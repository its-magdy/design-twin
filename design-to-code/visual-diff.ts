/*! visual-diff.ts — colorDelta, antialiased and hasManySiblings are a port of pixelmatch v6.0.0 (index.js,
 * https://github.com/mapbox/pixelmatch/tree/v6.0.0), under its licence:
 *
 * ISC License
 *
 * Copyright (c) 2024, Mapbox
 *
 * Permission to use, copy, modify, and/or distribute this software for any purpose
 * with or without fee is hereby granted, provided that the above copyright notice
 * and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
 * REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
 * FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
 * INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
 * OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
 * TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
 * THIS SOFTWARE.
 *
 * The colour metric is from Y. Kotsarenko and F. Ramos, "Measuring perceived color difference using YIQ NTSC
 * transmission color space in mobile applications" (2010); the anti-aliasing detector from V. Vysniauskas,
 * "Anti-aliased Pixel and Intensity Slope Detector" (2009).
 */
// The visual diff (informational — never the fidelity verdict): the built frame captured at the reference's
// scale against the Figma reference, pixel by pixel. Pure (no I/O); the probe (probe-visual.ts) feeds it.
//
// What is pixelmatch's (v6.0.0, the classic YIQ algorithm — the published 7.x is the same metric; OKLab is unreleased main):
// colorDelta (blend over white below alpha 255 — the 6.x rule, so transparent equals white), the threshold
// (maxDelta = 35215·t²; t = 0.2, Playwright toHaveScreenshot's default), and the anti-aliasing test (only on a pixel already
// over the threshold; a pixel that is AA in either image is not counted). Not ported: the identical-image Uint32Array fast path
// (it throws on a Buffer whose byteOffset is not a multiple of 4), the options object and the drawing.
//
// What is ours (NOT pixelmatch): the shift tolerance (a differing pixel whose colour each image has within `shiftPx` device px
// of it is "absorbed" — a 1-CSS-px layout shift or a glyph placed a pixel over is not a region), the hot cells and regions, the
// attribution to node ids, and the diff image.
import { crop, resampleBox } from "./png.ts";
import type { Rgba } from "./png.ts";
import type { Rect4, VisualRegion } from "./types.ts";

export { crop, resampleBox };

// ---------------------------------------------------------------- pixelmatch v6.0.0 (ported verbatim, typed)
const rgb2y = (r: number, g: number, b: number): number => r * 0.29889531 + g * 0.58662247 + b * 0.11448223;
const rgb2i = (r: number, g: number, b: number): number => r * 0.59597799 - g * 0.27417610 - b * 0.32180189;
const rgb2q = (r: number, g: number, b: number): number => r * 0.21147017 - g * 0.52261711 + b * 0.31114694;
/** blend a semi-transparent colour with white */
const blend = (c: number, a: number): number => 255 + (c - 255) * a;

/** The squared YIQ distance between pixel k of img1 and pixel m of img2 (byte offsets), negative when the img1 pixel is the
 *  brighter (pixelmatch: "negative if the img2 pixel is darker"); with yOnly, the signed brightness difference y1 − y2. */
export function colorDelta(img1: Uint8Array, img2: Uint8Array, k: number, m: number, yOnly?: boolean): number {
  let r1 = img1[k] ?? 0, g1 = img1[k + 1] ?? 0, b1 = img1[k + 2] ?? 0, a1 = img1[k + 3] ?? 0;
  let r2 = img2[m] ?? 0, g2 = img2[m + 1] ?? 0, b2 = img2[m + 2] ?? 0, a2 = img2[m + 3] ?? 0;
  if (a1 === a2 && r1 === r2 && g1 === g2 && b1 === b2) return 0;
  if (a1 < 255) { a1 /= 255; r1 = blend(r1, a1); g1 = blend(g1, a1); b1 = blend(b1, a1); }
  if (a2 < 255) { a2 /= 255; r2 = blend(r2, a2); g2 = blend(g2, a2); b2 = blend(b2, a2); }
  const y1 = rgb2y(r1, g1, b1), y2 = rgb2y(r2, g2, b2), y = y1 - y2;
  if (yOnly) return y; // brightness difference only
  const i = rgb2i(r1, g1, b1) - rgb2i(r2, g2, b2), q = rgb2q(r1, g1, b1) - rgb2q(r2, g2, b2);
  const delta = 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q;
  // encode whether the pixel lightens or darkens in the sign
  return y1 > y2 ? -delta : delta;
}
/** The maximum acceptable square YIQ distance for a threshold (35215 is the metric's maximum). */
export const maxDeltaOf = (threshold: number): number => 35215 * threshold * threshold;

