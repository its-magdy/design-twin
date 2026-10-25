// audit-gate.ts — the audit report seen from a plan. A build that reads a Blocked audit and proceeds must look, on disk,
// different from one that never read it: the plan's `auditGate` records which blockers a person decided to build past
// and why. This module owns every rule about that record, and the two callers only render it — plan-skeleton.ts writes
// the gate a skeleton pre-fills (and keeps a person's decision across re-runs), verify-build.ts turns the verdict into
// warnings (never a `blocking` entry: the gate is advice the hook makes visible, not a refusal).
//
//   1) WHICH report, and its family. The screen's report is node-artefacts.ts auditFor: the screen file's own name (audit.ts
//      names its default output `design/audit/<input file's basename>.json`, the `<LayerName>__<node-id>` name write-out.ts
//      gave the screen file), else the report whose nodeIds[] has the node — the same rule audit.ts refuses a second report
//      by — else an older plain-slug report (`positions.json`) by the exact slug of the screen's name. Beside a report
//      `<stem>.json` sit its sidecars `<stem>.<kind>.json` (cross-check's `.cross`, a library run's `.library`) and the
//      overrides a run reads (overridesFileOf: a sidecar run with no overrides file of its own reads its report's).
//   2) WHAT it blocks: blockerIds — each blocker finding's id (finding-id.ts), and the older positional ids beside them.
//   3) WHETHER a plan's auditGate covers it: judgeGate's verdict. A blocker is covered by its id (`code` / `code@nodeId`,
//      + `~n`) — also the bare code a person writes for a node-less finding — or by its older positional id (`code#i`),
//      so an older plan's decision still stands; a positional entry is reported either way, since a position shifts.
//   4) THE GATE a skeleton writes (gatePrefill) and how a re-run keeps a decision (mergeGate).
import fs from "node:fs";
import path from "node:path";
import { findingIds, legacyBlockerIds } from "./finding-id.ts";
import { isJsonObject } from "./types.ts";
import type { JsonValue, PlanAuditGate } from "./types.ts";
import { ifDefined } from "../bridge/src/json-util.ts";
import { isAuditReport } from "./doc-guards.ts";
import { readJson } from "../bridge/src/read-json.ts";
import { nodeArtefacts } from "./node-artefacts.ts";

// ---------------------------------------------------------------- the report's family
const OVERRIDES = ".overrides.json";

/** The cross-check report beside an audit report (`<stem>.cross.json`), where cross-file findings carry the same ids. */
export const crossCheckFileOf = (auditFile: string): string => auditFile.replace(/\.json$/, ".cross.json");

/** The overrides file an audit run writing `<outBase>.json` reads: its own `<outBase>.overrides.json`, else — a sidecar
 *  run (`--out <dir>/<report>.<kind>`, e.g. `.library`) with none of its own — its report's `<report>.overrides.json`
 *  when that one is there. */
export function overridesFileOf(outBase: string, exists: (file: string) => boolean = fs.existsSync): string {
  const own = outBase + OVERRIDES;
  const stem = path.basename(outBase), dot = stem.indexOf(".");
  const parent = dot > 0 ? path.join(path.dirname(outBase), stem.slice(0, dot) + OVERRIDES) : null;
  return !exists(own) && parent !== null && exists(parent) ? parent : own;
}

// ---------------------------------------------------------------- what a report blocks
/** A report's `findings[]` as far as ids go (anything else in an entry is ignored; a non-object entry is dropped). */
function reportFindings(auditDoc: unknown): Array<{ code?: string; nodeId?: string; severity?: string; id?: string }> {
  const findings: unknown[] = (auditDoc && typeof auditDoc === "object" && "findings" in auditDoc && Array.isArray(auditDoc.findings)) ? auditDoc.findings : [];
  const str = (v: JsonValue | undefined): string | undefined => typeof v === "string" && v ? v : undefined;
  return findings.filter(isJsonObject).map((f) => ({ ...ifDefined("code", str(f.code)), ...ifDefined("nodeId", str(f.nodeId)), ...ifDefined("severity", str(f.severity)), ...ifDefined("id", str(f.id)) }));
}

/** The id of each blocker finding, in report order — what a plan's `auditGate.overridden` names. It is the finding's own
 *  `id` (audit.ts writes one); an older report has none, and gets the same rule (finding-id.ts findingIds) computed over
 *  ALL its findings in report order. Takes anything read off disk: only `findings[]` is looked at. */
export function blockerIds(auditDoc: unknown): string[] {
  const findings = reportFindings(auditDoc);
  const ids = findingIds(findings.map((f) => ({ code: f.code || "blocker", nodeId: f.nodeId })));
  return findings.flatMap((f, i) => f.severity === "blocker" ? [f.id || ids[i] || f.code || "blocker"] : []);
}

/** A screen, as its audit is looked up (node-artefacts.ts auditFor's hints). */
export interface GateScreen { nodeId?: string | null | undefined; screenFile?: string | null | undefined; screenName?: string | null | undefined }

/** The screen's audit report, located and read. Paths are project-relative ("/"), as a plan records them. */
export type ScreenAudit =
  | { readonly status: "none" }
  /** there, but not readable as an audit report — it gates nothing, which is never "no blockers" */
  | { readonly status: "unreadable"; readonly auditFile: string; readonly error: string }
  | {
    readonly status: "read";
    readonly auditFile: string;
    /** the ids of the report's blockers, in report order */
    readonly blockers: readonly string[];
    /** the same blockers' older positional ids (`<code>#<i>`), index for index */
    readonly legacyBlockers: readonly string[];
    /** its cross-check sidecar, when one is there */
    readonly crossCheckFile: string | null;
  };

