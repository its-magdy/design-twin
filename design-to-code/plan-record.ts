// plan-record.ts — `verify-screen --compare --record-plan` writes plan.verification.recorded from the report it
// just wrote, so no agent copies a report into the plan by hand.
//
// `recorded` is the ONE tool-owned block (types.ts PlanVerificationRecord, schema plan-verification-record@2), replaced
// whole every run: {schema, by, at, report, reportSha256, verdict, headline, behaviourHeadline?, counts, mode, reason?,
// renderer?, artifacts, deltas, a11y?} — mode "rendered" + renderer, or, for a static-only measured file, "static-only" +
// the report's reason and no renderer; artifacts = the report .json/.md and the report's own artifacts that exist on
// disk; deltas = the OPEN high + medium deltas, compact (lows and accepted ones are only counted); a11y =
// report.behaviour.summary, when the behaviour checks ran. A key in it that the tool does not write is dropped with a
// note. The rest of verification (coverage, notes, a hand headline) is the agent's and is left as it was, and so is the
// rest of the plan — never deviations[] (a deviation needs a person's why; a residual goes there), waivers[], descopes[]
// or status. One exception: mode/reason/renderer/artifacts/deltas/a11y at verification's top level — where the first
// record (recorded@1, no schema) and hand-written plans keep them — are moved into the record when it holds them (one
// note): the first record of such a plan migrates it. One the record lacks (a hand a11y when the behaviour checks did
// not run, a hand reason the measured file did not give) stays, and is read from there; a renderer beside a static-only
// record or a reason beside a rendered one no longer holds and is removed. verify-build reads each key from the record
// first (verificationFacts, below). The file keeps its indentation, key order and line endings (updatePlan, below — the
// one plan writer, also used by --accept, plan-skeleton --out and the verify-build hook); it is written only when its bytes
// change, and a re-record of the same report keeps the old `recorded.at`. verify-build's planHash leaves `verification` out, so recording never reopens a plan — and a hook
// record still holding the older formula (which DID cover verification) is re-stamped with the current one in the
// same write, only when it matched the plan as it was: what the hook checked is exactly what the new hash covers.
// Paths are written project-relative only: a report outside the project is refused (throws — the plan could not
// name it), an artifact outside it is left out with a note.
// Every tool write of a plan is a locked read-modify-write (updatePlan, below): two tool writers never lose each
// other's keys. An agent's Edit/Write takes no lock: one that lands between the plan's last re-read and the rename is
// lost (the re-read catches every earlier one and starts the update over from its bytes).
import fs from "node:fs";
import path from "node:path";
import { sha256Hex } from "../bridge/src/hash.ts";
import { formatJsonLike, updateJsonLike } from "../bridge/src/json-file.ts";
import { ifDefined } from "../bridge/src/json-util.ts";
import type { UpdateJsonOpts } from "../bridge/src/json-file.ts";
import { RECORD_KEYS, isRecordV2Shaped, isVerificationRecord, isVerifyReport, parsePlan } from "./doc-guards.ts";
import { legacyPlanHash, planHash } from "./content-hash.ts";
import { PLAN_VERIFICATION_RECORD_SCHEMA, isJsonObject } from "./types.ts";
import { planLockFile, planLockRefused } from "./run-cache.ts";
import type {
  JsonObject, JsonValue, Plan, PlanA11yRecord, PlanRecordCounts, PlanRecordedDelta, PlanVerification, PlanVerificationRecord, VerifyReport, VerifyReportV2,
} from "./types.ts";

export interface RecordPlanResult { written: boolean; notes: string[] }

const slash = (p: string): string => p.split(path.sep).join("/").split("\\").join("/");
// The one plan writer — --record-plan, --accept, plan-skeleton --out and the verify-build hook: under the plan's lock
// (run-cache.ts planLockFile: in the run cache, never beside the plan where it could be committed), `fn` turns the
// plan's bytes as they are on disk (null: no plan yet) into the plan to write; atomic and in the plan file's own format
// (BOM, indentation, line endings), written only when its bytes change. True when written. `fn` may run more than
// once (the plan changed under it), so it computes from its argument only.
const formatPlan = formatJsonLike;
// A run cache that refuses the lock (a sandboxed command whose write scope does not reach a hoisted workspace's
// node_modules) is said in the status writes' sentence — where it is and where to run from.
const updatePlan = (file: string, fn: (raw: string | null) => unknown, opts: UpdateJsonOpts = {}): boolean =>
  updateJsonLike(file, fn, { lockFile: planLockFile(file), lockRefused: (e) => planLockRefused(file, e), ...opts });
