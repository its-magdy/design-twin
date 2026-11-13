// source-spec.ts — what a source edit may change: a local variable's values (`setVariable`) and a local paint, text or
// effect style (`setStyle`) (docs/write-plane-spec.md decision 9). A local main component is changed with `patch`
// (patch-spec.ts) on the component or a layer inside it; the plugin counts the instances that follow.
//
// A source edit changes one thing once and Figma carries it to everything that uses it, so the dry run says how much
// follows (the plugin counts it: figma-plugin/src/sources.ts), and anything that lives in another library file is refused
// with that file named. This module is the shape check, run by the dry run, the wire check and the plugin alike:
//
//   setVariable  {variable, values: {<mode name or id>: value}} — or `value` for a collection with one mode. A value is
//                the read export's (variables.json `values`): a hex colour, a number, a string, a boolean, or
//                `{aliasOf: <variable>}`. Whether it fits the variable's type is the plugin's check (only the file knows it).
//   setStyle     {style, set} — `set` in the read export's style field names (styles.<kind>.json): `paints` for a paint
//                style; `font`, `weight`, `size`, `lineHeight`, `letterSpacing`, `case`, `decoration`, `paragraphSpacing`,
//                `paragraphIndent` and `tokens` (a field → variable, null unbinds) for a text style; `effects` for an
//                effect style; `name` and `description` for any.
//
// Pure and dependency-free (bar pure siblings): the plugin bundle imports it, so it must type-check under
// figma-plugin/tsconfig.json (ES2019 lib, no Node types).
import { nearestNames, quoteList } from "./name-match.ts";
import { fillsCheck, hex, isObj, nonNeg, objectProblems, oneOf, ref, refuse, str, type Rule, type TreeFill } from "./tree-spec.ts";

/** One value of a variable in one mode, as the read export writes it. */
export type SourceValue = string | number | boolean | { aliasOf: string };
/** A shadow or blur, in the read export's effect fields (effects.ts). */
export type EffectSpec =
  | { type: "drop_shadow" | "inner_shadow"; color: string; offset: { x: number; y: number }; radius: number; spread?: number; behindNode?: true }
  | { type: "layer_blur" | "background_blur"; radius: number };
/** What a setStyle sets. Every field is optional; at least one is given, and they belong to one kind of style. */
export interface StyleSet {
  name?: string;
  description?: string;
  paints?: TreeFill[];
  font?: string;
  weight?: string;
  size?: number;
  lineHeight?: { unit: "px" | "percent" | "auto"; value?: number };
  letterSpacing?: { unit: "px" | "percent"; value: number };
  case?: "original" | "upper" | "lower" | "title" | "small_caps" | "small_caps_forced";
  decoration?: "none" | "underline" | "strikethrough";
  paragraphSpacing?: number;
  paragraphIndent?: number;
  effects?: EffectSpec[];
  /** a text style's fields bound to variables, as the read writes them: a field → a variable's name, key or id, or null
   *  to unbind it (its value stays) */
  tokens?: { [K in TextStyleTokenField]?: string | null };
}
/** The text style fields a variable can be bound to (Figma's VariableBindableTextField). */
export const TEXT_STYLE_TOKEN_FIELDS = ["fontFamily", "fontStyle", "fontWeight", "fontSize", "lineHeight", "letterSpacing", "paragraphSpacing", "paragraphIndent"] as const;
export type TextStyleTokenField = (typeof TEXT_STYLE_TOKEN_FIELDS)[number];
/** The type of variable each field takes: a family or a style name is a string, the rest numbers. */
export const TEXT_STYLE_TOKEN_TYPES: { readonly [K in TextStyleTokenField]: "STRING" | "FLOAT" } = {
  fontFamily: "STRING", fontStyle: "STRING", fontWeight: "FLOAT", fontSize: "FLOAT", lineHeight: "FLOAT", letterSpacing: "FLOAT", paragraphSpacing: "FLOAT", paragraphIndent: "FLOAT",
};
export type StyleField = keyof StyleSet;
/** The kind of style a field belongs to (null: every kind has it). */
export type StyleKindName = "paint" | "text" | "effect";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const num = (v: unknown): string | null => (isNum(v) ? null : "must be a number");
const xy = (v: unknown): string | null => (isObj(v) && isNum(v.x) && isNum(v.y) && Object.keys(v).every((k) => k === "x" || k === "y") ? null : "must be {x, y}");
/** A `{unit, value}` length, as the read writes a text style's (LengthSpec): both present, `auto` alone. */
const length = (units: readonly string[], auto: boolean) => (v: unknown): string | null => {
  if (!isObj(v)) return "must be an object {unit, value}";
  if (auto && v.unit === "auto") return Object.keys(v).some((k) => k !== "unit" && v[k] !== undefined) ? "`{unit:\"auto\"}` takes no value" : null;
  if (typeof v.unit !== "string" || units.indexOf(v.unit) < 0) return "unit must be one of " + (auto ? [...units, "auto"] : units).join(" | ");
  const extra = Object.keys(v).filter((k) => k !== "unit" && k !== "value" && v[k] !== undefined);
  if (extra.length) return "." + extra[0] + ": not a field of a length (it is {unit, value})";
  if (!isNum(v.value)) return "is missing value (a number)";
  return auto && v.value < 0 ? "value must be ≥ 0" : null;
};

