// verify-compare.ts — verify-screen --compare: compare() diffs a probe's measurements against the expectation, field by
// field with an explicit tolerance per field, grades the designed interactions on their evidence, applies the plan's
// waivers/descopes/anchors, and computes the verdict and the report (schema @2) — never asserted, always computed. Also
// the report's informational blocks copied from the measured file (visual diff, behaviour/a11y). No browser and no
// file writes; the CLI (reading the inputs, writing the report) is verify-screen.ts.
import fs from "node:fs";
import { sha256Hex } from "../bridge/src/hash.ts";
import {
  isBuildIdentity, isMeasuredBehaviour, isMeasuredVisual, isVisualRegion, isPageOverflow, isPlanDescope, isPlanWaiver, isProbeIdentity, isProbeReach,
} from "./doc-guards.ts";
import { planInteractionsSha256 } from "./plan-waivers.ts";
import { parseSteps, stepsSha256 } from "./probe-steps.ts";
import { MEASURED_PHASES, TERMINAL_PHASES } from "./verify-run.ts";
import type { VerifyStatusV2 } from "./verify-run.ts";
import { shellArg } from "./cli-args.ts";
import { isJsonObject } from "./types.ts";
import { CANONICAL_MATCHED_BY, idSuffix, normText } from "./probe-match.ts";
import type { MatchedBy } from "./probe-match.ts";
import type {
  ArtifactCheck, BehaviourCheck, BehaviourStatus, BuildIdentity, ProbeIdentity, BehaviourSummary, CodeInputs, DeltaSeverity, InteractionEvidence, JsonValue, MeasuredComponent,
  MeasuredNode, MeasuredStyles, InferredRow, PageOverflowCoverage, PaintedBy, PlanAnchor, PlanDescope, PlanWaiver, ProbeFrame, ReportBehaviour,
  ReportVisual, VerifyDelta, VerifyCoverageV2, VerifyInteraction, VerifyInteractionResult, VerifyMeasured, VerifyAgainst, VerifyReport, VerifyReportV2,
  VerifyRootFrame, VerifySpec, VerifyVerdict,
} from "./types.ts";
import { ifDefined } from "../bridge/src/json-util.ts";
import { getOrInit } from "./map-util.ts";
import {
  EXPECTATION_SCHEMA, FIELDS, PAD_SIDES, REPORT_SCHEMA, TEXT_BOX_HEIGHT, TOLERANCE, cssPx, fmt, fourSides, normColor, num, pctText, r2, samePlanFile,
} from "./verify-shared.ts";
import type { ChosenPlan, Expectation, Field } from "./verify-shared.ts";

// ---------------------------------------------------------------- the comparison
//
// The CANONICAL measured keys. A probe that names a field differently is never silently skipped:
// a key in FIELDS that is present in zero measurements is printed in the headline, and keys this
// file does not read are listed (a probe that wrote `radius` where the comparer reads
// `borderRadius` would leave a whole category of values passed untested).
// Two sets: a measured node's OWN keys (beside `styles`) and the keys INSIDE `styles` — a `styles.states`
// block is a misplaced key (unknown, with a hint), never read; the flat form (no `styles`) carries both on the node.
const KNOWN_NODE_KEYS = new Set([
  "nodeId", "styles", "states", "matchedBy", "note", "notes", "selector", "selectorCount", "unmeasured", "textFrom", "textFromMixed", "fillSource",
]);
const KNOWN_STYLE_KEYS = new Set([
  "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "color", "backgroundColor", "fill", "borderColor",
  "borderWidth", "borderRadius", "gap", "gapVisual", "width", "height", "x", "y", "opacity", "padding", "text",
  "placeholderText", "placeholderColor", "tag", "textBox", "display", "transform", "rotate", "visible",
  // where the probe read borderWidth/borderColor (a real border, or a ring drawn by box-shadow/outline)
  "strokeFrom", "strokeAlign",
  // a TEXT's computed text-transform; who paints a transparent element (optional keys)
  "textTransform", "paintedBy",
  // free text, never read for a judgement — tolerated on either level
  "note", "notes",
]);
const KNOWN_MEASURED_KEYS = new Set([...KNOWN_NODE_KEYS, ...KNOWN_STYLE_KEYS]);
// Suggestions only — the key is NEVER silently accepted (design note: a wrong key must be loud).
const KEY_HINTS: Record<string, string> = { radius: "borderRadius", borderTopLeftRadius: "borderRadius", background: "backgroundColor", bg: "backgroundColor", w: "width", h: "height", svgFill: "fill", placeholder: "placeholderText", rowGap: "gapVisual", columnGap: "gap",
  // a node-level key written INSIDE styles is not read there (a styles.fillSource "img" would not exempt the fill)
  ...Object.fromEntries([...KNOWN_NODE_KEYS].filter((k) => k !== "nodeId" && k !== "styles" && k !== "note" && k !== "notes").map((k) => [k, `nodes[].${k} (beside styles, not inside)`])) };

// Which variable a delta is about, chosen by the field (not `Object.values(spec.tokens)[0]`, which
// would make a background delta read `token: "Space 4"`).
const TOKEN_KEYS: Record<string, string[]> = {
  color: ["fills", "color"], backgroundColor: ["fills"], fill: ["fills"], placeholderColor: ["fills"],
  borderColor: ["strokes"], borderWidth: ["strokeWeight", "strokeTopWeight"],
  fontSize: ["fontSize"], fontWeight: ["fontWeight"], fontFamily: ["fontFamily"], lineHeight: ["lineHeight"], letterSpacing: ["letterSpacing"],
  gap: ["itemSpacing", "gap"], width: ["width", "minWidth"], height: ["height", "minHeight"], opacity: ["opacity"],
  padding: ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"],
  "radius.tl": ["topLeftRadius"], "radius.tr": ["topRightRadius"], "radius.br": ["bottomRightRadius"], "radius.bl": ["bottomLeftRadius"],
  borderRadius: ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius", "cornerRadius"],
};
export function tokenFor(spec: VerifySpec | null | undefined, key: string): string | undefined {
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
  // mismatch. A RAW null from the probe never gets here: compare() lists it under fieldsNotMeasured first.
  if (nw == null || ng == null) return null;
  if (f.tol == null) return nw === ng ? null : { want: nw, got: ng, delta: null };
  const a = Number(nw), b = Number(ng);
  if (Number.isNaN(a) || Number.isNaN(b)) return nw === ng ? null : { want: nw, got: ng, delta: null };
  const delta = Math.abs(a - b);
  return delta <= f.tol ? null : { want: a, got: b, delta: Number(delta.toFixed(3)) };
}

function comparePadding(want: unknown, got: readonly number[], skip?: readonly string[]): Bad | null {
  // (compare() hands over four px numbers — a null or unreadable side is listed as not measured first)
  if (!Array.isArray(want)) return null;
  const w: number[] = want.map(Number);
  if (w.some(Number.isNaN)) return null;
  // a side the design cannot show (expectation paddingSkip) is not compared
  const worst = Math.max(0, ...w.map((v, i) => (skip && skip.includes(PAD_SIDES[i] ?? "") ? 0 : Math.abs(v - (got[i] ?? 0)))));
  return worst <= TOLERANCE.padding ? null : { want: w, got: [...got], delta: Number(worst.toFixed(3)) };
}

// A measured radius as four corners [tl,tr,br,bl]: a number, a list of numbers or px strings
// (["8px","8px","8px","8px"] — each item is parsed, not passed through Number()), or a CSS shorthand
// string. A percentage or an elliptical "8px / 4px" is not a px radius here (the shipped probe resolves %).
export function radiusCorners(v: unknown): [number, number, number, number] | null {
  return v == null ? null : fourSides(v);
}
// CSS clamps a radius at half the shorter side, and so does Figma: `radius: 500` on a 36px box and
// `rounded-full` (33554400px) are both a circle. Compare the radius each side can ACTUALLY
// draw, not the number either side stored.
const clampRadius = (r: number, w: unknown, h: unknown): number => (num(w) && num(h) && w > 0 && h > 0 ? Math.min(r, Math.min(w, h) / 2) : r);

const TABLE_TAGS = new Set(["table", "thead", "tbody", "tfoot", "tr"]);
// a table row or row group draws no border-radius (CSS Backgrounds 3: radius applies to table and
// table-cell boxes only) — getComputedStyle still returns the specified value, so neither direction is evidence.
const ROW_TAGS = new Set(["tr", "thead", "tbody", "tfoot"]);
const ROW_RADIUS_WHY = "a table row/row-group does not draw border-radius — report the corner cells' radii under this id, or tag the cells";
// a FRAME/INSTANCE id on an inline element: its box is the union of its text's line boxes, not a frame's
const INLINE_BOX_FIELDS = new Set<string>(["width", "height", "x", "y", "borderRadius"]);
const inlineWhy = (tag: string): string => `the id sits on an inline <${tag || "element"}>, whose box is its text's — tag the element that owns the box`;
// Chromium FLOORS a computed border width to whole px, with a 1px minimum for any non-zero
// width (0.5 → 1, 1.5 → 1, 2.7 → 2, at DPR 1/2/3). A design's stroke is compared as the border CSS can draw. A ring
// (box-shadow spread, outline) is not snapped — it is compared with the raw design width.
const cssBorderWidth = (d: number): number => (d <= 0 ? 0 : d < 1 ? 1 : Math.floor(d));
// the probe's paintedBy block (a hand-written probe's free-form value is ignored)
const isPaintedBy = (x: unknown): x is PaintedBy => isJsonObject(x) && typeof x.backgroundColor === "string" && (x.via === "ancestor" || x.via === "child")
  && typeof x.tag === "string" && typeof x.depth === "number" && (x.dt === undefined || typeof x.dt === "string");
// ---- text as it RENDERS. Figma keeps the typed string and applies font.case when drawing; CSS keeps the DOM
// string and applies text-transform when drawing (textContent never carries it).
/** Figma's TextCase on a stored string. TITLE = "the first character of each word is upper case and all other characters
 *  are in lower case" (Plugin API, TextCase) — words split on white space. */
function applyFigmaCase(t: string, c: VerifySpec["textCase"]): string {
  if (c === "upper") return t.toUpperCase();
  if (c === "lower") return t.toLowerCase();
  if (c === "title") return t.toLowerCase().replace(/(^|\s)(\S)/gu, (_m, sp: string, ch: string) => sp + ch.toUpperCase());
  return t;
}
/** CSS text-transform on a DOM string, or null for a value this does not model (full-width, math-auto…). `capitalize`
 *  upper-cases the first letter or digit of each word (a hyphen starts a word, an apostrophe does not, leading
 *  punctuation is skipped) and KEEPS the rest (MDN: "hello wORLD-foo it's 3d" → "Hello WORLD-Foo It's 3d"). */
function applyCssTransform(t: string, tt: string): string | null {
  const v = tt.trim().toLowerCase();
  if (v === "none") return t;
  if (v === "uppercase") return t.toUpperCase();
  if (v === "lowercase") return t.toLowerCase();
  if (v === "capitalize") return t.replace(/(^|[\s\-\u2010-\u2015])([^\p{L}\p{N}\s\-]*)([\p{L}\p{N}])/gu, (_m, b: string, punct: string, ch: string) => b + punct + ch.toUpperCase());
  return null;
}
/** The two strings a TEXT compare judges — ONE rule for the copy compare and the width gate, so they agree.
 *  want = the design as rendered (stored text + textCase); have = the build as rendered (its text + textTransform). A
 *  build whose transform is unknown (a hand-written probe reports none) passes with EITHER the stored or the rendered
 *  design string — it may have typed either one. `norm` is the caller's own normalisation. */
function renderedText(stored: string, textCase: VerifySpec["textCase"], built: string, transform: unknown, norm: (t: string) => string): { want: string; have: string; same: boolean; transform: string | null } {
  const designed = applyFigmaCase(stored, textCase);
  const tt = typeof transform === "string" ? transform : null;
  const shown = tt !== null ? applyCssTransform(built, tt) : null;
  if (shown !== null) return { want: designed, have: shown, same: norm(designed) === norm(shown), transform: tt };
  const want = norm(built) === norm(stored) ? stored : designed;
  return { want, have: built, same: norm(want) === norm(built), transform: null };
}
// A TEXT node's id on an element that is NOT the text's own box (a <th> with padding, a <button>,
// a <label>) — its width/height/x describe the container, not the text (a real pull showed `height 24 → 56`
// on a header that is typographically exact).
const CONTAINER_TAGS = new Set(["th", "td", "tr", "button", "label", "li", "a", "section", "article", "header", "footer", "nav", "table", "input"]);
// The mirror image: a FRAME/INSTANCE id spread (by a `...rest` prop) onto a LEAF element
// inside the one that implements it — an <input> inside the <label> that draws the field. The leaf's
// box, fill, border and padding are not the container's, so they are not graded as such.
const LEAF_TAGS = new Set(["input", "textarea", "select", "img", "svg", "path", "video", "canvas"]);
const CONTAINER_TYPES = new Set<string>(["FRAME", "INSTANCE", "COMPONENT", "GROUP", "SECTION"]);
// Elements whose paint is pixels: an <img src="icon.svg"> is an isolated image document, so no computed
// style on it carries the SVG's fill — `fill` on the <img> is the inherited default, black. Such a spec's
// fill is unverifiable by this method, never a mismatch and never "not measured".
const PIXEL_TAGS = new Set(["img", "picture", "canvas", "object", "embed"]);
// Lengths CSS cannot make negative: a negative one is a measuring artefact (a gap read across children
// that are not laid out in one line, rows in different columns), listed as not measured — never compared.
const NON_NEGATIVE = new Set<string>(["fontSize", "lineHeight", "borderWidth", "gap", "width", "height", "opacity"]);
const LEAF_FIELDS = new Set<string>(["width", "height", "x", "y", "backgroundColor", "borderColor", "borderWidth", "borderRadius", "gap"]);
const isContainer = (got: MeasuredStyles): boolean => !!((got.tag && CONTAINER_TAGS.has(String(got.tag).toLowerCase())) || (Array.isArray(got.padding) && got.padding.some((v) => (cssPx(v) ?? 0) > 0)));

