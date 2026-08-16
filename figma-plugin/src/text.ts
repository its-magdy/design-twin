// TEXT / TEXT_PATH serialization: node-level typographic props + either one `font` or `runs[]`
// for mixed text. Reads defensively so TEXT_PATH (which shares most of the surface) degrades safely.
import { Obj, round, solidFromFills } from "./util";
import { warnKind } from "./state";
import { styleName, resolveBoundMap } from "./variables";

// A Figma length ({value, unit}) -> the emitted descriptor. The PERCENT -> "percent"/"px" mapping is
// what downstream codegen keys off, so it's defined once and the three readers below only differ in
// which values they reject.
const lenUnit = (v: any): Obj => ({ value: round(v.value), unit: v.unit === "PERCENT" ? "percent" : "px" });

// unit-aware line-height / letter-spacing (never coerce PERCENT/AUTO to a bare number).
export function lineH(v: any): Obj | undefined {
  if (!v || v === figma.mixed) return undefined;
  if (v.unit === "AUTO") return { unit: "auto" };
  return lenUnit(v);
}
export function letterS(v: any): Obj | undefined {
  if (!v || v === figma.mixed || !v.value) return undefined;
  return lenUnit(v);
}
// text-decoration thickness/offset are { value:number, unit:'PIXELS'|'PERCENT' } | { unit:'AUTO' }.
// The number lives DIRECTLY on .value (NOT .value.value). AUTO -> let CSS pick the default length.
function decoLen(v: any): Obj | undefined {
  if (!v || v === figma.mixed || v.unit === "AUTO" || typeof v.value !== "number") return undefined;
  return lenUnit(v);
}

// Font descriptor from a node OR a styled-text segment (both carry the same fields, so `any`).
function fontObj(src: any): Obj {
  const f: Obj = {};
  f.size = src.fontSize !== figma.mixed ? src.fontSize : "mixed";
  if (src.fontName && src.fontName !== figma.mixed) {
    f.family = src.fontName.family;
    f.weight = src.fontName.style; // e.g. "Semibold Italic" — keep verbatim
  }
  // Numeric CSS weight when the API exposes it (node-level; segments don't carry it).
  if (typeof src.fontWeight === "number") f.weightValue = src.fontWeight;
  const lh = lineH(src.lineHeight);
  if (lh) f.lineHeight = lh;
  const ls = letterS(src.letterSpacing);
  if (ls) f.letterSpacing = ls;
  if (src.textCase && src.textCase !== figma.mixed && src.textCase !== "ORIGINAL") f.case = src.textCase.toLowerCase();
  if (src.textDecoration && src.textDecoration !== figma.mixed && src.textDecoration !== "NONE") f.decoration = src.textDecoration.toLowerCase();
  if (f.decoration) {
    if (src.textDecorationStyle && src.textDecorationStyle !== figma.mixed && src.textDecorationStyle !== "SOLID") f.decorationStyle = String(src.textDecorationStyle).toLowerCase();
    // Underline/strike color/thickness/offset -> CSS text-decoration-color / -thickness / text-underline-offset.
    // textDecorationColor is { value: SolidPaint } | { value: 'AUTO' } — .value is the paint directly.
    const dcv = src.textDecorationColor && src.textDecorationColor.value;
    const dc = solidFromFills(dcv && dcv !== "AUTO" ? [dcv] : undefined);
    if (dc) f.decorationColor = dc;
    const th = decoLen(src.textDecorationThickness);
    if (th) f.decorationThickness = th;
    const off = decoLen(src.textDecorationOffset);
    if (off) f.decorationOffset = off;
    if (src.textDecorationSkipInk === false) f.decorationSkipInk = false; // default true; note when disabled
  }
  // OpenType features (small-caps, tabular figures, ligatures, fractions, stylistic sets)
  // -> CSS font-feature-settings. Only the enabled features.
  if (src.openTypeFeatures && typeof src.openTypeFeatures === "object" && src.openTypeFeatures !== figma.mixed) {
    const on = Object.keys(src.openTypeFeatures).filter((k) => src.openTypeFeatures[k]);
    if (on.length) f.openType = on;
  }
  const color = solidFromFills(src.fills);
  if (color) f.color = color;
  return f;
}

const TEXT_SEG_FIELDS = [
  "fontName", "fontSize", "lineHeight", "letterSpacing", "textCase", "textDecoration",
  "textDecorationStyle", "textDecorationColor", "textDecorationThickness", "textDecorationOffset",
  "textDecorationSkipInk", "fills", "hyperlink", "listOptions", "indentation", "listSpacing",
  "openTypeFeatures", "textStyleId", "fillStyleId", "boundVariables",
] as const;

// Hyperlink / list / indent live on a styled-text SEGMENT or, for uniform text, on the node itself —
// identical rules either way. One helper so a new inline attribute can't be added to the mixed-runs
// branch and forgotten on the uniform one (the two copies this replaced had already drifted).
function inlineExtras(src: any, out: Obj): void {
  const hl = src.hyperlink;
  if (hl && hl !== figma.mixed && hl.value) {
    if (hl.type === "NODE") out.linkNode = hl.value;
    else out.href = hl.value;
  }
  const lo = src.listOptions;
  if (lo && lo !== figma.mixed && lo.type && lo.type !== "NONE") out.list = lo.type.toLowerCase();
  if (typeof src.indentation === "number" && src.indentation) out.indent = src.indentation; // list nesting depth
}

