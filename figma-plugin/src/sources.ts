// Source edits (writes: setVariable, setStyle, and a patch of a main component): change a local variable's values, a
// local paint, text or effect style, or a local main component once, and Figma carries it to everything that uses it
// (docs/write-plane-spec.md decision 9).
//
// The op's shape has been checked (bridge/src/source-spec.ts). This module answers what only the file can:
//   resolveSourceOps   the variable or style each op names is LOCAL (one from another library file is refused, naming
//                      the file when Figma says which), the modes exist, every value fits the variable's type, an alias
//                      makes no loop, a text style's fonts load, a style's fields fit its kind — and, for a patch, the
//                      node does not sit inside a library component. Every problem of every op is listed in one refusal.
//   applyVariable / applyStyle   keep what they replace and return a Change that puts it back.
//   writeImpact        the dry run's half that needs the file: how many layers, instances, styles and variables follow.
//
// Plugin API facts this leans on (@figma/plugin-typings):
//   * Variable.setValueForMode(modeId, value) takes RGB/RGBA for a COLOR, a number, a string, a boolean, or a
//     VariableAlias (figma.variables.createVariableAlias). It throws on an alias that would make a loop.
//   * A library variable, style or component the file uses is reachable by id with `remote: true`; it cannot be
//     changed here. Only variables carry their library's name (figma.teamLibrary lists the collections with
//     `libraryName`); a component or style key is named only by the user-kept registry (libraries.ts).
//   * BaseStyle.getStyleConsumersAsync lists the layers that use a style; ComponentNode.getInstancesAsync lists a main
//     component's instances. Nothing lists a variable's users: the pages are walked for bindings.
//   * Setting a text style's font, size or spacing needs its font loaded; a paint or effect style's paints and effects
//     carry their own variable bindings, so putting the old list back restores them.
import type { AppliedWrite, WriteImpactCounts, WriteImpactReply, WriteImpactStep, WriteOp } from "../../bridge/src/commands.ts";
import { parseHexColor } from "../../bridge/src/hex-color.ts";
import { matchByName, nearestNames, quoteList } from "../../bridge/src/name-match.ts";
import { checkStyleSet, checkVariableEdit, isStyleSet, type EffectSpec, type SourceValue, type StyleKindName, type StyleSet } from "../../bridge/src/source-spec.ts";
import { registeredLibrary } from "./libraries";
import { solid } from "./tree";
import { resolveRefs, type RefResolution, type ResolvedRefs, type Use } from "./tree-refs";
import { errMsg } from "./util";
import { RestoreStopped, type Change, type OpProblem } from "./write-batch";

/** A setVariable whose variable, modes and values resolved. */
export interface VariableTarget {
  variable: Variable;
  /** each mode it sets: its id and name, and the value as the op gave it */
  modes: Array<{ modeId: string; name: string; value: SourceValue }>;
  refs: ResolvedRefs;
}
/** A setStyle whose style resolved and fits its fields. */
export interface StyleTarget {
  style: PaintStyle | TextStyle | EffectStyle;
  set: StyleSet;
  refs: ResolvedRefs;
  /** a text style: the font it ends with (loaded) */
  font: FontName | null;
  /** a text style: the variables its fields are bound to now, by field, bound back on restore */
  bound: Array<{ field: VariableBindableTextField; variable: Variable }>;
}

const isKey = (ref: string): boolean => /^[0-9a-f]{40}$/i.test(ref);
const getF = (o: object, k: string): unknown => Reflect.get(o, k);

/** "lives in the library 'X'" / "lives in another library file", and what to do instead. */
function libraryOwned(what: string, library: string | null): string {
  return what + " lives in " + (library ? "the library '" + library + "'" : "another library file (Figma does not tell plugins which)") +
    ", not in this file — change it in that library and publish it; this file then takes the update";
}

