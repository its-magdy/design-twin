// Offline tests for design-to-code/plan-record.ts (F-100, D115: `verify-screen --compare --record-plan` writes the
// tool-owned keys of plan.verification) and the verify-build side of it: planHash no longer covers `verification`
// (the pre-F-100 formula is still accepted), and the recorded-report sha warning.
//   node test/plan-record.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { recordPlan } from "../design-to-code/plan-record.ts";
import { checkPlan, computeStatus, isOpen, verificationContradictions } from "../design-to-code/verify-build.ts";
import * as verifyBuild from "../design-to-code/verify-build.ts";
import type { ReportRef } from "../design-to-code/verify-build.ts";
import { fileHashes, legacyPlanHash, planCodeFiles, planCodeSkipped } from "../design-to-code/content-hash.ts";
import { buildExpectation, compare, STYLE_KEYS } from "../design-to-code/verify-screen.ts";
import { isPlan, isVerifyReport } from "../design-to-code/doc-guards.ts";
import type { MeasuredBehaviour, MeasuredNode, MeasuredStyles, Plan, PlanVerification, VerifyReportV2 } from "../design-to-code/types.ts";
import { check, report } from "./assert.ts";
import { must, readFixture, screenExport } from "./fixtures.ts";
import { isJsonObject } from "../design-to-code/types.ts";

const HOOK = path.join(import.meta.dirname, "..", "design-to-code", "verify-build.ts");
const VS = path.join(import.meta.dirname, "..", "design-to-code", "verify-screen.ts");
const NOW = "2026-10-07T12:00:00.000Z";
const sha256 = (b: Buffer | string): string => crypto.createHash("sha256").update(b).digest("hex");

// ---------------------------------------------------------------- a real --compare report (compare() over a plugin-shaped export)
// Invented screen. Deltas: 80:2 background high (open), 80:3 width medium (accepted by a waiver), 80:5 width medium
// (open), 80:4 background + width capped to low (matched by position) — so the record must list exactly 80:2 + 80:5.
const exp = buildExpectation([{ doc: screenExport([{ type: "FRAME", id: "80:1", name: "Crates", box: { x: 0, y: 0, w: 1280, h: 800 }, fills: [{ type: "solid", color: "#ffffff" }],
  children: [
    { type: "RECTANGLE", id: "80:2", name: "Card", box: { x: 40, y: 40, w: 200, h: 100 }, fills: [{ type: "solid", color: "#5b5fc7" }] },
    { type: "RECTANGLE", id: "80:3", name: "Panel", box: { x: 300, y: 40, w: 200, h: 100 }, fills: [{ type: "solid", color: "#eeeeee" }] },
    { type: "RECTANGLE", id: "80:4", name: "Strip", box: { x: 40, y: 300, w: 400, h: 20 }, fills: [{ type: "solid", color: "#dddddd" }] },
    { type: "RECTANGLE", id: "80:5", name: "Bar", box: { x: 40, y: 400, w: 400, h: 20 }, fills: [{ type: "solid", color: "#cccccc" }] },
  ] }], { exportedAt: "2026-10-02T00:00:00Z", screen: "Crates", nodeId: "80:1" }), label: "Crates" }]);
const echo = (n: { nodeId: string }): MeasuredNode => { const styles: MeasuredStyles = {}; const src: Record<string, unknown> = { ...n }; for (const k of STYLE_KEYS) { const v = src[k]; if (v !== undefined) styles[k] = v; } return { nodeId: n.nodeId, styles, matchedBy: "tag" }; };
const nodes = exp.nodes.map(echo);
for (const n of nodes) {
  const st: MeasuredStyles = must(n.styles, "styles");
  if (n.nodeId === "80:2") st.backgroundColor = "#ff0000";
  if (n.nodeId === "80:3") st.width = 230;
  if (n.nodeId === "80:4") { st.width = 412; st.backgroundColor = "#dcdcdc"; n.matchedBy = "position"; }
  if (n.nodeId === "80:5") st.width = 412;
}
const behaviour: MeasuredBehaviour = { version: 1, ran: true, browser: { name: "chromium", version: "153.0" }, namesComputedBy: "Playwright (Chromium)", budgetMs: 90000, elapsedMs: 1000, cut: false,
  checks: [{ id: "a11y.axe", status: "fail", detail: "1 violation", nodeId: "80:2" }, { id: "keyboard.focus-visible", status: "warn", detail: "no ring" }, { id: "a11y.landmarks", status: "pass", detail: "1 main" }],
  landmarks: [], axe: { ran: true, package: "axe-core", version: "4.13.0", violations: [] }, widths: [], artifacts: [] };
