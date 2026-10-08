// color.ts — the ONE colour parser of the design-to-code layer (hex, and the CSS colour strings a browser
// computes), and the WCAG contrast arithmetic.
//
// Separate parsers would disagree (one requiring the `#`, one making it optional, one taking 3/4-digit
// shorthand, one taking shorthand but dropping or keeping alpha, one taking 3- but not 4-digit shorthand;
// three rgb() readers with three grammars), so the same value could be a colour to one tool and junk to the
// next. The rule, decided once:
//
//   ACCEPT  an optional `#`, then 3, 4, 6 or 8 hex digits (#rgb, #rgba, #rrggbb, #rrggbbaa), any case,
//           surrounding whitespace ignored. parseCssColor also reads the CSS functions (see there).
//   EMIT    lowercase, WITH the `#`: "#rrggbb" or "#rrggbbaa" (shorthand expanded).
//
// The `#` is optional here because export and token values are compared as written by people as well as by
// the plugin. The write path (bridge/src/hex-color.ts parseHexColor) requires it: a figma_write colour
// that is a word ("bad", "fade") must be refused, not painted.
//
// Nothing here is imported from another design-to-code module, so every module may import it (a
// "local copy to avoid an import cycle" is never needed: esbuild inlines the modules into each
// bundle, and color.ts imports nothing back). The formatter lives in bridge/src/hex-color.ts because the
// plugin writes every exported colour with it, and bridge/src never imports design-to-code.

import { formatHex } from "../bridge/src/hex-color.ts";
import type { Rgba } from "../bridge/src/hex-color.ts";
export { formatHex };
export type { Rgba };

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** "#abc" / "ABCD" / "#aabbcc" / "aabbccdd" -> "#aabbcc" / "#aabbccdd" (lowercase, alpha kept); anything else -> null. */
export function normHex(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const g = HEX.exec(v.trim())?.[1]; // the group is not optional: set whenever the regex matched
  if (g === undefined) return null;
  const h = g.toLowerCase();
  return "#" + (h.length <= 4 ? h.split("").map((c) => c + c).join("") : h);
}

/** The comparison key for "is this the same colour": always "#rrggbbaa" (opaque -> "ff"). Alpha is part
 *  of a colour's identity (`#ffffff` and `#ffffff1a` are different colours bound to different tokens). */
export function colorKey(v: unknown): string | null {
  const h = normHex(v);
  return h === null ? null : h.length === 7 ? h + "ff" : h;
}

/** A hex colour's channels (see the rule above); null when it is not one. */
export function parseHex(v: unknown): Rgba | null {
  const k = colorKey(v);
  if (k === null) return null;
  const n = (i: number): number => parseInt(k.slice(i, i + 2), 16);
  return { r: n(1), g: n(3), b: n(5), a: n(7) / 255 };
}

// ---------------------------------------------------------------- CSS colour strings
// The CSS Color 4 forms (https://www.w3.org/TR/css-color-4/) the callers see: a browser's computed value
// (§16.2: sRGB colours serialize as legacy comma-separated "rgb(r, g, b)" / "rgba(r, g, b, a)" — components
// base 10 in [0, 255], not necessarily integers; Tailwind v4 palettes compute to oklab()/oklch(), some to
// color(srgb …)), and colours authors write in source (both rgb() syntaxes, % alpha).
// A CSS <number> has digits after its '.' (`1.` is not one); the exponent is case-insensitive (the input is lower-cased).
const NUM = "[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:e[+-]?\\d+)?";
const PCT = `${NUM}%`;
const CH = `${NUM}%?`;
const CH_OR_NONE = `(?:${CH}|none)`;
// §5.1: legacy `rgb( <percentage>#{3} , <alpha-value>? ) | rgb( <number>#{3} , <alpha-value>? )` (commas; the three
// channels are all percentages or all numbers, the alpha either; `none` not allowed) and modern
// `rgb( [<number> | <percentage> | none]{3} [ / [<alpha-value> | none] ]? )` (spaces; channels may mix); rgba() is the same function.
const legacy = (ch: string): string => `\\(\\s*(${ch})\\s*,\\s*(${ch})\\s*,\\s*(${ch})\\s*(?:,\\s*(${CH})\\s*)?\\)`;
const RGB_LEGACY = new RegExp(`^rgba?(?:${legacy(PCT)}|${legacy(NUM)})$`);
const RGB_MODERN = new RegExp(`^rgba?\\(\\s*(${CH_OR_NONE})\\s+(${CH_OR_NONE})\\s+(${CH_OR_NONE})\\s*(?:/\\s*(${CH_OR_NONE})\\s*)?\\)$`);
const OK = new RegExp(`^(oklab|oklch)\\(\\s*(${CH_OR_NONE})\\s+(${CH_OR_NONE})\\s+(${CH_OR_NONE})\\s*(?:/\\s*(${CH_OR_NONE})\\s*)?\\)$`);
const SRGB = new RegExp(`^color\\(\\s*srgb\\s+(${CH_OR_NONE})\\s+(${CH_OR_NONE})\\s+(${CH_OR_NONE})\\s*(?:/\\s*(${CH_OR_NONE})\\s*)?\\)$`);

/** One component: a percentage is `pct` at 100%; `none` (a missing component) is 0 — CSS Color 4 §4.4: "a
 *  missing component behaves as a zero value". */
const comp = (x: string | undefined, pct: number): number =>
  x === undefined || x === "none" ? 0 : x.endsWith("%") ? (Number(x.slice(0, -1)) / 100) * pct : Number(x);
const clamp = (n: number, hi: number): number => Math.min(hi, Math.max(0, n));
/** Alpha: absent is opaque; out-of-range values clamp to [0, 1] (§4.2: "not invalid, but are clamped"). */
const alphaOf = (x: string | undefined): number => (x === undefined ? 1 : clamp(comp(x, 1), 1));

