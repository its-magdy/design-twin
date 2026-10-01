// Group 12a (slice A) — what --expect and --compare do with the probe's new evidence: F-117 overlay settings of an
// overlay's destination, F-95 plan interactions merged at --expect (D40(7)), L-1 steps (probe-steps.ts, reach),
// D41 evidence precedence by provenance (a run-bound probe row vs the agent's), D43 page overflow at the design width.
// Expectations come from the real `buildExpectation` over plugin-shaped screen exports (test/fixtures.ts; the overlay
// block has the shape figma-plugin/src/serialize.ts writes on a destination root). Invented names throughout.
// Run with:  node test/verify-drive.test.ts
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildExpectation, compare, reportToMarkdown, STYLE_KEYS } from "../design-to-code/verify-screen.ts";
import type { CompareOptions, ExpectInput, ExpectOptions } from "../design-to-code/verify-screen.ts";
import { planInteractionsSha256 } from "../design-to-code/plan-waivers.ts";
import { actionForExpect, parseSteps, stepsSha256 } from "../design-to-code/probe-steps.ts";
import { isVerifyExpectation, isVerifyReport, readableMeasured } from "../design-to-code/doc-guards.ts";
import { readJsonOrNull } from "../design-to-code/read-json.ts";
import type { VerifyStatusV2 } from "../design-to-code/verify-run.ts";
import type {
  InteractionEvidence, MeasuredNode, MeasuredStyles, PageOverflow, Plan, PlanWaiver, ProbeIdentity, ProbeStep, ScreenDoc, VerifyMeasured, VerifyReport, VerifyReportV2, VerifySpec,
} from "../design-to-code/types.ts";
import { screenExport } from "./fixtures.ts";
import type { NodeInput } from "./fixtures.ts";
import { check, report } from "./assert.ts";

const safe = (name: string, fn: () => boolean): boolean => { let r = false; try { r = fn(); } catch (e) { console.log(`    (threw: ${e instanceof Error ? e.message : String(e)})`); } return check(name, r); };

// ---------------------------------------------------------------- the screen and its dialogs (invented names)
const KIT = "Kitchen Kit";
const btn = (id: string, name: string, reactions?: NodeInput["reactions"]): NodeInput =>
  ({ type: "FRAME", id, name, fills: [{ type: "solid", color: "#2255aa" }], ...(reactions ? { reactions } : {}) });
const overlayTo = (dest: string): NodeInput["reactions"] => [{ trigger: "on_click", actions: [{ type: "NODE", navigation: "overlay", destinationId: dest }] }];
const PANTRY = (scroll?: "horizontal"): NodeInput => ({
  type: "FRAME", id: "1:1", name: "Pantry", box: { x: 0, y: 0, w: 1280, h: 800 }, fills: [{ type: "solid", color: "#ffffff" }], ...(scroll ? { scroll } : {}), children: [
    { type: "TEXT", id: "2:1", name: "Title", text: "Pantry", font: { family: "Inter", size: 20, color: "#111111" } },
    btn("2:2", "Add Jar", overlayTo("3:1")),
    btn("2:3", "Edit Jar", overlayTo("3:2")),
    btn("2:4", "Share Shelf", overlayTo("9:9")),
    btn("2:5", "Remove Jar"),
    { type: "FRAME", id: "2:6", name: "Old Tab", hidden: true, fills: [{ type: "solid", color: "#cccccc" }] },
    btn("2:7", "Jar Details", [{ trigger: "on_click", actions: [{ type: "NODE", navigation: "navigate", destinationId: "1:50" }] }]),
  ],
});
const screen = (scroll?: "horizontal"): ExpectInput => ({ doc: screenExport([PANTRY(scroll)], { exportedAt: "2026-10-01T00:00:00Z", screen: "Pantry", nodeId: "1:1", sourceFile: KIT }), label: "Pantry__1_1" });
// a dialog frame as its own export; `overlay` = the block serialize.ts writes on a destination root (only non-default)
const dialog = (id: string, name: string, overlay?: { position?: string; closeOnClickOutside?: true; background?: string }): ScreenDoc =>
  screenExport([{ type: "FRAME", id, name, box: { x: 0, y: 0, w: 480, h: 320 }, fills: [{ type: "solid", color: "#ffffff" }], ...(overlay ? { overlay } : {}) }],
    { exportedAt: "2026-10-01T00:00:00Z", screen: name, nodeId: id, sourceFile: KIT });
const SIBLINGS: Record<string, ScreenDoc> = {
  "pages/Main/Add_Jar__3_1.json": dialog("3:1", "Add Jar", { position: "center", closeOnClickOutside: true, background: "#00000040" }),
  "pages/Main/Edit_Jar__3_2.json": dialog("3:2", "Edit Jar"),
  "pages/Main/Remove_Jar__3_3.json": dialog("3:3", "Remove Jar"),
};
const LAYERS = [
  { id: "1:1", name: "Pantry", file: "pages/Main/Pantry__1_1.json", sourceFile: KIT },
  { id: "3:1", name: "Add Jar", file: "pages/Main/Add_Jar__3_1.json", sourceFile: KIT },
  { id: "3:2", name: "Edit Jar", file: "pages/Main/Edit_Jar__3_2.json", sourceFile: KIT },
  { id: "3:3", name: "Remove Jar", file: "pages/Main/Remove_Jar__3_3.json", sourceFile: KIT },
  { id: "1:50", name: "Jar Details", file: "pages/Main/Jar_Details__1_50.json", sourceFile: KIT },
  { id: "9:9", name: "Share Sheet", file: "pages/Main/Share_Sheet__9_9.json", sourceFile: "Other Kit" },
];
const OPTS: ExpectOptions = { index: { layers: LAYERS }, readSibling: (f) => SIBLINGS[f] ?? null };
const PLAN = (interactions: Plan["interactions"] | null, extra: Partial<Plan> = {}): Plan => ({ schema: "designtwin/plan@2", screen: "Pantry__1_1", nodeId: "1:1", ...(interactions ? { interactions } : {}), ...extra });
const REMOVE_ROW = { nodeId: "2:5", trigger: "ON_CLICK", expect: "dialog", destinationId: "3:3" } as const;

const exp = buildExpectation([screen()], OPTS);
const ia = (rows: typeof exp.interactions, id: string) => rows.find((i) => i.nodeId === id);

// ---------------------------------------------------------------- 1–3 F-117: the destination's overlay settings
console.log("F-117 — an overlay's destination settings at --expect:");
safe("[1] destination exported with an overlay block (sibling export, same file) → overlay {center, true, #00000040, from export}", () =>
  JSON.stringify(ia(exp.interactions, "2:2")?.overlay) === JSON.stringify({ position: "center", closeOnClickOutside: true, background: "#00000040", from: "export" }));
safe("[2] destination exported with NO overlay block → Figma's defaults {center, false, null, from default}", () =>
  JSON.stringify(ia(exp.interactions, "2:3")?.overlay) === JSON.stringify({ position: "center", closeOnClickOutside: false, background: null, from: "default" }));
