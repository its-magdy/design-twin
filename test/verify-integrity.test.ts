// what --compare trusts. Expectations come from the real
// `buildExpectation` over a plugin-shaped screen export (test/fixtures.ts, invented names); measured files and
// interaction evidence have the shapes the shipped probe and the verifier write (design-to-code/types.ts). The
// last block runs the CLI's --compare in a temp project with a status file beside the measured one.
// Run with:  node test/verify-integrity.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import * as VS from "../design-to-code/verify-screen.ts";
import * as VSC from "../design-to-code/verify-compare.ts";
import { reportToMarkdown } from "../design-to-code/verify-screen.ts";
import { compare } from "../design-to-code/verify-compare.ts";
import { buildExpectation } from "../design-to-code/verify-expect.ts";
import { STYLE_KEYS } from "../design-to-code/verify-shared.ts";
import type { CompareOptions } from "../design-to-code/verify-compare.ts";
import { isVerifyReport, readableMeasured } from "../design-to-code/doc-guards.ts";
import { readJsonOrNull } from "../design-to-code/read-json.ts";
import { liveStatusFile } from "../design-to-code/verify-run.ts";
import type { BuildIdentity, CodeInputs, InteractionEvidence, JsonObject, MeasuredNode, MeasuredStyles, VerifyMeasured, VerifyReport, VerifyReportV2, VerifySpec } from "../design-to-code/types.ts";
import { isJsonObject } from "../design-to-code/types.ts";
import { screenExport } from "./fixtures.ts";
import type { NodeInput } from "./fixtures.ts";
import { check, report } from "./assert.ts";

const safe = (name: string, fn: () => boolean): boolean => { let r = false; try { r = fn(); } catch (e) { console.log(`    (threw: ${e instanceof Error ? e.message : String(e)})`); } return check(name, r); };

// ---------------------------------------------------------------- the screen (invented names)
const SCREEN: NodeInput = {
  type: "FRAME", id: "1:1", name: "Garden Plots", box: { x: 0, y: 0, w: 1280, h: 800 }, children: [
    { type: "TEXT", id: "2:1", name: "Title", text: "Garden Plots", font: { family: "Inter", size: 20, color: "#111111" } },
    { type: "FRAME", id: "2:4", name: "Add Plot", fills: [{ type: "solid", color: "#0000ff" }], reactions: [{ trigger: "on_click", actions: [{ type: "NODE", navigation: "overlay", destinationId: "1:60" }] }] },
    { type: "FRAME", id: "2:5", name: "Open Map", fills: [{ type: "solid", color: "#00aa00" }], reactions: [{ trigger: "on_click", actions: [{ type: "NODE", navigation: "navigate", destinationId: "1:50" }] }] },
    { type: "FRAME", id: "3:1", name: "Plot Card", fills: [{ type: "solid", color: "#ffffff" }], layout: { display: "flex", flexDirection: "column", padding: [8, 8, 8, 8] }, children: [
      { type: "FRAME", id: "3:2", name: "Water Toggle", fills: [{ type: "solid", color: "#cccccc" }], reactions: [{ trigger: "on_click", actions: [{ type: "NODE", navigation: "change_to", destinationId: "3:9" }] }] },
      { type: "TEXT", id: "3:3", name: "Plot Name", text: "North Bed", font: { family: "Inter", size: 14, color: "#333333" } },
      { type: "VECTOR", id: "3:4", name: "Leaf Icon", fills: [{ type: "solid", color: "#22aa22" }] },
    ] },
    { type: "FRAME", id: "2:6", name: "Back Link", fills: [{ type: "solid", color: "#eeeeee" }], reactions: [{ trigger: "on_click", actions: [{ type: "back" }] }] },
    { type: "FRAME", id: "2:7", name: "Help Link", fills: [{ type: "solid", color: "#dddddd" }], reactions: [{ trigger: "on_click", actions: [{ type: "url", url: "https://example.test/help" }] }] },
    { type: "FRAME", id: "2:8", name: "Dismiss", fills: [{ type: "solid", color: "#cccccc" }], reactions: [{ trigger: "on_click", actions: [{ type: "close" }] }] },
  ],
};
const exp = buildExpectation([{ doc: screenExport([SCREEN], { exportedAt: "2026-09-30T00:00:00Z", screen: "Garden Plots", sourceFile: "Sample Kit" }), label: "Garden Plots" }]);

function echo(spec: VerifySpec): MeasuredNode {
  const styles: MeasuredStyles = {};
  const src: Record<string, unknown> = { ...spec };
  for (const k of STYLE_KEYS) { const v = src[k]; if (v !== undefined) styles[k] = v; }
  return { nodeId: spec.nodeId, styles, matchedBy: "tag" };
}
type Over = Record<string, MeasuredStyles | null>;
// A full evidence row: one element driven, the outcome the action produces, no navigation during it.
const ev = (nodeId: string, outcome: string, extra: Partial<InteractionEvidence> = {}): InteractionEvidence =>
  ({ nodeId, trigger: "on_click", ok: true, selector: `[data-dt-node="${nodeId}"]`, selectorCount: 1, outcome, navEvents: 0, detail: "driven", ...extra });
const GOOD = [ev("2:4", "dialog-opened"), ev("2:5", "url-changed", { navEvents: 1 }), ev("3:2", "state-changed"), ev("2:6", "url-changed", { navEvents: 1 }), ev("2:7", "url-changed", { navEvents: 1 }), ev("2:8", "state-changed")];
function measure(over: Over = {}, extra: Partial<VerifyMeasured> = {}): VerifyMeasured {
  const nodes: MeasuredNode[] = [];
  for (const s of exp.nodes) {
    const o = over[s.nodeId];
    if (o === null) continue;
    const m = echo(s);
    nodes.push({ ...m, styles: { ...m.styles, ...(o || {}) } });
  }
  return { measuredAt: "2026-09-30T01:00:00Z", renderer: "playwright-chromium", viewport: "1280x800", nodes, interactions: GOOD, ...extra };
}
const run = (m: VerifyMeasured, o: CompareOptions = {}): VerifyReportV2 => compare(exp, m, o);
const ia = (r: VerifyReportV2, id: string) => r.interactions.find((i) => i.nodeId === id);
const withEvidence = (rows: InteractionEvidence[]): VerifyMeasured => measure({}, { interactions: [...GOOD.filter((g) => !rows.some((r) => r.nodeId === g.nodeId)), ...rows] });

