// Pure helpers shared across the extractor. No Figma API calls here.

// A compact-output bag. The extractor emits heterogeneous JSON objects; the type safety we
// care about is on the INPUT (Figma API reads), so outputs stay intentionally loose.
export type Obj = Record<string, any>;

export const round = (n: unknown): number | unknown => (typeof n === "number" ? Math.round(n * 100) / 100 : n);
export const safe = (id: string): string => id.replace(/[^a-zA-Z0-9]/g, "_");
export const propName = (k: string): string => k.split("#")[0]; // strip Figma's "#nnn:nn" suffix

// Thrown value -> message string. The extractor's "never silent" discipline means every catch reports
// something, so this coercion is the single most repeated expression in the codebase — name it once.
export const errMsg = (e: unknown): string => String((e && (e as any).message) || e);

// The extractor's compaction rule: emit nothing rather than an empty object. One place to change it.
export const nonEmpty = (o: Obj): Obj | undefined => (Object.keys(o).length ? o : undefined);

// A Figma Vector -> a compact rounded pair. `round`'s precision is meant to be the single knob on
// emitted-geometry size, so every {x,y} in the output goes through here.
export const xy = (v: { x: number; y: number }): Obj => ({ x: round(v.x), y: round(v.y) });

// Assign `key` = the rounded vector, but only when the source really is a Vector object. Progressive
// blur / noise offsets are Vectors in normalized object space, so a `typeof === "number"` guard drops
// them silently — this keeps that one correct guard in one place.
export function putXY(o: Obj, key: string, v: unknown): void {
  if (v && typeof v === "object") o[key] = xy(v as { x: number; y: number });
}

// The exact animation-curve params on a Figma easing — cubic-bezier control points {x1,y1,x2,y2}
// and/or the spring config (its payload shape varies by surface, so pass it through verbatim).
// Shared by prototype transitions and motion keyframes so a new curve field is carried in one place.
export function easingCurve(ez: { easingFunctionCubicBezier?: unknown; easingFunctionSpring?: unknown }): Obj {
  const o: Obj = {};
  if (ez.easingFunctionCubicBezier) o.cubicBezier = ez.easingFunctionCubicBezier;
  if (ez.easingFunctionSpring) o.spring = ez.easingFunctionSpring;
  return o;
}

// Dynamic numeric-property read over the SceneNode union (TS can't index a union by a string var).
// Localizes the one unavoidable cast so callers stay typed.
export function numProp(node: unknown, key: string): number | undefined {
  const v = (node as Record<string, unknown>)[key];
  return typeof v === "number" ? v : undefined;
}

// Truthy dynamic property read (for `key in node && node[key]` patterns).
export function anyProp(node: unknown, key: string): unknown {
  return (node as Record<string, unknown>)[key];
}

export function rgbaToHex(c: { r: number; g: number; b: number; a?: number }): string {
  const to = (x: number) => Math.round(x * 255).toString(16).padStart(2, "0");
  const hex = `#${to(c.r)}${to(c.g)}${to(c.b)}`;
  return c.a !== undefined && c.a < 1 ? `${hex}${to(c.a)}` : hex;
}

// A visible SOLID paint -> hex (folding its opacity into the alpha channel).
export const solidHex = (p: { color: RGB; opacity?: number }): string => rgbaToHex({ ...p.color, a: p.opacity });

// First visible SOLID paint of an array -> hex (used for text run colors).
export function solidFromFills(fills: ReadonlyArray<Paint> | PluginAPI["mixed"] | null | undefined): string | undefined {
  if (!fills || fills === figma.mixed || !Array.isArray(fills)) return undefined;
  const s = (fills as ReadonlyArray<Paint>).find((f) => f.visible !== false && f.type === "SOLID");
  return s ? solidHex(s as SolidPaint) : undefined;
}

// The plugin main thread has no btoa/Buffer, so encode bytes to base64 by hand.
// Base64 is ~1.33x the raw size; a JSON array of ints is ~3.5–4x — big win for PNGs.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
// Accumulate into a bounded chunk string rather than one array element per base64 CHARACTER: a 2 MB
// reference PNG would otherwise build a ~2.7M-element array of 1-char strings before join(), which is
// the likeliest heap/GC pressure point in the sandbox (every icon, raster and source image runs this).
const B64_CHUNK = 16384;
export function toBase64(bytes: Uint8Array): string {
  const n = bytes.length;
  let out = "";
  let chunk = "";
  for (let i = 0; i < n; i += 3) {
    const t = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    chunk +=
      B64[(t >> 18) & 63] +
      B64[(t >> 12) & 63] +
      (i + 1 < n ? B64[(t >> 6) & 63] : "=") +
      (i + 2 < n ? B64[t & 63] : "=");
    if (chunk.length >= B64_CHUNK) { out += chunk; chunk = ""; }
  }
  return out + chunk;
}
