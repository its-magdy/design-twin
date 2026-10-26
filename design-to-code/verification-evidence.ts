// verification-evidence.ts — what a plan's `verification` block says, and which verify report is the plan's own. ONE
// reader over the block and the reports located for the plan (verify-locate.ts locateReports), which plan-status.ts (a
// plan's status) and verify-build.ts (the Stop hook's warnings) both ask; plan-record.ts writes the block and reads it
// back through it too.
//
// What it returns, from verificationEvidence(plan, located, {cwd}):
//   - facts: mode … a11y, read from verification.recorded@2 when there is one, else from verification's top level
//     (verificationFacts);
//   - recorded: the report verification.recorded.report names, in ONE spelling (recordedRel: project-relative, `/`,
//     the report .json for its .md) — read on disk against the record's sha256 (recordedReport), matched against the
//     located reports by that spelling, everywhere;
//   - own: the ONE report that speaks for the plan (OWN REPORT below);
//   - shapeWarnings: the block's shape and its agreement with itself and the reports (never a block);
//   - behaviourWarnings: the reports' behaviour/a11y section and the plan's a11y number against the own report.
//
// OWN REPORT. The status is judged over EVERY located report (plan-status.ts: one failing report is enough to fail, so a
// failing variant set is never silenced). Where ONE report has to speak — the a11y number the plan copied, the "checks did
// not run" warning, the git commit a "verified" status names — it is the own report, chosen by CONTENT, never by a clock
// (a `touch` or a fresh clone reorders mtimes): the located report verification.recorded.report names (the one its record
// was written from); else, among the reports for the plan's own screen (matchedBy "name", as locateReports ranks; all of
// them when none is), the latest measuredAt — none is the oldest — with mtime only breaking a tie.
import fs from "node:fs";
import path from "node:path";
import { sha256Hex } from "../bridge/src/hash.ts";
import { ifDefined } from "../bridge/src/json-util.ts";
import { readRegularFile } from "../bridge/src/read-json.ts";
import { scriptCmd } from "./cli-args.ts";
import { isRecordV2Shaped, isVerificationRecord, isVerifyReport } from "./doc-guards.ts";
import { isJsonObject, isPassingVerdict } from "./types.ts";
import type { JsonObject, JsonValue, Plan, PlanA11yRecord, PlanVerification, PlanVerificationRecord, VerifyReport } from "./types.ts";
import type { ReportRef } from "./verify-locate.ts";
import { siblingFile } from "./verify-sets.ts";

// ---------------------------------------------------------------- the block's facts

/** mode … a11y as every reader takes them. A recorded@2 block (doc-guards.ts isRecordV2Shaped; `record` is that block
 *  when it is the tool's shape) speaks for each key it holds — `at` "verification.recorded"; a key it lacks (a11y when
 *  the report's behaviour checks did not run, reason when the measured file gave none) is read from verification's top
 *  level, where the agent may have written it (`a11yAt` says where a11y came from). Without a recorded@2 — a
 *  hand-written or native plan, a recorded@1 one — every key is the top level's (`at` "verification"). */
export interface VerificationFacts {
  at: "verification.recorded" | "verification";
  a11yAt: "verification.recorded" | "verification";
  record: PlanVerificationRecord | null;
  mode: PlanVerification["mode"]; reason: string | undefined; renderer: string | undefined;
  artifacts: PlanVerification["artifacts"]; deltas: PlanVerification["deltas"]; a11y: PlanA11yRecord | undefined;
}
const TOOL_KEYS = ["mode", "reason", "renderer", "artifacts", "deltas", "a11y"] as const;
export function verificationFacts(v: PlanVerification | null | undefined): VerificationFacts {
  const top: PlanVerification = v && typeof v === "object" ? v : {};
  const rec: unknown = top.recorded;
  if (!isJsonObject(rec) || !isRecordV2Shaped(rec)) {
    return { at: "verification", a11yAt: "verification", record: null, mode: top.mode, reason: top.reason, renderer: top.renderer, artifacts: top.artifacts, deltas: top.deltas, a11y: top.a11y };
  }
  const r: JsonObject = rec;
  const has = (k: typeof TOOL_KEYS[number]): boolean => r[k] !== undefined;
  const str = (x: JsonValue | undefined): string | undefined => (typeof x === "string" ? x : undefined);
  const num = (x: JsonValue | undefined): number | undefined => (typeof x === "number" ? x : undefined);
  const a = r.a11y;
  const a11y: PlanA11yRecord | undefined = isJsonObject(a)
    ? { ...ifDefined("tool", str(a.tool)), ...ifDefined("violations", num(a.violations)), ...ifDefined("warnings", num(a.warnings)), ...ifDefined("report", str(a.report)) } : undefined;
  return { at: "verification.recorded", a11yAt: has("a11y") ? "verification.recorded" : "verification", record: isVerificationRecord(r) ? r : null,
    mode: has("mode") ? str(r.mode) : top.mode, reason: has("reason") ? str(r.reason) : top.reason, renderer: has("renderer") ? str(r.renderer) : top.renderer,
    artifacts: has("artifacts") ? r.artifacts : top.artifacts, deltas: has("deltas") ? r.deltas : top.deltas, a11y: has("a11y") ? a11y : top.a11y };
}

