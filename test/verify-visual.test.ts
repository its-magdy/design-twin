// the visual diff's expectation and compare halves: expectation.referenceImage at --expect (index
// first, the export's own geometry as the fallback, thumbnails and unreadable files refused, colour profile, crop,
// sha256), and report.visual at --compare (always written, a third headline, an md section, the lenient guard, and that
// the diff never reaches the verdict). Screens are plugin-shaped exports (test/fixtures.ts) with the real index-row and
// reference-PNG shapes (IHDR, pHYs, sRGB, gAMA, tEXt, IDAT, IEND); every name is invented ("Kiln Log").
// Run with:  node test/verify-visual.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { compare, reportToMarkdown, probeLine } from "../design-to-code/verify-screen.ts";
import { buildExpectation } from "../design-to-code/verify-expect.ts";
import { STYLE_KEYS, resolveInside } from "../design-to-code/verify-shared.ts";
import * as verifyScreen from "../design-to-code/verify-screen.ts";
import type { ExpectInput, ExpectOptions } from "../design-to-code/verify-expect.ts";
import * as guards from "../design-to-code/doc-guards.ts";
import { isVerifyExpectation, isVerifyMeasured, isVerifyReport, readableMeasured } from "../design-to-code/doc-guards.ts";
import { readJsonOrNull } from "../design-to-code/read-json.ts";
import type { IndexRow, MeasuredNode, VerifyReport, MeasuredStyles, MeasuredVisual, ProbeIdentity, ReportVisual, ScreenDoc, VerifyExpectation, VerifyMeasured, VerifyReportV2, VerifySpec, VisualRegion } from "../design-to-code/types.ts";
import { malformed, screenExport, screenReply } from "./fixtures.ts";
import type { NodeInput } from "./fixtures.ts";
import { check, report } from "./assert.ts";

const safe = (name: string, fn: () => boolean): boolean => { let r = false; try { r = fn(); } catch (e) { console.log(`    (threw: ${e instanceof Error ? e.message : String(e)})`); } return check(name, r); };
// (namespace lookups: this file runs — and fails cleanly — against a verify-screen that predates the reference-image checks)
const ns: Record<string, unknown> = { ...verifyScreen, ...guards };
const has = (name: string): boolean => typeof ns[name] === "function";

