// owner-decisions.ts — the owner's decisions on a verify report, and their whole life. ONE module for:
//   - what may be accepted (whyNotWaivable): a measured delta only — never an absent component, a failed interaction, or
//     a node or value that was not measured. --accept refuses by it; --compare says by it why a waiver matches nothing;
//   - --accept (selectForAccept, then acceptInto): the report's delta(s) picked, and one plan.waivers[] row per node +
//     field written from each — bound to the export content and the designed and built values, a new decision replacing
//     the old one;
//   - --compare (descopeRound, then waiverRound): each row matched to this round — a descope to a designed interaction
//     (removed from the graded set), a waiver to its delta within the field's tolerance (accepted, still listed) — or
//     reopened (re-exported, the designed or built value moved) or unused (nothing to match, and why);
//   - the hash a report records of them (waiversHash; report-freshness.ts judges a report stale by waiversChanged). The Stop
//     hook's plan hash (content-hash.ts planHash) leaves plan.waivers/descopes out: accepting is not editing the plan.
// No file reads or writes: --accept writes the rows acceptInto returns under the plan's lock (plan-record.ts updatePlan).
import { sha256Hex } from "../bridge/src/hash.ts";
import { canonical, ifDefined } from "../bridge/src/json-util.ts";
import { isPlanDescope, isPlanWaiver } from "./doc-guards.ts";
import { TOLERANCE, fmt, toleranceOf } from "./verify-shared.ts";
import { isJsonObject } from "./types.ts";
import type { JsonValue, Plan, PlanDescope, PlanWaiver, VerifyDelta, VerifyInteraction, VerifyReport, VerifyReportV2 } from "./types.ts";

// ---------------------------------------------------------------- the hash a report records

/** sha256 (hex) of the canonical JSON of {waivers, descopes}; `[]`, absent or non-array hash as the empty set. */
export function waiversHash(plan: Plan | null | undefined): string {
  const waivers = Array.isArray(plan?.waivers) ? plan.waivers : [];
  const descopes = Array.isArray(plan?.descopes) ? plan.descopes : [];
  return sha256Hex(canonical({ descopes, waivers }));
}
/** Whether the plan's decisions are not the ones a report recorded (`recorded`: its inputs.waivers.sha256 — a report that
 *  recorded none applied none). */
export function waiversChanged(recorded: string | null | undefined, plan: Plan | null | undefined): boolean {
  return (recorded || waiversHash(null)) !== waiversHash(plan);
}

// ---------------------------------------------------------------- what may be accepted

/** What a round could not grade as a delta — the one list of what is never waivable. */
export interface WaiverGaps {
  notMeasured: ReadonlyArray<{ nodeId: string }>;
  fieldsNotMeasured: ReadonlyArray<{ nodeId: string; field: string }>;
  interactionsFailed: ReadonlyArray<{ nodeId: string }>;
  componentsAbsent: ReadonlyArray<{ setName: string; nodeIds: string[] }>;
}
/** Why node `nodeId` (its `field`, when one is named) has nothing a waiver can accept — null: no such gap. The node's own
 *  gap wins (an absent component, then a failed interaction, then the node not measured), then the field's. */
export function whyNotWaivable(gaps: WaiverGaps, nodeId: string, field?: string): string | null {
  const absent = gaps.componentsAbsent.find((c) => c.nodeIds.includes(nodeId));
  if (absent) return `component set '${absent.setName}' is reported ABSENT — a missing component is never waivable; build it`;
  if (gaps.interactionsFailed.some((i) => i.nodeId === nodeId)) return "a failed interaction is never waivable — fix it, or have the owner descope it (plan.descopes) if it is deliberately inert";
  if (gaps.notMeasured.some((n) => n.nodeId === nodeId)) return "the node was not measured — only a measured delta can be accepted; measure it (or fold it: plan anchor foldedInto) first";
  if (field !== undefined && gaps.fieldsNotMeasured.some((g) => g.nodeId === nodeId && g.field === field)) return "that value was not measured this round — only a measured delta can be accepted";
  return null;
}
/** A report's gaps, as whyNotWaivable reads them (a report read from disk may lack any list). */
const gapsOfReport = (rep: VerifyReport): WaiverGaps => ({
  notMeasured: rep.notMeasured || [], fieldsNotMeasured: rep.fieldsNotMeasured || [], componentsAbsent: rep.componentsAbsent || [],
  interactionsFailed: (rep.interactions || []).filter((i) => i.result === "fail"),
});

// ---------------------------------------------------------------- --accept: the write side

