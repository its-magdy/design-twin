// The page capture (#175; docs/write-plane-spec.md, "From an existing app to Figma"): a rendered page as a tree spec on
// disk that figma_write lands by `treeFile`.
//   - the converter (design-to-code/capture-spec.ts), pure, on hand-made captures: flex, grid, block flow, text, fonts,
//     strokes, radius, clip, flattening, the node cap, images by file — every spec it makes passes the tree spec's check;
//   - the committed fixture capture (test/fixtures/capture/sample) is what the converter makes of its capture
//     (`bun test/capture-page.test.ts --record` writes it again after a converter change);
//   - the CLI's usage and exit codes;
//   - end to end with the repo's own Playwright: the BUILT claude-plugin/scripts/capture-page.js against a generic fixture
//     page served on an ephemeral port (Bun.serve, port 0), at two widths; then both specs landed through figma_write's
//     treeFile path on the MCP server with a fake plugin running the plugin's real code (dry run, a font the file lacks
//     refusing the whole batch, the real write, a re-send in place).
// Locally the browser half prints SKIPPED when chromium is not installed; in CI (CI=true) that is a failure.
//   bun test/capture-page.test.ts
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
import { sniffImage } from "../bridge/src/image-file.ts";
import { imagePaintsIn } from "../bridge/src/image-spec.ts";
import type { TreeNodeSpec } from "../bridge/src/tree-spec.ts";
import { checkTree } from "../bridge/src/tree-check.ts";
import type { WhoamiReply, WriteResult } from "../bridge/src/commands.ts";
import { isUnknownArray } from "../bridge/src/json-util.ts";
import { captureSpec, checkCaptured, countNodes, firstFamily, fontStyleName, hexOf, type CapEl, type CapFont, type CapText, type CaptureDoc } from "../design-to-code/capture-spec.ts";
import { CaptureError, ImageBudget, faceStyle, keptShot, nameFromUrl, outputEscape, within, type Kept } from "../design-to-code/capture-page.ts";
import { hideChildren, walkCapture } from "../design-to-code/probe-capture.ts";
import { INIT_SCRIPT } from "../design-to-code/probe-browser.ts";
import { runAsync, type ProcResult } from "../design-to-code/proc.ts";

const ROOT = path.join(import.meta.dirname, "..");
const BUNDLE = path.join(ROOT, "claude-plugin", "scripts", "capture-page.js");
const FIX = path.join(import.meta.dirname, "fixtures", "capture");
const SAMPLE = path.join(FIX, "sample");
const RECORD = process.argv.includes("--record");
const CI = process.env.CI === "true";
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const sha256 = (b: Uint8Array): string => crypto.createHash("sha256").update(b).digest("hex");
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dt-capture-")));

// ---------------------------------------------------------------- hand-made captures
const FONT: CapFont = { family: "Inter", size: 16, weight: 400, italic: false, lineHeight: 24, letterSpacing: 0, color: "rgb(24, 24, 27)", textAlign: "start", direction: "ltr", textTransform: "none", textDecoration: "none" };
let seq = 0;
function el(o: Partial<CapEl> & { rect: CapEl["rect"] }): CapEl {
  return {
    kind: "el", path: "p" + ++seq, tag: "div", name: "div", display: "block", position: "static", zIndex: 0,
    flexDirection: "row", flexWrap: "nowrap", justifyContent: "normal", alignItems: "normal", alignSelf: "auto", flexGrow: 0, order: 0,
    gridColumns: [], gridRows: [], gridPlaced: false, rowGap: 0, columnGap: 0, padding: [0, 0, 0, 0],
    background: null, border: null, radius: null, opacity: 1, clip: false, media: null, image: null, backgroundImage: null, text: null, dropped: [], children: [],
    ...o,
  };
}
const txt = (text: string, rect: CapEl["rect"], f: Partial<CapFont> = {}, lines = 1): CapText => ({ kind: "text", text, rect, lines, font: { ...FONT, ...f } });
/** An element whose content is one text, its box the text's line box. */
const textEl = (text: string, rect: CapEl["rect"], o: Partial<CapEl> = {}, f: Partial<CapFont> = {}, lines = 1): CapEl => el({ rect, ...o, text: txt(text, { ...rect }, f, lines) });
const docOf = (root: CapEl, o: Partial<CaptureDoc> = {}): CaptureDoc => ({ name: "t", width: root.rect.w, url: "http://127.0.0.1/t", document: true, background: "rgb(250, 250, 250)", root, ...o });
const page = (children: Array<CapEl | CapText>, h = 800): CapEl => el({ tag: "body", rect: { x: 0, y: 0, w: 400, h }, children });
const IMG = "a".repeat(64);
/** The spec (failing the case when the conversion refused it), checked by the tree spec's own check. */
function spec(d: CaptureDoc, label: string): TreeNodeSpec {
  const r = captureSpec(d);
  if (!r.ok) { check(`${label}: converts (${r.error})`, false); return {}; }
  const problems = checkCaptured(r.spec, () => IMG);
  if (problems.length) check(`${label}: passes the tree spec's check (${problems.slice(0, 3).join("; ")})`, false);
  return r.spec;
}
const kids = (n: TreeNodeSpec | undefined): TreeNodeSpec[] => (n && n.children) || [];
const at = (n: TreeNodeSpec, ...i: number[]): TreeNodeSpec | undefined => i.reduce<TreeNodeSpec | undefined>((m, k) => kids(m)[k], n);

