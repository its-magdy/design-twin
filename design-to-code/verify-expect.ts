// verify-expect.ts — verify-screen --expect: the design's own numbers, as data. buildExpectation() reads the screen
// export(s) into the <Screen>.expected.json document — one spec row per visible node worth checking, the instances, the
// designed interactions (the export's reactions plus a plan's interactions[]), the design values the method cannot
// compare, the hidden layers, a shared shell's aliases, what an overlay opens, and where the reference PNG sits over the
// first frame. A library: the CLI (file reading, --out, the notes) is verify-screen.ts.
import path from "node:path";
import { sha256Hex } from "../bridge/src/hash.ts";
import { walkWithHidden } from "./hidden.ts";
import { exportContentSha256 } from "./content-hash.ts";
import { planInteractionsSha256 } from "./plan-waivers.ts";
import { pngInfo } from "./png.ts";
import { actionForExpect, isPlanExpect } from "./probe-steps.ts";
import { isJsonObject } from "./types.ts";
import { screenExportOf, screenRoots } from "./export-shape.ts";
import { PAINT_TYPES, idSuffix } from "./probe-match.ts";
import type {
  Action, Box, DrawnState, IndexRow, IrNode, JsonValue, LayoutSpec, NotComparable, Paint, Plan, Reaction, ScreenDoc, SolidPaint, VerifyExpectation,
  VerifyInstance, VerifyInteraction, VerifyFrame, VerifyReferenceImage, VerifyReferenceUnusable, VerifyRootFrame, VerifySpec,
} from "./types.ts";
import { ifDefined } from "../bridge/src/json-util.ts";
import { getOrInit } from "./map-util.ts";
import { EXPORT_DIR } from "../bridge/src/project-layout.ts";
import { EXPECTATION_SCHEMA, MEASURED_KEYS_DOC, PAD_SIDES, TEXT_BOX_HEIGHT, TOLERANCE, lineHeightPx, normColor, normWeight, num, r2, resolveInside } from "./verify-shared.ts";
import type { PadSide } from "./verify-shared.ts";

// ---------------------------------------------------------------- the expectation
//
// One row per node worth checking, carrying ONLY values the export actually states. A field the
// export does not define is OMITTED, never defaulted — a spec that invents `fontWeight: 400` because
// the node didn't say produces exactly the confident-and-wrong comparison this file exists to stop.
//
// Only layers that RENDER get a row. The rule is hidden.ts's one predicate (`hidden: true` on the
// node or any ancestor — never `visible === false`, which the export does not use). Without it, a real
// pull had 83 of 272 specs, 61 of 112 instances and 22 of 28 designed interactions for layers the
// designer switched off, and a build that correctly omitted them was graded on them.

const firstSolid = (fills: Paint[] | null | undefined): SolidPaint | undefined => (fills || []).find((f): f is SolidPaint => !!f && f.type === "solid" && f.visible !== false);

// A layer drawn IN an interaction state. The designer drew one table row hovered (its fill is bound
// to `Backgrounds/Row Hover`, and only that row carries the hover-only edit button); measuring the
// build at rest and calling #121319-vs-#46464f a high-severity colour bug was 1 of 4 false highs on
// BOTH screens. The export says which state it drew, through the fill's
// token name or a variant property, so the spec carries it and the probe measures that state.
const STATE_WORD = /(?:^|[^a-z])(hover(?:ed)?|pressed|focus(?:ed)?)(?:[^a-z]|$)/i;
const normState = (w: string): DrawnState => (/^hover/i.test(w) ? "hover" : /^press/i.test(w) ? "pressed" : "focus");
interface DrawnStateOf { state: DrawnState; why: string }
function drawnStateOf(n: IrNode): DrawnStateOf | null {
  const fillTok = (n.tokens && typeof n.tokens.fills === "string" && n.tokens.fills) ||
    (Array.isArray(n.fills) && n.fills.map((f) => f && f.tokens && f.tokens.color).find((t): t is string => typeof t === "string")) || null;
  const word = fillTok ? STATE_WORD.exec(fillTok)?.[1] : undefined; // the group is not optional: set whenever the regex matched
  if (word !== undefined) return { state: normState(word), why: `its fill is bound to '${fillTok}'` };
  for (const [k, v] of Object.entries(n.props || {})) {
    if (typeof v === "string" && /^\s*(hover(?:ed)?|pressed|focus(?:ed)?)\s*$/i.test(v)) return { state: normState(v.trim()), why: `variant ${k}=${v}` };
  }
  // `component` is the variant name, e.g. "Type=Primary, Status=Hover".
  for (const pair of String(n.component || "").split(",")) {
    const [k, v] = pair.split("=").map((s) => s && s.trim());
    if (k && v && /^(hover(?:ed)?|pressed|focus(?:ed)?)$/i.test(v)) return { state: normState(v), why: `variant ${k}=${v}` };
  }
  return null;
}

// An inline SVG's colour is its `fill`, not a CSS background. Comparing a vector's fills against
// `background-color` produced the other recurring false high (the moon glyph, the Union icon).
const isPaintNode = (n: IrNode): boolean => PAINT_TYPES.has(n.type) || (typeof n.asset === "string" && /\.svg$/i.test(n.asset));

// A text layer that IS an input's placeholder. Its colour lives on `::placeholder`, which
// getComputedStyle(el) cannot see, and an empty <input> has no textContent — so comparing it as
// ordinary text/colour would be two guaranteed high deltas per placeholder.
function isPlaceholder(n: IrNode): boolean {
  if (n.type !== "TEXT") return false;
  const toks = [n.tokens && n.tokens.fills, ...(Array.isArray(n.fills) ? n.fills.map((f) => f && f.tokens && f.tokens.color) : [])];
  return toks.some((t) => typeof t === "string" && /placeholder/i.test(t)) || /placeholder/i.test(n.name || "");
}

// Position, FRAME-RELATIVE. The export's `box.x/y` are page-space and only present where the parent
// does not auto-position the node (absolute children, non-auto-layout parents); `renderBox` is the
// render bounds (for TEXT: the glyph ink). Subtracting the frame's own `box.x/y` gives the same
// coordinates a probe gets from `el.getBoundingClientRect()` minus the frame element's rect. Without a position
// check, a pagination bar 130px below the frame and an 18.94px column drift score zero deltas.
interface FramePos { x: number; y?: number; source: "box" | "renderBox" }
function framePosition(n: IrNode, frame: Partial<VerifyFrame> | null | undefined): FramePos | null {
  if (!frame || !num(frame.x) || !num(frame.y)) return null;
  const b: Partial<Box> = n.box || {}, rb = n.renderBox;
  if (n.type === "TEXT") {
    // A Range's getBoundingClientRect().x is the text's LAYOUT start (side bearings included, not ink). For hug
    // text and left-aligned text that is the text box's own left edge (box.x, when the export states it); for
    // centred/right-aligned text in a wider box only the ink start (renderBox.x) is near it, within a side-bearing.
    // Vertical ink depends on font metrics, so a TEXT node carries no `y`.
    const align = n.font && n.font.align;
    if (num(b.x) && (n.autoResize === "width_and_height" || align === undefined || align === "left")) return { x: r2(b.x - frame.x), source: "box" };
    if (rb && num(rb.x)) return { x: r2(rb.x - frame.x), source: "renderBox" };
    if (num(b.x)) return { x: r2(b.x - frame.x), source: "box" };
    return null;
  }
  if (num(b.x) && num(b.y)) return { x: r2(b.x - frame.x), y: r2(b.y - frame.y), source: "box" };
  // renderBox includes stroke/shadow/blur overflow; it is the layout box only when the sizes agree.
  if (rb && num(rb.x) && num(rb.y) && num(b.w) && num(b.h) && Math.abs(rb.w - b.w) <= 0.5 && Math.abs(rb.h - b.h) <= 0.5) {
    return { x: r2(rb.x - frame.x), y: r2(rb.y - frame.y), source: "renderBox" };
  }
  return null;
}

// Children that take part in the parent's flow: visible and not absolutely positioned.
const inFlowChildren = (n: IrNode): IrNode[] => (Array.isArray(n.children) ? n.children : []).filter((c) => c && !c.hidden && !c.absolute);
// `grow` is a number in the producer; `=== true` is an older export's spelling, still read.
interface LegacyGrow { grow?: number | boolean; heightMode?: IrNode["heightMode"]; widthMode?: IrNode["widthMode"] }
const growsAlong = (c: IrNode, dir: string): boolean => { const lc: LegacyGrow = c; return lc.grow === 1 || lc.grow === true || (dir === "column" ? lc.heightMode === "fill" : lc.widthMode === "fill"); };