// ---------------------------------------------------------------- the record's report

const slash = (x: string): string => x.split(path.sep).join("/").split("\\").join("/");
/** a report name with its .md spelt as the report .json beside it */
const asJson = (x: string): string => siblingFile(x, "reportMd", "report");
/** A report name as a plan writes it (project-relative, absolute, `./…`, the .md) in ReportRef.rel's spelling:
 *  project-relative, `/`-separated, the report .json — or null when there is no name. --record-plan writes exactly this
 *  spelling, so any other is a hand edit; every reader matches the record's report by it. */
export function recordedRel(report: unknown, cwd: string): string | null {
  if (typeof report !== "string" || !report.trim()) return null;
  return asJson(slash(path.relative(cwd, path.resolve(cwd, report.trim()))));
}
const recordedName = (plan: { verification?: unknown }): unknown => {
  const v = plan.verification;
  const rec = isJsonObject(v) ? v.recorded : undefined;
  return isJsonObject(rec) ? rec.report : undefined;
};

/** A plan's verification.recorded against the report it names (`report`: recordedRel's spelling): none recorded; the
 *  report not on disk; there but not a regular file (a record naming a FIFO or a device must not hang the hook: never
 *  read); its bytes no longer the ones the record's reportSha256 names (rewritten since — an older record); the bytes it
 *  names but no verify report; or the report it names, parsed. */
export type RecordedReport =
  | { kind: "none" }
  | { kind: "missing"; report: string }
  | { kind: "unreadable"; report: string }
  | { kind: "rewritten"; report: string }
  | { kind: "not-a-report"; report: string }
  | { kind: "names"; report: string; doc: VerifyReport };
export function recordedReport(plan: { verification?: unknown }, cwd: string): RecordedReport {
  const v = plan.verification;
  const rec = isJsonObject(v) ? v.recorded : undefined;
  const rel = recordedRel(recordedName(plan), cwd);
  if (!isJsonObject(rec) || rel === null) return { kind: "none" };
  return reportNamed(rel, rec.reportSha256, cwd);
}
/** The report file `report` (project-relative or absolute) as a record's sha256 `sha` names it. */
function reportNamed(report: string, sha: unknown, cwd: string): Exclude<RecordedReport, { kind: "none" }> {
  if (!fs.existsSync(path.resolve(cwd, report))) return { kind: "missing", report };
  const bytes = readRegularFile(path.resolve(cwd, report));
  if (!bytes) return { kind: "unreadable", report };
  if (typeof sha !== "string" || sha256Hex(bytes) !== sha) return { kind: "rewritten", report };
  let parsed: unknown = null;
  try { const x: unknown = JSON.parse(bytes.toString("utf8")); parsed = x; } catch { /* unparseable: no report */ }
  return isVerifyReport(parsed) ? { kind: "names", report, doc: parsed } : { kind: "not-a-report", report };
}
/** The report a record's reportSha256 still names (its name read in recordedRel's spelling), parsed — null when there is
 *  none to compare with (not on disk, not a regular file, its bytes rewritten since, or not a verify report). */
export function reportRecordNames(report: unknown, reportSha256: unknown, cwd: string): VerifyReport | null {
  const rel = recordedRel(report, cwd);
  if (rel === null) return null;
  const r = reportNamed(rel, reportSha256, cwd);
  return r.kind === "names" ? r.doc : null;
}

// ---------------------------------------------------------------- the own report

