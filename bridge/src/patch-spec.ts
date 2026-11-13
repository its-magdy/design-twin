// patch-spec.ts — what a `patch` write op may set on an existing node, by id (docs/write-plane-spec.md decisions 2, 4,
// 5, 14, 15, 20).
//
// A patch is `{op: "patch", nodeId, set}`: `set` names the node's fields the way the read export (and so a tree spec,
// tree-spec.ts) names them, and only the fields given change. Each field is one row of PATCH_FIELDS: the dry run shows
// one preview row per field, the wire check and the plugin refuse the same values, and every value is checked with the
// rule the tree spec uses for that field, so a value one accepts the other accepts too. A patch value may name a
// variable (`fills[].tokens.color`, `tokens`) or a text style (`styles.text`); the plugin resolves those names exactly
// as it resolves a tree spec's (figma-plugin/src/tree-refs.ts), and `null` in `tokens` unbinds a field.
//
// What only the file can say — the node exists, is the kind that has the field (a text for `text`, an instance for
// `props`), has auto-layout for a gap — is checked by the plugin before the batch runs (figma-plugin/src/patch.ts).
//
// Pure and dependency-free (bar pure siblings): the plugin bundle imports it, so it must type-check under
// figma-plugin/tsconfig.json (ES2019 lib, no Node types).
import type { RadiusCorners } from "./doc-types.ts";
import { nearestNames, quoteList } from "./name-match.ts";
import {
  LAYOUT_RULES, NODE_RULES, NUMBER_TOKEN_FIELDS, SIDES, STYLE_RULES, fillsCheck, hex, isObj, isRefuse, nonNeg, objOf, objectProblems, oneOf,
  propsCheck, ref, refuse, size, str, unit, type Check, type Rule, type TreeFill,
} from "./tree-spec.ts";

/** The writable slice of `layout` a patch takes: the tree spec's, plus the values that turn a flag back off. */
export interface PatchLayout {
  display?: "flex";
  /** no auto-layout: the frame's auto-layout is removed (its children keep where they are) */
  mode?: "absolute";
  flexDirection?: "row" | "column";
  gap?: number;
  padding?: number[];
  justifyContent?: "flex-start" | "center" | "flex-end" | "space-between" | "space-evenly" | "space-around";
  alignItems?: "flex-start" | "center" | "flex-end" | "baseline";
  flexWrap?: "wrap" | "nowrap";
  rowGap?: number;
  columnGap?: number;
  alignContent?: "space-between" | "auto";
  reverseZ?: boolean;
}
/** A patch's `strokes`: only the parts given change. `colors: []` removes the strokes. */
export interface PatchStrokes {
  colors?: string[];
  weight?: number;
  weights?: { top?: number; right?: number; bottom?: number; left?: number };
  align?: "inside" | "outside" | "center";
}
/** A patch's `tokens`: a field → a variable's name, key or id, or null to unbind it (its current value stays). */
export type PatchTokens = { [K in (typeof NUMBER_TOKEN_FIELDS)[number]]?: string | null } & { fills?: string | string[] | null; strokes?: string | string[] | null };
/** What a patch sets on one node. Every field is optional; at least one is given. */
export interface PatchSet {
  name?: string;
  hidden?: boolean;
  opacity?: number;
  text?: string;
  styles?: { text?: string };
  fills?: TreeFill[];
  strokes?: PatchStrokes;
  radius?: number | RadiusCorners;
  layout?: PatchLayout;
  box?: { w?: number; h?: number };
  widthMode?: "fill" | "hug" | "fixed";
  heightMode?: "fill" | "hug" | "fixed";
  autoResize?: "width_and_height" | "height" | "truncate" | "none";
  tokens?: PatchTokens;
  props?: Record<string, string | boolean>;
}
export type PatchField = keyof PatchSet;