console.log("baseline:");
const base = run(measure());
safe("the echo build with full evidence passes (six interactions pass)", () => base.verdict === "pass" && base.coverage.interactionsPassed === 6);

// ---------------------------------------------------------------- ok:true needs evidence
console.log("ok:true is a claim; the evidence is one element, an outcome the action produces, no reload:");
{
  const r = run(withEvidence([ev("2:4", "none", { navEvents: 1 })]));
  const row = ia(r, "2:4");
  safe("ok:true, count 1, navEvents 1, outcome none (the dev-server reload case) → not-probed, never pass", () => row?.result === "not-probed");
  safe("…the detail names what is missing (the outcome and the navigation)", () => /outcome 'none'/.test(row?.detail || "") && /1 document\(s\) loaded during the interaction/.test(row?.detail || ""));
  safe("…and the verdict is incomplete, never fail (the control may work)", () => r.verdict === "incomplete");
  safe("…the row carries outcome + navEvents", () => row?.outcome === "none" && row.navEvents === 1);
}
safe("overlay + dialog-opened, count 1, navEvents 0 → pass, carrying outcome and navEvents", () => { const x = ia(run(withEvidence([ev("2:4", "dialog-opened")])), "2:4"); return x?.result === "pass" && x.outcome === "dialog-opened" && x.navEvents === 0; });
safe("navigate + url-changed with navEvents 1 → pass (changing the URL IS the action)", () => ia(run(withEvidence([ev("2:5", "url-changed", { navEvents: 1 })])), "2:5")?.result === "pass");
safe("navigate + selector-appeared with navEvents 1 → not-probed (a navigation is only the outcome when the URL changed)", () => ia(run(withEvidence([ev("2:5", "selector-appeared", { navEvents: 1 })])), "2:5")?.result === "not-probed");
safe("overlay + url-changed → not-probed (not what an overlay does)", () => { const x = ia(run(withEvidence([ev("2:4", "url-changed")])), "2:4"); return x?.result === "not-probed" && /not what an overlay does/.test(x.detail || ""); });
safe("selectorCount 3 with a good outcome → not-probed 'needs exactly 1'", () => { const x = ia(run(withEvidence([ev("2:4", "dialog-opened", { selectorCount: 3 })])), "2:4"); return x?.result === "not-probed" && /needs exactly 1/.test(x.detail || ""); });
safe("older evidence with no outcome and no navEvents → not-probed 'no outcome recorded' + 'no navEvents recorded'", () => {
  const x = ia(run(withEvidence([{ nodeId: "2:4", trigger: "on_click", ok: true, selector: '[data-dt-node="2:4"]', selectorCount: 1, detail: "dialog open=1" }])), "2:4");
  return x?.result === "not-probed" && /no outcome recorded/.test(x.detail || "") && /no navEvents recorded/.test(x.detail || "");
});
safe("an outcome in free text ('opened fine') is not an outcome → not-probed", () => ia(run(withEvidence([ev("2:4", "opened fine")])), "2:4")?.result === "not-probed");
safe("change_to + state-changed → pass; change_to + none → not-probed", () => ia(run(withEvidence([ev("3:2", "state-changed")])), "3:2")?.result === "pass" && ia(run(withEvidence([ev("3:2", "none")])), "3:2")?.result === "not-probed");
safe("ok:false is still a fail (only a pass needs evidence)", () => ia(run(withEvidence([{ ...ev("2:4", "none"), ok: false }])), "2:4")?.result === "fail");
// navEvents counts DOCUMENTS LOADED — a full navigation is the outcome only for navigate / back / url
safe("back + url-changed with navEvents 1 → pass (a multi-page back link loads the previous document)", () => ia(run(withEvidence([ev("2:6", "url-changed", { navEvents: 1 })])), "2:6")?.result === "pass");
safe("url + url-changed with navEvents 1 → pass", () => ia(run(withEvidence([ev("2:7", "url-changed", { navEvents: 1 })])), "2:7")?.result === "pass");
safe("navigate + url-changed with navEvents 0 (an SPA pushState — no document loaded) → pass", () => ia(run(withEvidence([ev("2:5", "url-changed", { navEvents: 0 })])), "2:5")?.result === "pass");
safe("close + url-changed with navEvents 0 (an in-page URL change) → pass; with navEvents 1 (a document loaded) → not-probed naming the rule", () => {
  const inPage = ia(run(withEvidence([ev("2:8", "url-changed", { navEvents: 0 })])), "2:8"), loaded = ia(run(withEvidence([ev("2:8", "url-changed", { navEvents: 1 })])), "2:8");
  return inPage?.result === "pass" && loaded?.result === "not-probed" && /only a navigate, back or url action may load a document/.test(loaded.detail || "");
});
safe("an overlay opened as a route records what appeared: selector-appeared → pass; a tab kept in the query (change_to) + selector-appeared → pass", () =>
  ia(run(withEvidence([ev("2:4", "selector-appeared")])), "2:4")?.result === "pass" && ia(run(withEvidence([ev("3:2", "selector-appeared")])), "3:2")?.result === "pass");
safe("OUTCOMES_FOR_ACTION / INTERACTION_OUTCOMES are exported with the interface's values", () =>
  JSON.stringify(VSC.OUTCOMES_FOR_ACTION.navigate) === JSON.stringify(["url-changed", "selector-appeared"]) && JSON.stringify(VSC.OUTCOMES_FOR_ACTION.overlay) === JSON.stringify(["dialog-opened", "selector-appeared"])
  && VSC.OUTCOMES_FOR_ACTION.other.length === 4 && !VSC.OUTCOMES_FOR_ACTION.other.includes("none") && VSC.INTERACTION_OUTCOMES.length === 5);

