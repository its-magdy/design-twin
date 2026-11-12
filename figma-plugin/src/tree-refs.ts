// Design-system references in a tree spec (docs/write-plane-spec.md decisions 5, 14, 15): what a createTree spec names
// — a component with property values, a variable, a text style — resolved against the file before the batch runs.
//
// The spec's shape has been checked (bridge/src/tree-spec.ts). This module answers what only the file can: does each
// name match exactly one thing, is it the right kind (a colour variable for a paint, a number one for a spacing), do
// an instance's property names and values exist on its component. Every use is looked at, so the refusal lists every
// bad name at once, each with up to three candidates. Resolving runs in two steps:
//
//   resolveRefs   reads the file only: local components, variables and text styles by exact name, key or id, and a
//                 library variable by name (figma.teamLibrary lists those). A reference the file does not have yet
//                 but a library does becomes an import, not run here.
//   imports       runs those imports. Importing is a write that cannot be put back, so writes.ts calls it only once
//                 the whole batch resolved, with "Allow edits" still on, right before the first op.
//
// A key is accepted as exact (a component's, variable's or style's 40-hex `key`, as the read writes it); a key the file
// does not have is imported from an enabled library. A component or text style is found by NAME only in this file (the
// Plugin API lists no library components or styles), so a library one is named by its key.
//
// Plugin API facts this leans on (@figma/plugin-typings):
//   * Under documentAccess "dynamic-page" a page must be loaded (loadAsync) before findAllWithCriteria walks it.
//   * componentPropertyDefinitions throws on a variant (a COMPONENT inside a COMPONENT_SET): read the set's. A TEXT,
//     BOOLEAN or INSTANCE_SWAP property's key carries a "#id" suffix; a VARIANT property's key is its bare name.
//   * importComponentByKeyAsync / importComponentSetByKeyAsync / importStyleByKeyAsync /
//     figma.variables.importVariableByKeyAsync reject for a key no enabled library publishes.
import { matchByName, nearestNames, quoteList } from "../../bridge/src/name-match.ts";
import { nodeKind, type TreeNodeSpec } from "../../bridge/src/tree-spec.ts";
import type { OpProblem } from "./write-batch";

/** What a node of a spec resolved to, for the build. */
export interface ResolvedRefs {
  /** an INSTANCE node → the component to instantiate and its property values keyed as setProperties takes them */
  instances: Map<TreeNodeSpec, { main: ComponentNode; props: Record<string, string | boolean> }>;
  /** a variable reference → the variable */
  variables: Map<string, Variable>;
  /** a text style reference → the style */
  textStyles: Map<string, TextStyle>;
}

/** One place a spec names something, with what it needs. */
interface Use {
  index: number;
  path: string;
  kind: "component" | "variable" | "textStyle";
  ref: string;
  /** a variable: the type the field takes */
  type?: VariableResolvedDataType;
  /** a component: the node that names it */
  node?: TreeNodeSpec;
}

/** A key as Figma writes one: 40 hex digits. */
const isKey = (ref: string): boolean => /^[0-9a-f]{40}$/i.test(ref);

/** Every reference `spec` makes, with its path (as checkTree names it). */
function usesOf(index: number, s: TreeNodeSpec, path: string, out: Use[]): Use[] {
  const kind = nodeKind(s);
  if (kind === "INSTANCE" && s.component !== undefined) out.push({ index, path: path + ".component", kind: "component", ref: s.component, node: s });
  if (kind === "TEXT" && s.styles && s.styles.text !== undefined) out.push({ index, path: path + ".styles.text", kind: "textStyle", ref: s.styles.text });
  (s.fills || []).forEach((f, i) => { if (f.tokens) out.push({ index, path: path + ".fills[" + i + "].tokens.color", kind: "variable", ref: f.tokens.color, type: "COLOR" }); });
  const t = s.tokens || {};
  for (const k of Object.keys(t) as Array<keyof typeof t>) {
    const v = t[k];
    if (v === undefined) continue;
    const names = typeof v === "string" ? [v] : v;
    const type: VariableResolvedDataType = k === "fills" || k === "strokes" ? "COLOR" : "FLOAT";
    // `tokens.fills` beside `fills` repeats what the paints name (checkTree made sure): resolved once, from the paints.
    if (k === "fills" && s.fills) continue;
    names.forEach((ref, i) => out.push({ index, path: path + ".tokens." + k + (names.length > 1 ? "[" + i + "]" : ""), kind: "variable", ref, type }));
  }
  (s.children || []).forEach((c, i) => usesOf(index, c, path + ".children[" + i + "]", out));
  return out;
}

