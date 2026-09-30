// verify-screen.ts — turn "looks right" into a per-node number, and refuse to say "pass" without one.
//
// The live run shipped three verification passes totalling ~42 minutes, all of which returned
// "pass"/"verified", against a build where an independent measurement pass then found ~35% of sampled
// values wrong (finding 102). Not rounding — real errors: a heading rendered at the page-title style
// instead of its own, an empty-state body at 16px/#d4d4d4 where the export says 14px/#a0a0a0, a status
// chip with its fill token never applied, a modal at radius 20 against a spec of 12, and two toolbar
// components never built at all. The verifiers compared screenshots and structure; nothing compared
// the numbers, so anything wrong-but-plausible passed.
//
// The root causes were all mechanical, and so are the fixes here:
//
//   (a) The spec was PARAPHRASED. The builder's own EmptyState.tsx comment asserted "heading 20/Semi
//       Bold, subtitle 16/Regular" — which contradicts the export — and that comment is presumably
//       how the bug got written. So `--expect` emits the spec as DATA, read straight off the node
//       tree. Nobody retypes a number that a file already holds.
//   (b) There was no per-node comparison at all. `--compare` diffs measured computed styles against
//       that spec, field by field, with an explicit tolerance per field.
//   (c) Verdicts were prose in a chat hand-back, so nothing could be audited or re-run (findings
//       85/92). Every run writes <screen>.report.json, and `pass` is computed from it, never asserted.
//   (d) Coverage and interactions were never checked (findings 80/101). A screen can match every
//       pixel and still be a dead mockup with two components missing.
//
// Two commands, one file, because the expectation format and the comparison must never drift:
//   node verify-screen.js --expect  <screen.json>... --out design/verify/<Screen>
//   node verify-screen.js --compare <Screen>.expected.json <measured.json> [--interactions <file>] --out design/verify/<Screen>
//
// There is NO browser in this file. `--compare` diffs two JSON files; the rendering, measuring and
// interaction-driving are the probe's job (the visual-verifier agent, or any script), and what it did
// arrives as measured.json (+ an optional --interactions file). Anything the probe did not measure is
// reported as not measured / not probed — never as passed, and never as failed (findings 127/158).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { walkWithHidden } from "./hidden.ts";
import { exportContentSha256, fileHashes, gitHead } from "./content-hash.ts";
import { readDocFile, readJsonFile } from "./catalog-input.ts";
import { isInteractionEvidenceList, isMeasuredComponentList, isPageIndex, isPagesRootIndex, isPlan, isPlanDescope, isPlanWaiver, isProbeIdentity, isVerifyExpectation, isVerifyMeasured, isVerifyReport, readableMeasured } from "./doc-guards.ts";
import { isPassingVerdict, waiversHash } from "./plan-waivers.ts";
import { readJson, readJsonOrNull } from "./read-json.ts";
import { cliParse, scriptCmd } from "./cli-args.ts";
import { parseArgs } from "node:util";
import { isJsonObject } from "./types.ts";
import { isScreenDoc, screenExportOf, screenRoots } from "./export-shape.ts";
import { colorKey } from "./color.ts";
import type {
  Action, ArtifactCheck, Box, CodeInputs, DeltaSeverity, DrawnState, IndexRow, InteractionEvidence, IrNode, JsonValue, LayoutSpec, MeasuredComponent, MeasuredNode, MeasuredStyles,
  NotComparable, Paint, Plan, PlanAnchor, PlanDescope, PlanWaiver, ProbeFrame, Reaction, ReactionTrigger, ScreenDoc, SolidPaint, VerifyDelta, VerifyCoverageV2, VerifyExpectation, VerifyInstance, VerifyInteraction,
  VerifyInteractionResult, VerifyMeasured, VerifyFrame, VerifyAgainst, VerifyReport, VerifyReportV2, VerifyRootFrame, VerifySpec, VerifyVerdict,
} from "./types.ts";
import { ifDefined } from "../bridge/src/json-util.ts";
import { getOrInit } from "./map-util.ts";
import { isMainFallback } from "../bridge/src/is-main.ts"; // import.meta.main is undefined before Node 24.2

// ---------------------------------------------------------------- tolerances
//
// Every tolerance is a deliberate claim about what a browser may legitimately do differently from
// Figma, NOT a fudge factor for sloppy building. They are tight on purpose: the live run's misses
// were 20-vs-18px font, 16-vs-14px, radius 20-vs-12, gap 23.5-vs-16, row 50-vs-48 — every one of
// them lands outside these, which is the point.
const TOLERANCE = {
  fontSize: 0.5, // a browser rounds; a different token does not
  fontWeight: 0, // 500 vs 600 is a different style, never a rendering artifact
  lineHeight: 2, // normal/unitless line-heights and font-metric rounding genuinely differ
  letterSpacing: 0.2,
  radius: 0.5,
  padding: 1,
  gap: 1,
  // 1, not 2: a 2px box error is exactly a border put on the wrong side of the box — the filter button
  // measured 111.83×38 against 110×36 and the old inclusive 2px tolerance emitted nothing (finding 193).
  size: 1,
  // Frame-relative x/y. Loose enough for sub-pixel layout and a glyph's side-bearing, tight enough that
  // a column 18.94px out of place (finding 192) or a bar 130px below the frame (164) cannot hide.
  position: 2,
  opacity: 0.02,
};

// Colours compare exactly after normalisation. There is no "close enough" colour: the live run's
// chip was #03d5ab where the export said #007d6c, which any perceptual threshold loose enough to
// call a rendering artifact would also have let through.
function normColor(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  const key = colorKey(s); // color.ts: every hex spelling -> "#rrggbbaa"
  if (key) return key;
  const inner = /^rgba?\(([^)]+)\)$/.exec(s)?.[1]; // the group is not optional: set whenever the regex matched
  if (inner !== undefined) {
    const p = inner.split(/[,\s/]+/).filter(Boolean).map(Number);
    const [r, g, b, a0] = p;
    if (r === undefined || g === undefined || b === undefined || p.some((n) => Number.isNaN(n))) return s;
    const a = a0 ?? 1;
    if (a === 0) return "transparent"; // rgba(0,0,0,0) is "no background", whatever the channels say
    const hex = (n: number): string => Math.round(n).toString(16).padStart(2, "0");
    return "#" + hex(r) + hex(g) + hex(b) + hex(Math.round(a * 255));
  }
  if (s === "transparent" || s === "rgba(0, 0, 0, 0)") return "transparent";
  return s;
}

// Figma names weights ("SemiBold"); CSS uses numbers. Compare on the number, because that is what a
// browser actually applies — and because "Medium" rendering as 600 is precisely the live bug.
const WEIGHTS: Record<string, number> = {
  thin: 100, extralight: 200, ultralight: 200, light: 300, normal: 400, regular: 400, book: 400,
  medium: 500, semibold: 600, demibold: 600, bold: 700, extrabold: 800, ultrabold: 800, black: 900, heavy: 900,
};
function normWeight(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const key = s.toLowerCase().replace(/[^a-z]/g, "");
  return WEIGHTS[key] != null ? WEIGHTS[key] : null;
}