/** The text `verify-screen --compare` writes for a report (verify-screen.ts write): the bytes a record's reportSha256 names. */
const reportFileText = (report: unknown): string => JSON.stringify(report, null, 2) + "\n";
/** A plan's bytes (a UTF-8 BOM allowed) → the plan; throws naming `file` when it is not JSON or not a plan. */
function parsePlanText(raw: string, file: string): Plan {
  const parsed: unknown = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  const pp = parsePlan(parsed);
  if (!("plan" in pp)) throw new Error(`${file} ${pp.error}`);
  return pp.plan;
}

// The record's keys that the first record (and a hand-written plan) kept at verification's top level
const TOOL_KEYS = ["mode", "reason", "renderer", "artifacts", "deltas", "a11y"] as const;
type ToolKey = typeof TOOL_KEYS[number];

/** What a record says that its report alone decides: every key but schema/by/at/report/reportSha256 and artifacts
 *  (those depend on the disk). */
export type RecordFacts = Pick<PlanVerificationRecord, "verdict" | "headline" | "behaviourHeadline" | "counts" | "mode" | "reason" | "renderer" | "deltas" | "a11y">;
/** What a report says, as the record holds it (`reportAt`: the report's project-relative path, which a11y names).
 *  --record-plan writes exactly these, and verify-build compares a record with the report its sha256 names through this
 *  same function. Every value is the kind doc-guards.ts recordProblems accepts, whatever the report — or the measured
 *  file behind it — holds: a value of the wrong kind is left out (reason, renderer, behaviourHeadline, a delta row) or
 *  read as 0 / "", never written as it is, so a fresh record never blocks.
 *  Changing a formula here changes what every existing @2 record should hold, and verify-build would block each one
 *  recorded before the change: bump PLAN_VERIFICATION_RECORD_SCHEMA with it, and read the older schema the older way. */
function recordFacts(report: Omit<VerifyReport, "artifacts"> & { mode?: unknown; reason?: unknown }, reportAt: string): RecordFacts {
  const count = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  const text = (x: unknown): string | undefined => (typeof x === "string" && x ? x : undefined);
  const s = report.summary;
  const all = Array.isArray(report.deltas) ? report.deltas : [];
  const b = report.behaviour;
  const notMeasured = report.coverage && typeof report.coverage.nodesNotMeasured === "number" ? report.coverage.nodesNotMeasured : Array.isArray(report.notMeasured) ? report.notMeasured.length : 0;
  const counts: PlanRecordCounts = { high: count(s && s.high), medium: count(s && s.medium), low: count(s && s.low),
    accepted: s && typeof s.accepted === "number" ? count(s.accepted) : all.filter((d) => d.accepted).length, notMeasured: count(notMeasured),
    inferred: s && typeof s.inferred === "number" ? count(s.inferred) : Array.isArray(report.inferred) ? report.inferred.length : 0 };
  // the OPEN high + medium deltas, compact (lows and accepted ones are only counted)
  const deltas: PlanRecordedDelta[] = [];
  for (const d of all) {
    if (d.accepted || typeof d.nodeId !== "string" || typeof d.field !== "string") continue;
    const severity = d.severity === "high" ? "high" : d.severity === "medium" ? "medium" : null;
    if (severity) deltas.push({ nodeId: d.nodeId, field: d.field, severity, ...ifDefined("expected", d.expected), ...ifDefined("actual", d.actual) });
  }
  // A static-only measured file is recorded as such — no render happened, so no renderer is claimed
  const staticOnly = report.mode === "static-only";
  const ran = !!b && b.ran === true;
  const tool = b && b.axe && "version" in b.axe && typeof b.axe.version === "string" ? `axe-core ${b.axe.version}` : "verify-probe behaviour checks";
  return {
    verdict: typeof report.verdict === "string" ? report.verdict : "", headline: typeof report.headline === "string" ? report.headline : "",
    ...ifDefined("behaviourHeadline", text(b && b.headline)), counts, mode: staticOnly ? "static-only" : "rendered",
    ...(staticOnly ? ifDefined("reason", text(report.reason)) : ifDefined("renderer", text(report.renderer))), deltas,
    ...(ran && b ? { a11y: { tool, violations: count(b.summary && b.summary.fail), warnings: count(b.summary && b.summary.warn), report: reportAt } } : {}),
  };
}

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
function verificationFacts(v: PlanVerification | null | undefined): VerificationFacts {
  const top: PlanVerification = v && typeof v === "object" ? v : {};
  const rec: unknown = top.recorded;
  if (!isJsonObject(rec) || !isRecordV2Shaped(rec)) {
    return { at: "verification", a11yAt: "verification", record: null, mode: top.mode, reason: top.reason, renderer: top.renderer, artifacts: top.artifacts, deltas: top.deltas, a11y: top.a11y };
  }
  const r: JsonObject = rec;
  const has = (k: ToolKey): boolean => r[k] !== undefined;
  const str = (x: JsonValue | undefined): string | undefined => (typeof x === "string" ? x : undefined);
  const num = (x: JsonValue | undefined): number | undefined => (typeof x === "number" ? x : undefined);
  const a = r.a11y;
  const a11y: PlanA11yRecord | undefined = isJsonObject(a)
    ? { ...ifDefined("tool", str(a.tool)), ...ifDefined("violations", num(a.violations)), ...ifDefined("warnings", num(a.warnings)), ...ifDefined("report", str(a.report)) } : undefined;
  return { at: "verification.recorded", a11yAt: has("a11y") ? "verification.recorded" : "verification", record: isVerificationRecord(r) ? r : null,
    mode: has("mode") ? str(r.mode) : top.mode, reason: has("reason") ? str(r.reason) : top.reason, renderer: has("renderer") ? str(r.renderer) : top.renderer,
    artifacts: has("artifacts") ? r.artifacts : top.artifacts, deltas: has("deltas") ? r.deltas : top.deltas, a11y: has("a11y") ? a11y : top.a11y };
}

