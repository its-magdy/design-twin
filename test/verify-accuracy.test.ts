// Verify accuracy: what the compare judges and what it only lists. Expectations come from the real `buildExpectation`
// over plugin-shaped screen exports (test/fixtures.ts, invented names): font.case lower-case ("title", "upper", "small_caps"), lineHeight {value, unit},
// autoResize lower-case, fills bound to a state token, reactions[].actions[]. Measurements are the probe's shape
// ({nodeId, styles, states.<s>.styles, matchedBy}); paintedBy / textTransform are the shipped probe's optional keys.
// Run with:  node test/verify-accuracy.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildExpectation, compare, reportToMarkdown } from "../design-to-code/verify-screen.ts";
import { publishStaged } from "../design-to-code/verify-run.ts";
import { isVerifyReport } from "../design-to-code/doc-guards.ts";
import type { ExpectInput, ExpectOptions } from "../design-to-code/verify-screen.ts";
import type { BuildIdentity, CodeInputs, VerifyReport, FontSpec, IndexRow, JsonValue, MeasuredNode, MeasuredStyles, NotComparable, Plan, VerifyDelta, VerifyMeasured, VerifyReportV2, VerifySpec } from "../design-to-code/types.ts";
import { screenExport } from "./fixtures.ts";
import type { NodeInput } from "./fixtures.ts";
import { check, report } from "./assert.ts";

const safe = (name: string, fn: () => boolean): boolean => { let r = false; try { r = fn(); } catch (e) { console.log(`    (threw: ${e instanceof Error ? e.message : String(e)})`); } return check(name, r); };

const FRAME = (children: NodeInput[]): NodeInput => ({ type: "FRAME", id: "1:1", name: "Orders", box: { x: 100, y: 50, w: 1280, h: 800 }, fills: [{ type: "solid", color: "#ffffff" }], children });
const doc = (children: NodeInput[]): ExpectInput => ({ doc: screenExport([FRAME(children)], { exportedAt: "2026-10-07T00:00:00Z", screen: "Orders", sourceFile: "Sample Kit" }), label: "Orders" });
const expect1 = (children: NodeInput[], opts?: ExpectOptions) => buildExpectation([doc(children)], opts);
const measured = (nodes: MeasuredNode[], extra?: Partial<VerifyMeasured>): VerifyMeasured => ({ measuredAt: "2026-10-07T01:00:00Z", renderer: "playwright-chromium", viewport: "1280x800", nodes, ...extra });
const node = (nodeId: string, styles: MeasuredStyles, extra?: Partial<MeasuredNode>): MeasuredNode => ({ nodeId, styles, matchedBy: "tag", ...extra });
const spec = (e: { nodes: VerifySpec[] }, id: string): VerifySpec | undefined => e.nodes.find((n) => n.nodeId === id);
const deltasOn = (r: VerifyReportV2, id: string, field: RegExp): VerifyDelta[] => r.deltas.filter((d) => d.nodeId === id && field.test(d.field));
const ncOn = (e: { notComparable: NotComparable[] }, id: string, field: string): NotComparable | undefined => e.notComparable.find((n) => n.nodeId === id && n.field === field);
const notes = (r: VerifyReportV2): string[] => r.probe.inputNotes || [];
const TXT: FontSpec = { family: "Inter", size: 14, color: "#333333", align: "left" };
const text = (id: string, name: string, t: string, font: FontSpec, extra: Partial<NodeInput> = {}): NodeInput => ({ type: "TEXT", id, name, text: t, font, ...extra });

