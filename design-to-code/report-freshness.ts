// report-freshness.ts — what a verify report was computed against, and whether that still holds. ONE module both stamps
// (verify-screen --compare records it in report.inputs) and judges (plan-status.ts, a plan's status; verify-compare's SAME BUILD
// SERVED note): a report is fresh, or stale with typed reasons, each worded once (staleText). It also binds a measured
// file to its expectation and run (verify-compare's integrity reasons, verify-run's --phase measured/done refusals —
// measuredText) and reads a plan's verification.recorded against the report it names (recordedReport).
//
// Freshness is decided by CONTENT, never by a clock: the export's content hash (timestamps stripped — a no-change re-pull
// rewrites only exportedAt), the expectation file's sha256, each code file's content hash (never an mtime, which a `touch`
// or a fresh clone flips) and the hash of the plan's waivers[]/descopes[]. git HEAD is recorded and shown, never a reason:
// a commit does not say whether the tree was dirty. The git calls go through `Git` (injected; systemGit runs git).
//
// The consequence of a reason is each caller's: plan-status reads a stale report as `unverified`, verify-compare grades
// an unbound measured file `incomplete`, verify-run refuses to record it.
import fs from "node:fs";
import path from "node:path";
import { sha256Hex } from "../bridge/src/hash.ts";
import { exportContentSha256, fileHashes, planCodeFiles } from "./content-hash.ts";
import { isVerifyReport } from "./doc-guards.ts";
import { waiversHash } from "./plan-waivers.ts";
import { runSync } from "./proc.ts";
import { readRegularFile } from "./read-json.ts";
import { isJsonObject } from "./types.ts";
import type { CodeInputs, Plan, VerifyReport } from "./types.ts";
import { scriptCmd } from "./cli-args.ts";

// ---------------------------------------------------------------- the git seam