console.log("converter:");
{
  // the root
  const s = spec(docOf(page([el({ rect: { x: 10, y: 20, w: 50, h: 40 }, background: "rgb(255, 0, 0)" })])), "root");
  check("the root is a frame '<name> @<width>' keyed capture:<name>@<width>, the document's size, the page's background, clipped",
    s.name === "t @400" && s.key === "capture:t@400" && same(s.box, { w: 400, h: 800 }) && same(s.fills, [{ type: "solid", color: "#fafafa" }]) && s.clip === true && s.layout === undefined);
  check("block flow: a child at its x/y, its colour as a solid fill", same({ x: at(s, 0)?.x, y: at(s, 0)?.y, f: at(s, 0)?.fills }, { x: 10, y: 20, f: [{ type: "solid", color: "#ff0000" }] }));
  const none = spec(docOf(page([]), { background: null }), "no background");
  check("a page that paints no background is white", same(none.fills, [{ type: "solid", color: "#ffffff" }]));
}
{
  // flex row: gap, padding, justify, align; a grown child; a stretched child; an absolute child
  const row = el({
    display: "flex", rect: { x: 0, y: 0, w: 400, h: 60 }, columnGap: 8, rowGap: 4, padding: [4, 8, 4, 8], justifyContent: "space-between", alignItems: "center", background: "rgb(255, 255, 255)",
    children: [
      el({ rect: { x: 8, y: 20, w: 40, h: 20 }, background: "rgb(1, 2, 3)" }),
      el({ rect: { x: 56, y: 4, w: 336, h: 52 }, background: "rgb(1, 2, 3)", flexGrow: 1, alignSelf: "stretch" }),
      el({ rect: { x: 300, y: 0, w: 10, h: 10 }, background: "rgb(1, 2, 3)", position: "absolute" }),
    ],
  });
  const s = spec(docOf(page([row])), "flex row");
  const r = at(s, 0);
  check("flex row → auto-layout: direction, gap, padding, justify, align", same(r?.layout, { display: "flex", flexDirection: "row", gap: 8, padding: [4, 8, 4, 8], justifyContent: "space-between", alignItems: "center" }));
  check("…its children carry no x/y; flex-grow → grow 1; a stretched child → alignSelf stretch", at(s, 0, 0)?.x === undefined && at(s, 0, 1)?.grow === 1 && at(s, 0, 1)?.alignSelf === "stretch");
  check("…an absolute child → absolute: true at its x/y, after the flow", at(s, 0, 2)?.absolute === true && at(s, 0, 2)?.x === 300 && at(s, 0, 2)?.y === 0);
}
{
  // flex column, stretch by default; wrap; reverse
  const col = el({
    display: "flex", flexDirection: "column", rect: { x: 0, y: 0, w: 200, h: 100 }, rowGap: 10, alignItems: "normal",
    children: [el({ rect: { x: 0, y: 0, w: 200, h: 20 }, background: "rgb(9, 9, 9)" }), el({ rect: { x: 0, y: 30, w: 50, h: 20 }, background: "rgb(9, 9, 9)" })],
  });
  const wrap = el({ display: "flex", flexWrap: "wrap", rect: { x: 0, y: 100, w: 200, h: 100 }, columnGap: 6, rowGap: 12, children: [el({ rect: { x: 0, y: 100, w: 90, h: 40 }, background: "rgb(9, 9, 9)" })] });
  const rev = el({
    display: "flex", flexDirection: "row-reverse", rect: { x: 0, y: 200, w: 200, h: 20 }, columnGap: 10,
    children: ["A", "B", "C"].map((t, i) => textEl(t, { x: 190 - i * 20, y: 200, w: 10, h: 20 })),
  });
  const s = spec(docOf(page([col, wrap, rev])), "flex column, wrap, reverse");
  check("flex column → a column with the row gap; a full-width child of a stretching column → alignSelf stretch, a narrower one not",
    same(at(s, 0)?.layout, { display: "flex", flexDirection: "column", gap: 10 }) && at(s, 0, 0)?.alignSelf === "stretch" && at(s, 0, 1)?.alignSelf === undefined);
  check("flex-wrap → flexWrap wrap: the main-axis gap as gap, the cross one as rowGap", same(at(s, 1)?.layout, { display: "flex", flexDirection: "row", gap: 6, flexWrap: "wrap", rowGap: 12 }));
  check("row-reverse → a row with the children reversed, packed at the far end (flex-end)",
    same(kids(at(s, 2)).map((k) => k.text), ["C", "B", "A"]) && at(s, 2)?.layout?.justifyContent === "flex-end");
  // a reversed flex that wraps onto two lines: CSS reverses each line, Figma's wrap cannot → the children keep their x/y
  const chip = (t: string, x: number, y: number): CapEl => textEl(t, { x, y, w: 80, h: 20 });
  const revWrap = el({ display: "flex", flexDirection: "row-reverse", flexWrap: "wrap", rect: { x: 0, y: 0, w: 200, h: 50 }, columnGap: 10, rowGap: 10,
    children: [chip("A", 120, 0), chip("B", 30, 0), chip("C", 120, 30)] });
  const revOne = el({ display: "flex", flexDirection: "row-reverse", flexWrap: "wrap", rect: { x: 0, y: 0, w: 200, h: 20 }, columnGap: 10, children: [chip("A", 120, 0), chip("B", 30, 0)] });
  const rw = captureSpec(docOf(page([revWrap])));
  const rws = spec(docOf(page([revWrap])), "reverse + wrap, two lines");
  check("row-reverse that wraps onto several lines → no auto-layout, each child at its measured x/y, counted as approximated (reverse-wrap)",
    at(rws, 0)?.layout === undefined && same(kids(at(rws, 0)).map((k) => [k.text, k.x, k.y]), [["A", 120, 0], ["B", 30, 0], ["C", 120, 30]]) && rw.stats.approximated["reverse-wrap"]?.samples[0] === revWrap.path);
  const ro = spec(docOf(page([revOne])), "reverse + wrap, one line");
  check("…on one line it is still a reversed wrapping row", at(ro, 0)?.layout?.flexWrap === "wrap" && same(kids(at(ro, 0)).map((k) => k.text), ["B", "A"]));
}
{
  // grid: one column, one row, several columns (wrap), irregular
  const cell = (x: number, y: number, w: number): CapEl => el({ rect: { x, y, w, h: 30 }, background: "rgb(9, 9, 9)" });
  const oneCol = el({ display: "grid", rect: { x: 0, y: 0, w: 100, h: 70 }, gridColumns: [100], gridRows: [30, 30], rowGap: 10, children: [cell(0, 0, 100), cell(0, 40, 100)] });
  const oneRow = el({ display: "grid", rect: { x: 0, y: 100, w: 210, h: 30 }, gridColumns: [100, 100], gridRows: [30], columnGap: 10, children: [cell(0, 100, 100), cell(110, 100, 100)] });
  const multi = el({ display: "grid", rect: { x: 0, y: 200, w: 320, h: 70 }, gridColumns: [100, 100, 100], gridRows: [30, 30], columnGap: 10, rowGap: 10,
    children: [cell(0, 200, 100), cell(110, 200, 100), cell(220, 200, 100), cell(0, 240, 100)] });
  const odd = el({ display: "grid", rect: { x: 0, y: 300, w: 210, h: 40 }, gridColumns: [100, 100], gridRows: [30], columnGap: 10, children: [cell(0, 300, 210)] });
  const s = spec(docOf(page([oneCol, oneRow, multi, odd])), "grid");
  const r = captureSpec(docOf(page([oneCol, oneRow, multi, odd])));
  check("a one-column grid → a column with the row gap", same(at(s, 0)?.layout, { display: "flex", flexDirection: "column", gap: 10 }));
  check("a one-row grid → a row with the column gap", same(at(s, 1)?.layout, { display: "flex", flexDirection: "row", gap: 10 }));
  check("a grid of several columns → a wrapping row of fixed-width cells, the column gap as gap, the row gap between the rows",
    same(at(s, 2)?.layout, { display: "flex", flexDirection: "row", gap: 10, flexWrap: "wrap", rowGap: 10 }) && kids(at(s, 2)).every((k) => k.box?.w === 100 && k.x === undefined));
  check("a grid whose item spans tracks keeps its children where they are (no auto-layout), noted as approximated",
    at(s, 3)?.layout === undefined && at(s, 3, 0)?.x === 0 && r.stats.approximated.grid?.count === 1);
  // rows taller than their items: a column would pack them at 30 + gap, the page has them at the row pitch
  const tall = el({ display: "grid", rect: { x: 0, y: 0, w: 100, h: 210 }, gridColumns: [100], gridRows: [100, 100], rowGap: 10, alignItems: "start", children: [cell(0, 0, 100), cell(0, 110, 100)] });
  const centred = el({ display: "grid", rect: { x: 0, y: 300, w: 210, h: 100 }, gridColumns: [100, 100], gridRows: [100], columnGap: 10, alignItems: "center", children: [cell(0, 335, 100), cell(110, 335, 100)] });
  const rowsTall = el({ display: "grid", rect: { x: 0, y: 500, w: 210, h: 210 }, gridColumns: [100, 100], gridRows: [100, 100], columnGap: 10, rowGap: 10, alignItems: "start",
    children: [cell(0, 500, 100), cell(110, 500, 100), cell(0, 610, 100)] });
  const g = captureSpec(docOf(page([tall, centred, rowsTall])));
  const gs = spec(docOf(page([tall, centred, rowsTall])), "grid rows");
  check("a one-column grid of 100 px rows holding 30 px start-aligned items → no column (it would pack them), each at its x/y, approximated",
    at(gs, 0)?.layout === undefined && same(kids(at(gs, 0)).map((k) => k.y), [0, 110]) && g.stats.approximated.grid?.samples.includes(tall.path) === true);
  check("a one-row grid whose items are centred in a taller row → no row auto-layout (it would put them at the top)", at(gs, 1)?.layout === undefined && at(gs, 1, 0)?.y === 35);
  check("a wrapping grid whose row pitch is not item height + row gap → no auto-layout", at(gs, 2)?.layout === undefined && at(gs, 2, 2)?.y === 110 && g.stats.approximated.grid?.count === 3);
}
{
  // the position check: an auto-layout is written only when it puts the children where the page has them
  const box = (x: number, y: number, w = 40, h = 20): CapEl => el({ rect: { x, y, w, h }, background: "rgb(9, 9, 9)" });
  const margin = el({ display: "flex", rect: { x: 0, y: 0, w: 400, h: 20 }, columnGap: 8, children: [box(0, 0), box(60, 0)] });
  const auto = el({ display: "flex", rect: { x: 0, y: 40, w: 400, h: 20 }, columnGap: 8, children: [box(0, 40), box(48, 40), box(360, 40)] });
  const crossOff = el({ display: "flex", rect: { x: 0, y: 80, w: 400, h: 40 }, alignItems: "flex-start", children: [box(0, 80), box(40, 90)] });
  const fine = el({ display: "flex", rect: { x: 0, y: 140, w: 400, h: 40 }, columnGap: 8, padding: [10, 0, 10, 20], alignItems: "center", justifyContent: "center", children: [box(156, 150), box(204, 150, 60)] });
  const col = el({ display: "flex", flexDirection: "column", rect: { x: 0, y: 200, w: 100, h: 100 }, rowGap: 4, alignItems: "flex-end", children: [box(60, 200), box(60, 224)] });
  const d = docOf(page([margin, auto, crossOff, fine, col]));
  const r = captureSpec(d);
  const s = spec(d, "position check");
  check("a flex item with a margin (the gap is not the page's) → no auto-layout, children at their measured x/y, approximated (flex) with the path",
    at(s, 0)?.layout === undefined && same(kids(at(s, 0)).map((k) => k.x), [0, 60]) && r.stats.approximated.flex?.samples[0] === margin.path);
  check("margin: auto pushing the last item to the end → no auto-layout", at(s, 1)?.layout === undefined && at(s, 1, 2)?.x === 360);
  check("an item off its cross-axis alignment (a top margin) → no auto-layout", at(s, 2)?.layout === undefined && at(s, 2, 1)?.y === 10 && r.stats.approximated.flex?.count === 3);
  check("padding, gap, justify center and align center that match the page → auto-layout kept", at(s, 3)?.layout?.justifyContent === "center" && at(s, 3, 0)?.x === undefined);
  check("a column aligned to the end that matches → auto-layout kept", at(s, 4)?.layout?.alignItems === "flex-end" && at(s, 4, 1)?.y === undefined);
  // flex-grow: Figma splits the free space equally between fillers, CSS by the grow factors
  const grower = (x: number, w: number, g: number): CapEl => el({ rect: { x, y: 300, w, h: 20 }, background: "rgb(9, 9, 9)", flexGrow: g });
  const unequal = el({ display: "flex", rect: { x: 0, y: 300, w: 300, h: 20 }, children: [grower(0, 100, 1), grower(100, 200, 2)] });
  const equal = el({ display: "flex", rect: { x: 0, y: 300, w: 300, h: 20 }, children: [grower(0, 150, 1), grower(150, 150, 1)] });
  const gd = docOf(page([unequal, equal]));
  const gr = captureSpec(gd);
  const gs = spec(gd, "flex-grow");
  check("flex: 1 beside flex: 2 (100 / 200 px) → no grow (Figma would split them equally): fixed at their measured sizes, approximated (flex-grow)",
    at(gs, 0)?.layout !== undefined && kids(at(gs, 0)).every((k) => k.grow === undefined) && same(kids(at(gs, 0)).map((k) => k.box?.w), [100, 200]) && gr.stats.approximated["flex-grow"]?.samples[0] === unequal.path);
  check("…growers of one size that use up the free space → grow 1 each", kids(at(gs, 1)).every((k) => k.grow === 1) && gr.stats.approximated["flex-grow"]?.count === 1);
  // baseline: an item's margin must not pass unseen
  const base = el({ display: "flex", rect: { x: 0, y: 400, w: 300, h: 40 }, alignItems: "baseline", children: [box(0, 400), box(40, 420)] });
  const baseOk = el({ display: "flex", rect: { x: 0, y: 500, w: 300, h: 20 }, alignItems: "baseline", children: [box(0, 500), box(40, 500)] });
  const bs = spec(docOf(page([base, baseOk])), "baseline");
  check("baseline items off the line's start (a 20 px top margin on equal-height items) → no auto-layout, children at x/y", at(bs, 0)?.layout === undefined && at(bs, 0, 1)?.y === 20);
  check("…baseline items at the line's start keep the row, baseline-aligned", at(bs, 1)?.layout?.alignItems === "baseline");
}
{
  // text: one line hugs; wrapped text is a fixed width; centred single line in a wide block keeps its width; mixed inline
  const one = textEl("Hello", { x: 10, y: 10, w: 300, h: 24 });
  if (one.text) one.text.rect = { x: 10, y: 13, w: 40, h: 18 };
  const wrapped = textEl("A long paragraph that wraps", { x: 10, y: 50, w: 120, h: 48 }, {}, {}, 2);
  const centred = textEl("Mid", { x: 10, y: 110, w: 300, h: 24 }, {}, { textAlign: "center" });
  if (centred.text) centred.text.rect = { x: 150, y: 113, w: 30, h: 18 };
  const mixed = textEl("Some bold words", { x: 10, y: 140, w: 300, h: 24 });
  if (mixed.text) mixed.text.mixed = true;
  const styled = textEl("Caps", { x: 10, y: 170, w: 40, h: 24 }, {}, { weight: 700, italic: true, size: 14, lineHeight: null, letterSpacing: 0.5, color: "rgba(0, 0, 255, 0.5)", textTransform: "uppercase", textDecoration: "underline", family: "Sample Sans" });
  const d = docOf(page([one, wrapped, centred, mixed, styled]));
  const s = spec(d, "text");
  const r = captureSpec(d);
  check("an element of inline text is one TEXT: a single line hugs its text (width_and_height), at its text's x and its line box's y",
    at(s, 0)?.text === "Hello" && at(s, 0)?.autoResize === "width_and_height" && at(s, 0)?.box?.w === 40 && at(s, 0)?.x === 10 && at(s, 0)?.y === 10);
  check("wrapped text → a fixed width and autoResize height", at(s, 1)?.autoResize === "height" && same(at(s, 1)?.box, { w: 120, h: 48 }));
  check("a centred line in a wide block keeps the block's width, aligned centre", at(s, 2)?.autoResize === "height" && at(s, 2)?.box?.w === 300 && at(s, 2)?.font?.align === "center");
  check("mixed inline styles are flattened and counted", r.stats.approximated["mixed-inline"]?.count === 1);
  check("the font: family, the weight's style name with italic, size, colour with its alpha, letter spacing, case, decoration; line-height normal is left out",
    same(at(s, 4)?.font, { family: "Sample Sans", weight: "Bold Italic", size: 14, color: "#0000ff80", letterSpacing: { unit: "px", value: 0.5 }, case: "upper", decoration: "underline" }));
  check("every family + style is listed once", same(r.stats.fonts, [{ family: "Inter", style: "Regular" }, { family: "Sample Sans", style: "Bold Italic" }]));
  // a run beside a block: a TEXT per run, its line box from its glyphs and line height
  const box = el({ rect: { x: 0, y: 300, w: 300, h: 72 }, children: [txt("before", { x: 0, y: 303, w: 50, h: 18 }), textEl("block", { x: 0, y: 324, w: 300, h: 24 }), txt("after", { x: 0, y: 351, w: 40, h: 18 })] });
  const s2 = spec(docOf(page([box])), "runs");
  check("text beside a block child → a TEXT per run, each at its line box", same(kids(at(s2, 0)).map((k) => [k.text, k.y]), [["before", 0], ["block", 24], ["after", 48]]));
}
{
  check("weights → Figma style names", same([100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) => fontStyleName(w, false)), ["Thin", "ExtraLight", "Light", "Regular", "Medium", "SemiBold", "Bold", "ExtraBold", "Black"]));
  check("italic → 'Italic' (400) or '<Weight> Italic'; an odd weight rounds", fontStyleName(400, true) === "Italic" && fontStyleName(600, true) === "SemiBold Italic" && fontStyleName(650, false) === "Bold");
  check("a face's PostScript name says its style (Sample-BoldMT, Sample-SemiBoldItalic, none)", same([faceStyle("Sample-BoldMT"), faceStyle("Sample-SemiBoldItalic"), faceStyle("Sample")], [{ weight: 700, italic: false }, { weight: 600, italic: true }, { weight: null, italic: false }]));
  check("the computed stack's first family that is not generic", firstFamily("\"Sample Sans\", system-ui, sans-serif") === "Sample Sans" && firstFamily("system-ui, sans-serif") === "system-ui");
  check("a CSS colour as hex; transparent is none", hexOf("rgb(255, 0, 0)") === "#ff0000" && hexOf("rgba(0, 0, 0, 0)") === null && hexOf("rgba(0, 0, 0, 0.5)") === "#00000080");
}
{
  // strokes, radius, clip, opacity
  const sides = el({ rect: { x: 0, y: 0, w: 100, h: 50 }, border: { widths: [0, 0, 1, 0], color: "rgb(200, 200, 200)", from: "border", align: "inside" } });
  const even = el({ rect: { x: 0, y: 60, w: 100, h: 50 }, border: { widths: [2, 2, 2, 2], color: "rgb(1, 1, 1)", from: "border", align: "inside" }, radius: [4, 4, 0, 0], clip: true, opacity: 0.5 });
  const ring = el({ rect: { x: 0, y: 120, w: 100, h: 50 }, border: { widths: [3, 3, 3, 3], color: "rgb(1, 1, 1)", from: "box-shadow", align: "outside" }, radius: 999, dropped: ["shadow", "gradient"] });
  const flexBorder = el({ display: "flex", rect: { x: 0, y: 180, w: 100, h: 50 }, border: { widths: [1, 1, 1, 1], color: "rgb(1, 1, 1)", from: "border", align: "inside" }, padding: [8, 8, 8, 8] });
  const d = docOf(page([sides, even, ring, flexBorder]));
  const s = spec(d, "strokes");
  const r = captureSpec(d);
  check("a border on one side → strokes inside with per-side weights", same(at(s, 0)?.strokes, { colors: ["#c8c8c8"], align: "inside", weights: { top: 0, right: 0, bottom: 1, left: 0 } }));
  check("an even border → one weight; unequal corners → radius corners; overflow hidden → clip; opacity", same(at(s, 1)?.strokes, { colors: ["#010101"], align: "inside", weight: 2 })
    && same(at(s, 1)?.radius, { tl: 4, tr: 4, br: 0, bl: 0 }) && at(s, 1)?.clip === true && at(s, 1)?.opacity === 0.5);
  check("a ring → the stroke the probe read (outside); a pill's radius is capped at half its height", same(at(s, 2)?.strokes, { colors: ["#010101"], align: "outside", weight: 3 }) && at(s, 2)?.radius === 25);
  check("an auto-layout frame with a border counts it in its layout (strokesInLayout), as CSS's border box does", at(s, 3)?.strokesInLayout === true);
  check("what cannot be written is counted under dropped, with sample paths", r.stats.dropped.shadow?.count === 1 && r.stats.dropped.gradient?.samples[0] === ring.path);
}
{
  // flattening and empty leaves
  const inner = el({ name: "inner", rect: { x: 0, y: 0, w: 100, h: 50 }, background: "rgb(1, 1, 1)" });
  const wrapper = el({ name: "wrapper", rect: { x: 0, y: 0, w: 100, h: 50 }, children: [inner] });
  const painted = el({ name: "painted", rect: { x: 0, y: 60, w: 100, h: 50 }, background: "rgb(2, 2, 2)", children: [el({ name: "kid", rect: { x: 0, y: 60, w: 100, h: 50 }, background: "rgb(3, 3, 3)" })] });
  const emptyBlock = el({ name: "empty", rect: { x: 0, y: 120, w: 10, h: 10 } });
  const spacer = el({ display: "flex", rect: { x: 0, y: 140, w: 100, h: 10 }, children: [el({ name: "spacer", rect: { x: 0, y: 140, w: 10, h: 10 }, flexGrow: 1 })] });
  const s = spec(docOf(page([wrapper, painted, emptyBlock, spacer])), "flatten");
  check("an unpainted wrapper with one child of its box collapses into it", at(s, 0)?.name === "inner" && kids(at(s, 0)).length === 0);
  check("a painted one stays a frame around its child", at(s, 1)?.name === "painted" && at(s, 1, 0)?.name === "kid");
  check("an empty unpainted leaf is left out of a block; in an auto-layout parent it is kept (it takes space)", kids(s).length === 3 && at(s, 2, 0)?.name === "spacer");
}
{
  // the node and depth caps
  const many = page(Array.from({ length: 600 }, (_, i) => el({ rect: { x: 0, y: i, w: 10, h: 1 }, background: "rgb(1, 1, 1)" })));
  const r = captureSpec(docOf(many));
  check(`over ${500} nodes → refused with the count, never truncated (${r.ok ? "converted" : r.error})`, !r.ok && /601 nodes, more than the 500/.test(r.error));
  let deep = el({ rect: { x: 0, y: 0, w: 10, h: 10 }, background: "rgb(1, 1, 1)" });
  for (let i = 0; i < 45; i++) deep = el({ rect: { x: 0, y: 0, w: 10 + i + 1, h: 10 + i + 1 }, background: "rgb(1, 1, 1)", children: [deep] });
  const d = captureSpec(docOf(page([deep])));
  check(`nested deeper than 40 levels → refused (${d.ok ? "converted" : d.error})`, !d.ok && /levels deep, more than the 40/.test(d.error));
}
{
  // images by file
  const file = "design/capture/images/" + IMG + ".png";
  const img = el({ tag: "img", name: "Photo", media: "img", rect: { x: 0, y: 0, w: 120, h: 80 }, radius: 8, image: { file, sha256: IMG, w: 60, h: 40, from: "source", scaleMode: "fill" } });
  const svg = el({ tag: "svg", media: "svg", rect: { x: 0, y: 100, w: 24, h: 24 }, background: "rgb(1, 1, 1)", border: { widths: [1, 1, 1, 1], color: "rgb(1, 1, 1)", from: "border", align: "inside" }, image: { file, sha256: IMG, w: 24, h: 24, from: "screenshot", scaleMode: "fill" } });
  const bg = el({ rect: { x: 0, y: 200, w: 100, h: 100 }, background: "rgb(255, 255, 255)", backgroundImage: { file, sha256: IMG, w: 10, h: 10, from: "source", scaleMode: "tile", scale: 1 } });
  const broken = el({ tag: "img", media: "img", rect: { x: 0, y: 320, w: 10, h: 10 } });
  const d = docOf(page([img, svg, bg, broken]));
  const s = spec(d, "images");
  const r = captureSpec(d);
  check("an <img> → a frame with an image paint by file and its fit", same(at(s, 0)?.fills, [{ type: "image", file, scaleMode: "fill" }]) && at(s, 0)?.radius === 8);
  check("a screenshot (an inline <svg>) carries its own paint: no solid fill or stroke on top of it", same(at(s, 1)?.fills, [{ type: "image", file, scaleMode: "fill" }]) && at(s, 1)?.strokes === undefined);
  check("a CSS background image → its colour, then the image on top (a tile with its scale)", same(at(s, 2)?.fills, [{ type: "solid", color: "#ffffff" }, { type: "image", file, scaleMode: "tile", scale: 1 }]));
  check("an image that could not be read is noted under dropped", r.stats.dropped.image?.count === 1 && r.stats.images === 3);
  check("the image paints pass the tree spec's check once the server has given them their id…", r.ok && checkCaptured(r.spec, () => IMG).length === 0);
  check("…and fail it without (the check is the real one)", r.ok && checkCaptured(r.spec, () => null).some((p) => /came without them/.test(p)));
}
{
  // the --root element: its own layout and paint
  const root = el({ display: "flex", flexDirection: "column", rect: { x: 40, y: 100, w: 300, h: 200 }, rowGap: 4, background: "rgb(9, 9, 9)", children: [el({ rect: { x: 40, y: 100, w: 300, h: 50 }, background: "rgb(1, 1, 1)" })] });
  const s = spec(docOf(root, { document: false, width: 1280 }), "--root");
  check("a --root element is the root: its box, its own fill and auto-layout", s.name === "t @1280" && same(s.box, { w: 300, h: 200 }) && same(s.fills, [{ type: "solid", color: "#090909" }]) && s.layout?.flexDirection === "column");
}
{
  // the committed fixture: what the converter makes of the fixture capture
  const doc = JSON.parse(fs.readFileSync(path.join(SAMPLE, "sample@1280.capture-doc.json"), "utf8")) as CaptureDoc;
  const r = captureSpec(doc);
  const specFile = path.join(SAMPLE, "sample@1280.json");
  if (RECORD && r.ok) { fs.writeFileSync(specFile, JSON.stringify(r.spec, null, 1) + "\n"); console.log(`recorded ${path.relative(ROOT, specFile)}`); }
  const committed: unknown = JSON.parse(fs.readFileSync(specFile, "utf8"));
  check("the committed fixture spec is what the converter makes of the fixture capture (if the change is meant: bun test/capture-page.test.ts --record)", r.ok && same(r.spec, committed));
  const files = fs.readdirSync(path.join(SAMPLE, "images"));
  const ids = new Map(files.map((f) => ["design/capture/images/" + f, sha256(fs.readFileSync(path.join(SAMPLE, "images", f)))]));
  check("…it passes the tree spec's check, every image it paints is committed and named by its bytes", r.ok && checkCaptured(r.spec, (f) => ids.get(f) ?? null).length === 0
    && [...ids].every(([f, id]) => f.includes(id)) && imagePaintsIn(r.spec, "tree").every((p) => typeof p.paint.file === "string" && ids.has(p.paint.file)));
}
{
  check("the files' slug comes from the URL's path, else its host", same(["http://127.0.0.1:5173/", "https://example.test/app/settings", "http://localhost:3000/index.html", "file:///tmp/site/about.html"].map(nameFromUrl), ["127-0-0-1", "app-settings", "localhost", "tmp-site-about"]));
}

