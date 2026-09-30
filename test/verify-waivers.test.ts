// Group 9 — the deviation registry, waivers and grouping (DT-28, F-60, F-61, F-76, F-77, F-103, F-104; owner
// decisions D5, D20–D23). Expectations come from the real `buildExpectation` over a plugin-shaped screen export
// (test/fixtures.ts, invented names); plans have the real Plan shape (design-to-code/types.ts). The last block
// runs the CLI (--expect / --compare / --accept) in a temp project.
// Run with:  node test/verify-waivers.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { buildExpectation, compare, reportToMarkdown, STYLE_KEYS } from "../design-to-code/verify-screen.ts";
import type { CompareOptions, ExpectInput, ExpectOptions } from "../design-to-code/verify-screen.ts";
import { isPassingVerdict, waiversHash } from "../design-to-code/plan-waivers.ts";
import { isPlan, isVerifyExpectation, isVerifyReport } from "../design-to-code/doc-guards.ts";
import { readJsonOrNull } from "../design-to-code/read-json.ts";
import type { InteractionEvidence, JsonValue, MeasuredNode, MeasuredStyles, Plan, PlanDescope, PlanWaiver, ProbeFrame, VerifyMeasured, VerifyReportV2, VerifySpec } from "../design-to-code/types.ts";
import { isJsonObject } from "../design-to-code/types.ts";
import { screenExport } from "./fixtures.ts";
import type { NodeInput } from "./fixtures.ts";
import { check, report } from "./assert.ts";

const safe = (name: string, fn: () => boolean): boolean => { let r = false; try { r = fn(); } catch (e) { console.log(`    (threw: ${e instanceof Error ? e.message : String(e)})`); } return check(name, r); };

// ---------------------------------------------------------------- the screen (invented names)
const row = (n: number, date: string, action: string): NodeInput => ({
  type: "INSTANCE", id: `I2:7${n};5:1`, name: "Order Row", mainComponent: { name: "Order Row", key: "k-order-row", setName: "Order Row" },
  children: [
    { type: "TEXT", id: `I2:7${n};5:2`, name: "Date", text: date, font: { family: "Inter", size: 14, color: "#333333" } },
    { type: "TEXT", id: `I2:7${n};5:3`, name: "Action", text: action, font: { family: "Inter", size: 14, color: "#333333" } },
  ],
});
const SCREEN: NodeInput = {
  type: "FRAME", id: "1:1", name: "Orders", box: { x: 0, y: 0, w: 1280, h: 800 }, children: [
    { type: "TEXT", id: "2:1", name: "Title", text: "Orders", font: { family: "Inter", size: 14, color: "#111111" } },
    { type: "FRAME", id: "2:2", name: "Footer", box: { x: 0, y: 720, w: 1280, h: 80 }, fills: [{ type: "solid", color: "#fafafa" }], children: [
      { type: "FRAME", id: "2:21", name: "Links", box: { x: 16, y: 736, w: 200, h: 40 }, fills: [{ type: "solid", color: "#eeeeee" }] },
      { type: "FRAME", id: "2:22", name: "Legal", box: { x: 400, y: 736, w: 200, h: 40 }, fills: [{ type: "solid", color: "#eeeeee" }] },
      { type: "FRAME", id: "2:23", name: "Social", box: { x: 800, y: 736, w: 200, h: 40 }, fills: [{ type: "solid", color: "#eeeeee" }] },
    ] },
    { type: "FRAME", id: "2:8", name: "Panel", fills: [{ type: "solid", color: "#ffffff" }], children: [
      { type: "FRAME", id: "2:3", name: "Wrap", layout: { display: "flex", flexDirection: "column", padding: [8, 8, 8, 8] }, children: [
        { type: "TEXT", id: "2:31", name: "Filters", text: "Filters", font: { family: "Inter", size: 12, color: "#222222" } },
      ] },
    ] },
    { type: "FRAME", id: "2:4", name: "Export", fills: [{ type: "solid", color: "#0000ff" }], reactions: [{ trigger: "on_click", actions: [{ type: "NODE", navigation: "navigate", destinationId: "9:9" }] }] },
    { type: "FRAME", id: "2:5", name: "Open", fills: [{ type: "solid", color: "#00aa00" }], reactions: [{ trigger: "on_click", actions: [{ type: "NODE", navigation: "navigate", destinationId: "1:50" }] }] },
    { type: "FRAME", id: "2:6", name: "Help Badge", absolute: true, box: { x: 1200, y: 700, w: 40, h: 40 }, fills: [{ type: "solid", color: "#ff0000" }] },
    { type: "FRAME", id: "2:7", name: "Order List", children: [row(1, "14 Feb, 2026", "Delete"), row(2, "14 Feb, 2026", "Delete"), row(3, "14 Feb, 2026", "Delete"), row(4, "14 Feb, 2026", "Delete")] },
  ],
};
const doc = (sourceFile = "Sample Kit"): ExpectInput => ({ doc: screenExport([SCREEN], { exportedAt: "2026-09-30T00:00:00Z", screen: "Orders", sourceFile }), label: "Orders" });
// pages/index.json layers: 1:50 exported from this file; 9:9 exists only in ANOTHER file (ids are per file)
// (a real index always lists the screen itself — 1:1 — which is how compare knows the index covers this file)
const INDEX: ExpectOptions = { index: { layers: [
  { id: "1:1", name: "Orders", file: "pages/Main/Orders__1_1.json", sourceFile: "Sample Kit" },
  { id: "1:50", name: "Order Details", file: "pages/Main/Order_Details__1_50.json", sourceFile: "Sample Kit" },
  { id: "9:9", name: "Export Dialog", file: "pages/Main/Export_Dialog__9_9.json", sourceFile: "Other Kit" },
], sourceFile: "Sample Kit" } };
const exp = buildExpectation([doc()], INDEX);
const SHA = exp.exportContentSha256;

