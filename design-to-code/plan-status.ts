// plan-status.ts — a plan's status, COMPUTED and never stored, and whether the build-screen Stop hook still has work on
// it. ONE module both the hook (verify-build.ts: its fast path, its printed status, --status) and verify-screen --migrate
// (verify-migrate.ts: the status a rename must not change) ask.
//
// Three facts decide a status: the lifecycle a PERSON sets in `status` ("pending" — the default — "awaiting-user",
// "abandoned"; a "verified"/"static-only" an older hook stored is ignored); the hook's record (verification.hook, written
// by verify-build) against the plan and its code now — the planHash (content-hash.ts hookHashOf: the current formula or
// the older one) and each code file's content hash; and what the verify report(s) located for the plan say
// (verify-locate.ts locateReports, which asks node-artefacts.ts which sets are the node's), with whether a passing one
// still holds judged by report-freshness.ts. Precedence, first match wins: abandoned | awaiting-user → failed → pending →
// blocked → stale → what the report says. No clock decides a status: the Stop hook's 12 h scope (verify-build isStale) is
// the hook's own, never asked here.
import path from "node:path";
import { PLAN_DIR } from "../bridge/src/project-layout.ts";
import { scriptCmd } from "./cli-args.ts";
import { fileHashes, hookHashOf, planCodeFiles } from "./content-hash.ts";
import { recordedEdits, verificationFacts } from "./plan-record.ts";
import { isPassingVerdict } from "./plan-waivers.ts";
import { WAIVERS_CHANGED, reportFreshness, staleText } from "./report-freshness.ts";
import type { CachedBytes } from "./report-freshness.ts";
import { isJsonObject } from "./types.ts";
import type { Plan, PlanComputedStatus, PlanLifecycle } from "./types.ts";
import { locateExport, locateReports } from "./verify-locate.ts";
import type { ExportHit, LocateCache, ReportRef } from "./verify-locate.ts";

// ---------------------------------------------------------------- what a person sets

const LIFECYCLE = new Set<string>(["pending", "awaiting-user", "abandoned"]);
const COMPUTED_STORED = new Set<string>(["verified", "verified-with-deviations", "static-only"]);
const storedText = (doc: unknown): string | null => (isJsonObject(doc) && typeof doc.status === "string" ? doc.status : null);
const isLifecycle = (s: string): s is PlanLifecycle => LIFECYCLE.has(s);

/** The lifecycle a person set in `status` (case and spaces ignored); anything else — none, a computed value an older hook
 *  stored, not a string — is "pending". Reads a parsed plan and the raw JSON of one that cannot be parsed alike. */
export function lifecycleOf(doc: unknown): PlanLifecycle {
  const s = (storedText(doc) ?? "").trim().toLowerCase();
  return isLifecycle(s) ? s : "pending";
}
/** The computed status an older hook stored in `status` ("verified", "verified-with-deviations", "static-only"), as
 *  written — ignored by status(), deleted by the hook's next record — or null. */
export function storedComputed(doc: unknown): string | null {
  const s = storedText(doc);
  return s !== null && COMPUTED_STORED.has(s.trim().toLowerCase()) ? s : null;
}

/** The project a plan belongs to: <root>/design/plan/<x>.json → <root>; any other file → `fallback` (else the cwd). */
export function rootOfPlan(file: string, fallback?: string): string {
  const dir = path.dirname(path.resolve(file));
  if (dir.endsWith(path.sep + PLAN_DIR)) return path.dirname(path.dirname(dir));
  return fallback || process.cwd();
}

// ---------------------------------------------------------------- the hook's record

/** The Stop hook's record against the plan and its code now:
 *  - unchecked: no record (or no result);
 *  - plan-changed: its planHash is not the plan's (under either formula) — the plan changed after the check;
 *  - blocked: its last check blocked, on `blocking`;
 *  - edited: it passed, and verification.recorded was edited by hand since (the planHash leaves verification out; the
 *    hook's next check blocks on it);
 *  - stale: it passed, and a code file it hashed changed, went, or was added to files[] (`changed`, each labelled);
 *  - passed: it passed and holds. `complete` is false when the record lacks its planHash or its code hashes: the hook
 *    re-checks such a plan (it is open), though nothing is known to have changed.
 *  `unhashed`: mapped modules the record never hashed (a record from before mapped modules were hashed) — a note, never
 *  a change; the hook's next record holds them. */
export type HookState =
  | { kind: "unchecked" }
  | { kind: "plan-changed" }
  | { kind: "blocked"; blocking: string[] }
  | { kind: "edited"; edits: string[]; unhashed: string[] }
  | { kind: "stale"; changed: string[]; unhashed: string[] }
  | { kind: "passed"; complete: boolean; unhashed: string[] };

/** status()'s options: the plan's file (to locate its export and reports, and the node its file name carries), or those
 *  pre-located. */
