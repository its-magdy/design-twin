// Unit tests of the visual diff's pure parts: the PNG codec and the bridge's header-only pngSize
// (bridge/src/png.ts), the pixelmatch v6.0.0 port and our shift tolerance / regions / attribution / grid
// (design-to-code/visual-diff.ts), and the capture's budget (design-to-code/probe-visual.ts). No browser.
// Run with:  bun test/visual-diff.test.ts
import { deflateSync, crc32 } from "node:zlib";
import { PngError, crop, decodePng, encodePng, pngInfo, pngSize, resampleBox } from "../bridge/src/png.ts";
import type { Rgba } from "../bridge/src/png.ts";
import { MASK, attribute, colorDelta, diffOptionsFor, diffPixels, maxDeltaOf, planGrid, referenceCrop, renderDiff } from "../design-to-code/visual-diff.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import * as probeVisual from "../design-to-code/probe-visual.ts";
import { designedRects, finishVisual, visualLine } from "../design-to-code/probe-visual.ts";
import type { MeasuredVisual } from "../design-to-code/types.ts";
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

// ---------------------------------------------------------------- png: PNG codec
{
  // a noisy RGBA and RGB image (every byte different) — encode is RGB8, so RGBA round-trips through an opaque copy
  const w = 13, h = 7, rgba = img(w, h);
  for (let i = 0; i < rgba.data.length; i++) rgba.data[i] = (i * 37 + 11) & 255;
  for (let i = 3; i < rgba.data.length; i += 4) rgba.data[i] = 255;
  const back = decodePng(encodePng(rgba));
  check("[png] encodePng → decodePng is identical (RGB8 written, opaque RGBA read back)", back.w === w && back.h === h && same(back.data, rgba.data));
  const info = pngInfo(encodePng(rgba));
  check("[png] encodePng writes RGB8, non-interlaced", info !== null && info.colorType === 2 && info.bitDepth === 8 && info.interlace === 0);
  // hand-built RGBA (with alpha) and RGB, each filter 0..4 (4 = Paeth)
  const rgbaPix = new Uint8Array(w * h * 4), rgbPix = new Uint8Array(w * h * 3);
  for (let i = 0; i < rgbaPix.length; i++) rgbaPix[i] = (i * 53 + 7 * (i >> 5)) & 255;
  for (let i = 0; i < rgbPix.length; i++) rgbPix[i] = (i * 29 + 3 * (i >> 4)) & 255;
  const rgbAsRgba = new Uint8Array(w * h * 4);
  for (let p = 0; p < w * h; p++) { rgbAsRgba[p * 4] = rgbPix[p * 3] ?? 0; rgbAsRgba[p * 4 + 1] = rgbPix[p * 3 + 1] ?? 0; rgbAsRgba[p * 4 + 2] = rgbPix[p * 3 + 2] ?? 0; rgbAsRgba[p * 4 + 3] = 255; }
  for (const f of [0, 1, 2, 3, 4]) {
    check(`[png] decodePng RGBA filter ${f} is exact`, same(decodePng(handPng(w, h, 4, 6, rgbaPix, f)).data, rgbaPix));
    check(`[png] decodePng RGB filter ${f} is exact (alpha 255)`, same(decodePng(handPng(w, h, 3, 2, rgbPix, f)).data, rgbAsRgba));
  }
  // unsupported kinds name what they are
  const g = new Uint8Array(w * h);
  check("[png] colour type 0 (grey) throws naming the type", /colour type 0/.test(throwsMsg(() => decodePng(handPng(w, h, 1, 0, g, 0)))));
  check("[png] colour type 3 (palette) throws naming the type", /colour type 3/.test(throwsMsg(() => decodePng(handPng(w, h, 1, 3, g, 0, [chunk("PLTE", Buffer.alloc(3))])))));
  check("[png] colour type 4 (grey + alpha) throws naming the type", /colour type 4/.test(throwsMsg(() => decodePng(handPng(w, h, 2, 4, new Uint8Array(w * h * 2), 0)))));
  const deep = Buffer.concat([SIG, ihdr(2, 2, 16, 6), chunk("IDAT", deflateSync(Buffer.alloc(2 * (1 + 2 * 8)))), chunk("IEND", Buffer.alloc(0))]);
  check("[png] a 16-bit file throws naming the depth", /PngError: unsupported PNG \(colour type 6 \/ depth 16/.test(throwsMsg(() => decodePng(deep))));
  const laced = Buffer.concat([SIG, ihdr(2, 2, 8, 6, 1), chunk("IDAT", deflateSync(Buffer.alloc(64))), chunk("IEND", Buffer.alloc(0))]);
  check("[png] an interlaced file throws saying so", /interlaced/.test(throwsMsg(() => decodePng(laced))));
  const bad = Buffer.from(encodePng(rgba));
  bad[bad.length - 13] = (bad[bad.length - 13] ?? 0) ^ 0xff; // a byte of the IDAT's CRC... (the last chunk before IEND's 12 bytes)
  check("[png] a bad CRC throws", /bad CRC/.test(throwsMsg(() => decodePng(bad))));
  check("[png] pngInfo of non-PNG bytes is null", pngInfo(Buffer.from("not a png at all")) === null);
  // the Figma reference's chunks: sRGB (intent 0) + gAMA 45455; and an iCCP profile name
  const srgb = chunk("sRGB", Buffer.from([0])), gama = chunk("gAMA", Buffer.from([0, 0, 0xb1, 0x8f]));
  const iccp = chunk("iCCP", Buffer.concat([Buffer.from("Display P3\0", "latin1"), Buffer.from([0]), deflateSync(Buffer.alloc(16))]));
  const fig = pngInfo(handPng(w, h, 4, 6, rgbaPix, 0, [srgb, gama]));
  check("[png] pngInfo reports sRGB + gAMA 45455 (a Figma reference)", fig !== null && fig.srgb && fig.gama === 45455 && fig.iccp === null && fig.w === w && fig.h === h && fig.colorType === 6);
  const p3 = pngInfo(handPng(w, h, 4, 6, rgbaPix, 0, [iccp]));
  check("[png] pngInfo reports the iCCP profile's name", p3 !== null && p3.iccp === "Display P3" && !p3.srgb);
  // pngSize reads the signature + IHDR header alone: it keeps a size where pngInfo (every chunk CRC-checked) gives up
  const whole = handPng(w, h, 4, 6, rgbaPix, 0);
  const sized = (b: Uint8Array): string => JSON.stringify(pngSize(b));
  const want = JSON.stringify({ w, h });
  check("[png] pngSize of a whole PNG is its IHDR size", sized(whole) === want);
  const badIdat = chunk("IDAT", Buffer.alloc(4)); badIdat[badIdat.length - 1] = (badIdat[badIdat.length - 1] ?? 0) ^ 0xff;
  const badCrcPng = Buffer.concat([SIG, ihdr(w, h, 8, 6), badIdat, chunk("IEND", Buffer.alloc(0))]);
  check("[png] pngSize ignores a later chunk's bad CRC (pngInfo refuses it)", sized(badCrcPng) === want && pngInfo(badCrcPng) === null);
  check("[png] pngSize of a truncated file (header intact) is still the size", sized(whole.subarray(0, 48)) === want && pngInfo(whole.subarray(0, 48)) === null);
  const bareHeader = Buffer.alloc(24); SIG.copy(bareHeader, 0); bareHeader.writeUInt32BE(13, 8); bareHeader.write("IHDR", 12, "latin1"); bareHeader.writeUInt32BE(w, 16); bareHeader.writeUInt32BE(h, 20);
  check("[png] pngSize reads a 24-byte header with no CRC", sized(bareHeader) === want);
  check("[png] pngSize of a header cut inside the height is null", pngSize(bareHeader.subarray(0, 23)) === null);
  check("[png] pngSize of non-PNG bytes, a bad signature or an IHDR chunk under 13 bytes is null", pngSize(Buffer.from("not a png at all, long enough to hold a header")) === null && pngSize(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), bareHeader.subarray(8)])) === null && pngSize(Buffer.concat([bareHeader.subarray(0, 8), Buffer.from([0, 0, 0, 8]), bareHeader.subarray(12)])) === null);
  check("[png] pngSize reports the claimed size without bounding it (decodePng is what refuses a huge one)", sized(Buffer.concat([SIG, ihdr(0xffffffff, 0xfffffffe, 8, 6)])) === JSON.stringify({ w: 0xffffffff, h: 0xfffffffe }));
}

