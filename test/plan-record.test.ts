// Offline tests for design-to-code/plan-record.ts (`verify-screen --compare --record-plan` writes
// plan.verification.recorded, the tool-owned block, whole) and the verify-build side of it: planHash does not cover
// `verification` (the legacy formula is still accepted), the recorded-report sha warning, the block on a hand-edited
// record and the warning on the record's keys left at the top level.
//   node test/plan-record.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { recordPlan, updatePlan, verificationFacts } from "../design-to-code/plan-record.ts";
import { planLockFile } from "../design-to-code/run-cache.ts";
import { checkPlan, computeStatus, isOpen, verificationContradictions } from "../design-to-code/verify-build.ts";
import * as verifyBuild from "../design-to-code/verify-build.ts";
import type { ReportRef } from "../design-to-code/verify-build.ts";
import { fileHashes, legacyPlanHash, planCodeFiles, planCodeSkipped, planHash } from "../design-to-code/content-hash.ts";
import { compare } from "../design-to-code/verify-compare.ts";
import { buildExpectation } from "../design-to-code/verify-expect.ts";
import { STYLE_KEYS } from "../design-to-code/verify-shared.ts";
import { isPlan, isVerificationRecord, isVerifyReport } from "../design-to-code/doc-guards.ts";
import type { JsonObject, MeasuredBehaviour, MeasuredNode, MeasuredStyles, Plan, PlanVerification, VerifyReportV2 } from "../design-to-code/types.ts";
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