// the older layout spelling (itemSpacing, paddingTop/Right/Bottom/Left) is still read beside the producer's gap/padding[].
interface LegacyLayout extends LayoutSpec { itemSpacing?: number; paddingTop?: number; paddingRight?: number; paddingBottom?: number; paddingLeft?: number }
const PAD_KEYS = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"] as const;

// per FIXED axis (no widthMode/heightMode for it), padding the design cannot show: padding + in-flow content
// (sum + gaps on the main axis — the largest child when the list wraps — the largest child on the counter axis, or
// for a wrapping list the stacked lines, see wrapLines) larger than the box (+1) skips the side the overflow runs out
// at (the end for start alignment, the start for end alignment, both when centred); or content CENTRED on that axis
// with equal padding and no child growing along it (the padding moves nothing) — never on a wrapping list's main
// axis, where the padding sets the wrap point and so shows. Flex only (a grid's tracks are not modelled). Known
// miss: padding split across nested nodes is still compared node by node.
// The counter-axis extent of a WRAPPING list's stacked lines (Figma layoutWrap "WRAP"; the export writes
// layout.flexWrap "wrap" and counterAxisSpacing as layout.rowGap whatever the direction). Figma Plugin API
// (counterAxisAlignContent): each track is sized by its largest child along the counter axis; under "AUTO"
// counterAxisSpacing is the gap between tracks, under "SPACE_BETWEEN" the free space is split between tracks and
// the spacing is zero once the tracks overflow (the producer then omits rowGap, so the gap reads as 0 — the
// least the tracks need, which is what an overfull check wants). Children are packed greedily along the main axis
// within the inner main size (the box's main size minus its main-axis padding, `gap` between items). Returns
// undefined when a size is unknown — the caller then falls back to the largest child.
function wrapLines(mainSizes: ReadonlyArray<number | undefined>, crossSizes: ReadonlyArray<number | undefined>, inner: number, gap: number, crossGap: number): number | undefined {
  if (!num(inner) || !mainSizes.every(num) || !crossSizes.every(num)) return undefined;
  const lines: number[] = [];
  let used = -1;
  mainSizes.forEach((w, i) => {
    const h = crossSizes[i] ?? 0;
    if (used >= 0 && used + gap + w <= inner + 1) { used += gap + w; lines[lines.length - 1] = Math.max(lines[lines.length - 1] ?? 0, h); }
    else { used = w; lines.push(h); }
  });
  return lines.reduce((s, v) => s + v, 0) + crossGap * Math.max(0, lines.length - 1);
}

function paddingNotShown(n: IrNode, L: LegacyLayout, pad: readonly number[]): Array<{ sides: PadSide[]; why: string }> {
  const b = n.box;
  if (!b || L.display === "grid" || L.mode === "absolute") return [];
  const dir = L.flexDirection === "column" ? "column" : "row";
  const flow = inFlowChildren(n);
  const spaced = L.justifyContent === "space-between" || L.justifyContent === "space-evenly" || L.justifyContent === "space-around";
  const g = !spaced && typeof L.gap === "number" ? L.gap : typeof L.itemSpacing === "number" && !spaced ? L.itemSpacing : 0;
  const out: Array<{ sides: PadSide[]; why: string }> = [];
  for (const ax of ["x", "y"] as const) {
    if (ax === "x" ? n.widthMode : n.heightMode) continue; // hug/fill: the box follows the content, padding shows
    const size = ax === "x" ? b.w : b.h;
    const [i0, i1] = ax === "x" ? [3, 1] : [0, 2];
    const a = pad[i0] ?? 0, z = pad[i1] ?? 0;
    if (!num(size) || (a === 0 && z === 0)) continue;
    const sides: PadSide[] = ax === "x" ? ["left", "right"] : ["top", "bottom"];
    const main = (dir === "row") === (ax === "x");
    const dim = ax === "x" ? "width" : "height";
    const sizes = flow.map((c) => (c.box ? (ax === "x" ? c.box.w : c.box.h) : undefined));
    const wraps = L.flexWrap === "wrap";
    if (flow.length && sizes.every(num)) {
      // A WRAPPING list's main-axis padding sets the wrap point and shows: only its largest child can overflow.
      // Its counter axis holds the stacked lines (wrapLines) when the main size is known; else the largest child.
      let content: number;
      if (main && !wraps) content = sizes.reduce((s, v) => s + v, 0) + g * Math.max(0, flow.length - 1);
      else if (!main && wraps) {
        const mainSize = ax === "x" ? b.h : b.w;
        const [m0, m1] = ax === "x" ? [0, 2] : [3, 1];
        const mainSizes = flow.map((c) => (c.box ? (ax === "x" ? c.box.h : c.box.w) : undefined));
        content = wrapLines(mainSizes, sizes, mainSize - (pad[m0] ?? 0) - (pad[m1] ?? 0), g, typeof L.rowGap === "number" ? L.rowGap : 0) ?? Math.max(...sizes);
      } else content = Math.max(...sizes);
      if (a + z + content > size + 1) {
        // Figma still insets the first child by the START padding of a start-aligned box whose content
        // overflows (the overflow runs out at the end) — only the end side cannot show; mirrored for end alignment;
        // both only when the content is centred (space-around/space-evenly centre under negative free space in CSS
        // flexbox; space-between starts at the start).
        const al0 = main ? L.justifyContent : L.alignItems;
        const al = al0 === "space-around" || al0 === "space-evenly" ? "center" : al0;
        const lost: PadSide[] = al === "center" ? sides : al === "flex-end" ? [sides[0] ?? "left"] : [sides[1] ?? "right"];
        const shown = lost.filter((sd) => (pad[PAD_SIDES.indexOf(sd)] ?? 0) !== 0);
        if (shown.length) out.push({ sides: shown, why: `padding ${a}+${z} plus its content (${r2(content)}px) exceeds the fixed ${size}px ${dim}, and the content is ${al === "center" ? "centred" : al === "flex-end" ? "end-aligned" : "start-aligned"} — the design cannot show the ${shown.join("/")} padding, so the build need not have it` });
        continue;
      }
    }
    // (a wrapping list whose lines are spread by alignContent space-between puts its first and last line against the
    // padding, so that padding shows even with centred items)
    const centred = main ? L.justifyContent === "center" : L.alignItems === "center" && !(wraps && L.alignContent === "space-between");
    const grows = flow.some((c) => (main ? growsAlong(c, dir) : (ax === "x" ? c.widthMode === "fill" : c.heightMode === "fill") || c.alignSelf === "stretch"));
    if (flow.length && centred && a === z && !grows && !(main && wraps)) out.push({ sides, why: `content centred in a fixed ${size}px ${dim} with equal padding (${a}) — the padding moves nothing, so the build need not have it` });
  }
  return out;
}

const lineBoxWhy = (lh: number, h: number): string =>
  `the line box (${r2(lh)}px) is taller than the fixed text box (${r2(h)}px): Figma lets the line overflow the box — the build chooses: line-height ${r2(lh)} (the text overflows its box, as in Figma) or ${r2(h)} (the glyphs sit about ${r2((lh - h) / 2)}px higher); the TEXT height is not compared`;

/** The drawn state a node inherits from an ancestor that was drawn in one. `from` = the owner's name (for the why),
 *  `fromId` = its id (the probe hovers the OWNER, not this node — spec.drawnStateFrom). */
export interface InheritedState { state: DrawnState; why: string; from: string; fromId: string }
/** expectNode()'s context: the node's path, its frame (for positions), and any inherited drawn state. */
export interface ExpectContext { path?: string; frame?: Partial<VerifyFrame> | null; inheritedState?: InheritedState; frameId?: string }
/**
 * The spec row for one VISIBLE node, plus any design values the method cannot compare
 * (`notComparable`, each with a reason). `ctx` = { path, frame, inheritedState }.
 */