// ---------------------------------------------------------------- color-delta: colorDelta = pixelmatch v6's formula
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
  check("[color-delta] white vs black: the v6 value, negative (image 1 is the brighter)", near(cd(W, K), v6(W, K)) && cd(W, K) < 0 && Math.abs(cd(W, K)) > 32800);
  check("[color-delta] black vs white: positive (the sign flips with the order)", near(cd(K, W), -cd(W, K)) && cd(K, W) > 0);
  check("[color-delta] a transparent pixel equals white (blend over white, the 6.x rule)", cd([0, 0, 0, 0], W) === 0);
  const half = [200, 40, 90, 128], other = [30, 160, 220, 255];
  check("[color-delta] an alpha blend is the v6 value", near(cd(half, other), v6(half, other)));
  check("[color-delta] identical pixels: 0", cd(other, other) === 0);
  check("[color-delta] yOnly is the signed brightness difference y1 − y2", near(cd(W, K, true), 255 * (0.29889531 + 0.58662247 + 0.11448223)));
  check("[color-delta] maxDelta(0.2) = 1408.6", Math.abs(maxDeltaOf(0.2) - 1408.6) < 1e-9);
}

// ---------------------------------------------------------------- aa: anti-aliasing (pixelmatch v6)
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
  check(`[aa] a 1-px-shifted anti-aliased diagonal edge is AA, not counted (aa ${d.aa}, differing ${d.differing})`, d.aa > 0 && d.differing === 0);
  const a = img(60, 60), b = img(60, 60);
  rect(a, 20, 20, 20, 20, [40, 90, 200, 255]); rect(b, 20, 20, 20, 20, [200, 60, 40, 255]);
  const r = diffPixels(a, b, o);
  check(`[aa] a recoloured 20×20 block is counted (differing ${r.differing}, aa ${r.aa})`, r.differing === 400 && r.aa === 0);
  // a grey pixel between a black band and a white band with exactly 3 equal neighbours: not AA (pixelmatch: "more than 2 equal
  // siblings, it's definitely not anti-aliasing") — pins the `zeroes > 2` bound
  const ref = img(7, 7);
  rect(ref, 0, 0, 7, 3, [0, 0, 0, 255]); rect(ref, 0, 3, 7, 1, [128, 128, 128, 255]); put(ref, 2, 4, [128, 128, 128, 255]);
  const z = diffPixels(ref, img(7, 7), o);
  check("[aa] three equal siblings: counted, not AA (zeroes > 2)", z.mask[3 * 7 + 3] === MASK.diff);
  check("[aa] two equal siblings between darker and brighter bands: AA", z.mask[3 * 7 + 5] === MASK.aa);
}