// Figma stores a family as one name; CSS reports the whole stack. A match on the FIRST family is the
// honest comparison — the fallbacks are the builder's business.
function normFamily(v: unknown): string | null {
  if (v == null) return null;
  // ?? "": split() always returns at least one piece, so the fallback never applies
  return (String(v).split(",")[0] ?? "").trim().replace(/^['"]|['"]$/g, "").toLowerCase();
}

// ts-port: legacy/producer-mismatch read kept as-is (item 4). The producer writes a LengthSpec
// ({value, unit: "px"|"percent"|"auto"}); this also accepts a measured number/string and the older
// upper-case units, so its input is declared wide here rather than in types.ts.
type LineHeightInput = number | string | { unit?: string; value?: number } | null | undefined;

function lineHeightPx(lh: LineHeightInput, fontSize: number | string | undefined): number | null {
  if (lh == null) return null;
  if (typeof lh === "number") return lh;
  if (typeof lh === "string") {
    const s = lh.trim().toLowerCase();
    if (s === "normal") return null; // genuinely unknowable without the font metrics — not a mismatch
    const n = parseFloat(s);
    if (Number.isNaN(n)) return null;
    if (s.endsWith("%")) return fontSize ? (n / 100) * Number(fontSize) : null;
    if (s.endsWith("px")) return n;
    return fontSize ? n * Number(fontSize) : null; // unitless multiplier
  }
  if (typeof lh === "object") {
    if (lh.unit === "PERCENT" || lh.unit === "%") return fontSize ? (Number(lh.value) / 100) * Number(fontSize) : null;
    if (lh.unit === "AUTO") return null;
    return typeof lh.value === "number" ? lh.value : null;
  }
  return null;
}

// ---------------------------------------------------------------- the expectation
//
// One row per node worth checking, carrying ONLY values the export actually states. A field the
// export does not define is OMITTED, never defaulted — a spec that invents `fontWeight: 400` because
// the node didn't say produces exactly the confident-and-wrong comparison this file exists to stop.
//
// Only layers that RENDER get a row. The rule is hidden.ts's one predicate (`hidden: true` on the
// node or any ancestor — never `visible === false`, which the export does not use). Before it,
// 83 of 272 Job Roles specs, 61 of 112 instances and 22 of 28 designed interactions were for layers
// the designer switched off (findings 97/126/181), and a build that correctly omitted them was graded
// on them (157/159/185/188).
const EXPECTATION_SCHEMA = "designtwin/verify-expectation@2";
const REPORT_SCHEMA = "designtwin/verify-report@2";


const firstSolid = (fills: Paint[] | null | undefined): SolidPaint | undefined => (fills || []).find((f): f is SolidPaint => !!f && f.type === "solid" && f.visible !== false);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const r2 = (v: number): number => Math.round(v * 100) / 100;
// A measured length as a probe hands it over (DT-42): a number, or getComputedStyle's own resolved string —
// "20px", "0.15px", "3.35544e+07px" (a pill radius). A percentage, another unit, a keyword or an object is
// not a px value (null): `Number("20px")` used to be NaN, and the string then "differed" from 20.
const PX_RE = /^\s*[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?(?:px)?\s*$/i;
function cssPx(v: unknown): number | null {
  if (num(v)) return v;
  if (typeof v !== "string" || !PX_RE.test(v)) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}
// Four sides/corners in CSS order (t r b l / tl tr br bl) from a number, a list of 1-4 lengths, or a
// shorthand string — CSS's own 1-to-4 value expansion. null when any part is not a px length.
function fourSides(v: unknown): [number, number, number, number] | null {
  const parts: unknown[] = num(v) ? [v] : Array.isArray(v) ? v : typeof v === "string" ? v.trim().split(/\s+/) : [];
  const p = parts.map(cssPx);
  if (p.length < 1 || p.length > 4 || p.some((x) => x === null)) return null;
  const [p0, p1 = p0, p2 = p0, p3 = p1] = p.filter((x): x is number => x !== null);
  return p0 === undefined || p1 === undefined || p2 === undefined || p3 === undefined ? null : [p0, p1, p2, p3];
}

// A layer drawn IN an interaction state. The designer drew one table row hovered (its fill is bound
// to `Backgrounds/Row Hover`, and only that row carries the hover-only edit button); measuring the
// build at rest and calling #121319-vs-#46464f a high-severity colour bug was 1 of 4 false highs on
// BOTH screens (findings 98/128/161/194). The export says which state it drew, through the fill's
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
// `background-color` produced the other recurring false high (the moon glyph, the Union icon —
// findings 98/128/161/194).
const PAINT_TYPES = new Set<string>(["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "LINE"]);
const isPaintNode = (n: IrNode): boolean => PAINT_TYPES.has(n.type) || (typeof n.asset === "string" && /\.svg$/i.test(n.asset));

// A text layer that IS an input's placeholder. Its colour lives on `::placeholder`, which
// getComputedStyle(el) cannot see, and an empty <input> has no textContent — so comparing it as
// ordinary text/colour was two guaranteed high deltas per placeholder (findings 128/177/194).
function isPlaceholder(n: IrNode): boolean {
  if (n.type !== "TEXT") return false;
  const toks = [n.tokens && n.tokens.fills, ...(Array.isArray(n.fills) ? n.fills.map((f) => f && f.tokens && f.tokens.color) : [])];
  return toks.some((t) => typeof t === "string" && /placeholder/i.test(t)) || /placeholder/i.test(n.name || "");
}

// Position, FRAME-RELATIVE. The export's `box.x/y` are page-space and only present where the parent
// does not auto-position the node (absolute children, non-auto-layout parents); `renderBox` is the
// render bounds (for TEXT: the glyph ink). Subtracting the frame's own `box.x/y` gives the same
// coordinates a probe gets from `el.getBoundingClientRect()` minus the frame element's rect. No
// position was compared at all before (findings 164/192): a pagination bar 130px below the frame and
// an 18.94px column drift scored zero deltas.
interface FramePos { x: number; y?: number; source: "box" | "renderBox" }
function framePosition(n: IrNode, frame: Partial<VerifyFrame> | null | undefined): FramePos | null {
  if (!frame || !num(frame.x) || !num(frame.y)) return null;
  const b: Partial<Box> = n.box || {}, rb = n.renderBox;
  if (n.type === "TEXT") {
    // Ink start (renderBox.x) is what a Range's getBoundingClientRect().x reports, within a
    // side-bearing. Vertical ink depends on font metrics, so a TEXT node carries no `y`.
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
// ts-port: legacy/producer-mismatch read kept as-is (item 1) — `grow` is a number in the producer; `=== true` is an older export's spelling.
interface LegacyGrow { grow?: number | boolean; heightMode?: IrNode["heightMode"]; widthMode?: IrNode["widthMode"] }
const growsAlong = (c: IrNode, dir: string): boolean => { const lc: LegacyGrow = c; return lc.grow === 1 || lc.grow === true || (dir === "column" ? lc.heightMode === "fill" : lc.widthMode === "fill"); };

// ts-port: legacy/producer-mismatch read kept as-is (item 2) — the older layout spelling
// (itemSpacing, paddingTop/Right/Bottom/Left) beside the producer's gap/padding[].
interface LegacyLayout extends LayoutSpec { itemSpacing?: number; paddingTop?: number; paddingRight?: number; paddingBottom?: number; paddingLeft?: number }
const PAD_KEYS = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"] as const;

/** The drawn state a node inherits from an ancestor that was drawn in one. */
export interface InheritedState { state: DrawnState; why: string; from: string }
/** expectNode()'s context: the node's path, its frame (for positions), and any inherited drawn state. */
export interface ExpectContext { path?: string; frame?: Partial<VerifyFrame> | null; inheritedState?: InheritedState; frameId?: string }
/** expectNode()'s row: a VerifySpec plus the design values it could not compare, on a NON-enumerable
 *  `__notComparable` (so it never reaches the JSON). Always defined on a returned row. */
export interface ExpectedSpec extends VerifySpec { __notComparable?: NotComparable[] }

/**
 * The spec row for one VISIBLE node, plus any design values the method cannot compare
 * (`notComparable`, each with a reason). `ctx` = { path, frame, inheritedState }.
 */
function expectNode(n: IrNode, ctxOrPath?: string | ExpectContext | null): ExpectedSpec {
  return expectNodeRow(n, ctxOrPath).spec;
}

/** expectNode() plus the same `notComparable` array it hangs on the row, typed, for buildExpectation. */
function expectNodeRow(n: IrNode, ctxOrPath?: string | ExpectContext | null): { spec: ExpectedSpec; notComparable: NotComparable[] } {
  const ctx: ExpectContext = ctxOrPath == null ? {} : typeof ctxOrPath === "string" ? { path: ctxOrPath } : ctxOrPath;
  const spec: ExpectedSpec = { nodeId: n.id, name: n.name, type: n.type, ...ifDefined("path", ctx.path) };
  const notComparable: NotComparable[] = [];
  const skip = (field: string, value: JsonValue, why: string): number => notComparable.push({ nodeId: n.id, name: n.name, field, value, why });

  // `text` is where the producer writes a TEXT node's content (text.ts); the export never carries `characters`.
  if (n.text != null) spec.text = n.text;

  if (n.font) {
    if (n.font.family !== undefined) spec.fontFamily = n.font.family;
    if (typeof n.font.size === "number") spec.fontSize = n.font.size;
    const w = normWeight(n.font.weight);
    if (w != null) spec.fontWeight = w;
    const lh = lineHeightPx(n.font.lineHeight, n.font.size);
    if (lh != null) spec.lineHeight = lh;
    const ls: { value?: number; unit?: string } | undefined = n.font.letterSpacing;
    // Figma's percent letter-spacing is a share of the font size; the producer writes "percent" (an older
    // export "PERCENT") — it was read as px, so -2% on 20px text expected -2px, not -0.4px.
    if (ls && typeof ls.value === "number") {
      if (String(ls.unit).toLowerCase() !== "percent") spec.letterSpacing = ls.value;
      else if (typeof n.font.size === "number") spec.letterSpacing = r2((ls.value / 100) * n.font.size);
    }
    if (n.font.color) spec.color = normColor(n.font.color);
  }
  const fill = firstSolid(Array.isArray(n.fills) ? n.fills : null);
  // A TEXT node's fill is its TEXT colour, not a background — conflating the two is how a chip with a
  // missing background still looked "bound" (finding 100).
  if (fill && n.type !== "TEXT") {
    if (isPaintNode(n)) spec.fill = normColor(fill.color);
    else spec.backgroundColor = normColor(fill.color);
  }
  if (fill && n.type === "TEXT" && !spec.color) spec.color = normColor(fill.color);
  // Paint this method does not compare (a shadow, a blur, a gradient or image fill) is still paint: such a
  // wrapper is drawn, so a plan may never fold it away (F-77).
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
  }
  // Radius: one number, or per-corner. A per-corner radius with UNEQUAL corners (a table header
  // rounded only at the top) is compared corner by corner — the old code read `radius.tl` only, so
  // a card rounded at the bottom ({bl,br}) produced no radius spec at all (finding 162).
  if (typeof n.radius === "number") spec.borderRadius = n.radius;
  else if (n.radius && typeof n.radius === "object") {
    const rc = n.radius;
    const corner = (v: unknown): number => (num(v) ? v : 0);
    const c = { tl: corner(rc.tl), tr: corner(rc.tr), br: corner(rc.br), bl: corner(rc.bl) };
    if (c.tr === c.tl && c.br === c.tl && c.bl === c.tl) spec.borderRadius = c.tl;
    else spec.radiusCorners = c;
  }

  const L: LegacyLayout | undefined = n.layout;
  if (L && typeof L === "object") {
    const g = typeof L.gap === "number" ? L.gap : typeof L.itemSpacing === "number" ? L.itemSpacing : undefined;
    if (g !== undefined) {
      // A stored gap is only a GAP when it separates laid-out children. Three shapes where it is not
      // (finding 194: `gap 200 → 16`, `gap 146`, `gap 160` were all Figma auto-layout slack):
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
    if (pad && pad.some((v) => typeof v === "number" && v !== 0)) spec.padding = pad.map((v) => (typeof v === "number" ? v : 0));
  }
  if (n.box) {
    if (typeof n.box.w === "number") spec.width = n.box.w;
    if (typeof n.box.h === "number") spec.height = n.box.h;
  }
  const pos = framePosition(n, ctx.frame);
  if (pos) {
    spec.x = pos.x;
    if (pos.y !== undefined) spec.y = pos.y;
    spec.positionFrom = pos.source;
  }
  if (typeof n.opacity === "number" && n.opacity !== 1) spec.opacity = n.opacity;

  const own = drawnStateOf(n);
  if (own) { spec.drawnState = own.state; spec.drawnStateWhy = own.why; spec.drawnStateOwn = true; }
  else if (ctx.inheritedState) { spec.drawnState = ctx.inheritedState.state; spec.drawnStateWhy = `inside '${ctx.inheritedState.from}', which ${ctx.inheritedState.why}`; }

  // The token NAME, carried through for the report. A mismatch whose spec value is bound to a token is
  // a token bug, not a number bug, and that distinction is what tells a reader where to look.
  if (n.tokens && Object.keys(n.tokens).length) spec.tokens = n.tokens;
  if (ctx.frameId) spec.frameId = ctx.frameId;
  // Backward-compatible return: callers that only want the row get it; buildExpectation reads both.
  Object.defineProperty(spec, "__notComparable", { value: notComparable, enumerable: false });
  return { spec, notComparable };
}

// Which nodes are worth a row. Everything visible that CARRIES a checkable value — a node with no
// font, no fill, no radius, no layout and no stated position has nothing to be wrong about, and listing
// it would bury the rows that matter. A stated position counts: the pagination bar that rendered 130px
// below the frame carries nothing else (finding 164).
function checkable(spec: VerifySpec): boolean {
  return (["text", "placeholderText", "fontSize", "color", "backgroundColor", "fill", "borderRadius", "radiusCorners", "gap", "padding", "borderColor", "x"] as const).some((k) => spec[k] !== undefined);
}

const COORDINATES =
  "x/y are FRAME-RELATIVE: the node's page-space position minus the frame's own box.x/box.y. Measure " +
  "el.getBoundingClientRect() minus the rendered frame element's rect (the viewport origin when the frame " +
  "IS the page). A TEXT node's x is its INK start (the export's renderBox) — measure it with a Range over " +
  "the text and report it as textBox {x,w}. TEXT nodes carry no y (vertical ink depends on font metrics). " +
  "Auto-layout children carry no position (the export does not state one); their parent's is compared.";

// ts-port: legacy/producer-mismatch read kept as-is (item 3) — the older reaction shape (`action`
// singular, `trigger.type`, `on`) beside the producer's reactions[].actions[] + plain-string trigger.
type LegacyReaction = Omit<Reaction, "trigger"> & { trigger?: ReactionTrigger | { type?: string }; action?: Action; on?: string };

/** An expectation as READ BACK from disk (or built here): every field may be absent. */
export type Expectation = Partial<VerifyExpectation>;
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
/** buildExpectation()'s context beyond the screens: the export's pages/index.json layers (F-60), to tell an
 *  interaction whose destination was never exported. `sourceFile` = the index's own (a row's wins). */
export interface ExpectOptions { index?: { layers: IndexRow[]; sourceFile?: string } | null }

// F-104: the shape a sibling row is recognised by — the same component, or the same tree of node types.
function rowSignature(n: IrNode): string {
  const mc = n.type === "INSTANCE" ? n.mainComponent : undefined;
  if (mc) return `I:${mc.setKey || mc.key || mc.setName || mc.name || ""}`;
  return `${n.type}(${(Array.isArray(n.children) ? n.children : []).filter((c) => c && !c.hidden).map(rowSignature).join(",")})`;
}
// F-104: under every parent, >=3 visible children with one signature are sibling ROWS; a TEXT at the same
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

function buildExpectation(docs: ExpectInput[], opts?: ExpectOptions | null): BuiltExpectation {
  const nodes: VerifySpec[] = [];
  const instances: VerifyInstance[] = [];
  const interactions: VerifyInteraction[] = [];
  const notComparable: NotComparable[] = [];
  const hidden: { roots: Array<{ nodeId: string; name: string; path?: string }>; ids: string[]; specsSkipped: number; instancesSkipped: number; interactionsSkipped: number } =
    { roots: [], ids: [], specsSkipped: 0, instancesSkipped: 0, interactionsSkipped: 0 };
  const frames: Array<Partial<VerifyFrame>> = [];
  const seen = new Set<string>();
  let screen: string | undefined = undefined, exportedAt: string | undefined = undefined, reference: string | null = null;
  // F-60: every node id each Figma file's docs carry (ids are per FILE), and the file each interaction came from
  const idsByFile = new Map<string, Set<string>>();
  const interactionFile = new Map<VerifyInteraction, string | undefined>();
  const roots: IrNode[] = [];

  for (const { doc, label } of docs) {
    const exp = screenExportOf(doc);
    // (a screen export and a page-walk layer file both say which Figma file they came from; a bare node does not)
    const sf: unknown = doc && "sourceFile" in doc ? doc.sourceFile : exp ? exp.sourceFile : undefined;
    const sourceFile = typeof sf === "string" && sf ? sf : undefined;
    const fileIds = getOrInit(idsByFile, sourceFile ?? "", () => new Set<string>());
    if (!screen) screen = (exp && exp.screen) || label;
    if (!exportedAt) exportedAt = exp ? exp.exportedAt : undefined;
    for (const root of screenRoots(doc)) {
      if (!reference && root.reference) reference = root.reference;
      const b: Partial<Box> = root.box || {};
      const frame: Partial<VerifyFrame> = { nodeId: root.id, name: root.name, ...ifDefined("w", b.w), ...ifDefined("h", b.h), ...ifDefined("x", b.x), ...ifDefined("y", b.y), clip: root.clip === true };
      frames.push(frame);
      const frameId = frames.length > 1 ? root.id : undefined;
      const stateOf = new WeakMap<IrNode, InheritedState>(); // node -> inherited drawn-state { state, why, from }
      // node -> the ancestorIds its CHILDREN get: itself then its own ancestors (the frame root contributes none)
      const chainOf = new WeakMap<IrNode, string[]>();
      // F-61: a frame's fixed children (pinned while scrolling) and everything inside them. Figma keeps them "on
      // top of scrolling children" (plugin typings, numberOfFixedChildren) — the LAST N of children[], which is bottom-to-top.
      const fixedNodes = new WeakSet<IrNode>();
      roots.push(root);
      walkWithHidden(root, (n, c) => {
        if (n.id) fileIds.add(n.id);
        if (c.hidden) {
          // Counted, never specified. The ids travel with the expectation so --compare can say "you
          // drove a hidden layer" instead of crediting it (finding 187).
          if (!c.parentHidden) hidden.roots.push({ nodeId: n.id, name: n.name, path: c.path });
          if (n.id) hidden.ids.push(n.id);
          if (checkable(expectNode(n, { path: c.path }))) hidden.specsSkipped++;
          if (n.type === "INSTANCE" && n.mainComponent) hidden.instancesSkipped++;
          const reactions: LegacyReaction[] = Array.isArray(n.reactions) ? n.reactions : [];
          for (const r of reactions) hidden.interactionsSkipped += (Array.isArray(r.actions) ? r.actions : r.action ? [r.action] : []).filter((a) => a && (a.type || a.navigation)).length;
          return;
        }
        const inherited = c.parent ? stateOf.get(c.parent) : undefined;
        // Every ancestor of a visible node is visible (hidden is inherited), so this is the visible chain,
        // nearest first. The probe scopes a text match to a tagged ancestor with it (group 7); compare ignores it.
        const ancestorIds = c.parent ? chainOf.get(c.parent) ?? [] : [];
        chainOf.set(n, c.parent ? [...(n.id ? [n.id] : []), ...ancestorIds] : []);
        if (n.id && seen.has(n.id)) return;
        if (n.id) seen.add(n.id);
        const { spec, notComparable: gaps } = expectNodeRow(n, { path: c.path, frame, ...ifDefined("inheritedState", inherited), ...ifDefined("frameId", frameId) });
        spec.ancestorIds = ancestorIds;
        if (n.absolute) spec.absolute = true;
        const par = c.parent;
        const sibs = par && Array.isArray(par.children) ? par.children : [];
        const nFixed = par && typeof par.fixedChildren === "number" ? par.fixedChildren : 0;
        if (par && (fixedNodes.has(par) || (nFixed > 0 && sibs.indexOf(n) >= sibs.length - nFixed))) { fixedNodes.add(n); spec.fixed = true; }
        if (spec.drawnState) stateOf.set(n, inherited || { state: spec.drawnState, why: spec.drawnStateWhy || "", from: n.name || n.id });
        if (checkable(spec)) nodes.push(spec);
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
        // whole IR (finding 70) and the one nothing verified (finding 80). The real shape is
        // `reactions[].actions[]` (plural on both), with `trigger` a plain string — see
        // figma-plugin/src/prototype.ts. A singular `action` is accepted too so an older export still
        // yields interactions rather than silently producing none.
        const reactions: LegacyReaction[] = Array.isArray(n.reactions) ? n.reactions : [];
        for (const r of reactions) {
          const actions = Array.isArray(r.actions) ? r.actions : r.action ? [r.action] : [];
          const trigger = (r.trigger && (typeof r.trigger === "object" ? r.trigger.type || r.trigger : r.trigger)) || r.on || "on_click";
          for (const a of actions) {
            if (!a || !(a.type || a.navigation)) continue;
            const row: VerifyInteraction = {
              nodeId: n.id,
              name: n.name,
              trigger: String(trigger).toLowerCase(),
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

  // F-104: repeated placeholder copy in sibling rows
  const specById = new Map(nodes.map((s) => [s.nodeId, s]));
  for (const r of roots) markRepeatedText(r, specById);

  // F-60 / D22: a destination that is no node of the export FOR THE SAME FIGMA FILE was never designed here.
  // Figma node ids are per file — a join across files would match unrelated nodes. Decided only when every
  // index row resolves to ONE answer for its file: all rows name a file (a screen that names its file is looked
  // up among that file's rows), or none does (an export written before the bridge stamped sourceFile, as every
  // field-test export was: one unnamed file, matched only by a screen that names none). And the index must
  // cover this screen — one of its rows is a node of this export, in the same file — or an index of another
  // file would call every destination "never exported". Otherwise the row is left as it was (graded as before).
  const index = opts && opts.index;
  const rowFile = (l: IndexRow): string | undefined => l.sourceFile ?? index?.sourceFile;
  const named = index ? index.layers.filter((l) => !!rowFile(l)).length : 0;
  const consistent = !!index && (named === 0 || named === index.layers.length);
  if (index && consistent) {
    for (const row of interactions) {
      const file = interactionFile.get(row);
      if (!row.destinationId || file === undefined || (file === "") !== (named === 0)) continue;
      const known = idsByFile.get(file);
      if (known && known.has(row.destinationId)) continue;
      const ofFile = index.layers.filter((l) => (rowFile(l) ?? "") === file);
      if (!known || !ofFile.some((l) => known.has(l.id))) continue; // the index does not cover this screen
      if (!ofFile.some((l) => l.id === row.destinationId)) row.destinationExported = false;
    }
  }

  const f0: Partial<VerifyFrame> = frames[0] || {};
  // expectation.frame / frames[] row: the frame's id, name, size and clip (no x/y)
  const rootFrame = (f: Partial<VerifyFrame>): Partial<VerifyRootFrame> => ({ ...ifDefined("nodeId", f.nodeId), ...ifDefined("name", f.name), ...ifDefined("w", f.w), ...ifDefined("h", f.h), ...ifDefined("clip", f.clip) });
  return {
    schema: EXPECTATION_SCHEMA,
    ...ifDefined("screen", screen),
    ...ifDefined("exportedAt", exportedAt),
    // P2b round 2 (finding 314): the design's identity without the pull's timestamps, so a no-change
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
  };
}

// ---------------------------------------------------------------- the comparison
//
// The CANONICAL measured keys. A probe that names a field differently is not silently skipped any
// more: a key in FIELDS that is present in zero measurements is printed in the headline, and keys this
// file does not read are listed (finding 182 — a probe wrote `radius`, the comparer read
// `borderRadius`, and a whole category of values passed untested for a phase).
const KNOWN_MEASURED_KEYS = new Set([
  "nodeId", "styles", "states", "matchedBy", "note", "notes", "selector", "selectorCount", "unmeasured", "textFrom", "textFromMixed", "fillSource",
  "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "color", "backgroundColor", "fill", "borderColor",
  "borderWidth", "borderRadius", "gap", "gapVisual", "width", "height", "x", "y", "opacity", "padding", "text",
  "placeholderText", "placeholderColor", "tag", "textBox", "display", "transform", "rotate", "visible",
]);
// Suggestions only — the key is NEVER silently accepted (design note: a wrong key must be loud).
const KEY_HINTS: Record<string, string> = { radius: "borderRadius", borderTopLeftRadius: "borderRadius", background: "backgroundColor", bg: "backgroundColor", w: "width", h: "height", svgFill: "fill", placeholder: "placeholderText", rowGap: "gapVisual", columnGap: "gap" };

/** The spec fields compared one-to-one against a measured style of the same name. */
type FieldKey = "fontFamily" | "fontSize" | "fontWeight" | "lineHeight" | "letterSpacing" | "color" | "backgroundColor" | "fill" | "placeholderColor"
  | "borderColor" | "borderWidth" | "borderRadius" | "gap" | "width" | "height" | "x" | "y" | "opacity";
interface Field { key: FieldKey; tol: number | null; norm?: (v: unknown) => string | number | null; label: string; unit?: string; high?: boolean; colour?: boolean; box?: boolean; optional?: boolean }

const FIELDS: Field[] = [
  { key: "fontFamily", tol: null, norm: normFamily, label: "font-family" },
  { key: "fontSize", tol: TOLERANCE.fontSize, label: "font-size", unit: "px", high: true },
  { key: "fontWeight", tol: TOLERANCE.fontWeight, norm: normWeight, label: "font-weight", high: true },
  { key: "lineHeight", tol: TOLERANCE.lineHeight, label: "line-height", unit: "px" },
  { key: "letterSpacing", tol: TOLERANCE.letterSpacing, label: "letter-spacing", unit: "px" },
  { key: "color", tol: null, norm: normColor, label: "color", high: true, colour: true },
  { key: "backgroundColor", tol: null, norm: normColor, label: "background", high: true, colour: true },
  { key: "fill", tol: null, norm: normColor, label: "fill (SVG paint)", high: true, colour: true },
  { key: "placeholderColor", tol: null, norm: normColor, label: "placeholder colour", high: true, colour: true, optional: true },
  { key: "borderColor", tol: null, norm: normColor, label: "border-color", colour: true },
  { key: "borderWidth", tol: TOLERANCE.padding, label: "border-width", unit: "px" },
  { key: "borderRadius", tol: TOLERANCE.radius, label: "border-radius", unit: "px" },
  { key: "gap", tol: TOLERANCE.gap, label: "gap", unit: "px" },
  { key: "width", tol: TOLERANCE.size, label: "width", unit: "px", box: true },
  { key: "height", tol: TOLERANCE.size, label: "height", unit: "px", box: true },
  { key: "x", tol: TOLERANCE.position, label: "x (frame-relative)", unit: "px", box: true },
  { key: "y", tol: TOLERANCE.position, label: "y (frame-relative)", unit: "px", box: true },
  { key: "opacity", tol: TOLERANCE.opacity, label: "opacity" },
];

// Every key a measured node's `styles` carries — the FIELDS compared one-to-one, plus the keys compared
// their own way. Exported: the shipped probe (verify-probe.ts) measures exactly these, and MEASURED_KEYS_DOC's
// styles line is generated from it.
const STYLE_KEYS: readonly string[] = [...FIELDS.map((f) => f.key), "padding", "gapVisual", "text", "tag", "textBox", "placeholderText"];
const STYLE_KEY_SHAPE: Record<string, string> = {
  borderRadius: "number | [tl,tr,br,bl]", padding: "[t,r,b,l]", fill: "an SVG's paint", textBox: "{x,w} of a Range over the text",
  placeholderText: "el.placeholder", placeholderColor: "the ::placeholder colour", tag: "tagName, lower-case",
};

const MEASURED_KEYS_DOC: Record<string, string> = {
  "nodes[].nodeId": "the Figma node id the measurement is FOR (from data-dt-node, or matched by text/position)",
  // GENERATED from STYLE_KEYS, so the list a probe is told to send cannot drift from the list compared (DT-23: `fill` was missing)
  "nodes[].styles": `computed values, EVERY key on every node — lengths as px numbers (a "20px" string is read as 20; %, other units and keywords are not) — (null when it cannot be read, with the reason under unmeasured): ${STYLE_KEYS.map((k) => k + (STYLE_KEY_SHAPE[k] ? ` (${STYLE_KEY_SHAPE[k]})` : "")).join(" ")}`,
  "nodes[].unmeasured": "{<styles key>: why} for every styles key reported null — a null is listed as not measured, never as checked",
  "nodes[].styles.fill": "an SVG's paint: getComputedStyle(<path|rect|circle>).fill — never background-color",
  "nodes[].styles.textBox": "{x,w} of a Range over a TEXT node's characters, frame-relative — required when the id sits on a padded container (<th>, <button>, <label>)",
  "nodes[].styles.gapVisual": "the rendered distance between consecutive children — required for a <table> (border-spacing, not gap)",
  "nodes[].styles.placeholderText / placeholderColor": "el.placeholder / the ::placeholder colour (getComputedStyle(el,'::placeholder').color or the stylesheet rule)",
  "nodes[].styles.tag": "the element's tagName, lower-case",
  "nodes[].states.<hover|pressed|focus>": "the same styles, measured WITH the element in that state — required for a node whose spec has drawnState",
  "interactions[]": "{nodeId, trigger, ok: true|false|null, selector, selectorCount, detail} — `ok:true` needs the selector you drove and how many elements it matched (>=1); ok:null = not probed",
  "components[]": "{setName|nodeId, present: true|false} — present:false is an explicit claim of absence",
  "notMeasured[]": "{nodeId, why} for every spec the probe could not find — the one top-level key for it (not notFound/notFoundInDom); other unknown top-level keys are listed in the report",
  "expectationSha256": "sha256 of the .expected.json you measured against",
};

// Which variable a delta is about. It used to be `Object.values(spec.tokens)[0]` whatever the field,
// so a background delta read `token: "Space 4"` (findings 98/160).
const TOKEN_KEYS: Record<string, string[]> = {
  color: ["fills", "color"], backgroundColor: ["fills"], fill: ["fills"], placeholderColor: ["fills"],
  borderColor: ["strokes"], borderWidth: ["strokeWeight", "strokeTopWeight"],
  fontSize: ["fontSize"], fontWeight: ["fontWeight"], fontFamily: ["fontFamily"], lineHeight: ["lineHeight"], letterSpacing: ["letterSpacing"],
  gap: ["itemSpacing", "gap"], width: ["width", "minWidth"], height: ["height", "minHeight"], opacity: ["opacity"],
  padding: ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"],
  "radius.tl": ["topLeftRadius"], "radius.tr": ["topRightRadius"], "radius.br": ["bottomRightRadius"], "radius.bl": ["bottomLeftRadius"],
  borderRadius: ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius", "cornerRadius"],
};
function tokenFor(spec: VerifySpec | null | undefined, key: string): string | undefined {
  const t = spec && spec.tokens;
  if (!t) return undefined;
  const names = [...new Set((TOKEN_KEYS[key] || []).map((k) => t[k]).filter((v): v is string => typeof v === "string"))];
  return names.length ? names.join(" / ") : undefined;
}

/** A mismatch: the (normalised) expected and actual values, and the numeric distance when there is one. */
interface Bad { want: JsonValue; got: JsonValue; delta: number | null }

function compareField(f: Field, want: JsonValue | undefined, got: JsonValue | undefined): Bad | null {
  const nw = f.norm ? f.norm(want) : want;
  const ng = f.norm ? f.norm(got) : got;
  // One side cannot be known after normalising (an unknown weight name, `line-height: normal`) — not a
  // mismatch. A RAW null from the probe never gets here: compare() lists it under fieldsNotMeasured first (DT-43).
  if (nw == null || ng == null) return null;
  if (f.tol == null) return nw === ng ? null : { want: nw, got: ng, delta: null };
  const a = Number(nw), b = Number(ng);
  if (Number.isNaN(a) || Number.isNaN(b)) return nw === ng ? null : { want: nw, got: ng, delta: null };
  const delta = Math.abs(a - b);
  return delta <= f.tol ? null : { want: a, got: b, delta: Number(delta.toFixed(3)) };
}

function comparePadding(want: unknown, got: readonly number[]): Bad | null {
  // (compare() hands over four px numbers — a null or unreadable side is listed as not measured first, DT-43/DT-42)
  if (!Array.isArray(want)) return null;
  const w: number[] = want.map(Number);
  if (w.some(Number.isNaN)) return null;
  const worst = Math.max(...w.map((v, i) => Math.abs(v - (got[i] ?? 0))));
  return worst <= TOLERANCE.padding ? null : { want: w, got: [...got], delta: Number(worst.toFixed(3)) };
}

// A measured radius as four corners [tl,tr,br,bl]: a number, a list of numbers or px strings
// (["8px","8px","8px","8px"] — DT-46: each item used to go through Number() and fail), or a CSS shorthand
// string. A percentage or an elliptical "8px / 4px" is not a px radius here (the shipped probe resolves %).
function radiusCorners(v: unknown): [number, number, number, number] | null {
  return v == null ? null : fourSides(v);
}
// CSS clamps a radius at half the shorter side, and so does Figma: `radius: 500` on a 36px box and
// `rounded-full` (33554400px) are both a circle (finding 194). Compare the radius each side can ACTUALLY
// draw, not the number either side stored.
const clampRadius = (r: number, w: unknown, h: unknown): number => (num(w) && num(h) && w > 0 && h > 0 ? Math.min(r, Math.min(w, h) / 2) : r);

const TABLE_TAGS = new Set(["table", "thead", "tbody", "tfoot", "tr"]);
// A TEXT node's id on an element that is NOT the text's own box (a <th> with padding, a <button>,
// a <label>) — its width/height/x describe the container, not the text (finding 194: `height 24 → 56`
// on a Status header that is typographically exact).
const CONTAINER_TAGS = new Set(["th", "td", "tr", "button", "label", "li", "a", "section", "article", "header", "footer", "nav", "table", "input"]);
// The mirror image (finding 170): a FRAME/INSTANCE id spread (by a `...rest` prop) onto a LEAF element
// inside the one that implements it — an <input> inside the <label> that draws the field. The leaf's
// box, fill, border and padding are not the container's, so they are not graded as such.
const LEAF_TAGS = new Set(["input", "textarea", "select", "img", "svg", "path", "video", "canvas"]);
const CONTAINER_TYPES = new Set<string>(["FRAME", "INSTANCE", "COMPONENT", "GROUP", "SECTION"]);
// Elements whose paint is pixels (F-81): an <img src="icon.svg"> is an isolated image document, so no computed
// style on it carries the SVG's fill — `fill` on the <img> is the inherited default, black. Such a spec's
// fill is unverifiable by this method, never a mismatch and never "not measured".
const PIXEL_TAGS = new Set(["img", "picture", "canvas", "object", "embed"]);
// Lengths CSS cannot make negative (F-93): a negative one is a measuring artefact (a gap read across children
// that are not laid out in one line, rows in different columns), listed as not measured — never compared.
const NON_NEGATIVE = new Set<string>(["fontSize", "lineHeight", "borderWidth", "gap", "width", "height", "opacity"]);
const LEAF_FIELDS = new Set<string>(["width", "height", "x", "y", "backgroundColor", "borderColor", "borderWidth", "borderRadius", "gap"]);
const isContainer = (got: MeasuredStyles): boolean => !!((got.tag && CONTAINER_TAGS.has(String(got.tag).toLowerCase())) || (Array.isArray(got.padding) && got.padding.some((v) => (cssPx(v) ?? 0) > 0)));

const LIMITS = [
  "::before/::after content and any other pseudo-element are invisible to a computed-style probe; the export cannot say which layers a build draws that way, so they are compared only if the probe reports them under the node's id.",
  "::placeholder colour is compared only when the probe reports placeholderColor (getComputedStyle(el,'::placeholder') or the stylesheet rule); otherwise it is listed under `unverifiable`, never passed.",
  "A rotation applied with the CSS `rotate` property reads `transform: none` (Tailwind v4 `rotate-180`) — read `rotate` too before calling a rotation missing (finding 198).",
  "An icon drawn by an <img> (or <canvas>, <object>) has no readable fill: the SVG inside is a separate document, so its fill is listed under `unverifiable` — compare the asset file instead.",
  "Numbers are read as px: a number or a px string (\"20px\"). A percentage, another unit or a keyword (other than letter-spacing: normal = 0) is listed as not measured; so is a value CSS cannot produce (a negative gap, padding or size).",
  "Positions are compared only where the export states one (absolute layers, render/ink boxes); auto-layout children are placed by their parent, whose position is compared.",
];

/** compare()'s options — the evidence the CLI ties the report to. `components` = the --interactions file's
 *  components[] (the agent's present:false claims), merged with measured.json's. `against` = the previous
 *  round's report (D18: the one about to be overwritten, or --against), for a coverage comparison only. */
export interface CompareOptions {
  interactions?: InteractionEvidence[] | null; components?: MeasuredComponent[] | null; expectationSha256?: string; measuredSha256?: string;
  artifactCheck?: ArtifactCheck[] | null; code?: CodeInputs; against?: { file: string; report: VerifyReport } | null;
  /** what readableMeasured() dropped from the measured file (malformed optional extras) — reported, never judged */
  inputNotes?: string[] | null;
  /** D5: the plan's waivers[] — a matching delta is accepted (still listed, out of the counts) */
  waivers?: PlanWaiver[] | null;
  /** D20: the plan's descopes[] — a matching interaction is removed from the graded set */
  descopes?: PlanDescope[] | null;
  /** F-77: the plan's anchors{} — `foldedInto` takes a layout-only wrapper out of the denominator */
  anchors?: Record<string, PlanAnchor> | null;
  /** recorded as report.inputs.waivers: the plan file and waiversHash() of it */
  waiversInput?: { plan: string; sha256: string } | null;
}

// ---- D5 waivers: does a waiver's recorded value still describe this round's delta?
/** The slack a waiver's designed/built values are matched with — the field's own tolerance (null = exact). */
function fieldTolerance(label: string): number | null {
  const f = FIELDS.find((x) => x.label === label);
  if (f) return f.tol;
  if (label === "padding") return TOLERANCE.padding;
  if (label.startsWith("border-radius (")) return TOLERANCE.radius;
  if (label === "placement") return TOLERANCE.position;
  return null;
}
const NUM_IN_TEXT = /-?\d+(?:\.\d+)?/g;
/** Equal within `tol`: numbers by distance, lists item by item, strings exactly — or, with a tolerance, with
 *  every number in them within it (a placement actual "bottom edge at y=1450 in a 900-high frame"). */
function sameWithin(a: JsonValue, b: JsonValue, tol: number | null): boolean {
  const t = tol ?? 0;
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= t + 1e-9;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => { const y = b[i]; return y !== undefined && sameWithin(x, y, tol); });
  if (typeof a === "string" && typeof b === "string") {
    if (tol == null) return a.trim() === b.trim();
    if (a.replace(NUM_IN_TEXT, "#") !== b.replace(NUM_IN_TEXT, "#")) return false;
    const na = a.match(NUM_IN_TEXT) || [], nb = b.match(NUM_IN_TEXT) || [];
    return na.length === nb.length && na.every((x, i) => Math.abs(Number(x) - Number(nb[i])) <= t + 1e-9);
  }
  return JSON.stringify(a) === JSON.stringify(b);
}
// F-77: what makes a spec more than a layout wrapper — it paints or carries copy, so it is built, never folded.
const PAINT_KEYS = ["decorated", "text", "placeholderText", "fontSize", "color", "backgroundColor", "fill", "borderColor", "borderWidth", "borderWidths", "borderRadius", "radiusCorners", "opacity"] as const;
const paintOf = (s: VerifySpec): string[] => PAINT_KEYS.filter((k) => s[k] !== undefined);

// How the probe found each measured spec (coverage.matchedBy). The shipped probe writes the first six
// values; a hand-written probe wrote free text ("data-dt-node" is its spelling of a tag match), which is
// counted as `other`, and a node that does not say is `unstated`. `sharedComponentPath` is compare's own
// fallback (a measurement found under another screen's instance path).
const MATCH_BUCKET: Record<string, string> = {
  tag: "tag", "data-dt-node": "tag", "tag-shared-path": "tagSharedPath", text: "text", "text-ordinal": "textOrdinal", position: "position", frame: "frame",
};
const MATCH_BUCKETS = ["tag", "tagSharedPath", "text", "textOrdinal", "position", "frame", "sharedComponentPath", "other", "unstated"] as const;
const MATCH_LABEL: Record<string, string> = {
  tag: "tag", tagSharedPath: "shared path", text: "text", textOrdinal: "ordinal", position: "position", frame: "frame",
  sharedComponentPath: "shared component path", other: "other", unstated: "unstated",
};
// A TEXT spec's typography read off one of these without the probe naming the text run (textFrom) is the
// container's font, not the text's (F-71: a 500-weight <button> around a 400-weight <span>).
const TYPO_FIELDS = new Set<string>(["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "color"]);

const SEVERITY_RANK: Record<DeltaSeverity, number> = { high: 0, medium: 1, low: 2 };
const NEVER_MEASURED_HEADLINE_MIN = 2;

// Every top-level key of a measured file (F-94). Typed against VerifyMeasured, so a key added to the type
// must be added here; any other key is listed in report.probe.unknownTopLevelKeys, never silently read.
const MEASURED_TOP_KEYS = {
  measuredAt: true, renderer: true, viewport: true, theme: true, artifacts: true, expectationSha256: true, mode: true, reason: true,
  nodes: true, components: true, interactions: true, consoleErrors: true, notMeasured: true, componentsMissing: true, probe: true,
  frame: true, frames: true, navigation: true, matchedByCensus: true, notes: true,
} as const satisfies Record<keyof VerifyMeasured, true>;
const TOP_KEY_HINTS: Record<string, string> = { notFound: "notMeasured", notFoundInDom: "notMeasured", notMeasuredByProbe: "notMeasured", missing: "notMeasured", measurements: "nodes", elements: "nodes" };

/**
 * compare(expectation, measured, opts?) -> report.
 * opts: { interactions: [...] extra interaction evidence (the --interactions file),
 *         expectationSha256, measuredSha256, artifactCheck: [{path, exists, image}] }
 */
function compare(expectation: Expectation, measured: VerifyMeasured | null | undefined, opts?: CompareOptions | null): VerifyReportV2 {
  opts = opts || {};
  measured = measured || {};
  const hiddenSet = new Set(((expectation.hidden && expectation.hidden.ids) || []).map(String));
  const legacy = expectation.schema !== EXPECTATION_SCHEMA;
  const specs = (expectation.nodes || []).filter((s) => !hiddenSet.has(String(s.nodeId)));
  const frameOf = (spec: VerifySpec): Partial<VerifyRootFrame> => (spec.frameId && (expectation.frames || []).find((f) => f.nodeId === spec.frameId)) || expectation.frame || {};

  // ---- index the measurements (first one wins; duplicates are counted, not silently merged)
  const byId = new Map<string, MeasuredNode>();
  let duplicateNodeIds = 0;
  const unknownKeys = new Map<string, number>();
  const keysSeen = new Set<string>(); // every styles key any measured node carries
  for (const m of measured.nodes || []) {
    if (!m || m.nodeId == null) continue;
    const id = String(m.nodeId);
    if (byId.has(id)) { duplicateNodeIds++; continue; }
    byId.set(id, m);
    const s = m.styles || m;
    for (const k of Object.keys(s)) { keysSeen.add(k); if (!KNOWN_MEASURED_KEYS.has(k)) unknownKeys.set(k, (unknownKeys.get(k) || 0) + 1); }
  }
  // A shared implementation (one AppShell rendered on two routes) carries the node ids of the frame it
  // was built from: `I10970:111588;1910:23337` on Job Roles is `I10970:109860;1910:23337` here — the
  // same component-internal node under a different outer instance (findings 129/139/185). Match on
  // that internal path when it is unambiguous, and say so.
  const expectedIds = new Set([...specs.map((s) => String(s.nodeId)), ...(expectation.instances || []).map((i) => String(i.nodeId))]);
  const suffix = (id: string): string | null => { const i = id.indexOf(";"); return i === -1 ? null : id.slice(i + 1); };
  const foreignBySuffix = new Map<string, string[]>();
  for (const id of byId.keys()) {
    if (expectedIds.has(id) || hiddenSet.has(id)) continue;
    const sfx = suffix(id);
    if (sfx) foreignBySuffix.set(sfx, (foreignBySuffix.get(sfx) || []).concat(id));
  }
  const viaSharedPath = (id: string): string | null => { const sfx = suffix(String(id)); const c = sfx && foreignBySuffix.get(sfx); const only = c && c.length === 1 ? c[0] : undefined; return only ?? null; };
  // The probe's own reason for a spec it could not match (measured.notMeasured[]: {nodeId, why} from the
  // shipped probe; a hand-written probe wrote {nodeId, reason} or a bare id).
  const probeWhy = new Map<string, string>();
  for (const e of Array.isArray(measured.notMeasured) ? measured.notMeasured : []) {
    const row: unknown = e;
    if (!isJsonObject(row) || typeof row.nodeId !== "string") continue;
    const w = typeof row.why === "string" ? row.why : typeof row.reason === "string" ? row.reason : undefined;
    if (w && !probeWhy.has(row.nodeId)) probeWhy.set(row.nodeId, w);
  }

  const deltas: VerifyDelta[] = [];
  const notMeasured: VerifyReportV2["notMeasured"] = []; // node specs with NO measurement at all — one row per node, never per field
  const fieldsNotMeasured: VerifyReportV2["fieldsNotMeasured"] = []; // a measured node missing a field the spec states
  const unverifiable: VerifyReportV2["unverifiable"] = []; // values the method cannot read unless the probe goes out of its way
  const census = new Map<string, { expected: number; present: number }>(); // field -> { expected, present } over MEASURED nodes
  const tally = (key: string, present: boolean): void => { const c = census.get(key) || { expected: 0, present: 0 }; c.expected++; if (present) c.present++; census.set(key, c); };
  let fieldsChecked = 0, nodesMeasured = 0, nodesMatchedByComponentPath = 0, fieldsReportedNull = 0;
  const matchedByCensus: Record<string, number> = Object.fromEntries(MATCH_BUCKETS.map((b) => [b, 0]));
  const positionMatched = new Set<string>(); // spec ids matched by position: their deltas are low-confidence
  const typographyOn = new Map<string, string>(); // TEXT spec id -> the container tag its typography was read from
  const gap = (spec: VerifySpec, field: string, why: string): number => fieldsNotMeasured.push({ nodeId: spec.nodeId, name: spec.name, field, why });
  const push = (spec: VerifySpec, field: string, severity: DeltaSeverity, bad: Bad, extra?: Partial<VerifyDelta>): number => deltas.push(Object.assign({
    severity, nodeId: spec.nodeId, name: spec.name, ...ifDefined("path", spec.path), field,
    expected: bad.want, actual: bad.got, delta: bad.delta,
  }, extra));

  // F-77: plan anchors that fold a layout-only wrapper into a measured ancestor
  const anchors = opts.anchors && isJsonObject(opts.anchors) ? opts.anchors : {};
  const folded: VerifyReportV2["folded"] = [];
  const probeFrames: ProbeFrame[] = [...(Array.isArray(measured.frames) ? measured.frames : []), ...(measured.frame ? [measured.frame] : [])];
  const multiFrame = (expectation.frames || []).length > 1;
  const frameMeasured = (id: string): boolean => probeFrames.some((f) => f.nodeId === id);
  // F-104: the BUILD's texts per repeated-text group — varied texts are real data, one text for all is a copy bug
  const builtTexts = new Map<string, string[]>();
  for (const s of specs) {
    if (!s.repeatedTextGroup) continue;
    const mm = byId.get(String(s.nodeId));
    const t = mm ? (mm.styles || mm).text : undefined;
    if (typeof t === "string") getOrInit(builtTexts, s.repeatedTextGroup, () => []).push(t.replace(/\u00a0/g, " ").trim());
  }

  for (const spec of specs) {
    let m = byId.get(String(spec.nodeId));
    let matchedBy: string | null = m ? m.matchedBy || "id" : null;
    if (!m) {
      const alt = viaSharedPath(spec.nodeId);
      if (alt) { m = byId.get(alt); matchedBy = `shared-component-path (${alt})`; nodesMatchedByComponentPath++; }
    }
    if (!m) {
      let why = probeWhy.get(String(spec.nodeId)) ?? "no measurement for this node id";
      const anchor = anchors[spec.nodeId];
      const into = anchor && typeof anchor.foldedInto === "string" && anchor.foldedInto.trim() ? anchor.foldedInto.trim() : null;
      const paint = paintOf(spec);
      const frameId = frameOf(spec).nodeId;
      if (into) {
        // Folding is a CLAIM, checked: only a wrapper with nothing to paint, folded into its own measured ancestor.
        const refuse = paint.length ? `it states ${paint.join("/")} — a node that paints or carries copy is built, never folded`
          : !((spec.ancestorIds || []).includes(into) || into === frameId) ? `${into} is not an ancestor of this node in the export`
          : !(byId.has(into) || viaSharedPath(into) || frameMeasured(into)) ? `${into} was not measured, so nothing stands in for this node`
          : null;
        if (!refuse) {
          folded.push({ nodeId: spec.nodeId, name: spec.name, into, why: `plan anchor foldedInto ${into}: a layout-only wrapper the build merged into that measured ancestor` });
          continue;
        }
        why += ` — plan anchor foldedInto ${into} refused: ${refuse}`;
      } else if (!paint.length) {
        const parent = (spec.ancestorIds || [])[0] ?? frameId;
        why += ` — foldable (no paint — anchor it foldedInto its parent${parent ? ` ${parent}` : ""} if the build merged it there)`;
      }
      notMeasured.push({ nodeId: spec.nodeId, name: spec.name, ...ifDefined("path", spec.path), why });
      continue;
    }
    nodesMeasured++;
    const rawMatch = typeof m.matchedBy === "string" ? m.matchedBy : "";
    const bucket = matchedBy && matchedBy.startsWith("shared-component-path") ? "sharedComponentPath" : rawMatch === "" ? "unstated" : MATCH_BUCKET[rawMatch] ?? "other";
    matchedByCensus[bucket] = (matchedByCensus[bucket] ?? 0) + 1;
    if (/^position/i.test(rawMatch)) positionMatched.add(String(spec.nodeId));
    // DT-43: a null is the probe saying "I could not read this" — listed as not measured with its reason
    // (the shipped probe's unmeasured[key]), never compared, never counted as checked.
    const base: MeasuredStyles = m.styles || m;
    let got: MeasuredStyles = base, measuredIn = "rest";
    const state = spec.drawnState;
    const st = state && m.states && m.states[state];
    // A null in the state's styles OVERRIDES the resting value (Object.assign copies it): the hovered value
    // could not be read, and the resting one is not a stand-in for it.
    if (st) { got = Object.assign({}, base, st.styles || st); measuredIn = state; }
    // The state row's own reasons (states.<s>.unmeasured) win over the node's for a value measured in that state.
    const stUm: unknown = st ? st.unmeasured : undefined;
    const um: Record<string, string> = { ...(isJsonObject(m.unmeasured) ? m.unmeasured : {}), ...(isJsonObject(stUm) ? Object.fromEntries(Object.entries(stUm).filter((e): e is [string, string] => typeof e[1] === "string")) : {}) };
    const nullWhy = (...keys: string[]): string => { for (const k of keys) { const w = um[k]; if (typeof w === "string" && w) return w; } return "reported null"; };
    const gapNull = (field: string, ...keys: string[]): void => { fieldsReportedNull++; gap(spec, field, nullWhy(...keys)); };
    const zeroAtRest = num(base.width) && num(base.height) && base.width === 0 && base.height === 0;
    const stateWhy = state ? `the designer drew this ${spec.drawnStateOwn ? "layer" : "layer's container"} in its ${state} state (${spec.drawnStateWhy}) — measure it ${state === "hover" ? "hovered" : state} and report the values under states.${state}` : "";

    // Hover-only content measured at rest is absent by design, not missing (finding 128/194: the
    // edit button that exists only on the hovered row, "36 → 0").
    if (state && measuredIn === "rest" && zeroAtRest) {
      for (const f of FIELDS) if (spec[f.key] !== undefined) { tally(f.key, false); gap(spec, f.label, `renders 0×0 at rest: ${stateWhy}`); }
      continue;
    }
    const isText = spec.type === "TEXT";
    const container = isText && isContainer(got);
    const tb = got.textBox && typeof got.textBox === "object" ? got.textBox : null;
    const tagLc = typeof got.tag === "string" ? got.tag.toLowerCase() : "";
    if (isText && tagLc && (CONTAINER_TAGS.has(tagLc) || tagLc === "div") && m.textFrom === undefined) typographyOn.set(String(spec.nodeId), tagLc);
    const table = got.tag && TABLE_TAGS.has(String(got.tag).toLowerCase());
    const onLeaf = !!(CONTAINER_TYPES.has(spec.type) && got.tag && LEAF_TAGS.has(String(got.tag).toLowerCase()));
    const leafWhy = onLeaf ? `this ${spec.type}'s id sits on a leaf <${String(got.tag).toLowerCase()}> inside the element that implements it (a ...rest spread?) — tag and measure the container` : "";

    for (const f of FIELDS) {
      const want0 = spec[f.key];
      if (want0 === undefined) continue;
      let val: JsonValue | undefined = got[f.key];
      let nullKeys: string[] = [f.key];
      let present = val !== undefined;
      if (isText && tb && (f.key === "x" || f.key === "width")) { val = f.key === "x" ? tb.x : tb.w; present = val !== undefined; nullKeys = ["textBox", f.key]; }
      // gapVisual wins when it holds a value; the shipped probe sends every key, so a null gapVisual (not a
      // table) must not hide a measured gap.
      if (f.key === "gap" && got.gapVisual !== undefined && (got.gapVisual !== null || val == null)) { val = got.gapVisual; present = true; nullKeys = ["gapVisual", "gap"]; }
      if (f.key === "fill" && (PIXEL_TAGS.has(tagLc) || m.fillSource === "img")) {
        unverifiable.push({ nodeId: spec.nodeId, name: spec.name, field: f.label, expected: want0, why: `drawn by an <${PIXEL_TAGS.has(tagLc) ? tagLc : "img"}>: its paint is pixels, not a CSS property — the SVG's own fill cannot be read from the element's computed style` });
        continue;
      }
      tally(f.key, present);

      if (state && measuredIn === "rest" && spec.drawnStateOwn && f.colour) { gap(spec, f.label, stateWhy); continue; }
      if (onLeaf && LEAF_FIELDS.has(f.key)) { gap(spec, f.label, leafWhy); continue; }
      if (isText && f.box && container && !tb) {
        if (got.textBox === null && f.key !== "height") { gapNull(f.label, "textBox"); continue; }
        gap(spec, f.label, `this TEXT node's id sits on a <${got.tag || "container"}>${Array.isArray(got.padding) && got.padding.some((v) => (cssPx(v) ?? 0) > 0) ? " with padding" : ""}, whose box is not the text's — report textBox (a Range over the text) instead`);
        continue;
      }
      if (isText && tb && f.key === "height") { continue; } // a Range's height is the font's content area, not the line box
      if (f.key === "gap" && table && got.gapVisual == null) {
        if (got.gapVisual === null) { gapNull(f.label, "gapVisual"); continue; }
        gap(spec, f.label, `the element is a <${got.tag}>, which spaces rows with border-spacing, not gap — report gapVisual (the distance between consecutive rows)`);
        continue;
      }
      if (val === undefined) {
        if (f.optional) { unverifiable.push({ nodeId: spec.nodeId, name: spec.name, field: f.label, expected: want0, why: "a ::placeholder colour is not readable from getComputedStyle(el) — report placeholderColor to have it checked" }); continue; }
        gap(spec, f.label, "the probe did not report this property");
        continue;
      }
      if (val === null || (Array.isArray(val) && val.includes(null))) { gapNull(f.label, ...nullKeys); continue; }
      // A measured value the normaliser cannot read (fontWeight "bolder", an object) is not measured — never
      // "cannot be known, so no mismatch" (that allowance is for the spec side only; DT-43).
      if (f.norm && (f.norm(val) == null || (typeof val !== "string" && typeof val !== "number"))) { gap(spec, f.label, `could not read '${typeof val === "string" ? val : JSON.stringify(val)}' as ${f.label}`); continue; }
      // A numeric field reads a number or a px string (DT-42) — the delta then carries the number, so the
      // report never prints "28pxpx" (DT-32). `letter-spacing: normal` is 0; any other keyword, unit or shape
      // is not a px value and is listed as not measured, never compared as a string.
      if (f.tol != null && !f.norm && f.key !== "borderRadius") {
        // `gap: normal` is 0 in flex and grid (the only layouts it applies to); without `display` it is unknown
        const flexOrGrid = typeof got.display === "string" && /(^|-)(flex|grid)$/.test(got.display.trim());
        const n = val === "normal" && (f.key === "letterSpacing" || (f.key === "gap" && flexOrGrid)) ? 0 : cssPx(val);
        if (n === null) {
          const kw = val !== "normal" ? "" : f.key === "gap" ? " (0 in flex/grid, not applicable in block layout — report display, or a number)" : " (its px value depends on the font's metrics)";
          gap(spec, f.label, `could not read '${typeof val === "string" ? val : JSON.stringify(val)}' as a px number${kw}`);
          continue;
        }
        const box = Math.max(cssPx(got.width) ?? 0, cssPx(got.height) ?? 0);
        // (a negative design gap — overlapping avatars — may render as a negative distance; a computed CSS gap
        // is a real value, so only a rendered distance, gapVisual, is bounded by the element's box)
        const why = NON_NEGATIVE.has(f.key) && n < 0 && !(f.key === "gap" && num(want0) && want0 < 0) ? `${r2(n)} is impossible for ${f.label} (CSS cannot make it negative)`
          : f.key === "opacity" && n > 1 ? `${r2(n)} is impossible for opacity (0 to 1)`
          : f.key === "gap" && nullKeys[0] === "gapVisual" && box > 0 && n > box ? `${r2(n)}px is larger than the element measured (${r2(box)}px)`
          : null;
        // a rendered distance (gapVisual) that is an artefact does not hide a readable computed gap
        const cssGap = why && nullKeys[0] === "gapVisual" && !table ? cssPx(got.gap) : null;
        if (cssGap !== null && cssGap >= 0) val = cssGap;
        else if (why) { gap(spec, f.label, `${why} — a measuring artefact (children not laid out in one line, or rows read across columns?); not compared`); continue; }
        else val = n;
      }
      fieldsChecked++;
      let want: JsonValue = want0, have: JsonValue = val;
      if (f.key === "borderRadius") {
        const c = radiusCorners(val);
        if (!c) { gap(spec, f.label, `could not read '${JSON.stringify(val)}' as a px radius`); fieldsChecked--; continue; }
        if (c.some((r) => r < 0)) { gap(spec, f.label, `${JSON.stringify(val)} is impossible for a radius (CSS cannot make it negative) — a measuring artefact; not compared`); fieldsChecked--; continue; }
        const W = num(got.width) ? got.width : spec.width, H = num(got.height) ? got.height : spec.height;
        // (a borderRadius spec is a number — expectNode writes it from the node's radius)
        if (typeof want === "number") want = clampRadius(want, spec.width, spec.height);
        const target = Number(want);
        // the four corners must all match a uniform design radius
        const worst = c.map((r) => clampRadius(r, W, H)).reduce((a, r) => (Math.abs(r - target) > Math.abs(a - target) ? r : a), clampRadius(c[0], W, H));
        have = worst;
      }
      const bad = compareField(f, want, have);
      if (bad) {
        push(spec, f.label, f.high ? "high" : "medium", bad, {
          ...ifDefined("unit", f.unit), ...ifDefined("token", tokenFor(spec, f.key)), ...(measuredIn !== "rest" ? { measuredIn } : {}),
          ...ifDefined("matchedBy", matchedBy !== "id" ? matchedBy || undefined : undefined),
          ...(f.key === "borderRadius" && spec.borderRadius !== want ? { note: `design radius ${spec.borderRadius} on a ${spec.width}×${spec.height} box draws ${want}` } : {}),
        });
      }
    }

    // ---- per-corner radius (unequal corners)
    if (spec.radiusCorners && onLeaf) gap(spec, "border-radius", leafWhy);
    else if (spec.radiusCorners) {
      const rc = spec.radiusCorners;
      const c = radiusCorners(got.borderRadius);
      tally("borderRadius", got.borderRadius !== undefined);
      if (got.borderRadius === null || (Array.isArray(got.borderRadius) && got.borderRadius.some((v) => v === null))) gapNull("border-radius", "borderRadius");
      else if (!c) gap(spec, "border-radius", got.borderRadius === undefined ? "the probe did not report this property" : `could not read '${JSON.stringify(got.borderRadius)}' as a px radius`);
      else if (c.some((r) => r < 0)) gap(spec, "border-radius", `${JSON.stringify(got.borderRadius)} is impossible for a radius (CSS cannot make it negative) — a measuring artefact; not compared`);
      else {
        const W = num(got.width) ? got.width : spec.width, H = num(got.height) ? got.height : spec.height;
        const [ctl, ctr, cbr, cbl] = c;
        const measured = { tl: ctl, tr: ctr, br: cbr, bl: cbl };
        (["tl", "tr", "br", "bl"] as const).forEach((k) => {
          fieldsChecked++;
          const want = clampRadius(rc[k], spec.width, spec.height), have = clampRadius(measured[k], W, H);
          const d = Math.abs(want - have);
          if (d > TOLERANCE.radius) push(spec, `border-radius (${{ tl: "top-left", tr: "top-right", br: "bottom-right", bl: "bottom-left" }[k]})`, "medium", { want, got: have, delta: Number(d.toFixed(3)) }, { unit: "px", ...ifDefined("token", tokenFor(spec, "radius." + k)) });
        });
      }
    }
    if (spec.padding !== undefined) {
      tally("padding", got.padding !== undefined);
      const pad = fourSides(got.padding);
      if (got.padding === undefined) gap(spec, "padding", "the probe did not report this property");
      else if (got.tag && String(got.tag).toLowerCase() === "tr") gap(spec, "padding", "a table row's padding lives on its cells — report the first/last cell's padding under this id");
      else if (onLeaf) gap(spec, "padding", leafWhy);
      else if (got.padding === null || (Array.isArray(got.padding) && got.padding.some((v) => v === null))) gapNull("padding", "padding");
      else if (!pad) gap(spec, "padding", `could not read '${JSON.stringify(got.padding)}' as px padding [t,r,b,l]`);
      else if (pad.some((v) => v < 0)) gap(spec, "padding", `${JSON.stringify(got.padding)} is impossible for padding (CSS cannot make it negative) — a measuring artefact; not compared`);
      else {
        fieldsChecked++;
        const bad = comparePadding(spec.padding, pad);
        const allZero = pad.every((v) => v === 0);
        if (bad) push(spec, "padding", "medium", bad, { unit: "px", ...ifDefined("token", tokenFor(spec, "padding")),
          ...(allZero && !got.tag ? { note: "measured 0 on every side — if this id sits on a <tr> or a wrapper, the padding lives on its cells/child: report `tag` and measure the element that carries it" } : {}) });
      }
    }
    if (spec.placeholderText !== undefined) {
      tally("placeholderText", got.placeholderText !== undefined);
      if (got.placeholderText === undefined) gap(spec, "placeholder text", "this layer is an input placeholder: report el.placeholder as placeholderText (textContent of an empty input is '')");
      else if (got.placeholderText === null) gapNull("placeholder text", "placeholderText");
      else {
        fieldsChecked++;
        if (String(got.placeholderText).trim() !== String(spec.placeholderText).trim()) push(spec, "placeholder text", "high", { want: spec.placeholderText, got: got.placeholderText, delta: null });
      }
    }
    if (spec.text !== undefined) {
      tally("text", got.text !== undefined);
      if (got.text === null) {
        fieldsReportedNull++;
        gap(spec, "text", um.text || "the probe reported text: null — an element with child elements still has text; report its textContent");
      }
      else if (got.text !== undefined) {
        fieldsChecked++;
        // Compare the literal characters. Figma's text-transform renders "NO. Of" from a stored "NO. of"
        // — so the STORED string is the truth and a case-only difference the CSS explains is not a bug.
        const w = String(spec.text).replace(/ /g, " ").trim();
        const g = String(got.text).replace(/ /g, " ").trim();
        if (w !== g) {
          const caseOnly = w.toLowerCase() === g.toLowerCase();
          // "Job Role▲": the designed string plus glyphs that are not letters or digits (a sort caret,
          // an icon font) — the copy is intact; name the extra glyphs rather than calling it a copy bug.
          const extraGlyphs = !caseOnly && g.startsWith(w) && !/[\p{L}\p{N}]/u.test(g.slice(w.length));
          // F-104: the design repeats this string in >=3 sibling rows (placeholder copy). Low ONLY when the build's
          // texts in those rows differ from each other (real data); one wrong string in every row stays high.
          const rowTexts = spec.repeatedText && spec.repeatedTextGroup ? builtTexts.get(spec.repeatedTextGroup) : undefined;
          // Real data = at least three different built values, and the designed string in at most half the rows
          // (a realistic placeholder — "Active" — may well be one of the real values). A typo among correct rows
          // ({View×3, Veiw}: 2 values; {View×3, Veiw, Vew}: View is the majority) or one wrong label everywhere plus
          // a typo stays high. Trade-off: two-state data ({Active, Inactive}) stays high — too close to a copy bug.
          const distinct = rowTexts ? new Set(rowTexts).size : 0;
          const asDesigned = rowTexts ? rowTexts.filter((t) => t === w).length : 0;
          const realData = !caseOnly && !extraGlyphs && !!rowTexts && distinct >= 3 && asDesigned * 2 <= rowTexts.length;
          push(spec, "text", caseOnly || extraGlyphs || realData ? "low" : "high", { want: spec.text, got: got.text, delta: null }, {
            ...ifDefined("note", caseOnly ? "differs only in case — check for a text-transform, which Figma applies at render time while storing the original"
              : extraGlyphs ? `the designed text is intact, followed by '${g.slice(w.length).trim()}' (an icon or caret inside the same element?)`
              : realData ? `repeated placeholder copy: the design shows '${w}' in every sibling row; the build shows ${distinct} different values across them (real data?) — check the copy is the data the design means`
              : undefined),
          });
        }
        if (/ /.test(String(spec.text))) {
          // Show the escape, not the character. Printed raw, this row reads as two identical strings
          // flagged as a mismatch — the whole point is that the difference is INVISIBLE.
          const show = (t: unknown): string => String(t).replace(/ /g, "\\u00a0");
          deltas.push({
            severity: "low", nodeId: spec.nodeId, name: spec.name, field: "text (invisible character)",
            expected: show(spec.text), actual: show(got.text),
            note: "the designed string contains a non-breaking space (U+00A0) — a Figma auto-substitution. Carrying it into the DOM verbatim is usually not what anyone meant; decide deliberately.",
          });
        }
      }
    }

    // ---- placement: a designed-inside-the-frame node that renders outside it (finding 164)
    const fr = frameOf(spec);
    const bx = got;
    if (num(fr.w) && num(fr.h) && (num(bx.x) || num(bx.y))) {
      const w = num(bx.width) ? bx.width : 0, h = num(bx.height) ? bx.height : 0;
      const tol = TOLERANCE.position;
      const inDesign = (!num(spec.x) || (spec.x >= -tol && spec.x + (spec.width || 0) <= fr.w + tol)) && (!num(spec.y) || (spec.y >= -tol && spec.y + (spec.height || 0) <= fr.h + tol));
      const out: string[] = [];
      const over: number[] = []; // px past each edge — the delta's number, so a waiver's tolerance applies
      let bottomOnly = true;
      if (num(bx.y) && bx.y + h > fr.h + tol) { out.push(`bottom edge at y=${r2(bx.y + h)} in a ${fr.h}-high frame`); over.push(bx.y + h - fr.h); }
      if (num(bx.y) && bx.y < -tol) { out.push(`top edge at y=${r2(bx.y)}`); over.push(-bx.y); bottomOnly = false; }
      if (num(bx.x) && bx.x + w > fr.w + tol) { out.push(`right edge at x=${r2(bx.x + w)} in a ${fr.w}-wide frame`); over.push(bx.x + w - fr.w); bottomOnly = false; }
      if (num(bx.x) && bx.x < -tol) { out.push(`left edge at x=${r2(bx.x)}`); over.push(-bx.x); bottomOnly = false; }
      if (inDesign && out.length && !(zeroAtRest)) {
        // F-61: "below the fold" — a page that is simply longer than the design's frame scrolls to this node.
        // Medium (still blocks a pass) only when ALL hold: the bottom edge is the only one crossed; the probe
        // took the viewport as the frame, or the rendered frame is taller than the design's (the page grew);
        // the node is not absolute/fixed (those do not scroll into view); one frame (not a multi-frame/overlay
        // expectation). Anything else stays high. Trade-off: a real bug that pushes a CTA below the fold also
        // reads medium — it still blocks the pass, it only no longer shouts.
        const pf = probeFrames.find((f) => f.nodeId === fr.nodeId) ?? (!multiFrame && probeFrames.length === 1 ? probeFrames[0] : undefined);
        const pageGrew = !!pf && (pf.via === "viewport" || (isJsonObject(pf.rect) && num(pf.rect.h) && pf.rect.h > fr.h + tol));
        const belowFold = bottomOnly && pageGrew && !spec.absolute && !spec.fixed && !multiFrame;
        deltas.push({ severity: belowFold ? "medium" : "high", nodeId: spec.nodeId, name: spec.name, ...ifDefined("path", spec.path), field: "placement", expected: "inside the frame", actual: out.join(", "),
          delta: r2(Math.max(...over)), // px past the frame (no `unit`: `actual` is prose, printed as-is)
          note: belowFold ? "below the fold: the page renders taller than the design's frame and this node sits past its bottom edge — reachable by scrolling; accept it (verify-screen --accept) if the longer page is intended"
            : "the design places this node inside the frame; the build renders it outside, where the user cannot see it without scrolling" });
      }
    }
  }

  // ---- notes that change how far a delta can be trusted, never its severity
  const addNote = (d: VerifyDelta, note: string): void => { d.note = d.note ? `${d.note}; ${note}` : note; };
  const typoLabels = new Set(FIELDS.filter((f) => TYPO_FIELDS.has(f.key)).map((f) => f.label));
  for (const d of deltas) {
    const tag = typographyOn.get(String(d.nodeId));
    if (tag && typoLabels.has(d.field)) addNote(d, `typography read from a <${tag}>, not the text run — if the text sits in a child element, measure that element (the shipped probe does, and says textFrom)`);
    if (positionMatched.has(String(d.nodeId))) addNote(d, "low confidence: this node was matched by position, not by its data-dt-node tag or its text — the element measured may not be the one the design means");
  }

  // ---- measured ids the expectation does not know (the "134 measured vs 63 matched" case): a probe that
  // measured the wrong screen, a stale expectation, or ids on layers the export does not list.
  const knownIds = new Set([...expectedIds, ...hiddenSet, ...[expectation.frame, ...(expectation.frames || [])].map((f) => f && f.nodeId).filter((id): id is string => typeof id === "string")]);
  for (const id of expectedIds) { const alt = viaSharedPath(id); if (alt) knownIds.add(alt); }
  const measuredIdsNotInExpectation = [...byId.keys()].filter((id) => !knownIds.has(id));

  // ---- fields in FIELDS that the probe never reported under the canonical key (finding 182)
  const fieldsNeverMeasured: VerifyCoverageV2["fieldsNeverMeasured"] = [];
  for (const [key, c] of census) {
    if (FIELDS.some((f) => f.key === key && f.optional)) continue; // listed under `unverifiable` instead
    if (c.expected > 0 && c.present === 0) {
      const hinted = [...unknownKeys.keys()].filter((k) => KEY_HINTS[k] === key);
      fieldsNeverMeasured.push({ field: key, expectedOn: c.expected, measuredOn: 0, ...(hinted.length ? { probeSent: hinted } : {}) });
    }
  }

  // ---- component evidence. NOT presence: this is how many instance sets the probe could point at
  // (a data-dt-node id, a reported setName, or a shared-component path). A correct build that tags
  // nothing scores 0 here and a build that tags everything scores 100% without a pixel checked
  // (finding 169), so it never fails a screen on its own; only an explicit `present: false` does.
  const comps: MeasuredComponent[] = [...(Array.isArray(measured.components) ? measured.components : []), ...(Array.isArray(opts.components) ? opts.components : [])];
  const reported = comps.filter((c) => c && c.present !== false);
  const namesSeen = new Set(reported.map((c) => String(c.setName || c.name || c)));
  const idsSeen = new Set([...reported.map((c) => c.nodeId).filter(Boolean).map(String), ...byId.keys()]);
  const bySet = new Map<string, { setName: string; setKey?: string; nodeIds: string[]; instances: number }>();
  for (const i of expectation.instances || []) {
    if (hiddenSet.has(String(i.nodeId))) continue;
    const k = i.setName || i.name;
    const e = getOrInit(bySet, k, () => ({ setName: k, ...ifDefined("setKey", i.setKey), nodeIds: [], instances: 0 }));
    e.instances++;
    e.nodeIds.push(i.nodeId);
  }
  const untaggedInstanceSets: VerifyReportV2["untaggedInstanceSets"] = [];
  let setsViaSharedPath = 0;
  for (const [k, v] of bySet) {
    if (namesSeen.has(k) || v.nodeIds.some((id) => idsSeen.has(String(id)))) continue;
    if (v.nodeIds.some((id) => viaSharedPath(id))) { setsViaSharedPath++; continue; }
    untaggedInstanceSets.push(v);
  }
  const componentsAbsent: VerifyReportV2["componentsAbsent"] = [];
  for (const c of comps.filter((c) => c && c.present === false)) {
    const set = [...bySet.values()].find((v) => v.setName === (c.setName || c.name) || (c.nodeId !== undefined && v.nodeIds.includes(c.nodeId)));
    if (set) componentsAbsent.push({ setName: set.setName, nodeIds: set.nodeIds, ...ifDefined("detail", c.detail || c.note) });
  }

  // ---- interactions: the export says what each control does; did it? Three states, not two:
  // pass (driven, with the selector that was driven), fail (driven, did not work), not-probed
  // (nobody drove it — which is neither; finding 158 was a "not measured" detail under result "fail").
  const allEvidence: InteractionEvidence[] = [...(Array.isArray(measured.interactions) ? measured.interactions : []), ...(Array.isArray(opts.interactions) ? opts.interactions : [])];
  const exercised = new Map<string, InteractionEvidence>();
  let interactionEvidenceOnHidden = 0;
  const expectedKeys = new Set((expectation.interactions || []).map((i) => String(i.nodeId) + "|" + i.trigger));
  for (const r of allEvidence) {
    if (!r || r.nodeId == null) continue;
    if (hiddenSet.has(String(r.nodeId))) { interactionEvidenceOnHidden++; continue; }
    exercised.set(String(r.nodeId) + "|" + String(r.trigger || "on_click").toLowerCase(), r); // later evidence wins
  }
  // D20: the owner's descopes — bound to the export like a waiver; a re-export reopens them.
  const exportSha = expectation.exportContentSha256;
  const inputNotes = [...(Array.isArray(opts.inputNotes) ? opts.inputNotes : [])];
  const reopened: VerifyReportV2["waivers"]["reopened"] = [];
  const unused: VerifyReportV2["waivers"]["unused"] = [];
  const descopeRows: PlanDescope[] = [];
  (Array.isArray(opts.descopes) ? opts.descopes : []).forEach((d, i) => { if (isPlanDescope(d)) descopeRows.push(d); else inputNotes.push(`plan descopes[${i}] is not ${isPlanDescope.expected}; ignored`); });
  const descopeUsed = new Set<PlanDescope>();
  const descopeFor = (i: VerifyInteraction): PlanDescope | undefined => {
    const hits = descopeRows.filter((d) => d.nodeId === i.nodeId && d.trigger.toLowerCase() === i.trigger && (d.destinationId === undefined || d.destinationId === i.destinationId));
    for (const d of hits) descopeUsed.add(d);
    const live = hits.find((d) => d.exportContentSha256 === exportSha);
    if (!live) for (const d of hits) reopened.push({ nodeId: d.nodeId, field: `interaction (${d.trigger})`, why: "design re-exported: the export content changed since it was descoped" });
    return live;
  };
  const interactions = (expectation.interactions || []).filter((i) => !hiddenSet.has(String(i.nodeId))).map((i): VerifyInteractionResult => {
    const hit = exercised.get(String(i.nodeId) + "|" + i.trigger);
    const row: VerifyInteraction = { nodeId: i.nodeId, name: i.name, trigger: i.trigger, ...ifDefined("action", i.action), ...ifDefined("destinationId", i.destinationId), ...(i.destinationExported === false ? { destinationExported: false } : {}) };
    const worked = !!hit && hit.ok === true && hit.result !== "not-probed" && !!hit.selector && Number(hit.selectorCount) >= 1;
    // D20: removed from the graded set before grading; evidence that it works anyway is noted, never graded.
    const scoped = descopeFor(i);
    if (scoped) return Object.assign(row, { result: "descoped" as const, detail: `descoped by ${scoped.decidedBy} (${scoped.decidedAt}): ${scoped.reason}`, ...(worked ? { note: "descoped but works — the probe drove it successfully; drop the descope?" } : {}) });
    // D22: its destination was never exported — nothing designed to arrive at. A probe showing it working still passes.
    if (i.destinationExported === false && !worked) return Object.assign(row, { result: "undesigned" as const, detail: `destination ${i.destinationId} is not in this Figma file's export — nothing designed to check it against${hit && hit.detail ? `; probe said: ${hit.detail}` : ""}` });
    if (!hit) return Object.assign(row, { result: "not-probed" as const, detail: "no probe result for this node and trigger" });
    const count = Number(hit.selectorCount);
    if (hit.result === "not-probed" || hit.ok === null || hit.ok === undefined) return Object.assign(row, { result: "not-probed" as const, ...ifDefined("detail", hit.detail) });
    if (hit.ok === false) return Object.assign(row, { result: "fail" as const, ...ifDefined("detail", hit.detail), ...ifDefined("selector", hit.selector) });
    // ok:true is a claim; the evidence is the selector that was driven and proof it matched something.
    // An agent once credited two hidden popup rows with hovers it performed on unrelated controls (187).
    if (!hit.selector || !(count >= 1)) {
      return Object.assign(row, { result: "not-probed" as const, detail: `reported ok without evidence — ${!hit.selector ? "no selector named" : `selector '${hit.selector}' matched ${Number.isFinite(count) ? count : "an unreported number of"} element(s)`}${hit.detail ? `; probe said: ${hit.detail}` : ""}` });
    }
    return Object.assign(row, { result: "pass" as const, ...ifDefined("detail", hit.detail), selector: hit.selector, selectorCount: count });
  });
  const unexpectedInteractionEvidence = allEvidence.filter((r) => r && r.nodeId != null && !hiddenSet.has(String(r.nodeId)) && !expectedKeys.has(String(r.nodeId) + "|" + String(r.trigger || "on_click").toLowerCase())).length;
  const interactionsFailed = interactions.filter((i) => i.result === "fail");
  const interactionsNotProbed = interactions.filter((i) => i.result === "not-probed");
  const interactionsPassed = interactions.filter((i) => i.result === "pass");
  const interactionsUndesigned = interactions.filter((i) => i.result === "undesigned");
  const interactionsDescoped = interactions.filter((i) => i.result === "descoped");
  for (const d of descopeRows) if (!descopeUsed.has(d)) unused.push({ nodeId: d.nodeId, field: `interaction (${d.trigger})`, why: "no designed interaction with this node and trigger this round" });

  // ---- D5: the plan's waivers. A waiver accepts ONE delta (node + field) while the design is the one it was
  // accepted against (whole-export hash, D21), the designed value is the same and the built value has not moved
  // beyond its tolerance. Anything else reopens it. Never waivable: an absent component, a failed interaction,
  // a node or value that was not measured — none of them is a delta.
  const notWaivable = new Map<string, string>();
  for (const n of notMeasured) notWaivable.set(n.nodeId, "the node was not measured — only a measured delta can be accepted");
  for (const i of interactionsFailed) notWaivable.set(i.nodeId, "a failed interaction is never waivable (D5) — descope it (plan.descopes, owner-only) if it is deliberately inert");
  for (const c of componentsAbsent) for (const id of c.nodeIds) notWaivable.set(id, `component set '${c.setName}' is reported ABSENT — a missing component is never waivable (D5)`);
  let applied = 0;
  (Array.isArray(opts.waivers) ? opts.waivers : []).forEach((w, i) => {
    if (!isPlanWaiver(w)) { inputNotes.push(`plan waivers[${i}] is not ${isPlanWaiver.expected}; ignored`); return; }
    const cands = deltas.filter((d) => d.nodeId === w.nodeId && d.field === w.field && !d.accepted);
    if (!cands.length) {
      const fieldGap = fieldsNotMeasured.some((g) => g.nodeId === w.nodeId && g.field === w.field) ? "that value was not measured this round — only a measured delta can be accepted" : undefined;
      unused.push({ nodeId: w.nodeId, field: w.field, why: notWaivable.get(w.nodeId) ?? fieldGap ?? "no such delta this round — fixed? drop the waiver" });
      return;
    }
    if (!exportSha || w.exportContentSha256 !== exportSha) {
      reopened.push({ nodeId: w.nodeId, field: w.field, why: exportSha ? "design re-exported: the export content changed since the waiver was accepted" : "the expectation records no export content hash — regenerate it with --expect" });
      return;
    }
    const tol = fieldTolerance(w.field);
    const d = cands.find((x) => sameWithin(w.designed, x.expected, tol) && sameWithin(w.built, x.actual, w.tolerance ?? tol));
    if (d) {
      d.accepted = { reason: w.reason, decidedBy: w.decidedBy, decidedAt: w.decidedAt, ...ifDefined("cause", w.cause) };
      applied++;
      return;
    }
    const c0 = cands.find((x) => sameWithin(w.designed, x.expected, tol));
    reopened.push({ nodeId: w.nodeId, field: w.field,
      why: c0 ? `built value moved: was ${fmt(w.built)}, now ${fmt(c0.actual)}` : `designed value changed: was ${fmt(w.designed)}, now ${fmt(cands[0]?.expected)}` });
  });

  // ---- F-76: presentational groups — one cause, many rows. Counts and verdict stay per delta.
  // (a) a placement delta inside another node with a placement delta belongs to the OUTERMOST such ancestor's
  //     group (a footer pushed down carries its children with it);
  // (b) the same field with the same expected and actual on >=2 nodes is one group (one wrong token/class).
  // Trade-off: an independent defect inside a group's root is only visible in the member list.
  const specOf = new Map(specs.map((sp) => [String(sp.nodeId), sp]));
  const placed = new Map<string, VerifyDelta>();
  for (const d of deltas) if (d.field === "placement") placed.set(String(d.nodeId), d);
  for (const d of placed.values()) {
    const anc = (specOf.get(String(d.nodeId))?.ancestorIds || []).filter((a) => placed.has(a));
    const root = anc[anc.length - 1];
    if (root) { d.group = `placement:${root}`; const r = placed.get(root); if (r) r.group = `placement:${root}`; }
  }
  const sameKey = new Map<string, VerifyDelta[]>();
  for (const d of deltas) if (!d.group) getOrInit(sameKey, JSON.stringify([d.field, d.expected, d.actual]), () => []).push(d);
  for (const [k, list] of sameKey) {
    if (list.length < 2) continue;
    const gid = `same:${crypto.createHash("sha256").update(k).digest("hex").slice(0, 8)}`;
    for (const d of list) d.group = gid;
  }

  const open = deltas.filter((d) => !d.accepted);
  const high = open.filter((d) => d.severity === "high").length;
  const medium = open.filter((d) => d.severity === "medium").length;
  const accepted = deltas.length - open.length;
  const openHigh = open.filter((d) => d.severity === "high");
  const highCauses = new Set(openHigh.map((d, i) => d.group ?? `#${i}`)).size;

  // ---- what the evidence is tied to (findings 153/166/190)
  // (an in-process caller can hand over any object: a probe that is not an identity reads as unknown, with a note)
  const probeRaw: unknown = measured.probe;
  const probeIdentity = isProbeIdentity(probeRaw) ? probeRaw : undefined;
  if (probeRaw !== undefined && !probeIdentity && !inputNotes.some((n) => n.startsWith("measured.probe "))) inputNotes.push("measured.probe is not the shipped probe's identity; ignored (probe: unknown)");
  const inputs: VerifyReportV2["inputs"] = {
    expectationSchema: expectation.schema || "(none)",
    ...ifDefined("expectationSha256", opts.expectationSha256),
    ...ifDefined("measuredSha256", opts.measuredSha256),
    ...ifDefined("measuredAgainst", measured.expectationSha256 || undefined),
    // P2b round 2 (findings 314/317): WHAT was measured, by content — the design (timestamps stripped)
    // and the code (sha256 of each file in the plan's files[], the hashes the Stop hook records).
    ...ifDefined("exportContentSha256", expectation.exportContentSha256 || undefined),
    ...ifDefined("code", opts.code || undefined),
    // Which probe produced these numbers (F-101): a hand-written probe is "unknown", and its numbers are not
    // comparable round to round — a changed probe changes what "measured" means.
    probe: probeIdentity ?? "unknown",
    ...ifDefined("waivers", opts.waiversInput || undefined),
  };
  const stale = !!(opts.expectationSha256 && measured.expectationSha256 && measured.expectationSha256 !== opts.expectationSha256);
  const staticOnly = measured.mode === "static-only";
  const artifactCheck = Array.isArray(opts.artifactCheck) ? opts.artifactCheck : null;
  const noRender = !!artifactCheck && !artifactCheck.some((a) => a.exists && a.image);

  // The verdict is COMPUTED. Coverage first — how much was looked at decides what the rest is worth.
  // (a spec a plan anchor folded into a measured ancestor, F-77, is out of the denominator)
  const nodesExpected = specs.length - folded.length;
  const reasons: string[] = [];
  if (legacy) reasons.push(`the expectation is ${expectation.schema || "unversioned"}, which predates hidden-layer filtering — regenerate it with --expect before trusting any number here`);
  if (stale) reasons.push(`the measurements were taken against a DIFFERENT expectation (${String(measured.expectationSha256).slice(0, 12)}… vs ${String(opts.expectationSha256).slice(0, 12)}…) — re-measure`);
  if (staticOnly) reasons.push(`not rendered — the probe reported static-only${measured.reason ? ` (${measured.reason})` : ""}`);
  if (noRender) reasons.push("no screenshot of this render exists on disk — nothing ties these numbers to a picture (write design/verify/<Screen>.png and list it in artifacts)");
  for (const f of fieldsNeverMeasured) reasons.push(`field '${f.field}' was present on 0 of the ${f.expectedOn} measured node(s) whose spec states it${f.probeSent ? ` (the probe sent '${f.probeSent.join("', '")}' — the canonical key is '${f.field}')` : ""}`);
  if (notMeasured.length) reasons.push(`${notMeasured.length} of ${nodesExpected} node spec(s) were never measured`);
  if (high) reasons.push(`${high} high-severity value mismatch(es)`);
  if (medium) reasons.push(`${medium} medium-severity value mismatch(es)`);
  if (componentsAbsent.length) reasons.push(`${componentsAbsent.length} component set(s) reported ABSENT from the build by the probe`);
  if (interactionsFailed.length) reasons.push(`${interactionsFailed.length} designed interaction(s) failed`);
  if (interactionsNotProbed.length) reasons.push(`${interactionsNotProbed.length} designed interaction(s) were not probed`);
  const fieldGapsOther = fieldsNotMeasured.length;
  if (fieldGapsOther) reasons.push(`${fieldGapsOther} value(s) on measured nodes were not reported by the probe${fieldsReportedNull ? ` (${fieldsReportedNull} reported null — the probe could not read them)` : ""}`);

  // Reasons come from OPEN items only. Nothing open, but something accepted or descoped → pass-with-deviations (D5/D20).
  const verdict: VerifyVerdict = reasons.length === 0 ? (accepted || interactionsDescoped.length ? "pass-with-deviations" : "pass")
    : high || componentsAbsent.length || interactionsFailed.length ? "fail" : "incomplete";

  const coverage: VerifyCoverageV2 = {
    nodesExpected,
    nodesMeasured,
    nodesNotMeasured: notMeasured.length,
    nodesMatchedByComponentPath,
    fieldsChecked,
    fieldsNotMeasured: fieldsNotMeasured.length,
    fieldsNeverMeasured,
    valuesNotComparable: (expectation.notComparable || []).length,
    valuesUnverifiable: unverifiable.length,
    ...ifDefined("hiddenLayersSkipped", (expectation.counts && expectation.counts.hidden) || undefined),
    instanceSets: bySet.size,
    instanceSetsWithEvidence: bySet.size - untaggedInstanceSets.length,
    instanceSetsViaSharedPath: setsViaSharedPath,
    interactionsExpected: interactions.length,
    interactionsPassed: interactionsPassed.length,
    interactionsFailed: interactionsFailed.length,
    interactionsNotProbed: interactionsNotProbed.length,
    interactionsUndesigned: interactionsUndesigned.length,
    interactionsDescoped: interactionsDescoped.length,
    deltasAccepted: accepted,
    nodesFolded: folded.length,
    matchedBy: matchedByCensus,
  };

  // ---- D18: coverage against the previous round. Printed, recorded, and NEVER part of the verdict — a
  // round that measures 42 nodes where the last measured 185 is still judged on its own numbers, but it
  // can no longer read as progress (DT-44).
  let against: VerifyAgainst | undefined;
  if (opts.against) {
    const prev = opts.against.report;
    const pc = prev.coverage;
    const shaOf = (p: unknown): string | null => (isJsonObject(p) && typeof p.sha256 === "string" ? p.sha256 : null);
    const prevSha = shaOf(prev.inputs && prev.inputs.probe), curSha = probeIdentity ? probeIdentity.sha256 : null;
    const prevExp = prev.inputs && typeof prev.inputs.expectationSha256 === "string" ? prev.inputs.expectationSha256 : null;
    against = {
      report: opts.against.file,
      nodesMeasured: { before: pc && num(pc.nodesMeasured) ? pc.nodesMeasured : null, after: nodesMeasured },
      nodesExpected: { before: pc && num(pc.nodesExpected) ? pc.nodesExpected : null, after: nodesExpected },
      probeChanged: prevSha === null && curSha === null ? null : prevSha !== curSha,
      expectationChanged: prevExp && opts.expectationSha256 ? prevExp !== opts.expectationSha256 : null,
    };
  }
  const fell = against && against.nodesMeasured.before !== null && against.nodesMeasured.after < against.nodesMeasured.before;
  const mark = verdict.toUpperCase();
  // The headline's NEVER MEASURED slot is for a key the probe got wrong everywhere (finding 182). One node
  // that states a field says nothing about the probe — its gap is already listed under that node (F-59:
  // "'y' present in 0 of 74 measurements" was the frame root's one y).
  // A key no measured node carries at all is systemic too, however few specs state it (DT-23: `fill`).
  const systemic = fieldsNeverMeasured.filter((f) => f.expectedOn >= NEVER_MEASURED_HEADLINE_MIN || f.probeSent || !keysSeen.has(f.field));
  const headline =
    `${mark} — ` +
    (systemic.length ? `NEVER MEASURED: ${systemic.map((f) => `'${f.field}' present on 0 of ${f.expectedOn} nodes that state it${f.probeSent ? ` (probe sent '${f.probeSent.join("', '")}')` : ""}`).join("; ")} · ` : "") +
    `nodes measured ${nodesMeasured}/${nodesExpected}${folded.length ? ` (${folded.length} folded)` : ""} · ${fieldsChecked} values compared · ${high} high${highCauses < high ? ` (${highCauses} cause${highCauses === 1 ? "" : "s"})` : ""}, ${medium} medium` +
    (accepted ? ` · ${accepted} accepted` : "") + (reopened.length ? ` · ${reopened.length} waiver(s) REOPENED` : "") + " · " +
    // (not a verdict reason, like ::placeholder colour — but never silent: an <img> icon's fill is not a pass)
    (unverifiable.length ? `${unverifiable.length} value(s) unverifiable by method · ` : "") +
    `interactions ${interactionsPassed.length} pass, ${interactionsFailed.length} fail, ${interactionsNotProbed.length} not-probed` +
    (interactionsUndesigned.length ? `, ${interactionsUndesigned.length} undesigned` : "") + (interactionsDescoped.length ? `, ${interactionsDescoped.length} descoped` : "") + ` of ${interactions.length} · ` +
    `data-dt-node/component evidence ${coverage.instanceSetsWithEvidence}/${bySet.size} instance sets (tag coverage, not presence)` +
    (against && fell ? ` · COVERAGE FELL ${against.nodesMeasured.before}→${against.nodesMeasured.after} vs ${against.report}` : "") +
    (against && against.probeChanged === true ? " · probe changed" : "");

  return {
    schema: REPORT_SCHEMA,
    ...ifDefined("screen", expectation.screen),
    ...ifDefined("exportedAt", expectation.exportedAt),
    measuredAt: measured.measuredAt || new Date().toISOString(),
    renderer: measured.renderer || "unknown",
    ...ifDefined("viewport", measured.viewport),
    artifacts: artifactCheck || (Array.isArray(measured.artifacts) ? measured.artifacts : []),
    inputs,
    verdict,
    headline,
    why: reasons,
    coverage,
    summary: { high, medium, low: open.filter((d) => d.severity === "low").length, componentsAbsent: componentsAbsent.length, interactionsFailed: interactionsFailed.length, interactionsNotProbed: interactionsNotProbed.length,
      accepted, descoped: interactionsDescoped.length, undesigned: interactionsUndesigned.length, highCauses },
    deltas: deltas.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]),
    componentsAbsent,
    untaggedInstanceSets,
    interactions,
    notMeasured,
    fieldsNotMeasured,
    unverifiable,
    notComparable: expectation.notComparable || [],
    waivers: { applied, reopened, unused },
    folded,
    probe: {
      unknownKeys: [...unknownKeys].map(([key, count]) => ({ key, count, ...ifDefined("canonical", KEY_HINTS[key]) })),
      unknownTopLevelKeys: Object.keys(measured).filter((k) => !Object.hasOwn(MEASURED_TOP_KEYS, k)).map((key) => ({ key, ...ifDefined("canonical", TOP_KEY_HINTS[key]) })),
      duplicateNodeIds,
      interactionEvidenceOnHiddenLayers: interactionEvidenceOnHidden,
      interactionEvidenceNotInExpectation: unexpectedInteractionEvidence,
      measuredIdsOnHiddenLayers: [...byId.keys()].filter((id) => hiddenSet.has(id)).length,
      measuredIdsNotInExpectation: measuredIdsNotInExpectation.length,
      measuredIdsNotInExpectationSample: measuredIdsNotInExpectation.slice(0, 5),
      ...(inputNotes.length ? { inputNotes } : {}),
    },
    ...ifDefined("against", against),
    limits: LIMITS,
  };
}

/** The census as "tag 3 · text 1 · ordinal 0 · position 0" (the four the probe always reports, then any other non-zero bucket). */
function matchedLine(census: Record<string, number> | undefined): string {
  const c = census || {};
  const always = ["tag", "text", "textOrdinal", "position"];
  const keys = [...always, ...MATCH_BUCKETS.filter((b) => !always.includes(b) && (c[b] ?? 0) > 0)];
  return keys.map((k) => `${MATCH_LABEL[k] ?? k} ${c[k] ?? 0}`).join(" · ");
}
/**
 * The second stderr line after the headline (F-101): which probe produced the numbers, and how the nodes
 * were found. `probe verify-probe 1.2.3 (sha 1a2b3c4d5e6f…) · playwright 1.63.0 · chromium 140.0 · matched: tag N · text N · ordinal N · position N`.
 */
function probeLine(r: Pick<VerifyReport, "inputs" | "coverage">): string {
  const p = r.inputs && r.inputs.probe;
  const who = p && p !== "unknown"
    ? `probe ${p.name} ${p.version ?? "(no version)"} (sha ${p.sha256.slice(0, 12)}…) · ${p.playwright.package} ${p.playwright.version} · ${p.browser.name} ${p.browser.version}`
    : "probe unknown (hand-written — not comparable round to round)";
  return `${who} · matched: ${matchedLine(r.coverage && r.coverage.matchedBy)}`;
}

function reportToMarkdown(r: VerifyReportV2): string {
  const L: string[] = [];
  L.push(`# Verify — ${r.screen}`, "");
  L.push(`**${r.headline || r.verdict.toUpperCase()}**`, "");
  L.push(`renderer ${r.renderer}${r.viewport ? ` at ${typeof r.viewport === "object" ? JSON.stringify(r.viewport) : r.viewport}` : ""} · measured ${r.measuredAt}` +
    (r.inputs && r.inputs.expectationSha256 ? ` · against expectation ${r.inputs.expectationSha256.slice(0, 12)}…` : ""), "");
  if (r.why.length) {
    L.push("Why this is not a pass:", "");
    for (const w of r.why) L.push(`- ${w}`);
    L.push("");
  }
  const c = r.coverage;
  L.push("## What was actually checked", "");
  L.push("| | |", "|---|---|");
  L.push(`| node specs measured | ${c.nodesMeasured} / ${c.nodesExpected}${c.nodesMatchedByComponentPath ? ` (${c.nodesMatchedByComponentPath} via a shared component's internal path)` : ""}${c.nodesFolded ? ` (+${c.nodesFolded} folded into a measured ancestor, out of the count)` : ""} |`);
  L.push(`| individual values compared | ${c.fieldsChecked} |`);
  L.push(`| values on measured nodes the probe did not report | ${c.fieldsNotMeasured} |`);
  if (c.fieldsNeverMeasured.length) L.push(`| **fields present in 0 measurements** | ${c.fieldsNeverMeasured.map((f) => `\`${f.field}\`${f.probeSent ? ` (probe sent \`${f.probeSent.join("`, `")}\`)` : ""}`).join(", ")} |`);
  L.push(`| design values excluded by method (listed below) | ${c.valuesNotComparable} |`);
  L.push(`| values the method cannot read unaided | ${c.valuesUnverifiable} |`);
  if (c.hiddenLayersSkipped) L.push(`| hidden layers skipped (not built, not measured, not driven) | ${c.hiddenLayersSkipped.layers} layer(s) · ${c.hiddenLayersSkipped.specsSkipped} spec(s) · ${c.hiddenLayersSkipped.instancesSkipped} instance(s) · ${c.hiddenLayersSkipped.interactionsSkipped} interaction(s) |`);
  L.push(`| instance sets the probe could point at (data-dt-node / component evidence — coverage, NOT presence) | ${c.instanceSetsWithEvidence} / ${c.instanceSets} |`);
  L.push(`| designed interactions: pass / fail / not-probed | ${c.interactionsPassed} / ${c.interactionsFailed} / ${c.interactionsNotProbed} of ${c.interactionsExpected}` +
    `${c.interactionsUndesigned ? ` · ${c.interactionsUndesigned} undesigned (destination never exported)` : ""}${c.interactionsDescoped ? ` · ${c.interactionsDescoped} descoped by the owner` : ""} |`);
  if (c.deltasAccepted) L.push(`| value mismatches accepted by a plan waiver (listed, out of the counts) | ${c.deltasAccepted} |`);
  L.push("");
  if (r.against) {
    const a = r.against;
    L.push(`Against the previous round (${a.report}): nodes measured ${a.nodesMeasured.before ?? "?"} → ${a.nodesMeasured.after}, expected ${a.nodesExpected.before ?? "?"} → ${a.nodesExpected.after}` +
      `${a.probeChanged === true ? " · **the probe changed**" : a.probeChanged === null ? " · probe identity unknown on both rounds" : ""}${a.expectationChanged ? " · the expectation changed" : ""}. This never changes the verdict.`, "");
  }
  L.push("## How nodes were matched", "");
  const ip = r.inputs && r.inputs.probe;
  L.push(ip && ip !== "unknown" ? `Probe: ${ip.name} ${ip.version ?? "(no version)"} · sha256 ${ip.sha256.slice(0, 12)}… · ${ip.playwright.package} ${ip.playwright.version} · ${ip.browser.name} ${ip.browser.version}` : "Probe: unknown (a hand-written measured.json — its numbers are not comparable round to round).", "");
  L.push("| rule | node specs |", "|---|---|");
  for (const b of MATCH_BUCKETS) if ((c.matchedBy[b] ?? 0) > 0 || b === "tag") L.push(`| ${MATCH_LABEL[b] ?? b} | ${c.matchedBy[b] ?? 0} |`);
  L.push("");
  if (r.deltas.length) {
    // F-76: one line per cause first (a group = one cause, many rows); the table still lists every row.
    const groups = new Map<string, VerifyDelta[]>();
    for (const d of r.deltas) if (d.group) getOrInit(groups, d.group, () => []).push(d);
    if (groups.size) {
      L.push(`## Grouped causes (${groups.size})`, "", "*Presentational: every row still counts on its own.*", "");
      for (const [g, list] of groups) {
        const rootId = g.startsWith("placement:") ? g.slice("placement:".length) : null;
        const root = rootId ? list.find((d) => d.nodeId === rootId) : undefined;
        const open = list.filter((d) => !d.accepted);
        L.push(`- \`${g}\` — ${list[0]?.field ?? ""}, **${list.length} rows**${root ? ` (${root.name || root.nodeId} and ${list.length - 1} inside it)` : ` (${fmt(list[0]?.expected)} → ${fmt(list[0]?.actual)})`}` +
          `${open.length < list.length ? ` · ${list.length - open.length} accepted` : ""} — accept together: \`--accept <report> --group ${g} --reason … --by …\``);
      }
      L.push("");
    }
    L.push(`## Value mismatches (${r.deltas.length})`, "", "| Severity | Node | Field | Expected | Actual | Token | Group / accepted |", "|---|---|---|---|---|---|---|");
    for (const d of r.deltas) {
      const status = d.accepted ? `accepted — ${d.accepted.reason} (${d.accepted.decidedBy}, ${d.accepted.decidedAt})` : d.group ? `\`${d.group}\`` : "";
      L.push(`| ${d.accepted ? `~~${d.severity}~~` : d.severity} | ${d.name || ""} \`${d.nodeId}\` | ${d.field} | ${withUnit(d.expected, d.unit)} | ${withUnit(d.actual, d.unit)} | ${d.token || "—"} | ${status} |`);
    }
    L.push("");
  }
  const wv = r.waivers;
  if (wv && (wv.reopened.length || wv.unused.length)) {
    L.push("## Plan waivers that no longer apply", "");
    for (const w of wv.reopened) L.push(`- **reopened** \`${w.nodeId}\` (${w.field}) — ${w.why}`);
    for (const w of wv.unused) L.push(`- unused \`${w.nodeId}\` (${w.field})${w.why ? ` — ${w.why}` : ""}`);
    L.push("");
  }
  if (r.folded && r.folded.length) {
    L.push(`## Folded into a measured ancestor (${r.folded.length} node specs, out of the count)`, "");
    for (const f of r.folded) L.push(`- \`${f.nodeId}\` ${f.name || ""} → \`${f.into}\` — ${f.why}`);
    L.push("");
  }
  if (r.componentsAbsent.length) {
    L.push(`## Components the probe reported ABSENT (${r.componentsAbsent.length})`, "");
    for (const m of r.componentsAbsent) L.push(`- **${m.setName}** — e.g. \`${m.nodeIds[0]}\`${m.detail ? ` — ${m.detail}` : ""}`);
    L.push("");
  }
  if (r.untaggedInstanceSets.length) {
    L.push(`## Instance sets with no evidence in the probe (${r.untaggedInstanceSets.length})`, "",
      "*Tag coverage, not presence: these carry no `data-dt-node` and no reported setName. They may well be built — a repeated row rendered by one `.map()` or a shared shell is expected to leave gaps here. Not a failure on its own.*", "");
    for (const m of r.untaggedInstanceSets.slice(0, 40)) L.push(`- ${m.setName} — ${m.instances} instance(s), e.g. \`${m.nodeIds[0]}\``);
    if (r.untaggedInstanceSets.length > 40) L.push(`- …and ${r.untaggedInstanceSets.length - 40} more`);
    L.push("");
  }
  const bad = r.interactions.filter((i) => i.result === "fail" || i.result === "not-probed");
  if (bad.length) {
    L.push(`## Designed interactions not confirmed (${bad.length})`, "");
    for (const i of bad) L.push(`- \`${i.nodeId}\` ${i.name || ""} — ${i.trigger} → ${i.action}${i.destinationId ? ` (${i.destinationId})` : ""}: **${i.result}**${i.detail ? ` — ${i.detail}` : ""}`);
    L.push("");
  }
  const ungraded = r.interactions.filter((i) => i.result === "undesigned" || i.result === "descoped");
  if (ungraded.length) {
    L.push(`## Interactions not graded (${ungraded.length})`, "", "*undesigned: the destination was never exported; descoped: the owner removed it (plan.descopes).*", "");
    for (const i of ungraded) L.push(`- \`${i.nodeId}\` ${i.name || ""} — ${i.trigger} → ${i.action}${i.destinationId ? ` (${i.destinationId})` : ""}: **${i.result}**${i.detail ? ` — ${i.detail}` : ""}${i.note ? ` — ${i.note}` : ""}`);
    L.push("");
  }
  if (r.notMeasured.length) {
    L.push(`## Not measured (${r.notMeasured.length} node specs)`, "", "*Gaps in the probe, not clean results.*", "");
    for (const n of r.notMeasured.slice(0, 40)) L.push(`- \`${n.nodeId}\` ${n.name || ""} — ${n.why}`);
    if (r.notMeasured.length > 40) L.push(`- …and ${r.notMeasured.length - 40} more`);
    L.push("");
  }
  if (r.fieldsNotMeasured.length) {
    L.push(`## Values the probe did not report on measured nodes (${r.fieldsNotMeasured.length})`, "");
    for (const n of r.fieldsNotMeasured.slice(0, 40)) L.push(`- \`${n.nodeId}\` ${n.name || ""} (${n.field}) — ${n.why}`);
    if (r.fieldsNotMeasured.length > 40) L.push(`- …and ${r.fieldsNotMeasured.length - 40} more`);
    L.push("");
  }
  if (r.notComparable.length || r.unverifiable.length) {
    L.push(`## Excluded by method (${r.notComparable.length + r.unverifiable.length})`, "", "*Stated so they are not mistaken for passes.*", "");
    // (an `unverifiable` row carries `expected`, not `value` — only a notComparable row prints one)
    for (const n of [...r.unverifiable, ...r.notComparable].slice(0, 40)) L.push(`- \`${n.nodeId}\` ${n.name || ""} (${n.field}${"value" in n && n.value !== undefined ? ` ${fmt(n.value)}` : ""}) — ${n.why}`);
    if (r.notComparable.length + r.unverifiable.length > 40) L.push(`- …and ${r.notComparable.length + r.unverifiable.length - 40} more`);
    L.push("");
  }
  const p: Partial<VerifyReportV2["probe"]> = r.probe || {};
  if ((p.unknownKeys && p.unknownKeys.length) || (p.unknownTopLevelKeys && p.unknownTopLevelKeys.length) || p.duplicateNodeIds || p.interactionEvidenceOnHiddenLayers || p.measuredIdsOnHiddenLayers || p.measuredIdsNotInExpectation || (p.inputNotes && p.inputNotes.length)) {
    L.push("## About the probe's input", "");
    for (const k of p.unknownKeys || []) L.push(`- key \`${k.key}\` (${k.count}×) is not read by verify-screen${k.canonical ? ` — the canonical key is \`${k.canonical}\`` : ""}`);
    for (const k of p.unknownTopLevelKeys || []) L.push(`- top-level key \`${k.key}\` is not read by verify-screen${k.canonical ? ` — the canonical key is \`${k.canonical}\`` : ""}`);
    if (p.duplicateNodeIds) L.push(`- ${p.duplicateNodeIds} duplicate node id(s) in nodes[] — the first measurement of each id was used`);
    if (p.measuredIdsOnHiddenLayers) L.push(`- ${p.measuredIdsOnHiddenLayers} measurement(s) are for hidden layers and were ignored`);
    for (const n of p.inputNotes || []) L.push(`- ${n}`);
    if (p.measuredIdsNotInExpectation) L.push(`- ${p.measuredIdsNotInExpectation} measured node id(s) are not in the expectation (e.g. ${(p.measuredIdsNotInExpectationSample || []).map((id) => `\`${id}\``).join(", ")}) — measured against another screen or an older expectation?`);
    if (p.interactionEvidenceOnHiddenLayers) L.push(`- ${p.interactionEvidenceOnHiddenLayers} interaction result(s) are for hidden layers and were ignored — a hidden layer cannot be driven`);
    L.push("");
  }
  L.push("## Limits of this method", "");
  for (const l of r.limits || []) L.push(`- ${l}`);
  return L.join("\n") + "\n";
}
const fmt = (v: unknown): string => (Array.isArray(v) ? v.join("/") : String(v));
// A value that already ends in its unit is printed once (DT-32: a probe's "28px" printed as "28pxpx").
const withUnit = (v: unknown, unit: string | undefined): string => { const t = fmt(v); return unit && !t.endsWith(unit) ? t + unit : t; };

// P3 round 3, finding 315 ("--expect still writes two artefact sets for one screen" — Prompt 3
// criterion 6 reopened): defaulting `--out` to the input's own basename (round 1's fix) only helps
// when the caller actually uses that default. An explicit `--out <nickname>` — which both the verify
// skill's own `<Screen>` placeholder and build-screen's `<Layer>__<id>` convention invite, under two
// different names for the SAME node — still wrote a second, complete artefact set with no warning.
// Scans a directory's own `*.expected.json` files (never a subdirectory — one screen, one flat
// design/verify/) for one whose `frame.nodeId` already matches, at a DIFFERENT basename than the one
// about to be written. Returns that file's path, or null.
function findExistingExpectedFor(dir: string, nodeId: string | undefined, ownTarget: string): string | null {
  if (!nodeId || !fs.existsSync(dir)) return null;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".expected.json")) continue;
    const full = path.join(dir, f);
    if (path.resolve(full) === path.resolve(ownTarget)) continue;
    // an expectation this repo wrote — only frame.nodeId is looked at
    const doc = readJsonOrNull(full, isJsonObject);
    if (doc && isJsonObject(doc.frame) && doc.frame.nodeId === nodeId) return full;
  }
  return null;
}

// The plan(s) under design/plan/ (relative to the working directory) that describe this frame: by the frame's
// node id (plan.nodeId, or a `<Layer>__<id>` file name) or by name (the plan's own stem, or its export's).
function plansFor(frameId: string | undefined, stem: string): Array<{ file: string; plan: Plan }> {
  const planDir = path.join("design", "plan");
  const hits: Array<{ file: string; plan: Plan }> = [];
  for (const f of fs.existsSync(planDir) ? fs.readdirSync(planDir).filter((x) => x.endsWith(".json")).sort() : []) {
    // a plan under design/plan/ (plan-skeleton.ts); one that is not a readable plan describes nothing
    const p = readJsonOrNull(path.join(planDir, f), isPlan);
    if (!p) continue;
    const byId = frameId && (p.nodeId === frameId || new RegExp(`__${String(frameId).replace(":", "_")}$`).test(path.basename(f, ".json")));
    const byName = path.basename(f, ".json") === stem || (p.file && path.basename(String(p.file), ".json") === stem);
    if (byId || byName) hits.push({ file: path.join(planDir, f).split(path.sep).join("/"), plan: p });
  }
  return hits;
}

/** --accept's selection: the report deltas one waiver row each is written for, or why there are none. */
function selectForAccept(rep: VerifyReport, sel: { node?: string | undefined; field?: string | undefined; group?: string | undefined }): { deltas: VerifyDelta[] } | { error: string } {
  const deltas: VerifyDelta[] = Array.isArray(rep.deltas) ? rep.deltas : [];
  const picked = sel.group !== undefined ? deltas.filter((d) => d.group === sel.group)
    : deltas.filter((d) => d.nodeId === sel.node && (sel.field === undefined || d.field === sel.field));
  if (picked.length) return { deltas: picked };
  if (sel.group !== undefined) {
    const gs = [...new Set(deltas.map((d) => d.group).filter((g): g is string => !!g))];
    return { error: `no delta in the report belongs to group '${sel.group}'${gs.length ? ` (groups: ${gs.join(", ")})` : " (the report has no groups)"}` };
  }
  const id = sel.node;
  // Not a delta = not waivable (D5): say which kind of item it is instead.
  if ((rep.componentsAbsent || []).some((c) => c.nodeIds.includes(String(id)))) return { error: `${id} belongs to a component set reported ABSENT — a missing component is never waivable (D5); build it` };
  if ((rep.interactions || []).some((i) => i.nodeId === id && i.result === "fail")) return { error: `${id} is a failed interaction — never waivable (D5); fix it, or have the owner descope it in plan.descopes (D20)` };
  if ((rep.notMeasured || []).some((n) => n.nodeId === id)) return { error: `${id} was not measured — there is no delta to accept; measure it (or fold it, plan anchor foldedInto) first` };
  if (sel.field !== undefined && (rep.fieldsNotMeasured || []).some((n) => n.nodeId === id && n.field === sel.field)) return { error: `${id} (${sel.field}) was not measured — there is no delta to accept` };
  const fields = deltas.filter((d) => d.nodeId === id).map((d) => d.field);
  return { error: `no delta in the report for ${id}${sel.field !== undefined ? ` field '${sel.field}'` : ""}${fields.length ? ` (its deltas: ${fields.join(", ")})` : ""}` };
}

export { buildExpectation, compare, reportToMarkdown, selectForAccept, probeLine, expectNode, STYLE_KEYS, MEASURED_KEYS_DOC, normColor, normWeight, normFamily, lineHeightPx, tokenFor, radiusCorners, findExistingExpectedFor, TOLERANCE, FIELDS, EXPECTATION_SCHEMA, REPORT_SCHEMA };


// ---------------------------------------------------------------- CLI
function main(argv: string[]): number {
  const sha = (file: string): string => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const USAGE =
    "usage:\n" +
    `  ${scriptCmd("verify-screen")} --expect <screen.json>... --out design/verify/<Screen> [--force]\n` +
    "      writes <Screen>.expected.json — the design's own numbers, as data, for VISIBLE layers only.\n" +
    "      Read them; never retype them. --out defaults to design/verify/<the first input file's own basename>.\n" +
    "      Refuses (exit 1) if the same node already has an expectation under a DIFFERENT name in this\n" +
    "      directory — pass --force to write a second one anyway.\n" +
    `  ${scriptCmd("verify-screen")} --compare <Screen>.expected.json <measured.json> [--interactions <file>] [--against <report.json>] --out design/verify/<Screen>\n` +
    "      writes <Screen>.report.json + .md and exits 1 unless the verdict passes (pass / pass-with-deviations). It has NO browser: it compares\n" +
    "      two JSON files. Interaction results come from measured.json's interactions[] and/or --interactions <file>\n" +
    "      (a JSON array, or {interactions:[…], components:[…]}, of {nodeId, trigger, ok, selector, selectorCount, detail};\n" +
    "      components[] rows {setName|nodeId, present} are merged with measured.json's).\n" +
    "      --out defaults to design/verify/<the .expected.json file's own basename>.\n" +
    "      Coverage is compared with the report this run overwrites (or --against <report.json>): a drop in nodes\n" +
    "      measured prints COVERAGE FELL, a different probe prints 'probe changed'. Neither changes the verdict.\n" +
    "      The plan for this frame (design/plan/, or --plan <plan.json>) supplies waivers[] and descopes[]: an accepted\n" +
    "      delta stays listed but leaves the counts; with nothing else open the verdict is 'pass-with-deviations' (exit 0).\n" +
    `  ${scriptCmd("verify-screen")} --accept <Screen>.report.json (--node <id> (--field <label> | --all-fields) | --group <gid>) --reason "<why>" --by "<who>" [--plan <plan.json>]\n` +
    "      writes one plan waiver per node + field from the report's delta(s), bound to the export content, the designed\n" +
    "      and the built value (any change reopens it). Only on the owner's explicit word. Refuses a node with no delta:\n" +
    "      absent components, failed interactions and unmeasured nodes are never waivable. Re-run --compare to apply.";
  if (argv.includes("--help") || argv.includes("-h") || !argv.length) { console.log(USAGE); return argv.length ? 0 : 2; }

  const OPTIONS = {
    out: { type: "string" }, interactions: { type: "string" }, against: { type: "string" }, force: { type: "boolean" }, expect: { type: "boolean" }, compare: { type: "boolean" },
    accept: { type: "boolean" }, node: { type: "string" }, field: { type: "string" }, group: { type: "string" }, reason: { type: "string" }, by: { type: "string" }, plan: { type: "string" }, "all-fields": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  } as const;
  const { values: flags, positionals: files } = cliParse("verify-screen", argv, OPTIONS, USAGE, 2, (args) => parseArgs({ args, options: OPTIONS, allowPositionals: true }));
  const { out, interactions: interactionsFile, against: againstFile, plan: planFlag } = flags;
  const force = !!flags.force, doExpect = !!flags.expect, doCompare = !!flags.compare, doAccept = !!flags.accept;
  if ([doExpect, doCompare, doAccept].filter(Boolean).length !== 1) { console.error("pass exactly one of --expect / --compare / --accept\n" + USAGE); return 2; }
  for (const k of ["node", "field", "group", "reason", "by", "all-fields"] as const) if (flags[k] !== undefined && !doAccept) { console.error(`--${k} only applies to --accept\n` + USAGE); return 2; }
  if (planFlag !== undefined && doExpect) { console.error("--plan only applies to --compare / --accept\n" + USAGE); return 2; }
  if (doAccept) return acceptMain(files, flags, USAGE);
  if (interactionsFile !== undefined && !doCompare) { console.error("--interactions only applies to --compare\n" + USAGE); return 2; }
  if (againstFile !== undefined && !doCompare) { console.error("--against only applies to --compare\n" + USAGE); return 2; }

  const write = (base: string | undefined, obj: unknown, md?: string): void => {
    if (!base) { process.stdout.write(JSON.stringify(obj, null, 2) + "\n"); return; }
    fs.mkdirSync(path.dirname(base), { recursive: true });
    fs.writeFileSync(base + (doExpect ? ".expected.json" : ".report.json"), JSON.stringify(obj, null, 2) + "\n");
    if (md) fs.writeFileSync(base + ".report.md", md);
    console.error(`wrote ${base}${doExpect ? ".expected.json" : ".report.json"}${md ? " and " + base + ".report.md" : ""}`);
  };

  if (doExpect) {
    const firstFile = files[0];
    if (firstFile === undefined) { console.error("--expect needs at least one screen export\n" + USAGE); return 2; }
    const docs: ExpectInput[] = files.map((f) => ({ doc: readDocFile(f, "screen export", isScreenDoc), label: path.basename(f, ".json") }));
    // F-60: the export's own index (relative to the project root) tells which destinations were exported
    const indexFile = path.join("design", "export", "pages", "index.json");
    const idx = readJson(indexFile, isPagesRootIndex);
    if (!("doc" in idx) && !idx.missing) console.error(`note  ${indexFile} ${idx.error} — interaction destinations are checked against the given export(s) only`);
    // The root index is REPLACED by a page walk (only single-screen pulls merge into it), so the frames an earlier
    // walk exported live on only in their page's own pages/<dir>/index.json: read every one on disk too, or a
    // destination exported by the first walk reads as "never exported" after the second (review H2).
    const pagesDir = path.join("design", "export", "pages");
    const pageRows: IndexRow[] = [];
    let dirs: string[] = [];
    try { dirs = fs.readdirSync(pagesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* no pages dir */ }
    for (const d of dirs) {
      const pi = readJson(path.join(pagesDir, d, "index.json"), isPageIndex);
      if ("doc" in pi) pageRows.push(...pi.doc.layers);
    }
    const rootRows: IndexRow[] = "doc" in idx ? idx.doc.layers || [] : [];
    const seen = new Set(rootRows.map((l) => `${l.id}\u0000${l.sourceFile ?? ""}`));
    const layers = [...rootRows, ...pageRows.filter((l) => !seen.has(`${l.id}\u0000${l.sourceFile ?? ""}`))];
    const exp = buildExpectation(docs, "doc" in idx || layers.length ? { index: { layers, ...ifDefined("sourceFile", "doc" in idx ? idx.doc.sourceFile : undefined) } } : null);
    // P3 #152: `--expect` run once by base name and once by a nickname for the SAME screen wrote
    // two byte-identical files (`positions___7314_87192.expected.json` and `JobRoles.expected.json`)
    // because nothing tied the output name to the screen's own identity. Defaulting to the FIRST
    // input file's own basename — already `<LayerName>__<node-id>` by construction (write-out.js) —
    // means two runs against the same export file always land on the same name, whatever string the
    // caller typed on the command line.
    const outBase = out || path.join("design", "verify", path.basename(firstFile, ".json"));
    // Findings 153/181: re-running --expect replaced the file in place and left a measurement and a
    // report from the OLD expectation beside it, undated. The file itself stays byte-deterministic
    // (finding 154) — the notice goes to stderr, and every report records the sha it was computed on.
    const target = outBase + ".expected.json";
    // Finding 315 / P3 c6: an explicit --out under a DIFFERENT name than the one already indexing
    // this node (e.g. --out design/verify/JobRoles when design/verify/positions___7314_87192 already
    // covers node 7314:87192) is refused rather than silently creating a second artefact set.
    const dup = findExistingExpectedFor(path.dirname(target) || ".", exp.frame && exp.frame.nodeId, target);
    if (dup && !force) {
      console.error(
        `error  node ${exp.frame.nodeId} already has an expectation at ${dup} — refusing to also write ${target} ` +
          "(one screen, one artefact set). Use that existing name, or pass --force to write this one anyway."
      );
      return 1;
    }
    const next = JSON.stringify(exp, null, 2) + "\n";
    const prev = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
    write(outBase, exp);
    const h = crypto.createHash("sha256").update(next).digest("hex");
    let prevContent: JsonValue | undefined = null;
    try { if (prev !== null) { const prevDoc: unknown = JSON.parse(prev); prevContent = isJsonObject(prevDoc) ? prevDoc.exportContentSha256 : null; } } catch { /* unreadable */ }
    if (prev !== null && prev === next) console.error(`note  ${target} was already identical (sha256 ${h.slice(0, 12)}…) — unchanged`);
    else if (prev !== null && prevContent && prevContent === exp.exportContentSha256 && prev.replace(/"exportedAt": "[^"]*"/, "") === next.replace(/"exportedAt": "[^"]*"/, "")) {
      // Finding 314: a re-pull with nothing changed rewrites only exportedAt. Same design, same specs —
      // the measurements and report beside it still describe it.
      console.error(`note  ${target}: only exportedAt changed (export content sha256 ${exp.exportContentSha256.slice(0, 12)}… unchanged) — existing measurements and report still apply`);
    } else if (prev !== null) {
      console.error(`note  REPLACED an existing ${target} that differed (sha256 ${crypto.createHash("sha256").update(prev).digest("hex").slice(0, 12)}… → ${h.slice(0, 12)}…)`);
      const stale = [".measured.json", ".report.json", ".report.md"].map((s) => outBase + s).filter((f) => fs.existsSync(f));
      if (stale.length) console.error(`warn  ${stale.join(", ")} ${stale.length > 1 ? "were" : "was"} computed against the PREVIOUS expectation — re-measure and re-compare before reading ${stale.length > 1 ? "them" : "it"}.`);
    }
    const hc = exp.counts.hidden;
    console.error(`${exp.counts.nodes} node spec(s), ${exp.counts.instances} instance(s), ${exp.counts.interactions} designed interaction(s) — visible layers only; ` +
      `skipped ${hc.layers} hidden layer(s) (${hc.specsSkipped} spec(s), ${hc.instancesSkipped} instance(s), ${hc.interactionsSkipped} interaction(s)); ` +
      `${exp.counts.notComparable} design value(s) excluded by method (listed in notComparable) · expectation sha256 ${h.slice(0, 12)}…`);
    if (!exp.counts.interactions) console.error("note  this export declares no `reactions` on visible layers — interaction coverage cannot be checked, and the report will say so rather than passing.");
    return 0;
  }

  const [expFile, measuredFile] = files;
  if (!expFile || !measuredFile) { console.error("--compare needs <expected.json> <measured.json>\n" + USAGE); return 2; }
  const expectation = readDocFile(expFile, "expectation", isVerifyExpectation);
  const measuredRaw = readJsonFile(measuredFile, "probe measurements",
    "Render the built screen and write {measuredAt, renderer, viewport, artifacts, expectationSha256, nodes:[{nodeId,styles}], components:[], interactions:[]}.");
  // A malformed OPTIONAL extra (a hand-written `probe: "handmade"`, `notMeasured: {}`) is dropped with a note;
  // only measurements compare cannot read at all are refused.
  const readable = readableMeasured(measuredRaw);
  if (!readable) { console.error(`error  probe measurements: '${measuredFile}' is not ${isVerifyMeasured.expected}`); return 2; }
  const measured = readable.doc;
  for (const n of readable.notes) console.error(`note  ${measuredFile}: ${n}`);
  let extra: InteractionEvidence[] | undefined;
  let extraComponents: MeasuredComponent[] | undefined;
  if (interactionsFile) {
    const raw = readJsonFile(interactionsFile, "interaction evidence", "Write a JSON array of {nodeId, trigger, ok, selector, selectorCount, detail}.");
    // The object form ({interactions:[…], components:[…]}, the verifier's evidence.json) may carry either list.
    const obj = isJsonObject(raw) ? raw : null;
    const list = isInteractionEvidenceList(raw) ? raw : obj && isInteractionEvidenceList(obj.interactions) ? obj.interactions
      : obj && obj.interactions === undefined && obj.components !== undefined ? [] : null;
    const comps = obj && obj.components !== undefined ? (isMeasuredComponentList(obj.components) ? obj.components : null) : [];
    if (!list || !comps) { console.error(`--interactions ${interactionsFile}: expected a JSON array or {interactions:[…], components:[…]}`); return 2; }
    extra = list;
    if (comps.length) extraComponents = comps;
  }
  // Artifacts are checked on disk, relative to the working directory (the project root), so a report
  // can never cite a screenshot that does not exist (findings 166/190).
  const artifacts = measured.artifacts || [];
  const artifactCheck: ArtifactCheck[] = artifacts.map((a) => {
    const p = typeof a === "string" ? a : a && a.path;
    const exists = !!p && fs.existsSync(p);
    return { ...ifDefined("path", p), exists, image: !!p && /\.(png|jpe?g|webp)$/i.test(p), ...ifDefined("sha256", exists ? sha(p) : undefined) };
  });
  // Finding 317: tie the report to the code it measured — the plan (design/plan/*.json) for this
  // frame lists the files; their content hashes and `git rev-parse HEAD` go into report.inputs.code.
  let code: CodeInputs | undefined;
  // D5/D20/F-77: the same plan supplies waivers[], descopes[] and foldedInto anchors — found whether or not it lists files.
  let planHit: { file: string; plan: Plan } | undefined;
  if (planFlag !== undefined) {
    const r = readJson(planFlag, isPlan);
    if (!("doc" in r)) { console.error(`--plan '${planFlag}' ${r.error}`); return 2; }
    planHit = { file: planFlag.split(path.sep).join("/"), plan: r.doc };
  }
  {
    const frameId = expectation.frame && expectation.frame.nodeId;
    const stem = path.basename(expFile, ".json").replace(/\.expected$/, "");
    const all = planHit ? [planHit] : plansFor(frameId, stem);
    const hits = all.filter((h) => h.plan.files);
    const onlyHit = hits.length === 1 ? hits[0] : undefined;
    if (!planHit) planHit = all.length === 1 ? all[0] : onlyHit;
    if (!planHit && all.length > 1) console.error(`note  ${all.length} plans in design/plan/ describe this frame (${all.map((h) => h.file).join(", ")}) — no waivers/descopes applied; pass --plan <plan.json>`);
    if (onlyHit && onlyHit.plan.files) {
      code = { plan: onlyHit.file, files: fileHashes(onlyHit.plan.files, process.cwd()), gitHead: gitHead(process.cwd()) };
    } else {
      console.error(hits.length ? `note  ${hits.length} plans in design/plan/ describe this frame (${hits.map((h) => h.file).join(", ")}) — the report records no code hashes, so its status cannot be tied to the code`
        : all.length ? `note  ${all.map((h) => h.file).join(", ")} list${all.length === 1 ? "s" : ""} no files[] — the report records no code hashes, so verify-build --status cannot tie it to the code`
        : "note  no plan in design/plan/ describes this frame — the report records no code hashes (run from the project root), so verify-build --status cannot tie it to the code");
    }
  }
  const planInputs = planHit ? {
    ...ifDefined("waivers", planHit.plan.waivers), ...ifDefined("descopes", planHit.plan.descopes), ...ifDefined("anchors", planHit.plan.anchors),
    waiversInput: { plan: planHit.file, sha256: waiversHash(planHit.plan) },
  } : {};
  // Same rule as --expect (P3 #152): default to the EXPECTATION file's own basename (stripping the
  // `.expected` suffix it was written with), so `--compare <Screen>.expected.json <measured.json>`
  // always reports under `<Screen>.report.*`, never a second name for the same screen.
  const compareBase = out || path.join("design", "verify", path.basename(expFile, ".json").replace(/\.expected$/, ""));
  // D18 (DT-44): the report this run is about to overwrite is the coverage baseline — read BEFORE writing.
  // --against names another one. An explicit file that cannot be read is an error; an unreadable implicit
  // one is only noted (it is about to be replaced anyway).
  let against: { file: string; report: VerifyReport } | undefined;
  if (againstFile !== undefined) {
    const r = readJson(againstFile, isVerifyReport);
    if (!("doc" in r)) { console.error(`--against '${againstFile}' ${r.error}`); return 2; }
    against = { file: againstFile, report: r.doc };
  } else {
    const own = compareBase + ".report.json";
    const r = readJson(own, isVerifyReport);
    if ("doc" in r) against = { file: own, report: r.doc };
    else if (!r.missing) console.error(`note  ${own} ${r.error} — no coverage baseline this round (it is about to be overwritten)`);
  }
  const rep = compare(expectation, measured, { ...(readable.notes.length ? { inputNotes: readable.notes } : {}), ...ifDefined("interactions", extra), ...ifDefined("components", extraComponents), expectationSha256: sha(expFile), measuredSha256: sha(measuredFile), artifactCheck, ...ifDefined("code", code), ...ifDefined("against", against), ...planInputs });
  const md = reportToMarkdown(rep);
  write(compareBase, rep, md);
  console.error(rep.headline);
  console.error(probeLine(rep));
  const nie = rep.probe.measuredIdsNotInExpectation || 0;
  if (nie) console.error(`note  ${nie} measured node id(s) are not in the expectation (e.g. ${(rep.probe.measuredIdsNotInExpectationSample || []).join(", ")}) — measured against another screen or an older expectation?`);
  for (const w of rep.waivers.reopened) console.error(`warn  waiver REOPENED ${w.nodeId} (${w.field}): ${w.why}`);
  if (rep.waivers.unused.length) console.error(`note  ${rep.waivers.unused.length} plan waiver(s)/descope(s) match nothing this round: ${rep.waivers.unused.map((w) => `${w.nodeId} (${w.field})`).join(", ")} — fixed? drop them`);
  return isPassingVerdict(rep.verdict) ? 0 : 1;
}

// D23: `--accept <report> (--node <id> [--field <label>] | --group <gid>) --reason … --by … [--plan <plan.json>]`.
// Copies the report delta(s) into plan.waivers[] — one row per node + field — bound to the export content hash
// and to the designed and built values. It never grades anything: the next --compare applies (or reopens) them.
function acceptMain(files: string[], flags: { node?: string | undefined; field?: string | undefined; group?: string | undefined; reason?: string | undefined; by?: string | undefined; plan?: string | undefined; "all-fields"?: boolean | undefined }, USAGE: string): number {
  const reportFile = files[0];
  if (!reportFile || files.length > 1) { console.error("--accept needs exactly one <Screen>.report.json\n" + USAGE); return 2; }
  if ((flags.node === undefined) === (flags.group === undefined)) { console.error("--accept needs exactly one of --node <id> / --group <gid>\n" + USAGE); return 2; }
  if ((flags.field !== undefined || flags["all-fields"]) && flags.group !== undefined) { console.error("--field / --all-fields go with --node, not --group\n" + USAGE); return 2; }
  // One "keep the 16px" must not also waive a copy or colour delta on the same node: name the field, or say all.
  if (flags.node !== undefined && (flags.field === undefined) === !flags["all-fields"]) { console.error("--accept --node needs exactly one of --field \"<label>\" / --all-fields\n" + USAGE); return 2; }
  const reason = (flags.reason || "").trim(), by = (flags.by || "").trim();
  if (!reason || !by) { console.error(`--accept needs ${!reason ? "--reason \"<why this deviation is intended>\"" : ""}${!reason && !by ? " and " : ""}${!by ? "--by \"<who decided>\"" : ""} — a waiver without a reason and a decider is not recorded\n` + USAGE); return 2; }
  const r = readJson(reportFile, isVerifyReport);
  if (!("doc" in r)) { console.error(`error  report: '${reportFile}' ${r.error}`); return 2; }
  const report = r.doc;
  const exportSha = report.inputs && report.inputs.exportContentSha256;
  if (!exportSha) { console.error(`error  ${reportFile} records no inputs.exportContentSha256 — re-run --expect and --compare, then accept against the new report`); return 1; }
  const sel = selectForAccept(report, { node: flags.node, field: flags.field, group: flags.group });
  if ("error" in sel) { console.error(`refused  ${sel.error}`); return 1; }

  // the plan: --plan, else the one the report was compared with, else the one that describes this report's screen
  const stem = path.basename(reportFile, ".json").replace(/\.report$/, "");
  const recorded = (report.inputs && report.inputs.waivers && report.inputs.waivers.plan) || (report.inputs && report.inputs.code && report.inputs.code.plan) || undefined;
  let planFile = flags.plan ?? (recorded && fs.existsSync(recorded) ? recorded : undefined);
  if (!planFile) {
    const hits = plansFor(report.nodeId, stem);
    const only = hits.length === 1 ? hits[0] : undefined;
    if (!only) { console.error(hits.length ? `error  ${hits.length} plans describe this screen (${hits.map((h) => h.file).join(", ")}) — pass --plan <plan.json>` : "error  no plan in design/plan/ describes this screen (run from the project root, or pass --plan <plan.json>)"); return 1; }
    planFile = only.file;
  }
  const pr = readJson(planFile, isPlan);
  if (!("doc" in pr)) { console.error(`error  plan: '${planFile}' ${pr.error}`); return 1; }
  const plan = pr.doc;
  const decidedAt = new Date().toISOString();
  const waivers: PlanWaiver[] = Array.isArray(plan.waivers) ? [...plan.waivers] : [];
  const wrote: string[] = [];
  for (const d of sel.deltas) {
    const row: PlanWaiver = { nodeId: d.nodeId, field: d.field, designed: d.expected, built: d.actual, exportContentSha256: exportSha, reason, decidedBy: by, decidedAt, ...ifDefined("cause", flags.group) };
    // one row per node + field: a new decision replaces the old one
    const at = waivers.findIndex((w) => isJsonObject(w) && w.nodeId === d.nodeId && w.field === d.field);
    if (at >= 0) waivers[at] = row; else waivers.push(row);
    wrote.push(`${at >= 0 ? "replaced" : "added"}  ${d.nodeId} ${d.name ? `(${d.name}) ` : ""}${d.field}: designed ${fmt(d.expected)}, built ${fmt(d.actual)}`);
  }
  plan.waivers = waivers;
  const tmp = `${planFile}.${process.pid}.tmp`; // write-then-rename: a crash never leaves half a plan
  fs.writeFileSync(tmp, JSON.stringify(plan, null, 2) + "\n");
  fs.renameSync(tmp, planFile);
  console.error(`wrote ${wrote.length} waiver(s) to ${planFile} (decided by ${by}: ${reason})`);
  for (const w of wrote) console.error(`  ${w}`);
  console.error(`re-run --compare to apply ${wrote.length === 1 ? "it" : "them"}: an accepted delta stays listed, leaves the counts, and reopens if the design is re-exported or the built value moves.`);
  return 0;
}

if (import.meta.main ?? isMainFallback(import.meta.url)) process.exitCode = main(process.argv.slice(2));
