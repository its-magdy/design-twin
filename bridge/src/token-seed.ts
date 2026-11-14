// token-seed.ts — a project's code tokens read back into the create tables (`seedTokens`, docs/write-plane-spec.md
// "Starting from nothing"). The file a project's tokens live in becomes createVariables tables (one per collection) and
// one createStyles table, which figma_write sends as if they had been written inline: so no token value passes
// through the model, and every check, the dry run and the one-undo write are the create tables' own.
//
// Read (the formats design-to-code/tokens.ts writes, and hand-written DTCG 2025.10):
//   tokens.dtcg.json      one DTCG tree. Its modes ride in $extensions["figma.com"].modes; it names no collection, so the
//                         tokens go into one collection (the op's `collection`, "Tokens" by default) — or, when they
//                         carry different sets of modes, one per set of modes, "<collection> (<mode> / <mode>)" (a
//                         number after a name two sets would share). The default mode goes first: its
//                         $extensions["figma.com"].defaultMode, else the one mode whose value is the $value, else
//                         the key order.
//   tokens.resolver.json  a DTCG resolver: each set is a collection (its $extensions["figma.com"].collection, else the
//                         set's name), and the modifier of that collection gives its modes (the default first). A
//                         context file holds only what differs from the set's values.
// Not read: tokens.css, Tailwind's theme.css and the native files. A CSS name has lost the `/` grouping.
//
// Mapping:
//   names        the DTCG path joined with `/` (color.brand.primary → color/brand/primary); `{a.b}` → {aliasOf: "a/b"}
//   color        a hex string, or {colorSpace: "srgb", components, alpha?} → #rrggbb / #rrggbbaa (another colour space:
//                its `hex`, if it has one). A numeric $extensions["figma.com"].opacity (0–100) goes into the alpha.
//   dimension    px → a number; rem and em × 16 (the browser default font size)
//   number, string, boolean (a string token with $extensions["figma.com"].originalType "boolean"), fontFamily (the
//                first family of a list), fontWeight (a named weight → its number)
//   typography   a text style; shadow an effect style. A sub-value that is a `{ref}` is bound to that variable. A style
//                has no modes: the default mode's value is seeded, and a mode whose value differs is listed in `partly`.
// A token with children (a token cannot also be a group; DTCG puts a group's own token in `$root`): each child listed.
// Anything else (gradient, cubicBezier, duration, border, transition, strokeStyle, an unknown type, a bad value, an
// alias to a token that is not here) is listed in `unmapped` with the reason, never dropped silently. A token that is
// seeded but not in full (a style's other modes, extended-collection overrides, a name two paths or two sets reach)
// is listed in `partly` with what was left out. A description is not carried (the create tables have no field for it).
//
// Names come from the project's files, so they are never keys of a plain object: Maps, own-property reads.
// Pure: no Node, no file system (the files are read by seed-file.ts).
import { cellProblem, MAX_TABLE_ROWS, type VariableTypeName } from "./create-spec.ts";
import { formatHex, parseHexColor } from "./hex-color.ts";
import { isUnknownArray } from "./json-util.ts";
import { checkStyleSet, type EffectSpec, type SourceValue, type StyleSet } from "./source-spec.ts";

/** A token that is not seeded (or, in `partly`, seeded only in part), and why. */
export interface SeedUnmapped { token: string; reason: string }
/** One row of a seeded createVariables table: [name, type, a value per mode…]. */
export type SeedRow = [string, VariableTypeName, ...SourceValue[]];
export interface SeedVariablesOp { op: "createVariables"; collection: string; modes?: string[]; variables: SeedRow[] }
export interface SeedStyle { name: string; kind: "text" | "effect"; set: StyleSet }
export interface SeedStylesOp { op: "createStyles"; styles: SeedStyle[] }
export type SeedOp = SeedVariablesOp | SeedStylesOp;
/** The tables a token file makes (variables first, in an order where each table's aliases name earlier ones), the
 *  tokens in no table (`unmapped`), and the tokens in a table but seeded only in part (`partly`). */
export interface SeedResult { ops: SeedOp[]; unmapped: SeedUnmapped[]; partly: SeedUnmapped[] }
export type SeedOutcome = SeedResult | { error: string };

/** The collection a tokens.dtcg.json lands in when the op names none. */
export const DEFAULT_SEED_COLLECTION = "Tokens";
/** The formats seedTokens reads, as a refusal names them. */
export const SEED_FORMATS = "a DTCG token file (tokens.dtcg.json) or a DTCG resolver (tokens.resolver.json) with its set and context files";
/** The browser's default font size: what a rem or an em is taken to be. */
export const REM_PX = 16;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** An own property of a parsed JSON object (JSON.parse makes "__proto__" an own key; a plain read could reach the
 *  prototype for a key the object lacks). */
function own(o: Obj, k: string): unknown {
  const d = Object.getOwnPropertyDescriptor(o, k);
  return d ? d.value : undefined;
}
const hasOwn = (o: Obj, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
/** Are two parsed JSON values the same, whatever their keys' order? Own keys only ("__proto__" included). */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => sameJson(x, b[i]));
  }
  if (!isObj(a) || !isObj(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => hasOwn(b, k) && sameJson(own(a, k), own(b, k)));
}
/** The `figma.com` extension of a token, or null. */
function figmaExt(node: Obj): Obj | null {
  const ext = own(node, "$extensions");
  const f = isObj(ext) ? own(ext, "figma.com") : undefined;
  return isObj(f) ? f : null;
}

/** Is this parsed JSON a DTCG resolver document (rather than a token tree)? By its content, not its file name: a
 *  `resolutionOrder` list, or a `sets` entry with a `sources` list (the shape a set must have). A token tree may have a
 *  group, or a token, named `sets`. */
export function isResolverDoc(doc: unknown): boolean {
  if (!isObj(doc)) return false;
  if (Array.isArray(own(doc, "resolutionOrder"))) return true;
  const sets = own(doc, "sets");
  return isObj(sets) && Object.values(sets).some((s) => isObj(s) && Array.isArray(own(s, "sources")));
}

// ---------------------------------------------------------------- a token tree, flattened

/** One token of a DTCG tree: its `/` name, its $type (its own, or a group's above it), its $value and its figma.com
 *  extension. */
interface RawToken { name: string; type: string | null; value: unknown; ext: Obj | null }