/** The file's variables, styles and libraries, each read once per batch and only when an op needs it. */
function sourceLookups() {
  let locals: Promise<Variable[]> | null = null;
  let libColls: Promise<LibraryVariableCollection[]> | null = null;
  let libVars: Promise<Array<LibraryVariable & { libraryName: string }>> | null = null;
  let styles: Promise<Array<PaintStyle | TextStyle | EffectStyle>> | null = null;
  const localVariables = (): Promise<Variable[]> => { if (!locals) locals = figma.variables.getLocalVariablesAsync(); return locals; };
  const libraryCollections = (): Promise<LibraryVariableCollection[]> => {
    // Needs permissions:["teamlibrary"]; a plan without libraries throws. Either way: no library to name.
    if (!libColls) libColls = figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync().then((c) => c, () => []);
    return libColls;
  };
  const libraryVariables = (): Promise<Array<LibraryVariable & { libraryName: string }>> => {
    if (!libVars) libVars = (async () => {
      const out: Array<LibraryVariable & { libraryName: string }> = [];
      for (const c of await libraryCollections()) {
        try { for (const v of await figma.teamLibrary.getVariablesInLibraryCollectionAsync(c.key)) out.push({ ...v, libraryName: c.libraryName }); } catch { /* skip it */ }
      }
      return out;
    })();
    return libVars;
  };
  const localStyles = (): Promise<Array<PaintStyle | TextStyle | EffectStyle>> => {
    if (!styles) styles = (async () => {
      const out: Array<PaintStyle | TextStyle | EffectStyle> = [];
      out.push(...(await figma.getLocalPaintStylesAsync()), ...(await figma.getLocalTextStylesAsync()), ...(await figma.getLocalEffectStylesAsync()));
      return out;
    })();
    return styles;
  };
  /** The library a remote variable comes from, by its collection's key (then its own key), or null. */
  const libraryOfVariable = async (v: Variable): Promise<string | null> => {
    let coll: VariableCollection | null = null;
    try { coll = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId); } catch { coll = null; }
    const colls = await libraryCollections();
    for (const c of colls) if (coll && c.key === coll.key) return c.libraryName;
    for (const lv of await libraryVariables()) if (lv.key === v.key) return lv.libraryName;
    return null;
  };

  return {
    localVariables,
    async variable(ref: string): Promise<{ ok: Variable } | { error: string }> {
      if (ref.indexOf("VariableID:") === 0) {
        let byId: Variable | null = null;
        try { byId = await figma.variables.getVariableByIdAsync(ref); } catch { byId = null; }
        if (byId && byId.remote) return { error: libraryOwned("variable '" + byId.name + "'", await libraryOfVariable(byId)) };
        if (byId) return { ok: byId };
      }
      const all = await localVariables();
      const exact = all.filter((v) => v.id === ref || v.key === ref);
      const first = exact[0];
      if (first && exact.length === 1) return { ok: first };
      if (isKey(ref)) {
        const lib = (await libraryVariables()).filter((v) => v.key === ref)[0];
        if (lib) return { error: libraryOwned("variable '" + lib.name + "'", lib.libraryName) };
        return { error: "no variable of this file has the key '" + ref + "'" };
      }
      const m = matchByName(ref, all, (v) => v.name);
      if (m.kind === "one") return { ok: m.item };
      if (m.kind === "many") return { error: "variable '" + ref + "' matches " + m.matches.length + " variables — pass one's key or id: " + m.matches.slice(0, 3).map((v) => "'" + v.name + "' (" + v.id + ")").join(", ") };
      const lib = (await libraryVariables()).filter((v) => v.name === ref);
      if (lib.length) {
        const names = lib.map((v) => v.libraryName).filter((n, i, a) => a.indexOf(n) === i);
        return { error: names.length === 1 ? libraryOwned("variable '" + ref + "'", names[0] === undefined ? null : names[0]) : "variable '" + ref + "' is not in this file; libraries " + quoteList(names) + " have one by that name — a library's variable is changed in that library" };
      }
      return { error: "variable '" + ref + "' matches no variable of this file" + (m.candidates.length ? "; closest: " + quoteList(m.candidates) : "") };
    },
    async style(ref: string, kind: StyleKindName | null): Promise<{ ok: PaintStyle | TextStyle | EffectStyle } | { error: string }> {
      const all = await localStyles();
      const exact = all.filter((st) => st.id === ref || st.key === ref);
      const first = exact[0];
      if (first && exact.length === 1) return { ok: first };
      if (ref.indexOf("S:") === 0) {
        let byId: BaseStyle | null = null;
        try { byId = await figma.getStyleByIdAsync(ref); } catch { byId = null; }
        if (byId && byId.remote) return { error: libraryOwned(byId.type.toLowerCase() + " style '" + byId.name + "'", registeredLibrary(byId.key)) };
        if (byId) return { error: "'" + byId.name + "' is a " + byId.type.toLowerCase() + " style, which a style edit cannot change yet (paint, text and effect styles can)" };
      }
      if (isKey(ref)) return { error: libraryOwned("the style with the key '" + ref + "' (it is not a style of this file)", registeredLibrary(ref)) };
      // A name can repeat across kinds ("Primary" as a paint and a text style): the fields say which kind is meant.
      const pool = kind ? all.filter((st) => st.type === kind.toUpperCase()) : all;
      const m = matchByName(ref, pool, (st) => st.name);
      if (m.kind === "one") return { ok: m.item };
      if (m.kind === "many") return { error: "style '" + ref + "' matches " + m.matches.length + " styles — pass one's key or id: " + m.matches.slice(0, 3).map((st) => "'" + st.name + "' (" + st.type.toLowerCase() + ", " + st.id + ")").join(", ") };
      const near = nearestNames(ref, pool.map((st) => st.name));
      const elsewhere = kind ? all.filter((st) => st.name === ref)[0] : undefined;
      if (elsewhere) return { error: "'" + ref + "' is a " + elsewhere.type.toLowerCase() + " style, and these fields are a " + kind + " style's" };
      return { error: (kind ? kind + " " : "") + "style '" + ref + "' matches no style of this file (a library style is changed in its library)" + (near.length ? "; closest: " + quoteList(near) : "") };
    },
  };
}
type Lookups = ReturnType<typeof sourceLookups>;