// ---------------------------------------------------------------- shift: shift tolerance (ours)
{
  const a = img(30, 30), b = img(30, 30);
  rect(a, 10, 5, 1, 20, [0, 0, 0, 255]); rect(b, 11, 5, 1, 20, [0, 0, 0, 255]);
  const d = diffPixels(a, b, diffOptionsFor(1));
  check(`[shift] a 1-px line shifted 1 px: differing > 0, shift-tolerant 0 (differing ${d.differing}, shiftTolerant ${d.shiftTolerant})`, d.differing > 0 && d.shiftTolerant === 0);
  check("[shift] the absorbed pixels are marked absorbed", d.mask[10 * 30 + 10] === MASK.absorbed && d.hot.length === 0);
  const c = img(30, 30); rect(c, 14, 5, 1, 20, [0, 0, 0, 255]);
  const far = diffPixels(a, c, diffOptionsFor(1));
  check(`[shift] the same line 4 px away is not absorbed (shiftTolerant ${far.shiftTolerant})`, far.shiftTolerant === far.differing && far.differing > 0);
  check("[shift] shiftPx = max(1, round(k)) and cellPx = max(2, round(8k))", diffOptionsFor(1.4222).shiftPx === 1 && diffOptionsFor(2).shiftPx === 2 && diffOptionsFor(0.4096).shiftPx === 1 && diffOptionsFor(1.4222).cellPx === 11 && diffOptionsFor(0.1).cellPx === 2);
}