const SHADOW_RULES: Readonly<Record<string, Rule>> = {
  type: oneOf("drop_shadow", "inner_shadow"), color: hex, offset: xy, radius: nonNeg, spread: num,
  behindNode: (v) => (v === true ? null : "must be true (omit it for false)"),
  blendMode: refuse("a shadow's blend mode cannot be written yet"),
  tokens: refuse("binding an effect's fields to variables cannot be written yet"),
};
const BLUR_RULES: Readonly<Record<string, Rule>> = {
  type: oneOf("layer_blur", "background_blur"), radius: nonNeg,
  blurType: refuse("a progressive blur cannot be written yet"), startOffset: refuse("a progressive blur cannot be written yet"),
  endOffset: refuse("a progressive blur cannot be written yet"), startRadius: refuse("a progressive blur cannot be written yet"),
  tokens: refuse("binding an effect's fields to variables cannot be written yet"),
};
const effectsCheck = (v: unknown): string | null => {
  if (!Array.isArray(v)) return "must be a list of effects ([] removes them)";
  for (const [i, e] of v.entries()) {
    const at = "[" + i + "]";
    if (!isObj(e)) return at + " must be an effect object";
    const shadow = e.type === "drop_shadow" || e.type === "inner_shadow";
    const blur = e.type === "layer_blur" || e.type === "background_blur";
    if (!shadow && !blur) return at + ".type: " + (typeof e.type === "string" ? "'" + e.type + "' cannot be written yet (drop_shadow, inner_shadow, layer_blur and background_blur can)" : "must be drop_shadow | inner_shadow | layer_blur | background_blur");
    const bad = objectProblems(e, shadow ? SHADOW_RULES : BLUR_RULES, "")[0];
    if (bad) return at + (bad.startsWith(".") ? "" : " ") + bad;
    const need = shadow ? ["color", "offset", "radius"] : ["radius"];
    for (const k of need) if (e[k] === undefined) return at + " is missing " + k;
    if (e.behindNode !== undefined && e.type !== "drop_shadow") return at + ".behindNode: only a drop_shadow shows behind its node";
  }
  return null;
};

/** Every field a setStyle sets, with its rule and the kind of style it belongs to, in the order the plugin sets them
 *  (the font before its size and spacing: setting them needs it loaded). */
export const STYLE_FIELDS: { readonly [K in StyleField]: { rule: Rule; kind: StyleKindName | null } } = {
  name: { rule: (v) => (typeof v === "string" && v.trim().length > 0 ? null : "must be a non-empty string"), kind: null },
  description: { rule: str, kind: null },
  paints: { rule: fillsCheck, kind: "paint" },
  font: { rule: (v) => (typeof v === "string" && v.trim().length > 0 ? null : "must be a font family name"), kind: "text" },
  weight: { rule: (v) => (typeof v === "string" && v.trim().length > 0 ? null : "must be a font style name, e.g. \"Semi Bold\""), kind: "text" },
  size: { rule: (v) => (isNum(v) && v >= 1 ? null : "must be a number ≥ 1"), kind: "text" },
  lineHeight: { rule: length(["px", "percent"], true), kind: "text" },
  letterSpacing: { rule: length(["px", "percent"], false), kind: "text" },
  case: { rule: oneOf("original", "upper", "lower", "title", "small_caps", "small_caps_forced"), kind: "text" },
  decoration: { rule: oneOf("none", "underline", "strikethrough"), kind: "text" },
  paragraphSpacing: { rule: nonNeg, kind: "text" },
  paragraphIndent: { rule: nonNeg, kind: "text" },
  effects: { rule: effectsCheck, kind: "effect" },
  // Bound after the raw values above (setting a raw value unbinds the field).
  tokens: {
    rule: (v) => {
      if (!isObj(v)) return "must be an object of text style field → variable (or null to unbind)";
      const keys = Object.keys(v).filter((k) => v[k] !== undefined);
      if (!keys.length) return "is empty";
      for (const k of keys) {
        if ((TEXT_STYLE_TOKEN_FIELDS as readonly string[]).indexOf(k) < 0) { const near = nearestNames(k, TEXT_STYLE_TOKEN_FIELDS); return "." + k + ": not a text style field a variable binds to" + (near.length ? "; closest: " + quoteList(near) : ""); }
        const x = v[k];
        if (x !== null && (typeof x !== "string" || !x.trim())) return "." + k + " must be a variable's name, key or id, or null to unbind";
      }
      return null;
    },
    kind: "text",
  },
};
export const STYLE_FIELD_NAMES = Object.keys(STYLE_FIELDS) as StyleField[];
const STYLE_RULE_TABLE: Readonly<Record<string, Rule>> = Object.fromEntries(STYLE_FIELD_NAMES.map((k) => [k, STYLE_FIELDS[k].rule]));