// ---------------------------------------------------------------- unfiled probe results
console.log("a probe result filed under no designed interaction is named, with a hint:");
{
  const m = withEvidence([]);
  m.interactions = [...(m.interactions || []), ev("2:4", "dialog-opened", { trigger: "on_click(name link)" })];
  const r = run(m);
  const md = reportToMarkdown(r);
  safe("evidence `on_click(name link)` → headline '1 probe result(s) matched no designed interaction'", () => /· 1 probe result\(s\) matched no designed interaction/.test(r.headline));
  safe("…report.probe.unmatchedInteractionEvidence names it, with the hint", () => r.probe.unmatchedInteractionEvidence?.length === 1 && r.probe.unmatchedInteractionEvidence[0]?.trigger === "on_click(name link)");
  safe("…md hint: use the expectation's trigger `on_click`", () => /use the expectation's trigger `on_click`/.test(md) && /## Probe results that matched no designed interaction \(1\)/.test(md));
  safe("…and the verdict is unchanged (still pass)", () => r.verdict === "pass");
}
{
  const m = withEvidence([]);
  m.interactions = [...(m.interactions || []), ev("3:1", "state-changed"), ev("3:1", "state-changed"), ev("2:5", "dialog-opened", { trigger: "on_hover" })];
  const r = run(m);
  const u = r.probe.unmatchedInteractionEvidence || [];
  safe("a result on the designed node's ANCESTOR → hint 'an ancestor of the designed `3:2`'; the same row twice counts once", () => u.length === 2 && /an ancestor of the designed `3:2`/.test(u.find((x) => x.nodeId === "3:1")?.hint || ""));
  safe("the right node, another trigger → hint names the node's designed trigger", () => /designed trigger is `on_click`/.test(u.find((x) => x.nodeId === "2:5")?.hint || ""));
}

// ---------------------------------------------------------------- lost coverage
console.log("a previous delta gone only because it was not measured is LOST COVERAGE, not a fix:");
// (a report round-trips through JSON on disk)
const prevReport = (r: VerifyReportV2): VerifyReport => { const v: unknown = JSON.parse(JSON.stringify(r)); if (!isVerifyReport(v)) throw new Error("not a report"); return v; };
{
  const before = run(measure({ "3:3": { color: "#ff0000" }, "2:1": { fontSize: 24 } }));
  safe("two deltas (3:3 color, 2:1 font-size)", () => before.deltas.length === 2);
  const now = run(measure({ "3:3": { color: null }, "2:1": { fontSize: 24 } }), { against: { file: "prev.report.json", report: prevReport(before) } });
  const d = now.against?.deltas;
  safe("3:3 color now null → lostCoverage 1 {nodeId, field, was}, 2:1 unchanged", () => d?.lostCoverage.length === 1 && d.lostCoverage[0]?.nodeId === "3:3" && d.lostCoverage[0].field === "color" && d.lostCoverage[0].was === "#ff0000ff" && d.unchanged === 1 && d.fixed === 0);
  safe("…headline 'LOST COVERAGE on 1 earlier delta(s)'", () => /LOST COVERAGE on 1 earlier delta\(s\)/.test(now.headline));
  safe("…md lists it under '## Lost coverage (1)'", () => /## Lost coverage \(1\)/.test(reportToMarkdown(now)));
  const plain = run(measure({ "3:3": { color: null }, "2:1": { fontSize: 24 } }));
  safe("…and the verdict is the same as without the baseline", () => now.verdict === plain.verdict);
  const fixed = run(measure({ "2:1": { fontSize: 24 } }), { against: { file: "prev.report.json", report: prevReport(before) } });
  safe("3:3 measured and right → fixed 1, no LOST COVERAGE", () => fixed.against?.deltas?.fixed === 1 && fixed.against.deltas.lostCoverage.length === 0 && !/LOST COVERAGE/.test(fixed.headline));
  const gone = run(measure({ "3:3": null, "2:1": { fontSize: 22 } }), { against: { file: "prev.report.json", report: prevReport(before) } });
  safe("3:3 not measured at all → lost ('the node was not measured'); 2:1 now 22 is the same node + field → unchanged", () =>
    gone.against?.deltas?.lostCoverage[0]?.why === "the node was not measured this round" && gone.against.deltas.unchanged === 1);
  const fresh = run(measure({ "2:1": { fontSize: 24 }, "3:1": { backgroundColor: "#000000" } }), { against: { file: "prev.report.json", report: prevReport(before) } });
  safe("a delta the previous round did not have → new 1", () => fresh.against?.deltas?.new === 1);
}
// a delta can only be LOST when this round's measurement lacks the value — never because the compare changed
console.log("LOST COVERAGE and 'fixed' only when the measurement changed:");
{
  const M1 = "a".repeat(64), M2 = "b".repeat(64);
  const before = run(measure({ "3:3": { color: "#ff0000" }, "2:1": { fontSize: 24 } }), { measuredSha256: M1 });
  // the same measured file compared again by a compare that now reads 3:3's colour differently (simulated: null)
  const same = run(measure({ "3:3": { color: null }, "2:1": { fontSize: 24 } }), { measuredSha256: M1, against: { file: "prev.report.json", report: prevReport(before) } });
  const d = same.against?.deltas;
  safe("same measured sha as the previous report → 0 lost, 0 fixed, 0 new; the difference is `reclassified` (gone), sameMeasured", () => d !== undefined && d.lostCoverage.length === 0 && d.fixed === 0 && d.new === 0
    && d.sameMeasured === true && d.reclassified?.length === 1 && d.reclassified[0]?.nodeId === "3:3" && d.reclassified[0].change === "gone" && d.unchanged === 1);
  safe("…no LOST COVERAGE in the headline; the md says 'the same measured file' and lists it under Reclassified", () => !/LOST COVERAGE/.test(same.headline) && /the same measured file as last round/.test(reportToMarkdown(same)) && /## Reclassified \(1\)/.test(reportToMarkdown(same)));
  const sameFixed = run(measure({ "2:1": { fontSize: 24 } }), { measuredSha256: M1, against: { file: "prev.report.json", report: prevReport(before) } });
  safe("same measured sha, a delta the compare no longer raises → not 'fixed' (reclassified)", () => sameFixed.against?.deltas?.fixed === 0 && sameFixed.against.deltas.reclassified?.length === 1);
  const other = run(measure({ "3:3": { color: null }, "2:1": { fontSize: 24 } }), { measuredSha256: M2, against: { file: "prev.report.json", report: prevReport(before) } });
  safe("a different measured sha, the value now null → still LOST COVERAGE (1)", () => other.against?.deltas?.lostCoverage.length === 1 && /LOST COVERAGE on 1/.test(other.headline));
  // an icon whose fill was a delta last round is now drawn by an <img>: the value is there, the method cannot read it
  const icon = run(measure({ "3:4": { fill: "#ff0000" } }), { measuredSha256: M1 });
  safe("the icon's fill is a delta", () => icon.deltas.some((x) => x.nodeId === "3:4" && x.field === "fill (SVG paint)"));
  const img = measure({ "3:4": { fill: "#ff0000" } });
  img.nodes = (img.nodes || []).map((n) => (n.nodeId === "3:4" ? { ...n, styles: { ...n.styles, tag: "img" } } : n));
  const nowImg = run(img, { measuredSha256: M2, against: { file: "prev.report.json", report: prevReport(icon) } });
  const di = nowImg.against?.deltas;
  safe("the <img> fill now unverifiable → 0 lost, 0 fixed; listed under nowUnverifiable (method)", () => di !== undefined && di.lostCoverage.length === 0 && di.fixed === 0 && di.nowUnverifiable?.length === 1 && di.nowUnverifiable[0]?.nodeId === "3:4" && !/LOST COVERAGE/.test(nowImg.headline));
  const neg = run(measure({ "3:1": { padding: [-4, 0, 0, 0] } }), { measuredSha256: M2, against: { file: "prev.report.json", report: prevReport(run(measure({ "3:1": { padding: [9, 0, 0, 0] } }), { measuredSha256: M1 })) } });
  safe("a measured value the compare now drops as impossible (negative padding) → nowUnverifiable, not lost", () => neg.against?.deltas?.lostCoverage.length === 0 && neg.against.deltas.nowUnverifiable?.length === 1);
  // placement is DERIVED from the box — gone because an input (x/y/width/height) was not reported is lost, not fixed
  const below = run(measure({ "3:3": { x: 10, y: 900, width: 80, height: 20 } }), { measuredSha256: M1 });
  safe("3:3 rendered below the 800-high frame → a placement delta", () => below.deltas.some((x) => x.nodeId === "3:3" && x.field === "placement"));
  const noY = run(measure({ "3:3": { x: 10, width: 80, height: 20 } }), { measuredSha256: M2, against: { file: "prev.report.json", report: prevReport(below) } });
  safe("y no longer reported → placement is LOST COVERAGE (naming y), not fixed", () => noY.against?.deltas?.fixed === 0 && noY.against.deltas.lostCoverage.length === 1
    && noY.against.deltas.lostCoverage[0]?.field === "placement" && /y/.test(noY.against.deltas.lostCoverage[0].why));
  const nullY = run(measure({ "3:3": { x: 10, y: null, width: 80, height: 20 } }), { measuredSha256: M2, against: { file: "prev.report.json", report: prevReport(below) } });
  safe("y reported null → placement LOST COVERAGE, not fixed", () => nullY.against?.deltas?.fixed === 0 && nullY.against.deltas.lostCoverage.length === 1);
  const inside = run(measure({ "3:3": { x: 10, y: 100, width: 80, height: 20 } }), { measuredSha256: M2, against: { file: "prev.report.json", report: prevReport(below) } });
  safe("the whole box measured and inside the frame → fixed 1 (the real fix still counts)", () => inside.against?.deltas?.fixed === 1 && inside.against.deltas.lostCoverage.length === 0);
  // L-a: the box IS reported but placement cannot be judged from it — the delta is nowUnverifiable, never fixed
  const abc = measure({ "3:3": { x: 10, width: 80, height: 20 } });
  const abcNode = (abc.nodes || []).find((n) => n.nodeId === "3:3");
  if (abcNode?.styles) Reflect.set(abcNode.styles, "y", "abc"); // what a hand-written probe sends; the type says number
  const unreadY = run(abc, { measuredSha256: M2, against: { file: "prev.report.json", report: prevReport(below) } });
  const du = unreadY.against?.deltas;
  safe("y reported as 'abc' (not a px number) → placement nowUnverifiable, not fixed, not lost", () => du !== undefined && du.fixed === 0 && du.lostCoverage.length === 0
    && du.nowUnverifiable?.length === 1 && du.nowUnverifiable[0]?.field === "placement" && /could not read y/.test(du.nowUnverifiable[0].why));
  // a layer the designer drew hovered, measured at rest where it renders 0×0 (a hover-only control)
  const hoverExp = structuredClone(exp);
  for (const n of hoverExp.nodes) if (n.nodeId === "3:3") { n.drawnState = "hover"; n.drawnStateWhy = "its variant is named Hover"; n.drawnStateOwn = true; }
  const hidden = compare(hoverExp, measure({ "3:3": { x: 10, y: 900, width: 0, height: 0 } }), { measuredSha256: M2, against: { file: "prev.report.json", report: prevReport(below) } });
  const dh = hidden.against?.deltas;
  safe("the node now 0×0 at rest (hover-only) → placement nowUnverifiable ('renders 0×0 at rest'), not fixed", () => dh !== undefined && dh.fixed === 0 && dh.lostCoverage.length === 0
    && (dh.nowUnverifiable || []).some((x) => x.nodeId === "3:3" && x.field === "placement" && /renders 0×0 at rest/.test(x.why)));
}

// ---------------------------------------------------------------- the served build
console.log("the build that was served:");
const build = (sha: string): BuildIdentity => ({ url: "http://127.0.0.1:4173/", mode: "static", assets: 3, assetsSha256: sha, gitHead: "a".repeat(40), gitDirty: false });
const code = (h: string): CodeInputs => ({ plan: "design/plan/garden.json", files: { "src/GardenPlots.tsx": h }, gitHead: "a".repeat(40) });
{
  const r = run(measure());
  safe("measured without build → inputs.build 'unknown'; md 'build identity unknown'", () => r.inputs?.build === "unknown" && /build identity unknown/.test(reportToMarkdown(r)));
  const prev = run(measure({}, { build: build("b1") }), { code: code("h1") });
  safe("measured.build is copied to inputs.build and printed in the md", () => isJsonObject(prev.inputs?.build) && /Build served: static http:\/\/127\.0\.0\.1:4173\//.test(reportToMarkdown(prev)));
  const stale = run(measure({}, { build: build("b1") }), { code: code("h2"), against: { file: "prev.report.json", report: prevReport(prev) } });
  safe("same assetsSha256 as last round, code hashes differ → headline 'SAME BUILD SERVED as prev.report.json although the code changed'", () => stale.against?.sameBuild === true && /SAME BUILD SERVED as prev\.report\.json although the code changed/.test(stale.headline));
  safe("…the verdict does not change (still pass)", () => stale.verdict === "pass");
  const same = run(measure({}, { build: build("b1") }), { code: code("h1"), against: { file: "prev.report.json", report: prevReport(prev) } });
  safe("same build, same code → no warning", () => same.against?.sameBuild === true && !/SAME BUILD/.test(same.headline));
  const rebuilt = run(measure({}, { build: build("b2") }), { code: code("h2"), against: { file: "prev.report.json", report: prevReport(prev) } });
  safe("a new build for new code → sameBuild false, no warning", () => rebuilt.against?.sameBuild === false && !/SAME BUILD/.test(rebuilt.headline));
  // A partial hash on either side (bodies left out of assetsSha256) → sameBuild unknown, never SAME BUILD SERVED
  const partialPrev = run(measure({}, { build: { ...build("b1"), unhashed: 2 } }), { code: code("h1") });
  const afterPartial = run(measure({}, { build: build("b1") }), { code: code("h2"), against: { file: "prev.report.json", report: prevReport(partialPrev) } });
  safe("the earlier round's build hash was partial (unhashed 2) → sameBuild null, no SAME BUILD SERVED", () => afterPartial.against?.sameBuild === null && !/SAME BUILD/.test(afterPartial.headline));
  const partialNow = run(measure({}, { build: { ...build("b1"), unhashed: 1 } }), { code: code("h2"), against: { file: "prev.report.json", report: prevReport(prev) } });
  safe("this round's build hash is partial (unhashed 1) → sameBuild null, no SAME BUILD SERVED; the md says partial", () => partialNow.against?.sameBuild === null && !/SAME BUILD/.test(partialNow.headline)
    && /partial: 1 body\(ies\) not hashed/.test(reportToMarkdown(partialNow)));
  const bad: JsonObject = { measuredAt: "2026-09-30T01:00:00Z", nodes: [], build: { url: 1 } };
  const rd = readableMeasured(bad);
  safe("a malformed measured.build is dropped with a note (the file still compares)", () => rd !== null && rd.doc.build === undefined && rd.notes.some((n) => /measured\.build is not a build identity/.test(n)));
}
{
  // the MCP sandbox shape: a hand-written probe's page-wide navigation log under a top-level `navEvents` object
  const legacy: JsonObject = { measuredAt: "2026-09-30T01:00:00Z", nodes: [], interactions: [], navEvents: { total: 1, loads: 1, afterInitialNavigation: 0, events: [], artifactWrites: [] }, runId: "r1" };
  const rd = readableMeasured(legacy);
  const r = rd ? run({ ...measure(), ...rd.doc, nodes: measure().nodes ?? [], interactions: GOOD }) : null;
  safe("a legacy top-level navEvents OBJECT: readable, listed as an unknown top-level key (canonical: navigation), never read as interaction evidence", () =>
    r !== null && (r.probe.unknownTopLevelKeys || []).some((k) => k.key === "navEvents" && k.canonical === "navigation") && r.coverage.interactionsPassed === 6);
  safe("runId and build are known top-level keys (not listed as unknown)", () => r !== null && !(r.probe.unknownTopLevelKeys || []).some((k) => k.key === "runId" || k.key === "build") && r.inputs?.runId === "r1");
}

// ---------------------------------------------------------------- integrity failures
console.log("integrity failures make the verdict incomplete; the report is still written:");
const SHA_E = "e".repeat(64), SHA_M = "m".repeat(64);
const status = (phase: "measuring" | "measured" | "done", measuredSha256?: string) => ({ file: "Garden.status.json", status: { schema: "designtwin/verify-status@2" as const, screen: "Garden", runId: "run-7", rev: 3, phase, detail: "", at: "2026-09-30T01:00:00Z", by: "agent" as const, ...(measuredSha256 ? { measuredSha256 } : {}) } });
safe("a measured file with no expectationSha256 → incomplete 'measured file names no expectation (expectationSha256)'", () => {
  const r = run(measure(), { expectationSha256: SHA_E, measuredSha256: SHA_M });
  return r.verdict === "incomplete" && r.why.some((w) => w.startsWith("measured file names no expectation (expectationSha256)"));
});
safe("a status v2 of this run still at 'measuring' → incomplete '… (run run-7, rev 3) is at phase measuring — the verifier had not finished'", () => {
  const r = run(measure({}, { expectationSha256: SHA_E }), { expectationSha256: SHA_E, measuredSha256: SHA_M, status: status("measuring") });
  return r.verdict === "incomplete" && r.why.some((w) => /Garden\.status\.json \(run run-7, rev 3\) is at phase measuring — the verifier had not finished/.test(w));
});
safe("a status 'done' of the measured file's own run naming another measured sha → incomplete 'names a different measured file'", () => {
  const r = run(measure({}, { expectationSha256: SHA_E, runId: "run-7" }), { expectationSha256: SHA_E, measuredSha256: SHA_M, status: status("done", "f".repeat(64)) });
  return r.verdict === "incomplete" && r.why.some((w) => /names a different measured file \(sha ffffffffffff…/.test(w));
});
// an integrity reason outranks the grades — a high mismatch in an unverified run is incomplete, never fail
safe("a high mismatch + a run still at 'measuring' → incomplete (not fail); the integrity reason is listed first, the high still listed", () => {
  const r = run(measure({ "2:1": { fontSize: 30 } }, { expectationSha256: SHA_E }), { expectationSha256: SHA_E, measuredSha256: SHA_M, status: status("measuring") });
  return r.verdict === "incomplete" && /the verifier had not finished/.test(r.why[0] || "") && r.why.some((w) => /high-severity value mismatch/.test(w));
});
safe("a high mismatch + a measured file naming no expectation → incomplete; the same high with a clean run → fail", () => {
  const unsure = run(measure({ "2:1": { fontSize: 30 } }), { expectationSha256: SHA_E, measuredSha256: SHA_M });
  const clean = run(measure({ "2:1": { fontSize: 30 } }, { expectationSha256: SHA_E }), { expectationSha256: SHA_E, measuredSha256: SHA_M, status: status("done", SHA_M) });
  return unsure.verdict === "incomplete" && clean.verdict === "fail";
});
safe("a status 'done' naming this measured file → pass; inputs.runId = the run", () => {
  const r = run(measure({}, { expectationSha256: SHA_E }), { expectationSha256: SHA_E, measuredSha256: SHA_M, status: status("done", SHA_M) });
  return r.verdict === "pass" && r.inputs?.runId === "run-7";
});
// L-c: --accept refuses a report whose run failed its integrity checks — a waiver would bind to unverified numbers
// (the report as --accept reads it: the JSON on disk, through its guard)
const acceptSel = (r: VerifyReportV2, node: string, field: string): ReturnType<typeof VS.selectForAccept> => {
  const onDisk: unknown = JSON.parse(JSON.stringify(r));
  return isVerifyReport(onDisk) ? VS.selectForAccept(onDisk, { node, field }) : { error: "not a report" };
};
safe("--accept on a report whose run had not finished (a high delta listed) → refused, naming the integrity reason", () => {
  const r = run(measure({ "2:1": { fontSize: 30 } }, { expectationSha256: SHA_E }), { expectationSha256: SHA_E, measuredSha256: SHA_M, status: status("measuring") });
  const sel = acceptSel(r, "2:1", "font-size");
  return r.deltas.some((d) => d.nodeId === "2:1") && "error" in sel && /the report's run is unverified/.test(sel.error) && /the verifier had not finished/.test(sel.error);
});
safe("…a report whose measured file names no expectation, or a status naming another measured file → refused too", () => {
  const noExp = run(measure({ "2:1": { fontSize: 30 } }), { expectationSha256: SHA_E, measuredSha256: SHA_M });
  const other = run(measure({ "2:1": { fontSize: 30 } }, { expectationSha256: SHA_E, runId: "run-7" }), { expectationSha256: SHA_E, measuredSha256: SHA_M, status: status("done", "f".repeat(64)) });
  const otherExp = run(measure({ "2:1": { fontSize: 30 } }, { expectationSha256: "d".repeat(64) }), { expectationSha256: SHA_E, measuredSha256: SHA_M });
  return [noExp, other, otherExp].every((r) => { const sel = acceptSel(r, "2:1", "font-size"); return "error" in sel && /the report's run is unverified/.test(sel.error); });
});
safe("…the same delta in a clean run is selectable", () => {
  const clean = run(measure({ "2:1": { fontSize: 30 } }, { expectationSha256: SHA_E }), { expectationSha256: SHA_E, measuredSha256: SHA_M, status: status("done", SHA_M) });
  const sel = acceptSel(clean, "2:1", "font-size");
  return "deltas" in sel && sel.deltas.length === 1;
});
safe("an older v1 status is never trusted nor judged: pass, with a note", () => {
  const r = run(measure({}, { expectationSha256: SHA_E }), { expectationSha256: SHA_E, measuredSha256: SHA_M, status: { file: "Garden.status.json", status: "v1" } });
  return r.verdict === "pass" && (r.probe.inputNotes || []).some((n) => /older hand-written status/.test(n));
});

// a measured file that names NO run (build-screen's probe without --run), measured AFTER an ENDED run's status
const statusEnded = (phase: "done" | "failed" | "blocked") => ({ file: "Garden.status.json", status: { ...status("done", "f".repeat(64)).status, phase } });
const LATER = { expectationSha256: SHA_E, measuredAt: "2026-09-30T02:00:00Z" }; // the status above is at 01:00
safe("an unbound measured file taken after an earlier run's done (another measured sha) → pass, with a note naming the run", () => {
  const r = run(measure({}, LATER), { expectationSha256: SHA_E, measuredSha256: SHA_M, status: status("done", "f".repeat(64)) });
  return r.verdict === "pass" && !(r.integrity || []).length && (r.probe.inputNotes || []).some((n) => /is run run-7 \(done\); this measured file names no run/.test(n));
});
safe("…that report names no run of its own (inputs.runId unset, no '· run' in the md header; the note keeps the run); a bound one still names its run", () => {
  const r = run(measure({}, LATER), { expectationSha256: SHA_E, measuredSha256: SHA_M, status: status("done", "f".repeat(64)) });
  const bound = run(measure({}, { expectationSha256: SHA_E, runId: "run-7" }), { expectationSha256: SHA_E, measuredSha256: SHA_M, status: status("done", SHA_M) });
  return r.inputs?.runId === undefined && !/· run run-7/.test(reportToMarkdown(r)) && (r.probe.inputNotes || []).some((n) => /is run run-7 \(done\)/.test(n))
    && bound.inputs?.runId === "run-7" && /· run run-7/.test(reportToMarkdown(bound));
});
safe("…taken after an ended run at failed or blocked → pass (an ended run is not 'unfinished')", () =>
  (["failed", "blocked"] as const).every((p) => run(measure({}, LATER), { expectationSha256: SHA_E, measuredSha256: SHA_M, status: statusEnded(p) }).verdict === "pass"));
safe("…an unbound file NOT newer than the ended run (a stale file left behind, or no measuredAt) is still judged by that run → incomplete", () => {
  const stale = (["done", "failed", "blocked"] as const).every((p) => run(measure({}, { expectationSha256: SHA_E }), { expectationSha256: SHA_E, measuredSha256: SHA_M, status: statusEnded(p) }).verdict === "incomplete");
  const untimed = measure({}, LATER);
  delete untimed.measuredAt;
  const noTime = run(untimed, { expectationSha256: SHA_E, measuredSha256: SHA_M, status: statusEnded("failed") }).verdict === "incomplete";
  return stale && noTime;
});
safe("…a stale unbound file beside a run that ended failed/blocked: 'measured before that run ended — measure again', never the end-it hint (the run is over)", () =>
  (["failed", "blocked"] as const).every((p) => {
    const r = run(measure({}, { expectationSha256: SHA_E }), { expectationSha256: SHA_E, measuredSha256: SHA_M, status: statusEnded(p) });
    return r.verdict === "incomplete" && r.why.some((w) => new RegExp(`names no run and was measured before that run ended \\(Garden\\.status\\.json: run run-7 ${p} at .*\\) — measure again`).test(w)) && !r.why.some((w) => /end it:|had not finished/.test(w));
  }));
safe("…beside a run still in flight (measuring) → still incomplete, and the reason says how to end it", () => {
  const r = run(measure({}, LATER), { expectationSha256: SHA_E, measuredSha256: SHA_M, status: status("measuring") });
  return r.verdict === "incomplete" && r.why.some((w) => /the verifier had not finished.*--status Garden --phase failed --run run-7/.test(w));
});
safe("…beside a run at measured (another sha, not yet done) → incomplete, with the same end-it hint", () => {
  const r = run(measure({}, LATER), { expectationSha256: SHA_E, measuredSha256: SHA_M, status: status("measured", "f".repeat(64)) });
  return r.verdict === "incomplete" && r.why.some((w) => /measured again outside run run-7\? — wait for it, or if nobody is running it any more, end it: --status Garden --phase failed --run run-7/.test(w));
});
safe("…a high mismatch in an unbound measurement taken after an ended run is a plain fail (graded, not hidden as incomplete)", () =>
  run(measure({ "2:1": { fontSize: 30 } }, LATER), { expectationSha256: SHA_E, measuredSha256: SHA_M, status: status("done", "f".repeat(64)) }).verdict === "fail");

// an undesigned row quotes its evidence under the evidence's provenance — never "probe said" for agent evidence
{
  const expU = { ...exp, interactions: exp.interactions.map((i) => i.nodeId === "2:4" ? { ...i, destinationExported: false } : i) };
  const miss = ev("2:4", "none", { ok: false, detail: "no dialog appeared" });
  const agent = compare(expU, withEvidence([miss]), { expectationSha256: SHA_E, measuredSha256: SHA_M });
  safe("undesigned, evidence not run-bound (agent evidence) → the detail says 'agent evidence said: …', never 'probe said'", () =>
    ia(agent, "2:4")?.result === "undesigned" && /; agent evidence said: no dialog appeared$/.test(ia(agent, "2:4")?.detail ?? "") && !/probe said/.test(ia(agent, "2:4")?.detail ?? ""));
  const bare = compare(exp, withEvidence([{ nodeId: "2:5", trigger: "on_click", ok: true, detail: "clicked it" }]), {});
  safe("…and an agent's ok without evidence → 'reported ok without evidence — …; agent evidence said: …'", () =>
    ia(bare, "2:5")?.result === "not-probed" && /^reported ok without evidence — .*; agent evidence said: clicked it$/.test(ia(bare, "2:5")?.detail ?? ""));
  const IDENT = { name: "verify-probe", version: "1.0.0", sha256: "a".repeat(64), playwright: { package: "playwright", version: "1.50.0" }, browser: { name: "chromium", version: "130" } };
  const bound = compare(expU, { ...withEvidence([miss]), expectationSha256: SHA_E, runId: "run-7", probe: IDENT }, { expectationSha256: SHA_E, measuredSha256: SHA_M, status: status("done", SHA_M) });
  safe("control: the same row from a run-bound probe → 'probe said: …'", () =>
    ia(bound, "2:4")?.result === "undesigned" && /; probe said: no dialog appeared$/.test(ia(bound, "2:4")?.detail ?? ""));
}

// a measured file that names its run, with no status of that run beside it — nothing recorded it as that run's
safe("measured.runId set, compare looked for a status and found none → incomplete 'no status of that run records it'", () => {
  const r = run(measure({}, { expectationSha256: SHA_E, runId: "run-9" }), { expectationSha256: SHA_E, measuredSha256: SHA_M, status: null });
  return r.verdict === "incomplete" && r.why.some((w) => /taken in run run-9, but no status file was found — no status of that run records it/.test(w));
});
safe("…a status of ANOTHER run → incomplete, naming both runs", () => {
  const r = run(measure({}, { expectationSha256: SHA_E, runId: "run-9" }), { expectationSha256: SHA_E, measuredSha256: SHA_M, status: status("done", SHA_M) });
  return r.verdict === "incomplete" && r.why.some((w) => /taken in run run-9, but Garden\.status\.json is run run-7 — no status of that run records it/.test(w));
});
safe("…another run's status: the hint says re-measure in the current run, never 'record run-9' over it", () => {
  const r = run(measure({}, { expectationSha256: SHA_E, runId: "run-9" }), { expectationSha256: SHA_E, measuredSha256: SHA_M, status: status("measuring", SHA_M) });
  const w = r.why.find((x) => /taken in run run-9/.test(x)) || "";
  return /run run-7 is the current run — re-measure in it/.test(w) && !/--phase measured --run run-9/.test(w);
});
safe("an in-process caller that passes no status option is not judged: measured.runId alone → pass", () => {
  const r = run(measure({}, { expectationSha256: SHA_E, runId: "run-9" }), { expectationSha256: SHA_E, measuredSha256: SHA_M });
  return r.verdict === "pass" && !r.why.some((w) => /no status of that run records it/.test(w));
});
safe("…its own run's done naming this file → pass; no runId in the measured file and no status → pass (hand-run probe)", () => {
  const own = run(measure({}, { expectationSha256: SHA_E, runId: "run-7" }), { expectationSha256: SHA_E, measuredSha256: SHA_M, status: status("done", SHA_M) });
  const bare = run(measure({}, { expectationSha256: SHA_E }), { expectationSha256: SHA_E, measuredSha256: SHA_M, status: null });
  return own.verdict === "pass" && bare.verdict === "pass";
});
// the integrity reasons are recorded as report.integrity; --accept reads that field first
safe("report.integrity holds exactly the integrity reasons (the unfinished run), [] for a clean run", () => {
  const r = run(measure({ "2:1": { fontSize: 30 } }, { expectationSha256: SHA_E }), { expectationSha256: SHA_E, measuredSha256: SHA_M, status: status("measuring") });
  const clean = run(measure({ "2:1": { fontSize: 30 } }, { expectationSha256: SHA_E }), { expectationSha256: SHA_E, measuredSha256: SHA_M, status: status("done", SHA_M) });
  return r.integrity.length === 1 && /the verifier had not finished/.test(r.integrity[0] || "") && clean.integrity.length === 0 && clean.why.length > 0;
});
safe("--accept refuses on report.integrity even when no why[] entry carries a known phrase (reworded / a newer reason)", () => {
  const clean = run(measure({ "2:1": { fontSize: 30 } }, { expectationSha256: SHA_E }), { expectationSha256: SHA_E, measuredSha256: SHA_M, status: status("done", SHA_M) });
  const sel = acceptSel({ ...clean, integrity: ["the run was measured by a probe this version does not know"] }, "2:1", "font-size");
  return "error" in sel && /the report's run is unverified \(the run was measured by a probe this version does not know\)/.test(sel.error);
});
safe("…an older report (no integrity field) still refused by why[] wording; integrity [] trusts the field", () => {
  const r = run(measure({ "2:1": { fontSize: 30 } }, { expectationSha256: SHA_E }), { expectationSha256: SHA_E, measuredSha256: SHA_M, status: status("measuring") });
  const { integrity: _i, ...older } = r;
  const onDisk: unknown = JSON.parse(JSON.stringify(older));
  const selOld = isVerifyReport(onDisk) ? VS.selectForAccept(onDisk, { node: "2:1", field: "font-size" }) : { error: "" };
  const clean = run(measure({ "2:1": { fontSize: 30 } }, { expectationSha256: SHA_E }), { expectationSha256: SHA_E, measuredSha256: SHA_M, status: status("done", SHA_M) });
  const selNew = acceptSel(clean, "2:1", "font-size");
  return "error" in selOld && /the verifier had not finished/.test(selOld.error) && "deltas" in selNew;
});

// ---------------------------------------------------------------- CLI
console.log("CLI --compare with the run status beside the measured file:");
{
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dt-integrity-"));
  const VS_TS = path.join(import.meta.dirname, "..", "design-to-code", "verify-screen.ts");
  const cli = (...args: string[]) => spawnSync(process.execPath, [VS_TS, ...args], { cwd, encoding: "utf8" });
  const dir = path.join(cwd, "design", "verify");
  fs.mkdirSync(dir, { recursive: true });
  const expFile = path.join(dir, "Garden.expected.json");
  fs.writeFileSync(expFile, JSON.stringify(exp, null, 2) + "\n");
  const shaE = crypto.createHash("sha256").update(fs.readFileSync(expFile)).digest("hex");
  fs.writeFileSync(path.join(dir, "Garden.png"), "png");
  fs.writeFileSync(path.join(dir, "Garden.measured.json"), JSON.stringify(measure({}, { expectationSha256: shaE, artifacts: ["design/verify/Garden.png"] })));
  const st = cli("--status", "Garden", "--phase", "measuring", "--new-run");
  safe("the measuring status is live (run cache), not in design/verify", () => st.status === 0 && !fs.existsSync(path.join(dir, "Garden.status.json")));
  const c1 = cli("--compare", "design/verify/Garden.expected.json", "design/verify/Garden.measured.json");
  const rep1 = readJsonOrNull(path.join(dir, "Garden.report.json"), isVerifyReport);
  safe("status at 'measuring' → exit 1, the report IS written, verdict incomplete with the status reason", () => st.status === 0 && c1.status === 1 && rep1?.verdict === "incomplete" && (rep1.why || []).some((w) => /is at phase measuring/.test(w)));
  const done = cli("--status", "Garden", "--phase", "done");
  const c2 = cli("--compare", "design/verify/Garden.expected.json", "design/verify/Garden.measured.json");
  const rep2 = readJsonOrNull(path.join(dir, "Garden.report.json"), isVerifyReport);
  safe("after --status done (same run) → exit 0, pass, inputs.runId recorded; done published design/verify/Garden.status.json", () => done.status === 0 && fs.existsSync(path.join(dir, "Garden.status.json")) && c2.status === 0 && rep2?.verdict === "pass" && typeof rep2.inputs?.runId === "string" && rep2.inputs.runId.length > 0);
  safe("no tmp files are left beside the report (atomic writes)", () => !fs.readdirSync(dir).some((f) => f.includes(".tmp-")));
  // a measured file naming a run no status records (the probe's status write was refused) → incomplete
  fs.writeFileSync(path.join(dir, "Garden.measured.json"), JSON.stringify(measure({}, { expectationSha256: shaE, artifacts: ["design/verify/Garden.png"], runId: "run-unrecorded" })));
  const c3 = cli("--compare", "design/verify/Garden.expected.json", "design/verify/Garden.measured.json");
  const rep3 = readJsonOrNull(path.join(dir, "Garden.report.json"), isVerifyReport);
  safe("CLI: measured.runId names a run the status (another run's done) does not → exit 1, incomplete, report.integrity lists it", () =>
    c3.status === 1 && rep3?.verdict === "incomplete" && (rep3.integrity || []).some((w) => /taken in run run-unrecorded/.test(w)));
  // the probe wrote into a stage dir (--out elsewhere): its status is keyed by the EXPECTATION's dir — found there
  const rec = cli("--status", "Garden", "--phase", "measuring", "--run", "run-staged");
  const stageDir = path.join(cwd, "stage-elsewhere");
  fs.mkdirSync(stageDir);
  fs.writeFileSync(path.join(stageDir, "Garden.measured.json"), JSON.stringify(measure({}, { expectationSha256: shaE, runId: "run-staged" })));
  const c4 = cli("--compare", "design/verify/Garden.expected.json", "stage-elsewhere/Garden.measured.json", "--out", "stage-elsewhere/Garden");
  const rep4 = readJsonOrNull(path.join(stageDir, "Garden.report.json"), isVerifyReport);
  safe("CLI: a staged measured file naming its run finds the run's status by the expectation's dir (at measuring → 'had not finished', not 'unrecorded')", () =>
    rec.status === 0 && c4.status === 1 && (rep4?.why || []).some((w) => /is at phase measuring/.test(w)) && !(rep4?.why || []).some((w) => /no status of that run records it/.test(w)));
  // build-screen's recipe — probe without --run — after an earlier run ended: a fresh unbound measured file
  cli("--status", "Garden", "--phase", "failed", "--run", "run-staged"); // end the in-flight run above
  const st5 = cli("--status", "Garden", "--phase", "starting", "--new-run");
  const run5 = st5.stdout.trim().split(" ")[1] ?? "";
  fs.writeFileSync(path.join(dir, "Garden.measured.json"), JSON.stringify(measure({}, { expectationSha256: shaE, runId: run5, artifacts: ["design/verify/Garden.png"] })));
  const done5 = cli("--status", "Garden", "--phase", "done", "--run", run5);
  fs.writeFileSync(path.join(dir, "Garden.measured.json"), JSON.stringify(measure({}, { expectationSha256: shaE, measuredAt: new Date(Date.now() + 1000).toISOString(), artifacts: ["design/verify/Garden.png"] })));
  const c5 = cli("--compare", "design/verify/Garden.expected.json", "design/verify/Garden.measured.json");
  const rep5 = readJsonOrNull(path.join(dir, "Garden.report.json"), isVerifyReport);
  safe("CLI: a fresh measured file with no runId after an earlier run's done → exit 0, pass (not 'names a different measured file')", () =>
    done5.status === 0 && c5.status === 0 && rep5?.verdict === "pass" && !(rep5.integrity || []).length);
  fs.rmSync(path.dirname(liveStatusFile(path.join(dir, "Garden"))), { recursive: true, force: true }); // the run cache (OS temp dir: no node_modules here)
  fs.rmSync(cwd, { recursive: true, force: true });
}

report();
