// tree-spec.ts — the tree spec a `createTree` write carries: one nested document for a whole screen
// (docs/write-plane-spec.md decisions 1, 4, 5, 13, 14, 15, 20).
//
// Design-system references (decision 5): a node may be an INSTANCE of a named component with property values
// (`component`, `props`), a paint or a bindable number may name a variable (`fills[].tokens.color`, `tokens`), and a
// text may name a text style (`styles.text`), each in the read export's own fields. This module checks their shape and
// lists every name a spec uses (`TreeSummary.refs`); only the file can say what a name resolves to, so the plugin
// resolves them (figma-plugin/src/tree-refs.ts) before the batch runs. A raw value where a reference could stand is
// counted as `unbound`.
//
// The spec is the read export run backwards: a node uses the field names and values of an IrNode
// (doc-types.ts) with defaults omitted, carries no ids and no parent references, and may give itself a
// `handle` (the only nodes whose ids the reply returns). This module is the ONE check of a spec, read by
// all three readers of the write-op table (commands.ts WRITE_OPS): figma_write's dry run, the wire check
// a `write` passes in the plugin's handleBridge, and the plugin's applyWrites — so a spec the dry run calls
// valid is one the plugin builds, and one it refuses is refused before the file is touched.
//
// The decision per read field is a Record over the read type (`keyof IrNode`, `keyof LayoutSpec`,
// `keyof FontSpec`, `keyof Strokes`), so a field added to the read export fails to compile here until
// someone decides whether a write can set it. A read field a write cannot set is refused BY NAME, never
// dropped; a key the read export does not have is refused with the nearest field names.
//
// Pure and dependency-free (bar two pure siblings): the plugin bundle imports it, so it must type-check
// under figma-plugin/tsconfig.json (ES2019 lib, no Node types).
import type { Box, FontSpec, IrNode, LayoutSpec, RadiusCorners, RenderBox, SizeLimits, StyleRefs, Strokes } from "./doc-types.ts";
import { parseHexColor, HEX_COLOR_HINT } from "./hex-color.ts";
import { nearestNames, quoteList } from "./name-match.ts";

/** A solid paint as the read export writes it (paint.ts): `#rrggbb[aa]`, an optional paint opacity, and the colour
 *  variable it is bound to (`tokens.color`: a variable's name, key or id; the colour may then be left out). */
export interface TreeFill { type: "solid"; color?: string; opacity?: number; tokens?: { color: string } }
/** The node fields a number variable can be bound to: Figma's own field names, which the read writes under `tokens`. */
export const NUMBER_TOKEN_FIELDS = [
  "itemSpacing", "counterAxisSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius", "width", "height",
  "minWidth", "maxWidth", "minHeight", "maxHeight",
  "strokeWeight", "strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight", "opacity",
] as const;
export type NumberTokenField = (typeof NUMBER_TOKEN_FIELDS)[number];
/** A node's variable bindings, as the read writes them: a number field → a variable's name, key or id, and
 *  `fills` / `strokes` → the colour variable(s) of its paints. */
export type TreeTokens = { [K in NumberTokenField]?: string } & { fills?: string | string[]; strokes?: string | string[] };
/** The writable slice of `layout` (LayoutSpec): flex only. */
export interface TreeLayout {
  display?: "flex";
  mode?: "absolute";
  width?: number;
  height?: number;
  flexDirection?: "row" | "column";
  gap?: number;
  padding?: number[];
  justifyContent?: "flex-start" | "center" | "flex-end" | "space-between" | "space-evenly" | "space-around";
  alignItems?: "flex-start" | "center" | "flex-end" | "baseline";
  flexWrap?: "wrap";
  rowGap?: number;
  columnGap?: number;
  alignContent?: "space-between";
  reverseZ?: true;
}
/** The writable slice of `font` (FontSpec). */
export interface TreeFont {
  size?: number;
  family?: string;
  weight?: string;
  color?: string;
  align?: "left" | "center" | "right" | "justified";
  valign?: "center" | "bottom";
  lineHeight?: { unit: "px" | "percent" | "auto"; value?: number };
  letterSpacing?: { unit: "px" | "percent"; value: number };
  case?: "upper" | "lower" | "title" | "small_caps" | "small_caps_forced";
  decoration?: "underline" | "strikethrough";
  /** Variable-font axis values, e.g. `{ wght: 560 }`; an axis left out keeps the value `weight` names. */
  variationSettings?: Record<string, number>;
  /** The read's numeric weight: it follows `weight` (and `variationSettings`), so a write accepts it and sets nothing. */
  weightValue?: number;
}
/** The writable slice of `strokes` (Strokes). */
export interface TreeStrokes {
  colors?: string[];
  weight?: number;
  weights?: { top?: number; right?: number; bottom?: number; left?: number };
  align?: "inside" | "outside" | "center";
  /** Only the read's default, `{ profile: "uniform" }` (an even stroke), which sets nothing. */
  variableWidth?: { profile: "uniform" };
}
/** One node of a tree spec. `type` defaults to INSTANCE when the node names a `component`, TEXT when it has `text`,
 *  else FRAME. */
