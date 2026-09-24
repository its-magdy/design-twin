// Fills & strokes. Type-discriminated on Paint's `type` union.
import type {
  Paint as IrPaint, PaintBase as IrPaintBase, GradientStop as IrGradientStop, MediaPaint as IrMediaPaint,
  GradientPaint as IrGradientPaint, PatternPaint as IrPatternPaint, ShaderPaint as IrShaderPaint,
  ImageFilters as IrImageFilters, Strokes as IrStrokes,
} from "../../bridge/src/doc-types.ts";
import { round, lower, solidHex, rgbaToHex, numProp, xy, nonEmpty, putNonEmpty, isList } from "./util";
import { resolveBoundMap } from "./variables";
import { collectSourceImage } from "./assets";

const FILTER_KEYS: Array<keyof IrImageFilters & keyof ImageFilters> = ["exposure", "contrast", "saturation", "temperature", "tint", "highlights", "shadows"];

// Color-adjustment filters on an image/video paint (-1..+1 each). Map straight to CSS `filter`.
function imageFilters(f: ImagePaint | VideoPaint): IrImageFilters | undefined {
  if (!f.filters || typeof f.filters !== "object") return undefined;
  const src = f.filters;
  const out: IrImageFilters = {};
  for (const k of FILTER_KEYS) {
    const v = src[k];
    if (typeof v === "number" && v) out[k] = round(v);
  }
  return nonEmpty(out);
}

// Paint-level extras shared by every non-solid paint type (SOLID folds opacity into its hex alpha).
function paintExtras<T extends IrPaintBase>(f: Paint, o: T): T {
  if (f.blendMode && f.blendMode !== "NORMAL") o.blend = f.blendMode.toLowerCase();
  if (typeof f.opacity === "number" && f.opacity < 1) o.opacity = round(f.opacity);
  return o;
}

// IMAGE and VIDEO paints share the same shape (scaleMode, tile scale, rotation, crop transform,
// color filters) — only the hash/transform source fields differ. One helper keeps them in lockstep.
function mediaPaint(f: ImagePaint | VideoPaint, type: IrMediaPaint["type"], hash: string | null | undefined, transform: Transform | undefined): IrMediaPaint {
  const o = paintExtras<IrMediaPaint>(f, { type, scaleMode: f.scaleMode ? lower(f.scaleMode) : undefined });
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
): Promise<IrPaint[] | undefined> {
  if (!fills || fills === figma.mixed || !Array.isArray(fills)) return undefined;
  const vis = (fills as ReadonlyArray<Paint>).filter((f) => f.visible !== false);
  const out = await Promise.all(
    vis.map(async (f): Promise<IrPaint> => {
      let o: IrPaint;
      if (f.type === "SOLID") {
        o = { type: "solid", color: solidHex(f) };
        if (f.blendMode && f.blendMode !== "NORMAL") o.blend = f.blendMode.toLowerCase();
      } else if (f.type.startsWith("GRADIENT")) {
        // Carry stops AND the transform — without the transform every gradient renders as a
        // default top-to-bottom, losing its actual angle/direction/scale.
        const g = f as GradientPaint;
        const gp = paintExtras<IrGradientPaint>(g, { type: "gradient", kind: g.type });
        if (isList(g.gradientStops)) {
          gp.stops = await Promise.all(
            g.gradientStops.map(async (s) => {
              const stop: IrGradientStop = { pos: round(s.position), color: rgbaToHex(s.color) };
              const bv = await resolveBoundMap(s.boundVariables); // per-stop color token
              if (bv) stop.tokens = bv;
              return stop;
            })
          );
        }
        if (Array.isArray(g.gradientTransform)) gp.transform = g.gradientTransform;
        o = gp;
      } else if (f.type === "IMAGE") {
        const mp = mediaPaint(f, "image", f.imageHash, f.imageTransform);
        const size = await collectSourceImage(f.imageHash); // native pixel size + register source bytes
        if (size) mp.intrinsicSize = size;
        o = mp;
      } else if (f.type === "VIDEO") {
        o = mediaPaint(f, "video", f.videoHash, f.videoTransform);
      } else if (f.type === "PATTERN") {
        // Tiled pattern fill/stroke (beta) — the source node + tiling geometry.
        const pp = paintExtras<IrPatternPaint>(f, { type: "pattern" });
        if (f.sourceNodeId) pp.sourceNodeId = f.sourceNodeId;
        if (f.tileType) pp.tileType = String(f.tileType).toLowerCase();
        if (typeof f.scalingFactor === "number") pp.scale = f.scalingFactor;
        if (f.spacing) pp.spacing = xy(f.spacing);
        if (f.horizontalAlignment) pp.align = String(f.horizontalAlignment).toLowerCase();
        o = pp;
      } else if (f.type === "SHADER") {
        // Procedural shader fill — the opaque program id correlates the fill to the rendered PNG.
        const sp = paintExtras<IrShaderPaint>(f, { type: "shader" });
        if (f.id) sp.shaderId = f.id;
        o = sp;
      } else {
        // A paint type newer than the typings reaches here only at run time. Carried as its lowercased
        // type (plus the shared extras) rather than dropped; doc-types' closed Paint union cannot name
        // it, so this one object is widened into it.
        const future: Paint = f;
        o = paintExtras(future, { type: future.type.toLowerCase() } as IrPaint);
      }
      // Paint-level variable bindings (e.g. a solid fill's color bound to a token). Per
      // https://developers.figma.com/docs/plugins/api/Paint/ (fetched during this port) and the
      // typings, only SolidPaint (and ColorStop, handled above) carries `boundVariables` — the other
      // paint types never have this field, so there is nothing to read for them.
      const pbv = f.type === "SOLID" ? await resolveBoundMap(f.boundVariables) : undefined;
      if (pbv) o.tokens = pbv;
      return o;
    })
  );
  return out.length ? out : undefined;
}

