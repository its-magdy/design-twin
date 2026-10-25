// verify-build.ts — the Stop-hook gate for the build-screen skill, and the CLI that prints each plan's computed status
// (plan-status.ts computes it). Usage, what blocks and the status precedence are in --help (USAGE below).
//
// Registered in two places. build-screen/SKILL.md's frontmatter (Stop): active only for a session
// that actually invoked build-screen. claude-plugin/hooks/hooks.json (SubagentStop, matched to the
// screen-builder agent): Claude Code ignores `hooks` in a plugin-shipped agent's frontmatter, so the
// fan-out builder can only be gated from the plugin level.
//
// Only four things BLOCK (exit 2; for a Claude Code payload — it has hook_event_name — a JSON
// {decision: "block", reason} on stdout + exit 0, which survives PowerShell): an unexplained colour literal, a visible design node with no
// anchor, (web profiles) no `data-dt-node` tag at all, and a hand edit of the tool's own verification.recorded
// block (recordedEdits — --compare --record-plan repairs it). Everything else is a WARNING (exit 0): a
// gate that blocks on correct reuse teaches users to lie to it. The colour check is a source check,
// not a DOM check: only code is scanned (comments, prose strings and non-source files such as an
// exported SVG's baked-in stroke never reach a painted element as a literal), and the line that
// DEFINES a token is not a violation. The rendered comparison is verify-screen.ts's job.
//
// Status is COMPUTED, never stored. A stored status can say "verified" beside a report that says
// "fail", so the hook never writes `plan.status`; it writes `plan.verification.hook`
//   { result: "pass"|"blocked", checkedAt, blocking:[…], warnings:N, planHash, files:{<path>: <sha256/16>|null} }
// and plan-status.ts derives the status at read time from THREE facts that must all hold: hook
// result "pass"; every file in files[] (and every mapped module) still hashes the same; and the verify
// report (design/verify/<…>.report.json, schema @2) passes and is fresh (report-freshness.ts judge) — by
// content: its inputs.exportContentSha256 equals the export's (timestamps stripped), its expectation is the one on
// disk, its inputs.code.files equal the files' hashes now, and its inputs.waivers.sha256 equals the hash of the
// plan's waivers[]/descopes[] now (absent = none). No clock decides a status (STALE_HOURS below decides only which
// plans the Stop hook looks at). A stored "verified"/
// "static-only" (written by an older hook) is ignored and deleted the next time the hook checks that
// plan. `status` keeps only the states a PERSON sets: "pending" (default) · "awaiting-user" (paused on
// a question — skipped, never closed) · "abandoned" (retired — skipped). Every reader runs
// `verify-build.js --status` instead of trusting a field.
//
// Fast path: a plan is OPEN when its status is "pending" (or absent/legacy), it was touched within
// STALE_HOURS, and the hook has not already passed this exact plan + these exact files. No open plan
// → exit 0 at once. So an edit to a built file re-opens its plan, and a finished build stays quiet.
// A plan nobody has touched for STALE_HOURS is a leftover from an earlier session and is left alone
// (DTWIN_PLAN_STALE_HOURS overrides; 0 disables the cutoff).
//
// stdin: read ONLY when fd 0 is not a TTY; a pipe that delivers nothing within
// DTWIN_HOOK_STDIN_WAIT_MS (1 s) is treated as "no payload"; a payload with no EOF, or the whole run,
// is cut off at DTWIN_HOOK_TIMEOUT_MS (60 s) with a message naming what it was waiting on (exit 1 —
// a non-blocking error, because a stall of ours is not the agent's defect).
//
// Plan shape: see plan-skeleton.ts (which writes it) and build-screen/SKILL.md step 2.

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { errMsg } from "../bridge/src/errmsg.ts";
import { visibility } from "./visible-tree.ts";
import { screenRoots } from "./export-shape.ts";
import * as contentHash from "./content-hash.ts";
import { auditGateStatus } from "./audit-gate.ts";
import { isJsonObject, isPassingVerdict } from "./types.ts";
import { colorKey } from "./color.ts";
import { cliParse, scriptCmd } from "./cli-args.ts";
import { recordedReport } from "./report-freshness.ts";
import { isRecordV2Shaped, isVerificationRecord } from "./doc-guards.ts";
import { anyJson, readJsonOrNull } from "../bridge/src/read-json.ts";
import { isCodeConnectMap } from "./map-validate-core.ts";
import type {
  IrNodeType, Plan, PlanAnchor, PlanHookRecord, PlanLifecycle,
  PlanStoredStatus, PlanTokenRow, ScreenDoc,
} from "./types.ts";
import { getOrInit } from "./map-util.ts";
import { arbitraryPx, codeOf, colorLiterals, declaredCustomProps, kindsCompatible, literalUses, moduleImported, projectGraph } from "./code-scanner.ts";
import type { FileText, ProjectGraph } from "./code-scanner.ts";
import { requiredCustomProps } from "./token-naming.ts";
import { parsePlanText, recordedEdits, updatePlan, verificationFacts } from "./plan-record.ts";
import { lifecycleOf, planStatus, rootOfPlan, storedComputed } from "./plan-status.ts";
import type { StatusResult } from "./plan-status.ts";
import { locateCache, locateExport, locateReports, type LocateCache } from "./verify-locate.ts";
import { isPlanFile, nodeArtefacts, planNode, readPlan } from "./node-artefacts.ts";
import type { BadPlan, PlanFile } from "./node-artefacts.ts";
import type { ExportHit, ReportRef } from "./verify-locate.ts";
import { exitFlushed, runCli } from "./proc.ts";
import { LEGACY_MAP_FILE, MAP_FILE, PLAN_DIR, TARGET_FILE } from "../bridge/src/project-layout.ts";
import { parseSetName, setBaseOf, siblingFile } from "./verify-sets.ts";
import { readHookInput as readHookPayload } from "./hook-input.ts";
import { dropHeredocBodies, simpleCommands } from "./shell-words.ts";
import type { HookPayload, HookRead } from "./hook-input.ts";

// ================================================================ input / timeouts

const HOOK_TIMEOUT_MS = (): number => Number(process.env.DTWIN_HOOK_TIMEOUT_MS) || 60000;
const STDIN_WAIT_MS = (): number => { const n = Number(process.env.DTWIN_HOOK_STDIN_WAIT_MS); return Number.isFinite(n) && n >= 0 && process.env.DTWIN_HOOK_STDIN_WAIT_MS !== "" ? n : 1000; };

let phase = "starting";
const setPhase = (p: string): void => { phase = p; };


// The Stop-hook JSON (hook-input.ts: read only when stdin is not a terminal, never stalled by a pipe
// that never closes). The hard deadline sits a little inside the process watchdog, so its (more
// specific) message is the one printed.
function readHookInput(): Promise<HookRead> {
  return readHookPayload({
    waitMs: STDIN_WAIT_MS(),
    hardMs: Math.max(50, HOOK_TIMEOUT_MS() - 250),
    stalled: (bytes) => `timed out after ${Math.round(HOOK_TIMEOUT_MS() / 1000)} s waiting for the hook payload on stdin (${bytes} byte(s) received, no end-of-file) — pass the plan path as an argument instead, or ` +
      `pipe the payload: echo '{"cwd":"…"}' | ${scriptCmd("verify-build")}`,
  });
}

// ================================================================ plans on disk

const STALE_HOURS = 12;

function staleCutoffMs(): number {
  const raw = process.env.DTWIN_PLAN_STALE_HOURS;
  const h = raw === undefined || raw === "" ? STALE_HOURS : Number(raw);
  return Number.isFinite(h) && h > 0 ? h * 3600 * 1000 : 0;
}

// DELIBERATE clock: this decides the Stop hook's SCOPE (a plan untouched for STALE_HOURS is a leftover from another
// session, so its hook does not block this one), never a plan's status or a report's freshness — plan-status.ts and
// `--status` ignore it, and the hook puts a plan's mtime back after writing it so its own write does not reset this.
function isStale(file: string, now: number = Date.now()): boolean {
  const cutoff = staleCutoffMs();
  if (!cutoff) return false;
  try { return now - fs.statSync(file).mtimeMs > cutoff; } catch { return false; }
}

// Every plan under design/plan/, and — separately — the ones that could not be read: those are reported,
// never silently skipped (a hand-broken plan would otherwise vanish from the hook's view, so it would never be checked).
function findPlans(cwd: string): { plans: PlanFile[]; bad: BadPlan[] } {
  return nodeArtefacts(cwd, { planDir: path.join(cwd, PLAN_DIR) }).plans();
}

// OPEN = the hook still has work on this plan (plan-status.ts open) and it is in the hook's scope: touched within
// STALE_HOURS. A hand edit of the tool's verification.recorded after a pass reopens it (it is a block, and the fast path
// must not skip it).
function isOpen(p: PlanFile, cwd: string): boolean {
  return !isStale(p.file) && planStatus(cwd).open(p.plan);
}

// ================================================================ the export behind a plan

// Every JSON read below (an export, its index, a verify report/expectation, a component map) is checked
// against its doc-guards.ts guard; a lookup that finds only a broken file behaves as if it found nothing.

// ================================================================ anchors (block 2)

const anchored = (a: PlanAnchor | undefined): boolean => !!a && typeof a === "object" && (["mapModule", "file", "symbol", "omitted"] as const).some((k) => { const v = a[k]; return typeof v === "string" && !!v.trim(); });

interface NodeRef { id: string; name: string; type: IrNodeType }
/** anchorCoverage()'s result. */
export interface AnchorCoverage { visible: number; unmapped: NodeRef[]; unmappedNodes: number; wrappers: NodeRef[]; hiddenAnchored: string[]; unknown: string[] }

