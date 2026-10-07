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
import { isBuildIdentity, isInteractionEvidenceList, isMeasuredBehaviour, isMeasuredComponentList, isMeasuredVisual, isVisualRegion, isPageIndex, isPageOverflow, isPagesRootIndex, isPlan, isPlanDescope, isPlanWaiver, isProbeIdentity, isProbeReach, isVerifyExpectation, isVerifyMeasured, isVerifyReport, readableMeasured } from "./doc-guards.ts";
import { isPassingVerdict, planInteractionsSha256, waiversHash } from "./plan-waivers.ts";
import { actionForExpect, isPlanExpect, parseSteps, stepsSha256 } from "./probe-steps.ts";
import { MEASURED_PHASES, STATUS_PHASES, readStatusAt, statusFile, statusMain, waitMain, writeFileAtomic } from "./verify-run.ts";
import type { VerifyStatusV2 } from "./verify-run.ts";
import { readJson, readJsonOrNull } from "./read-json.ts";
import { cliParse, scriptCmd, shellArg } from "./cli-args.ts";
import { parseArgs } from "node:util";
import { isJsonObject } from "./types.ts";
import { isScreenDoc, screenExportOf, screenRoots } from "./export-shape.ts";
import { colorKey } from "./color.ts";
import { CANONICAL_MATCHED_BY } from "./probe-match.ts";
import type { MatchedBy } from "./probe-match.ts";
import type {
  Action, ArtifactCheck, BehaviourCheck, BehaviourStatus, BehaviourSummary, Box, CodeInputs, DeltaSeverity, DrawnState, IndexRow, InteractionEvidence, IrNode, JsonValue, LayoutSpec, MeasuredComponent, MeasuredNode, MeasuredStyles,
  NotComparable, PageOverflowCoverage, Paint, Plan, PlanAnchor, PlanDescope, PlanWaiver, ProbeFrame, Reaction, ReactionTrigger, ReportBehaviour, ReportVisual, ScreenDoc, SolidPaint, VerifyDelta, VerifyCoverageV2, VerifyExpectation, VerifyInstance, VerifyInteraction,
  VerifyInteractionResult, VerifyMeasured, VerifyFrame, VerifyReferenceImage, VerifyReferenceUnusable, VerifyAgainst, VerifyReport, VerifyReportV2, VerifyRootFrame, VerifySpec, VerifyVerdict,
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
  // DT-74 (D34): a stroke's own tolerance, inclusive — a lost 1px border (1 → 0) is a delta; the padding tolerance (1) let it pass
  stroke: 0.5,
  // DT-75 (D29): a fixed/fill-width TEXT's INK width (renderBox.w) against a Range's width (the layout advance box,
  // side bearings included). Empirical: hand-written textBox.w − renderBox.w was −0.63..+2.41 px (p5..p95, n=157)
  // in the field runs. Known miss: heavy italics/overhang can exceed it.
  textInk: 3,
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
    // A Range's getBoundingClientRect().x is the text's LAYOUT start (side bearings included, not ink). F-80: for hug
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
// ts-port: legacy/producer-mismatch read kept as-is (item 1) — `grow` is a number in the producer; `=== true` is an older export's spelling.
interface LegacyGrow { grow?: number | boolean; heightMode?: IrNode["heightMode"]; widthMode?: IrNode["widthMode"] }
const growsAlong = (c: IrNode, dir: string): boolean => { const lc: LegacyGrow = c; return lc.grow === 1 || lc.grow === true || (dir === "column" ? lc.heightMode === "fill" : lc.widthMode === "fill"); };

// ts-port: legacy/producer-mismatch read kept as-is (item 2) — the older layout spelling
// (itemSpacing, paddingTop/Right/Bottom/Left) beside the producer's gap/padding[].
interface LegacyLayout extends LayoutSpec { itemSpacing?: number; paddingTop?: number; paddingRight?: number; paddingBottom?: number; paddingLeft?: number }
const PAD_KEYS = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"] as const;
const PAD_SIDES = ["top", "right", "bottom", "left"] as const;
type PadSide = (typeof PAD_SIDES)[number];

// F-79: per FIXED axis (no widthMode/heightMode for it), padding the design cannot show: padding + in-flow content
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
        // review H3: Figma still insets the first child by the START padding of a start-aligned box whose content
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
    if (st.align) spec.strokeAlign = st.align; // (after the weight/weights chain — review M1)
  }
  // Radius: one number, or per-corner. A per-corner radius with UNEQUAL corners (a table header
  // rounded only at the top) is compared corner by corner — the old code read `radius.tl` only, so
  // a card rounded at the bottom ({bl,br}) produced no radius spec at all (finding 162).
  // F-75: a radius shows only where something draws the corners — a visible fill or stroke, an effect, or a clip of
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
  // DT-50: an asset/geometry/assetSkipped leaf is one exported image — whatever padding/gap an OLD export inferred for it is
  // the inset already baked into the file (new exports carry no `layout` on such a leaf). Never compared.
  if (L && typeof L === "object" && (n.asset || n.geometry || n.assetSkipped)) {
    const BAKED = "inset baked into the exported asset (DT-50)";
    const g = typeof L.gap === "number" ? L.gap : typeof L.itemSpacing === "number" ? L.itemSpacing : undefined;
    if (g !== undefined) skip("gap", g, BAKED);
    const pad = Array.isArray(L.padding) ? L.padding.slice(0, 4) : PAD_KEYS.some((k) => typeof L[k] === "number") ? PAD_KEYS.map((k) => L[k]) : null;
    if (pad && pad.some((v) => typeof v === "number" && v !== 0)) skip("padding", pad.map((v) => (typeof v === "number" ? v : 0)), BAKED);
  } else if (L && typeof L === "object") {
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
    if (pad && pad.some((v) => typeof v === "number" && v !== 0)) {
      const p4 = pad.map((v) => (typeof v === "number" ? v : 0));
      // F-79: padding that cannot show on a FIXED axis is not compared there (paddingSkip + a notComparable row per axis)
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
      // DT-75 / F-62 / F-64 (D29): a TEXT's width. Hug text (autoResize width_and_height) IS its box — compared with
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
    } else {
      if (typeof n.box.w === "number") spec.width = n.box.w;
      if (typeof n.box.h === "number") spec.height = n.box.h;
      // D31: a hug axis may GROW in the build (more content) without the match being wrong
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
  // DT-74: the exporter omits opacity 1 — a node that paints or carries copy states it anyway, so a control
  // rendered at opacity 0.5 is a delta instead of passing unchecked
  else if (spec.text !== undefined || spec.placeholderText !== undefined || spec.color !== undefined || spec.backgroundColor !== undefined || spec.fill !== undefined || spec.borderColor !== undefined || spec.decorated) spec.opacity = 1;

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
  "IS the page). A TEXT node's x and width are read ONLY from textBox {x,w} — a Range over its characters, " +
  "never the element's box. Its width is the text box for hug text (autoResize width_and_height) and the INK " +
  "width (the export's renderBox, widthFrom renderBox) for fixed- or fill-width text, whose box is wider than its " +
  "words; its x is the box's left edge for hug or left-aligned text, else the ink start. TEXT nodes carry no y " +
  "and no height (vertical ink and line boxes depend on font metrics). " +
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
 *  interaction whose destination was never exported. A row's file is its own sourceFile stamp only. */
export interface ExpectOptions { index?: { layers: IndexRow[] } | null;
  /** D32: reads a sibling screen export by its index row's `file` (relative to the export root) — aliases are built
   *  from the siblings of the SAME Figma file (the F-60/L-3 candidate rows); absent = no aliases */
  readSibling?: ((file: string) => ScreenDoc | null | undefined) | null;
  /** F-95: the plan for this screen — its interactions[] rows are merged (source "plan") when valid, the rest dropped
   *  with why; recorded as expectation.planInteractions (only when the plan has an interactions list) */
  plan?: { file: string; plan: Plan } | null;
  /** 12c: reads the reference PNG by its export pointer (`assets/<file>`, relative to design/export/); null = not on
   *  disk. Absent = no expectation.referenceImage is written (an in-memory caller with no export on disk). */
  readReference?: ((pointer: string) => Uint8Array | null) | null;
  /** 12c: design/export/design-system.json's `colorProfile` stamp (bridge doc-types DesignSystemStamp), when read */
  colorProfile?: string | null }

// D32: the OUTERMOST instances (no INSTANCE ancestor) of a screen's visible tree, by main component key, each indexed
// by the visible NAME PATH from the instance root ("" = the root itself) → node id. A path that repeats inside the
// instance maps to null (ambiguous). Hidden layers are skipped (hidden.ts: the flag is inherited).
// Each path also carries a CONTENT signature, and an alias needs both to agree (live run, group 11 review): a selected
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
    // review M5: a node with no text of its own (a close icon) is also placed by its nearest ancestor (within the
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
const idSuffix = (id: string): string | null => { const i = id.indexOf(";"); return i === -1 ? null : id.slice(i + 1); };

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
  // F-60 / L-3: each file's screen roots (id → name) — the index row that IS this screen ties it to its file
  // (names: the root's own and the export's title — a multi-frame selection pull is indexed as "selection", review M-a)
  const rootsByFile = new Map<string, Map<string, Set<string>>>();
  const interactionFile = new Map<VerifyInteraction, string | undefined>();
  const roots: IrNode[] = [];
  const rootNodesByFile = new Map<string, IrNode[]>(); // D32: each Figma file's input roots
  const visibleById = new Map<string, { name: string; file: string }>(); // F-95: a plan row's node — its name and file

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
        // (the title only for the frame the pull is filed under — the index row carries that one id, review LOW-1)
        for (const n of [root.name, exp && exp.nodeId === root.id ? exp.screen : undefined]) if (typeof n === "string" && n) names.add(n);
      }
      getOrInit(rootNodesByFile, sourceFile ?? "", () => []).push(root);
      if (!reference && root.reference) reference = root.reference;
      const b: Partial<Box> = root.box || {};
      const frame: Partial<VerifyFrame> = { nodeId: root.id, name: root.name, ...ifDefined("w", b.w), ...ifDefined("h", b.h), ...ifDefined("x", b.x), ...ifDefined("y", b.y), clip: root.clip === true,
        ...ifDefined("scroll", root.scroll) }; // D43: a frame designed to scroll sideways
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
        if (n.id) visibleById.set(n.id, { name: n.name, file: sourceFile ?? "" });
        const { spec, notComparable: gaps } = expectNodeRow(n, { path: c.path, frame, ...ifDefined("inheritedState", inherited), ...ifDefined("frameId", frameId) });
        spec.ancestorIds = ancestorIds;
        if (n.absolute) spec.absolute = true;
        const par = c.parent;
        const sibs = par && Array.isArray(par.children) ? par.children : [];
        const nFixed = par && typeof par.fixedChildren === "number" ? par.fixedChildren : 0;
        if (par && (fixedNodes.has(par) || (nFixed > 0 && sibs.indexOf(n) >= sibs.length - nFixed))) { fixedNodes.add(n); spec.fixed = true; }
        if (spec.drawnState) stateOf.set(n, inherited || { state: spec.drawnState, why: spec.drawnStateWhy || "", from: n.name || n.id });
        if (checkable(spec)) nodes.push(spec);
        else {
          // review M2: a group-11 exclusion (radius on a layer that draws nothing, padding the box cannot show) took the
          // node's only checkable value — it is not a spec any more; say so rather than let it vanish
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

  // ---- F-95 (D40(7)): plan.interactions[] — interactions the export cannot carry (a control with no prototype
  // reaction). Merged only when the row can be graded like an export row: a visible node of this export, a known
  // `expect` (→ the action OUTCOMES_FOR_ACTION grades), a dialog naming the frame it opens, and no export row with
  // the same nodeId + trigger (the export wins). Every other row is dropped with why. exportContentSha256 does not
  // change (D21: waivers bind the export, not the plan); only the rows' own hash binds (planInteractions.sha256).
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
      // review L2: the probe opens a dialog by clicking its opener — a dialog row on any other trigger (hover, key, drag…)
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

  // F-104: repeated placeholder copy in sibling rows
  const specById = new Map(nodes.map((s) => [s.nodeId, s]));
  for (const r of roots) markRepeatedText(r, specById);

  // F-60 / D22: a destination that is no node of the export FOR THE SAME FIGMA FILE was never designed here.
  // Figma node ids are per file — a join across files would match unrelated nodes. So a row's file is only ever
  // its OWN sourceFile stamp (never the index's top-level one: the CLI merges rows of several index files), and a
  // destination is looked up among the rows that COULD be this screen's file: the rows naming it, plus every row
  // naming none (an export written before the bridge stamped sourceFile — every field-test export, and the rest
  // of such an index after one screen is re-pulled, live run L-3). Found in one of those, or among the ids of any
  // unnamed input, it counts as exported (it may be this file's); found in none, it was never exported.
  // The screen must be IN the index — a row with its root's id AND name (a bare id like 1:1 recurs across files),
  // in its file or unnamed — or an index of another file would call every destination "never exported". A screen
  // naming no file takes its file from that row: one named file → that file's rows + unnamed ones; any unnamed own
  // row → every row; rows naming two files → nothing decided. Otherwise the row is left as it was (graded as before).
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
      // an unnamed own row may be any file's (review L-c: a duplicated file shares ids AND names) → every row
      if (named.size === 0 || covering.some((l) => !l.sourceFile)) return { rows: index.layers, resolved: null };
      f = [...named][0] ?? "";
    }
    return { rows: index.layers.filter((l) => !l.sourceFile || l.sourceFile === f), resolved: f || null };
  }
  for (const row of interactions) {
    const file = interactionFile.get(row);
    // D28 (live L-4): a change_to's destination is a component VARIANT — a drawn state of this very instance, never a
    // screen anyone exports — so it is never "undesigned"; undriven, it is not-probed like any other interaction.
    if (!row.destinationId || file === undefined || String(row.action).toLowerCase() === "change_to") continue;
    const known = idsByFile.get(file);
    if (!known || known.has(row.destinationId) || (unnamedIds && unnamedIds.has(row.destinationId))) continue;
    const candidates = candidatesFor(file);
    if (candidates && !candidates.some((l) => l.id === row.destinationId)) row.destinationExported = false;
  }

  // ---- D32/D35: aliases. A shared shell (sidebar, header) is ONE component instance on every screen, but Figma re-mints
  // the ids under each instance (`I<instance>;<path>`, nested instances re-mint the path too — F-85), so a build tagged
  // with screen A's ids misses on screen B. For each outermost instance, the SAME node in a sibling export of the SAME
  // Figma file (the F-60/L-3 candidate rows — never a join across files: ids and keys would match unrelated nodes) is
  // the one at the same visible name path under an instance of the same main component key, when that key has exactly
  // one outermost instance in both exports and the path is unique in both. Its id is an alias; an id whose `;` suffix
  // equals the spec's own is left out (the probe's tag-shared-path finds it already). Rebuilt from the CURRENT
  // siblings at every --expect (facts §8: sublayer id stability is undocumented). Known misses: a renamed layer, a
  // repeated name inside the instance (e.g. same-named menu items), a shell instantiated twice on one screen.
  const readSibling = opts && opts.readSibling;
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
        const sib = readSibling(row.file);
        if (!sib) continue;
        // the sibling's own stamp must not name another file (a row may be unnamed while its export is stamped). An
        // UNSTAMPED sibling is allowed for a stamped screen (the L-3 partly re-pulled export): the risk is small — an alias
        // also needs the same component key, a unique name path, the same content and texted ancestor, and a tag-alias
        // match is capped (D30), so D39 keeps it from making a pass on its own.
        const sx = screenExportOf(sib);
        const sibFile: unknown = "sourceFile" in sib ? sib.sourceFile : sx ? sx.sourceFile : undefined;
        // (an unstamped screen is checked against the file its index row resolved to — review pass 2)
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
            // (an id whose `;` suffix is ANY expected spec's suffix is that spec's tag-shared-path match — review LOW a)
            const s2 = idSuffix(sid);
            if (s2 !== null && specSuffixes.has(s2)) continue;
            getOrInit(aliases, id, () => new Set<string>()).add(sid);
          }
        }
      }
    }
    for (const [id, set] of aliases) { const sp = specById.get(id); if (sp) sp.aliases = [...set].sort(); }
  }

  // ---- F-117: what an overlay/swap opens. The destination frame's own overlay block (serialize.ts writes it only when it
  // differs from Figma's default: centred, no scrim, no close-on-click-outside) — read off the destination ROOT among the
  // inputs of the same file, else off the sibling export its index row names (the F-60/L-3 candidate rows). A destination
  // that is no exported root (never exported, or nested in another frame) gets no overlay.
  const siblingCache = new Map<string, ScreenDoc | null>();
  const sibling = (file: string): ScreenDoc | null => {
    if (!readSibling) return null;
    if (!siblingCache.has(file)) siblingCache.set(file, readSibling(file) ?? null);
    return siblingCache.get(file) ?? null;
  };
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
  // 12c: the reference PNG's geometry over the first frame (D40(4), D48) — only when the caller can read the PNG
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
    ...ifDefined("planInteractions", planInteractions),
    ...ifDefined("referenceImage", referenceImage),
  };
}

// ---------------------------------------------------------------- 12c: the reference image (--expect, D40(4), D48)
// Where the export's reference PNG sits over the first frame, so the probe can render the build at the reference's own
// scale and crop the frame box out of it. Index first (the row write-out.ts wrote for THIS png), else recomputed from
// the export root exactly as the bridge does. A png whose scale is not the one Figma renders a reference at is a
// discovery thumbnail (F-08) — never diffed at its own scale.
/** PNG facts the visual diff needs (IHDR + the colour chunks before IDAT) — null when the bytes are not a PNG. A tiny
 *  local reader: design-to-code's png.ts is the probe's decoder (verify-screen stays independent of it). */
export function pngHeader(b: Uint8Array): { w: number; h: number; colorType: number; bitDepth: number; interlace: number; iccp: string | null } | null {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 33 || SIG.some((v, i) => b[i] !== v)) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const name = (at: number): string => String.fromCharCode(b[at] ?? 0, b[at + 1] ?? 0, b[at + 2] ?? 0, b[at + 3] ?? 0);
  if (dv.getUint32(8) !== 13 || name(12) !== "IHDR") return null;
  let iccp: string | null = null;
  // chunks: length(4) type(4) data(length) crc(4); iCCP's data starts with its NUL-terminated profile name
  for (let at = 33; at + 8 <= b.length;) {
    const len = dv.getUint32(at), type = name(at + 4);
    if (type === "IDAT" || type === "IEND") break;
    if (type === "iCCP") {
      const start = at + 8, end = Math.min(start + len, start + 80, b.length);
      let nameEnd = start;
      while (nameEnd < end && b[nameEnd] !== 0) nameEnd++;
      iccp = String.fromCharCode(...b.subarray(start, nameEnd)) || "unnamed";
    }
    at += 12 + len;
  }
  return { w: dv.getUint32(16), h: dv.getUint32(20), bitDepth: b[24] ?? 0, colorType: b[25] ?? 0, interlace: b[28] ?? 0, iccp };
}
const round4 = (n: number): number => Math.round(n * 10000) / 10000;
/** `base` joined with a "/"-separated relative path, resolved, when it lies strictly inside `within` (default `base`) — else
 *  null (F-7: a pointer or a referenceImage.path with `..` segments never reads a file outside design/export). Lexical only:
 *  no file is touched. Shared by --expect and the probe (probe-visual.ts). */