// ---------------------------------------------------------------- instances and candidate components (#187)
console.log("\ninstances and candidate components:");
{
  // an element the component map names: an instance at its place (in a flex row: no x/y, its grow and stretch), its children not written
  const inst = (o: Partial<CapEl> & { rect: CapEl["rect"] }): CapEl => el({ ...o, instance: { component: "a1".repeat(20), props: { Size: "Large", Label: "Save" }, name: "Button" } });
  const row = el({ display: "flex", rect: { x: 0, y: 0, w: 400, h: 40 }, columnGap: 8, alignItems: "normal", children: [
    inst({ rect: { x: 0, y: 0, w: 196, h: 40 }, flexGrow: 1, children: [textEl("never written", { x: 0, y: 0, w: 60, h: 20 })] }),
    inst({ rect: { x: 204, y: 0, w: 196, h: 40 }, flexGrow: 1 }),
  ] });
  const r = captureSpec(docOf(page([row, inst({ rect: { x: 10, y: 100, w: 80, h: 30 }, opacity: 0.5 })])));
  const s = r.ok ? r.spec : {};
  const a = at(s, 0, 0), b = at(s, 1);
  check("an element the map names is an INSTANCE: the component (by key), its props, the component's name as the layer's, its box", same(a, { component: "a1".repeat(20), name: "Button", box: { w: 196, h: 40 }, props: { Size: "Large", Label: "Save" }, grow: 1, alignSelf: "stretch" }));
  check("…in a block parent at its x/y, its opacity kept; nothing inside it is written; counted", same({ x: b?.x, y: b?.y, o: b?.opacity, c: b?.children }, { x: 10, y: 100, o: 0.5, c: undefined }) && r.ok && r.stats.instances === 3);
  check("…and the spec passes the tree spec's check", r.ok && checkCaptured(r.spec, () => IMG).length === 0);
}
{
  // three cards: a painted, rounded frame with a title and a meta row of two texts; a fourth meta row stands alone
  const meta = (y: number, a: string, b: string): CapEl => el({ display: "flex", rect: { x: 16, y, w: 200, h: 20 }, columnGap: 8, border: { widths: [1, 0, 0, 0], color: "rgb(200, 200, 200)", from: "border", align: "inside" }, children: [
    textEl(a, { x: 16, y, w: 60, h: 20 }), textEl(b, { x: 84, y, w: 60, h: 20 }),
  ] });
  const card = (y: number, title: string, a: string): CapEl => el({ rect: { x: 0, y, w: 300, h: 80 }, background: "rgb(255, 255, 255)", radius: 8, children: [
    textEl(title, { x: 16, y: y + 8, w: 200, h: 24 }, {}, { size: 18, weight: 600 }), meta(y + 40, a, "today"),
  ] });
  const r = captureSpec(docOf(page([card(0, "First", "3 items"), card(100, "Second", "5 items"), card(200, "Third", "8 items"), meta(320, "Alone", "now")])));
  const cands = r.ok ? r.candidates : [];
  const [c1, c2] = cands;
  check(`the repeated card is a candidate: 3 times, 5 nodes, sample paths of the page (${JSON.stringify(cands.map((c) => [c.name, c.count, c.nodes]))})`, c1 !== undefined && c1.count === 3 && c1.nodes === 5 && c1.paths.length === 3 && c1.slug === "1-div");
  check("…the meta row inside every card is only offered because one stands outside them (4 times); a part only ever inside a bigger one is not", c2 !== undefined && c2.count === 4 && c2.nodes === 3 && cands.length === 2);
  const cs = c1?.spec ?? {};
  check("its spec: a COMPONENT root named after the page, a TEXT property per text that differs (default the first's), the layer wired; a text the same everywhere is not one",
    cs.type === "COMPONENT" && cs.name === "t div 1" && same(cs.props, { "Text 1": { type: "TEXT", default: "First" }, "Text 2": { type: "TEXT", default: "3 items" } }) &&
    same(at(cs, 0)?.propRefs, { characters: "Text 1" }) && same(at(cs, 1, 0)?.propRefs, { characters: "Text 2" }) && at(cs, 1, 1)?.propRefs === undefined && cs.x === undefined);
  const checked = checkTree(cs);
  check(`…and it passes the tree spec's check (${checked.problems.slice(0, 2).join("; ")})`, checked.problems.length === 0 && checked.summary.component?.props.length === 2);
  const instRow = el({ rect: { x: 0, y: 0, w: 400, h: 200 }, children: [0, 1].map((i) => el({ rect: { x: 0, y: i * 50, w: 100, h: 40 }, instance: { component: "Chip", props: {}, name: "Chip" } })) });
  const ri = captureSpec(docOf(page([instRow])));
  check("instances are never candidates themselves", ri.ok && ri.candidates.length === 0);
}