// A measurement that echoes every stated value (a perfect build), then per-test overrides.
function echo(spec: VerifySpec): MeasuredNode {
  const styles: MeasuredStyles = {};
  const src: Record<string, unknown> = { ...spec };
  for (const k of STYLE_KEYS) { const v = src[k]; if (v !== undefined) styles[k] = v; }
  return { nodeId: spec.nodeId, styles, matchedBy: "tag" };
}
type Over = Record<string, MeasuredStyles | null>; // null = not measured
const VIEWPORT: ProbeFrame = { nodeId: "1:1", selector: "body", via: "viewport", rect: { x: 0, y: 0, w: 1280, h: 1400 } };
// (D24/F-102: a pass needs an outcome the action produces and no navigation during it)
const works = (nodeId: string): InteractionEvidence => ({ nodeId, trigger: "on_click", ok: true, selector: `[data-dt-node="${nodeId}"]`, selectorCount: 1, outcome: "selector-appeared", navEvents: 0 });
function measure(over: Over = {}, extra: Partial<VerifyMeasured> = {}): VerifyMeasured {
  const nodes: MeasuredNode[] = [];
  for (const s of exp.nodes) {
    const o = over[s.nodeId];
    if (o === null) continue;
    const m = echo(s);
    nodes.push({ ...m, styles: { ...m.styles, ...(o || {}) } });
  }
  return { measuredAt: "2026-09-30T01:00:00Z", renderer: "playwright-chromium", viewport: "1280x800", nodes, interactions: [works("2:4"), works("2:5")], ...extra };
}
const waiver = (w: Partial<PlanWaiver> & { nodeId: string; field: string; designed: JsonValue; built: JsonValue }): PlanWaiver =>
  ({ exportContentSha256: SHA, reason: "the wider type reads better on the dense table", decidedBy: "Sam Doe", decidedAt: "2026-09-30T02:00:00Z", ...w });
const run = (m: VerifyMeasured, o: CompareOptions = {}): VerifyReportV2 => compare(exp, m, o);
const delta = (r: VerifyReportV2, id: string, field: string) => r.deltas.find((d) => d.nodeId === id && d.field === field);
const ia = (r: VerifyReportV2, id: string) => r.interactions.find((i) => i.nodeId === id);

// ---------------------------------------------------------------- baseline
console.log("baseline — a perfect build passes:");
const base = run(measure());
safe("the echo build passes (nothing open, nothing accepted) → plain 'pass'", () => base.verdict === "pass" && base.why.length === 0);
safe("PASSING_VERDICTS: pass and pass-with-deviations pass; fail/incomplete do not", () =>
  isPassingVerdict("pass") && isPassingVerdict("pass-with-deviations") && !isPassingVerdict("fail") && !isPassingVerdict("incomplete") && !isPassingVerdict(undefined));