const measuredMs = (r: ReportRef): number => {
  const t = r.measuredAt === null ? NaN : Date.parse(r.measuredAt);
  return Number.isNaN(t) ? -Infinity : t;
};
/** OWN REPORT (header) among `reports`: the one named `recorded` (recordedRel's spelling), else the own screen's latest. */
function ownAmong(reports: readonly ReportRef[], recorded: string | null): ReportRef | null {
  const named = recorded === null ? undefined : reports.find((r) => r.rel === recorded);
  if (named) return named;
  const own = reports.filter((r) => r.matchedBy === "name");
  const later = (r: ReportRef, best: ReportRef): boolean => measuredMs(r) > measuredMs(best) || (measuredMs(r) === measuredMs(best) && r.mtimeMs > best.mtimeMs);
  return (own.length ? own : reports).reduce<ReportRef | null>((best, r) => (!best || later(r, best) ? r : best), null);
}

// ---------------------------------------------------------------- the reader

export interface EvidenceContext {
  /** the project root: every report name is read against it */
  cwd: string;
  /** the plan's file: an a11y.report written relative to it is read from there */
  planFile?: string | undefined;
}
export interface VerificationEvidence {
  facts: VerificationFacts;
  /** the report verification.recorded.report names, in recordedRel's spelling (null: none named) */
  recorded: string | null;
  /** the located report the record names (null: none named, or not one of the located) */
  recordedRef: ReportRef | null;
  /** the reports located for the plan, every one of which the status judges */
  located: readonly ReportRef[];
  /** the ONE report that speaks for the plan (OWN REPORT) */
  own: ReportRef | null;
  /** the block's shape, the record against its report, and the block against itself and the reports — warnings only */
  shapeWarnings(): string[];
  /** the reports' behaviour/a11y section, and the plan's a11y number against the report it came from — warnings only */
  behaviourWarnings(): string[];
}

export function verificationEvidence(plan: Plan, located: readonly ReportRef[], ctx: EvidenceContext): VerificationEvidence {
  const facts = verificationFacts(plan.verification);
  const recorded = recordedRel(recordedName(plan), ctx.cwd);
  const recordedRef = recorded === null ? null : located.find((r) => r.rel === recorded) ?? null;
  const own = ownAmong(located, recorded);
  return {
    facts, recorded, recordedRef, located, own,
    shapeWarnings: () => [
      ...checkVerification(facts, ctx.cwd), ...missingEvidence(plan, facts), ...recordWarnings(plan, located, ctx.cwd), ...recordedShadowWarnings(plan),
      ...contradictions(plan, facts, located, recorded),
    ],
    behaviourWarnings: () => behaviourWarnings(facts, located, own, recorded, ctx),
  };
}

// ---------------------------------------------------------------- shape warnings

// What the plan says about how the build was checked — mode … a11y (facts). Every message names the block it read.
function checkVerification(f: VerificationFacts, cwd: string): string[] {
  const at = f.at;
  if (f.mode === undefined) {
    return ["no `verification.mode` in the plan — record how the build was checked: {mode:\"rendered\", renderer, artifacts:[…], deltas:[…]} after rendering and comparing (references/verify.md), or " +
      "{mode:\"static-only\", reason} if the project genuinely has no way to render"];
  }
  if (f.mode === "rendered") {
    // An agent may write artifacts/deltas as OBJECTS ({screenshot: "…"}, {high: 33, …}) — say the shape is wrong, not "empty"/"missing"
    const shape = (x: unknown): string => x === null ? "null" : Array.isArray(x) ? "an array" : typeof x === "object" ? "an object" : typeof x;
    // (both shape errors in one round: a plan can have both as objects, and this is only a warning)
    const wrongShape: string[] = [];
    if (f.artifacts !== undefined && !Array.isArray(f.artifacts))
      wrongShape.push(`${at}.artifacts must be an array of paths, got ${shape(f.artifacts)} — e.g. ["design/verify/<Layer>__<id>.png", "design/verify/<Layer>__<id>.report.json"]`);
    if (f.deltas !== undefined && !Array.isArray(f.deltas))
      wrongShape.push(`${at}.deltas must be an array of the residual differences, got ${shape(f.deltas)} — the counts live in the report; list each difference ([] if none were found)`);
    if (wrongShape.length) return f.deltas === undefined ? [...wrongShape, `${at}.deltas is missing — list the residual differences against the reference ([] if none were found)`] : wrongShape;
    const artifacts = Array.isArray(f.artifacts) ? f.artifacts : [];
    if (!artifacts.length) return [`${at}.mode is "rendered" but \`artifacts\` is empty — list the screenshot(s)/report the render produced`];
    const missing = artifacts.filter((a) => !fs.existsSync(path.join(cwd, String(a))));
    if (missing.length) return [`${at} artifact(s) not found on disk: ${missing.join(", ")} — render the screen, or record mode "static-only" with the reason`];
    if (!Array.isArray(f.deltas)) return [`${at}.deltas is missing — list the residual differences against the reference ([] if none were found)`];
    return [];
  }
  if (f.mode === "static-only") {
    if (f.reason) return [];
    return [at === "verification.recorded"
      ? "verification.recorded.mode is \"static-only\" with no `reason` — the measured file gave none: put what was checked for and not found (dev server, Playwright, simulator…) in the measured file's `reason`, then re-run --compare --record-plan"
      : "verification.mode is \"static-only\" with no `reason` — say what was checked for and not found (dev server, Playwright, simulator…)"];
  }
  return [`${at}.mode must be "rendered" or "static-only", got ${JSON.stringify(f.mode)}`];
}