/** The main component a node is, or sits inside (its variant when it is in a component set), or null. */
function componentOf(node: BaseNode): ComponentNode | ComponentSetNode | null {
  for (let n: BaseNode | null = node; n; n = n.parent) {
    if (n.type === "COMPONENT" || n.type === "COMPONENT_SET") return n;
    if (n.type === "PAGE" || n.type === "DOCUMENT") return null;
  }
  return null;
}
/** Why a patch of `node` would change a library's component (refused), or null. */
export function libraryComponentProblem(node: BaseNode): string | null {
  const c = componentOf(node);
  if (!c || !c.remote) return null;
  return libraryOwned("the component '" + c.name + "'" + (c === node ? "" : " that '" + node.name + "' sits in"), registeredLibrary(c.key));
}

const MODE_LIMIT = 3;
/** Each of the op's modes on the variable's collection, by exact name or modeId, or the problem. */
function modesOf(op: WriteOp, coll: VariableCollection, v: Variable): { modes: Array<{ modeId: string; name: string; value: SourceValue }> } | { errors: string[] } {
  const errors: string[] = [];
  const modes: Array<{ modeId: string; name: string; value: SourceValue }> = [];
  if (op.value !== undefined) {
    const only = coll.modes[0];
    if (coll.modes.length !== 1 || !only) return { errors: ["`value` sets the only mode, and '" + coll.name + "' has " + coll.modes.length + " (" + quoteList(coll.modes.slice(0, MODE_LIMIT).map((m) => m.name)) + "); give `values` by mode"] };
    modes.push({ modeId: only.modeId, name: only.name, value: op.value as SourceValue });
    return { modes };
  }
  const values = op.values || {};
  for (const name of Object.keys(values)) {
    const value = values[name];
    if (value === undefined) continue;
    const m = matchByName(name, coll.modes, (x) => x.name, (x) => [x.modeId]);
    if (m.kind === "one") { modes.push({ modeId: m.item.modeId, name: m.item.name, value: value as SourceValue }); continue; }
    if (m.kind === "many") { errors.push("values[" + JSON.stringify(name) + "]: '" + coll.name + "' has " + m.matches.length + " modes named '" + name + "' — pass its modeId: " + m.matches.slice(0, MODE_LIMIT).map((x) => x.modeId).join(", ")); continue; }
    errors.push("values[" + JSON.stringify(name) + "]: '" + coll.name + "' (the collection of '" + v.name + "') has no mode '" + name + "'" + (m.candidates.length ? "; closest: " + quoteList(m.candidates) : "; it has " + quoteList(coll.modes.map((x) => x.name))));
  }
  const ids = modes.map((m) => m.modeId);
  for (const [i, id] of ids.entries()) if (ids.indexOf(id) !== i) errors.push("values: two entries name the mode '" + (modes[i] ? modes[i].name : id) + "'");
  return errors.length ? { errors } : { modes };
}

/** Why `value` cannot be a value of a variable of `type` (an alias is checked by its target), or null. */
function valueProblem(value: SourceValue, type: VariableResolvedDataType): string | null {
  if (typeof value === "object") return null;
  if (type === "COLOR") return typeof value === "string" && parseHexColor(value) ? null : "a colour variable takes a hex colour (#rrggbb or #rrggbbaa) or {aliasOf}";
  if (type === "FLOAT") return typeof value === "number" ? null : "a number variable takes a number or {aliasOf}";
  if (type === "STRING") return typeof value === "string" ? null : "a string variable takes a string or {aliasOf}";
  if (type === "BOOLEAN") return typeof value === "boolean" ? null : "a boolean variable takes true, false or {aliasOf}";
  return "a " + String(type).toLowerCase() + " variable cannot be written yet";
}