const LIMITS = [
  "::before/::after content and any other pseudo-element are invisible to a computed-style probe; the export cannot say which layers a build draws that way, so they are compared only if the probe reports them under the node's id.",
  "::placeholder colour is compared only when the probe reports placeholderColor (getComputedStyle(el,'::placeholder') or the stylesheet rule); otherwise it is listed under `unverifiable`, never passed.",
  "A <table> with border-spacing (border-collapse: separate) also puts that spacing between its edge and the outer rows — above the first and below the last (CSS 2.1 §17.6.1): a container-height delta of twice the spacing is the table model, not a layout bug.",
  "A rotation applied with the CSS `rotate` property reads `transform: none` (Tailwind v4 `rotate-180`) — read `rotate` too before calling a rotation missing.",
  "An icon drawn by an <img> (or <canvas>, <object>) has no readable fill: the SVG inside is a separate document, so its fill is listed under `unverifiable` — compare the asset file instead.",
  "Numbers are read as px: a number or a px string (\"20px\"). A percentage, another unit or a keyword (other than letter-spacing: normal = 0) is listed as not measured; so is a value CSS cannot produce (a negative gap, padding or size).",
  "Positions are compared only where the export states one (absolute layers, render/ink boxes); auto-layout children are placed by their parent, whose position is compared.",
  "A TEXT node's height is not compared (neither a Range nor its element gives the line box Figma's text box has), and the width of text the design truncates is not either (a Range spans the unclipped string). A fixed- or fill-width text is compared at its ink width within 3px — an empirical bound (field runs: −0.6…+2.4px); heavy italics or overhanging glyphs may exceed it.",
  "A transparent element's background is compared through the element that paints it (paintedBy): its only same-box child, else its nearest painting ancestor that holds it. A sibling or an absolutely positioned overlay painting over it is not seen — when the ancestor's colour is the designed one the node may PASS although the overlay shows another; a transparent element whose own children paint all of it gets no painter (compared as transparent).",
  "Border widths are compared as CSS draws them: Chromium floors a computed border width to whole px, at least 1 (a 1.5px stroke is a 1px border). A ring (box-shadow spread, outline) is compared with the design's own width.",
  "Severity follows the match: a node matched by position or a non-canonical rule is at most low, by text-ordinal or another screen's id (tag-alias) at most medium; a matched element far from the design's size gets one 'match (size)' row and its other deltas are capped at low (cappedFrom keeps the original, cappedBy says which cap). An open capped delta blocks a plain pass (verdict incomplete, never fail on its own); a waiver on 'match (size)' lifts only the size cap — a match-confidence cap stays.",
];

/** compare()'s options — the evidence the CLI ties the report to. `components` = the --interactions file's
 *  components[] (the agent's present:false claims), merged with measured.json's. `against` = the previous
 *  round's report (the one about to be overwritten, or --against), for a coverage comparison only. */
export interface CompareOptions {
  interactions?: InteractionEvidence[] | null; components?: MeasuredComponent[] | null; expectationSha256?: string; measuredSha256?: string;
  artifactCheck?: ArtifactCheck[] | null; code?: CodeInputs; against?: { file: string; report: VerifyReport } | null;
  /** what readableMeasured() dropped from the measured file (malformed optional extras) — reported, never judged */
  inputNotes?: string[] | null;
  /** readableMeasured() dropped a malformed measured.behaviour — report.behaviour says so (not "no block") */
  behaviourMalformed?: boolean;
  /** readableMeasured() dropped a malformed measured.visual — report.visual says so (not "no block") */
  visualMalformed?: boolean;
  /** where measured.visual.diff is now (the CLI resolves it beside the measured file when the recorded path is gone) */
  visualDiff?: { path: string; exists: boolean } | null;
  /** the plan's waivers[] — a matching delta is accepted (still listed, out of the counts) */
  waivers?: PlanWaiver[] | null;
  /** the plan's descopes[] — a matching interaction is removed from the graded set */
  descopes?: PlanDescope[] | null;
  /** the plan's anchors{} — `foldedInto` takes a layout-only wrapper out of the denominator */
  anchors?: Record<string, PlanAnchor> | null;
  /** recorded as report.inputs.waivers: the plan file and waiversHash() of it */
  waiversInput?: { plan: string; sha256: string } | null;
  /** the run's status file beside the measured file — an unfinished run, or one naming another measured
   *  file, makes the verdict incomplete. A v1 (hand-written) status is never trusted, never judged. null = looked
   *  for and none found: a measured file naming its runId is then unrecorded; undefined = not looked for. */
  status?: { file: string; status: VerifyStatusV2 | "v1" } | null;
  /** the plan for this frame as found NOW: its interactions[] hash against the expectation's planInteractions;
   *  its navigate[] against the probe's measured.reach (report.inputs.reach.matchesPlan). `choice` = how the CLI
   *  picked it (choosePlan) — the re-run advice names --plan when the plan was not the frame's only one */
  plan?: ChosenPlan | null;
  /** the plan file the expectation merged interactions from (planInteractions.plan) could not be used at
   *  --compare — why ("no longer exists" / "is not a readable plan now: …"); the re-run advice then names both plans */
  recordedPlanGone?: string | null;
  /** the --interactions evidence file's `inferred` value, unchecked — compare keeps the well-formed
   *  {nodeId?, state, built, why?} rows (listed under Inferred, not designed) and notes the rest */
  inferred?: unknown;
}

// ---- waivers: does a waiver's recorded value still describe this round's delta?
/** The slack a waiver's designed/built values are matched with — the field's own tolerance (null = exact). */
function fieldTolerance(label: string): number | null {
  const f = FIELDS.find((x) => x.label === label);
  if (f) return f.tol;
  if (label === "padding") return TOLERANCE.padding;
  if (label.startsWith("border-radius (")) return TOLERANCE.radius;
  if (label === "placement") return TOLERANCE.position;
  if (label === "width (text ink)") return TOLERANCE.textInk;
  if (label === "match (size)") return TOLERANCE.size;
  if (label === "overflowX") return TOLERANCE.position;
  return null;
}
// ---- the previous round's deltas against this round's, keyed nodeId + field. A delta that is gone only
// because its node or value was not measured this round is LOST COVERAGE, not a fix. "Not measured" means the
// node is unmeasured or its measured node lacks the value (absent / null) — a value that was measured but the compare
// now declines (impossible, an <img> fill, a method gap) is nowUnverifiable; and when the measured file is the very
// same file as last round's, no difference is the build's — every one is `reclassified`, none fixed/new/lost.
const fieldBase = (f: string): string => f.replace(/\s*\(.*\)$/, "");
// the verdict reasons that say the run itself is unverified — the ONE wording compare() writes and
// --accept recognises (it refuses a report carrying any of them).
const INTEGRITY_PHRASES = {
  otherExpectation: "the measurements were taken against a DIFFERENT expectation",
  noExpectation: "measured file names no expectation (expectationSha256)",
  unfinished: "— the verifier had not finished",
  otherMeasured: "names a different measured file",
  unrecorded: "no status of that run records it",
  measuredBefore: "was measured before that run ended",
} as const;
export const isIntegrityReason = (w: string): boolean => Object.values(INTEGRITY_PHRASES).some((p) => w.includes(p));
interface CoverageNow {
  notMeasured: Array<{ nodeId: string }>; fieldsNotMeasured: Array<{ nodeId: string; field: string; why: string }>; unverifiable: Array<{ nodeId: string; field: string; why: string }>;
  specIds: Set<string>; absent: Set<string>; sameMeasured: boolean;
  /** nodes whose `placement` (derived from the box) could not be judged this round — absent = an input
   *  (x/y/width/height) was not reported or null (lost coverage), else one was reported but is not a number */
  placementGaps?: Map<string, { absent: boolean; why: string }>;
  /** the design values the expectation excludes by method (expectation.notComparable) — a previous
   *  delta on one of them is now unverifiable, not fixed (a TEXT box width, padding a fixed box cannot show) */
  notComparable?: Array<{ nodeId: string; field: string; why: string }>;
  /** coverage.pageOverflow this round — a previous overflowX delta with the page not judged now is lost coverage */
  pageOverflow?: string;
}
// Is a previous delta's value now excluded by method (expectation.notComparable)? Padding is per side:
// a `padding (left/right)` exclusion covers a previous padding delta only when every side that differed
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
    // the page's overflow is no spec — gone because the page was not judged at the design width is not a fix
    if (d.field === "overflowX") {
      const po = now.pageOverflow;
      if (po === undefined || po === "not measured" || po === "not at design width") out.lostCoverage.push({ nodeId: d.nodeId, field: d.field, was: was(d), why: po === "not at design width" ? "the page was not measured at the design width this round" : "page overflow was not measured this round" });
      else if (po === "designed to scroll") nowUnverifiable.push({ nodeId: d.nodeId, field: d.field, was: was(d), why: "the frame is designed to scroll sideways now" });
      // the content is still wider than the page — the page now hides it (overflow-x hidden/clip); not a fix
      else if (po === "clipped") nowUnverifiable.push({ nodeId: d.nodeId, field: d.field, was: was(d), why: "the page is still wider than the design width but clips it now (overflow-x hidden/clip) — clipped, not fixed" });
      else out.fixed++;
      continue;
    }
    if (!now.specIds.has(d.nodeId)) continue; // the spec left the expectation: neither fixed nor lost
    if (unmeasuredNodes.has(d.nodeId)) { out.lostCoverage.push({ nodeId: d.nodeId, field: d.field, was: was(d), why: "the node was not measured this round" }); continue; }
    const gapRow = now.fieldsNotMeasured.find((g) => sameField(g, d));
    const absent = gapRow ? now.absent.has(`${gapRow.nodeId}\u0000${gapRow.field}`) : now.absent.has(k) || [...now.absent].some((a) => a.startsWith(`${d.nodeId}\u0000`) && fieldBase(a.slice(d.nodeId.length + 1)) === fieldBase(d.field));
    if (absent) { out.lostCoverage.push({ nodeId: d.nodeId, field: d.field, was: was(d), why: `not measured this round: ${gapRow ? gapRow.why : "the probe did not report this property"}` }); continue; }
    // placement is derived from the box — gone because an input is missing is not a fix
    const derived = d.field === "placement" ? now.placementGaps?.get(d.nodeId) : undefined;
    if (derived && derived.absent) { out.lostCoverage.push({ nodeId: d.nodeId, field: d.field, was: was(d), why: `not measured this round: ${derived.why}` }); continue; }
    if (derived) { nowUnverifiable.push({ nodeId: d.nodeId, field: d.field, was: was(d), why: derived.why }); continue; }
    const method = gapRow ?? now.unverifiable.find((g) => sameField(g, d)) ?? excludedNow(d, now.notComparable || []);
    if (method) { nowUnverifiable.push({ nodeId: d.nodeId, field: d.field, was: was(d), why: method.why }); continue; }
    out.fixed++;
  }
  return nowUnverifiable.length ? { ...out, nowUnverifiable } : out;
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
// what makes a spec more than a layout wrapper — it paints or carries copy, so it is built, never folded.
const PAINT_KEYS = ["decorated", "text", "placeholderText", "fontSize", "color", "backgroundColor", "fill", "borderColor", "borderWidth", "borderWidths", "borderRadius", "radiusCorners", "opacity"] as const;
const paintOf = (s: VerifySpec): string[] => PAINT_KEYS.filter((k) => s[k] !== undefined);