function expectNode(n: IrNode, ctx: ExpectContext = {}): { spec: VerifySpec; notComparable: NotComparable[] } {
  const spec: VerifySpec = { nodeId: n.id, name: n.name, type: n.type, ...ifDefined("path", ctx.path) };
  const notComparable: NotComparable[] = [];
  const skip = (field: string, value: JsonValue, why: string): number => notComparable.push({ nodeId: n.id, name: n.name, field, value, why });

  // `text` is where the producer writes a TEXT node's content (text.ts); the export never carries `characters`.
  if (n.text != null) spec.text = n.text;
  // Figma stores the typed string and applies the text case at render time (font.case) — `text` stays the
  // stored string, `textCase` says how it renders; --compare judges the RENDERED strings (renderedText). Small caps are
  // a font variant (smaller capitals), not different characters: not compared.
  const fcase = n.font ? n.font.case : undefined;
  if (n.text != null && (fcase === "upper" || fcase === "lower" || fcase === "title")) spec.textCase = fcase;
  else if (n.text != null && (fcase === "small_caps" || fcase === "small_caps_forced")) skip("text case", fcase, "small caps (font-variant) not compared — Figma draws the stored characters as small capitals; the build's font-variant is not measured");

  if (n.font) {
    if (n.font.family !== undefined) spec.fontFamily = n.font.family;
    if (typeof n.font.size === "number") spec.fontSize = n.font.size;
    const w = normWeight(n.font.weight);
    if (w != null) spec.fontWeight = w;
    const lh = lineHeightPx(n.font.lineHeight, n.font.size);
    if (lh != null) spec.lineHeight = lh;
    const ls: { value?: number; unit?: string } | undefined = n.font.letterSpacing;
    // Figma's percent letter-spacing is a share of the font size; the producer writes "percent" (an older
    // export "PERCENT") — read as px, -2% on 20px text would be expected as -2px, not -0.4px.
    if (ls && typeof ls.value === "number") {
      if (String(ls.unit).toLowerCase() !== "percent") spec.letterSpacing = ls.value;
      else if (typeof n.font.size === "number") spec.letterSpacing = r2((ls.value / 100) * n.font.size);
    }
    if (n.font.color) spec.color = normColor(n.font.color);
  }
  const fill = firstSolid(Array.isArray(n.fills) ? n.fills : null);
  // A TEXT node's fill is its TEXT colour, not a background — conflating the two is how a chip with a
  // missing background still looked "bound".
  if (fill && n.type !== "TEXT") {
    if (isPaintNode(n)) spec.fill = normColor(fill.color);
    else spec.backgroundColor = normColor(fill.color);
  }
  if (fill && n.type === "TEXT" && !spec.color) spec.color = normColor(fill.color);
  // Paint this method does not compare (a shadow, a blur, a gradient or image fill) is still paint: such a
  // wrapper is drawn, so a plan may never fold it away.
  const paints = Array.isArray(n.fills) ? n.fills : [];
  if ((Array.isArray(n.effects) && n.effects.length > 0) || paints.some((p) => p && p.type !== "solid" && p.visible !== false)) spec.decorated = true;

  if (isPlaceholder(n)) {
    spec.placeholder = true;
    if (spec.text !== undefined) { spec.placeholderText = spec.text; delete spec.text; }
    if (spec.color !== undefined) { spec.placeholderColor = spec.color; delete spec.color; }
  }

  // `strokes` is an OBJECT, not an array of paints: `{colors:[…], weight | weights:{top,right,
  // bottom,left}, align, dash, …}` (figma-plugin/src/paint.ts simplifyStrokes). Treating it as an
  // array is how this blew up on the first real export it saw.
  const st = n.strokes;
  if (st && typeof st === "object" && Array.isArray(st.colors) && st.colors.length) {
    spec.borderColor = normColor(st.colors[0]);
    if (typeof st.weight === "number") spec.borderWidth = st.weight;
    // Per-side weights (a divider with only a bottom border) have no single CSS `border-width` to
    // compare against, so record them as their own field rather than picking one arbitrarily.
    else if (st.weights && typeof st.weights === "object") { const ws = st.weights; spec.borderWidths = (["top", "right", "bottom", "left"] as const).map((k) => { const v = ws[k]; return typeof v === "number" ? v : 0; }); }
    if (st.align) spec.strokeAlign = st.align; // (after the weight/weights chain)
  }
  // Radius: one number, or per-corner. A per-corner radius with UNEQUAL corners (a table header
  // rounded only at the top) is compared corner by corner — reading `radius.tl` only would give
  // a card rounded at the bottom ({bl,br}) no radius spec at all.
  // a radius shows only where something draws the corners — a visible fill or stroke, an effect, or a clip of
  // the content. On a layer that draws none of them it is invisible in Figma too, and a build need not carry it.
  const drawsBox = paints.some((p) => p && p.visible !== false) || !!(st && ((Array.isArray(st.colors) && st.colors.length > 0) || (Array.isArray(st.paints) && st.paints.some((p) => p && p.visible !== false))))
    || (Array.isArray(n.effects) && n.effects.length > 0) || n.clip === true;
  if (n.radius !== undefined && n.radius !== null && !drawsBox && n.type !== "TEXT") {
    const r = n.radius;
    const rv: JsonValue = typeof r === "number" ? r : { ...ifDefined("tl", r.tl), ...ifDefined("tr", r.tr), ...ifDefined("br", r.br), ...ifDefined("bl", r.bl) };
    if (typeof r !== "number" || r !== 0) skip("border-radius", rv, "radius on a layer that draws nothing (no visible fill, stroke or effect, and it does not clip its content) — its corners are invisible in the design too");
  } else if (typeof n.radius === "number") spec.borderRadius = n.radius;
  else if (n.radius && typeof n.radius === "object") {
    const rc = n.radius;
    const corner = (v: unknown): number => (num(v) ? v : 0);
    const c = { tl: corner(rc.tl), tr: corner(rc.tr), br: corner(rc.br), bl: corner(rc.bl) };
    if (c.tr === c.tl && c.br === c.tl && c.bl === c.tl) spec.borderRadius = c.tl;
    else spec.radiusCorners = c;
  }

  const L: LegacyLayout | undefined = n.layout;
  // an asset/geometry/assetSkipped leaf is one exported image — whatever padding/gap an older export inferred for it is
  // the inset already baked into the file (current exports carry no `layout` on such a leaf). Never compared.
  if (L && typeof L === "object" && (n.asset || n.geometry || n.assetSkipped)) {
    const BAKED = "inset baked into the exported asset";
    const g = typeof L.gap === "number" ? L.gap : typeof L.itemSpacing === "number" ? L.itemSpacing : undefined;
    if (g !== undefined) skip("gap", g, BAKED);
    const pad = Array.isArray(L.padding) ? L.padding.slice(0, 4) : PAD_KEYS.some((k) => typeof L[k] === "number") ? PAD_KEYS.map((k) => L[k]) : null;
    if (pad && pad.some((v) => typeof v === "number" && v !== 0)) skip("padding", pad.map((v) => (typeof v === "number" ? v : 0)), BAKED);
  } else if (L && typeof L === "object") {
    const g = typeof L.gap === "number" ? L.gap : typeof L.itemSpacing === "number" ? L.itemSpacing : undefined;
    if (g !== undefined) {
      // A stored gap is only a GAP when it separates laid-out children. Three shapes where it is not
      // (real pulls showed `gap 200 → 16`, `gap 146`, `gap 160` that were all Figma auto-layout slack):
      const dir = L.flexDirection === "column" ? "column" : "row";
      const flow = inFlowChildren(n);
      if (flow.length < 2) skip("gap", g, `fewer than two laid-out children (${flow.length}) — a gap has nothing to separate`);
      // primaryAxisAlignItems distribution modes (SPACE_BETWEEN/SPACE_EVENLY/SPACE_AROUND) all space
      // children by dividing the frame's free space along the primary axis, ignoring itemSpacing
      // (Figma Help Center, "Guide to auto layout", article 31289464393751: gap can be a number or
      // "Auto — choose from Between, Around, and Evenly auto spacing options", which "match CSS
      // property values space-between, space-evenly and space-around respectively") — so the stored
      // value is slack for all three, not just space-between.
      else if (L.justifyContent === "space-between" || L.justifyContent === "space-evenly" || L.justifyContent === "space-around") skip("gap", g, `${L.justifyContent}: Figma ignores item spacing here, so the stored value is slack, not a gap`);
      else if (flow.some((c) => growsAlong(c, dir))) skip("gap", g, "a child fills the main axis, so the stored gap and that child's size trade off — placement is checked through the children's positions and sizes instead");
      else spec.gap = g;
    }
    let pad: Array<number | undefined> | null = null;
    if (Array.isArray(L.padding)) pad = L.padding.slice(0, 4);
    else if (PAD_KEYS.some((k) => typeof L[k] === "number")) pad = PAD_KEYS.map((k) => L[k]);
    if (pad && pad.some((v) => typeof v === "number" && v !== 0)) {
      const p4 = pad.map((v) => (typeof v === "number" ? v : 0));
      // padding that cannot show on a FIXED axis is not compared there (paddingSkip + a notComparable row per axis)
      const skipped: NonNullable<VerifySpec["paddingSkip"]> = [];
      for (const ax of paddingNotShown(n, L, p4)) {
        skipped.push(...ax.sides);
        skip(`padding (${ax.sides.join("/")})`, ax.sides.map((sd) => p4[PAD_SIDES.indexOf(sd)] ?? 0), ax.why);
      }
      if (skipped.length < 4) spec.padding = p4;
      if (skipped.length && skipped.length < 4) spec.paddingSkip = skipped;
    }
  }
  if (n.box) {
    if (n.type === "TEXT") {
      // a TEXT's width. Hug text (autoResize width_and_height) IS its box — compared with
      // the Range width, tolerance 1. Any other text box (fixed or fill width, height-auto) is wider than its words:
      // the build's element hugs the text, so the design's INK width (renderBox.w) is compared, tolerance textInk.
      // Truncation set (ellipsis / line clamp): a Range spans the full unclipped string (text-overflow keeps it), so a
      // text the DESIGN truncates has no comparable width — but one whose ink ends well inside its box (a "12" in a
      // 121px cell set to truncate) is not truncated, and its ink is its full width. Several lines: not compared.
      // No height: neither a Range nor the element gives the line box Figma's text box has (see LIMITS).
      // A placeholder's characters are not in the DOM (the input's placeholder attribute): no Range measures them.
      const rb = n.renderBox;
      const lines = typeof n.maxLines === "number" ? n.maxLines : 0;
      const truncSet = n.autoResize === "truncate" || n.truncate === true || lines > 0;
      const truncated = truncSet && (lines > 1 || !rb || !num(rb.w) || rb.w >= n.box.w - TOLERANCE.textInk);
      const shadowed = Array.isArray(n.effects) && n.effects.length > 0;
      if (isPlaceholder(n)) skip("width", n.box.w, "an input placeholder: its characters are not in the DOM (the placeholder attribute), so no Range measures their width");
      else if (truncated) skip("width", n.box.w, "truncated text (ellipsis / line clamp) the design truncates or wraps: a Range over it measures the full unclipped string, not the box");
      else if (n.autoResize === "width_and_height") spec.width = n.box.w;
      else if (shadowed) skip("width", n.box.w, "text with an effect (shadow/blur): its render bounds include the effect, so neither box nor ink width is the text's");
      else if (rb && num(rb.w)) {
        spec.width = rb.w;
        spec.widthFrom = "renderBox";
        skip("width (text box)", n.box.w, `fixed-width text box (${n.widthMode === "fill" ? "fills its parent" : "set by the designer"}) wider than its words — the build's text hugs them, so the ink width (renderBox) is compared instead`);
      } else spec.width = n.box.w;
      // a FIXED-height text box shorter than its line box (a 28px line in a 24px box). Figma lets the line
      // overflow the box; CSS has no such box, so the build picks one — say so instead of letting a later height or
      // line-height delta read as a bug. Where Figma puts the glyphs inside the overflowing line is unverified.
      const lh = spec.lineHeight;
      if (num(lh) && num(n.box.h) && lh > n.box.h + 0.5 && n.autoResize !== "width_and_height" && n.autoResize !== "height") {
        skip(TEXT_BOX_HEIGHT, n.box.h, lineBoxWhy(lh, n.box.h));
      }
    } else {
      if (typeof n.box.w === "number") spec.width = n.box.w;
      if (typeof n.box.h === "number") spec.height = n.box.h;
      // a hug axis may GROW in the build (more content) without the match being wrong
      if (n.widthMode || n.heightMode) spec.sizing = { ...ifDefined("w", n.widthMode), ...ifDefined("h", n.heightMode) };
    }
  }
  const pos = isPlaceholder(n) ? null : framePosition(n, ctx.frame); // (a placeholder: no Range, see width)
  if (pos) {
    spec.x = pos.x;
    if (pos.y !== undefined) spec.y = pos.y;
    spec.positionFrom = pos.source;
  }
  if (typeof n.opacity === "number" && n.opacity !== 1) spec.opacity = n.opacity;
  // the exporter omits opacity 1 — a node that paints or carries copy states it anyway, so a control
  // rendered at opacity 0.5 is a delta instead of passing unchecked
  else if (spec.text !== undefined || spec.placeholderText !== undefined || spec.color !== undefined || spec.backgroundColor !== undefined || spec.fill !== undefined || spec.borderColor !== undefined || spec.decorated) spec.opacity = 1;

  const own = drawnStateOf(n);
  if (own) { spec.drawnState = own.state; spec.drawnStateWhy = own.why; spec.drawnStateOwn = true; }
  else if (ctx.inheritedState) {
    spec.drawnState = ctx.inheritedState.state; spec.drawnStateWhy = `inside '${ctx.inheritedState.from}', which ${ctx.inheritedState.why}`;
    spec.drawnStateFrom = ctx.inheritedState.fromId; // the owner the probe puts in that state
  }

  // The token NAME, carried through for the report. A mismatch whose spec value is bound to a token is
  // a token bug, not a number bug, and that distinction is what tells a reader where to look.
  if (n.tokens && Object.keys(n.tokens).length) spec.tokens = n.tokens;
  if (ctx.frameId) spec.frameId = ctx.frameId;
  return { spec, notComparable };
}

