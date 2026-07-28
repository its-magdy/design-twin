// Fills & strokes. Type-discriminated on Paint's `type` union.
import { Obj, round, solidHex, rgbaToHex, numProp, xy, nonEmpty } from "./util";
import { resolveBoundMap } from "./variables";
import { collectSourceImage } from "./assets";

const FILTER_KEYS = ["exposure", "contrast", "saturation", "temperature", "tint", "highlights", "shadows"];

// Color-adjustment filters on an image/video paint (-1..+1 each). Map straight to CSS `filter`.
function imageFilters(f: ImagePaint | VideoPaint): Obj | undefined {
  if (!f.filters || typeof f.filters !== "object") return undefined;
  const src = f.filters as Record<string, number>;
  const out: Obj = {};
  for (const k of FILTER_KEYS) {
    if (typeof src[k] === "number" && src[k]) out[k] = round(src[k]);
  }
  return nonEmpty(out);
}

// Paint-level extras shared by every non-solid paint type (SOLID folds opacity into its hex alpha).
function paintExtras(f: Paint, o: Obj): Obj {
  if (f.blendMode && f.blendMode !== "NORMAL") o.blend = f.blendMode.toLowerCase();
  if (typeof f.opacity === "number" && f.opacity < 1) o.opacity = round(f.opacity);
  return o;
}

// IMAGE and VIDEO paints share the same shape (scaleMode, tile scale, rotation, crop transform,
// color filters) — only the hash/transform source fields differ. One helper keeps them in lockstep.
function mediaPaint(f: ImagePaint | VideoPaint, type: string, hash: unknown, transform: unknown): Obj {
  const o = paintExtras(f, { type, scaleMode: f.scaleMode ? f.scaleMode.toLowerCase() : undefined });
  if (hash) o.hash = hash; // correlates the fill to an exported asset
  if (f.scaleMode === "TILE" && typeof f.scalingFactor === "number") o.scale = f.scalingFactor;
  if (typeof f.rotation === "number" && f.rotation) o.rotation = f.rotation;
  if (Array.isArray(transform)) o.transform = transform; // crop rect
  const flt = imageFilters(f);
  if (flt) o.filters = flt;
  return o;
}

export async function simplifyFills(
  fills: ReadonlyArray<Paint> | PluginAPI["mixed"] | null | undefined
): Promise<Obj[] | undefined> {
  if (!fills || fills === figma.mixed || !Array.isArray(fills)) return undefined;
  const vis = (fills as ReadonlyArray<Paint>).filter((f) => f.visible !== false);
  const out = await Promise.all(
    vis.map(async (f) => {
      let o: Obj;
      if (f.type === "SOLID") {
        o = { type: "solid", color: solidHex(f) };
        if (f.blendMode && f.blendMode !== "NORMAL") o.blend = f.blendMode.toLowerCase();
      } else if (f.type.startsWith("GRADIENT")) {
        // Carry stops AND the transform — without the transform every gradient renders as a
        // default top-to-bottom, losing its actual angle/direction/scale.
        const g = f as GradientPaint;
        o = paintExtras(g, { type: "gradient", kind: g.type });
        if (Array.isArray(g.gradientStops)) {
          o.stops = await Promise.all(
            g.gradientStops.map(async (s) => {
              const stop: Obj = { pos: round(s.position), color: rgbaToHex(s.color) };
              const bv = await resolveBoundMap((s as any).boundVariables); // per-stop color token
              if (bv) stop.tokens = bv;
              return stop;
            })
          );
        }
        if (Array.isArray(g.gradientTransform)) o.transform = g.gradientTransform;
      } else if (f.type === "IMAGE") {
        o = mediaPaint(f, "image", f.imageHash, f.imageTransform);
        const size = await collectSourceImage(f.imageHash); // native pixel size + register source bytes
        if (size) o.intrinsicSize = size;
      } else if (f.type === "VIDEO") {
        o = mediaPaint(f, "video", (f as any).videoHash, (f as any).videoTransform);
      } else if (f.type === "PATTERN") {
        // Tiled pattern fill/stroke (beta) — the source node + tiling geometry.
        o = paintExtras(f, { type: "pattern" });
        if (f.sourceNodeId) o.sourceNodeId = f.sourceNodeId;
        if (f.tileType) o.tileType = String(f.tileType).toLowerCase();
        if (typeof f.scalingFactor === "number") o.scale = f.scalingFactor;
        if (f.spacing) o.spacing = xy(f.spacing);
        if (f.horizontalAlignment) o.align = String(f.horizontalAlignment).toLowerCase();
      } else if (f.type === "SHADER") {
        // Procedural shader fill — the opaque program id correlates the fill to the rendered PNG.
        o = paintExtras(f, { type: "shader" });
        if (f.id) o.shaderId = f.id;
      } else {
        o = paintExtras(f, { type: (f as Paint).type.toLowerCase() });
      }
      // Paint-level variable bindings (e.g. a solid fill's color bound to a token).
      const pbv = await resolveBoundMap((f as any).boundVariables);
      if (pbv) o.tokens = pbv;
      return o;
    })
  );
  return out.length ? out : undefined;
}

