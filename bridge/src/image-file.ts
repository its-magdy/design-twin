// image-file.ts — figma_write's images from disk (docs/write-plane-spec.md decision 12; image-spec.ts for the paint).
//
// A paint `{type:"image", file}` names a PNG, JPEG or GIF in the project. The MCP server reads every such file BEFORE
// anything else looks at the batch (after a `treeFile` is read in and seedTokens became its tables), the same way it
// reads those: inside the directory it was started in (by name, then by real path, opened without following a final
// link; project-file.ts), a regular file, at most MAX_IMAGE_BYTES. The bytes are sniffed, not trusted to the name: PNG,
// JPEG or GIF only, at most MAX_IMAGE_SIDE pixels on either side (Figma's createImage limit). The batch's images
// together are at most MAX_BATCH_IMAGE_BYTES. Any problem refuses the call before the plugin is asked.
//
// Each paint is rewritten to `{type:"image", file, image: <sha-256 of the bytes>, …}` and the bytes go once per image
// beside the ops, as base64 (`images`: id → base64). The base64 exists only on the wire to the plugin: never in a reply,
// the dry run, a log or the spec a keyed re-send stores (that keeps `file` and `image`, so a file changed on disk is a
// changed spec and an unchanged one is no change). The same file named by many paints is read once.
import fs from "node:fs";
import path from "node:path";
import { sha256Hex } from "./hash.ts";
import { pngSize } from "./png.ts";
import { IMAGE_HASH, imagePaintsIn, inlineImageProblem, mapImagePaints, type ImageTable } from "./image-spec.ts";
import { nodeProjectIo, readProjectFile, type ProjectIo } from "./project-file.ts";
import type { WritePreviewStep } from "./commands.ts";

const MiB = 1024 * 1024;
/** The biggest image file read. */
export const MAX_IMAGE_BYTES = 8 * MiB;
/** The most image bytes one batch sends (its distinct images together). As base64 that is ~43 MB, a third of the
 *  bridge's default frame cap (settings.ts, 128 MB). */
export const MAX_BATCH_IMAGE_BYTES = 32 * MiB;
/** Figma's createImage refuses an image wider or taller than this many pixels. */
export const MAX_IMAGE_SIDE = 4096;

/** The formats Figma's createImage takes. */
export type ImageFormat = "PNG" | "JPEG" | "GIF";
const TAKES = "Figma takes PNG, JPEG or GIF";

/** The format and pixel size of an image, from its bytes alone, or what it is when it is not one Figma takes. */
export function sniffImage(b: Uint8Array): { format: ImageFormat; w: number; h: number } | { error: string } {
  const ascii = (from: number, to: number): string => String.fromCharCode(...b.subarray(from, Math.min(to, b.length)));
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 4) === "PNG") {
    const s = pngSize(b);
    return s ? { format: "PNG", ...s } : { error: "is a damaged PNG (no IHDR header)" };
  }
  if (b.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) {
    if (b.length < 10) return { error: "is a damaged GIF (its header is cut short)" };
    return { format: "GIF", w: (b[6] ?? 0) | ((b[7] ?? 0) << 8), h: (b[8] ?? 0) | ((b[9] ?? 0) << 8) };
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    const s = jpegSize(b);
    return s ? { format: "JPEG", ...s } : { error: "is a damaged JPEG (no frame header before the image data)" };
  }
  const kind = otherKind(b);
  return { error: (kind ? "is " + kind : "is not an image Figma can take") + "; " + TAKES };
}

/** A JPEG's size from its first start-of-frame segment (SOF0–SOF15 bar DHT, JPG and DAC), or null. */
function jpegSize(b: Uint8Array): { w: number; h: number } | null {
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1] ?? 0;
    if (m === 0xff) { i++; continue; } // fill bytes
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; } // markers with no length
    if (m === 0xd9 || m === 0xda) return null; // the end, or the image data, before a frame header
    const len = ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (i + 8 >= b.length) return null;
      return { w: ((b[i + 7] ?? 0) << 8) | (b[i + 8] ?? 0), h: ((b[i + 5] ?? 0) << 8) | (b[i + 6] ?? 0) };
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

