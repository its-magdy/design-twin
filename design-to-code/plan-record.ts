// plan-record.ts — F-100 (D115): `verify-screen --compare --record-plan` writes the tool-owned keys of
// plan.verification from the report it just wrote, so no agent copies a report into the plan by hand.
//
// Tool-owned (replaced every run): mode "rendered", renderer, artifacts (the report .json/.md and the report's own
// artifacts that exist on disk), deltas (the OPEN high + medium deltas, compact — lows and accepted ones are only
// counted), a11y (report.behaviour.summary, when the behaviour checks ran) and `recorded` {by, at, report,
// reportSha256, verdict, headline, behaviourHeadline, counts}. Everything else in verification (coverage, notes, the
// hook record) and in the plan is left exactly as it was — never deviations[] (a deviation needs a person's why),
// waivers[], descopes[] or status. The file keeps its indentation, key order and line endings; it is written
// (atomically: verify-run.ts writeFileAtomic) only when its bytes change, and a re-record of the same report keeps the
// old `recorded.at`. verify-build's planHash leaves `verification` out, so recording never reopens a plan — and a hook
// record still holding the pre-F-100 formula (which DID cover verification) is re-stamped with the current one in the
// same write (M1), only when it matched the plan as it was: what the hook checked is exactly what the new hash covers.
// Paths are written project-relative only (L7): a report outside the project is refused (throws — the plan could not
// name it), an artifact outside it is left out with a note.
// Known miss: a read-modify-write — a Stop hook writing the same plan between the read and the rename is lost.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { writeFileAtomic } from "./verify-run.ts";
import { parsePlan } from "./doc-guards.ts";
import { legacyPlanHash, planHash } from "./content-hash.ts";
import type { JsonObject, PlanVerification, PlanVerificationRecord, VerifyReportV2 } from "./types.ts";

export interface RecordPlanResult { written: boolean; notes: string[] }

const slash = (p: string): string => p.split(path.sep).join("/").split("\\").join("/");
// The file's own indentation: the first indented line's leading whitespace (2 spaces when the file has none).
const indentOf = (text: string): string => /\n([ \t]+)\S/.exec(text)?.[1] ?? "  ";

// `planFile` and `reportRel` are relative to `opts.cwd` (the project root, default process.cwd()) or absolute;
// `report` is the object --compare wrote to `reportRel`. `opts.now` fixes `recorded.at` (tests). Throws when the plan
// cannot be read or is not a plan (the caller chose it before comparing, so that is not expected).
function recordPlan(planFile: string, report: VerifyReportV2, reportRel: string, opts: { now?: string; cwd?: string } = {}): RecordPlanResult {
  const cwd = opts.cwd ?? process.cwd();
  const abs = path.resolve(cwd, planFile);
  const notes: string[] = [];
  const raw = fs.readFileSync(abs, "utf8");
  const bom = raw.charCodeAt(0) === 0xfeff ? "\ufeff" : "";
  const text = raw.slice(bom.length);
  const parsed: unknown = JSON.parse(text);
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
  v.mode = "rendered";
  if (typeof report.renderer === "string" && report.renderer) v.renderer = report.renderer;
  v.artifacts = artifacts;
  v.deltas = compact;
  if (b.ran) {
    const tool = b.axe && "version" in b.axe ? `axe-core ${b.axe.version}` : "verify-probe behaviour checks";
    v.a11y = { tool, violations: b.summary.fail, warnings: b.summary.warn, report: reportAt };
  } else if (v.a11y !== undefined) notes.push(`behaviour/a11y checks did not run (${b.why || "no reason recorded"}) — verification.a11y left as it was`);
  v.recorded = recorded;
  plan.verification = v;

  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const tail = /\n$/.test(text) ? eol : "";
  const out = bom + JSON.stringify(plan, null, indentOf(text)).split("\n").join(eol) + tail;
  if (out === raw) return { written: false, notes };
  writeFileAtomic(abs, out);
  return { written: true, notes };
}

export { recordPlan };
