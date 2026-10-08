// png.ts — a small PNG codec for the visual diff: Node builtins only (node:zlib), so the shipped bundles stay
// builtins-only and the pixels never go through a browser.
//
// Why not decode in Chromium: an <img> / createImageBitmap colour-manages gAMA / cHRM / iCCP by default,
// a 2D canvas quantises alpha, and returning the pixels through page.evaluate takes 45 s (a number[]) or 4–5× the time of
// this decoder (base64). Both sides of the diff are raw sRGB samples: Figma's references carry sRGB + gAMA 45455, and
// Playwright's screenshots are taken under --force-color-profile=srgb.
//
// What it reads: colour type 2 (RGB) and 6 (RGBA), bit depth 8, not interlaced — every Figma reference and every Playwright
// screenshot seen. Anything else throws PngError naming the colour type / depth / interlace. Every chunk's CRC
// is checked (W3C PNG 3 §5.3), the filters are §9 (None, Sub, Up, Average, Paeth). What it writes: RGB8, filter 0, deflate
// level 1 (a mostly uniform diff image compresses well at level 1, and fast), CRC via zlib.crc32 (Node ≥ 22.2).
import { crc32, deflateSync, inflateSync } from "node:zlib";

/** RGBA8 pixels, row-major, w·h·4 bytes. */
export interface Rgba { w: number; h: number; data: Uint8Array }
/** The PNG is malformed or of a kind this codec does not read. */
export class PngError extends Error {}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
interface Chunk { type: string; data: Buffer }

/** The chunks in file order, CRC-checked; stops at IEND. Throws PngError on a bad signature, a truncated chunk or a CRC. */
function chunks(b: Uint8Array): Chunk[] {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new PngError("not a PNG (bad signature)");
  const out: Chunk[] = [];
  let o = 8;
  while (o + 12 <= buf.length) {
    const len = buf.readUInt32BE(o);
    if (o + 12 + len > buf.length) throw new PngError("truncated PNG chunk");
    const type = buf.toString("latin1", o + 4, o + 8), data = buf.subarray(o + 8, o + 8 + len);
    if ((crc32(buf.subarray(o + 4, o + 8 + len)) >>> 0) !== buf.readUInt32BE(o + 8 + len)) throw new PngError(`bad CRC in the ${type} chunk`);
    out.push({ type, data });
    o += 12 + len;
    if (type === "IEND") break;
  }
  if (!out.length || out[0]?.type !== "IHDR") throw new PngError("not a PNG (no IHDR)");
  return out;
}

export interface PngInfo { w: number; h: number; colorType: number; bitDepth: number; interlace: number; srgb: boolean; gama: number | null; iccp: string | null }
/** IHDR + the colour chunks (sRGB, gAMA, the iCCP profile's name), or null when the bytes are not a readable PNG. */
export function pngInfo(b: Uint8Array): PngInfo | null {
  let cs: Chunk[];
  try { cs = chunks(b); } catch { return null; }
  const ihdr = cs[0];
  if (!ihdr || ihdr.data.length < 13) return null;
  const d = ihdr.data;
  const info: PngInfo = { w: d.readUInt32BE(0), h: d.readUInt32BE(4), bitDepth: d[8] ?? 0, colorType: d[9] ?? 0, interlace: d[12] ?? 0, srgb: false, gama: null, iccp: null };
  for (const c of cs) {
    if (c.type === "sRGB") info.srgb = true;
    else if (c.type === "gAMA" && c.data.length >= 4) info.gama = c.data.readUInt32BE(0);
    else if (c.type === "iCCP") { const z = c.data.indexOf(0); info.iccp = c.data.toString("latin1", 0, z < 0 ? Math.min(79, c.data.length) : z); }
  }
  return info;
}

