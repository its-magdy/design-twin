// Shadows / blur / noise / glass / texture / shader. Type-discriminated: BACKGROUND_BLUR
// (backdrop-filter) != LAYER_BLUR (filter) != shadows.
import type {
  Effect as IrEffect, ShadowEffect as IrShadowEffect, BlurEffect as IrBlurEffect, NoiseEffect as IrNoiseEffect,
  GlassEffect as IrGlassEffect, TextureEffect as IrTextureEffect, ShaderEffect as IrShaderEffect,
} from "../../bridge/src/doc-types.ts";
import { round, lower, rgbaToHex, xy, putXY, isList } from "./util";
import { resolveBoundMap } from "./variables";
import { putShaderProperties } from "./paint";

const GLASS_FIELDS: Array<keyof GlassEffect & Exclude<keyof IrGlassEffect, "type" | "tokens">> = ["lightIntensity", "lightAngle", "refraction", "depth", "dispersion", "radius"];

// One Figma effect -> its IR record, bindings aside. Every branch starts from `{ type }` so the emitted
// key order is type-first, exactly as it always was.
function effectBody(e: Effect): IrEffect {
  if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") {
    const o: IrShadowEffect = { type: lower(e.type) };
    if (e.color) o.color = rgbaToHex(e.color);
    if (e.offset) o.offset = xy(e.offset);
    if (typeof e.radius === "number") o.radius = round(e.radius);
    if (typeof e.spread === "number" && e.spread) o.spread = round(e.spread);
    if (e.blendMode && e.blendMode !== "NORMAL") o.blendMode = e.blendMode.toLowerCase();
    if (e.type === "DROP_SHADOW" && e.showShadowBehindNode) o.behindNode = true;
    return o;
  }
  if (e.type === "LAYER_BLUR" || e.type === "BACKGROUND_BLUR") {
    const o: IrBlurEffect = { type: lower(e.type) };
    if (typeof e.radius === "number") o.radius = round(e.radius); // no offset/spread on blurs
    if (e.blurType && e.blurType !== "NORMAL") o.blurType = lower(e.blurType); // NORMAL vs PROGRESSIVE
    // Progressive-blur ramp endpoints are Vectors in normalized object space {x,y} (0,0=top-left,
    // 1,1=bottom-right) — NOT numbers. putXY carries the guard that keeps them from being dropped.
    const be = e as BlurEffectProgressive;
    putXY(o, "startOffset", be.startOffset);
    putXY(o, "endOffset", be.endOffset);
    if (typeof be.startRadius === "number") o.startRadius = round(be.startRadius);
    return o;
  }
  if (e.type === "NOISE") {
    // 2025 grain/noise. noiseType drives extra channels (DUOTONE→secondaryColor, MULTITONE→opacity).
    const o: IrNoiseEffect = { type: "noise" };
    if (e.noiseType) o.noiseType = String(e.noiseType).toLowerCase();
    if (e.color) o.color = rgbaToHex(e.color);
    if (typeof e.density === "number") o.density = round(e.density);
    if (typeof e.noiseSize === "number") o.noiseSize = round(e.noiseSize);
    putXY(o, "noiseSizeVector", e.noiseSizeVector);
    if (e.noiseType === "DUOTONE" && e.secondaryColor) o.secondaryColor = rgbaToHex(e.secondaryColor);
    if (e.noiseType === "MULTITONE" && typeof e.opacity === "number") o.opacity = round(e.opacity);
    if (e.blendMode && e.blendMode !== "NORMAL") o.blendMode = e.blendMode.toLowerCase();
    return o;
  }
  if (e.type === "GLASS") {
    // 2025 liquid-glass effect — every visual characteristic lives in these numbers.
    const o: IrGlassEffect = { type: "glass" };
    for (const k of GLASS_FIELDS) {
      const v = e[k];
      if (typeof v === "number") o[k] = round(v);
    }
    return o;
  }
  if (e.type === "TEXTURE") {
    const o: IrTextureEffect = { type: "texture" };
    if (typeof e.noiseSize === "number") o.noiseSize = round(e.noiseSize);
    putXY(o, "noiseSizeVector", e.noiseSizeVector);
    if (typeof e.radius === "number") o.radius = round(e.radius);
    if (typeof e.clipToShape === "boolean") o.clipToShape = e.clipToShape;
    return o;
  }
  if (e.type === "SHADER") {
    const o: IrShaderEffect = { type: "shader" };
    if (e.id) o.shaderId = e.id; // opaque program id — correlates to the rendered reference PNG
    return o;
  }
  // Any still-newer union member reaches here only at run time (`e` is `never` to the compiler) and
  // falls through as {type} only — read defensively. doc-types' closed Effect union cannot name it, so
  // this one object is widened into it.
  const future: Effect = e;
  return { type: future.type.toLowerCase() } as IrEffect;
}

export async function simplifyEffects(
  effects: ReadonlyArray<Effect> | null | undefined
): Promise<IrEffect[] | undefined> {
  if (!isList(effects)) return undefined; // covers null/undefined too
  const vis = effects.filter((e) => e.visible !== false);
  const out = await Promise.all(
    vis.map(async (e) => {
      const o = effectBody(e);
      // A shader effect's inputs — ShaderEffect.properties (plugin-api.d.ts 1.139.0 L4574-4579, same
      // map as ShaderPaint's; see putShaderProperties in paint.ts for the quote and the IR shape).
      // Async (bound inputs resolve to token names), hence here rather than in the sync effectBody.
      if (e.type === "SHADER" && o.type === "shader") await putShaderProperties(o, e.properties);
      // Effect-level variable bindings (e.g. a shadow's radius/color bound to a token).
      // ShaderEffect declares no boundVariables (the typings), so the read is guarded; absent -> no tokens.
      const bv = await resolveBoundMap("boundVariables" in e ? e.boundVariables : undefined);
      if (bv) o.tokens = o.tokens ? { ...o.tokens, ...bv } : bv;
      return o;
    })
  );
  return out.length ? out : undefined;
}