/** The id a value aliases, or null. */
function aliasOf(x: unknown): string | null {
  if (!x || typeof x !== "object" || getF(x, "type") !== "VARIABLE_ALIAS") return null;
  const id = getF(x, "id");
  return typeof id === "string" ? id : null;
}
/** The variables `v`'s values alias, by id (one level). */
function aliasIds(v: Variable): string[] {
  const out: string[] = [];
  for (const k of Object.keys(v.valuesByMode)) { const id = aliasOf(v.valuesByMode[k]); if (id) out.push(id); }
  return out;
}
/** Each variable's alias per mode as the batch's earlier edits leave it: what a loop check follows. */
type AliasGraph = Map<string, Record<string, string | null>>;
/** `v`'s aliases by mode in `graph`, read from the file the first time. */
function aliasesIn(graph: AliasGraph, v: Variable): Record<string, string | null> {
  let modes = graph.get(v.id);
  if (!modes) {
    modes = {};
    for (const k of Object.keys(v.valuesByMode)) modes[k] = aliasOf(v.valuesByMode[k]);
    graph.set(v.id, modes);
  }
  return modes;
}
/** Does `from` (followed through its aliases in `graph`) reach the variable `to`? */
async function reaches(graph: AliasGraph, from: Variable, to: string): Promise<boolean> {
  const seen = new Set<string>();
  const queue: Variable[] = [from];
  while (queue.length) {
    const v = queue.shift();
    if (!v || seen.has(v.id)) continue;
    seen.add(v.id);
    if (v.id === to) return true;
    const modes = aliasesIn(graph, v);
    for (const k of Object.keys(modes)) {
      const id = modes[k];
      if (!id) continue;
      let next: Variable | null = null;
      try { next = await figma.variables.getVariableByIdAsync(id); } catch { next = null; }
      if (next) queue.push(next);
    }
  }
  return false;
}

/** The font a style's fields name, defaulting to `now` (what it has once the batch's earlier edits landed). */
function fontAfter(now: FontName, set: StyleSet): FontName {
  return { family: set.font !== undefined ? set.font : now.family, style: set.weight !== undefined ? set.weight : now.style };
}

/**
 * Resolve every source edit of a batch (setVariable, setStyle; a patch only for the library check) against the file.
 * Every op is looked at, so the refusal lists every problem at once; the variables the edits name (aliases, a paint's
 * colour variable) are resolved together through tree-refs.ts, exactly as a tree spec's are.
 */
