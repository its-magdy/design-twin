// A design system from nothing (writes: createVariables, createStyles): a table of variables — the collection, its modes
// and every variable in one op — and a table of paint, text and effect styles whose values name variables
// (docs/write-plane-spec.md, "Starting from nothing"; decision 11: a re-send updates in place).
//
// The op's shape has been checked (bridge/src/create-spec.ts). This module answers what only the file can:
//   resolveCreateOps  which names the file has (a local collection by name, a variable by name in it, a style by name and
//                     kind: updated in place) and which are new (made), what each alias and each variable a style names
//                     points to (a row of a table of this batch, else a variable the file or a library has, through
//                     tree-refs.ts), a type that cannot change, a loop of aliases through the file, a text style's fonts.
//                     The new names are the batch's plan (batch-plan.ts): the ops after the create ops can name them.
//   applyCreates      runs the create ops, before the rest of the batch (they come first in it): each op's Change puts
//                     back what it did — what it made is removed, the values and fields it replaced are set back.
//   createImpact      the dry run's half that needs the file: what each create op would make and what it would update.
//
// Plugin API facts this leans on (@figma/plugin-typings):
//   * figma.variables.createVariableCollection(name) makes a collection with one mode (its defaultModeId, named
//     "Mode 1"); addMode(name) returns the new mode's id and throws past the file plan's limit ("in addMode: Limited to
//     N modes only"); renameMode, removeMode and remove() undo them. An extended collection (isExtension) has no addMode.
//   * figma.variables.createVariable(name, collection, resolvedType) takes the collection object (the id form is
//     deprecated); Variable.remove() deletes it. A variable's resolvedType never changes.
//   * figma.createPaintStyle / createTextStyle / createEffectStyle make a local style (a text style starts as Inter
//     Regular); BaseStyle.remove() deletes it. Setting a text style's font fields needs its font loaded.
import type { AppliedWrite, CreateOutcome, CreatePlan, WriteImpactReply, WriteOp } from "../../bridge/src/commands.ts";
import { CREATE_OPS } from "../../bridge/src/commands.ts";
import { checkCreateStyles, checkCreateVariables, figmaType, type StyleRow } from "../../bridge/src/create-spec.ts";
import { parseHexColor } from "../../bridge/src/hex-color.ts";
import { matchByName, quoteList } from "../../bridge/src/name-match.ts";
import type { SourceValue } from "../../bridge/src/source-spec.ts";
import type { BatchPlan, Planned } from "./batch-plan";
import { applyStyle, fontAfter, styleSnapshot, styleUses, writeImpact, type StyleTarget } from "./sources";
import { resolveRefs, type RefResolution, type ResolvedRefs, type Use } from "./tree-refs";
import { errMsg } from "./util";
import { RestoreStopped, type Change, type OpProblem } from "./write-batch";

type AnyStyle = PaintStyle | TextStyle | EffectStyle;
type StyleType = "PAINT" | "TEXT" | "EFFECT";

/** Where an alias, or a variable a style names, points: a row of a create table of this batch, or a variable the file
 *  (or a library) has, resolved by tree-refs under `ref`. */
type Target = { row: RowTarget } | { ref: string };

/** One row of a createVariables table, resolved. */
interface RowTarget {
  op: number;
  index: number;
  name: string;
  type: VariableResolvedDataType;
  values: SourceValue[];
  /** the variable of that name in the collection, updated in place; null: made */
  existing: Variable | null;
  /** each cell's target (undefined: a raw value) */
  targets: Array<Target | undefined>;
  /** a new row's place in the batch's plan (filled when made) */
  planned: Planned<Variable> | null;
  /** the variable, once the op has run (made, or the existing one) */
  variable: Variable | null;
}
/** A createVariables op, resolved. */
interface VariablesTarget {
  kind: "variables";
  name: string;
  /** the local collection of that name; null: made */
  collection: VariableCollection | null;
  /** the modes in cell order: an existing mode's id, or null for one to add (a new collection's first mode is its
   *  default mode, renamed to the name given; "" keeps Figma's name) */
  modes: Array<{ name: string; modeId: string | null }>;
  /** an existing collection's modes the table leaves out: a new variable takes its first value there too */
  unlisted: string[];
  rows: RowTarget[];
}
/** One row of a createStyles table, resolved. */
interface StyleRowTarget {
  index: number;
  row: StyleRow;
  existing: AnyStyle | null;
  /** every variable its `set` names, by the name given */
  refs: Map<string, Target>;
  /** a text style's variables bound now, by field (bound back on restore) */
  bound: StyleTarget["bound"];
  planned: Planned<AnyStyle> | null;
}
interface StylesTarget {
  kind: "styles";
  rows: StyleRowTarget[];
}
export type CreateTarget = VariablesTarget | StylesTarget;