/** Is pixel (x1, y1) of img likely part of anti-aliasing (Vysniauskas 2009) — pixelmatch v6.0.0 `antialiased`. */
function antialiased(img: Uint8Array, x1: number, y1: number, width: number, height: number, img2: Uint8Array): boolean {
  const x0 = Math.max(x1 - 1, 0), y0 = Math.max(y1 - 1, 0), x2 = Math.min(x1 + 1, width - 1), y2 = Math.min(y1 + 1, height - 1);
  const pos = (y1 * width + x1) * 4;
  let zeroes = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2 ? 1 : 0;
  let min = 0, max = 0, minX = 0, minY = 0, maxX = 0, maxY = 0;
  // go through 8 adjacent pixels
  for (let x = x0; x <= x2; x++) {
    for (let y = y0; y <= y2; y++) {
      if (x === x1 && y === y1) continue;
      // brightness delta between the center pixel and adjacent one
      const delta = colorDelta(img, img, pos, (y * width + x) * 4, true);
      // count the number of equal, darker and brighter adjacent pixels
      if (delta === 0) {
        zeroes++;
        // if found more than 2 equal siblings, it's definitely not anti-aliasing
        if (zeroes > 2) return false;
      } else if (delta < min) { // remember the darkest pixel
        min = delta; minX = x; minY = y;
      } else if (delta > max) { // remember the brightest pixel
        max = delta; maxX = x; maxY = y;
      }
    }
  }
  // if there are no both darker and brighter pixels among siblings, it's not anti-aliasing
  if (min === 0 || max === 0) return false;
  // if either the darkest or the brightest pixel has 3+ equal siblings in both images
  // (definitely not anti-aliased), this pixel is anti-aliased
  return (hasManySiblings(img, minX, minY, width, height) && hasManySiblings(img2, minX, minY, width, height)) ||
    (hasManySiblings(img, maxX, maxY, width, height) && hasManySiblings(img2, maxX, maxY, width, height));
}
/** Does pixel (x1, y1) have 3+ adjacent pixels of the same colour — pixelmatch v6.0.0 `hasManySiblings`. */
function hasManySiblings(img: Uint8Array, x1: number, y1: number, width: number, height: number): boolean {
  const x0 = Math.max(x1 - 1, 0), y0 = Math.max(y1 - 1, 0), x2 = Math.min(x1 + 1, width - 1), y2 = Math.min(y1 + 1, height - 1);
  const pos = (y1 * width + x1) * 4;
  let zeroes = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2 ? 1 : 0;
  // go through 8 adjacent pixels
  for (let x = x0; x <= x2; x++) {
    for (let y = y0; y <= y2; y++) {
      if (x === x1 && y === y1) continue;
      const pos2 = (y * width + x) * 4;
      if (img[pos] === img[pos2] && img[pos + 1] === img[pos2 + 1] && img[pos + 2] === img[pos2 + 2] && img[pos + 3] === img[pos2 + 3]) zeroes++;
      if (zeroes > 2) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- ours: shift tolerance, cells, regions
export interface DiffOptions {
  /** pixelmatch threshold (0..1) */
  threshold: number;
  /** shift-tolerance radius, device px */
  shiftPx: number;
  /** hot-cell side, device px */
  cellPx: number;
  /** a cell is hot when at least max(hotMinPx, hotFraction · cellPx²) of its pixels are shift-tolerant differences — the
   *  fraction is of a WHOLE cell (also at the image's edge) */
  hotFraction: number;
  /** …and never fewer than this many px (a 2×2-px cell at a small scale is not hot from one pixel) */
  hotMinPx: number;
  /** the outermost `edgePx` device px of the image on each side are not counted for hot cells (they still count as
   *  differing): at a fractional scale the window's edge pixels are part frame, part page / shadow margin */
  edgePx: number;
  maxRegions: number;
}
/** mask values per pixel */
export const MASK = { same: 0, diff: 1, aa: 2, absorbed: 3 } as const;
export interface PixelDiff {
  compared: number;
  /** over the threshold and not anti-aliasing — pixelmatch's count (absorbed ones included) */
  differing: number;
  aa: number;
  /** differing − absorbed by the shift tolerance */
  shiftTolerant: number;
  /** MASK per pixel */
  mask: Uint8Array;
  /** hot regions, device px on the compared grid, most differing pixels first (≤ maxRegions) */
  hot: Array<Rect4 & { pixels: number }>;
  /** every hot region found */
  hotTotal: number;
}

/** The diff options for k device px per CSS px (8-CSS-px cells, shift radius max(1, round(k)); at a fractional k the 1-px
 *  edge ring is not counted for regions — a frame at y 200 CSS starts at device row 284.42, so row 284 is part page). A cell is hot at
 *  max(4, 0.08 · cell²) shift-tolerant differing px: the shift tolerance already removes 1-px jitter, so the cell rule
 *  only has to say where to look — a 1-CSS-px line (≤ 2 of 11 rows at 1.4222x) or a replaced string's strokes reach 8 %, they
 *  never reached the earlier 25 %. */
export function diffOptionsFor(k: number): DiffOptions {
  return { threshold: 0.2, shiftPx: Math.max(1, Math.round(k)), cellPx: Math.max(2, Math.round(8 * k)), hotFraction: 0.08, hotMinPx: 4, edgePx: Number.isInteger(k) ? 0 : 1, maxRegions: 10 };
}

/** Is pixel p of `a` matched within `r` px of p by some pixel of `b` (within maxDelta)? */
function matchedNear(a: Uint8Array, b: Uint8Array, x: number, y: number, w: number, h: number, r: number, maxDelta: number): boolean {
  const p = (y * w + x) * 4;
  for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) {
    for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
      if (Math.abs(colorDelta(a, b, p, (yy * w + xx) * 4)) <= maxDelta) return true;
    }
  }
  return false;
}

/** Compare two equal-sized images (ref = image 1, build = image 2). Throws when the sizes differ. */
export function diffPixels(ref: Rgba, build: Rgba, o: DiffOptions): PixelDiff {
  if (ref.w !== build.w || ref.h !== build.h || ref.data.length !== build.data.length) throw new Error(`image sizes do not match (${ref.w}×${ref.h} vs ${build.w}×${build.h})`);
  const { w, h } = ref, a = ref.data, b = build.data;
  if (a.length !== w * h * 4) throw new Error("image data size does not match width/height");
  const maxDelta = maxDeltaOf(o.threshold), r = Math.max(0, Math.round(o.shiftPx));
  const mask = new Uint8Array(w * h);
  let differing = 0, aa = 0, absorbed = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const pos = (y * w + x) * 4;
      const delta = colorDelta(a, b, pos, pos);
      if (Math.abs(delta) <= maxDelta) continue;
      if ((antialiased(a, x, y, w, h, b) || antialiased(b, x, y, w, h, a))) { mask[y * w + x] = MASK.aa; aa++; continue; }
      differing++;
      // ours: absorbed when each image has the other's colour within r px (both directions)
      if (r > 0 && matchedNear(a, b, x, y, w, h, r, maxDelta) && matchedNear(b, a, x, y, w, h, r, maxDelta)) { mask[y * w + x] = MASK.absorbed; absorbed++; }
      else mask[y * w + x] = MASK.diff;
    }
  }
  // hot cells: ≥ max(hotMinPx, hotFraction · cell²) shift-tolerant differing pixels
  const cell = Math.max(1, Math.round(o.cellPx)), cw = Math.ceil(w / cell), chh = Math.ceil(h / cell);
  const count = new Uint32Array(cw * chh), e = Math.max(0, Math.round(o.edgePx));
  for (let y = e; y < h - e; y++) for (let x = e; x < w - e; x++) if (mask[y * w + x] === MASK.diff) { const i = Math.floor(y / cell) * cw + Math.floor(x / cell); count[i] = (count[i] ?? 0) + 1; }
  // the fraction is of a WHOLE cell, also at the image's right / bottom edge: a 1–2 px sliver there (the 4-decimal scale leaves a
  // part-covered last column) is never a region by itself
  const hotCell = new Uint8Array(cw * chh), hotAt = Math.max(o.hotMinPx, o.hotFraction * cell * cell);
  for (let i = 0; i < hotCell.length; i++) if ((count[i] ?? 0) >= hotAt) hotCell[i] = 1;
  // 8-connected clusters of hot cells → bounding boxes (device px)
  const seen = new Uint8Array(cw * chh), regions: Array<Rect4 & { pixels: number }> = [];
  for (let i = 0; i < hotCell.length; i++) {
    if (!hotCell[i] || seen[i]) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, pixels = 0;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const c = stack.pop() ?? 0, cx = c % cw, cy = Math.floor(c / cw);
      x0 = Math.min(x0, cx); y0 = Math.min(y0, cy); x1 = Math.max(x1, cx); y1 = Math.max(y1, cy);
      pixels += count[c] ?? 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= cw || ny >= chh) continue;
        const n = ny * cw + nx;
        if (hotCell[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
      }
    }
    const rx = x0 * cell, ry = y0 * cell;
    regions.push({ x: rx, y: ry, w: Math.min(w, (x1 + 1) * cell) - rx, h: Math.min(h, (y1 + 1) * cell) - ry, pixels });
  }
  regions.sort((p, q) => q.pixels - p.pixels || p.y - q.y || p.x - q.x);
  return { compared: w * h, differing, aa, shiftTolerant: differing - absorbed, mask, hot: regions.slice(0, Math.max(0, o.maxRegions)), hotTotal: regions.length };
}