/** --accept's selection: the report deltas one waiver row each is written for, or why there are none. */
export function selectForAccept(rep: VerifyReport, sel: { node?: string | undefined; field?: string | undefined; group?: string | undefined }): { deltas: VerifyDelta[] } | { error: string } {
  // a report whose run failed its integrity checks graded numbers nothing ties to this design and run — a
  // waiver written from it would bind to values that may never have been rendered
  // the integrity reasons compare recorded (report.integrity, [] for a clean run); a report without the field cannot
  // show its run was verified, so nothing in it is accepted
  const integrity = rep.integrity;
  if (!Array.isArray(integrity)) return { error: "the report records no integrity[] — nothing says whether its run was verified; re-run --compare, then accept against the new report" };
  if (integrity.length) return { error: `the report's run is unverified (${integrity.join("; ")}) — nothing in it can be accepted; re-measure and --compare, then accept against the new report` };
  const deltas: VerifyDelta[] = Array.isArray(rep.deltas) ? rep.deltas : [];
  const picked = sel.group !== undefined ? deltas.filter((d) => d.group === sel.group)
    : deltas.filter((d) => d.nodeId === sel.node && (sel.field === undefined || d.field === sel.field));
  if (picked.length) return { deltas: picked };
  if (sel.group !== undefined) {
    const gs = [...new Set(deltas.map((d) => d.group).filter((g): g is string => !!g))];
    return { error: `no delta in the report belongs to group '${sel.group}'${gs.length ? ` (groups: ${gs.join(", ")})` : " (the report has no groups)"}` };
  }
  const id = String(sel.node);
  // Not a delta = not waivable: say which kind of item it is instead.
  const why = whyNotWaivable(gapsOfReport(rep), id, sel.field);
  if (why !== null) return { error: `${id}${sel.field !== undefined ? ` (${sel.field})` : ""}: ${why}` };
  const fields = deltas.filter((d) => d.nodeId === id).map((d) => d.field);
  return { error: `no delta in the report for ${id}${sel.field !== undefined ? ` field '${sel.field}'` : ""}${fields.length ? ` (its deltas: ${fields.join(", ")})` : ""}` };
}

/** Who accepted, why and when, against which export — what every row --accept writes carries. */
export interface AcceptDecision { exportContentSha256: string; reason: string; decidedBy: string; decidedAt: string; cause?: string | undefined }
/** The plan's waivers[] with one row per node + field written from each delta (a new decision replaces the old one, in
 *  place; other rows, malformed ones included, are kept as they are), and for each delta whether it replaced a row. */
export function acceptInto(waivers: PlanWaiver[] | undefined, deltas: readonly VerifyDelta[], decision: AcceptDecision): { waivers: PlanWaiver[]; wrote: Array<{ delta: VerifyDelta; replaced: boolean }> } {
  const { exportContentSha256, reason, decidedBy, decidedAt, cause } = decision;
  const out: PlanWaiver[] = Array.isArray(waivers) ? [...waivers] : [];
  const wrote: Array<{ delta: VerifyDelta; replaced: boolean }> = [];
  for (const d of deltas) {
    const row: PlanWaiver = { nodeId: d.nodeId, field: d.field, designed: d.expected, built: d.actual, exportContentSha256, reason, decidedBy, decidedAt, ...ifDefined("cause", cause) };
    const at = out.findIndex((w) => isJsonObject(w) && w.nodeId === d.nodeId && w.field === d.field);
    if (at >= 0) out[at] = row; else out.push(row);
    wrote.push({ delta: d, replaced: at >= 0 });
  }
  return { waivers: out, wrote };
}

// ---------------------------------------------------------------- --compare: the rows matched to this round

type Reopened = VerifyReportV2["waivers"]["reopened"];
type Unused = VerifyReportV2["waivers"]["unused"];
/** What a round made of the plan's rows: the input notes (a malformed row is ignored, said once) and the rows reopened or
 *  unused, in the order the report lists them. */
export interface DecisionOutcome { notes: string[]; reopened: Reopened; unused: Unused }

const REEXPORTED = (what: string): string => `design re-exported: the export content changed since ${what}`;

type DesignedInteraction = Pick<VerifyInteraction, "nodeId" | "trigger" | "destinationId">;
/** The descopes of a round's designed interactions: `descopeOf(i)` — for one of the interactions given — is the descope
 *  that removes it from the graded set while the design is the one it was descoped against (a hit on another export is
 *  reopened, the interaction graded); a descope that matches no designed interaction is unused. Matched by node, trigger
 *  (case-insensitive) and, when the row names one, destination. */
export function descopeRound<I extends DesignedInteraction>(rows: readonly unknown[], interactions: readonly I[], exportSha: string | undefined):
  DecisionOutcome & { descopeOf: (i: I) => PlanDescope | undefined } {
  const notes: string[] = [], reopened: Reopened = [], unused: Unused = [];
  const descopes: PlanDescope[] = [];
  rows.forEach((d, i) => { if (isPlanDescope(d)) descopes.push(d); else notes.push(`plan descopes[${i}] is not ${isPlanDescope.expected}; ignored`); });
  const used = new Set<PlanDescope>();
  const descoped = new Map<I, PlanDescope>();
  for (const i of interactions) {
    const hits = descopes.filter((d) => d.nodeId === i.nodeId && d.trigger.toLowerCase() === i.trigger && (d.destinationId === undefined || d.destinationId === i.destinationId));
    for (const d of hits) used.add(d);
    const live = hits.find((d) => d.exportContentSha256 === exportSha);
    if (live) descoped.set(i, live);
    else for (const d of hits) reopened.push({ nodeId: d.nodeId, field: `interaction (${d.trigger})`, why: REEXPORTED("it was descoped") });
  }
  for (const d of descopes) if (!used.has(d)) unused.push({ nodeId: d.nodeId, field: `interaction (${d.trigger})`, why: "no designed interaction with this node and trigger this round" });
  return { notes, reopened, unused, descopeOf: (i) => descoped.get(i) };
}