// ---------------------------------------------------------------- DT-28 / D5 / D21 waivers
console.log("DT-28 / D5 — a waiver accepts one delta, bound to export + designed + built:");
{
  const m = measure({ "2:1": { fontSize: 16 } });
  const open = run(m);
  safe("without a waiver: font-size 14 → 16 is high, verdict fail", () => open.verdict === "fail" && delta(open, "2:1", "font-size")?.severity === "high");
  const r = run(m, { waivers: [waiver({ nodeId: "2:1", field: "font-size", designed: 14, built: 16 })] });
  const d = delta(r, "2:1", "font-size");
  safe("with a matching waiver: verdict pass-with-deviations", () => r.verdict === "pass-with-deviations" && r.why.length === 0);
  safe("…the delta stays listed, marked accepted {reason, decidedBy, decidedAt}", () => !!d && !!d.accepted && d.accepted.decidedBy === "Sam Doe" && /dense table/.test(d.accepted.reason));
  safe("…and leaves the counts: summary.high 0, summary.accepted 1, coverage.deltasAccepted 1, waivers.applied 1", () =>
    r.summary.high === 0 && r.summary.accepted === 1 && r.coverage.deltasAccepted === 1 && r.waivers.applied === 1);
  safe("…headline says PASS-WITH-DEVIATIONS and '1 accepted'", () => /^PASS-WITH-DEVIATIONS — /.test(r.headline) && /1 accepted/.test(r.headline));
  safe("…report.md marks the row accepted", () => /accepted — the wider type/.test(reportToMarkdown(r)));

  const moved = run(measure({ "2:1": { fontSize: 18 } }), { waivers: [waiver({ nodeId: "2:1", field: "font-size", designed: 14, built: 16 })] });
  safe("built value moved (16 → 18): reopened 'built value moved: was 16, now 18', delta open, verdict fail", () =>
    moved.verdict === "fail" && !delta(moved, "2:1", "font-size")?.accepted && moved.waivers.reopened.some((w) => w.nodeId === "2:1" && /built value moved: was 16, now 18/.test(w.why)));
  const within = run(measure({ "2:1": { fontSize: 16.4 } }), { waivers: [waiver({ nodeId: "2:1", field: "font-size", designed: 14, built: 16 })] });
  safe("built value within the field's tolerance (16 → 16.4, tol 0.5): still accepted", () => within.verdict === "pass-with-deviations");
  const reexported = run(m, { waivers: [waiver({ nodeId: "2:1", field: "font-size", designed: 14, built: 16, exportContentSha256: "f".repeat(64) })] });
  safe("export content hash differs (D21: every re-export): reopened 'design re-exported', verdict fail", () =>
    reexported.verdict === "fail" && reexported.waivers.reopened.some((w) => /design re-exported/.test(w.why)));
  const redesigned = run(m, { waivers: [waiver({ nodeId: "2:1", field: "font-size", designed: 12, built: 16 })] });
  safe("designed value differs: reopened 'designed value changed: was 12, now 14'", () => redesigned.waivers.reopened.some((w) => /designed value changed: was 12, now 14/.test(w.why)) && redesigned.verdict === "fail");
  const unusedR = run(measure(), { waivers: [waiver({ nodeId: "2:1", field: "font-size", designed: 14, built: 16 })] });
  safe("a waiver that matches no delta (fixed): listed under waivers.unused, verdict plain pass", () =>
    unusedR.verdict === "pass" && unusedR.waivers.unused.some((w) => w.nodeId === "2:1" && w.field === "font-size"));
  const bad = run(m, { waivers: [waiver({ nodeId: "2:1", field: "font-size", designed: 14, built: 16, reason: "" })] });
  safe("a waiver with no reason is ignored (noted), not applied", () => bad.verdict === "fail" && (bad.probe.inputNotes || []).some((n) => /waivers\[0\]/.test(n)));
}
{
  // never waivable: an absent component, a failed interaction
  const absent = run(measure(), { components: [{ setName: "Order Row", present: false }], waivers: [waiver({ nodeId: "I2:71;5:1", field: "presence", designed: true, built: false })] });
  safe("[D5] a waiver on an ABSENT component is ignored (unused, says why); verdict fail", () =>
    absent.verdict === "fail" && absent.waivers.applied === 0 && absent.waivers.unused.some((w) => w.nodeId === "I2:71;5:1" && /never waivable/.test(w.why || "")));
  const failedM = measure({}, { interactions: [works("2:4"), { nodeId: "2:5", trigger: "on_click", ok: false, selector: '[data-dt-node="2:5"]', selectorCount: 1, detail: "nothing happened" }] });
  const failed = run(failedM, { waivers: [waiver({ nodeId: "2:5", field: "interaction", designed: "navigate", built: "nothing" })] });
  safe("[D5] a waiver on a FAILED interaction is ignored; it stays fail", () =>
    failed.verdict === "fail" && ia(failed, "2:5")?.result === "fail" && failed.waivers.unused.some((w) => w.nodeId === "2:5" && /failed interaction/.test(w.why || "")));

  // D20 descopes
  const descope = (d: Partial<PlanDescope> = {}): PlanDescope => ({ nodeId: "2:5", trigger: "on_click", exportContentSha256: SHA, reason: "details page ships next release", decidedBy: "Sam Doe", decidedAt: "2026-09-30T02:00:00Z", ...d });
  const ds = run(failedM, { descopes: [descope()] });
  safe("[D20] a descoped interaction is removed before grading → result 'descoped', verdict pass-with-deviations", () =>
    ia(ds, "2:5")?.result === "descoped" && ds.verdict === "pass-with-deviations" && ds.coverage.interactionsDescoped === 1 && ds.coverage.interactionsFailed === 0);
  safe("[D20] …headline counts it ('1 descoped')", () => /1 descoped/.test(ds.headline));
  const dsWorks = run(measure(), { descopes: [descope()] });
  safe("[D20] descoped but the probe drove it fine → still descoped, note 'descoped but works'", () => ia(dsWorks, "2:5")?.result === "descoped" && /descoped but works/.test(ia(dsWorks, "2:5")?.note || ""));
  const dsStale = run(failedM, { descopes: [descope({ exportContentSha256: "0".repeat(64) })] });
  safe("[D20] a descope from an older export is not applied (reopened) → fail", () => dsStale.verdict === "fail" && dsStale.waivers.reopened.some((w) => w.nodeId === "2:5"));
  const dsDest = run(failedM, { descopes: [descope({ destinationId: "7:7" })] });
  safe("[D20] a descope naming another destination does not match", () => ia(dsDest, "2:5")?.result === "fail");
}