// ---------------------------------------------------------------- 1. the RENDERED strings
console.log("Figma's text case and CSS text-transform: compare what each side renders:");
{
  const e = expect1([
    text("2:1", "Notes", "shipping notes", { ...TXT, case: "title" }),
    text("2:2", "Count", "NO. of items", { ...TXT, case: "title" }),
    text("2:3", "Save", "save", { ...TXT, case: "upper" }),
    text("2:4", "Badge", "new", { ...TXT, case: "small_caps" }),
    text("2:5", "Plain", "Order Total", TXT),
    // a fixed-width text (the width gate): ink width compared only once the copy matches
    text("2:6", "Label", "delivery date", { ...TXT, case: "title" }, { autoResize: "height", box: { w: 200, h: 20 }, renderBox: { x: 116, y: 74, w: 88, h: 11 } }),
  ]);
  safe("[1] expect: the stored string stays in `text`, the case travels as textCase (title / upper)", () =>
    spec(e, "2:1")?.text === "shipping notes" && spec(e, "2:1")?.textCase === "title" && spec(e, "2:3")?.textCase === "upper");
  safe("[1] expect: no textCase on a text without a case", () => spec(e, "2:5")?.textCase === undefined);
  safe("[1] expect: small caps → no textCase, one notComparable 'text case' row (font-variant)", () =>
    spec(e, "2:4")?.textCase === undefined && /small caps \(font-variant\) not compared/.test(ncOn(e, "2:4", "text case")?.why ?? ""));
  const run = (id: string, styles: MeasuredStyles): VerifyDelta[] => deltasOn(compare(e, measured([node(id, styles)])), id, /^text$/);
  safe("[1] built 'Shipping Notes', no transform reported → 0 text deltas (the build typed the rendered string)", () => run("2:1", { text: "Shipping Notes" }).length === 0);
  safe("[1] built 'shipping notes' + text-transform capitalize → 0 (CSS renders 'Shipping Notes')", () => run("2:1", { text: "shipping notes", textTransform: "capitalize" }).length === 0);
  safe("[1] built 'shipping notes', no transform reported → 0 (the stored string: either form passes unaided)", () => run("2:1", { text: "shipping notes" }).length === 0);
  safe("[1] built 'shipping notes' + transform none → 1 LOW naming both renderings and the stored strings", () => {
    const d = run("2:1", { text: "shipping notes", textTransform: "none" });
    const n = d[0]?.note ?? "";
    return d.length === 1 && d[0]?.severity === "low" && d[0].expected === "Shipping Notes" && d[0].actual === "shipping notes"
      && /renders 'Shipping Notes'/.test(n) && /stored 'shipping notes'/.test(n) && /text-transform none/.test(n);
  });
  // Figma TITLE lower-cases the rest ("NO. of" → "No. Of"); CSS capitalize keeps it ("NO. of" → "NO. Of")
  safe("[1] 'NO. of items' title vs built 'No. of items' (no transform) → one LOW (designed renders 'No. Of Items')", () => {
    const d = run("2:2", { text: "No. of items" });
    return d.length === 1 && d[0]?.severity === "low" && d[0].expected === "No. Of Items";
  });
  safe("[1] 'NO. of items' title vs built 'NO. of items' + capitalize → one LOW ('NO. Of Items' vs 'No. Of Items')", () => {
    const d = run("2:2", { text: "NO. of items", textTransform: "capitalize" });
    return d.length === 1 && d[0]?.severity === "low" && d[0].actual === "NO. Of Items";
  });
  safe("[1] upper: 'save' + uppercase → 0; 'SAVE' unaided → 0; 'Save' + none → one LOW", () =>
    run("2:3", { text: "save", textTransform: "uppercase" }).length === 0 && run("2:3", { text: "SAVE" }).length === 0
    && run("2:3", { text: "Save", textTransform: "none" }).length === 1);
  safe("[1] a real copy change under a case is still HIGH", () => run("2:1", { text: "Billing Notes", textTransform: "none" })[0]?.severity === "high");
  safe("[1] no case anywhere: a case-only difference keeps today's low + text-transform hint", () => {
    const d = run("2:5", { text: "ORDER TOTAL" });
    return d.length === 1 && d[0]?.severity === "low" && /^differs only in case — check for a text-transform/.test(d[0].note ?? "");
  });
  safe("[1] width agrees: the rendered copy matches → the ink width is compared (no 'text differs' gap, no width delta)", () => {
    const r = compare(e, measured([node("2:6", { text: "Delivery Date", textBox: { x: 16, w: 88.5 } })]));
    return !r.fieldsNotMeasured.some((g) => g.nodeId === "2:6" && /text differs/.test(g.why)) && deltasOn(r, "2:6", /width|text/).length === 0;
  });
}

