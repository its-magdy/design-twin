// TEXT / TEXT_PATH serialization: node-level typographic props + either one `font` or `runs[]`
// for mixed text. Reads defensively so TEXT_PATH (which shares most of the surface) degrades safely.
import type { LengthSpec, FontSpec, TextRun, TextFields } from "../../bridge/src/doc-types.ts";
import { round, lower, solidFromFills } from "./util";
import { warnKind } from "./state";
import { styleName, resolveBoundMap } from "./variables";

// A Figma length ({value, unit}) -> the emitted descriptor. The PERCENT -> "percent"/"px" mapping is
// what downstream codegen keys off, so it's defined once and the three readers below only differ in
// which values they reject.
const lenUnit = (v: { value: number; unit: "PIXELS" | "PERCENT" }): LengthSpec => ({ value: round(v.value), unit: v.unit === "PERCENT" ? "percent" : "px" });

// unit-aware line-height / letter-spacing (never coerce PERCENT/AUTO to a bare number).
export function lineH(v: LineHeight | PluginAPI["mixed"] | undefined): LengthSpec | undefined {
  if (!v || v === figma.mixed) return undefined;
  if (v.unit === "AUTO") return { unit: "auto" };
  return lenUnit(v);
}
export function letterS(v: LetterSpacing | PluginAPI["mixed"] | undefined): LengthSpec | undefined {
  if (!v || v === figma.mixed || !v.value) return undefined;
  return lenUnit(v);
}
// text-decoration thickness/offset are { value:number, unit:'PIXELS'|'PERCENT' } | { unit:'AUTO' }.
// The number lives DIRECTLY on .value (NOT .value.value). AUTO -> let CSS pick the default length.
function decoLen(v: TextDecorationThickness | TextDecorationOffset | PluginAPI["mixed"] | null | undefined): LengthSpec | undefined {
  if (!v || v === figma.mixed || v.unit === "AUTO" || typeof v.value !== "number") return undefined;
  return lenUnit(v);
}

// Font descriptor from a node OR a styled-text segment — both carry the same fields (node-level values
// add the `| figma.mixed` variant a single segment never has). lineHeight/textDecoration* are declared
// only on BaseNonResizableTextMixin's TextNode extension (NonResizableTextMixin) — TEXT_PATH's mixin
// (NonResizableTextPathMixin) is the bare base and genuinely has none of them, so a TextPathNode passed
// through the uniform-text fallback (no styled-text segment) always no-ops on these, exactly as the
// `any`-typed original did (the runtime property simply doesn't exist there).
interface TextStyleSource {
  fontSize: number | PluginAPI["mixed"];
  fontName: FontName | PluginAPI["mixed"];
  fontWeight: number | PluginAPI["mixed"];
  // Segment-only: `fontStyle: FontStyle` exists on StyledTextSegment (plugin-api.d.ts 1.139.0 L5493-5496)
  // but on no node type, so the uniform-text fallback (the bare node) never has it.
  fontStyle?: FontStyle;
  lineHeight?: LineHeight | PluginAPI["mixed"];
  letterSpacing: LetterSpacing | PluginAPI["mixed"];
  textCase: TextCase | PluginAPI["mixed"];
  textDecoration?: TextDecoration | PluginAPI["mixed"];
  textDecorationStyle?: TextDecorationStyle | PluginAPI["mixed"] | null;
  textDecorationColor?: TextDecorationColor | PluginAPI["mixed"] | null;
  textDecorationThickness?: TextDecorationThickness | PluginAPI["mixed"] | null;
  textDecorationOffset?: TextDecorationOffset | PluginAPI["mixed"] | null;
  textDecorationSkipInk?: boolean | PluginAPI["mixed"] | null;
  openTypeFeatures: Record<OpenTypeFeature, boolean> | PluginAPI["mixed"];
  fills: ReadonlyArray<Paint> | PluginAPI["mixed"];
}

