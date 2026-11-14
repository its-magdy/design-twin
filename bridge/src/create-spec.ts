// create-spec.ts — a design system started from nothing: a table of variables (`createVariables`) and a table of styles
// (`createStyles`), each sent as one op (docs/write-plane-spec.md, "Starting from nothing"; decisions 4, 5, 11).
//
//   createVariables  {collection, modes?, variables: [[name, type, value per mode…], …]} — the collection (by its local
//                    name; made when no local one has it), its modes (each made when the collection lacks it) and one row
//                    per variable. `type` is color | number | string | boolean; there is one value cell per mode, in
//                    `modes` order (one cell, and no `modes`, for a collection with one mode). A cell is the read
//                    export's value (variables.json `values`): a hex colour, a number, a string, a boolean, or
//                    `{aliasOf: <variable>}` — a row of the same table (before or after it), a variable another
//                    createVariables of the batch makes, or a variable the file has.
//   createStyles     {styles: [{name, kind, set}, …]} — `kind` paint | text | effect, `set` the setStyle fields
//                    (source-spec.ts checkStyleSet): a paint bound to a variable is `{type:"solid", tokens:{color}}`, a
//                    text style's fields bound through `tokens`, a shadow's or a blur's through the effect's `tokens`.
//
// A name the file already has is updated in place, never duplicated: a local collection by name, a variable by name
// within it, a style by name and kind. Only this file's own count: a library's collection or style with the same name
// does not, and a local one is made beside it. Both ops go before every other op of a batch, so the specs and patches
// after them can name what they make.
//
// This module is the shape check — everything that needs no file: the table's form, each cell against its row's type,
// a name twice in one table, an alias inside the table to a row of another type or round a loop. Run by the dry run,
// the wire check and the plugin alike; the plugin (figma-plugin/src/creates.ts) checks the rest against the file.
// Pure and dependency-free (bar pure siblings): the plugin bundle imports it, so it must type-check under
// figma-plugin/tsconfig.json (ES2019 lib, no Node types).
import { parseHexColor } from "./hex-color.ts";
import { nearestNames, quoteList } from "./name-match.ts";
import { checkSourceValue, checkStyleSet, type SourceValue, type StyleKindName, type StyleSet } from "./source-spec.ts";

/** A row's `type`, and the Figma type it makes. */
export const VARIABLE_TYPE_NAMES = ["color", "number", "string", "boolean"] as const;
export type VariableTypeName = (typeof VARIABLE_TYPE_NAMES)[number];
export type FigmaVariableType = "COLOR" | "FLOAT" | "STRING" | "BOOLEAN";
export function figmaType(t: VariableTypeName): FigmaVariableType {
  return t === "color" ? "COLOR" : t === "number" ? "FLOAT" : t === "string" ? "STRING" : "BOOLEAN";
}
/** The most rows one table takes (a larger set is several ops, or several calls). */
export const MAX_TABLE_ROWS = 1000;