/** The tokens of a DTCG tree by name, in document order. A name reached twice (a key with `/` in it), an empty name, a
 *  name an alias could not spell, a group's $extends: listed. */
function flatten(doc: unknown, g: Gather): Map<string, RawToken> {
  const { unmapped } = g;
  const out = new Map<string, RawToken>();
  /** The tokens under a token (a token and a group cannot share a name: DTCG puts a group's own token in `$root`). */
  const inside = (node: Obj, path: readonly string[], token: string): void => {
    for (const [k, child] of Object.entries(node)) {
      if (k.startsWith("$")) continue;
      const at = [...path, k];
      if (!isObj(child) || hasOwn(child, "$value")) unmapped.push({ token: at.join("/"), reason: "it is inside token '" + token + "' (a token cannot also be a group; a group's own token goes in $root)" });
      if (isObj(child)) inside(child, at, token);
    }
  };
  const leaf = (path: readonly string[], node: Obj, inherited: string | null): void => {
    const name = path.join("/");
    inside(node, path, name || "$root");
    if (!path.length) { unmapped.push({ token: "$root", reason: "a token needs a name" }); return; }
    if (out.has(name)) { g.part(name, "two paths make this name once joined with '/'; the first is seeded"); return; }
    const t = own(node, "$type");
    out.set(name, { name, type: typeof t === "string" ? t : inherited, value: own(node, "$value"), ext: figmaExt(node) });
  };
  const walk = (node: Obj, path: readonly string[], inherited: string | null): void => {
    const t = own(node, "$type");
    const type = typeof t === "string" ? t : inherited;
    if (own(node, "$extends") !== undefined) unmapped.push({ token: path.join("/") || "(the root group)", reason: "a group's $extends is not read; give its tokens in full" });
    for (const [k, child] of Object.entries(node)) {
      if (k.startsWith("$")) {
        // DTCG 2025.10: `$root` is the group's own token, named by the group's path.
        if (k === "$root" && isObj(child) && hasOwn(child, "$value")) leaf(path, child, type);
        continue;
      }
      const at = [...path, k];
      if (!k.trim()) { unmapped.push({ token: at.join("/"), reason: "an empty name" }); continue; }
      if (/[.{}]/.test(k)) { unmapped.push({ token: at.join("/"), reason: "a name with '.', '{' or '}' (no alias could name it)" }); continue; }
      if (!isObj(child)) { unmapped.push({ token: at.join("/"), reason: "neither a token (no $value) nor a group" }); continue; }
      if (hasOwn(child, "$value")) leaf(at, child, type);
      else walk(child, at, type);
    }
  };
  if (isObj(doc)) walk(doc, [], null);
  return out;
}

// ---------------------------------------------------------------- values

/** A value, or why it cannot be one. */
type Parsed<T> = { ok: T } | { bad: string };
const ALIAS_RE = /^\{([^{}]+)\}$/;
/** The `/` name a `{a.b}` reference names, or null. */
function aliasName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = ALIAS_RE.exec(v.trim());
  return m && m[1] ? m[1].split(".").join("/") : null;
}
const shownValue = (v: unknown): string => { const s = JSON.stringify(v); return s === undefined ? String(v) : s.length > 60 ? s.slice(0, 57) + "…" : s; };

/** A DTCG colour as a hex: a hex string, or a structured colour (sRGB from its components; another space only through
 *  its `hex` fallback). `opacity` (0–100) multiplies the alpha. */
function parseColor(v: unknown, opacity = 100): Parsed<string> {
  const withAlpha = (r: number, g: number, b: number, a: number): Parsed<string> => ({ ok: formatHex({ r: r * 255, g: g * 255, b: b * 255, a: a * Math.min(100, Math.max(0, opacity)) / 100 }) });
  if (typeof v === "string") {
    const c = parseHexColor(v.trim());
    return c ? withAlpha(c.r, c.g, c.b, c.a === undefined ? 1 : c.a) : { bad: "not a colour: " + shownValue(v) };
  }
  if (!isObj(v)) return { bad: "not a colour: " + shownValue(v) };
  const space = own(v, "colorSpace"), comps = own(v, "components"), alphaV = own(v, "alpha"), hex = own(v, "hex");
  const alpha = alphaV === undefined ? 1 : isNum(alphaV) && alphaV >= 0 && alphaV <= 1 ? alphaV : NaN;
  if (Number.isNaN(alpha)) return { bad: "a colour's alpha must be a number from 0 to 1" };
  if (space === "srgb" && isUnknownArray(comps) && comps.length === 3) {
    // CSS Color 4's `none` is a missing channel, which reads as 0.
    const ch = comps.map((c: unknown): unknown => (c === "none" ? 0 : c));
    const [r, g, b] = ch;
    if (isNum(r) && isNum(g) && isNum(b)) return withAlpha(r, g, b, alpha);
    return { bad: "an srgb colour's components must be three numbers from 0 to 1" };
  }
  const fallback = typeof hex === "string" ? parseHexColor(hex.trim()) : null;
  if (fallback) return withAlpha(fallback.r, fallback.g, fallback.b, alpha * (fallback.a === undefined ? 1 : fallback.a));
  return { bad: typeof space === "string" ? "a " + space + " colour without a hex fallback (a Figma variable holds sRGB hex)" : "not a colour: " + shownValue(v) };
}
/** A DTCG dimension as px: {value, unit} or "12px" / "1.5rem"; rem and em are REM_PX each. A bare number is px. */
function parseDimension(v: unknown): Parsed<number> {
  let n: unknown, unit: unknown = "px";
  if (isNum(v)) n = v;
  else if (isObj(v)) { n = own(v, "value"); unit = own(v, "unit"); }
  else if (typeof v === "string") {
    const m = /^\s*(-?(?:\d+\.?\d*|\.\d+))\s*(px|rem|em)?\s*$/.exec(v);
    if (m) { n = Number(m[1]); unit = m[2] || "px"; }
  }
  if (!isNum(n)) return { bad: "not a dimension: " + shownValue(v) };
  if (unit === "px") return { ok: n };
  if (unit === "rem" || unit === "em") return { ok: n * REM_PX };
  return { bad: "a dimension in '" + String(unit) + "' (px, rem and em are read)" };
}
/** DTCG's named font weights (Format 2025.10, fontWeight), by their number. */
const WEIGHT_NAMES = new Map<string, number>([
  ["thin", 100], ["hairline", 100], ["extralight", 200], ["ultralight", 200], ["light", 300], ["normal", 400], ["regular", 400], ["book", 400],
  ["medium", 500], ["semibold", 600], ["demibold", 600], ["bold", 700], ["extrabold", 800], ["ultrabold", 800], ["black", 900], ["heavy", 900],
  ["extrablack", 950], ["ultrablack", 950],
]);
function parseWeight(v: unknown): Parsed<number> {
  if (isNum(v) && v >= 1 && v <= 1000) return { ok: v };
  if (typeof v === "string") {
    const n = WEIGHT_NAMES.get(v.toLowerCase().replace(/[\s_-]/g, ""));
    if (n !== undefined) return { ok: n };
    if (/^\s*\d+\s*$/.test(v) && Number(v) >= 1 && Number(v) <= 1000) return { ok: Number(v) };
  }
  return { bad: "not a font weight: " + shownValue(v) };
}
/** A weight's number as the font style Figma names it (the common families' names: "Semi Bold", "Extra Light"). */
function weightStyle(n: number): string {
  const STYLES = ["Thin", "Extra Light", "Light", "Regular", "Medium", "Semi Bold", "Bold", "Extra Bold", "Black"];
  return STYLES[Math.min(8, Math.max(0, Math.round(n / 100) - 1))] || "Regular";
}
function parseFamily(v: unknown): Parsed<string> {
  if (typeof v === "string" && v.trim()) return { ok: v.trim() };
  if (Array.isArray(v) && typeof v[0] === "string" && v[0].trim()) return { ok: v[0].trim() };
  return { bad: "not a font family: " + shownValue(v) };
}

