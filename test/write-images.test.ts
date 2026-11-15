// Images in a write (#170; docs/write-plane-spec.md decision 12): a paint from disk (`{type:"image", file}`) or one the
// file has (`{type:"image", hash}`). The pure halves (the safe reader, the sniffer, the loader that reads every file and
// rewrites its paints, the spec checks, a keyed re-send's diff), the plugin's real code on a fake file (the images made
// before anything runs, the paints, the reply, the refusals), and figma_write end to end through the MCP server with a
// fake plugin (the wire's `images` table, a dry run that reads the files, no base64 in a reply).
//   bun test/write-images.test.ts
//
// Port rule: nothing here binds 8787–8789 (server-core's DT_TEST_EPHEMERAL_PORT seam; HOME and TMPDIR are a temp dir).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { check, report } from "./assert.ts";
import { fakePlugin } from "./fake-plugin.ts";
import { treeWorld } from "./harness/writes.ts";
import type { FakeNode } from "./fake-figma.ts";
import { encodePng } from "../bridge/src/png.ts";
import { imagePreview, loadImageFiles, MAX_BATCH_IMAGE_BYTES, MAX_IMAGE_BYTES, sniffImage } from "../bridge/src/image-file.ts";
import { imagePaintsIn, imageTableError, IMAGE_BYTES_REASON } from "../bridge/src/image-spec.ts";
import { nodeProjectIo, readProjectFile, type ProjectIo } from "../bridge/src/project-file.ts";
import { checkTree } from "../bridge/src/tree-check.ts";
import { checkPatch } from "../bridge/src/patch-spec.ts";
import { ownSpec, planUpdate, type OldNode } from "../bridge/src/tree-diff.ts";
import type { TreeNodeSpec } from "../bridge/src/tree-spec.ts";
import { writeOpError, writeOpPreview, type WhoamiReply, type WriteOp, type WriteResult } from "../bridge/src/commands.ts";
import { isUnknownArray } from "../bridge/src/json-util.ts";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dt-images-")));
const project = path.join(dir, "project");
fs.mkdirSync(project, { recursive: true });
const put = (name: string, bytes: Uint8Array | string): string => {
  const p = path.join(project, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, bytes);
  return p;
};
const inside = (p: string, what: string): string => {
  const r = path.resolve(project, p);
  const rel = path.relative(project, r);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`${what} must stay inside the directory (got ${p})`);
  return r;
};
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const err = (r: { error: string } | object): string => ("error" in r && typeof r.error === "string" ? r.error : "(no error)");
const sha256 = (b: Uint8Array): string => crypto.createHash("sha256").update(b).digest("hex");

// ---- image bytes: a real PNG, a JPEG and a GIF header with their sizes, and files Figma does not take
const png = (w: number, h: number, seed = 0): Buffer => {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7 + seed) & 0xff;
  return encodePng({ w, h, data });
};
/** A PNG signature and IHDR claiming w×h (the sniffer reads the header only). */
const pngHeader = (w: number, h: number): Buffer => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write("IHDR", 12, "latin1"); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
};
const jpeg = (w: number, h: number): Buffer => Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xff, 0xdb, 0x00, 0x04, 0x00, 0x00, // a short DQT, skipped by its length
  0xff, 0xc2, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  0xff, 0xd9,
]);
const gif = (w: number, h: number): Buffer => Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.from([w & 0xff, w >> 8, h & 0xff, h >> 8, 0, 0, 0]), Buffer.from([0x3b])]);
const webp = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.from([20, 0, 0, 0]), Buffer.from("WEBPVP8 ", "latin1"), Buffer.alloc(12)]);
const svg = "<?xml version=\"1.0\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"8\" height=\"8\"></svg>";