/** The create ops of a batch, resolved. */
export interface CreateResolution {
  targets: Map<number, CreateTarget>;
  problems: OpProblem[];
  /** the new names, for the ops after (batch-plan.ts) */
  plan: BatchPlan;
  /** the library variables the tables name, imported before the create ops run (tree-refs.ts) */
  imports: RefResolution["imports"];
  importCount: number;
  refs: ResolvedRefs;
}

export const isCreateOp = (op: WriteOp): boolean => CREATE_OPS.indexOf(op.op) >= 0;

/** A failure of create op `index` (applyCreates runs several ops, and the batch names the one that failed). */
export class CreateFailed extends Error {
  readonly index: number;
  readonly reason: unknown;
  constructor(index: number, reason: unknown) { super(errMsg(reason)); this.index = index; this.reason = reason; }
}

const getF = (o: object, k: string): unknown => Reflect.get(o, k);
/** The id a value aliases, or null. */
function aliasId(x: unknown): string | null {
  if (!x || typeof x !== "object" || getF(x, "type") !== "VARIABLE_ALIAS") return null;
  const id = getF(x, "id");
  return typeof id === "string" ? id : null;
}
const STYLE_TYPE: { readonly [K in StyleRow["kind"]]: StyleType } = { paint: "PAINT", text: "TEXT", effect: "EFFECT" };
/** The font a new text style starts with. */
const NEW_TEXT_FONT: FontName = { family: "Inter", style: "Regular" };

/**
 * Resolve every create op of a batch against the file. Every op is looked at, so the refusal lists every problem at
 * once. Reads only: nothing is made until applyCreates.
 */
