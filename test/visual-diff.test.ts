// Unit tests of the visual diff's pure parts: the PNG codec (design-to-code/png.ts), the pixelmatch v6.0.0 port and
// our shift tolerance / regions / attribution / grid (design-to-code/visual-diff.ts), and the capture's budget
// (design-to-code/probe-visual.ts). No browser.  Run with:  node test/visual-diff.test.ts
import { deflateSync, crc32 } from "node:zlib";
import { PngError, decodePng, encodePng, pngInfo } from "../design-to-code/png.ts";
import type { Rgba } from "../design-to-code/png.ts";
import { MASK, attribute, colorDelta, crop, diffOptionsFor, diffPixels, maxDeltaOf, planGrid, referenceCrop, renderDiff, resampleBox } from "../design-to-code/visual-diff.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import * as probeVisual from "../design-to-code/probe-visual.ts";
import { VISUAL_CAP_MS, designedRects, finishVisual, visualBudget, visualLine } from "../design-to-code/probe-visual.ts";
import type { MeasuredVisual } from "../design-to-code/types.ts";
import { BEHAVIOUR_RESERVE_MS } from "../design-to-code/probe-behaviour.ts";
import type { VerifySpec } from "../design-to-code/types.ts";
import { check, report } from "./assert.ts";

console.log("visual diff — png codec, pixelmatch port, shift tolerance, regions, grid, budget:");