function anchorCoverage(plan: Plan, doc: ScreenDoc): AnchorCoverage {
  const { visible, hidden } = visibility(screenRoots(doc));
  const anchors: Record<string, PlanAnchor> = plan.anchors || {};
  const covered = new Map<string, boolean>();
  const isCovered = (id: string): boolean => {
    const known = covered.get(id);
    if (known !== undefined) return known;
    const v = visible.get(id);
    const r = anchored(anchors[id]) || (!!v && !!v.parentId && visible.has(v.parentId) && isCovered(v.parentId));
    covered.set(id, r);
    return r;
  };
  // which uncovered nodes have an anchored node somewhere below them (pure wrappers — a warning)
  const hasAnchoredBelow = new Set<string>();
  for (const [id, v] of visible) {
    if (!anchored(anchors[id])) continue;
    let p = v.parentId;
    while (p && !hasAnchoredBelow.has(p)) {
      const pv = visible.get(p);
      if (!pv) break;
      hasAnchoredBelow.add(p); p = pv.parentId;
    }
  }
  const unmapped: NodeRef[] = [], wrappers: NodeRef[] = [];
  for (const [id, v] of visible) {
    if (isCovered(id)) continue;
    if (hasAnchoredBelow.has(id)) { wrappers.push({ id, name: v.node.name, type: v.node.type }); continue; }
    // report only the top of each unmapped subtree
    const parentUnmapped = v.parentId && visible.has(v.parentId) && !isCovered(v.parentId) && !hasAnchoredBelow.has(v.parentId);
    if (!parentUnmapped) unmapped.push({ id, name: v.node.name, type: v.node.type });
  }
  const unmappedNodes = [...visible.keys()].filter((id) => !isCovered(id) && !hasAnchoredBelow.has(id)).length;
  return {
    visible: visible.size,
    unmapped, unmappedNodes, wrappers,
    hiddenAnchored: Object.keys(anchors).filter((id) => hidden.has(id)),
    unknown: Object.keys(anchors).filter((id) => !visible.has(id) && !hidden.has(id)),
  };
}

// ================================================================ the checks

const verdictOf = (row: { verdict?: unknown } | null | undefined): string => String((row && row.verdict) || "").trim().toLowerCase();
// `codeToken: "MISSING"` (or none / n/a / null) means "there is no token" — not a token NAME.
const NO_TOKEN = new Set(["missing", "none", "n/a", "na", "-", "null", "tbd"]);
const hasToken = (row: PlanTokenRow): row is PlanTokenRow & { codeToken: string } => !!row.codeToken && !NO_TOKEN.has(String(row.codeToken).trim().toLowerCase());

function loadMapKeys(cwd: string): Map<string, { name: string; module: string }> {
  for (const f of [path.join(cwd, MAP_FILE), path.join(cwd, LEGACY_MAP_FILE)]) {
    // An invalid map is treated as no map (these are warnings about reuse; map-validate names the fault),
    // so a broken design/ map falls through to the root one — unlike findMapFile, which stops at the first that exists.
    const map = readJsonOrNull(f, isCodeConnectMap);
    if (!map) continue;
    const keys = new Map<string, { name: string; module: string }>();
    for (const [name, e] of Object.entries(map.components)) {
      if (e.figma.key && e.status !== "deprecated") keys.set(e.figma.key, { name, module: e.code.module });
    }
    return keys;
  }
  return new Map();
}