export async function resolveCreateOps(ops: readonly WriteOp[]): Promise<CreateResolution> {
  const targets = new Map<number, CreateTarget>();
  const problems: OpProblem[] = [];
  const plan: BatchPlan = { variables: [], styles: [] };
  const empty: ResolvedRefs = { instances: new Map(), variables: new Map(), textStyles: new Map() };
  const none = { targets, problems, plan, imports: async () => ({ problems: [], revoked: false }), importCount: 0, refs: empty };
  if (!ops.some(isCreateOp)) return none;

  // They run before the rest of the batch, so they must come first in it: an op before them would run after them.
  const firstOther = ops.findIndex((o) => !isCreateOp(o));
  for (const [index, op] of ops.entries()) {
    if (firstOther >= 0 && index > firstOther && isCreateOp(op)) {
      problems.push({ index, op: op.op, message: op.op + " goes before every other op of a batch (it comes after ops[" + firstOther + "], a " + String(ops[firstOther] ? ops[firstOther].op : "") + "): move it first, so the ops after it can name what it makes" });
    }
  }

  let collections: VariableCollection[] = [];
  let locals: Variable[] = [];
  if (ops.some((o) => o.op === "createVariables")) {
    collections = await figma.variables.getLocalVariableCollectionsAsync();
    locals = await figma.variables.getLocalVariablesAsync();
  }
  const allRows: RowTarget[] = [];
  const collectionOps = new Map<string, number>();

  // ---- the variable tables: the collection, its modes, each row's variable
  for (const [index, op] of ops.entries()) {
    if (op.op !== "createVariables") continue;
    const bad = (message: string): void => { problems.push({ index, op: op.op, message }); };
    const { problems: shape, summary } = checkCreateVariables(op);
    if (shape.length) { bad("the table did not pass its check"); continue; }
    const name = summary.collection;
    const named = collections.filter((c) => c.id === name || c.name === name);
    if (named.length > 1) { bad("collection '" + name + "' matches " + named.length + " local collections — pass one's id: " + named.slice(0, 3).map((c) => "'" + c.name + "' (" + c.id + ")").join(", ")); continue; }
    const coll = named[0] || null;
    if (coll && coll.isExtension) { bad("collection '" + coll.name + "' extends another collection, whose modes and variables it takes: create them in that one"); continue; }
    const key = coll ? coll.id : "\u0000" + name;
    const twice = collectionOps.get(key);
    if (twice !== undefined) { bad("ops[" + twice + "] writes the collection '" + name + "' too; send one table per collection in a batch"); continue; }
    collectionOps.set(key, index);
    let ok = true;
    const modes: VariablesTarget["modes"] = [];
    const unlisted: string[] = [];
    if (coll) {
      if (!summary.modes.length) {
        const only = coll.modes[0];
        if (coll.modes.length !== 1 || !only) { bad("'" + coll.name + "' has " + coll.modes.length + " modes (" + quoteList(coll.modes.slice(0, 3).map((m) => m.name)) + "): list them in `modes`, one value per mode in each row"); continue; }
        modes.push({ name: only.name, modeId: only.modeId });
      } else {
        for (const m of summary.modes) {
          const hit = matchByName(m, coll.modes, (x) => x.name, (x) => [x.modeId]);
          if (hit.kind === "many") { bad("modes: '" + coll.name + "' has " + hit.matches.length + " modes named '" + m + "' — pass its modeId: " + hit.matches.slice(0, 3).map((x) => x.modeId).join(", ")); ok = false; continue; }
          modes.push({ name: hit.kind === "one" ? hit.item.name : m, modeId: hit.kind === "one" ? hit.item.modeId : null });
        }
        const ids = modes.map((m) => m.modeId);
        for (const [i, id] of ids.entries()) if (id !== null && ids.indexOf(id) !== i) { bad("modes: two entries name the mode '" + String(modes[i] ? modes[i].name : id) + "'"); ok = false; }
        for (const m of coll.modes) if (ids.indexOf(m.modeId) < 0) unlisted.push(m.modeId);
      }
    } else if (summary.modes.length) {
      for (const m of summary.modes) modes.push({ name: m, modeId: null });
    } else {
      modes.push({ name: "", modeId: null });
    }
    if (!ok) continue;
    const where = coll ? "in the collection '" + coll.name + "'" : "in the new collection '" + name + "'";
    const rows: RowTarget[] = [];
    for (const [i, row] of summary.rows.entries()) {
      const type = figmaType(row.type);
      const existing = coll ? locals.filter((v) => v.variableCollectionId === coll.id && v.name === row.name)[0] || null : null;
      if (existing && existing.resolvedType !== type) {
        bad("variables[" + i + "]: '" + row.name + "' is a " + existing.resolvedType.toLowerCase() + " variable in '" + (coll ? coll.name : name) + "', and a variable's type cannot change — give the " + row.type + " one another name");
        ok = false;
        continue;
      }
      const planned: Planned<Variable> | null = existing ? null : { name: row.name, op: index, where, type, made: null };
      if (planned) plan.variables.push(planned);
      rows.push({ op: index, index: i, name: row.name, type, values: row.values, existing, targets: [], planned, variable: existing });
    }
    if (!ok) continue;
    allRows.push(...rows);
    targets.set(index, { kind: "variables", name, collection: coll, modes, unlisted, rows });
  }

  // ---- the style tables: each style by name and kind
  let localStyles: AnyStyle[] | null = null;
  const styleOps = new Map<string, number>();
  for (const [index, op] of ops.entries()) {
    if (op.op !== "createStyles") continue;
    const bad = (message: string): void => { problems.push({ index, op: op.op, message }); };
    const { problems: shape, rows } = checkCreateStyles(op);
    if (shape.length) { bad("the table did not pass its check"); continue; }
    if (!localStyles) localStyles = [...(await figma.getLocalPaintStylesAsync()), ...(await figma.getLocalTextStylesAsync()), ...(await figma.getLocalEffectStylesAsync())];
    const all = localStyles;
    const out: StyleRowTarget[] = [];
    let ok = true;
    for (const [i, row] of rows.entries()) {
      const type = STYLE_TYPE[row.kind];
      const same = all.filter((st) => st.type === type && st.name === row.name);
      if (same.length > 1) { bad("styles[" + i + "]: " + same.length + " local " + row.kind + " styles are named '" + row.name + "' (" + same.slice(0, 3).map((st) => st.id).join(", ") + "); rename all but one in Figma, or change one by id with setStyle"); ok = false; continue; }
      const key = type + "\u0000" + row.name;
      const twice = styleOps.get(key);
      if (twice !== undefined && twice !== index) { bad("styles[" + i + "]: ops[" + twice + "] writes the " + row.kind + " style '" + row.name + "' too"); ok = false; continue; }
      styleOps.set(key, index);
      const existing = same[0] || null;
      const planned: Planned<AnyStyle> | null = existing ? null : { name: row.name, op: index, where: "as a " + row.kind + " style", kind: type, made: null };
      if (planned) plan.styles.push(planned);
      out.push({ index: i, row, existing, refs: new Map(), bound: [], planned });
    }
    if (ok) targets.set(index, { kind: "styles", rows: out });
  }

  // ---- what each alias, and each variable a style names, points to
  const uses: Use[] = [];
  const existingRows = new Set<string>();
  for (const r of allRows) if (r.existing) existingRows.add(r.existing.id);
  /** A name: a row of the op's own table first, then a row of another create table, then the file (tree-refs). */
  const lookup = (ref: string, own: number | null, use: Use, bad: (m: string) => void): Target | null => {
    const mine = own === null ? undefined : allRows.filter((r) => r.op === own && r.name === ref)[0];
    if (mine) return { row: mine };
    const rows = allRows.filter((r) => r.name === ref && r.op !== own);
    const inFile = locals.filter((v) => v.name === ref && !existingRows.has(v.id)).length;
    if (rows.length + inFile > 1) {
      bad(use.path + ": variable '" + ref + "' matches " + (rows.length + inFile) + " variables (" + rows.map((r) => "a row of ops[" + r.op + "]").concat(inFile ? [inFile + " in the file"] : []).join(", ") + ") — pass the one meant by key or id, or rename one");
      return null;
    }
    const row = rows[0];
    if (row) {
      if (row.op > use.index) { bad(use.path + ": '" + ref + "' is a row of ops[" + row.op + "], which runs after this op: put that table first"); return null; }
      return { row };
    }
    uses.push(use);
    return { ref };
  };
  const typeName = (t: VariableResolvedDataType): string => (t === "FLOAT" ? "number" : t.toLowerCase());
  for (const [index, t] of targets) {
    const bad = (message: string): void => { problems.push({ index, op: t.kind === "variables" ? "createVariables" : "createStyles", message }); };
    if (t.kind === "variables") {
      for (const r of t.rows) {
        r.targets = r.values.map((v, j) => {
          if (typeof v !== "object") return undefined;
          const path = "variables[" + r.index + "][" + (j + 2) + "].aliasOf";
          const found = lookup(v.aliasOf, index, { index, op: "createVariables", path, kind: "variable", ref: v.aliasOf, type: r.type }, bad);
          if (found && "row" in found && found.row.type !== r.type) { bad(path + ": '" + found.row.name + "' is a " + typeName(found.row.type) + " row, and '" + r.name + "' a " + typeName(r.type) + " one"); return undefined; }
          return found || undefined;
        });
      }
      continue;
    }
    for (const s of t.rows) {
      for (const u of styleUses(index, "createStyles", s.row.set, "styles[" + s.index + "].set")) {
        const found = lookup(u.ref, null, u, bad);
        if (found && "row" in found && u.type && found.row.type !== u.type) { bad(u.path + ": '" + found.row.name + "' is a " + typeName(found.row.type) + " row, and this field takes a " + typeName(u.type) + " variable"); continue; }
        if (found) s.refs.set(u.ref, found);
      }
    }
  }
  // Fonts: a text style's now (to set anything on it) and after (what its fields name) must load. A style whose font is
  // bound to a variable (which the tables may change), or whose `tokens` bind its font, is checked when it applies.
  const loaded = new Map<string, Promise<string | null>>();
  const loadFont = (f: FontName): Promise<string | null> => {
    const k = f.family + "|" + f.style;
    let p = loaded.get(k);
    if (!p) { p = figma.loadFontAsync(f).then(() => null, () => "font '" + f.family + " " + f.style + "' is not available in this file"); loaded.set(k, p); }
    return p;
  };
  for (const [index, t] of targets) {
    if (t.kind !== "styles") continue;
    for (const s of t.rows) {
      if (s.row.kind !== "text") continue;
      const st = s.existing && s.existing.type === "TEXT" ? s.existing : null;
      const bv = st ? st.boundVariables || {} : {};
      if (st) {
        for (const field of Object.keys(bv) as VariableBindableTextField[]) {
          const a = bv[field];
          if (!a) continue;
          let v: Variable | null = null;
          try { v = await figma.variables.getVariableByIdAsync(a.id); } catch { v = null; }
          if (v) s.bound.push({ field, variable: v });
        }
      }
      const tok = s.row.set.tokens || {};
      if (bv.fontFamily || bv.fontStyle || bv.fontWeight || tok.fontFamily !== undefined || tok.fontStyle !== undefined || tok.fontWeight !== undefined) continue;
      const now = st ? st.fontName : NEW_TEXT_FONT;
      for (const f of [now, fontAfter(now, s.row.set)]) {
        const err = await loadFont(f);
        if (err) { problems.push({ index, op: "createStyles", message: "styles[" + s.index + "]: text style '" + s.row.name + "': its " + err + " (check `font` and `weight`)" }); break; }
      }
    }
  }
  const r = await resolveRefs(uses, loadFont);
  problems.push(...r.problems);
  if (!problems.length) problems.push(...(await loops(targets, allRows, r.refs)));
  problems.sort((a, b) => a.index - b.index);
  return { targets, problems, plan, imports: r.imports, importCount: r.importCount, refs: r.refs };
}

