// color.ts — the ONE hex-colour parser of the design-to-code layer, and the WCAG contrast arithmetic.
//
// There used to be five, and they disagreed: audit.ts's parseHex required the `#`, cross-check.ts's
// hexToRgb made it optional, tokens.ts's normHex also took 3/4-digit shorthand, verify-build.ts's
// hex6/colorKey took shorthand but dropped or kept alpha, and verify-screen.ts's normColor took 3- but
// not 4-digit shorthand. The same export value could therefore be a colour to one tool and junk to the
// next. The rule, decided once:
//
//   ACCEPT  an optional `#`, then 3, 4, 6 or 8 hex digits (#rgb, #rgba, #rrggbb, #rrggbbaa), any case,
//           surrounding whitespace ignored.
//   EMIT    lowercase, WITH the `#`: "#rrggbb" or "#rrggbbaa" (shorthand expanded).
//
// Nothing here is imported from another design-to-code module, so every module may import it (the old
// "local copy to avoid an import cycle" reasoning never applied: esbuild inlines the modules into each
// bundle, and color.ts imports nothing back).

/** 0–255 channels plus alpha 0–1. */
export interface Rgba { r: number; g: number; b: number; a: number }

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** "#abc" / "ABCD" / "#aabbcc" / "aabbccdd" -> "#aabbcc" / "#aabbccdd" (lowercase, alpha kept); anything else -> null. */
export function normHex(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = HEX.exec(v.trim());
  if (!m) return null;
  const h = m[1].toLowerCase();
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

// ---------------------------------------------------------------- WCAG 2.2 contrast
/** Relative luminance (WCAG 2.2). */
export function luminance(c: Rgba): number {
  const ch = (v: number): number => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}
/** WCAG contrast ratio, 1–21, whichever of the two is lighter. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
