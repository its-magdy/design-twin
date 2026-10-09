// verify-shared.ts — what verify-screen's expectation (--expect) and its comparison (--compare) must agree on: the
// tolerances, the value normalisers, the spec fields compared one-to-one and the measured keys a probe is told to send,
// the schema names, and the small helpers both sides — and the shipped probe (verify-probe.ts, probe-visual.ts) — share.
// A library with no CLI: importing it never loads verify-screen.ts.
import path from "node:path";
import { colorKey, formatHex, parseCssColor } from "./color.ts";
import type { Plan, VerifyExpectation } from "./types.ts";

// ---------------------------------------------------------------- tolerances
//
// Every tolerance is a deliberate claim about what a browser may legitimately do differently from
// Figma, NOT a fudge factor for sloppy building. They are tight on purpose: the live run's misses
// were 20-vs-18px font, 16-vs-14px, radius 20-vs-12, gap 23.5-vs-16, row 50-vs-48 — every one of
// them lands outside these, which is the point.
export const TOLERANCE = {
  fontSize: 0.5, // a browser rounds; a different token does not
  fontWeight: 0, // 500 vs 600 is a different style, never a rendering artifact
  lineHeight: 2, // normal/unitless line-heights and font-metric rounding genuinely differ
  letterSpacing: 0.2,
  radius: 0.5,
  padding: 1,
  gap: 1,
  // 1, not 2: a 2px box error is exactly a border put on the wrong side of the box — the filter button
  // measured 111.83×38 against 110×36, which an inclusive 2px tolerance would let through.
  size: 1,
  // Frame-relative x/y. Loose enough for sub-pixel layout and a glyph's side-bearing, tight enough that
  // a column 18.94px out of place or a bar 130px below the frame cannot hide.
  position: 2,
  opacity: 0.02,
  // a stroke's own tolerance, inclusive — a lost 1px border (1 → 0) is a delta; the padding tolerance (1) would let it pass
  stroke: 0.5,
  // a fixed/fill-width TEXT's INK width (renderBox.w) against a Range's width (the layout advance box,
  // side bearings included). Empirical: hand-written textBox.w − renderBox.w was −0.63..+2.41 px (p5..p95, n=157)
  // in the field runs. Known miss: heavy italics/overhang can exceed it.
  textInk: 3,
};

// Colours compare exactly after normalisation. There is no "close enough" colour: the live run's
// chip was #03d5ab where the export said #007d6c, which any perceptual threshold loose enough to
// call a rendering artifact would also have let through.
export function normColor(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  const key = colorKey(s); // color.ts: every hex spelling -> "#rrggbbaa"
  if (key) return key;
  const c = parseCssColor(s); // color.ts: rgb()/rgba() as the probe reads them back, transparent, oklab()/oklch()
  if (c === null) return s;
  if (c.a === 0) return "transparent"; // rgba(0,0,0,0) is "no background", whatever the channels say
  return colorKey(formatHex(c)) ?? s;
}

// Figma names weights ("SemiBold"); CSS uses numbers. Compare on the number, because that is what a
// browser actually applies — and because "Medium" rendering as 600 is precisely the live bug.
const WEIGHTS: Record<string, number> = {
  thin: 100, extralight: 200, ultralight: 200, light: 300, normal: 400, regular: 400, book: 400,
  medium: 500, semibold: 600, demibold: 600, bold: 700, extrabold: 800, ultrabold: 800, black: 900, heavy: 900,
};
export function normWeight(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const key = s.toLowerCase().replace(/[^a-z]/g, "");
  return WEIGHTS[key] != null ? WEIGHTS[key] : null;
}