const bool: Check = (v) => (typeof v === "boolean" ? null : "must be true or false");
const PATCH_LAYOUT_RULES: Readonly<Record<string, Rule>> = {
  ...LAYOUT_RULES,
  width: refuse("set the size with `box`"), height: refuse("set the size with `box`"),
  flexWrap: oneOf("wrap", "nowrap"),
  alignContent: oneOf("space-between", "auto"),
  reverseZ: bool,
};
const PATCH_STROKE_RULES: Readonly<Record<string, Rule>> = {
  colors: (v) => (Array.isArray(v) ? (() => { for (const [i, c] of v.entries()) { const bad = hex(c); if (bad !== null) return "[" + i + "] " + bad; } return null; })() : "must be a list of hex colours ([] removes the strokes)"),
  weight: nonNeg,
  weights: objOf(SIDES),
  align: oneOf("inside", "outside", "center"),
  paints: refuse("only solid stroke `colors` can be written yet"),
};
const tokenValue: Check = (v) => (v === null ? null : ref(v));
const tokenList: Check = (v) => (v === null ? null : typeof v === "string" ? ref(v) : Array.isArray(v) && v.length > 0 ? (() => { for (const [i, x] of v.entries()) { const bad = ref(x); if (bad !== null) return "[" + i + "] " + bad; } return null; })() : "must be a variable's name, key or id, a non-empty list of them, or null to unbind");
const PATCH_TOKEN_RULES: Readonly<Record<string, Rule>> = {
  ...Object.fromEntries(NUMBER_TOKEN_FIELDS.map((k) => [k, tokenValue])),
  fills: tokenList, strokes: tokenList,
  characters: refuse("a text's content cannot be bound to a variable yet; give `text`"),
  visible: refuse("visibility cannot be bound to a variable yet; give `hidden`"),
  cornerRadius: refuse("bind each corner: topLeftRadius, topRightRadius, bottomRightRadius, bottomLeftRadius"),
};
const BOX_RULES: Readonly<Record<string, Rule>> = {
  w: size, h: size,
  x: refuse("a patch does not move a node; `move` changes its parent"), y: refuse("a patch does not move a node; `move` changes its parent"),
};

/** Every field a patch sets, in the order the plugin applies them (an instance's variant first: it can change the
 *  node's layout; auto-layout before sizes and sizing; the raw values before the variables that bind them, since
 *  setting a raw value unbinds a field), with the rule its value must pass. A Record over PatchField: a field added to
 *  PatchSet fails to compile here until it has a rule. */
export const PATCH_FIELDS: { readonly [K in PatchField]: Rule } = {
  props: propsCheck,
  name: str,
  hidden: bool,
  opacity: unit,
  layout: objOf(PATCH_LAYOUT_RULES),
  box: (v) => { if (!isObj(v)) return "must be an object {w, h}"; const bad = objOf(BOX_RULES)(v); return bad !== null ? bad : v.w === undefined && v.h === undefined ? "needs `w`, `h` or both" : null; },
  widthMode: oneOf("fill", "hug", "fixed"),
  heightMode: oneOf("fill", "hug", "fixed"),
  radius: NODE_RULES.radius,
  fills: fillsCheck,
  strokes: (v) => { if (!isObj(v)) return "must be an object"; const bad = objOf(PATCH_STROKE_RULES)(v); return bad !== null ? bad : Object.keys(v).every((k) => v[k] === undefined) ? "is empty" : null; },
  styles: objOf(STYLE_RULES),
  text: str,
  autoResize: oneOf("width_and_height", "height", "truncate", "none"),
  tokens: objOf(PATCH_TOKEN_RULES),
};
export const PATCH_FIELD_NAMES = Object.keys(PATCH_FIELDS) as PatchField[];

/** Why each read field outside PATCH_FIELDS is refused by name. */
const NOT_PATCHED: Readonly<Record<string, string>> = {
  type: "a node's type cannot change",
  children: "a patch changes one node; change each child by its own id (or `move` a node this session created)",
  handle: "a handle names a node a createTree op creates",
  id: "the node is named by the op's `nodeId`",
  component: "swapping an instance's component cannot be written yet; set its `props`",
  x: "a patch does not move a node; `move` changes its parent", y: "a patch does not move a node; `move` changes its parent",
  font: "a text's font cannot be patched yet; name a text style in `styles.text`",
};

const settableIn = (rules: Readonly<Record<string, Rule>>): string[] => Object.keys(rules).filter((k) => { const r = rules[k]; return r !== undefined && !isRefuse(r); });

/** The design-system names a patch uses. */
export interface PatchRefs { variables: string[]; textStyles: string[] }
/** What a valid patch does, for the dry run and the reply. */
export interface PatchSummary {
  /** the fields it sets, in PATCH_FIELDS order */
  fields: PatchField[];
  refs: PatchRefs;
  /** raw colours, spacing, radii and stroke weights where a variable could stand */
  unbound: number;
}