// Missing evidence worth having.
function missingEvidence(plan: Plan, f: VerificationFacts): string[] {
  const v = plan.verification;
  if (!v || f.mode !== "rendered") return [];
  const out: string[] = [];
  const c = v.coverage;
  if (!c || !Array.isArray(c.rendered) || !c.rendered.length)
    out.push("verification.coverage is missing — record {rendered:[…], notChecked:[{what, why}]} so the report can say which states/themes/sizes were never rendered " +
      "(references/verify.md, \"Beyond the ideal frame\")");
  if (!f.a11y) out.push(f.at === "verification.recorded"
    ? "verification.recorded has no a11y — the recorded report's behaviour/a11y checks did not run; re-run the probe with them and --compare --record-plan, or say in the report that accessibility was not checked"
    : "verification.a11y is missing — copy report.behaviour.summary into it ({tool, violations: summary.fail, warnings: summary.warn, report: the report.json it came from}) — " +
      "`verify-screen --compare --record-plan` writes it; when no behaviour checks ran, no accessibility check is recorded — say so in the report rather than implying one ran");
  return out;
}

// plan.verification.recorded is what `--compare --record-plan` wrote from ONE report (its sha256 names that report's
// text). When the report file has since been rewritten (another --compare without --record-plan, a hand edit), the
// record is older than the verdict it summarises: the report is the verdict either way; plan-status.ts reads the record's
// mode/reason for a plan with no report (static-only), and blocks on a hand edit of it (plan-record.ts recordedEdits).
// A record naming a report that is not on disk at all (renamed or deleted) cannot be compared with it, so a hand edit of
// the record would go unseen: a warning of its own. And a record naming a report that IS on disk but is not one located
// for this plan (another screen's) speaks for nothing the status reads: the own report is chosen without it.
function recordWarnings(plan: Plan, located: readonly ReportRef[], cwd: string): string[] {
  const r = recordedReport(plan, cwd);
  if (r.kind === "missing") {
    return [`plan.verification.recorded names ${r.report}, which is not on disk (renamed or deleted) — the record cannot be checked against its report: run verify-screen --migrate for a ` +
      "legacy-named verify set, else re-run verify-screen --compare --record-plan"];
  }
  const out: string[] = [];
  if (r.kind === "rewritten") out.push(`plan.verification records an older run of ${r.report} — re-run ${scriptCmd("verify-screen")} --compare --record-plan (the report is the verdict)`);
  if ((r.kind === "names" || r.kind === "rewritten") && !located.some((x) => x.rel === r.report))
    out.push(`plan.verification.recorded names ${r.report}, which is not a verify report found for this plan in design/verify/ (${located.length ? `found: ${located.map((x) => x.rel).join(", ")}` : "none found"}) — ` +
      `the status and the a11y check read the reports found; re-run ${scriptCmd("verify-screen")} --compare --record-plan for this plan's screen`);
  return out;
}

// Beside a recorded block (the record), the record's own keys at verification's top level — and a hand-written
// headline/verdict — are read by nothing: say so, once. The tool keys only beside a recorded@2, and only the ones it
// holds (one it lacks is read from the top level — verificationFacts; beside a recorded@1 they are all still the
// record's); the hand verdicts beside either.
const HAND_VERDICT_KEYS = ["headline", "verdict", "verifyScreenVerdict"] as const;
function recordedShadowWarnings(plan: Plan): string[] {
  const v = plan.verification;
  const rec: unknown = v && typeof v === "object" ? v.recorded : undefined;
  if (!v || !isJsonObject(rec)) return [];
  const v2 = isRecordV2Shaped(rec);
  if (v2 && !isVerificationRecord(rec)) return []; // (an edited record blocks; its message comes first)
  const top = Object.keys(v);
  const keys = [...(v2 ? TOOL_KEYS.filter((k) => top.includes(k) && rec[k] !== undefined) : []), ...HAND_VERDICT_KEYS.filter((k) => top.includes(k))];
  return keys.length ? [`verification.${keys.join(", verification.")} ${keys.length > 1 ? "are" : "is"} ignored — verification.recorded is the record (${scriptCmd("verify-screen")} --compare --record-plan writes it); ` +
    "remove " + (keys.length > 1 ? "them" : "it") + " from the top level: a residual goes in deviations[] (with the why), anything else in notes"] : [];
}

