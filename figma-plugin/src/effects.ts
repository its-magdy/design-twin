// Shadows / blur / noise / glass / texture / shader. Type-discriminated: BACKGROUND_BLUR
// (backdrop-filter) != LAYER_BLUR (filter) != shadows.
import { Obj, round, rgbaToHex, xy, putXY } from "./util";
import { resolveBoundMap } from "./variables";

const GLASS_FIELDS = ["lightIntensity", "lightAngle", "refraction", "depth", "dispersion", "radius"];

export async function simplifyEffects(
  effects: ReadonlyArray<Effect> | null | undefined
): Promise<Obj[] | undefined> {
  if (!Array.isArray(effects)) return undefined; // covers null/undefined too
  const vis = effects.filter((e) => e.visible !== false);
  const out = await Promise.all(
    vis.map(async (e) => {
      const o: Obj = { type: e.type.toLowerCase() };
      if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") {
        if (e.color) o.color = rgbaToHex(e.color);
        if (e.offset) o.offset = xy(e.offset);
        if (typeof e.radius === "number") o.radius = round(e.radius);
        if (typeof e.spread === "number" && e.spread) o.spread = round(e.spread);
        if (e.blendMode && e.blendMode !== "NORMAL") o.blendMode = e.blendMode.toLowerCase();
        if (e.type === "DROP_SHADOW" && (e as DropShadowEffect).showShadowBehindNode) o.behindNode = true;
      } else if (e.type === "LAYER_BLUR" || e.type === "BACKGROUND_BLUR") {
        if (typeof e.radius === "number") o.radius = round(e.radius); // no offset/spread on blurs
        if (e.blurType && e.blurType !== "NORMAL") o.blurType = e.blurType.toLowerCase(); // NORMAL vs PROGRESSIVE
        // Progressive-blur ramp endpoints are Vectors in normalized object space {x,y} (0,0=top-left,
        // 1,1=bottom-right) — NOT numbers. putXY carries the guard that keeps them from being dropped.
        const be = e as BlurEffectProgressive;
        putXY(o, "startOffset", be.startOffset);
        putXY(o, "endOffset", be.endOffset);
        if (typeof be.startRadius === "number") o.startRadius = round(be.startRadius);
      } else if (e.type === "NOISE") {
        // 2025 grain/noise. noiseType drives extra channels (DUOTONE→secondaryColor, MULTITONE→opacity).
        const ne = e as any;
        if (ne.noiseType) o.noiseType = String(ne.noiseType).toLowerCase();
        if (ne.color) o.color = rgbaToHex(ne.color);
        if (typeof ne.density === "number") o.density = round(ne.density);
        if (typeof ne.noiseSize === "number") o.noiseSize = round(ne.noiseSize);
        putXY(o, "noiseSizeVector", ne.noiseSizeVector);
        if (ne.secondaryColor) o.secondaryColor = rgbaToHex(ne.secondaryColor);
        if (typeof ne.opacity === "number") o.opacity = round(ne.opacity);
        if (ne.blendMode && ne.blendMode !== "NORMAL") o.blendMode = ne.blendMode.toLowerCase();
      } else if (e.type === "GLASS") {
        // 2025 liquid-glass effect — every visual characteristic lives in these numbers.
        const ge = e as any;
        for (const k of GLASS_FIELDS) {
          if (typeof ge[k] === "number") o[k] = round(ge[k]);
        }
      } else if (e.type === "TEXTURE") {
        const te = e as any;
        if (typeof te.noiseSize === "number") o.noiseSize = round(te.noiseSize);
        putXY(o, "noiseSizeVector", te.noiseSizeVector);
        if (typeof te.radius === "number") o.radius = round(te.radius);
        if (typeof te.clipToShape === "boolean") o.clipToShape = te.clipToShape;
      } else if (e.type === "SHADER") {
        const se = e as any;
        if (se.id) o.shaderId = se.id; // opaque program id — correlates to the rendered reference PNG
      }
      // Any still-newer union member falls through as {type} only — read defensively.
      // Effect-level variable bindings (e.g. a shadow's radius/color bound to a token).
      const bv = await resolveBoundMap((e as any).boundVariables);
      if (bv) o.tokens = bv;
      return o;
    })
  );
  return out.length ? out : undefined;
}