/** What each DTCG $type becomes as a variable. */
const VARIABLE_TYPE = new Map<string, VariableTypeName>([
  ["color", "color"], ["dimension", "number"], ["number", "number"], ["fontWeight", "number"], ["string", "string"], ["fontFamily", "string"], ["boolean", "boolean"],
]);
/** The DTCG types with no Figma variable or style here, as the reason says it. */
const NOT_SEEDED = new Set(["gradient", "cubicBezier", "duration", "border", "transition", "strokeStyle"]);

/** A token's type as this module reads it: its $type, or "boolean" for a string token that was a Figma boolean. */
function tokenType(t: RawToken): string | null {
  return t.ext && own(t.ext, "originalType") === "boolean" ? "boolean" : t.type;
}

/** One value of a `type` variable: an alias, or the raw value. `opacity` is a composed colour's opacity half (0–100,
 *  or a reference). */
function cellOf(type: string, v: unknown, opacity: unknown): Parsed<SourceValue> {
  const alias = aliasName(v);
  if (opacity !== undefined && type === "color") {
    if (aliasName(opacity) !== null || typeof opacity === "string") return { bad: "its opacity is a reference (" + String(opacity) + "); a colour variable holds one colour" };
    if (!isNum(opacity)) return { bad: "its opacity must be a number from 0 to 100" };
    if (alias !== null && opacity < 100) return { bad: "an alias with an opacity of its own (" + opacity + "%) is not a variable value" };
  }
  if (alias !== null) return { ok: { aliasOf: alias } };
  if (type === "color") return parseColor(v, isNum(opacity) ? opacity : 100);
  if (type === "dimension") return parseDimension(v);
  if (type === "number") return isNum(v) ? { ok: v } : { bad: "not a number: " + shownValue(v) };
  if (type === "fontWeight") return parseWeight(v);
  if (type === "fontFamily") return parseFamily(v);
  if (type === "boolean") {
    if (typeof v === "boolean") return { ok: v };
    if (v === "true" || v === "false") return { ok: v === "true" };
    return { bad: "not a boolean: " + shownValue(v) };
  }
  return typeof v === "string" ? { ok: v } : { bad: "not a string: " + shownValue(v) };
}

// ---------------------------------------------------------------- tables

/** One variable to seed: its name, type and a value per mode of its collection. */
interface Row { name: string; type: VariableTypeName; dtcgType: string; cells: SourceValue[]; coll: Coll }
interface Coll { name: string; modes: string[]; rows: Row[] }
/** A typography or shadow token: a style, built once the variables are known. */
interface StyleToken { name: string; type: "typography" | "shadow"; value: unknown }
/** The per-mode values of a token, before they are typed: `value`, the opacity half beside it, and the mode's name
 *  (absent for a collection with one mode). */
interface ModeValue { value: unknown; opacity: unknown; mode?: string }

/** Everything a reader (DTCG or resolver) gathers before the tables are finished. */
class Gather {
  readonly colls: Coll[] = [];
  readonly styles: StyleToken[] = [];
  readonly unmapped: SeedUnmapped[] = [];
  /** What a seeded token leaves out. Kept (in `partly`) only if the token ends up in a table; else dropped, or with
   *  `orUnmapped` moved to `unmapped` (finish sorts them). */
  readonly partNotes: Array<SeedUnmapped & { orUnmapped: boolean }> = [];
  part(token: string, reason: string, orUnmapped = false): void { this.partNotes.push({ token, reason, orUnmapped }); }
  /** every token by name, for the type of an alias-only token and the value a style's reference names */
  readonly raw = new Map<string, RawToken>();
  coll(name: string, modes: string[]): Coll {
    const c: Coll = { name, modes, rows: [] };
    this.colls.push(c);
    return c;
  }
  /** The type of token `name`, following its aliases when it has no $type of its own (null: none found). */
  typeOf(name: string): string | null {
    const seen = new Set<string>();
    for (let t = this.raw.get(name); t && !seen.has(t.name); t = this.raw.get(aliasName(t.value) ?? "")) {
      seen.add(t.name);
      const type = tokenType(t);
      if (type !== null) return type;
      if (aliasName(t.value) === null) return null;
    }
    return null;
  }
  /** Token `t` with a value per mode of `coll` (one ModeValue per mode; one for a collection with one mode): a row, a
   *  style, or an unmapped entry. */
  add(t: RawToken, coll: () => Coll, values: readonly ModeValue[]): void {
    const type = this.typeOf(t.name);
    if (type === null) {
      const a = aliasName(t.value);
      this.unmapped.push({ token: t.name, reason: a !== null && !this.raw.has(a) ? "its alias {" + a.split("/").join(".") + "} names no token here" : "no $type (on it, a group above it, or the token it aliases)" });
      return;
    }
    if (type === "typography" || type === "shadow") {
      // A style has no modes: the default mode's value (the first) is the style; a mode that differs is said.
      const [first, ...rest] = values;
      const value = first && values.length > 1 ? first.value : t.value;
      const differ = rest.filter((mv) => !sameJson(mv.value, value)).map((mv) => "'" + (mv.mode ?? "?") + "'");
      // Said only if the style is made (finish): a style that fails keeps only its own reason, in `unmapped`.
      if (differ.length) this.part(t.name, "a style has no modes; only the '" + (first?.mode ?? "?") + "' value was seeded (" + differ.join(", ") + (differ.length === 1 ? " differs)" : " differ)"));
      this.styles.push({ name: t.name, type, value });
      return;
    }
    const vt = VARIABLE_TYPE.get(type);
    if (vt === undefined) {
      this.unmapped.push({ token: t.name, reason: NOT_SEEDED.has(type) ? "a " + type + " token has no Figma variable or style" : "unknown $type '" + type + "'" });
      return;
    }
    const cells: SourceValue[] = [];
    const sentinel = t.ext ? own(t.ext, "sentinel") : undefined;
    const figmaValue = isObj(sentinel) ? own(sentinel, "figmaValue") : undefined;
    const base = cellOf(type, t.value, undefined);
    for (const mv of values) {
      const c = cellOf(type, mv.value, mv.opacity);
      if ("bad" in c) { this.unmapped.push({ token: t.name, reason: c.bad }); return; }
      // A fully round radius is written for the web as a stand-in number (design-to-code: the sentinel); Figma had its own.
      const cell = isNum(figmaValue) && "ok" in base && c.ok === base.ok && typeof c.ok === "number" ? figmaValue : c.ok;
      const wrong = cellProblem(cell, vt);
      if (wrong !== null) { this.unmapped.push({ token: t.name, reason: wrong }); return; }
      cells.push(cell);
    }
    const into = coll();
    into.rows.push({ name: t.name, type: vt, dtcgType: type, cells, coll: into });
  }
}