export function resolveInside(base: string, rel: string, within: string = base): string | null {
  const root = path.resolve(within), file = path.resolve(base, ...rel.split("/"));
  return file.startsWith(root + path.sep) ? file : null;
}
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
  // F-7: confined to design/export (lexically — the root used here is any absolute one)
  if (resolveInside(path.resolve("design", "export"), reference) === null) return unusable(p, `the reference pointer ${reference} leads outside design/export — re-pull the screen`);
  if (!root || root.reference !== reference) return unusable(p, "the reference PNG belongs to another frame than the first one — only the first frame is diffed");
  const box = root.box;
  if (!box || !(num(box.w) && box.w > 0) || !(num(box.h) && box.h > 0)) return unusable(p, "the frame has no size in the export (box.w/h) — the reference cannot be placed");
  const bytes = o.readReference(reference);
  if (!bytes) return unusable(p, `the reference PNG ${p} is missing on disk — re-pull the screen`);
  const png = pngHeader(bytes);
  if (!png) return unusable(p, `the reference ${p} is not a PNG`);
  if (png.bitDepth !== 8 || (png.colorType !== 2 && png.colorType !== 6) || png.interlace !== 0)
    return unusable(p, `the reference ${p} is a PNG of colour type ${png.colorType} / depth ${png.bitDepth}${png.interlace ? " / interlaced" : ""} — the visual diff reads 8-bit RGB/RGBA, non-interlaced`);
  if (!png.w || !png.h) return unusable(p, `the reference ${p} is an empty PNG`);
  // index first: the row write-out.ts wrote for THIS png (same id, same file when both are stamped, same pointer)
  const row = o.rows.find((r) => r.id === root.id && (!r.sourceFile || !o.sourceFile || r.sourceFile === o.sourceFile) && r.reference === reference
    && num(r.referenceScale) && r.referenceScale > 0);
  // The export fallback is bridge/src/write-out.ts writeScreen's formula (F-118), duplicated here — design-to-code never
  // imports bridge runtime code; keep the two in step: refBox = renderBox || box; scale = round4(png.w / refBox.w);
  // offset = renderBox ? renderBox − box : {0, 0}.
  const rb = root.renderBox && num(root.renderBox.w) && root.renderBox.w > 0 ? root.renderBox : undefined;
  const exportOffset = !rb ? { x: 0, y: 0 } : num(rb.x) && num(rb.y) && num(box.x) && num(box.y) ? { x: rb.x - box.x, y: rb.y - box.y } : null;
  const rowOffset = row && row.referenceOffset && num(row.referenceOffset.x) && num(row.referenceOffset.y) ? { x: row.referenceOffset.x, y: row.referenceOffset.y } : null;
  const scale = row && num(row.referenceScale) ? row.referenceScale : round4(png.w / (rb ? rb.w : box.w));
  const offset = rowOffset ?? exportOffset;
  if (!offset) return unusable(p, "the export root has render bounds but no position (box.x/y) — where the reference sits over the frame is unknown");
  // F-08: a discovery thumbnail (360 px for a 1440 frame) is no export reference — Figma renders roots at s0
  // (the PNG on disk is checked too, not only the index's number: a thumbnail written over the pointer after the pull)
  const s0 = figmaReferenceScale(box.w, box.h), onDisk = png.w / (rb ? rb.w : box.w);
  if (![scale, onDisk].every((v) => Math.abs(v - s0) <= REFERENCE_SCALE_SLACK * s0))
    return unusable(p, `the reference is a ${png.w} px image, not the export reference (a discovery thumbnail, F-08) — re-pull the screen`);
  // F-3: the PNG must be the render bounds at that scale on BOTH axes (±2 px; on the height also the scale's own rounding — it
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
  const profiles = [o.colorProfile === "display_p3" ? "display_p3" : null, png.iccp !== null ? `iCCP:${png.iccp}` : null].filter((v): v is string => v !== null);
  return {
    usable: true, path: p, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), png: { w: png.w, h: png.h },
    scale, offset, from: row ? "index" : "export", crop, ...(profiles.length ? { colorProfile: profiles.join(" + ") } : {}),
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
  // D34: where the probe read borderWidth/borderColor (a real border, or a ring drawn by box-shadow/outline)
  "strokeFrom", "strokeAlign",
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
  { key: "borderWidth", tol: TOLERANCE.stroke, label: "border-width", unit: "px" },
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
// (F-78: `display` — an id on an inline element measures its text's box, not a frame's)
const STYLE_KEYS: readonly string[] = [...FIELDS.map((f) => f.key), "padding", "gapVisual", "text", "tag", "textBox", "placeholderText", "display"];
const STYLE_KEY_SHAPE: Record<string, string> = {
  borderRadius: "number | [tl,tr,br,bl]", padding: "[t,r,b,l]", fill: "an SVG's paint", textBox: "{x,w} of a Range over the text",
  placeholderText: "el.placeholder", placeholderColor: "the ::placeholder colour", tag: "tagName, lower-case",
  display: "getComputedStyle(el).display",
};

const MEASURED_KEYS_DOC: Record<string, string> = {
  "nodes[].nodeId": "the Figma node id the measurement is FOR (from data-dt-node, or matched by text/position)",
  // GENERATED from STYLE_KEYS, so the list a probe is told to send cannot drift from the list compared (DT-23: `fill` was missing)
  "nodes[].styles": `computed values, EVERY key on every node — lengths as px numbers (a "20px" string is read as 20; %, other units and keywords are not) — (null when it cannot be read, with the reason under unmeasured): ${STYLE_KEYS.map((k) => k + (STYLE_KEY_SHAPE[k] ? ` (${STYLE_KEY_SHAPE[k]})` : "")).join(" ")}`,
  "nodes[].unmeasured": "{<styles key>: why} for every styles key reported null — a null is listed as not measured, never as checked",
  "nodes[].styles.fill": "an SVG's paint: getComputedStyle(<path|rect|circle>).fill — never background-color",
  "nodes[].styles.textBox": "{x,w} of a Range over a TEXT node's characters, frame-relative — required for every TEXT node: its x/width are never read off the element's box",
  "nodes[].styles.display": "getComputedStyle(el).display — a FRAME/INSTANCE id on an inline element measures its text's box, not a frame's",
  "nodes[].styles.strokeFrom / strokeAlign": "where borderWidth/borderColor were read: border, or a ring (box-shadow spread / outline) and its side (inside | outside)",
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

function comparePadding(want: unknown, got: readonly number[], skip?: readonly string[]): Bad | null {
  // (compare() hands over four px numbers — a null or unreadable side is listed as not measured first, DT-43/DT-42)
  if (!Array.isArray(want)) return null;
  const w: number[] = want.map(Number);
  if (w.some(Number.isNaN)) return null;
  // F-79: a side the design cannot show (expectation paddingSkip) is not compared
  const worst = Math.max(0, ...w.map((v, i) => (skip && skip.includes(PAD_SIDES[i] ?? "") ? 0 : Math.abs(v - (got[i] ?? 0)))));
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
// DT-48 / F-75: a table row or row group draws no border-radius (CSS Backgrounds 3: radius applies to table and
// table-cell boxes only) — getComputedStyle still returns the specified value, so neither direction is evidence.
const ROW_TAGS = new Set(["tr", "thead", "tbody", "tfoot"]);
const ROW_RADIUS_WHY = "a table row/row-group does not draw border-radius — report the corner cells' radii under this id, or tag the cells";
// F-78: a FRAME/INSTANCE id on an inline element: its box is the union of its text's line boxes, not a frame's
const INLINE_BOX_FIELDS = new Set<string>(["width", "height", "x", "y", "borderRadius"]);
const inlineWhy = (tag: string): string => `the id sits on an inline <${tag || "element"}>, whose box is its text's — tag the element that owns the box`;
// DT-74 (D34, verified): Chromium FLOORS a computed border width to whole px, with a 1px minimum for any non-zero
// width (0.5 → 1, 1.5 → 1, 2.7 → 2, at DPR 1/2/3). A design's stroke is compared as the border CSS can draw. A ring
// (box-shadow spread, outline) is not snapped — it is compared with the raw design width.
const cssBorderWidth = (d: number): number => (d <= 0 ? 0 : d < 1 ? 1 : Math.floor(d));
const normText = (t: unknown): string => String(t).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
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
  "A TEXT node's height is not compared (neither a Range nor its element gives the line box Figma's text box has), and the width of text the design truncates is not either (a Range spans the unclipped string). A fixed- or fill-width text is compared at its ink width within 3px — an empirical bound (field runs: −0.6…+2.4px); heavy italics or overhanging glyphs may exceed it.",
  "Border widths are compared as CSS draws them: Chromium floors a computed border width to whole px, at least 1 (a 1.5px stroke is a 1px border). A ring (box-shadow spread, outline) is compared with the design's own width.",
  "Severity follows the match (D30/D31): a node matched by position or a non-canonical rule is at most low, by text-ordinal or another screen's id (tag-alias) at most medium; a matched element far from the design's size gets one 'match (size)' row and its other deltas are capped at low (cappedFrom keeps the original, cappedBy says which cap). D39: an open capped delta blocks a plain pass (verdict incomplete, never fail on its own); a waiver on 'match (size)' lifts only the size cap — a match-confidence cap stays.",
];

/** compare()'s options — the evidence the CLI ties the report to. `components` = the --interactions file's
 *  components[] (the agent's present:false claims), merged with measured.json's. `against` = the previous
 *  round's report (D18: the one about to be overwritten, or --against), for a coverage comparison only. */
export interface CompareOptions {
  interactions?: InteractionEvidence[] | null; components?: MeasuredComponent[] | null; expectationSha256?: string; measuredSha256?: string;
  artifactCheck?: ArtifactCheck[] | null; code?: CodeInputs; against?: { file: string; report: VerifyReport } | null;
  /** what readableMeasured() dropped from the measured file (malformed optional extras) — reported, never judged */
  inputNotes?: string[] | null;
  /** L3: readableMeasured() dropped a malformed measured.behaviour — report.behaviour says so (not "no block") */
  behaviourMalformed?: boolean;
  /** 12c: readableMeasured() dropped a malformed measured.visual — report.visual says so (not "no block") */
  visualMalformed?: boolean;
  /** 12c: where measured.visual.diff is now (the CLI resolves it beside the measured file when the recorded path is gone) */
  visualDiff?: { path: string; exists: boolean } | null;
  /** D5: the plan's waivers[] — a matching delta is accepted (still listed, out of the counts) */
  waivers?: PlanWaiver[] | null;
  /** D20: the plan's descopes[] — a matching interaction is removed from the graded set */
  descopes?: PlanDescope[] | null;
  /** F-77: the plan's anchors{} — `foldedInto` takes a layout-only wrapper out of the denominator */
  anchors?: Record<string, PlanAnchor> | null;
  /** recorded as report.inputs.waivers: the plan file and waiversHash() of it */
  waiversInput?: { plan: string; sha256: string } | null;
  /** F-72/D26: the run's status file beside the measured file — an unfinished run, or one naming another measured
   *  file, makes the verdict incomplete. A v1 (hand-written) status is never trusted, never judged. null = looked
   *  for and none found: a measured file naming its runId is then unrecorded (M-1); undefined = not looked for. */
  status?: { file: string; status: VerifyStatusV2 | "v1" } | null;
  /** the plan for this frame as found NOW: F-95 its interactions[] hash against the expectation's planInteractions;
   *  L-1 its navigate[] against the probe's measured.reach (report.inputs.reach.matchesPlan). `choice` = how the CLI
   *  picked it (choosePlan) — the re-run advice names --plan when the plan was not the frame's only one */
  plan?: ChosenPlan | null;
  /** review-2 M-b: the plan file the expectation merged interactions from (planInteractions.plan) could not be used at
   *  --compare — why ("no longer exists" / "is not a readable plan now: …"); the re-run advice then names both plans */
  recordedPlanGone?: string | null;
}

// ---- D5 waivers: does a waiver's recorded value still describe this round's delta?
/** The slack a waiver's designed/built values are matched with — the field's own tolerance (null = exact). */
function fieldTolerance(label: string): number | null {
  const f = FIELDS.find((x) => x.label === label);
  if (f) return f.tol;
  if (label === "padding") return TOLERANCE.padding;
  if (label.startsWith("border-radius (")) return TOLERANCE.radius;
  if (label === "placement") return TOLERANCE.position;
  if (label === "width (text ink)") return TOLERANCE.textInk;
  if (label === "match (size)") return TOLERANCE.size;
  if (label === "overflowX") return TOLERANCE.position; // D43
  return null;
}
// ---- F-92: the previous round's deltas against this round's, keyed nodeId + field. A delta that is gone only
// because its node or value was not measured this round is LOST COVERAGE, not a fix. H2: "not measured" means the
// node is unmeasured or its measured node lacks the value (absent / null) — a value that was measured but the compare
// now declines (impossible, an <img> fill, a method gap) is nowUnverifiable; and when the measured file is the very
// same file as last round's, no difference is the build's — every one is `reclassified`, none fixed/new/lost.
const fieldBase = (f: string): string => f.replace(/\s*\(.*\)$/, "");
// D26 (F-72): the verdict reasons that say the run itself is unverified — the ONE wording compare() writes and
// --accept recognises (it refuses a report carrying any of them).
const INTEGRITY_PHRASES = {
  otherExpectation: "the measurements were taken against a DIFFERENT expectation",
  noExpectation: "measured file names no expectation (expectationSha256)",
  unfinished: "— the verifier had not finished",
  otherMeasured: "names a different measured file",
  unrecorded: "no status of that run records it",
} as const;
const isIntegrityReason = (w: string): boolean => Object.values(INTEGRITY_PHRASES).some((p) => w.includes(p));
interface CoverageNow {
  notMeasured: Array<{ nodeId: string }>; fieldsNotMeasured: Array<{ nodeId: string; field: string; why: string }>; unverifiable: Array<{ nodeId: string; field: string; why: string }>;
  specIds: Set<string>; absent: Set<string>; sameMeasured: boolean;
  /** L-3: nodes whose `placement` (derived from the box) could not be judged this round — absent = an input
   *  (x/y/width/height) was not reported or null (lost coverage), else one was reported but is not a number */
  placementGaps?: Map<string, { absent: boolean; why: string }>;
  /** D18 (group 11): the design values the expectation excludes by method (expectation.notComparable) — a previous
   *  delta on one of them is now unverifiable, not fixed (a TEXT box width, padding a fixed box cannot show) */
  notComparable?: Array<{ nodeId: string; field: string; why: string }>;
  /** D43: coverage.pageOverflow this round — a previous overflowX delta with the page not judged now is lost coverage */
  pageOverflow?: string;
}
// D18 (group 11): is a previous delta's value now excluded by method (expectation.notComparable)? Padding is per side
// (review LOW b): a `padding (left/right)` exclusion covers a previous padding delta only when every side that differed
// is now skipped — a delta on the other axis is still the build's (fixed or open). Other fields: same base field.
function excludedNow(d: VerifyDelta, nc: ReadonlyArray<{ nodeId: string; field: string; why: string }>): { why: string } | undefined {
  const rows = nc.filter((g) => g.nodeId === d.nodeId && fieldBase(g.field) === fieldBase(d.field));
  if (!rows.length) return undefined;
  if (d.field !== "padding") return rows[0];
  const skipped = new Set(rows.flatMap((g) => (/^padding \((.*)\)$/.exec(g.field)?.[1] ?? "").split("/")));
  const e = Array.isArray(d.expected) ? d.expected : [], a = Array.isArray(d.actual) ? d.actual : [];
  const differs = PAD_SIDES.filter((_, i) => { const x = e[i], y = a[i]; return typeof x === "number" && typeof y === "number" && Math.abs(x - y) > TOLERANCE.padding; });
  return differs.length && differs.every((sd) => skipped.has(sd)) ? rows[0] : undefined;
}
function deltaChanges(prev: VerifyDelta[], cur: VerifyDelta[], now: CoverageNow): NonNullable<VerifyAgainst["deltas"]> {
  const keyOf = (d: { nodeId?: unknown; field?: unknown }): string | null => (typeof d.nodeId === "string" && typeof d.field === "string" ? `${d.nodeId}\u0000${d.field}` : null);
  const curByKey = new Map<string, VerifyDelta>();
  for (const d of cur) { const k = keyOf(d); if (k !== null && !curByKey.has(k)) curByKey.set(k, d); }
  const prevByKey = new Map<string, VerifyDelta>();
  for (const d of prev) { const k = isJsonObject(d) ? keyOf(d) : null; if (k !== null && !prevByKey.has(k)) prevByKey.set(k, d); }
  const out: NonNullable<VerifyAgainst["deltas"]> = { fixed: 0, new: 0, unchanged: 0, lostCoverage: [] };
  const was = (d: VerifyDelta): JsonValue => (d.actual === undefined ? null : d.actual);
  if (now.sameMeasured) {
    const reclassified: NonNullable<NonNullable<VerifyAgainst["deltas"]>["reclassified"]> = [];
    for (const [k, d] of curByKey) if (!prevByKey.has(k)) reclassified.push({ nodeId: d.nodeId, field: d.field, change: "new", was: null });
    for (const [k, d] of prevByKey) {
      if (curByKey.has(k)) out.unchanged++;
      else if (now.specIds.has(d.nodeId) || d.field === "overflowX") reclassified.push({ nodeId: d.nodeId, field: d.field, change: "gone", was: was(d) });
    }
    return { ...out, sameMeasured: true, reclassified };
  }
  for (const k of curByKey.keys()) if (!prevByKey.has(k)) out.new++;
  const unmeasuredNodes = new Set(now.notMeasured.map((n) => n.nodeId));
  const nowUnverifiable: NonNullable<NonNullable<VerifyAgainst["deltas"]>["nowUnverifiable"]> = [];
  const sameField = (g: { nodeId: string; field: string }, d: VerifyDelta): boolean => g.nodeId === d.nodeId && (g.field === d.field || fieldBase(g.field) === fieldBase(d.field));
  for (const [k, d] of prevByKey) {
    if (curByKey.has(k)) { out.unchanged++; continue; }
    // D43: the page's overflow is no spec — gone because the page was not judged at the design width is not a fix
    if (d.field === "overflowX") {
      const po = now.pageOverflow;
      if (po === undefined || po === "not measured" || po === "not at design width") out.lostCoverage.push({ nodeId: d.nodeId, field: d.field, was: was(d), why: po === "not at design width" ? "the page was not measured at the design width this round" : "page overflow was not measured this round" });
      else if (po === "designed to scroll") nowUnverifiable.push({ nodeId: d.nodeId, field: d.field, was: was(d), why: "the frame is designed to scroll sideways now" });
      // review L6: the content is still wider than the page — the page now hides it (overflow-x hidden/clip); not a fix
      else if (po === "clipped") nowUnverifiable.push({ nodeId: d.nodeId, field: d.field, was: was(d), why: "the page is still wider than the design width but clips it now (overflow-x hidden/clip) — clipped, not fixed" });
      else out.fixed++;
      continue;
    }
    if (!now.specIds.has(d.nodeId)) continue; // the spec left the expectation: neither fixed nor lost
    if (unmeasuredNodes.has(d.nodeId)) { out.lostCoverage.push({ nodeId: d.nodeId, field: d.field, was: was(d), why: "the node was not measured this round" }); continue; }
    const gapRow = now.fieldsNotMeasured.find((g) => sameField(g, d));
    const absent = gapRow ? now.absent.has(`${gapRow.nodeId}\u0000${gapRow.field}`) : now.absent.has(k) || [...now.absent].some((a) => a.startsWith(`${d.nodeId}\u0000`) && fieldBase(a.slice(d.nodeId.length + 1)) === fieldBase(d.field));
    if (absent) { out.lostCoverage.push({ nodeId: d.nodeId, field: d.field, was: was(d), why: `not measured this round: ${gapRow ? gapRow.why : "the probe did not report this property"}` }); continue; }
    // L-3: placement is derived from the box — gone because an input is missing is not a fix
    const derived = d.field === "placement" ? now.placementGaps?.get(d.nodeId) : undefined;
    if (derived && derived.absent) { out.lostCoverage.push({ nodeId: d.nodeId, field: d.field, was: was(d), why: `not measured this round: ${derived.why}` }); continue; }
    if (derived) { nowUnverifiable.push({ nodeId: d.nodeId, field: d.field, was: was(d), why: derived.why }); continue; }
    const method = gapRow ?? now.unverifiable.find((g) => sameField(g, d)) ?? excludedNow(d, now.notComparable || []);
    if (method) { nowUnverifiable.push({ nodeId: d.nodeId, field: d.field, was: was(d), why: method.why }); continue; }
    out.fixed++;
  }
  return nowUnverifiable.length ? { ...out, nowUnverifiable } : out;
}
const sortKeys = (o: Record<string, string | null>): Array<[string, string | null]> => Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

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
  tag: "tag", "data-dt-node": "tag", id: "tag", "tag-shared-path": "tagSharedPath", "tag-alias": "tagAlias", text: "text", "text-ordinal": "textOrdinal", position: "position", frame: "frame",
};
const MATCH_BUCKETS = ["tag", "tagSharedPath", "tagAlias", "text", "textOrdinal", "position", "frame", "sharedComponentPath", "other", "unstated"] as const;
const MATCH_LABEL: Record<string, string> = {
  tag: "tag", tagSharedPath: "shared path", tagAlias: "alias", text: "text", textOrdinal: "ordinal", position: "position", frame: "frame",
  sharedComponentPath: "shared component path", other: "other", unstated: "unstated",
};
// F-125 (D30): the canonical matchedBy vocabulary (the shipped probe's, probe-match.ts) and the cap each gets.
// A hand-written probe's synonyms for a tag match ("data-dt-node", "id") read as "tag".
const CANONICAL_MATCH = new Set<string>(CANONICAL_MATCHED_BY);
const MATCH_SYNONYM: Record<string, string> = { "data-dt-node": "tag", id: "tag" };
const NO_CAP = new Set<string>(["tag", "tag-shared-path", "text", "frame"] satisfies MatchedBy[]);
const MEDIUM_CAP = new Set<string>(["text-ordinal", "tag-alias"] satisfies MatchedBy[]);
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
  frame: true, frames: true, navigation: true, matchedByCensus: true, notes: true, runId: true, build: true,
  tagsNotInExpectation: true, reach: true, page: true, behaviour: true, visual: true,
} as const satisfies Record<keyof VerifyMeasured, true>;
// (a hand-written probe's top-level `navEvents` object is its page-wide navigation log — the canonical key is
// `navigation`; the per-interaction count F-102 reads lives on each interactions[] row, never up here)
const TOP_KEY_HINTS: Record<string, string> = { notFound: "notMeasured", notFoundInDom: "notMeasured", notMeasuredByProbe: "notMeasured", missing: "notMeasured", measurements: "nodes", elements: "nodes", navEvents: "navigation" };