// What the plan says about how the build was checked — mode … a11y read from verification.recorded@2 when there is
// one, else from verification's top level (a hand-written or native plan, a recorded@1 one): verificationFacts.
// Every message names the block it read. A warning, never a block.
function checkVerification(plan: Plan, cwd: string): string[] {
  const f = verificationFacts(plan.verification);
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

// Missing evidence worth having (a warning, never a block).
function verificationWarnings(plan: Plan): string[] {
  const v = plan.verification;
  const f = verificationFacts(v);
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
// record is older than the verdict it summarises. A warning — the report is the verdict either way; plan-status.ts reads the record's
// mode/reason for a plan with no report (static-only), and blocks on a hand edit of it (recordedEdits).
// (The report is read only when it is a regular file: a record naming a FIFO or a device must not hang the hook.)
// A record naming a report that is not on disk at all (renamed or deleted) cannot be compared with it, so a hand edit of
// the record would go unseen (recordedEdits): that is a warning of its own.
function recordedReportWarnings(plan: Plan, cwd: string): string[] {
  const r = recordedReport(plan, cwd);
  if (r.kind === "missing") {
    return [`plan.verification.recorded names ${r.report}, which is not on disk (renamed or deleted) — the record cannot be checked against its report: run verify-screen --migrate for a ` +
      "legacy-named verify set, else re-run verify-screen --compare --record-plan"];
  }
  return r.kind === "rewritten" ? [`plan.verification records an older run of ${r.report} — re-run ${scriptCmd("verify-screen")} --compare --record-plan (the report is the verdict)`] : [];
}

// Beside a recorded block (the record), the record's own keys at verification's top level — and a hand-written
// headline/verdict — are read by nothing: say so, once. The tool keys only beside a recorded@2, and only the ones it
// holds (one it lacks is read from the top level — verificationFacts; beside a recorded@1 they are all still the
// record's); the hand verdicts beside either.
const SHADOWED_TOOL_KEYS = ["mode", "reason", "renderer", "artifacts", "deltas", "a11y"] as const;
const HAND_VERDICT_KEYS = ["headline", "verdict", "verifyScreenVerdict"] as const;
function recordedShadowWarnings(plan: Plan): string[] {
  const v = plan.verification;
  const rec: unknown = v && typeof v === "object" ? v.recorded : undefined;
  if (!v || !isJsonObject(rec)) return [];
  const v2 = isRecordV2Shaped(rec);
  if (v2 && !isVerificationRecord(rec)) return []; // (an edited record blocks; its message comes first)
  const top = Object.keys(v);
  const keys = [...(v2 ? SHADOWED_TOOL_KEYS.filter((k) => top.includes(k) && rec[k] !== undefined) : []), ...HAND_VERDICT_KEYS.filter((k) => top.includes(k))];
  return keys.length ? [`verification.${keys.join(", verification.")} ${keys.length > 1 ? "are" : "is"} ignored — verification.recorded is the record (${scriptCmd("verify-screen")} --compare --record-plan writes it); ` +
    "remove " + (keys.length > 1 ? "them" : "it") + " from the top level: a residual goes in deviations[] (with the why), anything else in notes"] : [];
}

// What the report's behaviour/a11y section says — WARNINGS only, never a block (not the fidelity verdict).
// (a) a failed check; (b) plan.verification.a11y disagreeing with the report's fail count; (c) the checks did not run.
// (b) compares the plan's ONE a11y number with the ONE report it was copied from — verification.a11y.report when set
// (report.json or its .md), else the plan's own report (newestOwn).
// The name is read as written: project-relative, absolute, relative to the plan file, or a bare file name — the last two
// fall back to the basename when exactly one located report has it. Several with that basename → the own-screen rule among
// them. "Not found" only when nothing matches, so a real disagreement is never hidden behind a path spelling.
// The plan's own report is chosen by CONTENT, never by a clock (a `touch` or a fresh clone reorders mtimes — the
// freshness rule of plan-status.ts): the report verification.recorded.report names (the one its record was written from),
// else, among the reports for the plan's own screen (matched by name, as locateReports ranks; all of them when none is),
// the latest measuredAt — none is the oldest — with mtime only breaking a tie.
const json = (x: string): string => siblingFile(x, "reportMd", "report");
const slash = (x: string): string => x.split(path.sep).join("/").split("\\").join("/");
// verification.recorded.report in ReportRef.rel's spelling (read as recordedReportWarnings reads it: project-relative or absolute)
function recordedReportRel(plan: Plan, cwd: string | undefined): string | null {
  const rec: unknown = plan.verification && typeof plan.verification === "object" ? plan.verification.recorded : undefined;
  if (!isJsonObject(rec) || typeof rec.report !== "string" || !rec.report.trim()) return null;
  const named = rec.report.trim();
  return json(slash(cwd === undefined ? named : path.relative(cwd, path.resolve(cwd, named))).replace(/^\.\//, ""));
}
const measuredMs = (r: ReportRef): number => {
  const t = r.measuredAt === null ? NaN : Date.parse(r.measuredAt);
  return Number.isNaN(t) ? -Infinity : t;
};
const newestOwn = (reports: ReportRef[], recordedRel: string | null = null): ReportRef | null => {
  const recorded = recordedRel === null ? undefined : reports.find((r) => r.rel === recordedRel);
  if (recorded) return recorded;
  const own = reports.filter((r) => r.matchedBy === "name");
  const later = (r: ReportRef, best: ReportRef): boolean => measuredMs(r) > measuredMs(best) || (measuredMs(r) === measuredMs(best) && r.mtimeMs > best.mtimeMs);
  return (own.length ? own : reports).reduce<ReportRef | null>((best, r) => (!best || later(r, best) ? r : best), null);
};
function a11yReportOf(named: string | undefined, reports: ReportRef[], ctx: { cwd?: string; planFile?: string; recordedRel?: string | null } = {}): { ref: ReportRef | null; missing?: string } {
  if (named === undefined || !named.trim()) return { ref: newestOwn(reports, ctx.recordedRel) };
  const want = slash(named.trim());
  const rels = new Set<string>([json(want.replace(/^\.\//, ""))]);
  if (ctx.cwd !== undefined) {
    rels.add(json(slash(path.relative(ctx.cwd, path.resolve(ctx.cwd, named.trim()))))); // absolute, or relative to the project
    if (ctx.planFile !== undefined) rels.add(json(slash(path.relative(ctx.cwd, path.resolve(path.dirname(path.resolve(ctx.cwd, ctx.planFile)), named.trim())))));
  }
  const exact = reports.find((r) => rels.has(r.rel));
  if (exact) return { ref: exact };
  const base = json(path.posix.basename(want));
  const byBase = reports.filter((r) => path.posix.basename(r.rel) === base);
  if (byBase.length) return { ref: byBase.length === 1 ? byBase[0] ?? null : newestOwn(byBase, ctx.recordedRel) };
  return { ref: null, missing: want };
}
// ONE report speaks for the run — the one verification.a11y.report names, else the plan's own (newestOwn); its fail count is of
// failed elements ("+N more" rows count N), so it says "failures". A re-run of a set overwrites its report, so a run's
// older rounds are gone. Every OTHER report file locateReports matched (design/verify/ is flat, so
// another file is another set — a variant <Layer>__<id>.<slug> (a narrow width, a dark theme), or a legacy-named one)
// warns on its own failures: one warning per other report file, so no FAIL is silenced; the disagreement and "did not run"
// warnings stay with the one report above.
function behaviourWarnings(plan: Plan, reports: ReportRef[] | null | undefined, ctx: { cwd?: string; planFile?: string } = {}): string[] {
  const out: string[] = [];
  const all = reports || [];
  const f = verificationFacts(plan.verification);
  const a11y = f.a11y;
  const recorded = a11y && typeof a11y === "object" ? a11y.violations : undefined;
  const recordedRel = recordedReportRel(plan, ctx.cwd);
  const target = a11yReportOf(a11y && typeof a11y === "object" && typeof a11y.report === "string" ? a11y.report : undefined, all, { ...ctx, recordedRel });
  if (recorded !== undefined && target.missing !== undefined && all.some((r) => r.behaviour && r.behaviour.ran))
    out.push(`${f.a11yAt}.a11y.report names ${target.missing}, which is not a verify report found for this plan in design/verify/ — the a11y count was not checked against it`);
  const r = target.ref ?? newestOwn(all, recordedRel);
  const n = (k: number, one: string, many: string): string => `${k} ${k === 1 ? one : many}`;
  const failWarning = (ref: ReportRef, fail: number, failed: string[]): string => {
    const ids = [...new Set(failed)];
    return `${ref.rel}: behaviour/a11y — ${n(fail, "failure", "failures")} (${ids.slice(0, 6).join(", ")}${ids.length > 6 ? `, +${ids.length - 6} more` : ""}) — not the fidelity verdict, but a measurable ` +
      `accessibility failure is never waived: fix it or raise a designer question`;
  };
  // Every other report file (not the one speaking for the run)
  const others = all.filter((x) => x !== r);
  const otherFails = others.flatMap((x) => (x.behaviour && x.behaviour.ran && x.behaviour.fail > 0 ? [failWarning(x, x.behaviour.fail, x.behaviour.failed)] : []));
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
  if (recorded !== undefined && target.missing === undefined && recorded !== b.fail)
    out.push(`${f.a11yAt}.a11y records ${JSON.stringify(recorded)} ${recorded === 1 ? "violation" : "violations"} but ${r.rel} behaviour has ${n(b.fail, "failure", "failures")} — ` +
      (f.a11yAt === "verification.recorded" ? "re-run --compare --record-plan against that report" : "copy report.behaviour.summary"));
  return [...out, ...otherFails];
}

// The verification block contradicting itself in adjacent keys (a11y and deltas as verificationFacts reads them).
// A hand verdict is checked against the reports only in a plan with no `recorded`: beside one it is ignored
// (recordedShadowWarnings).
const A11Y = /\b(a11y|axe|accessib)/i;
function verificationContradictions(plan: Plan, reports: ReportRef[] | null | undefined): string[] {
  const v = plan.verification;
  if (!v || typeof v !== "object") return [];
  const f = verificationFacts(v);
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
  for (const r of reports || []) {
    // --record-plan writes only the OPEN high/medium deltas — [] beside a report of lows is that record, not a gap
    const recordedHere = isJsonObject(rec) && rec.report === r.rel;
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

// A deviation is only reviewable when it says WHICH node, WHICH field, what was designed,
// what was built, and why.
const DEVIATION_FIELDS = ["nodeId", "field", "designed", "built", "reason"] as const;
function deviationWarnings(plan: Plan): string[] {
  if (plan.deviations === undefined) return []; // (a non-array `deviations` is refused by parsePlan, doc-guards.ts)
  const bad: string[] = [];
  plan.deviations.forEach((d, i) => {
    const miss = DEVIATION_FIELDS.filter((k) => {
      if (k === "nodeId") return !(d && ((typeof d.nodeId === "string" && d.nodeId) || (Array.isArray(d.nodeIds) && d.nodeIds.length)));
      return !(d && d[k] !== undefined && d[k] !== null && d[k] !== "");
    });
    if (miss.length) bad.push(`#${i}${d && d.id ? ` (${d.id})` : ""}: ${miss.join(", ")}`);
  });
  return bad.length ? [`${bad.length} deviation(s) are missing fields — each needs {nodeId, field, designed, built, reason} so a reviewer can check it against the export: ` +
    `${bad.slice(0, 6).join("; ")}${bad.length > 6 ? `; +${bad.length - 6} more` : ""}`] : [];
}

// The header every other skill resolves a plan by. A warning — plan-skeleton.ts
// writes it, so a plan without it was hand-written.
function validatePlanHeader(plan: Plan): string[] {
  const missing = (["screenName", "nodeId", "route", "file"] as const).filter((k) => plan[k] === undefined || plan[k] === null || plan[k] === "");
  if (!missing.length) return [];
  return [
    `plan header is missing ${missing.map((k) => `\`${k}\``).join(", ")} — other skills (verify, sync-design) resolve a screen through this header, not through the free-text \`screen\` field; add ` +
      `${missing.length > 1 ? "them" : "it"} so this plan is findable by node id/name/route without guessing (the plan-skeleton script writes the header; only the route is yours to fill)`,
  ];
}

/** checkPlan()'s optional pre-located inputs (the CLI locates each once and passes them through).
 *  `graph`: the project graph over every plan's files[] (built on first use when absent) — one per hook run. */
export interface CheckPlanOptions { export?: ExportHit | null; reports?: ReportRef[]; graph?: () => ProjectGraph }
export interface TagCoverage { tagged: number; anchored: number }
export interface CheckPlanResult { blocking: string[]; warnings: string[]; tagCoverage?: TagCoverage }

const isAcknowledged = (row: PlanTokenRow): boolean => typeof row.acknowledged === "string" && !!row.acknowledged.trim();

// The project graph (code-scanner.ts) over every plan's files[] under design/plan/, read once per hook run: a shared
// shell lives in another plan's files, and the import check, the tag count and the declared-token check see it.
// `plans`: design/plan/'s readable plans when the caller has already parsed them (else they are found here).
function planGraph(cwd: string, extra: readonly string[] = [], plans?: readonly PlanFile[]): ProjectGraph {
  return projectGraph(cwd, (plans ?? findPlans(cwd).plans).map((p) => p.plan.files || []), extra);
}

// ---------------------------------------------------------------- profile and tag coverage
// The plan's `target` ("web-tailwind", or {profile: "web-tailwind", …}), else design/target.json's `profile`.
function profileOf(plan: Plan, cwd: string): string | null {
  const t = plan.target;
  if (typeof t === "string" && t.trim()) return t.trim();
  if (t && typeof t === "object" && typeof t.profile === "string" && t.profile.trim()) return t.profile.trim();
  const doc = readJsonOrNull(path.join(cwd, TARGET_FILE), isJsonObject);
  return doc && typeof doc.profile === "string" && doc.profile.trim() ? doc.profile.trim() : null;
}
const isWebProfile = (p: string | null): boolean => !!p && /^web(-|$)/i.test(p);

// An anchored visible node is TAGGED when its id appears as a string literal in any scanned file (the
// attribute value itself, or an entry of a lookup table the attribute reads: `data-dt-node={IDS.row}`).
// Anchored = its own anchor maps it to code (mapModule/file/symbol; `omitted` is not built, so not
// counted); visible = drawn by the export (all anchored ids when the export cannot be found).
function tagCoverageOf(plan: Plan, exp: ExportHit | null, files: FileText[]): { tagged: number; anchored: number; attribute: boolean; untagged: string[] } {
  const anchors: Record<string, PlanAnchor> = plan.anchors || {};
  const vis = exp ? visibility(screenRoots(exp.doc)).visible : null;
  const ids = Object.keys(anchors).filter((id) => { const a = anchors[id]; return anchored(a) && !(a && typeof a.omitted === "string" && a.omitted.trim()) && (!vis || vis.has(id)); });
  const attribute = files.some((f) => f.text.includes("data-dt-node"));
  // verify reads data-dt-node only: with the attribute nowhere, an id in some other attribute tags nothing.
  const untagged = attribute ? ids.filter((id) => !files.some((f) => f.text.includes(`"${id}"`) || f.text.includes(`'${id}'`) || f.text.includes("`" + id + "`"))) : ids;
  return { tagged: ids.length - untagged.length, anchored: ids.length, attribute, untagged };
}

// ---------------------------------------------------------------- colour tokens nothing declares
// A colour row's codeToken whose custom property no file declares — the utility or variable it
// names renders nothing (a hand-written @theme without the alias). Not checked in a project with a
// tailwind.config.* (Tailwind v3: colours are configured there, not declared as CSS variables).
function undeclaredColourTokens(live: PlanTokenRow[], g: ProjectGraph): string[] {
  const colour = [...new Set(live.filter((r) => hasToken(r) && String(r.kind).toLowerCase() === "color").map((r) => String(r.codeToken).trim()))];
  const wanted = colour.map((t) => ({ t, props: requiredCustomProps(t) })).filter((x) => x.props.length);
  if (!wanted.length) return [];
  const scan = g.scan();
  if (scan.tailwindConfig) return [];
  const declared = declaredCustomProps([...g.files, ...scan.css]);
  const missing = wanted.filter((x) => x.props.some((p) => !declared.has(p)));
  if (!missing.length) return [];
  const show = missing.slice(0, 8).map((x) => `'${x.t}' (needs ${x.props.filter((p) => !declared.has(p)).join(", ")})`).join(", ");
  return [`${missing.length} colour code token(s) are declared nowhere — not in any plan's files[] nor in a .css file of the project: ${show}${missing.length > 8 ? `, +${missing.length - 8} more` : ""} — a ` +
    `utility or variable with no definition renders nothing; add the alias to the theme (e.g. in the @theme block the tokens script writes)`];
}

// ---------------------------------------------------------------- a deviation that contradicts the plan
const STYLE_FIELDS = new Set(["effects", "shadow", "fill", "fills", "stroke", "strokes", "radius", "cornerradius", "opacity", "padding", "gap", "font",
  "typography", "color", "background", "border", "blur", "size", "width", "height", "fontsize", "fontweight", "lineheight", "letterspacing",
  "borderradius", "borderwidth", "textalign", "textcase"]);
function deviationConflicts(plan: Plan): string[] {
  const out: string[] = [];
  const anchors: Record<string, PlanAnchor> = plan.anchors || {};
  (plan.deviations || []).forEach((d, i) => {
    if (!d) return;
    // Only a WHOLE-NODE omission: `built` says nothing was built, and the field is not a style
    // sub-property (a reused card whose shadow was not built is a field-level change, not the card left out).
    // the LAST segment of a path-like field: `style.shadow` → shadow, `fills[0]` → fills
    const field = typeof d.field === "string" ? (d.field.trim().toLowerCase().split(/[.[\]\s/]+/).filter(Boolean).pop() ?? "") : "";
    if (STYLE_FIELDS.has(field)) return;
    const built = d.built;
    const omitted = built === null || built === false || (typeof built === "string" && /^(omitted|not built|not rendered|removed)/i.test(built.trim()));
    if (!omitted) return;
    const ids = [...(typeof d.nodeId === "string" && d.nodeId ? [d.nodeId] : []), ...(Array.isArray(d.nodeIds) ? d.nodeIds : [])];
    for (const id of ids) {
      const comp = (plan.components || []).find((c) => c.nodeId === id && verdictOf(c) === "reused");
      const a = anchors[id];
      const mod = a && typeof a.mapModule === "string" && a.mapModule.trim() ? a.mapModule : null;
      if (!comp && !mod) continue;
      const says = [comp ? `components[] marks '${comp.name}' "reused"${comp.mapModule ? ` from ${comp.mapModule}` : ""}` : null, mod ? `anchors["${id}"] maps it to ${mod}` : null].filter(Boolean).join(" and ");
      out.push(`deviation #${i}${d.id ? ` (${d.id})` : ""} says node ${id} was not built, but ${says} — one of them is wrong: if it was left out, anchor it as {"omitted": "<why>"} and drop the reuse claim; if it ` +
        `was built, correct the deviation`);
    }
  });
  return out;
}

// Returns { blocking: [...], warnings: [...] }.
// Its `blocking` messages are SAVED into the plan (verification.hook.blocking), a file users commit: name
// scripts in words here, never with scriptCmd() — that is a per-machine, per-plugin-version absolute path.
function checkPlan({ plan, file }: PlanFile, cwd: string, opts?: CheckPlanOptions): CheckPlanResult {
  const o = opts || {};
  const blocking: string[] = [], warnings: string[] = [];
  const listed = plan.files || [];
  const absent = listed.filter((f) => !fs.existsSync(path.join(cwd, f)));
  if (!listed.length) warnings.push("`files` is empty — list every file this build created or changed; the literal and import checks only read the files named there, so nothing was checked");
  if (absent.length) warnings.push(`file(s) listed in \`files\` not found on disk: ${absent.join(", ")} — fix the path(s) (relative to the project root) or remove entries for files that were not written`);

  // Every plan's files[] under design/plan/ (this one's included): a shared shell lives in another plan's
  // files, and the import check, the tag count and the declared-token check see it. The graph has read
  // this plan's files too, so their text is taken from it rather than read again.
  let built: ProjectGraph | null = null;
  const graph = (): ProjectGraph => built || (built = o.graph ? o.graph() : planGraph(cwd, listed));
  const g = graph();
  const isFileNow = (rel: string): boolean => { try { return fs.statSync(path.join(cwd, rel)).isFile(); } catch { return false; } };
  const byFile: FileText[] = listed.filter(isFileNow)
    .map((rel) => (g.cached(rel) !== undefined && g.byRel.get(rel)) || { rel, text: fs.readFileSync(path.join(cwd, rel), "utf8") });
  const code: FileText[] = codeOf(byFile);
  const source = code.map((f) => f.text).join("\n");

  const allowed = new Set((plan.allowedLiterals || []).filter((a) => a && a.reason && a.value !== undefined).map((a) => String(a.value).toLowerCase()));
  const allowedFiles = (plan.allowedLiterals || []).filter((a) => a && a.reason && a.file).map((a) => String(a.file));
  const isAllowed = (row: PlanTokenRow, literal: string): boolean => allowed.has(String(row.value).toLowerCase()) || allowed.has(String(literal).toLowerCase());
  // Where a literal is USED: `codeTokens` is every plan token that resolves to its value — a line defining any of them is
  // a definition, not a use — and an allow-listed token file is never a use (code-scanner.ts literalUses).
  const uses = (literal: string, codeTokens: readonly string[]): { found: boolean; usedIn: string[] } => literalUses(code, literal, codeTokens, allowedFiles);
  const definedOnly = (literal: string, codeTokens: readonly string[]): boolean => { const u = uses(literal, codeTokens); return u.found && !u.usedIn.length; };

  const tokens = plan.tokens || [];
  const live = tokens.filter((r) => verdictOf(r) !== "hidden-only");
  const colourTokensOf = (key: string): string[] => [...new Set(live.filter((r) => hasToken(r) && String(r.kind).toLowerCase() === "color" && colorKey(r.value) === key).map((r) => String(r.codeToken)))];
  const dimTokensOf = (n: number): string[] => [...new Set(live.filter((r) => hasToken(r) && String(r.kind).toLowerCase() !== "color" && parseFloat(String(r.value)) === n).map((r) => String(r.codeToken)))];
  // One message, however many rows: a fresh plan-skeleton plan has every row unfilled, and 33 lines
  // of the same sentence would bury the two things that actually block.
  const undecided = live.filter((row) => (verdictOf(row) === "missing" || !hasToken(row)) && !row.decision);
  if (undecided.length) {
    const show = undecided.slice(0, 8).map((row) => `${row.figmaName ? `'${row.figmaName}' ` : ""}${String(row.value)} (${row.kind})`).join(", ");
    warnings.push(`${undecided.length} token row(s) have no token and no recorded decision: ${show}${undecided.length > 8 ? `, +${undecided.length - 8} more` : ""} — fill codeToken, or say what you did about it in ` +
      `\`decision\` (a one-off literal is a legitimate answer; say so)`);
  }

  // Token IDENTITY: two DIFFERENT Figma tokens on one code token.
  // A row carrying `"acknowledged": "<why>"` is a merge a person decided on — it is left out.
  for (const row of live) if (row.acknowledged !== undefined && !isAcknowledged(row))
    warnings.push(`token row '${row.figmaName || String(row.value)}' has an empty \`acknowledged\` — say why the shared code token is right, or remove the field`);
  const byCodeToken = new Map<string, Map<string, PlanTokenRow["value"]>>();
  for (const row of live) {
    if (!hasToken(row) || !row.figmaName || isAcknowledged(row)) continue;
    const c = String(row.codeToken).trim();
    const names = byCodeToken.get(c) || new Map<string, PlanTokenRow["value"]>();
    if (!names.has(row.figmaName)) names.set(row.figmaName, row.value);
    byCodeToken.set(c, names);
  }
  for (const [c, names] of byCodeToken) {
    if (names.size < 2) continue;
    const l = [...names].map(([n, v]) => `'${n}' (${String(v)})`).join(" and ");
    warnings.push(`code token '${c}' is mapped from ${names.size} DIFFERENT Figma tokens — ${l}. They may share a value in the exported mode, but they are separate tokens and will diverge in another mode/theme; ` +
      `give each its own code token named after its own Figma name (or, if sharing is deliberate, add "acknowledged": "<why>" to the row that shares it)`);
  }

  // BLOCK 1: an unexplained colour literal. One message per LITERAL, however many plan rows resolve it
  // (a doc comment naming one literal would otherwise raise two problems).
  const colors = colorLiterals(source);
  const colourHits = new Map<string, { value: PlanTokenRow["value"]; tokens: string[]; where: string[] }>();
  for (const row of live) {
    if (!hasToken(row) || String(row.kind).toLowerCase() !== "color") continue;
    const h = colorKey(row.value);
    const lit = h && colors.get(h);
    if (!h || !lit || isAllowed(row, lit)) continue;
    // Name only files that USE the literal — not an allow-listed token file, not a file
    // where every occurrence is a token's own definition line.
    const e = getOrInit(colourHits, lit, () => ({ value: row.value, tokens: [], where: uses(lit, colourTokensOf(h)).usedIn }));
    if (e.where.length && !e.tokens.includes(row.codeToken)) e.tokens.push(row.codeToken);
  }
  for (const [lit, e] of colourHits) {
    // A block must name where the literal is used. No such file means every occurrence is a
    // definition or allow-listed — nothing to fix, so nothing to block on.
    const where = e.where;
    if (!where.length) continue;
    blocking.push(`raw colour ${lit} in ${where.join(", ")}, but the plan resolved ${String(e.value)} to token ${e.tokens.map((t) => `'${t}'`).join(" / ")} — use the token, not the literal (comments, prose strings ` +
      `and non-source files such as .svg are not scanned). A value that must stay literal goes in allowedLiterals as {"value": "${lit}", "reason": "…"}, matched on the exact value string, or name the file that ` +
      `defines the tokens: {"file": "…", "reason": "…"}`);
  }

  const dims = arbitraryPx(source);
  for (const row of live) {
    if (!hasToken(row) || String(row.kind).toLowerCase() === "color") continue;
    const n = parseFloat(String(row.value));
    const hits = Number.isFinite(n) ? dims.get(n) || [] : [];
    const hit = hits.find((e) => kindsCompatible(e.utility, row.kind) && !isAllowed(row, e.literal) && !definedOnly(e.literal, dimTokensOf(n)));
    if (hit) warnings.push(`arbitrary value ${hit.utility ? `${hit.utility}-${hit.literal}` : hit.literal} in built code, but the plan resolved ${String(row.value)} (${row.kind}) to token '${String(row.codeToken)}' ` +
      `— use the token (or add it to allowedLiterals with a reason)`);
  }

  const sharedByFile = (): FileText[] => graph().files.filter((f) => !listed.includes(f.rel));
  let reach: FileText[] | null = null;
  const reachable = (): FileText[] => reach || (reach = graph().reachable(listed));

  const mapped = loadMapKeys(cwd);
  const seenModule = new Set<string>();
  for (const row of plan.components || []) {
    const verdict = verdictOf(row);
    if (verdict === "reused" && row.mapModule && !seenModule.has(row.mapModule)) {
      seenModule.add(row.mapModule);
      // See code-scanner.ts ProjectGraph.reachable — this plan's files, what they import, and the app shell that renders them.
      if (!moduleImported(row.mapModule, byFile, cwd) && !moduleImported(row.mapModule, reachable(), cwd))
        warnings.push(`component '${row.name}' is "reused" from ${row.mapModule}, but no file in files[] imports that module (neither this plan's files, nor a plan file they import, nor one that renders them — an ` +
          `app shell — or its direct imports; compared by resolved path / path suffix, so '../../components/X' and '@/components/X' both count) — was it regenerated instead of reused? If it is rendered by a ` +
          `shared layout above this screen (e.g. an app shell), list that layout file in this plan's files[] too`);
    }
    const mappedTo = verdict === "new" && row.key ? mapped.get(row.key) : undefined;
    if (mappedTo) {
      warnings.push(`component '${row.name}' is marked "new" in the plan, but its Figma key is mapped to ${mappedTo.module} in codeconnect.local.json — reuse the existing component`);
    }
    if (verdict === "missing") warnings.push(`component '${row.name}' has no recorded reuse/new decision`);
  }

  // BLOCK 2: every visible design node has an anchor (itself or an ancestor).
  const exp = o.export === undefined ? locateExport(plan, file, cwd) : o.export;
  if (!exp) {
    warnings.push(`could not find this plan's screen export (no \`file\`/\`nodeId\` header, and no node id in its name) — the anchor check did not run; the plan-skeleton script writes the header`);
  } else {
    if (exp.staleFile) {
      const now = path.relative(cwd, exp.file).split(path.sep).join("/");
      warnings.push(`plan.file names ${exp.staleFile}; the index files node ${String(exp.nodeId)} under ${now} — read ${now}; re-run plan-skeleton --out to refresh the header`);
    }
    const cov = anchorCoverage(plan, exp.doc);
    if (cov.unmapped.length) {
      const show = cov.unmapped.slice(0, 10).map((u) => `${u.id} '${String(u.name).trim()}' (${u.type})`).join(", ");
      blocking.push(`${cov.unmappedNodes} visible design node(s) have no anchor in the plan — neither they nor any ancestor map to code. Top of each unmapped subtree: ` +
        `${show}${cov.unmapped.length > 10 ? `, +${cov.unmapped.length - 10} more` : ""}. Add anchors["<id>"] = {"mapModule": "<the file that renders it>"} on the subtree's top (children inherit it), or {"omitted": ` +
        `"<why it is not built>"} — the plan-skeleton script lists every visible node`);
    }
    if (cov.wrappers.length) warnings.push(`${cov.wrappers.length} visible container(s) have anchored children but no anchor of their own (e.g. ` +
      `${cov.wrappers.slice(0, 3).map((w) => `${w.id} '${String(w.name).trim()}'`).join(", ")}) — anchor the frame to the screen component so sync-design can place a change to it`);
    if (cov.hiddenAnchored.length) warnings.push(`${cov.hiddenAnchored.length} anchor(s) point at HIDDEN nodes (${cov.hiddenAnchored.slice(0, 4).join(", ")}${cov.hiddenAnchored.length > 4 ? ", …" : ""}) — hidden ` +
      `layers are not built; remove them`);
    if (cov.unknown.length) warnings.push(`${cov.unknown.length} anchor(s) name node ids that are not on this frame (${cov.unknown.slice(0, 4).join(", ")}${cov.unknown.length > 4 ? ", …" : ""}) — e.g. a shared ` +
      `shell tagged with another frame's instance ids; anchor THIS frame's ids`);
  }

  // Web tag coverage; colour code tokens nothing declares.
  let tagCoverage: TagCoverage | undefined;
  if (isWebProfile(profileOf(plan, cwd))) {
    const optOut = plan.tagging;
    const reason = optOut && optOut.off === true && typeof optOut.reason === "string" ? optOut.reason.trim() : "";
    if (optOut && optOut.off === true && !reason) warnings.push("`tagging.off` is set with no `reason` — the opt-out is ignored until it says why this project cannot carry data-dt-node tags");
    if (!reason && listed.length) { // no files[] at all is the "`files` is empty" warning, not a tag block
      const tagged = tagCoverageOf(plan, exp, [...code, ...codeOf(sharedByFile())]);
      if (tagged.anchored > 0) {
        tagCoverage = { tagged: tagged.tagged, anchored: tagged.anchored };
        const pct = Math.round((100 * tagged.tagged) / tagged.anchored);
        const how = "tag every element that implements a design node one-to-one with data-dt-node=\"<node id>\" (an id from a lookup table counts: the id string only has to appear in a listed file), so the verify " +
          "step measures the right element instead of guessing";
        if (!tagged.attribute) blocking.push(`web build with no data-dt-node tags: none of the files in any plan's files[] carries the attribute, so 0 of ${tagged.anchored} anchored visible node(s) can be measured ` +
          `— ${how}. A project that genuinely cannot tag records "tagging": {"off": true, "reason": "…"} in the plan`);
        else if (tagged.tagged * 2 < tagged.anchored) warnings.push(`data-dt-node tag coverage is ${tagged.tagged}/${tagged.anchored} anchored visible node(s) (${pct}%), below 50% — ` +
          `${how}${tagged.untagged.length ? `; untagged e.g. ${tagged.untagged.slice(0, 5).join(", ")}` : ""}`);
      }
    }
  }
  warnings.push(...undeclaredColourTokens(live, graph()));

  blocking.push(...recordedEdits(plan, cwd));
  warnings.push(...checkVerification(plan, cwd));
  warnings.push(...verificationWarnings(plan));
  warnings.push(...recordedReportWarnings(plan, cwd));
  warnings.push(...recordedShadowWarnings(plan));
  const reports = o.reports || locateReports(plan, file, cwd, exp);
  warnings.push(...verificationContradictions(plan, reports));
  warnings.push(...behaviourWarnings(plan, reports, { cwd, planFile: file }));
  warnings.push(...legacySetWarnings(plan, file, reports));
  warnings.push(...deviationWarnings(plan));
  warnings.push(...deviationConflicts(plan));
  warnings.push(...validatePlanHeader(plan));
  warnings.push(...auditGateWarnings(plan, cwd, exp, file));
  // One line per distinct message (the same sentence repeated is noise that buries the real ones).
  return { blocking: [...new Set(blocking)], warnings: [...new Set(warnings)], ...(tagCoverage ? { tagCoverage } : {}) };
}

// Only a WARNING (this file blocks on a raw colour, an unanchored node and — web — no tags at all). When design/audit/<screen>.json (or a legacy-named audit) has blocker(s) and the
// plan has no auditGate covering them, a build reading a Blocked audit and proceeding would otherwise
// be indistinguishable, on disk, from one that never read it.
// (audit-gate.ts is a static import, which cannot fail at this point.)
function auditGateWarnings(plan: Plan, cwd: string, exp: ExportHit | null | undefined, planFile?: string): string[] {
  const screenFile = plan.file ? path.resolve(cwd, plan.file) : null;
  const screenName = plan.screenName || (exp && exp.layerName) || null;
  let g: ReturnType<typeof auditGateStatus>;
  try { g = auditGateStatus(cwd, planNode(plan, planFile), screenFile, screenName); } catch { return []; }
  // An audit file that is there but cannot be read gates nothing — say so rather than read it as "no blockers".
  if (g.auditFile && g.unreadable) return [`${g.auditFile} ${g.error || "could not be read"} — the audit gate was NOT checked; re-run the audit script for this screen`];
  if (!g.auditFile || !g.blockers.length) return [];
  const gate = plan.auditGate;
  if (!gate) {
    return [`${g.auditFile} is Blocked (${g.blockers.length} blocker(s): ${g.blockers.join(", ")}) and this plan has no \`auditGate\` — either resolve the blocker(s) or record ` +
      `{auditGate:{auditFile,verdict,overridden:[...],reason,decidedBy,decidedAt}} naming which one(s) were acknowledged and why`];
  }
  const overridden = new Set(Array.isArray(gate.overridden) ? gate.overridden : []);
  // A blocker is covered by its id (`code` / `code@nodeId`, + `~n`) — which is also the bare code a
  // person writes for a node-less finding — or by its older positional id (`code#i`), so an older plan's
  // decision still stands. The warning lists the new ids.
  const out: string[] = [];
  const uncovered = g.blockers.filter((id, i) => !overridden.has(id) && !overridden.has(g.legacyBlockers[i] ?? id));
  if (uncovered.length) out.push(`${g.auditFile} has ${uncovered.length} blocker(s) not listed in this plan's auditGate.overridden: ${uncovered.join(", ")} — either resolve them or add them with a reason`);
  else if (!gate.reason) out.push(`this plan's auditGate overrides ${overridden.size} blocker(s) but gives no \`reason\` — say why it is safe to build past ${g.auditFile}`);
  // The positional id is still accepted, but it is not stable — it is the blocker's
  // position among ALL blockers, so fixing an earlier one shifts it onto a different blocker and the old
  // entry silently covers that one. ONE non-blocking warning maps every entry that covers a blocker only
  // through its positional id to the stable id, and names a positional entry that matches no current blocker.
  const legacySet = new Set(g.legacyBlockers);
  const viaLegacy: string[] = [];
  g.blockers.forEach((id, i) => {
    const old = g.legacyBlockers[i];
    if (old !== undefined && !overridden.has(id) && overridden.has(old)) viaLegacy.push(`${old} → ${id}`);
  });
  const staleLegacy = [...overridden].filter((e): e is string => typeof e === "string" && /^[^@#~]+#\d+$/.test(e) && !legacySet.has(e));
  if (viaLegacy.length || staleLegacy.length) {
    const parts = [...viaLegacy, ...(staleLegacy.length ? [`no current blocker: ${staleLegacy.map((e) => `${e} (drop it)`).join(", ")}`] : [])];
    out.push(`${g.auditFile}: this plan's auditGate.overridden still names blockers by the old positional id — a position shifts when an earlier blocker is fixed or a new one appears, so an old id can silently ` +
      `cover a different blocker. ${viaLegacy.length ? "Replace each with its stable id and check it is the blocker you meant" : "None of them covers a current blocker — " +
        "if one was meant for a blocker listed as not overridden, write that blocker's stable id instead"}: ${parts.join("; ")}`);
  }
  return out;
}

// ================================================================ the verify report behind a plan

// A report found for this plan under a name outside the key grammar (`<Layer>__<id>`, `<Layer>__<id>.<variant>` —
// screen-key.ts): a nickname, or an `@320` / `-r1` variant. It is still read (locateReports matches it by content); the
// warning names it so `verify-screen --migrate` can give it the screen's key.
function legacySetWarnings(plan: Plan, planFile: string | undefined, reports: ReportRef[]): string[] {
  const nodeId = planNode(plan, planFile);
  return reports.flatMap((r) => {
    const set = setBaseOf(path.posix.basename(r.rel), "report") ?? path.posix.basename(r.rel);
    return parseSetName(set) === null ? [`legacy-named verify set ${set} for ${nodeId ? `node ${nodeId}` : "this plan's screen"} — run verify-screen --migrate`] : [];
  });
}

// ================================================================ fan-out scoping

// Several screens build in parallel (one screen-builder each), and every one lands here when it
// stops. Narrow to the plans the stopping agent's own transcript claims (OWNERSHIP below; a subagent's own
// transcript when the payload names one, else the session's). A transcript that claims NO plan checks
// NOTHING: build-screen's Stop hook is skill-scoped, so it also fires in an orchestrator session
// that loaded the skill and built nothing itself — it must not block that session on a plan another
// agent is still filling. A transcript that claims only plans the hook already closed narrows to
// nothing too: agent A, finished, is not blocked on agent B's half-built plan. `scope: "unscoped"` means
// the payload carried no readable transcript at all (a hand-piped `{"cwd": …}`): every open plan is checked.
export type PlanScope = "unscoped" | "none-named" | "named";
// OWNERSHIP. A plan is this session's when the session's OWN tool calls (message.content[] tool_use
// items; for the session transcript, not a subagent's sidechain entries) either
//   (a) WRITE the plan; or
//   (b) WRITE a file that exactly ONE open plan lists in files[] — a builder or fixer editing that
//       screen's code. A file several plans list (a shared component) claims none of them.
// "Write" = a structured write only: a Write/Edit/MultiEdit/NotebookEdit of the path, or a Bash/PowerShell call that runs
// the plan-skeleton script with `--out <path>` (build-screen's step 2, the call that creates the plan — see
// planSkeletonOuts). Any other shell command (a redirect, `sed -i`, `cp`/`mv`, a script writing through fs) is
// not read: a command's targets can only be guessed, and a guess misses as much as it finds. The builder's own
// transcript is the owner's identity because nothing else is per-agent: Claude Code hands a subagent's Bash
// only the session id (CLAUDE_CODE_SESSION_ID), which parallel builders share, so a plan cannot carry its
// owner; the agent id is in the hook payload alone. Not prose, not an Agent/Task prompt (an orchestrator
// naming the plan a subagent should fill), not a tool_result (a subagent's report). Relative paths resolve
// against the transcript entry's own `cwd`, else the payload's. Separators are normalised; a Windows drive
// path from another machine matches by its project-relative tail.
// Nothing claimed → nothing checked, by design: the screen-builder's SubagentStop still gates delegated builds,
// and every builder's transcript holds its plan-skeleton call and the Write/Edit calls of its own code.
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
/** The builder agent hooks.json gates: the plugin-scoped name, or the bare one (the agent copied into a project's .claude/agents/). */
const BUILDER_AGENT = /^(designtwin:)?screen-builder$/;
/** A path the session wrote, and the directory it was relative to (the entry's `cwd`, when recorded). */
export interface WrittenPath { path: string; base: string | null }
// The paths one transcript line's tool_use items write, appended to `out`; returns how many tool_use items it holds.
function lineActions(line: string, ownOnly: boolean, out: WrittenPath[]): number {
  if (!line.trim()) return 0;
  let v: unknown = null;
  try { const parsed: unknown = JSON.parse(line); v = parsed; } catch { return 0; }
  if (!isJsonObject(v) || (ownOnly && v.isSidechain === true) || !isJsonObject(v.message) || !Array.isArray(v.message.content)) return 0;
  let uses = 0;
  for (const item of v.message.content) {
    if (!isJsonObject(item) || item.type !== "tool_use") continue;
    uses++;
    if (typeof item.name !== "string" || !isJsonObject(item.input)) continue;
    const inp = item.input;
    const base = typeof v.cwd === "string" && v.cwd ? v.cwd : null;
    if (WRITE_TOOLS.has(item.name)) { for (const k of ["file_path", "notebook_path"]) { const f = inp[k]; if (typeof f === "string") out.push({ path: f, base }); } }
    else if (SHELL_TOOLS.has(item.name) && typeof inp.command === "string") for (const f of planSkeletonOuts(inp.command, item.name === "PowerShell")) out.push({ path: f, base });
  }
  return uses;
}

// A transcript is tens of MB, mostly tool_result text, and only a line holding a tool_use item can claim a
// plan. Such a line holds the JSON string "tool_use": written plainly by Claude Code, or (by another JSON
// writer) with some of its letters as \uXXXX escapes, which the second test admits. A line passing neither
// cannot hold `type: "tool_use"`, so it is skipped without JSON.parse.
const TOOL_USE_ESCAPED = /"(?:t|\\u0074)(?:o|\\u006f)(?:o|\\u006f)(?:l|\\u006c)(?:_|\\u005f)(?:u|\\u0075)(?:s|\\u0073)(?:e|\\u0065)"/i;
const mayHoldToolUse = (line: string): boolean => line.includes('"tool_use"') || (line.includes("\\u") && TOOL_USE_ESCAPED.test(line));

// The file's lines exactly as readFileSync(file, "utf8").split("\n") gives them, read `chunk` bytes at a time
// so a large transcript is never held whole. A chunk is decoded only up to its last newline byte (0x0A never
// occurs inside a multi-byte UTF-8 sequence), so every decoded piece starts and ends on a character boundary.
const LINE_CHUNK = 1 << 20;
function forEachLine(file: string, onLine: (line: string) => void, chunk = LINE_CHUNK): void {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(chunk);
    let carry: Buffer[] = [];
    for (;;) {
      const n = fs.readSync(fd, buf, 0, chunk, null);
      if (n === 0) break;
      const cut = buf.subarray(0, n).lastIndexOf(0x0a);
      if (cut < 0) { carry.push(Buffer.from(buf.subarray(0, n))); continue; }
      const head = buf.subarray(0, cut);
      const text = (carry.length ? Buffer.concat([...carry, head]) : head).toString("utf8");
      for (const line of text.split("\n")) onLine(line);
      carry = cut + 1 < n ? [Buffer.from(buf.subarray(cut + 1, n))] : [];
    }
    onLine(Buffer.concat(carry).toString("utf8"));
  } finally { fs.closeSync(fd); }
}

/** What a transcript tells the hook: the paths its tool calls write, how many tool calls it holds, and whether it
 *  already holds the no-claim instruction (NO_CLAIM_MARK) — the builder was sent back once before. */
export interface TranscriptScan { writes: WrittenPath[]; toolUses: number; sentBack: boolean }
// The no-claim block's reason holds this phrase; Claude Code delivers it to the builder as a user-role entry that is
// not a tool_result. The phrase in any other entry (the builder's own tool_use, its text, a tool_result of it reading
// this script's source) is not that delivery.
const NO_CLAIM_MARK = "are stopping without claiming a plan, so your build has NOT been checked";
function isHookFeedback(line: string): boolean {
  let v: unknown = null;
  try { const parsed: unknown = JSON.parse(line); v = parsed; } catch { return false; }
  if (!isJsonObject(v) || !isJsonObject(v.message) || v.message.role !== "user") return false;
  const c = v.message.content;
  return typeof c === "string" || (Array.isArray(c) && !c.some((item) => isJsonObject(item) && item.type === "tool_result"));
}
function scanTranscript(file: string, ownOnly: boolean): TranscriptScan {
  const scan: TranscriptScan = { writes: [], toolUses: 0, sentBack: false };
  forEachLine(file, (line) => {
    if (!scan.sentBack && line.includes(NO_CLAIM_MARK) && isHookFeedback(line)) scan.sentBack = true;
    if (mayHoldToolUse(line)) scan.toolUses += lineActions(line, ownOnly, scan.writes);
  });
  return scan;
}
function transcriptActions(file: string, ownOnly: boolean): WrittenPath[] {
  return scanTranscript(file, ownOnly).writes;
}

// The plan files a shell command (the Bash tool's, or the PowerShell tool's — on by default on Windows without Git
// Bash, same `command` input) creates through plan-skeleton (see OWNERSHIP): the `--out <path>` / `--out=<path>`
// of each simple command with a word naming the plan-skeleton script (`plan-skeleton.js`, `.ts`, …) — run directly,
// through node/npx/tsx or PowerShell's `&`, or merely named (`echo plan-skeleton.js --out x` counts too: a miss would
// leave a plan unchecked, a false claim only checks one). A directory change earlier in the same command line (cd,
// pushd, chdir, `builtin cd`, PowerShell's Set-Location/sl/Push-Location) is followed, so a relative `--out` after it
// resolves under that dir. After one it cannot follow — no target, `-`, `~…`, a `$` expansion, popd, or any cd on a
// line with a `( … )` subshell or a `$( … )`/backtick substitution (simpleCommands flattens those, so a cd inside one
// cannot be told from one outside it) — a relative `--out` is tried against the entry's cwd, the likeliest root:
// a false claim needs that exact plan to exist. Heredoc bodies are data, not commands. A PowerShell command is split
// with PowerShell's quoting (a backslash is a plain character, a backtick an escape).
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const PLAN_SKELETON = /^plan-skeleton(\.[cm]?[jt]s)?$/i;
const CHANGE_DIR = /^(cd|chdir|pushd|popd|set-location|sl|push-location|pop-location)$/i;
const isAbsPath = (p: string): boolean => /^(?:[A-Za-z]:)?[\\/]/.test(p);
function planSkeletonOuts(cmd: string, powershell = false): string[] {
  const out: string[] = [];
  const text = powershell ? cmd : dropHeredocBodies(cmd);
  const nested = (powershell ? /\(/ : /[(`]/).test(text);
  let dir: string | null = ""; // "" = the transcript entry's cwd; null = a directory this cannot follow
  const under = (d: string, p: string): string => (d && !isAbsPath(p) ? `${d.replace(/[\\/]+$/, "")}/${p}` : p);
  for (const all of simpleCommands(text, { powershell })) {
    const words = all[0] === "builtin" || all[0] === "command" ? all.slice(1) : all;
    const head = words[0] ?? "";
    if (CHANGE_DIR.test(head)) {
      const to = /^pop/i.test(head) ? undefined : words.slice(1).find((w) => w === "-" || !w.startsWith("-"));
      dir = nested || to === undefined || to === "-" || /^~|\$|`/.test(to) ? null : isAbsPath(to) ? to : dir === null ? null : under(dir, to);
      continue;
    }
    if (!words.some((w) => PLAN_SKELETON.test(w.split(/[\\/]/).pop() ?? ""))) continue;
    words.forEach((w, k) => {
      const eq = /^--out=(.+)$/.exec(w);
      const target = w === "--out" ? words[k + 1] : eq?.[1];
      if (target) out.push(dir === null ? target : under(dir, target));
    });
  }
  return out;
}

// Does a path the session wrote name `rel` (project-relative) under `cwd`?
function sameFile(w: WrittenPath, rel: string, cwd: string): boolean {
  const c = w.path.trim().replace(/\\/g, "/");
  if (!c) return false;
  const want = path.resolve(cwd, rel).replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(c) && !/^[A-Za-z]:\//.test(want)) return path.posix.normalize(c).toLowerCase().endsWith("/" + path.posix.normalize(rel.replace(/\\/g, "/")).toLowerCase());
  const got = path.resolve(w.base || cwd, c).replace(/\\/g, "/");
  return /^[A-Za-z]:\//.test(want) ? got.toLowerCase() === want.toLowerCase() : got === want;
}

function ownPlans(open: PlanFile[], input: HookPayload, all: PlanFile[] | null | undefined, cwd: string): { plans: PlanFile[]; scope: PlanScope; scan?: TranscriptScan } {
  const agent = typeof input.agent_transcript_path === "string" && !!input.agent_transcript_path;
  const file = input.agent_transcript_path || (input.agent_id ? null : input.transcript_path);
  // (a non-string path would have thrown in openSync and been caught the same way)
  if (!file || typeof file !== "string") return { plans: open, scope: "unscoped" };
  let scan: TranscriptScan;
  // the session transcript may carry a subagent's sidechain entries: those are not this session's actions
  try { scan = scanTranscript(file, !agent); } catch { return { plans: open, scope: "unscoped" }; }
  const writes = scan.writes;
  // rule (b): a written file claims the ONE open plan that lists it; a file two or more open plans list claims none
  const listers = new Map<string, number>();
  for (const p of open) for (const f of new Set(p.plan.files || [])) listers.set(f, (listers.get(f) || 0) + 1);
  const owns = (p: PlanFile): boolean => {
    const planRel = path.relative(cwd, path.resolve(p.file));
    if (writes.some((w) => sameFile(w, planRel, cwd))) return true;
    return open.includes(p) && (p.plan.files || []).some((f) => listers.get(f) === 1 && writes.some((w) => sameFile(w, f, cwd)));
  };
  const known = all && all.length ? all : open;
  if (!known.some(owns)) return { plans: [], scope: "none-named", scan };
  return { plans: open.filter(owns), scope: "named", scan };
}

// The unreadable plans (findPlans' `bad`) the session's own Write/Edit or plan-skeleton --out wrote: its claim on a plan
// it broke, which is reported to it as a block rather than as a warning nobody reads. A plan whose raw JSON is an object
// with a closed status ("abandoned", "awaiting-user") is given up on, and stays a warning: the status is read from the
// raw JSON because parsePlan, which fails on such a plan, never gets as far as the status.
function ownBadPlans(bad: readonly BadPlan[], scan: TranscriptScan | undefined, cwd: string): BadPlan[] {
  if (!scan) return [];
  return bad.filter((b) => { const rel = path.relative(cwd, path.resolve(b.file)); return scan.writes.some((w) => sameFile(w, rel, cwd)) && !closedStatusOf(b); });
}

// The closed status ("abandoned", "awaiting-user") the raw JSON of an unreadable plan holds, or null when it holds none.
function closedStatusOf(b: BadPlan): PlanLifecycle | null {
  const life = lifecycleOf(readJsonOrNull(b.file, anyJson));
  return life === "pending" ? null : life;
}

// ================================================================ CLI

const USAGE = [
  `usage: ${scriptCmd("verify-build")}                     (Stop hook: reads the hook JSON from stdin when stdin is not a terminal)`,
  `       ${scriptCmd("verify-build")} <plan.json>…        check these plans now (no stdin read)`,
  `       ${scriptCmd("verify-build")} --status [<plan.json>…] [--json]   print each plan's computed status (all of design/plan/ by default); never writes`,
  "",
  "Blocks (exit 2) on: a raw colour the plan resolved to a token, in a source file of files[] (comments,",
  "prose strings and .svg/.json/non-source files are not scanned); a visible design node with no anchor",
  "(itself or an ancestor) in anchors{}; on web profiles, no data-dt-node tag in any plan's files[]",
  "(opt out: \"tagging\": {\"off\": true, \"reason\": \"…\"}); and a hand edit of verification.recorded, the block",
  "verify-screen --compare --record-plan writes whole (a key it does not write, a value of the wrong kind, or a",
  "verdict, count, mode, delta, … the report it names — same sha256 — does not say; re-run --compare --record-plan",
  "or restore the block; residuals go in deviations[]). Everything else is a warning (exit 0). Beside a recorded",
  "block, the keys it holds at verification's top level (mode, artifacts, deltas, a11y, …) and a hand",
  "headline/verdict are ignored.",
  "A Claude Code hook payload (it has hook_event_name) gets a block as {\"decision\":\"block\",\"reason\":…} on stdout",
  "and exit 0 instead — a native exit 2 under PowerShell reaches Claude Code as 1, which would not block.",
  "Hook mode checks the plans the stopping agent's own tool calls wrote (Write/Edit, plan-skeleton --out) and the",
  "plan that alone lists a file it wrote (Write/Edit); an agent that claims none checks nothing. A screen-builder's",
  "SubagentStop that claims none blocks once instead, naming the open plans: the builder runs verify-build <plan.json>",
  "on the plan it built and names it in its report (or says it built none); its next stop (stop_hook_active) passes,",
  "as does a builder whose transcript already holds that request or holds no tool call. A plan the agent wrote that",
  "cannot be read blocks (another unreadable plan is a warning, and so is one whose raw JSON says status abandoned or awaiting-user).",
  "Never writes plan.status: it records verification.hook {result, planHash, files:{path: sha256}}, and",
  "--status computes the status from that, the file hashes, and design/verify/<…>.report.json. First match wins:",
  "  1. abandoned | awaiting-user  set by a person in plan.status; nothing else is evaluated",
  "  2. failed       a verify-report@2 for this screen says fail (never hidden behind the hook's state)",
  "  3. pending      the hook has not checked this version of the plan (no hook record, or the plan changed since)",
  "  4. blocked      the Stop hook's last check blocked, or it passed and verification.recorded was edited by hand",
  "                  since (its next check blocks on that)",
  "  5. stale        a file in files[] or a module anchors/components map changed (by content) since the hook passed",
  "  6. unverified | static-only | verified | verified-with-deviations   what the report says: verified",
  "     only for an @2 'pass' that measured this design, these files and the plan's current waivers[]/",
  "     descopes[], by content hash (no report / a pre-@2 report / other design, code or waivers ->",
  "     unverified); verified-with-deviations when every report passes and >=1 says 'pass-with-deviations'.",
  "     A stored \"verified\" is ignored. waivers[]/descopes[] and verification{} are not part of the hook's",
  "     planHash (a hook record with the older formula, which hashed verification, is still accepted); a hand",
  "     edit of verification.recorded reopens the plan all the same.",
  "Every non-verified status carries a non-empty why: the hook's state AND what the report says (a",
  "report too old to trust is named with its schema). --json prints {plan, status, why, reasons, reports}.",
].join("\n");

interface RecordResult { blocking: string[]; warnings: string[]; cleared: PlanStoredStatus | null | undefined; status: StatusResult }

function checkAndRecord(p: PlanFile, cwd: string, graph?: () => ProjectGraph, locate?: LocateCache): RecordResult {
  const exp = locateExport(p.plan, p.file, cwd, locate);
  const reports = locateReports(p.plan, p.file, cwd, exp, locate);
  setPhase(`checking ${path.basename(p.file)}`);
  const { blocking, warnings, tagCoverage } = checkPlan(p, cwd, { export: exp, reports, ...(graph ? { graph } : {}) });
  const plan = p.plan;
  const cleared = storedComputed(plan);
  if (cleared) delete plan.status;
  if (!plan.verification) plan.verification = {};
  setPhase(`hashing files[] of ${path.basename(p.file)}`);
  // checkPlan has built the graph by now: the files it read are hashed from those bytes, not read again
  const cached = graph ? graph().cached : undefined;
  const hook: PlanHookRecord = {
    result: blocking.length ? "blocked" : "pass",
    checkedAt: new Date().toISOString(),
    blocking,
    warnings: warnings.length,
    planHash: contentHash.planHash(plan),
    files: planStatus(cwd, { cached }).codeHashes(plan),
    ...(tagCoverage ? { tagCoverage } : {}),
  };
  plan.verification.hook = hook;
  // The plan's mtime is the staleness clock — it measures the BUILDER's last edit. The hook's own
  // write must not reset it, or a blocked leftover plan would stay "fresh" (and nag) forever.
  const was: { times?: [Date, Date] } = {};
  let recorded: Plan = plan;
  try {
    // Under the plan's lock, onto the plan as it is on disk then (plan-record.ts updatePlan): only the hook record and
    // a stored computed status change, so an edit made while the checks ran is kept — and, its planHash differing
    // from this record's, reads as not yet checked. The mtime is taken from those same bytes, and put back right after
    // this write, still under the lock (an edit after the lock is released keeps its own mtime) — only when written.
    updatePlan(p.file, (raw) => {
      if (raw === null) throw new Error("it no longer exists");
      const fresh = parsePlanText(raw, p.file);
      try { const s = fs.statSync(p.file); was.times = [s.atime, s.mtime]; } catch { delete was.times; }
      if (storedComputed(fresh) !== null) delete fresh.status;
      fresh.verification = { ...fresh.verification, hook };
      recorded = fresh;
      return fresh;
    }, { afterWrite: () => { if (was.times) try { fs.utimesSync(p.file, was.times[0], was.times[1]); } catch { /* ignore */ } } });
  } catch (e) {
    // the checks above still stand (and still block); only their record is missing — the next stop checks again,
    // and the status printed now is the plan's without it
    const v = { ...plan.verification };
    delete v.hook;
    recorded = { ...plan, verification: v };
    warnings.push(`the hook record was not written into ${path.basename(p.file)} (${errMsg(e)}) — the plan stays pending until a check is recorded`);
  }
  if (graph) graph().rewrote(p.file); // a later plan that lists this one reads it from disk
  const st = planStatus(cwd, { cached }).status(recorded, { planFile: p.file, export: exp, reports });
  return { blocking, warnings, cleared, status: st };
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) { console.log(USAGE); return 0; }
  const OPTIONS = { status: { type: "boolean" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" } } as const;
  const { values: flags, positionals: planArgs } = cliParse("verify-build", argv, OPTIONS, USAGE, 2, (args) => parseArgs({ args, options: OPTIONS, allowPositionals: true }));
  if (flags.help) { console.log(USAGE); return 0; } // (-hh: the whole-word check above only sees -h)
  const statusMode = !!flags.status, json = !!flags.json;

  if (statusMode) {
    setPhase("computing plan status");
    const found = planArgs.length ? planArgs.map((f) => readPlan(path.resolve(f))) : null;
    const { plans, bad } = found ? { plans: found.filter(isPlanFile), bad: found.filter((p): p is BadPlan => !isPlanFile(p)) } : findPlans(process.cwd());
    const show = (f: string): string => { const r = path.relative(process.cwd(), f); return r.startsWith("..") ? f : r; };
    // An unreadable plan whose raw JSON holds a closed status is given up on, as the Stop hook treats it: skipped, not unreadable
    for (const b of bad) {
      const closed = closedStatusOf(b);
      console.error(closed ? `verify-build: ${show(b.file)} is "${closed}" — skipped (the file ${b.error})` : `verify-build: cannot read plan ${b.file}: ${b.error}`);
    }
    // The mapModules the code hash cannot follow — one note per plan, here only (the Stop hook stays quiet)
    const locate = locateCache(); // every plan's lookup shares one read of the reports and export indexes
    const rows = plans.map((p) => {
      const st = planStatus(rootOfPlan(p.file), { locate }).status(p.plan, { planFile: p.file });
      const skipped = contentHash.planCodeSkippedNote(p.plan, rootOfPlan(p.file));
      return Object.assign({ plan: show(p.file) }, st, skipped ? { reasons: [...st.reasons, `note: ${skipped}`] } : {});
    });
    if (json) console.log(JSON.stringify(rows.map((r) =>
      ({ plan: r.plan, status: r.status, why: r.reasons.join(" · ") || null, reasons: r.reasons, reports: r.reports.map((x) => ({ file: x.rel, verdict: x.verdict, matchedBy: x.matchedBy })) })), null, 2));
    else for (const r of rows) console.log(`${r.plan}: ${r.status}${r.reasons.length ? "\n  - " + r.reasons.join("\n  - ") : ""}`);
    if (!plans.length) console.error("verify-build: no plans found (design/plan/*.json)");
    return 0;
  }

  let input: HookPayload = {};
  let targets: PlanFile[] | undefined;
  if (planArgs.length) {
    const read = planArgs.map((f) => readPlan(path.resolve(f)));
    const bad = read.filter((p): p is BadPlan => !isPlanFile(p));
    if (bad.length) { console.error(`verify-build: cannot read plan(s): ${bad.map((b) => `${path.relative(process.cwd(), b.file) || b.file} (${b.error})`).join(", ")}`); return 1; }
    targets = read.filter(isPlanFile);
  } else {
    setPhase("reading the hook payload on stdin");
    const r = await readHookInput();
    if (r.error) { console.error(`verify-build: ${r.error}`); return 1; }
    input = r.payload || {};
    if (input.stop_hook_active) return 0; // avoid re-entrant loops on the same turn
  }

  // A real Claude Code payload (it names its event) gets a block as a JSON decision on stdout + exit 0, not exit 2: under
  // PowerShell (Windows without Git Bash runs shell-form hooks there) a native exit 2 reaches Claude Code as 1, a
  // non-blocking error, so the gate would never block. The reason is everything printed to stderr, which exit 2 delivered.
  const asDecision = typeof input.hook_event_name === "string";
  // A subagent (a screen-builder's SubagentStop) cannot ask the user: it hands the question back to the session that delegated it
  const thenAsk = input.hook_event_name === "SubagentStop"
    ? "then put the question in your report to the session that delegated this build" : "then ask the user";
  const said: string[] = [];
  const say = (s: string): void => { console.error(s); said.push(s); };
  const all: Array<{ p: PlanFile; cwd: string }> = [];
  const blockedOut: string[] = []; // `# <plan>` headers and the block items under each
  let checkBlocked = false; // some block comes from a plan's check (not only from unreadable plans)
  let hookCwd: string | null = null, hookPlans: PlanFile[] | undefined;
  if (targets) {
    for (const p of targets) {
      const cwd = rootOfPlan(p.file);
      const life = lifecycleOf(p.plan);
      if (life !== "pending") { console.error(`verify-build: ${path.basename(p.file)} is "${life}" — not checked`); continue; }
      all.push({ p, cwd });
    }
  } else {
    // (a hook payload's cwd is a string; anything else falls back to the process cwd)
    const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
    setPhase("finding open plans in design/plan/");
    const { plans, bad } = findPlans(cwd);
    hookCwd = cwd; hookPlans = plans;
    const open = plans.filter((p) => isOpen(p, cwd));
    if (!open.length && !bad.length) return 0; // fast path
    const own = ownPlans(open, input, plans, cwd);
    // A plan the hook cannot read is not checked — say so on every stop rather than skip it silently. One this session
    // wrote is its claim, and blocks: a warning on a stop that passes reaches no one (stderr on exit 0 is discarded).
    const badOwn = ownBadPlans(bad, own.scan, cwd);
    const fixIt = `fix it (${scriptCmd("plan-skeleton")} rewrites the skeleton fields and keeps what you filled)`;
    for (const b of bad) if (!badOwn.includes(b)) say(`verify-build: warning: ${path.relative(cwd, b.file)} ${b.error} — it was NOT checked; ${fixIt}`);
    for (const b of badOwn) {
      const rel = path.relative(cwd, b.file);
      blockedOut.push(`# ${path.basename(b.file)}`, `  - ${rel} ${b.error} — you wrote this plan and it cannot be read, so it was NOT checked; ${fixIt}, then run ${scriptCmd("verify-build")} ${rel}. `
        + `A plan you will not finish: set "status" to "abandoned" (or "awaiting-user", for a build paused on a question for the user, ${thenAsk}) in the file, which must be valid JSON, or move it out of design/plan/`);
    }
    if (!open.length && !badOwn.length) return 0;
    // An agent that claims none of the open plans checks nothing — unless it broke a plan of its own (blocked above).
    if (own.scope === "none-named" && !badOwn.length) {
      console.error(`verify-build: this session claimed no plan under design/plan/ (no Write/Edit or plan-skeleton --out of one, no Write/Edit of a file only one plan lists) — nothing checked (${open.length} open ` +
        `plan(s) belong to other sessions; check one by hand with ${scriptCmd("verify-build")} <plan.json>)`);
      // An orchestrator claiming nothing is normal; a screen-builder claiming nothing is a build the gate never saw. Its
      // tool calls name no plan of their own, so no other reader of them (the main session's Stop, a ledger) could claim
      // one either: only the builder knows which plan it built. So its SubagentStop blocks ONCE, and the reason — which
      // Claude Code delivers to the subagent as its next instruction — has it check its plan by hand and name the plan in
      // its report. Its next stop carries stop_hook_active and returns above, so this never loops; a transcript that
      // already holds this reason is not asked again whatever the payload says. An agent with no tool call at all is not
      // a build — an internal agent (prompt suggestions, a side question) reports the session's own agent_type under
      // `claude --agent` — so it is not sent back.
      if (input.hook_event_name === "SubagentStop" && typeof input.agent_type === "string" && BUILDER_AGENT.test(input.agent_type)
        && own.scan && own.scan.toolUses > 0 && !own.scan.sentBack) {
        const names = open.map((p) => path.relative(cwd, p.file).replace(/\\/g, "/"));
        console.log(JSON.stringify({ decision: "block", reason: `verify-build: you (${input.agent_type}) ${NO_CLAIM_MARK}. `
          + `Open plan(s): ${names.slice(0, 6).join(", ")}${names.length > 6 ? `, +${names.length - 6} more` : ""}. `
          + "A builder's plan is the one it writes with Write/Edit or creates with plan-skeleton --out (or the one plan listing a file it writes with Write/Edit); "
          + "shell edits (sed, cp, a redirect) are not read. Before you stop: if you built one of these plans, run "
          + `${scriptCmd("verify-build")} <that plan.json>, fix what it blocks on, and name the plan and its result in your report; `
          + "if you built none of them, say so in your report. This is asked once: your next stop is not checked again." }));
      }
      return 0;
    }
    for (const p of own.plans) all.push({ p, cwd });
  }

  const lines: string[] = [];
  // A warning several plans share (a merged token on a shared theme) is printed ONCE, naming them all.
  const warned = new Map<string, string[]>();
  const graphs = new Map<string, ProjectGraph>(); // built once per project root per run, on first use
  // One read of the reports and export indexes for every plan checked: checkAndRecord writes only the plan's own hook
  // record, never a report, an expectation or an export, so what the cache holds stays true for the whole loop.
  const locate = locateCache();
  for (const { p, cwd } of all) {
    // the hook's own cwd has its plans parsed already (findPlans above); a plan named on the command line is found again
    const res = checkAndRecord(p, cwd, () => getOrInit(graphs, cwd, () => planGraph(cwd, [], cwd === hookCwd ? hookPlans : undefined)), locate);
    const name = path.basename(p.file);
    if (res.cleared) say(`verify-build: ${name}: removed the stored "status": "${res.cleared}" — status is computed now (${scriptCmd("verify-build")} --status), never stored`);
    for (const w of res.warnings) getOrInit(warned, w, () => []).push(name);
    if (res.blocking.length) { checkBlocked = true; blockedOut.push(`# ${name}`, ...res.blocking.map((m) => `  - ${m}`)); }
    const why = res.blocking.length ? "see below" : res.status.reasons[res.status.reasons.length - 1];
    lines.push(`verify-build: ${name}: hook ${res.blocking.length ? "BLOCKED" : "passed"} · computed status: ${res.status.status}${why ? ` — ${why}` : ""}`);
  }
  for (const [w, names] of warned) say(`verify-build: warning (${names.join(", ")}): ${w}`);
  for (const l of lines) say(l);
  if (blockedOut.length) {
    say("\nverify-build: build-screen check failed — do not report this screen as done until these are resolved");
    // Setting a status closes a plan the hook can read; an unreadable plan has its own way out, stated in its item.
    if (checkBlocked) say(`(a plan that will not be finished: set its status to "abandoned", or move it out of design/plan/; a build paused on a question for the user: "awaiting-user", ${thenAsk}):\n`);
    else say("");
    say(blockedOut.join("\n"));
    if (!asDecision) return 2;
    console.log(JSON.stringify({ decision: "block", reason: said.join("\n") }));
  }
  return 0;
}

// The hook's checks, exported for the tests that drive each one directly. Source scanning is code-scanner.ts's and token
// names are token-naming.ts's; the locate / record / status functions are imported from their own modules.
export {
  checkPlan, anchorCoverage, validatePlanHeader, auditGateWarnings, legacySetWarnings, deviationWarnings, deviationConflicts,
  verificationWarnings, recordedReportWarnings, recordedShadowWarnings, verificationContradictions, behaviourWarnings,
  isStale, ownPlans, forEachLine, mayHoldToolUse, transcriptActions, planSkeletonOuts, main,
};

if (import.meta.main) {
  // A step that hangs: say so and end, with what was printed so far flushed first (exitFlushed, capped — never a bare
  // exit(), which drops what a pipe has not taken yet).
  const watchdog = setTimeout(() => {
    console.error(`verify-build: gave up after ${Math.round(HOOK_TIMEOUT_MS() / 1000)} s while ${phase} — nothing was blocked; re-run \`${scriptCmd("verify-build")} <plan.json>\` to check the plan directly`);
    exitFlushed(1);
  }, HOOK_TIMEOUT_MS());
  watchdog.unref();
  // exitCode, not exit() (runCli): a pipe write is asynchronous (macOS under Node; everywhere under Bun once the pipe is
  // full), and exit() would cut a long --json listing or the itemised block message short. stdin is paused+unref'd and
  // the watchdog unref'd, so nothing keeps the process alive once main() is done.
  runCli(main, { name: "verify-build" });
}