// ---------------------------------------------------------------- PNGs in the export reference's real shape
const crcOf = (b: Buffer): number => zlib.crc32(b);
const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crcOf(td) >>> 0);
  return Buffer.concat([len, td, crc]);
};
interface PngOpts { colorType?: number; bitDepth?: number; interlace?: number; iccp?: string; srgb?: boolean; tag?: number }
/** A real PNG: IHDR, pHYs, sRGB + gAMA (Figma's exportAsync), or iCCP, tEXt, IDAT (blank rows), IEND. */
function png(w: number, h: number, o: PngOpts = {}): Buffer {
  const ct = o.colorType ?? 6, bd = o.bitDepth ?? 8;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = bd; ihdr[9] = ct; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = o.interlace ?? 0;
  const channels = ct === 6 ? 4 : ct === 2 ? 3 : ct === 4 ? 2 : 1;
  const row = 1 + Math.ceil((w * channels * bd) / 8);
  const raw = Buffer.alloc(row * h, 0);
  if (o.tag !== undefined) raw[1] = o.tag;
  const phys = Buffer.alloc(9); phys.writeUInt32BE(5669, 0); phys.writeUInt32BE(5669, 4); phys[8] = 1;
  const gama = Buffer.alloc(4); gama.writeUInt32BE(45455);
  const colour = o.iccp !== undefined ? [chunk("iCCP", Buffer.concat([Buffer.from(o.iccp, "latin1"), Buffer.from([0, 0]), zlib.deflateSync(Buffer.alloc(64))]))]
    : o.srgb === false ? [] : [chunk("sRGB", Buffer.from([0])), chunk("gAMA", gama)];
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("pHYs", phys), ...colour,
    chunk("tEXt", Buffer.from("Software\u0000Figma", "latin1")), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const roundTrip = (x: unknown): unknown => { const back: unknown = JSON.parse(JSON.stringify(x)); return back; };
/** A report as the next round reads it back from disk (VerifyReport, the @2 shape) — compare()'s result via JSON. */
const readBack = (r: VerifyReportV2): VerifyReport => { const back = roundTrip(r); if (!isVerifyReport(back)) throw new Error("not a report"); return back; };
const sha = (b: Uint8Array): string => crypto.createHash("sha256").update(b).digest("hex");

// ---------------------------------------------------------------- the "Kiln Log" screen (invented)
// Screen 90:1 "Firings", 1440×720, its render bounds grown 12 px each side (a drop shadow) — the reference is rendered by
// Figma at s0 = min(2, 2048 / 1440) over those bounds: 1464×744 design px → 2082×1058 PNG px.
const KILN = "Kiln Log";
const S0 = Math.min(2, 2048 / 1440);
const REF_W = Math.round(1464 * S0), REF_H = Math.round(744 * S0);
const REF = "assets/90_1_ref-7c1e0a.png";
const card = (id: string, name: string, x: number): NodeInput => ({ type: "FRAME", id, name, box: { x: 40 + x, y: 160, w: 320, h: 200 }, fills: [{ type: "solid", color: "#f6efe6" }], radius: 12,
  children: [{ type: "TEXT", id: `${id}1`, name: "Cone", text: `Cone ${x / 340 + 4}`, font: { family: "Inter", size: 16, color: "#3b2a1a" } }] });
const FIRINGS: NodeInput = {
  type: "FRAME", id: "90:1", name: "Firings", box: { x: 200, y: 400, w: 1440, h: 720 }, renderBox: { x: 188, y: 388, w: 1464, h: 744 }, clip: true,
  fills: [{ type: "solid", color: "#ffffff" }], reference: REF,
  children: [
    { type: "TEXT", id: "90:2", name: "Title", text: "Firings", font: { family: "Inter", size: 28, color: "#1b120a" } },
    card("90:10", "Bisque", 0), card("90:11", "Glaze", 340), card("90:12", "Raku", 680), card("90:13", "Salt", 1020),
  ],
};
const doc = (root: NodeInput): ScreenDoc => screenExport([root], { exportedAt: "2026-10-06T00:00:00Z", screen: String(root.name), nodeId: root.id, page: "Studio", pageId: "1:2", sourceFile: KILN });
const screen: ExpectInput = { doc: doc(FIRINGS), label: "Firings__90_1" };
// the index row exactly as write-out.ts writeScreen writes it (referenceScale 4 decimals, referenceOffset design px)
const indexRow = (more: Partial<IndexRow> = {}): IndexRow => ({
  name: "Firings", id: "90:1", type: "FRAME", page: "Studio", pageId: "1:2", title: "Firings", texts: ["Firings", "Cone 4"], exportedAt: "2026-10-06T00:00:00Z", sourceFile: KILN,
  file: "pages/Studio/Firings__90_1.json", variables: "pages/Studio/Firings__90_1.vars.json", assets: "pages/Studio/Firings__90_1.assets.json",
  reference: REF, referenceScale: 1.4222, referenceOffset: { x: -12, y: -12 }, nodes: 11, w: 1440, h: 720, ...more,
});
const noScaleRow = (): IndexRow => { const { referenceScale: _s, referenceOffset: _o, ...rest } = indexRow(); return rest; };
/** FIRINGS without some of its keys (an export that never had them — absent, not undefined). */
const without = (n: NodeInput, ...keys: Array<"renderBox" | "reference" | "box">): NodeInput => {
  const out: NodeInput = { ...n };
  for (const k of keys) delete out[k];
  return out;
};
const REF_PNG = png(REF_W, REF_H);
const reader = (files: Record<string, Buffer>) => (p: string): Uint8Array | null => files[p] ?? null;
const expect = (opts: ExpectOptions, root: NodeInput = FIRINGS): VerifyExpectation => buildExpectation([{ doc: doc(root), label: "Firings__90_1" }], opts);
const refOf = (e: VerifyExpectation): VerifyExpectation["referenceImage"] => e.referenceImage;

// ---------------------------------------------------------------- 9: --expect from the index
console.log("[9] --expect: referenceImage from the index row (the scale belongs to this PNG):");
{
  const e = expect({ index: { layers: [indexRow()] }, readReference: reader({ [REF]: REF_PNG }) });
  const r = refOf(e);
  safe("[9] referenceImage {usable, from:index, scale 1.4222, offset {-12,-12}, path design/export/<pointer>, png dims, sha256 of the PNG bytes}", () =>
    !!r && r.usable === true && r.from === "index" && r.scale === 1.4222 && r.offset.x === -12 && r.offset.y === -12 && r.path === "design/export/" + REF
    && r.png.w === REF_W && r.png.h === REF_H && r.sha256 === sha(REF_PNG) && r.colorProfile === undefined);
  // crop: x = round(12·1.4222) = 17, y = 17, w = round(1440·1.4222) = 2048, h = round(720·1.4222) = 1024
  safe("[9] crop = the frame box inside the PNG in device px: {17, 17, 2048, 1024}", () =>
    !!r && r.usable === true && r.crop.x === 17 && r.crop.y === 17 && r.crop.w === 2048 && r.crop.h === 1024);
  const other = refOf(expect({ index: { layers: [indexRow({ reference: "assets/90_1_ref.png", referenceScale: 1.9, referenceOffset: { x: 0, y: 0 } })] }, readReference: reader({ [REF]: REF_PNG }) }));
  safe("[9] a row naming ANOTHER png (an earlier pull's) is not this reference's geometry → the export fallback, never its scale", () =>
    !!other && other.usable === true && other.from === "export" && other.scale === 1.4221);
  const otherFile = refOf(expect({ index: { layers: [indexRow({ sourceFile: "Another File", referenceScale: 1.9 })] }, readReference: reader({ [REF]: REF_PNG }) }));
  safe("[9] a row of another Figma file (sourceFile stamped on both, different) is not used", () => !!otherFile && otherFile.usable === true && otherFile.from === "export");
  safe("[9] the guard accepts it (isVerifyReferenceImage) and the expectation still reads back", () =>
    has("isVerifyReferenceImage") && guards.isVerifyReferenceImage(r) && isVerifyExpectation(roundTrip(e)));
  const noReader = buildExpectation([screen], { index: { layers: [indexRow()] } });
  safe("[9] an in-memory caller with no readReference writes no referenceImage (the export is not on disk)", () => noReader.referenceImage === undefined);
}

// ---------------------------------------------------------------- 10: --expect from an old export (no scale in the index)
console.log("[10] --expect: an export with no referenceScale — recomputed exactly as the bridge writes it:");
{
  const e = expect({ index: { layers: [noScaleRow()] }, readReference: reader({ [REF]: REF_PNG }) });
  const r = refOf(e);
  safe("[10] from:export, scale round4(png.w / renderBox.w) = 1.4221, offset renderBox − box = {-12,-12}", () =>
    !!r && r.usable === true && r.from === "export" && r.scale === Math.round((REF_W / 1464) * 10000) / 10000 && r.scale === 1.4221 && r.offset.x === -12 && r.offset.y === -12);
  safe("[10] crop from the recomputed geometry {17, 17, 2048, 1024}", () => !!r && r.usable === true && r.crop.x === 17 && r.crop.y === 17 && r.crop.w === 2048 && r.crop.h === 1024);
  const noIndex = refOf(expect({ readReference: reader({ [REF]: REF_PNG }) }));
  safe("[10] no index at all → the same from:export geometry", () => !!noIndex && JSON.stringify(noIndex) === JSON.stringify(r));
  // a 480-wide popup with a 21 px shadow: 1044 px wide is scale 2 over its 522-wide render bounds, NOT 1044/480 = 2.175
  const POPUP: NodeInput = { type: "FRAME", id: "90:60", name: "Firing Form", box: { x: 900, y: 300, w: 480, h: 588 }, renderBox: { x: 879, y: 299, w: 522, h: 630 }, reference: "assets/90_60_ref.png",
    fills: [{ type: "solid", color: "#ffffff" }], children: [{ type: "TEXT", id: "90:61", name: "Heading", text: "New firing", font: { family: "Inter", size: 20, color: "#1b120a" } }] };
  const pop = refOf(expect({ readReference: reader({ "assets/90_60_ref.png": png(1044, 1260) }) }, POPUP));
  safe("[10] a shadowed popup (box 480, renderBox 522, png 1044) → scale 2, offset {-21,-1}, crop {42, 2, 960, 1176}", () =>
    !!pop && pop.usable === true && pop.from === "export" && pop.scale === 2 && pop.offset.x === -21 && pop.offset.y === -1
    && pop.crop.x === 42 && pop.crop.y === 2 && pop.crop.w === 960 && pop.crop.h === 1176);
  const flat: NodeInput = without(FIRINGS, "renderBox");
  const flatRef = refOf(expect({ readReference: reader({ [REF]: png(2048, 1024) }) }, flat));
  safe("[10] no renderBox → scale png.w / box.w, offset {0,0}, crop the whole PNG", () =>
    !!flatRef && flatRef.usable === true && flatRef.scale === 1.4222 && flatRef.offset.x === 0 && flatRef.offset.y === 0 && flatRef.crop.x === 0 && flatRef.crop.w === 2048 && flatRef.crop.h === 1024);
}
// the formula equals write-out's: a harness pull of the same screen writes the index row, and the fallback agrees with it
{
  const dt = await import("../bridge/src/write-out.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-visual-pull-"));
  const shot = png(REF_W, REF_H, { tag: 7 });
  dt.writeScreen(dir, screenReply({
    screenName: "Firings", nodeId: "90:1", page: "Studio", pageId: "1:2", sourceFile: KILN,
    screen: { screen: "Firings", exportedAt: "2026-10-06T00:00:00.000Z", manifest: { nodes: 11 }, nodes: [{ ...FIRINGS, reference: "assets/90_1_ref.png" }] },
    assets: [{ id: "90:1:ref", name: "Firings (reference)", format: "png", file: "90_1_ref.png", base64: shot.toString("base64"), kind: "reference" }],
  }), () => undefined);
  const idx: unknown = JSON.parse(fs.readFileSync(path.join(dir, "pages", "index.json"), "utf8"));
  const rows: unknown = idx && typeof idx === "object" && "layers" in idx ? idx.layers : null;
  const row = Array.isArray(rows) ? rows.find((l: unknown): l is IndexRow => !!l && typeof l === "object" && "id" in l && l.id === "90:1") : undefined;
  const pointer = row && row.reference ? row.reference : "";
  const fallback = refOf(expect({ readReference: (p) => (p === pointer ? fs.readFileSync(path.join(dir, ...p.split("/"))) : null) }, { ...FIRINGS, reference: pointer }));
  const fromIndex = refOf(expect({ index: { layers: row ? [row] : [] }, readReference: (p) => (p === pointer ? fs.readFileSync(path.join(dir, ...p.split("/"))) : null) }, { ...FIRINGS, reference: pointer }));
  safe("[10] a harness pull (bridge write-out) writes referenceScale/referenceOffset; the export fallback computes the same numbers", () =>
    !!row && typeof row.referenceScale === "number" && !!fallback && fallback.usable === true && fallback.from === "export"
    && fallback.scale === row.referenceScale && fallback.offset.x === row.referenceOffset?.x && fallback.offset.y === row.referenceOffset?.y);
  safe("[10] …and --expect over that pull's index takes the row (from:index) with the same geometry", () =>
    !!fromIndex && !!fallback && fromIndex.usable === true && fallback.usable === true && fromIndex.from === "index" && fromIndex.scale === fallback.scale && JSON.stringify(fromIndex.crop) === JSON.stringify(fallback.crop));
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 11: thumbnails and unreadable references
console.log("[11] --expect: a thumbnail or an unreadable file is refused with why:");
{
  const thumb = refOf(expect({ index: { layers: [noScaleRow()] }, readReference: reader({ [REF]: png(360, 309) }) }, without(FIRINGS, "renderBox")));
  safe("[11] a 360×309 discovery thumbnail of a 1440 frame → usable:false, the thumbnail why (never diffed at 0.25)", () =>
    !!thumb && thumb.usable === false && thumb.path === "design/export/" + REF
    && thumb.why === "the reference is a 360 px image, not the export reference (a discovery thumbnail) — re-pull the screen");
  const thumbRow = refOf(expect({ index: { layers: [indexRow({ referenceScale: 0.25, referenceOffset: { x: 0, y: 0 } })] }, readReference: reader({ [REF]: png(360, 309) }) }, without(FIRINGS, "renderBox")));
  safe("[11] …also when an index row states the thumbnail's scale", () => !!thumbRow && thumbRow.usable === false && /discovery thumbnail\)/.test(thumbRow.why));
  const missing = refOf(expect({ index: { layers: [indexRow()] }, readReference: reader({}) }));
  safe("[11] the file missing on disk → usable:false, 'missing on disk — re-pull the screen'", () =>
    !!missing && missing.usable === false && missing.path === "design/export/" + REF && /missing on disk — re-pull the screen/.test(missing.why));
  const notPng = refOf(expect({ index: { layers: [indexRow()] }, readReference: reader({ [REF]: Buffer.from("<svg/>") }) }));
  safe("[11] not a PNG → usable:false 'is not a PNG'", () => !!notPng && notPng.usable === false && /is not a PNG/.test(notPng.why));
  const cut = refOf(expect({ index: { layers: [indexRow()] }, readReference: reader({ [REF]: REF_PNG.subarray(0, 150) }) }));
  safe("[11] a PNG cut off mid-stream → usable:false 'is not a PNG' (the reader checks every chunk it reads)", () => !!cut && cut.usable === false && /is not a PNG/.test(cut.why));
  const odd = [png(REF_W, REF_H, { colorType: 3 }), png(REF_W, REF_H, { bitDepth: 16 }), png(REF_W, REF_H, { interlace: 1 }), png(REF_W, REF_H, { colorType: 0 })]
    .map((b) => refOf(expect({ index: { layers: [indexRow()] }, readReference: reader({ [REF]: b }) })));
  safe("[11] palette / 16-bit / interlaced / grey PNGs → usable:false naming the colour type and depth", () =>
    odd.every((r) => !!r && r.usable === false && /colour type \d+ \/ depth \d+.*8-bit RGB\/RGBA, non-interlaced/.test(r.why)) && odd[2]?.usable === false && /interlaced —/.test(odd[2].why));
  const rgb = refOf(expect({ index: { layers: [indexRow()] }, readReference: reader({ [REF]: png(REF_W, REF_H, { colorType: 2 }) }) }));
  safe("[11] an 8-bit RGB PNG is usable", () => !!rgb && rgb.usable === true);
  const noRef = refOf(expect({ readReference: reader({}) }, without(FIRINGS, "reference")));
  safe("[11] an export with no reference → usable:false, path null", () => !!noRef && noRef.usable === false && noRef.path === null && /no reference PNG/.test(noRef.why));
  const noSize = refOf(expect({ readReference: reader({ [REF]: REF_PNG }) }, without(FIRINGS, "box", "renderBox")));
  safe("[11] no frame.w/h → usable:false", () => !!noSize && noSize.usable === false && /no size/.test(noSize.why));
}