export interface StatusOptions { planFile?: string | undefined; export?: ExportHit | null | undefined; reports?: ReportRef[] | undefined }
export interface StatusResult { status: PlanComputedStatus; reasons: string[]; reports: ReportRef[] }

export interface PlanStatus {
  readonly root: string;
  /** the content hash of each code file of the plan (files[], then the mapped modules) — what the hook records */
  codeHashes(plan: Plan | null | undefined): Record<string, string | null>;
  /** the hook's record against the plan and its code now */
  hook(plan: Plan): HookState;
  /** whether the hook still has work on the plan: pending, and its record is missing, blocked, outdated or incomplete */
  open(plan: Plan): boolean;
  /** the verify reports the plan's status reads (verify-locate.ts locateReports) */
  reports(plan: Plan, planFile?: string, exp?: ExportHit | null): ReportRef[];
  /** the computed status, with why — never empty for a status that is not verified */
  status(plan: Plan, o?: StatusOptions): StatusResult;
}

const REPORT_SCHEMA_V2 = "designtwin/verify-report@2";
const listed = (xs: readonly string[]): string => `${xs.slice(0, 6).join(", ")}${xs.length > 6 ? `, +${xs.length - 6} more` : ""}`;

/** `cached`: bytes the caller already read this run (verify-build's project graph); absent, every file is read from disk.
 *  `locate`: the command's report/export-index reads, shared across its plans (verify-locate.ts LocateCache); absent,
 *  each lookup reads afresh. */