// ---------------------------------------------------------------- geometry: the reference crop, the grid
/** planGrid's 1x fallback needs the two aspect ratios within this fraction of each other */
export const SHAPE_TOLERANCE = 0.01;
/** The frame box inside the reference PNG, device px, clamped to the PNG: the PNG's top-left sits at `offset` (design px,
 *  renderBox − box, ≤ 0 when a shadow grows the render bounds) and is `scale` PNG px per design px (bridge/src/write-out.ts). */
export function referenceCrop(png: { w: number; h: number }, scale: number, offset: { x: number; y: number }, frame: { w: number; h: number }): Rect4 {
  const x = Math.max(0, Math.min(png.w, Math.round(-offset.x * scale))), y = Math.max(0, Math.min(png.h, Math.round(-offset.y * scale)));
  return { x, y, w: Math.max(0, Math.min(png.w - x, Math.round(frame.w * scale))), h: Math.max(0, Math.min(png.h - y, Math.round(frame.h * scale))) };
}
/** Capture vs reference crop: within ±tolPx per axis both are cropped to the common size (the reference's grid); a larger
 *  mismatch is the 1x fallback (both resampled to the design size) — but only when the two have the same shape
 *  (aspect ratios within 1 %): a non-uniform resample would stretch one image and misplace every region, so a
 *  different shape is "none" (not compared, with why). */