/** The variables `rows` alias, and what each problem with them is: an alias to nothing here, to a token of another
 *  type, to one that is not seeded, round a loop, or to a later table. Rows are dropped (and listed) until every alias
 *  left names a row that is seeded, of its type, in its own table or an earlier one. Returns the tables in order. */
function settle(g: Gather): Coll[] {
  const byName = new Map<string, Row>();
  for (const c of g.colls) for (const r of c.rows) byName.set(r.name, r);
  const dropped = new Map<Row, string>();
  const drop = (r: Row, reason: string): void => { if (!dropped.has(r)) { dropped.set(r, reason); g.unmapped.push({ token: r.name, reason }); } };
  const live = (): Row[] => g.colls.flatMap((c) => c.rows.filter((r) => !dropped.has(r)));
  const targets = (r: Row): string[] => r.cells.flatMap((c) => (typeof c === "object" ? [c.aliasOf] : []));
  const dotted = (n: string): string => "{" + n.split("/").join(".") + "}";
  let order: Coll[] = [];
  for (let changed = true; changed;) {
    changed = false;
    const before = dropped.size;
    // Every alias names a seeded row of the same type.
    for (let again = true; again;) {
      again = false;
      for (const r of live()) {
        for (const a of targets(r)) {
          const t = byName.get(a);
          if (!t) {
            const style = g.styles.some((s) => s.name === a);
            drop(r, style ? "its alias " + dotted(a) + " names a style token" : g.raw.has(a) ? "its alias " + dotted(a) + " names a token that is not seeded" : "its alias " + dotted(a) + " names no token here");
          } else if (dropped.has(t)) drop(r, "its alias " + dotted(a) + " names a token that is not seeded");
          else if (t.type !== r.type) drop(r, "its alias " + dotted(a) + " names a " + t.type + " token, and it is a " + r.type + " one");
          if (dropped.has(r)) { again = true; break; }
        }
      }
    }
    // No loop of aliases (in any mode: a loop across modes is refused by the create tables too).
    const state = new Map<Row, 1 | 2>();
    const stack: Row[] = [];
    const visit = (r: Row): void => {
      state.set(r, 1);
      stack.push(r);
      for (const a of targets(r)) {
        const t = byName.get(a);
        if (!t || dropped.has(t) || t === r) continue;
        if (state.get(t) === 1) {
          const loop = stack.slice(stack.indexOf(t));
          const said = [...loop, t].map((x) => "'" + x.name + "'").join(" → ");
          for (const x of loop) drop(x, "its aliases loop: " + said);
        } else if (!state.has(t)) visit(t);
      }
      stack.pop();
      state.set(r, 2);
    };
    for (const r of live()) if (!state.has(r)) visit(r);
    for (const r of live()) if (targets(r).indexOf(r.name) >= 0) drop(r, "it aliases itself");
    // The tables in an order where each one's aliases name rows of itself or of an earlier table.
    const deps = (c: Coll): Set<Coll> => {
      const s = new Set<Coll>();
      for (const r of c.rows) if (!dropped.has(r)) for (const a of targets(r)) { const t = byName.get(a); if (t && t.coll !== c) s.add(t.coll); }
      return s;
    };
    order = [];
    const placed = new Set<Coll>();
    const pending = g.colls.slice();
    while (pending.length) {
      const i = pending.findIndex((c) => [...deps(c)].every((d) => placed.has(d)));
      const next = pending.splice(i >= 0 ? i : 0, 1)[0];
      if (!next) break;
      order.push(next);
      placed.add(next);
    }
    for (const [i, c] of order.entries()) {
      for (const r of c.rows) {
        if (dropped.has(r)) continue;
        for (const a of targets(r)) {
          const t = byName.get(a);
          if (t && t.coll !== c && order.indexOf(t.coll) > i) { drop(r, "its alias " + dotted(a) + " is in collection '" + t.coll.name + "', which aliases this one too (one of the two tables would have to come first)"); break; }
        }
      }
    }
    if (dropped.size !== before) changed = true;
  }
  for (const c of g.colls) c.rows = c.rows.filter((r) => !dropped.has(r));
  return order.filter((c) => c.rows.length > 0);
}