export interface TreeNodeSpec {
  type?: "FRAME" | "TEXT" | "INSTANCE";
  /** INSTANCE: the component — a local component or component set's exact name, or a component's key or id */
  component?: string;
  /** INSTANCE: property values by name (a variant's value, a text, a boolean) */
  props?: Record<string, string | boolean>;
  /** variables bound to this node's fields (Figma's field names) */
  tokens?: TreeTokens;
  /** TEXT: the text style it uses (a local style's exact name, or a style's key or id) */
  styles?: { text?: string };
  name?: string;
  /** A name the reply maps to the created node's id. Unique within the spec. */
  handle?: string;
  /** The root only: a stable name for the result. The plugin stores it on the root it builds; a spec sent again with
   *  the same key updates that result in place (tree-diff.ts) and replies with only what changed. */
  key?: string;
  hidden?: true;
  /** The root: page coordinates (placed beside the existing frames when absent). A child: relative to its parent,
   *  for a child of a frame without auto-layout or an `absolute` one. */
  x?: number;
  y?: number;
  /** `x`/`y` are the read's page coordinates of the node's own `x`/`y`: accepted, and they set nothing. */
  box?: { w: number; h: number; x?: number; y?: number };
  /** What the read says Figma renders: it follows `box` (and effects), so a write accepts it and sets nothing. */
  renderBox?: { x: number; y: number; w: number; h: number };
  layout?: TreeLayout;
  absolute?: true;
  grow?: number;
  alignSelf?: "min" | "center" | "max" | "stretch";
  widthMode?: "fill" | "hug";
  heightMode?: "fill" | "hug";
  sizeLimits?: SizeLimits;
  clip?: true;
  /** The strokes count toward the auto-layout size (border-box). Only on a frame with auto-layout. */
  strokesInLayout?: true;
  fills?: TreeFill[];
  strokes?: TreeStrokes;
  radius?: number | RadiusCorners;
  opacity?: number;
  text?: string;
  font?: TreeFont;
  autoResize?: "width_and_height" | "height" | "truncate";
  truncate?: true;
  maxLines?: number;
  children?: TreeNodeSpec[];
}

/** The most nodes one spec may hold, and how deep it may nest: a screen is far below both, a runaway is not. */
export const MAX_TREE_NODES = 500;
export const MAX_TREE_DEPTH = 40;
/** The longest `key` a spec root may carry. */
export const MAX_KEY_LENGTH = 200;
/** The font a text node gets when its spec names none (Figma's own default for a new text node). */
export const DEFAULT_FONT = { family: "Inter", weight: "Regular" } as const;

/** The design-system names a spec uses, each once, in first-use order. */
export interface TreeRefs {
  components: string[];
  variables: string[];
  textStyles: string[];
}
/** What a valid spec makes, for the dry run and the reply. */
export interface TreeSummary {
  frames: number;
  texts: number;
  instances: number;
  /** every component, variable and text style the spec names (resolved against the file by the plugin) */
  refs: TreeRefs;
  /** raw values where a reference could stand: colours, spacing, radii and stroke weights without a variable, and
   *  texts without a text style */
  unbound: number;
  /** every handle, in spec order */
  handles: string[];
  /** every font the texts without a text style use, first-use order (a styled text uses its style's font) */
  fonts: Array<{ family: string; weight: string }>;
  /** what is accepted but has no effect (x/y inside auto-layout, …), with the node's path */
  warnings: string[];
}

/** A field's check: null when `v` is fine, else what is wrong (the caller prefixes the path). */
type Check = (v: unknown) => string | null;
/** A read field a write does not set: why, in a few words (or "" for the plain sentence). */
interface Refuse { refuse: string }
type Rule = Check | Refuse;
const NOT_YET: Refuse = { refuse: "" };
const refuse = (why: string): Refuse => ({ refuse: why });
const isRefuse = (r: Rule): r is Refuse => typeof r !== "function";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str: Check = (v) => (typeof v === "string" ? null : "must be a string");
const num: Check = (v) => (isNum(v) ? null : "must be a number");
const nonNeg: Check = (v) => (isNum(v) && v >= 0 ? null : "must be a number ≥ 0");
/** Figma's resize() refuses a dimension under 0.01. */
const MIN_SIZE = 0.01;
const size: Check = (v) => (isNum(v) && v >= MIN_SIZE ? null : "must be a number ≥ " + MIN_SIZE);
const nonEmpty: Check = (v) => (typeof v === "string" && v.trim().length > 0 ? null : "must be a non-empty string");
const count: Check = (v) => (isNum(v) && Number.isInteger(v) && v >= 1 ? null : "must be a whole number ≥ 1");
const positive: Check = (v) => (isNum(v) && v > 0 ? null : "must be a number > 0 (leave it out for no limit)");
const unit: Check = (v) => (isNum(v) && v >= 0 && v <= 1 ? null : "must be a number from 0 to 1");
const trueOnly: Check = (v) => (v === true ? null : "must be true (omit it for false)");
const oneOf = (...vals: readonly string[]): Check => (v) => (typeof v === "string" && vals.includes(v) ? null : "must be one of " + vals.join(" | "));
const hex: Check = (v) => (parseHexColor(v) ? null : "is not " + HEX_COLOR_HINT);
const fourNums: Check = (v) => (Array.isArray(v) && v.length === 4 && v.every((n) => isNum(n) && n >= 0) ? null : "must be four numbers ≥ 0 [top, right, bottom, left]");
/** An object whose keys follow `rules` (the read type's own Record), checked recursively by `objectProblems`. */
const firstOr = (list: ReadonlyArray<string | null>): string | null => { for (const e of list) if (e !== null) return e; return null; };
const objOf = (rules: Readonly<Record<string, Rule>>): Check => (v) => (isObj(v) ? firstOr(objectProblems(v, rules, "")) : "must be an object");

