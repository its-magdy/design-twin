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
import { blockerIds, reportFindings } from "./audit.ts";
import { legacyBlockerIds } from "./finding-id.ts";
import { isAuditReport } from "./doc-guards.ts";
import { readJson } from "./read-json.ts";
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
  /** why it is unreadable (read-json.ts wording: "is not valid JSON — …", "is not an audit report …") */
  error?: string;
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