/** What a file Figma does not take is, by its first bytes, or null when it is none of the kinds known here. */
function otherKind(b: Uint8Array): string | null {
  const ascii = (from: number, to: number): string => String.fromCharCode(...b.subarray(from, Math.min(to, b.length)));
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "a WebP image";
  if (ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    return brand === "avif" || brand === "avis" ? "an AVIF image" : /^(heic|heix|hevc|mif1|msf1)$/.test(brand) ? "a HEIC image" : "an MP4/QuickTime-family file";
  }
  if (ascii(0, 2) === "BM") return "a BMP image";
  if (ascii(0, 4) === "II*\u0000" || ascii(0, 4) === "MM\u0000*") return "a TIFF image";
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return "an ICO icon";
  if (ascii(0, 5) === "%PDF-") return "a PDF";
  const head = ascii(0, 1024).replace(/^﻿/, "").replace(/^ï»¿/, "").trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return "an SVG (vector) file (an icon is a component instance; a picture is a PNG, JPEG or GIF)";
  return null;
}

/** One image file of the batch, for the dry run: the path as given, its id, what it is, and the ops whose paints use it. */
export interface ImageRecord { file: string; id: string; format: ImageFormat; w: number; h: number; bytes: number; ops: number[] }
/** A `hash` paint of the batch: checked against the file only when the write runs. */
export interface HashRecord { hash: string; ops: number[] }

const IMAGE_WORDS = { noun: "an image file", inside: "an image file", retry: "write again" };
const kb = (n: number): string => (n < 1024 ? n + " bytes" : n < MiB ? Math.round(n / 1024) + " kB" : Math.round((n / MiB) * 10) / 10 + " MB");

/**
 * Every image paint with a `file` given the id of the file's bytes (`image`), the bytes once per id (`images`, base64),
 * and what each is — or the first problem: an `image` the spec set itself, image bytes or a link in a paint, both `file`
 * and `hash`, a file that is refused, not read or not an image Figma takes, a batch over MAX_BATCH_IMAGE_BYTES. `resolve`
 * turns a path into the file to read and throws, with the reason, when it refuses it; `root` is the directory every file
 * must be in once its links are followed; `label` gives an op's index as the agent sent it (seedTokens expanded ops).
 */
export function loadImageFiles<T extends { op: string }>(
  ops: readonly T[], resolve: (p: string, what: string) => string,
  opts: { root?: string; label?: (i: number) => number; io?: ProjectIo } = {},
): { ops: T[]; images: ImageTable; records: ImageRecord[]; hashes: HashRecord[] } | { error: string } {
  const root = opts.root ?? process.cwd();
  const label = opts.label ?? ((i: number) => i);
  let realRoot: string;
  try { realRoot = fs.realpathSync(root); } catch { realRoot = path.resolve(root); }
  /** Each file read, by the path `resolve` gave: its id, or the problem. */
  const read = new Map<string, { id: string } | { error: string }>();
  const images: ImageTable = {};
  const records = new Map<string, ImageRecord>();
  const hashes = new Map<string, HashRecord>();
  let total = 0;
  const out: T[] = [];
  for (const [i, op] of ops.entries()) {
    const at = `ops[${label(i)}]`;
    // First every paint's shape that would make reading its file wrong, then the files, in document order.
    for (const { paint, path: p } of imagePaintsIn(op, at)) {
      if (paint.image !== undefined) return { error: `${p}.image: is set by the server (the id of the bytes it reads from \`file\`); leave it out` };
      const inline = inlineImageProblem(paint);
      if (inline !== null) return { error: p + inline };
      if (paint.file !== undefined && paint.hash !== undefined) return { error: `${p}: gives both \`file\` and \`hash\`; an image is one of them` };
      if (paint.hash !== undefined) {
        // Not echoed: a malformed hash may be an image's bytes.
        if (typeof paint.hash !== "string" || !IMAGE_HASH.test(paint.hash)) return { error: `${p}.hash: is not an image hash (40 lowercase hex characters: the \`hash\` an image fill has in the read)` };
        const h = hashes.get(paint.hash) ?? { hash: paint.hash, ops: [] };
        if (!h.ops.includes(i)) h.ops.push(i);
        hashes.set(paint.hash, h);
      }
    }
    const state: { failed: string | null } = { failed: null };
    const next = mapImagePaints(op, at, (paint, p) => {
      if (state.failed !== null || typeof paint.file !== "string" || !paint.file.trim()) return null;
      const given = paint.file;
      let file: string;
      try { file = resolve(given, `${p}.file`); } catch (e) { state.failed = e instanceof Error ? e.message : String(e); return null; }
      let got = read.get(file);
      if (!got) {
        got = readImage(file, given, `${p}.file`, realRoot, opts.io ?? nodeProjectIo, (id, bytes, info) => {
          const r = records.get(id);
          if (r) return null; // the same bytes under another path: sent once
          // Checked before this file is kept, so a batch of many images stops at the first one past the cap.
          if (total + bytes.length > MAX_BATCH_IMAGE_BYTES) {
            return `the batch's images are more than ${kb(MAX_BATCH_IMAGE_BYTES)} together (${[...records.values()].map((x) => x.file + " " + kb(x.bytes)).concat(given + " " + kb(bytes.length)).join(", ")}); one figma_write sends at most ${kb(MAX_BATCH_IMAGE_BYTES)} of images: send the rest in another call`;
          }
          total += bytes.length;
          images[id] = bytes.toString("base64");
          records.set(id, { file: given, id, ...info, bytes: bytes.length, ops: [] });
          return null;
        });
        read.set(file, got);
      }
      if ("error" in got) { state.failed = got.error; return null; }
      const rec = records.get(got.id);
      if (rec && !rec.ops.includes(i)) rec.ops.push(i);
      return { ...paint, image: got.id };
    });
    if (state.failed !== null) return { error: state.failed };
    out.push(next as T);
  }
  return { ops: out, images, records: [...records.values()], hashes: [...hashes.values()] };
}