// ---------------------------------------------------------------- 2. line box taller than the text box
console.log("a line box taller than its fixed text box:");
{
  const lh = (v: number): FontSpec => ({ ...TXT, lineHeight: { value: v, unit: "px" } });
  const e = expect1([
    text("3:1", "Description", "Remove this item from the order?", lh(28), { box: { w: 320, h: 24 }, renderBox: { x: 120, y: 80, w: 300, h: 17 } }),
    text("3:2", "Fits", "Fits in its box", lh(20), { box: { w: 320, h: 24 }, renderBox: { x: 120, y: 80, w: 100, h: 17 } }),
    text("3:3", "Hug height", "Grows with its lines", lh(28), { autoResize: "height", box: { w: 320, h: 24 }, renderBox: { x: 120, y: 80, w: 140, h: 17 } }),
  ]);
  const row = ncOn(e, "3:1", "text box height");
  safe("[2] 28px line in a fixed 24px box → notComparable 'text box height' = 24, naming 28 and 24 and the build's choice", () =>
    !!row && row.value === 24 && /28px/.test(row.why) && /24px/.test(row.why) && /line-height 28/.test(row.why) && /TEXT height is not compared/.test(row.why));
  safe("[2] 20px line in a 24px box → no row", () => ncOn(e, "3:2", "text box height") === undefined);
  safe("[2] hug height (autoResize height) → no row", () => ncOn(e, "3:3", "text box height") === undefined);
  safe("[2] compare: a line-height delta on that node carries the same note", () => {
    const d = deltasOn(compare(e, measured([node("3:1", { lineHeight: 24 })])), "3:1", /^line-height$/);
    return d.length === 1 && /taller than the fixed text box/.test(d[0]?.note ?? "");
  });
}

// ---------------------------------------------------------------- 3. misplaced / unused states
console.log("states beside styles, and states on a node whose design draws none:");
{
  const e = expect1([
    { type: "FRAME", id: "4:1", name: "Row", fills: [{ type: "solid", color: "#46464f", tokens: { color: "Backgrounds/Row Hover" } }], box: { x: 100, y: 100, w: 600, h: 48 } },
    { type: "INSTANCE", id: "4:2", name: "Header Button", fills: [{ type: "solid", color: "#121319" }], box: { x: 100, y: 60, w: 120, h: 36 } },
  ]);
  safe("[3] expect: the row is drawn hovered (own), the button is not", () => spec(e, "4:1")?.drawnState === "hover" && spec(e, "4:2")?.drawnState === undefined);
  // the hover block INSIDE styles (the misplaced-state shape) — never read
  const misplaced = node("4:1", { backgroundColor: "rgb(18, 19, 25)", width: 600, height: 48, x: 0, y: 50 });
  const styles = misplaced.styles;
  if (styles) styles.states = { hover: { styles: { backgroundColor: "rgb(70, 70, 79)" } } };
  const r = compare(e, measured([misplaced]));
  safe("[3] styles.states → listed as an unknown key with the hint 'nodes[].states (beside styles, not inside)'", () =>
    r.probe.unknownKeys.some((k) => k.key === "states" && k.canonical === "nodes[].states (beside styles, not inside)"));
  safe("[3] …and never read: the row's hover background is still not measured (the drawnState gap stays)", () =>
    r.fieldsNotMeasured.some((g) => g.nodeId === "4:1" && g.field === "background" && /hover/.test(g.why)) && deltasOn(r, "4:1", /background/).length === 0);
  safe("[3] any node-level key inside styles is listed with its place (styles.fillSource); free-text styles.note is tolerated", () => {
    const r3 = compare(e, measured([node("4:2", { backgroundColor: "rgb(18, 19, 25)", fillSource: "element", note: "matched by its label" })]));
    return r3.probe.unknownKeys.some((k) => k.key === "fillSource" && k.canonical === "nodes[].fillSource (beside styles, not inside)") && !r3.probe.unknownKeys.some((k) => k.key === "note");
  });
  safe("[3] the markdown names the canonical place", () => /`states`.*nodes\[\]\.states \(beside styles, not inside\)/.test(reportToMarkdown(r)));
  // states measured on a node whose design draws no state (an agent hovered a header button)
  const r2 = compare(e, measured([node("4:2", { backgroundColor: "rgb(18, 19, 25)" }, { states: { hover: { styles: { backgroundColor: "rgb(1, 2, 3)" } } } })]));
  safe("[3] states on a non-drawn spec → one input note, not compared (no background delta from the hover value)", () =>
    notes(r2).some((n) => /^states\.hover measured on 1 node\(s\) whose design draws no hover state — not compared/.test(n)) && deltasOn(r2, "4:2", /background/).length === 0);
  safe("[3] …and one Inferred row (undrawn-state, the node, state hover)", () =>
    (r2.inferred || []).length === 1 && r2.inferred?.[0]?.kind === "undrawn-state" && r2.inferred[0].nodeId === "4:2" && r2.inferred[0].state === "hover");
}