// ---- F-102 (D24): what counts as evidence that an interaction worked. `ok:true` is a claim; a pass needs the one
// element driven (selectorCount === 1), an outcome that is what the designed action does, and no document loaded
// during the interaction (navEvents: a reload or a cross-document navigation — a dev-server reload once read as "the
// dialog opened") — except where loading another document IS the action (navigate / back / url with url-changed).
// An in-page URL change (pushState, a hash) loads no document: navEvents 0, and `url-changed` passes for any action
// that allows it. Anything short of that is not-probed with the missing piece named, never fail: the control may work.
export const INTERACTION_OUTCOMES = ["url-changed", "dialog-opened", "selector-appeared", "state-changed", "none"] as const;
type Outcome = (typeof INTERACTION_OUTCOMES)[number];
const ANY_BUT_NONE: readonly Outcome[] = INTERACTION_OUTCOMES.filter((o) => o !== "none");
export const OUTCOMES_FOR_ACTION: Readonly<Record<"navigate" | "overlay" | "change_to" | "swap" | "other", readonly Outcome[]>> = {
  navigate: ["url-changed", "selector-appeared"],
  overlay: ["dialog-opened", "selector-appeared"],
  change_to: ["state-changed", "selector-appeared"],
  swap: ["state-changed", "selector-appeared"],
  other: ANY_BUT_NONE,
};
// Actions whose effect IS a URL change: a document loaded during them (a full navigation) is the outcome, not a
// reload. (D24 names navigate; `back` and `url` change the URL by definition too — without them a multi-page back
// link could never pass.) An overlay opened as a route or a tab kept in the query string records what APPEARED
// (dialog-opened / selector-appeared / state-changed), which its action allows — not url-changed.
const URL_ACTIONS = new Set(["navigate", "back", "url"]);
const isOutcome = (x: unknown): x is Outcome => typeof x === "string" && INTERACTION_OUTCOMES.some((o) => o === x);
function outcomesFor(action: string | undefined): readonly Outcome[] {
  return action === "navigate" || action === "overlay" || action === "change_to" || action === "swap" ? OUTCOMES_FOR_ACTION[action] : OUTCOMES_FOR_ACTION.other;
}
/** What an ok:true row lacks to count as a pass (D24), in words — empty when it passes. */
function evidenceGaps(hit: InteractionEvidence, action: string | undefined): string[] {
  const gaps: string[] = [];
  const count = Number(hit.selectorCount);
  if (!hit.selector) gaps.push("no selector named");
  else if (!(count >= 1)) gaps.push(`selector '${hit.selector}' matched ${Number.isFinite(count) ? count : "an unreported number of"} element(s)`);
  else if (count !== 1) gaps.push(`selector '${hit.selector}' matched ${count} elements — which one was driven? (needs exactly 1)`);
  const allowed = outcomesFor(action);
  if (hit.outcome === undefined) gaps.push("no outcome recorded (url-changed | dialog-opened | selector-appeared | state-changed | none)");
  else if (!isOutcome(hit.outcome)) gaps.push(`outcome '${String(hit.outcome)}' is not one of ${INTERACTION_OUTCOMES.join(" | ")}`);
  else if (!allowed.includes(hit.outcome)) gaps.push(`outcome '${hit.outcome}' is not what ${action ? `${/^[aeiou]/.test(action) ? "an" : "a"} ${action}` : "this action"} does (${allowed.join(" or ")})`);
  const nav = hit.navEvents;
  if (nav === undefined) gaps.push("no navEvents recorded (documents loaded during the interaction: a reload or a full navigation)");
  else if (typeof nav !== "number" || !Number.isInteger(nav) || nav < 0) gaps.push(`navEvents ${JSON.stringify(nav)} is not a count`);
  else if (nav > 0 && !(action !== undefined && URL_ACTIONS.has(action) && hit.outcome === "url-changed")) gaps.push(`${nav} document(s) loaded during the interaction (a reload or a full navigation) — a reload is not an outcome${hit.outcome === "url-changed" ? `; only a navigate, back or url action may load a document` : ""}`);
  return gaps;
}

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
  const typographyOn = new Map<string, string>(); // TEXT spec id -> the container tag its typography was read from
  const matchKind = new Map<string, string>(); // measured spec id -> how it was found (D33: through another screen's id?)
  const matchCapOf = new Map<string, DeltaSeverity>(); // D30: a node's match-confidence cap (D39: a size waiver keeps it)
  // H2: the gaps where the measured node lacks the value (the key absent, or null) — the only kind that can LOSE a
  // previous delta; every other gap is the compare declining a value it has (a method gap, not lost coverage)
  const absentGaps = new Set<string>();
  const placementGaps = new Map<string, { absent: boolean; why: string }>(); // L-3: placement's inputs, per node
  const gap = (spec: VerifySpec, field: string, why: string, absent = false): number => {
    if (absent) absentGaps.add(`${spec.nodeId}\u0000${field}`);
    return fieldsNotMeasured.push({ nodeId: spec.nodeId, name: spec.name, field, why });
  };
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
    matchKind.set(String(spec.nodeId), matchedBy && matchedBy.startsWith("shared-component-path") ? "shared-component-path" : rawMatch);
    const bucket = matchedBy && matchedBy.startsWith("shared-component-path") ? "sharedComponentPath" : rawMatch === "" ? "unstated" : MATCH_BUCKET[rawMatch] ?? "other";
    matchedByCensus[bucket] = (matchedByCensus[bucket] ?? 0) + 1;
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
    const gapNull = (field: string, ...keys: string[]): void => { fieldsReportedNull++; gap(spec, field, nullWhy(...keys), true); };
    const zeroAtRest = num(base.width) && num(base.height) && base.width === 0 && base.height === 0;
    const stateWhy = state ? `the designer drew this ${spec.drawnStateOwn ? "layer" : "layer's container"} in its ${state} state (${spec.drawnStateWhy}) — measure it ${state === "hover" ? "hovered" : state} and report the values under states.${state}` : "";

    // Hover-only content measured at rest is absent by design, not missing (finding 128/194: the
    // edit button that exists only on the hovered row, "36 → 0").
    if (state && measuredIn === "rest" && zeroAtRest) {
      for (const f of FIELDS) if (spec[f.key] !== undefined) { tally(f.key, false); gap(spec, f.label, `renders 0×0 at rest: ${stateWhy}`); }
      placementGaps.set(String(spec.nodeId), { absent: false, why: `renders 0×0 at rest: ${stateWhy}` }); // L-3
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
    const rowTag = ROW_TAGS.has(tagLc);
    const inline = CONTAINER_TYPES.has(spec.type) && typeof got.display === "string" && got.display.trim() === "inline";
    // DT-75: copy that differs renders a different width (and a centred/right-aligned start) — judge the copy first
    const textDiffers = isText && spec.text !== undefined && typeof got.text === "string" && normText(spec.text) !== normText(got.text);
    const firstDelta = deltas.length; // this node's deltas: deltas.slice(firstDelta) (D30/D31 caps below)

    for (const f0 of FIELDS) {
      const want0 = spec[f0.key];
      if (want0 === undefined) continue;
      // D29: a fixed/fill-width TEXT's width is its INK width — its own label and tolerance
      const f: Field = isText && f0.key === "width" && spec.widthFrom === "renderBox" ? { ...f0, label: "width (text ink)", tol: TOLERANCE.textInk } : f0;
      let val: JsonValue | undefined = got[f.key];
      let nullKeys: string[] = [f.key];
      let present = val !== undefined;
      // F-62 (D29): a TEXT's x/width come ONLY from textBox (a Range over its characters) — never its element's box,
      // which a flex-1 <span> or a padded cell stretches past the words
      const textXW = isText && (f.key === "x" || f.key === "width");
      if (textXW) { val = tb ? (f.key === "x" ? tb.x : tb.w) : got.textBox === null ? null : undefined; present = val !== undefined; nullKeys = ["textBox", f.key]; }
      // gapVisual wins when it holds a value; the shipped probe sends every key, so a null gapVisual (not a
      // table) must not hide a measured gap.
      if (f.key === "gap" && got.gapVisual !== undefined && (got.gapVisual !== null || val == null)) { val = got.gapVisual; present = true; nullKeys = ["gapVisual", "gap"]; }
      if (f.key === "fill" && (PIXEL_TAGS.has(tagLc) || m.fillSource === "img")) {
        unverifiable.push({ nodeId: spec.nodeId, name: spec.name, field: f.label, expected: want0, why: `drawn by an <${PIXEL_TAGS.has(tagLc) ? tagLc : "img"}>: its paint is pixels, not a CSS property — the SVG's own fill cannot be read from the element's computed style` });
        continue;
      }
      tally(f.key, present);

      // (DT-74: opacity too — hover-revealed content reads 0 at rest; any layer inside a drawn state, not only the owner)
      if (state && measuredIn === "rest" && ((spec.drawnStateOwn && f.colour) || f.key === "opacity")) { gap(spec, f.label, stateWhy); continue; }
      if (onLeaf && LEAF_FIELDS.has(f.key)) { gap(spec, f.label, leafWhy); continue; }
      if (inline && INLINE_BOX_FIELDS.has(f.key)) { gap(spec, f.label, inlineWhy(tagLc)); continue; }
      if (f.key === "borderRadius" && rowTag) { gap(spec, f.label, ROW_RADIUS_WHY); continue; }
      if (textXW && textDiffers) { gap(spec, f.label, "the text differs from the design's, so its width (and a centred or right-aligned start) does too — compared once the copy matches"); continue; }
      if (textXW && val === undefined) { gap(spec, f.label, "report textBox {x,w} — a Range over the text's characters; a TEXT's x/width are never read off its element's box", true); continue; }
      if (isText && f.box && container && !tb && !textXW) {
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
        gap(spec, f.label, "the probe did not report this property", true);
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
      let strokeNote: string | undefined;
      if (f.key === "borderWidth" && typeof want0 === "number") {
        const ring = got.strokeFrom === "box-shadow" || got.strokeFrom === "outline";
        if (!ring && cssBorderWidth(want0) !== want0) { want = cssBorderWidth(want0); strokeNote = `the design's ${want0}px stroke draws as a ${want}px CSS border (computed border widths are whole px, at least 1)`; }
        // a ring drawn on the other side of the box than the design's stroke: noted, never a delta of its own
        if (ring && got.strokeAlign && spec.strokeAlign && spec.strokeAlign !== "center" && got.strokeAlign !== spec.strokeAlign) strokeNote = `read from a ${got.strokeFrom} ring ${got.strokeAlign} the box; the design's stroke is ${spec.strokeAlign}`;
      }
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
          ...ifDefined("note", strokeNote),
        });
      }
    }

    // ---- per-corner radius (unequal corners)
    if (spec.radiusCorners && onLeaf) gap(spec, "border-radius", leafWhy);
    else if (spec.radiusCorners && inline) gap(spec, "border-radius", inlineWhy(tagLc));
    else if (spec.radiusCorners && rowTag) { tally("borderRadius", got.borderRadius !== undefined); gap(spec, "border-radius", ROW_RADIUS_WHY); }
    else if (spec.radiusCorners) {
      const rc = spec.radiusCorners;
      const c = radiusCorners(got.borderRadius);
      tally("borderRadius", got.borderRadius !== undefined);
      if (got.borderRadius === null || (Array.isArray(got.borderRadius) && got.borderRadius.some((v) => v === null))) gapNull("border-radius", "borderRadius");
      else if (!c) gap(spec, "border-radius", got.borderRadius === undefined ? "the probe did not report this property" : `could not read '${JSON.stringify(got.borderRadius)}' as a px radius`, got.borderRadius === undefined);
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
      if (got.padding === undefined) gap(spec, "padding", "the probe did not report this property", true);
      else if (got.tag && String(got.tag).toLowerCase() === "tr") gap(spec, "padding", "a table row's padding lives on its cells — report the first/last cell's padding under this id");
      else if (onLeaf) gap(spec, "padding", leafWhy);
      else if (inline) gap(spec, "padding", inlineWhy(tagLc));
      else if (got.padding === null || (Array.isArray(got.padding) && got.padding.some((v) => v === null))) gapNull("padding", "padding");
      else if (!pad) gap(spec, "padding", `could not read '${JSON.stringify(got.padding)}' as px padding [t,r,b,l]`);
      else if (pad.some((v) => v < 0)) gap(spec, "padding", `${JSON.stringify(got.padding)} is impossible for padding (CSS cannot make it negative) — a measuring artefact; not compared`);
      else {
        fieldsChecked++;
        const bad = comparePadding(spec.padding, pad, spec.paddingSkip);
        const allZero = pad.every((v) => v === 0);
        const skipNote = spec.paddingSkip && spec.paddingSkip.length ? `${spec.paddingSkip.join("/")} not compared (the design cannot show that padding — see notComparable)` : undefined;
        const zeroNote = allZero && !got.tag ? "measured 0 on every side — if this id sits on a <tr> or a wrapper, the padding lives on its cells/child: report `tag` and measure the element that carries it" : undefined;
        const padNote = [zeroNote, skipNote].filter((x): x is string => !!x).join("; ");
        if (bad) push(spec, "padding", "medium", bad, { unit: "px", ...ifDefined("token", tokenFor(spec, "padding")), ...(padNote ? { note: padNote } : {}) });
      }
    }
    if (spec.placeholderText !== undefined) {
      tally("placeholderText", got.placeholderText !== undefined);
      if (got.placeholderText === undefined) gap(spec, "placeholder text", "this layer is an input placeholder: report el.placeholder as placeholderText (textContent of an empty input is '')", true);
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
        gap(spec, "text", um.text || "the probe reported text: null — an element with child elements still has text; report its textContent", true);
      }
      else if (got.text === undefined) absentGaps.add(`${spec.nodeId}\u0000text`);
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
    if (num(fr.w) && num(fr.h)) {
      const BOX_KEYS = ["x", "y", "width", "height"] as const;
      const missing = BOX_KEYS.filter((k) => bx[k] === undefined || bx[k] === null);
      const unread = BOX_KEYS.filter((k) => bx[k] !== undefined && bx[k] !== null && !num(bx[k]));
      if (missing.length) placementGaps.set(String(spec.nodeId), { absent: true, why: `the probe did not report ${missing.join("/")} (placement is derived from the box)` });
      else if (unread.length) placementGaps.set(String(spec.nodeId), { absent: false, why: `could not read ${unread.join("/")} as px numbers (placement is derived from the box)` });
    }
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

    // ---- F-65 (D31): is this the element the design means? A matched box far from the design's size (>=2x or
    // <=1/2 on an axis AND >=8px off) is one medium `match (size)` row, and every other delta of the node is capped
    // at low (they describe some other element). A hug axis (or a frame root's height — the page scrolls) that only
    // GREW counts only when the other axis is off too: more content legitimately grows it.
    const own = deltas.slice(firstDelta);
    let sizeRow: VerifyDelta | undefined;
    if (!isText && !onLeaf && !inline) {
      const ew = num(spec.width) ? spec.width : null, eh = num(spec.height) ? spec.height : null;
      const mw = cssPx(got.width), mh = cssPx(got.height);
      const off = (e: number | null, m: number | null): boolean => e !== null && m !== null && Math.abs(m - e) >= 8 && (Math.min(e, m) <= 0 || Math.max(m / e, e / m) >= 2);
      const frameRoot = spec.nodeId === frameOf(spec).nodeId;
      const growOnlyW = spec.sizing?.w === "hug" && ew !== null && mw !== null && mw > ew;
      const growOnlyH = (spec.sizing?.h === "hug" || frameRoot) && eh !== null && mh !== null && mh > eh;
      const rawW = off(ew, mw), rawH = off(eh, mh);
      if ((rawW && (!growOnlyW || rawH)) || (rawH && (!growOnlyH || rawW))) {
        const dist = Math.max(ew !== null && mw !== null ? Math.abs(mw - ew) : 0, eh !== null && mh !== null ? Math.abs(mh - eh) : 0);
        sizeRow = { severity: "medium", nodeId: spec.nodeId, name: spec.name, ...ifDefined("path", spec.path), field: "match (size)", expected: [ew, eh], actual: [mw, mh], delta: r2(dist), unit: "px",
          ...ifDefined("matchedBy", matchedBy !== "id" ? matchedBy || undefined : undefined),
          note: "the matched element is far from the design's size — likely the wrong element (a wrapper, a page root, a neighbour); this node's other deltas are capped at low. Tag the element the design means, or accept the match (verify-screen --accept --field \"match (size)\")" };
        deltas.push(sizeRow);
      }
    }
    // ---- F-125 (D30): severity is capped by how the element was found. tag / tag-shared-path / text / frame / a
    // shared component path / unstated: no cap; text-ordinal and tag-alias: at most medium; position and any matchedBy
    // outside the canonical vocabulary (a hand-written "position-partial-size", "structural"): at most low.
    const canon = MATCH_SYNONYM[rawMatch] ?? rawMatch;
    const cap: DeltaSeverity | null = rawMatch === "" || NO_CAP.has(canon) ? null : MEDIUM_CAP.has(canon) ? "medium" : "low";
    if (cap) matchCapOf.set(String(spec.nodeId), cap);
    for (const d of [...own, ...(sizeRow ? [sizeRow] : [])]) {
      let sev = d.severity;
      const why: string[] = [];
      const by: NonNullable<VerifyDelta["cappedBy"]> = [];
      if (sizeRow && d !== sizeRow && SEVERITY_RANK[sev] < SEVERITY_RANK.low) { sev = "low"; by.push("size"); why.push("capped at low: the matched element's size is far from the design's (see match (size))"); }
      // (recorded whenever the match cap is below the ORIGINAL severity — it still binds if the size cap is lifted)
      if (cap && SEVERITY_RANK[d.severity] < SEVERITY_RANK[cap]) by.push("match");
      if (cap && SEVERITY_RANK[sev] < SEVERITY_RANK[cap]) { sev = cap; why.push(`capped at ${cap}: matched by ${rawMatch}${canon === rawMatch && !CANONICAL_MATCH.has(canon) ? " (not a canonical matchedBy)" : ""}, not by its data-dt-node tag — the element measured may not be the one the design means`); }
      if (sev !== d.severity) { d.cappedFrom = d.severity; d.cappedBy = by; d.severity = sev; d.note = d.note ? `${d.note}; ${why.join("; ")}` : why.join("; "); }
    }
  }

  // ---- D43: the page scrolls sideways at the design width — a HIGH, waivable fidelity delta on the frame root (field
  // overflowX), read only from the probe's measurement pass (measured.page). Not judged when the page was not measured,
  // measured at another width, or the frame is designed to scroll sideways; an overflow the root clips (overflow-x
  // hidden/clip) cannot be scrolled to — a note, not a delta. No match cap (D30/D31): no element was matched.
  const pageRaw: unknown = measured.page;
  const page = isPageOverflow(pageRaw) ? pageRaw : undefined;
  const pageNotes: string[] = [];
  if (pageRaw !== undefined && !page) pageNotes.push("measured.page is not a page overflow block; ignored (page overflow: not measured)");
  const rootF = expectation.frame || {};
  let pageOverflow: PageOverflowCoverage = "not measured";
  if (page) {
    const over = page.scrollWidth - page.clientWidth;
    if (!num(rootF.w) || Math.abs(page.viewport.w - rootF.w) > 1) {
      pageOverflow = "not at design width";
      pageNotes.push(`page overflow was measured at a ${page.viewport.w}px viewport${num(rootF.w) ? `, the design is ${rootF.w}px wide` : " and the expectation states no frame width"} — not judged (measure at the design width)`);
    } else if (rootF.scroll === "horizontal" || rootF.scroll === "both") pageOverflow = "designed to scroll";
    else if (over <= 1) pageOverflow = "ok";
    else if (!page.scrollable) {
      pageOverflow = "clipped";
      pageNotes.push(`the page is ${page.scrollWidth}px wide in a ${page.clientWidth}px viewport but its root clips it (overflow-x: ${page.overflowX}) — content past the right edge cannot be scrolled to`);
    } else {
      pageOverflow = "overflows";
      const widest = page.offenders.slice(0, 3).map((o) => `${o.dt ? `\`${o.dt}\` ` : ""}${o.path} → ${r2(o.right)}px`).join(", ");
      if (typeof rootF.nodeId === "string") {
        deltas.push({ severity: "high", nodeId: rootF.nodeId, ...ifDefined("name", rootF.name), field: "overflowX", expected: page.clientWidth, actual: page.scrollWidth, delta: r2(over), unit: "px",
          note: `the page scrolls sideways at the design width${widest ? ` (widest: ${widest})` : ""} — accept it (verify-screen --accept --node ${rootF.nodeId} --field overflowX) only if intended` });
      }
    }
    // review L8: once — the shipped probe already notes quirks mode in measured.notes; compare adds its own only when it did not
    const probeNotedQuirks = Array.isArray(measured.notes) && measured.notes.some((n) => typeof n === "string" && n.includes("quirks mode"));
    if (page.compatMode && page.compatMode !== "CSS1Compat" && !probeNotedQuirks) pageNotes.push(`the page renders in quirks mode (document.compatMode ${page.compatMode}) — its overflow is measured off <body>`);
  }

  // ---- notes that change how far a delta can be trusted (the match caps above change severity)
  const addNote = (d: VerifyDelta, note: string): void => { d.note = d.note ? `${d.note}; ${note}` : note; };
  const typoLabels = new Set(FIELDS.filter((f) => TYPO_FIELDS.has(f.key)).map((f) => f.label));
  for (const d of deltas) {
    const tag = typographyOn.get(String(d.nodeId));
    if (tag && typoLabels.has(d.field)) addNote(d, `typography read from a <${tag}>, not the text run — if the text sits in a child element, measure that element (the shipped probe does, and says textFrom)`);
  }

  // ---- measured ids the expectation does not know (the "134 measured vs 63 matched" case): a probe that
  // measured the wrong screen, a stale expectation, or ids on layers the export does not list.
  const knownIds = new Set([...expectedIds, ...hiddenSet, ...[expectation.frame, ...(expectation.frames || [])].map((f) => f && f.nodeId).filter((id): id is string => typeof id === "string")]);
  for (const id of expectedIds) { const alt = viaSharedPath(id); if (alt) knownIds.add(alt); }
  const measuredIdsNotInExpectation = [...byId.keys()].filter((id) => !knownIds.has(id));
  // ---- DT-47: tags on the page that name no node of this expectation (the shipped probe's tagsNotInExpectation) and
  // a hand-written probe's measured ids outside it, classified: prefixDrift — the `;` suffix of an expected id under
  // another instance prefix (a stale id table, another pull's ids); alias — another screen's id for one of these
  // nodes (D32); unknown — neither. Informational: the verdict never reads it.
  const tniRaw: unknown = measured.tagsNotInExpectation;
  const tni = isJsonObject(tniRaw) && typeof tniRaw.count === "number" && Array.isArray(tniRaw.ids) ? { count: tniRaw.count, ids: tniRaw.ids.filter(isJsonObject).map((r) => r.id).filter((x): x is string => typeof x === "string") } : null;
  const foreignListed = [...new Set([...(tni ? tni.ids : []), ...measuredIdsNotInExpectation])];
  const foreignTotal = (tni ? Math.max(tni.count, tni.ids.length) : 0) + measuredIdsNotInExpectation.filter((id) => !(tni && tni.ids.includes(id))).length;
  const expectedSuffixes = new Set([...expectedIds].map(idSuffix).filter((x): x is string => x !== null));
  const aliasIds = new Set(specs.flatMap((sp) => sp.aliases || []));
  const foreignClass = (id: string): "prefixDrift" | "alias" | "unknown" => { const sf = idSuffix(id); return sf !== null && expectedSuffixes.has(sf) ? "prefixDrift" : aliasIds.has(id) ? "alias" : "unknown"; };
  const prefixDrift = foreignListed.filter((id) => foreignClass(id) === "prefixDrift").length;
  const aliasTags = foreignListed.filter((id) => foreignClass(id) === "alias").length;
  // (ids past the probe's list of 50 are not classified — they count as unknown)
  const foreignTags = foreignTotal > 0 ? { total: foreignTotal, prefixDrift, alias: aliasTags, unknown: foreignTotal - prefixDrift - aliasTags,
    sample: [...foreignListed.filter((id) => foreignClass(id) === "unknown"), ...foreignListed.filter((id) => foreignClass(id) !== "unknown")].slice(0, 5) } : undefined;

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
  // ---- D33 (DT-31, F-96): the shared shell, counted apart (informational — never the verdict). An OUTERMOST instance
  // (an `I<instance>;…` id names its outermost instance; a plain id is one when it is an instance) is a shared shell
  // when any node under it was matched through ANOTHER screen's id (tag-shared-path, tag-alias, compare's shared
  // component path), or the plan marks it (anchors[<instance id>].shared: true).
  const visibleInstances = (expectation.instances || []).filter((i) => !hiddenSet.has(String(i.nodeId)));
  const instanceById = new Map(visibleInstances.map((i) => [String(i.nodeId), i]));
  const outermostOf = (id: string): string | null => {
    const outer = id.startsWith("I") && id.includes(";") ? id.slice(1, id.indexOf(";")) : id;
    return instanceById.has(outer) ? outer : null;
  };
  const foldedIds = new Set(folded.map((f) => f.nodeId));
  const shellGroups = new Map<string, { expected: number; measured: number; viaOther: boolean }>();
  for (const sp of specs) {
    const id = String(sp.nodeId);
    const outer = outermostOf(id);
    if (!outer || foldedIds.has(id)) continue;
    const g = getOrInit(shellGroups, outer, () => ({ expected: 0, measured: 0, viaOther: false }));
    g.expected++;
    const how = matchKind.get(id);
    if (how !== undefined) g.measured++;
    if (how === "tag-shared-path" || how === "tag-alias" || how === "shared-component-path") g.viaOther = true;
  }
  const shellIds = new Set([...shellGroups].filter(([id, g]) => g.viaOther || (anchors[id] && anchors[id].shared === true)).map(([id]) => id));
  const sharedShell: VerifyCoverageV2["sharedShell"] = shellIds.size ? (() => {
    const rows = [...shellIds].map((id) => { const i = instanceById.get(id); const g = shellGroups.get(id); return { nodeId: id, name: i ? i.name : id, ...ifDefined("setName", i && i.setName), expected: g ? g.expected : 0, measured: g ? g.measured : 0 }; });
    return { instances: rows, expected: rows.reduce((a, r) => a + r.expected, 0), measured: rows.reduce((a, r) => a + r.measured, 0) };
  })() : undefined;
  // F-96: an untagged instance set that lives only inside the shared shell is not this screen's work — listed apart
  const untaggedInstanceSetsInShell = untaggedInstanceSets.filter((v) => shellIds.size > 0 && v.nodeIds.every((id) => { const o = outermostOf(String(id)); return o !== null && shellIds.has(o); }));
  const untaggedOnScreen = untaggedInstanceSets.filter((v) => !untaggedInstanceSetsInShell.includes(v));

  const componentsAbsent: VerifyReportV2["componentsAbsent"] = [];
  for (const c of comps.filter((c) => c && c.present === false)) {
    const set = [...bySet.values()].find((v) => v.setName === (c.setName || c.name) || (c.nodeId !== undefined && v.nodeIds.includes(c.nodeId)));
    if (set) componentsAbsent.push({ setName: set.setName, nodeIds: set.nodeIds, ...ifDefined("detail", c.detail || c.note) });
  }

  const st = opts.status && opts.status.status !== "v1" ? opts.status.status : null;
  const stale = !!(opts.expectationSha256 && measured.expectationSha256 && measured.expectationSha256 !== opts.expectationSha256);
  const integrity: string[] = [];
  // D26 (F-72): the run's integrity, ranked FIRST. When any of these holds, the numbers below belong to an unverified
  // run (another expectation, no expectation, an unfinished run, another measured file) — so the verdict is
  // `incomplete` even with high mismatches (L-6): a `fail` would grade numbers nothing ties to this design and run.
  // The report is still written (the D18 baseline chain stays intact).
  if (stale) integrity.push(`${INTEGRITY_PHRASES.otherExpectation} (${String(measured.expectationSha256).slice(0, 12)}… vs ${String(opts.expectationSha256).slice(0, 12)}…) — re-measure`);
  if (opts.expectationSha256 && !measured.expectationSha256) integrity.push(`${INTEGRITY_PHRASES.noExpectation} — nothing ties these numbers to this design; re-measure with the shipped probe`);
  // M-1: a measured file that names its run, beside no status of that run (none found, a v1 file, another run's) —
  // nothing recorded it as that run's (the probe's status write was refused, or another run has started since).
  // Only when compare looked for one (opts.status null or set; undefined = an in-process caller that passed none).
  const measuredRun = typeof measured.runId === "string" && measured.runId ? measured.runId : undefined;
  if (measuredRun !== undefined && opts.status !== undefined && (st === null || st.runId !== measuredRun)) {
    integrity.push(`the measured file was taken in run ${measuredRun}, but ${st ? `${opts.status ? opts.status.file : "the status"} is run ${st.runId}` : opts.status && opts.status.status === "v1" ? `${opts.status.file} is an older hand-written status` : "no status file was found"} — ${INTEGRITY_PHRASES.unrecorded}; ${st ? `run ${st.runId} is the current run — re-measure in it (never record run ${measuredRun} over it)` : `record it with --status <Screen> --phase measured --run ${measuredRun}, or re-measure`}`);
  } else if (st) {
    const stFile = opts.status ? opts.status.file : "status.json";
    if (!MEASURED_PHASES.includes(st.phase)) integrity.push(`${stFile} (run ${st.runId}, rev ${st.rev}) is at phase ${st.phase} ${INTEGRITY_PHRASES.unfinished}${st.detail ? ` (${st.detail})` : ""}`);
    else if (st.measuredSha256 && opts.measuredSha256 && st.measuredSha256 !== opts.measuredSha256) integrity.push(`${stFile} ${INTEGRITY_PHRASES.otherMeasured} (sha ${st.measuredSha256.slice(0, 12)}…, this one ${opts.measuredSha256.slice(0, 12)}…) — measured again outside run ${st.runId}?`);
  }

  // ---- interactions: the export says what each control does; did it? Three states, not two:
  // pass (driven, with the selector that was driven), fail (driven, did not work), not-probed
  // (nobody drove it — which is neither; finding 158 was a "not measured" detail under result "fail").
  const measuredRows: InteractionEvidence[] = Array.isArray(measured.interactions) ? measured.interactions : [];
  const allEvidence: InteractionEvidence[] = [...measuredRows, ...(Array.isArray(opts.interactions) ? opts.interactions : [])];
  // D41: evidence precedence by PROVENANCE, never by a self-declared field. The measured file's rows are the shipped
  // probe's own (authoritative) only when the file is bound to a finished run: the shipped probe's identity, a runId,
  // the run's status naming that run AND this measured file's sha (verify-run's `done`), and no integrity failure (D26).
  // Otherwise every row is agent evidence, graded as before (later wins: measured rows, then --interactions).
  const probeBound = isProbeIdentity(measured.probe) && measuredRun !== undefined && st !== null && st.runId === measuredRun
    && !!st.measuredSha256 && st.measuredSha256 === opts.measuredSha256 && integrity.length === 0;
  const fromMeasured = new Set(measuredRows);
  const probeRows = new Map<string, InteractionEvidence>(); // P: the run-bound probe's rows (a budget-cut row is no evidence)
  const exercised = new Map<string, InteractionEvidence>(); // A: the agent's rows (and an unbound measured file's)
  let interactionEvidenceOnHidden = 0;
  const expectedKeys = new Set((expectation.interactions || []).map((i) => String(i.nodeId) + "|" + i.trigger));
  for (const r of allEvidence) {
    if (!r || r.nodeId == null) continue;
    if (hiddenSet.has(String(r.nodeId))) { interactionEvidenceOnHidden++; continue; }
    const key = String(r.nodeId) + "|" + String(r.trigger || "on_click").toLowerCase();
    if (probeBound && fromMeasured.has(r)) { if (r.cut !== "budget") probeRows.set(key, r); continue; }
    exercised.set(key, r); // later evidence wins
  }
  // D20: the owner's descopes — bound to the export like a waiver; a re-export reopens them.
  const exportSha = expectation.exportContentSha256;
  const inputNotes = [...(Array.isArray(opts.inputNotes) ? opts.inputNotes : [])];
  // review LOW d: expectation.tolerance carries textInk since group 11 — one without it was written by an older
  // verify-screen (TEXT box widths, no paddingSkip/aliases)
  inputNotes.push(...pageNotes);
  if (expectation.tolerance && isJsonObject(expectation.tolerance) && expectation.tolerance.textInk === undefined) inputNotes.push("expectation written by an older verify-screen (before group 11: TEXT box widths, no aliases) — re-run --expect");
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
  if (!probeBound && isProbeIdentity(measured.probe) && measuredRows.length) inputNotes.push("the measured file's interaction rows are not run-bound (no finished run's status names this measured file) — graded as agent evidence (D41)");
  const interactions = (expectation.interactions || []).filter((i) => !hiddenSet.has(String(i.nodeId))).map((i): VerifyInteractionResult => {
    const key = String(i.nodeId) + "|" + i.trigger;
    const p = probeRows.get(key), a = exercised.get(key);
    // D24: ok:true passes only with the evidence (one element, an outcome the action produces, no reload)
    const gapsOf = (h: InteractionEvidence | undefined): string[] | null => (h && h.ok === true && h.result !== "not-probed" ? evidenceGaps(h, i.action) : null);
    // D41: a probe pass of an overlay/swap also needs the destination frame's tag inside the element that opened
    const act = String(i.action).toLowerCase();
    const needsInside = !!i.destinationId && (act === "overlay" || act === "swap");
    const pGaps = gapsOf(p);
    const pInside = !needsInside || (!!p && !!p.destination && p.destination.inside === true && p.destination.nodeId === i.destinationId);
    const pPass = pGaps !== null && pGaps.length === 0 && pInside;
    // (1) a run-bound probe pass wins; (2)/(3) a probe pass without the tag inside, a miss, a not-run or a fail never
    // overrides an agent row — the agent's is graded (D24 as before); no agent row → the probe's, as it is
    const hit = p && pPass ? p : a ?? p;
    const fromProbe = !!hit && hit === p;
    const insideMiss = fromProbe && pGaps !== null && pGaps.length === 0 && !pInside;
    const gaps = fromProbe ? (insideMiss ? [] : pGaps) : gapsOf(hit);
    const worked = fromProbe ? pPass : gaps !== null && gaps.length === 0;
    const overridden = fromProbe && pPass && a && !(a.ok === true && (gapsOf(a) ?? []).length === 0)
      ? `agent row ok: ${a.ok === undefined ? "(none)" : String(a.ok)}${a.detail ? ` — ${a.detail}` : ""}` : undefined;
    if (overridden) inputNotes.push(`${i.nodeId} (${i.trigger}): the run-bound probe's pass overrides the agent's row (${overridden}) — D41`);
    const row: VerifyInteraction = { nodeId: i.nodeId, name: i.name, trigger: i.trigger, ...ifDefined("action", i.action), ...ifDefined("destinationId", i.destinationId), ...(i.destinationExported === false ? { destinationExported: false } : {}),
      ...(i.source === "plan" ? { source: "plan" as const, ...ifDefined("expect", i.expect) } : {}) };
    const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
    const said = hit ? { ...ifDefined("outcome", typeof hit.outcome === "string" ? hit.outcome : undefined), ...ifDefined("navEvents", typeof hit.navEvents === "number" ? hit.navEvents : undefined),
      ...(probeBound ? { evidenceFrom: fromProbe ? "probe" as const : "agent" as const } : {}),
      ...ifDefined("activation", str(hit.activation)), ...ifDefined("detectedBy", str(hit.detectedBy)), ...ifDefined("revealedBy", str(hit.revealedBy)), ...ifDefined("overridden", overridden) } : {};
    // D20: removed from the graded set before grading; evidence that it works anyway is noted, never graded.
    const scoped = descopeFor(i);
    if (scoped) return Object.assign(row, { result: "descoped" as const, detail: `descoped by ${scoped.decidedBy} (${scoped.decidedAt}): ${scoped.reason}`, ...(worked ? { note: "descoped but works — the probe drove it successfully; drop the descope?" } : {}) });
    // D22: its destination was never exported — nothing designed to arrive at. A probe showing it working still passes.
    if (i.destinationExported === false && !worked) return Object.assign(row, { result: "undesigned" as const, detail: `destination ${i.destinationId} is not in this Figma file's export — nothing designed to check it against${hit && hit.detail ? `; probe said: ${hit.detail}` : ""}` });
    if (!hit) return Object.assign(row, { result: "not-probed" as const, detail: "no probe result for this node and trigger" });
    const count = Number(hit.selectorCount);
    if (hit.result === "not-probed" || hit.ok === null || hit.ok === undefined) return Object.assign(row, { result: "not-probed" as const, ...ifDefined("detail", hit.detail), ...(probeBound ? said : {}) });
    if (hit.ok === false) return Object.assign(row, { result: "fail" as const, ...ifDefined("detail", hit.detail), ...ifDefined("selector", hit.selector), ...said });
    if (insideMiss) {
      return Object.assign(row, { result: "not-probed" as const, detail: `probe pass without the destination tag inside the opened element (D41) — tag the root of what opens with data-dt-node="${i.destinationId}"${p && p.destination ? ` (the probe found ${p.destination.count} element(s) tagged ${p.destination.nodeId}, none inside it)` : ""}${hit.detail ? `; probe said: ${hit.detail}` : ""}`, ...ifDefined("selector", hit.selector), ...said });
    }
    // ok:true is a claim; the evidence is the selector that was driven and proof it matched something.
    // An agent once credited two hidden popup rows with hovers it performed on unrelated controls (187).
    // F-102: the outcome and the navigation count too — a reload once read as "the dialog opened".
    if (!worked || !hit.selector) {
      return Object.assign(row, { result: "not-probed" as const, detail: `reported ok without evidence — ${(gaps || []).join("; ")}${hit.detail ? `; probe said: ${hit.detail}` : ""}`, ...ifDefined("selector", hit.selector), ...said });
    }
    return Object.assign(row, { result: "pass" as const, ...ifDefined("detail", hit.detail), selector: hit.selector, selectorCount: count, ...said });
  });
  const unexpectedRows = allEvidence.filter((r) => r && r.nodeId != null && !hiddenSet.has(String(r.nodeId)) && !expectedKeys.has(String(r.nodeId) + "|" + String(r.trigger || "on_click").toLowerCase()));
  const unexpectedInteractionEvidence = unexpectedRows.length;
  // DT-29: name each unmatched result (once per nodeId + trigger) and, when a designed interaction is near, say which —
  // the evidence was probably meant for it (a trigger written `on_click(name link)`, an ancestor's id).
  const designed = (expectation.interactions || []).filter((i) => !hiddenSet.has(String(i.nodeId)));
  const specAnc = new Map(specs.map((sp) => [String(sp.nodeId), sp.ancestorIds || []]));
  const unmatchedInteractionEvidence: Array<{ nodeId: string; trigger: string; hint?: string }> = [];
  const unmatchedSeen = new Set<string>();
  for (const r of unexpectedRows) {
    const nodeId = String(r.nodeId), trigger = String(r.trigger || "on_click");
    const key = nodeId + "|" + trigger.toLowerCase();
    if (unmatchedSeen.has(key)) continue;
    unmatchedSeen.add(key);
    const bare = trigger.toLowerCase().replace(/\s*[(:[].*$/, "").trim();
    const sameNode = designed.filter((i) => String(i.nodeId) === nodeId);
    const exact = sameNode.find((i) => i.trigger === bare);
    const kin = designed.find((i) => i.trigger === bare && (specAnc.get(String(i.nodeId)) || []).includes(nodeId))
      ?? designed.find((i) => i.trigger === bare && (specAnc.get(nodeId) || []).includes(String(i.nodeId)));
    const hint = exact ? `use the expectation's trigger \`${exact.trigger}\` verbatim (not \`${trigger}\`)`
      : sameNode.length ? `this node's designed trigger is ${sameNode.map((i) => `\`${i.trigger}\``).join(" / ")}, not \`${trigger}\``
      : kin ? `${(specAnc.get(String(kin.nodeId)) || []).includes(nodeId) ? "an ancestor" : "a descendant"} of the designed \`${kin.nodeId}\` ${kin.name || ""} (${kin.trigger}) — report the result under the designed node's id`.replace("  (", " (")
      : undefined;
    unmatchedInteractionEvidence.push({ nodeId, trigger, ...ifDefined("hint", hint) });
  }
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
      // review LOW c: a TEXT width waiver from before group 11 — the field is the ink width now, a different value
      const inkNow = w.field === "width" && (deltas.some((d) => d.nodeId === w.nodeId && d.field === "width (text ink)") || specs.some((sp) => sp.nodeId === w.nodeId && sp.widthFrom === "renderBox"))
        ? "the field is now 'width (text ink)' (group 11) — re-accept against the new report" : undefined;
      unused.push({ nodeId: w.nodeId, field: w.field, why: notWaivable.get(w.nodeId) ?? fieldGap ?? inkNow ?? "no such delta this round — fixed? drop the waiver" });
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

  // ---- D39 (refined): the owner accepted a `match (size)` row — the element IS the node, so the SIZE cap on its other
  // deltas is lifted (a real high then fails). A D30 match-confidence cap stays: how the element was found has not changed.
  for (const sz of deltas.filter((d) => d.field === "match (size)" && d.accepted)) {
    const mcap = matchCapOf.get(String(sz.nodeId));
    for (const d of deltas) {
      if (d === sz || d.nodeId !== sz.nodeId || !d.cappedFrom || !(d.cappedBy || []).includes("size")) continue;
      const orig = d.cappedFrom;
      const sev: DeltaSeverity = mcap && SEVERITY_RANK[orig] < SEVERITY_RANK[mcap] ? mcap : orig;
      d.severity = sev;
      if (sev === orig) { delete d.cappedFrom; delete d.cappedBy; } else d.cappedBy = ["match"];
      d.note = `${d.note ? `${d.note}; ` : ""}size cap lifted: the owner accepted this element (waiver on match (size))${sev !== orig ? ` — still capped at ${sev} by how it was matched` : ""}`;
    }
  }

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

  // F-95 (D40(7)): the plan's interactions[] bind the expectation by their hash — a plan that changed them since --expect
  // (or declares some the expectation never merged) makes the run incomplete (not an integrity failure: --accept works)
  const planNow = opts.plan || null;
  const recordedPi = expectation.planInteractions && isJsonObject(expectation.planInteractions) && typeof expectation.planInteractions.sha256 === "string" ? expectation.planInteractions : undefined;
  const nowRows = planNow && Array.isArray(planNow.plan.interactions) ? planNow.plan.interactions : null;
  // review M3: name --plan when the plan was not simply the frame's only one (picked by --plan, among several, or as the
  // expectation's recorded plan), or the expectation merged another plan's rows — a plain re-run of --expect could
  // otherwise pick a different plan
  const otherPlan = recordedPi !== undefined && planNow !== null && !samePlanFile(recordedPi.plan, planNow.file);
  const rerunPlanArg = planNow && (planNow.choice === "flag" || planNow.choice === "files" || planNow.choice === "recorded" || otherPlan) ? ` --plan ${planNow.file}` : "";
  const gone = opts.recordedPlanGone || null;
  const shaNow = planNow ? planInteractionsSha256(planNow.plan) : "";
  const planInteractionsChanged = !planNow || !(recordedPi ? shaNow !== recordedPi.sha256 : !!nowRows && nowRows.length > 0) ? null
    : !recordedPi ? `the plan's interactions[] changed since --expect (${planNow.file}: the expectation merged none) — re-run --expect${rerunPlanArg}`
    // review-2 M-b: the rows --expect merged came from ANOTHER plan file — name both, never advise only the one used now
    : otherPlan && planNow.choice === "flag" ? `the plan's interactions[] differ from those --expect merged (${planNow.file}, passed by --plan: sha256 ${shaNow.slice(0, 12)}…; --expect merged ${recordedPi.plan}'s${gone ? `, which ${gone}` : ""}: ${recordedPi.sha256.slice(0, 12)}…) — re-run --expect --plan ${planNow.file}${gone ? "" : `, or drop --plan at --compare to check against ${recordedPi.plan}`}`
    : otherPlan ? `the plan's interactions[] at --expect came from ${recordedPi.plan}, which ${gone ?? "--compare did not use"}; the plan found now, ${planNow.file}, declares others (sha256 ${recordedPi.sha256.slice(0, 12)}… at --expect, ${shaNow.slice(0, 12)}… now) — if that plan moved, re-run --compare … --plan <its path now>; otherwise re-run --expect … --plan <the plan you intend> (--plan ${planNow.file} to adopt this one)`
    : `the plan's interactions[] changed since --expect (${planNow.file}: sha256 ${recordedPi.sha256.slice(0, 12)}… at --expect, ${shaNow.slice(0, 12)}… now) — re-run --expect${rerunPlanArg}`;
  if (recordedPi && planNow && otherPlan && gone && !planInteractionsChanged) inputNotes.push(`the expectation merged plan interactions from ${recordedPi.plan}, which ${gone}; ${planNow.file} (used now) declares the same interactions[]`);
  if (recordedPi && !planNow) inputNotes.push(gone ? `the expectation merged plan interactions from ${recordedPi.plan}, which ${gone}, and no single plan describes this frame now — not checked; pass --compare … --plan <plan.json> (or re-run --expect … --plan <plan.json>)`
    : `the expectation merged plan interactions from ${recordedPi.plan}, but no plan was found for this frame now — not checked`);
  // L-1: the steps the probe replayed to reach the screen, against the plan's navigate[] — informational, never the verdict
  const reachRaw: unknown = measured.reach;
  const reach = isProbeReach(reachRaw) ? reachRaw : undefined;
  if (reachRaw !== undefined && !reach && !inputNotes.some((n) => n.startsWith("measured.reach "))) inputNotes.push("measured.reach is not the probe's steps block; ignored");
  let reachInput: NonNullable<VerifyReportV2["inputs"]>["reach"];
  if (reach) {
    const nav = planNow && planNow.plan.navigate !== undefined ? parseSteps({ navigate: planNow.plan.navigate }) : null;
    const planSha = nav && "steps" in nav ? stepsSha256(nav.steps) : null;
    const matchesPlan = nav === null ? null : planSha !== null && planSha === reach.sha256;
    reachInput = { sha256: reach.sha256, steps: reach.steps.length, source: reach.source, matchesPlan };
    if (matchesPlan === false) inputNotes.push(nav && "error" in nav ? `the plan's navigate ${nav.error} — the probe's steps (sha ${reach.sha256.slice(0, 12)}…) were not checked against it`
      : `the probe's steps (sha ${reach.sha256.slice(0, 12)}…, ${reach.source}) are not the plan's navigate (sha ${(planSha ?? "").slice(0, 12)}…) — measured another way than the plan says`);
  } else if (reachRaw === undefined && planNow && Array.isArray(planNow.plan.navigate) && planNow.plan.navigate.length > 0) {
    // review L9 (live L-1): the plan says how to reach the screen, the probe was never told — it measured the landing page
    inputNotes.push(`the plan declares navigate steps but the probe ran without --steps (${planNow.file}) — it measured whatever the URL shows first; re-run the probe with --steps ${planNow.file}`);
  }
  // ---- what the evidence is tied to (findings 153/166/190)
  // (an in-process caller can hand over any object: a probe that is not an identity reads as unknown, with a note)
  const probeRaw: unknown = measured.probe;
  const probeIdentity = isProbeIdentity(probeRaw) ? probeRaw : undefined;
  const buildRaw: unknown = measured.build;
  const buildNow = isBuildIdentity(buildRaw) ? buildRaw : undefined;
  if (buildRaw !== undefined && !buildNow && !inputNotes.some((n) => n.startsWith("measured.build "))) inputNotes.push("measured.build is not a build identity; ignored (build: unknown)");
  if (opts.status && opts.status.status === "v1") inputNotes.push(`${opts.status.file} is an older hand-written status (no run id, no shas) — not checked; write it with verify-screen --status`);
  const runId = typeof measured.runId === "string" && measured.runId ? measured.runId : st ? st.runId : undefined;
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
    // DT-81: the build the probe was served — "unknown" when it records none (a hand-written probe, an older one)
    build: buildNow ?? "unknown",
    ...ifDefined("runId", runId),
    ...ifDefined("reach", reachInput),
  };
  const staticOnly = measured.mode === "static-only";
  const artifactCheck = Array.isArray(opts.artifactCheck) ? opts.artifactCheck : null;
  const noRender = !!artifactCheck && !artifactCheck.some((a) => a.exists && a.image);

  // The verdict is COMPUTED. Coverage first — how much was looked at decides what the rest is worth.
  // (a spec a plan anchor folded into a measured ancestor, F-77, is out of the denominator)
  const nodesExpected = specs.length - folded.length;
  const reasons: string[] = [];
  // D26 (F-72): the run's integrity (computed above, before the interactions — D41 binds probe rows to it), ranked FIRST.
  reasons.push(...integrity);
  const integrityFailed = integrity.length > 0;
  // D39 (review H1): a capped delta keeps its lower severity, but the match behind it is not trusted — any open one
  // blocks a plain pass (and a pass-with-deviations): incomplete, never fail on its own
  const lowConfidence = open.filter((d) => d.cappedFrom !== undefined).length;
  if (lowConfidence) reasons.push(`${lowConfidence} delta(s) on low-confidence matches — tag these elements`);
  if (planInteractionsChanged) reasons.push(planInteractionsChanged);
  if (legacy) reasons.push(`the expectation is ${expectation.schema || "unversioned"}, which predates hidden-layer filtering — regenerate it with --expect before trusting any number here`);
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
    : integrityFailed ? "incomplete" : high || componentsAbsent.length || interactionsFailed.length ? "fail" : "incomplete";

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
    ...ifDefined("sharedShell", sharedShell),
    ...(probeBound ? { interactionsByProbe: interactions.filter((i) => i.evidenceFrom === "probe").length } : {}),
    pageOverflow,
  };

  // ---- D18: coverage against the previous round. Printed, recorded, and NEVER part of the verdict — a
  // round that measures 42 nodes where the last measured 185 is still judged on its own numbers, but it
  // can no longer read as progress (DT-44).
  let against: VerifyAgainst | undefined;
  if (opts.against) {
    const prev = opts.against.report;
    const pb: unknown = prev.inputs ? prev.inputs.build : undefined;
    const prevBuild = isBuildIdentity(pb) ? pb : null;
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
      ...(Array.isArray(prev.deltas) ? { deltas: deltaChanges(prev.deltas, deltas, { notMeasured, fieldsNotMeasured, unverifiable, notComparable: expectation.notComparable || [], specIds: new Set(specs.map((sp) => String(sp.nodeId))), absent: absentGaps, placementGaps, pageOverflow,
        sameMeasured: !!(opts.measuredSha256 && prev.inputs && prev.inputs.measuredSha256 === opts.measuredSha256) }) } : {}),
      // LOW a: unknown when either side's hash is partial (bodies left out) — never "the same build" on a partial hash
      sameBuild: prevBuild && buildNow && !prevBuild.unhashed && !buildNow.unhashed ? prevBuild.assetsSha256 === buildNow.assetsSha256 : null,
    };
  }
  // DT-81: the same build served although the code changed → the preview/dist was not rebuilt (never the verdict)
  const prevCode = opts.against && opts.against.report.inputs ? opts.against.report.inputs.code : undefined;
  const codeChanged = prevCode && opts.code ? (Object.keys(prevCode.files).length && Object.keys(opts.code.files).length ? JSON.stringify(sortKeys(prevCode.files)) !== JSON.stringify(sortKeys(opts.code.files))
    : !!(prevCode.gitHead && opts.code.gitHead && prevCode.gitHead !== opts.code.gitHead)) : false;
  const sameBuildServed = !!(against && against.sameBuild === true && codeChanged);
  const lost = against && against.deltas ? against.deltas.lostCoverage.length : 0;
  const unmatchedCount = unmatchedInteractionEvidence.length;
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
    `nodes measured ${nodesMeasured}/${nodesExpected}${folded.length ? ` (${folded.length} folded)` : ""}${sharedShell ? ` (shared shell ${sharedShell.measured}/${sharedShell.expected})` : ""} · ${fieldsChecked} values compared · ${high} high${highCauses < high ? ` (${highCauses} cause${highCauses === 1 ? "" : "s"})` : ""}, ${medium} medium` +
    (lowConfidence ? ` (+${lowConfidence} capped on low-confidence matches)` : "") +
    (accepted ? ` · ${accepted} accepted` : "") + (reopened.length ? ` · ${reopened.length} waiver(s) REOPENED` : "") + " · " +
    // (not a verdict reason, like ::placeholder colour — but never silent: an <img> icon's fill is not a pass)
    (unverifiable.length ? `${unverifiable.length} value(s) unverifiable by method · ` : "") +
    `interactions ${interactionsPassed.length} pass, ${interactionsFailed.length} fail, ${interactionsNotProbed.length} not-probed` +
    (interactionsUndesigned.length ? `, ${interactionsUndesigned.length} undesigned` : "") + (interactionsDescoped.length ? `, ${interactionsDescoped.length} descoped` : "") + ` of ${interactions.length} · ` +
    `data-dt-node/component evidence ${coverage.instanceSetsWithEvidence}/${bySet.size} instance sets (tag coverage, not presence)` +
    (against && fell ? ` · COVERAGE FELL ${against.nodesMeasured.before}→${against.nodesMeasured.after} vs ${against.report}` : "") +
    (against && against.probeChanged === true ? " · probe changed" : "") +
    // group 10 — informational, never the verdict
    (unmatchedCount ? ` · ${unmatchedCount} probe result(s) matched no designed interaction` : "") +
    (lost ? ` · LOST COVERAGE on ${lost} earlier delta(s)` : "") +
    (foreignTags ? ` · ${foreignTags.total} foreign tag(s) (${foreignTags.prefixDrift} prefix drift, ${foreignTags.alias} alias, ${foreignTags.unknown} unknown)` : "") +
    (sameBuildServed && against ? ` · SAME BUILD SERVED as ${against.report} although the code changed (stale preview/dist?)` : "");

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
    // 12b (D4): copied and counted, read by nothing above
    behaviour: behaviourReport(measured.behaviour, opts.behaviourMalformed === true),
    // 12c (D4, D40(3)): copied, read by nothing above
    visual: visualReport(measured.visual, opts.visualMalformed === true, { diff: opts.visualDiff ?? null, against: opts.against ?? null, noProbe: !isProbeIdentity(measured.probe) }),
    why: reasons,
    integrity,
    coverage,
    summary: { high, medium, low: open.filter((d) => d.severity === "low").length, componentsAbsent: componentsAbsent.length, interactionsFailed: interactionsFailed.length, interactionsNotProbed: interactionsNotProbed.length,
      accepted, descoped: interactionsDescoped.length, undesigned: interactionsUndesigned.length, highCauses, lowConfidence },
    deltas: deltas.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]),
    componentsAbsent,
    untaggedInstanceSets: untaggedOnScreen,
    ...(untaggedInstanceSetsInShell.length ? { untaggedInstanceSetsInShell } : {}),
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
      ...(unmatchedInteractionEvidence.length ? { unmatchedInteractionEvidence } : {}),
      measuredIdsOnHiddenLayers: [...byId.keys()].filter((id) => hiddenSet.has(id)).length,
      measuredIdsNotInExpectation: measuredIdsNotInExpectation.length,
      measuredIdsNotInExpectationSample: measuredIdsNotInExpectation.slice(0, 5),
      ...ifDefined("foreignTags", foreignTags),
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