/** The style token `s` as a createStyles row, or why it cannot be one. `vars` are the seeded rows by name. */
function styleOf(s: StyleToken, g: Gather, vars: ReadonlyMap<string, Row>): Parsed<SeedStyle> {
  // A style token that is an alias of another one takes that one's value.
  let value = s.value;
  for (let hops = 0, a = aliasName(value); a !== null && hops < 20; hops++, a = aliasName(value)) {
    const t = g.raw.get(a);
    if (!t) return { bad: "its alias {" + a.split("/").join(".") + "} names no token here" };
    value = t.value;
  }
  /** A sub-value that names a variable: the row, of the type the field takes, or why not. */
  const bound = (field: string, name: string, want: VariableTypeName): Parsed<Row> => {
    const r = vars.get(name);
    if (!r) return { bad: field + " names {" + name.split("/").join(".") + "}, which is not seeded" };
    if (r.type !== want) return { bad: field + " names '" + name + "', a " + r.type + " token (it takes a " + want + " one)" };
    return { ok: r };
  };
  /** The default-mode raw value of a row, through its aliases. */
  const rawOf = (r: Row): SourceValue | null => {
    let cur: Row | undefined = r;
    for (let hops = 0; cur && hops < 50; hops++) {
      const c: SourceValue | undefined = cur.cells[0];
      if (c === undefined) return null;
      if (typeof c !== "object") return c;
      cur = vars.get(c.aliasOf);
    }
    return null;
  };
  /** A field's value: the raw value (parsed as `type`), and the variable it is bound to when it is a reference. */
  const field = <T>(label: string, v: unknown, want: VariableTypeName, parse: (x: unknown) => Parsed<T>): Parsed<{ value: T; bind: string | null; dtcgType: string | null }> => {
    const a = aliasName(v);
    if (a === null) { const p = parse(v); return "bad" in p ? { bad: label + ": " + p.bad } : { ok: { value: p.ok, bind: null, dtcgType: null } }; }
    const r = bound(label, a, want);
    if ("bad" in r) return r;
    const raw = rawOf(r.ok);
    const p = parse(raw);
    return "bad" in p ? { bad: label + " names '" + a + "', whose value cannot be read" } : { ok: { value: p.ok, bind: a, dtcgType: r.ok.dtcgType } };
  };
  const set: StyleSet = {};
  if (s.type === "typography") {
    if (!isObj(value)) return { bad: "a typography value must be an object {fontFamily, fontSize, …}" };
    const tokens: NonNullable<StyleSet["tokens"]> = {};
    const fam = own(value, "fontFamily"), weight = own(value, "fontWeight"), size = own(value, "fontSize"), spacing = own(value, "letterSpacing"), lh = own(value, "lineHeight");
    if (fam !== undefined) {
      const f = field("fontFamily", fam, "string", parseFamily);
      if ("bad" in f) return f;
      set.font = f.ok.value;
      if (f.ok.bind) tokens.fontFamily = f.ok.bind;
    }
    if (weight !== undefined) {
      const w = field("fontWeight", weight, "number", parseWeight);
      if ("bad" in w) return w;
      set.weight = weightStyle(w.ok.value);
      if (w.ok.bind) tokens.fontWeight = w.ok.bind;
    }
    if (size !== undefined) {
      const z = field("fontSize", size, "number", parseDimension);
      if ("bad" in z) return z;
      set.size = z.ok.value;
      if (z.ok.bind) tokens.fontSize = z.ok.bind;
    }
    if (spacing !== undefined) {
      const l = field("letterSpacing", spacing, "number", parseDimension);
      if ("bad" in l) return l;
      set.letterSpacing = { unit: "px", value: l.ok.value };
      if (l.ok.bind) tokens.letterSpacing = l.ok.bind;
    }
    if (lh !== undefined) {
      // DTCG's line height is a multiple of the font size; Figma binds a line height to a number of px. So a multiple is
      // set as a percentage (a reference to one gives its value, unbound), and only a dimension is bound.
      const asNumber = isNum(lh) || (aliasName(lh) !== null && vars.get(aliasName(lh) ?? "")?.dtcgType === "number");
      if (asNumber) {
        const n = field("lineHeight", lh, "number", (x) => (isNum(x) ? { ok: x } : { bad: "not a number" }));
        if ("bad" in n) return n;
        set.lineHeight = { unit: "percent", value: Math.round(n.ok.value * 100 * 100) / 100 };
      } else {
        const d = field("lineHeight", lh, "number", parseDimension);
        if ("bad" in d) return d;
        set.lineHeight = { unit: "px", value: d.ok.value };
        if (d.ok.bind) tokens.lineHeight = d.ok.bind;
      }
    }
    if (Object.keys(tokens).length) set.tokens = tokens;
  } else {
    const layers = Array.isArray(value) ? value : [value];
    if (!layers.length) return { bad: "a shadow with no layers" };
    const effects: EffectSpec[] = [];
    for (const [i, layer] of layers.entries()) {
      const at = layers.length > 1 ? "shadow[" + i + "]." : "";
      if (!isObj(layer)) return { bad: at + "a shadow must be an object {color, offsetX, offsetY, blur, spread}" };
      const tokens: { color?: string; radius?: string; spread?: string; offsetX?: string; offsetY?: string } = {};
      const c = field(at + "color", own(layer, "color"), "color", (x) => parseColor(x));
      if ("bad" in c) return c;
      if (c.ok.bind) tokens.color = c.ok.bind;
      const dim = (k: string, tokenField: "radius" | "spread" | "offsetX" | "offsetY", dflt: number | null): Parsed<number | null> => {
        const v = own(layer, k);
        if (v === undefined) return { ok: dflt };
        const d = field(at + k, v, "number", parseDimension);
        if ("bad" in d) return d;
        if (d.ok.bind) tokens[tokenField] = d.ok.bind;
        return { ok: d.ok.value };
      };
      const x = dim("offsetX", "offsetX", 0), y = dim("offsetY", "offsetY", 0), blur = dim("blur", "radius", 0), spread = dim("spread", "spread", null);
      for (const p of [x, y, blur, spread]) if ("bad" in p) return p;
      const n = (p: Parsed<number | null>): number | null => ("ok" in p ? p.ok : null);
      const inset = own(layer, "inset");
      const e: EffectSpec = { type: inset === true ? "inner_shadow" : "drop_shadow", color: c.ok.value, offset: { x: n(x) ?? 0, y: n(y) ?? 0 }, radius: Math.max(0, n(blur) ?? 0) };
      const sp = n(spread);
      if (sp !== null) e.spread = sp;
      if (Object.keys(tokens).length) e.tokens = tokens;
      effects.push(e);
    }
    set.effects = effects;
  }
  if (!Object.keys(set).length) return { bad: "no field a Figma text style takes (fontFamily, fontWeight, fontSize, letterSpacing, lineHeight)" };
  const { problems } = checkStyleSet(set, "");
  if (problems.length) return { bad: problems.map((p) => p.replace(/^\.?/, "")).join("; ") };
  return { ok: { name: s.name, kind: s.type === "typography" ? "text" : "effect", set } };
}