/** A loop of aliases the tables would make through the file or another table (one inside a table is the shape check's,
 *  per mode). Followed across every mode: Figma refuses a loop in any of them. */
async function loops(targets: ReadonlyMap<number, CreateTarget>, rows: readonly RowTarget[], refs: ResolvedRefs): Promise<OpProblem[]> {
  const keyOf = (r: RowTarget): string => (r.existing ? "id:" + r.existing.id : "row:" + r.op + ":" + r.index);
  const byKey = new Map<string, RowTarget>();
  for (const r of rows) byKey.set(keyOf(r), r);
  const listedModes = new Map<number, Set<string>>();
  for (const [i, t] of targets) if (t.kind === "variables") listedModes.set(i, new Set(t.modes.map((m) => m.modeId).filter((m): m is string => m !== null)));
  const fileEdges = async (id: string, skip: ReadonlySet<string>): Promise<string[]> => {
    let v: Variable | null = null;
    try { v = await figma.variables.getVariableByIdAsync(id); } catch { v = null; }
    if (!v) return [];
    const out: string[] = [];
    for (const m of Object.keys(v.valuesByMode)) { if (skip.has(m)) continue; const a = aliasId(v.valuesByMode[m]); if (a) out.push("id:" + a); }
    return out;
  };
  const edges = async (key: string): Promise<string[]> => {
    const r = byKey.get(key);
    if (!r) return key.indexOf("id:") === 0 ? fileEdges(key.slice(3), new Set()) : [];
    const out: string[] = [];
    for (const t of r.targets) {
      if (!t) continue;
      if ("row" in t) out.push(keyOf(t.row));
      else { const v = refs.variables.get(t.ref); if (v) out.push("id:" + v.id); }
    }
    // An existing variable keeps the aliases of the modes its row does not set.
    if (r.existing) out.push(...(await fileEdges(r.existing.id, listedModes.get(r.op) || new Set())));
    return out;
  };
  const out: OpProblem[] = [];
  for (const start of rows) {
    if (!start.targets.some((t) => t !== undefined)) continue;
    const from = keyOf(start);
    // Breadth first, keeping each key's way back, so the loop can be named.
    const back = new Map<string, string>();
    const queue: string[] = [from];
    let found: string | null = null;
    while (queue.length && found === null) {
      const k = queue.shift();
      if (k === undefined) break;
      for (const n of await edges(k)) {
        if (n === from) { found = k; break; }
        if (back.has(n)) continue;
        back.set(n, k);
        queue.push(n);
      }
    }
    if (found === null) continue;
    const chain: string[] = [from];
    for (let k: string | undefined = found; k !== undefined && k !== from; k = back.get(k)) chain.splice(1, 0, k);
    // Every mode's aliases count together (a in one mode → b, b in another → a is a loop too), so a loop only the new
    // rows of one table make is refused here as well, though the shape check, per mode, passed it.
    const label = async (k: string): Promise<string> => {
      const r = byKey.get(k);
      if (r) return "'" + r.name + "'";
      let v: Variable | null = null;
      try { v = await figma.variables.getVariableByIdAsync(k.slice(3)); } catch { v = null; }
      return v ? "'" + v.name + "'" : k.slice(3);
    };
    const names: string[] = [];
    for (const k of chain.concat([from])) names.push(await label(k));
    out.push({ index: start.op, op: "createVariables", message: "variables[" + start.index + "]: the aliases " + names.join(" → ") + " make a loop" });
    break;
  }
  return out;
}

