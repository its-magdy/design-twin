// Pure helpers shared across the extractor. No Figma API calls here.
import type { JsonObject, JsonValue, XY, CubicBezier, ComponentPropType } from "../../bridge/src/doc-types.ts";

// The filesystem-boundary sanitiser lives in pages-layout.js, which names the page dirs and layer
// files this plugin's own download path writes — esbuild inlines that module into the bundle (main.ts
// already imports it), so re-export rather than keeping a byte-identical second copy that could
// desynchronise asset paths from page/layer paths.
export { safe } from "../../bridge/src/pages-layout.ts";

// The timestamp every emitted doc carries. One place to change the format for all of them.
export const exportedAt = (): string => new Date().toISOString();

// 2dp — the single knob on emitted-number precision. A non-number (an optional read that came back
// undefined/null) passes through unchanged.
export function round(n: number): number;
export function round<T>(n: number | T): number | T;
export function round<T>(n: number | T): number | T {
  return typeof n === "number" ? Math.round(n * 100) / 100 : n;
}

// A Figma enum literal -> the lowercased token the IR emits. `toLowerCase()` is typed `string`, so this
// is the ONE place that mapping is asserted — Lowercase<T> is exactly what it computes for an ASCII enum.
export const lower = <T extends string>(s: T): Lowercase<T> => s.toLowerCase() as Lowercase<T>;

export const propName = (k: string): string => k.split("#")[0]; // strip Figma's "#nnn:nn" suffix

// Figma's ComponentPropertyType, emitted verbatim. doc-types' ComponentPropType lists the same five
// members (SLOT included — kinds.ts maps it to "instance"); this is the one place the two unions are
// held equal, so a new Figma member fails here rather than in design-to-code.
export const propType = (t: ComponentPropertyType): ComponentPropType => t;

// Thrown value -> message string. Same reasoning as `safe` above: one definition in a dependency-free
// CJS module that esbuild inlines into this bundle, so the Node side and the plugin cannot drift.
export { errMsg } from "../../bridge/src/errmsg.ts";

// "Same SVG, modulo Figma's own export noise" — the ONE definition shared with bridge/write-out.js
// (clobber-avoidance) and design-to-code/design-diff.js (the change diff), so all three agree on what
// counts as a redraw. See bridge/svg-normalize.js for why 1 decimal place, not 2.
export { normalizeSvgText } from "../../bridge/src/svg-normalize.ts";

// The extractor's compaction rule: emit nothing rather than an empty object. One place to change it.
export const nonEmpty = <T extends object>(o: T): T | undefined => (Object.keys(o).length ? o : undefined);

// The same compaction rule applied as an ASSIGNMENT rather than a return: set `key` only when the bag
// has something in it. Callers used to inline `if (Object.keys(x).length) o.k = x`, which put the rule
// in eight places and quietly diverged from `nonEmpty`; going through here keeps it at one. Assigning
// `nonEmpty(x)` directly is NOT equivalent — that leaves an undefined-valued key on the in-memory
// object (invisible after JSON.stringify, visible to anything that walks Object.keys).
export function putNonEmpty<T, K extends keyof T>(o: T, key: K, v: (T[K] & object) | null | undefined): void {
  const kept = v && nonEmpty(v);
  if (kept) o[key] = kept;
}

// A Figma Vector -> a compact rounded pair. `round`'s precision is meant to be the single knob on
// emitted-geometry size, so every {x,y} in the output goes through here.
export const xy = (v: { x: number; y: number }): XY => ({ x: round(v.x), y: round(v.y) });

// Assign `key` = the rounded vector, but only when the source really is a Vector object. Progressive
// blur / noise offsets are Vectors in normalized object space, so a `typeof === "number"` guard drops
// them silently — this keeps that one correct guard in one place.
export function putXY<K extends string>(o: Partial<Record<K, XY>>, key: K, v: { x: number; y: number } | null | undefined): void {
  if (v && typeof v === "object") o[key] = xy(v);
}

// The exact animation-curve params on a Figma easing — cubic-bezier control points {x1,y1,x2,y2}
// and/or the spring config (its payload shape varies by surface, so pass it through verbatim).
// Shared by prototype transitions and motion keyframes so a new curve field is carried in one place.
export interface EasingCurve { cubicBezier?: CubicBezier; spring?: unknown }
export function easingCurve(ez: { easingFunctionCubicBezier?: CubicBezier; easingFunctionSpring?: unknown }): EasingCurve {
  const o: EasingCurve = {};
  if (ez.easingFunctionCubicBezier) o.cubicBezier = ez.easingFunctionCubicBezier;
  if (ez.easingFunctionSpring) o.spring = ez.easingFunctionSpring;
  return o;
}

// A value read off a union member NEWER than the pinned typings (a `default` branch typed `never`),
// carried through when it is JSON. A real structural walk, not an assertion; it mirrors what
// JSON.stringify would have written (undefined object members dropped, undefined array slots -> null).
export function asJson(v: unknown): JsonValue | undefined {
  if (v === null || typeof v === "string" || typeof v === "boolean" || typeof v === "number") return v;
  if (Array.isArray(v)) return v.map((x: unknown) => { const j = asJson(x); return j === undefined ? null : j; });
  if (typeof v === "object") {
    const out: JsonObject = {};
    for (const [k, x] of Object.entries(v)) {
      const j = asJson(x);
      if (j !== undefined) out[k] = j;
    }
    return out;
  }
  return undefined;
}

// Array.isArray's built-in guard narrows a ReadonlyArray<T> to an untyped array (its elements lose T — every
// Plugin API list is readonly); this is the same runtime check with T kept. Test doubles can hand back
// a non-array, and some reads are `T[] | figma.mixed`, hence the wide parameter.
export function isList<T>(v: ReadonlyArray<T> | PluginAPI["mixed"] | null | undefined): v is ReadonlyArray<T> {
  return Array.isArray(v);
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
