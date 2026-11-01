// verify-shared.ts — what verify-screen's expectation (--expect) and its comparison (--compare) must agree on: the
// tolerances, the value normalisers, the spec fields compared one-to-one and the measured keys a probe is told to send,
// the schema names, and the small helpers both sides — and the shipped probe (verify-probe.ts, probe-visual.ts) — share.
// A library with no CLI: importing it never loads verify-screen.ts.
import { colorKey, formatHex, parseCssColor } from "./color.ts";
import type { VerifyExpectation } from "./types.ts";

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
  if (/^\d+(?:\.\d+)?$/.test(s)) return Number(s); // a computed weight may be fractional ("650.5" — CSS Fonts 4 §2.2)
  // a style name carries the slant beside the weight ("Semibold Italic", "Bold Oblique"); a bare "Italic" is the regular weight's
  const name = s.toLowerCase().replace(/[^a-z]/g, "");
  const key = name === "italic" || name === "oblique" ? "regular" : name.replace(/(italic|oblique)$/, "");
  return WEIGHTS[key] != null ? WEIGHTS[key] : null;
}
// CSS Fonts 4 §2.2: a numeric font-weight is valid from 1 to 1000 — and a variable font's `wght` axis is that same scale
const cssWeight = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 1000 ? v : null);
/** The weight a font descriptor states, as the number CSS applies. Figma's numeric `fontWeight` (`weightValue`) first —
 *  it is what the build is told to emit as font-weight (ir-fields.md) — then the applied `wght` axis of a variable font
 *  (`variationSettings`, an export without weightValue), then the style name ("SemiBold", "Bold Italic"). */
export function fontWeightOf(f: { weight?: string; weightValue?: number; variationSettings?: Record<string, number> }): number | null {
  return cssWeight(f.weightValue) ?? cssWeight(f.variationSettings ? f.variationSettings.wght : undefined) ?? cssWeight(normWeight(f.weight));
}