/** One image file read and sniffed: its id (the sha-256 of its bytes), after `keep` has taken the bytes; or the problem. */
function readImage(file: string, given: string, at: string, realRoot: string, io: ProjectIo,
  keep: (id: string, bytes: Buffer, info: { format: ImageFormat; w: number; h: number }) => string | null): { id: string } | { error: string } {
  const r = readProjectFile(file, at, realRoot, MAX_IMAGE_BYTES, IMAGE_WORDS, io);
  if ("error" in r) return r;
  const s = sniffImage(r.bytes);
  if ("error" in s) return { error: `${at}: ${given} ${s.error}` };
  if (s.w < 1 || s.h < 1) return { error: `${at}: ${given} is a ${s.format} of ${s.w}×${s.h} px, which has nothing to show` };
  if (s.w > MAX_IMAGE_SIDE || s.h > MAX_IMAGE_SIDE) return { error: `${at}: ${given} is a ${s.format} of ${s.w}×${s.h} px; Figma takes an image at most ${MAX_IMAGE_SIDE} px on each side (scale it down first)` };
  const id = sha256Hex(r.bytes);
  const refused = keep(id, r.bytes, s);
  return refused !== null ? { error: refused } : { id };
}

/** A dry run's steps with the images each op's paints use (`images`, one line each), and a sentence on them in `note`. */
export function imagePreview<P extends { steps: WritePreviewStep[]; note?: string }>(p: P, records: readonly ImageRecord[], hashes: readonly HashRecord[]): P {
  if (!records.length && !hashes.length) return p;
  const lines = new Map<number, string[]>();
  const add = (i: number, line: string): void => { const l = lines.get(i) ?? []; l.push(line); lines.set(i, l); };
  for (const r of records) for (const i of r.ops) add(i, `${r.file}: ${r.format} ${r.w}×${r.h}, ${kb(r.bytes)}`);
  for (const h of hashes) for (const i of h.ops) add(i, `hash ${h.hash}: an image the file must already have (checked when the write runs)`);
  const steps = p.steps.map((s, i) => { const l = lines.get(i); return l ? { ...s, images: l } : s; });
  const sentence = (records.length ? `The image files were read and checked (${records.length}, ${kb(records.reduce((n, r) => n + r.bytes, 0))}); ` : "") +
    (hashes.length ? "an image named by `hash` is looked up in the file only when the write runs; " : "") +
    "the reply of the write lists each image made from a file with its Figma `hash` (`images`), to reuse in a later spec. ";
  return { ...p, steps, note: sentence + (p.note ?? "") };
}