// ---------------------------------------------------------------- 4. compare: who paints the background
console.log("a transparent element whose background another element paints:");
{
  const e = expect1([{ type: "FRAME", id: "5:1", name: "Cell", fills: [{ type: "solid", color: "#46464f", tokens: { color: "Backgrounds/Row Hover" } }], box: { x: 100, y: 100, w: 200, h: 48 } }]);
  const hovered = (styles: MeasuredStyles): MeasuredNode => node("5:1", { backgroundColor: "rgb(18, 19, 25)", width: 200, height: 48, x: 0, y: 50 }, { states: { hover: { styles } } });
  const bg = (styles: MeasuredStyles): VerifyDelta[] => deltasOn(compare(e, measured([hovered(styles)])), "5:1", /^background$/);
  const TRANSPARENT = "rgba(0, 0, 0, 0)";
  const r = compare(e, measured([hovered({ backgroundColor: TRANSPARENT, paintedBy: { backgroundColor: "rgb(70, 70, 79)", via: "ancestor", tag: "tr", depth: 1 } })]));
  safe("[4] own rgba(0,0,0,0), paintedBy rgb(70,70,79) (= #46464f) → 0 background deltas", () => deltasOn(r, "5:1", /^background$/).length === 0);
  safe("[4] …and one input note naming the painter", () => notes(r).some((n) => /paintedBy/.test(n) && /5:1 by its ancestor <tr>/.test(n)));
  safe("[4] paintedBy rgb(1,2,3) → HIGH, actual = the painted colour, note 'painted by its <tr>'", () => {
    const d = bg({ backgroundColor: TRANSPARENT, paintedBy: { backgroundColor: "rgb(1, 2, 3)", via: "ancestor", tag: "tr", depth: 1 } });
    return d.length === 1 && d[0]?.severity === "high" && d[0].actual === "#010203ff" && /painted by its <tr>/.test(d[0].note ?? "");
  });
  safe("[4] no paintedBy (a hand-written probe) → HIGH with actual transparent, as before", () => {
    const d = bg({ backgroundColor: TRANSPARENT });
    return d.length === 1 && d[0]?.severity === "high" && d[0].actual === "transparent";
  });
  safe("[4] a RESTING paintedBy never stands in for the hovered pass", () => {
    const m = node("5:1", { backgroundColor: TRANSPARENT, paintedBy: { backgroundColor: "rgb(70, 70, 79)", via: "ancestor", tag: "tr", depth: 1 } }, { states: { hover: { styles: { backgroundColor: TRANSPARENT } } } });
    return deltasOn(compare(e, measured([m])), "5:1", /^background$/).length === 1;
  });
  safe("[4] a same-box child that paints → no delta", () => bg({ backgroundColor: TRANSPARENT, paintedBy: { backgroundColor: "#46464f", via: "child", tag: "div", depth: 1 } }).length === 0);
}