// ---------------------------------------------------------------- applying and putting back

/** A cell as Figma takes it: an alias of its target, an RGBA for a colour, else the value. */
function cellValue(v: SourceValue, target: Target | undefined, refs: ResolvedRefs, type: VariableResolvedDataType): VariableValue {
  if (typeof v === "object") {
    const to = target === undefined ? undefined : "row" in target ? target.row.variable : refs.variables.get(target.ref);
    if (!to) throw new Error("variable '" + v.aliasOf + "' was not resolved before the batch ran");
    return figma.variables.createVariableAlias(to);
  }
  if (type !== "COLOR") return v;
  const c = typeof v === "string" ? parseHexColor(v) : null;
  if (!c) throw new Error("'" + String(v) + "' is not a hex colour");
  return { r: c.r, g: c.g, b: c.b, a: c.a === undefined ? 1 : c.a };
}
/** A value as Figma holds it, copied (an RGBA or an alias object is frozen, and a later change must not reach it). */
const copyValue = (x: VariableValue | undefined): VariableValue | undefined => (x && typeof x === "object" ? JSON.parse(JSON.stringify(x)) as VariableValue : x);

const isAliasValue = (x: VariableValue | undefined): boolean => typeof x === "object" && x !== null && "type" in x && x.type === "VARIABLE_ALIAS";