const LAYOUT_RULES: Record<keyof LayoutSpec, Rule> = {
  display: (v) => (v === "flex" ? null : v === "grid" ? "'grid' cannot be written yet (flex can)" : "must be \"flex\""),
  mode: oneOf("absolute"),
  width: size, height: size,
  flexDirection: oneOf("row", "column"),
  gap: num,
  padding: fourNums,
  justifyContent: oneOf("flex-start", "center", "flex-end", "space-between", "space-evenly", "space-around"),
  alignItems: oneOf("flex-start", "center", "flex-end", "baseline"),
  flexWrap: oneOf("wrap"),
  rowGap: nonNeg, columnGap: nonNeg,
  alignContent: oneOf("space-between"),
  reverseZ: trueOnly,
  inferred: refuse("it says the read guessed the auto-layout; a write sets a real one"),
  columns: refuse("grid layout cannot be written yet"), rows: refuse("grid layout cannot be written yet"),
  columnSizes: refuse("grid layout cannot be written yet"), rowSizes: refuse("grid layout cannot be written yet"),
  autoFlow: refuse("grid layout cannot be written yet"), autoTracks: refuse("grid layout cannot be written yet"),
};
/** A `{unit, value}` length: both present (an object missing either is refused, not sent to Figma half-made). */
const LENGTH = (units: readonly string[], value: Check = num): Check => (v) => {
  if (!isObj(v)) return "must be an object {unit, value}";
  const bad = objOf({ unit: oneOf(...units), value })(v);
  if (bad !== null) return bad;
  return v.unit === undefined ? "is missing unit" : v.value === undefined ? "is missing value" : null;
};
const FONT_RULES: Record<keyof FontSpec, Rule> = {
  size: (v) => (v === "mixed" ? "'mixed' cannot be written (one size per text node)" : isNum(v) && v >= 1 ? null : "must be a number ≥ 1"),
  family: nonEmpty, weight: nonEmpty, color: hex,
  align: oneOf("left", "center", "right", "justified"),
  valign: oneOf("center", "bottom"),
  lineHeight: (v) => {
    if (!isObj(v) || v.unit !== "auto") return LENGTH(["px", "percent"], nonNeg)(v);
    // `auto` has no value: every other key is refused, not dropped.
    const extra = Object.keys(v).filter((k) => k !== "unit" && v[k] !== undefined);
    return extra.length ? "." + extra[0] + ": not a field of an `auto` line height (it is `{unit:\"auto\"}` alone)" : null;
  },
  letterSpacing: LENGTH(["px", "percent"]),
  case: oneOf("upper", "lower", "title", "small_caps", "small_caps_forced"),
  decoration: oneOf("underline", "strikethrough"),
  // The read writes it on every text; it follows the style named in `weight`, so it is accepted and sets nothing.
  // No upper bound: Figma takes a `wght` axis past 1000 (seen live: 5000) and the read then writes that weight.
  weightValue: (v) => (isNum(v) && v > 0 ? null : "must be a number > 0 (it follows `weight`, and sets nothing)"),
  variationSettings: (v) => {
    if (!isObj(v)) return "must be an object of axis tag → number, e.g. {\"wght\": 560}";
    for (const [k, x] of Object.entries(v)) if (!isNum(x)) return "." + k + " must be a number";
    return null;
  },
  fontStyle: refuse("italic is part of the style name in `weight`, e.g. \"Italic\""),
  decorationStyle: NOT_YET, decorationColor: NOT_YET, decorationThickness: NOT_YET,
  decorationOffset: NOT_YET, decorationSkipInk: NOT_YET, openType: NOT_YET, openTypeOff: NOT_YET, paragraphSpacing: NOT_YET,
  paragraphIndent: NOT_YET, listSpacing: NOT_YET, leadingTrim: NOT_YET, textWrap: NOT_YET, hangingList: NOT_YET,
  hangingPunctuation: NOT_YET,
};
const SIDES: Record<"top" | "right" | "bottom" | "left", Rule> = { top: nonNeg, right: nonNeg, bottom: nonNeg, left: nonNeg };
const STROKE_RULES: Record<keyof Strokes, Rule> = {
  colors: (v) => (Array.isArray(v) && v.length > 0 ? firstOr(v.map(hex)) : "must be a non-empty list of hex colours"),
  weight: nonNeg,
  weights: objOf(SIDES),
  align: oneOf("inside", "outside", "center"),
  paints: refuse("only solid stroke `colors` can be written yet"),
  // The read writes `{profile:"uniform"}` on an ordinary stroke: that default is accepted (it sets nothing); a taper is not yet.
  variableWidth: (v) => (isObj(v) && v.profile === "uniform" && Object.keys(v).every((k) => k === "profile") ? null
    : "only the default {profile:\"uniform\"} can be written yet (a tapered or custom-width stroke cannot)"),
  dash: NOT_YET, cap: NOT_YET, join: NOT_YET, miter: NOT_YET, complex: NOT_YET,
};
const BOX_RULES: Record<keyof Box, Rule> = {
  w: size, h: size,
  // The read's page coordinates of the node's own `x`/`y` (written alongside them): accepted, and they set nothing.
  x: num, y: num,
};
const RADIUS_RULES: Record<keyof RadiusCorners, Rule> = { tl: nonNeg, tr: nonNeg, br: nonNeg, bl: nonNeg };
// Figma: "Value must be positive. Set to null to remove" — a 0 would throw mid-build.
const LIMIT_RULES: Record<keyof SizeLimits, Rule> = { minWidth: positive, maxWidth: positive, minHeight: positive, maxHeight: positive };
const RENDER_BOX_RULES: Record<keyof RenderBox, Rule> = { x: num, y: num, w: nonNeg, h: nonNeg };
const FILL_RULES: Readonly<Record<string, Rule>> = {
  type: (v) => (v === "solid" ? null : typeof v === "string" ? "'" + v + "' cannot be written yet (solid can)" : "must be \"solid\""),
  color: hex,
  opacity: unit,
  tokens: (v) => {
    if (!isObj(v)) return "must be an object {color: variable}";
    const bad = firstOr(objectProblems(v, PAINT_TOKEN_RULES, ""));
    return bad !== null ? bad : v.color === undefined ? "is missing color (the colour variable's name, key or id)" : null;
  },
  blend: NOT_YET,
  visible: refuse("an invisible paint is never written; leave it out"),
};
const fillsCheck: Check = (v) => {
  if (!Array.isArray(v)) return "must be a list of paints ({type:\"solid\", color})";
  for (const [i, p] of v.entries()) {
    if (!isObj(p)) return "[" + i + "] must be a paint object";
    const bad = objectProblems(p, FILL_RULES, "")[0];
    if (bad) return "[" + i + "]" + (bad.startsWith(".") ? "" : " ") + bad;
    if (p.color === undefined && p.tokens === undefined) return "[" + i + "] is missing color (a hex colour, or a colour variable in `tokens.color`)";
  }
  return null;
};
/** A reference to a variable, style or component: its name, key or id. */
const ref: Check = nonEmpty;
const refs: Check = (v) => (typeof v === "string" ? ref(v) : Array.isArray(v) && v.length > 0 ? firstOr(v.map((x, i) => { const bad = ref(x); return bad === null ? null : "[" + i + "] " + bad; })) : "must be a variable's name, key or id, or a non-empty list of them");
const PAINT_TOKEN_RULES: Readonly<Record<string, Rule>> = { color: ref };
/** `tokens`: Figma's bindable field names (the read's own keys) → a variable. Which fields fit which node is checked by the walk. */
const TOKEN_RULES: Readonly<Record<string, Rule>> = {
  ...Object.fromEntries(NUMBER_TOKEN_FIELDS.map((k) => [k, ref])),
  fills: refs, strokes: refs,
  characters: refuse("a text's content cannot be bound to a variable yet; give `text`"),
  visible: refuse("visibility cannot be bound to a variable yet; give `hidden`"),
  cornerRadius: refuse("bind each corner: topLeftRadius, topRightRadius, bottomRightRadius, bottomLeftRadius"),
};
/** The number fields each node kind can bind (the rest are refused on that kind by name). */
const FRAME_TOKENS: readonly string[] = [...NUMBER_TOKEN_FIELDS, "fills", "strokes"];
const TEXT_TOKENS: readonly string[] = ["width", "height", "opacity", "strokeWeight", "fills", "strokes"];
const INSTANCE_TOKENS: readonly string[] = ["width", "height", "opacity"];
const STYLE_RULES: Record<keyof StyleRefs, Rule> = {
  text: ref,
  fill: refuse("bind the paint to a colour variable instead: `fills[].tokens.color`"),
  stroke: refuse("bind the strokes to colour variables instead: `tokens.strokes`"),
  effect: refuse("effects cannot be written yet"), grid: refuse("layout grids cannot be written yet"),
};
const propsCheck: Check = (v) => {
  if (!isObj(v)) return "must be an object of property name → value";
  for (const [k, x] of Object.entries(v)) {
    if (!k.trim()) return "has an empty property name";
    if (x !== undefined && typeof x !== "string" && typeof x !== "boolean") return "." + k + " must be a string (a variant's value, a text) or a boolean";
  }
  return null;
};
const DS_REF = "binding a text field to a variable cannot be written yet; name a text style in `styles.text`";