/** The tables, once every reader has gathered its tokens. */
function finish(g: Gather, source: string): SeedOutcome {
  const order = settle(g);
  const vars = new Map<string, Row>();
  for (const c of order) for (const r of c.rows) vars.set(r.name, r);
  const styles: SeedStyle[] = [];
  for (const s of g.styles) {
    const st = styleOf(s, g, vars);
    if ("bad" in st) g.unmapped.push({ token: s.name, reason: st.bad });
    else styles.push(st.ok);
  }
  for (const c of order) {
    if (c.rows.length > MAX_TABLE_ROWS) return { error: "collection '" + c.name + "' would have " + c.rows.length + " variables, and a table takes at most " + MAX_TABLE_ROWS + " (split " + source + " into smaller sets)" };
  }
  if (styles.length > MAX_TABLE_ROWS) return { error: source + " has " + styles.length + " typography and shadow tokens, and a table takes at most " + MAX_TABLE_ROWS };
  const ops: SeedOp[] = order.map((c) => ({
    op: "createVariables" as const, collection: c.name, ...(c.modes.length ? { modes: c.modes } : {}),
    variables: c.rows.map((r): SeedRow => [r.name, r.type, ...r.cells]),
  }));
  if (styles.length) ops.push({ op: "createStyles", styles });
  // A note on what a token leaves out holds only for a token in a table.
  const seeded = new Set<string>([...vars.keys(), ...styles.map((s) => s.name)]);
  const partly: SeedUnmapped[] = [];
  for (const n of g.partNotes) {
    if (seeded.has(n.token)) partly.push({ token: n.token, reason: n.reason });
    else if (n.orUnmapped) g.unmapped.push({ token: n.token, reason: n.reason });
  }
  if (!ops.length) {
    const first = g.unmapped.slice(0, 3).map((u) => "'" + u.token + "': " + u.reason).join("; ");
    return { error: "no token in " + source + " could be seeded" + (first ? " (" + first + (g.unmapped.length > 3 ? "; and " + (g.unmapped.length - 3) + " more" : "") + ")" : " (it holds no tokens)") };
  }
  return { ops, unmapped: g.unmapped, partly };
}

// ---------------------------------------------------------------- tokens.dtcg.json

/** The tables a DTCG token tree makes. Its tokens go into `collection`; tokens with different modes go into one
 *  collection per set of modes ("<collection> (<mode> / <mode>)", numbered on a clash), the default mode first, and
 *  the ones with no modes into the one-mode one. */
export function seedFromDtcg(doc: unknown, opts: { collection?: string | undefined; source?: string | undefined } = {}): SeedOutcome {
  const source = opts.source || "the token file";
  if (!isObj(doc)) return { error: source + " is not a DTCG token tree (a JSON object of groups and tokens); seedTokens reads " + SEED_FORMATS };
  if (isResolverDoc(doc)) return { error: source + " is a DTCG resolver; read it with seedFromResolver" };
  const base = opts.collection || DEFAULT_SEED_COLLECTION;
  const g = new Gather();
  for (const [n, t] of flatten(doc, g)) g.raw.set(n, t);
  // The modes each token has, and the groups they make (a Map keyed by the mode list: names are free text). A group's
  // modes are in its default-first order: the plugin makes the first mode the collection's default.
  //   how sure: 2 the token's figma.com defaultMode (design-to-code writes it), 1 the one mode whose value is the
  //   $value, 0 neither (the key order). A group takes the order of its first token that is surest.
  const groups = new Map<string, { modes: string[]; sure: number; name: string; coll: Coll | null }>();
  const keyOf = (modes: readonly string[]): string => JSON.stringify(modes.slice().sort());
  const plan: Array<{ t: RawToken; key: string; modesV: Obj | null; modeOpacity: unknown; opacity: unknown }> = [];
  for (const t of g.raw.values()) {
    const modesV = t.ext ? own(t.ext, "modes") : undefined;
    const modeOpacity = t.ext ? own(t.ext, "modeOpacity") : undefined;
    const opacity = t.ext ? own(t.ext, "opacity") : undefined;
    const modes = isObj(modesV) ? Object.keys(modesV) : [];
    if (modes.some((m) => !m.trim())) { g.unmapped.push({ token: t.name, reason: "a mode with an empty name" }); continue; }
    if (modes.length < 2 || !isObj(modesV)) {
      const key = keyOf([]);
      if (!groups.has(key)) groups.set(key, { modes: [], sure: 2, name: base, coll: null });
      plan.push({ t, key, modesV: isObj(modesV) && modes.length === 1 ? modesV : null, modeOpacity, opacity });
      continue;
    }
    const declared = t.ext ? own(t.ext, "defaultMode") : undefined;
    const matching = modes.filter((m) => sameJson(own(modesV, m), t.value));
    const [dflt, sure] = typeof declared === "string" && modes.indexOf(declared) >= 0 ? [declared, 2] : matching.length === 1 && matching[0] !== undefined ? [matching[0], 1] : [modes[0] ?? "", 0];
    const ordered = [dflt, ...modes.filter((m) => m !== dflt)];
    const key = keyOf(modes);
    const grp = groups.get(key);
    if (!grp) groups.set(key, { modes: ordered, sure, name: "", coll: null });
    else if (sure > grp.sure) { grp.modes = ordered; grp.sure = sure; }
    plan.push({ t, key, modesV, modeOpacity, opacity });
  }
  // Each group's collection name, unique in this seed (the plugin takes one table per collection): mode names may hold
  // " / ", so two sets of modes can join alike; a clash takes a number.
  const several = groups.size > 1;
  const used = new Set<string>();
  const plain = groups.get(keyOf([]));
  if (plain) used.add(plain.name);
  for (const grp of groups.values()) {
    if (grp === plain) continue;
    const want = several ? base + " (" + grp.modes.join(" / ") + ")" : base;
    let name = want;
    for (let n = 2; used.has(name); n++) name = want + " " + n;
    used.add(name);
    grp.name = name;
  }
  const collOf = (key: string): (() => Coll) => () => {
    const grp = groups.get(key);
    if (!grp) throw new Error("token-seed: no group " + key);
    if (!grp.coll) grp.coll = g.coll(grp.name, grp.modes);
    return grp.coll;
  };
  for (const p of plan) {
    const grp = groups.get(p.key);
    if (!grp) continue;
    const { modesV, modeOpacity, opacity } = p;
    // One mode (or none): the token's $value. A one-mode `modes` names its mode, which a one-mode table leaves to Figma.
    const values: ModeValue[] = !grp.modes.length
      ? [{ value: modesV ? own(modesV, Object.keys(modesV)[0] ?? "") : p.t.value, opacity }]
      : grp.modes.map((m) => ({ value: modesV ? own(modesV, m) : undefined, opacity: isObj(modeOpacity) ? own(modeOpacity, m) : opacity, mode: m }));
    g.add(p.t, collOf(p.key), values);
  }
  // Composite overrides an extended collection layers on a token are not seeded: say so, once per token.
  for (const t of g.raw.values()) if (t.ext && own(t.ext, "extensionOverrides") !== undefined) g.part(t.name, "its extended-collection overrides are not seeded (the base value is)");
  // Tables in first-seen order of their groups, so a one-mode collection made first stays first.
  return finish(g, source);
}