export function planGrid(refCrop: { w: number; h: number }, capture: { w: number; h: number }, tolPx = 2):
  { grid: "reference"; w: number; h: number; note: string | null } | { grid: "1x"; why: string } | { grid: "none"; why: string } {
  const dw = capture.w - refCrop.w, dh = capture.h - refCrop.h;
  if (Math.abs(dw) <= tolPx && Math.abs(dh) <= tolPx) {
    const w = Math.min(capture.w, refCrop.w), h = Math.min(capture.h, refCrop.h);
    return { grid: "reference", w, h, note: dw || dh ? `the capture is ${capture.w}×${capture.h} device px and the reference's frame ${refCrop.w}×${refCrop.h} (rounding) — compared over the common ${w}×${h}` : null };
  }
  const shape = refCrop.w > 0 && refCrop.h > 0 && capture.w > 0 && capture.h > 0 ? (capture.w / capture.h) / (refCrop.w / refCrop.h) : 0;
  if (!(Math.abs(shape - 1) <= SHAPE_TOLERANCE)) {
    return { grid: "none", why: `the capture is ${capture.w}×${capture.h} device px and the reference's frame ${refCrop.w}×${refCrop.h} — different shapes (aspect ratios ${shape > 0 ? `${Math.round(Math.abs(shape - 1) * 1000) / 10} %` : "not comparable"} apart), so resampling would stretch one of them: not compared (a stale or clipped reference — re-pull the screen, then re-run --expect)` };
  }
  return { grid: "1x", why: `the capture is ${capture.w}×${capture.h} device px and the reference's frame ${refCrop.w}×${refCrop.h} — resampled to 1x (resampling can hide a difference)` };
}