/** One row of a createVariables table, checked. */
export interface VariableRow {
  name: string;
  type: VariableTypeName;
  /** one per mode, in `modes` order (one when the op gives no `modes`) */
  values: SourceValue[];
}
/** What a valid createVariables makes or updates. */
export interface CreateVariablesSummary {
  collection: string;
  /** the modes, in order; empty when the op gives none (the collection's one mode) */
  modes: string[];
  rows: VariableRow[];
  /** the variables its aliases name that are not rows of the table (resolved against the batch and the file) */
  outside: string[];
}
/** One row of a createStyles table, checked. */
export interface StyleRow {
  name: string;
  kind: StyleKindName;
  set: StyleSet;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isTypeName = (v: unknown): v is VariableTypeName => typeof v === "string" && (VARIABLE_TYPE_NAMES as readonly string[]).indexOf(v) >= 0;

/** Why `v` cannot be a value of a `type` row (an alias is checked by its target), or null. */
export function cellProblem(v: SourceValue, type: VariableTypeName): string | null {
  if (typeof v === "object") return null;
  if (type === "color") return typeof v === "string" && parseHexColor(v) ? null : "a color row takes a hex colour (#rrggbb or #rrggbbaa) or {aliasOf}";
  if (type === "number") return isNum(v) ? null : "a number row takes a number or {aliasOf}";
  if (type === "string") return typeof v === "string" ? null : "a string row takes a string or {aliasOf}";
  return typeof v === "boolean" ? null : "a boolean row takes true, false or {aliasOf}";
}

/** Every problem with a createVariables op (each starting with its path), and what a valid one makes. */
export function checkCreateVariables(o: { collection?: unknown; modes?: unknown; variables?: unknown }, path = ""): { problems: string[]; summary: CreateVariablesSummary } {
  const at = (k: string): string => (path ? path + "." : "") + k;
  const summary: CreateVariablesSummary = { collection: typeof o.collection === "string" ? o.collection : "", modes: [], rows: [], outside: [] };
  const problems: string[] = [];
  if (!nonEmpty(o.collection)) problems.push(at("collection") + ": must be the collection's name (a non-empty string)");
  let width = 1;
  if (o.modes !== undefined) {
    if (!Array.isArray(o.modes) || !o.modes.length) problems.push(at("modes") + ": must be a list of mode names, e.g. [\"Light\", \"Dark\"] (leave it out for a collection with one mode)");
    else {
      const seen = new Set<string>();
      for (const [i, m] of o.modes.entries()) {
        if (!nonEmpty(m)) { problems.push(at("modes") + "[" + i + "]: must be a mode name (a non-empty string)"); continue; }
        if (seen.has(m)) { problems.push(at("modes") + "[" + i + "]: '" + m + "' is listed twice"); continue; }
        seen.add(m);
        summary.modes.push(m);
      }
      width = o.modes.length;
    }
  }
  if (!Array.isArray(o.variables) || !o.variables.length) {
    problems.push(at("variables") + ": must be a list of rows [name, type, value per mode…], e.g. [[\"color/brand\", \"color\", \"#4f46e5\"]]");
    return { problems, summary };
  }
  if (o.variables.length > MAX_TABLE_ROWS) problems.push(at("variables") + ": " + o.variables.length + " rows; one op takes at most " + MAX_TABLE_ROWS + " (send the rest in another op)");
  const names = new Map<string, number>();
  for (const [i, row] of o.variables.entries()) {
    const rp = at("variables") + "[" + i + "]";
    if (!Array.isArray(row)) { problems.push(rp + ": must be a row [name, type, value per mode…]"); continue; }
    const [name, type, ...cells] = row as unknown[];
    if (!nonEmpty(name)) { problems.push(rp + "[0]: must be the variable's name (a non-empty string)"); continue; }
    if (!isTypeName(type)) {
      const near = typeof type === "string" ? nearestNames(type, VARIABLE_TYPE_NAMES) : [];
      problems.push(rp + "[1]: the type of '" + name + "' must be one of " + VARIABLE_TYPE_NAMES.join(" | ") + (near.length ? "; closest: " + quoteList(near) : ""));
      continue;
    }
    const was = names.get(name);
    if (was !== undefined) { problems.push(rp + "[0]: '" + name + "' is row " + was + " too; a name is one row"); continue; }
    names.set(name, i);
    if (cells.length !== width) {
      problems.push(rp + ": '" + name + "' has " + cells.length + " value" + (cells.length === 1 ? "" : "s") + ", and " +
        (o.modes === undefined ? "a collection with one mode (no `modes`) takes one" : "`modes` lists " + width + " — one per mode, in that order"));
      continue;
    }
    let ok = true;
    const values: SourceValue[] = [];
    for (const [j, cell] of cells.entries()) {
      const cp = rp + "[" + (j + 2) + "]";
      const bad = checkSourceValue(cell);
      if (bad !== null) { problems.push(cp + (bad.startsWith(".") ? "" : ": ") + bad); ok = false; continue; }
      const value = cell as SourceValue;
      const wrong = cellProblem(value, type);
      if (wrong !== null) { problems.push(cp + ": " + wrong + " ('" + name + "' is a " + type + " row)"); ok = false; continue; }
      values.push(value);
    }
    if (ok) summary.rows.push({ name, type, values });
  }
  if (problems.length) return { problems, summary };
  // Aliases inside the table: the row named must hold the same type, and no chain of them may come back to its start.
  const byName = new Map<string, VariableRow>();
  for (const r of summary.rows) byName.set(r.name, r);
  for (const [i, r] of summary.rows.entries()) {
    for (const [j, v] of r.values.entries()) {
      if (typeof v !== "object") continue;
      const target = byName.get(v.aliasOf);
      const cp = at("variables") + "[" + i + "][" + (j + 2) + "].aliasOf";
      if (!target) { if (summary.outside.indexOf(v.aliasOf) < 0) summary.outside.push(v.aliasOf); continue; }
      if (target === r) { problems.push(cp + ": '" + r.name + "' cannot alias itself"); continue; }
      if (target.type !== r.type) problems.push(cp + ": '" + target.name + "' is a " + target.type + " row, and '" + r.name + "' is a " + r.type + " one");
    }
  }
  const loop = tableLoop(summary.rows, byName, summary.modes.length || 1);
  if (loop) problems.push(at("variables") + ": " + loop);
  return { problems, summary };
}

/** A loop of aliases inside the table, in one mode, as a sentence ("'a' → 'b' → 'a' in mode 2"), or null. */
function tableLoop(rows: readonly VariableRow[], byName: ReadonlyMap<string, VariableRow>, width: number): string | null {
  for (let m = 0; m < width; m++) {
    for (const start of rows) {
      const chain: VariableRow[] = [start];
      const seen = new Set<VariableRow>([start]);
      for (let cur: VariableRow = start; ;) {
        const v = cur.values[m];
        const next = v !== undefined && typeof v === "object" ? byName.get(v.aliasOf) : undefined;
        if (!next || next === cur) break;
        chain.push(next);
        if (next === start) return "the aliases " + chain.map((r) => "'" + r.name + "'").join(" → ") + " make a loop" + (width > 1 ? " (mode " + (m + 1) + ")" : "");
        if (seen.has(next)) break; // a loop that does not pass through `start`: reported from one of its own rows
        seen.add(next);
        cur = next;
      }
    }
  }
  return null;
}

/** Every problem with a createStyles op (each starting with its path), and its rows. */
export function checkCreateStyles(o: { styles?: unknown }, path = ""): { problems: string[]; rows: StyleRow[] } {
  const at = (k: string): string => (path ? path + "." : "") + k;
  const rows: StyleRow[] = [];
  const problems: string[] = [];
  if (!Array.isArray(o.styles) || !o.styles.length) {
    return { problems: [at("styles") + ": must be a list of styles {name, kind: paint | text | effect, set}, e.g. [{name: \"Brand\", kind: \"paint\", set: {paints: [{type: \"solid\", tokens: {color: \"color/brand\"}}]}}]"], rows };
  }
  if (o.styles.length > MAX_TABLE_ROWS) problems.push(at("styles") + ": " + o.styles.length + " styles; one op takes at most " + MAX_TABLE_ROWS);
  const seen = new Map<string, number>();
  for (const [i, s] of o.styles.entries()) {
    const sp = at("styles") + "[" + i + "]";
    if (!isObj(s)) { problems.push(sp + ": must be a style {name, kind, set}"); continue; }
    const extra = Object.keys(s).filter((k) => k !== "name" && k !== "kind" && k !== "set" && s[k] !== undefined);
    for (const k of extra) {
      const near = nearestNames(k, ["name", "kind", "set"]);
      problems.push(sp + "." + k + ": not a field of a style row (it is {name, kind, set}" + (near.length ? "; closest: " + quoteList(near) : "") + ")");
    }
    if (!nonEmpty(s.name)) { problems.push(sp + ".name: must be the style's name (a non-empty string)"); continue; }
    const kind = s.kind;
    if (kind !== "paint" && kind !== "text" && kind !== "effect") { problems.push(sp + ".kind: must be paint | text | effect"); continue; }
    if (isObj(s.set) && s.set.name !== undefined) { problems.push(sp + ".set.name: a new style is named by the row's `name` (rename an existing one with setStyle)"); continue; }
    const { problems: bad, summary } = checkStyleSet(s.set, sp + ".set");
    if (bad.length) { problems.push(...bad); continue; }
    if (summary.kind !== null && summary.kind !== kind) { problems.push(sp + ".set: its fields are a " + summary.kind + " style's, and the row says " + kind); continue; }
    const key = kind + "\u0000" + s.name;
    const was = seen.get(key);
    if (was !== undefined) { problems.push(sp + ".name: the " + kind + " style '" + s.name + "' is styles[" + was + "] too; a name is one row per kind"); continue; }
    seen.set(key, i);
    if (extra.length) continue;
    rows.push({ name: s.name, kind, set: s.set as StyleSet });
  }
  return { problems, rows };
}

/** A value as the dry run shows it. */
const shown = (v: SourceValue): string => (typeof v === "object" ? "alias of '" + v.aliasOf + "'" : JSON.stringify(v));

/** The dry run's sentence for a valid createVariables. */
export function describeCreateVariables(s: CreateVariablesSummary): string {
  const types = VARIABLE_TYPE_NAMES.map((t) => [t, s.rows.filter((r) => r.type === t).length] as const).filter(([, n]) => n > 0).map(([t, n]) => n + " " + t);
  const first = s.rows[0];
  return "collection '" + s.collection + "'" + (s.modes.length ? " (modes " + quoteList(s.modes) + ")" : " (one mode)") + ": " + s.rows.length + " variable" + (s.rows.length === 1 ? "" : "s") +
    " (" + types.join(", ") + ")" + (first ? ", e.g. '" + first.name + "' = " + first.values.map(shown).join(" / ") : "") +
    " — a local collection, mode or variable with the same name is updated in place (a library's is not matched), the rest are created; the ops after it in the batch can name them";
}
/** The dry run's sentence for a valid createStyles. */
export function describeCreateStyles(rows: readonly StyleRow[]): string {
  const kinds = (["paint", "text", "effect"] as const).map((k) => [k, rows.filter((r) => r.kind === k).length] as const).filter(([, n]) => n > 0).map(([k, n]) => n + " " + k);
  return rows.length + " style" + (rows.length === 1 ? "" : "s") + " (" + kinds.join(", ") + "): " + quoteList(rows.slice(0, 3).map((r) => r.name)) + (rows.length > 3 ? " and " + (rows.length - 3) + " more" : "") +
    " — a local style with the same name and kind is updated in place (a library's is not matched), the rest are created; the ops after it in the batch can name them";
}