// ---------------------------------------------------------------- the CLI's parts
console.log("\nthe CLI's parts:");
{
  // the image cap is the batch's: every width's images, each counted once by its bytes
  const b = new ImageBudget(100);
  const got = [b.add("a", 60), b.add("a", 60), b.add("b", 30)];
  const over = b.add("c", 20);
  check("the image budget counts an image every width paints once (by sha), and refuses the one that takes the batch past the cap",
    same(got, [null, null, null]) && b.total === 90 && over !== null && /every width is one figma_write batch/.test(over) && b.add("b", 30) === null);
  // a screenshot that fails is dropped; the budget's refusal of one that was taken stops the capture
  const k: Kept = { bytes: Buffer.from([1]), ext: "png", sha: "s", w: 1, h: 1 };
  const failed = await keptShot(async () => { throw new Error("element detached"); }, () => k);
  const refused = await keptShot(async () => Buffer.from([1]), () => { throw new CaptureError("over the cap", 5); }).then(() => null, (e: unknown) => e);
  check("a screenshot that cannot be taken → null (noted dropped); the budget's CaptureError over one taken is not swallowed",
    failed === null && refused instanceof CaptureError && refused.exit === 5);
  // a screenshot that fails once the read's deadline has passed (a canvas that never holds still) is the timeout, not a drop
  const lateShot = await keptShot(async () => { throw new Error("Timeout 30000ms exceeded"); }, () => k, Date.now() - 1).then(() => null, (e: unknown) => e);
  const inTime = await keptShot(async () => { throw new Error("element detached"); }, () => k, Date.now() + 60_000);
  check("…a screenshot failing past the read's deadline → a CaptureError (exit 4), never an image quietly dropped; one failing in time is still dropped",
    lateShot instanceof CaptureError && lateShot.exit === 4 && /did not finish within --timeout/.test(lateShot.message) && inTime === null);
  // a wait on the page is bounded by the deadline
  const t0 = Date.now();
  const stalled = await within(new Promise<never>(() => {}), Date.now() + 50, "the page's fonts").then(() => null, (e: unknown) => e);
  check("a wait that never ends → a CaptureError (exit 4) at the deadline, naming it", stalled instanceof CaptureError && stalled.exit === 4 && /the page's fonts did not finish within --timeout/.test(stalled.message) && Date.now() - t0 < 2_000);
  check("…one that ends in time gives its value", (await within(Promise.resolve(7), Date.now() + 1_000, "x")) === 7);
  // containment on disk: realpaths, not the lexical path
  const proj = path.join(tmp, "contain");
  const away = path.join(tmp, "away");
  fs.mkdirSync(path.join(proj, "real", "images"), { recursive: true });
  fs.mkdirSync(away, { recursive: true });
  fs.symlinkSync(away, path.join(proj, "linked"), "dir");
  fs.symlinkSync(path.join(proj, "real"), path.join(proj, "inner"), "dir");
  check("an --out dir that is a symlink out of the project is refused", /leads out of --project/.test(outputEscape(proj, [path.join(proj, "linked"), path.join(proj, "linked", "images")], []) ?? ""));
  check("…so is one not made yet below such a link", /leads out of --project/.test(outputEscape(proj, [path.join(proj, "linked", "a", "b")], []) ?? ""));
  check("…a symlink that stays inside the project is fine, as is a plain new dir", outputEscape(proj, [path.join(proj, "inner"), path.join(proj, "new", "dir")], []) === null);
  fs.symlinkSync(path.join(away, "x.json"), path.join(proj, "real", "t@1280.json"));
  check("a file name that exists as a symlink is refused, even one pointing nowhere", /is a symbolic link/.test(outputEscape(proj, [], [path.join(proj, "real", "t@1280.json")]) ?? ""));
}

// ---------------------------------------------------------------- the CLI
async function cli(args: string[], cwd = tmp, timeoutMs = 120_000): Promise<ProcResult> {
  return await runAsync(process.execPath, ["--no-install", "--no-env-file", BUNDLE, ...args], { cwd, timeoutMs }).done;
}
console.log("\nthe CLI:");
const project = path.join(tmp, "project");
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, "package.json"), "{}\n");
// the project's Playwright: the repo's own (a junction on Windows needs no rights)
fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(project, "node_modules"), process.platform === "win32" ? "junction" : "dir");
const bare = path.join(tmp, "bare");
fs.mkdirSync(bare, { recursive: true });
{
  const help = await cli(["--help"]);
  check("--help: exit 0 with the usage", help.status === 0 && /--url <url>/.test(help.stdout) && /exit: 0 wrote/.test(help.stdout));
  const none = await cli([]);
  check("no arguments: exit 2 with the usage", none.status === 2 && /usage:/.test(none.stderr));
  const width = await cli(["--url", "http://127.0.0.1:9/", "--width", "1280,abc"]);
  check(`a bad --width: exit 2 (${width.stderr.split("\n")[0] ?? ""})`, width.status === 2 && /--width must be/.test(width.stderr));
  const out = await cli(["--url", "http://127.0.0.1:9/", "--project", project, "--out", "../elsewhere"]);
  check("an --out outside --project: exit 2 (the MCP server reads it from there)", out.status === 2 && /--out must be a directory inside --project/.test(out.stderr));
  // output that leads out of the project on disk: exit 2 before anything is captured or written
  const outside = path.join(tmp, "outside");
  fs.mkdirSync(outside, { recursive: true });
  const linkProj = path.join(tmp, "link-project");
  fs.mkdirSync(path.join(linkProj, "design", "capture"), { recursive: true });
  fs.symlinkSync(outside, path.join(linkProj, "out-link"), "dir");
  const viaOut = await cli(["--url", "http://127.0.0.1:9/", "--project", linkProj, "--out", "out-link", "--name", "t"]);
  check(`an --out that is a symlink out of --project: exit 2, nothing written (${viaOut.stderr.split("\n")[0] ?? ""})`, viaOut.status === 2 && /leads out of --project/.test(viaOut.stderr) && fs.readdirSync(outside).length === 0);
  fs.symlinkSync(outside, path.join(linkProj, "design", "capture", "images"), "dir");
  const viaImages = await cli(["--url", "http://127.0.0.1:9/", "--project", linkProj, "--name", "t"]);
  check(`an images/ dir that is a symlink out of --project: exit 2, nothing written (${viaImages.stderr.split("\n")[0] ?? ""})`, viaImages.status === 2 && /images leads out of --project/.test(viaImages.stderr) && fs.readdirSync(outside).length === 0);
  fs.mkdirSync(path.join(linkProj, "spec-out"), { recursive: true });
  fs.writeFileSync(path.join(outside, "victim.json"), "keep\n");
  fs.symlinkSync(path.join(outside, "victim.json"), path.join(linkProj, "spec-out", "t@1280.json"));
  const viaSpec = await cli(["--url", "http://127.0.0.1:9/", "--project", linkProj, "--out", "spec-out", "--name", "t"]);
  check(`a symlink where a spec file goes: exit 2, never written through (${viaSpec.stderr.split("\n")[0] ?? ""})`, viaSpec.status === 2 && /t@1280\.json is a symbolic link/.test(viaSpec.stderr) && fs.readFileSync(path.join(outside, "victim.json"), "utf8") === "keep\n");
  const noPw = await cli(["--check", "--project", bare]);
  check(`--check in a project without Playwright: exit 3, nothing installed (${noPw.stderr.split("\n")[0] ?? ""})`, noPw.status === 3 && /renderer unavailable/.test(noPw.stderr) && /never installs a package/.test(noPw.stderr));
}