console.log("\nthe sniffer:");
{
  const p = sniffImage(png(3, 2)), j = sniffImage(jpeg(640, 480)), g = sniffImage(gif(300, 2)), big = sniffImage(pngHeader(5000, 10));
  check("a PNG, a JPEG (its SOF2 after a DQT) and a GIF: format and size", same(p, { format: "PNG", w: 3, h: 2 }) && same(j, { format: "JPEG", w: 640, h: 480 }) && same(g, { format: "GIF", w: 300, h: 2 }));
  check("a PNG's size is its IHDR's (the sniffer reads no further)", same(big, { format: "PNG", w: 5000, h: 10 }));
  check(`a WebP is named and refused (${err(sniffImage(webp))})`, err(sniffImage(webp)) === "is a WebP image; Figma takes PNG, JPEG or GIF");
  check(`an SVG is named, with the icon route (${err(sniffImage(Buffer.from(svg)))})`, /^is an SVG \(vector\) file \(an icon is a component instance.*; Figma takes PNG, JPEG or GIF$/.test(err(sniffImage(Buffer.from(svg)))));
  check("text that is no image: refused without a name", err(sniffImage(Buffer.from("hello"))) === "is not an image Figma can take; Figma takes PNG, JPEG or GIF");
  check("a JPEG with no frame header: damaged", /damaged JPEG/.test(err(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xd9])))));
}

console.log("\nthe safe reader:");
{
  put("a.png", png(2, 2));
  fs.mkdirSync(path.join(project, "pics"), { recursive: true });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "dt-images-out-"));
  fs.writeFileSync(path.join(out, "secret.png"), png(2, 2, 9));
  fs.symlinkSync(path.join(out, "secret.png"), path.join(project, "link.png"));
  const W = { noun: "an image file", inside: "an image file", retry: "write again" };
  const ok = readProjectFile(path.join(project, "a.png"), "x", project, 1000, W);
  check("a file inside the directory is read whole", "bytes" in ok && ok.bytes.equals(fs.readFileSync(path.join(project, "a.png"))));
  check("a link that leads out is refused, naming where it leads", /x: .*link\.png leads, through a symbolic link, to .*secret\.png, outside the directory .*; an image file must be inside it/.test(err(readProjectFile(path.join(project, "link.png"), "x", project, 1000, W))));
  check("a missing file, a directory", /x: no file at .*nope\.png/.test(err(readProjectFile(path.join(project, "nope.png"), "x", project, 1000, W)))
    && /pics is not a file/.test(err(readProjectFile(path.join(project, "pics"), "x", project, 1000, W))));
  check("a file over the cap is refused by its size", /is \d+ bytes; an image file is at most 10$/.test(err(readProjectFile(path.join(project, "a.png"), "x", project, 10, W))));
  if (fs.constants.O_NOFOLLOW !== undefined) {
    let closed = 0;
    put("swap.png", png(2, 2));
    const swap: ProjectIo = { ...nodeProjectIo, realpath: (p) => { const r = nodeProjectIo.realpath(p); fs.rmSync(r); fs.symlinkSync(path.join(out, "secret.png"), r); return r; }, close: (fd) => { closed++; nodeProjectIo.close(fd); } };
    const r = readProjectFile(path.join(project, "swap.png"), "x", project, 1000, W, swap);
    check(`a file swapped for a link between the check and the open is refused, nothing read (${err(r)})`, /swap\.png changed while it was read .*; write again/.test(err(r)) && closed === 0);
  }
  fs.rmSync(out, { recursive: true, force: true });
}