// Which nodes are worth a row. Everything visible that CARRIES a checkable value — a node with no
// font, no fill, no radius, no layout and no stated position has nothing to be wrong about, and listing
// it would bury the rows that matter. A stated position counts: the pagination bar that rendered 130px
// below the frame carries nothing else.
function checkable(spec: VerifySpec): boolean {
  return (["text", "placeholderText", "fontSize", "color", "backgroundColor", "fill", "borderRadius", "radiusCorners", "gap", "padding", "borderColor", "x"] as const).some((k) => spec[k] !== undefined);
}

const COORDINATES =
  "x/y are FRAME-RELATIVE: the node's page-space position minus the frame's own box.x/box.y. Measure " +
  "el.getBoundingClientRect() minus the rendered frame element's rect (the viewport origin when the frame " +
  "IS the page). A TEXT node's x and width are read ONLY from textBox {x,w} — a Range over its characters, " +
  "never the element's box. Its width is the text box for hug text (autoResize width_and_height) and the INK " +
  "width (the export's renderBox, widthFrom renderBox) for fixed- or fill-width text, whose box is wider than its " +
  "words; its x is the box's left edge for hug or left-aligned text, else the ink start. TEXT nodes carry no y " +
  "and no height (vertical ink and line boxes depend on font metrics). " +
  "Auto-layout children carry no position (the export does not state one); their parent's is compared.";

// The export's reaction shape is reactions[].actions[] with `trigger` a plain lowercase string
// (figma-plugin/src/prototype.ts). A reaction with no trigger is read as a click.
/** The actions of one reaction that name something to do (an action type or a navigation). */
const actionsOf = (r: Reaction): Action[] => (Array.isArray(r.actions) ? r.actions : []).filter((a) => a && (a.type || a.navigation));
/** The reaction's trigger, lowercased; `on_click` when it names none. */
const triggerOf = (r: Reaction): string => String(r.trigger || "on_click").toLowerCase();

/** What buildExpectation() returns: every field present (frame's own fields still depend on the export having a root). */
export interface BuiltExpectation extends VerifyExpectation {
  exportContentSha256: string;
  counts: NonNullable<VerifyExpectation["counts"]>;
  nodes: VerifySpec[];
  instances: VerifyInstance[];
  interactions: VerifyInteraction[];
  notComparable: NotComparable[];
  hidden: NonNullable<VerifyExpectation["hidden"]>;
}
/** One screen export handed to buildExpectation(): the parsed document and the label it is known by. */
export interface ExpectInput { doc: ScreenDoc | undefined; label?: string }
/** buildExpectation()'s context beyond the screens: the export's pages/index.json layers, to tell an
 *  interaction whose destination was never exported. A row's file is its own sourceFile stamp only. */
export interface ExpectOptions { index?: { layers: IndexRow[] } | null;
  /** reads a sibling screen export by its index row's `file` (relative to the export root) — aliases are built
   *  from the siblings of the SAME Figma file (the candidate rows); absent = no aliases */
  readSibling?: ((file: string) => ScreenDoc | null | undefined) | null;
  /** the plan for this screen — its interactions[] rows are merged (source "plan") when valid, the rest dropped
   *  with why; recorded as expectation.planInteractions (only when the plan has an interactions list) */
  plan?: { file: string; plan: Plan } | null;
  /** reads the reference PNG by its export pointer (`assets/<file>`, relative to design/export/); null = not on
   *  disk. Absent = no expectation.referenceImage is written (an in-memory caller with no export on disk). */
  readReference?: ((pointer: string) => Uint8Array | null) | null;
  /** design/export/design-system.json's `colorProfile` stamp (bridge doc-types DesignSystemStamp), when read */
  colorProfile?: string | null }