// ---------------------------------------------------------------- F-60 / D22 undesigned destinations
console.log("F-60 / D22 — an interaction whose destination was never exported:");
{
  const i4 = exp.interactions.find((i) => i.nodeId === "2:4"), i5 = exp.interactions.find((i) => i.nodeId === "2:5");
  safe("--expect: 9:9 is only in ANOTHER file's index rows → destinationExported:false", () => i4?.destinationExported === false);
  safe("--expect: 1:50 is in this file's index → not marked", () => !!i5 && i5.destinationExported === undefined);
  const noIndex = buildExpectation([doc()]);
  safe("--expect without an index: nothing is marked (unknown, graded as before)", () => noIndex.interactions.every((i) => i.destinationExported === undefined));
  const noFile = buildExpectation([doc("")], INDEX);
  safe("--expect when the screen names no source file but the index does: nothing is marked (never join ids across files)", () => noFile.interactions.every((i) => i.destinationExported === undefined));
  // the field tests' real shape: an export written before the bridge stamped sourceFile — neither the screen nor
  // any index row names a file, so the index is one (unnamed) file and its ids can be looked up
  const unnamed = buildExpectation([{ doc: screenExport([SCREEN], { exportedAt: "2026-09-30T00:00:00Z", screen: "Orders" }), label: "Orders" }],
    { index: { layers: [{ id: "1:1", name: "Orders", file: "pages/Main/Orders__1_1.json" }, { id: "1:50", name: "Order Details", file: "pages/Main/Order_Details__1_50.json" }] } });
  // review H2: the screen names its file, the index rows do not (mixed) → never decided
  const mixed = buildExpectation([doc()], { index: { layers: [{ id: "1:1", name: "Orders", file: "pages/Main/Orders__1_1.json" }, { id: "1:50", name: "Order Details", file: "pages/Main/Order_Details__1_50.json" }] } });
  safe("[review H2] screen names its file, index rows name none → nothing marked (1:50 IS exported)", () => mixed.interactions.every((i) => i.destinationExported === undefined));
  // review H2: a merged index — an older page walk wrote rows with no sourceFile, a newer pull one with it
  const merged = buildExpectation([doc()], { index: { layers: [{ id: "1:1", name: "Orders", file: "pages/Main/Orders__1_1.json", sourceFile: "Sample Kit" }, { id: "1:50", name: "Order Details", file: "pages/Main/Order_Details__1_50.json" }] } });
  safe("[review H2] some index rows name a file, some do not → nothing marked (1:50 may be this file's)", () => merged.interactions.every((i) => i.destinationExported === undefined));
  // review: an index that covers only ANOTHER file says nothing about this screen's destinations
  const other = buildExpectation([doc()], { index: { layers: [{ id: "9:9", name: "Export Dialog", file: "pages/Other/Export_Dialog__9_9.json", sourceFile: "Other Kit" }] } });
  safe("[review] an index with no row of this screen's file → nothing marked", () => other.interactions.every((i) => i.destinationExported === undefined));
  safe("--expect: no file named anywhere (one unnamed file) → 9:9 marked destinationExported:false, 1:50 not", () =>
    unnamed.interactions.find((i) => i.nodeId === "2:4")?.destinationExported === false && unnamed.interactions.find((i) => i.nodeId === "2:5")?.destinationExported === undefined);
  const m = measure({}, { interactions: [{ nodeId: "2:4", trigger: "on_click", ok: false, selector: '[data-dt-node="2:4"]', selectorCount: 1, detail: "no dialog" }, works("2:5")] });
  const r = run(m);
  safe("compare: probe ok:false on it → 'undesigned', not a fail; verdict pass", () => ia(r, "2:4")?.result === "undesigned" && r.coverage.interactionsFailed === 0 && r.verdict === "pass");
  safe("…counted in coverage and the headline", () => r.coverage.interactionsUndesigned === 1 && /1 undesigned/.test(r.headline));
  const nop = run(measure({}, { interactions: [works("2:5")] }));
  safe("compare: not probed at all → 'undesigned' too (never blocks)", () => ia(nop, "2:4")?.result === "undesigned" && nop.verdict === "pass");
  safe("compare: the probe shows it working → pass", () => ia(run(measure()), "2:4")?.result === "pass");
}