// ---------------------------------------------------------------- end to end
const png = (w: number, h: number): Buffer => {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = 200; data[i + 1] = ((i / 4) % w) * 4; data[i + 2] = 120; data[i + 3] = 255; }
  return encodePng({ w, h, data });
};
const photo = png(60, 40);
const manyHtml = "<!doctype html><body>" + Array.from({ length: 600 }, (_, i) => `<div style="height:2px;background:#${(i % 9) + 1}${(i % 9) + 1}${(i % 9) + 1}"></div>`).join("") + "</body>";
// a font that starts loading after the load event and never arrives: document.fonts.ready never settles
const stallHtml = "<!doctype html><body style=\"font-family: Stalled, sans-serif\">Waiting<script>addEventListener('load', () => { const f = new FontFace('Stalled', 'url(/stall.woff2)'); document.fonts.add(f); f.load().catch(() => {}); });</script></body>";
// two boxes of one size and background (an SVG, which Figma does not take: a screenshot), one with its own text
const BG_SVG = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10'%3E%3Crect width='10' height='10' fill='%234f46e5'/%3E%3C/svg%3E";
const bgTextHtml = `<!doctype html><style>body { margin: 0; } .bg { width: 120px; height: 40px; margin: 0 0 20px; background: url("${BG_SVG}") 0 0 / 100% 100% no-repeat; font: 16px/40px Arial, sans-serif; color: #ffffff; text-shadow: 0 1px 0 #000000; }</style><body><div id="a" class="bg">Label</div><div id="b" class="bg"></div></body>`;
const hideHtml = `<!doctype html><body><div id="x" style="color: rgb(1, 2, 3) !important; border: 2px solid; text-shadow: none">own text<span style="visibility: visible">kid</span><b>bold <i style="visibility: visible">deep</i></b><x-host id="host"></x-host></div>` +
  // an open shadow root's element that says visibility: visible itself (querySelectorAll does not reach it)
  `<script>document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = '<em style="visibility: visible; color: red">shadow</em>';</script>` +
  // a run of adjacent inline elements beside a block: its characters as the page has them, no space made up between them
  `<section id="run"><span>$</span><span>100</span>, <b>net</b><br>more<div>Details</div></section>` +
  // …and only what is drawn: a hidden span, one at opacity 0, one at display none — but a visible child of a hidden span shows
  `<section id="hid"><span>Shown</span><span style="visibility:hidden">Hidden<i style="visibility:visible">Back</i></span><span style="opacity:0">Faded</span><span style="display:none">Gone</span><div>Details</div></section>` +
  // the same rule for an element of inline content only (one TEXT): its drawn characters, its <br> a line break
  `<section id="inl"><p>Shown<span style="visibility:hidden">Hidden<span style="visibility:visible">Back</span></span><span style="opacity:0">Faded</span><br>Next</p><div>Details</div></section></body>`;