// Borders — buttons/inputs/cards rely on these; missing them wrecks fidelity.
export async function simplifyStrokes(node: SceneNode): Promise<Obj | undefined> {
  if (!("strokes" in node) || !Array.isArray(node.strokes)) return undefined;
  const vis = node.strokes.filter((s) => s.visible !== false);
  if (!vis.length) return undefined;
  const out: Obj = {};
  // `colors` holds COLORS. It used to fall back to the paint's type name for anything non-solid, so a
  // gradient border emitted the string "gradient_linear" in a field consumers read as a hex — pushing
  // "is this element a color or a type name?" onto every codegen profile. Non-solid stroke paints are
  // described by `paints` below (stops/transform/hash/opacity/blend and all), which is strictly more
  // information, so the type-name fallback carried nothing the record didn't already have.
  const solids = vis.filter((s) => s.type === "SOLID") as SolidPaint[];
  if (solids.length) out.colors = solids.map(solidHex);
  if (vis.some((s) => s.type !== "SOLID")) {
    const paints = await simplifyFills(vis);
    if (paints) out.paints = paints;
  }
  const strokeWeight = (node as any).strokeWeight;
  if (strokeWeight && strokeWeight !== figma.mixed) {
    out.weight = strokeWeight;
  } else if (strokeWeight === figma.mixed) {
    // Per-side weights (dividers/underlines set only one side) — the mixed fallback.
    const sides: Obj = {};
    (
      [
        ["strokeTopWeight", "top"],
        ["strokeRightWeight", "right"],
        ["strokeBottomWeight", "bottom"],
        ["strokeLeftWeight", "left"],
      ] as Array<[string, string]>
    ).forEach(([k, s]) => {
      const v = numProp(node, k);
      if (v != null) sides[s] = v;
    });
    if (Object.keys(sides).length) out.weights = sides;
  }
  const n = node as any;
  if (n.strokeAlign) out.align = String(n.strokeAlign).toLowerCase();
  if (n.dashPattern && n.dashPattern.length) out.dash = n.dashPattern;
  // Line ends/corners — matter for dividers, dashed lines, arrows/connectors.
  if ("strokeCap" in node && n.strokeCap && n.strokeCap !== figma.mixed && n.strokeCap !== "NONE") out.cap = String(n.strokeCap).toLowerCase();
  if ("strokeJoin" in node && n.strokeJoin && n.strokeJoin !== figma.mixed && n.strokeJoin !== "MITER") out.join = String(n.strokeJoin).toLowerCase();
  if ("strokeMiterLimit" in node && typeof n.strokeMiterLimit === "number" && n.strokeMiterLimit !== 4) out.miter = n.strokeMiterLimit;
  return out;
}