const waiver = { nodeId: "80:3", field: "width", designed: 200, built: 230, exportContentSha256: exp.exportContentSha256 ?? "", reason: "wider panel agreed", decidedBy: "owner", decidedAt: "2026-10-01" };
const base = { measuredAt: "2026-10-02T01:00:00Z", renderer: "playwright-chromium", nodes, artifacts: ["design/verify/Crates.png", "design/verify/gone.png"] };
const measured = { ...base, behaviour };
const rep: VerifyReportV2 = compare(exp, measured, { waivers: [waiver] });
const noBehaviour: VerifyReportV2 = compare(exp, base, { waivers: [waiver] });

console.log("the fixture report (real compare() output):");
check(`compare() gave 1 open high, 1 open medium, 1 accepted, 2 lows, behaviour 1 fail + 1 warn (got ${JSON.stringify(rep.summary)})`,
  rep.verdict === "fail" && rep.summary.high === 1 && rep.summary.medium === 1 && rep.summary.accepted === 1 && rep.summary.low === 2
  && rep.behaviour.ran && rep.behaviour.summary.fail === 1 && rep.behaviour.summary.warn === 1);

// ---------------------------------------------------------------- a project: plan (4-space indent, hand keys), report on disk
const REL = "design/plan/Crates.json", REPORT = "design/verify/Crates.report.json";
function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-record-"));
  const put = (rel: string, body: string): void => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };
  put("src/Crates.tsx", "export const Crates = () => null;\n");
  put("design/verify/Crates.png", "png");
  put(REPORT, JSON.stringify(rep, null, 2) + "\n");
  put("design/verify/Crates.report.md", "# Crates\n");
  const plan: Plan = { status: "pending", screenName: "Crates", nodeId: "80:1", files: ["src/Crates.tsx"], anchors: { "80:1": { mapModule: "src/Crates.tsx" } },
    deviations: [{ nodeId: "80:3", field: "width", designed: 200, built: 230, reason: "wider panel agreed" }],
    verification: { mode: "rendered", coverage: { rendered: ["default"], notChecked: [{ what: "dark theme", why: "no theme switch yet" }] }, deltas: [{ hand: "copied by an agent" }] },
    waivers: [waiver] };
  put(REL, JSON.stringify(plan, null, 2) + "\n");
  return root;
}
const runHook = (root: string) => spawnSync(process.execPath, [HOOK, REL], { cwd: root, encoding: "utf8" });
const reindent = (root: string, n: number): void => { const f = path.join(root, REL); fs.writeFileSync(f, JSON.stringify(readFixture(f, isPlan), null, n) + "\n"); };
const planOf = (root: string): Plan => readFixture(path.join(root, REL), isPlan);
const statusOf = (root: string) => computeStatus(planOf(root), { cwd: root, planFile: path.join(root, REL) });
const openOf = (root: string): boolean => isOpen({ file: path.join(root, REL), plan: planOf(root) }, root);