// ---------------------------------------------------------------- regions: regions + attribution at k = 1.4222
{
  const k = 1.4222, w = 400, h = 300;
  const a = img(w, h), b = img(w, h);
  rect(a, 30, 40, 60, 50, [40, 90, 200, 255]); rect(b, 30, 40, 60, 50, [200, 60, 40, 255]); // 3000 px
  rect(a, 250, 150, 100, 80, [10, 120, 60, 255]); rect(b, 250, 150, 100, 80, [240, 200, 20, 255]); // 8000 px
  const d = diffPixels(a, b, diffOptionsFor(k));
  check(`[regions] two separate blocks → 2 regions (got ${d.hot.length}/${d.hotTotal})`, d.hot.length === 2 && d.hotTotal === 2);
  const [big, small] = d.hot;
  check(`[regions] sorted by pixels, the bigger first (${big?.pixels}, ${small?.pixels} — the hot cells' differing px)`, big !== undefined && small !== undefined && big.pixels > 7000 && big.pixels <= 8000 && small.pixels > 2500 && small.pixels <= 3000);
  // built rects (frame-relative CSS px): the card around the big block, a smaller badge inside it, an unrelated header
  const built = [{ id: "90:10", rect: { x: 170, y: 100, w: 90, h: 70 } }, { id: "90:14", rect: { x: 180, y: 110, w: 30, h: 20 } }, { id: "90:2", rect: { x: 0, y: 0, w: 280, h: 20 } }];
  const specs: VerifySpec[] = [
    { nodeId: "90:12", name: "Kiln Card", type: "FRAME", x: 15, y: 22, width: 60, height: 50 },
    { nodeId: "90:13", name: "Cone Badge", type: "FRAME", x: 25, y: 30, width: 20, height: 12 },
    { nodeId: "90:20", name: "Firing Title", type: "TEXT", x: 20, width: 80, fontSize: 14 },
    { nodeId: "90:21", name: "Firing Date", type: "TEXT", x: 20, y: 35, width: 80, lineHeight: 20 },
  ];
  const designed = designedRects({ frame: { nodeId: "90:1" }, nodes: specs });
  check("[regions] designedRects: a TEXT without y has no design rect; a TEXT with y gets one line", !designed.some((x) => x.id === "90:20") && designed.some((x) => x.id === "90:21" && x.rect.h === 20));
  const regions = attribute(d.hot, k, built, designed);
  const r0 = regions[0], r1 = regions[1];
  check(`[regions] rects in frame-relative CSS px (÷k): ${JSON.stringify(r0?.rect)}`, r0 !== undefined && Math.abs(r0.rect.x - 250 / k) < 8 && Math.abs(r0.rect.y - 150 / k) < 8 && Math.abs(r0.rect.w - 100 / k) < 10 && r0.pct > 25);
  check(`[regions] built attribution: innermost (smallest) first (${JSON.stringify(r0?.built)})`, r0 !== undefined && r0.built[0] === "90:14" && r0.built[1] === "90:10" && !r0.built.includes("90:2"));
  check(`[regions] designed attribution: innermost first, TEXT without y excluded (${JSON.stringify(r1?.designed)})`, r1 !== undefined && r1.designed[0] === "90:13" && r1.designed.includes("90:12") && r1.designed.includes("90:21") && !r1.designed.includes("90:20"));
  const pic = renderDiff(b, d);
  const at = (x: number, y: number): number[] => Array.from(pic.data.subarray((y * w + x) * 4, (y * w + x) * 4 + 3));
  check("[regions] renderDiff: differences red, the region outlined magenta, the rest a pale grey", at(60, 60).join() === "255,0,0" && at((big?.x ?? 0), (big?.y ?? 0) + 5).join() === "255,0,255" && (at(5, 5)[0] ?? 0) > 200);
}

