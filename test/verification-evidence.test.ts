// test/verification-evidence.test.ts — what a plan's verification block says and which verify report is the plan's own
// (design-to-code/verification-evidence.ts): the block's facts, the record's report in one spelling and on disk, the ONE
// own-report rule, and the warnings that read them (the record against the reports located for the plan). The
// behaviour/a11y warnings' full table is test/verify-build.test.ts's; the status that asks for the own report is
// test/plan-status.test.ts's.
// Run with:  bun test/verification-evidence.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sha256Hex } from "../bridge/src/hash.ts";
import { recordedRel, recordedReport, reportRecordNames, verificationEvidence, verificationFacts } from "../design-to-code/verification-evidence.ts";
import type { Plan, PlanVerificationRecord } from "../design-to-code/types.ts";
import type { ReportRef } from "../design-to-code/verify-locate.ts";
import { check, report } from "./assert.ts";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "dt-evidence-"));
const put = (rel: string, body: string): string => { const f = path.join(ROOT, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return rel; };
// A located report with only the fields a check reads set (the rest as locateReports writes them when absent).
const ref = (r: Partial<ReportRef> & { rel: string }): ReportRef => ({ matchedBy: "name", schema: "designtwin/verify-report@2", verdict: "pass", headline: null, why: [], deltas: null, measuredAt: null, mtimeMs: 0,
  inputs: { exportContentSha256: null, expectationSha256: null, code: null, waiversSha256: null }, behaviour: null, shippedProbe: false, ...r });
const REP = "design/verify/Plots__1_1.report.json";
const TEXT = JSON.stringify({ schema: "designtwin/verify-report@2", verdict: "pass" }, null, 2) + "\n";
put(REP, TEXT);
put("design/verify/Plots__1_1.report.md", "# the report, as markdown\n");
/** a recorded@2 block naming `report` with sha256 `sha` */
const rec = (report: string, sha = sha256Hex(TEXT), extra: Partial<PlanVerificationRecord> = {}): PlanVerificationRecord => ({
  schema: "designtwin/plan-verification-record@2", by: "verify-screen --record-plan", at: "2026-10-07T12:00:00.000Z", report, reportSha256: sha, verdict: "pass", headline: "PASS",
  counts: { high: 0, medium: 0, low: 0, accepted: 0, notMeasured: 0, inferred: 0 }, mode: "rendered", artifacts: [], deltas: [], ...extra });
const recorded = (report: string, sha?: string, extra?: Partial<PlanVerificationRecord>): Plan => ({ verification: { recorded: rec(report, sha, extra) } });
const ev = (plan: Plan, located: ReportRef[] = []) => verificationEvidence(plan, located, { cwd: ROOT });

// ---------------------------------------------------------------- the block's facts
console.log("facts — mode … a11y, the record first:");
{
  const top = verificationFacts({ mode: "static-only", reason: "no dev server", a11y: { violations: 2 } });
  check("[facts] no record: every key from the top level", top.at === "verification" && top.a11yAt === "verification" && top.mode === "static-only" && top.reason === "no dev server" && top.a11y?.violations === 2);
  const both = verificationFacts({ mode: "static-only", a11y: { violations: 2 }, recorded: rec(REP) });
  check("[facts] a recorded@2 speaks for the keys it holds; one it lacks (a11y) is read from the top level",
    both.at === "verification.recorded" && both.mode === "rendered" && both.a11yAt === "verification" && both.a11y?.violations === 2 && both.record !== null);
}

// ---------------------------------------------------------------- the record's report
console.log("the record's report — one spelling, read on disk:");
check("[spelling] project-relative, `./…`, absolute and the .md all read as the project-relative report .json",
  [REP, `./${REP}`, path.join(ROOT, REP), "design/verify/Plots__1_1.report.md", ` ${REP} `].every((s) => recordedRel(s, ROOT) === REP));
check("[spelling] no name: null", recordedRel(undefined, ROOT) === null && recordedRel("  ", ROOT) === null && recordedRel(7, ROOT) === null);
check("[record] no record: none", recordedReport({}, ROOT).kind === "none");
check("[record] the report it names, unchanged: names it, parsed", (() => { const r = recordedReport(recorded(REP), ROOT); return r.kind === "names" && r.doc.verdict === "pass"; })());
check("[record] the report rewritten since: rewritten", recordedReport(recorded(REP, "0".repeat(64)), ROOT).kind === "rewritten");
check("[record] the report gone: missing", recordedReport(recorded("design/verify/Gone.report.json"), ROOT).kind === "missing");
put("design/verify/Notjson.report.json", "not json");
check("[record] the bytes the sha names, but no verify report: not-a-report", recordedReport(recorded("design/verify/Notjson.report.json", sha256Hex("not json")), ROOT).kind === "not-a-report");
fs.mkdirSync(path.join(ROOT, "design/verify/Dir.report.json"));
check("[record] not a regular file (a directory, a FIFO): unreadable, never read", recordedReport(recorded("design/verify/Dir.report.json"), ROOT).kind === "unreadable");
// [behaviour change] a record spelling its report as the .md (or ./…, or absolute) is read as the report .json, the way
// every other reader matches it: before, the .md's bytes were hashed against the .json's sha — "an older run" — and the
// record's facts were never compared with its report
check("[record] named by its .md, `./…` or an absolute path: the report .json is read — names it, not rewritten",
  ["design/verify/Plots__1_1.report.md", `./${REP}`, path.join(ROOT, REP)].every((s) => { const r = recordedReport(recorded(s), ROOT); return r.kind === "names" && r.report === REP; })
  && reportRecordNames("design/verify/Plots__1_1.report.md", sha256Hex(TEXT), ROOT)?.verdict === "pass");

// ---------------------------------------------------------------- the own report
console.log("own — the ONE report that speaks for the plan:");
{
  const A = ref({ rel: "design/verify/A.report.json", measuredAt: "2026-10-01T00:00:00Z", mtimeMs: 9 });
  const B = ref({ rel: "design/verify/B.report.json", measuredAt: "2026-10-02T00:00:00Z", mtimeMs: 1 });
  const C = ref({ rel: "design/verify/C.report.json", measuredAt: "2026-09-01T00:00:00Z", mtimeMs: 0 });
  const V = ref({ rel: "design/verify/A.narrow.report.json", matchedBy: "nodeId", measuredAt: "2026-12-01T00:00:00Z", mtimeMs: 99 });
  const own = (plan: Plan, located: ReportRef[]): string => ev(plan, located).own?.rel ?? "none";
  check("[own] the report the record names, over a later measuredAt and a newer mtime", own(recorded(C.rel), [A, B, C]) === C.rel);
  check("[own] …however the record spells it (./…, absolute, the .md)",
    [`./${C.rel}`, path.join(ROOT, C.rel), "design/verify/C.report.md"].every((s) => own(recorded(s), [A, B, C]) === C.rel));
  check("[own] no record: the own screen's (matched by name) latest measuredAt — not a later variant matched by node id", own({}, [V, A, B]) === B.rel);
  check("[own] a record naming no located report: the same", own(recorded("design/verify/Gone.report.json"), [A, B, C]) === B.rel);
  check("[own] none matched by name: the latest among all", own({}, [V, ref({ rel: "design/verify/X.report.json", matchedBy: "layer name" })]) === V.rel);
  const D = ref({ rel: "design/verify/D.report.json", measuredAt: "2026-10-02T00:00:00Z", mtimeMs: 5 });
  check("[own] equal measuredAt: the newer mtime breaks the tie; no measuredAt is the oldest", own({}, [B, D]) === D.rel && own({}, [ref({ rel: "design/verify/N.report.json", mtimeMs: 99 }), C]) === C.rel);
  check("[own] nothing located: none", own(recorded(REP), []) === "none");
  const e = ev(recorded(`./${C.rel}`), [A, C]);
  check("[recorded] the record's report in one spelling, and the located report it is", e.recorded === C.rel && e.recordedRef === C && ev(recorded("design/verify/Gone.report.json"), [A]).recordedRef === null);
}

// ---------------------------------------------------------------- warnings that read the record and the located reports
console.log("shape warnings — the record against the reports:");
{
  const lowOnly = ref({ rel: REP, deltas: [{ nodeId: "1:2", field: "width", severity: "low", expected: 10, actual: 11 }] });
  const other = ref({ rel: "design/verify/Plots__1_1.narrow.report.json", matchedBy: "nodeId", deltas: [{ nodeId: "1:2", field: "width", severity: "medium", expected: 10, actual: 12 }] });
  const DELTAS = /deltas is \[\] but/;
  const deltasWarn = (plan: Plan, located: ReportRef[]): string[] => ev(plan, located).shapeWarnings().filter((w) => DELTAS.test(w));
  // [behaviour change] the record's report is matched by the one spelling: before, a record naming its report as
  // `./…`, an absolute path or the .md read as "another report", and its [] deltas as a gap
  check("[deltas] a record's [] beside the report it recorded (lows only) is that record — however the record spells the report",
    [REP, `./${REP}`, path.join(ROOT, REP), "design/verify/Plots__1_1.report.md"].every((s) => deltasWarn(recorded(s), [lowOnly]).length === 0));
  check("[deltas] …while another located report with deltas still warns, naming it", (() => {
    const w = deltasWarn(recorded(`./${REP}`), [lowOnly, other]);
    return w.length === 1 && (w[0] ?? "").startsWith(`verification.recorded.deltas is [] but ${other.rel} lists 1 delta(s) — the record is of another report`);
  })());
  check("[deltas] no record: a hand [] is checked against every located report", deltasWarn({ verification: { mode: "rendered", deltas: [] } }, [lowOnly, other]).length === 2);

  const NOT_LOCATED = /^plan\.verification\.recorded names (\S+), which is not a verify report found for this plan/;
  const notLocated = (plan: Plan, located: ReportRef[]): string[] => ev(plan, located).shapeWarnings().filter((w) => NOT_LOCATED.test(w));
  // [behaviour change, new warning] a record naming a report on disk that is not one located for the plan (another
  // screen's): the status reads the located reports and the own report is chosen without it — say so
  put("design/verify/Other__9_9.report.json", TEXT);
  const elsewhere = recorded("design/verify/Other__9_9.report.json");
  check("[located] a record naming a report on disk that is not located for the plan → ONE warning naming it and what was found",
    (() => { const w = notLocated(elsewhere, [lowOnly]); return w.length === 1 && (w[0] ?? "").includes(`(found: ${REP})`); })()
    && (notLocated(elsewhere, [])[0] ?? "").includes("(none found)"));
  check("[located] …not for a record naming a located report (any spelling), nor one not on disk (that has its own warning)",
    notLocated(recorded("design/verify/Plots__1_1.report.md"), [lowOnly]).length === 0 && notLocated(recorded("design/verify/Gone.report.json"), [lowOnly]).length === 0
    && ev(recorded("design/verify/Gone.report.json"), [lowOnly]).shapeWarnings().some((w) => /^plan\.verification\.recorded names design\/verify\/Gone\.report\.json, which is not on disk/.test(w)));
  check("[located] a rewritten report that is not located warns twice: an older run, and not this plan's",
    (() => { const w = ev(recorded("design/verify/Other__9_9.report.json", "0".repeat(64)), [lowOnly]).shapeWarnings(); return w.some((x) => /records an older run of design\/verify\/Other__9_9\.report\.json/.test(x)) && w.some((x) => NOT_LOCATED.test(x)); })());
}

fs.rmSync(ROOT, { recursive: true, force: true });
report();