// ---------------------------------------------------------------- 12c: visual diff (D4, D40(3) — never the verdict)
// compare() copies measured.visual into report.visual; nothing else in compare reads it, so the verdict, why[],
// integrity, summary, coverage, deltas and the fidelity headline are the same with or without it (D4).
export const VISUAL_NO_BLOCK = "the measured file carries no visual diff (hand-written, or a probe older than 12c)";
/** F-12: a measured file with no probe block (hand-written, a non-web stack) — the visual diff is a web-probe step */
export const VISUAL_NOT_APPLICABLE = "not applicable (no web probe)";
export const VISUAL_MALFORMED = "the measured file's visual block is malformed — ignored (see the input notes)";
const VISUAL_PREFIX = "VISUAL (informational — never the verdict) — ";
/** A percentage for a headline: 1 decimal, "<0.1" for a non-zero value that rounds to 0 (the probe's stderr line uses it too). */
export const pctText = (n: number): string => (n > 0 && n < 0.05 ? "<0.1" : (Math.round(n * 10) / 10).toFixed(1));
/** The third headline: `VISUAL (informational — never the verdict) — 0.9% of pixels differ (2.4% before 1-px shift
 *  tolerance) · 4 hot regions · at the reference's 1.4222x (index) · design/verify/S.diff.png`, or `… — not run (<why>)`. */