function fontObj(src: TextStyleSource): FontSpec {
  const f: FontSpec = {};
  f.size = src.fontSize !== figma.mixed ? src.fontSize : "mixed";
  if (src.fontName && src.fontName !== figma.mixed) {
    f.family = src.fontName.family;
    f.weight = src.fontName.style; // e.g. "Semibold Italic" — keep verbatim
    // Variable font axis values (Update 138), e.g. {wght: 600, slnt: -10}. Absent for a static font.
    const vs = src.fontName.variationSettings;
    if (vs && Object.keys(vs).length) f.variationSettings = { ...vs };
  }
  // Numeric CSS weight when the API exposes it (both node-level and per-segment; figma.mixed for
  // mixed-weight uniform text falls through and leaves weightValue unset).
  if (typeof src.fontWeight === "number") f.weightValue = src.fontWeight;
  // `type FontStyle = 'REGULAR' | 'ITALIC'` (plugin-api.d.ts 1.139.0 L4000; StyledTextSegment.fontStyle
  // L5496, "The style of the font (i.e. "REGULAR", "ITALIC")"). Same "absent = default" rule as
  // case/decoration below: REGULAR says nothing and is omitted, ITALIC -> "italic".
  if (src.fontStyle === "ITALIC") f.fontStyle = "italic";
  const lh = lineH(src.lineHeight);
  if (lh) f.lineHeight = lh;
  const ls = letterS(src.letterSpacing);
  if (ls) f.letterSpacing = ls;
  if (src.textCase && src.textCase !== figma.mixed && src.textCase !== "ORIGINAL") f.case = lower(src.textCase);
  if (src.textDecoration && src.textDecoration !== figma.mixed && src.textDecoration !== "NONE") f.decoration = lower(src.textDecoration);
  if (f.decoration) {
    if (src.textDecorationStyle && src.textDecorationStyle !== figma.mixed && src.textDecorationStyle !== "SOLID") f.decorationStyle = String(src.textDecorationStyle).toLowerCase();
    // Underline/strike color/thickness/offset -> CSS text-decoration-color / -thickness / text-underline-offset.
    // textDecorationColor is { value: SolidPaint } | { value: 'AUTO' } — .value is the paint directly.
    const tdc = src.textDecorationColor && src.textDecorationColor !== figma.mixed ? src.textDecorationColor.value : undefined;
    const dc = solidFromFills(tdc && tdc !== "AUTO" ? [tdc] : undefined);
    if (dc) f.decorationColor = dc;
    const th = decoLen(src.textDecorationThickness);
    if (th) f.decorationThickness = th;
    const off = decoLen(src.textDecorationOffset);
    if (off) f.decorationOffset = off;
    if (src.textDecorationSkipInk === false) f.decorationSkipInk = false; // default true; note when disabled
  }
  // OpenType features (small-caps, tabular figures, ligatures, fractions, stylistic sets)
  // -> CSS font-feature-settings. Only the enabled features.
  const feats = src.openTypeFeatures;
  if (feats && feats !== figma.mixed) {
    const on = (Object.keys(feats) as OpenTypeFeature[]).filter((k) => feats[k]);
    if (on.length) f.openType = on;
  }
  const color = solidFromFills(src.fills);
  if (color) f.color = color;
  return f;
}

// The exact segment fields this extractor reads. Left as a plain mutable array (not `as const`) so its
// element type stays `keyof Omit<StyledTextSegment, 'characters'|'start'|'end'>` — a readonly tuple
// isn't assignable to getStyledTextSegments' `T extends (...)[]` (mutable array) constraint, and the
// wider element type still gives every field below full compile-time checking (TS just can't narrow the
// segment's Pick<> to exactly these 26 keys — it types it as the full StyledTextSegment shape instead).
// Every field StyledTextSegment offers (plugin-api.d.ts 1.139.0 L5468-5589) except characters/start/end.
// `textWrapStyle` (StyledTextSegment, plugin-api.d.ts 1.139.0 L5565-5568: "The text wrap style applied
// to the paragraph." `textWrapStyle: TextWrapStyle`) is requested so a node whose node-level value is
// figma.mixed yields one segment per wrap style (the typings' own example, L10122-10137). Requesting it
// cannot split a node whose paragraphs all share one wrap style, so every other node's segments — and
// output — are unchanged. Of the last four, three are proven the same way: `fontStyle` (L5496) is a
// function of the already-requested fontName (Figma has no faux italic), and `paragraphIndent` (L5560) /
// `paragraphSpacing` (L5564) can only differ across a node whose node-level value is figma.mixed
// (L10027 / L10084). `textStyleOverrides` (L5588) is NOT proven: each member means "overridden relative
// to the text style" (developers.figma.com/docs/plugins/api/TextStyleOverrides/), and nothing documents
// whether that flag is a live comparison with the style or a sticky "was set by hand" bit. If it is
// sticky, two adjacent ranges with the same font/weight/link/decoration but a different override list
// would now be two runs where they were one. Untested offline — the §5.2 live check on a styled range
// (sticky-vs-live: still open; the runtime SHAPE is settled — see `styleOverrides` below).
const TEXT_SEG_FIELDS: Array<keyof Omit<StyledTextSegment, "characters" | "start" | "end">> = [
  "fontName", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "textCase", "textDecoration",
  "textDecorationStyle", "textDecorationColor", "textDecorationThickness", "textDecorationOffset",
  "textDecorationSkipInk", "fills", "hyperlink", "listOptions", "indentation", "listSpacing",
  "openTypeFeatures", "textStyleId", "fillStyleId", "boundVariables", "textWrapStyle",
  "fontStyle", "paragraphIndent", "paragraphSpacing", "textStyleOverrides",
];