/** The largest image decodePng reads: 4096 × 4096 px (64 MB of RGBA). */
export const MAX_DECODE_SIDE = 4096;
const MAX_DECODE_PIXELS = MAX_DECODE_SIDE * MAX_DECODE_SIDE;
/** Decode to RGBA8 (an RGB image gets alpha 255). Throws PngError for anything but colour type 2/6, depth 8, non-interlaced. */
export function decodePng(b: Uint8Array): Rgba {
  const cs = chunks(b);
  const d = cs[0]?.data;
  if (!d || d.length < 13) throw new PngError("bad IHDR");
  const w = d.readUInt32BE(0), h = d.readUInt32BE(4), depth = d[8] ?? 0, ct = d[9] ?? 0, interlace = d[12] ?? 0;
  if (depth !== 8 || (ct !== 2 && ct !== 6) || interlace !== 0) throw new PngError(`unsupported PNG (colour type ${ct} / depth ${depth}${interlace ? " / interlaced" : ""}) — only 8-bit RGB / RGBA, not interlaced`);
  if (!w || !h) throw new PngError("empty PNG");
  // refused BEFORE inflating — a few-MB zlib stream can claim gigabytes (Figma's references are ≤ ~2100 px on the long side)
  if (w * h > MAX_DECODE_PIXELS) throw new PngError(`the PNG is ${w}×${h} px — over the ${MAX_DECODE_SIDE}×${MAX_DECODE_SIDE} pixels this decoder reads`);
  const ch = ct === 6 ? 4 : 3, stride = w * ch;
  let raw: Buffer;
  // the inflated size is capped at exactly what the IHDR implies (one filter byte per row)
  try { raw = inflateSync(Buffer.concat(cs.filter((c) => c.type === "IDAT").map((c) => c.data)), { maxOutputLength: (stride + 1) * h }); } catch (e) { throw new PngError(`bad image data (${e instanceof Error ? e.message : String(e)})`); }
  if (raw.length < (stride + 1) * h) throw new PngError("truncated image data");
  const px = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)] ?? 0, s = y * (stride + 1) + 1, dst = y * stride, prev = dst - stride;
    if (f > 4) throw new PngError(`bad filter type ${f} on row ${y}`);
    for (let i = 0; i < stride; i++) {
      const x = raw[s + i] ?? 0, a = i >= ch ? px[dst + i - ch] ?? 0 : 0, up = y ? px[prev + i] ?? 0 : 0, c = y && i >= ch ? px[prev + i - ch] ?? 0 : 0;
      let v: number;
      if (f === 0) v = x;
      else if (f === 1) v = x + a;
      else if (f === 2) v = x + up;
      else if (f === 3) v = x + ((a + up) >> 1);
      else { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c); }
      px[dst + i] = v & 255;
    }
  }
  if (ch === 4) return { w, h, data: px };
  const data = new Uint8Array(w * h * 4);
  for (let i = 0, j = 0; i < px.length; i += 3, j += 4) { data[j] = px[i] ?? 0; data[j + 1] = px[i + 1] ?? 0; data[j + 2] = px[i + 2] ?? 0; data[j + 3] = 255; }
  return { w, h, data };
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}
/** Encode as RGB8 (alpha dropped — the diff image is opaque), filter 0, deflate level 1. */
export function encodePng(img: Rgba): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.w, 0); ihdr.writeUInt32BE(img.h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = img.w * 3 + 1, raw = Buffer.alloc(stride * img.h);
  for (let y = 0; y < img.h; y++) {
    let o = y * stride + 1, i = y * img.w * 4;
    for (let x = 0; x < img.w; x++, i += 4) { raw[o++] = img.data[i] ?? 0; raw[o++] = img.data[i + 1] ?? 0; raw[o++] = img.data[i + 2] ?? 0; }
  }
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 1 })), chunk("IEND", Buffer.alloc(0))]);
}

/** The pixels of `r` (clamped to the image; integer px). */
export function crop(img: Rgba, r: { x: number; y: number; w: number; h: number }): Rgba {
  const x0 = Math.max(0, Math.min(img.w, Math.round(r.x))), y0 = Math.max(0, Math.min(img.h, Math.round(r.y)));
  const w = Math.max(0, Math.min(img.w - x0, Math.round(r.w))), h = Math.max(0, Math.min(img.h - y0, Math.round(r.h)));
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) data.set(img.data.subarray(((y0 + y) * img.w + x0) * 4, ((y0 + y) * img.w + x0 + w) * 4), y * w * 4);
  return { w, h, data };
}

/** Area-average (box) resample to w×h: every output pixel is the coverage-weighted mean of the source pixels under it,
 *  colour weighted by alpha (a transparent pixel adds no colour). Exact for integer factors on uniform blocks. */
export function resampleBox(img: Rgba, w: number, h: number): Rgba {
  if (w <= 0 || h <= 0) return { w: Math.max(0, w), h: Math.max(0, h), data: new Uint8Array(0) };
  if (w === img.w && h === img.h) return { w, h, data: img.data.slice() };
  /** per output index, the source spans and their weights along one axis */
  const spans = (n: number, m: number): Array<Array<[number, number]>> => {
    const sc = n / m, out: Array<Array<[number, number]>> = [];
    for (let o = 0; o < m; o++) {
      const a = o * sc, b = (o + 1) * sc, list: Array<[number, number]> = [];
      for (let s = Math.floor(a); s < Math.min(n, Math.ceil(b)); s++) { const wgt = Math.min(b, s + 1) - Math.max(a, s); if (wgt > 1e-9) list.push([s, wgt]); }
      out.push(list);
    }
    return out;
  };
  const xs = spans(img.w, w), ys = spans(img.h, h);
  // horizontal pass into premultiplied floats (r·a, g·a, b·a, a), then vertical
  const tmp = new Float64Array(w * img.h * 4);
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, bl = 0, a = 0, tw = 0;
      for (const [s, wgt] of xs[x] ?? []) {
        const i = (y * img.w + s) * 4, al = img.data[i + 3] ?? 0;
        r += (img.data[i] ?? 0) * al * wgt; g += (img.data[i + 1] ?? 0) * al * wgt; bl += (img.data[i + 2] ?? 0) * al * wgt; a += al * wgt; tw += wgt;
      }
      const o = (y * w + x) * 4;
      tmp[o] = r / tw; tmp[o + 1] = g / tw; tmp[o + 2] = bl / tw; tmp[o + 3] = a / tw;
    }
  }
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, bl = 0, a = 0, tw = 0;
      for (const [s, wgt] of ys[y] ?? []) {
        const i = (s * w + x) * 4;
        r += (tmp[i] ?? 0) * wgt; g += (tmp[i + 1] ?? 0) * wgt; bl += (tmp[i + 2] ?? 0) * wgt; a += (tmp[i + 3] ?? 0) * wgt; tw += wgt;
      }
      const o = (y * w + x) * 4;
      a /= tw;
      data[o + 3] = Math.round(a);
      if (a > 0) { data[o] = Math.round(r / tw / a); data[o + 1] = Math.round(g / tw / a); data[o + 2] = Math.round(bl / tw / a); }
    }
  }
  return { w, h, data };
}