/** A name that resolved, or why it did not. `later` = a key the file does not have, to import; it calls `allowed`
 *  before each import it runs (a component key may take two: a component, then a component set). */
type Found<T> = { ok: T } | { error: string } | { later: (allowed: () => boolean) => Promise<T> };
/** Thrown by an import that found "Allow edits" off: the batch stops there, refused as edits-off. */
export class ImportsRevoked extends Error {}

/** The resolution of every reference of a batch, and the imports it still needs. */
export interface RefResolution {
  refs: ResolvedRefs;
  problems: OpProblem[];
  /** Run the imports, then check what they brought in (property names, variable types, fonts). Every problem, or none;
   *  `revoked` when `allowed` said no before an import (the imports before it stay: an import cannot be put back). */
  imports(allowed: () => boolean): Promise<{ problems: OpProblem[]; revoked: boolean }>;
  /** How many items the imports will bring in (0: nothing to import). */
  importCount: number;
}

/**
 * Resolve every design-system reference of a batch's createTree specs. `specs` maps an op index to its spec;
 * `loadFont` loads a font (null = loaded, else why not), shared with the raw-font loads so a family loads once.
 */
export async function resolveRefs(specs: ReadonlyMap<number, TreeNodeSpec>, loadFont: (f: FontName) => Promise<string | null>): Promise<RefResolution> {
  const uses: Use[] = [];
  for (const [index, spec] of specs) usesOf(index, spec, "tree", uses);
  const refs: ResolvedRefs = { instances: new Map(), variables: new Map(), textStyles: new Map() };
  const problems: OpProblem[] = [];
  if (!uses.length) return { refs, problems, imports: async () => ({ problems: [], revoked: false }), importCount: 0 };

  const file = fileLookups();
  // One lookup per distinct name; one problem per op per name (the first place it is used, and how many more).
  const found = new Map<string, Promise<Found<unknown>>>();
  const lookup = <T>(kind: Use["kind"], ref: string, run: () => Promise<Found<T>>): Promise<Found<T>> => {
    const k = kind + "\u0000" + ref;
    let p = found.get(k);
    if (!p) { p = run(); found.set(k, p); }
    return p as Promise<Found<T>>;
  };
  const report = reporter(problems);
  const bad = report.bad;

  const imported: Array<{ use: Use; get: (allowed: () => boolean) => Promise<unknown> }> = [];
  for (const u of uses) {
    const f: Found<unknown> = u.kind === "component" ? await lookup(u.kind, u.ref, () => file.component(u.ref))
      : u.kind === "variable" ? await lookup(u.kind, u.ref, () => file.variable(u.ref))
      : await lookup(u.kind, u.ref, () => file.textStyle(u.ref));
    if ("error" in f) { bad(u, f.error); continue; }
    if ("later" in f) {
      // A library variable listed by name says its type before it is imported: a wrong one is refused now.
      const typed = file.libraryType(u.ref);
      if (u.kind === "variable" && typed && u.type && typed !== u.type) { bad(u, typeMismatch(u, typed)); continue; }
      imported.push({ use: u, get: f.later });
      continue;
    }
    const err = await accept(u, f.ok, refs, loadFont);
    if (err) bad(u, err);
  }
  report.finish();

  const importCount = new Set(imported.map((i) => i.use.kind + "\u0000" + i.use.ref)).size;
  return {
    refs, problems, importCount,
    async imports(allowed) {
      const late: OpProblem[] = [];
      const lateReport = reporter(late);
      // Each distinct item imports once, however many places name it; one at a time (an import is a network round
      // trip Figma serialises anyway), in spec order, with consent checked before each.
      const once = new Map<string, { item: unknown } | { error: unknown }>();
      for (const { use, get } of imported) {
        const k = use.kind + "\u0000" + use.ref;
        let got = once.get(k);
        if (!got) {
          if (!allowed()) return { problems: [], revoked: true };
          try { got = { item: await get(allowed) }; } catch (e) {
            if (e instanceof ImportsRevoked) return { problems: [], revoked: true };
            got = { error: e };
          }
          once.set(k, got);
        }
        if ("error" in got) { lateReport.bad(use, importFailed(use, got.error)); continue; }
        const err = await accept(use, got.item, refs, loadFont);
        if (err) lateReport.bad(use, err);
      }
      lateReport.finish();
      return { problems: late, revoked: false };
    },
  };
}