/** The slack a waiver's designed/built values are matched with — the field's own tolerance (null = exact). */
function waiverTolerance(label: string): number | null {
  // a property's own (verify-shared.ts PROPERTIES — a per-side or per-corner field included), else the derived rows'
  const own = toleranceOf(label);
  if (own !== undefined) return own;
  if (label === "placement") return TOLERANCE.position;
  if (label === "match (size)") return TOLERANCE.size;
  if (label === "overflowX") return TOLERANCE.position;
  return null;
}
const NUM_IN_TEXT = /-?\d+(?:\.\d+)?/g;
/** Equal within `tol`: numbers by distance, lists item by item, strings exactly — or, with a tolerance, with
 *  every number in them within it (a placement actual "bottom edge at y=1450 in a 900-high frame"). */
function sameWithin(a: JsonValue, b: JsonValue, tol: number | null): boolean {
  const t = tol ?? 0;
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= t + 1e-9;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => { const y = b[i]; return y !== undefined && sameWithin(x, y, tol); });
  if (typeof a === "string" && typeof b === "string") {
    if (tol == null) return a.trim() === b.trim();
    if (a.replace(NUM_IN_TEXT, "#") !== b.replace(NUM_IN_TEXT, "#")) return false;
    const na = a.match(NUM_IN_TEXT) || [], nb = b.match(NUM_IN_TEXT) || [];
    return na.length === nb.length && na.every((x, i) => Math.abs(Number(x) - Number(nb[i])) <= t + 1e-9);
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The round a waiver is matched against: its deltas (an applied waiver marks its delta `accepted`), the export it was
 *  graded on, what it could not grade (whyNotWaivable), and the TEXT nodes whose width is compared at its ink width. */
export interface WaiverRound { deltas: VerifyDelta[]; exportSha: string | undefined; gaps: WaiverGaps; inkWidthNodes: ReadonlySet<string> }
/** The plan's waivers on a round: each accepts ONE delta (node + field) while the design is the one it was accepted
 *  against (whole-export hash), the designed value is the same and the built value has not moved beyond its tolerance —
 *  that delta gets `accepted` (it stays listed, out of the counts). Anything else reopens it; a waiver with no delta of its
 *  node and field is unused, with why. Returns how many were applied. */
export function waiverRound(rows: readonly unknown[], round: WaiverRound): DecisionOutcome & { applied: number } {
  const { deltas, exportSha, gaps, inkWidthNodes } = round;
  const notes: string[] = [], reopened: Reopened = [], unused: Unused = [];
  let applied = 0;
  rows.forEach((w, i) => {
    if (!isPlanWaiver(w)) { notes.push(`plan waivers[${i}] is not ${isPlanWaiver.expected}; ignored`); return; }
    const cands = deltas.filter((d) => d.nodeId === w.nodeId && d.field === w.field && !d.accepted);
    if (!cands.length) {
      // a waiver on a TEXT width written against the old field — the field is the ink width, a different value
      const inkNow = w.field === "width" && (deltas.some((d) => d.nodeId === w.nodeId && d.field === "width (text ink)") || inkWidthNodes.has(w.nodeId))
        ? "this TEXT's width is compared as 'width (text ink)' — re-accept against the new report" : undefined;
      unused.push({ nodeId: w.nodeId, field: w.field, why: whyNotWaivable(gaps, w.nodeId, w.field) ?? inkNow ?? "no such delta this round — fixed? drop the waiver" });
      return;
    }
    if (!exportSha || w.exportContentSha256 !== exportSha) {
      reopened.push({ nodeId: w.nodeId, field: w.field, why: exportSha ? REEXPORTED("the waiver was accepted") : "the expectation records no export content hash — regenerate it with --expect" });
      return;
    }
    const tol = waiverTolerance(w.field);
    const d = cands.find((x) => sameWithin(w.designed, x.expected, tol) && sameWithin(w.built, x.actual, w.tolerance ?? tol));
    if (d) {
      d.accepted = { reason: w.reason, decidedBy: w.decidedBy, decidedAt: w.decidedAt, ...ifDefined("cause", w.cause) };
      applied++;
      return;
    }
    const c0 = cands.find((x) => sameWithin(w.designed, x.expected, tol));
    reopened.push({ nodeId: w.nodeId, field: w.field,
      why: c0 ? `built value moved: was ${fmt(w.built)}, now ${fmt(c0.actual)}` : `designed value changed: was ${fmt(w.designed)}, now ${fmt(cands[0]?.expected)}` });
  });
  return { notes, reopened, unused, applied };
}