export function visualHeadline(r: Omit<ReportVisual, "headline">, shiftPx?: number, notComparedPct?: number): string {
  if (!r.ran) return r.why === VISUAL_NOT_APPLICABLE ? VISUAL_PREFIX + VISUAL_NOT_APPLICABLE : `${VISUAL_PREFIX}not run (${r.why || "no reason recorded"})`;
  const n = r.regionsTotal ?? r.regions.length;
  const parts = [`${pctText(r.shiftTolerantPct ?? 0)}% of pixels differ (${pctText(r.differingPct ?? 0)}% before ${shiftPx ?? 1}-px shift tolerance)`,
    `${n} hot region${n === 1 ? "" : "s"}`];
  const at = r.reference ? ` (${r.reference.from})` : "";
  parts.push(r.grid === "1x" ? `resampled to 1x (reference ${r.scale ?? "?"}x${at}) — resampling can hide a difference` : `at the reference's ${r.scale ?? "?"}x${at}`);
  if (notComparedPct) parts.push(`${pctText(notComparedPct)}% of the design window not compared`);
  if (r.reference && r.reference.colorProfile) parts.push(`${r.reference.colorProfile}: colours not colour-managed`);
  if (r.diff) parts.push(r.diff.exists ? r.diff.path : `${r.diff.path} (missing)`);
  return VISUAL_PREFIX + parts.join(" · ");
}
/** report.visual from measured.visual (absent → ran:false with why; malformed → ran:false, ignored). The block's fields
 *  are read one by one (the guard is lenient). `diff` = where the diff PNG is now (the CLI resolves it beside the measured
 *  file); absent = the recorded path, checked as-is. `against` = the previous round's report (D18). */
