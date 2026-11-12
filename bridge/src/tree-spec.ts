// tree-spec.ts — the tree spec a `createTree` write carries: one nested document for a whole screen
// (docs/write-plane-spec.md decisions 1, 4, 13, 14, 20).
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
import type { Box, FontSpec, IrNode, LayoutSpec, RadiusCorners, SizeLimits, Strokes } from "./doc-types.ts";
import { parseHexColor, HEX_COLOR_HINT } from "./hex-color.ts";
import { nearestNames, quoteList } from "./name-match.ts";

/** A solid paint as the read export writes it (paint.ts): `#rrggbb[aa]`, an optional paint opacity. */
export interface TreeFill { type: "solid"; color: string; opacity?: number }
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
}
/** The writable slice of `strokes` (Strokes). */
export interface TreeStrokes {
  colors?: string[];
  weight?: number;
  weights?: { top?: number; right?: number; bottom?: number; left?: number };
  align?: "inside" | "outside" | "center";
}
/** One node of a tree spec. `type` defaults to TEXT when the node has `text`, else FRAME. */
export interface TreeNodeSpec {
  type?: "FRAME" | "TEXT";
  name?: string;
  /** A name the reply maps to the created node's id. Unique within the spec. */
  handle?: string;
  hidden?: true;
  /** The root: page coordinates (placed beside the existing frames when absent). A child: relative to its parent,
   *  for a child of a frame without auto-layout or an `absolute` one. */
  x?: number;
  y?: number;
  box?: { w: number; h: number };
  layout?: TreeLayout;
  absolute?: true;
  grow?: number;
  alignSelf?: "min" | "center" | "max" | "stretch";
  widthMode?: "fill" | "hug";
  heightMode?: "fill" | "hug";
  sizeLimits?: SizeLimits;
  clip?: true;
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
/** The font a text node gets when its spec names none (Figma's own default for a new text node). */
export const DEFAULT_FONT = { family: "Inter", weight: "Regular" } as const;

/** What a valid spec makes, for the dry run and the reply. */
export interface TreeSummary {
  frames: number;
  texts: number;
  /** every handle, in spec order */
  handles: string[];
  /** every font the texts use, as `family|weight`, first-use order */
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
  lineHeight: (v) => (isObj(v) && v.unit === "auto" && v.value === undefined ? null : LENGTH(["px", "percent"], nonNeg)(v)),
  letterSpacing: LENGTH(["px", "percent"]),
  case: oneOf("upper", "lower", "title", "small_caps", "small_caps_forced"),
  decoration: oneOf("underline", "strikethrough"),
  weightValue: refuse("the weight is the style name in `weight`"),
  fontStyle: refuse("italic is part of the style name in `weight`, e.g. \"Italic\""),
  variationSettings: NOT_YET, decorationStyle: NOT_YET, decorationColor: NOT_YET, decorationThickness: NOT_YET,
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
  dash: NOT_YET, cap: NOT_YET, join: NOT_YET, miter: NOT_YET, variableWidth: NOT_YET, complex: NOT_YET,
};
const BOX_RULES: Record<keyof Box, Rule> = {
  w: size, h: size,
  x: refuse("the read's page coordinate; place a node with its own `x`/`y`"),
  y: refuse("the read's page coordinate; place a node with its own `x`/`y`"),
};
const RADIUS_RULES: Record<keyof RadiusCorners, Rule> = { tl: nonNeg, tr: nonNeg, br: nonNeg, bl: nonNeg };
const LIMIT_RULES: Record<keyof SizeLimits, Rule> = { minWidth: nonNeg, maxWidth: nonNeg, minHeight: nonNeg, maxHeight: nonNeg };
const FILL_RULES: Readonly<Record<string, Rule>> = {
  type: (v) => (v === "solid" ? null : typeof v === "string" ? "'" + v + "' cannot be written yet (solid can)" : "must be \"solid\""),
  color: hex,
  opacity: unit,
  tokens: refuse("binding a variable comes with design-system references"),
  blend: NOT_YET,
  visible: refuse("an invisible paint is never written; leave it out"),
};
const fillsCheck: Check = (v) => {
  if (!Array.isArray(v)) return "must be a list of paints ({type:\"solid\", color})";
  for (const [i, p] of v.entries()) {
    if (!isObj(p)) return "[" + i + "] must be a paint object";
    const bad = objectProblems(p, FILL_RULES, "")[0];
    if (bad) return "[" + i + "]" + (bad.startsWith(".") ? "" : " ") + bad;
    if (p.color === undefined) return "[" + i + "] is missing color";
  }
  return null;
};
const DS_REF = "design-system references (variables, styles) come in a later write step";

/** Every IrNode field, and whether a tree spec may carry it. `children` and `type` are checked by the walk. */
const NODE_RULES: Record<keyof IrNode, Rule> & { handle: Rule } = {
  type: str, children: (v) => (Array.isArray(v) ? null : "must be a list of nodes"),
  name: str,
  handle: (v) => (typeof v === "string" && v.length > 0 ? null : "must be a non-empty string"),
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
  // Read fields a write does not set (yet). Each is refused by name.
  props: refuse("component instances come with design-system references"),
  propTokens: refuse(DS_REF), component: refuse("component instances come with design-system references"),
  mainComponent: refuse("component instances come with design-system references"),
  propRefs: NOT_YET, overrides: NOT_YET, exposedInstances: NOT_YET, detachedFrom: NOT_YET,
  renderBox: refuse("it is what Figma renders; set `box`"), layoutGrids: NOT_YET, scroll: NOT_YET,
  gridColumnSpan: NOT_YET, gridRowSpan: NOT_YET, gridColumnStart: NOT_YET, gridRowStart: NOT_YET, gridJustifySelf: NOT_YET,
  gridAlignSelf: NOT_YET, pin: NOT_YET, fixedChildren: NOT_YET, strokesInLayout: NOT_YET, effects: NOT_YET,
  radiusFull: refuse("set `radius` to the size it should render at"), rotation: NOT_YET, flipped: NOT_YET, skew: NOT_YET,
  blendMode: NOT_YET, mask: NOT_YET, maskType: NOT_YET, cornerSmoothing: NOT_YET, aspectRatio: NOT_YET, arc: NOT_YET,
  shape: NOT_YET, booleanOp: NOT_YET, exportSettings: NOT_YET, overlay: NOT_YET,
  tokens: refuse(DS_REF), styles: refuse(DS_REF), textTokens: refuse(DS_REF),
  reactions: NOT_YET, variableModes: refuse("set a frame's mode with a setVariableMode op after the tree lands"),
  resolvedModes: refuse("it is read-only (what the frame inherits)"), annotations: NOT_YET, devStatus: NOT_YET,
  devStatusNote: NOT_YET, css: refuse("it is read-only"), pluginData: NOT_YET, sharedData: NOT_YET, motion: NOT_YET,
  asset: refuse("images come in a later write step"), assetSkipped: refuse("it is read-only"), assetFrom: refuse("it is read-only"),
  sourceTransform: refuse("it is read-only"), geometry: NOT_YET, tableCells: NOT_YET, reference: refuse("it is read-only"),
  devResources: NOT_YET, runs: refuse("mixed-format text comes in a later write step; give one `font`"), href: NOT_YET,
  linkNode: NOT_YET, list: NOT_YET, indent: NOT_YET, textStyleOverrides: refuse(DS_REF), missingFont: refuse("it is read-only"),
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

/** The kind a node spec is: its `type`, else TEXT when it has `text`, else FRAME. */
export function nodeKind(n: { type?: unknown; text?: unknown }): "FRAME" | "TEXT" | null {
  if (n.type === undefined) return n.text !== undefined ? "TEXT" : "FRAME";
  return n.type === "FRAME" || n.type === "TEXT" ? n.type : null;
}
const isFlex = (n: Record<string, unknown>): boolean => isObj(n.layout) && n.layout.display === "flex";

/** A text node's font as Figma names it: family + style (`weight`), defaults filled in. */
export function fontOf(font: TreeFont | undefined): { family: string; weight: string } {
  // Only an OMITTED name takes the default; checkTree refuses an empty one (a name is never guessed).
  return { family: font && font.family !== undefined ? font.family : DEFAULT_FONT.family, weight: font && font.weight !== undefined ? font.weight : DEFAULT_FONT.weight };
}

/** The check of a whole spec: every problem (empty when it is valid) and, for a valid one, what it makes. */
export function checkTree(spec: unknown): { problems: string[]; summary: TreeSummary } {
  const problems: string[] = [];
  const summary: TreeSummary = { frames: 0, texts: 0, handles: [], fonts: [], warnings: [] };
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
    if (kind === null) problems.push(path + ".type: '" + String(n.type) + "' cannot be written yet (FRAME and TEXT can)");
    const isRoot = parentFlex === null;
    const flex = isFlex(n);
    const say = (msg: string): void => { problems.push(path + ": " + msg); };
    if (kind === "TEXT") {
      if (typeof n.text !== "string") say("a TEXT node needs `text`");
      for (const k of ["children", "layout", "clip", "radius", "sizeLimits"]) if (n[k] !== undefined) say("`" + k + "` is not on a TEXT node");
    } else if (kind === "FRAME") {
      for (const k of ["text", "font", "autoResize", "truncate", "maxLines"]) if (n[k] !== undefined) say("`" + k + "` is only on a TEXT node (give the node `text`)");
    }
    for (const axis of ["widthMode", "heightMode"] as const) {
      const m = n[axis];
      if (m === "fill" && parentFlex !== true) say("`" + axis + ": \"fill\"` needs a parent with auto-layout" + (isRoot ? " (this is the root)" : ""));
      if (m === "hug" && !flex && kind !== "TEXT") say("`" + axis + ": \"hug\"` needs the node itself to have auto-layout (layout.display \"flex\") or be TEXT");
    }
    if (parentFlex !== true) {
      for (const k of ["absolute", "grow", "alignSelf"]) if (n[k] !== undefined) say("`" + k + "` needs a parent with auto-layout");
    }
    if (n.sizeLimits !== undefined && !flex && parentFlex !== true) say("`sizeLimits` needs auto-layout on the node or its parent");
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
    if (isObj(n.layout) && n.layout.mode === "absolute" && n.layout.display !== undefined) say("`layout` is either `display: \"flex\"` or `mode: \"absolute\"`, not both");
    if (isObj(n.layout) && n.layout.display === undefined && n.layout.mode === undefined) say("`layout` needs `display: \"flex\"` (or `mode: \"absolute\"` for none)");
    if (typeof n.handle === "string" && n.handle) {
      if (seenHandles.has(n.handle)) say("handle '" + n.handle + "' is used twice; a handle names one node");
      seenHandles.add(n.handle);
    }
    if (problems.length === before) {
      if (kind === "TEXT") {
        summary.texts++;
        const f = fontOf(isObj(n.font) ? n.font : undefined);
        const key = f.family + "|" + f.weight;
        if (!seenFonts.has(key)) { seenFonts.add(key); summary.fonts.push(f); }
      } else summary.frames++;
      if (typeof n.handle === "string" && n.handle) summary.handles.push(n.handle);
    }
    if (Array.isArray(n.children)) n.children.forEach((c, i) => walk(c, path + ".children[" + i + "]", depth + 1, flex));
  };
  if (!isObj(spec)) problems.push("tree: must be a node object (the root frame)");
  else {
    walk(spec, "tree", 0, null);
    if (nodeKind(spec) !== "FRAME") problems.push("tree: the root must be a FRAME (a screen); put the text inside one");
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
  const nodes = s.frames + s.texts;
  const where = (page ? "on page '" + page + "'" : "on the current page") +
    (spec.x !== undefined || spec.y !== undefined ? " at " + (spec.x !== undefined ? spec.x : "auto") + "," + (spec.y !== undefined ? spec.y : "auto") : ", placed beside the existing frames");
  const parts = [
    "creates frame '" + (spec.name || "Frame") + "'" + size + al + " with " + nodes + " node" + (nodes === 1 ? "" : "s") +
      " (" + s.frames + " frame" + (s.frames === 1 ? "" : "s") + ", " + s.texts + " text" + (s.texts === 1 ? "" : "s") + ") " + where,
  ];
  if (s.handles.length) parts.push("ids come back for " + quoteList(s.handles));
  if (s.fonts.length) parts.push("fonts " + quoteList(s.fonts.map((f) => f.family + " " + f.weight)));
  return parts.join("; ") + " — the page and fonts are checked against the file when applied, and nothing lands unless all of it does";
}