/** A plain value of a type, held for a moment by a cell whose alias is being replaced. */
const placeholder = (type: VariableResolvedDataType): VariableValue =>
  type === "COLOR" ? { r: 0, g: 0, b: 0, a: 1 } : type === "FLOAT" ? 0 : type === "BOOLEAN" ? false : "";

/** Figma's refusal of a mode, with what to do when it is the file plan's limit. */
function modeRefused(what: string, e: unknown): Error {
  const msg = errMsg(e);
  return new Error("Figma refused " + what + ": " + msg + (/limit/i.test(msg) ? " (this file's Figma plan limits how many modes a collection has; send fewer modes, or move the file to a plan with more)" : ""));
}

/** Run one createVariables op: the collection and its modes, the variables, then every value. The Change removes what it
 *  made and sets back what it replaced; a failure partway is put back by the batch through the same Change. */
function applyVariables(t: VariablesTarget, refs: ResolvedRefs, consent: () => void, changes: Change[], clear: readonly VariablesTarget[], start: ReadonlyMap<Variable, string>): AppliedWrite {
  let coll = t.collection;
  let made = false;
  const added: Array<{ id: string; name: string }> = [];
  const createdVars: Variable[] = [];
  const kept: Array<{ v: Variable; modeId: string; value: VariableValue | undefined }> = [];
  /** the aliases of the batch's tables dropped before this one ran (`clear`), put back after everything else */
  const cleared: Array<{ v: Variable; modeId: string; value: VariableValue }> = [];
  const applied: AppliedWrite = {};
  const change: Change = {
    applied, kind: "created variable table", what: "the variables of the collection '" + t.name + "'",
    restore(allowed) {
      const check = (): void => { if (!allowed()) throw new RestoreStopped("'Allow edits' was turned off"); };
      if (made && coll) { check(); coll.remove(); }
      else {
        // Every value written, new variables' too, set back newest first: each step back is a state the apply passed
        // through, so none makes an alias loop.
        for (const k of kept.slice().reverse()) { check(); if (k.value !== undefined) k.v.setValueForMode(k.modeId, k.value); }
        for (const v of createdVars.slice().reverse()) { check(); v.remove(); }
        for (const m of added.slice().reverse()) { check(); if (coll) coll.removeMode(m.id); }
      }
      for (const k of cleared.slice().reverse()) { check(); k.v.setValueForMode(k.modeId, k.value); }
    },
  };
  changes.push(change);
  consent();
  // Every alias an existing variable holds in a mode some table of the batch sets is dropped first (a plain placeholder
  // of its type), so an old alias a later table replaces cannot close a loop with a new alias an earlier one sets.
  for (const other of clear) {
    for (const r of other.rows) {
      const v = r.existing;
      if (!v) continue;
      other.modes.forEach((m, j) => {
        if (m.modeId === null || r.values[j] === undefined) return;
        const old = copyValue(v.valuesByMode[m.modeId]);
        if (!isAliasValue(old) || old === undefined) return;
        consent();
        try { v.setValueForMode(m.modeId, placeholder(r.type)); } catch (e) { throw modeRefused("the value of '" + r.name + "' for mode '" + m.name + "'", e); }
        cleared.push({ v, modeId: m.modeId, value: old });
      });
    }
  }
  if (!coll) { coll = figma.variables.createVariableCollection(t.name); made = true; }
  const c = coll;
  const ids: string[] = [];
  for (const [i, m] of t.modes.entries()) {
    if (m.modeId !== null) { ids.push(m.modeId); continue; }
    consent();
    if (made && i === 0) {
      // A new collection's first mode is its default one, named as asked.
      if (m.name && c.modes[0] && c.modes[0].name !== m.name) c.renameMode(c.defaultModeId, m.name);
      ids.push(c.defaultModeId);
      continue;
    }
    let id: string;
    try { id = c.addMode(m.name); } catch (e) { throw modeRefused("the mode '" + m.name + "' of '" + t.name + "'", e); }
    added.push({ id, name: m.name });
    ids.push(id);
  }
  applied.id = c.id;
  for (const r of t.rows) {
    if (r.existing) continue;
    consent();
    const v = figma.variables.createVariable(r.name, c, r.type);
    createdVars.push(v);
    r.variable = v;
    if (r.planned) r.planned.made = v;
  }
  // Every cell the table sets: (row, mode, which value).
  interface Cell { r: RowTarget; v: Variable; modeId: string; mode: string; cell: number }
  const cells: Cell[] = [];
  const before = new Map<RowTarget, string>();
  for (const r of t.rows) {
    const v = r.variable;
    if (!v) throw new Error("variable '" + r.name + "' was not made");
    const was = r.existing ? start.get(r.existing) : undefined;
    before.set(r, r.existing ? (was !== undefined ? was : JSON.stringify(v.valuesByMode)) : "");
    t.modes.forEach((m, j) => { const id = ids[j]; if (id !== undefined && r.values[j] !== undefined) cells.push({ r, v, modeId: id, mode: m.name, cell: j }); });
    // A new variable in a collection whose other modes the table leaves out: its first value there too.
    if (!r.existing && r.values[0] !== undefined) for (const id of t.unlisted) cells.push({ r, v, modeId: id, mode: "", cell: 0 });
  }
  // Two passes, so no step passes through an alias loop the finished table does not have (in any mode, whatever the
  // row order, through variables outside the table too). First every cell the table sets drops the alias it holds
  // (raw cells take their value; alias cells a plain placeholder of the type); then the aliases are set. Every
  // graph in between is part of the finished one, which the up-front check found free of loops.
  const write = (c: Cell, value: VariableValue): void => {
    consent();
    const old = copyValue(c.v.valuesByMode[c.modeId]);
    try { c.v.setValueForMode(c.modeId, value); } catch (e) { throw modeRefused("the value of '" + c.r.name + "' for mode '" + (c.mode || "the default") + "'", e); }
    kept.push({ v: c.v, modeId: c.modeId, value: old });
  };
  const aliasCells: Cell[] = [];
  for (const c of cells) {
    const value = c.r.values[c.cell];
    if (value === undefined) continue;
    if (typeof value === "object") {
      aliasCells.push(c);
      if (isAliasValue(c.v.valuesByMode[c.modeId])) write(c, placeholder(c.r.type));
      continue;
    }
    write(c, cellValue(value, c.r.targets[c.cell], refs, c.r.type));
  }
  for (const c of aliasCells) {
    const value = c.r.values[c.cell];
    if (value !== undefined) write(c, cellValue(value, c.r.targets[c.cell], refs, c.r.type));
  }
  const outcome: Array<[string, CreateOutcome]> = [];
  for (const r of t.rows) {
    const v = r.variable;
    if (!v) throw new Error("variable '" + r.name + "' was not made");
    outcome.push([v.id, !r.existing ? "created" : JSON.stringify(v.valuesByMode) === before.get(r) ? "unchanged" : "updated"]);
  }
  applied.result = made ? "created" : added.length ? "updated" : "unchanged";
  if (added.length && !made) applied.modesAdded = added.map((m) => m.name);
  applied.rows = outcome;
  return applied;
}