// `textStyleOverrides: TextStyleOverrideType[]` (plugin-api.d.ts 1.139.0 L5585-5588, "Overrides applied
// over a text style"; `type TextStyleOverrideType = { type: 'SEMANTIC_ITALIC' | 'SEMANTIC_WEIGHT' |
// 'HYPERLINK' | 'TEXT_DECORATION' }` L5465-5467). developers.figma.com/docs/plugins/api/TextStyleOverrides/
// defines every member as "if the text range has a style which has been overridden to …", so the list
// is only meaningful on a range that HAS a text style: emitted (lower-cased, in API order) only when
// non-empty AND the segment's textStyleId is set; otherwise undefined -> absent.
// LIVE (Figma Desktop, 2026-09-25, §5.2 check on a page with a hand-bolded styled range): the runtime
// returns each member as a bare STRING (`["SEMANTIC_WEIGHT"]`) — the shape of the example on that same
// docs page (`"textStyleOverrides": ["SEMANTIC_WEIGHT"]`), NOT the `{ type }` object its declaration and
// plugin-api.d.ts 1.139.0 L5465-5467 state. Reading `.type` off a string threw "cannot read property
// 'toLowerCase' of undefined" inside the sandbox and aborted the whole page export. Both shapes are read
// (the typings may catch up with the runtime, or vice versa); anything else is skipped, not thrown on.
function overrideName(o: unknown): string | undefined {
  if (typeof o === "string") return o;
  if (o !== null && typeof o === "object" && "type" in o && typeof o.type === "string") return o.type;
  return undefined;
}
function styleOverrides(s: { textStyleId?: string; textStyleOverrides?: readonly unknown[] }): string[] | undefined {
  const ov = s.textStyleOverrides;
  if (!s.textStyleId || !Array.isArray(ov) || !ov.length) return undefined;
  const names: string[] = [];
  for (const o of ov) {
    const n = overrideName(o);
    if (n !== undefined) names.push(n.toLowerCase());
  }
  return names.length ? names : undefined;
}

