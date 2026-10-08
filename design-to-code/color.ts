// color.ts — the ONE hex-colour parser of the design-to-code layer, and the WCAG contrast arithmetic.
//
// Separate parsers would disagree (one requiring the `#`, one making it optional, one taking 3/4-digit
// shorthand, one taking shorthand but dropping or keeping alpha, one taking 3- but not 4-digit shorthand),
// so the same export value could be a colour to one tool and junk to the next. The rule, decided once:
//
//   ACCEPT  an optional `#`, then 3, 4, 6 or 8 hex digits (#rgb, #rgba, #rrggbb, #rrggbbaa), any case,
//           surrounding whitespace ignored.
//   EMIT    lowercase, WITH the `#`: "#rrggbb" or "#rrggbbaa" (shorthand expanded).
//
// Nothing here is imported from another design-to-code module, so every module may import it (a
// "local copy to avoid an import cycle" is never needed: esbuild inlines the modules into each
// bundle, and color.ts imports nothing back).

/** 0–255 channels plus alpha 0–1. */
export interface Rgba { r: number; g: number; b: number; a: number }

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

/** An Rgba as "#rrggbb" (alpha rounds to 255) or "#rrggbbaa" — channels rounded to 0–255. */
export function formatHex(c: Rgba): string {
  const to = (x: number): string => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, "0");
  const a = Math.round(c.a * 255);
  return "#" + to(c.r) + to(c.g) + to(c.b) + (a < 255 ? to(a) : "");
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