// ---------------------------------------------------------------- tokens.resolver.json

/** Why a `$ref` of a resolver is not read, or null: a URL, an absolute path, a pointer into the resolver, a fragment. */
export function refProblem(ref: unknown): string | null {
  if (typeof ref !== "string" || !ref.trim()) return "a $ref must be a file path (a non-empty string)";
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return "'" + ref + "' is a URL or a drive path; a $ref is a file next to the resolver";
  if (ref.startsWith("/") || ref.startsWith("\\")) return "'" + ref + "' is an absolute path; a $ref is relative to the resolver";
  if (ref.startsWith("#")) return "'" + ref + "' points into the resolver; give a set's tokens as a file, or inline";
  if (ref.indexOf("#") >= 0) return "'" + ref + "' has a #fragment, which is not read; point at the whole file";
  return null;
}

interface ResolverSetDef { name: string; collection: string; sources: unknown[] }
interface ResolverModDef { name: string; collection: string | null; contexts: Array<[string, unknown[]]>; dflt: string | null }
/** A resolver's sets and modifiers in resolution order, or the problem with it. */
function resolverParts(doc: Obj): { sets: ResolverSetDef[]; mods: ResolverModDef[] } | { error: string } {
  const setsV = own(doc, "sets"), modsV = own(doc, "modifiers"), orderV = own(doc, "resolutionOrder");
  const sets: ResolverSetDef[] = [], mods: ResolverModDef[] = [];
  const extCollection = (o: Obj): string | null | undefined => {
    const f = figmaExt(o);
    if (!f || !hasOwn(f, "collection")) return undefined;
    const c = own(f, "collection");
    return typeof c === "string" && c.trim() ? c : null;
  };
  const asSet = (name: string, o: unknown): string | null => {
    if (!isObj(o)) return "set '" + name + "' is not an object";
    const src = own(o, "sources");
    if (!Array.isArray(src)) return "set '" + name + "' has no `sources` list";
    sets.push({ name, collection: extCollection(o) || name, sources: src });
    return null;
  };
  const asMod = (name: string, o: unknown): string | null => {
    if (!isObj(o)) return "modifier '" + name + "' is not an object";
    const ctx = own(o, "contexts");
    if (!isObj(ctx)) return "modifier '" + name + "' has no `contexts`";
    const contexts: Array<[string, unknown[]]> = [];
    for (const [k, v] of Object.entries(ctx)) {
      if (!Array.isArray(v)) return "modifier '" + name + "' context '" + k + "' is not a list of sources";
      contexts.push([k, v]);
    }
    const f = figmaExt(o);
    const d = own(o, "default");
    const dm = f ? own(f, "defaultMode") : undefined;
    const ec = extCollection(o);
    mods.push({ name, collection: ec === undefined ? null : ec === null ? name : ec, contexts, dflt: typeof d === "string" ? d : typeof dm === "string" ? dm : null });
    return null;
  };
  const unptr = (s: string): string => s.replace(/~1/g, "/").replace(/~0/g, "~");
  if (Array.isArray(orderV)) {
    for (const [i, item] of orderV.entries()) {
      if (!isObj(item)) return { error: "resolutionOrder[" + i + "] is not an object" };
      const ref = own(item, "$ref");
      if (typeof ref === "string") {
        const m = /^#\/(sets|modifiers)\/(.+)$/.exec(ref);
        if (!m || !m[2]) return { error: "resolutionOrder[" + i + "]: '" + ref + "' is not a #/sets/<name> or #/modifiers/<name> pointer" };
        const name = unptr(m[2]);
        const pool = m[1] === "sets" ? setsV : modsV;
        if (!isObj(pool) || !hasOwn(pool, name)) return { error: "resolutionOrder[" + i + "]: '" + ref + "' names nothing in the resolver" };
        const bad = m[1] === "sets" ? asSet(name, own(pool, name)) : asMod(name, own(pool, name));
        if (bad) return { error: bad };
        continue;
      }
      // An inline set or modifier (Resolver Module 2025.10: {type, name, …}).
      const type = own(item, "type"), name = own(item, "name");
      const label = typeof name === "string" && name ? name : "resolutionOrder[" + i + "]";
      const bad = type === "set" ? asSet(label, item) : type === "modifier" ? asMod(label, item) : "resolutionOrder[" + i + "] is neither a $ref nor an inline set or modifier";
      if (bad) return { error: bad };
    }
  } else {
    if (isObj(setsV)) for (const [k, v] of Object.entries(setsV)) { const bad = asSet(k, v); if (bad) return { error: bad }; }
    if (isObj(modsV)) for (const [k, v] of Object.entries(modsV)) { const bad = asMod(k, v); if (bad) return { error: bad }; }
  }
  return { sets, mods };
}