export async function resolveSourceOps(ops: readonly WriteOp[], lookups: Lookups = sourceLookups()): Promise<{ variables: Map<number, VariableTarget>; styles: Map<number, StyleTarget>; problems: OpProblem[]; imports: RefResolution["imports"]; importCount: number }> {
  const variables = new Map<number, VariableTarget>();
  const styles = new Map<number, StyleTarget>();
  const problems: OpProblem[] = [];
  const uses: Use[] = [];
  const empty = (): ResolvedRefs => ({ instances: new Map(), variables: new Map(), textStyles: new Map() });
  const loaded = new Map<string, Promise<string | null>>();
  const loadFont = (f: FontName): Promise<string | null> => {
    const key = f.family + "|" + f.style;
    let p = loaded.get(key);
    if (!p) { p = figma.loadFontAsync(f).then(() => null, () => "font '" + f.family + " " + f.style + "' is not available in this file"); loaded.set(key, p); }
    return p;
  };
  // An alias the batch makes, checked for a loop once the names resolved.
  const aliases: Array<{ index: number; variable: Variable; ref: string; path: string }> = [];
  // A text style's font as the batch's earlier edits leave it (two edits of one style in a batch build on each other).
  const fontNow = new Map<string, FontName>();

  for (const [index, op] of ops.entries()) {
    const bad = (message: string): void => { problems.push({ index, op: op.op, message }); };
    if (op.op === "patch" && op.nodeId) {
      let nd: BaseNode | null = null;
      try { nd = await figma.getNodeByIdAsync(op.nodeId); } catch { nd = null; }
      const lib = nd ? libraryComponentProblem(nd) : null;
      if (lib) bad(lib);
      continue;
    }
    if (op.op === "setVariable") {
      if (checkVariableEdit(op).problems.length || !op.variable) { bad("the edit did not pass its check"); continue; }
      const found = await lookups.variable(op.variable);
      if ("error" in found) { bad(found.error); continue; }
      const v = found.ok;
      let coll: VariableCollection | null = null;
      try { coll = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId); } catch { coll = null; }
      if (!coll) { bad("variable '" + v.name + "': its collection cannot be read"); continue; }
      const m = modesOf(op, coll, v);
      if ("errors" in m) { for (const e of m.errors) bad(e); continue; }
      let ok = true;
      for (const mode of m.modes) {
        const path = op.value !== undefined ? "value" : "values[" + JSON.stringify(mode.name) + "]";
        const err = valueProblem(mode.value, v.resolvedType);
        if (err) { bad(path + ": " + err + " ('" + v.name + "' is a " + v.resolvedType.toLowerCase() + " variable)"); ok = false; continue; }
        if (typeof mode.value === "object") {
          uses.push({ index, op: op.op, path: path + ".aliasOf", kind: "variable", ref: mode.value.aliasOf, type: v.resolvedType });
          aliases.push({ index, variable: v, ref: mode.value.aliasOf, path: path + ".aliasOf" });
        }
      }
      if (ok) variables.set(index, { variable: v, modes: m.modes, refs: empty() });
      continue;
    }
    if (op.op === "setStyle") {
      const set = op.set;
      if (!isStyleSet(set) || !op.style) { bad("the edit did not pass its check"); continue; }
      const { kind } = checkStyleSet(set).summary;
      const found = await lookups.style(op.style, kind);
      if ("error" in found) { bad(found.error); continue; }
      const st = found.ok;
      if (kind && st.type !== kind.toUpperCase()) { bad("'" + st.name + "' is a " + st.type.toLowerCase() + " style, and these fields are a " + kind + " style's"); continue; }
      (set.paints || []).forEach((p, i) => { if (p.tokens) uses.push({ index, op: op.op, path: "set.paints[" + i + "].tokens.color", kind: "variable", ref: p.tokens.color, type: "COLOR" }); });
      let font: FontName | null = null;
      const bound: StyleTarget["bound"] = [];
      if (st.type === "TEXT") {
        // Its font now (to set anything on it and to put it back) and the one it ends with must load.
        let fontOk = true;
        const projected = fontNow.get(st.id);
        const now = projected ? projected : st.fontName;
        const after = fontAfter(now, set);
        for (const f of [st.fontName, now, after]) {
          const err = await loadFont(f);
          if (err) { bad("text style '" + st.name + "': its " + err + (f === after ? " (check `font` and `weight`)" : "")); fontOk = false; break; }
        }
        if (!fontOk) continue;
        font = after;
        fontNow.set(st.id, after);
        const bv = st.boundVariables || {};
        for (const field of Object.keys(bv) as VariableBindableTextField[]) {
          const a = bv[field];
          if (!a) continue;
          let v: Variable | null = null;
          try { v = await figma.variables.getVariableByIdAsync(a.id); } catch { v = null; }
          if (v) bound.push({ field, variable: v });
        }
      }
      styles.set(index, { style: st, set, refs: empty(), font, bound });
    }
  }
  const r = await resolveRefs(uses, loadFont);
  problems.push(...r.problems);
  // Loops are checked in op order against the alias graph the batch's earlier edits leave: an op that replaces an alias
  // with a value removes that edge for the ops after it. Each op's own edges land first, then its aliases are checked.
  const graph: AliasGraph = new Map();
  for (const [index, t] of variables) {
    const modes = aliasesIn(graph, t.variable);
    for (const m of t.modes) {
      const target = typeof m.value === "object" ? r.refs.variables.get(m.value.aliasOf) : undefined;
      modes[m.modeId] = target ? target.id : null;
    }
    for (const a of aliases) {
      if (a.index !== index) continue;
      const target = r.refs.variables.get(a.ref);
      if (!target) continue; // not resolved (a problem already), or a library variable still to import (it aliases no local one)
      if (target.id === a.variable.id || (await reaches(graph, target, a.variable.id))) problems.push({ index: a.index, op: "setVariable", message: a.path + ": '" + target.name + "' " + (target.id === a.variable.id ? "is '" + a.variable.name + "' itself" : "aliases '" + a.variable.name + "'") + ", so the alias would make a loop" });
    }
  }
  for (const t of variables.values()) t.refs = r.refs;
  for (const t of styles.values()) t.refs = r.refs;
  return { variables, styles, problems, imports: r.imports, importCount: r.importCount };
}

// ---------------------------------------------------------------- applying and putting back

function figmaValue(value: SourceValue, refs: ResolvedRefs): VariableValue {
  if (typeof value === "object") {
    const target = refs.variables.get(value.aliasOf);
    if (!target) throw new Error("variable '" + value.aliasOf + "' was not resolved before the batch ran");
    return figma.variables.createVariableAlias(target);
  }
  // Only a colour variable's value comes here: a hex the resolve step checked.
  const c = typeof value === "string" ? parseHexColor(value) : null;
  if (!c) throw new Error("'" + String(value) + "' is not a hex colour");
  return { r: c.r, g: c.g, b: c.b, a: c.a === undefined ? 1 : c.a };
}

