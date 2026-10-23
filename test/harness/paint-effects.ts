// Paints, strokes, effects and corner radii: hex formatting, the selection's gradient rect, the overlay node's
// gradient/image/pattern/shader paints and blur/noise/glass effects, the fully-rounded radius sentinel. Directly
// serialized nodes carry no getCSSAsync, so their output does not depend on whether a collector left css on.
import { ok } from "../assert.ts";
import { must } from "../fixtures.ts";
import type { RadiusCorners } from "../../bridge/src/doc-types.ts";
import { flatPaint, flatEffect, type Case } from "./helpers.ts";
import { world } from "./scene.ts";
import { selection } from "./screen-read.ts";
import { overlay } from "./read-misc.ts";

export const cases: Case[] = [{
  name: "colours are written by formatHex: an alpha that rounds to 255 is opaque",
  async run() {
    const { api } = world();
    // ---- colours are written by bridge/src/hex-color.ts formatHex: an alpha that rounds to 255 is opaque (6 digits),
    // 0.999 × 255 = 254.745 -> 255; 0.5 × 255 = 127.5 -> 128 = 0x80. Channels 0.1/0.3/0.9 × 255 = 25.5/76.5/229.5 -> 1a/4d/e6.
    const hexFrame = { type: "RECTANGLE", name: "HexAlpha", visible: true, id: "hx:1", width: 10, height: 10,
      fills: [{ type: "SOLID", visible: true, color: { r: 0.1, g: 0.3, b: 0.9 }, opacity: 0.999 }, { type: "SOLID", visible: true, color: { r: 1, g: 0, b: 0 }, opacity: 0.5 }] };
    const hexOut = await api.serialize(hexFrame, 0, false);
    const hexFills = hexOut.fills ?? [];
    ok("[formatHex] a paint at opacity 0.999 exports as 6-digit #1a4de6 (alpha rounds to opaque); at 0.5 as #ff000080",
      hexFills.length === 2 && flatPaint(must(hexFills[0], "hexFills[0]")).color === "#1a4de6" && flatPaint(must(hexFills[1], "hexFills[1]")).color === "#ff000080");
  },
}, {
  name: "overlay node paints and strokes: gradient transform, image hash + intrinsic size, stroke cap/join",
  async run() {
    const abs = await overlay();
    const abs0 = flatPaint(must(abs.fills?.[0], "abs.fills[0]"));
    ok("gradient transform carried", Array.isArray(abs0.transform) && abs0.transform?.[0]?.[0] === 1);
    const abs1 = flatPaint(must(abs.fills?.[1], "abs.fills[1]"));
    ok("image hash carried", abs1.hash === "abc123");
    ok("image intrinsicSize via getImageByHash", !!(abs1.intrinsicSize && abs1.intrinsicSize.w === 800 && abs1.intrinsicSize.h === 600));
    ok("stroke cap + join carried", abs.strokes?.cap === "round" && abs.strokes?.join === "round");
  },
}, {
  name: "the selection's gradient rect: stops, per-side strokes, ordered effects, per-corner radius, effect token",
  async run() {
    const { rect } = await selection();
    const rect0 = must(rect.fills?.[0], "rect.fills[0]");
    ok("gradient stops carried", rect0.type === "gradient" && Array.isArray(flatPaint(rect0).stops) && flatPaint(rect0).stops?.length === 2);
    ok("gradient stop color hex", flatPaint(rect0).stops?.[0]?.color === "#ff0000");
    ok("per-side stroke weights (mixed fallback)", !!(rect.strokes?.weights && rect.strokes?.weights.bottom === 2));
    ok("effects ordered array len 2", Array.isArray(rect.effects) && rect.effects.length === 2);
    const rectE0 = must(rect.effects?.[0], "rect.effects[0]");
    ok("drop_shadow discriminated", rectE0.type === "drop_shadow" && flatEffect(rectE0).offset?.y === 2);
    const rectE1 = must(rect.effects?.[1], "rect.effects[1]");
    ok("background_blur no offset", rectE1.type === "background_blur" && flatEffect(rectE1).offset === undefined);
    ok("per-corner radius (mixed fallback)", !!(rect.radius && (rect.radius as RadiusCorners).tl === 8 && (rect.radius as RadiusCorners).bl === undefined));
    // (Tier 1 token bindings)
    ok("effect bound variable -> token name", !!(rect.effects?.[0]?.tokens && rect.effects?.[0]?.tokens.radius === "misc/bad"));
  },
}, {
  name: "radius: two things never land in `radius`, which a builder copies verbatim into CSS",
  async run() {
    const { api } = world();
    const pill = await api.serialize(
      { type: "RECTANGLE", name: "Pill", visible: true, id: "r:full", width: 120, height: 32,
        absoluteBoundingBox: { x: 0, y: 0, width: 120, height: 32 }, cornerRadius: 1000000000 }, 0, false);
    ok("radius: Figma's 'fully rounded' sentinel is not emitted as 1000000000", pill.radius !== 1000000000);
    ok("radius: it is clamped to what Figma actually renders — half the shorter side", pill.radius === 16);
    ok("radius: and the INTENT survives as radiusFull, so a builder can emit 50% / .infinity", pill.radiusFull === true);
    const dusty = await api.serialize(
      { type: "RECTANGLE", name: "Card", visible: true, id: "r:dust", width: 100, height: 100,
        absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 }, cornerRadius: 60.00000762939453 }, 0, false);
    ok("radius: float dust from a resize is rounded like every other emitted number", dusty.radius === 60);
    ok("radius: an ordinary radius carries no radiusFull flag", dusty.radiusFull === undefined);
  },
}, {
  name: "READ additions (verified vs developers.figma.com 2026-07-23): overlay node effects and paints",
  async run() {
    const abs = await overlay();
    // progressive-blur startOffset/endOffset are Vectors {x,y}, not numbers (kept, not dropped).
    const absEffect0 = flatEffect(must(abs.effects?.[0], "abs.effects[0]"));
    ok("progressive blur endOffset Vector kept", !!(absEffect0.blurType === "progressive" && absEffect0.endOffset && absEffect0.endOffset.y === 1));
    const absEffect1 = must(abs.effects?.[1], "abs.effects[1]");
    ok("noise effect fields", absEffect1.type === "noise" && absEffect1.noiseType === "multitone" && absEffect1.opacity === 0.3);
    const absEffect2 = must(abs.effects?.[2], "abs.effects[2]");
    ok("glass effect fields", absEffect2.type === "glass" && absEffect2.refraction === 0.2 && absEffect2.depth === 4);
    const abs1 = flatPaint(must(abs.fills?.[1], "abs.fills[1]"));
    ok("image filters carried", !!(abs1.filters && abs1.filters.saturation === -0.5 && abs1.filters.exposure === undefined));
    const absFill2 = must(abs.fills?.[2], "abs.fills[2]");
    ok("pattern paint fields", absFill2.type === "pattern" && absFill2.sourceNodeId === "9:99" && absFill2.tileType === "rectangular");
    const absFill3 = abs.fills?.[3];
    ok("shader paint id captured", absFill3 !== undefined && absFill3.type === "shader" && absFill3.shaderId === "shader_1");
  },
}];