/** Problems for `out`, one per op per name and message (the first place it is used, then "and N more places"). */
function reporter(out: OpProblem[]): { bad: (u: Use, message: string) => void; finish: () => void } {
  const reported = new Map<string, { problem: OpProblem; more: number }>();
  return {
    bad(u, message) {
      const k = u.index + "\u0000" + u.kind + "\u0000" + u.ref + "\u0000" + message;
      const seen = reported.get(k);
      if (seen) { seen.more++; return; }
      const problem: OpProblem = { index: u.index, op: "createTree", message: u.path + ": " + message };
      reported.set(k, { problem, more: 0 });
      out.push(problem);
    },
    finish() {
      for (const { problem, more } of reported.values()) if (more) problem.message += " (and " + more + " more place" + (more === 1 ? "" : "s") + " in this spec)";
    },
  };
}

function importFailed(u: Use, e: unknown): string {
  const what = u.kind === "component" ? "component" : u.kind === "variable" ? "variable" : "text style";
  return "no " + what + " in this file or an enabled library has the key '" + u.ref + "'" + (e instanceof Error && e.message ? " (" + e.message + ")" : "");
}

const typeMismatch = (u: Use, actual: VariableResolvedDataType): string =>
  "variable '" + u.ref + "' holds a " + actual.toLowerCase() + ", and this field takes a " + (u.type || "").toLowerCase() + " variable";

/** Record a resolved item for its use, or say why it does not fit there. */
async function accept(u: Use, item: unknown, refs: ResolvedRefs, loadFont: (f: FontName) => Promise<string | null>): Promise<string | null> {
  if (u.kind === "variable") {
    const v = item as Variable;
    if (u.type && v.resolvedType !== u.type) return typeMismatch(u, v.resolvedType);
    refs.variables.set(u.ref, v);
    return null;
  }
  if (u.kind === "textStyle") {
    const st = item as BaseStyle;
    if (st.type !== "TEXT") return "'" + u.ref + "' is a " + st.type.toLowerCase() + " style, not a text style";
    const font = st.fontName;
    const err = await loadFont(font);
    if (err) return "text style '" + st.name + "': its " + err;
    refs.textStyles.set(u.ref, st);
    return null;
  }
  const c = item as ComponentNode | ComponentSetNode;
  const node = u.node;
  if (!node) return "no node";
  const set = c.type === "COMPONENT_SET" ? c : c.parent && c.parent.type === "COMPONENT_SET" ? c.parent : null;
  const main = c.type === "COMPONENT_SET" ? c.defaultVariant : c;
  let defs: ComponentPropertyDefinitions;
  try { defs = (set || c).componentPropertyDefinitions; } catch { defs = {}; }
  const mapped = mapProps(node.props || {}, defs, (set || c).name);
  if ("errors" in mapped) return mapped.errors.join("; ");
  // An instance hugs only when the variant it ends up as has auto-layout (checkTree cannot know; Figma would refuse
  // mid-build): the variant the given variant values pick, the default's values for the rest.
  const shown = set ? variantFor(set, main, mapped.ok, defs) : main;
  if (shown.layoutMode === "NONE") for (const axis of ["widthMode", "heightMode"] as const) {
    if (node[axis] === "hug") return "component '" + (set || c).name + "' has no auto-layout, so its instance cannot `" + axis + ": \"hug\"`";
  }
  refs.instances.set(node, { main, props: mapped.ok });
  return null;
}

/** The variant of `set` an instance made from `start` shows once `props` are set: each VARIANT property at its given
 *  value, else at `start`'s. `start` itself when no variant matches (Figma keeps it then too). */
function variantFor(set: ComponentSetNode, start: ComponentNode, props: Readonly<Record<string, string | boolean>>, defs: ComponentPropertyDefinitions): ComponentNode {
  const want: Record<string, string> = {};
  const from = start.variantProperties || {};
  for (const k of Object.keys(defs)) {
    const d = defs[k];
    if (!d || d.type !== "VARIANT") continue;
    const given = props[k];
    const v = typeof given === "string" ? given : from[k];
    if (v !== undefined) want[k] = v;
  }
  for (const c of set.children) {
    if (c.type !== "COMPONENT") continue;
    const vp = c.variantProperties || {};
    if (Object.keys(want).every((k) => vp[k] === want[k])) return c;
  }
  return start;
}

/** An instance's property values keyed the way setProperties takes them: a VARIANT property by its name, the others
 *  by their "name#id" key. A bare name is enough when it names one property; the full key always works. */