export function visualReport(v: unknown, malformed = false, o?: { diff?: { path: string; exists: boolean } | null; against?: { file: string; report: VerifyReport } | null; noProbe?: boolean }): ReportVisual {
  const none = (why: string): ReportVisual => {
    const r = { ran: false, why, regions: [], notes: [] };
    return { ...r, headline: visualHeadline(r) };
  };
  if (v === undefined) return none(malformed ? VISUAL_MALFORMED : o && o.noProbe ? VISUAL_NOT_APPLICABLE : VISUAL_NO_BLOCK);
  if (!isMeasuredVisual(v)) return none(VISUAL_MALFORMED);
  if (!v.ran) return none(v.why);
  const notes: string[] = [];
  const raw: unknown[] = v.regions;
  const regions = raw.filter(isVisualRegion);
  if (regions.length < raw.length) notes.push(`${raw.length - regions.length} malformed region row(s) left out`);
  const rt: unknown = v.regionsTotal, ref: unknown = v.reference, grid: unknown = v.grid, cap: unknown = v.capture, nc: unknown = v.notCompared, sp: unknown = v.shiftPx, dp: unknown = v.diff;
  const from: "index" | "export" | null = isJsonObject(ref) ? ref.from === "index" ? "index" : ref.from === "export" ? "export" : null : null;
  const reference: ReportVisual["reference"] = isJsonObject(ref) && typeof ref.path === "string" && from
    ? { path: ref.path, from, ...ifDefined("colorProfile", typeof ref.colorProfile === "string" ? ref.colorProfile : undefined), ...ifDefined("sha256", typeof ref.sha256 === "string" ? ref.sha256 : undefined) }
    : undefined;
  const refScale = isJsonObject(ref) && num(ref.scale) ? ref.scale : undefined;
  const scale = refScale ?? (isJsonObject(cap) && num(cap.dsf) ? cap.dsf : undefined);
  const g: "reference" | "1x" | undefined = grid === "reference" ? "reference" : grid === "1x" ? "1x" : undefined;
  const notCompared = isJsonObject(nc) && num(nc.pct) ? { pct: nc.pct, why: typeof nc.why === "string" ? nc.why : "" } : undefined;
  if (notCompared && notCompared.pct > 0) notes.push(`${pctText(notCompared.pct)}% of the design window not compared${notCompared.why ? ` (${notCompared.why})` : ""}`);
  const own: unknown[] = Array.isArray(v.notes) ? v.notes : [];
  notes.unshift(...own.filter((n): n is string => typeof n === "string"));
  const diff = typeof dp === "string" && dp ? o && o.diff ? o.diff : { path: dp, exists: fs.existsSync(dp) } : undefined;
  // D18-style: the previous round's percentage, only when it diffed the same reference on the same grid
  let against: ReportVisual["against"];
  const pv: unknown = o && o.against ? o.against.report.visual : undefined;
  if (o && o.against && isJsonObject(pv) && pv.ran === true && num(pv.shiftTolerantPct) && pv.grid === g && reference && reference.sha256
    && isJsonObject(pv.reference) && pv.reference.sha256 === reference.sha256) against = { report: o.against.file, before: pv.shiftTolerantPct, after: v.shiftTolerantPct };
  const r: Omit<ReportVisual, "headline"> = {
    ran: true, differingPct: v.differingPct, shiftTolerantPct: v.shiftTolerantPct, ...ifDefined("grid", g), ...ifDefined("scale", scale), ...ifDefined("reference", reference),
    regions, regionsTotal: num(rt) ? rt : regions.length, ...ifDefined("diff", diff), notes, ...ifDefined("against", against),
  };
  return { ...r, headline: visualHeadline(r, num(sp) ? sp : undefined, notCompared ? notCompared.pct : undefined) };
}
const VISUAL_MD_ROWS = 10;
/** The md section "Visual diff — informational, not part of the verdict". */
function visualMarkdown(v: ReportVisual): string[] {
  const L: string[] = ["## Visual diff — informational, not part of the verdict", ""];
  L.push("*The pixel diff never changes the fidelity verdict above (D4, D40(3)). Font rasterisation alone differs 1–3% on text-heavy screens (Figma's renderer vs Chromium), so read the regions, not the percentage.*", "");
  if (!v.ran) {
    L.push(v.why === VISUAL_NOT_APPLICABLE ? "Not applicable (no web probe)." : `Not run (${mdText(v.why) || "no reason recorded"}).`, "");
    return L;
  }
  L.push(`${pctText(v.shiftTolerantPct ?? 0)}% of the compared pixels differ after the shift tolerance (${pctText(v.differingPct ?? 0)}% before it; anti-aliased edge pixels excluded) · ${v.regionsTotal ?? v.regions.length} hot region(s).`, "");
  if (v.reference) L.push(`Reference: ${mdText(v.reference.path)} at ${v.scale ?? "?"}x (geometry from the ${v.reference.from === "index" ? "export index" : "export root, recomputed"}).`, "");
  if (v.grid === "1x") L.push("Grid: **resampled to 1x** — the capture and the reference crop differ by more than 2 px, so both were resampled to the design size (up or down); resampling can hide a difference.", "");
  else if (v.grid) L.push("Grid: the reference's own pixel grid (the build rendered at the reference's scale).", "");
  if (v.reference && v.reference.colorProfile) L.push(`Colour profile: ${mdText(v.reference.colorProfile)} — colours are compared without colour management, so colour differences are unreliable.`, "");
  if (v.regions.length) {
    L.push("| Region (x, y) | Size | Differ | Built nodes | Designed nodes |", "|---|---|---|---|---|");
    for (const g of v.regions.slice(0, VISUAL_MD_ROWS)) {
      L.push(`| ${Math.round(g.rect.x)}, ${Math.round(g.rect.y)} | ${Math.round(g.rect.w)}×${Math.round(g.rect.h)} | ${pctText(g.pct)}% (${g.pixels} px) | ${g.built.map(mdText).join(", ")} | ${g.designed.map(mdText).join(", ")} |`);
    }
    const total = v.regionsTotal ?? v.regions.length;
    if (total > Math.min(v.regions.length, VISUAL_MD_ROWS)) L.push(`| …and ${total - Math.min(v.regions.length, VISUAL_MD_ROWS)} more (the largest are listed) | | | | |`);
    L.push("");
  }
  if (v.diff) L.push(`Diff image: ${mdText(v.diff.path)}${v.diff.exists ? "" : " (missing on disk)"}`, "");
  if (v.against) L.push(`Against the previous round (${mdText(v.against.report)}): visual: ${pctText(v.against.before)} % → ${pctText(v.against.after)} % (same reference, same grid; never the verdict).`, "");
  for (const n of v.notes) L.push(`- ${mdText(n)}`);
  if (v.notes.length) L.push("");
  return L;
}

// ---------------------------------------------------------------- 12b: behaviour / a11y (D4 — never the verdict)
// compare() copies measured.behaviour into report.behaviour and counts it; nothing else in compare reads it, so the
// verdict, why[], integrity, summary, coverage, deltas and the fidelity headline are the same with or without it.
const BEHAVIOUR_ORDER: Record<BehaviourStatus, number> = { fail: 0, warn: 1, "not-run": 2, unsupported: 3, pass: 4 };
export const BEHAVIOUR_NO_BLOCK = "the measured file carries no behaviour checks (hand-written, or a probe older than 12b)";
export const BEHAVIOUR_MALFORMED = "the measured file's behaviour block is malformed — ignored (see the input notes)";
/** F-110: how accessible names were obtained — never a screen reader. */
export const NAMES_LABEL = "names computed by Playwright (Chromium), not screen-reader verified";
const BEHAVIOUR_PREFIX = "BEHAVIOUR/A11Y (not the fidelity verdict) — ";
/** A "+N more" row (the elements past the per-element cap): the probe marks it evidence.more === true, and evidence.count
 *  says how many elements it stands for. Never keyed on the row's wording. */
function moreCount(c: BehaviourCheck): number | null {
  const ev = c.evidence;
  const n = ev ? ev.count : undefined;
  if (!ev || c.status === "pass" || typeof n !== "number" || !Number.isInteger(n) || n <= 0) return null;
  if (ev.more === true) return n;
  // FALLBACK (measured files written before evidence.more — the first 12b probe only): its exact "+N more" detail, with N
  // equal to evidence.count. Remove once those files are gone.
  return ev.more === undefined && c.detail.startsWith(`+${n} more `) ? n : null;
}
/** Results per status: a row counts once — an aggregate "k of n" pass row too — except a "+N more" row, which counts the
 *  N elements it stands for (so summary.fail is what plan.verification.a11y.violations copies). */
export function behaviourSummary(checks: readonly BehaviourCheck[]): BehaviourSummary {
  const s: BehaviourSummary = { pass: 0, fail: 0, warn: 0, notRun: 0, unsupported: 0 };
  for (const c of checks) {
    const n = moreCount(c) ?? 1;
    if (c.status === "not-run") s.notRun += n;
    else s[c.status] += n;
  }
  return s;
}
/** The second headline: `BEHAVIOUR/A11Y (not the fidelity verdict) — 2 fail · 1 warn · 9 pass · 3 not run · axe-core 4.13.0 · names computed …`,
 *  or `… — not run (<why>)`. */
export function behaviourHeadline(summary: BehaviourSummary, o: { ran: boolean; why?: string | undefined; axe?: ReportBehaviour["axe"] | undefined; cut?: boolean | undefined }): string {
  if (!o.ran) return `${BEHAVIOUR_PREFIX}not run (${o.why || "no reason recorded"})`;
  const parts = [`${summary.fail} fail`, `${summary.warn} warn`, `${summary.pass} pass`, `${summary.notRun} not run`];
  if (summary.unsupported) parts.push(`${summary.unsupported} unsupported`);
  if (o.cut) parts.push("cut by the time budget");
  if (o.axe) parts.push("version" in o.axe ? `axe-core ${o.axe.version}` : "axe-core not run");
  parts.push(NAMES_LABEL);
  return BEHAVIOUR_PREFIX + parts.join(" · ");
}
/** report.behaviour from measured.behaviour (absent → ran:false with why; malformed → ran:false, ignored). Checks sorted
 *  fail > warn > not-run > unsupported > pass, the probe's order kept within a status. */