/** Why each read field outside STYLE_FIELDS is refused by name. */
const NOT_STYLED: Readonly<Record<string, string>> = {
  id: "the style is named by the op's `style`", key: "the style is named by the op's `style`",
  remote: "it says where the style lives; a write changes only a style of this file",
  publish: "publishing is done in Figma's library panel", docs: "a style's documentation links cannot be written yet",
  grids: "a grid style cannot be written yet", entries: "an animation style cannot be written yet",
  leadingTrim: "a text style's leading trim cannot be written yet", listSpacing: "a text style's list spacing cannot be written yet",
  textWrap: "a text style's text wrap cannot be written yet",
};

/** What a valid setStyle does, for the dry run and the reply. */
export interface StyleSummary {
  fields: StyleField[];
  /** the kind its fields belong to (null when it only renames or describes) */
  kind: StyleKindName | null;
  /** the colour variables its paints name */
  variables: string[];
}

/** Every problem with a setStyle's `set` (each starting with `path`), and for a valid one what it sets. */
export function checkStyleSet(set: unknown, path = "set"): { problems: string[]; summary: StyleSummary } {
  const summary: StyleSummary = { fields: [], kind: null, variables: [] };
  if (!isObj(set)) return { problems: [path + ": must be an object of the style's fields to change, e.g. {paints: [{type: \"solid\", color: \"#2563eb\"}]}"], summary };
  const problems: string[] = [];
  for (const [k, v] of Object.entries(set)) {
    if (v === undefined || Object.prototype.hasOwnProperty.call(STYLE_FIELDS, k)) continue;
    const at = path + "." + k;
    const why = Object.prototype.hasOwnProperty.call(NOT_STYLED, k) ? NOT_STYLED[k] : undefined;
    if (why !== undefined) problems.push(at + ": a style edit cannot set it — " + why);
    else {
      const near = nearestNames(k, STYLE_FIELD_NAMES);
      problems.push(at + ": not a field a style edit sets" + (near.length ? "; closest: " + quoteList(near) : ""));
    }
  }
  problems.push(...objectProblems(Object.fromEntries(Object.entries(set).filter(([k]) => Object.prototype.hasOwnProperty.call(STYLE_FIELDS, k))), STYLE_RULE_TABLE, path));
  const fields = STYLE_FIELD_NAMES.filter((k) => set[k] !== undefined);
  if (!fields.length && !problems.length) problems.push(path + ": sets nothing; give at least one of " + STYLE_FIELD_NAMES.join(", "));
  if (problems.length) return { problems, summary };
  const kinds = fields.map((f) => STYLE_FIELDS[f].kind).filter((k): k is StyleKindName => k !== null);
  const kind = kinds[0] === undefined ? null : kinds[0];
  const other = kinds.filter((k) => k !== kind)[0];
  if (kind !== null && other !== undefined) {
    const of = (want: StyleKindName): string => fields.filter((f) => STYLE_FIELDS[f].kind === want).map((f) => "`" + f + "`").join(", ");
    problems.push(path + ": " + of(kind) + " belong" + (of(kind).indexOf(",") < 0 ? "s" : "") + " to a " + kind + " style and " + of(other) + " to a" + (other === "effect" ? "n " : " ") + other + " style; a style is one kind");
    return { problems, summary };
  }
  summary.fields = fields;
  summary.kind = kind;
  const add = (name: unknown): void => { if (typeof name === "string" && summary.variables.indexOf(name) < 0) summary.variables.push(name); };
  if (Array.isArray(set.paints)) for (const p of set.paints) if (isObj(p) && isObj(p.tokens)) add(p.tokens.color);
  if (isObj(set.tokens)) for (const k of Object.keys(set.tokens)) add(set.tokens[k]);
  return { problems, summary };
}

/** `set` is a setStyle set checkStyleSet accepts. */
export function isStyleSet(v: unknown): v is StyleSet {
  return checkStyleSet(v).problems.length === 0;
}

