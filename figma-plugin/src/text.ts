// TEXT / TEXT_PATH serialization: node-level typographic props + either one `font` or `runs[]`
// for mixed text. Reads defensively so TEXT_PATH (which shares most of the surface) degrades safely.
import { Obj, round, solidFromFills } from "./util";
import { warnKind } from "./state";
import { styleName, resolveBoundMap } from "./variables";

// A Figma length ({value, unit}) -> the emitted descriptor. The PERCENT -> "percent"/"px" mapping is
// what downstream codegen keys off, so it's defined once and the three readers below only differ in
// which values they reject.
const lenUnit = (v: { value: number; unit: "PIXELS" | "PERCENT" }): Obj => ({ value: round(v.value), unit: v.unit === "PERCENT" ? "percent" : "px" });

// unit-aware line-height / letter-spacing (never coerce PERCENT/AUTO to a bare number).
export function lineH(v: LineHeight | PluginAPI["mixed"] | undefined): Obj | undefined {
  if (!v || v === figma.mixed) return undefined;
  if (v.unit === "AUTO") return { unit: "auto" };
  return lenUnit(v);
}
export function letterS(v: LetterSpacing | PluginAPI["mixed"] | undefined): Obj | undefined {
  if (!v || v === figma.mixed || !v.value) return undefined;
  return lenUnit(v);
}
// text-decoration thickness/offset are { value:number, unit:'PIXELS'|'PERCENT' } | { unit:'AUTO' }.
// The number lives DIRECTLY on .value (NOT .value.value). AUTO -> let CSS pick the default length.
function decoLen(v: TextDecorationThickness | TextDecorationOffset | PluginAPI["mixed"] | null | undefined): Obj | undefined {
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

function fontObj(src: TextStyleSource): Obj {
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
// segment's Pick<> to exactly these 20 keys — it types it as the full StyledTextSegment shape instead).
const TEXT_SEG_FIELDS: Array<keyof Omit<StyledTextSegment, "characters" | "start" | "end">> = [
  "fontName", "fontSize", "lineHeight", "letterSpacing", "textCase", "textDecoration",
  "textDecorationStyle", "textDecorationColor", "textDecorationThickness", "textDecorationOffset",
  "textDecorationSkipInk", "fills", "hyperlink", "listOptions", "indentation", "listSpacing",
  "openTypeFeatures", "textStyleId", "fillStyleId", "boundVariables",
];

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
function inlineExtras(src: InlineExtrasSource, out: Obj): void {
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
export async function serializeText(node: TextNode | TextPathNode | TextSublayerNode): Promise<Obj> {
  const out: Obj = { text: node.characters };
  let segs: ReturnType<TextNode["getStyledTextSegments"]> | undefined;
  try {
    segs = node.getStyledTextSegments(TEXT_SEG_FIELDS);
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
    inlineExtras(s0 || node, out);
  }
  if ("textAlignHorizontal" in node && node.textAlignHorizontal) out.font.align = node.textAlignHorizontal.toLowerCase();
  // paragraphSpacing/paragraphIndent/listSpacing/leadingTrim live on NonResizableTextMixin — TEXT and
  // the TABLE-cell TextSublayerNode both extend it; TEXT_PATH's mixin (NonResizableTextPathMixin) is
  // the bare Base and genuinely lacks them, same no-op as before.
  if ("paragraphSpacing" in node && typeof node.paragraphSpacing === "number" && node.paragraphSpacing) out.font.paragraphSpacing = node.paragraphSpacing;
  if ("paragraphIndent" in node && typeof node.paragraphIndent === "number" && node.paragraphIndent) out.font.paragraphIndent = node.paragraphIndent;
  if ("listSpacing" in node && typeof node.listSpacing === "number" && node.listSpacing) out.font.listSpacing = node.listSpacing; // gap between list items
  if ("leadingTrim" in node && node.leadingTrim && node.leadingTrim !== figma.mixed && node.leadingTrim !== "NONE") out.font.leadingTrim = node.leadingTrim.toLowerCase();
  if ("textAlignVertical" in node && node.textAlignVertical && node.textAlignVertical !== "TOP") out.font.valign = node.textAlignVertical.toLowerCase();
  // Line-breaking strategy (TextWrapStyle = AUTO | BALANCE | PRETTY). AUTO is the default and says
  // nothing; BALANCE (even line lengths) and PRETTY (fewer orphans) map 1:1 onto CSS
  // `text-wrap: balance|pretty`. Declared on NonResizableTextMixin (TEXT and table-cell text; TEXT_PATH's
  // bare-Base mixin lacks it, hence the `in` guard) as `TextWrapStyle | PluginAPI['mixed']` — the
  // typeof-string test is the figma.mixed guard, since per-paragraph wrap styles make it genuinely mixable.
  if ("textWrapStyle" in node) {
    const tw = node.textWrapStyle;
    if (typeof tw === "string" && tw !== "AUTO") out.font.textWrap = tw.toLowerCase();
  }
  // List rendering: markers hanging in the margin vs. inline, and hanging punctuation into the margin.
  // hangingList/hangingPunctuation are on NonResizableTextMixin, so TEXT and the TABLE-cell
  // TextSublayerNode both have them; TEXT_PATH's bare-Base mixin doesn't.
  if ("hangingList" in node && node.hangingList === true) out.font.hangingList = true;
  if ("hangingPunctuation" in node && node.hangingPunctuation === true) out.font.hangingPunctuation = true;
  // Text-box sizing/overflow — fixed-width vs hug vs truncate/clamp. textAutoResize/textTruncation/
  // maxLines are declared directly on TextNode (not the shared mixins) — TEXT only.
  if ("type" in node && node.type === "TEXT") {
    if (node.textAutoResize && node.textAutoResize !== "NONE") out.autoResize = node.textAutoResize.toLowerCase();
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