/** The git facts a report records. Informational: neither is ever a stale reason. */
export interface Git {
  /** `git rev-parse HEAD` in `cwd`, or null (not a work tree, no git, anything else) */
  head(cwd: string): string | null;
  /** whether the work tree has changes outside design/ (the verifier's own files), or null when unknown */
  dirty(cwd: string): boolean | null;
}
const OBJECT_ID_LINE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})\s*$/;
/** The real git, through proc.ts runSync. */
export const systemGit: Git = {
  head(cwd) {
    try {
      // exit 0 must come with an object id — 40 hex digits (SHA-1), or 64 in a SHA-256 repository (`git init
      // --object-format=sha256`): an empty capture (Bun #46142) is re-run once, then reads as "no head"
      const r = runSync("git", ["rev-parse", "HEAD"], { cwd, timeoutMs: 2000, expect: OBJECT_ID_LINE });
      const h = r.status === 0 && r.stdout.trim();
      return h && OBJECT_ID_LINE.test(h) ? h : null;
    } catch { return null; }
  },
  dirty(cwd) {
    try {
      // porcelain v2 --branch always prints its `# branch.oid` header, so an empty capture (Bun #46142: exit 0, no stdout)
      // is never read as "clean": it is re-run once, then unknown (null). A change is any non-header line.
      const r = runSync("git", ["status", "--porcelain=v2", "--branch", "--", ".", ":(exclude)design"], { cwd, timeoutMs: 5000, expect: /^# branch\.oid /m });
      return r.status === 0 && !r.lost ? r.stdout.split("\n").some((l) => l !== "" && !l.startsWith("#")) : null;
    } catch { return null; }
  },
};

// ---------------------------------------------------------------- what a report was computed against

/** What a report says it was computed against — the one reader of report.inputs for freshness (null: not recorded). */
export interface ReportInputs { exportContentSha256: string | null; expectationSha256: string | null; code: CodeInputs | null; waiversSha256: string | null }
const str = (x: unknown): string | null => (typeof x === "string" && x ? x : null);
export function reportInputs(report: { inputs?: unknown }): ReportInputs {
  const i = isJsonObject(report.inputs) ? report.inputs : {};
  const code = isJsonObject(i.code) && isJsonObject(i.code.files) ? i.code : null;
  const files: Record<string, string | null> = {};
  if (code && isJsonObject(code.files)) for (const [k, v] of Object.entries(code.files)) files[k] = typeof v === "string" ? v : null;
  return {
    exportContentSha256: str(i.exportContentSha256),
    expectationSha256: str(i.expectationSha256),
    code: code ? { ...(typeof code.plan === "string" ? { plan: code.plan } : {}), files, ...(code.gitHead === null || typeof code.gitHead === "string" ? { gitHead: code.gitHead } : {}) } : null,
    waiversSha256: isJsonObject(i.waivers) ? str(i.waivers.sha256) : null,
  };
}

/** Why a report no longer describes the design, expectation, code or waivers on disk. */
export type StaleReason =
  | { kind: "no-export-sha" }
  | { kind: "no-export" }
  | { kind: "export-changed"; was: string; now: string }
  | { kind: "expectation-changed"; expectation: string }
  | { kind: "no-code" }
  | { kind: "code-changed"; files: string[] }
  | { kind: "waivers-changed" };

export const WAIVERS_CHANGED = "waivers changed since the last compare — re-run --compare (with --plan <plan.json> when several plans describe the frame)";
/** The one wording of a stale reason for report `rel`. */
export function staleText(rel: string, r: StaleReason): string {
  switch (r.kind) {
    case "no-export-sha": return `${rel} does not record the content hash of the export it measured (inputs.exportContentSha256) — re-run ${scriptCmd("verify-screen")} --expect and --compare`;
    case "no-export": return `cannot find this plan's screen export to compare with ${rel}'s inputs.exportContentSha256 — give the plan its \`file\` header`;
    case "export-changed": return `the design changed since ${rel} was computed (export content sha256 ${r.was.slice(0, 12)}… → ${r.now.slice(0, 12)}…, timestamps ignored) — re-run --expect and --compare`;
    case "expectation-changed": return `${rel} was computed against a different ${r.expectation} than the one on disk (inputs.expectationSha256 no longer matches) — re-run --compare`;
    case "no-code": return `${rel} does not record which code it measured (inputs.code) — re-run ${scriptCmd("verify-screen")} --compare from the project root, where design/plan/ lists this screen's files`;
    case "code-changed": return `${rel} measured different code — changed since: ${r.files.slice(0, 6).join(", ")}${r.files.length > 6 ? `, +${r.files.length - 6} more` : ""} — re-run --compare`;
    case "waivers-changed": return `${rel}: ${WAIVERS_CHANGED} (the plan's waivers[]/descopes[] are not the ones the report applied)`;
  }
}

/** What a report records about the design and the run it was computed against (verify-compare writes it into
 *  report.inputs beside the code and waivers `stamp` gives): the expectation's sha256 and the export content hash it
 *  carries, the measured file's sha256 and the expectation it says it measured. Pure: the shas are the caller's. */
export function stampEvidence(o: { expectation: { exportContentSha256?: unknown }; expectationSha256?: string | undefined; measuredSha256?: string | undefined; measured: { expectationSha256?: unknown } }):
  { expectationSha256?: string; measuredSha256?: string; measuredAgainst?: string; exportContentSha256?: string } {
  const against = str(o.measured.expectationSha256), exportSha = str(o.expectation.exportContentSha256);
  return {
    ...(o.expectationSha256 ? { expectationSha256: o.expectationSha256 } : {}),
    ...(o.measuredSha256 ? { measuredSha256: o.measuredSha256 } : {}),
    ...(against !== null ? { measuredAgainst: against } : {}),
    // WHAT was measured, by content — the design, timestamps stripped
    ...(exportSha !== null ? { exportContentSha256: exportSha } : {}),
  };
}

// ---------------------------------------------------------------- a measured file's run

/** Why a measured file is not this expectation's and this run's. */
export type MeasuredReason =
  | { kind: "no-expectation" }
  | { kind: "other-expectation"; measured: string; current: string }
  | { kind: "other-run"; measuredRun: string; run: string }
  | { kind: "other-measured"; recorded: string; now: string };
/** The core of each measured reason — what --compare's integrity reasons and verify-run's refusals both say (each adds
 *  the file it is about and its own next step). */
export const MEASURED_PHRASES = {
  otherExpectation: "the measurements were taken against a DIFFERENT expectation",
  noExpectation: "measured file names no expectation (expectationSha256)",
  otherMeasured: "names a different measured file",
} as const;
const short = (sha: string): string => `${sha.slice(0, 12)}…`;
/** `subject`: what names the other measured file (default "its run"; --compare names the status file). */
export function measuredText(r: MeasuredReason, subject = "its run"): string {
  switch (r.kind) {
    case "no-expectation": return MEASURED_PHRASES.noExpectation;
    case "other-expectation": return `${MEASURED_PHRASES.otherExpectation} (${short(r.measured)} vs ${short(r.current)})`;
    case "other-run": return `the measured file was taken in run ${r.measuredRun}, not run ${r.run}`;
    case "other-measured": return `${subject} ${MEASURED_PHRASES.otherMeasured} (sha ${short(r.recorded)}, this one ${short(r.now)})`;
  }
}

// ---------------------------------------------------------------- a plan's record

/** A plan's verification.recorded against the report it names: none recorded; the report not on disk; there but not a
 *  regular file (a record naming a FIFO or a device must not hang the hook: never read); its bytes no longer the ones
 *  the record's reportSha256 names (rewritten since — an older record); the bytes it names but no verify report; or the
 *  report it names, parsed. */
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
  if (!isJsonObject(rec) || typeof rec.report !== "string" || !rec.report) return { kind: "none" };
  return reportNamed(rec.report, rec.reportSha256, cwd);
}
/** The report file `report` as a record's sha256 `sha` names it (recordedReport's reading of one record). */
export function reportNamed(report: string, sha: unknown, cwd: string): Exclude<RecordedReport, { kind: "none" }> {
  if (!fs.existsSync(path.resolve(cwd, report))) return { kind: "missing", report };
  const bytes = readRegularFile(path.resolve(cwd, report));
  if (!bytes) return { kind: "unreadable", report };
  if (typeof sha !== "string" || sha256Hex(bytes) !== sha) return { kind: "rewritten", report };
  let parsed: unknown = null;
  try { const x: unknown = JSON.parse(bytes.toString("utf8")); parsed = x; } catch { /* unparseable: no report */ }
  return isVerifyReport(parsed) ? { kind: "names", report, doc: parsed } : { kind: "not-a-report", report };
}

/** The report a record's reportSha256 still names, parsed — null when there is none to compare with (not on disk, not a
 *  regular file, its bytes rewritten since, or not a verify report): reportNamed's `names`. */
export function reportRecordNames(report: unknown, reportSha256: unknown, cwd: string): VerifyReport | null {
  if (typeof report !== "string" || !report) return null;
  const r = reportNamed(report, reportSha256, cwd);
  return r.kind === "names" ? r.doc : null;
}

// ---------------------------------------------------------------- the module

/** Bytes the caller already read this run (verify-build's project graph), else undefined: read from disk. */
export type CachedBytes = (rel: string) => Uint8Array | undefined;

export interface ReportFreshness {
  /** what --compare records about the plan it used: the code (each code file's content hash and git HEAD — none when the
   *  plan lists no files[]) and the plan's waivers/descopes hash */
  stamp(plan: { file: string; plan: Plan }): { code?: CodeInputs; waivers: { plan: string; sha256: string } };
  /** why report `rel` (project-relative; its expectation is `<set>.expected.json` beside it) no longer holds for this plan
   *  and export, in order — [] = fresh */
  judge(rel: string, inputs: ReportInputs, now: { plan: Plan; exportDoc: unknown }): StaleReason[];
  /** whether the plan's waivers/descopes are not the ones the report applied (a report that recorded none applied none) */
  waiversChanged(inputs: ReportInputs, plan: Plan): boolean;
}

export function reportFreshness(root: string, o: { git?: Git; cached?: CachedBytes } = {}): ReportFreshness {
  const git = o.git ?? systemGit;
  const NO_WAIVERS = waiversHash(null);
  const codeNow = (plan: Plan): Record<string, string | null> => fileHashes(planCodeFiles(plan, root), root, o.cached);
  const waiversChanged = (inputs: ReportInputs, plan: Plan): boolean => (inputs.waiversSha256 || NO_WAIVERS) !== waiversHash(plan);

  function expectationChanged(rel: string, inputs: ReportInputs): string | null {
    const want = inputs.expectationSha256;
    if (!want) return null;
    const expRel = rel.replace(/\.report\.json$/, ".expected.json");
    try { return sha256Hex(fs.readFileSync(path.resolve(root, expRel))) !== want ? expRel : null; } catch { return null; }
  }

  return {
    stamp(p) {
      return {
        ...(p.plan.files ? { code: { plan: p.file, files: codeNow(p.plan), gitHead: git.head(root) } } : {}),
        waivers: { plan: p.file, sha256: waiversHash(p.plan) },
      };
    },
    judge(rel, inputs, now) {
      const out: StaleReason[] = [];
      const exp = expectationChanged(rel, inputs);
      if (!inputs.exportContentSha256) {
        if (exp !== null) out.push({ kind: "expectation-changed", expectation: exp });
        out.push({ kind: "no-export-sha" });
        return out;
      }
      const nowSha = now.exportDoc ? exportContentSha256(now.exportDoc) : null;
      if (nowSha === null) return [{ kind: "no-export" }];
      if (inputs.exportContentSha256 !== nowSha) out.push({ kind: "export-changed", was: inputs.exportContentSha256, now: nowSha });
      if (exp !== null) out.push({ kind: "expectation-changed", expectation: exp });
      const measured = inputs.code ? inputs.code.files : null;
      if (!measured) out.push({ kind: "no-code" });
      else {
        const h = codeNow(now.plan);
        // a mapped module an older report never hashed reads "(not recorded)" — one re-compare records it
        const differ = Object.keys(h).filter((f) => measured[f] !== h[f]).map((f) => (measured[f] === undefined ? `${f} (not recorded)` : f));
        if (differ.length) out.push({ kind: "code-changed", files: differ });
      }
      if (waiversChanged(inputs, now.plan)) out.push({ kind: "waivers-changed" });
      return out;
    },
    waiversChanged,
  };
}

/** Whether the code changed between two compares (verify-compare's SAME BUILD SERVED note): the files BOTH hashed
 *  differ — a key the earlier one never recorded (a mapped module, a file just added to files[]) says nothing about it —
 *  and with none in common, the git commits. Either side unrecorded: unchanged. */
export function codeChanged(before: CodeInputs | null | undefined, after: CodeInputs | null | undefined): boolean {
  if (!before || !after) return false;
  const common = Object.keys(before.files).filter((f) => Object.hasOwn(after.files, f));
  if (common.length) return common.some((f) => before.files[f] !== after.files[f]);
  return !!(before.gitHead && after.gitHead && before.gitHead !== after.gitHead);
}

/** Why a measured file is not bound to the expectation on disk (its sha; null: none to bind to) and to `run` (the run it
 *  is recorded in, and the measured file that run recorded): it names no expectation or another, was taken in another
 *  run, or is not the file its run recorded. [] = bound. */
export function bindMeasured(o: { expectationSha256: string | null | undefined; measured: { expectationSha256?: unknown; runId?: unknown }; measuredSha256: string | null | undefined;
  run?: { runId: string; measuredSha256?: string | undefined } | null | undefined }): MeasuredReason[] {
  const out: MeasuredReason[] = [];
  const named = str(o.measured.expectationSha256);
  if (o.expectationSha256) {
    if (named === null) out.push({ kind: "no-expectation" });
    else if (named !== o.expectationSha256) out.push({ kind: "other-expectation", measured: named, current: o.expectationSha256 });
  }
  const measuredRun = str(o.measured.runId);
  const run = o.run;
  if (run && measuredRun !== null && measuredRun !== run.runId) out.push({ kind: "other-run", measuredRun, run: run.runId });
  if (run && run.measuredSha256 && o.measuredSha256 && run.measuredSha256 !== o.measuredSha256) out.push({ kind: "other-measured", recorded: run.measuredSha256, now: o.measuredSha256 });
  return out;
}