// Hyperlink / list / indent live on a styled-text SEGMENT or, for uniform text, on the node itself —
// identical rules either way. One helper so a new inline attribute can't be added to the mixed-runs
// branch and forgotten on the uniform one (the two copies this replaced had already drifted).
// All fields optional: TEXT_PATH's mixin doesn't declare listOptions/indentation at node level, so the
// uniform-text fallback (the bare node) simply has none of them — same no-op it always was.
interface InlineExtrasSource {
  hyperlink?: HyperlinkTarget | PluginAPI["mixed"] | null;
  listOptions?: TextListOptions | PluginAPI["mixed"];
  indentation?: number | PluginAPI["mixed"];
}
function inlineExtras(src: InlineExtrasSource, out: Pick<TextFields, "href" | "linkNode" | "list" | "indent">): void {
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
// TableCellNode.text (collect from serialize.ts's table-cell branch) is a TextSublayerNode — it
// carries the same BaseNonResizableTextMixin/NonResizableTextMixin typographic surface (fonts, runs,
// decoration, paragraph/list spacing) but NONE of BaseNodeMixin's identity fields (no `name`/`id`/
// `width`/`type`) since a cell's text isn't a scene node in its own right. The three reads below that
// need those fields (`node.name`, `node.id`, `node.width`) are guarded the same way the original
// `cell.text as TextNode` cast let them silently read `undefined` for a cell — behaviour unchanged,
// just typed instead of cast. See developers.figma.com/docs/plugins/api/TextSublayerNode/.
export async function serializeText(node: TextNode | TextPathNode | TextSublayerNode): Promise<TextFields> {
  const out: TextFields = { text: node.characters };
  let segs: ReturnType<TextNode["getStyledTextSegments"]> | undefined;
  try {
    segs = node.getStyledTextSegments(TEXT_SEG_FIELDS);
  } catch (e) {
    segs = undefined;
  }
  let font: FontSpec;
  // The first run, shared by both branches; with length > 1 it is always present, so the extra test
  // below only narrows the type.
  const s0 = segs && segs[0];
  if (segs && segs.length > 1 && s0) {
    // Per-run wrap style only when the node-level value is figma.mixed (plugin-api.d.ts 1.139.0 L10141,
    // NonResizableTextMixin: `textWrapStyle: TextWrapStyle | PluginAPI['mixed']`); otherwise the single
    // value is `font.textWrap` below and the runs stay as they were. TEXT_PATH lacks it -> never mixed.
    const wrapMixed = "textWrapStyle" in node && node.textWrapStyle === figma.mixed;
    // Per-run paragraph spacing / indent under the same rule: only when the node-level value is
    // figma.mixed (NonResizableTextMixin, plugin-api.d.ts 1.139.0 L10027 `paragraphIndent: number |
    // PluginAPI['mixed']`, L10084 `paragraphSpacing: number | PluginAPI['mixed']`) — a uniform value is
    // already `font.paragraphSpacing`/`font.paragraphIndent` below. TEXT_PATH lacks both -> never mixed.
    const spacingMixed = "paragraphSpacing" in node && node.paragraphSpacing === figma.mixed;
    const indentMixed = "paragraphIndent" in node && node.paragraphIndent === figma.mixed;
    // Mixed runs — a heading with one bold word must not collapse to a single style.
    out.runs = await Promise.all(
      segs.map(async (s) => {
        const r: TextRun = { text: s.characters, font: fontObj(s) };
        inlineExtras(s, r);
        // Per-run STYLE references — for mixed text these are figma.mixed at node level, so the token
        // binding of a single bold/colored word would otherwise be lost.
        const [ts, fs, bv] = await Promise.all([styleName(s.textStyleId), styleName(s.fillStyleId), resolveBoundMap(s.boundVariables)]);
        if (ts) r.textStyle = ts;
        if (fs) r.fillStyle = fs;
        if (bv) r.tokens = bv; // per-run variable bindings (color/size/etc.)
        // Same mapping as the node-level `font.textWrap`: lowercased, AUTO (the default) omitted.
        if (wrapMixed && typeof s.textWrapStyle === "string" && s.textWrapStyle !== "AUTO") r.textWrap = lower(s.textWrapStyle);
        // Same mapping as the node-level font.paragraphSpacing/paragraphIndent: 0 (the default) omitted.
        if (spacingMixed && typeof s.paragraphSpacing === "number" && s.paragraphSpacing) r.paragraphSpacing = s.paragraphSpacing;
        if (indentMixed && typeof s.paragraphIndent === "number" && s.paragraphIndent) r.paragraphIndent = s.paragraphIndent;
        const ov = styleOverrides(s);
        if (ov) r.textStyleOverrides = ov;
        return r;
      })
    );
    font = out.font = fontObj(s0);
  } else {
    font = out.font = fontObj(s0 ? s0 : node);
    const bv = await resolveBoundMap(s0 ? s0.boundVariables : undefined);
    if (bv) out.textTokens = bv;
    // Uniform (single-run) text still carries hyperlink/list/indent — these live on the lone
    // segment (or the node), NOT only on mixed runs.
    inlineExtras(s0 || node, out);
    // The lone segment's overrides over the node's text style (the style itself is `styles.text`).
    // No segment (the bare-node fallback) -> no overrides: no node type declares the field.
    const ov = s0 ? styleOverrides(s0) : undefined;
    if (ov) out.textStyleOverrides = ov;
  }
  if ("textAlignHorizontal" in node && node.textAlignHorizontal) font.align = lower(node.textAlignHorizontal);
  // paragraphSpacing/paragraphIndent/listSpacing/leadingTrim live on NonResizableTextMixin — TEXT and
  // the TABLE-cell TextSublayerNode both extend it; TEXT_PATH's mixin (NonResizableTextPathMixin) is
  // the bare Base and genuinely lacks them, same no-op as before.
  if ("paragraphSpacing" in node && typeof node.paragraphSpacing === "number" && node.paragraphSpacing) font.paragraphSpacing = node.paragraphSpacing;
  if ("paragraphIndent" in node && typeof node.paragraphIndent === "number" && node.paragraphIndent) font.paragraphIndent = node.paragraphIndent;
  if ("listSpacing" in node && typeof node.listSpacing === "number" && node.listSpacing) font.listSpacing = node.listSpacing; // gap between list items
  if ("leadingTrim" in node && node.leadingTrim && node.leadingTrim !== figma.mixed && node.leadingTrim !== "NONE") font.leadingTrim = node.leadingTrim.toLowerCase();
  if ("textAlignVertical" in node && node.textAlignVertical && node.textAlignVertical !== "TOP") font.valign = lower(node.textAlignVertical);
  // Line-breaking strategy (TextWrapStyle = AUTO | BALANCE | PRETTY). AUTO is the default and says
  // nothing; BALANCE (even line lengths) and PRETTY (fewer orphans) map 1:1 onto CSS
  // `text-wrap: balance|pretty`. Declared on NonResizableTextMixin (TEXT and table-cell text; TEXT_PATH's
  // bare-Base mixin lacks it, hence the `in` guard) as `TextWrapStyle | PluginAPI['mixed']` — the
  // typeof-string test is the figma.mixed guard, since per-paragraph wrap styles make it genuinely mixable.
  if ("textWrapStyle" in node) {
    const tw = node.textWrapStyle;
    if (typeof tw === "string" && tw !== "AUTO") font.textWrap = lower(tw);
  }
  // List rendering: markers hanging in the margin vs. inline, and hanging punctuation into the margin.
  // hangingList/hangingPunctuation are on NonResizableTextMixin, so TEXT and the TABLE-cell
  // TextSublayerNode both have them; TEXT_PATH's bare-Base mixin doesn't.
  if ("hangingList" in node && node.hangingList === true) font.hangingList = true;
  if ("hangingPunctuation" in node && node.hangingPunctuation === true) font.hangingPunctuation = true;
  // Text-box sizing/overflow — fixed-width vs hug vs truncate/clamp. textAutoResize/textTruncation/
  // maxLines are declared directly on TextNode (not the shared mixins) — TEXT only.
  if ("type" in node && node.type === "TEXT") {
    if (node.textAutoResize && node.textAutoResize !== "NONE") out.autoResize = lower(node.textAutoResize);
    if (node.textTruncation === "ENDING") out.truncate = true; // -> text-overflow: ellipsis
    if (typeof node.maxLines === "number" && node.maxLines) out.maxLines = node.maxLines; // -> -webkit-line-clamp
  }
  // Font substitution signal: a font this text uses isn't available/loaded, so Figma is rendering a
  // FALLBACK — the family/weight recorded above may not match what's shown. Flag it so codegen knows
  // the type is approximate (and can warn or pin a webfont) rather than trusting the name blindly.
  if (node.hasMissingFont === true) {
    out.missingFont = true;
    // Kinded: a real file has one of these per text node using the font — 80 identical sentences.
    // `name`/`id` are BaseNodeMixin fields the TABLE-cell TextSublayerNode doesn't have — same
    // "undefined (undefined)" the prior `cell.text as TextNode` cast produced there, now typed.
    const name = "name" in node ? node.name : undefined;
    const id = "id" in node ? node.id : undefined;
    warnKind("missing font — Figma is substituting a fallback; the recorded family may differ from the render", name + " (" + id + ")");
  }
  // Zero-width text thread is a data smell (a collapsed/broken node) — surface it.
  if ("width" in node && node.width === 0) {
    const name = "name" in node ? node.name : undefined;
    const id = "id" in node ? node.id : undefined;
    warnKind("zero-width text node (possible collapsed thread)", name + " (" + id + ")");
  }
  return out;
}
