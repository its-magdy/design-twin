// audit-gate.ts — shared "which audit file belongs to this screen, and what does it block" logic for
// plan-skeleton.ts (pre-fills auditGate) and verify-build.ts (warns when a Blocked audit is not
// covered by one). Finding 136 (livetest-3): there was nowhere in the plan schema to record "audit
// blocker acknowledged and overridden, here is why" — a build that reads an existing Blocked audit and
// proceeds looked, on disk, identical to one that never read it.
//
// audit.ts's own CLI names its default output `design/audit/<input file's own basename>.json` — the
// same `<LayerName>__<node-id>` name write-out.js gave the screen file — so that is tried first. Older
// runs (this repo's own livetest fixtures included) wrote a plain slug (`positions.json`,
// `System_Configurations.json`) instead; those are found by a case/punctuation-insensitive match
// against the screen's own name.
import fs from "node:fs";
import path from "node:path";
import { blockerIds, reportFindings } from "./audit.ts";
import { legacyBlockerIds } from "./finding-id.ts";
import { isAuditReport } from "./doc-guards.ts";
import { readJson } from "./read-json.ts";

function slug(s: unknown): string { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, ""); }

function locateAuditFile(cwd: string, screenFile: string | null | undefined, screenName: string | null | undefined): string | null {
  const dir = path.join(cwd, "design", "audit");
  if (!fs.existsSync(dir)) return null;
  const base = screenFile ? path.basename(screenFile, ".json") : null;
  const candidates: string[] = [];
  if (base) candidates.push(path.join(dir, base + ".json"));
  let entries: string[] = [];
  // Report pairs only: a sidecar (<screen>.cross.json, <screen>.overrides.json, <screen>.library.json) has a
  // dot in its stem, which a report basename never does (safe() folds every non-alphanumeric to "_").
  try { entries = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.slice(0, -5).includes(".")); } catch { entries = []; }
  for (const c of candidates) if (fs.existsSync(c)) return path.relative(cwd, c).split(path.sep).join("/");
  const wantSlug = slug(screenName);
  if (wantSlug) {
    // EXACT slug only. A prefix match either way handed "Job Roles" the audit of "Job Roles Detail"
    // (and "Job Roles Detail" the audit of "Job Roles") — a wrong screen's blockers gating this build.
    // Audit files are named `<LayerName>__<node-id>.json` (audit.ts --out), so the name is also
    // compared with that `__<id>` suffix stripped: "Job Roles" finds Job_Roles__9_9.json, never
    // Job_Roles_Detail__9_9.json. The split is at the LAST `__`: safe() turns every non-alphanumeric
    // run in a layer name into underscores, so "Detail - Overview" is Detail___Overview__9_9 and a
    // first-`__` split would hand the unrelated screen "Detail" its audit. The id part itself
    // (safe("9:9") = 9_9) never contains a double underscore.
    const stem = (f: string): string => f.replace(/\.json$/, "");
    const nameOf = (f: string): string | null => { const s = stem(f); const i = s.lastIndexOf("__"); return i > 0 ? s.slice(0, i) : null; };
    const hit = entries.find((f) => slug(stem(f)) === wantSlug)
      ?? entries.find((f) => { const n = nameOf(f); return n !== null && slug(n) === wantSlug; });
    if (hit) return path.relative(cwd, path.join(dir, hit)).split(path.sep).join("/");
  }
  return null;
}

/** What auditGateStatus knows about a screen's audit file. */
export interface AuditGateStatus {
  auditFile: string | null;
  /** F-44 ids (finding-id.ts) of the report's blockers, in report order */
  blockers: string[];
  /** the same blockers' pre-F-44 positional ids (`<code>#<i>`), index for index — a plan written against
   *  them still covers its blockers */
  legacyBlockers: string[];
  unreadable?: true;
  /** why it is unreadable (read-json.ts wording: "is not valid JSON — …", "is not an audit report …") */
  error?: string;
}

function auditGateStatus(cwd: string, screenFile: string | null | undefined, screenName: string | null | undefined): AuditGateStatus {
  const rel = locateAuditFile(cwd, screenFile, screenName);
  if (!rel) return { auditFile: null, blockers: [], legacyBlockers: [] };
  // An audit report (audit.ts --out). A file there that cannot be read, or is not an audit report, is
  // `unreadable` — never "no blockers".
  const r = readJson(path.join(cwd, rel), isAuditReport);
  if (!("doc" in r)) return { auditFile: rel, blockers: [], legacyBlockers: [], unreadable: true, error: r.error };
  return { auditFile: rel, blockers: blockerIds(r.doc), legacyBlockers: legacyBlockerIds(reportFindings(r.doc)) };
}

export { locateAuditFile, auditGateStatus, blockerIds, slug };