export function planStatus(root: string, o: { cached?: CachedBytes | undefined; locate?: LocateCache | undefined } = {}): PlanStatus {
  const codeHashes = (plan: Plan | null | undefined): Record<string, string | null> => fileHashes(planCodeFiles(plan || {}, root), root, o.cached);

  // The record's code hashes against the code now. A key the record never hashed is a change when it is a files[] entry;
  // a MAPPED module it never hashed is only noted — the upgrade must not reopen a plan the hook closed with no file changed.
  function codeDiff(plan: Plan, recorded: Record<string, string | null>): { changed: string[]; unhashed: string[] } {
    const now = codeHashes(plan);
    const files = new Set(Array.isArray(plan.files) ? plan.files.map(String) : []);
    const changed: string[] = [], unhashed: string[] = [];
    for (const f of new Set([...Object.keys(recorded), ...Object.keys(now)])) {
      if (recorded[f] === now[f]) continue;
      // gone from planCodeFiles — dropped from files[] or the anchors, or an extensionless mapModule no longer resolves
      if (now[f] === undefined) changed.push(`${f} (no longer hashed: not in files[] nor a mapped module that resolves)`);
      else if (recorded[f] === undefined) { if (files.has(f)) changed.push(`${f} (added to files[])`); else unhashed.push(`${f} (now hashed: mapped module)`); }
      else changed.push(now[f] === null ? `${f} (missing)` : f);
    }
    return { changed, unhashed };
  }

  function hook(plan: Plan): HookState {
    const h = plan.verification && plan.verification.hook;
    if (!h || !h.result) return { kind: "unchecked" };
    const matches = hookHashOf(h, plan) !== null;
    if (h.planHash && !matches) return { kind: "plan-changed" };
    if (h.result !== "pass") return { kind: "blocked", blocking: h.blocking && h.blocking.length ? h.blocking : ["the hook's last check blocked"] };
    const d = h.files ? codeDiff(plan, h.files) : { changed: [], unhashed: [] };
    const edits = recordedEdits(plan, root);
    if (edits.length) return { kind: "edited", edits, unhashed: d.unhashed };
    if (d.changed.length) return { kind: "stale", changed: d.changed, unhashed: d.unhashed };
    return { kind: "passed", complete: matches && !!h.files, unhashed: d.unhashed };
  }

  const open = (plan: Plan): boolean => {
    if (lifecycleOf(plan) !== "pending") return false;
    const h = hook(plan);
    return h.kind !== "passed" || !h.complete;
  };

  const reports = (plan: Plan, planFile?: string, exp?: ExportHit | null): ReportRef[] => locateReports(plan, planFile, root, exp, o.locate);

  // What the verify report(s) say about the plan, on their own: failed | unverified | static-only | verified |
  // verified-with-deviations, never with empty reasons. A stale passing report (report-freshness judge) reads as
  // unverified, with its first reason.
  function reportVerdict(plan: Plan, exp: ExportHit | null, found: ReportRef[]): { status: PlanComputedStatus; reasons: string[] } {
    const f = verificationFacts(plan.verification);
    if (!found.length) {
      if (f.mode === "static-only") return { status: "static-only", reasons: [`built and checked statically — not rendered (${f.reason || "no reason recorded"})`] };
      return { status: "unverified", reasons: [`no verify report found for this screen in design/verify/ — run ${scriptCmd("verify-screen")} --expect/--compare (the report's verdict is what grants "verified")`] };
    }
    // A report older than verify-report@2 counted hidden layers as "never built" / "failed" (0-for-83 wrong on the live
    // run). Its figures are not repeated as fact — only its verdict, labelled.
    const legacy = found.filter((r) => r.schema !== REPORT_SCHEMA_V2);
    if (legacy.length) return { status: "unverified", reasons: legacy.map((r) => `${r.rel} is ${r.schema || "an unversioned report"} (its verdict: ${JSON.stringify(r.verdict)}) — it predates ${REPORT_SCHEMA_V2}, ` +
      `whose counts exclude hidden layers, so its verdict and figures are not reliable. Regenerate it: ${scriptCmd("verify-screen")} --expect, then --compare`) };
    const said = (r: ReportRef): string => `${r.rel} says verdict ${JSON.stringify(r.verdict)}${r.headline ? ` (${r.headline})` : r.why.length ? `: ${r.why.join("; ")}` : ""}`;
    const fresh = reportFreshness(root, { ...(o.cached ? { cached: o.cached } : {}) });
    // a fail stays a fail until it is re-compared — but say when the owner has since accepted something
    const failing = found.filter((r) => r.verdict === "fail");
    if (failing.length) return { status: "failed", reasons: failing.map((r) => said(r) + (fresh.waiversChanged(r.inputs, plan) ? ` — ${WAIVERS_CHANGED}` : "")) };
    // "incomplete" (nothing failed, but not everything was measured/probed) or no verdict at all is not a pass — and not
    // a failure the build caused either
    const notPass = found.filter((r) => !isPassingVerdict(r.verdict));
    if (notPass.length) return { status: "unverified", reasons: notPass.map(said) };
    for (const r of found) {
      const stale = fresh.judge(r.rel, r.inputs, { plan, exportDoc: exp ? exp.doc : null })[0];
      if (stale !== undefined) return { status: "unverified", reasons: [staleText(r.rel, stale)] };
    }
    const head = found.map((r) => r.inputs.code && r.inputs.code.gitHead).find(Boolean);
    const withDeviations = found.filter((r) => r.verdict === "pass-with-deviations");
    const says = withDeviations.length ? `says pass (${withDeviations.map((r) => r.rel).join(", ")}: pass-with-deviations — accepted deltas / descoped interactions are listed in the report)` : "says pass";
    return { status: withDeviations.length ? "verified-with-deviations" : "verified",
      reasons: [`${found.map((r) => r.rel).join(", ")} ${says} and measured this design and exactly these files (by content)${head ? ` — at git ${head.slice(0, 12)}` : ""}`] };
  }

  function status(plan: Plan, so: StatusOptions = {}): StatusResult {
    const notes: string[] = [];
    const stored = storedComputed(plan);
    if (stored !== null) notes.push(`the stored "status": "${stored}" was not confirmed by the current hook and is ignored — status is computed, never stored`);
    const life = lifecycleOf(plan);
    if (life !== "pending") return { status: life, reasons: [life === "abandoned" ? "retired by hand (\"status\": \"abandoned\")" : "paused on a question for the user (\"status\": \"awaiting-user\")"], reports: [] };
    const exp = so.export === undefined ? locateExport(plan, so.planFile, root, o.locate) : so.export;
    const found = so.reports || reports(plan, so.planFile, exp);
    const rv = reportVerdict(plan, exp, found);
    const h = hook(plan);
    let hookState: PlanComputedStatus | null = null, hookWhy: string[] = [];
    switch (h.kind) {
      case "unchecked": hookState = "pending"; hookWhy = ["the build-screen Stop hook has not checked this plan"]; break;
      case "plan-changed": hookState = "pending"; hookWhy = ["the plan changed after the hook's last check"]; break;
      case "blocked": hookState = "blocked"; hookWhy = h.blocking; break;
      case "edited": hookState = "blocked"; hookWhy = h.edits; break;
      case "stale": hookState = "stale"; hookWhy = [`file(s) changed since the hook passed: ${listed(h.changed)}`]; break;
      case "passed": break;
    }
    const unhashed = "unhashed" in h ? h.unhashed : [];
    const unhashedWhy = unhashed.length ? [`hook: not hashed by the hook's last check (its record predates hashing of mapped modules), so not a change: ` +
      `${listed(unhashed)} — the hook's next check of this plan records it; until then an edit to it does not reopen the plan ` +
      `(\`verify-build <plan>\` re-checks now)`] : [];
    const reportWhy = rv.reasons.map((r) => (hookState ? "report: " : "") + r);
    if (rv.status === "failed") return { status: "failed", reasons: notes.concat(reportWhy, hookWhy.map((x) => "hook: " + x), unhashedWhy), reports: found };
    if (hookState) return { status: hookState, reasons: notes.concat(hookWhy, reportWhy, unhashedWhy), reports: found };
    return { status: rv.status, reasons: notes.concat(rv.status === "verified" || rv.status === "verified-with-deviations" ? ["hook passed; " + rv.reasons[0]] : rv.reasons, unhashedWhy), reports: found };
  }

  return { root, codeHashes, hook, open, reports, status };
}