/** Every file a resolver's sets and modifiers `$ref` (each once, as written), or the first one that is not read. */
export function resolverRefs(doc: unknown): { refs: string[] } | { error: string } {
  if (!isObj(doc)) return { error: "a resolver must be a JSON object" };
  const parts = resolverParts(doc);
  if ("error" in parts) return parts;
  const refs: string[] = [];
  const add = (src: readonly unknown[], where: string): string | null => {
    for (const s of src) {
      if (!isObj(s) || !hasOwn(s, "$ref")) continue; // inline tokens
      const ref = own(s, "$ref");
      const bad = refProblem(ref);
      if (bad) return where + ": " + bad;
      if (typeof ref === "string" && refs.indexOf(ref) < 0) refs.push(ref);
    }
    return null;
  };
  for (const s of parts.sets) { const bad = add(s.sources, "set '" + s.name + "'"); if (bad) return { error: bad }; }
  for (const m of parts.mods) for (const [k, src] of m.contexts) { const bad = add(src, "modifier '" + m.name + "' context '" + k + "'"); if (bad) return { error: bad }; }
  return { refs };
}

/**
 * The tables a DTCG resolver makes: a collection per set (by its figma.com collection, else its name), its modes from
 * the modifier of that collection (by its figma.com collection, its name, or the one set its tokens belong to), the
 * default mode first. `files` holds each `$ref`'s parsed content, by the ref as written (resolverRefs lists them).
 */
export function seedFromResolver(doc: unknown, files: ReadonlyMap<string, unknown>, opts: { source?: string | undefined } = {}): SeedOutcome {
  const source = opts.source || "the resolver";
  if (!isObj(doc)) return { error: source + " is not a DTCG resolver" };
  const parts = resolverParts(doc);
  if ("error" in parts) return { error: source + ": " + parts.error };
  const g = new Gather();
  /** The tokens of a list of sources, later sources over earlier ones. */
  const tokensOf = (src: readonly unknown[]): Map<string, RawToken> => {
    const out = new Map<string, RawToken>();
    for (const s of src) {
      const tree = isObj(s) && hasOwn(s, "$ref") ? files.get(String(own(s, "$ref"))) : s;
      for (const [n, t] of flatten(tree, g)) out.set(n, t);
    }
    return out;
  };
  // The sets: one collection each (two sets of one collection are one), every name in the first collection to have it.
  interface Build { name: string; base: Map<string, RawToken>; mod: { name: string; modes: string[]; ctx: Map<string, Map<string, RawToken>> } | null }
  const colls = new Map<string, Build>();
  const owner = new Map<string, Build>();
  for (const s of parts.sets) {
    let b = colls.get(s.collection);
    if (!b) { b = { name: s.collection, base: new Map(), mod: null }; colls.set(s.collection, b); }
    for (const [n, t] of tokensOf(s.sources)) {
      const was = owner.get(n);
      if (was && was !== b) { g.part(n, "set '" + s.name + "' has it too; it is seeded once, in collection '" + was.name + "'"); continue; }
      owner.set(n, b);
      b.base.set(n, t);
      if (!g.raw.has(n)) g.raw.set(n, t);
    }
  }
  // The modifiers: the modes of one collection each.
  for (const m of parts.mods) {
    const ctx = new Map<string, Map<string, RawToken>>();
    for (const [k, src] of m.contexts) ctx.set(k, tokensOf(src));
    const names = new Set<string>();
    for (const t of ctx.values()) for (const n of t.keys()) names.add(n);
    // A token a set has too is still seeded (its set's value): the note is then a `partly` one.
    const unmapAll = (reason: string): void => { for (const n of names) g.part(n, reason, true); };
    let b: Build | undefined;
    if (m.collection !== null) {
      b = colls.get(m.collection);
      if (!b) { unmapAll("modifier '" + m.name + "' overrides collection '" + m.collection + "', which no set makes (an extended collection's overrides are not seeded)"); continue; }
    } else {
      b = colls.get(m.name);
      if (!b) {
        const owners = new Set<Build>();
        for (const n of names) { const o = owner.get(n); if (o) owners.add(o); }
        if (owners.size !== 1) { unmapAll(owners.size ? "modifier '" + m.name + "' changes tokens of several collections; a collection has one set of modes" : "modifier '" + m.name + "' changes tokens no set has"); continue; }
        b = [...owners][0];
      }
    }
    if (!b) continue;
    if (b.mod) { unmapAll("modifier '" + m.name + "' is a second set of modes for collection '" + b.name + "' (it has '" + b.mod.name + "')"); continue; }
    const keys = m.contexts.map(([k]) => k);
    if (keys.some((k) => !k.trim())) { unmapAll("modifier '" + m.name + "' has a context with an empty name"); continue; }
    const dflt = m.dflt !== null && keys.indexOf(m.dflt) >= 0 ? m.dflt : keys[0];
    if (dflt === undefined) continue;
    b.mod = { name: m.name, modes: [dflt, ...keys.filter((k) => k !== dflt)], ctx };
    for (const [, t] of ctx) for (const [n, tok] of t) if (!g.raw.has(n)) g.raw.set(n, tok);
  }
  // Each collection's rows: a value per mode — the mode's context, else the set's value.
  for (const b of colls.values()) {
    let made: Coll | null = null;
    const coll = (): Coll => (made ??= g.coll(b.name, b.mod ? b.mod.modes : []));
    if (!b.mod) {
      for (const t of b.base.values()) g.add(t, coll, [{ value: t.value, opacity: t.ext ? own(t.ext, "opacity") : undefined }]);
      continue;
    }
    const mod = b.mod;
    const dflt = mod.modes[0] ?? "";
    const names: string[] = [...b.base.keys()];
    for (const t of mod.ctx.values()) for (const n of t.keys()) if (names.indexOf(n) < 0) names.push(n);
    for (const n of names) {
      const o = owner.get(n);
      if (o && o !== b) { g.part(n, "modifier '" + mod.name + "' sets it, and it is in collection '" + o.name + "'", true); continue; }
      const at = (m: string): RawToken | undefined => mod.ctx.get(m)?.get(n) ?? b.base.get(n) ?? (b.base.has(n) ? undefined : mod.ctx.get(dflt)?.get(n));
      const first = at(dflt);
      if (!first) { g.unmapped.push({ token: n, reason: "no value in the default mode '" + dflt + "'" }); continue; }
      // A token only a context gives is typed by it: put it where the type lookup finds it.
      const typed: RawToken = b.base.get(n) ?? first;
      if (!g.raw.has(n)) g.raw.set(n, typed);
      g.add(typed, coll, mod.modes.map((m) => { const t = at(m) ?? first; return { value: t.value, opacity: t.ext ? own(t.ext, "opacity") : undefined, mode: m }; }));
    }
  }
  return finish(g, source);
}