/** Run one createStyles op: each style made (or found) and its fields set by applyStyle (sources.ts), which keeps what
 *  it replaces. The Change puts the edited styles back and removes the new ones. */
async function applyStyles(t: StylesTarget, refs: ResolvedRefs, consent: () => void, changes: Change[]): Promise<AppliedWrite> {
  const made: AnyStyle[] = [];
  const edits: Change[] = [];
  const applied: AppliedWrite = {};
  const change: Change = {
    applied, kind: "created style table", what: "the styles of a createStyles table",
    async restore(allowed) {
      for (const e of edits.slice().reverse()) await e.restore(allowed);
      for (const st of made.slice().reverse()) { if (!allowed()) throw new RestoreStopped("'Allow edits' was turned off"); st.remove(); }
    },
  };
  changes.push(change);
  const outcome: Array<[string, CreateOutcome]> = [];
  for (const s of t.rows) {
    consent();
    let st = s.existing;
    if (!st) {
      st = s.row.kind === "paint" ? figma.createPaintStyle() : s.row.kind === "text" ? figma.createTextStyle() : figma.createEffectStyle();
      made.push(st);
      st.name = s.row.name;
      if (s.planned) s.planned.made = st;
    }
    const variables = new Map<string, Variable>();
    for (const [ref, target] of s.refs) {
      const v = "row" in target ? target.row.variable : refs.variables.get(target.ref);
      if (!v) throw new Error("variable '" + ref + "' was not resolved before the batch ran");
      variables.set(ref, v);
    }
    const before = s.existing ? styleSnapshot(st) : "";
    const target: StyleTarget = { style: st, set: s.row.set, refs: { instances: new Map(), variables, textStyles: new Map() }, font: null, bound: s.bound };
    edits.push(await applyStyle(target, consent));
    outcome.push([st.id, !s.existing ? "created" : styleSnapshot(st) === before ? "unchanged" : "updated"]);
  }
  applied.rows = outcome;
  return applied;
}