/** Every IrNode field, and whether a tree spec may carry it. `children` and `type` are checked by the walk. */
const NODE_RULES: Record<keyof IrNode, Rule> & { handle: Rule; key: Rule } = {
  type: str, children: (v) => (Array.isArray(v) ? null : "must be a list of nodes"),
  name: str,
  // "__proto__" is refused: Figma's own main-thread → UI message copy drops a key of that name (seen live), so the
  // reply could not carry it back however the plugin builds it.
  handle: (v) => (typeof v !== "string" || v.length === 0 ? "must be a non-empty string" : v === "__proto__" ? "'__proto__' cannot be a handle (Figma's message passing drops that key); pick another name" : null),
  // Stored on the node as plugin data (an entry is capped at 100 kB by Figma; a key is far below it).
  key: (v) => (typeof v !== "string" || !v.trim() ? "must be a non-empty string" : v.length > MAX_KEY_LENGTH ? "must be at most " + MAX_KEY_LENGTH + " characters" : null),
  id: refuse("a new node gets its id from Figma; give it a `handle` to get the id back"),
  hidden: trueOnly,
  x: num, y: num,
  box: objOf(BOX_RULES),
  layout: objOf(LAYOUT_RULES),
  absolute: trueOnly,
  grow: (v) => (v === 0 || v === 1 ? null : "must be 0 or 1"),
  alignSelf: oneOf("min", "center", "max", "stretch"),
  widthMode: oneOf("fill", "hug"),
  heightMode: oneOf("fill", "hug"),
  sizeLimits: objOf(LIMIT_RULES),
  clip: trueOnly,
  fills: fillsCheck,
  strokes: objOf(STROKE_RULES),
  radius: (v) => (isNum(v) ? nonNeg(v) : objOf(RADIUS_RULES)(v)),
  opacity: unit,
  text: str,
  font: objOf(FONT_RULES),
  autoResize: oneOf("width_and_height", "height", "truncate"),
  truncate: trueOnly,
  maxLines: count,
  component: ref,
  props: propsCheck,
  tokens: objOf(TOKEN_RULES),
  styles: objOf(STYLE_RULES),
  // Read fields a write does not set (yet). Each is refused by name.
  propTokens: refuse("a property bound to a variable cannot be written yet; give its value in `props`"),
  mainComponent: refuse("name the component in `component` (its name, key or id)"),
  propRefs: NOT_YET, overrides: NOT_YET, exposedInstances: NOT_YET, detachedFrom: NOT_YET,
  renderBox: objOf(RENDER_BOX_RULES), // it follows `box`: accepted, sets nothing
  layoutGrids: NOT_YET, scroll: NOT_YET,
  gridColumnSpan: NOT_YET, gridRowSpan: NOT_YET, gridColumnStart: NOT_YET, gridRowStart: NOT_YET, gridJustifySelf: NOT_YET,
  gridAlignSelf: NOT_YET, pin: NOT_YET, fixedChildren: NOT_YET, strokesInLayout: trueOnly, effects: NOT_YET,
  radiusFull: refuse("set `radius` to the size it should render at"), rotation: NOT_YET, flipped: NOT_YET, skew: NOT_YET,
  blendMode: NOT_YET, mask: NOT_YET, maskType: NOT_YET, cornerSmoothing: NOT_YET, aspectRatio: NOT_YET, arc: NOT_YET,
  shape: NOT_YET, booleanOp: NOT_YET, exportSettings: NOT_YET, overlay: NOT_YET,
  textTokens: refuse(DS_REF),
  reactions: NOT_YET, variableModes: refuse("set a frame's mode with a setVariableMode op after the tree lands"),
  resolvedModes: refuse("it is read-only (what the frame inherits)"), annotations: NOT_YET, devStatus: NOT_YET,
  devStatusNote: NOT_YET, css: refuse("it is read-only"), pluginData: NOT_YET, sharedData: NOT_YET, motion: NOT_YET,
  asset: refuse("images come in a later write step"), assetSkipped: refuse("it is read-only"), assetFrom: refuse("it is read-only"),
  sourceTransform: refuse("it is read-only"), geometry: NOT_YET, tableCells: NOT_YET, reference: str, // the read's path to its reference PNG: accepted, sets nothing
  devResources: NOT_YET, runs: refuse("mixed-format text comes in a later write step; give one `font`"), href: NOT_YET,
  linkNode: NOT_YET, list: NOT_YET, indent: NOT_YET, textStyleOverrides: refuse("it is read-only (which fields differ from the text style)"), missingFont: refuse("it is read-only"),
};

