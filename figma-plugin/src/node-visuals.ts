// A node's own visual reads: fills, strokes, effects, corner radius, opacity, blend mode. One module for the
// page walk (serialize.ts) and the component catalog (components.ts), so a component's `visuals` carry the
// same values a page walk would write for the same node. A leaf: it imports only the paint/effects helpers
// and util, never serialize.ts or components.ts.
import type { Box, Paint, Strokes, Effect, RadiusCorners, CatalogComponent } from "../../bridge/src/doc-types.ts";
import { round, numProp, nonEmpty } from "./util";
import { simplifyFills, simplifyStrokes } from "./paint";
import { simplifyEffects } from "./effects";

type Size = Pick<Box, "w" | "h"> | undefined;

/** The three paint-side reads (fills, strokes, effects). Independent, each ending in a variable lookup, so
 *  they run at once. */
export async function nodePaints(node: SceneNode): Promise<{ fills?: Paint[]; strokes?: Strokes; effects?: Effect[] }> {
  const [fills, strokes, effects] = await Promise.all([
    simplifyFills("fills" in node ? node.fills : undefined),
    simplifyStrokes(node),
    simplifyEffects("effects" in node ? node.effects : undefined),
  ]);
  const out: { fills?: Paint[]; strokes?: Strokes; effects?: Effect[] } = {};
  if (fills) out.fills = fills;
  if (strokes) out.strokes = strokes;
  if (effects) out.effects = effects;
  return out;
}

const CORNER_KEYS: Array<[string, keyof RadiusCorners]> = [
  ["topLeftRadius", "tl"],
  ["topRightRadius", "tr"],
  ["bottomRightRadius", "br"],
  ["bottomLeftRadius", "bl"],
];

// A corner radius, made safe to transcribe.
//
// Two things reach this field that must not land verbatim in generated code. Figma's "fully rounded"
// corner exports as a literal 1000000000 — a sentinel, not a measurement, and `border-radius:
// 1000000000px` is nobody's intent. And an unrounded float arrives as
// 60.00000762939453 / 34.000003814697266, float dust from a resize that a builder then copies into
// CSS.
//
// So: round to 2dp like every other number the plugin emits, and replace the sentinel with what Figma
// ACTUALLY renders — half the shorter side of `size` — while reporting `full` so the caller sets
// `radiusFull` and the builder can emit the platform's own idiom (CSS 9999px or 50%, SwiftUI .infinity,
// Compose CircleShape) instead of a number. The value stays faithful to the render; the intent stays
// recoverable.
const RADIUS_SENTINEL = 10000;
function radiusOut(raw: number, size: Size, flag: { full?: true }): number {
  if (raw < RADIUS_SENTINEL) return round(raw);
  flag.full = true;
  const w = size && typeof size.w === "number" ? size.w : undefined;
  const h = size && typeof size.h === "number" ? size.h : undefined;
  if (w === undefined && h === undefined) return round(raw); // no size to clamp against — keep it honest and let the flag carry the meaning
  return round(Math.min(w === undefined ? Infinity : w, h === undefined ? Infinity : h) / 2);
}

/** The node's corner radius (one number, or per-corner when mixed) and whether any corner is Figma's
 *  "fully rounded" setting. `size` is the node's own box, what a fully rounded corner is clamped to. */
export function nodeCorners(node: SceneNode, size: Size): { radiusFull?: true; radius?: number | RadiusCorners } {
  const out: { radiusFull?: true; radius?: number | RadiusCorners } = {};
  if (!("cornerRadius" in node)) return out;
  const flag: { full?: true } = {};
  let radius: number | RadiusCorners | undefined;
  if (node.cornerRadius !== figma.mixed && node.cornerRadius) radius = radiusOut(node.cornerRadius, size, flag);
  else if (node.cornerRadius === figma.mixed) {
    // Per-corner fallback (pills/cards with asymmetric corners).
    const corners: RadiusCorners = {};
    for (const [k, s] of CORNER_KEYS) {
      const v = numProp(node, k);
      if (k in node && typeof v === "number" && v) corners[s] = radiusOut(v, size, flag);
    }
    radius = nonEmpty(corners);
  }
  if (flag.full) out.radiusFull = true;
  if (radius !== undefined) out.radius = radius;
  return out;
}

/** Layer opacity below 1, rounded. */
export function nodeOpacity(node: SceneNode): number | undefined {
  return "opacity" in node && typeof node.opacity === "number" && node.opacity < 1 ? round(node.opacity) : undefined;
}

/** A blend mode other than the defaults, lowercased (CSS names). */
export function nodeBlendMode(node: SceneNode): string | undefined {
  return "blendMode" in node && node.blendMode && node.blendMode !== "NORMAL" && node.blendMode !== "PASS_THROUGH"
    ? String(node.blendMode).toLowerCase() : undefined;
}

/** The catalog's `visuals` shape (doc-types.ts CatalogComponent), which is exactly the page walk's fields. */
export type NodeVisuals = NonNullable<CatalogComponent["visuals"]>;

/** Every visual read at once, for a caller that writes them together (the component catalog). The page
 *  walk calls the parts itself, since it interleaves other fields between them. */
export async function nodeVisuals(node: SceneNode, size: Size): Promise<NodeVisuals | undefined> {
  const out: NodeVisuals = { ...(await nodePaints(node)), ...nodeCorners(node, size) };
  const opacity = nodeOpacity(node);
  if (opacity !== undefined) out.opacity = opacity;
  const blendMode = nodeBlendMode(node);
  if (blendMode) out.blendMode = blendMode;
  return nonEmpty(out);
}