/**
 * A CSS colour as sRGB channels 0–255 (not rounded: formatHex rounds) plus alpha 0–1; null when it is not
 * one this reads. Reads, case-insensitively with surrounding whitespace ignored: `transparent`; a hex
 * colour WITH its `#` (CSS hex notation; see the rule at the top); rgb()/rgba() in the legacy comma and the
 * modern space syntax (number or percentage channels, number or percentage alpha); oklab()/oklch(),
 * converted to sRGB and clipped to its gamut; color(srgb …). Out-of-range rgb() channels clamp to 0–255
 * (§5.1: "clamped to the ranges defined here at parsed-value time"). Named colours other than
 * `transparent`, and other colour spaces (lab(), lch(), color(display-p3 …)), are not read.
 */
export function parseCssColor(v: unknown): Rgba | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  if (t === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  if (t.startsWith("#")) return parseHex(t);
  const leg = RGB_LEGACY.exec(t);
  // the legacy pattern has two alternatives (percentage channels, number channels): groups 1-4 or 5-8
  const rgb = leg ? (leg[1] !== undefined ? leg.slice(1, 5) : leg.slice(5, 9)) : RGB_MODERN.exec(t)?.slice(1, 5);
  if (rgb) {
    const ch = (x: string | undefined): number => clamp(comp(x, 255), 255);
    const c = { r: ch(rgb[0]), g: ch(rgb[1]), b: ch(rgb[2]), a: alphaOf(rgb[3]) };
    return Number.isFinite(c.r + c.g + c.b + c.a) ? c : null;
  }
  const ok = OK.exec(t);
  if (ok) {
    // Oklab -> linear sRGB (Ottosson's published matrices) -> the sRGB transfer curve; percentages: L 100% = 1,
    // a/b/C 100% = 0.4 (the CSS Color 4 reference ranges).
    const L = comp(ok[2], 1);
    let a: number, b: number;
    if (ok[1] === "oklab") { a = comp(ok[3], 0.4); b = comp(ok[4], 0.4); }
    else { const C = comp(ok[3], 0.4), h = (comp(ok[4], 1) * Math.PI) / 180; a = C * Math.cos(h); b = C * Math.sin(h); }
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s3 = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const enc = (c: number): number => Math.round(255 * clamp(c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055, 1));
    const c = {
      r: enc(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s3),
      g: enc(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s3),
      b: enc(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s3),
      a: alphaOf(ok[5]),
    };
    return Number.isFinite(c.r + c.g + c.b + c.a) ? c : null;
  }
  const srgb = SRGB.exec(t);
  if (srgb) {
    const ch = (x: string | undefined): number => Math.round(clamp(comp(x, 1) * 255, 255));
    const c = { r: ch(srgb[1]), g: ch(srgb[2]), b: ch(srgb[3]), a: alphaOf(srgb[4]) };
    return Number.isFinite(c.r + c.g + c.b + c.a) ? c : null;
  }
  return null;
}

// ---------------------------------------------------------------- Figma opacity percentages
// Figma's variable opacities are PERCENTAGES, 0–100: VariableComposedColor.opacity is "An opacity
// percentage from 0 to 100, or an alias to a FLOAT variable", and VariableScope says "OPACITY corresponds
// to layer opacity, while COLOR_OPACITY corresponds to the opacity channel of a color" (REST API variables
// types, https://developers.figma.com/docs/rest-api/variables-types/). These two functions are the ONE
// implementation of that rule — tokens.ts, tokens-native.ts, cross-check.ts and plan-skeleton.ts call them.

/**
 * Clamp an opacity percentage to 0–100 as Figma does (Help Center,
 * https://help.figma.com/hc/en-us/articles/14506821864087): "If the number variable has a negative value,
 * the opacity will default to 0%. If the number variable has a value greater than 100, the opacity will
 * default to 100%." A NaN stays NaN: callers check Number.isFinite first.
 */
export function clampOpacityPct(n: number): number {
  return Math.min(100, Math.max(0, n));
}

/**
 * A colour's alpha (0–1) after a Figma opacity percentage is applied: alpha × clamp(opacityPct)/100.
 * The MULTIPLY is an INFERENCE: Figma documents the 0–100 range (see above) but not how the opacity
 * combines with a colour whose own alpha is < 1. Multiplying is what tokens.css's
 * `color-mix(in srgb, <colour> N%, transparent)` does too (MDN color-mix: it works "even if the color
 * is already non-opaque", https://developer.mozilla.org/en-US/docs/Web/CSS/color_value/color-mix).
 */
export function composeAlpha(alpha: number, opacityPct: number): number {
  return alpha * (clampOpacityPct(opacityPct) / 100);
}

// ---------------------------------------------------------------- WCAG 2.2 contrast
/**
 * A translucent colour as it RENDERS over another: per channel fg × a + bg × (1 − a), result opaque.
 * WCAG 2.2 defines the contrast ratio on the relative luminance of the two colours as seen
 * (https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio, #dfn-relative-luminance) and does not itself spell
 * out how to treat alpha; compositing the foreground over its background first (simple source-over
 * alpha compositing, sRGB-encoded channels, as browsers blend) is the conventional reading, and the one
 * audit.ts's `over` already uses. The background's OWN alpha is not composited (what is under it is
 * unknown here); its channels are taken as they are.
 */
export function compositeOver(fg: Rgba, bg: Rgba): Rgba {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}

/** Relative luminance (WCAG 2.2). */
export function luminance(c: Rgba): number {
  const ch = (v: number): number => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}
/** WCAG contrast ratio, 1–21, whichever of the two is lighter. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = luminance(a), lb = luminance(b);
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}