// code components (#187): by data-component (with data-props), and by a React dev build's fibers (made by hand here: a
// forwardRef "Badge" around a function component "Inner", both first-host-wrapping the element; a lone "Widget")
const identityHtml = `<!doctype html><body><section id="ids">` +
  `<div id="dc" data-component="Button" data-props='{"variant":"primary","disabled":true,"size":2,"onClick":{"x":1}}'><span>Save</span></div>` +
  `<div id="dcm" data-component="@/ui/card#Card"><p>Inside</p></div>` +
  `<div id="un" data-component="Unknown"><p>Kept</p></div>` +
  `<div id="fib"><span>Fiber text</span></div><div id="fib2"><p>Plain</p></div></section>` +
  `<script>
    function Inner() {} function Outer() {} Outer.displayName = "Badge"; function Widget() {}
    const fiberOf = (el) => ({ tag: 5, stateNode: el });
    const host = fiberOf(document.getElementById("fib"));
    const inner = { tag: 0, type: Inner, memoizedProps: { tone: "info", count: 3, children: "Fiber text", onClick() {} }, child: host };
    const outer = { tag: 11, type: { render: Outer }, memoizedProps: { tone: "warn", children: { nested: true } }, child: inner };
    const section = { tag: 5, child: outer };
    host.return = inner; inner.return = outer; outer.return = section;
    document.getElementById("fib")["__reactFiber$test"] = host;
    const host2 = fiberOf(document.getElementById("fib2"));
    const widget = { tag: 15, type: Widget, memoizedProps: {}, child: host2, return: { tag: 5 } };
    host2.return = widget;
    document.getElementById("fib2")["__reactFiber$test"] = host2;
  </script></body>`;
// a lazy image far down the page whose response sends its headers and part of a body, then never ends
const stallImgHtml = `<!doctype html><body style="margin:0"><div style="height:3000px">Top</div><img loading="lazy" width="40" height="40" src="/stall-img.png"></body>`;
const server = Bun.serve({
  // idleTimeout 0: Bun otherwise ends a quiet response after 10 s, so stall-img.png's body would end before a slow
  // runner reaches the read's --timeout (load and read each get their own)
  hostname: "127.0.0.1", port: 0, idleTimeout: 0,
  fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === "/photo.png") return new Response(photo, { headers: { "content-type": "image/png" } });
    if (p === "/many.html") return new Response(manyHtml, { headers: { "content-type": "text/html" } });
    if (p === "/stall.html") return new Response(stallHtml, { headers: { "content-type": "text/html" } });
    if (p === "/stall.woff2") return new Promise<Response>(() => {});
    if (p === "/stall-img.html") return new Response(stallImgHtml, { headers: { "content-type": "text/html" } });
    if (p === "/stall-img.png") return new Response(new ReadableStream({ start(c) { c.enqueue(photo.subarray(0, 16)); } }), { headers: { "content-type": "image/png" } });
    if (p === "/bg-text.html") return new Response(bgTextHtml, { headers: { "content-type": "text/html" } });
    if (p === "/hide.html") return new Response(hideHtml, { headers: { "content-type": "text/html" } });
    if (p === "/identity.html") return new Response(identityHtml, { headers: { "content-type": "text/html" } });
    const f = path.join(FIX, p === "/" ? "page.html" : p.slice(1));
    if (!f.startsWith(FIX) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return new Response("not found", { status: 404 });
    return new Response(fs.readFileSync(f), { headers: { "content-type": f.endsWith(".svg") ? "image/svg+xml" : "text/html; charset=utf-8" } });
  },
});
const base = `http://127.0.0.1:${server.port}`;

interface Report { fonts: Array<{ family: string; style: string }>; widths: Array<{ width: number; spec: string; nodes: number; texts: number; images: number; approximated: Record<string, { count: number }> }>; images: string[]; ops: Array<{ op: string; treeFile: string }> }
const readJson = (f: string): unknown => { const v: unknown = JSON.parse(fs.readFileSync(f, "utf8")); return v; };
const walk = (n: TreeNodeSpec): TreeNodeSpec[] => [n, ...kids(n).flatMap(walk)];