// The block contradicting itself in adjacent keys (a11y and deltas as the facts read them), and against the reports.
// A hand verdict is checked against the reports only in a plan with no `recorded`: beside one it is ignored
// (recordedShadowWarnings).
const A11Y = /\b(a11y|axe|accessib)/i;
function contradictions(plan: Plan, f: VerificationFacts, located: readonly ReportRef[], recorded: string | null): string[] {
  const v = plan.verification;
  if (!v || typeof v !== "object") return [];
  const out: string[] = [];
  const notChecked = (v.coverage && Array.isArray(v.coverage.notChecked)) ? v.coverage.notChecked : [];
  const what = (e: string | { what?: string; why?: string } | null | undefined): string => String(e && typeof e === "object" ? e.what || "" : e || "");
  const rendered = (v.coverage && Array.isArray(v.coverage.rendered)) ? v.coverage.rendered.map((x) => String(x).trim().toLowerCase()) : [];
  if (f.a11y && typeof f.a11y === "object" && f.a11y.violations !== undefined) {
    const nc = notChecked.find((e) => A11Y.test(what(e)));
    if (nc) out.push(`verification contradicts itself: \`${f.a11yAt === "verification" ? "" : "recorded."}a11y\` records ${JSON.stringify(f.a11y.violations)} violation(s) from ${JSON.stringify(f.a11y.tool || "an a11y scan")}, while \`coverage.notChecked\` says ` +
      `"${what(nc)}" was not checked${typeof nc === "object" && nc.why ? ` (${nc.why})` : ""} — keep the one that is true`);
  }
  for (const e of notChecked) if (rendered.includes(what(e).trim().toLowerCase())) out.push(`verification contradicts itself: "${what(e)}" is listed both in coverage.rendered and in coverage.notChecked`);
  const rec: unknown = v.recorded;
  for (const r of located) {
    // --record-plan writes only the OPEN high/medium deltas — [] beside the report it recorded (however the record spells
    // its name) is that record, not a gap
    const recordedHere = r.rel === recorded;
    if (!recordedHere && Array.isArray(f.deltas) && !f.deltas.length && Array.isArray(r.deltas) && r.deltas.length)
      out.push(`${f.at}.deltas is [] but ${r.rel} lists ${r.deltas.length} delta(s) — ` + (f.at === "verification.recorded"
        ? `the record is of another report; if ${r.rel} is this build's, record it (${scriptCmd("verify-screen")} --compare --record-plan)`
        : "copy them (or the ones you judged real, with why) into the plan"));
    if (rec !== undefined) continue;
    for (const k of ["verifyScreenVerdict", "verdict"] as const) {
      const claimed = v[k];
      const s = claimed && typeof claimed === "object" ? claimed.verdict : claimed;
      if (typeof s === "string" && /pass/i.test(s) && !isPassingVerdict(r.verdict))
        out.push(`verification.${k} says ${JSON.stringify(s)} but ${r.rel} says verdict ${JSON.stringify(r.verdict)} — the report is the verdict; the plan cannot overrule it`);
      // accepted deviations are not a plain pass: the plan must not summarise them away
      else if (typeof s === "string" && /^\s*pass\s*$/i.test(s) && r.verdict === "pass-with-deviations")
        out.push(`verification.${k} says "pass" but ${r.rel} says "pass-with-deviations" — say the accepted deviations, not a plain pass`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- behaviour/a11y

// The report the plan's a11y number was copied from: verification.a11y.report when set (report.json or its .md), else the
// own report. The name is read as written: project-relative, absolute, relative to the plan file, or a bare file name —
// the last two fall back to the basename when exactly one located report has it; several with that basename → the
// own-report rule among them. "Not found" only when nothing matches, so a real disagreement is never hidden behind a
// path spelling.
function a11yReportOf(named: string | undefined, located: readonly ReportRef[], own: ReportRef | null, recorded: string | null, ctx: EvidenceContext): { ref: ReportRef | null; missing?: string } {
  if (named === undefined || !named.trim()) return { ref: own };
  const want = slash(named.trim());
  const rels = new Set<string>([asJson(want.replace(/^\.\//, "")), recordedRel(named, ctx.cwd) ?? ""]);
  if (ctx.planFile !== undefined) rels.add(asJson(slash(path.relative(ctx.cwd, path.resolve(path.dirname(path.resolve(ctx.cwd, ctx.planFile)), named.trim())))));
  const exact = located.find((r) => rels.has(r.rel));
  if (exact) return { ref: exact };
  const base = asJson(path.posix.basename(want));
  const byBase = located.filter((r) => path.posix.basename(r.rel) === base);
  if (byBase.length) return { ref: byBase.length === 1 ? byBase[0] ?? null : ownAmong(byBase, recorded) };
  return { ref: null, missing: want };
}
// What the reports' behaviour/a11y section says — (a) a failed check; (b) the plan's a11y number disagreeing with the
// report it came from; (c) the checks did not run. ONE report speaks for the run (a11yReportOf); its fail count is of
// failed elements ("+N more" rows count N), so it says "failures". A re-run of a set overwrites its report, so a run's
// older rounds are gone. Every OTHER located report file (design/verify/ is flat, so another file is another set — a
// variant <Layer>__<id>.<slug> (a narrow width, a dark theme), or a legacy-named one) warns on its own failures: one
// warning per other report file, so no FAIL is silenced; the disagreement and "did not run" warnings stay with the one.
function behaviourWarnings(f: VerificationFacts, located: readonly ReportRef[], own: ReportRef | null, recorded: string | null, ctx: EvidenceContext): string[] {
  const out: string[] = [];
  const a11y = f.a11y;
  const copied = a11y && typeof a11y === "object" ? a11y.violations : undefined;
  const target = a11yReportOf(a11y && typeof a11y === "object" && typeof a11y.report === "string" ? a11y.report : undefined, located, own, recorded, ctx);
  if (copied !== undefined && target.missing !== undefined && located.some((r) => r.behaviour && r.behaviour.ran))
    out.push(`${f.a11yAt}.a11y.report names ${target.missing}, which is not a verify report found for this plan in design/verify/ — the a11y count was not checked against it`);
  const r = target.ref ?? own;
  const n = (k: number, one: string, many: string): string => `${k} ${k === 1 ? one : many}`;
  const failWarning = (ref: ReportRef, fail: number, failed: string[]): string => {
    const ids = [...new Set(failed)];
    return `${ref.rel}: behaviour/a11y — ${n(fail, "failure", "failures")} (${ids.slice(0, 6).join(", ")}${ids.length > 6 ? `, +${ids.length - 6} more` : ""}) — not the fidelity verdict, but a measurable ` +
      `accessibility failure is never waived: fix it or raise a designer question`;
  };
  const otherFails = located.filter((x) => x !== r).flatMap((x) => (x.behaviour && x.behaviour.ran && x.behaviour.fail > 0 ? [failWarning(x, x.behaviour.fail, x.behaviour.failed)] : []));
  const b = r ? r.behaviour : null;
  if (!r || !b) return [...out, ...otherFails];
  if (!b.ran) {
    // a measured file the shipped probe did not write (hand-written, non-web — the probe is web only) never has a
    // block: no warning every Stop. "--behaviour off" is the probe's own switch, so it always warns.
    if (b.why !== "--behaviour off" && !r.shippedProbe) return out;
    out.push(b.why === "--behaviour off"
      ? `${r.rel}: behaviour/a11y checks were not run (--behaviour off) — a switch for the probe's own tests only; re-run the probe without it before claiming accessibility`
      : `${r.rel}: behaviour/a11y checks did not run (${b.why || "no reason recorded"}) — re-run the shipped probe, or say in the report that accessibility was not checked`);
    return [...out, ...otherFails];
  }
  if (b.fail > 0) out.push(failWarning(r, b.fail, b.failed));
  if (copied !== undefined && target.missing === undefined && copied !== b.fail)
    out.push(`${f.a11yAt}.a11y records ${JSON.stringify(copied)} ${copied === 1 ? "violation" : "violations"} but ${r.rel} behaviour has ${n(b.fail, "failure", "failures")} — ` +
      (f.a11yAt === "verification.recorded" ? "re-run --compare --record-plan against that report" : "copy report.behaviour.summary"));
  return [...out, ...otherFails];
}