/** `k` is a field `rules` lets a write set (not unknown, not refused by name). */
const settable = (rules: Readonly<Record<string, Rule>>, k: string): boolean => {
  const r = Object.prototype.hasOwnProperty.call(rules, k) ? rules[k] : undefined;
  return r !== undefined && !isRefuse(r);
};

/** Every problem with the keys of `o` against `rules`: refused read fields by name, unknown keys with the nearest
 *  names, bad values with what they must be. Each starts with `path` + "." + the key. */
function objectProblems(o: Record<string, unknown>, rules: Readonly<Record<string, Rule>>, path: string): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined) continue;
    const at = path + "." + k;
    const rule = Object.prototype.hasOwnProperty.call(rules, k) ? rules[k] : undefined;
    if (rule === undefined) {
      const near = nearestNames(k, Object.keys(rules).filter((r) => { const x = rules[r]; return x !== undefined && !isRefuse(x); }));
      out.push(at + ": not a field the write accepts" + (near.length ? "; closest: " + quoteList(near) : ""));
    } else if (isRefuse(rule)) {
      out.push(at + ": a read field a write cannot set yet" + (rule.refuse ? " — " + rule.refuse : ""));
    } else {
      const bad = rule(v);
      if (bad !== null) out.push(at + (bad.startsWith(".") || bad.startsWith("[") ? "" : " ") + bad);
    }
  }
  return out;
}

export type NodeKind = "FRAME" | "TEXT" | "INSTANCE";
/** The kind a node spec is: its `type`, else INSTANCE when it names a `component`, TEXT when it has `text`, else FRAME. */
export function nodeKind(n: { type?: unknown; text?: unknown; component?: unknown }): NodeKind | null {
  if (n.type === undefined) return n.component !== undefined ? "INSTANCE" : n.text !== undefined ? "TEXT" : "FRAME";
  return n.type === "FRAME" || n.type === "TEXT" || n.type === "INSTANCE" ? n.type : null;
}
/** The fields an INSTANCE node may carry: its place and size, and the component with its property values. Its
 *  content comes from the component, so everything else is refused on it. */
const INSTANCE_FIELDS = new Set(["type", "component", "props", "name", "handle", "hidden", "x", "y", "box", "renderBox", "reference",
  "absolute", "grow", "alignSelf", "widthMode", "heightMode", "opacity", "tokens"]);
/** The font fields a text style sets: on a styled text they are accepted and set nothing. */
const STYLE_FONT_FIELDS = ["family", "weight", "size", "lineHeight", "letterSpacing", "case", "decoration", "variationSettings"] as const;
const SIDE_PAD = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"] as const;
const CORNERS = [["tl", "topLeftRadius"], ["tr", "topRightRadius"], ["br", "bottomRightRadius"], ["bl", "bottomLeftRadius"]] as const;
const STROKE_SIDES = [["top", "strokeTopWeight"], ["right", "strokeRightWeight"], ["bottom", "strokeBottomWeight"], ["left", "strokeLeftWeight"]] as const;
const nameList = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The raw values of one (valid) node where a reference could stand: each colour, spacing, radius and stroke weight
 *  without a variable, and a text without a text style. */
function unboundOf(n: Record<string, unknown>, kind: NodeKind): number {
  const t = isObj(n.tokens) ? n.tokens : {};
  const has = (k: string): boolean => t[k] !== undefined;
  let c = 0;
  if (Array.isArray(n.fills)) for (const p of n.fills) if (isObj(p) && p.tokens === undefined) c++;
  if (kind === "TEXT") {
    const styled = isObj(n.styles) && n.styles.text !== undefined;
    if (!styled) c++;
    if (n.fills === undefined && !has("fills") && isObj(n.font) && n.font.color !== undefined) c++;
  }
  const st = isObj(n.strokes) ? n.strokes : null;
  if (st) {
    if (Array.isArray(st.colors) && !has("strokes")) c += st.colors.length;
    if (st.weight !== undefined && !has("strokeWeight")) c++;
    if (isObj(st.weights)) for (const [side, field] of STROKE_SIDES) if (st.weights[side] !== undefined && !has(field)) c++;
  }
  const l = isObj(n.layout) ? n.layout : null;
  if (l && l.display === "flex") {
    if (l.gap !== undefined && !has("itemSpacing")) c++;
    if (Array.isArray(l.padding)) SIDE_PAD.forEach((f) => { if (!has(f)) c++; });
    const track = l.flexDirection === "column" ? l.columnGap : l.rowGap;
    if (l.flexWrap !== undefined && track !== undefined && !has("counterAxisSpacing")) c++;
  }
  if (typeof n.radius === "number") { if (!CORNERS.every(([, f]) => has(f))) c++; }
  else if (isObj(n.radius)) for (const [k, f] of CORNERS) if (n.radius[k] !== undefined && !has(f)) c++;
  return c;
}
const isFlex = (n: Record<string, unknown>): boolean => isObj(n.layout) && n.layout.display === "flex";