// ---------------------------------------------------------------- helpers
const img = (w: number, h: number, fill: [number, number, number, number] = [255, 255, 255, 255]): Rgba => {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(fill, i * 4);
  return { w, h, data };
};
const put = (m: Rgba, x: number, y: number, c: [number, number, number, number]): void => { m.data.set(c, (y * m.w + x) * 4); };
const rect = (m: Rgba, x: number, y: number, w: number, h: number, c: [number, number, number, number]): void => { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) put(m, xx, yy, c); };
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
/** a PNG chunk (CRC by zlib.crc32, as the spec defines it) */
const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
};
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = (w: number, h: number, depth: number, ct: number, interlace = 0): Buffer => {
  const d = Buffer.alloc(13); d.writeUInt32BE(w, 0); d.writeUInt32BE(h, 4); d[8] = depth; d[9] = ct; d[12] = interlace; return chunk("IHDR", d);
};
/** a hand-built PNG of `pix` (raw samples, ch channels per pixel) with every row filtered by `filter` (W3C PNG 3 §9) */
const handPng = (w: number, h: number, ch: number, ct: number, pix: Uint8Array, filter: number, extra: Buffer[] = []): Buffer => {
  const stride = w * ch, raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i++) {
      const x = pix[y * stride + i] ?? 0, a = i >= ch ? pix[y * stride + i - ch] ?? 0 : 0, b = y ? pix[(y - 1) * stride + i] ?? 0 : 0, c = y && i >= ch ? pix[(y - 1) * stride + i - ch] ?? 0 : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      raw[y * (stride + 1) + 1 + i] = (x - pred) & 255;
    }
  }
  return Buffer.concat([SIG, ihdr(w, h, 8, ct), ...extra, chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
};
const throwsMsg = (f: () => unknown): string => { try { f(); return ""; } catch (e) { return e instanceof Error ? `${e instanceof PngError ? "PngError" : "Error"}: ${e.message}` : String(e); } };

// ---------------------------------------------------------------- 1. PNG codec
{
  // a noisy RGBA and RGB image (every byte different) — encode is RGB8, so RGBA round-trips through an opaque copy
  const w = 13, h = 7, rgba = img(w, h);
  for (let i = 0; i < rgba.data.length; i++) rgba.data[i] = (i * 37 + 11) & 255;
  for (let i = 3; i < rgba.data.length; i += 4) rgba.data[i] = 255;
  const back = decodePng(encodePng(rgba));
  check("1 encodePng → decodePng is identical (RGB8 written, opaque RGBA read back)", back.w === w && back.h === h && same(back.data, rgba.data));
  const info = pngInfo(encodePng(rgba));
  check("1 encodePng writes RGB8, non-interlaced", info !== null && info.colorType === 2 && info.bitDepth === 8 && info.interlace === 0);
  // hand-built RGBA (with alpha) and RGB, each filter 0..4 (4 = Paeth)
  const rgbaPix = new Uint8Array(w * h * 4), rgbPix = new Uint8Array(w * h * 3);
  for (let i = 0; i < rgbaPix.length; i++) rgbaPix[i] = (i * 53 + 7 * (i >> 5)) & 255;
  for (let i = 0; i < rgbPix.length; i++) rgbPix[i] = (i * 29 + 3 * (i >> 4)) & 255;
  const rgbAsRgba = new Uint8Array(w * h * 4);
  for (let p = 0; p < w * h; p++) { rgbAsRgba[p * 4] = rgbPix[p * 3] ?? 0; rgbAsRgba[p * 4 + 1] = rgbPix[p * 3 + 1] ?? 0; rgbAsRgba[p * 4 + 2] = rgbPix[p * 3 + 2] ?? 0; rgbAsRgba[p * 4 + 3] = 255; }
  for (const f of [0, 1, 2, 3, 4]) {
    check(`1 decodePng RGBA filter ${f} is exact`, same(decodePng(handPng(w, h, 4, 6, rgbaPix, f)).data, rgbaPix));
    check(`1 decodePng RGB filter ${f} is exact (alpha 255)`, same(decodePng(handPng(w, h, 3, 2, rgbPix, f)).data, rgbAsRgba));
  }
  // unsupported kinds name what they are
  const g = new Uint8Array(w * h);
  check("1 colour type 0 (grey) throws naming the type", /colour type 0/.test(throwsMsg(() => decodePng(handPng(w, h, 1, 0, g, 0)))));
  check("1 colour type 3 (palette) throws naming the type", /colour type 3/.test(throwsMsg(() => decodePng(handPng(w, h, 1, 3, g, 0, [chunk("PLTE", Buffer.alloc(3))])))));
  check("1 colour type 4 (grey + alpha) throws naming the type", /colour type 4/.test(throwsMsg(() => decodePng(handPng(w, h, 2, 4, new Uint8Array(w * h * 2), 0)))));
  const deep = Buffer.concat([SIG, ihdr(2, 2, 16, 6), chunk("IDAT", deflateSync(Buffer.alloc(2 * (1 + 2 * 8)))), chunk("IEND", Buffer.alloc(0))]);
  check("1 a 16-bit file throws naming the depth", /PngError: unsupported PNG \(colour type 6 \/ depth 16/.test(throwsMsg(() => decodePng(deep))));
  const laced = Buffer.concat([SIG, ihdr(2, 2, 8, 6, 1), chunk("IDAT", deflateSync(Buffer.alloc(64))), chunk("IEND", Buffer.alloc(0))]);
  check("1 an interlaced file throws saying so", /interlaced/.test(throwsMsg(() => decodePng(laced))));
  const bad = Buffer.from(encodePng(rgba));
  bad[bad.length - 13] = (bad[bad.length - 13] ?? 0) ^ 0xff; // a byte of the IDAT's CRC... (the last chunk before IEND's 12 bytes)
  check("1 a bad CRC throws", /bad CRC/.test(throwsMsg(() => decodePng(bad))));
  check("1 pngInfo of non-PNG bytes is null", pngInfo(Buffer.from("not a png at all")) === null);
  // the Figma reference's chunks: sRGB (intent 0) + gAMA 45455; and an iCCP profile name
  const srgb = chunk("sRGB", Buffer.from([0])), gama = chunk("gAMA", Buffer.from([0, 0, 0xb1, 0x8f]));
  const iccp = chunk("iCCP", Buffer.concat([Buffer.from("Display P3\0", "latin1"), Buffer.from([0]), deflateSync(Buffer.alloc(16))]));
  const fig = pngInfo(handPng(w, h, 4, 6, rgbaPix, 0, [srgb, gama]));
  check("1 pngInfo reports sRGB + gAMA 45455 (a Figma reference)", fig !== null && fig.srgb && fig.gama === 45455 && fig.iccp === null && fig.w === w && fig.h === h && fig.colorType === 6);
  const p3 = pngInfo(handPng(w, h, 4, 6, rgbaPix, 0, [iccp]));
  check("1 pngInfo reports the iCCP profile's name", p3 !== null && p3.iccp === "Display P3" && !p3.srgb);
}

// ---------------------------------------------------------------- 2. colorDelta = pixelmatch v6's formula
{
  // the v6.0.0 formula, written out independently
  const yiq = (r: number, g: number, b: number): [number, number, number] => [r * 0.29889531 + g * 0.58662247 + b * 0.11448223, r * 0.59597799 - g * 0.27417610 - b * 0.32180189, r * 0.21147017 - g * 0.52261711 + b * 0.31114694];
  const v6 = (p: number[], q: number[]): number => {
    const bl = (c: number, a: number): number => (a < 255 ? 255 + (c - 255) * (a / 255) : c);
    const [y1, i1, q1] = yiq(bl(p[0] ?? 0, p[3] ?? 0), bl(p[1] ?? 0, p[3] ?? 0), bl(p[2] ?? 0, p[3] ?? 0));
    const [y2, i2, q2] = yiq(bl(q[0] ?? 0, q[3] ?? 0), bl(q[1] ?? 0, q[3] ?? 0), bl(q[2] ?? 0, q[3] ?? 0));
    const d = 0.5053 * (y1 - y2) ** 2 + 0.299 * (i1 - i2) ** 2 + 0.1957 * (q1 - q2) ** 2;
    return y1 > y2 ? -d : d;
  };
  const cd = (p: number[], q: number[], yOnly?: boolean): number => colorDelta(Uint8Array.from(p), Uint8Array.from(q), 0, 0, yOnly);
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;
  const W = [255, 255, 255, 255], K = [0, 0, 0, 255];
  check("2 white vs black: the v6 value, negative (image 1 is the brighter)", near(cd(W, K), v6(W, K)) && cd(W, K) < 0 && Math.abs(cd(W, K)) > 32800);
  check("2 black vs white: positive (the sign flips with the order)", near(cd(K, W), -cd(W, K)) && cd(K, W) > 0);
  check("2 a transparent pixel equals white (blend over white, the 6.x rule)", cd([0, 0, 0, 0], W) === 0);
  const half = [200, 40, 90, 128], other = [30, 160, 220, 255];
  check("2 an alpha blend is the v6 value", near(cd(half, other), v6(half, other)));
  check("2 identical pixels: 0", cd(other, other) === 0);
  check("2 yOnly is the signed brightness difference y1 − y2", near(cd(W, K, true), 255 * (0.29889531 + 0.58662247 + 0.11448223)));
  check("2 maxDelta(0.2) = 1408.6", Math.abs(maxDeltaOf(0.2) - 1408.6) < 1e-9);
}

// ---------------------------------------------------------------- 3. anti-aliasing (pixelmatch v6)
{
  // an anti-aliased diagonal edge (coverage → grey), and the same edge one pixel to the right
  const edge = (shift: number): Rgba => {
    const m = img(40, 40);
    for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) {
      const t = x - shift - y - 5; // the edge: x = y + 5 + shift (45°); dark to the right
      const cov = Math.max(0, Math.min(1, t + 0.5));
      const v = Math.round(255 * (1 - cov));
      put(m, x, y, [v, v, v, 255]);
    }
    return m;
  };
  const o = { ...diffOptionsFor(1), shiftPx: 0 };
  const d = diffPixels(edge(0), edge(1), o);
  check(`3 a 1-px-shifted anti-aliased diagonal edge is AA, not counted (aa ${d.aa}, differing ${d.differing})`, d.aa > 0 && d.differing === 0);
  const a = img(60, 60), b = img(60, 60);
  rect(a, 20, 20, 20, 20, [40, 90, 200, 255]); rect(b, 20, 20, 20, 20, [200, 60, 40, 255]);
  const r = diffPixels(a, b, o);
  check(`3 a recoloured 20×20 block is counted (differing ${r.differing}, aa ${r.aa})`, r.differing === 400 && r.aa === 0);
  // a grey pixel between a black band and a white band with exactly 3 equal neighbours: not AA (pixelmatch: "more than 2 equal
  // siblings, it's definitely not anti-aliasing") — pins the `zeroes > 2` bound
  const ref = img(7, 7);
  rect(ref, 0, 0, 7, 3, [0, 0, 0, 255]); rect(ref, 0, 3, 7, 1, [128, 128, 128, 255]); put(ref, 2, 4, [128, 128, 128, 255]);
  const z = diffPixels(ref, img(7, 7), o);
  check("3 three equal siblings: counted, not AA (zeroes > 2)", z.mask[3 * 7 + 3] === MASK.diff);
  check("3 two equal siblings between darker and brighter bands: AA", z.mask[3 * 7 + 5] === MASK.aa);
}

// ---------------------------------------------------------------- 4. shift tolerance (ours)
{
  const a = img(30, 30), b = img(30, 30);
  rect(a, 10, 5, 1, 20, [0, 0, 0, 255]); rect(b, 11, 5, 1, 20, [0, 0, 0, 255]);
  const d = diffPixels(a, b, diffOptionsFor(1));
  check(`4 a 1-px line shifted 1 px: differing > 0, shift-tolerant 0 (differing ${d.differing}, shiftTolerant ${d.shiftTolerant})`, d.differing > 0 && d.shiftTolerant === 0);
  check("4 the absorbed pixels are marked absorbed", d.mask[10 * 30 + 10] === MASK.absorbed && d.hot.length === 0);
  const c = img(30, 30); rect(c, 14, 5, 1, 20, [0, 0, 0, 255]);
  const far = diffPixels(a, c, diffOptionsFor(1));
  check(`4 the same line 4 px away is not absorbed (shiftTolerant ${far.shiftTolerant})`, far.shiftTolerant === far.differing && far.differing > 0);
  check("4 shiftPx = max(1, round(k)) and cellPx = max(2, round(8k))", diffOptionsFor(1.4222).shiftPx === 1 && diffOptionsFor(2).shiftPx === 2 && diffOptionsFor(0.4096).shiftPx === 1 && diffOptionsFor(1.4222).cellPx === 11 && diffOptionsFor(0.1).cellPx === 2);
}

// ---------------------------------------------------------------- 5. regions + attribution at k = 1.4222
{
  const k = 1.4222, w = 400, h = 300;
  const a = img(w, h), b = img(w, h);
  rect(a, 30, 40, 60, 50, [40, 90, 200, 255]); rect(b, 30, 40, 60, 50, [200, 60, 40, 255]); // 3000 px
  rect(a, 250, 150, 100, 80, [10, 120, 60, 255]); rect(b, 250, 150, 100, 80, [240, 200, 20, 255]); // 8000 px
  const d = diffPixels(a, b, diffOptionsFor(k));
  check(`5 two separate blocks → 2 regions (got ${d.hot.length}/${d.hotTotal})`, d.hot.length === 2 && d.hotTotal === 2);
  const [big, small] = d.hot;
  check(`5 sorted by pixels, the bigger first (${big?.pixels}, ${small?.pixels} — the hot cells' differing px)`, big !== undefined && small !== undefined && big.pixels > 7000 && big.pixels <= 8000 && small.pixels > 2500 && small.pixels <= 3000);
  // built rects (frame-relative CSS px): the card around the big block, a smaller badge inside it, an unrelated header
  const built = [{ id: "90:10", rect: { x: 170, y: 100, w: 90, h: 70 } }, { id: "90:14", rect: { x: 180, y: 110, w: 30, h: 20 } }, { id: "90:2", rect: { x: 0, y: 0, w: 280, h: 20 } }];
  const specs: VerifySpec[] = [
    { nodeId: "90:12", name: "Kiln Card", type: "FRAME", x: 15, y: 22, width: 60, height: 50 },
    { nodeId: "90:13", name: "Cone Badge", type: "FRAME", x: 25, y: 30, width: 20, height: 12 },
    { nodeId: "90:20", name: "Firing Title", type: "TEXT", x: 20, width: 80, fontSize: 14 },
    { nodeId: "90:21", name: "Firing Date", type: "TEXT", x: 20, y: 35, width: 80, lineHeight: 20 },
  ];
  const designed = designedRects({ frame: { nodeId: "90:1" }, nodes: specs });
  check("5 designedRects: a TEXT without y has no design rect; a TEXT with y gets one line", !designed.some((x) => x.id === "90:20") && designed.some((x) => x.id === "90:21" && x.rect.h === 20));
  const regions = attribute(d.hot, k, built, designed);
  const r0 = regions[0], r1 = regions[1];
  check(`5 rects in frame-relative CSS px (÷k): ${JSON.stringify(r0?.rect)}`, r0 !== undefined && Math.abs(r0.rect.x - 250 / k) < 8 && Math.abs(r0.rect.y - 150 / k) < 8 && Math.abs(r0.rect.w - 100 / k) < 10 && r0.pct > 25);
  check(`5 built attribution: innermost (smallest) first (${JSON.stringify(r0?.built)})`, r0 !== undefined && r0.built[0] === "90:14" && r0.built[1] === "90:10" && !r0.built.includes("90:2"));
  check(`5 designed attribution: innermost first, TEXT without y excluded (${JSON.stringify(r1?.designed)})`, r1 !== undefined && r1.designed[0] === "90:13" && r1.designed.includes("90:12") && r1.designed.includes("90:21") && !r1.designed.includes("90:20"));
  const pic = renderDiff(b, d);
  const at = (x: number, y: number): number[] => Array.from(pic.data.subarray((y * w + x) * 4, (y * w + x) * 4 + 3));
  check("5 renderDiff: differences red, the region outlined magenta, the rest a pale grey", at(60, 60).join() === "255,0,0" && at((big?.x ?? 0), (big?.y ?? 0) + 5).join() === "255,0,255" && (at(5, 5)[0] ?? 0) > 200);
}

// ---------------------------------------------------------------- 6. reference crop + grid (real scale, invented offset)
{
  const s = 1.4222, png = { w: 2082, h: 1058 }, frame = { w: 1440, h: 720 };
  const c = referenceCrop(png, s, { x: -12, y: -12 }, frame);
  check(`6 crop.x = round(12·1.4222) = 17 (${JSON.stringify(c)})`, c.x === 17 && c.y === 17 && c.w === 2048 && c.h === 1024);
  const c0 = referenceCrop({ w: 2048, h: 1024 }, s, { x: 0, y: 0 }, frame);
  check("6 no offset: the whole PNG", c0.x === 0 && c0.y === 0 && c0.w === 2048 && c0.h === 1024);
  check("6 clamped to the PNG", referenceCrop({ w: 2050, h: 1030 }, s, { x: -12, y: -12 }, frame).w === 2050 - 17);
  const g = planGrid({ w: 2047, h: 1024 }, { w: 2048, h: 1024 });
  check("6 capture 2048 vs crop 2047 → grid reference over the common size, the delta noted", g.grid === "reference" && g.w === 2047 && g.h === 1024 && g.note !== null && /2048×1024/.test(g.note) && /2047×1024/.test(g.note));
  const eq = planGrid({ w: 2048, h: 1024 }, { w: 2048, h: 1024 });
  check("6 equal sizes → reference, no note", eq.grid === "reference" && eq.note === null);
  const off = planGrid({ w: 2048, h: 1024 }, { w: 2048, h: 1029 });
  check("6 5 px off → the 1x fallback, with why", off.grid === "1x" && /resampled to 1x/.test(off.why));
  const cr = crop(img(10, 10), { x: 8, y: 8, w: 5, h: 5 });
  check("6 crop clamps to the image", cr.w === 2 && cr.h === 2 && cr.data.length === 16);
}

// ---------------------------------------------------------------- 7. resampleBox
{
  const m = img(8, 6);
  for (let by = 0; by < 3; by++) for (let bx = 0; bx < 4; bx++) rect(m, bx * 2, by * 2, 2, 2, [bx * 60, by * 100, 30 + bx * by * 10, 255]);
  const r = resampleBox(m, 4, 3);
  let exact = r.w === 4 && r.h === 3;
  for (let by = 0; by < 3; by++) for (let bx = 0; bx < 4; bx++) { const p = (by * 4 + bx) * 4; exact &&= r.data[p] === bx * 60 && r.data[p + 1] === by * 100 && r.data[p + 2] === 30 + bx * by * 10 && r.data[p + 3] === 255; }
  check("7 2× → 1× on uniform 2×2 blocks is exact", exact);
  const mix = img(2, 1); put(mix, 0, 0, [0, 0, 0, 255]); put(mix, 1, 0, [255, 255, 255, 255]);
  const one = resampleBox(mix, 1, 1);
  check("7 the area average of black + white is mid grey", Math.abs((one.data[0] ?? 0) - 128) <= 1);
  const tr = img(2, 1); put(tr, 0, 0, [0, 0, 0, 0]); put(tr, 1, 0, [200, 100, 50, 255]);
  const t1 = resampleBox(tr, 1, 1);
  check("7 a transparent pixel adds no colour (alpha-weighted)", t1.data[0] === 200 && t1.data[1] === 100 && t1.data[2] === 50 && Math.abs((t1.data[3] ?? 0) - 128) <= 1);
}

// ---------------------------------------------------------------- 8. the capture's budget
{
  check("8 the cap is 30 s and the reserve is behaviour's (imported)", VISUAL_CAP_MS === 30_000 && BEHAVIOUR_RESERVE_MS === 20_000);
  check("8 plenty of time → the cap", visualBudget(0, 180_000) === 30_000);
  check("8 little time → what is left less the reserve", visualBudget(1_000, 1_000 + BEHAVIOUR_RESERVE_MS + 7_000) === 7_000);
  check("8 no time → 0, never negative", visualBudget(0, BEHAVIOUR_RESERVE_MS - 1) === 0 && visualBudget(0, 5_000) === 0);
  check("8 explicit cap / reserve", visualBudget(0, 100_000, 10_000, 5_000) === 10_000 && visualBudget(0, 12_000, 10_000, 5_000) === 7_000);
}

// ---- elapsedMs is the capture's own time + the diff step's, never the behaviour battery in between
{
  const w = 40, h = 30, a = img(w, h), b = img(w, h); rect(b, 5, 5, 10, 10, [0, 0, 0, 255]);
  const r4 = { x: 0, y: 0, w, h };
  const out = finishVisual({
    expectation: { frame: { nodeId: "90:1", name: "Firings", w, h, clip: true }, nodes: [] },
    prep: { ok: true, ref: { usable: true, path: "design/export/assets/90_1_ref.png", sha256: "x", png: { w, h }, scale: 1, offset: { x: 0, y: 0 }, from: "index", crop: r4 }, bytes: encodePng(a), frameSize: { w, h }, notes: [] },
    capture: { png: encodePng(b), dsf: 1, clip: r4, shot: r4, frame: { nodeId: "90:1", via: "tag", selector: null }, built: [], notes: [] },
    diffPath: "design/verify/Firings.diff.png", captureMs: 1234,
  });
  const v = out.visual;
  check("[own] finishVisual elapsedMs = captureMs + the diff step (1234 ≤ elapsed < 1234 + 5000), not time since the capture started",
    v.ran === true && v.elapsedMs >= 1234 && v.elapsedMs < 6234);
  if (!v.ran || !(v.elapsedMs >= 1234)) console.log("    got", v.ran ? v.elapsedMs : v.why);
}

// ---------------------------------------------------------------- malformed and out-of-root reference images
console.log("finishVisual and prepareVisual guards:");
// (namespace lookups: this part runs — and fails cleanly — against a probe-visual without these exports)
const pv: Record<string, unknown> = { ...probeVisual };
const safe = (name: string, fn: () => boolean): boolean => { let r = false; try { r = fn(); } catch (e) { console.log(`    (threw: ${e instanceof Error ? e.message : String(e)})`); } return check(name, r); };
const okRef = { usable: true, path: "design/export/assets/90_1_ref.png", sha256: "x", png: { w: 40, h: 30 }, scale: 1, offset: { x: 0, y: 0 }, from: "index", crop: { x: 0, y: 0, w: 40, h: 30 } } as const;
const fin = (refPng: Rgba, shotPng: Rgba, offset = { x: 0, y: 0 }): MeasuredVisual => {
  const r4 = { x: 0, y: 0, w: shotPng.w, h: shotPng.h };
  return finishVisual({
    expectation: { frame: { nodeId: "90:1", name: "Firings", w: shotPng.w, h: shotPng.h, clip: true }, nodes: [] },
    prep: { ok: true, ref: { ...okRef, png: { w: refPng.w, h: refPng.h }, offset, crop: { x: 0, y: 0, w: refPng.w, h: refPng.h } }, bytes: encodePng(refPng), frameSize: { w: shotPng.w, h: shotPng.h }, notes: [] },
    capture: { png: encodePng(shotPng), dsf: 1, clip: r4, shot: r4, frame: { nodeId: "90:1", via: "tag", selector: null }, built: [], notes: [] },
    diffPath: "design/verify/Firings.diff.png", captureMs: 0,
  }).visual;
};
// a malformed referenceImage is {ok:false}, never a throw
{
  const prep = (ri: unknown): string => {
    const exp: Record<string, unknown> = { reference: "assets/90_1_ref.png", frame: { nodeId: "90:1", name: "Firings", w: 40, h: 30 }, referenceImage: ri };
    const r = probeVisual.prepareVisual(exp, os.tmpdir());
    return r.ok ? "(ok)" : r.why;
  };
  const MAL = "the expectation's referenceImage is malformed — re-run --expect";
  safe("referenceImage null → {ok:false} 'malformed — re-run --expect' (no TypeError)", () => prep(null) === MAL);
  safe("referenceImage \"off\" → malformed (never a why-less ran:false)", () => prep("off") === MAL);
  safe("{usable:true} without its fields → malformed (not 'the reference PNG undefined is missing')", () => prep({ usable: true }) === MAL && prep({ usable: "yes", path: 5 }) === MAL);
}
// the reference root is the project owning the expectation
{
  // read through a type guard so this file still loads (and fails) against a probe-visual.ts without referenceRoot
  const isRoot = (f: unknown): f is (e: string, p: string) => string => typeof f === "function";
  const rr = pv.referenceRoot;
  const root = (e: string, p: string): string => (isRoot(rr) ? rr(e, p) : "(no referenceRoot)");
  const mono = path.resolve("/r/mono"), app = path.join(mono, "apps", "web");
  safe("--expected <root>/design/verify/S.expected.json → <root>, whatever --project is", () => root(path.join(mono, "design", "verify", "S.expected.json"), app) === mono);
  safe("an expectation elsewhere (a stage dir) → --project", () => root(path.join(mono, ".stage", "S.expected.json"), app) === app && root(path.join(mono, "verify", "S.expected.json"), app) === app);
}
// the reference path must stay inside <root>/design/export
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "visual-diff-f7-"));
  const outside = encodePng(img(40, 30));
  fs.mkdirSync(path.join(dir, "design", "export"), { recursive: true });
  fs.writeFileSync(path.join(dir, "secret.png"), outside);
  const sha = crypto.createHash("sha256").update(outside).digest("hex");
  const why = (p: string): string => {
    const r = probeVisual.prepareVisual({ reference: "assets/x.png", frame: { nodeId: "90:1", name: "Firings", w: 40, h: 30 }, referenceImage: { ...okRef, path: p, sha256: sha } }, dir);
    return r.ok ? "(ok — read)" : r.why;
  };
  safe(`design/export/../../secret.png → not read, 'outside design/export' (${why("design/export/../../secret.png")})`, () => /outside design\/export/.test(why("design/export/../../secret.png")));
  safe("a path not under design/export at all → outside", () => /outside design\/export/.test(why("secret.png")));
  fs.rmSync(dir, { recursive: true, force: true });
}
// the decoder's pixel cap (before inflating) and maxOutputLength
{
  const huge = Buffer.concat([SIG, ihdr(5000, 5000, 8, 6), chunk("IDAT", deflateSync(Buffer.alloc(10))), chunk("IEND", Buffer.alloc(0))]);
  const t0 = Date.now(), msg = throwsMsg(() => decodePng(huge));
  safe(`a 5000×5000 IHDR → PngError naming the size, before inflating (${msg})`, () => /^PngError: .*5000×5000/.test(msg) && Date.now() - t0 < 1000);
  // a 4×2 RGB image whose IDAT inflates to far more than (stride+1)·h
  const extra = Buffer.concat([SIG, ihdr(4, 2, 8, 2), chunk("IDAT", deflateSync(Buffer.alloc(1_000_000))), chunk("IEND", Buffer.alloc(0))]);
  safe(`image data inflating past (stride+1)·h → PngError (maxOutputLength) (${throwsMsg(() => decodePng(extra))})`, () => /^PngError: bad image data/.test(throwsMsg(() => decodePng(extra))));
  const exact = handPng(4, 2, 3, 2, new Uint8Array(24).fill(7), 0);
  safe("…an exact-size image still decodes", () => decodePng(exact).w === 4);
}
// the 1x fallback never resamples non-uniformly; its note says "resampled"
{
  const g = planGrid({ w: 2048, h: 1000 }, { w: 2048, h: 1024 });
  safe(`reference crop 2048×1000 vs capture 2048×1024 (aspects 2.4 % apart) → grid none, why 'different shapes' (${g.grid})`, () => g.grid === "none" && /different shapes/.test(g.why));
  const u = planGrid({ w: 1000, h: 500 }, { w: 2048, h: 1024 });
  safe("the same shape at another size → the 1x fallback still runs", () => u.grid === "1x");
  safe("the 1x note says resampling (s < 1 upsamples), never 'downscaling'", () => u.grid === "1x" && /resampling can hide a difference/.test(u.why) && !/downscal/.test(u.why));
  const v = fin(img(40, 20), img(40, 30));
  safe(`finishVisual: a reference shorter than the frame → ran:false, nothing stretched (${v.ran ? "ran" : v.why})`, () => !v.ran && /different shapes/.test(v.why));
}
// A positive offset gets a note
{
  const v = fin(img(40, 30), img(40, 30), { x: 3, y: 0 });
  const v0 = fin(img(40, 30), img(40, 30));
  safe("offset > 0 → a note 'render bounds inside the frame box — alignment unverified'; offset 0 → none", () =>
    v.ran && v.notes.some((n) => /render bounds lie inside the frame box \(offset 3,0\) — alignment unverified/.test(n)) && v0.ran && !v0.notes.some((n) => /alignment unverified/.test(n)));
}
// hot cells: ≥ max(4, 0.08 · cell²) shift-tolerant differing px
{
  const k = 1.4222, a = img(300, 120), b = img(300, 120);
  rect(a, 20, 40, 200, 2, [51, 51, 51, 255]); // a dark 1-CSS-px border (2 device px) the build lacks
  const d = diffPixels(a, b, diffOptionsFor(k));
  safe(`[hot] a missing 1-CSS-px line (2 of 11 rows of a cell) is a region now (${d.hotTotal}; it never reached 25 %)`, () => d.hotTotal >= 1 && d.shiftTolerant > 0);
  const o = diffOptionsFor(k);
  safe("[hot] the options record the rule: hotFraction 0.08, hotMinPx 4", () => o.hotFraction === 0.08 && o.hotMinPx === 4);
  const s1 = img(40, 40), s2 = img(40, 40); put(s2, 21, 21, [0, 0, 0, 255]);
  const one = diffPixels(s1, s2, diffOptionsFor(0.1)); // 2×2-px cells: 0.08·4 = 0.32 px — the minimum of 4 decides
  safe(`[hot] one differing pixel in a 2-px cell is no region (min 4 px) (${one.shiftTolerant} px, ${one.hotTotal} region(s))`, () => one.shiftTolerant === 1 && one.hotTotal === 0);
  const s3 = img(40, 40); rect(s3, 20, 20, 2, 2, [0, 0, 0, 255]);
  const four = diffPixels(s1, s3, diffOptionsFor(0.1));
  safe(`[hot] a whole 2×2 cell (4 px) is (${four.hotTotal})`, () => four.hotTotal === 1);
  const e1 = img(300, 120), e2 = img(300, 120);
  rect(e2, 299, 0, 1, 120, [60, 60, 60, 255]); rect(e2, 0, 0, 300, 1, [60, 60, 60, 255]); // a part-page edge column + row
  const edge = diffPixels(e1, e2, diffOptionsFor(k));
  safe(`[hot] at a fractional scale the 1-px edge ring is no region (a frame at y 200 CSS starts at device row 284.42) (${edge.hotTotal}, ${edge.shiftTolerant} px still differ)`, () => edge.hotTotal === 0 && edge.shiftTolerant > 0 && diffOptionsFor(k).edgePx === 1);
  const at2 = diffPixels(e1, e2, diffOptionsFor(2));
  safe(`[hot] …at an integer scale (k 2) the edge is counted (${at2.hotTotal})`, () => diffOptionsFor(2).edgePx === 0 && at2.hotTotal >= 1);
  const vf = fin(img(40, 30), img(40, 30));
  safe("[hot] measured.visual records hotFraction 0.08 and hotMinPx 4", () => vf.ran && vf.hotFraction === 0.08 && vf.hotMinPx === 4);
}
// the probe's line leads with the number the report headline leads with, in the same words
{
  const b = img(40, 30); rect(b, 5, 5, 10, 10, [0, 0, 0, 255]);
  const v = fin(img(40, 30), b);
  const line = v.ran ? visualLine({ ...v, differingPct: 0.6, shiftTolerantPct: 0.47 }) : "";
  safe(`visualLine: '0.5% of pixels differ (0.6% before 1-px shift tolerance)' (${line.slice(0, 110)})`, () => /never the verdict\) 0\.5% of pixels differ \(0\.6% before 1-px shift tolerance\)/.test(line));
}

report();