// ---------------------------------------------------------------- F-61 below the fold
console.log("F-61 — page-root bottom overflow is 'below the fold' (medium) only when it can be:");
{
  const down = { "2:2": { y: 1300 }, "2:21": { y: 1316 }, "2:22": { y: 1316 }, "2:23": { y: 1316 } };
  const vp = run(measure(down, { frame: VIEWPORT }));
  const p = delta(vp, "2:2", "placement");
  safe("footer below the design frame, probe frame via viewport → placement medium, 'below the fold'", () => !!p && p.severity === "medium" && /below the fold/.test(p.note || ""));
  safe("…the placement delta carries a numeric overflow (580px past 800)", () => p?.delta === 580);
  const taller = run(measure(down, { frame: { ...VIEWPORT, via: "tag", selector: "main" } }));
  safe("rendered frame (via tag) taller than the design → medium too", () => delta(taller, "2:2", "placement")?.severity === "medium");
  const noFrame = run(measure(down));
  safe("no measured frame (hand-written probe) → stays high", () => delta(noFrame, "2:2", "placement")?.severity === "high");
  const abs = run(measure({ "2:6": { y: 1300 } }, { frame: VIEWPORT }));
  safe("an absolute node below the fold → high (spec.absolute from the IR)", () => exp.nodes.find((s) => s.nodeId === "2:6")?.absolute === true && delta(abs, "2:6", "placement")?.severity === "high");
  const right = run(measure({ "2:2": { x: 400 } }, { frame: VIEWPORT }));
  safe("right-edge overflow → high", () => delta(right, "2:2", "placement")?.severity === "high");
  const sameH = run(measure(down, { frame: { ...VIEWPORT, via: "tag", selector: "main", rect: { x: 0, y: 0, w: 1280, h: 800 } } }));
  safe("rendered frame as tall as the design (via tag) → high", () => delta(sameH, "2:2", "placement")?.severity === "high");
  // a fixed (sticky) child: the frame's LAST numberOfFixedChildren children
  const fixedExp = buildExpectation([{ doc: screenExport([{ ...SCREEN, fixedChildren: 1 }], { screen: "Orders", sourceFile: "Sample Kit" }), label: "Orders" }]);
  safe("a frame's fixed child (and its subtree) is marked fixed; the others are not", () =>
    fixedExp.nodes.find((s) => s.nodeId === "I2:74;5:2")?.fixed === true && fixedExp.nodes.find((s) => s.nodeId === "2:2")?.fixed === undefined);

  // a waiver on a placement delta honours tolerance through its numbers
  const pw = waiver({ nodeId: "2:2", field: "placement", designed: "inside the frame", built: String(p?.actual) });
  const slight = run(measure({ ...down, "2:2": { y: 1301 } }, { frame: VIEWPORT }), { waivers: [pw] });
  safe("[F-61/D5] placement waiver: the footer 1px lower is still accepted (position tolerance 2)", () => !!delta(slight, "2:2", "placement")?.accepted);
  const far = run(measure({ ...down, "2:2": { y: 1340 } }, { frame: VIEWPORT }), { waivers: [pw] });
  safe("[F-61/D5] …40px lower reopens it (built value moved)", () => !delta(far, "2:2", "placement")?.accepted && far.waivers.reopened.some((w) => /built value moved/.test(w.why)));
}