// the OUTERMOST instances (no INSTANCE ancestor) of a screen's visible tree, by main component key, each indexed
// by the visible NAME PATH from the instance root ("" = the root itself) → node id. A path that repeats inside the
// instance maps to null (ambiguous). Hidden layers are skipped (hidden.ts: the flag is inherited).
// Each path also carries a CONTENT signature, and an alias needs both to agree (seen in a live run): a selected
// item moved between wrapper frames per screen, so one name path was unique in each export yet named "Orders" in
// one and "Invoices" in the other. The signature is the subtree's visible TEXT (concatenated in tree order,
// whitespace normalised); a subtree with no text uses the node types + main component key/set along the path.
interface ShellEntry { id: string; sig: string }
type ShellIndex = Map<string, Array<Map<string, ShellEntry | null>>>;
function shellIndex(roots: readonly IrNode[]): ShellIndex {
  const out: ShellIndex = new Map();
  const index = (inst: IrNode): Map<string, ShellEntry | null> => {
    const m = new Map<string, ShellEntry | null>();
    const textOf = new Map<IrNode, string>();
    const noText: Array<{ p: string; anc: IrNode[] }> = [];
    // returns the subtree's visible text pieces
    const go = (n: IrNode, p: string, chain: string, anc: IrNode[]): string[] => {
      if (n.hidden) return [];
      const mc = n.type === "INSTANCE" ? n.mainComponent : undefined;
      const here = `${chain}/${n.type}${mc ? `[${mc.key ?? ""}|${mc.setName ?? mc.name}]` : ""}`;
      const texts: string[] = n.type === "TEXT" && typeof n.text === "string" ? [n.text] : [];
      for (const c of Array.isArray(n.children) ? n.children : []) if (c) texts.push(...go(c, p === "" && n === inst ? c.name : `${p}\u0000${c.name}`, here, [n, ...anc]));
      const text = texts.join(" ").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
      textOf.set(n, text);
      if (n.id) {
        m.set(p, m.has(p) ? null : { id: n.id, sig: text ? `text:${text}` : `shape:${here}` });
        if (!text) noText.push({ p, anc });
      }
      return texts;
    };
    go(inst, "", "", []);
    // a node with no text of its own (a close icon) is also placed by its nearest ancestor (within the
    // instance) that HAS text — "x" in an "Add Item" popup is not the "x" of an "Edit Category" one
    for (const { p, anc } of noText) {
      const e = m.get(p);
      const owner = anc.find((a) => (textOf.get(a) ?? "") !== "");
      if (e && owner) e.sig += `|in:${textOf.get(owner) ?? ""}`;
    }
    return m;
  };
  const walk = (n: IrNode): void => {
    if (n.hidden) return;
    const key = n.type === "INSTANCE" && n.mainComponent ? n.mainComponent.key : undefined;
    if (key) { getOrInit(out, key, () => []).push(index(n)); return; } // outermost: nothing below is
    for (const c of Array.isArray(n.children) ? n.children : []) if (c) walk(c);
  };
  for (const r of roots) walk(r);
  return out;
}

// the shape a sibling row is recognised by — the same component, or the same tree of node types.
function rowSignature(n: IrNode): string {
  const mc = n.type === "INSTANCE" ? n.mainComponent : undefined;
  if (mc) return `I:${mc.setKey || mc.key || mc.setName || mc.name || ""}`;
  return `${n.type}(${(Array.isArray(n.children) ? n.children : []).filter((c) => c && !c.hidden).map(rowSignature).join(",")})`;
}
// under every parent, >=3 visible children with one signature are sibling ROWS; a TEXT at the same
// relative path (child indices) in >=3 of them with the IDENTICAL string is the designer's repeated placeholder
// copy ("14 Feb, 2026" in every row), not a claim about each row's data. Each such cluster is one group.
function markRepeatedText(root: IrNode, specById: Map<string, VerifySpec>): void {
  const visibleKids = (n: IrNode): IrNode[] => (Array.isArray(n.children) ? n.children : []).filter((c) => c && !c.hidden);
  const texts = (n: IrNode, rel: string, out: Map<string, Array<{ id: string; text: string }>>): void => {
    if (n.type === "TEXT" && typeof n.text === "string" && n.id) getOrInit(out, rel, () => []).push({ id: n.id, text: n.text.trim() });
    visibleKids(n).forEach((c, i) => texts(c, rel ? `${rel}/${i}` : String(i), out));
  };
  (function go(p: IrNode): void {
    if (p.hidden) return;
    const kids = visibleKids(p);
    const bySig = new Map<string, IrNode[]>();
    for (const k of kids) getOrInit(bySig, rowSignature(k), () => []).push(k);
    for (const rows of bySig.values()) {
      if (rows.length < 3) continue;
      const slots = new Map<string, Array<{ id: string; text: string }>>();
      for (const r of rows) texts(r, "", slots);
      for (const [rel, list] of slots) {
        const byText = new Map<string, string[]>();
        for (const e of list) if (e.text) getOrInit(byText, e.text, () => []).push(e.id);
        let k = 0;
        for (const ids of byText.values()) {
          if (ids.length < 3) continue;
          const group = `${p.id}>${rel || "."}#${k++}`;
          for (const id of ids) {
            const spec = specById.get(id);
            if (spec && spec.type === "TEXT" && spec.text !== undefined && !spec.repeatedText) { spec.repeatedText = true; spec.repeatedTextGroup = group; }
          }
        }
      }
    }
    for (const k of kids) go(k);
  })(root);
}