// ---------------------------------------------------------------- 5. expect: whose drawn state
console.log("the expectation records the OWNER of an inherited drawn state:");
{
  const e = expect1([{ type: "FRAME", id: "6:1", name: "Row", fills: [{ type: "solid", color: "#46464f", tokens: { color: "Backgrounds/Row Hover" } }], box: { x: 100, y: 100, w: 600, h: 48 },
    children: [
      { type: "FRAME", id: "6:2", name: "Actions", box: { x: 500, y: 108, w: 80, h: 32 }, children: [
        { type: "INSTANCE", id: "6:3", name: "Delete Button", fills: [{ type: "solid", color: "#292931" }], box: { x: 540, y: 108, w: 32, h: 32 } },
      ] },
    ] }]);
  safe("[5] a control inside the hovered row → drawnStateFrom = the row's id (the owner), also through a wrapper", () =>
    spec(e, "6:3")?.drawnState === "hover" && spec(e, "6:3")?.drawnStateFrom === "6:1");
  safe("[5] the row drawn in its own state → no drawnStateFrom (absent = itself)", () => spec(e, "6:1")?.drawnStateOwn === true && spec(e, "6:1")?.drawnStateFrom === undefined);
  safe("[5] the why still names the owner by name", () => /inside 'Row'/.test(spec(e, "6:3")?.drawnStateWhy ?? ""));
}