console.log("recordPlan:");
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
  check(`written: true, ONE note — the plan's top-level mode + deltas (a hand-written plan) are the record's now, moved into it (got ${JSON.stringify(r)})`,
    r.written && r.notes.length === 1 && (r.notes[0] ?? "").startsWith("verification.mode, verification.deltas: the record's keys are kept in verification.recorded now (written from this report) — the top-level ones are removed")
    && /a residual goes in deviations\[\]/.test(r.notes[0] ?? ""));
  check(`verification keeps the agent's keys + the hook's, and the record — the top-level mode/deltas are gone (got ${JSON.stringify(Object.keys(v))})`,
    JSON.stringify(Object.keys(v)) === JSON.stringify(["coverage", "hook", "recorded"]) && !("mode" in v) && !("deltas" in v) && !("artifacts" in v) && !("a11y" in v) && !("renderer" in v));
  const rec = must(isVerificationRecord(v.recorded) ? v.recorded : undefined, "recorded@2");
  check(`recorded is the closed @2 block, exactly these keys in this order (got ${JSON.stringify(Object.keys(rec))})`,
    JSON.stringify(Object.keys(rec)) === JSON.stringify(["schema", "by", "at", "report", "reportSha256", "verdict", "headline", "behaviourHeadline", "counts", "mode", "renderer", "artifacts", "deltas", "a11y"])
    && rec.schema === "designtwin/plan-verification-record@2");
  check("recorded.mode \"rendered\", recorded.renderer = report.renderer, no reason", rec.mode === "rendered" && rec.renderer === "playwright-chromium" && !("reason" in rec));
  check(`recorded.artifacts = the report .json + .md + the report's artifact that exists (the missing one is dropped) (got ${JSON.stringify(rec.artifacts)})`,
    JSON.stringify(rec.artifacts) === JSON.stringify([REPORT, "design/verify/Crates.report.md", "design/verify/Crates.png"]));
  check(`recorded.deltas = the OPEN high + medium only, compact {nodeId, field, severity, expected, actual}; the hand row, the accepted medium and the lows are gone (got ${JSON.stringify(rec.deltas)})`,
    JSON.stringify(rec.deltas) === JSON.stringify([
      { nodeId: "80:2", field: "background", severity: "high", expected: "#5b5fc7ff", actual: "#ff0000ff" },
      { nodeId: "80:5", field: "width", severity: "medium", expected: 400, actual: 412 }]));
  check(`recorded.a11y = report.behaviour.summary {tool, violations: fail, warnings: warn, report} (got ${JSON.stringify(rec.a11y)})`,
    JSON.stringify(rec.a11y) === JSON.stringify({ tool: "axe-core 4.13.0", violations: 1, warnings: 1, report: REPORT }));
  check(`recorded {by, at, report, reportSha256 = sha256 of the report file, verdict, headline, behaviourHeadline, counts} (got ${JSON.stringify({ ...rec, headline: "…" })})`,
    rec.by === "verify-screen --record-plan" && rec.at === NOW && rec.report === REPORT && rec.reportSha256 === sha256(fs.readFileSync(path.join(root, REPORT)))
    && rec.verdict === "fail" && rec.headline === rep.headline && rec.behaviourHeadline === rep.behaviour.headline
    && JSON.stringify(rec.counts) === JSON.stringify({ high: 1, medium: 1, low: 2, accepted: 1, notMeasured: 0, inferred: 0 }));
  check("hand keys untouched: coverage, deviations[], waivers[], status, the hook record",
    JSON.stringify(v.coverage) === JSON.stringify(before.verification?.coverage) && JSON.stringify(after.deviations) === JSON.stringify(before.deviations)
    && JSON.stringify(after.waivers) === JSON.stringify(before.waivers) && after.status === "pending" && JSON.stringify(v.hook) === JSON.stringify(before.verification?.hook));
  check("the file keeps its 4-space indentation and key order (top level; inside verification the record is appended)",
    /^\{\n {4}"status": "pending",\n {4}"screenName"/.test(text) && JSON.stringify(Object.keys(after)) === JSON.stringify(Object.keys(before)) && text.endsWith("}\n"));
  check("everything outside verification is byte-identical", JSON.stringify({ ...after, verification: null }) === JSON.stringify({ ...before, verification: null }));
  // the core: recording must not send a closed plan back to pending (mutation: keep verification in planHash)
  const st = statusOf(root);
  check(`verify-build --status after the record: NOT "the plan changed after the hook's last check", the plan stays closed (got ${st.status}: ${st.reasons.join(" | ").slice(0, 160)})`,
    !st.reasons.some((x) => /plan changed after the hook/.test(x)) && !openOf(root));
  const cli = spawnSync(process.execPath, [HOOK, "--status", "--json"], { cwd: root, encoding: "utf8" });
  check("…and the CLI agrees (--status --json: failed by the report, no pending reason)", cli.status === 0 && /"status": "failed"/.test(cli.stdout) && !/plan changed after the hook/.test(cli.stdout));
  const quiet = spawnSync(process.execPath, [HOOK], { cwd: root, input: JSON.stringify({ cwd: root }), encoding: "utf8" });
  check("…and the Stop hook's fast path stays silent on it (closed)", quiet.status === 0 && quiet.stderr === "");
  const again = recordPlan(REL, rep, REPORT, { cwd: root, now: "2026-10-08T00:00:00.000Z" });
  check("recording the same report again: written false, the bytes (and recorded.at) unchanged", !again.written && fs.readFileSync(path.join(root, REL), "utf8") === text);
  const fresh = checkPlan({ plan: planOf(root), file: path.join(root, REL) }, root);
  check(`the recorded report → no block on the record, no recorded-sha / 'ignored' warning, and the record's deltas list what the report's open high/medium are (no 'copy them' warning) (got ${JSON.stringify(fresh.blocking)})`,
    !fresh.blocking.some((b) => /verification\.recorded/.test(b)) && !fresh.warnings.some((w) => /records an older run|deltas is \[\]|ignored — verification\.recorded/.test(w)));
  // the report is rewritten after the record (another --compare without --record-plan, or a hand edit)
  fs.writeFileSync(path.join(root, REPORT), JSON.stringify({ ...rep, headline: rep.headline + " (edited)" }, null, 2) + "\n");
  const w = checkPlan({ plan: planOf(root), file: path.join(root, REL) }, root).warnings;
  check(`edited report → "plan.verification records an older run of ${REPORT} — re-run … --compare --record-plan (the report is the verdict)"`,
    w.some((x) => x.startsWith(`plan.verification records an older run of ${REPORT} — re-run `) && x.endsWith("--compare --record-plan (the report is the verdict)")));
  check("…a missing report is no recorded-sha warning (the status reasons say there is no report)", (() => { fs.rmSync(path.join(root, REPORT)); return verifyBuild.recordedReportWarnings(planOf(root), root).length === 0; })());
  check("the plan text before the record was not the plan text after (sanity)", beforeText !== text);
}
{
  // behaviour did not run: a11y is not invented — the record has none, and a hand a11y at the top level (which this report
  // does not replace) stays there and is still read; the note says exactly what moved and what stayed
  const root = project();
  const p = planOf(root);
  fs.writeFileSync(path.join(root, REL), JSON.stringify({ ...p, verification: { ...p.verification, a11y: { tool: "manual", violations: 0 } } }, null, 2) + "\n");
  fs.writeFileSync(path.join(root, REPORT), JSON.stringify(noBehaviour, null, 2) + "\n");
  const r = recordPlan(REL, noBehaviour, REPORT, { cwd: root, now: NOW });
  const v = must(planOf(root).verification, "verification");
  const rec = must(isVerificationRecord(v.recorded) ? v.recorded : undefined, "recorded@2");
  check(`behaviour did not run → the record has no a11y, the hand top-level one stays, two notes (got ${JSON.stringify(v.a11y)}; notes ${JSON.stringify(r.notes)})`,
    !("a11y" in rec) && JSON.stringify(v.a11y) === JSON.stringify({ tool: "manual", violations: 0 }) && r.notes.length === 2
    && /^behaviour\/a11y checks did not run \(.+\) — this record has no a11y$/.test(r.notes[0] ?? "")
    && r.notes[1] === "verification.mode, verification.deltas: the record's keys are kept in verification.recorded now (written from this report) — the top-level ones are removed; "
      + "verification.a11y stays at the top level: this report gives none, so it is still read from there; coverage and notes stay yours, and a residual goes in deviations[] (with the why)"
    && rec.counts.high === 1);
  const facts = verificationFacts(v);
  const w = checkPlan({ plan: planOf(root), file: path.join(root, REL) }, root).warnings;
  check(`…the readers take mode/deltas from the record and that a11y from the top level, with no 'ignored' warning for it (got at ${facts.at}, a11yAt ${facts.a11yAt})`,
    facts.at === "verification.recorded" && facts.a11yAt === "verification" && facts.a11y?.tool === "manual" && facts.mode === "rendered"
    && !w.some((x) => /ignored — verification\.recorded/.test(x)) && !w.some((x) => /has no a11y|a11y is missing/.test(x)));
}
{
  // a static-only measured file that gives no reason: a hand reason at the top level stays and is read; one beside a
  // rendered record no longer holds and is removed
  const so: VerifyReportV2 = compare(exp, { mode: "static-only", nodes: [] }, {});
  const root = project();
  const p = planOf(root);
  fs.writeFileSync(path.join(root, REL), JSON.stringify({ ...p, verification: { ...p.verification, mode: "static-only", reason: "no simulator on this machine" } }, null, 2) + "\n");
  fs.writeFileSync(path.join(root, REPORT), JSON.stringify(so, null, 2) + "\n");
  const r = recordPlan(REL, so, REPORT, { cwd: root, now: NOW });
  const v = must(planOf(root).verification, "verification");
  const rec = must(isVerificationRecord(v.recorded) ? v.recorded : undefined, "recorded@2");
  const res = checkPlan({ plan: planOf(root), file: path.join(root, REL) }, root);
  check(`static-only with no reason in the report → the record has none, the hand reason stays and is read (no 'no reason' warning, no block) (got ${JSON.stringify({ rec: rec.reason, top: v.reason, notes: r.notes })})`,
    rec.mode === "static-only" && !("reason" in rec) && v.reason === "no simulator on this machine" && verificationFacts(v).reason === "no simulator on this machine"
    && /verification\.reason stays at the top level: this report gives none/.test(r.notes.join(" ")) && !res.warnings.some((x) => /with no `reason`|ignored — verification\.recorded/.test(x))
    && !res.blocking.some((b) => /verification\.recorded/.test(b)));
  fs.writeFileSync(path.join(root, REPORT), JSON.stringify(rep, null, 2) + "\n");
  const r2 = recordPlan(REL, rep, REPORT, { cwd: root, now: NOW });
  check(`…a later rendered record removes that reason, and says why (got ${JSON.stringify(r2.notes)})`,
    planOf(root).verification?.reason === undefined && r2.notes.some((n) => n.startsWith("verification.reason removed: this report was rendered, so the \"why no render\" no longer holds")));
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

console.log("the record is replaced whole; a recorded@1 plan is migrated; a static-only run; one format-preserving plan writer:");
{
  // hand rows in deltas, a non-array deltas, a stale hand headline/verdict: no detector of its own any more — the
  // top-level deltas is the record's key (moved, one note); a hand headline/verdict is left, and verify-build says it is ignored
  for (const [what, extra] of [
    ["a hand residual row in deltas", { deltas: [{ nodeId: "80:2", field: "boxShadow", note: "platform shadow approximation" }] }],
    ["a hand-written object in deltas", { deltas: { high: 4, medium: 9, interactions: "1 pass, 2 fail of 3" } }],
    ["a stale hand headline + verdict", { deltas: [], headline: "4 high, 9 medium (round 2)", verdict: "pass" }],
  ] as const) {
    const root = project();
    const p = planOf(root);
    fs.writeFileSync(path.join(root, REL), JSON.stringify({ ...p, verification: { ...p.verification, ...extra } }, null, 2) + "\n");
    const r = recordPlan(REL, rep, REPORT, { cwd: root, now: NOW });
    const v = must(planOf(root).verification, "verification");
    check(`${what} → ONE note, the move into the record — no hand-row, non-array or stale note (got ${JSON.stringify(r.notes)})`,
      r.notes.length === 1 && (r.notes[0] ?? "").startsWith("verification.mode, verification.deltas: the record's keys are kept in verification.recorded now")
      && !r.notes.some((n) => /were not written by --record-plan|was a hand-written|stale beside/.test(n)) && !("deltas" in v));
    if ("headline" in extra) {
      const vh: unknown = "headline" in v ? v.headline : undefined;
      check("…the hand headline/verdict are left as they were (the agent's keys)", vh === "4 high, 9 medium (round 2)" && v.verdict === "pass");
    }
  }
}
{
  // re-recording the same report over its own record: nothing to say, nothing written
  const root = project();
  recordPlan(REL, rep, REPORT, { cwd: root, now: NOW });
  const again = recordPlan(REL, rep, REPORT, { cwd: root, now: NOW });
  check(`re-recording over its own record adds no note and writes nothing (got ${JSON.stringify(again)})`, !again.written && again.notes.length === 0);
  // a key added inside the record by hand is dropped on the next record, with one note naming it
  const p = planOf(root);
  const v = must(p.verification, "verification");
  fs.writeFileSync(path.join(root, REL), JSON.stringify({ ...p, verification: { ...v, recorded: { ...v.recorded, residuals: [{ nodeId: "80:2", why: "shadow" }] } } }, null, 2) + "\n");
  const r = recordPlan(REL, rep, REPORT, { cwd: root, now: NOW });
  const recKeys = Object.keys(must(planOf(root).verification?.recorded, "recorded"));
  check(`a hand key inside verification.recorded → dropped, ONE note naming it and pointing at deviations[] (got ${JSON.stringify(r.notes)})`,
    r.written && r.notes.length === 1 && (r.notes[0] ?? "").startsWith("verification.recorded held `residuals`, which --record-plan does not write — dropped") && /deviations\[\]/.test(r.notes[0] ?? "")
    && !recKeys.includes("residuals"));
}
{
  // two --compare runs at once: the other run rewrites the report file between this run's write and its record. The
  // record's sha256 and its facts come from this run's report text, so it never reads as a hand edit — only as an older
  // run until this report is on disk again
  const root = project();
  const other: VerifyReportV2 = { ...rep, verdict: "pass", headline: rep.headline + " (the other run)" };
  fs.writeFileSync(path.join(root, REPORT), JSON.stringify(other, null, 2) + "\n");
  const r = recordPlan(REL, rep, REPORT, { cwd: root, now: NOW });
  const got = planOf(root).verification?.recorded;
  const rec = must(isVerificationRecord(got) ? got : undefined, "recorded@2");
  const raced = checkPlan({ plan: planOf(root), file: path.join(root, REL) }, root);
  check(`the report rewritten by another run before the record → the record names THIS run's report (sha256 of its text, its verdict and headline), no block on it, the older-run warning, one note (got ${JSON.stringify(raced.blocking)}; ${JSON.stringify(r.notes)})`,
    rec.reportSha256 === sha256(JSON.stringify(rep, null, 2) + "\n") && rec.verdict === rep.verdict && rec.headline === rep.headline
    && !raced.blocking.some((b) => /verification\.recorded/.test(b)) && raced.warnings.some((w) => w.startsWith(`plan.verification records an older run of ${REPORT}`))
    && r.notes.some((n) => n.startsWith(`${REPORT} on disk is not the report this run wrote (another --compare rewrote it?)`)));
  fs.writeFileSync(path.join(root, REPORT), JSON.stringify(rep, null, 2) + "\n");
  const back = checkPlan({ plan: planOf(root), file: path.join(root, REL) }, root);
  check("…with this run's report back on disk the record matches it: no block, no older-run warning",
    !back.blocking.some((b) => /verification\.recorded/.test(b)) && !back.warnings.some((w) => /records an older run/.test(w)));
}
{
  // a recorded@1 plan (no schema; mode … a11y at the top level, as the first record wrote them), closed by the hook:
  // read with the fallback, then migrated by the first record — the hook's hash does not cover verification, so it stays closed
  const root = project();
  const p = planOf(root);
  const v1 = { mode: "rendered", coverage: { rendered: ["default"], notChecked: [] }, renderer: "playwright-chromium",
    artifacts: [REPORT, "design/verify/Crates.report.md", "design/verify/Crates.png"], deltas: [{ nodeId: "80:2", field: "background", severity: "high", expected: "#5b5fc7ff", actual: "#ff0000ff" }],
    a11y: { tool: "axe-core 4.13.0", violations: 1, warnings: 1, report: REPORT },
    recorded: { by: "verify-screen --record-plan", at: NOW, report: REPORT, reportSha256: sha256(fs.readFileSync(path.join(root, REPORT))), verdict: rep.verdict, headline: rep.headline,
      behaviourHeadline: rep.behaviour.headline, counts: { high: 1, medium: 1, low: 2, accepted: 1, notMeasured: 0, inferred: 0 } } };
  fs.writeFileSync(path.join(root, REL), JSON.stringify({ ...p, verification: v1 }, null, 2) + "\n");
  runHook(root);
  const facts = verificationFacts(planOf(root).verification);
  const res = checkPlan({ plan: planOf(root), file: path.join(root, REL) }, root);
  check(`recorded@1 is read with the fallback: the top-level keys, no block, no 'ignored' warning (got at ${facts.at}, mode ${String(facts.mode)}; blocking ${JSON.stringify(res.blocking)})`,
    facts.at === "verification" && facts.record === null && facts.mode === "rendered" && JSON.stringify(facts.artifacts) === JSON.stringify(v1.artifacts)
    && !res.blocking.some((b) => /verification\.recorded/.test(b)) && !res.warnings.some((w) => /is ignored|are ignored/.test(w)) && !openOf(root));
  const r = recordPlan(REL, rep, REPORT, { cwd: root, now: NOW });
  const v = must(planOf(root).verification, "verification");
  check(`the first record migrates it: the top-level mode/renderer/artifacts/deltas/a11y are gone, ONE note names them, recorded is @2 (got keys ${JSON.stringify(Object.keys(v))}; ${JSON.stringify(r.notes)})`,
    r.written && JSON.stringify(Object.keys(v)) === JSON.stringify(["coverage", "recorded", "hook"]) && r.notes.length === 1
    && (r.notes[0] ?? "").startsWith("verification.mode, verification.renderer, verification.artifacts, verification.deltas, verification.a11y: the record's keys are kept in verification.recorded now")
    && isVerificationRecord(v.recorded) && v.recorded.mode === "rendered" && v.recorded.renderer === "playwright-chromium" && v.recorded.a11y?.violations === 1);
  check("…and the plan stays closed (planHash leaves verification out; no re-stamp needed)", !openOf(root) && !r.notes.some((n) => /re-stamped/.test(n)));
}
{
  // a first-format record compared with the report its sha256 names: an untouched one (as the first writer wrote it)
  // passes; a @2 block stripped to the first-format keys with its verdict/headline/counts edited blocks, one message per
  // key; with the report rewritten since (sha differs) there is nothing to compare with
  const root = project();
  const p = planOf(root);
  const EDITED_V1 = (k: string): string => `verification.recorded.${k} is not what the report its reportSha256 names says (a hand edit, or an older record of a report another --compare rewrote) — re-run verify-screen --compare --record-plan (it rewrites the block in the current format), or restore the block; residuals go in deviations[]`;
  const v1 = { by: "verify-screen --record-plan", at: NOW, report: REPORT, reportSha256: sha256(fs.readFileSync(path.join(root, REPORT))), verdict: rep.verdict, headline: rep.headline,
    behaviourHeadline: rep.behaviour.headline, counts: { high: 1, medium: 1, low: 2, accepted: 1, notMeasured: 0, inferred: 0 } };
  const put = (recorded: JsonObject): void => fs.writeFileSync(path.join(root, REL), JSON.stringify({ ...p, verification: { ...p.verification, deltas: [], recorded } }, null, 2) + "\n");
  const v1Blocks = (): string[] => checkPlan({ plan: planOf(root), file: path.join(root, REL) }, root).blocking.filter((b) => /verification\.recorded/.test(b));
  put(v1);
  check(`an untouched first-format record of the report on disk → no block (got ${JSON.stringify(v1Blocks())})`, v1Blocks().length === 0);
  // the block --record-plan writes now, stripped down to the first-format keys: the same values, so no block either
  recordPlan(REL, rep, REPORT, { cwd: root, now: NOW });
  const full = must(planOf(root).verification?.recorded, "recorded");
  const stripped: JsonObject = { by: full.by, at: full.at, report: full.report, reportSha256: full.reportSha256, verdict: full.verdict, headline: full.headline,
    ...(full.behaviourHeadline !== undefined ? { behaviourHeadline: full.behaviourHeadline } : {}), counts: { ...full.counts } };
  put(stripped);
  check(`a current block stripped to the first-format keys, values untouched → no block (got ${JSON.stringify(v1Blocks())})`, v1Blocks().length === 0);
  put({ ...stripped, verdict: "pass" });
  check(`…its verdict then edited → BLOCKS on verdict (got ${JSON.stringify(v1Blocks())})`, JSON.stringify(v1Blocks()) === JSON.stringify([EDITED_V1("verdict")]));
  put({ ...stripped, verdict: "pass", headline: "PASS", counts: { ...v1.counts, high: 0, medium: 0 } });
  const many = v1Blocks();
  check(`…verdict, headline and two counts edited → one block each (got ${JSON.stringify(many)})`,
    JSON.stringify(many) === JSON.stringify([EDITED_V1("verdict"), EDITED_V1("headline"), EDITED_V1("counts.high"), EDITED_V1("counts.medium")]));
  // the report rewritten since the record (sha mismatch): an older record, not an edited one — no compare, the older-run warning
  put({ ...stripped, verdict: "pass" });
  fs.writeFileSync(path.join(root, REPORT), JSON.stringify({ ...rep, headline: rep.headline + " (re-run)" }, null, 2) + "\n");
  const older = checkPlan({ plan: planOf(root), file: path.join(root, REL) }, root);
  check(`the report rewritten since (sha differs) + an edited first-format verdict → no block, the older-run warning (got ${JSON.stringify(older.blocking)})`,
    !older.blocking.some((b) => /verification\.recorded/.test(b)) && older.warnings.some((w) => w.startsWith(`plan.verification records an older run of ${REPORT}`)));
  fs.rmSync(path.join(root, REPORT));
  check("…and no report on disk at all → no block", v1Blocks().length === 0);
}
{
  // a recorded@1 block a person added keys to that no record writes: ONE block naming them (not one per @2 key it
  // lacks), the plan still read the older way; the next record drops them
  const root = project();
  const p = planOf(root);
  fs.writeFileSync(path.join(root, REL), JSON.stringify({ ...p, verification: { ...p.verification, deltas: [], recorded: {
    by: "verify-screen --record-plan", at: NOW, report: REPORT, reportSha256: sha256(fs.readFileSync(path.join(root, REPORT))), verdict: rep.verdict, headline: rep.headline,
    counts: { high: 1, medium: 1, low: 2, accepted: 1, notMeasured: 0, inferred: 0 }, residuals: [{ nodeId: "80:2", why: "shadow" }], note: "checked by hand" } } }, null, 2) + "\n");
  const blocks = checkPlan({ plan: planOf(root), file: path.join(root, REL) }, root).blocking.filter((b) => /verification\.recorded/.test(b));
  check(`a recorded@1 with hand keys \`residuals\`, \`note\` → ONE block naming both and what to do (got ${JSON.stringify(blocks)})`,
    blocks.length === 1 && (blocks[0] ?? "").startsWith("verification.recorded is a record in the first format (no schema) with `residuals`, `note` added by hand, which verify-screen --compare --record-plan never writes — remove them, or re-run verify-screen --compare --record-plan")
    && /residuals go in deviations\[\]/.test(blocks[0] ?? "") && verificationFacts(planOf(root).verification).at === "verification");
  const r = recordPlan(REL, rep, REPORT, { cwd: root, now: NOW });
  const recKeys = Object.keys(must(planOf(root).verification?.recorded, "recorded"));
  check(`…the next record drops them with one note, and nothing blocks on the record (got ${JSON.stringify(r.notes)})`,
    r.notes.some((n) => n.startsWith("verification.recorded held `residuals`, `note`, which --record-plan does not write — dropped")) && !recKeys.includes("residuals") && !recKeys.includes("note")
    && !checkPlan({ plan: planOf(root), file: path.join(root, REL) }, root).blocking.some((b) => /verification\.recorded/.test(b)));
}
{
  // a static-only measured file → the report says so, and the record is static-only + the why, no renderer
  const so: VerifyReportV2 = compare(exp, { mode: "static-only", reason: "no dev server, no Playwright", nodes: [] }, {});
  check(`compare() of a static-only measured file: report.mode "static-only" + its reason (got ${JSON.stringify({ mode: so.mode, reason: so.reason })}); a rendered one carries no mode`,
    so.mode === "static-only" && so.reason === "no dev server, no Playwright" && rep.mode === undefined && !("reason" in rep));
  const root = project();
  const p = planOf(root);
  fs.writeFileSync(path.join(root, REL), JSON.stringify({ ...p, verification: { ...p.verification, renderer: "playwright-chromium" } }, null, 2) + "\n");
  fs.writeFileSync(path.join(root, REPORT), JSON.stringify(so, null, 2) + "\n");
  recordPlan(REL, so, REPORT, { cwd: root, now: NOW });
  const v = must(planOf(root).verification, "verification");
  const rec = must(isVerificationRecord(v.recorded) ? v.recorded : undefined, "recorded@2");
  check(`--record-plan of it: recorded.mode "static-only" + the report's reason, no renderer anywhere (got ${JSON.stringify({ mode: rec.mode, reason: rec.reason, renderer: rec.renderer, top: v.renderer })})`,
    rec.mode === "static-only" && rec.reason === "no dev server, no Playwright" && !("renderer" in rec) && v.renderer === undefined);
  // no report on disk: computeStatus reads the record (the hook passed it)
  fs.rmSync(path.join(root, "design/verify"), { recursive: true });
  runHook(root);
  const st = statusOf(root);
  check(`…computeStatus with no report reads the record: static-only, with its reason (got ${st.status}: ${st.reasons.join(" | ").slice(0, 160)})`,
    st.status === "static-only" && st.reasons.includes("built and checked statically — not rendered (no dev server, no Playwright)"));
  fs.mkdirSync(path.join(root, "design/verify"), { recursive: true });
  fs.writeFileSync(path.join(root, REPORT), JSON.stringify(rep, null, 2) + "\n");
  recordPlan(REL, rep, REPORT, { cwd: root, now: NOW });
  const rec2 = must(planOf(root).verification?.recorded, "recorded");
  check(`…a later rendered record: mode "rendered" + renderer, the static-only reason gone (got ${JSON.stringify(rec2)})`,
    isVerificationRecord(rec2) && rec2.mode === "rendered" && rec2.renderer === "playwright-chromium" && !("reason" in rec2));
}
{
  // --accept and the verify-build hook write the plan as --record-plan does — BOM, indentation and CRLF kept
  const crlf4 = (root: string): void => { const f = path.join(root, REL); fs.writeFileSync(f, "\ufeff" + JSON.stringify(readFixture(f, isPlan), null, 4).split("\n").join("\r\n") + "\r\n"); };
  const sameFormat = (t: string): boolean => t.startsWith("\ufeff{\r\n    \"status\"") && t.endsWith("}\r\n") && !/[^\r]\n/.test(t);
  const root = project();
  crlf4(root);
  const a = spawnSync(process.execPath, [VS, "--accept", REPORT, "--node", "80:2", "--field", "background", "--reason", "brand red agreed", "--by", "Sam Doe", "--plan", REL], { cwd: root, encoding: "utf8" });
  const text = fs.readFileSync(path.join(root, REL), "utf8");
  check(`--accept on a BOM + CRLF + 4-space plan: the waiver is written and the file keeps its format (exit ${a.status}; starts ${JSON.stringify(text.slice(0, 16))})`,
    a.status === 0 && sameFormat(text) && (planOf(root).waivers ?? []).some((w) => isJsonObject(w) && w.nodeId === "80:2" && w.reason === "brand red agreed")
    && !fs.readdirSync(path.join(root, "design/plan")).some((f) => /\.tmp/.test(f)));
  const h = runHook(root);
  const hooked = fs.readFileSync(path.join(root, REL), "utf8");
  check(`…the verify-build hook's record keeps it too (exit ${h.status}; starts ${JSON.stringify(hooked.slice(0, 16))})`,
    h.status === 0 && planOf(root).verification?.hook?.result !== undefined && hooked !== text && sameFormat(hooked));
}

console.log("planHash: verification left out, the legacy formula still accepted:");
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

console.log("recording a plan the old hook closed, project-relative paths only:");
{
  // the hook closed this plan under the legacy formula (it covered verification); the first --record-plan after the
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
  check(`after the first --record-plan: still closed, not pending (got ${st.status}: ${st.reasons.join(" | ").slice(0, 160)})`,
    r.written && !openOf(root) && !st.reasons.some((x) => /plan changed after the hook/.test(x)));
  check("…the hook's planHash is now the current formula's, the rest of the hook record is untouched, and a note says so",
    after.verification?.hook?.planHash === planHash(after) && after.verification.hook.result === "pass"
    && JSON.stringify(after.verification.hook.files) === JSON.stringify(hook.files) && r.notes.some((n) => /an older plan hash that also covered verification/.test(n) && /re-stamped/.test(n)));
  const quiet = spawnSync(process.execPath, [HOOK], { cwd: root, input: JSON.stringify({ cwd: root }), encoding: "utf8" });
  check("…and the Stop hook's fast path stays silent on it", quiet.status === 0 && quiet.stderr === "");
  // a hash that matches NEITHER formula (the plan changed after the hook) is never re-stamped: the plan stays pending
  const q = planOf(root);
  must(q.verification?.hook, "hook").planHash = "0000000000000000";
  fs.writeFileSync(path.join(root, REL), JSON.stringify(q, null, 2) + "\n");
  const r2 = recordPlan(REL, { ...rep, headline: rep.headline + " (again)" }, REPORT, { cwd: root, now: NOW });
  check("control: a hook hash matching neither formula is left alone (still pending, no re-stamp note)",
    planOf(root).verification?.hook?.planHash === "0000000000000000" && openOf(root) && !r2.notes.some((n) => /re-stamped/.test(n)));
}
{
  // a report or artifact outside the project — the plan records project-relative paths only
  const root = project();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-outside-"));
  const before = fs.readFileSync(path.join(root, REL), "utf8");
  let threw = "";
  try { recordPlan(REL, rep, path.join(outside, "Crates.report.json"), { cwd: root, now: NOW }); } catch (e) { threw = e instanceof Error ? e.message : String(e); }
  check(`a report outside the project → refused (throws), the plan is unchanged (got ${JSON.stringify(threw.slice(0, 120))})`,
    /is outside the project/.test(threw) && /project-relative paths only/.test(threw) && fs.readFileSync(path.join(root, REL), "utf8") === before);
  fs.writeFileSync(path.join(outside, "shot.png"), "png");
  const withOutside: VerifyReportV2 = { ...rep, artifacts: [...rep.artifacts, path.join(outside, "shot.png"), "../" + path.basename(outside) + "/shot.png"] };
  const r = recordPlan(REL, withOutside, "./design/verify/../verify/Crates.report.json", { cwd: root, now: NOW });
  const v = planOf(root).verification;
  const rec = must(isVerificationRecord(v?.recorded) ? v.recorded : undefined, "recorded@2");
  check(`an artifact outside the project (absolute or ../) → left out with ONE note; the report path is normalised (got ${JSON.stringify(rec.artifacts)}; ${JSON.stringify(r.notes)})`,
    JSON.stringify(rec.artifacts) === JSON.stringify([REPORT, "design/verify/Crates.report.md", "design/verify/Crates.png"]) && rec.report === REPORT && rec.a11y?.report === REPORT
    && r.notes.filter((n) => /artifact\(s\) outside the project not recorded in verification\.recorded\.artifacts/.test(n)).length === 1 && !JSON.stringify(v).includes(outside));
  fs.rmSync(outside, { recursive: true, force: true });
}

console.log("verify-build on the record: a hand edit of it blocks; its keys left at the top level are ignored:");
{
  const EDITED = (k: string): string => `verification.recorded.${k} is tool-owned and was edited — re-run verify-screen --compare --record-plan (or restore the block); residuals go in deviations[]`;
  const root = project();
  runHook(root);
  recordPlan(REL, rep, REPORT, { cwd: root, now: NOW });
  const recorded = planOf(root);
  check("setup: recorded@2 and closed", !openOf(root) && isVerificationRecord(recorded.verification?.recorded));
  // the recorded plan with `patch` applied to verification (and its record), written to disk; → checkPlan of it
  const write = (patch: (v: JsonObject, rec: JsonObject) => void): void => {
    const p = structuredClone(recorded);
    const v: unknown = p.verification;
    const rec: unknown = isJsonObject(v) ? v.recorded : undefined;
    if (isJsonObject(v) && isJsonObject(rec)) patch(v, rec);
    fs.writeFileSync(path.join(root, REL), JSON.stringify(p, null, 2) + "\n");
  };
  const checked = () => checkPlan({ plan: planOf(root), file: path.join(root, REL) }, root);
  const recordBlocks = (): string[] => checked().blocking.filter((b) => b.startsWith("verification.recorded"));
  write((_, rec) => { rec.verdict = "pass"; });
  check(`the verdict edited while reportSha256 still names the report → BLOCKS: "${EDITED("verdict")}" (got ${JSON.stringify(recordBlocks())})`,
    JSON.stringify(recordBlocks()) === JSON.stringify([EDITED("verdict")]));
  write((_, rec) => { rec.headline = "PASS — all good"; if (isJsonObject(rec.counts)) rec.counts.high = 0; });
  check(`the headline and counts.high edited → one block each (got ${JSON.stringify(recordBlocks())})`,
    JSON.stringify(recordBlocks()) === JSON.stringify([EDITED("headline"), EDITED("counts.high")]));
  // everything else the report decides is checked the same way: the deltas, the mode, the reason, the renderer, a11y
  const deltaEdits: Array<[string, (rec: JsonObject) => void, string[]]> = [
    ["the deltas emptied", (rec) => { rec.deltas = []; }, ["deltas"]],
    ["a delta's actual set to its expected", (rec) => { const d = Array.isArray(rec.deltas) ? rec.deltas[0] : undefined; if (isJsonObject(d)) d.actual = d.expected ?? null; }, ["deltas"]],
    ["the mode switched to static-only (renderer dropped, a reason added)", (rec) => { rec.mode = "static-only"; delete rec.renderer; rec.reason = "no browser"; }, ["mode", "reason", "renderer"]],
    ["the renderer changed", (rec) => { rec.renderer = "webkit"; }, ["renderer"]],
    ["the a11y violations zeroed", (rec) => { if (isJsonObject(rec.a11y)) rec.a11y.violations = 0; }, ["a11y"]],
    ["the a11y removed", (rec) => { delete rec.a11y; }, ["a11y"]],
  ];
  for (const [what, patch, keys] of deltaEdits) {
    write((_, rec) => patch(rec));
    check(`${what}, the sha still matching → BLOCKS on exactly ${keys.join(", ")} (got ${JSON.stringify(recordBlocks())})`, JSON.stringify(recordBlocks()) === JSON.stringify(keys.map(EDITED)));
  }
  // key order is not content: an editor that reorders the record's keys (and those of its a11y and delta rows) edits nothing
  const reversed = (o: JsonObject): JsonObject => Object.fromEntries(Object.entries(o).reverse());
  write((v, rec) => {
    const rows = Array.isArray(rec.deltas) ? rec.deltas.map((d) => (isJsonObject(d) ? reversed(d) : d)) : [];
    v.recorded = reversed({ ...rec, deltas: rows, ...(isJsonObject(rec.a11y) ? { a11y: reversed(rec.a11y) } : {}), ...(isJsonObject(rec.counts) ? { counts: reversed(rec.counts) } : {}) });
  });
  const reordered: unknown = planOf(root).verification?.recorded;
  check(`the record's keys reordered (top level, a11y, counts, delta rows), values unchanged → no block (got ${JSON.stringify(recordBlocks())})`,
    recordBlocks().length === 0 && isJsonObject(reordered) && Object.keys(reordered)[0] === "a11y" && isJsonObject(reordered.a11y) && Object.keys(reordered.a11y)[0] === "report");
  // a @2 block with its schema removed is not a recorded@1: it holds keys that record never wrote
  write((_, rec) => { delete rec.schema; });
  const noSchema = recordBlocks();
  check(`the schema removed from a @2 block → still a @2 block, and it BLOCKS once, saying the schema is missing (got ${JSON.stringify(noSchema)})`,
    noSchema.length === 1 && /^verification\.recorded has no schema but holds `mode`, .*`artifacts`.*, which only a @2 record writes; it lacks `schema` — re-run verify-screen --compare --record-plan \(or restore the block\); residuals go in deviations\[\]$/.test(noSchema[0] ?? ""));
  // --status says blocked at once for a closed plan whose record was edited (the hook's next check would block)
  write((_, rec) => { rec.verdict = "pass"; });
  const edited = statusOf(root);
  check(`--status of a closed plan with an edited record: the failing report first, then the hook named blocked by the edit (got ${edited.status}: ${edited.reasons.join(" | ").slice(0, 200)})`,
    edited.status === "failed" && edited.reasons.includes(`hook: ${EDITED("verdict")}`));
  const st2 = computeStatus(planOf(root), { cwd: root, planFile: path.join(root, REL), reports: [] });
  check(`…with no failing report in the way, the computed status is "blocked", the edit its first reason (got ${st2.status}: ${st2.reasons[0] ?? ""})`,
    st2.status === "blocked" && st2.reasons[0] === EDITED("verdict"));
  // the Stop hook: the plan was closed, and planHash leaves verification out — the edit still reopens it, and it blocks
  write((_, rec) => { rec.verdict = "pass"; });
  const open = openOf(root);
  const h = runHook(root);
  const hook = planOf(root).verification?.hook;
  check(`…a closed plan whose record is then edited is open again; the Stop hook BLOCKS with the message and records it (open ${open}, exit ${h.status})`,
    open && h.status === 2 && h.stderr.includes(EDITED("verdict")) && hook?.result === "blocked" && hook.blocking.includes(EDITED("verdict")));
  const fix = recordPlan(REL, rep, REPORT, { cwd: root, now: NOW });
  const h2 = runHook(root);
  check(`…--compare --record-plan repairs it: the record is rewritten whole and the hook passes again (written ${fix.written}, exit ${h2.status})`,
    fix.written && recordBlocks().length === 0 && h2.status === 0 && planOf(root).verification?.hook?.result === "pass" && !openOf(root));
  // the report rewritten since the record (its sha no longer matches): the record is older, not edited — a warning, no block
  write((_, rec) => { rec.verdict = "pass"; });
  fs.writeFileSync(path.join(root, REPORT), JSON.stringify({ ...rep, headline: rep.headline + " (re-run)" }, null, 2) + "\n");
  const older = checked();
  check(`control: the report rewritten since (sha differs) + an edited verdict → no block, the older-run warning (got ${JSON.stringify(older.blocking)})`,
    !older.blocking.some((b) => /verification\.recorded/.test(b)) && older.warnings.some((w) => w.startsWith(`plan.verification records an older run of ${REPORT}`)));
  fs.writeFileSync(path.join(root, REPORT), JSON.stringify(rep, null, 2) + "\n");
  // the record's keys (and a hand verdict) at the top level beside a valid recorded@2: ignored, one warning; the readers keep reading the record
  write((v) => { v.mode = "static-only"; v.deltas = []; v.verdict = "pass"; });
  const shadow = checked();
  const ignored = shadow.warnings.filter((w) => /ignored — verification\.recorded is the record/.test(w));
  check(`top-level mode/deltas/verdict beside recorded@2 → ONE warning "verification.mode, verification.deltas, verification.verdict are ignored — verification.recorded is the record …" (got ${JSON.stringify(ignored)})`,
    ignored.length === 1 && (ignored[0] ?? "").startsWith("verification.mode, verification.deltas, verification.verdict are ignored — verification.recorded is the record (")
    && /a residual goes in deviations\[\]/.test(ignored[0] ?? "") && !shadow.blocking.some((b) => /verification\.recorded/.test(b)));
  check("…the top-level static-only (no reason) and verdict \"pass\" are not read: no static-only warning, no 'says \"pass\" but' contradiction",
    !shadow.warnings.some((w) => /static-only" with no `reason`|says "pass" but/.test(w)) && verificationFacts(planOf(root).verification).mode === "rendered");
  write(() => undefined);
  check("control: the record alone → no 'ignored' warning", !checked().warnings.some((w) => /ignored — verification\.recorded/.test(w)));
  // a record naming something that is not a regular file — a FIFO (whose open waits for a writer) or /dev/zero (which
  // never ends) — is read as no report: the hook's fast path and the sha warning return at once
  if (process.platform !== "win32") {
    const fifo = path.join(root, "design/verify/pipe.report.json");
    const made = spawnSync("mkfifo", [fifo]).status === 0;
    for (const target of [...(made ? [fifo] : []), "/dev/zero"]) {
      write((_, rec) => { rec.report = target; rec.verdict = "pass"; });
      const t0 = Date.now();
      const p = planOf(root);
      const out = [verifyBuild.recordedEdits(p, root).length, verifyBuild.recordedReportWarnings(p, root).length, openOf(root) ? 1 : 0];
      check(`a record naming ${target === fifo ? "a FIFO" : target} → no report read, no hang (no edit block, no sha warning, still closed) in ${Date.now() - t0} ms`,
        JSON.stringify(out) === "[0,0,0]" && Date.now() - t0 < 5000);
    }
    if (!made) console.log("  (mkfifo unavailable: only /dev/zero checked)");
  } else console.log("  (skipped: FIFO and /dev/zero are POSIX)");
}
{
  // a plan with no `recorded` (hand-written, native) keeps the top-level reading: a hand verdict "pass" against a failing report is the contradiction
  const root = project();
  const p = planOf(root);
  fs.writeFileSync(path.join(root, REL), JSON.stringify({ ...p, verification: { ...p.verification, verdict: "pass" } }, null, 2) + "\n");
  const w = checkPlan({ plan: planOf(root), file: path.join(root, REL) }, root).warnings;
  check("no recorded block: verification.verdict \"pass\" beside a failing report → \"…the report is the verdict; the plan cannot overrule it\", and no 'ignored' warning",
    w.some((x) => x === `verification.verdict says "pass" but ${REPORT} says verdict "fail" — the report is the verdict; the plan cannot overrule it`) && !w.some((x) => /ignored — verification\.recorded/.test(x)));
}

console.log("the CLI (verify-screen --compare --record-plan, flag-gated):");
{
  const usage = spawnSync(process.execPath, [VS, "--help"], { encoding: "utf8" });
  if (!/--record-plan/.test(usage.stdout + usage.stderr)) {
    console.log("  - SKIPPED: verify-screen has no --record-plan flag yet — the CLI cases (no plan → exit 2, no report written) are not run");
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
    // round trip: whatever the measured file holds, a fresh --compare --record-plan writes a record the hook accepts
    // (a value of the wrong kind is left out of the record, never written as is — else the hook blocks and re-recording
    // writes the same block again)
    const cases: Array<[string, Record<string, unknown>, (r: JsonObject) => boolean]> = [
      ["a rendered file", { measuredAt: measured.measuredAt, renderer: measured.renderer, nodes, behaviour }, (r) => r.mode === "rendered" && r.renderer === "playwright-chromium" && isJsonObject(r.a11y)],
      ["a static-only file with a string reason", { mode: "static-only", reason: "no simulator", nodes: [] }, (r) => r.mode === "static-only" && r.reason === "no simulator" && !("renderer" in r)],
      ["a static-only file with a non-string reason", { mode: "static-only", reason: { why: "no simulator" }, nodes: [] }, (r) => r.mode === "static-only" && !("reason" in r)],
      ["a rendered file with an object renderer", { measuredAt: measured.measuredAt, renderer: { name: "chromium", version: "153" }, nodes }, (r) => r.mode === "rendered" && !("renderer" in r)],
    ];
    for (const [what, file, shape] of cases) {
      const root3 = project();
      fs.writeFileSync(path.join(root3, "design/verify/Crates.expected.json"), JSON.stringify(exp, null, 2));
      fs.writeFileSync(path.join(root3, "design/verify/Crates.measured.json"), JSON.stringify(file));
      const run = () => spawnSync(process.execPath, [VS, "--compare", "design/verify/Crates.expected.json", "design/verify/Crates.measured.json", "--plan", REL, "--record-plan"], { cwd: root3, encoding: "utf8" });
      const c1 = run();
      const rec3: unknown = planOf(root3).verification?.recorded;
      const blocks1 = checkPlan({ plan: planOf(root3), file: path.join(root3, REL) }, root3).blocking.filter((b) => /verification\.recorded/.test(b));
      const c2 = run();
      const blocks2 = checkPlan({ plan: planOf(root3), file: path.join(root3, REL) }, root3).blocking.filter((b) => /verification\.recorded/.test(b));
      check(`round trip, ${what}: --compare --record-plan → a valid @2 record, checkPlan blocks nothing on it, and a second run neither (exit ${c1.status}/${c2.status}; blocks ${JSON.stringify(blocks1)}; ${c1.stderr.split("\n").filter((l) => /error/.test(l)).join(" | ")})`,
        isVerificationRecord(rec3) && isJsonObject(rec3) && shape(rec3) && blocks1.length === 0 && blocks2.length === 0 && !/error {2}--record-plan/.test(c1.stderr + c2.stderr));
    }
  }
}

console.log("dotted import names resolve; a report reached through a symlink is inside the project:");
{
  const root = project();
  fs.mkdirSync(path.join(root, "src/shell"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/shell/app.component.tsx"), "export const Shell = () => null;\n");
  const dotted = { files: ["src/Crates.tsx"], anchors: { "1:1": { mapModule: "src/shell/app.component" }, "1:2": { mapModule: "src/shell/gone.tsx" } } };
  check("'src/shell/app.component' (a dot in the last part, no extension) resolves to the .tsx and is hashed",
    planCodeFiles(dotted, root).includes("src/shell/app.component.tsx") && !planCodeFiles(dotted, root).includes("src/shell/app.component"));
  check("a mapped path that names no file (a typo / a deleted file) is still hashed as written AND named by the skipped note",
    planCodeFiles(dotted, root).includes("src/shell/gone.tsx") && JSON.stringify(planCodeSkipped(dotted, root)) === JSON.stringify(["src/shell/gone.tsx"]));
  const link = path.join(os.tmpdir(), `dtwin-record-link-${process.pid}`);
  try {
    fs.symlinkSync(root, link);
    let written = false;
    try { written = recordPlan(REL, rep, path.join(link, REPORT), { cwd: fs.realpathSync(root), now: NOW }).written; } catch { /* refused: fails below */ }
    check("a report path through a symlink to the project is inside it (recorded project-relative)",
      written && planOf(root).verification?.recorded?.report === REPORT);
  } finally { try { fs.unlinkSync(link); } catch { /* never created */ } }
}

// Every tool plan write is a locked read-modify-write (plan-record.ts updatePlan): writers in separate processes —
// waiver rows (--accept's write) and the Stop hook's record — never lose each other's keys.
console.log("plan writers in separate processes — no lost update:");
{
  const root = project();
  recordPlan(REL, rep, REPORT, { cwd: root, now: NOW });
  const child = path.join(import.meta.dirname, "lock-child.ts");
  const N = 4, K = 8;
  const run = (cmd: string[], cwd?: string): Promise<{ code: number | null; err: string }> => new Promise((resolve) => {
    const p = spawn(process.execPath, cmd, cwd === undefined ? {} : { cwd });
    let err = "";
    p.stderr.on("data", (b: Buffer) => { err += b.toString(); });
    p.on("close", (code) => resolve({ code, err }));
  });
  const results = await Promise.all([
    ...Array.from({ length: N }, (_, w) => run([child, "waive", path.join(root, REL), `w${w}`, String(K)])),
    run([HOOK, REL], root), run([HOOK, REL], root),
  ]);
  const after = planOf(root);
  const rows = (after.waivers ?? []).filter((w) => isJsonObject(w) && typeof w.nodeId === "string" && /^w\d:\d+$/.test(w.nodeId));
  check(`${N} processes × ${K} waiver writes and two Stop-hook runs at once → all ${N * K} rows, the original waiver, --record-plan's record and the hook's record are all there`,
    results.slice(0, N).every((r) => r.code === 0) && rows.length === N * K && new Set(rows.map((w) => isJsonObject(w) ? w.nodeId : "")).size === N * K
    && (after.waivers ?? []).some((w) => isJsonObject(w) && w.nodeId === "80:3") && after.verification?.recorded?.at === NOW && after.verification.hook?.result !== undefined);
  if (rows.length !== N * K) console.log(`    rows ${rows.length}; ${results.map((r) => `${r.code}${r.err ? `: ${r.err.split("\n")[0]}` : ""}`).join(" | ")}`);
  check("…no lock or tmp file is left in design/plan/", fs.readdirSync(path.join(root, "design", "plan")).join() === "Crates.json");
}

// A lock a killed writer leaves must never sit beside the plan, where it could be committed: with a project root (a
// package.json) it lives in the run cache; with none, beside the plan (the temp dir is not shared with the sandbox).
console.log("the plan's lock lives in the run cache:");
{
  const root = project();
  const plan = path.join(root, REL);
  check("no package.json → the lock is <plan>.lock beside it", planLockFile(plan) === plan + ".lock");
  fs.writeFileSync(path.join(root, "package.json"), "{\"name\":\"crates-app\",\"private\":true}\n");
  fs.mkdirSync(path.join(root, "node_modules"));
  const lock = planLockFile(plan);
  const cache = path.join(fs.realpathSync.native(root), "node_modules", ".cache", "designtwin-verify", "plan-locks");
  check("a project with node_modules → <project>/node_modules/.cache/designtwin-verify/plan-locks/Crates.json.<key>.lock",
    path.dirname(lock) === cache && /^Crates\.json\.[0-9a-f]{16}\.lock$/.test(path.basename(lock)));
  const prevCwd = process.cwd();
  process.chdir(path.join(root, "design"));
  let fromSubdir = "";
  try { fromSubdir = planLockFile(path.join("plan", path.basename(plan))); } finally { process.chdir(prevCwd); }
  check("…the same lock from another working directory (a relative path)", fromSubdir === lock);
  let during: string[] = [];
  const wrote = updatePlan(plan, (raw) => {
    during = [fs.existsSync(lock) ? "held" : "free", fs.readdirSync(path.dirname(plan)).join()];
    const p: unknown = JSON.parse(raw ?? "{}");
    return isJsonObject(p) ? { ...p, screenName: "Crates2" } : p;
  });
  check("an update holds that lock while it runs, and design/plan/ holds only the plan; released after",
    wrote && during.join(" ") === "held Crates.json" && !fs.existsSync(lock) && fs.readdirSync(path.dirname(plan)).join() === "Crates.json");
  // a run cache this process may not write (a sandboxed command outside a hoisted workspace's write scope): the
  // status writes' sentence, never a raw errno and never a lock beside the plan instead
  if (process.platform !== "win32" && !(typeof process.getuid === "function" && process.getuid() === 0)) {
    const nm = path.join(root, "node_modules");
    const before = fs.readFileSync(plan, "utf8");
    fs.rmSync(path.join(nm, ".cache"), { recursive: true, force: true });
    fs.chmodSync(nm, 0o555);
    let e: unknown = null;
    try { updatePlan(plan, () => ({ screenName: "never" })); } catch (x) { e = x; } finally { fs.chmodSync(nm, 0o755); }
    const msg = e instanceof Error ? e.message : String(e);
    check("a run cache that refuses the plan's lock (EACCES) → RunCacheUnwritable naming the run cache and where to run from; the plan untouched, no lock beside it",
      e instanceof Error && e.name === "RunCacheUnwritable" && msg.includes(path.join(fs.realpathSync.native(root), "node_modules", ".cache", "designtwin-verify"))
      && /is not writable \(sandbox write scope\?\) — run from /.test(msg) && fs.readFileSync(plan, "utf8") === before && fs.readdirSync(path.dirname(plan)).join() === "Crates.json");
    if (!(e instanceof Error && e.name === "RunCacheUnwritable")) console.log(`    threw: ${msg}`);
  } else console.log("  (skipped: a read-only run cache — mode bits refuse nothing on Windows / as root)");
}

report();