export function behaviourReport(b: unknown, malformed = false): ReportBehaviour {
  const none = (why: string): ReportBehaviour => {
    const summary = behaviourSummary([]);
    return { ran: false, why, summary, headline: behaviourHeadline(summary, { ran: false, why }), checks: [] };
  };
  // L3: readableMeasured dropped a block that was there (malformed) — not the same as a probe that wrote none
  if (b === undefined) return none(malformed ? BEHAVIOUR_MALFORMED : BEHAVIOUR_NO_BLOCK);
  if (!isMeasuredBehaviour(b)) return none(BEHAVIOUR_MALFORMED);
  if (!b.ran) return none(b.why);
  const checks = b.checks.map((c, i) => ({ c, i })).sort((x, y) => BEHAVIOUR_ORDER[x.c.status] - BEHAVIOUR_ORDER[y.c.status] || x.i - y.i).map((x) => x.c);
  const summary = behaviourSummary(checks);
  // the block's other fields are read one by one: the guard is lenient (an older/newer probe still reports its rows)
  const ax: unknown = b.axe;
  const axe: ReportBehaviour["axe"] | undefined = !isJsonObject(ax) ? undefined
    : ax.ran === true && typeof ax.version === "string" ? { version: ax.version }
    : ax.ran === false ? { notRun: typeof ax.why === "string" ? ax.why : "no reason recorded" } : undefined;
  const artifacts: unknown = b.artifacts;
  const arts = Array.isArray(artifacts) ? artifacts.filter((a): a is string => typeof a === "string") : [];
  const names: unknown = b.namesComputedBy;
  const cut: unknown = b.cut;
  const block: unknown = b.writeBlock;
  return {
    ran: true, summary, headline: behaviourHeadline(summary, { ran: true, axe, cut: cut === true }),
    ...ifDefined("namesComputedBy", typeof names === "string" ? names : undefined), ...ifDefined("axe", axe),
    checks, ...(arts.length ? { artifacts: arts } : {}), ...ifDefined("writeBlock", typeof block === "string" ? block : undefined),
  };
}
// L5: behaviour text comes from the page (accessible names, text, element paths like "body > div > <span>") — escaped
// for markdown AND inline HTML, so "focus went to <body>" never renders as "focus went to ", and a | or newline never
// breaks the table. No code spans: a backtick inside one cannot be escaped.
export const mdText = (x: string | undefined): string => (x ?? "").replace(/\r?\n|\r/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/\|/g, "\\|").replace(/`/g, "\\`");
const behaviourWhere = (c: BehaviourCheck): string => [c.nodeId ? mdText(c.nodeId) : "", c.trigger ? `(${mdText(c.trigger)})` : "", c.target ? mdText(c.target) : ""].filter(Boolean).join(" ");
const BEHAVIOUR_MD_ROWS = 80;
/** The md section "Behaviour and accessibility — not part of the verdict". */
function behaviourMarkdown(b: ReportBehaviour): string[] {
  const L: string[] = ["## Behaviour and accessibility — not part of the verdict", ""];
  L.push("*These checks never change the fidelity verdict above (D4). A failed check is still a measurable accessibility failure: fix it or raise a designer question.*", "");
  if (!b.ran) {
    L.push(`Not run (${mdText(b.why) || "no reason recorded"}).`, "");
    return L;
  }
  const s = b.summary;
  L.push(`${s.fail} fail · ${s.warn} warn · ${s.pass} pass · ${s.notRun} not run${s.unsupported ? ` · ${s.unsupported} unsupported` : ""}`, "");
  const fails = b.checks.filter((c) => c.status === "fail");
  if (fails.length) {
    L.push(`### Failed (${fails.length})`, "");
    for (const c of fails) L.push(`- **${mdText(c.id)}**${behaviourWhere(c) ? ` ${behaviourWhere(c)}` : ""}${c.variant ? ` [${mdText(c.variant)}]` : ""} — ${mdText(c.detail)}`);
    L.push("");
  }
  if (b.checks.length) {
    L.push("| Status | Check | Node/target | Variant | Detail |", "|---|---|---|---|---|");
    for (const c of b.checks.slice(0, BEHAVIOUR_MD_ROWS)) L.push(`| ${c.status} | ${mdText(c.id)} | ${behaviourWhere(c)} | ${mdText(c.variant)} | ${mdText(c.detail)}${c.synthetic ? " *(synthetic (headless), not a real-browser observation)*" : ""} |`);
    if (b.checks.length > BEHAVIOUR_MD_ROWS) L.push(`| …and ${b.checks.length - BEHAVIOUR_MD_ROWS} more (report.json lists all) | | | | |`);
    L.push("");
  }
  L.push(`Accessible names: ${NAMES_LABEL}${b.namesComputedBy ? ` (${mdText(b.namesComputedBy)})` : ""}.`, "");
  if (b.axe) L.push("version" in b.axe ? `axe-core ${mdText(b.axe.version)} ran on the main frame (iframes not scanned): critical/serious violations fail, moderate/minor warn.` : `axe-core: not run — ${mdText(b.axe.notRun)}.`, "");
  if (b.artifacts && b.artifacts.length) L.push(`Behaviour artifacts: ${b.artifacts.map(mdText).join(", ")}`, "");
  if (b.writeBlock) L.push(`Write block: ${mdText(b.writeBlock)}`, "");
  return L;
}

function reportToMarkdown(r: VerifyReportV2): string {
  const L: string[] = [];
  L.push(`# Verify — ${r.screen}`, "");
  L.push(`**${r.headline || r.verdict.toUpperCase()}**`, "");
  L.push(`**${mdText(r.behaviour.headline)}**`, "");
  L.push(mdText(r.visual.headline), "");
  L.push(`renderer ${r.renderer}${r.viewport ? ` at ${typeof r.viewport === "object" ? JSON.stringify(r.viewport) : r.viewport}` : ""} · measured ${r.measuredAt}` +
    (r.inputs && r.inputs.expectationSha256 ? ` · against expectation ${r.inputs.expectationSha256.slice(0, 12)}…` : "") + (r.inputs && r.inputs.runId ? ` · run ${r.inputs.runId}` : ""), "");
  // L-1: how the probe reached the screen (never the verdict)
  const rc = r.inputs && r.inputs.reach;
  if (rc) L.push(`Reached by ${rc.steps} step(s) (sha ${rc.sha256.slice(0, 12)}…, ${rc.source})${rc.matchesPlan === true ? " — the plan's navigate" : rc.matchesPlan === false ? " — **not the plan's navigate**" : ""}.`, "");
  // DT-81: which build was served (a stale preview measures old code)
  const b = r.inputs && r.inputs.build;
  L.push(b && b !== "unknown"
    ? `Build served: ${b.mode} ${b.url} · ${b.assets} asset(s), sha256 ${b.assetsSha256.slice(0, 12)}…${b.unhashed ? ` (partial: ${b.unhashed} body(ies) not hashed)` : ""} · git ${b.gitHead ? b.gitHead.slice(0, 12) : "none"}${b.gitDirty ? " (uncommitted changes)" : ""}`
    : "Build served: build identity unknown (the measured file records none — measured by a hand-written or older probe).", "");
  if (r.why.length) {
    L.push("Why this is not a pass:", "");
    for (const w of r.why) L.push(`- ${w}`);
    L.push("");
  }
  const c = r.coverage;
  L.push("## What was actually checked", "");
  L.push("| | |", "|---|---|");
  L.push(`| node specs measured | ${c.nodesMeasured} / ${c.nodesExpected}${c.nodesMatchedByComponentPath ? ` (${c.nodesMatchedByComponentPath} via a shared component's internal path)` : ""}${c.nodesFolded ? ` (+${c.nodesFolded} folded into a measured ancestor, out of the count)` : ""} |`);
  if (c.sharedShell) L.push(`| of which in a shared shell (informational — matched through another screen's id, or plan anchors[id].shared) | ${c.sharedShell.measured} / ${c.sharedShell.expected} in ${c.sharedShell.instances.map((i) => `${i.name} \`${i.nodeId}\` ${i.measured}/${i.expected}`).join(", ")} |`);
  L.push(`| individual values compared | ${c.fieldsChecked} |`);
  L.push(`| values on measured nodes the probe did not report | ${c.fieldsNotMeasured} |`);
  if (c.fieldsNeverMeasured.length) L.push(`| **fields present in 0 measurements** | ${c.fieldsNeverMeasured.map((f) => `\`${f.field}\`${f.probeSent ? ` (probe sent \`${f.probeSent.join("`, `")}\`)` : ""}`).join(", ")} |`);
  L.push(`| design values excluded by method (listed below) | ${c.valuesNotComparable} |`);
  L.push(`| values the method cannot read unaided | ${c.valuesUnverifiable} |`);
  if (c.hiddenLayersSkipped) L.push(`| hidden layers skipped (not built, not measured, not driven) | ${c.hiddenLayersSkipped.layers} layer(s) · ${c.hiddenLayersSkipped.specsSkipped} spec(s) · ${c.hiddenLayersSkipped.instancesSkipped} instance(s) · ${c.hiddenLayersSkipped.interactionsSkipped} interaction(s) |`);
  L.push(`| instance sets the probe could point at (data-dt-node / component evidence — coverage, NOT presence) | ${c.instanceSetsWithEvidence} / ${c.instanceSets} |`);
  L.push(`| designed interactions: pass / fail / not-probed | ${c.interactionsPassed} / ${c.interactionsFailed} / ${c.interactionsNotProbed} of ${c.interactionsExpected}` +
    `${c.interactionsUndesigned ? ` · ${c.interactionsUndesigned} undesigned (destination never exported)` : ""}${c.interactionsDescoped ? ` · ${c.interactionsDescoped} descoped by the owner` : ""}` +
    `${c.interactionsByProbe ? ` · ${c.interactionsByProbe} driven by the shipped probe (dialog contract)` : ""} |`);
  if (c.pageOverflow !== undefined) L.push(`| page overflow at the design width (overflowX) | ${c.pageOverflow} |`);
  if (c.deltasAccepted) L.push(`| value mismatches accepted by a plan waiver (listed, out of the counts) | ${c.deltasAccepted} |`);
  L.push("");
  L.push(...behaviourMarkdown(r.behaviour));
  L.push(...visualMarkdown(r.visual));
  if (r.against) {
    const a = r.against;
    L.push(`Against the previous round (${a.report}): nodes measured ${a.nodesMeasured.before ?? "?"} → ${a.nodesMeasured.after}, expected ${a.nodesExpected.before ?? "?"} → ${a.nodesExpected.after}` +
      `${a.probeChanged === true ? " · **the probe changed**" : a.probeChanged === null ? " · probe identity unknown on both rounds" : ""}${a.expectationChanged ? " · the expectation changed" : ""}. This never changes the verdict.`, "");
    const d = a.deltas;
    if (d && d.sameMeasured) {
      const rc = d.reclassified || [];
      L.push(`Previous deltas (node + field): **the same measured file as last round** — nothing about the build changed, so nothing is fixed, new or lost; ${d.unchanged} still open` +
        `${rc.length ? `, ${rc.length} reclassified by the compare (or the expectation): ${rc.filter((x) => x.change === "gone").length} no longer a delta, ${rc.filter((x) => x.change === "new").length} newly a delta` : ""}.`, "");
      if (rc.length) {
        L.push(`## Reclassified (${rc.length})`, "", "*Same measured file — the compare changed, not the build.*", "", "| Node | Field | Change | Was |", "|---|---|---|---|");
        for (const x of rc.slice(0, 40)) L.push(`| \`${x.nodeId}\` | ${x.field} | ${x.change === "gone" ? "no longer a delta" : "newly a delta"} | ${x.change === "gone" ? fmt(x.was) : ""} |`);
        if (rc.length > 40) L.push(`| …and ${rc.length - 40} more | | | |`);
        L.push("");
      }
    } else if (d) {
      const nu = d.nowUnverifiable || [];
      L.push(`Previous deltas (node + field): ${d.fixed} fixed · ${d.unchanged} still open · ${d.new} new · ${d.lostCoverage.length ? `**${d.lostCoverage.length} lost coverage** (gone only because they were not measured this round)` : "0 lost coverage"}` +
        `${nu.length ? ` · ${nu.length} now unverifiable by method (measured, but the compare no longer reads it)` : ""}.`, "");
      if (nu.length) {
        L.push(`## Now unverifiable by method (${nu.length})`, "", "*A previous delta whose value was measured this round, but the compare now declines it — not lost coverage, not a fix.*", "", "| Node | Field | Was | Why |", "|---|---|---|---|");
        for (const x of nu.slice(0, 40)) L.push(`| \`${x.nodeId}\` | ${x.field} | ${fmt(x.was)} | ${x.why} |`);
        if (nu.length > 40) L.push(`| …and ${nu.length - 40} more | | | |`);
        L.push("");
      }
    }
    if (a.sameBuild === true && r.headline.includes("SAME BUILD SERVED")) L.push("**The same build was served as last round although the code changed** — a stale preview or dist? Rebuild before measuring a preview.", "");
    if (d && d.lostCoverage.length) {
      L.push(`## Lost coverage (${d.lostCoverage.length})`, "", "*A previous delta that is gone only because its node or value was not measured — not a fix.*", "", "| Node | Field | Was | Why |", "|---|---|---|---|");
      for (const x of d.lostCoverage.slice(0, 40)) L.push(`| \`${x.nodeId}\` | ${x.field} | ${fmt(x.was)} | ${x.why} |`);
      if (d.lostCoverage.length > 40) L.push(`| …and ${d.lostCoverage.length - 40} more | | | |`);
      L.push("");
    }
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
  const inShell = r.untaggedInstanceSetsInShell || [];
  if (inShell.length) {
    L.push(`## Instance sets with no evidence, inside the shared shell (${inShell.length})`, "", "*Built once for every screen (F-96): listed apart, not this screen's work. Not a failure on its own.*", "");
    for (const m of inShell.slice(0, 40)) L.push(`- ${m.setName} — ${m.instances} instance(s), e.g. \`${m.nodeIds[0]}\``);
    if (inShell.length > 40) L.push(`- …and ${inShell.length - 40} more`);
    L.push("");
  }
  const bad = r.interactions.filter((i) => i.result === "fail" || i.result === "not-probed");
  if (bad.length) {
    L.push(`## Designed interactions not confirmed (${bad.length})`, "");
    for (const i of bad) L.push(`- \`${i.nodeId}\` ${i.name || ""} — ${i.trigger} → ${i.action}${i.destinationId ? ` (${i.destinationId})` : ""}${i.source === "plan" ? " [plan]" : ""}: **${i.result}**${i.detail ? ` — ${i.detail}` : ""}`);
    L.push("");
  }
  // DT-29: a result filed under a node + trigger nothing designed — never graded, so it never helped the verdict
  const um = (r.probe && r.probe.unmatchedInteractionEvidence) || [];
  if (um.length) {
    L.push(`## Probe results that matched no designed interaction (${um.length})`, "", "*Copy nodeId and trigger verbatim from the expectation's interactions[]; these results were not graded.*", "");
    for (const u of um.slice(0, 40)) L.push(`- \`${u.nodeId}\` ${u.trigger}${u.hint ? ` — ${u.hint}` : ""}`);
    if (um.length > 40) L.push(`- …and ${um.length - 40} more`);
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
  if ((p.unknownKeys && p.unknownKeys.length) || (p.unknownTopLevelKeys && p.unknownTopLevelKeys.length) || p.duplicateNodeIds || p.interactionEvidenceOnHiddenLayers || p.measuredIdsOnHiddenLayers || p.measuredIdsNotInExpectation || p.foreignTags || (p.inputNotes && p.inputNotes.length)) {
    L.push("## About the probe's input", "");
    for (const k of p.unknownKeys || []) L.push(`- key \`${k.key}\` (${k.count}×) is not read by verify-screen${k.canonical ? ` — the canonical key is \`${k.canonical}\`` : ""}`);
    for (const k of p.unknownTopLevelKeys || []) L.push(`- top-level key \`${k.key}\` is not read by verify-screen${k.canonical ? ` — the canonical key is \`${k.canonical}\`` : ""}`);
    if (p.duplicateNodeIds) L.push(`- ${p.duplicateNodeIds} duplicate node id(s) in nodes[] — the first measurement of each id was used`);
    if (p.measuredIdsOnHiddenLayers) L.push(`- ${p.measuredIdsOnHiddenLayers} measurement(s) are for hidden layers and were ignored`);
    for (const n of p.inputNotes || []) L.push(`- ${n}`);
    if (p.measuredIdsNotInExpectation) L.push(`- ${p.measuredIdsNotInExpectation} measured node id(s) are not in the expectation (e.g. ${(p.measuredIdsNotInExpectationSample || []).map((id) => `\`${id}\``).join(", ")}) — measured against another screen or an older expectation?`);
    if (p.interactionEvidenceOnHiddenLayers) L.push(`- ${p.interactionEvidenceOnHiddenLayers} interaction result(s) are for hidden layers and were ignored — a hidden layer cannot be driven`);
    const ft = p.foreignTags;
    if (ft) L.push(`- ${ft.total} tag(s)/id(s) on the page name no node of this expectation (informational): ${ft.prefixDrift} prefix drift (an expected node's \`;\` path under another instance id — a stale or other screen's id table?), ${ft.alias} another screen's id for one of these nodes (alias), ${ft.unknown} unknown${ft.sample.length ? ` — e.g. ${ft.sample.map((id) => `\`${id}\``).join(", ")}` : ""}`);
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

/** How a plan was chosen for a frame: "flag" = --plan, "only" = the one plan that describes it, "files" = the one
 *  of several that lists files[] (the plan the build is tied to), "recorded" = --compare's: the plan file the expectation
 *  merged interactions from (planInteractions.plan), when another plan (or none) is found now — review-2 M-b. */
type PlanChoice = "flag" | "only" | "files" | "recorded";
export interface ChosenPlan { file: string; plan: Plan; choice?: PlanChoice }
/** Review M3: ONE plan-selection rule for --expect and --compare (they must pick the same plan, or the plan's
 *  interactions[] hash can never agree and the run stays incomplete). --plan; else the one plan in design/plan/ that
 *  describes this frame; else, among several, the one that lists files[]; else none (`all` names the candidates). */
/** Two spellings of one plan file (`./design/plan/x.json`, an absolute path) are the same plan. */
function samePlanFile(a: string, b: string): boolean { return path.resolve(a) === path.resolve(b); }
function choosePlan(flagged: { file: string; plan: Plan } | undefined, frameId: string | undefined, stem: string): { hit?: ChosenPlan; all: Array<{ file: string; plan: Plan }> } {
  if (flagged) return { hit: { ...flagged, choice: "flag" }, all: [flagged] };
  const all = plansFor(frameId, stem);
  if (all.length === 1 && all[0]) return { hit: { ...all[0], choice: "only" }, all };
  const withFiles = all.filter((h) => h.plan.files);
  if (withFiles.length === 1 && withFiles[0]) return { hit: { ...withFiles[0], choice: "files" }, all };
  return { all };
}

/** --accept's selection: the report deltas one waiver row each is written for, or why there are none. */
function selectForAccept(rep: VerifyReport, sel: { node?: string | undefined; field?: string | undefined; group?: string | undefined }): { deltas: VerifyDelta[] } | { error: string } {
  // L-c: a report whose run failed its integrity checks graded numbers nothing ties to this design and run — a
  // waiver written from it would bind to values that may never have been rendered (D26)
  // L-1: the integrity reasons compare recorded (report.integrity); an older report has only why[] — match its wording
  const integrity = Array.isArray(rep.integrity) ? rep.integrity : (rep.why || []).filter(isIntegrityReason);
  if (integrity.length) return { error: `the report's run is unverified (${integrity.join("; ")}) — nothing in it can be accepted; re-measure and --compare, then accept against the new report` };
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
function main(argv: string[]): number | Promise<number> {
  const sha = (file: string): string => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const USAGE =
    "usage:\n" +
    `  ${scriptCmd("verify-screen")} --expect <screen.json>... --out design/verify/<Screen> [--force] [--plan <plan.json>]\n` +
    "      writes <Screen>.expected.json — the design's own numbers, as data, for VISIBLE layers only.\n" +
    "      The plan for this frame (--plan, else the one plan in design/plan/ that describes it) adds its interactions[]\n" +
    "      ({nodeId, trigger, expect: dialog|url|selector:<css>, destinationId?}) the export cannot carry; a row that cannot\n" +
    "      be graded is dropped with why. Their hash binds the expectation: change them → re-run --expect.\n" +
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
    "      measured prints COVERAGE FELL, a different probe prints 'probe changed'. Neither changes the verdict.\n" +    "      Integrity first: a measured file naming no or another expectation, or a run status not finished / naming another\n" +
    "      measured file, makes the verdict 'incomplete' even with high mismatches (the numbers belong to an unverified run).\n" +
    "      The plan for this frame (--plan <plan.json>; else the plan file --expect merged interactions from, while it exists;\n" +
    "      else design/plan/ as at --expect) supplies waivers[] and descopes[]: an accepted\n" +
    "      delta stays listed but leaves the counts; with nothing else open the verdict is 'pass-with-deviations' (exit 0).\n" +
    `  ${scriptCmd("verify-screen")} --accept <Screen>.report.json (--node <id> (--field <label> | --all-fields) | --group <gid>) --reason "<why>" --by "<who>" [--plan <plan.json>]\n` +
    "      writes one plan waiver per node + field from the report's delta(s), bound to the export content, the designed\n" +
    "      and the built value (any change reopens it). Only on the owner's explicit word. Refuses a node with no delta:\n" +
    "      absent components, failed interactions and unmeasured nodes are never waivable. Re-run --compare to apply.\n" +
    `  ${scriptCmd("verify-screen")} --status <Screen> --phase <${STATUS_PHASES.join("|")}> [--run <id> | --new-run] [--detail "…"] [--by agent|orchestrator] [--dir design/verify] [--publish <stageDir>]\n` +
    "      writes the run's LIVE status (status v2: runId, rev, machine time) atomically in the run cache —\n" +
    "      node_modules/.cache/designtwin-verify/<Screen>.status.json (the project's: the nearest package.json at or above <dir>, or the\n" +
    "      workspace root its dependencies are hoisted to, never past .git; the OS temp dir, not shared between sandboxed and unsandboxed\n" +
    "      commands, with no package.json or Yarn PnP) — <dir> resolves against the cwd — outside every dev-server\n" +
    "      watch, so a heartbeat never reloads the page being measured — and prints `run <id> rev <n>` (stdout), the live file and the run's\n" +
    "      stage dir (stderr). Without --run it continues only a run that has not ended (else exit 2). `done` checks first — refuses (exit 1)\n" +
    "      a missing measured file (the staged one when --publish holds it), one measured against another expectation, in another run, or\n" +
    "      not the one the probe recorded in this run — then publishes, records the sha256 of <Screen>.expected/.measured.json (and\n" +
    "      .evidence.json when this run published it), and writes the final status into <dir>/<Screen>.status.json. --publish copies every\n" +
    "      file of a staging directory into <dir> (tmp file in <dir>, then rename) — stage in the run cache while any page of the app is open.\n" +
    `  ${scriptCmd("verify-screen")} --wait <Screen> --run <id> [--timeout <s>=1200] [--stall <s>=300] [--interval <s>=2] [--dir design/verify]\n` +
    "      waits (on the live status, else <dir>/<Screen>.status.json) until run <id> is done and <Screen>.measured.json is the file it\n" +
    "      names, then prints the --compare command (exit 0; with --interactions only for evidence this run published);\n" +
    "      exit 1 when the run failed or is blocked (prints why), 5 on timeout or when the status did not change for --stall seconds,\n" +
    "      6 when the run cache exists but cannot be read.\n" +
    "exit (--status): 0 wrote · 1 refused · 2 usage · 6 the run cache is not writable (sandbox write scope? — run from the project root).";
  if (argv.includes("--help") || argv.includes("-h") || !argv.length) { console.log(USAGE); return argv.length ? 0 : 2; }

  const OPTIONS = {
    out: { type: "string" }, interactions: { type: "string" }, against: { type: "string" }, force: { type: "boolean" }, expect: { type: "boolean" }, compare: { type: "boolean" },
    accept: { type: "boolean" }, node: { type: "string" }, field: { type: "string" }, group: { type: "string" }, reason: { type: "string" }, by: { type: "string" }, plan: { type: "string" }, "all-fields": { type: "boolean" },
    status: { type: "string" }, wait: { type: "string" }, phase: { type: "string" }, run: { type: "string" }, "new-run": { type: "boolean" }, detail: { type: "string" },
    dir: { type: "string" }, publish: { type: "string" }, timeout: { type: "string" }, stall: { type: "string" }, interval: { type: "string" },
    help: { type: "boolean", short: "h" },
  } as const;
  const { values: flags, positionals: files } = cliParse("verify-screen", argv, OPTIONS, USAGE, 2, (args) => parseArgs({ args, options: OPTIONS, allowPositionals: true }));
  // F-72 (D25): the run's status file and the wait on it — the tools write machine time, rev and shas, never the agent
  const runFlags = ["phase", "run", "new-run", "detail", "dir", "publish", "timeout", "stall", "interval"] as const;
  if (flags.status !== undefined || flags.wait !== undefined) {
    if (flags.status !== undefined && flags.wait !== undefined) { console.error("pass --status or --wait, not both\n" + USAGE); return 2; }
    const other = (["expect", "compare", "accept", "out", "interactions", "against", "force", "node", "field", "group", "reason", "plan", "all-fields"] as const).filter((k) => flags[k] !== undefined);
    if (other.length || files.length) { console.error(`--${flags.status !== undefined ? "status" : "wait"} takes none of ${[...other.map((k) => `--${k}`), ...files].join(", ")}\n` + USAGE); return 2; }
    if (flags.wait !== undefined) {
      const bad = (["phase", "new-run", "detail", "publish", "by"] as const).filter((k) => flags[k] !== undefined);
      if (bad.length) { console.error(`--wait takes none of ${bad.map((k) => `--${k}`).join(", ")}\n` + USAGE); return 2; }
      return waitMain(flags.wait, flags, USAGE);
    }
    const bad = (["timeout", "stall", "interval"] as const).filter((k) => flags[k] !== undefined);
    if (bad.length) { console.error(`--status takes none of ${bad.map((k) => `--${k}`).join(", ")}\n` + USAGE); return 2; }
    return statusMain(flags.status, flags, USAGE);
  }
  for (const k of runFlags) if (flags[k] !== undefined) { console.error(`--${k} only applies to --status / --wait\n` + USAGE); return 2; }
  const { out, interactions: interactionsFile, against: againstFile, plan: planFlag } = flags;
  const force = !!flags.force, doExpect = !!flags.expect, doCompare = !!flags.compare, doAccept = !!flags.accept;
  if ([doExpect, doCompare, doAccept].filter(Boolean).length !== 1) { console.error("pass exactly one of --expect / --compare / --accept\n" + USAGE); return 2; }
  for (const k of ["node", "field", "group", "reason", "by", "all-fields"] as const) if (flags[k] !== undefined && !doAccept) { console.error(`--${k} only applies to --accept\n` + USAGE); return 2; }
  if (doAccept) return acceptMain(files, flags, USAGE);
  if (interactionsFile !== undefined && !doCompare) { console.error("--interactions only applies to --compare\n" + USAGE); return 2; }
  if (againstFile !== undefined && !doCompare) { console.error("--against only applies to --compare\n" + USAGE); return 2; }

  const write = (base: string | undefined, obj: unknown, md?: string): void => {
    if (!base) { process.stdout.write(JSON.stringify(obj, null, 2) + "\n"); return; }
    // F-72: atomic (tmp beside the target, then rename) — a reader never sees half a report or expectation
    writeFileAtomic(base + (doExpect ? ".expected.json" : ".report.json"), JSON.stringify(obj, null, 2) + "\n");
    if (md) writeFileAtomic(base + ".report.md", md);
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
    // (rows only: the root index's own top-level sourceFile names its last walk, not the page-dir rows merged in — review M2)
    // D32: sibling screen exports (aliases for a shared shell's nodes) — read lazily, only the same file's rows
    const exportRoot = path.join("design", "export");
    const readSibling = (file: string): ScreenDoc | null => readJsonOrNull(path.join(exportRoot, file), isScreenDoc);
    const outBase0 = out || path.join("design", "verify", path.basename(firstFile, ".json"));
    // F-95 (D40(7)): the plan's interactions[] — the plan --compare will pick too (choosePlan, review M3)
    let flagged: { file: string; plan: Plan } | undefined;
    if (planFlag !== undefined) {
      const r = readJson(planFlag, isPlan);
      if (!("doc" in r)) { console.error(`--plan '${planFlag}' ${r.error}`); return 2; }
      flagged = { file: planFlag.split(path.sep).join("/"), plan: r.doc };
    }
    const firstRoot = docs.map((d) => screenRoots(d.doc)[0]).find((r) => r !== undefined);
    const chosen = choosePlan(flagged, firstRoot && firstRoot.id, path.basename(outBase0));
    const planForExpect = chosen.hit;
    if (chosen.all.length > 1 && chosen.all.some((h) => h.plan.interactions !== undefined)) {
      console.error(planForExpect ? `note  ${chosen.all.length} plans in design/plan/ describe this frame (${chosen.all.map((h) => h.file).join(", ")}) — using ${planForExpect.file}, the only one listing files[] (--compare picks the same); pass --plan <plan.json> to choose another`
        : `note  ${chosen.all.length} plans in design/plan/ describe this frame (${chosen.all.map((h) => h.file).join(", ")}) — no plan interactions merged; pass --plan <plan.json> (here and at --compare)`);
    }
    // 12c: the reference PNG (pointer relative to design/export/) and the document's colour profile stamp
    const readReference = (pointer: string): Uint8Array | null => {
      const file = resolveInside(exportRoot, pointer);
      if (file === null) return null; // (referenceImageFor refuses such a pointer before reading)
      try { return fs.readFileSync(file); } catch { return null; }
    };
    const ds = readJsonOrNull(path.join(exportRoot, "design-system.json"), isJsonObject);
    const colorProfile = ds && typeof ds.colorProfile === "string" ? ds.colorProfile : null;
    const expOpts: ExpectOptions = { ...("doc" in idx || layers.length ? { index: { layers }, readSibling } : {}), ...(planForExpect ? { plan: planForExpect } : {}), readReference, colorProfile };
    const exp = buildExpectation(docs, Object.keys(expOpts).length ? expOpts : null);
    const pi = exp.planInteractions;
    if (pi) {
      console.error(`${pi.plan}: ${pi.merged} plan interaction(s) merged${pi.dropped.length ? `, ${pi.dropped.length} dropped` : ""} (plan interactions sha256 ${pi.sha256.slice(0, 12)}…)`);
      for (const d of pi.dropped) console.error(`warn  plan interaction ${d.nodeId} dropped: ${d.why}`);
    }
    // P3 #152: `--expect` run once by base name and once by a nickname for the SAME screen wrote
    // two byte-identical files (`positions___7314_87192.expected.json` and `JobRoles.expected.json`)
    // because nothing tied the output name to the screen's own identity. Defaulting to the FIRST
    // input file's own basename — already `<LayerName>__<node-id>` by construction (write-out.js) —
    // means two runs against the same export file always land on the same name, whatever string the
    // caller typed on the command line.
    const outBase = outBase0;
    // Findings 153/181: re-running --expect replaced the file in place and left a measurement and a
    // report from the OLD expectation beside it, undated. The file itself stays byte-deterministic
    // (finding 154) — the notice goes to stderr, and every report records the sha it was computed on.
    const target = outBase + ".expected.json";
    // Finding 315 / P3 c6: an explicit --out under a DIFFERENT name than the one already indexing
    // this node (e.g. --out design/verify/JobRoles when design/verify/positions___7314_87192 already
    // covers node 7314:87192) is refused rather than silently creating a second artefact set.
    const dup = findExistingExpectedFor(path.dirname(target) || ".", exp.frame && exp.frame.nodeId, target);
    if (dup && !force) {
      // DT-34: the existing set is under another name (a nickname). Say what it is, which name is canonical
      // (the screen file's basename, `<Layer>__<id>`), and the way out: retire the old expectation, re-run.
      const oldBase = dup.slice(0, -".expected.json".length);
      const dir = path.dirname(dup), stemOld = path.basename(oldBase);
      const oldFiles = fs.readdirSync(dir).filter((f) => f.startsWith(stemOld + ".") || f.startsWith(stemOld + "-")).sort().map((f) => path.join(dir, f));
      const canonical = path.join(path.dirname(target), path.basename(firstFile, ".json"));
      if (stemOld === path.basename(canonical)) {
        console.error(
          `error  node ${exp.frame.nodeId} already has an expectation at ${dup} — refusing to also write ${target} ` +
            `(one screen, one artefact set). That is the canonical name: drop --out (the default is ${shellArg(canonical)}), or pass --force to write a second set anyway.`
        );
        return 1;
      }
      console.error(
        `error  node ${exp.frame.nodeId} already has an expectation at ${dup} — refusing to also write ${target} ` +
          "(one screen, one artefact set).\n" +
          `       existing set under '${stemOld}' (${oldFiles.length} file(s)): ${oldFiles.join(", ")}\n` +
          `       the canonical name for this screen is '${path.basename(canonical)}' (<Layer>__<id> — the screen file's own basename), not '${stemOld}'.\n` +
          `       To move it to the canonical name: mv ${shellArg(dup)} ${shellArg(dup + ".retired")}, then re-run this command` +
          (path.resolve(target) === path.resolve(canonical + ".expected.json") ? "" : ` with --out ${shellArg(canonical)}`) +
          ", then probe + --compare as usual — the old measured/report/PNGs stay as history under the old name.\n" +
          `       Or keep the old name: --out ${shellArg(oldBase)}. (--force writes a second, parallel set — not recommended.)`
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
    const ri = exp.referenceImage;
    if (ri) console.error(ri.usable ? `reference ${ri.path} ${ri.png.w}×${ri.png.h} at ${ri.scale}x (${ri.from})${ri.offset.x || ri.offset.y ? `, offset ${ri.offset.x},${ri.offset.y}` : ""}${ri.colorProfile ? ` — ${ri.colorProfile}: colours are compared without colour management` : ""}`
      : `note  no visual diff for this screen: ${ri.why}`);
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
  let planHit: ChosenPlan | undefined;
  let recordedPlanGone: string | undefined;
  const compareNotes: string[] = [];
  let flagged: { file: string; plan: Plan } | undefined;
  if (planFlag !== undefined) {
    const r = readJson(planFlag, isPlan);
    if (!("doc" in r)) { console.error(`--plan '${planFlag}' ${r.error}`); return 2; }
    flagged = { file: planFlag.split(path.sep).join("/"), plan: r.doc };
  }
  {
    const frameId = expectation.frame && expectation.frame.nodeId;
    const stem = path.basename(expFile, ".json").replace(/\.expected$/, "");
    // review M3: the same rule --expect used (choosePlan) — never a second way of picking the plan
    const chosen = choosePlan(flagged, frameId, stem);
    const all = chosen.all;
    const hits = all.filter((h) => h.plan.files);
    const onlyHit = hits.length === 1 ? hits[0] : undefined;
    planHit = chosen.hit;
    // review-2 M-b: the plan --expect merged interactions from (planInteractions.plan) wins over another found now —
    // --expect may have been given --plan, or design/plan/ changed since; without --plan, check the rows it merged
    const recPi = expectation.planInteractions && isJsonObject(expectation.planInteractions) && typeof expectation.planInteractions.plan === "string" ? expectation.planInteractions.plan : undefined;
    if (recPi !== undefined && !(planHit && samePlanFile(planHit.file, recPi))) {
      const r = readJson(recPi, isPlan);
      if (!("doc" in r)) recordedPlanGone = r.missing ? "no longer exists" : `is not a readable plan now (${r.error})`;
      else if (!flagged) {
        const foundNow = planHit ? ` instead of ${planHit.file}, the plan found in design/plan/ now` : all.length ? `; ${all.length} plans in design/plan/ describe this frame now (${all.map((h) => h.file).join(", ")})` : "; no plan in design/plan/ describes this frame";
        compareNotes.push(`using ${recPi} (the plan --expect merged interactions from)${foundNow} — its interactions[], waivers, descopes, anchors and navigate apply; pass --plan <plan.json> to use another`);
        console.error(`note  ${compareNotes[compareNotes.length - 1]}`);
        planHit = { file: recPi, plan: r.doc, choice: "recorded" };
      }
    }
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
  // F-72/D26: the run status of the measured file (<dir>/<S>.measured.json → the live status of <dir>/<S>, else the
  // published <dir>/<S>.status.json) — the same resolver --status, --wait and verify-probe --run use (H1)
  // — and, for a measured file naming its run, else the status of the expectation's dir the probe wrote it to
  // (verify-probe keys the run by the expectation's dir, so a measured file it wrote to a stage dir finds its run)
  const measuredBase = /\.measured\.json$/.test(measuredFile) ? measuredFile.replace(/\.measured\.json$/, "") : null;
  const probeBase = measuredBase !== null && typeof measured.runId === "string" && measured.runId ? path.join(path.dirname(expFile), path.basename(measuredBase)) : null;
  const found = measuredBase === null ? null : readStatusAt(measuredBase) ?? (probeBase !== null && path.resolve(probeBase) !== path.resolve(measuredBase) ? readStatusAt(probeBase) : null);
  // (status: null = looked and found none — a measured file naming its run then has nothing recording it, M-1)
  const statusOpt = found ? { status: { file: [measuredBase, probeBase].some((b) => b !== null && found.file === statusFile(b)) ? path.basename(found.file) : `${path.basename(found.file)} (live, ${found.file})`, status: found.status } }
    : measuredBase !== null ? { status: null } : {};
  // 12c: the diff PNG the probe recorded — as recorded, else the same name beside the measured file (a published stage)
  const vd: unknown = measured.visual && measured.visual.ran ? measured.visual.diff : undefined;
  let visualDiff: { path: string; exists: boolean } | null = null;
  if (typeof vd === "string" && vd) {
    const beside = path.join(path.dirname(measuredFile), path.basename(vd));
    visualDiff = fs.existsSync(vd) ? { path: vd, exists: true } : fs.existsSync(beside) ? { path: beside.split(path.sep).join("/"), exists: true } : { path: vd, exists: false };
  }
  const rep = compare(expectation, measured, { ...statusOpt, ...(readable.dropped.includes("behaviour") ? { behaviourMalformed: true } : {}), ...(readable.dropped.includes("visual") ? { visualMalformed: true } : {}), ...(visualDiff ? { visualDiff } : {}), ...(readable.notes.length || compareNotes.length ? { inputNotes: [...readable.notes, ...compareNotes] } : {}), ...ifDefined("recordedPlanGone", recordedPlanGone), ...ifDefined("interactions", extra), ...ifDefined("components", extraComponents), expectationSha256: sha(expFile), measuredSha256: sha(measuredFile), artifactCheck, ...ifDefined("code", code), ...ifDefined("against", against), ...planInputs, ...(planHit ? { plan: planHit } : {}) });
  const md = reportToMarkdown(rep);
  write(compareBase, rep, md);
  console.error(rep.headline);
  console.error(probeLine(rep));
  console.error(rep.behaviour.headline);
  console.error(rep.visual.headline);
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

if (import.meta.main ?? isMainFallback(import.meta.url)) {
  const code = main(process.argv.slice(2));
  if (typeof code === "number") process.exitCode = code;
  else code.then((c) => { process.exitCode = c; }, (e: unknown) => { console.error(`verify-screen: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; });
}