// ---------------------------------------------------------------- 8. Inferred, not designed
console.log("what the build does that the design never drew, listed and never graded:");
{
  const INDEX: { layers: IndexRow[] } = { layers: [{ id: "1:1", name: "Orders", file: "pages/Main/Orders__1_1.json", sourceFile: "Sample Kit" }] };
  const plan: Plan = { nodeId: "1:1", interactions: [{ nodeId: "7:2", trigger: "on_click", expect: "url" }] };
  const e = expect1([
    { type: "INSTANCE", id: "7:1", name: "Share", fills: [{ type: "solid", color: "#121319" }], box: { x: 100, y: 100, w: 80, h: 32 },
      reactions: [{ trigger: "on_click", actions: [{ type: "node", navigation: "overlay", destinationId: "9:9" }] }] },
    { type: "INSTANCE", id: "7:2", name: "Help Link", fills: [{ type: "solid", color: "#121319" }], box: { x: 200, y: 100, w: 80, h: 32 } },
  ], { index: INDEX, plan: { file: "design/plan/Orders__1_1.json", plan } });
  safe("[8] setup: one undesigned destination, one plan-declared interaction", () =>
    e.interactions.some((i) => i.nodeId === "7:1" && i.destinationExported === false) && e.interactions.some((i) => i.nodeId === "7:2" && i.source === "plan"));
  const base = [node("7:1", { backgroundColor: "#121319" }), node("7:2", { backgroundColor: "#121319" })];
  const agent: JsonValue = [{ nodeId: "7:2", state: "error", built: "an inline error under the field", why: "the design draws no error copy" }];
  const withRows = compare(e, Object.assign(measured(base), { inferred: agent }));
  const without = compare(e, measured(base));
  const inf = withRows.inferred || [];
  safe("[8] report.inferred: plan-declared + undesigned + agent row = 3", () =>
    inf.length === 3 && inf.some((x) => x.kind === "plan-interaction" && x.nodeId === "7:2") && inf.some((x) => x.kind === "undesigned-interaction" && x.nodeId === "7:1" && /9:9/.test(x.why))
    && inf.some((x) => x.kind === "agent" && x.state === "error" && x.name === "Help Link"));
  // the undesigned interaction is already in the headline's "1 undesigned" — counted once
  safe("[8] summary.inferred 3 (rows); the headline counts each thing once: '1 undesigned' + '· 2 inferred (not designed; the 1 undesigned … counted above)'", () =>
    withRows.summary.inferred === 3 && /, 1 undesigned of 2 · /.test(withRows.headline)
    && / · 2 inferred \(not designed; the 1 undesigned interaction\(s\) are counted above\)/.test(withRows.headline) && !/ · 3 inferred/.test(withRows.headline));
  safe("[8] markdown: '## Inferred, not designed (3)' with the best-practice line, after 'Interactions not graded'", () => {
    const md = reportToMarkdown(withRows);
    const at = md.indexOf("## Inferred, not designed (3)");
    return at > 0 && md.indexOf("## Interactions not graded") < at && /judged against best practice and the design's intent, never 'matched'/.test(md);
  });
  safe("[8] never the verdict: verdict and why[] identical with and without the agent rows", () =>
    withRows.verdict === without.verdict && JSON.stringify(withRows.why) === JSON.stringify(without.why) && !withRows.why.some((w) => /inferred/i.test(w)));
  safe("[8] the evidence file's inferred[] counts too (compare opts.inferred)", () =>
    (compare(e, measured(base), { inferred: agent }).inferred || []).filter((x) => x.kind === "agent").length === 1);
  safe("[8] a malformed agent row (no built) → an input note, not a row; a non-list → a note", () => {
    const r = compare(e, Object.assign(measured(base), { inferred: [{ state: "empty" }] }), { inferred: { state: "x" } });
    return (r.inferred || []).every((x) => x.kind !== "agent") && notes(r).some((n) => /inferred\[0\] is not \{nodeId\?, state, built, why\?\}/.test(n))
      && notes(r).some((n) => /inferred is not a list/.test(n));
  });
  safe("[8] an agent row naming a node in the expectation → no unknown-id note", () => !notes(withRows).some((n) => /node id\(s\) not in this expectation/.test(n)));
  safe("[8][queued] agent rows whose nodeId matches no spec → ONE input note naming them (rows still listed)", () => {
    const r = compare(e, Object.assign(measured(base), { inferred: [{ nodeId: "99:1", state: "empty", built: "an empty list" }, { nodeId: "99:2", state: "error", built: "a toast" }] }), { inferred: [{ nodeId: "99:1", state: "x", built: "y" }] });
    const hits = notes(r).filter((n) => /inferred\[\] row\(s\) name 2 node id\(s\) not in this expectation: 99:1, 99:2/.test(n));
    return hits.length === 1 && (r.inferred || []).filter((x) => x.kind === "agent").length === 3;
  });
  safe("[8] measured.inferred is a known top-level key (not listed as unknown)", () => !(withRows.probe.unknownTopLevelKeys || []).some((k) => k.key === "inferred"));
}

// ---------------------------------------------------------------- 12. the reference is illustrative
console.log("a plan deviation that marks the reference PNG illustrative:");
{
  const e = expect1([{ type: "FRAME", id: "8:1", name: "Chart", fills: [{ type: "solid", color: "#121319" }], box: { x: 100, y: 100, w: 400, h: 200 } }]);
  const m = measured([node("8:1", { backgroundColor: "#ffffff" })]);
  const plan: Plan = { nodeId: "1:1", deviations: [{ nodeId: "8:1", field: "reference", designed: "a sample chart", built: "the live chart", reason: "the designer drew placeholder data" }] };
  const withDev = compare(e, m, { plan: { file: "design/plan/Orders__1_1.json", plan, choice: "only" } });
  const plain = compare(e, m, { plan: { file: "design/plan/Orders__1_1.json", plan: { nodeId: "1:1" }, choice: "only" } });
  safe("[12] report.visual.illustrative: one row {nodeId, reason}", () =>
    withDev.visual.illustrative?.length === 1 && withDev.visual.illustrative[0]?.nodeId === "8:1" && withDev.visual.illustrative[0].reason === "the designer drew placeholder data");
  safe("[12] the VISUAL line says so; an input note names the plan", () =>
    /\(the plan marks the reference illustrative for 1 node\(s\)\)$/.test(withDev.visual.headline) && notes(withDev).some((n) => /Orders__1_1\.json marks the reference PNG illustrative/.test(n)));
  safe("[12] never waives: deltas, counts and verdict identical to the run without it", () =>
    JSON.stringify(withDev.summary) === JSON.stringify(plain.summary) && withDev.verdict === plain.verdict && withDev.deltas.length === plain.deltas.length && withDev.deltas.every((d) => !d.accepted));
}