// ---------------------------------------------------------------- the PNG's height, the pointer's place (--expect)
console.log("[11] --expect: width AND height of the PNG checked; the pointer confined to design/export:");
{
  const tall = refOf(expect({ index: { layers: [indexRow()] }, readReference: reader({ [REF]: png(REF_W, 150000) }) }));
  safe("the right width but 150000 px tall → usable:false naming both sizes (never decoded by the probe)", () =>
    !!tall && tall.usable === false && /is 2082×150000 px, but the frame's render bounds at 1\.4222x are 2082×1058/.test(tall.why) && /re-run --expect/.test(tall.why));
  const short = refOf(expect({ index: { layers: [indexRow()] }, readReference: reader({ [REF]: png(REF_W, REF_H - 40) }) }));
  safe("a PNG 40 px shorter than the render bounds (a stale reference) → usable:false", () => !!short && short.usable === false && /render bounds/.test(short.why));
  const near = refOf(expect({ index: { layers: [indexRow()] }, readReference: reader({ [REF]: png(REF_W, REF_H + 2) }) }));
  safe("±2 px of rounding is still usable", () => !!near && near.usable === true);
  // a tall narrow frame: the scale comes from png.w (164 px), so round(5000 · 0.41) = 2050 is not the PNG's 2048 — allowed
  const LEDGER: NodeInput = { type: "FRAME", id: "90:50", name: "Kiln Ledger", box: { x: 3000, y: 0, w: 400, h: 5000 }, reference: "assets/90_50_ref.png", fills: [{ type: "solid", color: "#f7f3ee" }], children: [] };
  const led = [164, 163].map((w) => refOf(expect({ readReference: reader({ "assets/90_50_ref.png": png(w, 2048) }) }, LEDGER)));
  safe("a 400×5000 frame's 164×2048 / 163×2048 reference stays usable (the height tolerance carries the scale's own rounding)", () => led.every((r) => !!r && r.usable === true));
  const evil = refOf(expect({ readReference: () => REF_PNG }, { ...FIRINGS, reference: "../../outside/x.png" }));
  safe("a pointer with ../.. → usable:false 'leads outside design/export' (never read, hashed or decoded)", () => !!evil && evil.usable === false && /leads outside design\/export/.test(evil.why));
  const inner = refOf(expect({ readReference: reader({ "assets/sub/../90_1.png": REF_PNG }) }, { ...FIRINGS, reference: "assets/sub/../90_1.png" }));
  safe("a `..` that stays inside design/export is fine", () => !!inner && inner.usable === true);
  // a sibling directory sharing the prefix ("design/export-evil") is outside too
  const ex = path.resolve("/r", "design", "export");
  safe("resolveInside refuses a sibling sharing the prefix (design/export-evil) and accepts a file inside", () =>
    resolveInside(ex, "../export-evil/x.png") === null && resolveInside(ex, "assets/x.png") === path.join(ex, "assets", "x.png"));
}

// ---------------------------------------------------------------- 12: colour profile
console.log("[12] --expect: a Display P3 document or an iCCP reference is recorded (no colour management):");
{
  const p3 = refOf(expect({ index: { layers: [indexRow()] }, readReference: reader({ [REF]: REF_PNG }), colorProfile: "display_p3" }));
  safe("[12] design-system colorProfile display_p3 → colorProfile 'display_p3'", () => !!p3 && p3.usable === true && p3.colorProfile === "display_p3");
  const icc = refOf(expect({ index: { layers: [indexRow()] }, readReference: reader({ [REF]: png(REF_W, REF_H, { iccp: "Display P3" }) }), colorProfile: "srgb" }));
  safe("[12] an iCCP chunk → colorProfile 'iCCP:Display P3'", () => !!icc && icc.usable === true && icc.colorProfile === "iCCP:Display P3");
  const nameless = refOf(expect({ index: { layers: [indexRow()] }, readReference: reader({ [REF]: png(REF_W, REF_H, { iccp: "" }) }), colorProfile: "srgb" }));
  safe("[12] an iCCP chunk with no profile name → 'iCCP:unnamed'", () => !!nameless && nameless.usable === true && nameless.colorProfile === "iCCP:unnamed");
  const both = refOf(expect({ index: { layers: [indexRow()] }, readReference: reader({ [REF]: png(REF_W, REF_H, { iccp: "Display P3" }) }), colorProfile: "display_p3" }));
  safe("[12] both → both named", () => !!both && both.usable === true && both.colorProfile === "display_p3 + iCCP:Display P3");
  const srgb = refOf(expect({ index: { layers: [indexRow()] }, readReference: reader({ [REF]: REF_PNG }), colorProfile: "srgb" }));
  safe("[12] srgb stamp + sRGB/gAMA chunks (Figma's own) → no colorProfile", () => !!srgb && srgb.usable === true && !("colorProfile" in srgb));
}

// ---------------------------------------------------------------- --expect through the CLI (main reads the files)
console.log("[9-12] --expect CLI: main reads design/export/<pointer> and design-system.json:");
{
  const CLI = path.join(import.meta.dirname, "..", "design-to-code", "verify-screen.ts");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "verify-visual-expect-"));
  const put = (rel: string, v: string | Buffer): string => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), v); return rel; };
  const scr = put("design/export/pages/Studio/Firings__90_1.json", JSON.stringify(doc(FIRINGS)));
  put("design/export/pages/index.json", JSON.stringify({ pageDirs: [{ page: "Studio", pageId: "1:2", dir: "Studio", index: "pages/Studio/index.json", layers: 1 }], layers: [indexRow()], sourceFile: KILN }));
  put("design/export/" + REF, REF_PNG);
  put("design/export/design-system.json", JSON.stringify({ exportedAt: "2026-10-06T00:00:00Z", file: KILN, colorProfile: "display_p3", files: {} }));
  const r = spawnSync(process.execPath, [CLI, "--expect", scr], { encoding: "utf8", cwd });
  const e = readJsonOrNull(path.join(cwd, "design/verify/Firings__90_1.expected.json"), isVerifyExpectation);
  const ri = e ? e.referenceImage : undefined;
  safe("[9] the CLI's expectation carries referenceImage from:index with the PNG's sha256, and the P3 stamp", () =>
    r.status === 0 && !!ri && ri.usable === true && ri.from === "index" && ri.sha256 === sha(REF_PNG) && ri.colorProfile === "display_p3");
  safe("[9] …stderr names the reference and its scale", () => /reference design\/export\/assets\/90_1_ref-7c1e0a\.png 2082×1058 at 1\.4222x \(index\), offset -12,-12/.test(r.stderr));
  fs.writeFileSync(path.join(cwd, "design/export/" + REF), png(360, 309));
  const r2 = spawnSync(process.execPath, [CLI, "--expect", scr, "--force"], { encoding: "utf8", cwd });
  const e2 = readJsonOrNull(path.join(cwd, "design/verify/Firings__90_1.expected.json"), isVerifyExpectation);
  safe("[11] the CLI on a thumbnail: usable:false and a 'no visual diff' note", () =>
    r2.status === 0 && e2?.referenceImage?.usable === false && /note {2}no visual diff for this screen: the reference is a 360 px image/.test(r2.stderr));
  fs.rmSync(cwd, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 13: compare → report.visual
const exp = buildExpectation([screen], { index: { layers: [indexRow()] }, readReference: reader({ [REF]: REF_PNG }) });
const PROBE: ProbeIdentity = { name: "verify-probe", version: "1.0.0", sha256: "c".repeat(64), playwright: { package: "playwright", version: "1.63.0" }, browser: { name: "chromium", version: "153.0" } };
function echo(spec: VerifySpec): MeasuredNode {
  const styles: MeasuredStyles = {};
  const src: Record<string, unknown> = { ...spec };
  for (const k of STYLE_KEYS) { const v = src[k]; if (v !== undefined) styles[k] = v; }
  if (spec.nodeId === "90:12") styles.backgroundColor = "#aa2222ff"; // one real delta: the fidelity side is not empty
  return { nodeId: spec.nodeId, styles, matchedBy: "tag" };
}
const base = (extra: Partial<VerifyMeasured> = {}): VerifyMeasured => ({
  measuredAt: "2026-10-06T01:00:00Z", renderer: "playwright-chromium", viewport: "1440x720", probe: PROBE, nodes: exp.nodes.map(echo), interactions: [], ...extra,
});
const region = (x: number, pixels: number, built: string[], designed: string[]): VisualRegion => ({ rect: { x, y: 160, w: 320, h: 200 }, pixels, pct: Math.round((pixels / (320 * 200 * 2.02)) * 1000) / 10, built, designed });
const ranVisual = (o: { differingPct?: number; shiftTolerantPct?: number; regions?: VisualRegion[]; regionsTotal?: number; diff?: string | null; grid?: "reference" | "1x"; sha256?: string; colorProfile?: string; notes?: string[] } = {}): MeasuredVisual => ({
  version: 1, ran: true,
  reference: { path: "design/export/" + REF, sha256: o.sha256 ?? sha(REF_PNG), scale: 1.4222, offset: { x: -12, y: -12 }, from: "index", crop: { x: 17, y: 17, w: 2048, h: 1024 }, ...(o.colorProfile ? { colorProfile: o.colorProfile } : {}) },
  capture: { dsf: 1.4222, clip: { x: 0, y: 0, w: 1440, h: 720 }, frame: { nodeId: "90:1", via: "tag", selector: "[data-dt-node=\"90:1\"]" }, size: { w: 2048, h: 1024 } },
  grid: o.grid ?? "reference", resampled: o.grid === "1x" ? "both" : "none", compared: { w: 2048, h: 1024, k: 1.4222 },
  threshold: 0.2, shiftPx: 1, cellPx: 11, hotFraction: 0.25,
  differingPct: o.differingPct ?? 2.4, shiftTolerantPct: o.shiftTolerantPct ?? 0.9, aaPct: 1.1,
  regions: o.regions ?? [region(680, 41000, ["90:12", "90:1"], ["90:12"]), region(0, 900, ["90:10"], ["90:10", "90:101"])], regionsTotal: o.regionsTotal ?? 2,
  diff: o.diff === undefined ? "design/verify/Firings__90_1.diff.png" : o.diff, elapsedMs: 1400, notes: o.notes ?? ["the build frame is 80 px taller than the design — only the design window is compared"],
});
const visualOf = (r: VerifyReportV2): ReportVisual | undefined => { const v: unknown = r.visual; return v && typeof v === "object" ? r.visual : undefined; };
console.log("[13] --compare: report.visual from measured.visual, always written:");
{
  const r = compare(exp, base({ visual: ranVisual() }));
  const v = visualOf(r);
  safe("[13] report.visual {ran, differingPct, shiftTolerantPct, grid, scale, reference {path, from, sha256}, regions, regionsTotal, diff, notes}", () =>
    !!v && v.ran === true && v.differingPct === 2.4 && v.shiftTolerantPct === 0.9 && v.grid === "reference" && v.scale === 1.4222
    && v.reference?.path === "design/export/" + REF && v.reference.from === "index" && v.reference.sha256 === sha(REF_PNG)
    && v.regions.length === 2 && v.regions[0]?.built[0] === "90:12" && v.regionsTotal === 2 && v.diff?.path === "design/verify/Firings__90_1.diff.png" && v.diff.exists === false
    && v.notes.some((n) => /80 px taller/.test(n)));
  safe("[13] the third headline: 'VISUAL (informational — never the verdict) — 0.9% of pixels differ (2.4% before 1-px shift tolerance) · 2 hot regions · at the reference's 1.4222x (index) · <diff> (missing)'", () =>
    v?.headline === "VISUAL (informational — never the verdict) — 0.9% of pixels differ (2.4% before 1-px shift tolerance) · 2 hot regions · at the reference's 1.4222x (index) · design/verify/Firings__90_1.diff.png (missing)");
  const none = visualOf(compare(exp, base()));
  safe("[13] no visual block → ran:false, why 'carries no visual diff (… predates the visual diff)', headline 'not run (…)'", () =>
    !!none && none.ran === false && none.why === "the measured file carries no visual diff (hand-written, or a probe that predates the visual diff)" && none.regions.length === 0
    && none.headline === "VISUAL (informational — never the verdict) — not run (the measured file carries no visual diff (hand-written, or a probe that predates the visual diff))");
  // a measured file with no probe block (hand-written, a non-web stack) — not applicable, never "predates the visual diff"
  const { probe: _probe, ...handBase } = base();
  const hand = compare(exp, handBase);
  const handV = visualOf(hand);
  safe("no probe block, no visual → ran:false 'not applicable (no web probe)', headline '… — not applicable (no web probe)', md 'Not applicable'", () =>
    !!handV && handV.ran === false && handV.why === "not applicable (no web probe)" && handV.headline === "VISUAL (informational — never the verdict) — not applicable (no web probe)"
    && /## Visual diff — informational, not part of the verdict[\s\S]*Not applicable \(no web probe\)\./.test(reportToMarkdown(hand)));
  safe("…the verdict and why are the probe-less file's own (the same as without the change)", () => {
    const withProbe = compare(exp, base());
    return hand.verdict !== undefined && JSON.stringify(hand.deltas) === JSON.stringify(withProbe.deltas);
  });
  const notRun = visualOf(compare(exp, base({ visual: { version: 1, ran: false, why: "no time left within --max-time after measuring and driving" } })));
  safe("[13] the probe's ran:false why is carried", () => notRun?.ran === false && notRun.why === "no time left within --max-time after measuring and driving" && /not run \(no time left/.test(notRun.headline));
  const oneX = visualOf(compare(exp, base({ visual: ranVisual({ grid: "1x", colorProfile: "display_p3" }) })));
  safe("[13] grid 1x says resampled (resampling can hide a difference: not downscaling, s < 1 upsamples); a colour profile is named", () =>
    !!oneX && /resampled to 1x \(reference 1\.4222x \(index\)\) — resampling can hide a difference/.test(oneX.headline) && /display_p3: colours not colour-managed/.test(oneX.headline));
  // malformed: readableMeasured drops it with a note; compare says malformed (never "predates the visual diff")
  const bad = { ...base(), visual: { version: 1, ran: true, differingPct: "lots" } };
  safe("[13] isMeasuredVisual: ran and ran:false blocks pass, a block without numbers does not", () =>
    has("isMeasuredVisual") && guards.isMeasuredVisual(ranVisual()) && guards.isMeasuredVisual({ version: 1, ran: false, why: "x" }) && !guards.isMeasuredVisual(bad.visual) && !isVerifyMeasured(bad));
  const rm = readableMeasured(bad);
  safe("[13] readableMeasured drops a malformed visual block with an input note and lists it in dropped", () =>
    !!rm && rm.doc.visual === undefined && rm.dropped.includes("visual") && rm.notes.some((n) => /^measured\.visual is not a visual block .*; ignored$/.test(n)));
  const rr = rm ? compare(exp, rm.doc, { inputNotes: rm.notes, visualMalformed: rm.dropped.includes("visual") }) : null;
  safe("[13] …report.visual says the block is malformed, the verdict is the no-block one", () =>
    !!rr && visualOf(rr)?.ran === false && /visual block is malformed/.test(visualOf(rr)?.why ?? "") && rr.verdict === compare(exp, base()).verdict);
  const someBad = visualOf(compare(exp, base({ visual: malformed<MeasuredVisual>({ ...ranVisual(), regions: [region(0, 10, ["90:10"], []), { rect: "?" }] }) })));
  safe("[13] a malformed region row is left out with a note (the rest of the block is kept)", () => someBad?.ran === true && someBad.regions.length === 1 && someBad.notes.some((n) => /1 malformed region row/.test(n)));
  // markdown
  const md = reportToMarkdown(r);
  const lines = md.split("\n");
  const bh = lines.indexOf(`**${r.behaviour.headline}**`);
  safe("[13] md: the VISUAL headline is a plain (not bold) line under the behaviour headline", () => bh > 0 && lines[bh + 2] === v?.headline);
  safe("[13] md: a section 'Visual diff — informational, not part of the verdict' after the behaviour section, with the 1–3% font note", () =>
    /## Behaviour and accessibility — not part of the verdict[\s\S]*## Visual diff — informational, not part of the verdict/.test(md) && /Font rasterisation alone differs 1–3% on text-heavy screens/.test(md));
  safe("[13] md: the regions table (Region | Size | Differ | Built nodes | Designed nodes) with the ids, and the diff path", () =>
    md.includes("| Region (x, y) | Size | Differ | Built nodes | Designed nodes |") && md.includes("| 680, 160 | 320×200 | 31.7% (41000 px) | 90:12, 90:1 | 90:12 |")
    && md.includes("Diff image: design/verify/Firings__90_1.diff.png (missing on disk)"));
  const evil = reportToMarkdown(compare(exp, base({ visual: ranVisual({ notes: ["frame <main> | a `tick`"] }) })));
  safe("[13] md: probe text is escaped (mdText)", () => evil.includes("- frame &lt;main&gt; \\| a \\`tick\\`"));
  const noneMd = reportToMarkdown(compare(exp, base()));
  safe("[13] md: no block → 'Not run (…predates the visual diff).'", () => /## Visual diff — informational, not part of the verdict[\s\S]*Not run \(the measured file carries no visual diff \(hand-written, or a probe that predates the visual diff\)\)\./.test(noneMd));
  // against: only on the same reference sha and grid
  const prev = compare(exp, base({ visual: ranVisual({ shiftTolerantPct: 3.2 }) }));
  const now = visualOf(compare(exp, base({ visual: ranVisual() }), { against: { file: "design/verify/Firings__90_1.report.json", report: readBack(prev) } }));
  const otherRef = visualOf(compare(exp, base({ visual: ranVisual({ sha256: "d".repeat(64) }) }), { against: { file: "x.report.json", report: readBack(prev) } }));
  safe("[13] against: 'visual: 3.2 % → 0.9 %' when both rounds diffed the same reference on the same grid; none when the reference changed", () =>
    now?.against?.before === 3.2 && now.against.after === 0.9 && otherRef?.against === undefined
    && reportToMarkdown(compare(exp, base({ visual: ranVisual() }), { against: { file: "p.report.json", report: readBack(prev) } })).includes("visual: 3.2 % → 0.9 %"));
}

// ---------------------------------------------------------------- 14: the verdict is unaffected
console.log("[14] the visual diff never reaches the fidelity verdict:");
{
  const without = compare(exp, base());
  const loud = compare(exp, base({ visual: ranVisual({ differingPct: 40, shiftTolerantPct: 40, regionsTotal: 10, regions: Array.from({ length: 10 }, (_, i) => region(i * 100, 60000, ["90:1"], ["90:2"])) }) }));
  const strip = (r: VerifyReportV2): string => { const { visual: _v, ...rest } = r; return JSON.stringify(rest); };
  safe("[14] the fixture's fidelity side is not empty (a real delta)", () => without.deltas.length > 0);
  safe("[14] with and without a 40%, 10-region visual block → verdict, why, integrity, summary, coverage, deltas, headline identical", () =>
    loud.verdict === without.verdict && JSON.stringify(loud.why) === JSON.stringify(without.why) && JSON.stringify(loud.integrity) === JSON.stringify(without.integrity)
    && JSON.stringify(loud.summary) === JSON.stringify(without.summary) && JSON.stringify(loud.coverage) === JSON.stringify(without.coverage)
    && JSON.stringify(loud.deltas) === JSON.stringify(without.deltas) && loud.headline === without.headline);
  safe("[14] …the whole report is identical except report.visual (and the visual block is no unknown top-level key)", () =>
    strip(loud) === strip(without) && visualOf(loud)?.regionsTotal === 10 && !(loud.probe.unknownTopLevelKeys || []).some((k) => k.key === "visual"));
  safe("[14] …the fidelity headline never carries the visual line", () => !/VISUAL/.test(loud.headline) && probeLine(loud) === probeLine(without));
}

// ---------------------------------------------------------------- the CLI: third headline, the diff beside the measured file
console.log("[13] --compare CLI — the VISUAL line after the behaviour line:");
{
  const CLI = path.join(import.meta.dirname, "..", "design-to-code", "verify-screen.ts");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "verify-visual-"));
  const put = (rel: string, v: unknown): string => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), typeof v === "string" || Buffer.isBuffer(v) ? v : JSON.stringify(v, null, 2)); return rel; };
  const e = put("design/verify/Firings__90_1.expected.json", exp);
  // the probe ran in a stage dir that is gone; the diff was published beside the measured file
  const m = put("design/verify/Firings__90_1.measured.json", base({ visual: ranVisual({ diff: ".stage/run-1/Firings__90_1.diff.png" }) }));
  put("design/verify/Firings__90_1.diff.png", png(8, 8));
  const r = spawnSync(process.execPath, [CLI, "--compare", e, m], { encoding: "utf8", cwd });
  const rep = readJsonOrNull(path.join(cwd, "design/verify/Firings__90_1.report.json"), isVerifyReport);
  const err = r.stderr.split("\n");
  const bl = rep && rep.behaviour ? err.indexOf(rep.behaviour.headline) : -1;
  safe("[13] stderr: fidelity headline, probe line, BEHAVIOUR line, then the VISUAL line", () =>
    !!rep && bl > 1 && err[bl - 1] === probeLine(rep) && err[bl + 1] === rep.visual?.headline && /^VISUAL \(informational — never the verdict\) — 0\.9% of pixels differ/.test(err[bl + 1] ?? ""));
  safe("[13] …the recorded diff path is gone, the same name beside the measured file is found", () =>
    rep?.visual?.diff?.path === "design/verify/Firings__90_1.diff.png" && rep.visual.diff.exists === true && !/\(missing\)/.test(rep.visual.headline));
  safe("[13] …report.md carries the section", () => /## Visual diff — informational, not part of the verdict/.test(fs.readFileSync(path.join(cwd, "design/verify/Firings__90_1.report.md"), "utf8")));
  const m2 = put("design/verify/Old__90_1.measured.json", { ...base(), visual: { ran: "yes" } });
  const r2 = spawnSync(process.execPath, [CLI, "--compare", e, m2, "--out", "design/verify/Old__90_1"], { encoding: "utf8", cwd });
  const rep2 = readJsonOrNull(path.join(cwd, "design/verify/Old__90_1.report.json"), isVerifyReport);
  safe("[13] a malformed visual block through the CLI: a note, exit 0/1 (never 2), report.visual ran:false 'malformed'", () =>
    (r2.status === 0 || r2.status === 1) && /note .*measured\.visual is not a visual block/.test(r2.stderr) && rep2?.visual?.ran === false && /visual block is malformed/.test(rep2.visual.why ?? ""));
  fs.rmSync(cwd, { recursive: true, force: true });
}

report();