safe("[3] destination never exported (another file's id) → destinationExported false, no overlay; a navigate row gets none either", () => {
  const share = ia(exp.interactions, "2:4"), nav = ia(exp.interactions, "2:7");
  return !!share && share.destinationExported === false && share.overlay === undefined && !!nav && nav.overlay === undefined && ia(exp.interactions, "2:2")?.overlay !== undefined;
});
safe("[3] D43 — the frame root's scroll direction travels with expectation.frame", () => buildExpectation([screen("horizontal")], OPTS).frame.scroll === "horizontal" && exp.frame.scroll === undefined);

// ---------------------------------------------------------------- 4–5 F-95: plan interactions merged at --expect
console.log("F-95 — plan.interactions merged at --expect:");
{
  const plan = PLAN([REMOVE_ROW]);
  const e = buildExpectation([screen()], { ...OPTS, plan: { file: "design/plan/Pantry__1_1.json", plan } });
  const r = ia(e.interactions, "2:5");
  safe("[4] the row is merged: source plan, action overlay (expect dialog), trigger lowercased, the export node's name", () =>
    !!r && r.source === "plan" && r.action === "overlay" && r.expect === "dialog" && r.trigger === "on_click" && r.name === "Remove Jar" && r.destinationId === "3:3");
  safe("[4] …its destination's overlay is read like an export row's (defaults here)", () => r?.overlay?.from === "default");
  safe("[4] expectation.planInteractions {plan, sha256 = planInteractionsSha256(plan), merged 1, dropped []}", () =>
    !!e.planInteractions && e.planInteractions.plan === "design/plan/Pantry__1_1.json" && e.planInteractions.sha256 === planInteractionsSha256(plan) && e.planInteractions.merged === 1 && e.planInteractions.dropped.length === 0);
  safe("[4] exportContentSha256 unchanged by the plan (D21: waivers bind the export only); counts.interactions +1", () =>
    e.exportContentSha256 === exp.exportContentSha256 && e.counts.interactions === exp.counts.interactions + 1);
  safe("[4] actionForExpect: dialog → overlay, url → navigate, selector:… → other", () =>
    actionForExpect("dialog") === "overlay" && actionForExpect("url") === "navigate" && actionForExpect("selector:#jar-list") === "other");
}
{
  const plan = PLAN([
    { trigger: "on_click", expect: "url" },
    { nodeId: "7:7", trigger: "on_click", expect: "url" },
    { nodeId: "2:1", trigger: "on_click", expect: "dialog" },
    { nodeId: "2:1", trigger: "on_click", expect: "fill" },
    { nodeId: "2:2", trigger: "on_click", expect: "dialog", destinationId: "3:1" },
    { nodeId: "2:6", trigger: "on_click", expect: "url" },
    { nodeId: "2:1", trigger: "on_press", expect: "selector:#jar-count" },
  ]);
  const e = buildExpectation([screen()], { ...OPTS, plan: { file: "design/plan/Pantry__1_1.json", plan } });
  const dropped = e.planInteractions?.dropped ?? [];
  const why = (id: string, re: RegExp): boolean => dropped.some((d) => d.nodeId === id && re.test(d.why));
  safe("[5] dropped with why: no nodeId / unknown node / dialog without destinationId / expect 'fill' / duplicate of the export row / hidden layer", () =>
    dropped.length === 6 && why("(interactions[0])", /no nodeId/) && why("7:7", /no visible node/) && why("2:1", /needs the destinationId/) && why("2:1", /'?"?fill/) && why("2:2", /duplicates the export's own interaction/) && why("2:6", /hidden layer/));
  safe("[5] …the valid row is kept (selector:… → action other), the export's own 2:2 row is untouched", () =>
    e.planInteractions?.merged === 1 && ia(e.interactions, "2:1")?.action === "other" && e.interactions.filter((i) => i.nodeId === "2:2").length === 1 && ia(e.interactions, "2:2")?.source === undefined);
}

// ---------------------------------------------------------------- compare helpers
const SHA_E = "e".repeat(64), SHA_M = "a".repeat(64);
const PROBE: ProbeIdentity = { name: "verify-probe", version: "1.0.0", sha256: "b".repeat(64), playwright: { package: "playwright", version: "1.63.0" }, browser: { name: "chromium", version: "153.0" } };
const status = (measuredSha256: string = SHA_M): { file: string; status: VerifyStatusV2 } =>
  ({ file: "Pantry.status.json", status: { schema: "designtwin/verify-status@2", screen: "Pantry", runId: "run-12", rev: 4, phase: "done", detail: "", at: "2026-10-01T01:00:00Z", by: "orchestrator", expectationSha256: SHA_E, measuredSha256 } });
function echo(spec: VerifySpec): MeasuredNode {
  const styles: MeasuredStyles = {};
  const src: Record<string, unknown> = { ...spec };
  for (const k of STYLE_KEYS) { const v = src[k]; if (v !== undefined) styles[k] = v; }
  return { nodeId: spec.nodeId, styles, matchedBy: "tag" };
}
const pass = (nodeId: string, outcome: string): InteractionEvidence => ({ nodeId, trigger: "on_click", ok: true, selector: `[data-dt-node="${nodeId}"]`, selectorCount: 1, outcome, navEvents: 0 });
// the shipped probe's pass of an overlay: mouse, a dialog contract match, the destination tag inside what opened
const probePass = (nodeId: string, dest: string, inside = true): InteractionEvidence =>
  ({ ...pass(nodeId, "dialog-opened"), activation: "mouse", detectedBy: ":modal", destination: { nodeId: dest, inside, count: 1 } });
const OTHERS = [probePass("2:3", "3:2"), pass("2:7", "url-changed")];
function measured(rows: InteractionEvidence[], extra: Partial<VerifyMeasured> = {}, e = exp): VerifyMeasured {
  return { measuredAt: "2026-10-01T01:00:00Z", renderer: "playwright-chromium", viewport: "1280x800", expectationSha256: SHA_E, probe: PROBE, runId: "run-12",
    nodes: e.nodes.map(echo), interactions: rows, ...extra };
}
const bound = (o: CompareOptions = {}): CompareOptions => ({ expectationSha256: SHA_E, measuredSha256: SHA_M, status: status(), ...o });
const res = (r: VerifyReportV2, id: string) => r.interactions.find((i) => i.nodeId === id);
const fail2 = (nodeId: string): InteractionEvidence => ({ nodeId, trigger: "on_click", ok: false, selector: `[data-dt-node="${nodeId}"]`, selectorCount: 1, detail: "nothing opened" });