// How the probe found each measured spec (coverage.matchedBy). The shipped probe writes the first six
// values; a hand-written probe wrote free text ("data-dt-node" is its spelling of a tag match), which is
// counted as `other`, and a node that does not say is `unstated`. `sharedComponentPath` is compare's own
// fallback (a measurement found under another screen's instance path).
const MATCH_BUCKET: Record<string, string> = {
  tag: "tag", "data-dt-node": "tag", id: "tag", "tag-shared-path": "tagSharedPath", "tag-alias": "tagAlias", text: "text", "text-ordinal": "textOrdinal", position: "position", frame: "frame",
};
export const MATCH_BUCKETS = ["tag", "tagSharedPath", "tagAlias", "text", "textOrdinal", "position", "frame", "sharedComponentPath", "other", "unstated"] as const;
export const MATCH_LABEL: Record<string, string> = {
  tag: "tag", tagSharedPath: "shared path", tagAlias: "alias", text: "text", textOrdinal: "ordinal", position: "position", frame: "frame",
  sharedComponentPath: "shared component path", other: "other", unstated: "unstated",
};
// the canonical matchedBy vocabulary (the shipped probe's, probe-match.ts) and the cap each gets.
// A hand-written probe's synonyms for a tag match ("data-dt-node", "id") read as "tag".
const CANONICAL_MATCH = new Set<string>(CANONICAL_MATCHED_BY);
const MATCH_SYNONYM: Record<string, string> = { "data-dt-node": "tag", id: "tag" };
const NO_CAP = new Set<string>(["tag", "tag-shared-path", "text", "frame"] satisfies MatchedBy[]);
const MEDIUM_CAP = new Set<string>(["text-ordinal", "tag-alias"] satisfies MatchedBy[]);
// A TEXT spec's typography read off one of these without the probe naming the text run (textFrom) is the
// container's font, not the text's (e.g. a 500-weight <button> around a 400-weight <span>).
const TYPO_FIELDS = new Set<string>(["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "color"]);

const SEVERITY_RANK: Record<DeltaSeverity, number> = { high: 0, medium: 1, low: 2 };
const NEVER_MEASURED_HEADLINE_MIN = 2;

// Every top-level key of a measured file. Typed against VerifyMeasured, so a key added to the type
// must be added here; any other key is listed in report.probe.unknownTopLevelKeys, never silently read.
const MEASURED_TOP_KEYS = {
  measuredAt: true, renderer: true, viewport: true, theme: true, artifacts: true, expectationSha256: true, mode: true, reason: true,
  nodes: true, components: true, interactions: true, consoleErrors: true, notMeasured: true, componentsMissing: true, probe: true,
  frame: true, frames: true, navigation: true, matchedByCensus: true, notes: true, runId: true, build: true,
  tagsNotInExpectation: true, reach: true, page: true, behaviour: true, visual: true,
} as const satisfies Record<keyof VerifyMeasured, true>;
// (a hand-written probe's top-level `navEvents` object is its page-wide navigation log — the canonical key is
// `navigation`; the per-interaction count lives on each interactions[] row, never up here)
// top-level keys read untyped (not in VerifyMeasured) — the verifier's own `inferred[]` rows
const MEASURED_UNTYPED_TOP_KEYS = new Set(["inferred"]);
const TOP_KEY_HINTS: Record<string, string> = { notFound: "notMeasured", notFoundInDom: "notMeasured", notMeasuredByProbe: "notMeasured", missing: "notMeasured", measurements: "nodes", elements: "nodes", navEvents: "navigation" };

// ---- what counts as evidence that an interaction worked. `ok:true` is a claim; a pass needs the one
// element driven (selectorCount === 1), an outcome that is what the designed action does, and no document loaded
// during the interaction (navEvents: a reload or a cross-document navigation — a dev-server reload can read as "the
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
// reload. (`back` and `url` change the URL by definition too, like navigate — without them a multi-page back
// link could never pass.) An overlay opened as a route or a tab kept in the query string records what APPEARED
// (dialog-opened / selector-appeared / state-changed), which its action allows — not url-changed.
const URL_ACTIONS = new Set(["navigate", "back", "url"]);
const isOutcome = (x: unknown): x is Outcome => typeof x === "string" && INTERACTION_OUTCOMES.some((o) => o === x);
function outcomesFor(action: string | undefined): readonly Outcome[] {
  return action === "navigate" || action === "overlay" || action === "change_to" || action === "swap" ? OUTCOMES_FOR_ACTION[action] : OUTCOMES_FOR_ACTION.other;
}
/** What an ok:true row lacks to count as a pass, in words — empty when it passes. */
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

/** compare()'s measurement index: each measured node by id (the first wins), what its keys say about the probe, and the
 *  probe's own reason for a spec it could not match. */
interface MeasuredIndex {
  byId: Map<string, MeasuredNode>; duplicateNodeIds: number; unknownKeys: Map<string, number>; keysSeen: Set<string>; expectedIds: Set<string>;
  viaSharedPath: (id: string) => string | null; probeWhy: Map<string, string>;
}
/** compare()'s state: the inputs, the measurement index, and what the spec walk collects. The walk's counters are the
 *  only fields written after compareCtx() (`cx.fieldsChecked++`); every collection is filled in place. inputNotes
 *  starts as a copy of the caller's notes, reopened and unused start empty; the passes after the walk add to them. */
interface CompareCtx extends MeasuredIndex {
  expectation: Expectation; measured: VerifyMeasured; opts: CompareOptions; hiddenSet: Set<string>; legacy: boolean; specs: VerifySpec[];
  frameOf: (spec: VerifySpec) => Partial<VerifyRootFrame>;
  deltas: VerifyDelta[]; notMeasured: VerifyReportV2["notMeasured"]; fieldsNotMeasured: VerifyReportV2["fieldsNotMeasured"];
  unverifiable: VerifyReportV2["unverifiable"]; census: Map<string, { expected: number; present: number }>; tally: (key: string, present: boolean) => void;
  fieldsChecked: number; nodesMeasured: number; nodesMatchedByComponentPath: number; fieldsReportedNull: number;
  matchedByCensus: Record<string, number>; typographyOn: Map<string, string>; matchKind: Map<string, string>; matchCapOf: Map<string, DeltaSeverity>;
  absentGaps: Set<string>; placementGaps: Map<string, { absent: boolean; why: string }>; undrawnStates: Array<{ spec: VerifySpec; state: string }>;
  paintedVia: Array<{ nodeId: string; how: string }>; lineBoxWhyOf: Map<string, string>;
  gap: (spec: VerifySpec, field: string, why: string, absent?: boolean) => number;
  push: (spec: VerifySpec, field: string, severity: DeltaSeverity, bad: Bad, extra?: Partial<VerifyDelta>) => number;
  anchors: Record<string, PlanAnchor>; folded: VerifyReportV2["folded"]; probeFrames: ProbeFrame[]; multiFrame: boolean; frameMeasured: (id: string) => boolean;
  builtTexts: Map<string, string[]>; inputNotes: string[]; reopened: VerifyReportV2["waivers"]["reopened"]; unused: VerifyReportV2["waivers"]["unused"];
}
/** One measured spec as the checks read it: the measurement and how it was found, the styles compared (a drawn state's
 *  over the resting ones), the probe's reasons for its nulls, and what the element is (text, a container, a table, a leaf,
 *  inline). `firstDelta` = where this node's deltas start in cx.deltas (the caps). */
interface NodeCtx {
  spec: VerifySpec; m: MeasuredNode; matchedBy: string | null; rawMatch: string; base: MeasuredStyles; got: MeasuredStyles; measuredIn: string;
  state: VerifySpec["drawnState"]; st: NonNullable<MeasuredNode["states"]>[string] | undefined; um: Record<string, string>;
  gapNull: (field: string, ...keys: string[]) => void; zeroAtRest: boolean; stateWhy: string; isText: boolean; container: boolean;
  tb: NonNullable<MeasuredStyles["textBox"]> | null; tagLc: string; table: boolean | MeasuredStyles["tag"]; onLeaf: boolean; leafWhy: string;
  rowTag: boolean; inline: boolean; textDiffers: boolean; firstDelta: number;
}
/** an instance set of the expectation and the evidence the probe gave for it */
interface InstanceSet { setName: string; setKey?: string; nodeIds: string[]; instances: number }
/** What compare()'s passes after the spec walk hand each other — each pass takes the ones it reads (Pick) and returns
 *  the ones it computes. */
interface Graded {
  pageNotes: string[];
  rootF: Partial<VerifyRootFrame>;
  pageOverflow: PageOverflowCoverage;
  measuredIdsNotInExpectation: string[];
  foreignTags: NonNullable<VerifyReportV2["probe"]>["foreignTags"];
  fieldsNeverMeasured: VerifyCoverageV2["fieldsNeverMeasured"];
  comps: MeasuredComponent[];
  bySet: Map<string, InstanceSet>;
  untaggedInstanceSets: VerifyReportV2["untaggedInstanceSets"];
  setsViaSharedPath: number;
  sharedShell: VerifyCoverageV2["sharedShell"];
  untaggedInstanceSetsInShell: VerifyReportV2["untaggedInstanceSets"];
  untaggedOnScreen: VerifyReportV2["untaggedInstanceSets"];
  componentsAbsent: VerifyReportV2["componentsAbsent"];
  st: VerifyStatusV2 | null;
  integrity: string[];
  unboundNote: string | undefined;
  measuredRun: string | undefined;
  measuredRows: InteractionEvidence[];
  allEvidence: InteractionEvidence[];
  probeBound: boolean;
  probeRows: Map<string, InteractionEvidence>;
  exercised: Map<string, InteractionEvidence>;
  interactionEvidenceOnHidden: number;
  expectedKeys: Set<string>;
  exportSha: string | undefined;
  interactions: VerifyInteractionResult[];
  interactionsFailed: VerifyInteractionResult[];
  interactionsNotProbed: VerifyInteractionResult[];
  interactionsPassed: VerifyInteractionResult[];
  interactionsUndesigned: VerifyInteractionResult[];
  interactionsDescoped: VerifyInteractionResult[];
  unexpectedInteractionEvidence: number;
  unmatchedInteractionEvidence: Array<{ nodeId: string; trigger: string; hint?: string }>;
  inferred: InferredRow[];
  inferredHead: number;
  inferredUndesigned: number;
  applied: number;
  open: VerifyDelta[];
  high: number;
  medium: number;
  accepted: number;
  highCauses: number;
  planNow: ChosenPlan | null;
  planInteractionsChanged: string | null;
  reachInput: NonNullable<VerifyReportV2["inputs"]>["reach"];
  probeIdentity: ProbeIdentity | undefined;
  buildNow: BuildIdentity | undefined;
  inputs: NonNullable<VerifyReportV2["inputs"]>;
  staticOnly: boolean;
  artifactCheck: ArtifactCheck[] | null;
  noRender: boolean;
  nodesExpected: number;
  reasons: string[];
  lowConfidence: number;
  verdict: VerifyVerdict;
  coverage: VerifyCoverageV2;
  against: VerifyAgainst | undefined;
  headline: string;
  visual: ReportVisual;
}

/**
 * compare(expectation, measured, opts?) -> report.
 * opts: { interactions: [...] extra interaction evidence (the --interactions file),
 *         expectationSha256, measuredSha256, artifactCheck: [{path, exists, image}] }
 */
export function compare(expectation: Expectation, measured: VerifyMeasured | null | undefined, opts?: CompareOptions | null): VerifyReportV2 {
  const cx = compareCtx(expectation, measured || {}, opts || {});
  for (const spec of cx.specs) compareSpec(cx, spec);
  const { pageNotes, rootF, pageOverflow } = pageOverflowOf(cx);
  typographyNotes(cx);
  const { measuredIdsNotInExpectation } = idsNotInExpectation(cx);
  const { foreignTags } = foreignTagsOf(cx, { measuredIdsNotInExpectation });
  const { fieldsNeverMeasured } = fieldsNeverMeasuredOf(cx);
  const { comps, bySet, untaggedInstanceSets, setsViaSharedPath } = componentEvidence(cx);
  const { sharedShell, untaggedInstanceSetsInShell, untaggedOnScreen } = sharedShellOf(cx, { untaggedInstanceSets });
  const { componentsAbsent } = componentsAbsentOf({ comps, bySet });
  const { st, integrity, unboundNote, measuredRun } = runIntegrity(cx);
  const {
    measuredRows, allEvidence, probeBound, probeRows, exercised, interactionEvidenceOnHidden, expectedKeys,
  } = interactionEvidence(cx, { st, integrity, measuredRun });
  const {
    exportSha, interactions, interactionsFailed, interactionsNotProbed, interactionsPassed, interactionsUndesigned, interactionsDescoped,
  } = gradeInteractions(cx, { pageNotes, unboundNote, measuredRows, probeBound, probeRows, exercised });
  const { unexpectedInteractionEvidence, unmatchedInteractionEvidence } = unmatchedEvidence(cx, { allEvidence, expectedKeys });
  const { inferred, inferredHead, inferredUndesigned } = inferredRows(cx, { interactions });
  paintedByNote(cx);
  const { applied } = applyWaivers(cx, { componentsAbsent, exportSha, interactionsFailed });
  liftSizeCaps(cx);
  groupDeltas(cx);
  const { open, high, medium, accepted, highCauses } = openCounts(cx);
  const { planNow, planInteractionsChanged } = planInteractionsCheck(cx);
  const { reachInput } = reachInputOf(cx, { planNow });
  const { probeIdentity, buildNow, inputs, staticOnly, artifactCheck, noRender } = evidenceInputs(cx, { st, unboundNote, measuredRun, reachInput });
  const { nodesExpected, reasons, lowConfidence, verdict } = verdictOf(cx, {
    fieldsNeverMeasured, componentsAbsent, integrity, interactionsFailed, interactionsNotProbed, interactionsDescoped, open, high, medium,
    accepted, planInteractionsChanged, staticOnly, noRender,
  });
  const { coverage } = coverageOf(cx, {
    pageOverflow, fieldsNeverMeasured, bySet, untaggedInstanceSets, setsViaSharedPath, sharedShell, probeBound, interactions, interactionsFailed,
    interactionsNotProbed, interactionsPassed, interactionsUndesigned, interactionsDescoped, accepted, nodesExpected,
  });
  const { against } = againstOf(cx, { pageOverflow, probeIdentity, buildNow, nodesExpected });
  const { headline } = headlineOf(cx, {
    foreignTags, fieldsNeverMeasured, bySet, sharedShell, interactions, interactionsFailed, interactionsNotProbed, interactionsPassed,
    interactionsUndesigned, interactionsDescoped, unmatchedInteractionEvidence, inferredHead, inferredUndesigned, high, medium, accepted,
    highCauses, nodesExpected, lowConfidence, verdict, coverage, against,
  });
  const { visual } = visualOf(cx, { rootF, planNow });
  return reportOf(cx, {
    measuredIdsNotInExpectation, foreignTags, untaggedInstanceSetsInShell, untaggedOnScreen, componentsAbsent, integrity,
    interactionEvidenceOnHidden, interactions, interactionsFailed, interactionsNotProbed, interactionsUndesigned, interactionsDescoped,
    unexpectedInteractionEvidence, unmatchedInteractionEvidence, inferred, applied, open, high, medium, accepted, highCauses, inputs, staticOnly,
    artifactCheck, reasons, lowConfidence, verdict, coverage, against, headline, visual,
  });
}

/** the measurement index: duplicates are counted, unknown keys listed, and another screen's id for a shared component's node is found */
function indexMeasurements(expectation: Expectation, measured: VerifyMeasured, hiddenSet: Set<string>, specs: VerifySpec[]): MeasuredIndex {
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
    // inside `styles` only style keys are known (a `styles.states` is misplaced — listed, never read)
    const known = m.styles ? KNOWN_STYLE_KEYS : KNOWN_MEASURED_KEYS;
    for (const k of Object.keys(s)) { keysSeen.add(k); if (!known.has(k)) unknownKeys.set(k, (unknownKeys.get(k) || 0) + 1); }
  }
  // A shared implementation (one AppShell rendered on two routes) carries the node ids of the frame it
  // was built from: `I10970:111588;1910:23337` on another screen is `I10970:109860;1910:23337` here — the
  // same component-internal node under a different outer instance. Match on
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
  return { byId, duplicateNodeIds, unknownKeys, keysSeen, expectedIds, viaSharedPath, probeWhy };
}
/** compare()'s inputs, the measurement index and the empty collections the spec walk and the passes fill */
function compareCtx(expectation: Expectation, measured: VerifyMeasured, opts: CompareOptions): CompareCtx {
  const hiddenSet = new Set(((expectation.hidden && expectation.hidden.ids) || []).map(String));
  const legacy = expectation.schema !== EXPECTATION_SCHEMA;
  const specs = (expectation.nodes || []).filter((s) => !hiddenSet.has(String(s.nodeId)));
  const frameOf = (spec: VerifySpec): Partial<VerifyRootFrame> => (spec.frameId && (expectation.frames || []).find((f) => f.nodeId === spec.frameId)) || expectation.frame || {};
  const { byId, duplicateNodeIds, unknownKeys, keysSeen, expectedIds, viaSharedPath, probeWhy } = indexMeasurements(expectation, measured, hiddenSet, specs);

  const deltas: VerifyDelta[] = [];
  const notMeasured: VerifyReportV2["notMeasured"] = []; // node specs with NO measurement at all — one row per node, never per field
  const fieldsNotMeasured: VerifyReportV2["fieldsNotMeasured"] = []; // a measured node missing a field the spec states
  const unverifiable: VerifyReportV2["unverifiable"] = []; // values the method cannot read unless the probe goes out of its way
  const census = new Map<string, { expected: number; present: number }>(); // field -> { expected, present } over MEASURED nodes
  const tally = (key: string, present: boolean): void => { const c = census.get(key) || { expected: 0, present: 0 }; c.expected++; if (present) c.present++; census.set(key, c); };
  let fieldsChecked = 0, nodesMeasured = 0, nodesMatchedByComponentPath = 0, fieldsReportedNull = 0;
  const matchedByCensus: Record<string, number> = Object.fromEntries(MATCH_BUCKETS.map((b) => [b, 0]));
  const typographyOn = new Map<string, string>(); // TEXT spec id -> the container tag its typography was read from
  const matchKind = new Map<string, string>(); // measured spec id -> how it was found (through another screen's id?)
  const matchCapOf = new Map<string, DeltaSeverity>(); // a node's match-confidence cap (a size waiver keeps it)
  // the gaps where the measured node lacks the value (the key absent, or null) — the only kind that can LOSE a
  // previous delta; every other gap is the compare declining a value it has (a method gap, not lost coverage)
  const absentGaps = new Set<string>();
  const placementGaps = new Map<string, { absent: boolean; why: string }>(); // placement's inputs, per node
  // states measured on a node whose design draws none — never compared, listed under Inferred
  const undrawnStates: Array<{ spec: VerifySpec; state: string }> = [];
  // backgrounds compared through the element that paints them (paintedBy) — one input note
  const paintedVia: Array<{ nodeId: string; how: string }> = [];
  // nodes whose line box is taller than their fixed text box (the expectation's notComparable rows)
  const lineBoxWhyOf = new Map((expectation.notComparable || []).filter((g) => g.field === TEXT_BOX_HEIGHT).map((g) => [g.nodeId, g.why]));
  const gap = (spec: VerifySpec, field: string, why: string, absent = false): number => {
    if (absent) absentGaps.add(`${spec.nodeId}\u0000${field}`);
    return fieldsNotMeasured.push({ nodeId: spec.nodeId, name: spec.name, field, why });
  };
  const push = (spec: VerifySpec, field: string, severity: DeltaSeverity, bad: Bad, extra?: Partial<VerifyDelta>): number => deltas.push(Object.assign({
    severity, nodeId: spec.nodeId, name: spec.name, ...ifDefined("path", spec.path), field,
    expected: bad.want, actual: bad.got, delta: bad.delta,
  }, extra));

  // plan anchors that fold a layout-only wrapper into a measured ancestor
  const anchors = opts.anchors && isJsonObject(opts.anchors) ? opts.anchors : {};
  const folded: VerifyReportV2["folded"] = [];
  const probeFrames: ProbeFrame[] = [...(Array.isArray(measured.frames) ? measured.frames : []), ...(measured.frame ? [measured.frame] : [])];
  const multiFrame = (expectation.frames || []).length > 1;
  const frameMeasured = (id: string): boolean => probeFrames.some((f) => f.nodeId === id);
  // the BUILD's texts per repeated-text group — varied texts are real data, one text for all is a copy bug
  const builtTexts = new Map<string, string[]>();
  for (const s of specs) {
    if (!s.repeatedTextGroup) continue;
    const mm = byId.get(String(s.nodeId));
    const t = mm ? (mm.styles || mm).text : undefined;
    if (typeof t === "string") getOrInit(builtTexts, s.repeatedTextGroup, () => []).push(t.replace(/\u00a0/g, " ").trim());
  }
  // filled by the passes after the walk: the report's input notes (the caller's first), the waivers/descopes reopened or unused
  const inputNotes = [...(Array.isArray(opts.inputNotes) ? opts.inputNotes : [])];
  const reopened: VerifyReportV2["waivers"]["reopened"] = [];
  const unused: VerifyReportV2["waivers"]["unused"] = [];
  return {
    expectation, measured, opts, hiddenSet, legacy, specs, frameOf, byId, duplicateNodeIds, unknownKeys, keysSeen, expectedIds, viaSharedPath, probeWhy, deltas, notMeasured, fieldsNotMeasured, unverifiable, census, tally, fieldsChecked, nodesMeasured, nodesMatchedByComponentPath, fieldsReportedNull, matchedByCensus, typographyOn, matchKind, matchCapOf, absentGaps, placementGaps, undrawnStates, paintedVia, lineBoxWhyOf, gap, push, anchors, folded, probeFrames, multiFrame, frameMeasured, builtTexts, inputNotes, reopened, unused,
  };
}

/** One spec against its measurement: matched (or folded / not measured), then every check, then the caps. */
function compareSpec(cx: CompareCtx, spec: VerifySpec): void {
  const hit = matchSpec(cx, spec);
  if (!hit) return;
  const n = readNode(cx, spec, hit.m, hit.matchedBy);
  if (!n) return;
  checkFields(cx, n);
  checkCorners(cx, n);
  checkPadding(cx, n);
  checkPlaceholderText(cx, n);
  checkText(cx, n);
  checkPlacement(cx, n);
  const { own, sizeRow } = checkMatchSize(cx, n);
  capSeverity(cx, n, own, sizeRow);
}
/** the measurement for a spec — by id, else through a shared component's internal path; none → folded into a measured
 *  ancestor (a plan anchor, checked) or not measured (null) */
function matchSpec(cx: CompareCtx, spec: VerifySpec): { m: MeasuredNode; matchedBy: string | null } | null {
  const { frameOf, byId, viaSharedPath, probeWhy, notMeasured, anchors, folded, frameMeasured } = cx;
  let m = byId.get(String(spec.nodeId));
  let matchedBy: string | null = m ? m.matchedBy || "id" : null;
  if (!m) {
    const alt = viaSharedPath(spec.nodeId);
    if (alt) { m = byId.get(alt); matchedBy = `shared-component-path (${alt})`; cx.nodesMatchedByComponentPath++; }
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
        return null;
      }
      why += ` — plan anchor foldedInto ${into} refused: ${refuse}`;
    } else if (!paint.length) {
      const parent = (spec.ancestorIds || [])[0] ?? frameId;
      why += ` — foldable (no paint — anchor it foldedInto its parent${parent ? ` ${parent}` : ""} if the build merged it there)`;
    }
    notMeasured.push({ nodeId: spec.nodeId, name: spec.name, ...ifDefined("path", spec.path), why });
    return null;
  }
  return { m, matchedBy };
}
/** the node's NodeCtx — or null for a node drawn in a state that renders 0×0 at rest (absent by design, listed) */
function readNode(cx: CompareCtx, spec: VerifySpec, m: MeasuredNode, matchedBy: string | null): NodeCtx | null {
  const { deltas, tally, matchedByCensus, typographyOn, matchKind, placementGaps, undrawnStates, gap } = cx;
  cx.nodesMeasured++;
  const rawMatch = typeof m.matchedBy === "string" ? m.matchedBy : "";
  matchKind.set(String(spec.nodeId), matchedBy && matchedBy.startsWith("shared-component-path") ? "shared-component-path" : rawMatch);
  const bucket = matchedBy && matchedBy.startsWith("shared-component-path") ? "sharedComponentPath" : rawMatch === "" ? "unstated" : MATCH_BUCKET[rawMatch] ?? "other";
  matchedByCensus[bucket] = (matchedByCensus[bucket] ?? 0) + 1;
  // a null is the probe saying "I could not read this" — listed as not measured with its reason
  // (the shipped probe's unmeasured[key]), never compared, never counted as checked.
  const base: MeasuredStyles = m.styles || m;
  let got: MeasuredStyles = base, measuredIn = "rest";
  const state = spec.drawnState;
  if (!state && m.states && isJsonObject(m.states)) for (const s of Object.keys(m.states)) undrawnStates.push({ spec, state: s });
  const st = state && m.states && m.states[state];
  // A null in the state's styles OVERRIDES the resting value (Object.assign copies it): the hovered value
  // could not be read, and the resting one is not a stand-in for it.
  if (st) { got = Object.assign({}, base, st.styles || st); measuredIn = state; }
  // The state row's own reasons (states.<s>.unmeasured) win over the node's for a value measured in that state.
  const stUm: unknown = st ? st.unmeasured : undefined;
  const um: Record<string, string> = { ...(isJsonObject(m.unmeasured) ? m.unmeasured : {}), ...(isJsonObject(stUm) ? Object.fromEntries(Object.entries(stUm).filter((e): e is [string, string] => typeof e[1] === "string")) : {}) };
  const nullWhy = (...keys: string[]): string => { for (const k of keys) { const w = um[k]; if (typeof w === "string" && w) return w; } return "reported null"; };
  const gapNull = (field: string, ...keys: string[]): void => { cx.fieldsReportedNull++; gap(spec, field, nullWhy(...keys), true); };
  const zeroAtRest = num(base.width) && num(base.height) && base.width === 0 && base.height === 0;
  const stateWhy = state ? `the designer drew this ${spec.drawnStateOwn ? "layer" : "layer's container"} in its ${state} state (${spec.drawnStateWhy}) — measure it ${state === "hover" ? "hovered" : state} and report the values under states.${state}` : "";

  // Hover-only content measured at rest is absent by design, not missing (e.g. the
  // edit button that exists only on the hovered row, "36 → 0").
  if (state && measuredIn === "rest" && zeroAtRest) {
    for (const f of FIELDS) if (spec[f.key] !== undefined) { tally(f.key, false); gap(spec, f.label, `renders 0×0 at rest: ${stateWhy}`); }
    placementGaps.set(String(spec.nodeId), { absent: false, why: `renders 0×0 at rest: ${stateWhy}` });
    return null;
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
  // copy that differs renders a different width (and a centred/right-aligned start) — judge the copy first
  // (the RENDERED strings — the same rule as the copy compare below)
  const textDiffers = isText && spec.text !== undefined && typeof got.text === "string" && !renderedText(spec.text, spec.textCase, got.text, got.textTransform, normText).same;
  const firstDelta = deltas.length; // this node's deltas: deltas.slice(firstDelta) (the caps below)
  return { spec, m, matchedBy, rawMatch, base, got, measuredIn, state, st, um, gapNull, zeroAtRest, stateWhy, isText, container, tb, tagLc, table, onLeaf, leafWhy, rowTag, inline, textDiffers, firstDelta };
}
/** the FIELDS compared one-to-one (a TEXT's x/width from its textBox, a gap from gapVisual, the stroke and radius as CSS draws them, a background through its painter) */
function checkFields(cx: CompareCtx, n: NodeCtx): void {
  const { unverifiable, tally, paintedVia, lineBoxWhyOf, gap, push } = cx;
  const {
    spec, m, matchedBy, base, got, measuredIn, state, st, gapNull, stateWhy, isText, container, tb, tagLc, table, onLeaf, leafWhy, rowTag,
    inline, textDiffers,
  } = n;
  for (const f0 of FIELDS) {
    const want0 = spec[f0.key];
    if (want0 === undefined) continue;
    // a fixed/fill-width TEXT's width is its INK width — its own label and tolerance
    const f: Field = isText && f0.key === "width" && spec.widthFrom === "renderBox" ? { ...f0, label: "width (text ink)", tol: TOLERANCE.textInk } : f0;
    let val: JsonValue | undefined = got[f.key];
    let nullKeys: string[] = [f.key];
    let present = val !== undefined;
    // a TEXT's x/width come ONLY from textBox (a Range over its characters) — never its element's box,
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

    // (opacity too — hover-revealed content reads 0 at rest; any layer inside a drawn state, not only the owner)
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
    // "cannot be known, so no mismatch" (that allowance is for the spec side only).
    if (f.norm && (f.norm(val) == null || (typeof val !== "string" && typeof val !== "number"))) { gap(spec, f.label, `could not read '${typeof val === "string" ? val : JSON.stringify(val)}' as ${f.label}`); continue; }
    // A numeric field reads a number or a px string — the delta then carries the number, so the
    // report never prints "28pxpx". `letter-spacing: normal` is 0; any other keyword, unit or shape
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
    cx.fieldsChecked++;
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
      if (!c) { gap(spec, f.label, `could not read '${JSON.stringify(val)}' as a px radius`); cx.fieldsChecked--; continue; }
      if (c.some((r) => r < 0)) { gap(spec, f.label, `${JSON.stringify(val)} is impossible for a radius (CSS cannot make it negative) — a measuring artefact; not compared`); cx.fieldsChecked--; continue; }
      const W = num(got.width) ? got.width : spec.width, H = num(got.height) ? got.height : spec.height;
      // (a borderRadius spec is a number — expectNode writes it from the node's radius)
      if (typeof want === "number") want = clampRadius(want, spec.width, spec.height);
      const target = Number(want);
      // the four corners must all match a uniform design radius
      const worst = c.map((r) => clampRadius(r, W, H)).reduce((a, r) => (Math.abs(r - target) > Math.abs(a - target) ? r : a), clampRadius(c[0], W, H));
      have = worst;
    }
    // a transparent element whose background another element paints (a hovered <tr> behind its
    // <td>, a same-box child) — the painted colour is the one the user sees. Only the probe's paintedBy says so; read
    // from the same pass as the background (a state's own, never the resting one).
    let paintNote: string | undefined;
    if (f.key === "backgroundColor" && normColor(have) === "transparent" && normColor(want) !== "transparent") {
      const stBag: unknown = st ? st.styles || st : undefined;
      const pb: unknown = isJsonObject(stBag) && stBag.backgroundColor !== undefined ? stBag.paintedBy : base.paintedBy;
      if (isPaintedBy(pb)) {
        have = pb.backgroundColor;
        paintNote = pb.via === "child" ? `background painted by its same-box child <${pb.tag}> — the element itself is transparent`
          : `background painted by its <${pb.tag}>${pb.depth > 1 ? ` (${pb.depth} levels up)` : ""} — the element itself is transparent`;
        paintedVia.push({ nodeId: spec.nodeId, how: `${pb.via === "child" ? "child" : "ancestor"} <${pb.tag}>` });
      }
    }
    const bad = compareField(f, want, have);
    if (bad) {
      push(spec, f.label, f.high ? "high" : "medium", bad, {
        ...ifDefined("unit", f.unit), ...ifDefined("token", tokenFor(spec, f.key)), ...(measuredIn !== "rest" ? { measuredIn } : {}),
        ...ifDefined("matchedBy", matchedBy !== "id" ? matchedBy || undefined : undefined),
        ...(f.key === "borderRadius" && spec.borderRadius !== want ? { note: `design radius ${spec.borderRadius} on a ${spec.width}×${spec.height} box draws ${want}` } : {}),
        ...ifDefined("note", [strokeNote, paintNote, f.key === "lineHeight" ? lineBoxWhyOf.get(spec.nodeId) : undefined].filter((x): x is string => x !== undefined).join("; ") || undefined),
      });
    }
  }
}
/** a per-corner radius (unequal corners) */
function checkCorners(cx: CompareCtx, n: NodeCtx): void {
  const { tally, gap, push } = cx;
  const { spec, got, gapNull, tagLc, onLeaf, leafWhy, rowTag, inline } = n;
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
        cx.fieldsChecked++;
        const want = clampRadius(rc[k], spec.width, spec.height), have = clampRadius(measured[k], W, H);
        const d = Math.abs(want - have);
        if (d > TOLERANCE.radius) push(spec, `border-radius (${{ tl: "top-left", tr: "top-right", br: "bottom-right", bl: "bottom-left" }[k]})`, "medium", { want, got: have, delta: Number(d.toFixed(3)) }, { unit: "px", ...ifDefined("token", tokenFor(spec, "radius." + k)) });
      });
    }
  }
}
/** padding, side by side (a side the design cannot show is skipped) */
function checkPadding(cx: CompareCtx, n: NodeCtx): void {
  const { tally, gap, push } = cx;
  const { spec, got, gapNull, tagLc, onLeaf, leafWhy, inline } = n;
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
      cx.fieldsChecked++;
      const bad = comparePadding(spec.padding, pad, spec.paddingSkip);
      const allZero = pad.every((v) => v === 0);
      const skipNote = spec.paddingSkip && spec.paddingSkip.length ? `${spec.paddingSkip.join("/")} not compared (the design cannot show that padding — see notComparable)` : undefined;
      const zeroNote = allZero && !got.tag ? "measured 0 on every side — if this id sits on a <tr> or a wrapper, the padding lives on its cells/child: report `tag` and measure the element that carries it" : undefined;
      const padNote = [zeroNote, skipNote].filter((x): x is string => !!x).join("; ");
      if (bad) push(spec, "padding", "medium", bad, { unit: "px", ...ifDefined("token", tokenFor(spec, "padding")), ...(padNote ? { note: padNote } : {}) });
    }
  }
}
/** an input placeholder's text */
function checkPlaceholderText(cx: CompareCtx, n: NodeCtx): void {
  const { tally, gap, push } = cx;
  const { spec, got, gapNull } = n;
  if (spec.placeholderText !== undefined) {
    tally("placeholderText", got.placeholderText !== undefined);
    if (got.placeholderText === undefined) gap(spec, "placeholder text", "this layer is an input placeholder: report el.placeholder as placeholderText (textContent of an empty input is '')", true);
    else if (got.placeholderText === null) gapNull("placeholder text", "placeholderText");
    else {
      cx.fieldsChecked++;
      // (a cased placeholder may be built with either the stored or the rendered string — its transform is not read)
      if (!renderedText(String(spec.placeholderText), spec.textCase, String(got.placeholderText), undefined, (t) => t.trim()).same) push(spec, "placeholder text", "high", { want: spec.placeholderText, got: got.placeholderText, delta: null });
    }
  }
}
/** the copy, as rendered (text case / text-transform), and a non-breaking space in it */
function checkText(cx: CompareCtx, n: NodeCtx): void {
  const { deltas, tally, absentGaps, gap, push, builtTexts } = cx;
  const { spec, got, um } = n;
  if (spec.text !== undefined) {
    tally("text", got.text !== undefined);
    if (got.text === null) {
      cx.fieldsReportedNull++;
      gap(spec, "text", um.text || "the probe reported text: null — an element with child elements still has text; report its textContent", true);
    }
    else if (got.text === undefined) absentGaps.add(`${spec.nodeId}\u0000text`);
    else if (got.text !== undefined) {
      cx.fieldsChecked++;
      // compare the RENDERED strings — the stored string with the design's text case against the build's
      // string with its computed text-transform (renderedText). Without a reported transform either design form passes.
      const rt = renderedText(String(spec.text), spec.textCase, String(got.text), got.textTransform, (t) => t.replace(/ /g, " ").trim());
      const w = rt.want.replace(/ /g, " ").trim();
      const g = rt.have.replace(/ /g, " ").trim();
      // the stored strings behind the rendered ones, named when a case or a transform changed either side
      const caseShown = spec.textCase !== undefined || (rt.transform !== null && rt.transform.trim().toLowerCase() !== "none");
      const renderNote = !caseShown ? undefined
        : `the design renders '${w}' (stored '${String(spec.text).trim()}'${spec.textCase ? `, text case ${spec.textCase}` : ""}); the build renders '${g}' (text '${String(got.text).trim()}'${rt.transform !== null ? `, text-transform ${rt.transform}` : ", text-transform not reported"})`;
      if (!rt.same) {
        const caseOnly = w.toLowerCase() === g.toLowerCase();
        // "Name▲": the designed string plus glyphs that are not letters or digits (a sort caret,
        // an icon font) — the copy is intact; name the extra glyphs rather than calling it a copy bug.
        const extraGlyphs = !caseOnly && g.startsWith(w) && !/[\p{L}\p{N}]/u.test(g.slice(w.length));
        // the design repeats this string in >=3 sibling rows (placeholder copy). Low ONLY when the build's
        // texts in those rows differ from each other (real data); one wrong string in every row stays high.
        const rowTexts = spec.repeatedText && spec.repeatedTextGroup ? builtTexts.get(spec.repeatedTextGroup) : undefined;
        // Real data = at least three different built values, and the designed string in at most half the rows
        // (a realistic placeholder — "Active" — may well be one of the real values). A typo among correct rows
        // ({View×3, Veiw}: 2 values; {View×3, Veiw, Vew}: View is the majority) or one wrong label everywhere plus
        // a typo stays high. Trade-off: two-state data ({Active, Inactive}) stays high — too close to a copy bug.
        const distinct = rowTexts ? new Set(rowTexts).size : 0;
        const asDesigned = rowTexts ? rowTexts.filter((t) => t === w).length : 0;
        const realData = !caseOnly && !extraGlyphs && !!rowTexts && distinct >= 3 && asDesigned * 2 <= rowTexts.length;
        const why = caseOnly ? (caseShown ? "differs only in case, as rendered" : "differs only in case — check for a text-transform, which Figma applies at render time while storing the original")
          : extraGlyphs ? `the designed text is intact, followed by '${g.slice(w.length).trim()}' (an icon or caret inside the same element?)`
          : realData ? `repeated placeholder copy: the design shows '${w}' in every sibling row; the build shows ${distinct} different values across them (real data?) — check the copy is the data the design means`
          : undefined;
        const note = [why, renderNote].filter((x): x is string => x !== undefined).join(" — ");
        push(spec, "text", caseOnly || extraGlyphs || realData ? "low" : "high", { want: spec.textCase ? rt.want : spec.text, got: caseShown && rt.transform !== null ? rt.have : got.text, delta: null }, {
          ...(note ? { note } : {}),
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
}
/** placement: a node designed inside the frame that renders outside it */
function checkPlacement(cx: CompareCtx, n: NodeCtx): void {
  const { frameOf, deltas, placementGaps, probeFrames, multiFrame } = cx;
  const { spec, got, zeroAtRest } = n;
  // ---- placement: a designed-inside-the-frame node that renders outside it
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
      // "below the fold" — a page that is simply longer than the design's frame scrolls to this node.
      // Medium (still blocks a pass) only when ALL hold: the bottom edge is the only one crossed; the probe
      // took the viewport as the frame, or the rendered frame is taller than the design's (the page grew);
      // the node is not absolute/fixed (those do not scroll into view); one frame (not a multi-frame/overlay
      // expectation). Anything else stays high. Trade-off: a real bug that pushes a CTA below the fold also
      // reads medium — it still blocks the pass, it just does not shout.
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
/** is this the element the design means? a `match (size)` row when its box is far from the design's */
function checkMatchSize(cx: CompareCtx, n: NodeCtx): { own: VerifyDelta[]; sizeRow: VerifyDelta | undefined } {
  const { frameOf, deltas } = cx;
  const { spec, matchedBy, got, isText, onLeaf, inline, firstDelta } = n;
  // ---- is this the element the design means? A matched box far from the design's size (>=2x or
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
  return { own, sizeRow };
}
/** the node's deltas capped by how the element was found (and by a `match (size)` row) */
function capSeverity(cx: CompareCtx, n: NodeCtx, own: VerifyDelta[], sizeRow: VerifyDelta | undefined): void {
  const { matchCapOf } = cx;
  const { spec, rawMatch } = n;
  // ---- severity is capped by how the element was found. tag / tag-shared-path / text / frame / a
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

/** the page's sideways overflow at the design width (a delta on the frame root) and its notes */
function pageOverflowOf(cx: CompareCtx): Pick<Graded, "pageNotes" | "rootF" | "pageOverflow"> {
  const { expectation, measured, deltas } = cx;
  // ---- the page scrolls sideways at the design width — a HIGH, waivable fidelity delta on the frame root (field
  // overflowX), read only from the probe's measurement pass (measured.page). Not judged when the page was not measured,
  // measured at another width, or the frame is designed to scroll sideways; an overflow the root clips (overflow-x
  // hidden/clip) cannot be scrolled to — a note, not a delta. No match cap: no element was matched.
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
    // once — the shipped probe already notes quirks mode in measured.notes; compare adds its own only when it did not
    const probeNotedQuirks = Array.isArray(measured.notes) && measured.notes.some((n) => typeof n === "string" && n.includes("quirks mode"));
    if (page.compatMode && page.compatMode !== "CSS1Compat" && !probeNotedQuirks) pageNotes.push(`the page renders in quirks mode (document.compatMode ${page.compatMode}) — its overflow is measured off <body>`);
  }
  return { pageNotes, rootF, pageOverflow };
}
/** a note on each typography delta read off a container rather than the text run */
function typographyNotes(cx: CompareCtx): void {
  const { deltas, typographyOn } = cx;
  // ---- notes that change how far a delta can be trusted (the match caps above change severity)
  const addNote = (d: VerifyDelta, note: string): void => { d.note = d.note ? `${d.note}; ${note}` : note; };
  const typoLabels = new Set(FIELDS.filter((f) => TYPO_FIELDS.has(f.key)).map((f) => f.label));
  for (const d of deltas) {
    const tag = typographyOn.get(String(d.nodeId));
    if (tag && typoLabels.has(d.field)) addNote(d, `typography read from a <${tag}>, not the text run — if the text sits in a child element, measure that element (the shipped probe does, and says textFrom)`);
  }
}
/** measured ids the expectation does not know */
function idsNotInExpectation(cx: CompareCtx): Pick<Graded, "measuredIdsNotInExpectation"> {
  const { expectation, hiddenSet, byId, expectedIds, viaSharedPath } = cx;
  // ---- measured ids the expectation does not know (the "134 measured vs 63 matched" case): a probe that
  // measured the wrong screen, a stale expectation, or ids on layers the export does not list.
  const knownIds = new Set([...expectedIds, ...hiddenSet, ...[expectation.frame, ...(expectation.frames || [])].map((f) => f && f.nodeId).filter((id): id is string => typeof id === "string")]);
  for (const id of expectedIds) { const alt = viaSharedPath(id); if (alt) knownIds.add(alt); }
  const measuredIdsNotInExpectation = [...byId.keys()].filter((id) => !knownIds.has(id));
  return { measuredIdsNotInExpectation };
}
/** tags/ids on the page that name no node of this expectation, classified (informational) */
function foreignTagsOf(cx: CompareCtx, g: Pick<Graded, "measuredIdsNotInExpectation">): Pick<Graded, "foreignTags"> {
  const { measured, specs, expectedIds } = cx;
  const { measuredIdsNotInExpectation } = g;
  // ---- tags on the page that name no node of this expectation (the shipped probe's tagsNotInExpectation) and
  // a hand-written probe's measured ids outside it, classified: prefixDrift — the `;` suffix of an expected id under
  // another instance prefix (a stale id table, another pull's ids); alias — another screen's id for one of these
  // nodes; unknown — neither. Informational: the verdict never reads it.
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
  return { foreignTags };
}
/** FIELDS keys the probe never reported under the canonical key */
function fieldsNeverMeasuredOf(cx: CompareCtx): Pick<Graded, "fieldsNeverMeasured"> {
  const { unknownKeys, census } = cx;
  // ---- fields in FIELDS that the probe never reported under the canonical key
  const fieldsNeverMeasured: VerifyCoverageV2["fieldsNeverMeasured"] = [];
  for (const [key, c] of census) {
    if (FIELDS.some((f) => f.key === key && f.optional)) continue; // listed under `unverifiable` instead
    if (c.expected > 0 && c.present === 0) {
      const hinted = [...unknownKeys.keys()].filter((k) => KEY_HINTS[k] === key);
      fieldsNeverMeasured.push({ field: key, expectedOn: c.expected, measuredOn: 0, ...(hinted.length ? { probeSent: hinted } : {}) });
    }
  }
  return { fieldsNeverMeasured };
}
/** component evidence — the instance sets the probe could point at (not presence) */
function componentEvidence(cx: CompareCtx): Pick<Graded, "comps" | "bySet" | "untaggedInstanceSets" | "setsViaSharedPath"> {
  const { expectation, measured, opts, hiddenSet, byId, viaSharedPath } = cx;
  // ---- component evidence. NOT presence: this is how many instance sets the probe could point at
  // (a data-dt-node id, a reported setName, or a shared-component path). A correct build that tags
  // nothing scores 0 here and a build that tags everything scores 100% without a pixel checked,
  // so it never fails a screen on its own; only an explicit `present: false` does.
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
  return { comps, bySet, untaggedInstanceSets, setsViaSharedPath };
}
/** the shared shell, counted apart (informational), and the untagged sets inside it */
function sharedShellOf(
  cx: CompareCtx,
  g: Pick<Graded, "untaggedInstanceSets">,
): Pick<Graded, "sharedShell" | "untaggedInstanceSetsInShell" | "untaggedOnScreen"> {
  const { expectation, hiddenSet, specs, matchKind, anchors, folded } = cx;
  const { untaggedInstanceSets } = g;
  // ---- the shared shell, counted apart (informational — never the verdict). An OUTERMOST instance
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
  // an untagged instance set that lives only inside the shared shell is not this screen's work — listed apart
  const untaggedInstanceSetsInShell = untaggedInstanceSets.filter((v) => shellIds.size > 0 && v.nodeIds.every((id) => { const o = outermostOf(String(id)); return o !== null && shellIds.has(o); }));
  const untaggedOnScreen = untaggedInstanceSets.filter((v) => !untaggedInstanceSetsInShell.includes(v));
  return { sharedShell, untaggedInstanceSetsInShell, untaggedOnScreen };
}
/** the component sets the probe reported absent (present: false) */
function componentsAbsentOf(g: Pick<Graded, "comps" | "bySet">): Pick<Graded, "componentsAbsent"> {
  const { comps, bySet } = g;
  const componentsAbsent: VerifyReportV2["componentsAbsent"] = [];
  for (const c of comps.filter((c) => c && c.present === false)) {
    const set = [...bySet.values()].find((v) => v.setName === (c.setName || c.name) || (c.nodeId !== undefined && v.nodeIds.includes(c.nodeId)));
    if (set) componentsAbsent.push({ setName: set.setName, nodeIds: set.nodeIds, ...ifDefined("detail", c.detail || c.note) });
  }
  return { componentsAbsent };
}
/** the run's integrity (another or no expectation, an unfinished run, another measured file) — ranked first in the verdict */
function runIntegrity(cx: CompareCtx): Pick<Graded, "st" | "integrity" | "unboundNote" | "measuredRun"> {
  const { measured, opts } = cx;
  const st = opts.status && opts.status.status !== "v1" ? opts.status.status : null;
  const stale = !!(opts.expectationSha256 && measured.expectationSha256 && measured.expectationSha256 !== opts.expectationSha256);
  const integrity: string[] = [];
  let unboundNote: string | undefined;
  // the run's integrity, ranked FIRST. When any of these holds, the numbers below belong to an unverified
  // run (another expectation, no expectation, an unfinished run, another measured file) — so the verdict is
  // `incomplete` even with high mismatches: a `fail` would grade numbers nothing ties to this design and run.
  // The report is still written (the coverage-baseline chain stays intact).
  if (stale) integrity.push(`${INTEGRITY_PHRASES.otherExpectation} (${String(measured.expectationSha256).slice(0, 12)}… vs ${String(opts.expectationSha256).slice(0, 12)}…) — re-measure`);
  if (opts.expectationSha256 && !measured.expectationSha256) integrity.push(`${INTEGRITY_PHRASES.noExpectation} — nothing ties these numbers to this design; re-measure with the shipped probe`);
  // a measured file that names its run, beside no status of that run (none found, a v1 file, another run's) —
  // nothing recorded it as that run's (the probe's status write was refused, or another run has started since).
  // Only when compare looked for one (opts.status null or set; undefined = an in-process caller that passed none).
  const measuredRun = typeof measured.runId === "string" && measured.runId ? measured.runId : undefined;
  if (measuredRun !== undefined && opts.status !== undefined && (st === null || st.runId !== measuredRun)) {
    integrity.push(`the measured file was taken in run ${measuredRun}, but ${st ? `${opts.status ? opts.status.file : "the status"} is run ${st.runId}` : opts.status && opts.status.status === "v1" ? `${opts.status.file} is an older hand-written status` : "no status file was found"} — ${INTEGRITY_PHRASES.unrecorded}; ${st ? `run ${st.runId} is the current run — re-measure in it (never record run ${measuredRun} over it)` : `record it with --status <Screen> --phase measured --run ${measuredRun}, or re-measure`}`);
  } else if (st && measuredRun === undefined && TERMINAL_PHASES.includes(st.phase) && Date.parse(String(measured.measuredAt)) > Date.parse(st.at)) {
    // a measured file that names no run (a probe without --run) and was measured AFTER the run ended is not
    // part of any run — that run's status says nothing about it; it is graded unbound (its interaction rows are
    // agent evidence). An older unbound file (no or unreadable measuredAt included) stays judged by the run below.
    unboundNote = `${opts.status ? opts.status.file : "status.json"} is run ${st.runId} (${st.phase}); this measured file names no run — graded as an unbound measurement`;
  } else if (st) {
    const stFile = opts.status ? opts.status.file : "status.json";
    // an unbound measured file beside a run still open: say how to end that run (only if nobody is still running it)
    const endHint = measuredRun === undefined ? ` — wait for it, or if nobody is running it any more, end it: --status ${shellArg(st.screen)} --phase failed --run ${shellArg(st.runId)}` : "";
    // an unbound measured file that is NOT newer than an ENDED run (failed/blocked) — the run cannot be "ended"
    // again (that would only rewrite its status, and a blocked run's detail with it): the file is stale, measure again
    if (measuredRun === undefined && TERMINAL_PHASES.includes(st.phase) && st.phase !== "done") integrity.push(`this measured file names no run and ${INTEGRITY_PHRASES.measuredBefore} (${stFile}: run ${st.runId} ${st.phase} at ${st.at}) — measure again`);
    else if (!MEASURED_PHASES.includes(st.phase)) integrity.push(`${stFile} (run ${st.runId}, rev ${st.rev}) is at phase ${st.phase} ${INTEGRITY_PHRASES.unfinished}${st.detail ? ` (${st.detail})` : ""}${endHint}`);
    else if (st.measuredSha256 && opts.measuredSha256 && st.measuredSha256 !== opts.measuredSha256) integrity.push(`${stFile} ${INTEGRITY_PHRASES.otherMeasured} (sha ${st.measuredSha256.slice(0, 12)}…, this one ${opts.measuredSha256.slice(0, 12)}…) — measured again outside run ${st.runId}?${st.phase === "done" ? "" : endHint}`);
  }
  return { st, integrity, unboundNote, measuredRun };
}
/** the interaction evidence by provenance — the run-bound probe's rows, the agent's rows */
function interactionEvidence(
  cx: CompareCtx,
  g: Pick<Graded, "st" | "integrity" | "measuredRun">,
): Pick<Graded,
  "measuredRows" | "allEvidence" | "probeBound" | "probeRows" | "exercised" | "interactionEvidenceOnHidden" | "expectedKeys"
> {
  const { expectation, measured, opts, hiddenSet } = cx;
  const { st, integrity, measuredRun } = g;
  // ---- interactions: the export says what each control does; did it? Three states, not two:
  // pass (driven, with the selector that was driven), fail (driven, did not work), not-probed
  // (nobody drove it — which is neither, so it is never filed as a "not measured" detail under result "fail").
  const measuredRows: InteractionEvidence[] = Array.isArray(measured.interactions) ? measured.interactions : [];
  const allEvidence: InteractionEvidence[] = [...measuredRows, ...(Array.isArray(opts.interactions) ? opts.interactions : [])];
  // evidence precedence by PROVENANCE, never by a self-declared field. The measured file's rows are the shipped
  // probe's own (authoritative) only when the file is bound to a finished run: the shipped probe's identity, a runId,
  // the run's status naming that run AND this measured file's sha (verify-run's `done`), and no integrity failure.
  // Otherwise every row is agent evidence (later wins: measured rows, then --interactions).
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
  return { measuredRows, allEvidence, probeBound, probeRows, exercised, interactionEvidenceOnHidden, expectedKeys };
}
/** each designed interaction graded on its evidence (pass / fail / not-probed / undesigned / descoped) */
function gradeInteractions(
  cx: CompareCtx,
  g: Pick<Graded, "pageNotes" | "unboundNote" | "measuredRows" | "probeBound" | "probeRows" | "exercised">,
): Pick<Graded,
  "exportSha" | "interactions" | "interactionsFailed" | "interactionsNotProbed" | "interactionsPassed" | "interactionsUndesigned" |
  "interactionsDescoped"
> {
  const { expectation, measured, opts, hiddenSet, inputNotes, reopened, unused } = cx;
  const { pageNotes, unboundNote, measuredRows, probeBound, probeRows, exercised } = g;
  // the owner's descopes — bound to the export like a waiver; a re-export reopens them.
  const exportSha = expectation.exportContentSha256;
  // expectation.tolerance carries textInk — one without it was written by an older
  // verify-screen (TEXT box widths, no paddingSkip/aliases)
  inputNotes.push(...pageNotes);
  if (expectation.tolerance && isJsonObject(expectation.tolerance) && expectation.tolerance.textInk === undefined) inputNotes.push("expectation written by an older verify-screen (TEXT box widths, no aliases) — re-run --expect");
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
  if (unboundNote !== undefined) inputNotes.push(unboundNote);
  if (!probeBound && isProbeIdentity(measured.probe) && measuredRows.length) inputNotes.push("the measured file's interaction rows are not run-bound (no finished run's status names this measured file) — graded as agent evidence");
  const interactions = (expectation.interactions || []).filter((i) => !hiddenSet.has(String(i.nodeId))).map((i): VerifyInteractionResult => {
    const key = String(i.nodeId) + "|" + i.trigger;
    const p = probeRows.get(key), a = exercised.get(key);
    // ok:true passes only with the evidence (one element, an outcome the action produces, no reload)
    const gapsOf = (h: InteractionEvidence | undefined): string[] | null => (h && h.ok === true && h.result !== "not-probed" ? evidenceGaps(h, i.action) : null);
    // a probe pass of an overlay/swap also needs the destination frame's tag inside the element that opened
    const act = String(i.action).toLowerCase();
    const needsInside = !!i.destinationId && (act === "overlay" || act === "swap");
    const pGaps = gapsOf(p);
    const pInside = !needsInside || (!!p && !!p.destination && p.destination.inside === true && p.destination.nodeId === i.destinationId);
    const pPass = pGaps !== null && pGaps.length === 0 && pInside;
    // (1) a run-bound probe pass wins; (2)/(3) a probe pass without the tag inside, a miss, a not-run or a fail never
    // overrides an agent row — the agent's is graded; no agent row → the probe's, as it is
    const hit = p && pPass ? p : a ?? p;
    const fromProbe = !!hit && hit === p;
    const insideMiss = fromProbe && pGaps !== null && pGaps.length === 0 && !pInside;
    const gaps = fromProbe ? (insideMiss ? [] : pGaps) : gapsOf(hit);
    const worked = fromProbe ? pPass : gaps !== null && gaps.length === 0;
    const overridden = fromProbe && pPass && a && !(a.ok === true && (gapsOf(a) ?? []).length === 0)
      ? `agent row ok: ${a.ok === undefined ? "(none)" : String(a.ok)}${a.detail ? ` — ${a.detail}` : ""}` : undefined;
    if (overridden) inputNotes.push(`${i.nodeId} (${i.trigger}): the run-bound probe's pass overrides the agent's row (${overridden})`);
    const row: VerifyInteraction = { nodeId: i.nodeId, name: i.name, trigger: i.trigger, ...ifDefined("action", i.action), ...ifDefined("destinationId", i.destinationId), ...(i.destinationExported === false ? { destinationExported: false } : {}),
      ...(i.source === "plan" ? { source: "plan" as const, ...ifDefined("expect", i.expect) } : {}) };
    const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
    const said = hit ? { ...ifDefined("outcome", typeof hit.outcome === "string" ? hit.outcome : undefined), ...ifDefined("navEvents", typeof hit.navEvents === "number" ? hit.navEvents : undefined),
      ...(probeBound ? { evidenceFrom: fromProbe ? "probe" as const : "agent" as const } : {}),
      ...ifDefined("activation", str(hit.activation)), ...ifDefined("detectedBy", str(hit.detectedBy)), ...ifDefined("revealedBy", str(hit.revealedBy)), ...ifDefined("overridden", overridden) } : {};
    // whose words a detail quotes — the run-bound probe's, else agent evidence (an unbound file's rows too)
    const saidBy = fromProbe ? "probe said" : "agent evidence said";
    // removed from the graded set before grading; evidence that it works anyway is noted, never graded.
    const scoped = descopeFor(i);
    if (scoped) return Object.assign(row, { result: "descoped" as const, detail: `descoped by ${scoped.decidedBy} (${scoped.decidedAt}): ${scoped.reason}`, ...(worked ? { note: "descoped but works — the probe drove it successfully; drop the descope?" } : {}) });
    // its destination was never exported — nothing designed to arrive at. A probe showing it working still passes.
    if (i.destinationExported === false && !worked) return Object.assign(row, { result: "undesigned" as const, detail: `destination ${i.destinationId} is not in this Figma file's export — nothing designed to check it against${hit && hit.detail ? `; ${saidBy}: ${hit.detail}` : ""}` });
    if (!hit) return Object.assign(row, { result: "not-probed" as const, detail: "no probe result for this node and trigger" });
    const count = Number(hit.selectorCount);
    if (hit.result === "not-probed" || hit.ok === null || hit.ok === undefined) return Object.assign(row, { result: "not-probed" as const, ...ifDefined("detail", hit.detail), ...(probeBound ? said : {}) });
    if (hit.ok === false) return Object.assign(row, { result: "fail" as const, ...ifDefined("detail", hit.detail), ...ifDefined("selector", hit.selector), ...said });
    if (insideMiss) {
      return Object.assign(row, { result: "not-probed" as const, detail: `probe pass without the destination tag inside the opened element — tag the root of what opens with data-dt-node="${i.destinationId}"${p && p.destination ? ` (the probe found ${p.destination.count} element(s) tagged ${p.destination.nodeId}, none inside it)` : ""}${hit.detail ? `; probe said: ${hit.detail}` : ""}`, ...ifDefined("selector", hit.selector), ...said });
    }
    // ok:true is a claim; the evidence is the selector that was driven and proof it matched something.
    // An agent can credit hidden popup rows with hovers on unrelated controls.
    // The outcome and the navigation count too — a reload can read as "the dialog opened".
    if (!worked || !hit.selector) {
      return Object.assign(row, { result: "not-probed" as const, detail: `reported ok without evidence — ${(gaps || []).join("; ")}${hit.detail ? `; ${saidBy}: ${hit.detail}` : ""}`, ...ifDefined("selector", hit.selector), ...said });
    }
    return Object.assign(row, { result: "pass" as const, ...ifDefined("detail", hit.detail), selector: hit.selector, selectorCount: count, ...said });
  });
  const interactionsFailed = interactions.filter((i) => i.result === "fail");
  const interactionsNotProbed = interactions.filter((i) => i.result === "not-probed");
  const interactionsPassed = interactions.filter((i) => i.result === "pass");
  const interactionsUndesigned = interactions.filter((i) => i.result === "undesigned");
  const interactionsDescoped = interactions.filter((i) => i.result === "descoped");
  for (const d of descopeRows) if (!descopeUsed.has(d)) unused.push({ nodeId: d.nodeId, field: `interaction (${d.trigger})`, why: "no designed interaction with this node and trigger this round" });
  return { exportSha, interactions, interactionsFailed, interactionsNotProbed, interactionsPassed, interactionsUndesigned, interactionsDescoped };
}
/** evidence for no designed interaction, each with a hint when a designed one is near */
function unmatchedEvidence(
  cx: CompareCtx,
  g: Pick<Graded, "allEvidence" | "expectedKeys">,
): Pick<Graded, "unexpectedInteractionEvidence" | "unmatchedInteractionEvidence"> {
  const { expectation, hiddenSet, specs } = cx;
  const { allEvidence, expectedKeys } = g;
  const unexpectedRows = allEvidence.filter((r) => r && r.nodeId != null && !hiddenSet.has(String(r.nodeId)) && !expectedKeys.has(String(r.nodeId) + "|" + String(r.trigger || "on_click").toLowerCase()));
  const unexpectedInteractionEvidence = unexpectedRows.length;
  // name each unmatched result (once per nodeId + trigger) and, when a designed interaction is near, say which —
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
  return { unexpectedInteractionEvidence, unmatchedInteractionEvidence };
}
/** "Inferred, not designed" — what the build does that the design never drew (never a verdict reason) */
function inferredRows(cx: CompareCtx, g: Pick<Graded, "interactions">): Pick<Graded, "inferred" | "inferredHead" | "inferredUndesigned"> {
  const { measured, opts, specs, undrawnStates, inputNotes } = cx;
  const { interactions } = g;
  // ---- "Inferred, not designed" — what the build does that the design never drew: an interaction only the
  // plan declares, a destination never exported (what opens is the build's reading), a state measured on a node whose
  // design draws none, and the verifier's own rows (measured.inferred[] / the evidence file's inferred[]). Judged
  // against best practice and the design's intent, never "matched" — listed and counted, NEVER a verdict reason.
  const inferred: InferredRow[] = [];
  // the headline counts each thing once — an interaction already counted "undesigned" is not counted again, and
  // one interaction with two rows (plan-declared AND an unexported destination) counts once
  let inferredHead = 0, inferredUndesigned = 0;
  for (const i of interactions) {
    if (i.source === "plan" || i.destinationExported === false) { if (i.result === "undesigned") inferredUndesigned++; else inferredHead++; }
    if (i.source === "plan") inferred.push({ kind: "plan-interaction", nodeId: i.nodeId, ...ifDefined("name", i.name), trigger: i.trigger, built: i.result,
      why: `declared by the plan (expect ${i.expect ?? "?"}) — the export carries no prototype link for it; graded as an interaction, but what it does was never drawn` });
    if (i.destinationExported === false) inferred.push({ kind: "undesigned-interaction", nodeId: i.nodeId, ...ifDefined("name", i.name), trigger: i.trigger, built: i.result,
      why: `its destination ${i.destinationId ?? "?"} was never exported — what it opens is the build's own reading of the design` });
  }
  const undrawnBy = new Map<string, number>();
  for (const u of undrawnStates) {
    undrawnBy.set(u.state, (undrawnBy.get(u.state) ?? 0) + 1);
    inferredHead++;
    inferred.push({ kind: "undrawn-state", nodeId: u.spec.nodeId, ...ifDefined("name", u.spec.name), state: u.state,
      why: `measured in its ${u.state} state, but the design draws no ${u.state} state for this node — the build's ${u.state} look is its own (not compared)` });
  }
  for (const [st0, n] of undrawnBy) inputNotes.push(`states.${st0} measured on ${n} node(s) whose design draws no ${st0} state — not compared (listed under Inferred, not designed)`);
  const specName = new Map(specs.map((sp) => [String(sp.nodeId), sp.name]));
  const unknownIds = new Set<string>();
  const agentRows = (raw: unknown, from: string): void => {
    if (raw === undefined) return;
    if (!Array.isArray(raw)) { inputNotes.push(`${from} inferred is not a list of {nodeId?, state, built, why?}; ignored`); return; }
    raw.forEach((r: unknown, k) => {
      const bad = (): void => { inputNotes.push(`${from} inferred[${k}] is not {nodeId?, state, built, why?} (state and built: non-empty strings); ignored`); };
      if (!isJsonObject(r)) return bad();
      const { nodeId, state: rs, built, why } = r;
      if (typeof rs !== "string" || !rs.trim() || typeof built !== "string" || !built.trim() || (nodeId !== undefined && typeof nodeId !== "string") || (why !== undefined && typeof why !== "string")) return bad();
      if (nodeId !== undefined && !specName.has(nodeId)) unknownIds.add(nodeId);
      inferredHead++;
      inferred.push({ kind: "agent", ...ifDefined("nodeId", nodeId), ...ifDefined("name", nodeId !== undefined ? specName.get(nodeId) : undefined), state: rs.trim(), built: built.trim(),
        why: why !== undefined && why.trim() ? why.trim() : "reported by the verifier: built, but the design draws no such state" });
    });
  };
  agentRows("inferred" in measured ? measured.inferred : undefined, "measured.json");
  agentRows(opts.inferred, "the --interactions evidence file's");
  if (unknownIds.size) inputNotes.push(`inferred[] row(s) name ${unknownIds.size} node id(s) not in this expectation: ${[...unknownIds].slice(0, 5).join(", ")}${unknownIds.size > 5 ? ", …" : ""} — listed as written (another screen's id, or a typo?)`);
  return { inferred, inferredHead, inferredUndesigned };
}
/** one input note for the backgrounds compared through the element that paints them */
function paintedByNote(cx: CompareCtx): void {
  const { paintedVia, inputNotes } = cx;
  // backgrounds compared through the element that paints them
  if (paintedVia.length) inputNotes.push(`background compared through the element that paints it on ${paintedVia.length} node(s) whose own background is transparent (paintedBy): ${paintedVia.slice(0, 5).map((p) => `${p.nodeId} by its ${p.how}`).join(", ")}${paintedVia.length > 5 ? `, …and ${paintedVia.length - 5} more` : ""}`);
}
/** the plan's waivers — each accepts one delta while its design and values hold, else is reopened or unused */
function applyWaivers(cx: CompareCtx, g: Pick<Graded, "componentsAbsent" | "exportSha" | "interactionsFailed">): Pick<Graded, "applied"> {
  const { opts, specs, deltas, notMeasured, fieldsNotMeasured, inputNotes, reopened, unused } = cx;
  const { componentsAbsent, exportSha, interactionsFailed } = g;
  // ---- the plan's waivers. A waiver accepts ONE delta (node + field) while the design is the one it was
  // accepted against (whole-export hash), the designed value is the same and the built value has not moved
  // beyond its tolerance. Anything else reopens it. Never waivable: an absent component, a failed interaction,
  // a node or value that was not measured — none of them is a delta.
  const notWaivable = new Map<string, string>();
  for (const n of notMeasured) notWaivable.set(n.nodeId, "the node was not measured — only a measured delta can be accepted");
  for (const i of interactionsFailed) notWaivable.set(i.nodeId, "a failed interaction is never waivable — descope it (plan.descopes, owner-only) if it is deliberately inert");
  for (const c of componentsAbsent) for (const id of c.nodeIds) notWaivable.set(id, `component set '${c.setName}' is reported ABSENT — a missing component is never waivable`);
  let applied = 0;
  (Array.isArray(opts.waivers) ? opts.waivers : []).forEach((w, i) => {
    if (!isPlanWaiver(w)) { inputNotes.push(`plan waivers[${i}] is not ${isPlanWaiver.expected}; ignored`); return; }
    const cands = deltas.filter((d) => d.nodeId === w.nodeId && d.field === w.field && !d.accepted);
    if (!cands.length) {
      const fieldGap = fieldsNotMeasured.some((g) => g.nodeId === w.nodeId && g.field === w.field) ? "that value was not measured this round — only a measured delta can be accepted" : undefined;
      // a waiver on a TEXT width written against the old field — the field is the ink width, a different value
      const inkNow = w.field === "width" && (deltas.some((d) => d.nodeId === w.nodeId && d.field === "width (text ink)") || specs.some((sp) => sp.nodeId === w.nodeId && sp.widthFrom === "renderBox"))
        ? "this TEXT's width is compared as 'width (text ink)' — re-accept against the new report" : undefined;
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
  return { applied };
}
/** an accepted `match (size)` row lifts the size cap on its node's other deltas (a match cap stays) */
function liftSizeCaps(cx: CompareCtx): void {
  const { deltas, matchCapOf } = cx;
  // ---- the owner accepted a `match (size)` row — the element IS the node, so the SIZE cap on its other
  // deltas is lifted (a real high then fails). A match-confidence cap stays: how the element was found is unchanged.
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
}
/** presentational groups — one cause, many rows (counts and verdict stay per delta) */
function groupDeltas(cx: CompareCtx): void {
  const { specs, deltas } = cx;
  // ---- presentational groups — one cause, many rows. Counts and verdict stay per delta.
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
    const gid = `same:${sha256Hex(k).slice(0, 8)}`;
    for (const d of list) d.group = gid;
  }
}
/** the open deltas and their counts (accepted ones leave them) */
function openCounts(cx: CompareCtx): Pick<Graded, "open" | "high" | "medium" | "accepted" | "highCauses"> {
  const { deltas } = cx;
  const open = deltas.filter((d) => !d.accepted);
  const high = open.filter((d) => d.severity === "high").length;
  const medium = open.filter((d) => d.severity === "medium").length;
  const accepted = deltas.length - open.length;
  const openHigh = open.filter((d) => d.severity === "high");
  const highCauses = new Set(openHigh.map((d, i) => d.group ?? `#${i}`)).size;
  return { open, high, medium, accepted, highCauses };
}
/** the plan's interactions[] against the hash the expectation recorded */
function planInteractionsCheck(cx: CompareCtx): Pick<Graded, "planNow" | "planInteractionsChanged"> {
  const { expectation, opts, inputNotes } = cx;
  // the plan's interactions[] bind the expectation by their hash — a plan that changed them since --expect
  // (or declares some the expectation never merged) makes the run incomplete (not an integrity failure: --accept works)
  const planNow = opts.plan || null;
  const recordedPi = expectation.planInteractions && isJsonObject(expectation.planInteractions) && typeof expectation.planInteractions.sha256 === "string" ? expectation.planInteractions : undefined;
  const nowRows = planNow && Array.isArray(planNow.plan.interactions) ? planNow.plan.interactions : null;
  // name --plan when the plan was not simply the frame's only one (picked by --plan, among several, or as the
  // expectation's recorded plan), or the expectation merged another plan's rows — a plain re-run of --expect could
  // otherwise pick a different plan
  const otherPlan = recordedPi !== undefined && planNow !== null && !samePlanFile(recordedPi.plan, planNow.file);
  const rerunPlanArg = planNow && (planNow.choice === "flag" || planNow.choice === "files" || planNow.choice === "recorded" || otherPlan) ? ` --plan ${planNow.file}` : "";
  const gone = opts.recordedPlanGone || null;
  const shaNow = planNow ? planInteractionsSha256(planNow.plan) : "";
  const planInteractionsChanged = !planNow || !(recordedPi ? shaNow !== recordedPi.sha256 : !!nowRows && nowRows.length > 0) ? null
    : !recordedPi ? `the plan's interactions[] changed since --expect (${planNow.file}: the expectation merged none) — re-run --expect${rerunPlanArg}`
    // the rows --expect merged came from ANOTHER plan file — name both, never advise only the one used now
    : otherPlan && planNow.choice === "flag" ? `the plan's interactions[] differ from those --expect merged (${planNow.file}, passed by --plan: sha256 ${shaNow.slice(0, 12)}…; --expect merged ${recordedPi.plan}'s${gone ? `, which ${gone}` : ""}: ${recordedPi.sha256.slice(0, 12)}…) — re-run --expect --plan ${planNow.file}${gone ? "" : `, or drop --plan at --compare to check against ${recordedPi.plan}`}`
    : otherPlan ? `the plan's interactions[] at --expect came from ${recordedPi.plan}, which ${gone ?? "--compare did not use"}; the plan found now, ${planNow.file}, declares others (sha256 ${recordedPi.sha256.slice(0, 12)}… at --expect, ${shaNow.slice(0, 12)}… now) — if that plan moved, re-run --compare … --plan <its path now>; otherwise re-run --expect … --plan <the plan you intend> (--plan ${planNow.file} to adopt this one)`
    : `the plan's interactions[] changed since --expect (${planNow.file}: sha256 ${recordedPi.sha256.slice(0, 12)}… at --expect, ${shaNow.slice(0, 12)}… now) — re-run --expect${rerunPlanArg}`;
  if (recordedPi && planNow && otherPlan && gone && !planInteractionsChanged) inputNotes.push(`the expectation merged plan interactions from ${recordedPi.plan}, which ${gone}; ${planNow.file} (used now) declares the same interactions[]`);
  if (recordedPi && !planNow) inputNotes.push(gone ? `the expectation merged plan interactions from ${recordedPi.plan}, which ${gone}, and no single plan describes this frame now — not checked; pass --compare … --plan <plan.json> (or re-run --expect … --plan <plan.json>)`
    : `the expectation merged plan interactions from ${recordedPi.plan}, but no plan was found for this frame now — not checked`);
  return { planNow, planInteractionsChanged };
}
/** the steps the probe replayed to reach the screen, against the plan's navigate[] (never the verdict) */
function reachInputOf(cx: CompareCtx, g: Pick<Graded, "planNow">): Pick<Graded, "reachInput"> {
  const { measured, inputNotes } = cx;
  const { planNow } = g;
  // the steps the probe replayed to reach the screen, against the plan's navigate[] — informational, never the verdict
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
    // the plan says how to reach the screen, the probe was never told — it measured the landing page
    inputNotes.push(`the plan declares navigate steps but the probe ran without --steps (${planNow.file}) — it measured whatever the URL shows first; re-run the probe with --steps ${planNow.file}`);
  }
  return { reachInput };
}
/** what the evidence is tied to (report.inputs) and whether anything rendered */
function evidenceInputs(
  cx: CompareCtx,
  g: Pick<Graded, "st" | "unboundNote" | "measuredRun" | "reachInput">,
): Pick<Graded, "probeIdentity" | "buildNow" | "inputs" | "staticOnly" | "artifactCheck" | "noRender"> {
  const { expectation, measured, opts, inputNotes } = cx;
  const { st, unboundNote, measuredRun, reachInput } = g;
  // ---- what the evidence is tied to
  // (an in-process caller can hand over any object: a probe that is not an identity reads as unknown, with a note)
  const probeRaw: unknown = measured.probe;
  const probeIdentity = isProbeIdentity(probeRaw) ? probeRaw : undefined;
  const buildRaw: unknown = measured.build;
  const buildNow = isBuildIdentity(buildRaw) ? buildRaw : undefined;
  if (buildRaw !== undefined && !buildNow && !inputNotes.some((n) => n.startsWith("measured.build "))) inputNotes.push("measured.build is not a build identity; ignored (build: unknown)");
  if (opts.status && opts.status.status === "v1") inputNotes.push(`${opts.status.file} is an older hand-written status (no run id, no shas) — not checked; write it with verify-screen --status`);
  // an unbound measured file (no run, measured after that run ended) is no run's — the ended run is named in its
  // input note only, never as the report's own run
  const runId = measuredRun ?? (st && unboundNote === undefined ? st.runId : undefined);
  if (probeRaw !== undefined && !probeIdentity && !inputNotes.some((n) => n.startsWith("measured.probe "))) inputNotes.push("measured.probe is not the shipped probe's identity; ignored (probe: unknown)");
  const inputs: VerifyReportV2["inputs"] = {
    expectationSchema: expectation.schema || "(none)",
    ...ifDefined("expectationSha256", opts.expectationSha256),
    ...ifDefined("measuredSha256", opts.measuredSha256),
    ...ifDefined("measuredAgainst", measured.expectationSha256 || undefined),
    // WHAT was measured, by content — the design (timestamps stripped)
    // and the code (sha256 of each file in the plan's files[], the hashes the Stop hook records).
    ...ifDefined("exportContentSha256", expectation.exportContentSha256 || undefined),
    ...ifDefined("code", opts.code || undefined),
    // Which probe produced these numbers: a hand-written probe is "unknown", and its numbers are not
    // comparable round to round — a changed probe changes what "measured" means.
    probe: probeIdentity ?? "unknown",
    ...ifDefined("waivers", opts.waiversInput || undefined),
    // the build the probe was served — "unknown" when it records none (a hand-written probe, an older one)
    build: buildNow ?? "unknown",
    ...ifDefined("runId", runId),
    ...ifDefined("reach", reachInput),
  };
  const staticOnly = measured.mode === "static-only";
  const artifactCheck = Array.isArray(opts.artifactCheck) ? opts.artifactCheck : null;
  const noRender = !!artifactCheck && !artifactCheck.some((a) => a.exists && a.image);
  return { probeIdentity, buildNow, inputs, staticOnly, artifactCheck, noRender };
}
/** the verdict, computed from the open items — integrity first */
function verdictOf(
  cx: CompareCtx,
  g: Pick<Graded,
    "fieldsNeverMeasured" | "componentsAbsent" | "integrity" | "interactionsFailed" | "interactionsNotProbed" | "interactionsDescoped" | "open" |
    "high" | "medium" | "accepted" | "planInteractionsChanged" | "staticOnly" | "noRender"
  >,
): Pick<Graded, "nodesExpected" | "reasons" | "lowConfidence" | "verdict"> {
  const { expectation, measured, legacy, specs, notMeasured, fieldsNotMeasured, fieldsReportedNull, folded } = cx;
  const {
    fieldsNeverMeasured, componentsAbsent, integrity, interactionsFailed, interactionsNotProbed, interactionsDescoped, open, high, medium,
    accepted, planInteractionsChanged, staticOnly, noRender,
  } = g;
  // The verdict is COMPUTED. Coverage first — how much was looked at decides what the rest is worth.
  // (a spec a plan anchor folded into a measured ancestor is out of the denominator)
  const nodesExpected = specs.length - folded.length;
  const reasons: string[] = [];
  // the run's integrity (computed above, before the interactions — probe rows bind to it), ranked FIRST.
  reasons.push(...integrity);
  const integrityFailed = integrity.length > 0;
  // a capped delta keeps its lower severity, but the match behind it is not trusted — any open one
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

  // Reasons come from OPEN items only. Nothing open, but something accepted or descoped → pass-with-deviations.
  const verdict: VerifyVerdict = reasons.length === 0 ? (accepted || interactionsDescoped.length ? "pass-with-deviations" : "pass")
    : integrityFailed ? "incomplete" : high || componentsAbsent.length || interactionsFailed.length ? "fail" : "incomplete";
  return { nodesExpected, reasons, lowConfidence, verdict };
}
/** report.coverage */
function coverageOf(
  cx: CompareCtx,
  g: Pick<Graded,
    "pageOverflow" | "fieldsNeverMeasured" | "bySet" | "untaggedInstanceSets" | "setsViaSharedPath" | "sharedShell" | "probeBound" |
    "interactions" | "interactionsFailed" | "interactionsNotProbed" | "interactionsPassed" | "interactionsUndesigned" | "interactionsDescoped" |
    "accepted" | "nodesExpected"
  >,
): Pick<Graded, "coverage"> {
  const { expectation, notMeasured, fieldsNotMeasured, unverifiable, fieldsChecked, nodesMeasured, nodesMatchedByComponentPath, matchedByCensus, folded } = cx;
  const {
    pageOverflow, fieldsNeverMeasured, bySet, untaggedInstanceSets, setsViaSharedPath, sharedShell, probeBound, interactions, interactionsFailed,
    interactionsNotProbed, interactionsPassed, interactionsUndesigned, interactionsDescoped, accepted, nodesExpected,
  } = g;
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
  return { coverage };
}
/** coverage against the previous round (never the verdict) */
function againstOf(cx: CompareCtx, g: Pick<Graded, "pageOverflow" | "probeIdentity" | "buildNow" | "nodesExpected">): Pick<Graded, "against"> {
  const { expectation, opts, specs, deltas, notMeasured, fieldsNotMeasured, unverifiable, nodesMeasured, absentGaps, placementGaps } = cx;
  const { pageOverflow, probeIdentity, buildNow, nodesExpected } = g;
  // ---- coverage against the previous round. Printed, recorded, and NEVER part of the verdict — a
  // round that measures 42 nodes where the last measured 185 is still judged on its own numbers, but it
  // cannot read as progress.
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
      // unknown when either side's hash is partial (bodies left out) — never "the same build" on a partial hash
      sameBuild: prevBuild && buildNow && !prevBuild.unhashed && !buildNow.unhashed ? prevBuild.assetsSha256 === buildNow.assetsSha256 : null,
    };
  }
  return { against };
}
/** the fidelity headline */
function headlineOf(
  cx: CompareCtx,
  g: Pick<Graded,
    "foreignTags" | "fieldsNeverMeasured" | "bySet" | "sharedShell" | "interactions" | "interactionsFailed" | "interactionsNotProbed" |
    "interactionsPassed" | "interactionsUndesigned" | "interactionsDescoped" | "unmatchedInteractionEvidence" | "inferredHead" |
    "inferredUndesigned" | "high" | "medium" | "accepted" | "highCauses" | "nodesExpected" | "lowConfidence" | "verdict" | "coverage" |
    "against"
  >,
): Pick<Graded, "headline"> {
  const { opts, keysSeen, unverifiable, fieldsChecked, nodesMeasured, folded, reopened } = cx;
  const {
    foreignTags, fieldsNeverMeasured, bySet, sharedShell, interactions, interactionsFailed, interactionsNotProbed, interactionsPassed,
    interactionsUndesigned, interactionsDescoped, unmatchedInteractionEvidence, inferredHead, inferredUndesigned, high, medium, accepted,
    highCauses, nodesExpected, lowConfidence, verdict, coverage, against,
  } = g;
  // the same build served although the code changed → the preview/dist was not rebuilt (never the verdict)
  const prevCode = opts.against && opts.against.report.inputs ? opts.against.report.inputs.code : undefined;
  // only the files BOTH reports hashed — a key the previous report never recorded (a mapped module, a file just
  // added to files[]) says nothing about whether the code changed; none in common → the git commits
  const codeNow = opts.code ? opts.code.files : {};
  const common = prevCode ? Object.keys(prevCode.files).filter((f) => Object.hasOwn(codeNow, f)) : [];
  const codeChanged = prevCode && opts.code ? (common.length ? common.some((f) => prevCode.files[f] !== codeNow[f])
    : !!(prevCode.gitHead && opts.code.gitHead && prevCode.gitHead !== opts.code.gitHead)) : false;
  const sameBuildServed = !!(against && against.sameBuild === true && codeChanged);
  const lost = against && against.deltas ? against.deltas.lostCoverage.length : 0;
  const unmatchedCount = unmatchedInteractionEvidence.length;
  const fell = against && against.nodesMeasured.before !== null && against.nodesMeasured.after < against.nodesMeasured.before;
  const mark = verdict.toUpperCase();
  // The headline's NEVER MEASURED slot is for a key the probe got wrong everywhere. One node
  // that states a field says nothing about the probe — its gap is already listed under that node (a real pull read
  // "'y' present in 0 of 74 measurements" off the frame root's one y).
  // A key no measured node carries at all is systemic too, however few specs state it (e.g. `fill`).
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
    // unmatched probe results — informational, never the verdict
    (unmatchedCount ? ` · ${unmatchedCount} probe result(s) matched no designed interaction` : "") +
    (inferredHead ? ` · ${inferredHead} inferred (not designed${inferredUndesigned ? `; the ${inferredUndesigned} undesigned interaction(s) are counted above` : ""})` : "") +
    (lost ? ` · LOST COVERAGE on ${lost} earlier delta(s)` : "") +
    (foreignTags ? ` · ${foreignTags.total} foreign tag(s) (${foreignTags.prefixDrift} prefix drift, ${foreignTags.alias} alias, ${foreignTags.unknown} unknown)` : "") +
    (sameBuildServed && against ? ` · SAME BUILD SERVED as ${against.report} although the code changed (stale preview/dist?)` : "");
  return { headline };
}
/** report.visual, with the plan's "reference" deviations marked illustrative */
function visualOf(cx: CompareCtx, g: Pick<Graded, "rootF" | "planNow">): Pick<Graded, "visual"> {
  const { measured, opts, inputNotes } = cx;
  const { rootF, planNow } = g;
  // ---- the plan's deviations with field "reference" — the reference PNG is illustrative for those nodes
  // (the designer drew a stand-in there). Shown on the VISUAL line and in the input notes; it never waives or changes a
  // delta (only an owner's waiver does).
  const visual = visualReport(measured.visual, opts.visualMalformed === true, { diff: opts.visualDiff ?? null, against: opts.against ?? null, noProbe: !isProbeIdentity(measured.probe) });
  const devs: unknown[] = planNow && Array.isArray(planNow.plan.deviations) ? planNow.plan.deviations : [];
  const illustrative: NonNullable<ReportVisual["illustrative"]> = [];
  for (const d of devs) {
    if (!isJsonObject(d) || d.field !== "reference") continue;
    const ids = [...(typeof d.nodeId === "string" && d.nodeId ? [d.nodeId] : []), ...(Array.isArray(d.nodeIds) ? d.nodeIds.filter((x): x is string => typeof x === "string" && x !== "") : [])];
    const reason = typeof d.reason === "string" && d.reason ? d.reason : typeof d.what === "string" ? d.what : "";
    for (const id of ids.length ? ids : typeof rootF.nodeId === "string" ? [rootF.nodeId] : []) illustrative.push({ nodeId: id, reason });
  }
  if (illustrative.length && planNow) {
    visual.illustrative = illustrative;
    visual.headline += ` (the plan marks the reference illustrative for ${illustrative.length} node(s))`;
    inputNotes.push(`${planNow.file} marks the reference PNG illustrative (deviations field "reference") for ${illustrative.map((r) => r.nodeId).join(", ")} — the visual diff there shows a stand-in; no delta is waived or changed`);
  }
  return { visual };
}
/** the report */
function reportOf(
  cx: CompareCtx,
  g: Pick<Graded,
    "measuredIdsNotInExpectation" | "foreignTags" | "untaggedInstanceSetsInShell" | "untaggedOnScreen" | "componentsAbsent" | "integrity" |
    "interactionEvidenceOnHidden" | "interactions" | "interactionsFailed" | "interactionsNotProbed" | "interactionsUndesigned" |
    "interactionsDescoped" | "unexpectedInteractionEvidence" | "unmatchedInteractionEvidence" | "inferred" | "applied" | "open" | "high" |
    "medium" | "accepted" | "highCauses" | "inputs" | "staticOnly" | "artifactCheck" | "reasons" | "lowConfidence" | "verdict" | "coverage" |
    "against" | "headline" | "visual"
  >,
): VerifyReportV2 {
  const {
    expectation, measured, opts, hiddenSet, byId, duplicateNodeIds, unknownKeys, deltas, notMeasured, fieldsNotMeasured, unverifiable, folded,
    inputNotes, reopened, unused,
  } = cx;
  const {
    measuredIdsNotInExpectation, foreignTags, untaggedInstanceSetsInShell, untaggedOnScreen, componentsAbsent, integrity,
    interactionEvidenceOnHidden, interactions, interactionsFailed, interactionsNotProbed, interactionsUndesigned, interactionsDescoped,
    unexpectedInteractionEvidence, unmatchedInteractionEvidence, inferred, applied, open, high, medium, accepted, highCauses, inputs, staticOnly,
    artifactCheck, reasons, lowConfidence, verdict, coverage, against, headline, visual,
  } = g;
  return {
    schema: REPORT_SCHEMA,
    ...ifDefined("screen", expectation.screen),
    ...ifDefined("exportedAt", expectation.exportedAt),
    measuredAt: measured.measuredAt || new Date().toISOString(),
    renderer: measured.renderer || "unknown",
    ...ifDefined("viewport", measured.viewport),
    artifacts: artifactCheck || (Array.isArray(measured.artifacts) ? measured.artifacts : []),
    // --record-plan records a static-only run as static-only, with its why
    ...(staticOnly ? { mode: "static-only" as const, ...ifDefined("reason", measured.reason || undefined) } : {}),
    inputs,
    verdict,
    headline,
    // copied and counted, read by nothing above
    behaviour: behaviourReport(measured.behaviour, opts.behaviourMalformed === true),
    // copied, read by nothing above
    visual,
    why: reasons,
    integrity,
    coverage,
    summary: { high, medium, low: open.filter((d) => d.severity === "low").length, componentsAbsent: componentsAbsent.length, interactionsFailed: interactionsFailed.length, interactionsNotProbed: interactionsNotProbed.length,
      accepted, descoped: interactionsDescoped.length, undesigned: interactionsUndesigned.length, inferred: inferred.length, highCauses, lowConfidence },
    deltas: deltas.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]),
    componentsAbsent,
    untaggedInstanceSets: untaggedOnScreen,
    ...(untaggedInstanceSetsInShell.length ? { untaggedInstanceSetsInShell } : {}),
    interactions,
    ...(inferred.length ? { inferred } : {}),
    notMeasured,
    fieldsNotMeasured,
    unverifiable,
    notComparable: expectation.notComparable || [],
    waivers: { applied, reopened, unused },
    folded,
    probe: {
      unknownKeys: [...unknownKeys].map(([key, count]) => ({ key, count, ...ifDefined("canonical", KEY_HINTS[key]) })),
      unknownTopLevelKeys: Object.keys(measured).filter((k) => !Object.hasOwn(MEASURED_TOP_KEYS, k) && !MEASURED_UNTYPED_TOP_KEYS.has(k)).map((key) => ({ key, ...ifDefined("canonical", TOP_KEY_HINTS[key]) })),
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

// ---------------------------------------------------------------- visual diff (never the verdict)
// compare() copies measured.visual into report.visual; nothing else in compare reads it, so the verdict, why[],
// integrity, summary, coverage, deltas and the fidelity headline are the same with or without it.
export const VISUAL_NO_BLOCK = "the measured file carries no visual diff (hand-written, or a probe that predates the visual diff)";
/** a measured file with no probe block (hand-written, a non-web stack) — the visual diff is a web-probe step */
export const VISUAL_NOT_APPLICABLE = "not applicable (no web probe)";
export const VISUAL_MALFORMED = "the measured file's visual block is malformed — ignored (see the input notes)";
const VISUAL_PREFIX = "VISUAL (informational — never the verdict) — ";
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
 *  file); absent = the recorded path, checked as-is. `against` = the previous round's report. */
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
  // the previous round's percentage, only when it diffed the same reference on the same grid
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

// ---------------------------------------------------------------- behaviour / a11y (never the verdict)
// compare() copies measured.behaviour into report.behaviour and counts it; nothing else in compare reads it, so the
// verdict, why[], integrity, summary, coverage, deltas and the fidelity headline are the same with or without it.
const BEHAVIOUR_ORDER: Record<BehaviourStatus, number> = { fail: 0, warn: 1, "not-run": 2, unsupported: 3, pass: 4 };
export const BEHAVIOUR_NO_BLOCK = "the measured file carries no behaviour checks (hand-written, or a probe that predates the behaviour checks)";
export const BEHAVIOUR_MALFORMED = "the measured file's behaviour block is malformed — ignored (see the input notes)";
/** how accessible names were obtained — never a screen reader. */
export const NAMES_LABEL = "names computed by Playwright (Chromium), not screen-reader verified";
const BEHAVIOUR_PREFIX = "BEHAVIOUR/A11Y (not the fidelity verdict) — ";
/** A "+N more" row (the elements past the per-element cap): the probe marks it evidence.more === true, and evidence.count
 *  says how many elements it stands for. Never keyed on the row's wording. */
function moreCount(c: BehaviourCheck): number | null {
  const ev = c.evidence;
  const n = ev ? ev.count : undefined;
  if (!ev || c.status === "pass" || typeof n !== "number" || !Number.isInteger(n) || n <= 0) return null;
  if (ev.more === true) return n;
  // FALLBACK (measured files written before evidence.more — an older probe only): its exact "+N more" detail, with N
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
  // readableMeasured dropped a block that was there (malformed) — not the same as a probe that wrote none
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