/**
 * Run the batch's create ops, in order, before any other op: each pushes its Change onto `changes` before it changes
 * anything, so a failure partway (or a later op's) puts it back with the rest of the batch. Their library imports have
 * run (`res.imports`), so every variable a table names is in the file. A failure is thrown as CreateFailed, naming the
 * op. Returns each op's applied row.
 */
export async function applyCreates(res: CreateResolution, consent: () => void, changes: Change[]): Promise<Map<number, AppliedWrite>> {
  const rows = new Map<number, AppliedWrite>();
  const ordered = [...res.targets].sort((a, b) => a[0] - b[0]);
  // Before the first alias is set, every alias the batch's tables replace on an existing variable is dropped (a
  // plain placeholder of its type), so an old alias a later table replaces cannot close a loop with a new alias an
  // earlier one sets. The first variable table does it, as the first thing its Change puts back last.
  const tables = ordered.map(([, t]) => t).filter((t): t is VariablesTarget => t.kind === "variables");
  // Each existing variable's values before anything runs, for "unchanged" (the clearing changes them first).
  const start = new Map<Variable, string>();
  for (const t of tables) for (const r of t.rows) if (r.existing) start.set(r.existing, JSON.stringify(r.existing.valuesByMode));
  let first = true;
  for (const [index, t] of ordered) {
    try {
      const clear = t.kind === "variables" && first ? tables : [];
      if (t.kind === "variables") first = false;
      rows.set(index, t.kind === "variables" ? applyVariables(t, res.refs, consent, changes, clear, start) : await applyStyles(t, res.refs, consent, changes));
    } catch (e) {
      throw new CreateFailed(index, e);
    }
  }
  return rows;
}

// ---------------------------------------------------------------- the dry run

/** The dry run's file-side half for the create ops: what each would make and what it would update in place (a problem
 *  the file gives instead, when it has one). Reads only. */
export async function createImpact(ops: readonly WriteOp[]): Promise<WriteImpactReply> {
  const res = await resolveCreateOps(ops);
  const steps: WriteImpactReply["steps"] = [];
  for (const [index, op] of ops.entries()) {
    if (!isCreateOp(op)) continue;
    const mine = res.problems.filter((p) => p.index === index);
    if (mine.length) { steps.push({ index, op: op.op, problem: mine.map((p) => p.message).join("; ") }); continue; }
    const t = res.targets.get(index);
    if (!t) continue;
    const plan: CreatePlan = { create: [], update: [] };
    if (t.kind === "variables") {
      if (!t.collection) plan.create.push("collection '" + t.name + "'");
      t.modes.forEach((m, i) => { if (m.modeId === null && !(i === 0 && !t.collection)) plan.create.push("mode '" + m.name + "'"); });
      for (const r of t.rows) (r.existing ? plan.update : plan.create).push(r.name);
    } else {
      for (const s of t.rows) (s.existing ? plan.update : plan.create).push(s.row.name);
    }
    steps.push({ index, op: op.op, plan });
  }
  return { steps };
}

/** The dry run's whole file-side half (the `writeImpact` command): the source edits' counts and the create ops' plans,
 *  in op order. */
export async function designImpact(ops: readonly WriteOp[]): Promise<WriteImpactReply> {
  // writeImpact counts only the source edits; the create ops are answered here.
  const sources = await writeImpact(ops);
  const creates = await createImpact(ops);
  const steps = [...sources.steps, ...creates.steps].sort((a, b) => a.index - b.index);
  return sources.warnings ? { steps, warnings: sources.warnings } : { steps };
}