async function e2e(): Promise<void> {
  console.log("\nend to end (chromium):");
  const probe = await cli(["--check", "--project", project]);
  if (probe.status !== 0) {
    const why = (probe.stderr.split("\n")[0] ?? "").slice(0, 200);
    if (!CI) { console.log(`SKIPPED (no playwright: ${why})`); return; }
    check(`chromium is usable for the capture (CI must run this): ${why}`, false);
    return;
  }
  check("--check: Playwright and chromium are usable", /^ok {2}playwright/.test(probe.stdout));
  const run = await cli(["--url", base + "/", "--width", "1280,390", "--name", "sample", "--project", project], project);
  check(`two widths: exit 0 (${run.stderr.slice(0, 300).replace(/\n/g, " ")})`, run.status === 0);
  const lines = run.stdout.trim().split("\n");
  check(`stdout is one summary line, then the ops (${lines[0] ?? ""})`, lines.length === 2 && /^capture-page: sample — 1280: \d+ nodes .* · 390: \d+ nodes/.test(lines[0] ?? ""));
  const ops = (() => { try { return (JSON.parse(lines[1] ?? "") as { ops: Report["ops"] }).ops; } catch { return []; } })();
  check("…the ops: one createTree per width, by treeFile, bound to the file's variables and styles, in one batch", same(ops, [{ op: "createTree", treeFile: "design/capture/sample@1280.json", bind: true }, { op: "createTree", treeFile: "design/capture/sample@390.json", bind: true }]));
  const rep = readJson(path.join(project, "design", "capture", "sample.capture.json")) as Report;
  const specs = ops.map((o) => readJson(path.join(project, o.treeFile)) as TreeNodeSpec);
  const imgs = fs.readdirSync(path.join(project, "design", "capture", "images"));
  const ids = new Map(imgs.map((f) => ["design/capture/images/" + f, sha256(fs.readFileSync(path.join(project, "design", "capture", "images", f)))]));
  check("every image on disk is named by its bytes and is a PNG, JPEG or GIF", imgs.length > 0 && [...ids].every(([f, id]) => f.includes(id)) && imgs.every((f) => !("error" in sniffImage(fs.readFileSync(path.join(project, "design", "capture", "images", f))))));
  check("both specs pass the tree spec's check, every image they paint on disk", specs.length === 2 && specs.every((s) => checkCaptured(s, (f) => ids.get(f) ?? null).length === 0));
  check("the page's PNG is saved as the page loaded it (same bytes)", [...ids.values()].includes(sha256(photo)));
  const fills = (s: TreeNodeSpec): string[] => walk(s).flatMap((n) => (n.fills ?? []).flatMap((p) => (p.type === "image" && p.file ? [p.file] : [])));
  check("the SVG <img> and the inline <svg> are PNG screenshots of their element", fills(specs[0] ?? {}).filter((f) => ids.get(f) !== sha256(photo)).length >= 2);
  check("the report: per width the node count, texts and images of its spec; the ops; every font up front",
    rep.widths.length === 2 && rep.widths.every((w, i) => w.nodes === countNodes(specs[i] ?? {}) && w.texts === walk(specs[i] ?? {}).filter((n) => n.text !== undefined).length) && same(rep.ops, ops) && rep.fonts.length > 0 && rep.fonts.every((f) => f.family !== "" && f.style !== ""));
  const [wide, narrow] = specs;
  if (!wide || !narrow) return;
  check("the roots: '<name> @<width>', keyed, the width wide", wide.name === "sample @1280" && wide.key === "capture:sample@1280" && wide.box?.w === 1280 && narrow.box?.w === 390);
  const named = (s: TreeNodeSpec, n: string): TreeNodeSpec | undefined => walk(s).find((x) => x.name === n);
  const header = named(wide, "header");
  check("flex → auto-layout: the header is a row, space-between, centred", header?.layout?.flexDirection === "row" && header.layout.justifyContent === "space-between" && header.layout.alignItems === "center");
  const section = (s: TreeNodeSpec): TreeNodeSpec | undefined => named(s, "section");
  check("grid → auto-layout: three columns at 1280 are a row of three cards, one column at 390 a column", section(wide)?.layout?.flexDirection === "row" && kids(section(wide)).length === 3 && section(narrow)?.layout?.flexDirection === "column");
  const texts = walk(wide).flatMap((n) => (n.text !== undefined ? [n.text] : []));
  check("text is real text, in the page's order; row-reverse reverses the chips; a run beside a block is its own text",
    texts.includes("Welcome back") && texts.indexOf("Third") < texts.indexOf("First") && texts.includes("Plain text beside a block") && texts.includes("and a tail.") && !texts.includes("Not shown"));
  const h1 = walk(wide).find((n) => n.text === "Welcome back");
  check(`the heading's font: rendered family, Bold, 28 px (${JSON.stringify(h1?.font)})`, !!h1?.font?.family && h1.font.weight === "Bold" && h1.font.size === 28);
  check("inline styles flattened are counted", (rep.widths[0]?.approximated["mixed-inline"]?.count ?? 0) >= 1);
  const badge = walk(wide).find((n) => n.name === "span" && n.box?.w === 24 && n.x !== undefined);
  check("an absolutely placed badge keeps its x/y in its block parent", badge !== undefined);

  const part = await cli(["--url", base + "/", "--root", ".cards", "--name", "cards", "--project", project], project);
  const cards = part.status === 0 ? readJson(path.join(project, "design", "capture", "cards@1280.json")) as TreeNodeSpec : null;
  check(`--root captures one element: its box and its own auto-layout (${part.stderr.slice(0, 200)})`, cards !== null && cards.layout?.flexDirection === "row" && kids(cards).length === 3 && cards.box?.w === 1232);
  const many = await cli(["--url", base + "/many.html", "--name", "many", "--project", project], project);
  check(`a page over 500 nodes: exit 5 with the count and the --root hint, nothing written (${many.stderr.slice(0, 160).replace(/\n/g, " ")})`, many.status === 5 && /more than the 500/.test(many.stderr) && /--root/.test(many.stderr) && !fs.existsSync(path.join(project, "design", "capture", "many.capture.json")));
  const late = await cli(["--url", base + "/", "--ready", "#never", "--timeout", "1500", "--name", "late", "--project", project], project);
  check(`a --ready that never shows: exit 4, nothing written (${late.stderr.slice(0, 160).replace(/\n/g, " ")})`, late.status === 4 && /--ready #never/.test(late.stderr) && !fs.existsSync(path.join(project, "design", "capture", "late@1280.json")));

  const t0 = Date.now();
  const stall = await cli(["--url", base + "/stall.html", "--timeout", "2000", "--name", "stall", "--project", project], project, 60_000);
  check(`fonts that never finish loading: exit 4 at --timeout, not a hang, nothing written (${stall.stderr.slice(0, 160).replace(/\n/g, " ")})`,
    stall.status === 4 && /fonts .*did not finish within --timeout/.test(stall.stderr) && Date.now() - t0 < 30_000 && !fs.existsSync(path.join(project, "design", "capture", "stall@1280.json")));

  const t1 = Date.now();
  const stallImg = await cli(["--url", base + "/stall-img.html", "--timeout", "6000", "--name", "stall-img", "--project", project], project, 90_000);
  check(`a lazy image whose body never ends: exit 4 at --timeout, not a hang, nothing written (${stallImg.stderr.slice(0, 160).replace(/\n/g, " ")})`,
    stallImg.status === 4 && /reading the image .*stall-img\.png did not finish within --timeout/.test(stallImg.stderr) && Date.now() - t1 < 45_000 && !fs.existsSync(path.join(project, "design", "capture", "stall-img@1280.json")));

  const bgText = await cli(["--url", base + "/bg-text.html", "--name", "bg-text", "--project", project], project);
  const bgSpec = bgText.status === 0 ? readJson(path.join(project, "design", "capture", "bg-text@1280.json")) as TreeNodeSpec : {};
  const bgFile = (n: string): string | undefined => { const p = named(bgSpec, n)?.fills?.find((x) => x.type === "image"); return p && p.type === "image" ? p.file : undefined; };
  check(`a background screenshot of an element with its own text leaves the text out of the picture (it is a TEXT layer): the same picture as the empty box (${bgText.stderr.slice(0, 160)})`,
    bgText.status === 0 && bgFile("div#a") !== undefined && bgFile("div#a") === bgFile("div#b") && walk(bgSpec).some((n) => n.text === "Label"));

  await hideRestores();
  await identityWalk();
  await land(ops, rep);
}

/** hideChildren in a real page: during the screenshot no glyph paint and no child shows, the element's own border keeps
 *  its colour; after it every inline style is as it was. */
async function hideRestores(): Promise<void> {
  const pw = await import("playwright").catch(() => null);
  const browser = pw ? await pw.chromium.launch().catch(() => null) : null;
  if (!browser) { check("chromium for the hideChildren check", !CI); return; }
  try {
    const pg = await browser.newPage();
    await pg.addInitScript({ content: INIT_SCRIPT });
    await pg.goto(base + "/hide.html");
    const xPath = String(await pg.evaluate("window.__dt.paths()(document.getElementById('x'))"));
    const styles = "[...document.querySelectorAll('#x, #x *')].map((e) => e.getAttribute('style'))";
    const look = "(() => { const x = getComputedStyle(document.getElementById('x')); return [x.color, x.webkitTextFillColor, x.borderTopColor, getComputedStyle(document.querySelector('#x span')).visibility, getComputedStyle(document.querySelector('#x b')).visibility, getComputedStyle(document.querySelector('#x i')).visibility, getComputedStyle(document.getElementById('host').shadowRoot.querySelector('em')).visibility, document.getElementById('host').shadowRoot.querySelector('em').getAttribute('style')]; })()";
    const before = await pg.evaluate(styles);
    const lookBefore = await pg.evaluate(look);
    await pg.evaluate(hideChildren, { path: xPath, hide: true });
    const during = await pg.evaluate(look);
    await pg.evaluate(hideChildren, { path: xPath, hide: false });
    const after = await pg.evaluate(styles);
    check(`hidden for the screenshot: the text's paint transparent, every descendant hidden (a nested visibility: visible too), a currentColor border kept (${JSON.stringify(during)})`,
      Array.isArray(during) && Array.isArray(lookBefore) && during[0] === "rgba(0, 0, 0, 0)" && during[1] === "rgba(0, 0, 0, 0)" && during[2] === lookBefore[2] && during[3] === "hidden" && during[4] === "hidden" && during[5] === "hidden" && during[6] === "hidden");
    check(`…and after it every inline style is back as it was, !important included (${JSON.stringify(after)})`, same(after, before) && same(await pg.evaluate(look), lookBefore));
    // the walk's run beside a block keeps the page's characters
    const walked = await pg.evaluate(walkCapture, { root: "#run", maxElements: 100 });
    const runs = walked.root ? walked.root.children.flatMap((c) => (c.kind === "run" ? [c.text] : [])) : [];
    check(`a run of adjacent inline elements reads as the page has it: no space made up at an element's edge, a <br> a space (${JSON.stringify(runs)})`,
      same(runs, ["$100, net more"]));
    const hid = await pg.evaluate(walkCapture, { root: "#hid", maxElements: 100 });
    const hidRuns = hid.root ? hid.root.children.flatMap((c) => (c.kind === "run" ? [c.text] : [])) : [];
    check(`…only its drawn characters: none of a hidden, faded (opacity 0) or display: none span, a visible child of a hidden one kept (${JSON.stringify(hidRuns)})`,
      same(hidRuns, ["ShownBack"]));
    const inl = await pg.evaluate(walkCapture, { root: "#inl", maxElements: 100 });
    const para = inl.root ? inl.root.children.find((c) => c.kind === "el") : undefined;
    const inlText = para && para.kind === "el" && para.text ? para.text.drawn : undefined;
    check(`…and an element of inline content only (one TEXT) carries its drawn characters, a <br> a line break (${JSON.stringify(inlText)})`, inlText === "ShownBack\nNext");
  } finally {
    await browser.close();
  }
}

/** The walker's code components in a real page: data-component with data-props, and a React dev build's fibers (outermost
 *  composite first); an element the map names is not walked into; one it does not name is walked and says its name. */
async function identityWalk(): Promise<void> {
  const pw = await import("playwright").catch(() => null);
  const browser = pw ? await pw.chromium.launch().catch(() => null) : null;
  if (!browser) { check("chromium for the code-component walk", !CI); return; }
  try {
    const pg = await browser.newPage();
    await pg.addInitScript({ content: INIT_SCRIPT });
    await pg.goto(base + "/identity.html");
    const walked = await pg.evaluate(walkCapture, { root: "#ids", maxElements: 100, identity: true, components: ["Button", "@/ui/card#Card", "Badge", "Inner"] });
    const els = walked.root ? walked.root.children.flatMap((c) => (c.kind === "el" ? [c] : [])) : [];
    const [dc, dcm, un, fib, fib2] = els;
    check(`data-component + data-props: the component, its string/number/boolean props, its text; nothing inside walked (${JSON.stringify(dc?.component)})`,
      same(dc?.component, { name: "Button", props: { variant: "primary", disabled: true, size: 2 }, text: "Save" }) && dc?.children.length === 0 && dc.text === null);
    check("…a module#Export name matches as given", dcm?.component?.name === "@/ui/card#Card" && dcm.children.length === 0);
    check("…a name the map does not have: walked as before, its name kept (namedUnmapped)", un?.component === undefined && un?.codeName === "Unknown" && (un?.children.length ?? 0) > 0);
    check(`React fibers: the outermost composite whose first host is the element wins (a forwardRef's render name), a children object left out (${JSON.stringify(fib?.component)})`,
      same(fib?.component, { name: "Badge", props: { tone: "warn" }, text: "Fiber text" }));
    check("…a composite the map does not name is the element's codeName", fib2?.component === undefined && fib2?.codeName === "Widget");
    const off = await pg.evaluate(walkCapture, { root: "#ids", maxElements: 100 });
    check("without identity nothing is read (no component, no codeName)", off.root !== null && off.root.children.every((c) => c.kind !== "el" || (c.component === undefined && c.codeName === undefined)));
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------- landing it: figma_write by treeFile
interface Reply { text: string; isError: boolean }
function replyText(r: unknown): Reply {
  const content: unknown = typeof r === "object" && r !== null && "content" in r ? r.content : undefined;
  const parts = isUnknownArray(content) ? content : [];
  const text = parts.map((c) => (typeof c === "object" && c !== null && "text" in c && typeof c.text === "string" ? c.text : "")).join("\n");
  return { text, isError: typeof r === "object" && r !== null && "isError" in r && r.isError === true };
}
const TOKEN = "capture-page-token";
async function land(ops: Report["ops"], rep: Report): Promise<void> {
  console.log("\nlanding the capture (figma_write, treeFile, fake plugin):");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const k of ["FIGMA_DAEMON_IDLE_MIN", "FIGMA_EXPORT_DIR", "FIGMA_BRIDGE_TOKEN_FILE", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR"]) delete env[k];
  Object.assign(env, { HOME: tmp, USERPROFILE: tmp, APPDATA: path.join(tmp, "AppData"), TMPDIR: tmp, TEMP: tmp, TMP: tmp, FIGMA_BRIDGE_PORT: "8789", FIGMA_BRIDGE_TOKEN: TOKEN, MAX_MCP_OUTPUT_TOKENS: "", DT_TEST_EPHEMERAL_PORT: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, "bridge", "src", "figma-mcp.ts")], env, cwd: project, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (d: Buffer) => { stderr += String(d); });
  const client = new Client({ name: "capture-page", version: "0.0.0" });
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
    const dry = await call({ dryRun: true, ops });
    check(`the dry run reads both specs and their images from disk (${dry.text.slice(0, 160)}…)`, !dry.isError && /creates frame 'sample @1280'/.test(dry.text) && /creates frame 'sample @390'/.test(dry.text) && /\.png: PNG/.test(dry.text));

    let w = await treeWorld();
    const plugin = fakePlugin(port, {
      token: TOKEN, hello: { instanceId: "fig-cap", file: "Sample App", page: "Page 1" },
      on: {
        whoami: (): WhoamiReply => ({ instanceId: "fig-cap", startedAt: 0, uptimeMs: 1, file: "Sample App", page: "Page 1", pageId: "", editorType: "figma", pluginVersion: "0.0.0", fileKey: null, fileKeyAvailable: false, editsAllowed: true }),
        write: async (a): Promise<WriteResult> => await w.api.applyWrites(a.ops.map((o) => ({ ...o })), a.images),
      },
    });
    await plugin.opened;
    await w.allowEdits();
    // the fake file has Inter and Roboto only: a font the capture used that it lacks refuses the whole batch, named
    const known = new Set(["Inter|Regular", "Inter|Bold", "Inter|Semi Bold", "Roboto|Regular"]);
    const missing = rep.fonts.filter((f) => !known.has(f.family + "|" + f.style));
    if (missing.length) {
      const refused = await call({ ops });
      const first = missing[0];
      check(`a font the file lacks refuses the whole batch, naming it with the closest the file has — never swapped (${refused.text.slice(0, 200).replace(/\n/g, " ")})`,
        refused.isError && first !== undefined && refused.text.includes(`font '${first.family} ${first.style}' is not available in this file`) && w.alive().length === 0);
    }
    // a file that has the capture's fonts
    w = await treeWorld({ fonts: rep.fonts.map((f) => [f.family, f.style] as const) });
    await w.allowEdits();
    const real = await call({ ops });
    const reply = (() => { try { return JSON.parse(real.text) as WriteResult; } catch { return null; } })();
    check(`the write lands both screens, all or nothing (${real.text.slice(0, 200)})`, !real.isError && reply !== null && reply.ok && reply.applied.length === 2);
    const roots = w.alive().filter((n: FakeNode) => n.type === "FRAME" && typeof n.name === "string" && n.name.startsWith("sample @"));
    const num = (n: FakeNode | undefined, k: string): number => { const v = n?.[k]; return typeof v === "number" ? v : NaN; };
    const [a, b] = roots;
    check("…two roots on the page, side by side without overlap", roots.length === 2 && num(b, "x") >= num(a, "x") + num(a, "width"));
    const made = w.alive();
    const imagePaints = made.filter((n) => Array.isArray(n.fills) && n.fills.some((p: unknown) => typeof p === "object" && p !== null && "type" in p && p.type === "IMAGE")).length;
    check("…its texts and its pictures are in the file", made.filter((n) => n.type === "TEXT").length === rep.widths.reduce((s, x) => s + x.texts, 0) && imagePaints === rep.widths.reduce((s, x) => s + x.images, 0));
    const again = await call({ ops });
    check(`sending the same files again updates the two screens in place (${again.text.slice(0, 160)})`, !again.isError && w.alive().filter((n: FakeNode) => n.type === "FRAME" && typeof n.name === "string" && n.name.startsWith("sample @")).length === 2);
    plugin.close();
  } finally {
    await client.close().catch(() => {});
  }
}

void (async () => {
  try {
    await e2e();
  } catch (e) {
    check(`the end-to-end half ran to the end (${e instanceof Error ? e.stack ?? e.message : String(e)})`, false);
  } finally {
    void server.stop(true);
    // the link to the repo's node_modules goes first, so removing the temp dir can never reach through it
    fs.unlinkSync(path.join(project, "node_modules"));
    fs.rmSync(tmp, { recursive: true, force: true });
    report();
  }
})();