export function buildExpectation(docs: ExpectInput[], opts?: ExpectOptions | null): BuiltExpectation {
  const nodes: VerifySpec[] = [];
  const instances: VerifyInstance[] = [];
  const interactions: VerifyInteraction[] = [];
  const notComparable: NotComparable[] = [];
  const hidden: { roots: Array<{ nodeId: string; name: string; path?: string }>; ids: string[]; specsSkipped: number; instancesSkipped: number; interactionsSkipped: number } =
    { roots: [], ids: [], specsSkipped: 0, instancesSkipped: 0, interactionsSkipped: 0 };
  const frames: Array<Partial<VerifyFrame>> = [];
  const seen = new Set<string>();
  let screen: string | undefined = undefined, exportedAt: string | undefined = undefined, reference: string | null = null;
  // every node id each Figma file's docs carry (ids are per FILE), and the file each interaction came from
  const idsByFile = new Map<string, Set<string>>();
  // each file's screen roots (id → name) — the index row that IS this screen ties it to its file
  // (names: the root's own and the export's title — a multi-frame selection pull is indexed as "selection")
  const rootsByFile = new Map<string, Map<string, Set<string>>>();
  const interactionFile = new Map<VerifyInteraction, string | undefined>();
  const roots: IrNode[] = [];
  const rootNodesByFile = new Map<string, IrNode[]>(); // each Figma file's input roots
  const visibleById = new Map<string, { name: string; file: string }>(); // a plan row's node — its name and file

  for (const { doc, label } of docs) {
    const exp = screenExportOf(doc);
    // (a screen export and a page-walk layer file both say which Figma file they came from; a bare node does not)
    const sf: unknown = doc && "sourceFile" in doc ? doc.sourceFile : exp ? exp.sourceFile : undefined;
    const sourceFile = typeof sf === "string" && sf ? sf : undefined;
    const fileIds = getOrInit(idsByFile, sourceFile ?? "", () => new Set<string>());
    if (!screen) screen = (exp && exp.screen) || label;
    if (!exportedAt) exportedAt = exp ? exp.exportedAt : undefined;
    for (const root of screenRoots(doc)) {
      if (root.id) {
        const names = getOrInit(getOrInit(rootsByFile, sourceFile ?? "", () => new Map<string, Set<string>>()), root.id, () => new Set<string>());
        // (the title only for the frame the pull is filed under — the index row carries that one id)
        for (const n of [root.name, exp && exp.nodeId === root.id ? exp.screen : undefined]) if (typeof n === "string" && n) names.add(n);
      }
      getOrInit(rootNodesByFile, sourceFile ?? "", () => []).push(root);
      if (!reference && root.reference) reference = root.reference;
      const b: Partial<Box> = root.box || {};
      const frame: Partial<VerifyFrame> = { nodeId: root.id, name: root.name, ...ifDefined("w", b.w), ...ifDefined("h", b.h), ...ifDefined("x", b.x), ...ifDefined("y", b.y), clip: root.clip === true,
        ...ifDefined("scroll", root.scroll) }; // a frame designed to scroll sideways
      frames.push(frame);
      const frameId = frames.length > 1 ? root.id : undefined;
      const stateOf = new WeakMap<IrNode, InheritedState>(); // node -> inherited drawn-state { state, why, from }
      // node -> the ancestorIds its CHILDREN get: itself then its own ancestors (the frame root contributes none)
      const chainOf = new WeakMap<IrNode, string[]>();
      // a frame's fixed children (pinned while scrolling) and everything inside them. Figma keeps them "on
      // top of scrolling children" (plugin typings, numberOfFixedChildren) — the LAST N of children[], which is bottom-to-top.
      const fixedNodes = new WeakSet<IrNode>();
      roots.push(root);
      walkWithHidden(root, (n, c) => {
        if (n.id) fileIds.add(n.id);
        if (c.hidden) {
          // Counted, never specified. The ids travel with the expectation so --compare can say "you
          // drove a hidden layer" instead of crediting it.
          if (!c.parentHidden) hidden.roots.push({ nodeId: n.id, name: n.name, path: c.path });
          if (n.id) hidden.ids.push(n.id);
          if (checkable(expectNode(n, { path: c.path }).spec)) hidden.specsSkipped++;
          if (n.type === "INSTANCE" && n.mainComponent) hidden.instancesSkipped++;
          for (const r of Array.isArray(n.reactions) ? n.reactions : []) hidden.interactionsSkipped += actionsOf(r).length;
          return;
        }
        const inherited = c.parent ? stateOf.get(c.parent) : undefined;
        // Every ancestor of a visible node is visible (hidden is inherited), so this is the visible chain,
        // nearest first. The probe scopes a text match to a tagged ancestor with it; compare ignores it.
        const ancestorIds = c.parent ? chainOf.get(c.parent) ?? [] : [];
        chainOf.set(n, c.parent ? [...(n.id ? [n.id] : []), ...ancestorIds] : []);
        if (n.id && seen.has(n.id)) return;
        if (n.id) seen.add(n.id);
        if (n.id) visibleById.set(n.id, { name: n.name, file: sourceFile ?? "" });
        const { spec, notComparable: gaps } = expectNode(n, { path: c.path, frame, ...ifDefined("inheritedState", inherited), ...ifDefined("frameId", frameId) });
        spec.ancestorIds = ancestorIds;
        if (n.absolute) spec.absolute = true;
        const par = c.parent;
        const sibs = par && Array.isArray(par.children) ? par.children : [];
        const nFixed = par && typeof par.fixedChildren === "number" ? par.fixedChildren : 0;
        if (par && (fixedNodes.has(par) || (nFixed > 0 && sibs.indexOf(n) >= sibs.length - nFixed))) { fixedNodes.add(n); spec.fixed = true; }
        if (spec.drawnState) stateOf.set(n, inherited || { state: spec.drawnState, why: spec.drawnStateWhy || "", from: n.name || n.id, fromId: n.id });
        if (checkable(spec)) nodes.push(spec);
        else {
          // an exclusion (radius on a layer that draws nothing, padding the box cannot show) took the
          // node's only checkable value — it is not a spec; say so rather than let it vanish
          const g11 = gaps.filter((g) => g.field === "border-radius" || g.field.startsWith("padding ("));
          if (g11.length) gaps.push({ nodeId: n.id, name: n.name, field: "node", value: null,
            why: gaps.some((g) => g.field === "border-radius") ? "node not checked: it draws nothing (no fill, stroke, effect or clip) — its radius was its only stated value"
              : `node not checked: every value it states is excluded by method (${g11.map((g) => g.field).join(", ")})` });
        }
        notComparable.push(...gaps);

        if (n.type === "INSTANCE" && n.mainComponent) {
          instances.push({
            nodeId: n.id,
            name: n.name,
            setName: n.mainComponent.setName || n.mainComponent.name,
            ...ifDefined("setKey", n.mainComponent.setKey || n.mainComponent.key),
            ...ifDefined("variant", n.mainComponent.variant),
            ...ifDefined("props", n.props || undefined),
          });
        }
        // The interaction graph is already in the export, keyed by node id — the richest input in the
        // whole IR and the one nothing verified. The real shape is
        // `reactions[].actions[]` (plural on both), with `trigger` a plain string — see
        // figma-plugin/src/prototype.ts.
        for (const r of Array.isArray(n.reactions) ? n.reactions : []) {
          const trigger = triggerOf(r);
          for (const a of actionsOf(r)) {
            const row: VerifyInteraction = {
              nodeId: n.id,
              name: n.name,
              trigger,
              ...ifDefined("action", a.navigation || a.type),
              ...ifDefined("destinationId", a.destinationId),
              ...ifDefined("destination", a.destination),
            };
            interactions.push(row);
            interactionFile.set(row, sourceFile ?? "");
          }
        }
      });
    }
  }

  // ---- plan.interactions[] — interactions the export cannot carry (a control with no prototype
  // reaction). Merged only when the row can be graded like an export row: a visible node of this export, a known
  // `expect` (→ the action OUTCOMES_FOR_ACTION grades), a dialog naming the frame it opens, and no export row with
  // the same nodeId + trigger (the export wins). Every other row is dropped with why. exportContentSha256 does not
  // change (waivers bind the export, not the plan); only the rows' own hash binds (planInteractions.sha256).
  const planIn = opts && opts.plan;
  let planInteractions: VerifyExpectation["planInteractions"];
  if (planIn && Array.isArray(planIn.plan.interactions)) {
    const dropped: Array<{ nodeId: string; why: string }> = [];
    const keys = new Set(interactions.map((r) => `${r.nodeId}|${r.trigger}`));
    const hiddenIds = new Set(hidden.ids);
    let merged = 0;
    planIn.plan.interactions.forEach((raw, k) => {
      const at = `interactions[${k}]`;
      const o = isJsonObject(raw) ? raw : null;
      const id = o && typeof o.nodeId === "string" && o.nodeId.trim() ? o.nodeId.trim() : null;
      const drop = (why: string): void => { dropped.push({ nodeId: id ?? `(${at})`, why }); };
      if (!o) return drop(`${at} is not an object`);
      if (id === null) return drop(`${at} has no nodeId — a plan interaction is keyed by its node like an export reaction`);
      if (typeof o.trigger !== "string" || !o.trigger.trim()) return drop("no trigger (on_click, on_press, …)");
      if (!isPlanExpect(o.expect)) return drop(`expect ${JSON.stringify(o.expect ?? null)} is not dialog | url | selector:<css>`);
      if (o.destinationId !== undefined && (typeof o.destinationId !== "string" || !o.destinationId.trim())) return drop("destinationId is not a node id");
      if (o.expect === "dialog" && o.destinationId === undefined) return drop("expect dialog needs the destinationId of the frame it opens (its root is tagged with it)");
      const node = visibleById.get(id);
      if (!node) return drop(hiddenIds.has(id) ? "the node is a hidden layer — it is not built or driven" : "no visible node of this export has that id");
      const trigger = o.trigger.trim().toLowerCase();
      // the probe opens a dialog by clicking its opener — a dialog row on any other trigger (hover, key, drag…)
      // could never be driven, so it would sit not-probed forever
      if (o.expect === "dialog" && trigger !== "on_click" && trigger !== "on_press") return drop(`expect dialog needs trigger on_click or on_press (the probe opens a dialog by clicking its opener), not ${trigger}`);
      if (keys.has(`${id}|${trigger}`)) return drop(`duplicates ${interactions.some((r) => r.nodeId === id && r.trigger === trigger && r.source !== "plan") ? "the export's own interaction" : "an earlier plan row"} for this node and trigger (${trigger})`);
      keys.add(`${id}|${trigger}`);
      const destinationId = typeof o.destinationId === "string" ? o.destinationId.trim() : undefined;
      const row: VerifyInteraction = { nodeId: id, name: node.name, trigger, action: actionForExpect(o.expect), expect: o.expect, ...ifDefined("destinationId", destinationId), source: "plan" };
      interactions.push(row);
      interactionFile.set(row, node.file);
      merged++;
    });
    planInteractions = { plan: planIn.file, sha256: planInteractionsSha256(planIn.plan), merged, dropped };
  }

  // repeated placeholder copy in sibling rows
  const specById = new Map(nodes.map((s) => [s.nodeId, s]));
  for (const r of roots) markRepeatedText(r, specById);

  // a destination that is no node of the export FOR THE SAME FIGMA FILE was never designed here.
  // Figma node ids are per file — a join across files would match unrelated nodes. So a row's file is only ever
  // its OWN sourceFile stamp (never the index's top-level one: the CLI merges rows of several index files), and a
  // destination is looked up among the rows that COULD be this screen's file: the rows naming it, plus every row
  // naming none (an export written before the bridge stamped sourceFile — every field-test export, and the rest
  // of such an index after one screen is re-pulled). Found in one of those, or among the ids of any
  // unnamed input, it counts as exported (it may be this file's); found in none, it was never exported.
  // The screen must be IN the index — a row with its root's id AND name (a bare id like 1:1 recurs across files),
  // in its file or unnamed — or an index of another file would call every destination "never exported". A screen
  // naming no file takes its file from that row: one named file → that file's rows + unnamed ones; any unnamed own
  // row → every row; rows naming two files → nothing decided. Otherwise the row is left as it was.
  // Known misses: sourceFile is the file's NAME — rows pulled before a rename name the old one and are excluded; a
  // destination frame nested in an exported SECTION/GROUP is no index row of its own, so it reads as never exported.
  const index = opts && opts.index;
  const unnamedIds = idsByFile.get("");
  const candidatesFor = (file: string): IndexRow[] | null => candidatesOf(file)?.rows ?? null;
  // (resolved: the Figma file the candidate rows belong to — null when they may be any file's)
  function candidatesOf(file: string): { rows: IndexRow[]; resolved: string | null } | null {
    if (!index) return null;
    const own = rootsByFile.get(file);
    const sameName = (l: IndexRow): boolean => { const names = own?.get(l.id); return !!names && (!names.size || l.name === undefined || names.has(l.name)); };
    const covering = own ? index.layers.filter((l) => sameName(l) && (file === "" || !l.sourceFile || l.sourceFile === file)) : [];
    if (!covering.length) return null; // the index does not cover this screen
    let f = file;
    if (f === "") {
      const named = new Set(covering.map((l) => l.sourceFile).filter((x): x is string => !!x));
      if (named.size > 1) return null;
      // an unnamed own row may be any file's (a duplicated file shares ids AND names) → every row
      if (named.size === 0 || covering.some((l) => !l.sourceFile)) return { rows: index.layers, resolved: null };
      f = [...named][0] ?? "";
    }
    return { rows: index.layers.filter((l) => !l.sourceFile || l.sourceFile === f), resolved: f || null };
  }
  for (const row of interactions) {
    const file = interactionFile.get(row);
    // a change_to's destination is a component VARIANT — a drawn state of this very instance, never a
    // screen anyone exports — so it is never "undesigned"; undriven, it is not-probed like any other interaction.
    if (!row.destinationId || file === undefined || String(row.action).toLowerCase() === "change_to") continue;
    const known = idsByFile.get(file);
    if (!known || known.has(row.destinationId) || (unnamedIds && unnamedIds.has(row.destinationId))) continue;
    const candidates = candidatesFor(file);
    if (candidates && !candidates.some((l) => l.id === row.destinationId)) row.destinationExported = false;
  }

  // ---- aliases. A shared shell (sidebar, header) is ONE component instance on every screen, but Figma re-mints
  // the ids under each instance (`I<instance>;<path>`, nested instances re-mint the path too), so a build tagged
  // with screen A's ids misses on screen B. For each outermost instance, the SAME node in a sibling export of the SAME
  // Figma file (the candidate rows — never a join across files: ids and keys would match unrelated nodes) is
  // the one at the same visible name path under an instance of the same main component key, when that key has exactly
  // one outermost instance in both exports and the path is unique in both. Its id is an alias; an id whose `;` suffix
  // equals the spec's own is left out (the probe's tag-shared-path finds it already). Rebuilt from the CURRENT
  // siblings at every --expect (sublayer id stability is undocumented). Known misses: a renamed layer, a
  // repeated name inside the instance (e.g. same-named menu items), a shell instantiated twice on one screen.
  // Each sibling export is read from disk once per --expect: this pass and the overlay pass below share the memo.
  const readSibling = opts && opts.readSibling;
  const siblingCache = new Map<string, ScreenDoc | null>();
  const sibling = (file: string): ScreenDoc | null => {
    if (!readSibling) return null;
    if (!siblingCache.has(file)) siblingCache.set(file, readSibling(file) ?? null);
    return siblingCache.get(file) ?? null;
  };
  if (index && readSibling) {
    const ownRootIds = new Set(roots.map((r) => r.id));
    const specSuffixes = new Set(nodes.map((n) => idSuffix(n.nodeId)).filter((x): x is string => x !== null));
    const aliases = new Map<string, Set<string>>();
    for (const [file, fileRoots] of rootNodesByFile) {
      const co = candidatesOf(file);
      if (!co) continue;
      const cands = co.rows;
      const own = shellIndex(fileRoots);
      if (!own.size) continue;
      const read = new Set<string>();
      for (const row of cands) {
        if (ownRootIds.has(row.id) || !row.file || read.has(row.file)) continue;
        read.add(row.file);
        const sib = sibling(row.file);
        if (!sib) continue;
        // the sibling's own stamp must not name another file (a row may be unnamed while its export is stamped). An
        // UNSTAMPED sibling is allowed for a stamped screen (a partly re-pulled export): the risk is small — an alias
        // also needs the same component key, a unique name path, the same content and texted ancestor, and a tag-alias
        // match is capped, so it cannot make a pass on its own.
        const sx = screenExportOf(sib);
        const sibFile: unknown = "sourceFile" in sib ? sib.sourceFile : sx ? sx.sourceFile : undefined;
        // (an unstamped screen is checked against the file its index row resolved to)
        if (co.resolved && typeof sibFile === "string" && sibFile && sibFile !== co.resolved) continue;
        const theirs = shellIndex(screenRoots(sib));
        for (const [key, mine] of own) {
          const other = theirs.get(key);
          const a = mine.length === 1 ? mine[0] : undefined, b = other && other.length === 1 ? other[0] : undefined;
          if (!a || !b) continue;
          for (const [p, mine1] of a) {
            const their1 = b.get(p);
            if (!mine1 || !their1 || mine1.sig !== their1.sig) continue; // same path, different content: another node
            const id = mine1.id, sid = their1.id;
            if (sid === id) continue;
            // (an id whose `;` suffix is ANY expected spec's suffix is that spec's tag-shared-path match)
            const s2 = idSuffix(sid);
            if (s2 !== null && specSuffixes.has(s2)) continue;
            getOrInit(aliases, id, () => new Set<string>()).add(sid);
          }
        }
      }
    }
    for (const [id, set] of aliases) { const sp = specById.get(id); if (sp) sp.aliases = [...set].sort(); }
  }

  // ---- what an overlay/swap opens. The destination frame's own overlay block (serialize.ts writes it only when it
  // differs from Figma's default: centred, no scrim, no close-on-click-outside) — read off the destination ROOT among the
  // inputs of the same file, else off the sibling export its index row names (the candidate rows). A destination
  // that is no exported root (never exported, or nested in another frame) gets no overlay.
  const destinationRoot = (destId: string, file: string): IrNode | undefined => {
    const own = [...(rootNodesByFile.get(file) ?? []), ...(file !== "" ? rootNodesByFile.get("") ?? [] : [])].find((r) => r.id === destId);
    if (own) return own;
    const co = candidatesOf(file);
    for (const row of co ? co.rows : []) {
      if (row.id !== destId || !row.file) continue;
      const sib = sibling(row.file);
      if (!sib) continue;
      const sx = screenExportOf(sib);
      const sibFile: unknown = "sourceFile" in sib ? sib.sourceFile : sx ? sx.sourceFile : undefined;
      if (co && co.resolved && typeof sibFile === "string" && sibFile && sibFile !== co.resolved) continue;
      const hit = screenRoots(sib).find((r) => r.id === destId);
      if (hit) return hit;
    }
    return undefined;
  };
  for (const row of interactions) {
    const act = String(row.action).toLowerCase();
    if (!row.destinationId || (act !== "overlay" && act !== "swap") || row.destinationExported === false) continue;
    const dest = destinationRoot(row.destinationId, interactionFile.get(row) ?? "");
    if (!dest) continue;
    const ov = dest.overlay;
    row.overlay = { position: ov && typeof ov.position === "string" ? ov.position : "center", closeOnClickOutside: !!ov && ov.closeOnClickOutside === true,
      background: ov && typeof ov.background === "string" ? ov.background : null, from: ov ? "export" : "default" };
  }

  const f0: Partial<VerifyFrame> = frames[0] || {};
  // the reference PNG's geometry over the first frame — only when the caller can read the PNG
  const readReference = opts && opts.readReference;
  let referenceImage: VerifyReferenceImage | VerifyReferenceUnusable | undefined;
  if (readReference) {
    const first = roots[0];
    const firstFile = first ? [...rootNodesByFile].find(([, rs]) => rs.includes(first))?.[0] : undefined;
    referenceImage = referenceImageFor({ reference, root: first, sourceFile: firstFile || undefined, rows: index ? index.layers : [],
      readReference, colorProfile: opts && typeof opts.colorProfile === "string" ? opts.colorProfile : null });
  }
  // expectation.frame / frames[] row: the frame's id, name, size and clip (no x/y)
  const rootFrame = (f: Partial<VerifyFrame>): Partial<VerifyRootFrame> => ({ ...ifDefined("nodeId", f.nodeId), ...ifDefined("name", f.name), ...ifDefined("w", f.w), ...ifDefined("h", f.h), ...ifDefined("clip", f.clip), ...ifDefined("scroll", f.scroll) });
  return {
    schema: EXPECTATION_SCHEMA,
    ...ifDefined("screen", screen),
    ...ifDefined("exportedAt", exportedAt),
    // the design's identity without the pull's timestamps, so a no-change
    // re-pull (only `exportedAt` differs) is recognised as the same design by content, not by clock.
    exportContentSha256: exportContentSha256(docs.map((d) => d.doc)),
    reference,
    frame: rootFrame(f0),
    ...(frames.length > 1 ? { frames: frames.map(rootFrame) } : {}),
    coordinates: COORDINATES,
    note:
      "Generated from the export — do NOT retype these numbers into code comments. Every row is the " +
      "value the design states; a field the export does not define is absent rather than defaulted. " +
      "Layers the designer switched off (hidden: true on the node or an ancestor) have NO row: do not build, " +
      "measure or drive them — their ids are listed under `hidden`. Feed this to a renderer probe and compare " +
      "with `verify-screen.js --compare`; the probe's field names are listed under `measuredKeys`.",
    measuredKeys: MEASURED_KEYS_DOC,
    tolerance: TOLERANCE,
    counts: {
      nodes: nodes.length, instances: instances.length, interactions: interactions.length, notComparable: notComparable.length,
      hidden: { layers: hidden.roots.length, nodes: hidden.ids.length, specsSkipped: hidden.specsSkipped, instancesSkipped: hidden.instancesSkipped, interactionsSkipped: hidden.interactionsSkipped },
    },
    nodes,
    instances,
    interactions,
    notComparable,
    hidden: { roots: hidden.roots, ids: hidden.ids },
    ...ifDefined("planInteractions", planInteractions),
    ...ifDefined("referenceImage", referenceImage),
  };
}