// ---------------------------------------------------------------- crop: reference crop + grid (real scale, invented offset)
{
  const s = 1.4222, png = { w: 2082, h: 1058 }, frame = { w: 1440, h: 720 };
  const c = referenceCrop(png, s, { x: -12, y: -12 }, frame);
  check(`[crop] crop.x = round(12·1.4222) = 17 (${JSON.stringify(c)})`, c.x === 17 && c.y === 17 && c.w === 2048 && c.h === 1024);
  const c0 = referenceCrop({ w: 2048, h: 1024 }, s, { x: 0, y: 0 }, frame);
  check("[crop] no offset: the whole PNG", c0.x === 0 && c0.y === 0 && c0.w === 2048 && c0.h === 1024);
  check("[crop] clamped to the PNG", referenceCrop({ w: 2050, h: 1030 }, s, { x: -12, y: -12 }, frame).w === 2050 - 17);
  const g = planGrid({ w: 2047, h: 1024 }, { w: 2048, h: 1024 });
  check("[crop] capture 2048 vs crop 2047 → grid reference over the common size, the delta noted", g.grid === "reference" && g.w === 2047 && g.h === 1024 && g.note !== null && /2048×1024/.test(g.note) && /2047×1024/.test(g.note));
  const eq = planGrid({ w: 2048, h: 1024 }, { w: 2048, h: 1024 });
  check("[crop] equal sizes → reference, no note", eq.grid === "reference" && eq.note === null);
  const off = planGrid({ w: 2048, h: 1024 }, { w: 2048, h: 1029 });
  check("[crop] 5 px off → the 1x fallback, with why", off.grid === "1x" && /resampled to 1x/.test(off.why));
  const cr = crop(img(10, 10), { x: 8, y: 8, w: 5, h: 5 });
  check("[crop] crop clamps to the image", cr.w === 2 && cr.h === 2 && cr.data.length === 16);
}