/** Every problem with a patch's `set` (each starting with `path`), and for a valid one what it sets. */
export function checkPatch(set: unknown, path = "set"): { problems: string[]; summary: PatchSummary } {
  const summary: PatchSummary = { fields: [], refs: { variables: [], textStyles: [] }, unbound: 0 };
  if (!isObj(set)) return { problems: [path + ": must be an object of the fields to change, e.g. {text: \"…\"}"], summary };
  const problems: string[] = [];
  const say = (m: string): void => { problems.push(path + ": " + m); };
  for (const [k, v] of Object.entries(set)) {
    if (v === undefined) continue;
    const at = path + "." + k;
    if (Object.prototype.hasOwnProperty.call(PATCH_FIELDS, k)) continue;
    const why = Object.prototype.hasOwnProperty.call(NOT_PATCHED, k) ? NOT_PATCHED[k] : undefined;
    const tree = Object.prototype.hasOwnProperty.call(NODE_RULES, k) ? (NODE_RULES as Readonly<Record<string, Rule>>)[k] : undefined;
    if (why !== undefined) problems.push(at + ": a patch cannot set it — " + why);
    else if (tree !== undefined) problems.push(at + ": a read field a patch cannot set yet" + (isRefuse(tree) && tree.refuse ? " — " + tree.refuse : ""));
    else {
      const near = nearestNames(k, PATCH_FIELD_NAMES);
      problems.push(at + ": not a field a patch sets" + (near.length ? "; closest: " + quoteList(near) : ""));
    }
  }
  problems.push(...objectProblems(Object.fromEntries(Object.entries(set).filter(([k]) => Object.prototype.hasOwnProperty.call(PATCH_FIELDS, k))), PATCH_FIELDS, path));
  const fields = PATCH_FIELD_NAMES.filter((k) => set[k] !== undefined);
  if (!fields.length && !problems.length) say("sets nothing; give at least one of " + PATCH_FIELD_NAMES.join(", "));
  if (problems.length) return { problems, summary };

  // Values that contradict each other within the patch: refused here, before any file is read.
  const l = isObj(set.layout) ? set.layout : null;
  if (l) {
    if (l.mode !== undefined && l.display !== undefined) say("`layout` is either `display: \"flex\"` or `mode: \"absolute\"`, not both");
    else if (l.mode !== undefined) for (const k of Object.keys(l)) if (l[k] !== undefined && k !== "mode" && settableIn(PATCH_LAYOUT_RULES).indexOf(k) >= 0) say("`layout." + k + "` is an auto-layout field; `mode: \"absolute\"` removes auto-layout");
    if (l.alignItems === "baseline" && l.flexDirection === "column") say("`layout.alignItems: \"baseline\"` works only in a row (Figma refuses it in a column)");
    if (l.flexWrap === "nowrap") for (const k of ["rowGap", "columnGap", "alignContent"]) if (l[k] !== undefined) say("`layout." + k + "` needs wrapping; `flexWrap: \"nowrap\"` turns it off");
  }
  const box = isObj(set.box) ? set.box : null;
  if (box && box.w !== undefined && set.widthMode !== undefined && set.widthMode !== "fixed") say("`box.w` gives a fixed width, which `widthMode: \"" + String(set.widthMode) + "\"` contradicts; leave one out");
  if (box && box.h !== undefined && set.heightMode !== undefined && set.heightMode !== "fixed") say("`box.h` gives a fixed height, which `heightMode: \"" + String(set.heightMode) + "\"` contradicts; leave one out");
  const t = isObj(set.tokens) ? set.tokens : {};
  if (t.width !== undefined && t.width !== null && set.widthMode !== undefined && set.widthMode !== "fixed") say("`tokens.width` sizes the node, which `widthMode` already does; leave one out");
  if (t.height !== undefined && t.height !== null && set.heightMode !== undefined && set.heightMode !== "fixed") say("`tokens.height` sizes the node, which `heightMode` already does; leave one out");
  if (Array.isArray(set.fills) && t.fills !== undefined) {
    // As in a tree spec: `tokens.fills` beside `fills` repeats what the paints name, so it must agree.
    const onPaints = set.fills.map((p) => (isObj(p) && isObj(p.tokens) ? p.tokens.color : undefined));
    if (t.fills === null) say("`tokens.fills: null` unbinds the node's paints, and `fills` replaces them; give one");
    else for (const name of typeof t.fills === "string" ? [t.fills] : Array.isArray(t.fills) ? t.fills : []) if (onPaints.indexOf(name) < 0) say("`tokens.fills` names '" + String(name) + "', which no paint in `fills` is bound to; bind the paint instead: `fills[i].tokens.color`");
  }
  const st = isObj(set.strokes) ? set.strokes : null;
  if (st && Array.isArray(st.colors) && t.strokes !== undefined && t.strokes !== null) {
    const n = typeof t.strokes === "string" ? 1 : Array.isArray(t.strokes) ? t.strokes.length : 0;
    if (n !== st.colors.length) say("`tokens.strokes` names " + n + " variable" + (n === 1 ? "" : "s") + " for " + st.colors.length + " stroke colour" + (st.colors.length === 1 ? "" : "s") + "; give one per colour, in order");
  }
  if (problems.length) return { problems, summary };

  summary.fields = fields;
  const add = (list: string[], name: unknown): void => { if (typeof name === "string" && list.indexOf(name) < 0) list.push(name); };
  if (Array.isArray(set.fills)) for (const p of set.fills) if (isObj(p) && isObj(p.tokens)) add(summary.refs.variables, p.tokens.color);
  for (const v of Object.values(t)) for (const name of typeof v === "string" ? [v] : Array.isArray(v) ? v : []) add(summary.refs.variables, name);
  if (isObj(set.styles)) add(summary.refs.textStyles, set.styles.text);
  summary.unbound = unboundOf(set, t);
  return { problems, summary };
}

