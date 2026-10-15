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
// record (recorded@1, no schema) and hand-written plans keep them — are the record's now, so they are removed (one note):
// the first record of such a plan migrates it. verify-build reads the record first and those keys only without one
// (verificationFacts, below). The file keeps its indentation, key order and line endings (updatePlan, below — the
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
import { RECORD_KEYS, isVerificationRecord, parsePlan } from "./doc-guards.ts";
import { legacyPlanHash, planHash } from "./content-hash.ts";
import { PLAN_VERIFICATION_RECORD_SCHEMA, isJsonObject } from "./types.ts";
import { planLockFile, planLockRefused } from "./run-cache.ts";
import type {
  JsonValue, Plan, PlanA11yRecord, PlanRecordCounts, PlanRecordedDelta, PlanVerification, PlanVerificationRecord, VerifyReport, VerifyReportV2,
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
/** A plan's bytes (a UTF-8 BOM allowed) → the plan; throws naming `file` when it is not JSON or not a plan. */
function parsePlanText(raw: string, file: string): Plan {
  const parsed: unknown = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  const pp = parsePlan(parsed);
  if (!("plan" in pp)) throw new Error(`${file} ${pp.error}`);
  return pp.plan;
}

// The record's keys that the first record (and a hand-written plan) kept at verification's top level
const TOOL_KEYS = ["mode", "reason", "renderer", "artifacts", "deltas", "a11y"] as const;

/** What a report says, as the record holds it. --record-plan writes these, and verify-build compares a record with
 *  the report its sha256 names through this same function. */
function recordFacts(report: Omit<VerifyReport, "artifacts">): Pick<PlanVerificationRecord, "verdict" | "headline" | "behaviourHeadline" | "counts"> {
  const s = report.summary;
  const deltas = report.deltas ?? [];
  const b = report.behaviour;
  const notMeasured = report.coverage && typeof report.coverage.nodesNotMeasured === "number" ? report.coverage.nodesNotMeasured : (report.notMeasured ?? []).length;
  const counts: PlanRecordCounts = { high: s ? s.high : 0, medium: s ? s.medium : 0, low: s ? s.low : 0,
    accepted: (s && s.accepted) ?? deltas.filter((d) => d.accepted).length, notMeasured, inferred: (s && s.inferred) ?? (report.inferred ? report.inferred.length : 0) };
  return { verdict: report.verdict ?? "", headline: report.headline ?? "", ...(b && b.headline ? { behaviourHeadline: b.headline } : {}), counts };
}

/** mode … a11y as every reader takes them: from a recorded@2 block (`at` "verification.recorded"; `record` is that
 *  block when it is the tool's shape), else — a hand-written or native plan, a recorded@1 one — from verification's
 *  top level (`at` "verification"). Beside a recorded@2 the top-level keys are never read. */
export interface VerificationFacts {
  at: "verification.recorded" | "verification";
  record: PlanVerificationRecord | null;
  mode: PlanVerification["mode"]; reason: string | undefined; renderer: string | undefined;
  artifacts: PlanVerification["artifacts"]; deltas: PlanVerification["deltas"]; a11y: PlanA11yRecord | undefined;
}
function verificationFacts(v: PlanVerification | null | undefined): VerificationFacts {
  const rec: unknown = v && typeof v === "object" ? v.recorded : undefined;
  if (isJsonObject(rec) && rec.schema !== undefined) {
    const str = (x: JsonValue | undefined): string | undefined => (typeof x === "string" ? x : undefined);
    const num = (x: JsonValue | undefined): number | undefined => (typeof x === "number" ? x : undefined);
    const a = rec.a11y;
    const a11y: PlanA11yRecord | undefined = isJsonObject(a)
      ? { ...ifDefined("tool", str(a.tool)), ...ifDefined("violations", num(a.violations)), ...ifDefined("warnings", num(a.warnings)), ...ifDefined("report", str(a.report)) } : undefined;
    return { at: "verification.recorded", record: isVerificationRecord(rec) ? rec : null, mode: str(rec.mode), reason: str(rec.reason), renderer: str(rec.renderer),
      artifacts: rec.artifacts, deltas: rec.deltas, a11y };
  }
  const top: PlanVerification = v && typeof v === "object" ? v : {};
  return { at: "verification", record: null, mode: top.mode, reason: top.reason, renderer: top.renderer, artifacts: top.artifacts, deltas: top.deltas, a11y: top.a11y };
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

    let reportSha256: string;
    try { reportSha256 = sha256Hex(fs.readFileSync(path.resolve(cwd, reportAt))); }
    catch {
      // not on disk (a caller recording before writing): the bytes --compare writes for this object
      reportSha256 = sha256Hex(JSON.stringify(report, null, 2) + "\n");
      notes.push(`${reportAt} is not on disk — recorded the sha256 of the report as --compare writes it`);
    }
    const deltas: PlanRecordedDelta[] = report.deltas.filter((d) => !d.accepted && (d.severity === "high" || d.severity === "medium"))
      .map((d) => ({ nodeId: d.nodeId, field: d.field, severity: d.severity === "high" ? "high" : "medium", expected: d.expected, actual: d.actual }));
    const b = report.behaviour;
    const facts = recordFacts(report);
    // A static-only measured file is recorded as such — no render happened, so no renderer is claimed
    const staticOnly = report.mode === "static-only";
    const recorded: PlanVerificationRecord = {
      schema: PLAN_VERIFICATION_RECORD_SCHEMA, by: "verify-screen --record-plan", at: opts.now ?? new Date().toISOString(), report: reportAt, reportSha256,
      verdict: facts.verdict, headline: facts.headline, ...ifDefined("behaviourHeadline", facts.behaviourHeadline), counts: facts.counts,
      mode: staticOnly ? "static-only" : "rendered",
      ...(staticOnly ? ifDefined("reason", report.reason || undefined) : ifDefined("renderer", (typeof report.renderer === "string" && report.renderer) || undefined)),
      artifacts, deltas,
      ...(b.ran ? { a11y: { tool: b.axe && "version" in b.axe ? `axe-core ${b.axe.version}` : "verify-probe behaviour checks", violations: b.summary.fail, warnings: b.summary.warn, report: reportAt } } : {}),
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
    // The record's keys at the top level (a recorded@1 plan, a hand-written one) are the record's now: moved into it
    const moved = TOOL_KEYS.filter((k) => v[k] !== undefined);
    for (const k of moved) delete v[k];
    if (moved.length) notes.push(`verification.${moved.join(", verification.")}: the record's ${moved.length > 1 ? "keys are" : "key is"} kept in verification.recorded now (written from this report) — the top-level ${moved.length > 1 ? "copies are" : "copy is"} removed; coverage and notes stay yours, and a residual goes in deviations[] (with the why)`);
    v.recorded = recorded;
    plan.verification = v;
    return plan;
  });
  return { written, notes };
}

export { formatPlan, parsePlanText, recordFacts, recordPlan, updatePlan, verificationFacts };