// ---------------------------------------------------------------- resample: resampleBox
{
  const m = img(8, 6);
  for (let by = 0; by < 3; by++) for (let bx = 0; bx < 4; bx++) rect(m, bx * 2, by * 2, 2, 2, [bx * 60, by * 100, 30 + bx * by * 10, 255]);
  const r = resampleBox(m, 4, 3);
  let exact = r.w === 4 && r.h === 3;
  for (let by = 0; by < 3; by++) for (let bx = 0; bx < 4; bx++) { const p = (by * 4 + bx) * 4; exact &&= r.data[p] === bx * 60 && r.data[p + 1] === by * 100 && r.data[p + 2] === 30 + bx * by * 10 && r.data[p + 3] === 255; }
  check("[resample] 2× → 1× on uniform 2×2 blocks is exact", exact);
  const mix = img(2, 1); put(mix, 0, 0, [0, 0, 0, 255]); put(mix, 1, 0, [255, 255, 255, 255]);
  const one = resampleBox(mix, 1, 1);
  check("[resample] the area average of black + white is mid grey", Math.abs((one.data[0] ?? 0) - 128) <= 1);
  const tr = img(2, 1); put(tr, 0, 0, [0, 0, 0, 0]); put(tr, 1, 0, [200, 100, 50, 255]);
  const t1 = resampleBox(tr, 1, 1);
  check("[resample] a transparent pixel adds no colour (alpha-weighted)", t1.data[0] === 200 && t1.data[1] === 100 && t1.data[2] === 50 && Math.abs((t1.data[3] ?? 0) - 128) <= 1);
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
  safe(`[hot] a missing 1-CSS-px line (2 of 11 rows of a cell) is a region (${d.hotTotal}; under 25 % of the cell)`, () => d.hotTotal >= 1 && d.shiftTolerant > 0);
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

// ---------------------------------------------------------------- equivalence: the faster diff / resample / crop yield the same bytes
// The digests below were recorded from the implementation before the speed-ups (matchedNear with pixel p's colour computed once,
// byte-equal rows skipped, the row-wise resample intermediate, the identity crop / resample returning the image). Each digest
// covers everything the evidence carries: the counts, the hot regions, the per-pixel mask and the encoded diff image (diff);
// the size and every byte (resample, crop). A corpus: antialiased glyph strokes, gradients, translucent pixels, transparent vs
// white, 1–2 px shifts, re-flowed text, changes at the first / last byte and at row ends, integer and fractional scales, and
// unaligned views (a byteOffset not a multiple of 4).
console.log("equivalence corpus (digests from the pre-speed-up implementation):");
{
  const lcg = (seed: number): (() => number) => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; };
  /** a page-like image: a gradient header band, cards with antialiased glyph strokes, a translucent ramp (alpha: a translucent background) */
  const page = (w: number, h: number, seed: number, alpha = false): Rgba => {
    const rnd = lcg(seed), d = new Uint8Array(w * h * 4);
    const set = (x: number, y: number, c: number[]): void => { if (x < 0 || y < 0 || x >= w || y >= h) return; d.set(c, (y * w + x) * 4); };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) set(x, y, y < 12 ? [40 + Math.floor(x * 180 / w), 60, 200, 255] : [244, 246, 250, alpha ? 128 + ((x * 7 + y * 3) & 127) : 255]);
    for (let cy = 16; cy + 30 < h; cy += 34) for (let cx = 4; cx + 40 < w; cx += 44) {
      for (let y = cy; y < cy + 30; y++) for (let x = cx; x < cx + 40; x++) set(x, y, [255, 255, 255, 255]);
      for (let g = 0; g < 10; g++) { // glyphs: a dark core with grey antialiased edges
        const gx = cx + 3 + Math.floor(rnd() * 32), gy = cy + 3 + Math.floor(rnd() * 22), gw = 1 + Math.floor(rnd() * 3), gh = 3 + Math.floor(rnd() * 4);
        for (let y = gy - 1; y <= gy + gh; y++) for (let x = gx - 1; x <= gx + gw; x++) {
          const edge = y === gy - 1 || y === gy + gh || x === gx - 1 || x === gx + gw, v = edge ? 140 + Math.floor(rnd() * 90) : 30;
          set(x, y, [v, v, v + 10, 255]);
        }
      }
    }
    for (let y = Math.floor(h * 0.6); y < Math.floor(h * 0.6) + 6; y++) for (let x = 0; x < w; x++) set(x, y, [200, 30, 30, Math.floor(255 * x / w)]);
    return { w, h, data: d };
  };
  const copy = (m: Rgba): Rgba => ({ w: m.w, h: m.h, data: m.data.slice() });
  const shifted = (m: Rgba, dx: number, dy: number): Rgba => {
    const o = copy(m);
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) { const sx = Math.min(m.w - 1, Math.max(0, x - dx)), sy = Math.min(m.h - 1, Math.max(0, y - dy)); o.data.set(m.data.subarray((sy * m.w + sx) * 4, (sy * m.w + sx) * 4 + 4), (y * m.w + x) * 4); }
    return o;
  };
  const edit = (m: Rgba, f: (d: Uint8Array, w: number) => void): Rgba => { const o = copy(m); f(o.data, o.w); return o; };
  /** the same pixels at a byteOffset of `off` */
  const unaligned = (m: Rgba, off: number): Rgba => { const buf = new Uint8Array(m.data.length + off + 3); buf.set(m.data, off); return { w: m.w, h: m.h, data: buf.subarray(off, off + m.data.length) }; };
  const digest = (head: unknown, ...parts: Uint8Array[]): string => { const hh = crypto.createHash("sha256").update(JSON.stringify(head)); for (const p of parts) hh.update(p); return hh.digest("hex").slice(0, 16); };
  const diffDigest = (a: Rgba, b: Rgba, k: number): string => { const d = diffPixels(a, b, diffOptionsFor(k)); return digest([d.compared, d.differing, d.aa, d.shiftTolerant, d.hot, d.hotTotal], d.mask, encodePng(renderDiff(b, d))); };

  const base = page(97, 83, 1), alpha = page(64, 50, 2, true);
  const sparse = edit(base, (d, w) => { for (let y = 40; y < 46; y++) for (let x = 50; x < 58; x++) d.set([20, 20, 20, 255], (y * w + x) * 4); });
  const rowEnds = edit(base, (d, w) => { for (let y = 20; y < 30; y++) { d.set([0, 0, 0, 255], (y * w) * 4); d.set([0, 0, 0, 255], (y * w + w - 1) * 4); } });
  const variants: Array<[string, Rgba, Rgba, string[]]> = [
    ["identical", base, copy(base), ["08b9b4367319e84f", "08b9b4367319e84f", "08b9b4367319e84f", "08b9b4367319e84f"]],
    ["changed", base, edit(base, (d) => { for (let i = 0; i < d.length; i += 4) { d[i] = 255 - (d[i] ?? 0); d[i + 1] = 255 - (d[i + 1] ?? 0); } }), ["925936c192b86f4d", "35f11bbe168070e7", "f9411c1e33fae983", "e986d10949f495b3"]],
    ["sparse", base, sparse, ["79ac2107d00935aa", "9b8806ab97781d66", "6573ba4b7c3e6a4b", "4ab8ca726c48c408"]],
    ["shift 1 px", base, shifted(base, 1, 0), ["0de3fe7718ffa03d", "0de3fe7718ffa03d", "0de3fe7718ffa03d", "0de3fe7718ffa03d"]],
    ["shift 2,1 px", base, shifted(base, 2, 1), ["a961b869ad4a4e6a", "6987fe0baf137a01", "0031ea066969a14b", "0031ea066969a14b"]],
    ["re-flowed text", base, page(97, 83, 3), ["76d9c923a57a0b6c", "3c0990c1d84c10d5", "19425467efee5dc8", "54a9f81bead64510"]],
    ["first / last byte", base, edit(base, (d) => { d[0] = 0; d[d.length - 1] = 0; d[d.length - 2] = 0; }), ["ecabece2160eff87", "ecabece2160eff87", "ecabece2160eff87", "ecabece2160eff87"]],
    ["row ends", base, rowEnds, ["234e44fb15ed0fd2", "84220d62ce745caa", "84220d62ce745caa", "84220d62ce745caa"]],
    ["red channel", base, edit(base, (d) => { for (let i = 0; i < d.length; i += 4) d[i] = 255 - (d[i] ?? 0); }), ["9a698bfe34ee6ed0", "18674dc86d3ed6e3", "b1ad6c5713ae7d85", "361d0b5411c1ade0"]],
    ["alpha", alpha, edit(alpha, (d) => { for (let i = 3; i < d.length; i += 12) d[i] = 255 - (d[i] ?? 0); }), ["9f2884f73b35837e", "12461eb3b9beab43", "a820a885567f2619", "18b6c036d9ed0f7a"]],
    ["alpha shift", alpha, shifted(alpha, 1, 1), ["a2249eb22eecf5b5", "a2249eb22eecf5b5", "a2249eb22eecf5b5", "a2249eb22eecf5b5"]],
    ["transparent vs white", edit(alpha, (d) => { for (let i = 0; i < d.length / 2; i += 4) d.set([17, 99, 3, 0], i); }), edit(alpha, (d) => { for (let i = 0; i < d.length / 2; i += 4) d.set([255, 255, 255, 255], i); }), ["1f3149402b110380", "1f3149402b110380", "1f3149402b110380", "1f3149402b110380"]],
  ];
  const ks = [1, 1.4222, 2, 3], bad: string[] = [];
  for (const [name, a, b, want] of variants) ks.forEach((k, i) => { const got = diffDigest(a, b, k); if (got !== want[i]) bad.push(`${name} k=${k}: ${got}`); });
  const views: Array<[string, Rgba, Rgba, number, string]> = [
    ["shift 1 px", unaligned(base, 1), unaligned(shifted(base, 1, 0), 3), 1.4222, "0de3fe7718ffa03d"],
    ["sparse", unaligned(base, 3), unaligned(sparse, 1), 2, "6573ba4b7c3e6a4b"],
    ["identical", unaligned(base, 2), unaligned(base, 1), 1, "08b9b4367319e84f"],
    ["row ends", unaligned(base, 1), unaligned(rowEnds, 2), 1, "234e44fb15ed0fd2"],
    // read from the buffer's start instead of the view's, white rows would look equal to b's: the first byte must count
    ["row start", unaligned(img(20, 10), 1), edit(img(20, 10), (d) => { d[0] = 0; }), 1, "8af367e55e28cb44"],
  ];
  for (const [name, a, b, k, want] of views) { const got = diffDigest(a, b, k); if (got !== want) bad.push(`unaligned ${name} k=${k}: ${got}`); }
  check(`[equivalence] diffPixels + renderDiff: ${variants.length * ks.length + views.length} cases, the same counts / regions / mask / diff image${bad.length ? ` — differ: ${bad.join("; ")}` : ""}`, bad.length === 0);
  const sh = diffPixels(base, shifted(base, 2, 1), diffOptionsFor(1.4222)), ch = diffPixels(base, variants[1]?.[2] ?? base, diffOptionsFor(2));
  check(`[equivalence] the corpus reaches every mask value and hot regions (shift: ${sh.aa} aa / ${sh.differing - sh.shiftTolerant} absorbed / ${sh.shiftTolerant} differ; changed: ${ch.hotTotal} region(s))`,
    sh.aa > 0 && sh.differing - sh.shiftTolerant > 0 && sh.shiftTolerant > 0 && ch.hotTotal > 0);

  const p = page(97, 83, 5), al = page(64, 50, 6, true), noise = edit(page(31, 17, 7), (d) => { const r = lcg(9); for (let i = 0; i < d.length; i++) d[i] = Math.floor(r() * 256); });
  const resamples: Array<[string, Rgba, number, number, string]> = [
    ["page 1.4222 down", p, 68, 58, "ded7ac305e534a2c"], ["page up", p, 139, 118, "f559dcac0684cb5f"], ["page same width", p, 97, 80, "eb775fee29cbae57"],
    ["page same height", p, 90, 83, "b40163d988ed4918"], ["page half", p, 48, 41, "45baabe124e878f4"], ["page 1×1", p, 1, 1, "cfa062c9a2976b27"],
    ["alpha down", al, 45, 35, "9bfdf5b7e2725f30"], ["alpha up", al, 91, 71, "5abf352f753cca93"], ["noise down", noise, 13, 7, "b1b542feb9fdd4c1"],
    ["noise up", noise, 62, 34, "ba4b3783fe47d67e"], ["noise one row", noise, 31, 1, "713909aa1b39e714"], ["noise 3× odd", noise, 10, 6, "ec4009a9f458c3f5"],
    ["noise unaligned", unaligned(noise, 1), 22, 12, "fc207b5e99e6a810"], ["page identity", p, 97, 83, "b7b3edfd643f317c"],
  ];
  const badR = resamples.flatMap(([name, m, w, h, want]) => { const r = resampleBox(m, w, h), got = digest([r.w, r.h], r.data); return got === want ? [] : [`${name}: ${got}`]; });
  check(`[equivalence] resampleBox: ${resamples.length} cases (colour, alpha, edges, rounding, up / down / one axis), the same bytes${badR.length ? ` — differ: ${badR.join("; ")}` : ""}`, badR.length === 0);

  const c = page(97, 83, 8);
  const crops: Array<[string, Rgba, { x: number; y: number; w: number; h: number }, string]> = [
    ["identity", c, { x: 0, y: 0, w: 97, h: 83 }, "09161e4617d42121"], ["inner", c, { x: 3, y: 5, w: 40, h: 30 }, "c92012ea91b66b1c"],
    ["fractional", c, { x: 1.4, y: 2.6, w: 50.5, h: 20.2 }, "7067c880907fe69f"], ["clamped", c, { x: 90, y: 80, w: 20, h: 20 }, "1b2fd6ccc45c8278"],
    ["oversized", c, { x: -5, y: -5, w: 200, h: 200 }, "09161e4617d42121"], ["unaligned identity", unaligned(c, 1), { x: 0, y: 0, w: 97, h: 83 }, "09161e4617d42121"],
  ];
  const badC = crops.flatMap(([name, m, r, want]) => { const o = crop(m, r), got = digest([o.w, o.h], o.data); return got === want ? [] : [`${name}: ${got}`]; });
  check(`[equivalence] crop: ${crops.length} cases, the same bytes${badC.length ? ` — differ: ${badC.join("; ")}` : ""}`, badC.length === 0);
  check("[identity] a whole-image crop and a same-size resample are the image itself (no copy); a smaller crop is a copy",
    crop(c, { x: 0, y: 0, w: 97, h: 83 }) === c && crop(c, { x: -5, y: -5, w: 200, h: 200 }) === c && resampleBox(c, 97, 83) === c && crop(c, { x: 0, y: 0, w: 96, h: 83 }).data.buffer !== c.data.buffer);
}

report();