/** A text node's font as Figma names it: family + style (`weight`), defaults filled in. */
export function fontOf(font: TreeFont | undefined): { family: string; weight: string } {
  // Only an OMITTED name takes the default; checkTree refuses an empty one (a name is never guessed).
  return { family: font && font.family !== undefined ? font.family : DEFAULT_FONT.family, weight: font && font.weight !== undefined ? font.weight : DEFAULT_FONT.weight };
}

/** The context `tokens` needs on a node of `kind` (its shape is checked by TOKEN_RULES): each field is one the kind
 *  has, a spacing field sits on an auto-layout frame, a size is not also `fill`/`hug`, and `fills`/`strokes` name the
 *  node's paints. */
function tokenProblems(n: Record<string, unknown>, t: Record<string, unknown>, kind: NodeKind, flex: boolean, inFlex: boolean, say: (m: string) => void): void {
  const fits = kind === "FRAME" ? FRAME_TOKENS : kind === "TEXT" ? TEXT_TOKENS : INSTANCE_TOKENS;
  const l = isObj(n.layout) ? n.layout : {};
  for (const k of Object.keys(t)) {
    if (t[k] === undefined || !settable(TOKEN_RULES, k)) continue;
    const at = "`tokens." + k + "`";
    if (fits.indexOf(k) < 0) { say(at + " is not on a" + (kind === "INSTANCE" ? "n " : " ") + kind + " node" + (kind === "INSTANCE" ? " (its content comes from its component)" : "")); continue; }
    if ((k === "itemSpacing" || k.startsWith("padding")) && !flex) say(at + " needs auto-layout on the node (layout.display \"flex\")");
    if (k === "counterAxisSpacing" && (!flex || l.flexWrap === undefined)) say(at + " is the gap between wrapped tracks: it needs `layout.flexWrap: \"wrap\"`");
    if (k === "width" && n.widthMode !== undefined) say(at + " sizes the node, which `widthMode` already does; leave one out");
    if (k === "height" && n.heightMode !== undefined) say(at + " sizes the node, which `heightMode` already does; leave one out");
    if ((k === "minWidth" || k === "maxWidth" || k === "minHeight" || k === "maxHeight") && !flex && !inFlex) say(at + " needs auto-layout on the node or its parent");
  }
  const fills = nameList(t.fills);
  if (t.fills !== undefined && Array.isArray(n.fills)) {
    // The read writes a bound paint's variable both on the paint and here: here it adds nothing, so it must agree.
    const onPaints = n.fills.map((p) => (isObj(p) && isObj(p.tokens) ? p.tokens.color : undefined));
    for (const name of fills) if (onPaints.indexOf(name) < 0) say("`tokens.fills` names '" + name + "', which no paint in `fills` is bound to; bind the paint instead: `fills[i].tokens.color`");
  }
  const strokes = nameList(t.strokes);
  const colors = isObj(n.strokes) && Array.isArray(n.strokes.colors) ? n.strokes.colors : null;
  if (t.strokes !== undefined && colors && colors.length !== strokes.length) say("`tokens.strokes` names " + strokes.length + " variable" + (strokes.length === 1 ? "" : "s") + " for " + colors.length + " stroke colour" + (colors.length === 1 ? "" : "s") + "; give one per colour, in order (or leave `strokes.colors` out)");
}