// ---------------------------------------------------------------- the same build served
console.log("the same build served, publish, limits:");
{
  // the first --compare after the upgrade — the new report also hashes a mapped module the previous one never
  // recorded. Only the files BOTH hashed say whether the code changed.
  const e = expect1([{ type: "FRAME", id: "9:1", name: "Panel", fills: [{ type: "solid", color: "#121319" }], box: { x: 100, y: 100, w: 400, h: 200 } }]);
  const build: BuildIdentity = { url: "http://127.0.0.1:4173/", mode: "static", assets: 3, assetsSha256: "b1", gitHead: "a".repeat(40), gitDirty: false };
  const m = measured([node("9:1", { backgroundColor: "#121319" })], { build });
  const code = (files: Record<string, string | null>): CodeInputs => ({ plan: "design/plan/Orders__1_1.json", files, gitHead: "a".repeat(40) });
  const asPrev = (r: VerifyReportV2): VerifyReport => { const v: unknown = JSON.parse(JSON.stringify(r)); if (!isVerifyReport(v)) throw new Error("not a report"); return v; };
  const prev = asPrev(compare(e, m, { code: code({ "src/Orders.tsx": "h1" }) }));
  const upgraded = compare(e, m, { code: code({ "src/Orders.tsx": "h1", "src/shell/Shell.tsx": "s1" }), against: { file: "prev.report.json", report: prev } });
  safe("same build, the same hash for every file both reports recorded, plus a newly hashed mapped module → no 'SAME BUILD SERVED'", () =>
    upgraded.against?.sameBuild === true && !/SAME BUILD SERVED/.test(upgraded.headline));
  const edited = compare(e, m, { code: code({ "src/Orders.tsx": "h2", "src/shell/Shell.tsx": "s1" }), against: { file: "prev.report.json", report: prev } });
  safe("control: a file both recorded changed while the build is the same → 'SAME BUILD SERVED … although the code changed'", () =>
    /SAME BUILD SERVED as prev\.report\.json although the code changed/.test(edited.headline));
  const dropped = compare(e, m, { code: code({ "src/Other.tsx": "o1" }), against: { file: "prev.report.json", report: prev } });
  safe("no file in common → the git commits decide (same commit: no warning)", () => !/SAME BUILD SERVED/.test(dropped.headline));

  // the overlay known miss is stated in the report's limits
  safe("report.limits names paintedBy's overlay miss ('may PASS') and the children-paint case", () =>
    prev.limits !== undefined && prev.limits.some((l) => /paintedBy/.test(l) && /overlay/.test(l) && /may PASS/.test(l) && /children paint all of it gets no painter/.test(l)));

  // --expect keeps <S>.expected.prev.json — a staged copy of one must never be published over it
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-acc-"));
  const stage = path.join(tmp, "stage"), dest = path.join(tmp, "design", "verify");
  fs.mkdirSync(stage, { recursive: true }); fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(stage, "Orders.evidence.json"), "{}");
  fs.writeFileSync(path.join(stage, "Orders.expected.prev.json"), "{\"staged\": true}");
  fs.writeFileSync(path.join(dest, "Orders.expected.prev.json"), "{\"kept\": true}");
  const pub = publishStaged(stage, dest);
  safe("a stage dir holding a .prev.json → refused (tool-written), nothing copied", () =>
    "error" in pub && /Orders\.expected\.prev\.json/.test(pub.error) && fs.readFileSync(path.join(dest, "Orders.expected.prev.json"), "utf8") === "{\"kept\": true}" && !fs.existsSync(path.join(dest, "Orders.evidence.json")));
  fs.rmSync(tmp, { recursive: true, force: true });
}

report();
