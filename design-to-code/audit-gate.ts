// audit-gate.ts — shared "which audit file belongs to this screen, and what does it block" logic for
// plan-skeleton.ts (pre-fills auditGate) and verify-build.ts (warns when a Blocked audit is not
// covered by one). Without it the plan schema has nowhere to record "audit blocker acknowledged and
// overridden, here is why" — a build that reads an existing Blocked audit and proceeds would look, on
// disk, identical to one that never read it.
//
// Which audit file is the screen's is node-artefacts.ts auditFor: the screen file's own name (audit.ts names its default
// output `design/audit/<input file's basename>.json`, the `<LayerName>__<node-id>` name write-out.ts gave the screen
// file), else the report whose nodeIds[] has the node — the same rule audit.ts refuses a second report by — else an older
// plain-slug report (`positions.json`) by the exact slug of the screen's name.
import path from "node:path";
import { findingIds, legacyBlockerIds } from "./finding-id.ts";
import { isJsonObject } from "./types.ts";
import type { JsonValue } from "./types.ts";
import { ifDefined } from "../bridge/src/json-util.ts";
import { isAuditReport } from "./doc-guards.ts";
import { readJson } from "../bridge/src/read-json.ts";
import { nodeArtefacts } from "./node-artefacts.ts";

/** What auditGateStatus knows about a screen's audit file. */
export interface AuditGateStatus {
  auditFile: string | null;
  /** the ids (finding-id.ts) of the report's blockers, in report order */
  blockers: string[];
  /** the same blockers' older positional ids (`<code>#<i>`), index for index — a plan written against
   *  them still covers its blockers */
  legacyBlockers: string[];
  unreadable?: true;
  /** why it is unreadable (bridge/src/read-json.ts wording: "is not valid JSON — …", "is not an audit report …") */
  error?: string;
}

// The id of each blocker finding, so a plan's `auditGate.overridden` can name exactly
// which blocker(s) the user decided to build past. It is the finding's own `id` (audit.ts writes one); an
// older report has none, and gets the same rule (finding-id.ts findingIds) computed over ALL
// its findings in report order. What plan-skeleton.ts pre-fills and verify-build.ts checks against (which
// also still accepts the older positional `<code>#<i>`, finding-id.ts legacyBlockerIds).
// Takes anything (an audit report, or whatever a caller read off disk): only `findings[]` is looked at.
function blockerIds(auditDoc: unknown): string[] {
  const findings = reportFindings(auditDoc);
  const ids = findingIds(findings.map((f) => ({ code: f.code || "blocker", nodeId: f.nodeId })));
  return findings.flatMap((f, i) => f.severity === "blocker" ? [f.id || ids[i] || f.code || "blocker"] : []);
}
/** A report's `findings[]` as far as ids go (anything else in an entry is ignored; a non-object entry is dropped). */
function reportFindings(auditDoc: unknown): Array<{ code?: string; nodeId?: string; severity?: string; id?: string }> {
  const findings: unknown[] = (auditDoc && typeof auditDoc === "object" && "findings" in auditDoc && Array.isArray(auditDoc.findings)) ? auditDoc.findings : [];
  const str = (v: JsonValue | undefined): string | undefined => typeof v === "string" && v ? v : undefined;
  return findings.filter(isJsonObject).map((f) => ({ ...ifDefined("code", str(f.code)), ...ifDefined("nodeId", str(f.nodeId)), ...ifDefined("severity", str(f.severity)), ...ifDefined("id", str(f.id)) }));
}

function auditGateStatus(cwd: string, nodeId: string | null | undefined, screenFile: string | null | undefined, screenName: string | null | undefined): AuditGateStatus {
  const rel = nodeArtefacts(cwd).auditFor(nodeId, { screenFile, screenName });
  if (!rel) return { auditFile: null, blockers: [], legacyBlockers: [] };
  // An audit report (audit.ts --out). A file there that cannot be read, or is not an audit report, is
  // `unreadable` — never "no blockers".
  const r = readJson(path.join(cwd, rel), isAuditReport);
  if (!("doc" in r)) return { auditFile: rel, blockers: [], legacyBlockers: [], unreadable: true, error: r.error };
  return { auditFile: rel, blockers: blockerIds(r.doc), legacyBlockers: legacyBlockerIds(reportFindings(r.doc)) };
}

export { auditGateStatus, blockerIds };