console.log("recordPlan (F-100, D115):");
{
  const root = project();
  runHook(root); // the Stop hook closes the plan …
  reindent(root, 4); // … and a person's editor re-saves it with 4 spaces — same content, same planHash
  const before = planOf(root);
  const beforeText = fs.readFileSync(path.join(root, REL), "utf8");
  check("setup: the hook passed and the plan is closed (not open, not pending)", before.verification?.hook?.result === "pass" && !openOf(root) && !statusOf(root).reasons.some((r) => /plan changed after the hook/.test(r)));
  const r = recordPlan(REL, rep, REPORT, { cwd: root, now: NOW });
  const text = fs.readFileSync(path.join(root, REL), "utf8");
  const after = planOf(root);
  const v = must(after.verification, "verification");
  check(`written: true, one note — the hand row it replaced in verification.deltas (M1, s19) (got ${JSON.stringify(r)})`,
    r.written && r.notes.length === 1 && /^1 row\(s\) in verification\.deltas were not written by --record-plan/.test(r.notes[0] ?? ""));
  check("mode \"rendered\", renderer = report.renderer", v.mode === "rendered" && v.renderer === "playwright-chromium");
  check(`artifacts = the report .json + .md + the report's artifact that exists (the missing one is dropped) (got ${JSON.stringify(v.artifacts)})`,
    JSON.stringify(v.artifacts) === JSON.stringify([REPORT, "design/verify/Crates.report.md", "design/verify/Crates.png"]));
  check(`deltas = the OPEN high + medium only, compact {nodeId, field, severity, expected, actual}; the hand row, the accepted medium and the lows are gone (got ${JSON.stringify(v.deltas)})`,
    JSON.stringify(v.deltas) === JSON.stringify([
      { nodeId: "80:2", field: "background", severity: "high", expected: "#5b5fc7ff", actual: "#ff0000ff" },
      { nodeId: "80:5", field: "width", severity: "medium", expected: 400, actual: 412 }]));
  check(`a11y = report.behaviour.summary {tool, violations: fail, warnings: warn, report} (got ${JSON.stringify(v.a11y)})`,
    JSON.stringify(v.a11y) === JSON.stringify({ tool: "axe-core 4.13.0", violations: 1, warnings: 1, report: REPORT }));
  const rec = must(v.recorded, "recorded");
  check(`recorded {by, at, report, reportSha256 = sha256 of the report file, verdict, headline, behaviourHeadline, counts} (got ${JSON.stringify({ ...rec, headline: "…" })})`,
    rec.by === "verify-screen --record-plan" && rec.at === NOW && rec.report === REPORT && rec.reportSha256 === sha256(fs.readFileSync(path.join(root, REPORT)))
    && rec.verdict === "fail" && rec.headline === rep.headline && rec.behaviourHeadline === rep.behaviour.headline
    && JSON.stringify(rec.counts) === JSON.stringify({ high: 1, medium: 1, low: 2, accepted: 1, notMeasured: 0, inferred: 0 }));
  check("hand keys untouched: coverage, deviations[], waivers[], status, the hook record",
    JSON.stringify(v.coverage) === JSON.stringify(before.verification?.coverage) && JSON.stringify(after.deviations) === JSON.stringify(before.deviations)
    && JSON.stringify(after.waivers) === JSON.stringify(before.waivers) && after.status === "pending" && JSON.stringify(v.hook) === JSON.stringify(before.verification?.hook));
  check("the file keeps its 4-space indentation and key order (top level and inside verification; new keys appended)",
    /^\{\n {4}"status": "pending",\n {4}"screenName"/.test(text) && JSON.stringify(Object.keys(after)) === JSON.stringify(Object.keys(before))
    && JSON.stringify(Object.keys(v)) === JSON.stringify(["mode", "coverage", "deltas", "hook", "renderer", "artifacts", "a11y", "recorded"]) && text.endsWith("}\n"));
  check("everything outside verification is byte-identical", JSON.stringify({ ...after, verification: null }) === JSON.stringify({ ...before, verification: null }));
  // the core of F-100: recording must not send a closed plan back to pending (mutation: keep verification in planHash)
  const st = statusOf(root);
  check(`verify-build --status after the record: NOT "the plan changed after the hook's last check", the plan stays closed (got ${st.status}: ${st.reasons.join(" | ").slice(0, 160)})`,
    !st.reasons.some((x) => /plan changed after the hook/.test(x)) && !openOf(root));
  const cli = spawnSync(process.execPath, [HOOK, "--status", "--json"], { cwd: root, encoding: "utf8" });
  check("…and the CLI agrees (--status --json: failed by the report, no pending reason)", cli.status === 0 && /"status": "failed"/.test(cli.stdout) && !/plan changed after the hook/.test(cli.stdout));
  const quiet = spawnSync(process.execPath, [HOOK], { cwd: root, input: JSON.stringify({ cwd: root }), encoding: "utf8" });
  check("…and the Stop hook's fast path stays silent on it (closed)", quiet.status === 0 && quiet.stderr === "");
  const again = recordPlan(REL, rep, REPORT, { cwd: root, now: "2026-10-08T00:00:00.000Z" });
  check("recording the same report again: written false, the bytes (and recorded.at) unchanged", !again.written && fs.readFileSync(path.join(root, REL), "utf8") === text);
  check("the recorded report → no recorded-sha warning, and verification.deltas lists what the report's open high/medium are (no 'copy them' warning)",
    !checkPlan({ plan: planOf(root), file: path.join(root, REL) }, root).warnings.some((w) => /records an older run|verification\.deltas is \[\]/.test(w)));
  // the report is rewritten after the record (another --compare without --record-plan, or a hand edit)
  fs.writeFileSync(path.join(root, REPORT), JSON.stringify({ ...rep, headline: rep.headline + " (edited)" }, null, 2) + "\n");
  const w = checkPlan({ plan: planOf(root), file: path.join(root, REL) }, root).warnings;
  check(`edited report → "plan.verification records an older run of ${REPORT} — re-run … --compare --record-plan (the report is the verdict)"`,
    w.some((x) => x.startsWith(`plan.verification records an older run of ${REPORT} — re-run `) && x.endsWith("--compare --record-plan (the report is the verdict)")));
  check("…a missing report is no recorded-sha warning (the status reasons say there is no report)", (() => { fs.rmSync(path.join(root, REPORT)); return verifyBuild.recordedReportWarnings(planOf(root), root).length === 0; })());
  check("the plan text before the record was not the plan text after (sanity)", beforeText !== text);
}
{
  // behaviour did not run: a11y is not invented — a hand a11y stays, with a note
  const root = project();
  const p = planOf(root);
  fs.writeFileSync(path.join(root, REL), JSON.stringify({ ...p, verification: { ...p.verification, a11y: { tool: "manual", violations: 0 } } }, null, 2) + "\n");
  const r = recordPlan(REL, noBehaviour, REPORT, { cwd: root, now: NOW });
  const v = planOf(root).verification;
  check(`behaviour did not run → a11y left as it was, a note says why; the record still counts the deltas (got ${JSON.stringify(v?.a11y)}; notes ${JSON.stringify(r.notes)})`,
    JSON.stringify(v?.a11y) === JSON.stringify({ tool: "manual", violations: 0 }) && r.notes.some((n) => /behaviour\/a11y checks did not run/.test(n)) && v?.recorded?.counts.high === 1);
}
{
  // a report of lows only: deltas [] is the record, not a "copy them" gap
  const lowsOnly: VerifyReportV2 = { ...rep, deltas: rep.deltas.filter((d) => d.severity === "low") };
  const v: PlanVerification = { mode: "rendered", deltas: [], recorded: { by: "verify-screen --record-plan", at: NOW, report: REPORT, reportSha256: "x", verdict: "pass", headline: "", counts: { high: 0, medium: 0, low: 2, accepted: 0, notMeasured: 0, inferred: 0 } } };
  const refRow: ReportRef = { rel: REPORT, matchedBy: "name", schema: "designtwin/verify-report@2", verdict: lowsOnly.verdict, headline: null, why: [], deltas: lowsOnly.deltas, exportedAt: null, measuredAt: null, mtimeMs: 0,
    exportContentSha256: null, code: null, expectationChanged: false, expectationRel: null, waiversSha256: null, behaviour: null, shippedProbe: false };
  check("a recorded plan with deltas [] beside its report's 2 lows → no 'verification.deltas is [] but … lists 2' contradiction",
    verificationContradictions({ verification: { ...v } }, [refRow]).length === 0
    && verificationContradictions({ verification: { mode: "rendered", deltas: [] } }, [refRow]).length === 1);
}

console.log("review 18 (s19): a hand row in deltas, a static-only run, one format-preserving plan writer:");
{
  // M1: verification.deltas is the report's (D115) — a builder's residual there is replaced, never silently
  const root = project();
  const p = planOf(root);
  fs.writeFileSync(path.join(root, REL), JSON.stringify({ ...p, verification: { ...p.verification, deltas: [{ nodeId: "80:2", field: "boxShadow", note: "platform shadow approximation" }] } }, null, 2) + "\n");
  const r = recordPlan(REL, rep, REPORT, { cwd: root, now: NOW });
  check(`[M1] replacing a hand row in verification.deltas says so, names it and points at deviations[] (got ${JSON.stringify(r.notes)})`,
    r.notes.some((n) => /^1 row\(s\) in verification\.deltas .*not written by --record-plan.*\(80:2 boxShadow\).*deviations\[\]/.test(n)));
  const again = recordPlan(REL, rep, REPORT, { cwd: root, now: NOW });
  check(`[M1] …re-recording over its own rows adds no note (got ${JSON.stringify(again.notes)})`, !again.written && again.notes.length === 0);
}
{
  // M2: a static-only measured file → the report says so, and the plan records static-only + the why, no renderer
  const so: VerifyReportV2 = compare(exp, { mode: "static-only", reason: "no dev server, no Playwright", nodes: [] }, {});
  check(`[M2] compare() of a static-only measured file: report.mode "static-only" + its reason (got ${JSON.stringify({ mode: so.mode, reason: so.reason })}); a rendered one carries no mode`,
    so.mode === "static-only" && so.reason === "no dev server, no Playwright" && rep.mode === undefined && !("reason" in rep));
  const root = project();
  const p = planOf(root);
  fs.writeFileSync(path.join(root, REL), JSON.stringify({ ...p, verification: { ...p.verification, renderer: "playwright-chromium" } }, null, 2) + "\n");
  fs.writeFileSync(path.join(root, REPORT), JSON.stringify(so, null, 2) + "\n");
  recordPlan(REL, so, REPORT, { cwd: root, now: NOW });
  const v = must(planOf(root).verification, "verification");
  check(`[M2] --record-plan of it: mode "static-only" + the report's reason, no renderer (got ${JSON.stringify({ mode: v.mode, reason: v.reason, renderer: v.renderer })})`,
    v.mode === "static-only" && v.reason === "no dev server, no Playwright" && v.renderer === undefined);
  fs.writeFileSync(path.join(root, REPORT), JSON.stringify(rep, null, 2) + "\n");
  recordPlan(REL, rep, REPORT, { cwd: root, now: NOW });
  const v2 = must(planOf(root).verification, "verification");
  check(`[M2] …a later rendered record: mode "rendered" + renderer, the static-only reason gone (got ${JSON.stringify({ mode: v2.mode, reason: v2.reason, renderer: v2.renderer })})`,
    v2.mode === "rendered" && v2.renderer === "playwright-chromium" && v2.reason === undefined);
}
{
  // L5: --accept and the verify-build hook write the plan as --record-plan does — BOM, indentation and CRLF kept
  const crlf4 = (root: string): void => { const f = path.join(root, REL); fs.writeFileSync(f, "\ufeff" + JSON.stringify(readFixture(f, isPlan), null, 4).split("\n").join("\r\n") + "\r\n"); };
  const sameFormat = (t: string): boolean => t.startsWith("\ufeff{\r\n    \"status\"") && t.endsWith("}\r\n") && !/[^\r]\n/.test(t);
  const root = project();
  crlf4(root);
  const a = spawnSync(process.execPath, [VS, "--accept", REPORT, "--node", "80:2", "--field", "background", "--reason", "brand red agreed", "--by", "Sam Doe", "--plan", REL], { cwd: root, encoding: "utf8" });
  const text = fs.readFileSync(path.join(root, REL), "utf8");
  check(`[L5] --accept on a BOM + CRLF + 4-space plan: the waiver is written and the file keeps its format (exit ${a.status}; starts ${JSON.stringify(text.slice(0, 16))})`,
    a.status === 0 && sameFormat(text) && (planOf(root).waivers ?? []).some((w) => isJsonObject(w) && w.nodeId === "80:2" && w.reason === "brand red agreed")
    && !fs.readdirSync(path.join(root, "design/plan")).some((f) => /\.tmp/.test(f)));
  const h = runHook(root);
  const hooked = fs.readFileSync(path.join(root, REL), "utf8");
  check(`[L5] …the verify-build hook's record keeps it too (exit ${h.status}; starts ${JSON.stringify(hooked.slice(0, 16))})`,
    h.status === 0 && planOf(root).verification?.hook?.result !== undefined && hooked !== text && sameFormat(hooked));
}

console.log("planHash: verification left out, the pre-F-100 formula still accepted (D115):");
{
  const root = project();
  runHook(root);
  // rewrite the hook record as an older hook wrote it: planHash = the legacy formula (verification minus hook)
  const p = planOf(root);
  const hook = must(p.verification?.hook, "hook");
  hook.planHash = legacyPlanHash(p);
  fs.writeFileSync(path.join(root, REL), JSON.stringify(p, null, 2) + "\n");
  const st = statusOf(root);
  check(`a plan closed under the legacy planHash stays closed after the upgrade (not open, not pending) (got ${st.status})`, !openOf(root) && !st.reasons.some((x) => /plan changed after the hook/.test(x)));
  hook.planHash = "0000000000000000";
  fs.writeFileSync(path.join(root, REL), JSON.stringify(p, null, 2) + "\n");
  check("control: a planHash matching neither formula → pending, open", openOf(root) && statusOf(root).reasons.some((x) => /plan changed after the hook/.test(x)));
  // a real content edit still reopens it
  runHook(root);
  const q = planOf(root);
  q.route = "/crates";
  fs.writeFileSync(path.join(root, REL), JSON.stringify(q, null, 2) + "\n");
  check("a plan content edit (route) still reopens it", openOf(root) && statusOf(root).reasons.some((x) => /plan changed after the hook/.test(x)));
  // and a hand edit of verification (coverage) after the new-formula hook does not
  runHook(root);
  const c = planOf(root);
  must(c.verification, "verification").coverage = { rendered: ["default", "hover"], notChecked: [] };
  fs.writeFileSync(path.join(root, REL), JSON.stringify(c, null, 2) + "\n");
  check("a hand edit of verification.coverage after the hook → still closed (planHash leaves verification out)", !openOf(root) && !statusOf(root).reasons.some((x) => /plan changed after the hook/.test(x)));
  check("the hook records exactly these files (planCodeFiles)", JSON.stringify(c.verification?.hook?.files) === JSON.stringify(fileHashes(planCodeFiles(c), root)));
}

console.log("fix pass 1 — recording a plan the old hook closed (M1), project-relative paths only (L7):");
{
  // M1: the hook closed this plan under the pre-F-100 formula (it covered verification); the first --record-plan after the
  // upgrade rewrites verification — the record re-stamps the hook's hash in the same write, so the plan stays closed
  const root = project();
  runHook(root);
  const p = planOf(root);
  const hook = must(p.verification?.hook, "hook");
  hook.planHash = legacyPlanHash(p);
  fs.writeFileSync(path.join(root, REL), JSON.stringify(p, null, 2) + "\n");
  check("setup: closed under the legacy hash", !openOf(root) && !statusOf(root).reasons.some((x) => /plan changed after the hook/.test(x)));
  const r = recordPlan(REL, rep, REPORT, { cwd: root, now: NOW });
  const after = planOf(root);
  const st = statusOf(root);
  check(`[M1] after the first --record-plan: still closed, not pending (got ${st.status}: ${st.reasons.join(" | ").slice(0, 160)})`,
    r.written && !openOf(root) && !st.reasons.some((x) => /plan changed after the hook/.test(x)));
  check("[M1] …the hook's planHash is now the current formula's, the rest of the hook record is untouched, and a note says so",
    after.verification?.hook?.planHash === verifyBuild.planHash(after) && after.verification.hook.result === "pass"
    && JSON.stringify(after.verification.hook.files) === JSON.stringify(hook.files) && r.notes.some((n) => /pre-F-100 plan hash/.test(n) && /re-stamped/.test(n)));
  const quiet = spawnSync(process.execPath, [HOOK], { cwd: root, input: JSON.stringify({ cwd: root }), encoding: "utf8" });
  check("[M1] …and the Stop hook's fast path stays silent on it", quiet.status === 0 && quiet.stderr === "");
  // a hash that matches NEITHER formula (the plan changed after the hook) is never re-stamped: the plan stays pending
  const q = planOf(root);
  must(q.verification?.hook, "hook").planHash = "0000000000000000";
  fs.writeFileSync(path.join(root, REL), JSON.stringify(q, null, 2) + "\n");
  const r2 = recordPlan(REL, { ...rep, headline: rep.headline + " (again)" }, REPORT, { cwd: root, now: NOW });
  check("[M1] control: a hook hash matching neither formula is left alone (still pending, no re-stamp note)",
    planOf(root).verification?.hook?.planHash === "0000000000000000" && openOf(root) && !r2.notes.some((n) => /re-stamped/.test(n)));
}
{
  // L7: a report or artifact outside the project — the plan records project-relative paths only
  const root = project();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-outside-"));
  const before = fs.readFileSync(path.join(root, REL), "utf8");
  let threw = "";
  try { recordPlan(REL, rep, path.join(outside, "Crates.report.json"), { cwd: root, now: NOW }); } catch (e) { threw = e instanceof Error ? e.message : String(e); }
  check(`[L7] a report outside the project → refused (throws), the plan is unchanged (got ${JSON.stringify(threw.slice(0, 120))})`,
    /is outside the project/.test(threw) && /project-relative paths only/.test(threw) && fs.readFileSync(path.join(root, REL), "utf8") === before);
  fs.writeFileSync(path.join(outside, "shot.png"), "png");
  const withOutside: VerifyReportV2 = { ...rep, artifacts: [...rep.artifacts, path.join(outside, "shot.png"), "../" + path.basename(outside) + "/shot.png"] };
  const r = recordPlan(REL, withOutside, "./design/verify/../verify/Crates.report.json", { cwd: root, now: NOW });
  const v = planOf(root).verification;
  check(`[L7] an artifact outside the project (absolute or ../) → left out with ONE note; the report path is normalised (got ${JSON.stringify(v?.artifacts)}; ${JSON.stringify(r.notes)})`,
    JSON.stringify(v?.artifacts) === JSON.stringify([REPORT, "design/verify/Crates.report.md", "design/verify/Crates.png"]) && v?.recorded?.report === REPORT && v.a11y?.report === REPORT
    && r.notes.filter((n) => /artifact\(s\) outside the project not recorded/.test(n)).length === 1 && !JSON.stringify(v).includes(outside));
  fs.rmSync(outside, { recursive: true, force: true });
}

console.log("the CLI (verify-screen --compare --record-plan, wired by slice A1):");
{
  const usage = spawnSync(process.execPath, [VS, "--help"], { encoding: "utf8" });
  if (!/--record-plan/.test(usage.stdout + usage.stderr)) {
    console.log("  - SKIPPED: verify-screen has no --record-plan flag yet (slice A1 wires it) — the CLI cases (no plan → exit 2, no report written) are not run");
  } else {
    const root = project();
    fs.rmSync(path.join(root, "design", "plan"), { recursive: true });
    fs.writeFileSync(path.join(root, "design/verify/Crates.expected.json"), JSON.stringify(exp, null, 2));
    fs.writeFileSync(path.join(root, "design/verify/Crates.measured.json"), JSON.stringify({ measuredAt: measured.measuredAt, renderer: measured.renderer, nodes }));
    fs.rmSync(path.join(root, REPORT));
    const r = spawnSync(process.execPath, [VS, "--compare", "design/verify/Crates.expected.json", "design/verify/Crates.measured.json", "--record-plan"], { cwd: root, encoding: "utf8" });
    check(`--record-plan with no plan → exit 2 before comparing, no report written (got exit ${r.status})`, r.status === 2 && !fs.existsSync(path.join(root, REPORT)));
    const root2 = project();
    fs.writeFileSync(path.join(root2, "design/verify/Crates.expected.json"), JSON.stringify(exp, null, 2));
    fs.writeFileSync(path.join(root2, "design/verify/Crates.measured.json"), JSON.stringify({ measuredAt: measured.measuredAt, renderer: measured.renderer, nodes, behaviour }));
    const r2 = spawnSync(process.execPath, [VS, "--compare", "design/verify/Crates.expected.json", "design/verify/Crates.measured.json", "--plan", REL, "--record-plan"], { cwd: root2, encoding: "utf8" });
    const written = readFixture(path.join(root2, REPORT), isVerifyReport);
    const rec = planOf(root2).verification?.recorded;
    check(`--compare --record-plan --plan <plan>: the report is written and the plan records its sha256 (exit ${r2.status}, verdict ${String(written.verdict)})`,
      !!rec && rec.verdict === written.verdict && rec.headline === written.headline && rec.reportSha256 === sha256(fs.readFileSync(path.join(root2, REPORT))) && rec.report === REPORT);
  }
}

console.log("review 2 (D129): dotted import names resolve; a report reached through a symlink is inside the project:");
{
  const root = project();
  fs.mkdirSync(path.join(root, "src/shell"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/shell/app.component.tsx"), "export const Shell = () => null;\n");
  const dotted = { files: ["src/Crates.tsx"], anchors: { "1:1": { mapModule: "src/shell/app.component" }, "1:2": { mapModule: "src/shell/gone.tsx" } } };
  check("[D129 M1] 'src/shell/app.component' (a dot in the last part, no extension) resolves to the .tsx and is hashed",
    planCodeFiles(dotted, root).includes("src/shell/app.component.tsx") && !planCodeFiles(dotted, root).includes("src/shell/app.component"));
  check("[D129 M1] a mapped path that names no file (a typo / a deleted file) is still hashed as written AND named by the skipped note",
    planCodeFiles(dotted, root).includes("src/shell/gone.tsx") && JSON.stringify(planCodeSkipped(dotted, root)) === JSON.stringify(["src/shell/gone.tsx"]));
  const link = path.join(os.tmpdir(), `dtwin-record-link-${process.pid}`);
  try {
    fs.symlinkSync(root, link);
    let written = false;
    try { written = recordPlan(REL, rep, path.join(link, REPORT), { cwd: fs.realpathSync(root), now: NOW }).written; } catch { /* refused: fails below */ }
    check("[D129 L1] a report path through a symlink to the project is inside it (recorded project-relative)",
      written && planOf(root).verification?.recorded?.report === REPORT);
  } finally { try { fs.unlinkSync(link); } catch { /* never created */ } }
}

report();