/** Set a setVariable's values; the Change puts the old ones back. A failure partway puts back what it set first. */
export function applyVariable(t: VariableTarget, consent: () => void): Change {
  const v = t.variable;
  const kept: Array<{ modeId: string; value: VariableValue | undefined }> = [];
  const restore = (allowed: () => boolean): void => {
    for (const k of kept.slice().reverse()) {
      if (!allowed()) throw new RestoreStopped("'Allow edits' was turned off");
      if (k.value !== undefined) v.setValueForMode(k.modeId, k.value);
    }
  };
  try {
    for (const m of t.modes) {
      consent();
      const old = v.valuesByMode[m.modeId];
      // A value as Figma holds it: a colour or alias object is copied, so a later change cannot reach the kept one.
      kept.push({ modeId: m.modeId, value: old && typeof old === "object" ? JSON.parse(JSON.stringify(old)) as VariableValue : old });
      v.setValueForMode(m.modeId, t.variable.resolvedType === "COLOR" || typeof m.value === "object" ? figmaValue(m.value, t.refs) : m.value);
    }
  } catch (e) {
    try { restore(() => true); } catch { /* reported with the error below */ }
    throw e;
  }
  const applied: AppliedWrite = { id: v.id, modes: t.modes.map((m) => m.name) };
  return { applied, kind: "variable change", what: "the values of the variable '" + v.name + "'", restore };
}

const LINE_UNIT = { px: "PIXELS", percent: "PERCENT" } as const;
const CASES = { original: "ORIGINAL", upper: "UPPER", lower: "LOWER", title: "TITLE", small_caps: "SMALL_CAPS", small_caps_forced: "SMALL_CAPS_FORCED" } as const;
const DECORATIONS = { none: "NONE", underline: "UNDERLINE", strikethrough: "STRIKETHROUGH" } as const;

function effectOf(e: EffectSpec): Effect {
  if (!("color" in e)) return { type: e.type === "layer_blur" ? "LAYER_BLUR" : "BACKGROUND_BLUR", blurType: "NORMAL", radius: e.radius, visible: true };
  const c = parseHexColor(e.color);
  const color: RGBA = c ? { r: c.r, g: c.g, b: c.b, a: c.a === undefined ? 1 : c.a } : { r: 0, g: 0, b: 0, a: 1 };
  const base = { color, offset: { x: e.offset.x, y: e.offset.y }, radius: e.radius, spread: e.spread === undefined ? 0 : e.spread, visible: true, blendMode: "NORMAL" as const };
  return e.type === "drop_shadow" ? { type: "DROP_SHADOW", ...base, showShadowBehindNode: e.behindNode === true } : { type: "INNER_SHADOW", ...base };
}

/** The style's fields a setStyle can change, as they are now (copied: Figma hands back frozen objects). */
function keepStyle(st: PaintStyle | TextStyle | EffectStyle): Record<string, unknown> {
  const out: Record<string, unknown> = { name: st.name, description: st.description };
  const copy = (v: unknown): unknown => (v && typeof v === "object" ? JSON.parse(JSON.stringify(v)) as unknown : v);
  if (st.type === "PAINT") out.paints = st.paints.slice();
  if (st.type === "EFFECT") out.effects = st.effects.slice();
  if (st.type === "TEXT") for (const k of ["fontName", "fontSize", "lineHeight", "letterSpacing", "textCase", "textDecoration", "paragraphSpacing", "paragraphIndent"]) out[k] = copy(getF(st, k));
  return out;
}
/** Set `k` on `o` to `v` when it differs (a text style field set to its own value would still unbind a variable). */
function putBack(o: object, k: string, v: unknown): void {
  if (JSON.stringify(getF(o, k)) === JSON.stringify(v)) return;
  if (!Reflect.set(o, k, v)) throw new Error("cannot set " + k);
}

/** Set a setStyle's fields; the Change puts the old ones back (a text style's bound variables included). A text style's
 *  font now and the one it ends with are loaded first, read live: an earlier op of the batch (a variable its font is
 *  bound to) may have changed it since the batch resolved, and putting it back needs it loaded too. */
