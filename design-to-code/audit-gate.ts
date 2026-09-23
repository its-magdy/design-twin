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
import { blockerIds } from "./audit.ts";
import type { AuditReport } from "./types.ts";

function slug(s: unknown): string { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, ""); }

function locateAuditFile(cwd: string, screenFile: string | null | undefined, screenName: string | null | undefined): string | null {
  const dir = path.join(cwd, "design", "audit");
  if (!fs.existsSync(dir)) return null;
  const base = screenFile ? path.basename(screenFile, ".json") : null;
  const candidates: string[] = [];
  if (base) candidates.push(path.join(dir, base + ".json"));
  let entries: string[] = [];
  try { entries = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { entries = []; }
  for (const c of candidates) if (fs.existsSync(c)) return path.relative(cwd, c).split(path.sep).join("/");
  const wantSlug = slug(screenName);
  if (wantSlug) {
    const hit = entries.find((f) => slug(f.replace(/\.json$/, "")) === wantSlug || slug(f.replace(/\.json$/, "")).startsWith(wantSlug) || wantSlug.startsWith(slug(f.replace(/\.json$/, ""))));
    if (hit) return path.relative(cwd, path.join(dir, hit)).split(path.sep).join("/");
  }
  return null;
}

/** What auditGateStatus knows about a screen's audit file: `doc` is the parsed report when it was readable. */
export interface AuditGateStatus {
  auditFile: string | null;
  blockers: string[];
  unreadable?: true;
  doc?: AuditReport;
}

function auditGateStatus(cwd: string, screenFile: string | null | undefined, screenName: string | null | undefined): AuditGateStatus {
  const rel = locateAuditFile(cwd, screenFile, screenName);
  if (!rel) return { auditFile: null, blockers: [] };
  // An audit report under design/audit/ is this repo's own writer's output (audit.ts --out).
  let doc: AuditReport;
  try { doc = JSON.parse(fs.readFileSync(path.join(cwd, rel), "utf8")) as AuditReport; } catch { return { auditFile: rel, blockers: [], unreadable: true }; }
  return { auditFile: rel, blockers: blockerIds(doc), doc };
}

export { locateAuditFile, auditGateStatus, blockerIds, slug };