export function mapProps(given: Readonly<Record<string, string | boolean>>, defs: ComponentPropertyDefinitions, component: string):
  { ok: Record<string, string | boolean> } | { errors: string[] } {
  const keys = Object.keys(defs);
  const bare = (k: string): string => { const i = k.lastIndexOf("#"); return i > 0 ? k.slice(0, i) : k; };
  const ok: Record<string, string | boolean> = {};
  const errors: string[] = [];
  for (const name of Object.keys(given)) {
    const value = given[name];
    if (value === undefined) continue;
    const hits = keys.indexOf(name) >= 0 ? [name] : keys.filter((k) => bare(k) === name);
    const key = hits[0];
    if (key === undefined) {
      const near = nearestNames(name, keys.map(bare));
      errors.push("component '" + component + "' has no property '" + name + "'" + (near.length ? "; closest: " + quoteList(near) : keys.length ? "" : " (it has none)"));
      continue;
    }
    if (hits.length > 1) { errors.push("component '" + component + "' has " + hits.length + " properties named '" + name + "' — pass one's full key: " + quoteList(hits.slice(0, 3))); continue; }
    const def = defs[key];
    if (!def) continue;
    if (def.type === "VARIANT") {
      const options = def.variantOptions || [];
      if (typeof value !== "string" || options.indexOf(value) < 0) {
        const near = typeof value === "string" ? nearestNames(value, options) : options.slice(0, 3);
        errors.push("property '" + name + "' of '" + component + "' has no value " + JSON.stringify(value) + (near.length ? "; closest: " + quoteList(near) : ""));
        continue;
      }
    } else if (def.type === "BOOLEAN") {
      if (typeof value !== "boolean") { errors.push("property '" + name + "' of '" + component + "' is a boolean: give true or false"); continue; }
    } else if (def.type === "TEXT") {
      if (typeof value !== "string") { errors.push("property '" + name + "' of '" + component + "' is a text: give a string"); continue; }
    } else {
      errors.push("property '" + name + "' of '" + component + "' swaps a nested instance, which a write cannot set yet");
      continue;
    }
    ok[key] = value;
  }
  return errors.length ? { errors } : { ok };
}