export async function applyStyle(t: StyleTarget, consent: () => void): Promise<Change> {
  const st = t.style;
  const set = t.set;
  if (st.type === "TEXT") {
    for (const f of [st.fontName, fontAfter(st.fontName, set)]) {
      try { await figma.loadFontAsync(f); } catch { throw new Error("text style '" + st.name + "': font '" + f.family + " " + f.style + "' is not available in this file (an earlier op of the batch changed its font)"); }
    }
  }
  const old = keepStyle(st);
  const restore = (allowed: () => boolean): void => {
    const check = (): void => { if (!allowed()) throw new RestoreStopped("'Allow edits' was turned off"); };
    check();
    if (st.type === "PAINT") putBack(st, "paints", old.paints);
    if (st.type === "EFFECT") putBack(st, "effects", old.effects);
    if (st.type === "TEXT") {
      for (const k of ["fontName", "fontSize", "lineHeight", "letterSpacing", "textCase", "textDecoration", "paragraphSpacing", "paragraphIndent"]) putBack(st, k, old[k]);
      const now = st.boundVariables || {};
      for (const b of t.bound) {
        check();
        const a = now[b.field];
        if (!a || a.id !== b.variable.id) st.setBoundVariable(b.field, b.variable);
      }
    }
    putBack(st, "description", old.description);
    putBack(st, "name", old.name);
  };
  try {
    consent();
    if (set.name !== undefined) st.name = set.name;
    if (set.description !== undefined) st.description = set.description;
    if (st.type === "PAINT" && set.paints) {
      st.paints = set.paints.map((p) => {
        const paint = solid(p.color === undefined ? "#000000" : p.color, p.opacity);
        const ref = p.tokens && p.tokens.color;
        if (ref === undefined) return paint;
        const v = t.refs.variables.get(ref);
        if (!v) throw new Error("variable '" + ref + "' was not resolved before the batch ran");
        return figma.variables.setBoundVariableForPaint(paint, "color", v);
      });
    }
    if (st.type === "EFFECT" && set.effects) st.effects = set.effects.map(effectOf);
    if (st.type === "TEXT") {
      if (t.font && (set.font !== undefined || set.weight !== undefined)) st.fontName = fontAfter(st.fontName, set);
      if (set.size !== undefined) st.fontSize = set.size;
      const lh = set.lineHeight;
      if (lh) st.lineHeight = lh.unit === "auto" ? { unit: "AUTO" } : { unit: LINE_UNIT[lh.unit], value: lh.value === undefined ? 0 : lh.value };
      const ls = set.letterSpacing;
      if (ls) st.letterSpacing = { unit: LINE_UNIT[ls.unit], value: ls.value };
      if (set.case !== undefined) st.textCase = CASES[set.case];
      if (set.decoration !== undefined) st.textDecoration = DECORATIONS[set.decoration];
      if (set.paragraphSpacing !== undefined) st.paragraphSpacing = set.paragraphSpacing;
      if (set.paragraphIndent !== undefined) st.paragraphIndent = set.paragraphIndent;
    }
  } catch (e) {
    try { restore(() => true); } catch { /* reported with the error below */ }
    throw e;
  }
  return { applied: { id: st.id }, kind: "style change", what: "the " + st.type.toLowerCase() + " style '" + st.name + "'", restore };
}

// ---------------------------------------------------------------- what follows (the dry run)

/** Every variable id `node` (or one of its paints) is bound to. */
function boundIds(node: SceneNode, out: Set<string>): void {
  const walk = (v: unknown, depth: number): void => {
    if (!v || typeof v !== "object" || depth > 4) return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (getF(v, "type") === "VARIABLE_ALIAS") { const id = getF(v, "id"); if (typeof id === "string") out.add(id); return; }
    for (const k of Object.keys(v)) walk(getF(v, k), depth + 1);
  };
  try { walk(getF(node, "boundVariables"), 0); } catch { /* a node without bindings */ }
  for (const k of ["fills", "strokes", "effects"]) {
    let list: unknown = null;
    try { list = getF(node, k); } catch { list = null; }
    if (Array.isArray(list)) for (const p of list as unknown[]) if (p && typeof p === "object") walk(getF(p, "boundVariables"), 0);
  }
}
/** Every variable id a style's fields or paints/effects are bound to. */
function styleBoundIds(st: BaseStyle): Set<string> {
  const out = new Set<string>();
  const scan = (v: unknown): void => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) { for (const x of v) scan(x); return; }
    if (getF(v, "type") === "VARIABLE_ALIAS") { const id = getF(v, "id"); if (typeof id === "string") out.add(id); return; }
    for (const k of Object.keys(v)) scan(getF(v, k));
  };
  scan(getF(st, "boundVariables"));
  for (const k of ["paints", "effects", "layoutGrids"]) { const list = getF(st, k); if (Array.isArray(list)) for (const p of list as unknown[]) if (p && typeof p === "object") scan(getF(p, "boundVariables")); }
  return out;
}