// Per-side stroke weights, in emitted order.
const SIDE_WEIGHTS: Array<[string, keyof NonNullable<IrStrokes["weights"]>]> = [
  ["strokeTopWeight", "top"],
  ["strokeRightWeight", "right"],
  ["strokeBottomWeight", "bottom"],
  ["strokeLeftWeight", "left"],
];

// Borders — buttons/inputs/cards rely on these; missing them wrecks fidelity.
export async function simplifyStrokes(node: SceneNode): Promise<IrStrokes | undefined> {
  if (!("strokes" in node) || !isList(node.strokes)) return undefined;
  const vis = node.strokes.filter((s) => s.visible !== false);
  if (!vis.length) return undefined;
  const out: IrStrokes = {};
  // `colors` holds COLORS. It used to fall back to the paint's type name for anything non-solid, so a
  // gradient border emitted the string "gradient_linear" in a field consumers read as a hex — pushing
  // "is this element a color or a type name?" onto every codegen profile. Non-solid stroke paints are
  // described by `paints` below (stops/transform/hash/opacity/blend and all), which is strictly more
  // information, so the type-name fallback carried nothing the record didn't already have.
  const solids = vis.filter((s) => s.type === "SOLID");
  if (solids.length) out.colors = solids.map(solidHex);
  if (vis.some((s) => s.type !== "SOLID")) {
    const paints = await simplifyFills(vis);
    if (paints) out.paints = paints;
  }
  const strokeNode = node as GeometryMixin & ComplexStrokesMixin & SceneNode;
  const strokeWeight = strokeNode.strokeWeight;
  if (strokeWeight && strokeWeight !== figma.mixed) {
    out.weight = strokeWeight;
  } else if (strokeWeight === figma.mixed) {
    // Per-side weights (dividers/underlines set only one side) — the mixed fallback.
    const sides: NonNullable<IrStrokes["weights"]> = {};
    SIDE_WEIGHTS.forEach(([k, s]) => {
      const v = numProp(node, k);
      if (v != null) sides[s] = v;
    });
    putNonEmpty(out, "weights", sides);
  }
  const n = strokeNode;
  if (n.strokeAlign) out.align = lower(n.strokeAlign);
  if (n.dashPattern && n.dashPattern.length) out.dash = [...n.dashPattern];
  // Line ends/corners — matter for dividers, dashed lines, arrows/connectors.
  if ("strokeCap" in node && n.strokeCap && n.strokeCap !== figma.mixed && n.strokeCap !== "NONE") out.cap = String(n.strokeCap).toLowerCase();
  if ("strokeJoin" in node && n.strokeJoin && n.strokeJoin !== figma.mixed && n.strokeJoin !== "MITER") out.join = String(n.strokeJoin).toLowerCase();
  if ("strokeMiterLimit" in node && typeof n.strokeMiterLimit === "number" && n.strokeMiterLimit !== 4) out.miter = n.strokeMiterLimit;
  // Tapered/variable-width strokes (illustration-style hand-drawn lines) — no flat CSS equivalent, but
  // record the profile so a consumer can at least render it as an SVG path with a width gradient.
  // Per https://developers.figma.com/docs/plugins/api/VariableWidthStrokeProperties/ (fetched during
  // this port) and node_modules/@figma/plugin-typings/plugin-api.d.ts ~L8669-8697, the real shape is a
  // union: PresetVariableWidthStrokeProperties `{widthProfile}` (one of the 6 named presets, no points)
  // or CustomVariableWidthStrokeProperties `{widthProfile:'CUSTOM', variableWidthPoints:[{position,width}]}`.
  // The old `.strokeWeightProfile.mapping[].position/.value` read used field names that don't exist on
  // this type and was always undefined at runtime — this is a behaviour fix, not a no-op rename: emit
  // `profile` always, and `points` (from `variableWidthPoints`) only for the CUSTOM branch.
  const vw = n.variableWidthStrokeProperties;
  if (vw && vw.widthProfile) {
    const variableWidth: NonNullable<IrStrokes["variableWidth"]> = { profile: lower(vw.widthProfile) };
    if (vw.widthProfile === "CUSTOM" && isList(vw.variableWidthPoints) && vw.variableWidthPoints.length) {
      variableWidth.points = vw.variableWidthPoints.map((p) => ({ pos: round(p.position), width: round(p.width) }));
    }
    out.variableWidth = variableWidth;
  }
  return out;
}