// ---------------------------------------------------------------- F-76 grouping
console.log("F-76 — presentational grouping keeps the counts:");
{
  const down = { "2:2": { y: 1300 }, "2:21": { y: 1316 }, "2:22": { y: 1316 }, "2:23": { y: 1316 } };
  const r = run(measure(down));
  const placements = r.deltas.filter((d) => d.field === "placement");
  safe("footer + 3 children outside the frame → 4 placement deltas, all in group placement:2:2", () => placements.length === 4 && placements.every((d) => d.group === "placement:2:2"));
  safe("…counts unchanged: summary.high 4 (every row still counts)", () => r.summary.high === 4 && r.summary.highCauses === 1);
  safe("…headline '4 high (1 cause)'", () => /4 high \(1 cause\)/.test(r.headline));
  safe("…report.md prints the group once with its count", () => /Grouped causes \(\d+\)/.test(reportToMarkdown(r)) && /placement:2:2` — placement, \*\*4 rows\*\*/.test(reportToMarkdown(r)));
  const same = run(measure({ "2:21": { backgroundColor: "#dddddd" }, "2:22": { backgroundColor: "#dddddd" } }));
  const bgs = same.deltas.filter((d) => d.field === "background");
  safe("the same field/expected/actual on 2 nodes → one group; still 2 high", () => bgs.length === 2 && !!bgs[0]?.group && bgs[0]?.group === bgs[1]?.group && same.summary.high === 2 && /2 high \(1 cause\)/.test(same.headline));
}

// ---------------------------------------------------------------- F-77 foldedInto
console.log("F-77 — a plan anchor folds a layout-only wrapper into a measured ancestor:");
{
  const m = measure({ "2:3": null });
  const plain = run(m);
  const nm = plain.notMeasured.find((n) => n.nodeId === "2:3");
  safe("without an anchor: the padding-only wrapper is not measured, with the 'foldable' hint", () => !!nm && /foldable \(no paint — anchor it foldedInto its parent 2:8/.test(nm.why));
  const r = run(m, { anchors: { "2:3": { foldedInto: "2:8" } } });
  safe("foldedInto its measured ancestor: listed in folded[], out of notMeasured and the denominator", () =>
    r.folded.some((f) => f.nodeId === "2:3" && f.into === "2:8") && !r.notMeasured.some((n) => n.nodeId === "2:3") && r.coverage.nodesExpected === plain.coverage.nodesExpected - 1 && r.coverage.nodesFolded === 1);
  safe("…and the screen passes", () => r.verdict === "pass");
  const paint = run(measure({ "2:2": null, "2:21": null, "2:22": null, "2:23": null }), { anchors: { "2:21": { foldedInto: "2:2" } } });
  safe("refused: a wrapper that paints (background) stays notMeasured with the reason", () => paint.notMeasured.some((n) => n.nodeId === "2:21" && /foldedInto 2:2 refused: it states backgroundColor/.test(n.why)) && paint.folded.length === 0);
  const notAnc = run(m, { anchors: { "2:3": { foldedInto: "2:4" } } });
  safe("refused: the target is not an ancestor", () => notAnc.notMeasured.some((n) => n.nodeId === "2:3" && /2:4 is not an ancestor/.test(n.why)));
  const unmeasured = run(measure({ "2:3": null, "2:8": null }), { anchors: { "2:3": { foldedInto: "2:8" } } });
  // review: a wrapper whose only paint is a shadow (not compared by this method) is still drawn — never folded
  const shadowed = buildExpectation([{ doc: screenExport([{ type: "FRAME", id: "1:1", name: "Orders", box: { x: 0, y: 0, w: 1280, h: 800 }, children: [
    { type: "FRAME", id: "4:1", name: "Card", fills: [{ type: "solid", color: "#ffffff" }], children: [
      { type: "FRAME", id: "4:2", name: "Lift", effects: [{ type: "drop_shadow", color: "#00000033", offset: { x: 0, y: 2 }, radius: 4 }], layout: { display: "flex", flexDirection: "column", padding: [8, 8, 8, 8] }, children: [
        { type: "TEXT", id: "4:3", name: "Label", text: "Total", font: { family: "Inter", size: 14, color: "#111111" } }] }] }] }], { exportedAt: "2026-09-30T00:00:00Z", screen: "Orders" }), label: "Orders" }]);
  safe("[review] expectNode marks a node with a visible effect `decorated`", () => shadowed.nodes.find((n) => n.nodeId === "4:2")?.decorated === true);
  const sh = compare(shadowed, { nodes: [{ nodeId: "4:1", styles: { backgroundColor: "rgb(255, 255, 255)" } }, { nodeId: "4:3", styles: { text: "Total", fontSize: 14, fontFamily: "Inter", color: "rgb(17, 17, 17)" } }] }, { anchors: { "4:2": { foldedInto: "4:1" } } });
  safe("[review] refused: a shadow-only wrapper cannot be folded (it states decorated)", () => sh.notMeasured.some((n) => n.nodeId === "4:2" && /refused: it states decorated/.test(n.why)) && sh.folded.length === 0);
  safe("refused: the ancestor was not measured", () => unmeasured.notMeasured.some((n) => n.nodeId === "2:3" && /2:8 was not measured/.test(n.why)));
}

// ---------------------------------------------------------------- F-104 repeatedText
console.log("F-104 — repeated placeholder copy in sibling rows:");
{
  const date = (n: number) => `I2:7${n};5:2`, act = (n: number) => `I2:7${n};5:3`;
  safe("--expect marks the 4 identical dates (and actions) in sibling rows repeatedText, one group each", () => {
    const ds = [1, 2, 3, 4].map((n) => exp.nodes.find((s) => s.nodeId === date(n)));
    const as = [1, 2, 3, 4].map((n) => exp.nodes.find((s) => s.nodeId === act(n)));
    return ds.every((s) => s?.repeatedText === true && s.repeatedTextGroup === ds[0]?.repeatedTextGroup) && as.every((s) => s?.repeatedText === true) && ds[0]?.repeatedTextGroup !== as[0]?.repeatedTextGroup;
  });
  safe("--expect: a one-off text is not marked", () => exp.nodes.find((s) => s.nodeId === "2:1")?.repeatedText === undefined);
  const over: Over = {};
  [1, 2, 3, 4].forEach((n) => { over[date(n)] = { text: `${n} Mar, 2026` }; over[act(n)] = { text: "Remove" }; });
  const r = run(measure(over));
  safe("the build's dates differ row to row (real data) → text delta low, with a note", () =>
    [1, 2, 3, 4].every((n) => { const d = delta(r, date(n), "text"); return d?.severity === "low" && /repeated placeholder copy/.test(d.note || ""); }));
  safe("the build's action is 'Remove' in every row (uniform wrong copy) → stays high", () => [1, 2, 3, 4].every((n) => delta(r, act(n), "text")?.severity === "high"));
  // review H1: a typo in ONE row among correct ones is a copy bug, not real data
  const designed = String(exp.nodes.find((s) => s.nodeId === date(1))?.text ?? "");
  const typo: Over = {};
  [1, 2, 3].forEach((n) => { typo[date(n)] = { text: designed }; });
  typo[date(4)] = { text: designed.replace(/\d/, "9") };
  safe("[review H1] 3 rows show the designed text, 1 a typo → the typo stays high", () => designed !== "" && delta(run(measure(typo)), date(4), "text")?.severity === "high");
  const two: Over = {};
  [1, 2, 3].forEach((n) => { two[date(n)] = { text: "Pending" }; });
  two[date(4)] = { text: "Pendng" };
  safe("[review H1] one wrong label everywhere plus a typo (2 distinct values) → high", () => [1, 2, 3, 4].every((n) => delta(run(measure(two)), date(n), "text")?.severity === "high"));
  // re-review H1: real enum data that includes the designed placeholder value is real data, not a copy bug
  const en: Over = {};
  en[date(1)] = { text: designed }; en[date(2)] = { text: "1 Jan, 2027" }; en[date(3)] = { text: "2 Feb, 2027" }; en[date(4)] = { text: "3 Mar, 2027" };
  safe("[re-review H1] the designed value in 1 of 4 rows among 4 distinct values → the others are low", () => [2, 3, 4].every((n) => delta(run(measure(en)), date(n), "text")?.severity === "low"));
  const t = run(measure({ "2:1": { text: "Order list" } }));
  safe("a non-repeated text mismatch stays high", () => delta(t, "2:1", "text")?.severity === "high");
}

// ---------------------------------------------------------------- waiversHash
console.log("waiversHash — what a report records:");
{
  const p1: Plan = { screen: "Orders", waivers: [waiver({ nodeId: "2:1", field: "font-size", designed: 14, built: 16 })] };
  safe("absent and [] hash alike; key order does not matter; a change does", () => {
    const flipped: Plan = { screen: "Orders", waivers: (p1.waivers || []).map((w) => ({ decidedAt: w.decidedAt, decidedBy: w.decidedBy, reason: w.reason, exportContentSha256: w.exportContentSha256, built: w.built, designed: w.designed, field: w.field, nodeId: w.nodeId })) };
    return waiversHash({}) === waiversHash({ waivers: [], descopes: [] }) && waiversHash(p1) === waiversHash(flipped) && waiversHash(p1) !== waiversHash({});
  });
  safe("parsePlan refuses a non-array waivers", () => !isPlan({ waivers: {} }) && isPlan({ waivers: [] }) && !isPlan({ descopes: "x" }));
  const rec = run(measure(), { waiversInput: { plan: "design/plan/Orders.json", sha256: waiversHash(p1) } });
  safe("compare records inputs.waivers {plan, sha256}", () => rec.inputs?.waivers?.sha256 === waiversHash(p1) && rec.inputs.waivers.plan === "design/plan/Orders.json");
}

// ---------------------------------------------------------------- CLI: --expect index, --compare with the plan, --accept round trip
console.log("CLI — --expect reads the index; --compare applies the plan; --accept writes the waiver:");
{
  const CLI = path.join(import.meta.dirname, "..", "design-to-code", "verify-screen.ts");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "verify-waivers-"));
  const cli = (...a: string[]) => spawnSync(process.execPath, [CLI, ...a], { encoding: "utf8", cwd });
  const put = (rel: string, v: unknown): string => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), typeof v === "string" ? v : JSON.stringify(v, null, 2)); return rel; };
  const readPlan = (): Plan | null => readJsonOrNull(path.join(cwd, "design/plan/Orders__1_1.json"), isPlan);
  const readReport = () => readJsonOrNull(path.join(cwd, "design/verify/Orders.report.json"), isVerifyReport);
  put("design/export/pages/index.json", { pageDirs: [], sourceFile: "Sample Kit", layers: INDEX.index?.layers ?? [] });
  const screenFile = put("design/export/pages/Main/Orders__1_1.json", screenExport([SCREEN], { exportedAt: "2026-09-30T00:00:00Z", screen: "Orders", sourceFile: "Sample Kit" }));
  put("design/plan/Orders__1_1.json", { schema: "designtwin/plan@2", screen: "Orders__1_1", screenName: "Orders", nodeId: "1:1", file: screenFile, anchors: {} } satisfies Plan);
  put("design/verify/Orders.png", "not really a png");
  const e = cli("--expect", screenFile, "--out", "design/verify/Orders");
  const expDoc = readJsonOrNull(path.join(cwd, "design/verify/Orders.expected.json"), isVerifyExpectation);
  safe("--expect (exit 0) reads design/export/pages/index.json: 2:4 → destinationExported:false", () =>
    e.status === 0 && !!expDoc && (expDoc.interactions || []).some((i) => i.nodeId === "2:4" && i.destinationExported === false) && (expDoc.interactions || []).some((i) => i.nodeId === "2:5" && i.destinationExported === undefined));
  // review H2: a later page walk REPLACED the root index; 9:9 was exported by an earlier walk and is listed only
  // in its page's own index — it must not read as "never exported"
  const walked = fs.mkdtempSync(path.join(os.tmpdir(), "verify-waivers-walk-"));
  const putW = (rel: string, v: unknown): string => { fs.mkdirSync(path.dirname(path.join(walked, rel)), { recursive: true }); fs.writeFileSync(path.join(walked, rel), JSON.stringify(v, null, 2)); return rel; };
  putW("design/export/pages/index.json", { pageDirs: [{ page: "Main", dir: "Main", index: "pages/Main/index.json" }], sourceFile: "Sample Kit", layers: (INDEX.index?.layers ?? []).filter((l) => l.id !== "9:9") });
  putW("design/export/pages/Dialogs/index.json", { page: "Dialogs", layers: [{ id: "9:9", name: "Export Dialog", file: "pages/Dialogs/Export_Dialog__9_9.json", sourceFile: "Sample Kit" }] });
  const wScreen = putW("design/export/pages/Main/Orders__1_1.json", screenExport([SCREEN], { exportedAt: "2026-09-30T00:00:00Z", screen: "Orders", sourceFile: "Sample Kit" }));
  const we = spawnSync(process.execPath, [CLI, "--expect", wScreen, "--out", "design/verify/Orders"], { encoding: "utf8", cwd: walked });
  const wDoc = readJsonOrNull(path.join(walked, "design/verify/Orders.expected.json"), isVerifyExpectation);
  safe("[review H2] 9:9 listed only in pages/Dialogs/index.json (an earlier walk) → not marked undesigned", () =>
    we.status === 0 && !!wDoc && (wDoc.interactions || []).some((i) => i.nodeId === "2:4" && i.destinationExported === undefined));
  fs.rmSync(walked, { recursive: true, force: true });
  const expSha = (() => { try { return crypto.createHash("sha256").update(fs.readFileSync(path.join(cwd, "design/verify/Orders.expected.json"))).digest("hex"); } catch { return ""; } })();
  put("design/verify/Orders.measured.json", { ...measure({ "2:1": { fontSize: 16 } }), expectationSha256: expSha, artifacts: ["design/verify/Orders.png"] });
  const c1 = cli("--compare", "design/verify/Orders.expected.json", "design/verify/Orders.measured.json");
  const r1 = readReport();
  safe("--compare finds the plan without files[] and records inputs.waivers; font-size high → exit 1", () =>
    c1.status === 1 && r1?.verdict === "fail" && r1.inputs?.waivers?.plan === "design/plan/Orders__1_1.json" && r1.inputs.waivers.sha256 === waiversHash({}));
  const noReason = cli("--accept", "design/verify/Orders.report.json", "--node", "2:1", "--by", "Sam Doe");
  safe("--accept without --reason → exit 2, nothing written", () => noReason.status === 2 && /--reason/.test(noReason.stderr) && !readPlan()?.waivers);
  const noField = cli("--accept", "design/verify/Orders.report.json", "--node", "2:1", "--reason", "x", "--by", "Sam Doe");
  safe("[review] --accept --node without --field or --all-fields → exit 2, nothing written", () => noField.status === 2 && /--field "<label>" \/ --all-fields/.test(noField.stderr) && !readPlan()?.waivers);
  const noDelta = cli("--accept", "design/verify/Orders.report.json", "--node", "2:4", "--all-fields", "--reason", "x", "--by", "Sam Doe");
  safe("--accept on a node with no delta → refused, exit 1", () => noDelta.status === 1 && /refused {2}no delta in the report for 2:4/.test(noDelta.stderr));
  const flagOnCompare = cli("--compare", "design/verify/Orders.expected.json", "design/verify/Orders.measured.json", "--reason", "x");
  safe("--reason outside --accept → exit 2", () => flagOnCompare.status === 2);
  const a = cli("--accept", "design/verify/Orders.report.json", "--node", "2:1", "--field", "font-size", "--reason", "the wider type reads better", "--by", "Sam Doe");
  const plan = readPlan();
  const w0 = plan?.waivers?.[0];
  safe("--accept writes one waiver {designed 14, built 16, export sha, reason, decidedBy} into the plan, exit 0, says re-run --compare", () =>
    a.status === 0 && plan?.waivers?.length === 1 && w0?.nodeId === "2:1" && w0.field === "font-size" && w0.designed === 14 && w0.built === 16 &&
    w0.exportContentSha256 === r1?.inputs?.exportContentSha256 && w0.decidedBy === "Sam Doe" && /re-run --compare/.test(a.stderr));
  safe("…the rest of the plan is kept as it was", () => plan?.nodeId === "1:1" && isJsonObject(plan.anchors));
  const c2 = cli("--compare", "design/verify/Orders.expected.json", "design/verify/Orders.measured.json");
  const r2 = readReport();
  safe("re-run --compare → pass-with-deviations, exit 0, inputs.waivers.sha256 = waiversHash(plan)", () =>
    c2.status === 0 && r2?.verdict === "pass-with-deviations" && !!plan && r2.inputs?.waivers?.sha256 === waiversHash(plan) && /PASS-WITH-DEVIATIONS/.test(c2.stderr));
  const again = cli("--accept", "design/verify/Orders.report.json", "--node", "2:1", "--field", "font-size", "--reason", "still intended", "--by", "Sam Doe");
  safe("[review] the plan is written by rename: no temp file is left beside it", () => !fs.readdirSync(path.join(cwd, "design/plan")).some((f) => f.endsWith(".tmp")));
  safe("accepting the same node + field again replaces the row (one per node + field)", () => again.status === 0 && readPlan()?.waivers?.length === 1 && readPlan()?.waivers?.[0]?.reason === "still intended");
  fs.rmSync(cwd, { recursive: true, force: true });
}

report();