const valueCheck = (v: unknown): string | null => {
  if (typeof v === "string" || typeof v === "boolean" || isNum(v)) return null;
  if (isObj(v)) {
    if (v.composed !== undefined) return "a composed colour (a colour and a separate opacity) cannot be written yet";
    const extra = Object.keys(v).filter((k) => k !== "aliasOf" && v[k] !== undefined);
    if (extra.length) return "." + extra[0] + ": an alias is {aliasOf: <variable name, key or id>}";
    const bad = ref(v.aliasOf);
    return bad === null ? null : ".aliasOf " + bad;
  }
  return "must be a hex colour, a number, a string, true/false, or {aliasOf: <variable>}";
};

/** What a valid setVariable does, for the dry run. */
export interface VariableEditSummary {
  /** the modes it names, in the order given; empty for `value` (the collection's only mode) */
  modes: string[];
  /** the variables its aliases name */
  aliases: string[];
}

/** Every problem with a setVariable op's `values` / `value` (each starting with its path), and what a valid one sets. */
export function checkVariableEdit(o: { values?: unknown; value?: unknown }, path = ""): { problems: string[]; summary: VariableEditSummary } {
  const summary: VariableEditSummary = { modes: [], aliases: [] };
  const at = (k: string): string => (path ? path + "." : "") + k;
  const problems: string[] = [];
  const add = (v: unknown): void => { if (isObj(v) && typeof v.aliasOf === "string" && summary.aliases.indexOf(v.aliasOf) < 0) summary.aliases.push(v.aliasOf); };
  if (o.values !== undefined && o.value !== undefined) return { problems: [at("value") + ": give `values` (by mode) or `value` (a collection with one mode), not both"], summary };
  if (o.values === undefined && o.value === undefined) return { problems: [(path || "setVariable") + ": missing values — `values: {<mode>: value}`, or `value` for a collection with one mode"], summary };
  if (o.value !== undefined) {
    const bad = valueCheck(o.value);
    if (bad !== null) problems.push(at("value") + (bad.startsWith(".") ? "" : ": ") + bad);
    else add(o.value);
    return { problems, summary };
  }
  if (!isObj(o.values) || !Object.keys(o.values).some((k) => isObj(o.values) && o.values[k] !== undefined)) return { problems: [at("values") + ": must be an object of mode name (or modeId) → value, with at least one mode"], summary };
  for (const [mode, v] of Object.entries(o.values)) {
    if (v === undefined) continue;
    if (!mode.trim()) { problems.push(at("values") + ": a mode name must not be empty"); continue; }
    const bad = valueCheck(v);
    if (bad !== null) { problems.push(at("values") + "[" + JSON.stringify(mode) + "]" + (bad.startsWith(".") ? "" : ": ") + bad); continue; }
    summary.modes.push(mode);
    add(v);
  }
  return { problems, summary };
}

/** A value as the dry run shows it. */
const shown = (v: SourceValue): string => (typeof v === "object" ? "alias of '" + v.aliasOf + "'" : JSON.stringify(v));

/** The dry run's sentence for a valid setVariable. */
export function describeVariableEdit(variable: string | undefined, o: { values?: Record<string, unknown> | undefined; value?: unknown }): string {
  const parts: string[] = [];
  if (o.value !== undefined) parts.push("its only mode → " + shown(o.value as SourceValue));
  else for (const [m, v] of Object.entries(o.values || {})) if (v !== undefined) parts.push("'" + m + "' → " + shown(v as SourceValue));
  return "variable '" + (variable || "?") + "': " + parts.join(", ") +
    " — a local variable only (one from a library file is refused, naming the file); the modes and the value types are checked against the file when applied, and everything bound to it (nodes, styles, aliases) follows";
}
/** The dry run's sentence for a valid setStyle. */
export function describeStyleEdit(style: string | undefined, s: StyleSummary): string {
  const parts = ["style '" + (style || "?") + "'" + (s.kind ? " (a " + s.kind + " style)" : "") + ": sets " + s.fields.join(", ")];
  if (s.variables.length) parts.push("variables " + quoteList(s.variables));
  return parts.join("; ") + " — a local style only (one from a library file is refused); the kind and the names are checked against the file when applied, and every layer that uses the style follows";
}
/** The dry run's rows for a valid setStyle: one per field, with the value it gets. */
export function styleRows(set: StyleSet, s: StyleSummary): Array<{ field: StyleField; to: string }> {
  return s.fields.map((f) => ({ field: f, to: JSON.stringify(set[f]) }));
}
/** The refusal for an invalid setStyle / setVariable: every problem, one per line. */
export function sourceRefusal(problems: readonly string[]): string {
  const first = problems[0];
  if (problems.length === 1 && first !== undefined) return first + ". Nothing was changed.";
  return problems.length + " problems in the edit — nothing was changed:\n" + problems.join("\n");
}