// `planFile` and `reportRel` are relative to `opts.cwd` (the project root, default process.cwd()) or absolute;
// `report` is the object --compare wrote to `reportRel`. `opts.now` fixes `recorded.at` (tests). Throws when the plan
// cannot be read or is not a plan (the caller chose it before comparing, so that is not expected).
function recordPlan(planFile: string, report: VerifyReportV2, reportRel: string, opts: { now?: string; cwd?: string } = {}): RecordPlanResult {
  const cwd = opts.cwd ?? process.cwd();
  const abs = path.resolve(cwd, planFile);
  let notes: string[] = [];
  // under the plan's lock, from the bytes on disk at that moment (updateJsonLike): a tool writer between the
  // report and this record is kept; the record is computed again when the plan changes under it
  const written = updatePlan(abs, (raw) => {
    notes = [];
    if (raw === null) throw new Error(`${planFile} does not exist`);
    const plan = parsePlanText(raw, planFile);
    // project-relative, normalised, `/`-separated — or null when the path leaves the project (another drive, `..`)
    const inside = (r: string): boolean => !(r === ".." || r.startsWith("../") || path.isAbsolute(r) || /^[A-Za-z]:/.test(r));
    const realOf = (p: string): string => { try { return fs.realpathSync(p); } catch { return p; } };
    // Lexically inside, else inside by REAL paths (an absolute path through a symlink, macOS /tmp → /private/tmp)
    const rel = (p: string): string | null => {
      const lex = slash(path.relative(cwd, path.resolve(cwd, p)));
      if (inside(lex)) return lex;
      const real = slash(path.relative(realOf(cwd), realOf(path.resolve(cwd, p))));
      return inside(real) ? real : null;
    };
    const reportAt = rel(reportRel);
    if (reportAt === null) throw new Error(`the report ${slash(reportRel)} is outside the project (${slash(cwd)}) — the plan records project-relative paths only; write the report inside the project (--out design/verify/<Screen>)`);
    const exists = (p: string): boolean => { try { return fs.statSync(path.resolve(cwd, p)).isFile(); } catch { return false; } };

    // artifacts: the report itself (+ its .md), then the report's artifacts that exist on disk (relative to the project)
    const artifacts: string[] = [];
    const outside: string[] = [];
    const addArtifact = (p: string | undefined): void => {
      if (!p || !exists(p)) return;
      const r = rel(p);
      if (r === null) { if (!outside.includes(slash(p))) outside.push(slash(p)); } else if (!artifacts.includes(r)) artifacts.push(r);
    };
    addArtifact(reportAt);
    addArtifact(reportAt.replace(/\.report\.json$/, ".report.md"));
    for (const a of report.artifacts) {
      if (typeof a === "string") addArtifact(a);
      else if (a && typeof a.path === "string" && !("exists" in a && a.exists === false)) addArtifact(a.path);
    }
    if (outside.length) notes.push(`${outside.length} artifact(s) outside the project not recorded in verification.recorded.artifacts (project-relative paths only): ${outside.join(", ")}`);

    // The sha256 and the facts come from ONE text: the report as this run writes it (reportFileText), never the file's
    // bytes now — another --compare may have rewritten the file since, and its sha beside this report's facts would
    // read as a hand edit (verify-build recordedEdits). The facts are read back from that text, as verify-build reads
    // them from the file. A file that no longer holds this text reads as an older run there (a warning).
    const text = reportFileText(report);
    const reportSha256 = sha256Hex(text);
    let onDisk: Buffer | null = null;
    try { onDisk = fs.readFileSync(path.resolve(cwd, reportAt)); } catch { /* not on disk: said below */ }
    if (onDisk === null) notes.push(`${reportAt} is not on disk — recorded the sha256 of the report as --compare writes it`);
    else if (sha256Hex(onDisk) !== reportSha256) notes.push(`${reportAt} on disk is not the report this run wrote (another --compare rewrote it?) — recorded this run's report; verify-build warns that the plan records an older run until --compare --record-plan runs again`);
    const b = report.behaviour;
    const asWritten: unknown = JSON.parse(text);
    const facts = recordFacts(isVerifyReport(asWritten) ? asWritten : report, reportAt);
    const recorded: PlanVerificationRecord = {
      schema: PLAN_VERIFICATION_RECORD_SCHEMA, by: "verify-screen --record-plan", at: opts.now ?? new Date().toISOString(), report: reportAt, reportSha256,
      verdict: facts.verdict, headline: facts.headline, ...ifDefined("behaviourHeadline", facts.behaviourHeadline), counts: facts.counts,
      mode: facts.mode, ...ifDefined("reason", facts.reason), ...ifDefined("renderer", facts.renderer), artifacts, deltas: facts.deltas, ...ifDefined("a11y", facts.a11y),
    };

    const v: PlanVerification = plan.verification ?? {}; // (parsePlan refuses a non-object verification)
    // A hook record under the older formula matches only while verification is unchanged — re-stamp it (computed on
    // the plan BEFORE this record touches verification) so this write does not send the plan back to pending
    const hook = v.hook;
    if (hook && typeof hook.planHash === "string" && hook.planHash !== planHash(plan) && hook.planHash === legacyPlanHash(plan)) {
      hook.planHash = planHash(plan);
      notes.push("the hook's record held an older plan hash that also covered verification — re-stamped with the current one, so this record does not reopen the plan");
    }
    const prev: unknown = v.recorded;
    const before = verificationFacts(v);
    // the same report recorded again: keep its time, so an unchanged plan is not rewritten
    if (isJsonObject(prev) && typeof prev.at === "string" && JSON.stringify({ ...prev, at: "" }) === JSON.stringify({ ...recorded, at: "" })) recorded.at = prev.at;
    // The block is the tool's, replaced whole: a key it does not write was added by hand — dropped, never silently
    const foreign = isJsonObject(prev) ? Object.keys(prev).filter((k) => !RECORD_KEYS.includes(k)) : [];
    if (foreign.length) notes.push(`verification.recorded held ${foreign.map((k) => `\`${k}\``).join(", ")}, which --record-plan does not write — dropped (the block is the tool's): put a residual in deviations[] (with the why), anything else in notes`);
    if (!b.ran && before.a11y !== undefined) notes.push(`behaviour/a11y checks did not run (${b.why || "no reason recorded"}) — this record has no a11y`);
    // The record's keys at the top level (a recorded@1 plan, a hand-written one): one the record now holds is moved into
    // it; a renderer beside a static-only record, or a reason beside a rendered one, no longer holds and is removed; one
    // the record lacks (a hand a11y when the behaviour checks did not run, a hand reason the measured file did not give)
    // stays — the readers fall back to it (verificationFacts)
    const present = TOOL_KEYS.filter((k) => v[k] !== undefined);
    const moved = present.filter((k) => recorded[k] !== undefined);
    const stale = present.filter((k) => recorded[k] === undefined && k === (recorded.mode === "static-only" ? "renderer" : "reason"));
    const kept = present.filter((k) => !moved.includes(k) && !stale.includes(k));
    for (const k of [...moved, ...stale]) delete v[k];
    const list = (ks: readonly ToolKey[]): string => ks.map((k) => `verification.${k}`).join(", ");
    if (moved.length || stale.length) notes.push([
      ...(moved.length ? [`${list(moved)}: the record's ${moved.length > 1 ? "keys are" : "key is"} kept in verification.recorded now (written from this report) — the top-level ${moved.length > 1 ? "copies are" : "copy is"} removed`] : []),
      ...(stale.length ? [`${list(stale)} removed: ${recorded.mode === "static-only" ? "this report is static-only, so no renderer is claimed" : "this report was rendered, so the \"why no render\" no longer holds"}`] : []),
      ...(kept.length ? [`${list(kept)} ${kept.length > 1 ? "stay" : "stays"} at the top level: this report gives none, so ${kept.length > 1 ? "they are" : "it is"} still read from there`] : []),
    ].join("; ") + "; coverage and notes stay yours, and a residual goes in deviations[] (with the why)");
    v.recorded = recorded;
    plan.verification = v;
    return plan;
  });
  return { written, notes };
}

export { formatPlan, parsePlanText, recordFacts, recordPlan, reportFileText, updatePlan, verificationFacts };