/** The layers that use `style`; a lookup Figma refuses is said through `warn` (the count is then low), never a quiet 0. */
async function consumersOf(style: BaseStyle, nodes: Set<string>, warn: (m: string) => void): Promise<void> {
  try { for (const c of await style.getStyleConsumersAsync()) nodes.add(c.node.id); } catch (e) {
    warn("the layers using the style '" + style.name + "' could not be read (" + errMsg(e) + "), so they are not counted");
  }
}

/** What follows a change of the variable `v`: the variables that alias it (through any chain), the local styles bound to
 *  any of those, and every layer bound to one of them or using such a style. `warn` gets pages that could not be read. */
async function variableImpact(v: Variable, lookups: Lookups, warn: (m: string) => void): Promise<WriteImpactCounts> {
  const ids = new Set<string>([v.id]);
  const locals = await lookups.localVariables();
  for (let grew = true; grew;) {
    grew = false;
    for (const x of locals) if (!ids.has(x.id) && aliasIds(x).some((id) => ids.has(id))) { ids.add(x.id); grew = true; }
  }
  const styles: BaseStyle[] = [];
  const local: BaseStyle[] = [...(await figma.getLocalPaintStylesAsync()), ...(await figma.getLocalTextStylesAsync()), ...(await figma.getLocalEffectStylesAsync()), ...(await figma.getLocalGridStylesAsync())];
  for (const st of local) {
    for (const id of styleBoundIds(st)) if (ids.has(id)) { styles.push(st); break; }
  }
  const nodes = new Set<string>();
  for (const page of figma.root.children) {
    try {
      await page.loadAsync();
      const hits = page.findAll((n) => { const b = new Set<string>(); boundIds(n, b); for (const id of b) if (ids.has(id)) return true; return false; });
      for (const n of hits) nodes.add(n.id);
    } catch (e) {
      warn("page '" + page.name + "' could not be read (" + errMsg(e) + "), so its layers are not counted");
    }
  }
  for (const st of styles) await consumersOf(st, nodes, warn);
  return { nodes: nodes.size, styles: styles.length, variables: ids.size - 1 };
}

/** The instances that follow a change of `c` (every variant's, for a component set). */
async function instancesOf(c: ComponentNode | ComponentSetNode, warn: (m: string) => void): Promise<number> {
  const mains = c.type === "COMPONENT_SET" ? c.children.filter((k): k is ComponentNode => k.type === "COMPONENT") : [c];
  let n = 0;
  for (const m of mains) {
    try { n += (await m.getInstancesAsync()).length; } catch (e) {
      warn("the instances of '" + m.name + "' could not be read (" + errMsg(e) + "), so they are not counted");
    }
  }
  return n;
}

/** The dry run's file-side half (the `writeImpact` command): for each source edit of the batch, how much follows, or
 *  why the file refuses it. Reads only; changes nothing. */
export async function writeImpact(ops: readonly WriteOp[]): Promise<WriteImpactReply> {
  const warnings: string[] = [];
  const warn = (m: string): void => { if (warnings.indexOf(m) < 0) warnings.push(m); };
  const lookups = sourceLookups();
  const steps: WriteImpactStep[] = [];
  for (const [index, op] of ops.entries()) {
    try {
      if (op.op === "patch") {
        let nd: BaseNode | null = null;
        try { nd = op.nodeId ? await figma.getNodeByIdAsync(op.nodeId) : null; } catch { nd = null; }
        const c = nd ? componentOf(nd) : null;
        if (!nd || !c) continue; // not a source: an ordinary layer (or no node, which the write itself reports)
        const lib = libraryComponentProblem(nd);
        steps.push(lib ? { index, op: op.op, problem: lib } : { index, op: op.op, affects: { instances: await instancesOf(c, warn) } });
        continue;
      }
      if (op.op === "setVariable" && op.variable) {
        const found = await lookups.variable(op.variable);
        steps.push("error" in found ? { index, op: op.op, problem: found.error } : { index, op: op.op, affects: await variableImpact(found.ok, lookups, warn) });
        continue;
      }
      if (op.op === "setStyle" && op.style) {
        const kind = isStyleSet(op.set) ? checkStyleSet(op.set).summary.kind : null;
        const found = await lookups.style(op.style, kind);
        if ("error" in found) { steps.push({ index, op: op.op, problem: found.error }); continue; }
        const nodes = new Set<string>();
        await consumersOf(found.ok, nodes, warn);
        steps.push({ index, op: op.op, affects: { nodes: nodes.size } });
      }
    } catch (e) {
      steps.push({ index, op: op.op, problem: "could not be counted: " + errMsg(e) });
    }
  }
  return warnings.length ? { steps, warnings } : { steps };
}