/** The audit report of `screen` in the project at `cwd`. Never throws: a lookup that fails finds none. */
export function screenAudit(cwd: string, screen: GateScreen): ScreenAudit {
  let rel: string | null;
  try { rel = nodeArtefacts(cwd).auditFor(screen.nodeId, { screenFile: screen.screenFile, screenName: screen.screenName }); } catch { return { status: "none" }; }
  if (!rel) return { status: "none" };
  const r = readJson(path.join(cwd, rel), isAuditReport);
  if (!("doc" in r)) return { status: "unreadable", auditFile: rel, error: r.error };
  const cross = crossCheckFileOf(rel);
  return {
    status: "read", auditFile: rel, blockers: blockerIds(r.doc), legacyBlockers: legacyBlockerIds(reportFindings(r.doc)),
    crossCheckFile: cross !== rel && fs.existsSync(path.join(cwd, cross)) ? cross : null,
  };
}

// ---------------------------------------------------------------- the verdict on a plan's auditGate
/** The overridden entries that name a blocker by its older positional id: each that covers a blocker only that way
 *  (`old` → its stable `id`), and each that matches no current blocker. */
export interface LegacyCover { readonly via: ReadonlyArray<{ old: string; id: string }>; readonly stale: readonly string[] }

/** What the gate says about a plan's auditGate against the screen's audit. */
export type GateVerdict =
  /** nothing to gate: no report, or one that blocks nothing */
  | { readonly status: "clear" }
  /** a report is there but unreadable: the gate was not checked */
  | { readonly status: "unchecked"; readonly auditFile: string; readonly error: string }
  /** the report blocks, and the plan has no auditGate */
  | { readonly status: "ungated"; readonly auditFile: string; readonly blockers: readonly string[] }
  /** blockers the auditGate does not override, by their stable ids */
  | { readonly status: "uncovered"; readonly auditFile: string; readonly uncovered: readonly string[]; readonly legacy: LegacyCover }
  /** every blocker overridden, with no reason given */
  | { readonly status: "unreasoned"; readonly auditFile: string; readonly overridden: number; readonly legacy: LegacyCover }
  /** every blocker overridden, with a reason */
  | { readonly status: "covered"; readonly auditFile: string; readonly legacy: LegacyCover };

const POSITIONAL = /^[^@#~]+#\d+$/;

/** The verdict on `gate` (a plan's auditGate, as a person left it) against `audit`. */
export function judgeGate(audit: ScreenAudit, gate: PlanAuditGate | null | undefined): GateVerdict {
  if (audit.status === "none") return { status: "clear" };
  if (audit.status === "unreadable") return { status: "unchecked", auditFile: audit.auditFile, error: audit.error };
  const { auditFile, blockers, legacyBlockers } = audit;
  if (!blockers.length) return { status: "clear" };
  if (!gate) return { status: "ungated", auditFile, blockers };
  const overridden = new Set<unknown>(Array.isArray(gate.overridden) ? gate.overridden : []);
  const legacySet = new Set(legacyBlockers);
  // The positional id is still accepted, but it is not stable — it is the blocker's position among ALL blockers, so
  // fixing an earlier one shifts it onto a different blocker and the old entry silently covers that one.
  const via: Array<{ old: string; id: string }> = [];
  blockers.forEach((id, i) => {
    const old = legacyBlockers[i];
    if (old !== undefined && !overridden.has(id) && overridden.has(old)) via.push({ old, id });
  });
  const stale = [...overridden].filter((e): e is string => typeof e === "string" && POSITIONAL.test(e) && !legacySet.has(e));
  const legacy: LegacyCover = { via, stale };
  const uncovered = blockers.filter((id, i) => !overridden.has(id) && !overridden.has(legacyBlockers[i] ?? id));
  if (uncovered.length) return { status: "uncovered", auditFile, uncovered, legacy };
  if (!gate.reason) return { status: "unreasoned", auditFile, overridden: overridden.size, legacy };
  return { status: "covered", auditFile, legacy };
}

// ---------------------------------------------------------------- the gate a skeleton writes
/** The auditGate a fresh plan skeleton writes for the screen: every blocker to decide on, nothing decided (a person fills
 *  overridden / reason / decidedBy / decidedAt) — null when the audit blocks nothing, is not there, or cannot be read. */
export function gatePrefill(audit: ScreenAudit): Required<PlanAuditGate> | null {
  if (audit.status !== "read" || !audit.blockers.length) return null;
  return { auditFile: audit.auditFile, crossCheckFile: audit.crossCheckFile, verdict: "blocked", blockers: [...audit.blockers], overridden: [], reason: null, decidedBy: null, decidedAt: null };
}

/** A re-run's gate. The skeleton owns what it READ — auditFile, crossCheckFile, blockers (the audit's current ids) — and
 *  a person owns the decision: overridden / reason / decidedBy / decidedAt / verdict are never touched (keeping the whole
 *  old gate would freeze its blockers at the ids of the first run). With no fresh gate (no audit file now, or no blockers
 *  left in it) the old one stays as it was: a decision is never cleared. */
export function mergeGate(prev: PlanAuditGate | null | undefined, fresh: Required<PlanAuditGate> | null): PlanAuditGate | null {
  if (!prev || typeof prev !== "object") return fresh;
  if (!fresh) return prev;
  return { ...prev, auditFile: fresh.auditFile, crossCheckFile: fresh.crossCheckFile, blockers: fresh.blockers };
}