/** The raw values of a (valid) patch where a variable could stand. */
function unboundOf(set: Record<string, unknown>, t: Record<string, unknown>): number {
  const has = (k: string): boolean => t[k] !== undefined && t[k] !== null;
  let c = 0;
  if (Array.isArray(set.fills)) for (const p of set.fills) if (isObj(p) && p.tokens === undefined) c++;
  const st = isObj(set.strokes) ? set.strokes : null;
  if (st) {
    if (Array.isArray(st.colors) && !has("strokes")) c += st.colors.length;
    if (st.weight !== undefined && !has("strokeWeight")) c++;
    if (isObj(st.weights)) for (const [side, f] of [["top", "strokeTopWeight"], ["right", "strokeRightWeight"], ["bottom", "strokeBottomWeight"], ["left", "strokeLeftWeight"]] as const) if (st.weights[side] !== undefined && !has(f)) c++;
  }
  const l = isObj(set.layout) ? set.layout : null;
  if (l) {
    if (l.gap !== undefined && !has("itemSpacing")) c++;
    if (Array.isArray(l.padding)) for (const f of ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"]) if (!has(f)) c++;
  }
  const corners = [["tl", "topLeftRadius"], ["tr", "topRightRadius"], ["br", "bottomRightRadius"], ["bl", "bottomLeftRadius"]] as const;
  if (typeof set.radius === "number") { if (!corners.every(([, f]) => has(f))) c++; }
  else if (isObj(set.radius)) for (const [k, f] of corners) if (set.radius[k] !== undefined && !has(f)) c++;
  return c;
}

/** `set` is a patch checkPatch accepts. The plugin applies only a patch that passed this. */
export function isPatchSet(v: unknown): v is PatchSet {
  return checkPatch(v).problems.length === 0;
}

/** The refusal for an invalid patch: every problem, one per line. */
export function patchRefusal(problems: readonly string[]): string {
  const first = problems[0];
  if (problems.length === 1 && first !== undefined) return first + ". Nothing was changed.";
  return problems.length + " problems in the patch — nothing was changed:\n" + problems.join("\n");
}

/** One preview row of a patch: a field and the value it gets, as compact JSON. */
export interface PatchRow { field: PatchField; to: string }
/** The dry run's rows for a valid patch: one per field it sets. */
export function patchRows(set: PatchSet, s: PatchSummary): PatchRow[] {
  return s.fields.map((f) => ({ field: f, to: JSON.stringify(set[f]) }));
}
/** One sentence of what a valid patch changes: the dry run's `change`. */
export function describePatch(nodeId: string | undefined, s: PatchSummary): string {
  const { variables, textStyles } = s.refs;
  const parts = ["node " + (nodeId || "?") + ": sets " + s.fields.join(", ")];
  if (variables.length) parts.push("variables " + quoteList(variables));
  if (textStyles.length) parts.push("text styles " + quoteList(textStyles));
  if (s.unbound) parts.push(s.unbound + " raw value" + (s.unbound === 1 ? "" : "s") + " left unbound");
  return parts.join("; ") + " — the node, its kind and the names are checked against the file when applied; the values it replaces are kept, and put back if a later op of the batch fails";
}