// Figma stores a family as one name; CSS reports the whole stack. A match on the FIRST family is the
// honest comparison — the fallbacks are the builder's business.
export function normFamily(v: unknown): string | null {
  if (v == null) return null;
  // ?? "": split() always returns at least one piece, so the fallback never applies
  return (String(v).split(",")[0] ?? "").trim().replace(/^['"]|['"]$/g, "").toLowerCase();
}

// The producer writes a LengthSpec ({value, unit: "px"|"percent"|"auto"}); this also accepts a measured number/string
// and the older upper-case units, so its input is declared wide here rather than in types.ts.
type LineHeightInput = number | string | { unit?: string; value?: number } | null | undefined;

export function lineHeightPx(lh: LineHeightInput, fontSize: number | string | undefined): number | null {
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

// the schema an expectation (--expect) and a report (--compare) carry
export const EXPECTATION_SCHEMA = "designtwin/verify-expectation@2";
export const REPORT_SCHEMA = "designtwin/verify-report@2";

// small numeric helpers: a finite number, rounded to 2 decimals, a measured px length, four CSS sides
export const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
export const r2 = (v: number): number => Math.round(v * 100) / 100;
// A measured length as a probe hands it over: a number, or getComputedStyle's own resolved string —
// "20px", "0.15px", "3.35544e+07px" (a pill radius). A percentage, another unit, a keyword or an object is
// not a px value (null): `Number("20px")` is NaN, which would make the string "differ" from 20.
const PX_RE = /^\s*[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?(?:px)?\s*$/i;
export function cssPx(v: unknown): number | null {
  if (num(v)) return v;
  if (typeof v !== "string" || !PX_RE.test(v)) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}
// Four sides/corners in CSS order (t r b l / tl tr br bl) from a number, a list of 1-4 lengths, or a
// shorthand string — CSS's own 1-to-4 value expansion. null when any part is not a px length.
export function fourSides(v: unknown): [number, number, number, number] | null {
  const parts: unknown[] = num(v) ? [v] : Array.isArray(v) ? v : typeof v === "string" ? v.trim().split(/\s+/) : [];
  const p = parts.map(cssPx);
  if (p.length < 1 || p.length > 4 || p.some((x) => x === null)) return null;
  const [p0, p1 = p0, p2 = p0, p3 = p1] = p.filter((x): x is number => x !== null);
  return p0 === undefined || p1 === undefined || p2 === undefined || p3 === undefined ? null : [p0, p1, p2, p3];
}

export const PAD_SIDES = ["top", "right", "bottom", "left"] as const;
export type PadSide = (typeof PAD_SIDES)[number];

// the notComparable field a line box taller than its fixed text box is listed under; --compare hangs the
// same why on a line-height delta of that node.
export const TEXT_BOX_HEIGHT = "text box height";

/** An expectation as READ BACK from disk (or built here): every field may be absent. */
export type Expectation = Partial<VerifyExpectation>;

/** `base` joined with a "/"-separated relative path, resolved, when it lies strictly inside `within` (default `base`) — else
 *  null (a pointer or a referenceImage.path with `..` segments never reads a file outside design/export). Lexical only:
 *  no file is touched. Shared by --expect and the probe (probe-visual.ts). */
export function resolveInside(base: string, rel: string, within: string = base): string | null {
  const root = path.resolve(within), file = path.resolve(base, ...rel.split("/"));
  return file.startsWith(root + path.sep) ? file : null;
}

/** The spec fields compared one-to-one against a measured style of the same name. */
type FieldKey = "fontFamily" | "fontSize" | "fontWeight" | "lineHeight" | "letterSpacing" | "color" | "backgroundColor" | "fill" | "placeholderColor"
  | "borderColor" | "borderWidth" | "borderRadius" | "gap" | "width" | "height" | "x" | "y" | "opacity";
export interface Field { key: FieldKey; tol: number | null; norm?: (v: unknown) => string | number | null; label: string; unit?: string; high?: boolean; colour?: boolean; box?: boolean; optional?: boolean }

export const FIELDS: Field[] = [
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
// (`display` — an id on an inline element measures its text's box, not a frame's)
export const STYLE_KEYS: readonly string[] = [...FIELDS.map((f) => f.key), "padding", "gapVisual", "text", "tag", "textBox", "placeholderText", "display"];
const STYLE_KEY_SHAPE: Record<string, string> = {
  borderRadius: "number | [tl,tr,br,bl]", padding: "[t,r,b,l]", fill: "an SVG's paint", textBox: "{x,w} of a Range over the text",
  placeholderText: "el.placeholder", placeholderColor: "the ::placeholder colour", tag: "tagName, lower-case",
  display: "getComputedStyle(el).display",
};

export const MEASURED_KEYS_DOC: Record<string, string> = {
  "nodes[].nodeId": "the Figma node id the measurement is FOR (from data-dt-node, or matched by text/position)",
  // GENERATED from STYLE_KEYS, so the list a probe is told to send cannot drift from the list compared (`fill` must be in it)
  "nodes[].styles": `computed values, EVERY key on every node — lengths as px numbers (a "20px" string is read as 20; %, other units and keywords are not) — (null when it cannot be read, with the reason under unmeasured): ${STYLE_KEYS.map((k) => k + (STYLE_KEY_SHAPE[k] ? ` (${STYLE_KEY_SHAPE[k]})` : "")).join(" ")}`,
  "nodes[].unmeasured": "{<styles key>: why} for every styles key reported null — a null is listed as not measured, never as checked",
  "nodes[].styles.fill": "an SVG's paint: getComputedStyle(<path|rect|circle>).fill — never background-color",
  "nodes[].styles.textBox": "{x,w} of a Range over a TEXT node's characters, frame-relative — required for every TEXT node: its x/width are never read off the element's box",
  "nodes[].styles.display": "getComputedStyle(el).display — a FRAME/INSTANCE id on an inline element measures its text's box, not a frame's",
  "nodes[].styles.strokeFrom / strokeAlign": "where borderWidth/borderColor were read: border, or a ring (box-shadow spread / outline) and its side (inside | outside)",
  "nodes[].styles.gapVisual": "the rendered distance between consecutive children — required for a <table> (border-spacing, not gap)",
  "nodes[].styles.placeholderText / placeholderColor": "el.placeholder / the ::placeholder colour (getComputedStyle(el,'::placeholder').color or the stylesheet rule)",
  "nodes[].styles.tag": "the element's tagName, lower-case",
  "nodes[].styles.textTransform": "getComputedStyle(el).textTransform of a TEXT node's element (inherited) — optional; with it the build's RENDERED string is compared with the design's (spec textCase)",
  "nodes[].styles.paintedBy": "{backgroundColor, via: ancestor|child, tag, depth} — optional: when the element's own background is transparent, the nearest containing ancestor (or same-box child) that paints it",
  "nodes[].states.<hover|pressed|focus>": "the same styles, measured with the OWNER in that state (the spec's drawnStateFrom, else the node itself) — required for a node whose spec has drawnState; beside styles, never inside it; a state on a node whose spec has no drawnState is not compared (listed under Inferred, not designed)",
  "inferred[]": "{nodeId?, state, built, why?} — something the build does that the design never drew (an error message, an empty list, an open state): listed under Inferred, not designed; never graded",
  "interactions[]": "{nodeId, trigger, ok: true|false|null, selector, selectorCount, detail} — `ok:true` needs the selector you drove and how many elements it matched (>=1); ok:null = not probed",
  "components[]": "{setName|nodeId, present: true|false} — present:false is an explicit claim of absence",
  "notMeasured[]": "{nodeId, why} for every spec the probe could not find — the one top-level key for it (not notFound/notFoundInDom); other unknown top-level keys are listed in the report",
  "expectationSha256": "sha256 of the .expected.json you measured against",
};

/** A percentage for a headline: 1 decimal, "<0.1" for a non-zero value that rounds to 0 (the probe's stderr line uses it too). */
export const pctText = (n: number): string => (n > 0 && n < 0.05 ? "<0.1" : (Math.round(n * 10) / 10).toFixed(1));

// a value as a report prints it (a list as a/b/c)
export const fmt = (v: unknown): string => (Array.isArray(v) ? v.join("/") : String(v));

/** How a plan was chosen for a frame: "flag" = --plan, "only" = the one plan that describes it, "files" = the one
 *  of several that lists files[] (the plan the build is tied to), "recorded" = --compare's: the plan file the expectation
 *  merged interactions from (planInteractions.plan), when another plan (or none) is found now. */
type PlanChoice = "flag" | "only" | "files" | "recorded";
export interface ChosenPlan { file: string; plan: Plan; choice?: PlanChoice }

/** Two spellings of one plan file (`./design/plan/x.json`, an absolute path) are the same plan. */
export function samePlanFile(a: string, b: string): boolean { return path.resolve(a) === path.resolve(b); }