/** The check of a whole spec: every problem (empty when it is valid) and, for a valid one, what it makes. */
export function checkTree(spec: unknown): { problems: string[]; summary: TreeSummary } {
  const problems: string[] = [];
  const summary: TreeSummary = { frames: 0, texts: 0, instances: 0, refs: { components: [], variables: [], textStyles: [] }, unbound: 0, handles: [], fonts: [], warnings: [] };
  const seenHandles = new Set<string>();
  const seenFonts = new Set<string>();
  let count = 0;
  let tooMany = false;
  const walk = (n: unknown, path: string, depth: number, parentFlex: boolean | null): void => {
    if (++count > MAX_TREE_NODES) { tooMany = true; return; }
    if (!isObj(n)) { problems.push(path + ": must be a node object"); return; }
    if (depth > MAX_TREE_DEPTH) { problems.push(path + ": nested deeper than " + MAX_TREE_DEPTH + " levels"); return; }
    const before = problems.length;
    problems.push(...objectProblems(n, NODE_RULES, path));
    const kind = nodeKind(n);
    if (kind === null) problems.push(path + ".type: '" + String(n.type) + "' cannot be written yet (FRAME, TEXT and INSTANCE can)");
    const isRoot = parentFlex === null;
    const flex = isFlex(n);
    const say = (msg: string): void => { problems.push(path + ": " + msg); };
    if (!isRoot && n.key !== undefined) say("`key` names a whole result, so only the root carries it");
    if (kind === "TEXT") {
      if (typeof n.text !== "string") say("a TEXT node needs `text`");
      for (const k of ["children", "layout", "clip", "radius", "sizeLimits", "strokesInLayout"]) if (n[k] !== undefined) say("`" + k + "` is not on a TEXT node");
      if (n.maxLines !== undefined && n.truncate !== true) summary.warnings.push(path + ": `maxLines` has no effect without `truncate: true`, so it is not set");
    } else if (kind === "FRAME") {
      for (const k of ["text", "font", "autoResize", "truncate", "maxLines"]) if (n[k] !== undefined) say("`" + k + "` is only on a TEXT node (give the node `text`)");
    } else if (kind === "INSTANCE") {
      if (n.component === undefined) say("an INSTANCE node needs `component` (a component's name, key or id)");
      for (const k of Object.keys(n)) if (n[k] !== undefined && !INSTANCE_FIELDS.has(k) && settable(NODE_RULES, k)) say("`" + k + "` is not on an INSTANCE node (its content comes from its component; set its `props`)");
    }
    if (kind !== "INSTANCE") for (const k of ["component", "props"]) if (n[k] !== undefined) say("`" + k + "` is only on an INSTANCE node");
    if (isObj(n.styles) && n.styles.text !== undefined && kind !== "TEXT") say("`styles.text` is only on a TEXT node");
    for (const axis of ["widthMode", "heightMode"] as const) {
      const m = n[axis];
      if (m === "fill" && parentFlex !== true) say("`" + axis + ": \"fill\"` needs a parent with auto-layout" + (isRoot ? " (this is the root)" : ""));
      // An instance hugs when its component has auto-layout: only the file knows, so the plugin checks it.
      if (m === "hug" && !flex && kind === "FRAME") say("`" + axis + ": \"hug\"` needs the node itself to have auto-layout (layout.display \"flex\") or be TEXT");
    }
    if (isObj(n.tokens) && kind !== null) tokenProblems(n, n.tokens, kind, flex, parentFlex === true, say);
    if (parentFlex !== true) {
      for (const k of ["absolute", "grow", "alignSelf"]) if (n[k] !== undefined) say("`" + k + "` needs a parent with auto-layout");
    }
    if (n.sizeLimits !== undefined && !flex && parentFlex !== true) say("`sizeLimits` needs auto-layout on the node or its parent");
    if (n.absolute === true && parentFlex === true) {
      // Out of the flow, a child cannot fill or grow in it: Figma refuses these on an absolute child mid-build.
      for (const axis of ["widthMode", "heightMode"] as const) if (n[axis] === "fill") say("`" + axis + ": \"fill\"` is not on an `absolute` child (it is out of the auto-layout flow)");
      if (n.grow === 1) say("`grow: 1` is not on an `absolute` child (it is out of the auto-layout flow)");
      if (n.alignSelf === "stretch") say("`alignSelf: \"stretch\"` is not on an `absolute` child (it is out of the auto-layout flow)");
    }
    if (kind === "FRAME" && n.strokesInLayout === true && !flex) summary.warnings.push(path + ": `strokesInLayout` has no effect without auto-layout on the frame, so it is not set");
    if (parentFlex === true && n.absolute !== true && (n.x !== undefined || n.y !== undefined)) {
      summary.warnings.push(path + ": `x`/`y` have no effect inside auto-layout (add `absolute: true` to place it)");
    }
    if (isObj(n.layout) && n.layout.display === "flex") {
      // Values Figma refuses, or ignores, only in context: caught here so nothing is sent that fails mid-build.
      const l = n.layout;
      const column = l.flexDirection === "column";
      if (l.alignItems === "baseline" && column) say("`layout.alignItems: \"baseline\"` works only in a row (Figma refuses it in a column)");
      if (l.flexWrap === undefined) for (const k of ["rowGap", "columnGap", "alignContent"]) if (l[k] !== undefined) say("`layout." + k + "` needs `flexWrap: \"wrap\"`");
      if (l.flexWrap !== undefined && (column ? l.rowGap : l.columnGap) !== undefined) {
        say("`layout." + (column ? "rowGap" : "columnGap") + "` is the main-axis gap in a wrapping " + (column ? "column" : "row") + "; use `gap`, and `" + (column ? "columnGap" : "rowGap") + "` between the wrapped tracks");
      }
    }
    if (kind === "TEXT" && isObj(n.strokes) && n.strokes.weights !== undefined) say("`strokes.weights` (per side) is not on a TEXT node; use `strokes.weight`");
    if (isObj(n.sizeLimits)) {
      const m = n.sizeLimits;
      if (isNum(m.minWidth) && isNum(m.maxWidth) && m.minWidth > m.maxWidth) say("`sizeLimits.minWidth` is above `maxWidth`");
      if (isNum(m.minHeight) && isNum(m.maxHeight) && m.minHeight > m.maxHeight) say("`sizeLimits.minHeight` is above `maxHeight`");
    }
    if (isObj(n.layout) && n.layout.mode === "absolute") {
      const l = n.layout;
      if (l.display !== undefined) say("`layout` is either `display: \"flex\"` or `mode: \"absolute\"`, not both");
      // No auto-layout: its fields would be dropped, so they are refused (width/height are the frame's size either way).
      else for (const k of Object.keys(l)) if (l[k] !== undefined && k !== "mode" && k !== "width" && k !== "height" && settable(LAYOUT_RULES, k)) say("`layout." + k + "` is an auto-layout field; `mode: \"absolute\"` has none (use `display: \"flex\"`)");
    }
    if (isObj(n.layout) && n.layout.display === undefined && n.layout.mode === undefined) say("`layout` needs `display: \"flex\"` (or `mode: \"absolute\"` for none)");
    if (typeof n.handle === "string" && n.handle) {
      if (seenHandles.has(n.handle)) say("handle '" + n.handle + "' is used twice; a handle names one node");
      seenHandles.add(n.handle);
    }
    if (problems.length === before && kind !== null) {
      const styled = isObj(n.styles) && typeof n.styles.text === "string";
      if (kind === "TEXT") {
        summary.texts++;
        if (styled) {
          const set = isObj(n.font) ? STYLE_FONT_FIELDS.filter((k) => isObj(n.font) && n.font[k] !== undefined) : [];
          if (set.length) summary.warnings.push(path + ": " + set.map((k) => "`font." + k + "`").join(", ") + " " + (set.length === 1 ? "is" : "are") + " set by the text style, so " + (set.length === 1 ? "it is" : "they are") + " not set");
        } else {
          const f = fontOf(isObj(n.font) ? n.font : undefined);
          const key = f.family + "|" + f.weight;
          if (!seenFonts.has(key)) { seenFonts.add(key); summary.fonts.push(f); }
        }
      } else if (kind === "INSTANCE") summary.instances++;
      else summary.frames++;
      if (typeof n.handle === "string" && n.handle) summary.handles.push(n.handle);
      const addRef = (list: string[], name: unknown): void => { if (typeof name === "string" && list.indexOf(name) < 0) list.push(name); };
      if (kind === "INSTANCE") addRef(summary.refs.components, n.component);
      if (styled && isObj(n.styles)) addRef(summary.refs.textStyles, n.styles.text);
      if (Array.isArray(n.fills)) for (const p of n.fills) if (isObj(p) && isObj(p.tokens)) addRef(summary.refs.variables, p.tokens.color);
      if (isObj(n.tokens)) for (const v of Object.values(n.tokens)) for (const name of nameList(v)) addRef(summary.refs.variables, name);
      summary.unbound += unboundOf(n, kind);
    }
    if (Array.isArray(n.children)) n.children.forEach((c, i) => walk(c, path + ".children[" + i + "]", depth + 1, flex));
  };
  if (!isObj(spec)) problems.push("tree: must be a node object (the root frame)");
  else {
    walk(spec, "tree", 0, null);
    if (nodeKind(spec) !== "FRAME") problems.push("tree: the root must be a FRAME (a screen); put the " + (nodeKind(spec) === "INSTANCE" ? "instance" : "text") + " inside one");
    if (tooMany) problems.push("tree: more than " + MAX_TREE_NODES + " nodes — send a large screen as several trees");
  }
  return { problems, summary };
}

