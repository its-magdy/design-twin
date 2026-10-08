// plan-record.ts — F-100 (D115): `verify-screen --compare --record-plan` writes the tool-owned keys of
// plan.verification from the report it just wrote, so no agent copies a report into the plan by hand.
//
// Tool-owned (replaced every run): mode "rendered" + renderer — or, for a static-only measured file (M2, s19),
// mode "static-only" + the report's reason and no renderer —, artifacts (the report .json/.md and the report's own
// artifacts that exist on disk), deltas (the OPEN high + medium deltas, compact — lows and accepted ones are only
// counted; rows it did not write are replaced with a note, M1 s19: a builder's residual belongs in deviations[]),
// a11y (report.behaviour.summary, when the behaviour checks ran) and `recorded` {by, at, report,
// reportSha256, verdict, headline, behaviourHeadline, counts}. Everything else in verification (coverage, notes, the
// hook record) and in the plan is left exactly as it was — never deviations[] (a deviation needs a person's why),
// waivers[], descopes[] or status. The file keeps its indentation, key order and line endings (writePlan, below — the
// one plan writer, also used by --accept and the verify-build hook, L5 s19); it is written only when its bytes
// change, and a re-record of the same report keeps the old `recorded.at`. verify-build's planHash leaves `verification` out, so recording never reopens a plan — and a hook
// record still holding the pre-F-100 formula (which DID cover verification) is re-stamped with the current one in the
// same write (M1), only when it matched the plan as it was: what the hook checked is exactly what the new hash covers.
// Paths are written project-relative only (L7): a report outside the project is refused (throws — the plan could not
// name it), an artifact outside it is left out with a note.
// Known miss: a read-modify-write — a Stop hook writing the same plan between the read and the rename is lost.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { formatJsonLike, writeJsonLike } from "../bridge/src/json-file.ts";
import { parsePlan } from "./doc-guards.ts";
import { legacyPlanHash, planHash } from "./content-hash.ts";
import { isJsonObject } from "./types.ts";
import type { JsonObject, JsonValue, PlanVerification, PlanVerificationRecord, VerifyReportV2 } from "./types.ts";

export interface RecordPlanResult { written: boolean; notes: string[] }

const slash = (p: string): string => p.split(path.sep).join("/").split("\\").join("/");
// The one plan writer — --record-plan, --accept, plan-skeleton --out and the verify-build hook: atomic and
// in the plan file's own format (BOM, indentation, line endings), written only when its bytes change. True when written.
const formatPlan = formatJsonLike, writePlan = writeJsonLike;

// M1 (s19): a verification.deltas row --record-plan writes — {nodeId, field, severity high|medium, expected, actual}
// and nothing else. Anything else there was written by hand (a residual, a copied report row).
const RECORDED_DELTA_KEYS = new Set(["nodeId", "field", "severity", "expected", "actual"]);
const isRecordedDelta = (d: JsonValue): boolean => isJsonObject(d) && typeof d.nodeId === "string" && typeof d.field === "string"
  && (d.severity === "high" || d.severity === "medium") && Object.keys(d).every((k) => RECORDED_DELTA_KEYS.has(k));

