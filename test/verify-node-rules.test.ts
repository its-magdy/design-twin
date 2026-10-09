// per-node-type rules and match confidence. Expectations come from the real `buildExpectation`
// over plugin-shaped screen exports (test/fixtures.ts, invented names): lowercase autoResize ("width_and_height" /
// "height"), widthMode "hug"/"fill", renderBox (ink) beside box, strokes {colors, weight, align}, clip,
// mainComponent {key, setName}, instance-sublayer ids "I<instance>;<child>". Measurements are the probe's shape.
// Run with:  node test/verify-node-rules.test.ts
import { buildExpectation, compare, reportToMarkdown } from "../design-to-code/verify-screen.ts";
import { TOLERANCE } from "../design-to-code/verify-shared.ts";
import type { ExpectInput, ExpectOptions } from "../design-to-code/verify-screen.ts";
import type { IndexRow, JsonValue, MeasuredNode, MeasuredStyles, PlanWaiver, ScreenDoc, VerifyDelta, VerifyMeasured, VerifyReport, VerifyReportV2, VerifySpec } from "../design-to-code/types.ts";
import { readableMeasured } from "../design-to-code/doc-guards.ts";
import { screenExport } from "./fixtures.ts";
import type { NodeInput } from "./fixtures.ts";
import { check, report } from "./assert.ts";

const safe = (name: string, fn: () => boolean): boolean => { let r = false; try { r = fn(); } catch (e) { console.log(`    (threw: ${e instanceof Error ? e.message : String(e)})`); } return check(name, r); };

const FRAME = (children: NodeInput[], extra: Partial<NodeInput> = {}): NodeInput => ({ type: "FRAME", id: "1:1", name: "Orders", box: { x: 100, y: 50, w: 1280, h: 800 }, fills: [{ type: "solid", color: "#ffffff" }], children, ...extra });
const doc = (children: NodeInput[], sourceFile = "Sample Kit", extra: Partial<NodeInput> = {}): ExpectInput => ({ doc: screenExport([FRAME(children, extra)], { exportedAt: "2026-10-01T00:00:00Z", screen: "Orders", sourceFile }), label: "Orders" });
const expect1 = (children: NodeInput[], opts?: ExpectOptions) => buildExpectation([doc(children)], opts);
const measured = (nodes: MeasuredNode[], extra?: Partial<VerifyMeasured>): VerifyMeasured => ({ measuredAt: "2026-10-01T01:00:00Z", renderer: "playwright-chromium", viewport: "1280x800", nodes, ...extra });
const node = (nodeId: string, styles: MeasuredStyles, matchedBy = "tag"): MeasuredNode => ({ nodeId, styles, matchedBy });
const spec = (e: { nodes: VerifySpec[] }, id: string): VerifySpec | undefined => e.nodes.find((n) => n.nodeId === id);
const deltaOn = (r: VerifyReportV2, id: string, field: RegExp): VerifyDelta | undefined => r.deltas.find((d) => d.nodeId === id && field.test(d.field));
const gapOn = (r: VerifyReportV2, id: string, field: RegExp) => r.fieldsNotMeasured.find((g) => g.nodeId === id && field.test(g.field));
const ncOn = (e: { notComparable: Array<{ nodeId: string; field: string; value: JsonValue; why: string }> }, id: string, field: RegExp) => e.notComparable.find((n) => n.nodeId === id && field.test(n.field));
const TXT = { family: "Inter", size: 14, color: "#333333", align: "left" as const };

// ---------------------------------------------------------------- A. TEXT width
console.log("A — TEXT width is the ink width, x/width only from textBox:");
{
  const e = expect1([
    // a fixed-width header cell text: 121px box around the word "Date" (ink 32.14)
    { type: "TEXT", id: "2:1", name: "Date", text: "Date", font: TXT, autoResize: "height", box: { w: 121, h: 20 }, renderBox: { x: 116.62, y: 74, w: 32.14, h: 11 } },
    // hug text: its box IS the text
    { type: "TEXT", id: "2:2", name: "Total", text: "Total", font: TXT, autoResize: "width_and_height", box: { w: 34, h: 20 }, renderBox: { x: 300.6, y: 74, w: 32.9, h: 11 } },
    // fill-width text in a row
    { type: "TEXT", id: "2:3", name: "Showing", text: "Showing 1 to 20", font: TXT, autoResize: "height", widthMode: "fill", box: { w: 895.62, h: 20 }, renderBox: { x: 0, y: 0, w: 207.4, h: 11 } },
    // truncation set, the design really truncates: ink reaches the box edge
    { type: "TEXT", id: "2:4", name: "Long", text: "A very long role name", font: TXT, autoResize: "height", truncate: true, maxLines: 1, box: { w: 197, h: 20 }, renderBox: { x: 0, y: 0, w: 195.5, h: 11 } },
    // truncation set, but "12" fits easily in its 121px cell: not truncated, its ink is its full width
    { type: "TEXT", id: "2:5", name: "Count", text: "12", font: TXT, autoResize: "height", truncate: true, maxLines: 1, box: { w: 121, h: 20 }, renderBox: { x: 0, y: 0, w: 9.77, h: 11 } },
    // left-aligned absolute text with a stated box and a centred one
    { type: "TEXT", id: "2:6", name: "Left", text: "Left", font: TXT, autoResize: "height", box: { x: 436, y: 70, w: 100, h: 20 }, renderBox: { x: 436.9, y: 74, w: 25, h: 11 } },
    { type: "TEXT", id: "2:7", name: "Centre", text: "Centre", font: { ...TXT, align: "center" }, autoResize: "height", box: { x: 436, y: 100, w: 100, h: 20 }, renderBox: { x: 469.2, y: 104, w: 33.6, h: 11 } },
  ]);
  const s1 = spec(e, "2:1"), s2 = spec(e, "2:2"), s3 = spec(e, "2:3"), s4 = spec(e, "2:4"), s5 = spec(e, "2:5"), s6 = spec(e, "2:6"), s7 = spec(e, "2:7");
  safe("fixed-width text: spec.width = renderBox.w 32.14 (not the 121 box), widthFrom renderBox", () => s1?.width === 32.14 && s1.widthFrom === "renderBox");
  safe("…the box width is notComparable 'width (text box)' value 121", () => ncOn(e, "2:1", /^width \(text box\)$/)?.value === 121);
  safe("no TEXT carries a height (neither a Range nor its element gives the line box)", () => s1?.height === undefined && s2?.height === undefined && e.nodes.filter((n) => n.type === "TEXT").every((n) => n.height === undefined));
  safe("hug text (width_and_height): spec.width = box.w 34, no widthFrom, no notComparable", () => s2?.width === 34 && s2.widthFrom === undefined && !ncOn(e, "2:2", /width/));
  safe("fill-width text: ink width 207.4 + notComparable 'fills its parent'", () => s3?.width === 207.4 && s3.widthFrom === "renderBox" && /fills its parent/.test(ncOn(e, "2:3", /width \(text box\)/)?.why ?? ""));
  safe("truncated text the design truncates: width notComparable (a Range spans the unclipped string), no width spec", () => s4?.width === undefined && /truncated/.test(ncOn(e, "2:4", /^width$/)?.why ?? ""));
  safe("truncation set but the text fits (ink 9.77 in 121): its ink width is compared", () => s5?.width === 9.77 && s5.widthFrom === "renderBox");
  safe("left-aligned text with a stated box: x = box.x − frame.x = 336 (positionFrom box), not the ink 336.9", () => s6?.x === 336 && s6.positionFrom === "box");
  safe("centred text in a wider box: x = renderBox.x − frame.x = 369.2 (ink start)", () => s7?.x === 369.2 && s7.positionFrom === "renderBox");

  const textNode = (id: string, text: string, tb: MeasuredStyles["textBox"] | undefined, extra: MeasuredStyles = {}): MeasuredNode =>
    node(id, { fontFamily: "Inter", fontSize: 14, color: "rgb(51, 51, 51)", text, tag: "span", width: 146, ...(tb === undefined ? {} : { textBox: tb }), ...extra });
  const r = compare(e, measured([
    textNode("2:1", "Date", { x: 16, w: 33.9 }),
    textNode("2:2", "Total", { x: 200.6, w: 33.2 }),
    textNode("2:3", "Showing 1 to 20", { x: 0, w: 214 }),
    textNode("2:5", "12", { x: 0, w: 10.75 }),
  ]));
  safe("Range 33.9 vs ink 32.14 (within textInk 3): no width delta — before: 121 → 33.9 medium", () => !deltaOn(r, "2:1", /width/));
  safe("tolerance textInk is 3", () => TOLERANCE.textInk === 3);
  safe("fill text whose Range is 214 vs ink 207.4 (6.6 off): delta 'width (text ink)' medium, expected 207.4", () => { const d = deltaOn(r, "2:3", /width/); return d?.field === "width (text ink)" && d.severity === "medium" && d.expected === 207.4 && d.actual === 214; });
  safe("hug text 34 vs Range 33.2 (tol 1): no delta", () => !deltaOn(r, "2:2", /width/));
  safe("'12' 10.75 vs ink 9.77: no delta (before: 121 → 10.75)", () => !deltaOn(r, "2:5", /width/));
  const hugOff = compare(e, measured([textNode("2:2", "Total", { x: 200.6, w: 36.5 })]));
  safe("hug text 34 vs 36.5: delta field 'width' (tolerance 1, not the ink's 3)", () => deltaOn(hugOff, "2:2", /^width$/)?.delta === 2.5);

  // no textBox → never the element box
  const noTb = compare(e, measured([textNode("2:1", "Date", undefined)]));
  safe("TEXT on a flex-1 <span> 146 wide, no textBox: gap 'report textBox' (absent), no width delta", () =>
    !deltaOn(noTb, "2:1", /width/) && /report textBox/.test(gapOn(noTb, "2:1", /width/)?.why ?? ""));
  const nullTb = compare(e, measured([{ ...textNode("2:1", "Date", null), unmeasured: { textBox: "the text's own characters have no rendered box" } }]));
  safe("textBox null: gap with the probe's reason, no delta", () => /no rendered box/.test(gapOn(nullTb, "2:1", /width/)?.why ?? "") && !deltaOn(nullTb, "2:1", /width/));
  const differs = compare(e, measured([textNode("2:3", "Showing 1 to 12 of 240 entries", { x: 0, w: 260 })]));
  safe("the copy differs: width gap 'the text differs', no width delta (the text delta stays)", () =>
    !deltaOn(differs, "2:3", /width/) && /text differs/.test(gapOn(differs, "2:3", /width/)?.why ?? "") && !!deltaOn(differs, "2:3", /^text$/));
}