// Figma stores a family as one name; CSS reports the whole stack. A match on the FIRST family is the
// honest comparison — the fallbacks are the builder's business.
export function normFamily(v: unknown): string | null {
  if (v == null) return null;
  // ?? "": split() always returns at least one piece, so the fallback never applies
  return (String(v).split(",")[0] ?? "").trim().replace(/^['"]|['"]$/g, "").toLowerCase();
}

// The producer writes a LengthSpec ({value, unit: "px"|"percent"|"auto"}, figma-plugin/src/text.ts lenUnit); this also
// accepts a measured number/string and Figma's own upper-case units (PIXELS/PERCENT/AUTO), so its input is declared wide
// here rather than in types.ts. A percent is of the FONT SIZE (the REST API's lineHeightPercentFontSize; Figma's CSS for a
// 14px 150% line: `150% /* 21px */`) — a font size that is "mixed" or absent resolves nothing.
type LineHeightInput = number | string | { unit?: string; value?: number } | null | undefined;

export function lineHeightPx(lh: LineHeightInput, fontSize: number | string | undefined): number | null {
  if (lh == null) return null;
  if (typeof lh === "number") return lh;
  const size = typeof fontSize === "number" ? fontSize : typeof fontSize === "string" ? Number(fontSize) : NaN;
  const of = (factor: number): number | null => (Number.isFinite(size) && size > 0 && Number.isFinite(factor) ? r2(factor * size) : null);
  if (typeof lh === "string") {
    const s = lh.trim().toLowerCase();
    if (s === "normal") return null; // genuinely unknowable without the font metrics — not a mismatch
    const n = parseFloat(s);
    if (Number.isNaN(n)) return null;
    if (s.endsWith("%")) return of(n / 100);
    if (s.endsWith("px")) return n;
    return of(n); // unitless multiplier
  }
  if (typeof lh === "object") {
    const unit = String(lh.unit ?? "px").toLowerCase();
    if (unit === "percent" || unit === "%") return typeof lh.value === "number" ? of(lh.value / 100) : null;
    if (unit === "auto") return null;
    if (unit === "px" || unit === "pixels") return typeof lh.value === "number" ? lh.value : null;
    return null; // a unit this reader does not know is no px value
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

/** A reference scale as printed (4 decimals): the value itself stays exact — 2048/1440 is captured as 1.4222222…. */
export const scaleText = (n: number): string => `${Math.round(n * 10000) / 10000}x`;

// ---------------------------------------------------------------- the property table
//
// Every property --compare checks on a measured node, one row each (CHECK_ORDER is the order they are walked). A row says
// which spec value states it and which measured value it is read from (its shapes), the element rules under which it is
// not this element's to show (`applies`), and how it is compared. A property stated more than one way — one radius or
// four corners, one border width or four sides — is ONE row with a shape per way. verify-compare.ts reads the table: one
// admissibility pass words every gap (not reported, null, unreadable, impossible) the same way for every row, and one
// comparer per `compare` kind judges the value. The registries below (FIELDS, STYLE_KEYS, measuredKeysDoc, the paint,
// leaf and inline sets) are derived from it.

/** The element rules under which a property is not this element's to show, tried in this order — each worded once in
 *  verify-compare.ts (RULES). */
export const RULES = [
  "drawnState", // a colour of a layer the designer drew in a state, measured at rest
  "revealed", // the opacity of any layer inside a drawn state, measured at rest (hover-revealed content reads 0)
  "tableRow", // padding on a <tr>: it lives on the cells
  "leaf", // a FRAME/INSTANCE id spread onto a leaf <input>/<img>/<svg> inside the element that implements it
  "inline", // a FRAME/INSTANCE id on an inline element, whose box is its text's
  "rowTag", // a radius on a table row or row group, which draws none
  "textDiffers", // a TEXT's x/width while its copy differs
  "textBoxAbsent", // a TEXT's x/width without a textBox
  "textOnContainer", // a TEXT's box read off a container element
  "boxOnContainer", // a TEXT's box width read off a container element
  "textHeight", // a TEXT's height from a Range — the font's content area, not the line box (skipped, not listed)
  "tableGap", // a gap on a <table>, which spaces rows with border-spacing
] as const;
export type Rule = (typeof RULES)[number];

/** How a measured value is read: through the row's normaliser, as one px length, as four corners or four sides (CSS's
 *  1-to-4 expansion), or as a string. */
export type Parse = "norm" | "px" | "corners" | "sides" | "string";
/** How a shape is compared — one comparer each in verify-compare.ts (COMPARE). */
export type CompareKind = "field" | "textBox" | "corners" | "sides" | "padding" | "placeholder" | "copy";
/** The spec values a shape can state. */
export type SpecKey = "fontFamily" | "fontSize" | "fontWeight" | "lineHeight" | "letterSpacing" | "color" | "backgroundColor" | "fill" | "placeholderColor"
  | "borderColor" | "borderWidth" | "borderWidths" | "borderRadius" | "radiusCorners" | "gap" | "width" | "height" | "x" | "y" | "opacity" | "boxWidth" | "padding"
  | "placeholderText" | "text";

/** The styles keys a shape reads its value from. */
export type MeasuredKey = Exclude<SpecKey, "radiusCorners" | "boxWidth"> | "borderWidths";

/** One way a property is stated and measured. */
export interface PropertyShape {
  /** the spec value that states it */
  spec: SpecKey;
  /** the findings' field; a shape with `parts` lists its deltas per part, `${label} (${part})` */
  label: string;
  parts?: readonly string[];
  /** the styles key read, and the key coverage counts it under (a probe that never sent it) */
  measured: MeasuredKey;
  census: string;
  /** where else the value is read from: a TEXT's x/width from its textBox, a gap from gapVisual */
  read?: "textBox" | "gapVisual";
  parse: Parse;
  compare: CompareKind;
  tol: number | null;
  /** a variant of the shape after it for the same spec value — a fixed/fill-width TEXT's width is its ink width */
  when?: "textInk";
  /** a measured value below 0 is a measuring artefact (CSS cannot make it negative) */
  nonNegative?: boolean;
  /** what "could not read … as" / "is impossible for" call a four-value measurement */
  as?: string;
  noun?: string;
  /** how the probe sends the measured key (measuredKeysDoc) */
  doc?: string;
  /** the wording when the measured key is absent (the default is ABSENT) or null (the probe's reason first) — or
   *  `unlisted`: an absent value is lost coverage but no row of its own */
  absentWhy?: string;
  absent?: "unlisted";
  nullWhy?: string;
  /** the spec value means the node paints or carries copy — it is built, never folded into an ancestor */
  paints?: boolean;
}
export interface Property {
  key: string;
  shapes: readonly PropertyShape[];
  applies: readonly Rule[];
  norm?: (v: unknown) => string | number | null;
  unit?: string;
  high?: boolean;
  colour?: boolean;
  box?: boolean;
  /** not readable by getComputedStyle(el): absent is unverifiable, never not measured */
  optional?: boolean;
  /** typography a TEXT reads off its element — a container's, without the probe naming the text run */
  typography?: boolean;
  /** paint that is pixels on these elements (an <img>'s SVG) — unverifiable, before it is counted */
  pixels?: boolean;
}

const BOX_RULES = ["leaf", "inline"] as const;
const CORNERS = ["top-left", "top-right", "bottom-right", "bottom-left"] as const;
/** a property compared one value against one value of the same name */
const field = (key: Extract<SpecKey, MeasuredKey>, label: string, tol: number | null, extra: Partial<PropertyShape> = {}): PropertyShape =>
  ({ spec: key, label, measured: key, census: key, parse: tol !== null && !extra.parse ? "px" : "norm", compare: "field", tol, ...extra });

export const PROPERTIES: readonly Property[] = [
  { key: "fontFamily", norm: normFamily, typography: true, applies: [], shapes: [field("fontFamily", "font-family", null)] },
  { key: "fontSize", unit: "px", high: true, typography: true, applies: [], shapes: [field("fontSize", "font-size", TOLERANCE.fontSize, { nonNegative: true, paints: true })] },
  { key: "fontWeight", norm: normWeight, high: true, typography: true, applies: [], shapes: [field("fontWeight", "font-weight", TOLERANCE.fontWeight, { parse: "norm" })] },
  { key: "lineHeight", unit: "px", typography: true, applies: [], shapes: [field("lineHeight", "line-height", TOLERANCE.lineHeight, { nonNegative: true })] },
  { key: "letterSpacing", unit: "px", typography: true, applies: [], shapes: [field("letterSpacing", "letter-spacing", TOLERANCE.letterSpacing)] },
  { key: "color", norm: normColor, high: true, colour: true, typography: true, applies: ["drawnState"], shapes: [field("color", "color", null, { paints: true })] },
  { key: "backgroundColor", norm: normColor, high: true, colour: true, applies: ["drawnState", "leaf"], shapes: [field("backgroundColor", "background", null, { paints: true })] },
  { key: "fill", norm: normColor, high: true, colour: true, pixels: true, applies: ["drawnState"], shapes: [field("fill", "fill (SVG paint)", null, { paints: true, doc: "an SVG's paint" })] },
  { key: "placeholderColor", norm: normColor, high: true, colour: true, optional: true, applies: ["drawnState"],
    shapes: [field("placeholderColor", "placeholder colour", null, { doc: "the ::placeholder colour",
      absentWhy: "a ::placeholder colour is not readable from getComputedStyle(el) — report placeholderColor to have it checked" })] },
  { key: "borderColor", norm: normColor, colour: true, applies: ["drawnState", "leaf"], shapes: [field("borderColor", "border-color", null, { paints: true })] },
  // one border width, or four sides (a divider with only a bottom stroke) — read off a border, or a ring (box-shadow/outline)
  { key: "border", unit: "px", applies: ["leaf"], shapes: [
    field("borderWidth", "border-width", TOLERANCE.stroke, { nonNegative: true, paints: true }),
    { spec: "borderWidths", label: "border-width", parts: PAD_SIDES, measured: "borderWidths", census: "borderWidths", parse: "sides", compare: "sides", tol: TOLERANCE.stroke,
      as: "px border widths [t,r,b,l]", noun: "a border width", doc: "[t,r,b,l] — a ring's sides when it draws the stroke", paints: true },
  ] },
  // one radius, or four unequal corners (a table header rounded only at the top) — both read off borderRadius
  { key: "radius", unit: "px", applies: [...BOX_RULES, "rowTag"], shapes: [
    field("borderRadius", "border-radius", TOLERANCE.radius, { parse: "corners", as: "a px radius", noun: "a radius", doc: "number | [tl,tr,br,bl]", paints: true }),
    { spec: "radiusCorners", label: "border-radius", parts: CORNERS, measured: "borderRadius", census: "borderRadius", parse: "corners", compare: "corners", tol: TOLERANCE.radius,
      as: "a px radius", noun: "a radius", paints: true },
  ] },
  { key: "gap", unit: "px", applies: ["leaf", "tableGap"], shapes: [field("gap", "gap", TOLERANCE.gap, { read: "gapVisual", nonNegative: true })] },
  { key: "width", unit: "px", box: true, applies: [...BOX_RULES, "textDiffers", "textBoxAbsent", "textOnContainer"], shapes: [
    field("width", "width (text ink)", TOLERANCE.textInk, { when: "textInk", read: "textBox", nonNegative: true }),
    field("width", "width", TOLERANCE.size, { read: "textBox", nonNegative: true }),
  ] },
  { key: "height", unit: "px", box: true, applies: [...BOX_RULES, "textOnContainer", "textHeight"], shapes: [field("height", "height", TOLERANCE.size, { nonNegative: true })] },
  { key: "x", unit: "px", box: true, applies: [...BOX_RULES, "textDiffers", "textBoxAbsent", "textOnContainer"], shapes: [field("x", "x (frame-relative)", TOLERANCE.position, { read: "textBox" })] },
  { key: "y", unit: "px", box: true, applies: [...BOX_RULES, "textOnContainer"], shapes: [field("y", "y (frame-relative)", TOLERANCE.position)] },
  { key: "opacity", applies: ["revealed"], shapes: [field("opacity", "opacity", TOLERANCE.opacity, { nonNegative: true, paints: true })] },
  // a fixed-width TEXT's box in a parent that hugs its width: the width of the text's own element
  { key: "textBoxWidth", unit: "px", applies: ["boxOnContainer"],
    shapes: [{ spec: "boxWidth", label: "width (text box)", measured: "width", census: "width", parse: "px", compare: "textBox", tol: TOLERANCE.size, nonNegative: true }] },
  { key: "padding", unit: "px", applies: ["tableRow", ...BOX_RULES],
    shapes: [{ spec: "padding", label: "padding", measured: "padding", census: "padding", parse: "sides", compare: "padding", tol: TOLERANCE.padding, as: "px padding [t,r,b,l]", noun: "padding", doc: "[t,r,b,l]" }] },
  { key: "placeholderText", applies: [], shapes: [{ spec: "placeholderText", label: "placeholder text", measured: "placeholderText", census: "placeholderText", parse: "string", compare: "placeholder", tol: null,
    doc: "el.placeholder", absentWhy: "this layer is an input placeholder: report el.placeholder as placeholderText (textContent of an empty input is '')", paints: true }] },
  { key: "text", applies: [], shapes: [{ spec: "text", label: "text", measured: "text", census: "text", parse: "string", compare: "copy", tol: null, absent: "unlisted",
    nullWhy: "the probe reported text: null — an element with child elements still has text; report its textContent", paints: true }] },
];

/** The order a node's properties are walked — and so the order its findings, and coverage's never-measured fields, are
 *  listed (the order reports have always used): every one-value shape in field order, then the text box width, the
 *  per-corner radius, the per-side border, padding, the placeholder and the copy. Each spec value once. */
export const CHECK_ORDER: readonly SpecKey[] = ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "color", "backgroundColor", "fill",
  "placeholderColor", "borderColor", "borderWidth", "borderRadius", "gap", "width", "height", "x", "y", "opacity", "boxWidth", "radiusCorners", "borderWidths",
  "padding", "placeholderText", "text"];

const SHAPES: ReadonlyArray<{ p: Property; s: PropertyShape }> = PROPERTIES.flatMap((p) => p.shapes.map((s) => ({ p, s })));
/** A shape's field labels: its own, or one per part. */
const labelsOf = (s: PropertyShape): string[] => (s.parts ? s.parts.map((x) => `${s.label} (${x})`) : [s.label]);
/** The tolerance a finding's field is compared with (null = exact; undefined = no property's). */
export const toleranceOf = (label: string): number | null | undefined => SHAPES.find(({ s }) => labelsOf(s).includes(label))?.s.tol;

/** The spec fields compared one-to-one against a measured style of the same name. */
type FieldKey = "fontFamily" | "fontSize" | "fontWeight" | "lineHeight" | "letterSpacing" | "color" | "backgroundColor" | "fill" | "placeholderColor"
  | "borderColor" | "borderWidth" | "borderRadius" | "gap" | "width" | "height" | "x" | "y" | "opacity";
export interface Field { key: FieldKey; tol: number | null; norm?: (v: unknown) => string | number | null; label: string; unit?: string; high?: boolean; colour?: boolean; box?: boolean; optional?: boolean }
const isFieldKey = (k: string): k is FieldKey => SHAPES.some(({ s }) => s.compare === "field" && s.spec === k);
/** the one-to-one shapes (each spec value's own shape, not a variant), as a Field */
export const FIELDS: Field[] = SHAPES.filter(({ s }) => s.compare === "field" && !s.when).flatMap(({ p, s }) => (isFieldKey(s.spec) ? [{
  key: s.spec, tol: s.tol, ...(p.norm ? { norm: p.norm } : {}), label: s.label, ...(p.unit ? { unit: p.unit } : {}),
  ...(p.high ? { high: true } : {}), ...(p.colour ? { colour: true } : {}), ...(p.box ? { box: true } : {}), ...(p.optional ? { optional: true } : {}),
}] : []));

// Every key a measured node's `styles` carries — the FIELDS compared one-to-one, then the shaped properties' own keys
// (borderWidths, padding, text, placeholderText) and the element facts the rules read (gapVisual, tag, textBox, display),
// in the order every expectation's measuredKeys line has listed them. Exported: the shipped probe (verify-probe.ts)
// measures exactly these, and measuredKeysDoc()'s styles line is generated from it. (A test checks every key a property
// reads is here.) (`display` — an id on an inline element measures its text's box, not a frame's)
export const STYLE_KEYS: readonly string[] = [...FIELDS.map((f) => f.key), "borderWidths", "padding", "gapVisual", "text", "tag", "textBox", "placeholderText", "display"];
const STYLE_KEY_SHAPE: Record<string, string> = {
  ...Object.fromEntries(SHAPES.flatMap(({ s }) => (s.doc ? [[s.measured, s.doc]] : []))),
  textBox: "{x,w} of a Range over the text", tag: "tagName, lower-case", display: "getComputedStyle(el).display",
};

/** The expectation's `measuredKeys`: what a probe sends, field by field. Built on call, not at load — the styles line is
 *  computed from STYLE_KEYS, and a module-level value would be computed (and kept) in every bundle that inlines this
 *  module, the probe's among them, whether or not it writes an expectation. */
export const measuredKeysDoc = (): Record<string, string> => ({
  "nodes[].nodeId": "the Figma node id the measurement is FOR (from data-dt-node, or matched by text/position)",
  // GENERATED from STYLE_KEYS, so the list a probe is told to send cannot drift from the list compared (`fill` must be in it)
  "nodes[].styles": `computed values, EVERY key on every node — lengths as px numbers (a "20px" string is read as 20; %, other units and keywords are not) — (null when it cannot be read, with the reason under ` +
    `unmeasured): ${STYLE_KEYS.map((k) => k + (STYLE_KEY_SHAPE[k] ? ` (${STYLE_KEY_SHAPE[k]})` : "")).join(" ")}`,
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
  "nodes[].states.<hover|pressed|focus>": "the same styles, measured with the OWNER in that state (the spec's drawnStateFrom, else the node itself; focus lands on the owner or its first focusable descendant, as :focus-within) — required for a node whose spec has drawnState; beside styles, " +
    "never inside it; a state on a node whose spec has no drawnState is not compared (listed under Inferred, not designed)",
  "inferred[]": "{nodeId?, state, built, why?} — something the build does that the design never drew (an error message, an empty list, an open state): listed under Inferred, not designed; never graded",
  "interactions[]": "{nodeId, trigger, ok: true|false|null, selector, selectorCount, detail} — `ok:true` needs the selector you drove and how many elements it matched (>=1); ok:null = not probed",
  "components[]": "{setName|nodeId, present: true|false} — present:false is an explicit claim of absence",
  "notMeasured[]": "{nodeId, why} for every spec the probe could not find — the one top-level key for it (not notFound/notFoundInDom); other unknown top-level keys are listed in the report",
  "expectationSha256": "sha256 of the .expected.json you measured against",
});

/** A percentage for a headline: 1 decimal, "<0.1" for a non-zero value that rounds to 0 (the probe's stderr line uses it too). */
export const pctText = (n: number): string => (n > 0 && n < 0.05 ? "<0.1" : (Math.round(n * 10) / 10).toFixed(1));

// a value as a report prints it (a list as a/b/c)
export const fmt = (v: unknown): string => (Array.isArray(v) ? v.join("/") : String(v));