// Returns the text FRAGMENT to merge into the node record. Every other helper in the serializer
// returns a value the caller assigns; this one used to be the lone exception that wrote into the
// caller's object, which meant it could set any key without the serializer knowing.
export async function serializeText(node: TextNode | TextPathNode): Promise<Obj> {
  const t = node as any;
  const out: Obj = { text: node.characters };
  let segs: any[] | undefined;
  try {
    segs = (node as TextNode).getStyledTextSegments(TEXT_SEG_FIELDS as any) as any[];
  } catch (e) {
    segs = undefined;
  }
  if (segs && segs.length > 1) {
    // Mixed runs — a heading with one bold word must not collapse to a single style.
    out.runs = await Promise.all(
      segs.map(async (s) => {
        const r: Obj = { text: s.characters, font: fontObj(s) };
        inlineExtras(s, r);
        // Per-run STYLE references — for mixed text these are figma.mixed at node level, so the token
        // binding of a single bold/colored word would otherwise be lost.
        const [ts, fs, bv] = await Promise.all([styleName(s.textStyleId), styleName(s.fillStyleId), resolveBoundMap(s.boundVariables)]);
        if (ts) r.textStyle = ts;
        if (fs) r.fillStyle = fs;
        if (bv) r.tokens = bv; // per-run variable bindings (color/size/etc.)
        return r;
      })
    );
    out.font = fontObj(segs[0]);
  } else {
    const s0 = segs && segs[0];
    out.font = fontObj(s0 ? s0 : node);
    const bv = await resolveBoundMap(s0 ? s0.boundVariables : undefined);
    if (bv) out.textTokens = bv;
    // Uniform (single-run) text still carries hyperlink/list/indent — these live on the lone
    // segment (or the node), NOT only on mixed runs.
    inlineExtras(s0 || t, out);
  }
  if (t.textAlignHorizontal) out.font.align = t.textAlignHorizontal.toLowerCase();
  if (typeof t.paragraphSpacing === "number" && t.paragraphSpacing) out.font.paragraphSpacing = t.paragraphSpacing;
  if (typeof t.paragraphIndent === "number" && t.paragraphIndent) out.font.paragraphIndent = t.paragraphIndent;
  if (typeof t.listSpacing === "number" && t.listSpacing) out.font.listSpacing = t.listSpacing; // gap between list items
  if (t.leadingTrim && t.leadingTrim !== figma.mixed && t.leadingTrim !== "NONE") out.font.leadingTrim = t.leadingTrim.toLowerCase();
  if (t.textAlignVertical && t.textAlignVertical !== "TOP") out.font.valign = t.textAlignVertical.toLowerCase();
  // Line-breaking strategy (Plugin API update 2026-08-14; TextWrapStyle = AUTO | BALANCE | PRETTY).
  // AUTO is the default and says nothing; BALANCE (even line lengths) and PRETTY (fewer orphans) map
  // 1:1 onto CSS `text-wrap: balance|pretty`. The typeof-string test is also the figma.mixed guard —
  // mixed is a Symbol, and per-paragraph wrap styles make this genuinely mixable.
  {
    const tw = (t as any).textWrapStyle;
    if (typeof tw === "string" && tw && tw !== "AUTO") out.font.textWrap = tw.toLowerCase();
  }
  // List rendering: markers hanging in the margin vs. inline, and hanging punctuation into the margin.
  if (t.hangingList === true) out.font.hangingList = true;
  if (t.hangingPunctuation === true) out.font.hangingPunctuation = true;
  // Text-box sizing/overflow — fixed-width vs hug vs truncate/clamp.
  if (t.textAutoResize && t.textAutoResize !== "NONE") out.autoResize = t.textAutoResize.toLowerCase();
  if (t.textTruncation === "ENDING") out.truncate = true; // -> text-overflow: ellipsis
  if (typeof t.maxLines === "number" && t.maxLines) out.maxLines = t.maxLines; // -> -webkit-line-clamp
  // Font substitution signal: a font this text uses isn't available/loaded, so Figma is rendering a
  // FALLBACK — the family/weight recorded above may not match what's shown. Flag it so codegen knows
  // the type is approximate (and can warn or pin a webfont) rather than trusting the name blindly.
  if (t.hasMissingFont === true) {
    out.missingFont = true;
    // Kinded: a real file has one of these per text node using the font — 80 identical sentences.
    warnKind("missing font — Figma is substituting a fallback; the recorded family may differ from the render", node.name + " (" + node.id + ")");
  }
  // Zero-width text thread is a data smell (a collapsed/broken node) — surface it.
  if (node.width === 0) warnKind("zero-width text node (possible collapsed thread)", node.name + " (" + node.id + ")");
  return out;
}