// ---------------------------------------------------------------- B. stroke + opacity
console.log("B — stroke tolerance with CSS snapping, rings, opacity:");
{
  const btn = (id: string, weight: number, align: "inside" | "outside" | "center" = "inside"): NodeInput =>
    ({ type: "FRAME", id, name: "Menu Button", box: { w: 36, h: 36 }, fills: [{ type: "solid", color: "#ffffff" }], strokes: { colors: ["#cccccc"], weight, align } });
  const e = expect1([btn("3:1", 1), btn("3:2", 1.5), btn("3:3", 0.5), btn("3:4", 2, "outside"), btn("3:5", 1, "outside")]);
  const box = (id: string, extra: MeasuredStyles): MeasuredNode => node(id, { backgroundColor: "rgb(255, 255, 255)", borderColor: "rgb(204, 204, 204)", width: 36, height: 36, opacity: 1, ...extra });
  const r = compare(e, measured([
    box("3:1", { borderWidth: 0 }), box("3:2", { borderWidth: 1 }), box("3:3", { borderWidth: 1 }),
    box("3:4", { borderWidth: 1, strokeFrom: "box-shadow", strokeAlign: "outside" }), box("3:5", { borderWidth: 1, strokeFrom: "box-shadow", strokeAlign: "inside" }),
  ]));
  safe("a lost 1px stroke (1 → 0) is a medium border-width delta — before: inside the padding tolerance 1", () => deltaOn(r, "3:1", /border-width/)?.severity === "medium");
  safe("tolerance stroke is 0.5", () => TOLERANCE.stroke === 0.5);
  safe("design 1.5 vs a computed '1px' border: no delta (Chromium floors border widths)", () => !deltaOn(r, "3:2", /border-width/));
  safe("design 0.5 vs '1px': no delta (1px minimum)", () => !deltaOn(r, "3:3", /border-width/));
  safe("a box-shadow ring is compared with the RAW design width (2 vs 1): delta, expected 2", () => deltaOn(r, "3:4", /border-width/)?.expected === 2);
  const r2 = compare(e, measured([box("3:5", { borderWidth: 0, strokeFrom: "box-shadow", strokeAlign: "inside" })]));
  safe("a ring on the other side than the design's stroke: noted on the delta, not a delta of its own", () =>
    /ring inside the box; the design's stroke is outside/.test(deltaOn(r2, "3:5", /border-width/)?.note ?? "") && r2.deltas.filter((d) => d.nodeId === "3:5").length === 1);
  safe("…and no delta at all when the ring's width matches (only the side differs)", () => !r.deltas.some((d) => d.nodeId === "3:5"));
  const snapped = compare(e, measured([box("3:2", { borderWidth: 0 })]));
  safe("design 1.5 lost entirely: delta expected 1 (what CSS draws), with a note naming the 1.5", () => { const d = deltaOn(snapped, "3:2", /border-width/); return d?.expected === 1 && d.actual === 0 && /1\.5px stroke draws as a 1px/.test(d.note ?? ""); });

  // opacity: stated (1) on every node that paints or carries copy
  const e2 = expect1([
    { type: "FRAME", id: "4:1", name: "Export", box: { w: 80, h: 32 }, fills: [{ type: "solid", color: "#0000ff" }] },
    { type: "FRAME", id: "4:2", name: "Wrapper", box: { w: 80, h: 32 }, layout: { display: "flex", padding: [4, 4, 4, 4] } },
    { type: "FRAME", id: "4:3", name: "Row Hovered", box: { w: 400, h: 40 }, fills: [{ type: "solid", color: "#46464f", tokens: { color: "Surface/Row Hover" } }], children: [
      { type: "FRAME", id: "4:4", name: "Edit", box: { w: 24, h: 24 }, fills: [{ type: "solid", color: "#ffffff" }] },
    ] },
  ]);
  safe("a painted node states opacity 1 (the exporter omits 1)", () => spec(e2, "4:1")?.opacity === 1);
  safe("a wrapper with no paint states none", () => spec(e2, "4:2")?.opacity === undefined);
  const half = compare(e2, measured([node("4:1", { backgroundColor: "rgb(0, 0, 255)", width: 80, height: 32, opacity: 0.5 })]));
  safe("the control rendered at opacity 0.5: a medium opacity delta (1 → 0.5)", () => { const d = deltaOn(half, "4:1", /opacity/); return d?.severity === "medium" && d.expected === 1 && d.actual === 0.5; });
  const rest = compare(e2, measured([node("4:3", { backgroundColor: "rgb(70, 70, 79)", width: 400, height: 40, opacity: 1 }), node("4:4", { backgroundColor: "rgb(255, 255, 255)", width: 24, height: 24, opacity: 0 })]));
  safe("hover-revealed content measured at rest (opacity 0): a gap naming the hover state, never a delta", () =>
    !deltaOn(rest, "4:4", /opacity/) && /hover/.test(gapOn(rest, "4:4", /opacity/)?.why ?? ""));
}

// ---------------------------------------------------------------- C. radius: <tr> and unpainted layers
console.log("C — radius on a table row, radius on a layer that draws nothing:");
{
  const e = expect1([
    { type: "FRAME", id: "5:1", name: "Header Row", box: { w: 1112, h: 48 }, fills: [{ type: "solid", color: "#121319" }], radius: 12 },
    { type: "FRAME", id: "5:2", name: "Last Row", box: { w: 1112, h: 48 }, fills: [{ type: "solid", color: "#121319" }], radius: { tl: 0, tr: 0, br: 12, bl: 12 } },
    { type: "INSTANCE", id: "5:3", name: "search and filter", box: { w: 1112, h: 36 }, radius: 8, mainComponent: { name: "search and filter", key: "k-search", setName: "search and filter" },
      layout: { display: "flex", gap: 8 }, children: [{ type: "TEXT", id: "I5:3;1:1", name: "Label", text: "Search", font: TXT }, { type: "TEXT", id: "I5:3;1:2", name: "Hint", text: "by name", font: TXT }] },
    { type: "FRAME", id: "5:4", name: "Clip Card", box: { w: 200, h: 100 }, radius: 8, clip: true, layout: { display: "flex", gap: 8 }, children: [
      { type: "FRAME", id: "5:5", name: "Photo", box: { w: 200, h: 60 }, fills: [{ type: "image", hash: "h1" }] }, { type: "FRAME", id: "5:6", name: "Strip", box: { w: 200, h: 32 }, fills: [{ type: "solid", color: "#eeeeee" }] }] },
  ]);
  const r = compare(e, measured([
    node("5:1", { backgroundColor: "rgb(18, 19, 25)", borderRadius: 0, width: 1112, height: 48, tag: "tr" }),
    node("5:2", { backgroundColor: "rgb(18, 19, 25)", borderRadius: 0, width: 1112, height: 48, tag: "thead" }),
  ]));
  safe("radius 12 measured 0 on a <tr>: gap 'table row … corner cells', no delta (before: 12 → 0 medium)", () => !deltaOn(r, "5:1", /radius/) && /table row\/row-group/.test(gapOn(r, "5:1", /radius/)?.why ?? ""));
  safe("per-corner radius on a <thead>: gap too, no corner delta", () => !deltaOn(r, "5:2", /radius/) && !!gapOn(r, "5:2", /radius/));
  safe("radius 8 on an instance that paints nothing: no borderRadius spec, notComparable 'draws nothing' value 8", () => spec(e, "5:3")?.borderRadius === undefined && ncOn(e, "5:3", /border-radius/)?.value === 8);
  safe("a clipping frame keeps its radius (the clip shows the corners)", () => spec(e, "5:4")?.borderRadius === 8 && !ncOn(e, "5:4", /radius/));
}

// ---------------------------------------------------------------- D. padding on a fixed box
console.log("D — padding the design cannot show:");
{
  const e = expect1([
    // 36x36 fixed square button, its icon CENTRED, padding 16 + an 18px icon: 16+16+18 = 50 > 36 on both axes
    { type: "INSTANCE", id: "6:1", name: "Square Button", box: { w: 36, h: 36 }, fills: [{ type: "solid", color: "#ffffff" }], mainComponent: { name: "Square Button", key: "k-sq", setName: "Square Button" },
      layout: { display: "flex", justifyContent: "center", alignItems: "center", padding: [16, 16, 16, 16] }, children: [{ type: "VECTOR", id: "I6:1;1:1", name: "Icon", box: { w: 18, h: 18 }, fills: [{ type: "solid", color: "#000000" }] }] },
    // 224 wide fixed logo container, centred, equal side padding 60, content 104 (fits: 224) — top/bottom 0
    { type: "FRAME", id: "6:2", name: "Logo", box: { w: 224, h: 40 }, fills: [{ type: "solid", color: "#111111" }], layout: { display: "flex", justifyContent: "center", padding: [0, 60, 0, 60] },
      children: [{ type: "FRAME", id: "6:3", name: "Mark", box: { w: 104, h: 40 }, fills: [{ type: "solid", color: "#222222" }] }] },
    // a hug-width pill: padding shows (the box follows the content) — compared
    { type: "FRAME", id: "6:4", name: "Pill", box: { w: 60, h: 28 }, widthMode: "hug", heightMode: "hug", fills: [{ type: "solid", color: "#e8f5e9" }], layout: { display: "flex", padding: [4, 12, 4, 12] },
      children: [{ type: "TEXT", id: "6:5", name: "Pill Label", text: "Active", font: TXT, autoResize: "width_and_height", box: { w: 36, h: 20 } }] },
    // fixed 120 wide, left-aligned, padding 8+8 + 40 content: fits, not centred → compared
    { type: "FRAME", id: "6:6", name: "Cell", box: { w: 120, h: 40 }, fills: [{ type: "solid", color: "#ffffff" }], layout: { display: "flex", padding: [8, 8, 8, 8] },
      children: [{ type: "FRAME", id: "6:7", name: "Dot", box: { w: 40, h: 24 }, fills: [{ type: "solid", color: "#00aa00" }] }] },
  ]);
  const s1 = spec(e, "6:1"), s2 = spec(e, "6:2"), s4 = spec(e, "6:4"), s6 = spec(e, "6:6");
  safe("36x36 box, padding 16 + 18px icon: padding dropped (all four sides cannot show), notComparable per axis", () =>
    s1?.padding === undefined && /exceeds the fixed 36px width/.test(ncOn(e, "6:1", /padding \(left\/right\)/)?.why ?? "") && /exceeds the fixed 36px height/.test(ncOn(e, "6:1", /padding \(top\/bottom\)/)?.why ?? ""));
  safe("centred content, equal side padding 60 on a fixed 224 width: left/right skipped (paddingSkip), padding kept", () =>
    JSON.stringify(s2?.paddingSkip) === JSON.stringify(["left", "right"]) && JSON.stringify(s2?.padding) === JSON.stringify([0, 60, 0, 60]) && /centred/.test(ncOn(e, "6:2", /padding/)?.why ?? ""));
  safe("a hug pill keeps its padding (the box follows the content)", () => JSON.stringify(s4?.padding) === JSON.stringify([4, 12, 4, 12]) && s4?.paddingSkip === undefined);
  safe("a fixed box whose padding fits and is not centred keeps it", () => JSON.stringify(s6?.padding) === JSON.stringify([8, 8, 8, 8]) && s6?.paddingSkip === undefined);
  const r = compare(e, measured([node("6:2", { backgroundColor: "rgb(17, 17, 17)", width: 224, height: 40, padding: [0, 0, 0, 0], tag: "div" })]));
  safe("compare: the build's justify-center with no padding (60 → 0 on skipped sides) is no padding delta", () => !deltaOn(r, "6:2", /padding/));
  const r2 = compare(e, measured([node("6:2", { backgroundColor: "rgb(17, 17, 17)", width: 224, height: 40, padding: [6, 0, 0, 0], tag: "div" })]));
  safe("…but a side still compared (top 0 → 6) is a delta, noting the skipped sides", () => { const d = deltaOn(r2, "6:2", /padding/); return d?.delta === 6 && /left\/right not compared/.test(d.note ?? ""); });
}

// ---------------------------------------------------------------- E. a frame id on an inline element
console.log("E — a FRAME/INSTANCE id on an inline element:");
{
  const e = expect1([{ type: "FRAME", id: "7:1", name: "Page Number", box: { w: 121, h: 36 }, radius: 8, fills: [{ type: "solid", color: "#ffffff" }], layout: { display: "flex", padding: [8, 8, 8, 8] } }]);
  const r = compare(e, measured([node("7:1", { backgroundColor: "rgb(255, 255, 255)", width: 10.75, height: 20, borderRadius: 0, padding: [0, 0, 0, 0], tag: "span", display: "inline" })]));
  safe("FRAME id on an inline <span> 10.75 wide: width/height/radius/padding are gaps 'inline <span> … owns the box', no box deltas", () =>
    !deltaOn(r, "7:1", /^(width|height|border-radius|padding)$/) && ["width", "height", "border-radius", "padding"].every((f) => /inline <span>/.test(gapOn(r, "7:1", new RegExp(`^${f}$`))?.why ?? "")));
  const flex = compare(e, measured([node("7:1", { backgroundColor: "rgb(255, 255, 255)", width: 10.75, height: 20, borderRadius: 0, padding: [0, 0, 0, 0], tag: "span", display: "inline-flex" })]));
  safe("display inline-flex owns a box: the width delta stays", () => deltaOn(flex, "7:1", /^width$/)?.expected === 121);
  const none = compare(e, measured([node("7:1", { backgroundColor: "rgb(255, 255, 255)", width: 10.75, height: 20, borderRadius: 0, padding: [0, 0, 0, 0], tag: "span" })]));
  safe("no display reported: no rule (the width delta stays)", () => !!deltaOn(none, "7:1", /^width$/));
}

// ---------------------------------------------------------------- F. match confidence
console.log("F — the match's size and how it was found cap severity:");
{
  const e = expect1([
    { type: "FRAME", id: "8:1", name: "Search Field", box: { w: 380, h: 36 }, radius: 8, fills: [{ type: "solid", color: "#ffffff" }] },
    { type: "TEXT", id: "8:2", name: "Nav Label", text: "Day Of Ownership", font: { ...TXT, size: 14 }, autoResize: "width_and_height", box: { w: 110, h: 20 } },
    { type: "FRAME", id: "8:3", name: "Dot", box: { w: 6, h: 6 }, radius: 3, fills: [{ type: "solid", color: "#00aa00" }] },
    { type: "FRAME", id: "8:4", name: "Tag List", box: { w: 120, h: 28 }, widthMode: "hug", fills: [{ type: "solid", color: "#eeeeee" }] },
  ]);
  const wrapper = (matchedBy: string): MeasuredNode => node("8:1", { backgroundColor: "rgb(0, 0, 0)", borderRadius: 0, width: 1160, height: 1248, opacity: 1, tag: "div" }, matchedBy);
  const r = compare(e, measured([wrapper("tag")]));
  const size = deltaOn(r, "8:1", /^match \(size\)$/);
  safe("380×36 matched to a 1160×1248 wrapper: ONE medium 'match (size)' row, expected [380,36], actual [1160,1248]", () =>
    r.deltas.filter((d) => d.field === "match (size)").length === 1 && size?.severity === "medium" && JSON.stringify(size.expected) === "[380,36]" && JSON.stringify(size.actual) === "[1160,1248]");
  safe("…every other delta of the node is capped at low, recording cappedFrom (background high → low)", () => {
    const bg = deltaOn(r, "8:1", /background/);
    return bg?.severity === "low" && bg.cappedFrom === "high" && r.deltas.filter((d) => d.nodeId === "8:1" && d !== size).every((d) => d.severity === "low");
  });
  safe("…no high left: the verdict is decided by the size row (medium), not the wrong element's colours", () => r.summary.high === 0 && r.summary.medium === 1);
  const small = compare(e, measured([node("8:3", { backgroundColor: "rgb(0, 170, 0)", borderRadius: 3, width: 13, height: 13, opacity: 1 })]));
  safe("6×6 measured 13×13 (>2x but only 7px off — the 8px floor): no size suspect", () => !deltaOn(small, "8:3", /match/));
  const grew = compare(e, measured([node("8:4", { backgroundColor: "rgb(238, 238, 238)", width: 320, height: 28, opacity: 1 })]));
  safe("a hug axis that only GREW (120 → 320) with the other axis right: no size suspect (the width delta stays medium)", () => !deltaOn(grew, "8:4", /match/) && deltaOn(grew, "8:4", /^width$/)?.severity === "medium");
  const grewBoth = compare(e, measured([node("8:4", { backgroundColor: "rgb(238, 238, 238)", width: 320, height: 90, opacity: 1 })]));
  safe("…it counts once the other axis is off too (28 → 90)", () => !!deltaOn(grewBoth, "8:4", /match/));

  // the cap by matchedBy
  const nav = (matchedBy: string): MeasuredNode => node("8:2", { fontFamily: "Inter", fontSize: 14, color: "rgb(51, 51, 51)", text: "OKR Management", textBox: { x: 0, w: 110 }, opacity: 1 }, matchedBy);
  const sevOf = (matchedBy: string): VerifyDelta | undefined => deltaOn(compare(e, measured([nav(matchedBy)])), "8:2", /^text$/);
  safe("an off-by-one POSITION match: the text delta is low (cappedFrom high) — before: high", () => { const d = sevOf("position"); return d?.severity === "low" && d.cappedFrom === "high" && /capped at low: matched by position/.test(d.note ?? ""); });
  safe("a hand-written 'position-partial-size' (not canonical): low", () => sevOf("position-partial-size")?.severity === "low");
  safe("text-ordinal: capped at medium", () => { const d = sevOf("text-ordinal"); return d?.severity === "medium" && d.cappedFrom === "high"; });
  safe("tag-alias: capped at medium", () => sevOf("tag-alias")?.severity === "medium");
  safe("tag / data-dt-node / text / frame / tag-shared-path / unstated: no cap (high, no cappedFrom)", () =>
    ["tag", "data-dt-node", "text", "frame", "tag-shared-path", ""].every((mb) => { const d = sevOf(mb); return d?.severity === "high" && d.cappedFrom === undefined; }));
  safe("the census counts tag-alias as 'alias' and a hand-written 'id' as a tag", () => {
    const c = compare(e, measured([nav("tag-alias"), node("8:3", { backgroundColor: "rgb(0, 170, 0)", width: 6, height: 6, borderRadius: 3, opacity: 1 }, "id")])).coverage.matchedBy;
    return c.tagAlias === 1 && c.tag === 1 && c.other === 0;
  });

  // a waiver on match (size): the owner accepts the element
  const w: PlanWaiver = { nodeId: "8:1", field: "match (size)", designed: [380, 36], built: [1160, 1248], exportContentSha256: e.exportContentSha256, reason: "the field IS the full-width filter bar here", decidedBy: "Sam Doe", decidedAt: "2026-10-01T02:00:00Z" };
  const waived = compare(e, measured([wrapper("tag")]), { waivers: [w] });
  // (accepting the element lifts the size cap — a tag match has no other cap, so the wrong background is a real high again)
  safe("a waiver on 'match (size)' applies: the row is accepted and the size cap is lifted (tag match, no match cap: background high → fail)", () =>
    !!deltaOn(waived, "8:1", /match/)?.accepted && deltaOn(waived, "8:1", /background/)?.severity === "high" && waived.verdict === "fail");
}

// ---------------------------------------------------------------- a delta now excluded by method
console.log("a previous delta the expectation now excludes is now unverifiable, not fixed:");
{
  const e = expect1([{ type: "TEXT", id: "2:1", name: "Date", text: "Date", font: TXT, autoResize: "height", box: { w: 121, h: 20 }, renderBox: { x: 116.62, y: 74, w: 32.14, h: 11 } },
    { type: "FRAME", id: "3:1", name: "Box", box: { w: 36, h: 36 }, fills: [{ type: "solid", color: "#ffffff" }] }]);
  const prev: VerifyReport = { schema: "designtwin/verify-report@2", verdict: "fail", coverage: { nodesExpected: 2, nodesMeasured: 2, fieldsChecked: 4 },
    inputs: { measuredSha256: "a".repeat(64) },
    deltas: [{ severity: "medium", nodeId: "2:1", field: "width", expected: 121, actual: 33.9, delta: 87.1 }, { severity: "high", nodeId: "3:1", field: "background", expected: "#ffffffff", actual: "#000000ff" }] };
  const r = compare(e, measured([node("2:1", { fontFamily: "Inter", fontSize: 14, color: "rgb(51, 51, 51)", text: "Date", textBox: { x: 16, w: 33.9 }, opacity: 1 }), node("3:1", { backgroundColor: "rgb(0, 0, 0)", width: 36, height: 36, opacity: 1 }, "position")]),
    { measuredSha256: "b".repeat(64), against: { file: "Orders.report.json", report: prev } });
  const dc = r.against?.deltas;
  safe("the old box-width delta (121 → 33.9) is nowUnverifiable (the box width is notComparable), not fixed", () =>
    dc?.fixed === 0 && dc.nowUnverifiable?.some((x) => x.nodeId === "2:1" && x.field === "width" && /text box/.test(x.why)) === true);
  safe("a delta capped by its match keeps its key: unchanged (severity is not part of it)", () => dc?.unchanged === 1 && deltaOn(r, "3:1", /background/)?.severity === "low");
}

// ---------------------------------------------------------------- G. shell aliases, split, foreign tags
console.log("G — shared shell: aliases at --expect, coverage split, foreign tags:");
{
  // The same Sidebar component on two screens of one Figma file. Figma re-mints every id under each instance; the nested
  // "Settings" sub-item is re-minted INSIDE too, so its `;` suffix differs as well.
  const sidebar = (inst: string, nested: string): NodeInput => ({ type: "INSTANCE", id: inst, name: "Sidebar", box: { x: 100, y: 50, w: 240, h: 800 }, fills: [{ type: "solid", color: "#121319" }],
    mainComponent: { name: "Sidebar", key: "k-sidebar", setName: "Sidebar" }, children: [
      { type: "TEXT", id: `I${inst.replace(/^I/, "")};2:1`, name: "Brand", text: "Acme", font: TXT },
      { type: "INSTANCE", id: `I${inst};2:5`, name: "Settings Group", fills: [{ type: "solid", color: "#1d1d1f" }], mainComponent: { name: "Nav Group", key: "k-group", setName: "Nav Group" }, children: [
        { type: "TEXT", id: `I${inst};2:5;${nested}`, name: "Settings", text: "Settings", font: TXT },
        { type: "INSTANCE", id: `I${inst};2:5;${nested}9`, name: "Chevron", mainComponent: { name: "Chevron", key: "k-chev", setName: "Chevron" }, box: { w: 16, h: 16 } },
      ] },
    ] });
  const screen = (frameId: string, inst: string, nested: string, sourceFile = "Sample Kit"): ScreenDoc =>
    screenExport([{ type: "FRAME", id: frameId, name: frameId === "1:1" ? "Orders" : "Customers", box: { x: 100, y: 50, w: 1280, h: 800 }, fills: [{ type: "solid", color: "#ffffff" }], children: [sidebar(inst, nested)] }],
      { exportedAt: "2026-10-01T00:00:00Z", screen: frameId === "1:1" ? "Orders" : "Customers", sourceFile });
  const files: Record<string, ScreenDoc> = { "pages/Main/Customers__1_2.json": screen("1:2", "10:20", "7:40") };
  const ORDERS_ROW: IndexRow = { id: "1:1", name: "Orders", file: "pages/Main/Orders__1_1.json", sourceFile: "Sample Kit" };
  const layers: IndexRow[] = [ORDERS_ROW, { id: "1:2", name: "Customers", file: "pages/Main/Customers__1_2.json", sourceFile: "Sample Kit" }];
  const readSibling = (f: string): ScreenDoc | null => files[f] ?? null;
  const e = buildExpectation([{ doc: screen("1:1", "10:10", "7:30"), label: "Orders" }], { index: { layers }, readSibling });
  const aliasesOf = (id: string): string[] | undefined => spec(e, id)?.aliases;
  safe("the shell root instance gets the sibling's id as an alias (name path '')", () => JSON.stringify(aliasesOf("10:10")) === JSON.stringify(["10:20"]));
  safe("the nested re-minted 'Settings' text: alias I10:20;2:5;7:40 (same key + name path, different suffix)", () => JSON.stringify(aliasesOf("I10:10;2:5;7:30")) === JSON.stringify(["I10:20;2:5;7:40"]));
  safe("a node whose sibling id has the SAME `;` suffix gets no alias (tag-shared-path finds it)", () => aliasesOf("I10:10;2:1") === undefined && aliasesOf("I10:10;2:5") === undefined);
  // another Figma file's sibling: never joined (ids and component keys would match unrelated nodes)
  const other = buildExpectation([{ doc: screen("1:1", "10:10", "7:30"), label: "Orders" }], { index: { layers: [ORDERS_ROW, { id: "1:2", name: "Customers", file: "pages/Main/Customers__1_2.json", sourceFile: "Other Kit" }] }, readSibling });
  safe("a sibling row of ANOTHER Figma file: no aliases at all", () => other.nodes.every((n) => n.aliases === undefined));
  const stamped = buildExpectation([{ doc: screen("1:1", "10:10", "7:30"), label: "Orders" }], { index: { layers: [ORDERS_ROW, { id: "1:2", name: "Customers", file: "pages/Main/Customers__1_2.json" }] },
    readSibling: (f) => (f === "pages/Main/Customers__1_2.json" ? screen("1:2", "10:20", "7:40", "Other Kit") : null) });
  safe("an unnamed index row whose export is stamped with another file: no aliases", () => stamped.nodes.every((n) => n.aliases === undefined));
  const noIndex = buildExpectation([{ doc: screen("1:1", "10:10", "7:30"), label: "Orders" }], { readSibling });
  safe("no index: no aliases (nothing says which siblings are this file's)", () => noIndex.nodes.every((n) => n.aliases === undefined));
  const twice = buildExpectation([{ doc: screenExport([{ type: "FRAME", id: "1:1", name: "Orders", box: { x: 100, y: 50, w: 1280, h: 800 }, fills: [{ type: "solid", color: "#ffffff" }], children: [sidebar("10:10", "7:30"), sidebar("10:11", "7:31")] }], { screen: "Orders", sourceFile: "Sample Kit" }), label: "Orders" }], { index: { layers }, readSibling });
  safe("the shell instantiated twice on this screen: ambiguous, no aliases", () => twice.nodes.every((n) => n.aliases === undefined));

  // a selected nav item moves between wrapper frames per screen, so one name path is unique in
  // both exports yet names DIFFERENT nodes. An alias pair must also agree on content: the subtree's visible text, or —
  // with no text — the node types + main component key along the path.
  const slotShell = (inst: string, sfx: string, label: string, iconKey: string): NodeInput => ({ type: "INSTANCE", id: inst, name: "Sidebar", box: { x: 100, y: 50, w: 240, h: 800 }, fills: [{ type: "solid", color: "#121319" }],
    mainComponent: { name: "Sidebar", key: "k-sidebar", setName: "Sidebar" }, children: [
      { type: "FRAME", id: `I${inst};3:${sfx}`, name: "Selected Slot", fills: [{ type: "solid", color: "#2a2a30" }], children: [{ type: "TEXT", id: `I${inst};3:${sfx}1`, name: "Item", text: label, font: TXT }] },
      { type: "INSTANCE", id: `I${inst};4:${sfx}`, name: "Icon Slot", box: { w: 16, h: 16 }, fills: [{ type: "solid", color: "#ffffff" }], mainComponent: { name: "Icon", key: iconKey, setName: "Icon" } },
    ] });
  const slotScreen = (frameId: string, shell: NodeInput): ScreenDoc => screenExport([{ type: "FRAME", id: frameId, name: frameId === "1:1" ? "Orders" : "Customers", box: { x: 100, y: 50, w: 1280, h: 800 }, fills: [{ type: "solid", color: "#ffffff" }], children: [shell] }], { screen: frameId === "1:1" ? "Orders" : "Customers", sourceFile: "Sample Kit" });
  const withSibling = (sib: NodeInput) => buildExpectation([{ doc: slotScreen("1:1", slotShell("10:10", "1", "Orders", "k-gear")), label: "Orders" }],
    { index: { layers }, readSibling: (f) => (f === "pages/Main/Customers__1_2.json" ? slotScreen("1:2", sib) : null) });
  const moved = withSibling(slotShell("10:20", "2", "Customers", "k-gear"));
  safe("[alias] same key + unique name path but different text ('Orders' vs 'Customers'): no alias for the slot or its text", () =>
    spec(moved, "I10:10;3:1")?.aliases === undefined && spec(moved, "I10:10;3:11")?.aliases === undefined);
  const same = withSibling(slotShell("10:20", "2", "Orders", "k-gear"));
  safe("[alias] …same text: alias (I10:10;3:11 → I10:20;3:21)", () => JSON.stringify(spec(same, "I10:10;3:11")?.aliases) === JSON.stringify(["I10:20;3:21"]));
  safe("[alias] a no-text subtree with the same component key along the path: alias (Icon Slot)", () => JSON.stringify(spec(same, "I10:10;4:1")?.aliases) === JSON.stringify(["I10:20;4:2"]));
  const swapped = withSibling(slotShell("10:20", "2", "Orders", "k-card"));
  safe("[alias] a no-text subtree whose component key differs (k-gear vs k-card): no alias", () => spec(swapped, "I10:10;4:1")?.aliases === undefined && JSON.stringify(spec(swapped, "I10:10;3:11")?.aliases) === JSON.stringify(["I10:20;3:21"]));

  // the coverage split — matched through another screen's id
  const tagged = (id: string, styles: MeasuredStyles, mb: string): MeasuredNode => node(id, { opacity: 1, ...styles }, mb);
  const r = compare(e, measured([
    tagged("10:10", { backgroundColor: "rgb(18, 19, 25)", width: 240, height: 800, x: 0, y: 0 }, "tag-alias"),
    tagged("I10:10;2:1", { fontFamily: "Inter", fontSize: 14, color: "rgb(51, 51, 51)", text: "Acme", textBox: { x: 16, w: 30 } }, "tag-shared-path"),
  ], { tagsNotInExpectation: { count: 3, ids: [{ id: "10:20", elements: 1 }, { id: "I10:20;2:1", elements: 1 }, { id: "I99:1;4:4", elements: 2 }] } }));
  const sh = r.coverage.sharedShell;
  safe("a shell matched through another screen's id: coverage.sharedShell {Sidebar 10:10, measured 2 of its specs}", () =>
    sh?.instances.length === 1 && sh.instances[0]?.nodeId === "10:10" && sh.instances[0].setName === "Sidebar" && sh.measured === 2 && sh.expected === (e.nodes.filter((n) => n.nodeId === "10:10" || n.nodeId.startsWith("I10:10;")).length));
  safe("the headline says 'nodes measured a/b (shared shell c/d)'", () => new RegExp(`nodes measured ${r.coverage.nodesMeasured}/${r.coverage.nodesExpected} \\(shared shell 2/${sh?.expected ?? -1}\\)`).test(r.headline));
  safe("informational: the verdict reasons do not mention the shell", () => !r.why.some((w) => /shell/.test(w)));
  safe("the untagged Chevron set inside the shell is listed apart (untaggedInstanceSetsInShell), not under untaggedInstanceSets", () =>
    r.untaggedInstanceSetsInShell?.some((s) => s.setName === "Chevron") === true && !r.untaggedInstanceSets.some((s) => s.setName === "Chevron"));
  safe("…and the .md has its own section", () => /## Instance sets with no evidence, inside the shared shell \(/.test(reportToMarkdown(r)));
  const anchored = compare(e, measured([tagged("10:10", { backgroundColor: "rgb(18, 19, 25)", width: 240, height: 800 }, "tag")]), { anchors: { "10:10": { shared: true } } });
  safe("plan anchors[<instance>].shared: true marks the shell even when every match is by its own tag", () => anchored.coverage.sharedShell?.instances[0]?.nodeId === "10:10");
  const plain = compare(e, measured([tagged("10:10", { backgroundColor: "rgb(18, 19, 25)", width: 240, height: 800 }, "tag")]));
  safe("no other-screen match and no anchor: no sharedShell", () => plain.coverage.sharedShell === undefined && !/shared shell/.test(plain.headline));

  // the foreign tags, classified
  const ft = r.probe.foreignTags;
  safe("foreign tags: total 3 = 1 prefix drift (I10:20;2:1 — an expected suffix) + 1 alias (10:20) + 1 unknown", () =>
    ft?.total === 3 && ft.prefixDrift === 1 && ft.alias === 1 && ft.unknown === 1 && ft.sample[0] === "I99:1;4:4");
  safe("headline note (informational) and an .md line", () => /3 foreign tag\(s\) \(1 prefix drift, 1 alias, 1 unknown\)/.test(r.headline) && /3 tag\(s\)\/id\(s\) on the page name no node of this expectation/.test(reportToMarkdown(r)));
  // (one foreign id with an expected suffix is matched through it — shared-component-path; two are ambiguous and stay foreign)
  const hand = compare(e, measured([tagged("I77:7;2:1", { fontFamily: "Inter" }, "data-dt-node"), tagged("I78:8;2:1", { fontFamily: "Inter" }, "data-dt-node")]));
  const bad = readableMeasured({ nodes: [], tagsNotInExpectation: "three" });
  safe("a malformed measured.tagsNotInExpectation is dropped with a note (the measurements still compare)", () =>
    !!bad && bad.doc.tagsNotInExpectation === undefined && bad.notes.some((n) => /tagsNotInExpectation/.test(n)));
  safe("…and it is a known top-level key (not listed as unknown)", () => !(r.probe.unknownTopLevelKeys || []).some((k) => k.key === "tagsNotInExpectation"));
  safe("a hand-written probe's measured ids outside the expectation are classified too (2 prefix drift)", () => hand.probe.foreignTags?.prefixDrift === 2 && hand.probe.foreignTags.total === 2);
}

// ---------------------------------------------------------------- overfull padding sides, per-side strokes, dropped specs, mutation gaps, alias content
console.log("overfull padding sides, per-side strokes, dropped specs, mutation gaps, alias content:");
{
  const card: NodeInput = { type: "FRAME", id: "9:1", name: "Card", box: { w: 300, h: 120 }, fills: [{ type: "solid", color: "#f5f5f5" }], radius: 8 };
  const e = expect1([card]);
  const red = (mb: string, w = 300): MeasuredNode => node("9:1", { backgroundColor: "rgb(255, 0, 0)", width: w, height: 120, borderRadius: 8, opacity: 1, tag: "div", display: "block" }, mb);
  const frameNode = node("1:1", { backgroundColor: "rgb(255, 255, 255)", width: 1280, height: 800, x: 0, y: 0, opacity: 1 }, "frame");
  const structural = compare(e, measured([frameNode, red("structural")]));
  const byPos = compare(e, measured([frameNode, red("position")]));
  const byTag = compare(e, measured([frameNode, red("tag")]));
  safe("a wrong background on a 'structural' match (capped low): verdict incomplete with 'low-confidence matches — tag these elements', not pass", () =>
    structural.verdict === "incomplete" && structural.why.some((w) => /1 delta\(s\) on low-confidence matches — tag these elements/.test(w)) && structural.summary.lowConfidence === 1);
  safe("…the same on a position match: incomplete (never pass, never fail)", () => byPos.verdict === "incomplete" && deltaOn(byPos, "9:1", /background/)?.severity === "low");
  safe("…a tag match fails as before", () => byTag.verdict === "fail");
  safe("the headline counts the capped deltas", () => /\(\+1 capped on low-confidence matches\)/.test(structural.headline));
  const w: PlanWaiver = { nodeId: "9:1", field: "match (size)", designed: [300, 120], built: [640, 120], exportContentSha256: e.exportContentSha256, reason: "the card is full-width here", decidedBy: "Sam Doe", decidedAt: "2026-10-01T02:00:00Z" };
  const waived = compare(e, measured([frameNode, red("tag", 640)]), { waivers: [w] });
  safe("a waiver on match (size) lifts the size cap (tag match, no match cap): the red background is high again → fail", () =>
    waived.verdict === "fail" && deltaOn(waived, "9:1", /background/)?.severity === "high" && deltaOn(waived, "9:1", /background/)?.cappedFrom === undefined && !!deltaOn(waived, "9:1", /match/)?.accepted);

  // Figma insets the first child of a start-aligned overfull box by its start padding
  const e3 = expect1([{ type: "FRAME", id: "9:2", name: "Brand", box: { w: 247, h: 40 }, fills: [{ type: "solid", color: "#111111" }], layout: { display: "flex", padding: [0, 28, 0, 28] },
    children: [{ type: "FRAME", id: "9:3", name: "Logo", box: { w: 224, h: 40 }, fills: [{ type: "solid", color: "#222222" }] }] }]);
  safe("fixed 247, padding 28+28, 224 child, start-aligned: only the RIGHT side is skipped", () => JSON.stringify(spec(e3, "9:2")?.paddingSkip) === JSON.stringify(["right"]) && /start-aligned/.test(ncOn(e3, "9:2", /padding \(right\)/)?.why ?? ""));
  const r3 = compare(e3, measured([node("9:2", { backgroundColor: "rgb(17, 17, 17)", width: 247, height: 40, padding: [0, 0, 0, 0], opacity: 1 })]));
  safe("…so a build with no left padding is still a padding delta", () => !!deltaOn(r3, "9:2", /^padding$/));

  // per-side weights + align
  const e4 = expect1([{ type: "FRAME", id: "9:4", name: "Row", box: { w: 300, h: 40 }, fills: [{ type: "solid", color: "#ffffff" }], strokes: { colors: ["#e6e6e6"], weights: { bottom: 1 }, align: "inside" } }]);
  safe("strokes {weights:{bottom:1}, align:inside} → borderWidths [0,0,1,0] AND strokeAlign inside", () => JSON.stringify(spec(e4, "9:4")?.borderWidths) === "[0,0,1,0]" && spec(e4, "9:4")?.strokeAlign === "inside");

  // a node whose only checkable value was excluded says so
  const e5 = expect1([{ type: "FRAME", id: "9:5", name: "Hit Area", box: { w: 200, h: 36 }, radius: 8 }]);
  safe("a frame whose only value was an invisible radius: no spec, and a notComparable 'node' row 'it draws nothing'", () => !spec(e5, "9:5") && /node not checked: it draws nothing/.test(ncOn(e5, "9:5", /^node$/)?.why ?? ""));

  // mutation gaps
  const e6 = expect1([
    { type: "FRAME", id: "9:6", name: "Panel", box: { w: 300, h: 120 }, fills: [{ type: "solid", color: "#eeeeee" }] },
    { type: "TEXT", id: "9:7", name: "Two Lines", text: "Ok", font: TXT, autoResize: "height", truncate: true, maxLines: 2, box: { w: 200, h: 40 }, renderBox: { x: 0, y: 0, w: 14, h: 11 } },
    { type: "FRAME", id: "9:8", name: "Lopsided", box: { w: 224, h: 40 }, fills: [{ type: "solid", color: "#111111" }], layout: { display: "flex", justifyContent: "center", padding: [0, 40, 0, 60] },
      children: [{ type: "FRAME", id: "9:9", name: "Mark", box: { w: 104, h: 40 }, fills: [{ type: "solid", color: "#222222" }] }] },
  ]);
  const wide = compare(e6, measured([node("9:6", { backgroundColor: "rgb(238, 238, 238)", width: 450, height: 120, opacity: 1 })]));
  safe("1.5x wider (300 → 450, 150px off): not a size suspect (needs >= 2x)", () => !deltaOn(wide, "9:6", /match/) && deltaOn(wide, "9:6", /^width$/)?.severity === "medium");
  safe("maxLines 2 (several lines) even when the ink fits: width notComparable", () => spec(e6, "9:7")?.width === undefined && !!ncOn(e6, "9:7", /^width$/));
  safe("centred but UNEQUAL padding (60/40): not skipped", () => spec(e6, "9:8")?.paddingSkip === undefined && !!spec(e6, "9:8")?.padding);
  const tall = compare(expect1([]), measured([node("1:1", { backgroundColor: "rgb(255, 255, 255)", width: 1280, height: 2400, x: 0, y: 0, opacity: 1 }, "frame")]));
  safe("the frame root only taller (page scrolls, 800 → 2400): no size suspect", () => !deltaOn(tall, "1:1", /match/));

  // sibling stamping
  const popup = (inst: string, sfx: string, title: string, sourceFile: string | undefined, extra: NodeInput[] = []): ScreenDoc => screenExport([{ type: "FRAME", id: inst === "11:10" ? "1:1" : "1:2", name: inst === "11:10" ? "Orders" : "Customers", box: { x: 100, y: 50, w: 1280, h: 800 }, fills: [{ type: "solid", color: "#ffffff" }], children: [
    { type: "INSTANCE", id: inst, name: "Popup", box: { x: 400, y: 200, w: 480, h: 300 }, fills: [{ type: "solid", color: "#1d1d1f" }], mainComponent: { name: "Popup", key: "k-popup", setName: "Popup" }, children: [
      { type: "FRAME", id: `I${inst};5:${sfx}`, name: "Header", fills: [{ type: "solid", color: "#2a2a30" }], children: [
        { type: "TEXT", id: `I${inst};5:${sfx}1`, name: "Title", text: title, font: TXT },
        { type: "INSTANCE", id: `I${inst};5:${sfx}2`, name: "Close", box: { w: 16, h: 16 }, fills: [{ type: "solid", color: "#ffffff" }], mainComponent: { name: "x-close", key: "k-x", setName: "x-close" } },
      ] }, ...extra] }] }], { screen: inst === "11:10" ? "Orders" : "Customers", ...(sourceFile ? { sourceFile } : {}) });
  const ROWS: IndexRow[] = [{ id: "1:1", name: "Orders", file: "pages/Main/Orders__1_1.json", sourceFile: "Sample Kit" }, { id: "1:2", name: "Customers", file: "pages/Main/Customers__1_2.json" }];
  const withPopup = (sib: ScreenDoc, own = popup("11:10", "1", "Add Item", "Sample Kit")) => buildExpectation([{ doc: own, label: "Orders" }], { index: { layers: ROWS }, readSibling: (f) => (f === "pages/Main/Customers__1_2.json" ? sib : null) });
  const diffTitle = withPopup(popup("11:20", "2", "Edit Category", "Sample Kit"));
  safe("the close icon (no text, same key + path) under titles 'Add Item' vs 'Edit Category': no alias", () => spec(diffTitle, "I11:10;5:12")?.aliases === undefined);
  const sameTitle = withPopup(popup("11:20", "2", "Add Item", "Sample Kit"));
  safe("…same title: the close icon gets its alias", () => JSON.stringify(spec(sameTitle, "I11:10;5:12")?.aliases) === JSON.stringify(["I11:20;5:22"]));
  const unstamped = withPopup(popup("11:20", "2", "Add Item", undefined));
  safe("a stamped screen + an unstamped sibling export (unnamed row): aliases are built", () => JSON.stringify(spec(unstamped, "I11:10;5:12")?.aliases) === JSON.stringify(["I11:20;5:22"]));
  const otherFile = withPopup(popup("11:20", "2", "Add Item", "Other Kit"));
  safe("a stamped screen + a sibling export stamped with ANOTHER file (unnamed row): no aliases", () => otherFile.nodes.every((n) => n.aliases === undefined));
  // the sibling's id for the close icon carries the suffix of ANOTHER spec of this screen
  const clash = withPopup(popup("11:20", "2", "Add Item", "Sample Kit"), popup("11:10", "1", "Add Item", "Sample Kit", [{ type: "FRAME", id: "I11:10;5:22", name: "Footer", fills: [{ type: "solid", color: "#333333" }] }]));
  safe("an alias whose `;` suffix is ANY expected spec's suffix is left out", () => spec(clash, "I11:10;5:12")?.aliases === undefined);

  // padding by side
  const e7 = expect1([{ type: "FRAME", id: "9:10", name: "Logo", box: { w: 224, h: 40 }, fills: [{ type: "solid", color: "#111111" }], layout: { display: "flex", justifyContent: "center", padding: [4, 60, 4, 60] },
    children: [{ type: "FRAME", id: "9:11", name: "Mark", box: { w: 104, h: 32 }, fills: [{ type: "solid", color: "#222222" }] }] }]);
  const prevOf = (exp: number[], act: number[]): VerifyReport => ({ schema: "designtwin/verify-report@2", verdict: "fail", coverage: { nodesExpected: 1, nodesMeasured: 1, fieldsChecked: 1 }, inputs: { measuredSha256: "a".repeat(64) },
    deltas: [{ severity: "medium", nodeId: "9:10", field: "padding", expected: exp, actual: act, delta: 60 }] });
  const nowM = measured([node("9:10", { backgroundColor: "rgb(17, 17, 17)", width: 224, height: 40, padding: [4, 0, 4, 0], opacity: 1 })]);
  const lr = compare(e7, nowM, { measuredSha256: "b".repeat(64), against: { file: "Logo.report.json", report: prevOf([4, 60, 4, 60], [4, 0, 4, 0]) } }).against?.deltas;
  const tb = compare(e7, nowM, { measuredSha256: "b".repeat(64), against: { file: "Logo.report.json", report: prevOf([4, 60, 4, 60], [12, 60, 12, 60]) } }).against?.deltas;
  safe("a previous padding delta on the now-skipped left/right sides: nowUnverifiable", () => lr?.nowUnverifiable?.length === 1 && lr.fixed === 0);
  safe("…one on top/bottom (still compared, now right): fixed, not nowUnverifiable", () => tb?.fixed === 1 && !tb.nowUnverifiable);

  // a text-width waiver, and an expectation without textInk
  const eT = expect1([{ type: "TEXT", id: "2:1", name: "Date", text: "Date", font: TXT, autoResize: "height", box: { w: 121, h: 20 }, renderBox: { x: 116.62, y: 74, w: 32.14, h: 11 } }]);
  const oldW: PlanWaiver = { nodeId: "2:1", field: "width", designed: 121, built: 33.9, exportContentSha256: eT.exportContentSha256, reason: "box", decidedBy: "Sam Doe", decidedAt: "2026-09-30T00:00:00Z" };
  const rc = compare(eT, measured([node("2:1", { fontFamily: "Inter", fontSize: 14, color: "rgb(51, 51, 51)", text: "Date", textBox: { x: 16, w: 20 }, opacity: 1 })]), { waivers: [oldW] });
  safe("a 'width' waiver on a TEXT compared by ink: unused 'compared as width (text ink)'", () => rc.waivers.unused.some((u) => u.nodeId === "2:1" && /compared as 'width \(text ink\)'/.test(u.why ?? "")));
  const { textInk: _ink, ...oldTol } = eT.tolerance ?? {};
  const rd = compare({ ...eT, tolerance: oldTol }, measured([]));
  safe("an expectation whose tolerance has no textInk (an older expectation): a note 're-run --expect'", () => (rd.probe.inputNotes || []).some((n) => /older verify-screen.*re-run --expect/.test(n)) && !(compare(eT, measured([])).probe.inputNotes || []).some((n) => /older verify-screen/.test(n)));
}

// ---------------------------------------------------------------- overfull alignment, wrap, space-*, size waiver, sibling file
console.log("overfull alignment per axis, wrap, space-*, the size-waiver cap, nearest texted ancestor, resolved sibling file:");
{
  const box = (id: string, layout: NonNullable<NodeInput["layout"]>, w: number, h: number, kids: Array<[number, number]>): NodeInput =>
    ({ type: "FRAME", id, name: `Box ${id}`, box: { w, h }, fills: [{ type: "solid", color: "#ffffff" }], layout, children: kids.map(([cw, ch], i): NodeInput => ({ type: "FRAME", id: `${id}${i}`, name: `Kid ${i}`, box: { w: cw, h: ch }, fills: [{ type: "solid", color: "#eeeeee" }] })) });
  const e = expect1([
    // row, alignItems flex-end, overfull on y (8+8+40 > 40): the overflow runs out at the TOP
    box("12:1", { display: "flex", alignItems: "flex-end", padding: [8, 0, 8, 0] }, 100, 40, [[40, 40]]),
    // column, justifyContent flex-end (main = y) overfull on y; alignItems center overfull on x
    box("12:2", { display: "flex", flexDirection: "column", justifyContent: "flex-end", alignItems: "center", padding: [8, 8, 8, 8] }, 40, 40, [[40, 40]]),
    // start-aligned, overfull on x, right padding 0: the lost side has no padding → nothing skipped
    box("12:3", { display: "flex", padding: [0, 0, 0, 16] }, 100, 40, [[100, 40]]),
    // a wrapping chip list: 200 wide, padding 16, 4×60 chips gap 8 — the end padding sets the wrap point
    box("12:4", { display: "flex", flexWrap: "wrap", gap: 8, padding: [16, 16, 16, 16] }, 200, 120, [[60, 24], [60, 24], [60, 24], [60, 24]]),
    // space-around overfull on the main axis: CSS centres it → both sides
    box("12:5", { display: "flex", justifyContent: "space-around", padding: [0, 20, 0, 20] }, 100, 40, [[50, 40], [50, 40]]),
  ]);
  const skipOf = (id: string): string => JSON.stringify(spec(e, id)?.paddingSkip ?? null);
  safe("row + alignItems flex-end, overfull on y: paddingSkip [top]", () => skipOf("12:1") === '["top"]');
  safe("column + justifyContent flex-end (y) and alignItems center (x), both overfull: skip top AND left/right", () => {
    const sk = spec(e, "12:2")?.paddingSkip ?? [];
    return sk.length === 3 && ["top", "left", "right"].every((x) => sk.some((y) => y === x)) && !!ncOn(e, "12:2", /padding \(top\)/) && !!ncOn(e, "12:2", /padding \(left\/right\)/);
  });
  safe("start-aligned overfull whose right padding is 0: no paddingSkip (the left padding still shows)", () => skipOf("12:3") === "null" && !!spec(e, "12:3")?.padding);
  safe("[wrap] a wrapping list's main axis is not overfull (end padding sets the wrap point): no skip", () => skipOf("12:4") === "null");
  safe("[space-around] overfull space-around centres: both sides skipped", () => skipOf("12:5") === '["left","right"]' && !!ncOn(e, "12:5", /padding \(left\/right\)/));

  // refined: a size waiver lifts only the size cap
  const eC = expect1([{ type: "FRAME", id: "12:6", name: "Card", box: { w: 300, h: 120 }, fills: [{ type: "solid", color: "#f5f5f5" }] }]);
  const wv: PlanWaiver = { nodeId: "12:6", field: "match (size)", designed: [300, 120], built: [640, 120], exportContentSha256: eC.exportContentSha256, reason: "full-width here", decidedBy: "Sam Doe", decidedAt: "2026-10-01T02:00:00Z" };
  const big = (mb: string): MeasuredNode => node("12:6", { backgroundColor: "rgb(255, 0, 0)", width: 640, height: 120, opacity: 1, tag: "div" }, mb);
  const noWaiver = compare(eC, measured([big("position")]));
  safe("[refined] a position match + size suspect: the background records cappedBy [size, match]", () => JSON.stringify(deltaOn(noWaiver, "12:6", /background/)?.cappedBy) === '["size","match"]');
  const tagW = compare(eC, measured([big("tag")]), { waivers: [wv] });
  safe("[refined] tag match + size suspect + waiver: background back to high → fail", () => deltaOn(tagW, "12:6", /background/)?.severity === "high" && tagW.verdict === "fail");
  const posW = compare(eC, measured([big("position")]), { waivers: [wv] });
  safe("[refined] position match + size suspect + waiver: background stays low (capped by match) → incomplete via the waiver", () => {
    const d = deltaOn(posW, "12:6", /background/);
    return d?.severity === "low" && d.cappedFrom === "high" && JSON.stringify(d.cappedBy) === '["match"]' && posW.verdict === "incomplete" && posW.why.some((x) => /low-confidence matches/.test(x));
  });

  // the NEAREST texted ancestor decides
  const card2 = (inst: string, sfx: string, parentText: string, grandText: string, sourceFile: string | undefined): ScreenDoc => screenExport([{ type: "FRAME", id: inst === "13:10" ? "1:1" : "1:2", name: inst === "13:10" ? "Orders" : "Customers", box: { x: 100, y: 50, w: 1280, h: 800 }, fills: [{ type: "solid", color: "#ffffff" }], children: [
    { type: "INSTANCE", id: inst, name: "Panel", box: { x: 400, y: 200, w: 480, h: 300 }, fills: [{ type: "solid", color: "#1d1d1f" }], mainComponent: { name: "Panel", key: "k-panel", setName: "Panel" }, children: [
      { type: "FRAME", id: `I${inst};6:${sfx}`, name: "Body", fills: [{ type: "solid", color: "#2a2a30" }], children: [
        { type: "TEXT", id: `I${inst};6:${sfx}1`, name: "Caption", text: grandText, font: TXT },
        { type: "FRAME", id: `I${inst};6:${sfx}2`, name: "Row", fills: [{ type: "solid", color: "#333333" }], children: [
          { type: "TEXT", id: `I${inst};6:${sfx}3`, name: "Label", text: parentText, font: TXT },
          { type: "INSTANCE", id: `I${inst};6:${sfx}4`, name: "Icon", box: { w: 16, h: 16 }, fills: [{ type: "solid", color: "#ffffff" }], mainComponent: { name: "Icon", key: "k-icon", setName: "Icon" } },
        ] },
      ] },
    ] }] }], { screen: inst === "13:10" ? "Orders" : "Customers", ...(sourceFile ? { sourceFile } : {}) });
  const ROWS: IndexRow[] = [{ id: "1:1", name: "Orders", file: "pages/Main/Orders__1_1.json", sourceFile: "Sample Kit" }, { id: "1:2", name: "Customers", file: "pages/Main/Customers__1_2.json" }];
  const pair = (own: ScreenDoc, sib: ScreenDoc) => buildExpectation([{ doc: own, label: "Orders" }], { index: { layers: ROWS }, readSibling: (f) => (f === "pages/Main/Customers__1_2.json" ? sib : null) });
  const parentDiffers = pair(card2("13:10", "1", "Alpha", "Beta", "Sample Kit"), card2("13:20", "2", "Gamma", "Beta", "Sample Kit"));
  safe("untexted icon: parent text differs (Alpha vs Gamma), grandparent same: no alias", () => spec(parentDiffers, "I13:10;6:14")?.aliases === undefined);
  const grandDiffers = pair(card2("13:10", "1", "Alpha", "Beta", "Sample Kit"), card2("13:20", "2", "Alpha", "Delta", "Sample Kit"));
  safe("parent text same, grandparent differs: alias (the nearest texted ancestor decides)", () => JSON.stringify(spec(grandDiffers, "I13:10;6:14")?.aliases) === '["I13:20;6:24"]');

  // the sibling stamp is checked against the file an UNSTAMPED screen resolved to through its index row
  const unstampedOwn = card2("13:10", "1", "Alpha", "Beta", undefined);
  const otherStamp = pair(unstampedOwn, card2("13:20", "2", "Alpha", "Beta", "Other Kit"));
  safe("[sibling] an unstamped screen (its index row says Sample Kit) + a sibling stamped Other Kit: no aliases", () => otherStamp.nodes.every((n) => n.aliases === undefined));
  const sameStamp = pair(unstampedOwn, card2("13:20", "2", "Alpha", "Beta", "Sample Kit"));
  safe("[sibling] …a sibling stamped Sample Kit: aliases built", () => JSON.stringify(spec(sameStamp, "I13:10;6:14")?.aliases) === '["I13:20;6:24"]');

  safe("[LIMITS] the report's limits say capped deltas block a plain pass and a size waiver lifts only the size cap", () => (noWaiver.limits || []).some((l) => /capped delta blocks a plain pass/.test(l) && /lifts only the size cap/.test(l)));
}

// ---------------------------------------------------------------- a wrapping list's padding
console.log("a wrapping list's main-axis padding shows, its cross axis holds the stacked lines; a medium match cap still holds:");
{
  const box = (id: string, layout: NonNullable<NodeInput["layout"]>, w: number, h: number, kids: Array<[number, number]>): NodeInput =>
    ({ type: "FRAME", id, name: `Box ${id}`, box: { w, h }, fills: [{ type: "solid", color: "#ffffff" }], layout, children: kids.map(([cw, ch], i): NodeInput => ({ type: "FRAME", id: `${id}${i}`, name: `Kid ${i}`, box: { w: cw, h: ch }, fills: [{ type: "solid", color: "#eeeeee" }] })) });
  const e = expect1([
    // centred wrapping chip list, padding L/R 40: inner 220 holds 3 chips a line (no padding: 4) — the padding shows
    box("20:1", { display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 8, rowGap: 8, padding: [0, 40, 0, 40] }, 300, 100, [[60, 24], [60, 24], [60, 24], [60, 24], [60, 24]]),
    // fixed 200×60, padding 16: four 60×24 chips → 2 lines (24+8+24 = 56) + 32 > 60 — overfull on the cross axis
    box("20:2", { display: "flex", flexWrap: "wrap", gap: 8, rowGap: 8, padding: [16, 16, 16, 16] }, 200, 60, [[60, 24], [60, 24], [60, 24], [60, 24]]),
    // the gap between lines counts: three 60×20 chips in a 100-wide box → 3 lines, 60 + 2×4 = 68, + 16 > 80
    box("20:3", { display: "flex", flexWrap: "wrap", gap: 8, rowGap: 4, padding: [8, 0, 8, 0] }, 100, 80, [[60, 20], [60, 20], [60, 20]]),
    // …and the same lines that DO fit (height 90): nothing skipped
    box("20:4", { display: "flex", flexWrap: "wrap", gap: 8, rowGap: 4, padding: [8, 0, 8, 0] }, 100, 90, [[60, 20], [60, 20], [60, 20]]),
    // greedy packing per line: two chips share a line when they fit the inner width (40+8+40 ≤ 100) → 2 lines, 20+4+30 = 54, + 16 ≤ 80
    box("20:5", { display: "flex", flexWrap: "wrap", gap: 8, rowGap: 4, padding: [8, 0, 8, 0] }, 100, 80, [[40, 20], [40, 20], [40, 30]]),
    // lines pack within the INNER width: 140 − 10 − 10 = 120 < 60+8+60 → 2 lines (20+4+20 = 44) + 16 > 50 (in 140 they would share one line)
    box("20:6", { display: "flex", flexWrap: "wrap", gap: 8, rowGap: 4, padding: [8, 10, 8, 10] }, 140, 50, [[60, 20], [60, 20]]),
    // a line is as tall as its TALLEST child, not its last: 60×30 then 40×10 share line 1, 60×20 is line 2 → 30+4+20 = 54, + 16 > 66
    box("20:7", { display: "flex", flexWrap: "wrap", gap: 8, rowGap: 4, padding: [8, 0, 8, 0] }, 110, 66, [[60, 30], [40, 10], [60, 20]]),
    // centred items, but alignContent space-between spreads the 2 lines to the top and bottom padding → the padding shows
    box("20:8", { display: "flex", flexWrap: "wrap", alignItems: "center", alignContent: "space-between", gap: 8, padding: [20, 0, 20, 0] }, 130, 200, [[60, 24], [60, 24], [60, 24]]),
    // …and without space-between the centred, equal top/bottom padding moves nothing (unchanged rule)
    box("20:9", { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: [20, 0, 20, 0] }, 130, 200, [[60, 24], [60, 24], [60, 24]]),
  ]);
  const skipOf = (id: string): string => JSON.stringify(spec(e, id)?.paddingSkip ?? null);
  safe("[wrap] a centred wrapping list with equal L/R padding: the padding sets the wrap point → not skipped", () => skipOf("20:1") === "null" && JSON.stringify(spec(e, "20:1")?.padding) === "[0,40,0,40]" && !ncOn(e, "20:1", /padding/));
  safe("[wrap] cross axis = stacked lines: 2 lines (56px) + 32 padding > 60 → bottom skipped (start-aligned)", () => skipOf("20:2") === '["bottom"]' && /56px/.test(ncOn(e, "20:2", /padding \(bottom\)/)?.why ?? ""));
  safe("[wrap] the gap between lines (rowGap) counts: 3 lines + 2×4 + 16 > 80 → bottom skipped", () => skipOf("20:3") === '["bottom"]' && /68px/.test(ncOn(e, "20:3", /padding \(bottom\)/)?.why ?? ""));
  safe("[wrap] the same lines in 90px fit: nothing skipped", () => skipOf("20:4") === "null");
  safe("[wrap] children share a line when they fit (greedy packing): 2 lines of 54px fit 80 → nothing skipped", () => skipOf("20:5") === "null");
  safe("[wrap] a line is as tall as its tallest child: 30+4+20 = 54 + 16 > 66 → bottom skipped", () => skipOf("20:7") === '["bottom"]' && /54px/.test(ncOn(e, "20:7", /padding \(bottom\)/)?.why ?? ""));
  safe("[wrap] alignContent space-between: centred items still put the lines against the padding → not skipped", () => skipOf("20:8") === "null" && !ncOn(e, "20:8", /padding/));
  safe("[wrap] centred wrapping lines without space-between: equal top/bottom padding moves nothing → skipped", () => skipOf("20:9") === '["top","bottom"]');
  safe("[wrap] lines pack within the inner width (main-axis padding subtracted): 2 lines of 44px + 16 > 50 → bottom skipped", () => skipOf("20:6") === '["bottom"]' && /44px/.test(ncOn(e, "20:6", /padding \(bottom\)/)?.why ?? ""));

  // a medium match cap survives an accepted size waiver
  const eC = expect1([{ type: "FRAME", id: "21:1", name: "Card", box: { w: 300, h: 120 }, fills: [{ type: "solid", color: "#f5f5f5" }] }]);
  const wv: PlanWaiver = { nodeId: "21:1", field: "match (size)", designed: [300, 120], built: [640, 120], exportContentSha256: eC.exportContentSha256, reason: "full-width here", decidedBy: "Sam Doe", decidedAt: "2026-10-01T02:00:00Z" };
  const big = (mb: string): MeasuredNode => node("21:1", { backgroundColor: "rgb(255, 0, 0)", width: 640, height: 120, opacity: 1, tag: "div" }, mb);
  for (const mb of ["tag-alias", "text-ordinal"]) {
    const noW = compare(eC, measured([big(mb)]));
    const r = compare(eC, measured([big(mb)]), { waivers: [wv] });
    safe(`${mb} + size suspect: background low, cappedBy [size, match]`, () => { const d = deltaOn(noW, "21:1", /background/); return d?.severity === "low" && JSON.stringify(d.cappedBy) === '["size","match"]'; });
    safe(`${mb} + size suspect + waiver on match (size): background high → MEDIUM, cappedFrom high, cappedBy [match], verdict incomplete`, () => {
      const d = deltaOn(r, "21:1", /background/);
      return !!deltaOn(r, "21:1", /match/)?.accepted && d?.severity === "medium" && d.cappedFrom === "high" && JSON.stringify(d.cappedBy) === '["match"]' && r.verdict === "incomplete";
    });
  }
}

report();