// ---------------------------------------------------------------- attribution and the diff image
const overlap = (a: Rect4, b: Rect4): boolean => Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) && Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y);
/** Hot regions (device px, k device px per CSS px) as frame-relative CSS rects, each naming the built nodes (measured rects)
 *  and the designed nodes (design geometry) that overlap it — smallest area (innermost) first, ≤ 5 each. */
export function attribute(hot: PixelDiff["hot"], k: number, built: Array<{ id: string; rect: Rect4 }>, designed: Array<{ id: string; rect: Rect4 }>): VisualRegion[] {
  const names = (list: Array<{ id: string; rect: Rect4 }>, r: Rect4): string[] => {
    const ids: string[] = [];
    for (const n of list.filter((n) => n.rect.w > 0 && n.rect.h > 0 && overlap(n.rect, r)).sort((p, q) => p.rect.w * p.rect.h - q.rect.w * q.rect.h)) {
      if (!ids.includes(n.id)) ids.push(n.id);
      if (ids.length >= 5) break;
    }
    return ids;
  };
  return hot.map((h) => {
    const x = Math.floor(h.x / k), y = Math.floor(h.y / k);
    const rect = { x, y, w: Math.ceil((h.x + h.w) / k) - x, h: Math.ceil((h.y + h.h) / k) - y };
    return { rect, pixels: h.pixels, pct: Math.round((h.pixels / Math.max(1, h.w * h.h)) * 1000) / 10, built: names(built, rect), designed: names(designed, rect) };
  });
}

/** The diff image (pixelmatch style): the build at 10 % grey over white, differences red, anti-aliasing yellow, differences the
 *  shift tolerance absorbed light orange, each hot region outlined 2 px magenta. */
export function renderDiff(build: Rgba, d: PixelDiff): Rgba {
  const { w, h } = build, out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const p = i * 4, m = d.mask[i] ?? 0;
    let r: number, g: number, b: number;
    if (m === MASK.diff) { r = 255; g = 0; b = 0; }
    else if (m === MASK.aa) { r = 255; g = 255; b = 0; }
    else if (m === MASK.absorbed) { r = 255; g = 200; b = 140; }
    else { const v = blend(rgb2y(build.data[p] ?? 0, build.data[p + 1] ?? 0, build.data[p + 2] ?? 0), 0.1 * (build.data[p + 3] ?? 0) / 255); r = v; g = v; b = v; }
    out[p] = r; out[p + 1] = g; out[p + 2] = b; out[p + 3] = 255;
  }
  const put = (x: number, y: number): void => { if (x < 0 || y < 0 || x >= w || y >= h) return; const p = (y * w + x) * 4; out[p] = 255; out[p + 1] = 0; out[p + 2] = 255; out[p + 3] = 255; };
  for (const r of d.hot) {
    for (let t = 0; t < 2; t++) {
      for (let x = r.x; x < r.x + r.w; x++) { put(x, r.y + t); put(x, r.y + r.h - 1 - t); }
      for (let y = r.y; y < r.y + r.h; y++) { put(r.x + t, y); put(r.x + r.w - 1 - t, y); }
    }
  }
  return { w, h, data: out };
}