console.log("\nthe loader:");
const load = (ops: Array<{ op: string } & Record<string, unknown>>, label?: (i: number) => number) => loadImageFiles(ops, inside, { root: project, ...(label ? { label } : {}) });
{
  const hero = put("img/hero.png", png(4, 3));
  put("img/logo.gif", gif(16, 16));
  put("img/copy.png", fs.readFileSync(hero));
  const tree = { name: "Screen", fills: [{ type: "image", file: "img/hero.png", scaleMode: "fit" }], children: [
    { name: "Logo", fills: [{ type: "image", file: "img/logo.gif" }] },
    { name: "Again", fills: [{ type: "solid", color: "#ffffff" }, { type: "image", file: "img/hero.png", opacity: 0.5 }] },
    { name: "Copy", fills: [{ type: "image", file: "img/copy.png" }] },
  ] };
  let reads = 0;
  const io: ProjectIo = { ...nodeProjectIo, open: (p) => { reads++; return nodeProjectIo.open(p); } };
  const r = loadImageFiles([{ op: "createTree", tree }, { op: "patch", nodeId: "1:2", set: { fills: [{ type: "image", file: "img/hero.png" }] } }], inside, { root: project, io });
  const heroId = sha256(fs.readFileSync(hero)), logoId = sha256(fs.readFileSync(path.join(project, "img/logo.gif")));
  const ops = "ops" in r ? r.ops : [];
  const t0 = ops[0]?.tree as TreeNodeSpec | undefined;
  check("each paint from disk gets the id of its bytes beside its file, its other fields kept", same(t0?.fills, [{ type: "image", file: "img/hero.png", scaleMode: "fit", image: heroId }])
    && same(t0?.children?.[0]?.fills, [{ type: "image", file: "img/logo.gif", image: logoId }])
    && same(t0?.children?.[1]?.fills, [{ type: "solid", color: "#ffffff" }, { type: "image", file: "img/hero.png", opacity: 0.5, image: heroId }]));
  check("the input ops are not changed", same(tree.fills, [{ type: "image", file: "img/hero.png", scaleMode: "fit" }]));
  check("one file read once however many paints name it (3 files for 5 paints)", reads === 3);
  check("the bytes go once per image (the same bytes under two names: once), as base64", "images" in r && same(Object.keys(r.images).sort(), [heroId, logoId].sort())
    && r.images[heroId] === fs.readFileSync(hero).toString("base64"));
  check("the records say what each image is and which ops use it", "records" in r && same(r.records.map((x) => [x.file, x.format, x.w, x.h, x.ops]), [["img/hero.png", "PNG", 4, 3, [0, 1]], ["img/logo.gif", "GIF", 16, 16, [0]]]));
  check("a loaded spec passes the tree check, a patch the patch check", t0 !== undefined && checkTree(t0).problems.length === 0 && writeOpError(ops[1], 1) === null);

  const untouched = [{ op: "createTree", tree: { name: "A", fills: [{ type: "solid", color: "#000000" }] } }];
  const u = load(untouched);
  check("a batch with no image file passes through as it is (the same objects), with no table", "ops" in u && u.ops[0] === untouched[0] && same(u.images, {}));
  const byHash = load([{ op: "createTree", tree: { name: "A", fills: [{ type: "image", hash: "a".repeat(40) }] } }]);
  check("a `hash` paint is not read: it is recorded for the dry run", "hashes" in byHash && same(byHash.hashes, [{ hash: "a".repeat(40), ops: [0] }]) && same(byHash.images, {}));

  const fill = (paint: Record<string, unknown>) => load([{ op: "createTree", tree: { name: "A", children: [{ name: "B", fills: [paint] }] } }]);
  check(`an \`image\` from the model is refused: the server sets it (${err(fill({ type: "image", file: "img/hero.png", image: "b".repeat(64) }))})`,
    err(fill({ type: "image", file: "img/hero.png", image: "b".repeat(64) })) === "ops[0].tree.children[0].fills[0].image: is set by the server (the id of the bytes it reads from `file`); leave it out");
  for (const [what, paint] of [
    ["base64 in `data`", { type: "image", data: "iVBORw0KGgo=" }],
    ["`bytes`", { type: "image", bytes: [137, 80] }],
    ["`src`", { type: "image", src: "https://example.com/a.png" }],
    ["a data: URI as `file`", { type: "image", file: "data:image/png;base64,iVBORw0KGgo=" }],
    ["an https URL as `file`", { type: "image", file: "https://example.com/a.png" }],
    ["a URL as `hash`", { type: "image", hash: "http://example.com/x" }],
  ] as const) {
    const e = err(fill(paint));
    check(`${what} is refused with the reason, before anything is read (${e})`, e.startsWith("ops[0].tree.children[0].fills[0].") && e.endsWith(IMAGE_BYTES_REASON));
  }
  check("a data: URI is not echoed in the refusal (it may hold the bytes)", !err(fill({ type: "image", file: "data:image/png;base64,iVBORw0KGgo=" })).includes("iVBOR")
    && !err(fill({ type: "image", hash: "data:image/png;base64,iVBORw0KGgo=" })).includes("iVBOR"));
  const blob = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  check("bare base64 as `file` is refused unread and unquoted", err(fill({ type: "image", file: blob })) === "ops[0].tree.children[0].fills[0].file: is base64 text, not a path; " + IMAGE_BYTES_REASON
    && err(fill({ type: "image", file: "QUJD".repeat(40) })).endsWith(IMAGE_BYTES_REASON) && !err(fill({ type: "image", file: "x.png" + "a".repeat(2000) })).includes("aaaa"));
  check("…and the image table does not quote a bad key", !String(imageTableError({ [blob]: "AA==" })).includes("iVBOR"));
  check("a malformed `hash` is refused by the loader, its value not echoed (no dry-run record of it)", err(fill({ type: "image", hash: "iVBORw0KGgoAAAANSUhEUg" })) === "ops[0].tree.children[0].fills[0].hash: is not an image hash (40 lowercase hex characters: the `hash` an image fill has in the read)");
  check("`file` and `hash` both: refused", /fills\[0\]: gives both `file` and `hash`/.test(err(fill({ type: "image", file: "img/hero.png", hash: "a".repeat(40) }))));
  check("a path outside the directory: the server's refusal, verbatim", err(fill({ type: "image", file: "../x.png" })) === "ops[0].tree.children[0].fills[0].file must stay inside the directory (got ../x.png)");
  check("a missing file", /^ops\[0\]\.tree\.children\[0\]\.fills\[0\]\.file: no file at .*nope\.png$/.test(err(fill({ type: "image", file: "nope.png" }))));
  put("w.webp", webp);
  put("icon.svg", svg);
  put("huge.png", pngHeader(4097, 100));
  put("fake.png", "not an image");
  check(`a WebP named .webp, an SVG, a PNG over 4096 px, text named .png: each refused by what it is (${err(fill({ type: "image", file: "huge.png" }))})`,
    /w\.webp is a WebP image; Figma takes PNG, JPEG or GIF$/.test(err(fill({ type: "image", file: "w.webp" })))
    && /icon\.svg is an SVG/.test(err(fill({ type: "image", file: "icon.svg" })))
    && /huge\.png is a PNG of 4097×100 px; Figma takes an image at most 4096 px on each side/.test(err(fill({ type: "image", file: "huge.png" })))
    && /fake\.png is not an image Figma can take/.test(err(fill({ type: "image", file: "fake.png" }))));
  put("big.png", Buffer.concat([png(2, 2), Buffer.alloc(MAX_IMAGE_BYTES)]));
  check("a file over 8 MB is refused by its size", /big\.png is \d+ bytes; an image file is at most 8388608/.test(err(fill({ type: "image", file: "big.png" }))));
  // The batch cap: five different 7 MB images are over 32 MB together.
  const parts: string[] = [];
  for (let i = 0; i < 5; i++) { parts.push(`b${i}.png`); put(`b${i}.png`, Buffer.concat([pngHeader(10, 10), Buffer.alloc(7 * 1024 * 1024, i)])); }
  const capped = load(parts.map((f) => ({ op: "createTree", tree: { name: f, fills: [{ type: "image", file: f }] } })));
  check(`a batch over ${MAX_BATCH_IMAGE_BYTES} bytes of images is refused, naming them (${err(capped).slice(0, 120)}…)`, /the batch's images are more than 32 MB together \(b0\.png 7 MB, .*b4\.png 7 MB\); one figma_write sends at most 32 MB of images: send the rest in another call/.test(err(capped)));
  check("…four of them fit", "ops" in load(parts.slice(0, 4).map((f) => ({ op: "createTree", tree: { name: f, fills: [{ type: "image", file: f }] } }))));
  check("an error names the op as the agent sent it (seedTokens expanded ops)", /^ops\[7\]\.tree/.test(err(load([{ op: "createTree", tree: { name: "A", fills: [{ type: "image", file: "nope.png" }] } }], () => 7))));
  check("a style's paints and a fragment's or an edit's fills are found too", imagePaintsIn({ op: "createStyles", styles: [{ name: "S", kind: "paint", set: { paints: [{ type: "image", hash: "x" }] } }] }, "ops[0]").map((x) => x.path).join() === "ops[0].styles[0].set.paints[0]"
    && imagePaintsIn({ tree: { fragments: { card: { fills: [{ type: "image", file: "a" }] } }, children: [{ use: "card", edits: { Pic: { fills: [{ type: "image", file: "b" }] } } }] } }, "").length === 2);
  const preview = imagePreview({ steps: [writeOpPreview({ op: "createTree", tree: { name: "A" } }, 0), writeOpPreview({ op: "createTree", tree: { name: "B" } }, 1)], note: "Nothing was changed." },
    [{ file: "img/hero.png", id: heroId, format: "PNG", w: 4, h: 3, bytes: 2048, ops: [1] }], [{ hash: "a".repeat(40), ops: [0] }]);
  check("the dry run says per step the file, format, size and bytes, and that a hash is checked at write time", same(preview.steps[1]?.images, ["img/hero.png: PNG 4×3, 2 kB"])
    && /hash a{40}: an image the file must already have \(checked when the write runs\)/.test(String(preview.steps[0]?.images)) && /^The image files were read and checked \(1, 2 kB\); .*Nothing was changed\.$/.test(preview.note));
}

console.log("\nthe spec checks:");
{
  const id = "c".repeat(64), hash = "d".repeat(40);
  const tree = (paint: Record<string, unknown>): string => checkTree({ name: "A", fills: [paint] }).problems.join("\n");
  check("an image from disk (once the server read it) and one by hash pass, with fit/tile/scale/opacity/intrinsicSize",
    tree({ type: "image", file: "a.png", image: id, scaleMode: "tile", scale: 0.5, opacity: 0.4 }) === "" && tree({ type: "image", hash, scaleMode: "fit", intrinsicSize: { w: 10, h: 10 } }) === "");
  check("`intrinsicSize` takes only numeric w and h (nothing else rides in it)", /intrinsicSize\.data: not a field the write accepts/.test(tree({ type: "image", hash, intrinsicSize: { w: 1, h: 1, data: "iVBORw0KGgo=" } }))
    && /intrinsicSize\.w/.test(tree({ type: "image", hash, intrinsicSize: { w: "1", h: 1 } })));
  check(`a file the server has not read (no \`image\`): refused like a treeFile that came round it (${tree({ type: "image", file: "a.png" })})`, /fills\[0\]\.file: an image file is read by figma_write on the MCP server/.test(tree({ type: "image", file: "a.png" })));
  check("crop, a transform, rotation, filters, tokens: not yet", /'crop' cannot be written yet/.test(tree({ type: "image", hash, scaleMode: "crop" }))
    && /\.transform: a read field a write cannot set yet/.test(tree({ type: "image", hash, transform: [[1, 0, 0], [0, 1, 0]] }))
    && /\.rotation: a read field a write cannot set yet/.test(tree({ type: "image", hash, rotation: 90 }))
    && /\.filters: a read field/.test(tree({ type: "image", hash, filters: { exposure: 1 } }))
    && /\.tokens: a read field a write cannot set yet — an image paint has no colour/.test(tree({ type: "image", hash, tokens: { color: "x" } })));
  check("a bad hash, neither file nor hash, a scale without tile, an `image` beside a hash", /\.hash is not an image hash \(40 lowercase hex/.test(tree({ type: "image", hash: "ABC" }))
    && /is missing `file` .* or `hash`/.test(tree({ type: "image" })) && /\.scale: is the tile's scale/.test(tree({ type: "image", hash, scale: 2 }))
    && /\.image: is set by the server for a `file`/.test(tree({ type: "image", hash, image: id })));
  check("inline bytes refused here too (a batch that came round the server)", tree({ type: "image", base64: "AAAA" }).endsWith(IMAGE_BYTES_REASON));
  check("video stays refused; the message says image can", /'video' cannot be written yet \(solid and image can\)/.test(tree({ type: "video", hash })));
  check("`asset` points at the image fill", /\.asset: .*fills: \[\{type: "image", file\}\]/.test(checkTree({ name: "A", asset: "x.png" }).problems.join()));
  check("an image paint is no raw colour: `unbound` does not count it", checkTree({ name: "A", fills: [{ type: "image", hash }] }).summary.unbound === 0);
  check("a patch takes an image fill, a style's paints too", checkPatch({ fills: [{ type: "image", hash }] }).problems.length === 0
    && writeOpError({ op: "setStyle", style: "S", set: { paints: [{ type: "image", hash }] } }, 0) === null);
  check("the wire's image table: ids and base64 only", imageTableError({ [id]: "iVBORw0KGgo=" }) === null && /not an image id/.test(String(imageTableError({ x: "AA==" })))
    && /is not base64 text/.test(String(imageTableError({ [id]: "<svg>" }))) && /not an object/.test(String(imageTableError([]))));
}

console.log("\na keyed re-send:");
{
  const old = (spec: TreeNodeSpec, at = "root"): OldNode<string> => ({ ref: at, spec: ownSpec(spec), children: (spec.children ?? []).map((c, i) => old(c, at + "/" + (c.name ?? String(i)))) });
  const a = put("k.png", png(2, 2, 1));
  const spec = (): TreeNodeSpec => {
    const r = load([{ op: "createTree", tree: { key: "k", name: "Screen", children: [{ name: "Pic", fills: [{ type: "image", file: "k.png" }] }] } }]);
    return ("ops" in r ? r.ops[0]?.tree : null) as TreeNodeSpec;
  };
  const first = spec();
  const again = planUpdate(old(first), spec());
  check("the same file sent again: no change", again.updates.length === 0 && again.builds.length === 0);
  fs.writeFileSync(a, png(2, 2, 2));
  const changed = planUpdate(old(first), spec());
  const pic = changed.updates.find((u) => u.ref === "root/Pic");
  check("the file changed on disk: its node's fills are patched with the new id", changed.updates.length === 1 && pic !== undefined && same(pic.fields, ["fills"]) && pic.set?.fills?.[0]?.type === "image");
  check("the stored spec keeps the file and the id only, no bytes", JSON.stringify(ownSpec(first)).length < 400 && !JSON.stringify(ownSpec(first)).includes("base64"));
}

// ---- the plugin's real code on a fake file
const imageOf = (n: FakeNode | undefined): Record<string, unknown> | null => {
  const f = n && Array.isArray(n.fills) ? (n.fills as unknown[])[0] : null;
  return typeof f === "object" && f !== null ? (f as Record<string, unknown>) : null;
};
async function pluginCases(): Promise<void> {
  console.log("\nthe plugin:");
  const bytes = png(5, 4, 3);
  const id = sha256(bytes);
  const table = { [id]: bytes.toString("base64") };
  const figmaHash = crypto.createHash("sha1").update(bytes).digest("hex");
  {
    const w = await treeWorld();
    const r = await w.api.applyWrites([{ op: "createTree", tree: { name: "Card", handle: "card", fills: [{ type: "image", file: "pics/a.png", image: id, scaleMode: "tile", scale: 0.5, opacity: 0.25 }] } }], table);
    const card = w.alive().find((n) => n.name === "Card");
    check(`an image from disk: made once, painted as an ImagePaint, the reply gives its hash and size (${JSON.stringify(r.images)})`, r.ok
      && same(imageOf(card), { type: "IMAGE", imageHash: figmaHash, scaleMode: "TILE", scalingFactor: 0.5, opacity: 0.25 })
      && same(r.images, [{ file: "pics/a.png", hash: figmaHash, w: 5, h: 4 }]));
    check("…one undo step: the batch commits before and after only", w.undo.commits === 2 && w.undo.implicit === 0);
    const cardId = String(card?.id);
    const p = await w.api.applyWrites([{ op: "patch", nodeId: cardId, set: { fills: [{ type: "image", hash: figmaHash, scaleMode: "fit" }] } }]);
    check("a patch reuses it by hash (no table needed), fit", p.ok && same(imageOf(w.alive().find((n) => n.name === "Card")), { type: "IMAGE", imageHash: figmaHash, scaleMode: "FIT" }) && p.images === undefined);
    const before = JSON.stringify(imageOf(w.alive().find((n) => n.name === "Card")));
    const unknown = await w.api.applyWrites([{ op: "patch", nodeId: cardId, set: { fills: [{ type: "image", hash: "e".repeat(40) }] } }, { op: "createFrame", name: "Never" }]);
    check(`a hash the file does not have refuses the whole batch before anything runs (${unknown.error})`, !unknown.ok && unknown.failedAt === 0 && /the file has no image with hash 'e{40}'/.test(String(unknown.error))
      && !w.alive().some((n) => n.name === "Never") && JSON.stringify(imageOf(w.alive().find((n) => n.name === "Card"))) === before);
    // A handle Figma returns for a hash it does not hold: its size cannot be read.
    w.scene.images["f".repeat(40)] = { getSizeAsync: async () => { throw new Error("Image not found"); }, getBytesAsync: async () => new Uint8Array() };
    const ghost = await w.api.applyWrites([{ op: "patch", nodeId: cardId, set: { fills: [{ type: "image", hash: "f".repeat(40) }] } }]);
    check("…and so does a hash whose handle has no image behind it", !ghost.ok && /no image with hash 'f{40}'/.test(String(ghost.error)));
    const notImg = Buffer.from("not an image at all");
    const notId = sha256(notImg);
    const bad = await w.api.applyWrites([{ op: "createFrame", name: "Never2" }, { op: "createTree", tree: { name: "X", fills: [{ type: "image", file: "pics/x.png", image: notId }] } }], { [notId]: notImg.toString("base64") });
    check(`bytes Figma cannot open refuse the whole batch, naming the file (${bad.error})`, !bad.ok && bad.failedAt === 1 && /'pics\/x\.png' is not an image Figma can open \(Image type is unsupported\)/.test(String(bad.error)) && !w.alive().some((n) => n.name === "Never2"));
    const missing = await w.api.applyWrites([{ op: "createTree", tree: { name: "Y", fills: [{ type: "image", file: "pics/y.png", image: "9".repeat(64) }] } }], {});
    check("an image whose bytes did not come with the batch: refused", !missing.ok && /'pics\/y\.png' came without its bytes/.test(String(missing.error)));
    const badTable = await w.api.applyWrites([{ op: "createFrame", name: "Z" }], { nope: "AA==" });
    check("a malformed table: refused", !badTable.ok && /not an image id/.test(String(badTable.error)) && !w.alive().some((n) => n.name === "Z"));
  }
  {
    // A keyed spec stores `file` and `image` only; a re-send of the same file changes nothing; a failed later op puts the
    // image fill back.
    const w = await treeWorld();
    const spec = { key: "hero", name: "Hero", children: [{ name: "Pic", fills: [{ type: "image", file: "a.png", image: id }] }] };
    const first = await w.api.applyWrites([{ op: "createTree", tree: spec }], table);
    const pic = w.alive().find((n) => n.name === "Pic");
    const stored = typeof pic?.getPluginData === "function" ? String((pic.getPluginData as (k: string) => string)("dtwin.spec")) : "";
    check(`the stored spec holds the file and the id, never the bytes (${stored})`, first.ok && stored.includes(id) && stored.includes("a.png") && !stored.includes(table[id] ?? "?"));
    const again = await w.api.applyWrites([{ op: "createTree", tree: spec }], table);
    check("the same image re-sent: unchanged", again.ok && again.applied[0]?.unchanged === true);
    const other = png(3, 3, 7);
    const otherId = sha256(other);
    const changed = await w.api.applyWrites([{ op: "createTree", tree: { ...spec, children: [{ name: "Pic", fills: [{ type: "image", file: "a.png", image: otherId }] }] } }, { op: "setFill", nodeId: "nope:1", color: "#000000" }], { [otherId]: other.toString("base64") });
    const after = imageOf(w.alive().find((n) => n.name === "Pic"));
    check("a changed image whose batch fails later is put back", !changed.ok && after?.imageHash === figmaHash && (changed.restored ?? []).length > 0);
  }
}

// ---- figma_write end to end, with a fake plugin running the plugin's real code
interface Reply { text: string; isError: boolean }
function replyText(r: unknown): Reply {
  const content: unknown = typeof r === "object" && r !== null && "content" in r ? r.content : undefined;
  const parts = isUnknownArray(content) ? content : [];
  const text = parts.map((c) => (typeof c === "object" && c !== null && "text" in c && typeof c.text === "string" ? c.text : "")).join("\n");
  return { text, isError: typeof r === "object" && r !== null && "isError" in r && r.isError === true };
}
const TOKEN = "write-images-token";
async function mcpCases(): Promise<void> {
  console.log("\nfigma_write end to end:");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const k of ["FIGMA_DAEMON_IDLE_MIN", "FIGMA_EXPORT_DIR", "FIGMA_BRIDGE_TOKEN_FILE", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR"]) delete env[k];
  Object.assign(env, {
    HOME: dir, USERPROFILE: dir, APPDATA: path.join(dir, "AppData"), TMPDIR: dir, TEMP: dir, TMP: dir,
    FIGMA_BRIDGE_PORT: "8789", FIGMA_BRIDGE_TOKEN: TOKEN, MAX_MCP_OUTPUT_TOKENS: "", DT_TEST_EPHEMERAL_PORT: "1",
  });
  const photo = put("shots/photo.png", png(6, 5, 4));
  const b64 = fs.readFileSync(photo).toString("base64");
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(import.meta.dirname, "..", "bridge", "src", "figma-mcp.ts")], env, cwd: project, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (d: Buffer) => { stderr += String(d); });
  const client = new Client({ name: "write-images", version: "0.0.0" });
  try {
    await client.connect(transport);
    let port = 0;
    for (let i = 0; i < 400 && !port; i++) {
      const m = /\[bridge\] DT_TEST_EPHEMERAL_PORT: 8789 -> (\d+)/.exec(stderr);
      if (m) port = Number(m[1]); else await sleep(25);
    }
    check("the MCP server is up and its bridge is listening", port > 0);
    if (!port) { console.log(stderr); return; }
    const call = async (args: Record<string, unknown>): Promise<Reply> => replyText(await client.callTool({ name: "figma_write", arguments: args }));
    const batch = [{ op: "createTree", tree: { name: "Shot", fills: [{ type: "image", file: "shots/photo.png", scaleMode: "fill" }], children: [{ name: "Again", fills: [{ type: "image", file: "shots/photo.png" }] }] } }];

    const dry = await call({ dryRun: true, ops: batch });
    check(`a dry run with no plugin reads the files and says what each is (${dry.text.slice(0, 200)}…)`, !dry.isError && dry.text.includes("shots/photo.png: PNG 6×5") && !dry.text.includes(b64.slice(0, 40)));
    const bad = await call({ dryRun: true, ops: [{ op: "createTree", tree: { name: "X", fills: [{ type: "image", file: "shots/none.png" }] } }] });
    check("…and refuses a missing one, saying nothing changed", bad.isError && /ops\[0\]\.tree\.fills\[0\]\.file: no file at .*none\.png\. Nothing was changed\./.test(bad.text));
    const inline = await call({ ops: [{ op: "createTree", tree: { name: "X", fills: [{ type: "image", data: b64 }] } }] });
    check("inline bytes are refused before the plugin is asked", inline.isError && inline.text.includes(IMAGE_BYTES_REASON));

    const w = await treeWorld();
    const writes: Array<{ ops: WriteOp[]; images?: Record<string, string> | undefined }> = [];
    const plugin = fakePlugin(port, {
      token: TOKEN, hello: { instanceId: "fig-img", file: "Sample App", page: "Page 1" },
      on: {
        whoami: (): WhoamiReply => ({ instanceId: "fig-img", startedAt: 0, uptimeMs: 1, file: "Sample App", page: "Page 1", pageId: "", editorType: "figma", pluginVersion: "0.0.0", fileKey: null, fileKeyAvailable: false, editsAllowed: true }),
        write: async (a): Promise<WriteResult> => { writes.push(a); return await w.api.applyWrites(a.ops.map((o) => ({ ...o })), a.images); },
      },
    });
    await plugin.opened;
    const real = await call({ ops: batch });
    const sent = writes[0];
    const id = sha256(fs.readFileSync(photo));
    check("the plugin gets each paint with the id of its bytes, and the bytes once, beside the ops", sent !== undefined && same(Object.keys(sent.images ?? {}), [id]) && sent.images?.[id] === b64
      && JSON.stringify(sent.ops).includes(id) && !JSON.stringify(sent.ops).includes(b64.slice(0, 40)));
    const reply = (() => { try { return JSON.parse(real.text) as WriteResult; } catch { return null; } })();
    check(`the write lands; its reply lists the image with Figma's hash, and holds no base64 (${real.text.slice(0, 200)})`, !real.isError && reply !== null && reply.ok
      && reply.images?.length === 1 && reply.images[0]?.file === "shots/photo.png" && /^[0-9a-f]{40}$/.test(String(reply.images[0]?.hash)) && !real.text.includes(b64.slice(0, 40)));
    check("both layers show the image", w.alive().filter((n) => imageOf(n)?.type === "IMAGE").length === 2);
    plugin.close();
  } finally {
    await client.close().catch(() => {});
  }
}

void (async () => {
  try {
    await pluginCases();
    await mcpCases();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    report();
  }
})();