// ---------------------------------------------------------------- 6 CLI: --plan at --expect, plan auto-discovery
console.log("F-95 — the CLI: --plan at --expect, and the plan found in design/plan/:");
{
  const CLI = path.join(import.meta.dirname, "..", "design-to-code", "verify-screen.ts");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "verify-drive-"));
  const put = (rel: string, v: unknown): string => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), JSON.stringify(v, null, 2)); return rel; };
  const scr = screen().doc;
  const shot = put("design/export/pages/Main/Pantry__1_1.json", scr);
  for (const [f, d] of Object.entries(SIBLINGS)) put(`design/export/${f}`, d);
  put("design/export/pages/index.json", { pageDirs: [{ dir: "Main", index: "pages/Main/index.json" }], layers: LAYERS });
  const planFile = put("design/plan/Pantry__1_1.json", PLAN([REMOVE_ROW]));
  const cli = (...a: string[]) => spawnSync(process.execPath, [CLI, ...a], { encoding: "utf8", cwd });
  const readExp = () => readJsonOrNull(path.join(cwd, "design/verify/Pantry__1_1.expected.json"), isVerifyExpectation);
  const withFlag = cli("--expect", shot, "--plan", planFile);
  const e1 = readExp();
  safe("[6] --expect --plan <plan> exits 0 (was 'only applies to --compare', exit 2) and merges the row", () =>
    withFlag.status === 0 && !!e1 && !!e1.planInteractions && e1.planInteractions.merged === 1 && (e1.interactions || []).some((i) => i.nodeId === "2:5" && i.source === "plan"));
  safe("[6] …the overlay of an exported destination is read through the real index + sibling file", () =>
    (e1?.interactions || []).some((i) => i.nodeId === "2:2" && i.overlay !== undefined && i.overlay.from === "export" && i.overlay.background === "#00000040"));
  fs.rmSync(path.join(cwd, "design/verify"), { recursive: true, force: true });
  const auto = cli("--expect", shot);
  const e2 = readExp();
  safe("[6] without --plan: the one plan in design/plan/ for this frame is used", () => auto.status === 0 && e2?.planInteractions?.plan === "design/plan/Pantry__1_1.json" && e2.planInteractions.merged === 1);
  put("design/plan/Pantry.json", PLAN([REMOVE_ROW], { screen: "Pantry" }));
  fs.rmSync(path.join(cwd, "design/verify"), { recursive: true, force: true });
  const two = cli("--expect", shot);
  const e3 = readExp();
  safe("[6] two plans describe the frame → a note, nothing merged", () => two.status === 0 && !!e3 && e3.planInteractions === undefined && /2 plans in design\/plan\/ describe this frame/.test(two.stderr));
  const badPlan = put("design/plan/broken.json", { interactions: { nodeId: "2:5" } });
  const bad = cli("--expect", shot, "--plan", badPlan);
  safe("[6] --plan naming a plan whose interactions is not a list → exit 2 (not a plan)", () => bad.status === 2 && /is not a plan/.test(bad.stderr));
  fs.rmSync(cwd, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 7 the plan's interactions bind the expectation
console.log("F-95 — a plan whose interactions changed since --expect:");
{
  const plan = PLAN([REMOVE_ROW]);
  const e = buildExpectation([screen()], { ...OPTS, plan: { file: "design/plan/Pantry__1_1.json", plan } });
  const rows = [pass("2:2", "dialog-opened"), ...OTHERS, pass("2:5", "dialog-opened")];
  const same = compare(e, measured(rows, {}, e), { plan: { file: "design/plan/Pantry__1_1.json", plan } });
  safe("[7] unchanged plan interactions → no reason, pass", () => same.verdict === "pass" && !same.why.some((w) => /interactions\[\] changed/.test(w)));
  const changed = PLAN([{ ...REMOVE_ROW, destinationId: "3:2" }]);
  const r = compare(e, measured(rows, {}, e), { plan: { file: "design/plan/Pantry__1_1.json", plan: changed } });
  safe("[7] changed → incomplete 'the plan's interactions[] changed since --expect … re-run --expect' (not an integrity reason)", () =>
    r.verdict === "incomplete" && r.why.some((w) => /the plan's interactions\[\] changed since --expect .*re-run --expect/.test(w)) && r.integrity.length === 0);
  const declares = compare(exp, measured([pass("2:2", "dialog-opened"), ...OTHERS]), { plan: { file: "design/plan/Pantry__1_1.json", plan } });
  safe("[7] the plan now declares interactions the expectation never merged → incomplete", () => declares.verdict === "incomplete" && declares.why.some((w) => /the expectation merged none/.test(w)));
}

// ---------------------------------------------------------------- 8–12 D41: evidence precedence by provenance
console.log("D41 — a run-bound probe row against the agent's:");
{
  const r = compare(exp, measured([probePass("2:2", "3:1"), ...OTHERS]), bound({ interactions: [fail2("2:2")] }));
  const x = res(r, "2:2");
  safe("[8] bound probe pass (destination inside) vs an agent ok:false → pass from the probe (later agent row used to win: fail)", () =>
    x?.result === "pass" && x.evidenceFrom === "probe" && x.activation === "mouse" && x.detectedBy === ":modal" && r.verdict === "pass");
  safe("[8] …the agent's disagreement is recorded (result.overridden + an input note); coverage.interactionsByProbe counts it", () =>
    /agent row ok: false/.test(x?.overridden ?? "") && (r.probe.inputNotes || []).some((n) => /run-bound probe's pass overrides/.test(n)) && r.coverage.interactionsByProbe === 3);
  safe("[8] report.md says how many the shipped probe drove", () => /3 driven by the shipped probe \(dialog contract\)/.test(reportToMarkdown(r)));
}
{
  const r = compare(exp, measured([probePass("2:2", "3:1", false), ...OTHERS]), bound());
  safe("[9] a probe pass WITHOUT the destination tag inside what opened → not-probed (D41), not pass", () =>
    res(r, "2:2")?.result === "not-probed" && /without the destination tag inside the opened element \(D41\)/.test(res(r, "2:2")?.detail ?? "") && r.verdict === "incomplete");
  const other = compare(exp, measured([{ ...probePass("2:2", "3:2") }, ...OTHERS]), bound());
  safe("[9] …nor a pass whose tag inside names another frame", () => res(other, "2:2")?.result === "not-probed");
  const withAgent = compare(exp, measured([probePass("2:2", "3:1", false), ...OTHERS]), bound({ interactions: [pass("2:2", "dialog-opened")] }));
  safe("[9] …with an agent row, the agent's full-D24 pass is graded instead", () => res(withAgent, "2:2")?.result === "pass" && res(withAgent, "2:2")?.evidenceFrom === "agent");
}
{
  const miss: InteractionEvidence = { nodeId: "2:2", trigger: "on_click", ok: null, detail: "nothing detected within 2 s" };
  const r = compare(exp, measured([miss, ...OTHERS]), bound({ interactions: [pass("2:2", "dialog-opened")] }));
  safe("[10] (guard) a probe miss (ok:null) never overrides an agent's full-D24 pass", () => res(r, "2:2")?.result === "pass");
  const alone = compare(exp, measured([miss, ...OTHERS]), bound());
  safe("[10] (guard) …a probe miss alone → not-probed with the probe's detail", () => res(alone, "2:2")?.result === "not-probed" && /nothing detected/.test(res(alone, "2:2")?.detail ?? ""));
}
{
  const cut: InteractionEvidence = { ...probePass("2:2", "3:1"), cut: "budget" };
  const r = compare(exp, measured([cut, ...OTHERS]), bound({ interactions: [fail2("2:2")] }));
  safe("[11] (guard) a budget-cut probe row never overrides: the agent's fail stands", () => res(r, "2:2")?.result === "fail");
  const cutNull: InteractionEvidence = { nodeId: "2:2", trigger: "on_click", ok: null, cut: "budget", detail: "not-run: time budget" };
  const alone = compare(exp, measured([cutNull, ...OTHERS]), bound());
  safe("[11] (guard) a budget-cut row alone → not-probed", () => res(alone, "2:2")?.result === "not-probed");
}
{
  // a measured row that SAYS it is the probe's, in a file no finished run binds — the field is never read
  const claimed = { ...probePass("2:2", "3:1"), by: "verify-probe" };
  const row: InteractionEvidence = claimed;
  const noStatus = compare(exp, measured([row, ...OTHERS]), { expectationSha256: SHA_E, measuredSha256: SHA_M, interactions: [fail2("2:2")] });
  safe("[12] (guard) unbound measured file (no status) with by:'verify-probe' ok:true + an agent fail → fail (later evidence wins, as before)", () => res(noStatus, "2:2")?.result === "fail");
  const otherSha = compare(exp, measured([row, ...OTHERS]), bound({ status: status("f".repeat(64)), interactions: [fail2("2:2")] }));
  safe("[12] (guard) a status naming another measured file binds nothing either (and is an integrity failure)", () => res(otherSha, "2:2")?.result === "fail" && otherSha.verdict === "incomplete");
  const { probe: _p, ...noProbe } = measured([row, ...OTHERS]);
  const bareProbe = compare(exp, noProbe, bound({ interactions: [fail2("2:2")] }));
  safe("[12] (guard) no shipped-probe identity in the file → not bound → the agent's fail stands", () => res(bareProbe, "2:2")?.result === "fail");
}

// ---------------------------------------------------------------- 13–17 D43: page overflow at the design width
console.log("D43 — the page scrolls sideways at the design width:");
const page = (p: Partial<PageOverflow> = {}): PageOverflow => ({ viewport: { w: 1280, h: 800 }, scrollWidth: 1562, clientWidth: 1280, overflowX: "visible", scrollable: true,
  offenders: [{ path: "main > table.jars", dt: "2:7", right: 1562 }], ...p });
const ALL = [probePass("2:2", "3:1"), ...OTHERS];
const over = compare(exp, measured(ALL, { page: page() }), bound());
{
  const d = over.deltas.find((x) => x.field === "overflowX");
  safe("[13] a HIGH delta on the frame root, field overflowX, expected clientWidth 1280, actual scrollWidth 1562, 282px → verdict fail", () =>
    !!d && d.severity === "high" && d.nodeId === "1:1" && d.expected === 1280 && d.actual === 1562 && d.delta === 282 && d.unit === "px" && over.verdict === "fail");
  safe("[13] …the note names the widest element and the --accept command; coverage.pageOverflow 'overflows'", () =>
    /main > table\.jars/.test(d?.note ?? "") && /--accept --node 1:1 --field overflowX/.test(d?.note ?? "") && over.coverage.pageOverflow === "overflows");
}
{
  const ok = compare(exp, measured(ALL), bound());
  const scrolls = compare(buildExpectation([screen("horizontal")], OPTS), measured(ALL, { page: page() }), bound());
  const narrow = compare(exp, measured(ALL, { page: page({ viewport: { w: 1024, h: 768 }, clientWidth: 1024 }) }), bound());
  const clipped = compare(exp, measured(ALL, { page: page({ overflowX: "hidden", scrollable: false }) }), bound());
  const fits = compare(exp, measured(ALL, { page: page({ scrollWidth: 1281 }) }), bound());
  const none = (r: VerifyReportV2): boolean => !r.deltas.some((x) => x.field === "overflowX");
  safe("[14] the frame is designed to scroll sideways → no delta, 'designed to scroll'", () => none(scrolls) && scrolls.coverage.pageOverflow === "designed to scroll");
  safe("[14] measured at 1024 against a 1280 design → no delta, 'not at design width' + a note", () =>
    none(narrow) && narrow.coverage.pageOverflow === "not at design width" && (narrow.probe.inputNotes || []).some((n) => /1024px viewport, the design is 1280px/.test(n)));
  safe("[14] no page block → 'not measured', and the verdict is the one the page-less compare gives", () => none(ok) && ok.coverage.pageOverflow === "not measured" && ok.verdict === "pass");
  safe("[14] overflow the root clips (overflow-x hidden) → 'clipped', a note, no delta", () =>
    none(clipped) && clipped.coverage.pageOverflow === "clipped" && clipped.verdict === "pass" && (clipped.probe.inputNotes || []).some((n) => /clips it \(overflow-x: hidden\)/.test(n)));
  safe("[14] 1px over (rounding) → 'ok'", () => none(fits) && fits.coverage.pageOverflow === "ok");
}
{
  const w = (p: Partial<PlanWaiver> = {}): PlanWaiver => ({ nodeId: "1:1", field: "overflowX", designed: 1280, built: 1562, exportContentSha256: exp.exportContentSha256,
    reason: "the jar table scrolls on purpose", decidedBy: "Sam Doe", decidedAt: "2026-10-01T02:00:00Z", ...p });
  const accepted = compare(exp, measured(ALL, { page: page() }), bound({ waivers: [w()] }));
  safe("[15] a waiver (frame id + overflowX + 1280/1562 + export hash) → pass-with-deviations", () => accepted.verdict === "pass-with-deviations" && accepted.waivers.applied === 1);
  const wider = compare(exp, measured(ALL, { page: page({ scrollWidth: 1700 }) }), bound({ waivers: [w()] }));
  safe("[15] …the page grows to 1700 → reopened (built value moved), fail", () => wider.verdict === "fail" && wider.waivers.reopened.some((x) => x.field === "overflowX" && /built value moved/.test(x.why)));
  const within = compare(exp, measured(ALL, { page: page({ scrollWidth: 1563.5 }) }), bound({ waivers: [w()] }));
  safe("[15] …within the position tolerance (2px) → still accepted", () => within.verdict === "pass-with-deviations");
  const reexp = compare(exp, measured(ALL, { page: page() }), bound({ waivers: [w({ exportContentSha256: "c".repeat(64) })] }));
  safe("[15] …a re-export (export hash) reopens it", () => reexp.verdict === "fail" && reexp.waivers.reopened.some((x) => /design re-exported/.test(x.why)));
}
{
  const parsed: unknown = JSON.parse(JSON.stringify(over));
  const prev: VerifyReport | null = isVerifyReport(parsed) ? parsed : null;
  const gone = prev ? compare(exp, measured(ALL), bound({ measuredSha256: "d".repeat(64), status: status("d".repeat(64)), against: { file: "Pantry.report.json", report: prev } })) : null;
  safe("[16] a previous overflowX delta, page not measured now → lost coverage, not fixed", () =>
    !!gone && !!gone.against?.deltas && gone.against.deltas.fixed === 0 && gone.against.deltas.lostCoverage.some((l) => l.field === "overflowX" && /page overflow was not measured/.test(l.why)));
  const fixed = prev ? compare(exp, measured(ALL, { page: page({ scrollWidth: 1280 }) }), bound({ measuredSha256: "d".repeat(64), status: status("d".repeat(64)), against: { file: "Pantry.report.json", report: prev } })) : null;
  safe("[16] …measured again and fitting → fixed", () => !!fixed && fixed.against?.deltas?.fixed === 1 && fixed.against.deltas.lostCoverage.length === 0);
}
{
  const ok = compare(exp, measured(ALL, { page: page({ scrollWidth: 1280 }), reach: { steps: [{ click: "#pantry" }], sha256: stepsSha256([{ click: "#pantry" }]), source: "--steps steps.json", url: "http://localhost:5173/" }, behaviour: { summary: {} } }), bound());
  safe("[17] reach / page / behaviour are known top-level keys (not listed as unknown)", () =>
    !(ok.probe.unknownTopLevelKeys || []).some((k) => ["reach", "page", "behaviour"].includes(k.key)));
  const rm = readableMeasured({ nodes: [], page: { scrollWidth: "wide" }, reach: { steps: "x" } });
  safe("[17] a malformed page / reach is dropped with a note (the file still compares)", () =>
    !!rm && rm.doc.page === undefined && rm.doc.reach === undefined && rm.notes.some((n) => /^measured\.page is not/.test(n)) && rm.notes.some((n) => /^measured\.reach is not/.test(n)));
}

// ---------------------------------------------------------------- 18–19 L-1: steps
console.log("L-1 — the steps vocabulary and the reach record:");
{
  const okArr = parseSteps([{ click: "[data-dt-node=\"70:30\"]" }, { waitFor: "[data-dt-node=\"70:1\"]" }, { goto: "/pantry?shelf=2" }]);
  const okPlan = parseSteps({ screen: "Pantry", navigate: [{ click: "#shelves" }] });
  const err = (x: unknown, re: RegExp): boolean => { const r = parseSteps(x); return "error" in r && re.test(r.error); };
  safe("[18] an array of click / waitFor / goto, or a plan with navigate[], parses", () => "steps" in okArr && okArr.steps.length === 3 && "steps" in okPlan && okPlan.steps.length === 1);
  safe("[18] fill / press / hover are refused naming the step", () =>
    err([{ click: "#a" }, { fill: "#q" }], /step 2 \{fill: …\} is not a step.*form/) && err([{ press: "Enter" }], /step 1 \{press/) && err([{ hover: "#row" }], /hover/));
  safe("[18] two keys, an empty selector, a cross-origin goto are refused", () =>
    err([{ click: "#a", waitFor: "#b" }], /2 keys/) && err([{ click: " " }], /non-empty/) && err([{ goto: "https://example.test/x" }], /same-origin path/) && err([{ goto: "//example.test" }], /same-origin/));
  safe("[18] not a list, a plan without navigate → refused", () => err("click #a", /not a list/) && err({ screen: "Pantry" }, /no `navigate`/));
  const a: unknown = JSON.parse('{"navigate":[{"click":"#shelves"},{"waitFor":"#jars"}],"screen":"Pantry"}');
  const b: unknown = JSON.parse('{\n  "screen": "Pantry",\n  "navigate": [ { "click": "#shelves" }, { "waitFor": "#jars" } ]\n}');
  const pa = parseSteps(a), pb = parseSteps(b);
  safe("[18] stepsSha256 is the same for the same steps whatever the file's key order or formatting; another order differs", () =>
    "steps" in pa && "steps" in pb && stepsSha256(pa.steps) === stepsSha256(pb.steps) && stepsSha256(pa.steps) !== stepsSha256([...pa.steps].reverse()));
}
{
  const steps: ProbeStep[] = [{ click: "#shelves" }, { waitFor: "[data-dt-node=\"1:1\"]" }];
  const reach = { steps, sha256: stepsSha256(steps), source: "--steps design/plan/Pantry__1_1.json", url: "http://localhost:5173/" };
  const plan = PLAN(null, { navigate: steps });
  const r = compare(exp, measured(ALL, { reach }), bound({ plan: { file: "design/plan/Pantry__1_1.json", plan } }));
  safe("[19] report.inputs.reach {sha256, steps 2, source, matchesPlan true} when the plan's navigate is the same steps", () =>
    r.inputs?.reach?.matchesPlan === true && r.inputs.reach.steps === 2 && r.inputs.reach.sha256 === reach.sha256 && r.inputs.reach.source === reach.source);
  safe("[19] …report.md: 'Reached by 2 step(s) (sha …)'", () => /Reached by 2 step\(s\) \(sha [0-9a-f]{12}…/.test(reportToMarkdown(r)));
  const other = compare(exp, measured(ALL, { reach }), bound({ plan: { file: "x", plan: PLAN(null, { navigate: [{ click: "#elsewhere" }] }) } }));
  safe("[19] another plan navigate → matchesPlan false + a note, the verdict untouched", () =>
    other.inputs?.reach?.matchesPlan === false && other.verdict === r.verdict && (other.probe.inputNotes || []).some((n) => /not the plan's navigate/.test(n)));
  const noPlan = compare(exp, measured(ALL, { reach }), bound());
  safe("[19] no plan navigate → matchesPlan null", () => noPlan.inputs?.reach?.matchesPlan === null);
}

// ---------------------------------------------------------------- 20–27 review 1 (fix pass 1)
console.log("Review 1 — one plan rule, guards, steps, page notes:");
{
  // M3: two plans describe the frame — the current one (lists files[], declares interactions) and an old one. --expect
  // and --compare must pick the SAME plan, or the interactions hash never agrees and every run stays incomplete.
  const CLI = path.join(import.meta.dirname, "..", "design-to-code", "verify-screen.ts");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "verify-drive-m3-"));
  const put = (rel: string, v: unknown): string => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), typeof v === "string" ? v : JSON.stringify(v, null, 2)); return rel; };
  const shot = put("design/export/pages/Main/Pantry__1_1.json", screen().doc);
  for (const [f, d] of Object.entries(SIBLINGS)) put(`design/export/${f}`, d);
  put("design/export/pages/index.json", { pageDirs: [{ dir: "Main", index: "pages/Main/index.json" }], layers: LAYERS });
  put("src/pantry.tsx", "export const Pantry = 1;\n");
  const current = PLAN([REMOVE_ROW], { files: ["src/pantry.tsx"] });
  put("design/plan/Pantry__1_1.json", current);
  put("design/plan/Pantry_old.json", { schema: "designtwin/plan@2", screen: "Pantry-old", nodeId: "1:1" });
  const cli = (...a: string[]) => spawnSync(process.execPath, [CLI, ...a], { encoding: "utf8", cwd });
  const ex = cli("--expect", shot);
  const expRel = "design/verify/Pantry__1_1.expected.json";
  const e = readJsonOrNull(path.join(cwd, expRel), isVerifyExpectation);
  safe("[20] M3 — two plans, one lists files[]: --expect merges that plan's interactions (the one --compare picks) and says so", () =>
    ex.status === 0 && e?.planInteractions?.plan === "design/plan/Pantry__1_1.json" && e.planInteractions.merged === 1 && /using design\/plan\/Pantry__1_1\.json, the only one listing files\[\]/.test(ex.stderr));
  const shaOf = (rel: string): string => crypto.createHash("sha256").update(fs.readFileSync(path.join(cwd, rel))).digest("hex");
  const rows = [pass("2:2", "dialog-opened"), ...OTHERS, pass("2:5", "dialog-opened")];
  const meas = (ee: NonNullable<typeof e>): string => put("design/verify/Pantry__1_1.measured.json", { measuredAt: "2026-10-01T01:00:00Z", renderer: "playwright-chromium", viewport: "1280x800", expectationSha256: shaOf(expRel), nodes: (ee.nodes ?? []).map(echo), interactions: rows });
  const readRep = () => readJsonOrNull(path.join(cwd, "design/verify/Pantry__1_1.report.json"), isVerifyReport);
  if (e) {
    const c = cli("--compare", expRel, meas(e));
    const rep = readRep();
    safe("[20] …and --compare finds the plan unchanged (no 'changed since --expect' reason; it said 'the expectation merged none' before)", () =>
      (c.status === 0 || c.status === 1) && !!rep && !(rep.why || []).some((w) => /changed since --expect/.test(w)));
    put("design/plan/Pantry__1_1.json", PLAN([{ ...REMOVE_ROW, destinationId: "3:2" }], { files: ["src/pantry.tsx"] }));
    cli("--compare", expRel, meas(e));
    const rep2 = readRep();
    safe("[20] …the plan's rows edited → the reason names the plan to pass: 're-run --expect --plan design/plan/Pantry__1_1.json'", () =>
      !!rep2 && (rep2.why || []).some((w) => /changed since --expect .*re-run --expect --plan design\/plan\/Pantry__1_1\.json/.test(w)));
  }
  fs.rmSync(cwd, { recursive: true, force: true });
  const plan = PLAN([REMOVE_ROW]);
  const ee = buildExpectation([screen()], { ...OPTS, plan: { file: "design/plan/Pantry__1_1.json", plan } });
  const changed = PLAN([{ ...REMOVE_ROW, destinationId: "3:2" }]);
  const rr = [pass("2:2", "dialog-opened"), ...OTHERS, pass("2:5", "dialog-opened")];
  const only = compare(ee, measured(rr, {}, ee), { plan: { file: "design/plan/Pantry__1_1.json", plan: changed, choice: "only" } });
  const flagged = compare(ee, measured(rr, {}, ee), { plan: { file: "design/plan/Pantry__1_1.json", plan: changed, choice: "flag" } });
  safe("[20] in-process: the frame's only plan → 're-run --expect' (no --plan); chosen by --plan → '… --expect --plan <file>'", () =>
    only.why.some((w) => /re-run --expect$/.test(w)) && flagged.why.some((w) => /re-run --expect --plan design\/plan\/Pantry__1_1\.json$/.test(w)));
}
{
  // L1: probeBound needs NO integrity reason — runId + sha matching is not enough
  const unfinished = compare(exp, measured([probePass("2:2", "3:1"), ...OTHERS]), bound({ status: { file: "Pantry.status.json", status: { ...status().status, phase: "driving" } }, interactions: [fail2("2:2")] }));
  safe("[21] (L1) status at an unfinished phase (driving), runId + measured sha matching → probe rows NOT bound: the agent's fail stands", () =>
    res(unfinished, "2:2")?.result === "fail" && res(unfinished, "2:2")?.evidenceFrom === undefined && unfinished.verdict === "incomplete");
  const stale = compare(exp, measured([probePass("2:2", "3:1"), ...OTHERS], { expectationSha256: "9".repeat(64) }), bound({ interactions: [fail2("2:2")] }));
  safe("[21] (L1) a stale expectation (measured against another expectation sha) → NOT bound either", () =>
    res(stale, "2:2")?.result === "fail" && res(stale, "2:2")?.evidenceFrom === undefined && stale.verdict === "incomplete");
}
{
  // L2: a plan dialog row is driven by clicking its opener — any other trigger could never be driven
  const plan = PLAN([{ ...REMOVE_ROW, trigger: "on_hover" }, { nodeId: "2:1", trigger: "ON_PRESS", expect: "dialog", destinationId: "3:3" }]);
  const e = buildExpectation([screen()], { ...OPTS, plan: { file: "design/plan/Pantry__1_1.json", plan } });
  safe("[22] (L2) plan expect:'dialog' on on_hover → dropped (needs on_click / on_press); on_press kept", () =>
    e.planInteractions?.merged === 1 && (e.planInteractions.dropped).some((d) => d.nodeId === "2:5" && /needs trigger on_click or on_press/.test(d.why)) && ia(e.interactions, "2:5") === undefined && ia(e.interactions, "2:1")?.trigger === "on_press");
}
{
  // L4/L5: goto can only be a same-origin path; a refused-key lookup reads own keys only
  const err = (x: unknown, re: RegExp): boolean => { const r = parseSteps(x); return "error" in r && re.test(r.error); };
  safe("[23] (L4) goto '/\\\\host', '/\\t/host', '/a b', '/a\\\\b', a control char → refused at parse", () =>
    ["/\\evil.test", "/\t/evil.test", "/a b", "/a\\b", "/a\u0001b", "/\n/evil.test"].every((g) => err([{ goto: g }], /same-origin path/)));
  safe("[23] (L4) a plain path with a query and an encoded space still parses", () => "steps" in parseSteps([{ goto: "/pantry?shelf=2&q=a%20b#top" }]));
  const badSteps = fs.mkdtempSync(path.join(os.tmpdir(), "verify-drive-steps-"));
  fs.writeFileSync(path.join(badSteps, "steps.json"), JSON.stringify([{ goto: "/\\evil.test" }]));
  fs.writeFileSync(path.join(badSteps, "x.expected.json"), "{}");
  const probe = spawnSync(process.execPath, [path.join(import.meta.dirname, "..", "design-to-code", "verify-probe.ts"), "--expected", path.join(badSteps, "x.expected.json"), "--url", "http://127.0.0.1:9/", "--steps", path.join(badSteps, "steps.json")], { encoding: "utf8" });
  safe("[23] (L4) the probe CLI refuses such a --steps file with exit 2 (before any browser)", () => probe.status === 2 && /same-origin path/.test(probe.stderr));
  fs.rmSync(badSteps, { recursive: true, force: true });
  const proto: unknown = JSON.parse('[{"__proto__": "#a"}]');
  const ctor: unknown = JSON.parse('[{"constructor": "#a"}]');
  const clean = (x: unknown): boolean => { const r = parseSteps(x); return "error" in r && /\(navigation only\)$/.test(r.error) && !/object Object|native code/.test(r.error); };
  safe("[24] (L5) a '__proto__' / 'constructor' key is refused as not a step, with no inherited 'reason' in the message", () => clean(proto) && clean(ctor));
}
{
  // L6: a previous overflowX the page now CLIPS is not fixed
  const parsed: unknown = JSON.parse(JSON.stringify(over));
  const prev: VerifyReport | null = isVerifyReport(parsed) ? parsed : null;
  const clippedNow = prev ? compare(exp, measured(ALL, { page: page({ overflowX: "hidden", scrollable: false }) }), bound({ measuredSha256: "d".repeat(64), status: status("d".repeat(64)), against: { file: "Pantry.report.json", report: prev } })) : null;
  safe("[25] (L6) a previous overflowX delta, the page clipped now → nowUnverifiable 'clipped, not fixed', fixed 0", () =>
    !!clippedNow && clippedNow.against?.deltas?.fixed === 0 && (clippedNow.against.deltas.nowUnverifiable || []).some((u) => u.field === "overflowX" && /clipped, not fixed/.test(u.why)));
}
{
  // L8: the quirks-mode note once — the probe's (measured.notes) when it wrote one
  const probeNote = "the page renders in quirks mode (document.compatMode BackCompat: no <!doctype html>) — its layout and page overflow measure differently from a standards-mode build";
  const q = (notes?: string[]) => compare(exp, measured(ALL, { page: page({ scrollWidth: 1280, compatMode: "BackCompat" }), ...(notes ? { notes } : {}) }), bound());
  const quirkNotes = (r: VerifyReportV2): number => (r.probe.inputNotes || []).filter((n) => /quirks mode/.test(n)).length;
  safe("[26] (L8) the probe already noted quirks mode → compare adds no second note", () => quirkNotes(q([probeNote])) === 0);
  safe("[26] (L8) a measured file without the probe's note → compare's own note, once", () => quirkNotes(q()) === 1 && quirkNotes(q(["settled after 2 quiet polls"])) === 1);
}
{
  // L9 (live L-1): the plan says how to reach the screen but the probe was not told
  const steps: ProbeStep[] = [{ click: "#shelves" }, { waitFor: "[data-dt-node=\"1:1\"]" }];
  const plan = PLAN(null, { navigate: steps });
  const forgot = compare(exp, measured(ALL), bound({ plan: { file: "design/plan/Pantry__1_1.json", plan } }));
  const note = (r: VerifyReportV2): boolean => (r.probe.inputNotes || []).some((n) => /the plan declares navigate steps but the probe ran without --steps/.test(n));
  safe("[27] (L9) plan.navigate but no measured.reach → note 'the plan declares navigate steps but the probe ran without --steps'", () => note(forgot) && forgot.verdict === "pass");
  const told = compare(exp, measured(ALL, { reach: { steps, sha256: stepsSha256(steps), source: "--steps design/plan/Pantry__1_1.json", url: "http://localhost:5173/" } }), bound({ plan: { file: "design/plan/Pantry__1_1.json", plan } }));
  safe("[27] (L9) …with measured.reach, or a plan without navigate → no such note", () => !note(told) && !note(compare(exp, measured(ALL), bound({ plan: { file: "x", plan: PLAN(null) } }))));
}

{
  // Review 2 M-b: --expect was given --plan <a plan outside design/plan/>; --compare without --plan must check the rows
  // --expect merged (the recorded plan file), not the plan design/plan/ yields now — and never advise re-running
  // --expect with only the plan found now when the recorded one is gone.
  console.log("Review 2 — M-b: --compare and the plan file --expect recorded:");
  const CLI = path.join(import.meta.dirname, "..", "design-to-code", "verify-screen.ts");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "verify-drive-mb-"));
  const put = (rel: string, v: unknown): string => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), typeof v === "string" ? v : JSON.stringify(v, null, 2)); return rel; };
  const shot = put("design/export/pages/Main/Pantry__1_1.json", screen().doc);
  for (const [f, d] of Object.entries(SIBLINGS)) put(`design/export/${f}`, d);
  put("design/export/pages/index.json", { pageDirs: [{ dir: "Main", index: "pages/Main/index.json" }], layers: LAYERS });
  put("src/pantry.tsx", "export const Pantry = 1;\n");
  put("design/plan/Pantry__1_1.json", PLAN([REMOVE_ROW], { files: ["src/pantry.tsx"] }));
  const MINE = "scratch/my-pantry-plan.json";
  const mineRows = [{ ...REMOVE_ROW, destinationId: "3:2" }];
  put(MINE, PLAN(mineRows, { waivers: [] }));
  const cli = (...a: string[]) => spawnSync(process.execPath, [CLI, ...a], { encoding: "utf8", cwd });
  const expRel = "design/verify/Pantry__1_1.expected.json";
  const ex = cli("--expect", shot, "--plan", MINE);
  const e = readJsonOrNull(path.join(cwd, expRel), isVerifyExpectation);
  const shaOf = (rel: string): string => crypto.createHash("sha256").update(fs.readFileSync(path.join(cwd, rel))).digest("hex");
  const measRel = e ? put("design/verify/Pantry__1_1.measured.json", { measuredAt: "2026-10-01T01:00:00Z", renderer: "playwright-chromium", viewport: "1280x800", expectationSha256: shaOf(expRel), nodes: (e.nodes ?? []).map(echo), interactions: [pass("2:2", "dialog-opened"), ...OTHERS, pass("2:5", "dialog-opened")] }) : "";
  const run = (...a: string[]): { rep: VerifyReport | null; stderr: string } => {
    const c = cli("--compare", expRel, measRel, ...a);
    return { rep: readJsonOrNull(path.join(cwd, "design/verify/Pantry__1_1.report.json"), isVerifyReport), stderr: c.stderr };
  };
  const why = (r: VerifyReport | null): string[] => (r?.why || []).filter((w) => /interactions\[\]/.test(w));
  const notes = (r: VerifyReport | null): string[] => (r?.probe && typeof r.probe === "object" && "inputNotes" in r.probe && Array.isArray(r.probe.inputNotes) ? r.probe.inputNotes.filter((n): n is string => typeof n === "string") : []);
  safe("[28] (M-b) setup: --expect --plan <outside design/plan/> records that plan", () => ex.status === 0 && e?.planInteractions?.plan === MINE);
  const r1 = run();
  safe("[28] (M-b) --compare without --plan checks the recorded plan: no interactions[] reason (it blamed design/plan/Pantry__1_1.json before)", () => !!r1.rep && why(r1.rep).length === 0);
  safe("[28] (M-b) …and says so (inputNote + stderr 'using <recorded> (the plan --expect merged interactions from) instead of …'); its waivers bind", () =>
    notes(r1.rep).some((n) => n.startsWith(`using ${MINE} (the plan --expect merged interactions from) instead of design/plan/Pantry__1_1.json`)) && /note {2}using scratch\/my-pantry-plan\.json/.test(r1.stderr)
    && r1.rep?.inputs?.waivers?.plan === MINE);
  put(MINE, PLAN([{ ...REMOVE_ROW, destinationId: "3:1" }], { waivers: [] }));
  const r2 = run();
  safe("[28] (M-b) the recorded plan's rows edited → 'changed since --expect (<recorded> …) — re-run --expect --plan <recorded>'", () =>
    why(r2.rep).length === 1 && why(r2.rep).every((w) => w.startsWith(`the plan's interactions[] changed since --expect (${MINE}:`) && w.endsWith(`re-run --expect --plan ${MINE}`)));
  put(MINE, PLAN(mineRows, { waivers: [] }));
  const r3 = run("--plan", "design/plan/Pantry__1_1.json");
  safe("[28] (M-b) --plan <another> at --compare (recorded still there) → names both: 're-run --expect --plan <flag>, or drop --plan … <recorded>'", () =>
    why(r3.rep).length === 1 && why(r3.rep).every((w) => w.includes(`--expect merged ${MINE}'s`) && w.endsWith(`re-run --expect --plan design/plan/Pantry__1_1.json, or drop --plan at --compare to check against ${MINE}`)));
  fs.renameSync(path.join(cwd, MINE), path.join(cwd, "scratch/moved-plan.json"));
  const r4 = run();
  safe("[28] (M-b) the recorded plan gone → names both plans; advises --compare … --plan <its path now> or --expect … --plan <intended>", () =>
    why(r4.rep).length === 1 && why(r4.rep).every((w) => w.includes(`came from ${MINE}, which no longer exists; the plan found now, design/plan/Pantry__1_1.json, declares others`)
      && w.includes("re-run --compare … --plan <its path now>") && w.includes("re-run --expect … --plan <the plan you intend>")));
  const r5 = run("--plan", "scratch/moved-plan.json");
  safe("[28] (M-b) …--plan <its new path> with the same rows → no reason; a note that the recorded file is gone and this one matches", () =>
    !!r5.rep && why(r5.rep).length === 0 && notes(r5.rep).some((n) => n.includes(`${MINE}, which no longer exists; scratch/moved-plan.json (used now) declares the same interactions[]`)));
  const r6 = run("--plan", "design/plan/Pantry__1_1.json");
  safe("[28] (M-b) --plan <another> with the recorded plan gone → no 'drop --plan' advice (nothing to fall back to)", () =>
    why(r6.rep).length === 1 && why(r6.rep).every((w) => w.includes(`${MINE}'s, which no longer exists`) && w.endsWith("re-run --expect --plan design/plan/Pantry__1_1.json")));
  put("design/plan/Pantry_v2.json", PLAN([REMOVE_ROW], { screen: "Pantry", files: ["src/pantry.tsx"] }));
  const r7 = run();
  safe("[28] (M-b) recorded plan gone + several plans with files[] (none chosen) → not checked, the note says to pass --plan", () =>
    !!r7.rep && why(r7.rep).length === 0 && notes(r7.rep).some((n) => n.includes(`${MINE}, which no longer exists, and no single plan describes this frame now — not checked; pass --compare … --plan <plan.json>`)));
  fs.renameSync(path.join(cwd, "scratch/moved-plan.json"), path.join(cwd, MINE));
  const r8 = run();
  safe("[28] (M-b) recorded plan back + several plans with files[] → the recorded one is used, no reason", () =>
    !!r8.rep && why(r8.rep).length === 0 && notes(r8.rep).some((n) => n.startsWith(`using ${MINE} (the plan --expect merged interactions from); 2 plans in design/plan/ describe this frame now`)));
  fs.rmSync(path.join(cwd, "design/plan/Pantry_v2.json"));
  // guards: the plan --expect found itself is still the one found now → no 'using' note, the plain M3 advice
  fs.rmSync(path.join(cwd, "design/verify"), { recursive: true, force: true });
  const ex2 = cli("--expect", shot);
  const e2 = readJsonOrNull(path.join(cwd, expRel), isVerifyExpectation);
  if (e2) put("design/verify/Pantry__1_1.measured.json", { measuredAt: "2026-10-01T01:00:00Z", renderer: "playwright-chromium", viewport: "1280x800", expectationSha256: shaOf(expRel), nodes: (e2.nodes ?? []).map(echo), interactions: [pass("2:2", "dialog-opened"), ...OTHERS, pass("2:5", "dialog-opened")] });
  const r9 = run();
  safe("[28] (M-b guard) the frame's only plan at both steps → no 'using <recorded>' note, no reason", () =>
    ex2.status === 0 && e2?.planInteractions?.plan === "design/plan/Pantry__1_1.json" && !!r9.rep && why(r9.rep).length === 0 && !notes(r9.rep).some((n) => /plan --expect merged/.test(n)));
  put("design/plan/Pantry__1_1.json", PLAN([{ ...REMOVE_ROW, destinationId: "3:1" }], { files: ["src/pantry.tsx"] }));
  const r10 = run();
  safe("[28] (M-b guard) …its rows edited → 're-run --expect' (no --plan: it is the only plan)", () => why(r10.rep).length === 1 && why(r10.rep).every((w) => /changed since --expect \(design\/plan\/Pantry__1_1\.json: .*re-run --expect$/.test(w)));
  // the same plan file spelled another way at --expect (./…) is the same plan: no 'using <recorded>' note, the usual advice
  fs.rmSync(path.join(cwd, "design/verify"), { recursive: true, force: true });
  cli("--expect", shot, "--plan", "./design/plan/Pantry__1_1.json");
  const e3 = readJsonOrNull(path.join(cwd, expRel), isVerifyExpectation);
  if (e3) put("design/verify/Pantry__1_1.measured.json", { measuredAt: "2026-10-01T01:00:00Z", renderer: "playwright-chromium", viewport: "1280x800", expectationSha256: shaOf(expRel), nodes: (e3.nodes ?? []).map(echo), interactions: [pass("2:2", "dialog-opened"), ...OTHERS, pass("2:5", "dialog-opened")] });
  const r11 = run();
  safe("[28] (M-b guard) --expect --plan ./design/plan/<the frame's plan> → the same plan at --compare (no 'using' note, no reason)", () =>
    e3?.planInteractions?.plan === "./design/plan/Pantry__1_1.json" && !!r11.rep && why(r11.rep).length === 0 && !notes(r11.rep).some((n) => /plan --expect merged/.test(n)));
  fs.rmSync(cwd, { recursive: true, force: true });
}

report();