/** The file's components, variables and text styles, each read once and only when a reference needs it. */
function fileLookups() {
  let components: Promise<Array<ComponentNode | ComponentSetNode>> | null = null;
  let variables: Promise<Variable[]> | null = null;
  let styles: Promise<TextStyle[]> | null = null;
  let library: Promise<Array<LibraryVariable & { libraryName: string }>> | null = null;
  const libraryTypes = new Map<string, VariableResolvedDataType>();

  const allComponents = (): Promise<Array<ComponentNode | ComponentSetNode>> => {
    if (!components) components = (async () => {
      const out: Array<ComponentNode | ComponentSetNode> = [];
      for (const page of figma.root.children) {
        try {
          await page.loadAsync(); // dynamic-page: before it is walked
          out.push(...page.findAllWithCriteria({ types: ["COMPONENT_SET", "COMPONENT"] }));
        } catch { /* a page that will not load holds no component a name could match */ }
      }
      return out;
    })();
    return components;
  };
  const libraryVariables = (): Promise<Array<LibraryVariable & { libraryName: string }>> => {
    if (!library) library = (async () => {
      const out: Array<LibraryVariable & { libraryName: string }> = [];
      let colls: LibraryVariableCollection[] = [];
      // Needs permissions:["teamlibrary"]; a plan without libraries throws. Either way: no library to name.
      try { colls = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync(); } catch { colls = []; }
      for (const c of colls) {
        try { for (const v of await figma.teamLibrary.getVariablesInLibraryCollectionAsync(c.key)) out.push({ ...v, libraryName: c.libraryName }); } catch { /* skip it */ }
      }
      return out;
    })();
    return library;
  };
  const ambiguous = (what: string, ref: string, items: ReadonlyArray<{ name: string; id: string }>): { error: string } =>
    ({ error: what + " '" + ref + "' matches " + items.length + " " + what + "s — pass one's key or id: " + items.slice(0, 3).map((x) => "'" + x.name + "' (" + x.id + ")").join(", ") });
  const none = (what: string, ref: string, candidates: readonly string[], where: string): { error: string } =>
    ({ error: what + " '" + ref + "' matches no " + what + " " + where + (candidates.length ? "; closest: " + quoteList(candidates) : "") });

  return {
    libraryType: (ref: string): VariableResolvedDataType | undefined => libraryTypes.get(ref),
    async component(ref: string): Promise<Found<ComponentNode | ComponentSetNode>> {
      let byId: BaseNode | null = null;
      try { byId = /^[I\d][\d:;I-]*$/.test(ref) ? await figma.getNodeByIdAsync(ref) : null; } catch { byId = null; }
      if (byId && (byId.type === "COMPONENT" || byId.type === "COMPONENT_SET")) return { ok: byId };
      const all = await allComponents();
      const exact = all.filter((c) => c.key === ref || c.id === ref);
      const first = exact[0];
      if (first && exact.length === 1) return { ok: first };
      // A key is exact: it imports the item it names, even when some local component happens to be called that.
      if (isKey(ref)) return { later: (allowed) => importComponent(ref, allowed) };
      // By name: a component set, or a component outside one (a variant is chosen through `props`).
      const named = all.filter((c) => !(c.type === "COMPONENT" && c.parent && c.parent.type === "COMPONENT_SET"));
      const m = matchByName(ref, named, (c) => c.name);
      if (m.kind === "one") return { ok: m.item };
      if (m.kind === "many") return ambiguous("component", ref, m.matches);
      return none("component", ref, m.candidates, "in this file (a library component is named by its key)");
    },
    async variable(ref: string): Promise<Found<Variable>> {
      let byId: Variable | null = null;
      try { byId = ref.indexOf("VariableID:") === 0 ? await figma.variables.getVariableByIdAsync(ref) : null; } catch { byId = null; }
      if (byId) return { ok: byId };
      if (!variables) variables = figma.variables.getLocalVariablesAsync();
      const locals = await variables;
      const exact = locals.filter((v) => v.id === ref || v.key === ref);
      const first = exact[0];
      if (first && exact.length === 1) return { ok: first };
      if (isKey(ref)) {
        // A key is exact: a library variable listed with it says its type before the import.
        const listed = (await libraryVariables()).filter((v) => v.key === ref)[0];
        if (listed) libraryTypes.set(ref, listed.resolvedType);
        return { later: () => figma.variables.importVariableByKeyAsync(ref) };
      }
      const m = matchByName(ref, locals, (v) => v.name);
      if (m.kind === "one") return { ok: m.item };
      if (m.kind === "many") return ambiguous("variable", ref, m.matches);
      const lib = (await libraryVariables()).filter((v) => v.name === ref);
      const one = lib[0];
      if (one && lib.length === 1) {
        libraryTypes.set(ref, one.resolvedType);
        return { later: () => figma.variables.importVariableByKeyAsync(one.key) };
      }
      if (lib.length > 1) return { error: "variable '" + ref + "' matches " + lib.length + " library variables — pass one's key: " + lib.slice(0, 3).map((v) => "'" + v.name + "' in '" + v.libraryName + "' (" + v.key + ")").join(", ") };
      const near = nearestNames(ref, [...locals.map((v) => v.name), ...(await libraryVariables()).map((v) => v.name)]);
      return none("variable", ref, near, "in this file or an enabled library");
    },
    async textStyle(ref: string): Promise<Found<BaseStyle>> {
      if (!styles) styles = figma.getLocalTextStylesAsync();
      const locals = await styles;
      const exact = locals.filter((st) => st.id === ref || st.key === ref);
      const first = exact[0];
      if (first && exact.length === 1) return { ok: first };
      let byId: BaseStyle | null = null;
      try { byId = ref.indexOf("S:") === 0 ? await figma.getStyleByIdAsync(ref) : null; } catch { byId = null; }
      if (byId) return { ok: byId };
      // A key is exact: it imports the style it names, even when a local style happens to be called that.
      if (isKey(ref)) return { later: () => figma.importStyleByKeyAsync(ref) };
      const m = matchByName(ref, locals, (st) => st.name);
      if (m.kind === "one") return { ok: m.item };
      if (m.kind === "many") return ambiguous("text style", ref, m.matches);
      return none("text style", ref, m.candidates, "in this file (a library style is named by its key)");
    },
  };
}

/** A library component by key: a component, else a component set (consent checked again before the second import). */
async function importComponent(key: string, allowed: () => boolean): Promise<ComponentNode | ComponentSetNode> {
  try { return await figma.importComponentByKeyAsync(key); } catch (e) {
    if (!allowed()) throw new ImportsRevoked("'Allow edits' was turned off");
    try { return await figma.importComponentSetByKeyAsync(key); } catch { throw e; }
  }
}