/** `v` is a spec checkTree accepts. The plugin builds only a spec that passed this. */
export function isTreeSpec(v: unknown): v is TreeNodeSpec {
  return checkTree(v).problems.length === 0;
}

/** The refusal for an invalid spec: every problem (each starting with its path), one per line. */
export function treeRefusal(problems: readonly string[]): string {
  const first = problems[0];
  if (problems.length === 1 && first !== undefined) return first + ". Nothing was changed.";
  return problems.length + " problems in the tree spec — nothing was changed:\n" + problems.join("\n");
}

/** One sentence of what a valid spec creates: the dry run's `change`. `page` is the op's page, if it named one. */
export function describeTree(spec: TreeNodeSpec, page: string | undefined, s: TreeSummary): string {
  const size = spec.box ? " " + spec.box.w + "×" + spec.box.h : spec.layout && spec.layout.width && spec.layout.height ? " " + spec.layout.width + "×" + spec.layout.height : "";
  const al = spec.layout && spec.layout.display === "flex" ? ", " + (spec.layout.flexDirection === "column" ? "vertical" : "horizontal") + " auto-layout" : "";
  const nodes = s.frames + s.texts + s.instances;
  const plural = (n: number, one: string): string => n + " " + one + (n === 1 ? "" : "s");
  const where = (page ? "on page '" + page + "'" : "on the current page") +
    (spec.x !== undefined || spec.y !== undefined ? " at " + (spec.x !== undefined ? spec.x : "auto") + "," + (spec.y !== undefined ? spec.y : "auto") : ", placed beside the existing frames");
  const parts = [
    "creates frame '" + (spec.name || "Frame") + "'" + size + al + " with " + nodes + " node" + (nodes === 1 ? "" : "s") +
      " (" + plural(s.frames, "frame") + ", " + plural(s.texts, "text") + (s.instances ? ", " + plural(s.instances, "instance") : "") + ") " + where,
  ];
  if (spec.key !== undefined) parts.push("key '" + spec.key + "': when the file already holds this key's earlier result, that result is updated in place instead (same ids, only the fields that differ from the spec sent last time) and the reply lists only what changed");
  if (s.handles.length) parts.push("ids come back for " + quoteList(s.handles));
  if (s.fonts.length) parts.push("fonts " + quoteList(s.fonts.map((f) => f.family + " " + f.weight)));
  const { components, variables, textStyles } = s.refs;
  if (components.length) parts.push("components " + quoteList(components));
  if (variables.length) parts.push("variables " + quoteList(variables));
  if (textStyles.length) parts.push("text styles " + quoteList(textStyles));
  if (s.unbound) parts.push(plural(s.unbound, "raw value") + " left unbound");
  const checked = components.length + variables.length + textStyles.length
    ? "the page, fonts and names are checked against the file when applied (a library item is imported only then)"
    : "the page and fonts are checked against the file when applied";
  return parts.join("; ") + " — " + checked + ", and nothing lands unless all of it does";
}

// ---------------------------------------------------------------- shared with patch-spec.ts
// A patch (patch-spec.ts) sets the same fields on an existing node: it checks each value with the rule the tree spec
// uses for that field, so a value one accepts the other accepts too.
export type { Check, Rule };
export { LAYOUT_RULES, NODE_RULES, STROKE_RULES, STYLE_RULES, SIDES, fillsCheck, hex, isObj, isRefuse, nonNeg, objOf, objectProblems, oneOf, propsCheck, ref, refs, refuse, size, str, unit };