// `planFile` and `reportRel` are relative to `opts.cwd` (the project root, default process.cwd()) or absolute;
// `report` is the object --compare wrote to `reportRel`. `opts.now` fixes `recorded.at` (tests). Throws when the plan
// cannot be read or is not a plan (the caller chose it before comparing, so that is not expected).
function recordPlan(planFile: string, report: VerifyReportV2, reportRel: string, opts: { now?: string; cwd?: string } = {}): RecordPlanResult {
  const cwd = opts.cwd ?? process.cwd();
  const abs = path.resolve(cwd, planFile);
  const notes: string[] = [];
  const raw = fs.readFileSync(abs, "utf8");
  const parsed: unknown = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  const pp = parsePlan(parsed);
  if (!("plan" in pp)) throw new Error(`${planFile} ${pp.error}`);
  const plan = pp.plan;
  // project-relative, normalised, `/`-separated — or null when the path leaves the project (another drive, `..`)
  const inside = (r: string): boolean => !(r === ".." || r.startsWith("../") || path.isAbsolute(r) || /^[A-Za-z]:/.test(r));
  const realOf = (p: string): string => { try { return fs.realpathSync(p); } catch { return p; } };
  // D129: lexically inside, else inside by REAL paths (an absolute path through a symlink, macOS /tmp → /private/tmp)
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
  if (outside.length) notes.push(`${outside.length} artifact(s) outside the project not recorded in verification.artifacts (project-relative paths only): ${outside.join(", ")}`);

  const deltas = report.deltas;
  const compact: JsonObject[] = deltas.filter((d) => !d.accepted && (d.severity === "high" || d.severity === "medium"))
    .map((d) => ({ nodeId: d.nodeId, field: d.field, severity: d.severity, expected: d.expected, actual: d.actual }));
  const s = report.summary;
  const notMeasured = typeof report.coverage.nodesNotMeasured === "number" ? report.coverage.nodesNotMeasured : report.notMeasured.length;
  let reportSha256: string;
  try { reportSha256 = crypto.createHash("sha256").update(fs.readFileSync(path.resolve(cwd, reportAt))).digest("hex"); }
  catch {
    // not on disk (a caller recording before writing): the bytes --compare writes for this object
    reportSha256 = crypto.createHash("sha256").update(JSON.stringify(report, null, 2) + "\n").digest("hex");
    notes.push(`${reportAt} is not on disk — recorded the sha256 of the report as --compare writes it`);
  }
  const b = report.behaviour;
  const recorded: PlanVerificationRecord = {
    by: "verify-screen --record-plan", at: opts.now ?? new Date().toISOString(), report: reportAt, reportSha256,
    verdict: report.verdict, headline: report.headline,
    ...(b.headline ? { behaviourHeadline: b.headline } : {}),
    counts: { high: s.high, medium: s.medium, low: s.low, accepted: s.accepted ?? deltas.filter((d) => d.accepted).length,
      notMeasured, inferred: s.inferred ?? (report.inferred ? report.inferred.length : 0) },
  };

  const v: PlanVerification = plan.verification ?? {}; // (parsePlan refuses a non-object verification)
  // M1: a hook record under the pre-F-100 formula matches only while verification is unchanged — re-stamp it (computed on
  // the plan BEFORE this record touches verification) so this write does not send the plan back to pending
  const hook = v.hook;
  if (hook && typeof hook.planHash === "string" && hook.planHash !== planHash(plan) && hook.planHash === legacyPlanHash(plan)) {
    hook.planHash = planHash(plan);
    notes.push("the hook's record held the pre-F-100 plan hash (it covered verification) — re-stamped with the current one, so this record does not reopen the plan");
  }
  const prev = v.recorded;
  // the same report recorded again: keep its time, so an unchanged plan is not rewritten
  if (prev && typeof prev.at === "string" && JSON.stringify({ ...prev, at: "" }) === JSON.stringify({ ...recorded, at: "" })) recorded.at = prev.at;
  // M2 (s19): a static-only measured file is recorded as such — no render happened, so no renderer is claimed
  if (report.mode === "static-only") {
    v.mode = "static-only";
    if (report.reason) v.reason = report.reason;
    delete v.renderer;
  } else {
    if (v.mode === "static-only") delete v.reason; // rendered now: the "why no render" no longer holds
    v.mode = "rendered";
    if (typeof report.renderer === "string" && report.renderer) v.renderer = report.renderer;
  }
  v.artifacts = artifacts;
  // M1 (s19): D115 — this field is the report's; a row it did not write is replaced, never silently
  const hand = Array.isArray(v.deltas) ? v.deltas.filter((d) => !isRecordedDelta(d)) : [];
  if (hand.length) notes.push(`${hand.length} row(s) in verification.deltas were not written by --record-plan and are replaced by the report's open deltas (${hand.map((d) => isJsonObject(d) && typeof d.nodeId === "string" ? `${d.nodeId}${typeof d.field === "string" ? ` ${d.field}` : ""}` : JSON.stringify(d).slice(0, 40)).join(", ")}) — put builder-chosen residuals in deviations[] (with the why), never in verification.deltas`);
  // F1: a hand-written non-array (counts copied from a report, live) is replaced too — never silently
  else if (v.deltas !== undefined && !Array.isArray(v.deltas)) notes.push(`verification.deltas was a hand-written ${v.deltas === null ? "null" : typeof v.deltas} (${JSON.stringify(v.deltas).slice(0, 60)}), replaced by the report's open deltas (an array) — the counts are in verification.recorded.counts; put builder-chosen residuals in deviations[] (with the why)`);
  v.deltas = compact;
  // F2: hand-written headline / verdict keys are left alone, but one that disagrees with this record is stale — say so
  const handText = (x: unknown): string | null => typeof x === "string" ? x.trim() : isJsonObject(x) && typeof x.verdict === "string" ? x.verdict.trim() : null;
  const stale: string[] = [];
  const handHeadline = "headline" in v ? handText(v.headline) : null;
  if (handHeadline !== null && handHeadline !== recorded.headline.trim()) stale.push(`verification.headline ("${handHeadline.slice(0, 60)}")`);
  for (const k of ["verdict", "verifyScreenVerdict"] as const) {
    const t = handText(v[k]);
    if (t !== null && t.toLowerCase() !== recorded.verdict.toLowerCase()) stale.push(`verification.${k} ("${t.slice(0, 40)}")`);
  }
  if (stale.length) notes.push(`${stale.join(" and ")} — hand-written, and not what this report says (verdict "${recorded.verdict}"); stale beside verification.recorded, which is the record — update or remove ${stale.length > 1 ? "them" : "it"} by hand`);
  if (b.ran) {
    const tool = b.axe && "version" in b.axe ? `axe-core ${b.axe.version}` : "verify-probe behaviour checks";
    v.a11y = { tool, violations: b.summary.fail, warnings: b.summary.warn, report: reportAt };
  } else if (v.a11y !== undefined) notes.push(`behaviour/a11y checks did not run (${b.why || "no reason recorded"}) — verification.a11y left as it was`);
  v.recorded = recorded;
  plan.verification = v;

  return { written: writePlan(abs, plan, raw), notes };
}

export { formatPlan, recordPlan, writePlan };