// ---------------------------------------------------------------- the reference image (--expect)
// Where the export's reference PNG sits over the first frame, so the probe can render the build at the reference's own
// scale and crop the frame box out of it. Index first (the row write-out.ts wrote for THIS png), else recomputed from
// the export root exactly as the bridge does. A png whose scale is not the one Figma renders a reference at is a
// discovery thumbnail — never diffed at its own scale.
const round4 = (n: number): number => Math.round(n * 10000) / 10000;
/** The scale Figma renders a root's reference at (figma-plugin/src/assets.ts collectReference: no explicit scale). */
export const figmaReferenceScale = (w: number, h: number): number => Math.min(2, 2048 / (Math.max(w, h) || 1));
const REFERENCE_SCALE_SLACK = 0.02;
interface ReferenceInput {
  reference: string | null; root: IrNode | undefined; sourceFile: string | undefined; rows: readonly IndexRow[];
  readReference: (pointer: string) => Uint8Array | null; colorProfile: string | null;
}
/** expectation.referenceImage for the first frame (see the section comment). */
export function referenceImageFor(o: ReferenceInput): VerifyReferenceImage | VerifyReferenceUnusable {
  const { reference, root } = o;
  const unusable = (p: string | null, why: string): VerifyReferenceUnusable => ({ usable: false, path: p, why });
  if (!reference) return unusable(null, "the export has no reference PNG for this screen — re-pull it with its reference");
  const p = "design/export/" + reference;
  // confined to design/export (lexically — the root used here is any absolute one)
  if (resolveInside(path.resolve(EXPORT_DIR), reference) === null) return unusable(p, `the reference pointer ${reference} leads outside design/export — re-pull the screen`);
  if (!root || root.reference !== reference) return unusable(p, "the reference PNG belongs to another frame than the first one — only the first frame is diffed");
  const box = root.box;
  if (!box || !(num(box.w) && box.w > 0) || !(num(box.h) && box.h > 0)) return unusable(p, "the frame has no size in the export (box.w/h) — the reference cannot be placed");
  const bytes = o.readReference(reference);
  if (!bytes) return unusable(p, `the reference PNG ${p} is missing on disk — re-pull the screen`);
  const png = pngInfo(bytes);
  if (!png) return unusable(p, `the reference ${p} is not a PNG or is damaged — re-pull the screen`);
  if (png.bitDepth !== 8 || (png.colorType !== 2 && png.colorType !== 6) || png.interlace !== 0)
    return unusable(p, `the reference ${p} is a PNG of colour type ${png.colorType} / depth ${png.bitDepth}${png.interlace ? " / interlaced" : ""} — the visual diff reads 8-bit RGB/RGBA, non-interlaced`);
  if (!png.w || !png.h) return unusable(p, `the reference ${p} is an empty PNG`);
  // index first: the row write-out.ts wrote for THIS png (same id, same file when both are stamped, same pointer)
  const row = o.rows.find((r) => r.id === root.id && (!r.sourceFile || !o.sourceFile || r.sourceFile === o.sourceFile) && r.reference === reference
    && num(r.referenceScale) && r.referenceScale > 0);
  // The export fallback is bridge/src/write-out.ts writeScreen's formula, duplicated here — it is inline in
  // writeScreen, not an exported function; keep the two in step: refBox = renderBox || box; scale = round4(png.w / refBox.w);
  // offset = renderBox ? renderBox − box : {0, 0}.
  const rb = root.renderBox && num(root.renderBox.w) && root.renderBox.w > 0 ? root.renderBox : undefined;
  const exportOffset = !rb ? { x: 0, y: 0 } : num(rb.x) && num(rb.y) && num(box.x) && num(box.y) ? { x: rb.x - box.x, y: rb.y - box.y } : null;
  const rowOffset = row && row.referenceOffset && num(row.referenceOffset.x) && num(row.referenceOffset.y) ? { x: row.referenceOffset.x, y: row.referenceOffset.y } : null;
  const scale = row && num(row.referenceScale) ? row.referenceScale : round4(png.w / (rb ? rb.w : box.w));
  const offset = rowOffset ?? exportOffset;
  if (!offset) return unusable(p, "the export root has render bounds but no position (box.x/y) — where the reference sits over the frame is unknown");
  // a discovery thumbnail (360 px for a 1440 frame) is no export reference — Figma renders roots at s0
  // (the PNG on disk is checked too, not only the index's number: a thumbnail written over the pointer after the pull)
  const s0 = figmaReferenceScale(box.w, box.h), onDisk = png.w / (rb ? rb.w : box.w);
  if (![scale, onDisk].every((v) => Math.abs(v - s0) <= REFERENCE_SCALE_SLACK * s0))
    return unusable(p, `the reference is a ${png.w} px image, not the export reference (a discovery thumbnail) — re-pull the screen`);
  // the PNG must be the render bounds at that scale on BOTH axes (±2 px; on the height also the scale's own rounding — it
  // comes from png.w, up to 1 px off the true width, + round4 — so a tall narrow frame's round(h · scale) can be h/w px off:
  // 0 extra for 1440×720, 12 for 400×5000). A PNG of another height is a stale or
  // foreign image under the pointer — and an absurd one (150 000 px tall) would be decoded in full by the probe.
  const refW = rb ? rb.w : box.w, refH = rb && num(rb.h) && rb.h > 0 ? rb.h : box.h;
  const ew = Math.round(refW * scale), eh = Math.round(refH * scale), tolH = 2 + Math.floor(refH * (1 / refW + 0.00005));
  if (Math.abs(png.w - ew) > 2 || Math.abs(png.h - eh) > tolH)
    return unusable(p, `the reference ${p} is ${png.w}×${png.h} px, but the frame's render bounds at ${scale}x are ${ew}×${eh} — a stale or foreign PNG under the pointer; re-pull the screen, then re-run --expect`);
  // the frame box inside the PNG, device px, clamped to the image
  const x = Math.min(Math.max(0, Math.round(-offset.x * scale)), png.w), y = Math.min(Math.max(0, Math.round(-offset.y * scale)), png.h);
  const crop = { x, y, w: Math.max(0, Math.min(Math.round(box.w * scale), png.w - x)), h: Math.max(0, Math.min(Math.round(box.h * scale), png.h - y)) };
  const profiles = [o.colorProfile === "display_p3" ? "display_p3" : null, png.iccp !== null ? `iCCP:${png.iccp || "unnamed"}` : null].filter((v): v is string => v !== null);
  return {
    usable: true, path: p, sha256: sha256Hex(bytes), png: { w: png.w, h: png.h },
    scale, offset, from: row ? "index" : "export", crop, ...(profiles.length ? { colorProfile: profiles.join(" + ") } : {}),
  };
}
