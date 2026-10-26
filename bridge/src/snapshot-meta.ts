// snapshot-meta.ts — reads the freshness stamp a figma-pull export already left on disk.
//
// design-system.json's `exportedAt` (ISO timestamp) and `file` (figma.root.name) are stamped by the
// PLUGIN itself (collect.ts/components.ts's buildDesignSystem()) — nothing here invents a new field,
// it only reads what's already written. Kept as its own small module (same pattern as errmsg.ts /
// node-id.ts) so both the MCP entry and the test suite can read it without importing figma-mcp.ts
// itself, which has top-level side effects (opens the bridge WebSocket server, connects an MCP stdio
// transport) that would make it unsafe to import from a test.
//
// Never throws: a missing/unreadable/malformed snapshot is reported as such, not silently treated as
// "no snapshot" or crashed on — figma_status's whole point is to say what it knows, loudly.
import fs from "node:fs";
import path from "node:path";
import { DESIGN_SYSTEM_FILES } from "./design-system-layout.ts";
import { exportRoot, readExportFreshness } from "./export-reader.ts";
import type { ExportFreshness } from "./export-reader.ts";

const MANIFEST = DESIGN_SYSTEM_FILES.MANIFEST;

/** What snapshotAge reports. `problem` is set only when there is no usable age. */
export interface SnapshotAge {
  exportedAt: string | undefined;
  ageMs: number | undefined;
  problem?: "missing" | "unparseable";
}

/** A readable, stamped (or best-available unstamped) export on disk. */
export interface SnapshotInfo {
  /** absolute path of the file the stamp was read from */
  file: string;
  exportedAt: string | undefined;
  ageMs: number | undefined;
  /** the Figma file name (`file`), or a screen doc's `screen` label */
  sourceFile: string | undefined;
  /** set when the stamp is missing or unparseable */
  warning: string | undefined;
}

/** A named export file (design-system.json / pages/index.json) that exists but is not valid JSON. */
export interface SnapshotParseError {
  file: string;
  error: string;
}

// A parsed JSON document's own field, read the way plain JS reads `doc && doc.x`: undefined for a
// falsy doc and for anything that is not an object carrying the key.
function field(doc: unknown, key: string): unknown {
  return doc && typeof doc === "object" && key in doc ? (doc as Record<string, unknown>)[key] : undefined;
}

// A stamp is a string in every export this repo writes; a truthy non-string (hand-edited JSON) is
// stringified rather than passed through, so the declared `string` holds.
const asText = (v: unknown): string | undefined => (v ? (typeof v === "string" ? v : String(v)) : undefined);

// The ONE freshness rule, shared with design-to-code/drift-lint.ts: given a parsed catalog, what is its
// export timestamp and how old is it? Callers own the POLICY (max-age threshold, warning codes,
// wording); this owns only "which field, and is it parseable". Two copies of the parse rule meant
// figma_status and drift-lint could disagree about the same file on disk.
// `problem` is "missing" (no stamp at all) or "unparseable" (stamp present, not a date).
export function snapshotAge(doc: unknown, now?: number): SnapshotAge {
  const exportedAt = asText(field(doc, "exportedAt"));
  if (!exportedAt) return { exportedAt: undefined, ageMs: undefined, problem: "missing" };
  const t = Date.parse(exportedAt);
  if (Number.isNaN(t)) return { exportedAt, ageMs: undefined, problem: "unparseable" };
  return { exportedAt, ageMs: (now || Date.now()) - t };
}

// Which file carries the freshness stamp, in order of how much of the design it covers.
// design-system.json only exists after a `--design-system` or full pull; `pages/index.json` after a
// page walk; a single-screen pull (`--node`/selection) writes ONLY `design/<Screen>.json`. Reporting
// "nothing exported yet" to someone who has just exported a screen is wrong and sends them to re-run
// a pull they already ran (live run #5), so a screen doc counts as an export too — it is exactly as
// stamped as the others.
// The design system's stamp (design-system.json, else design-system/tokens.json) and the page walk's
// (pages/index.json) are export-reader.ts's (readExportFreshness): the filename alone identifies each as an
// export. Only the DISCOVERED top-level files below have to earn it via looksLikeExport.
// design/ also holds files this tool GENERATES from an export — tokens.dtcg.json,
// tokens.resolver.json, target.json, an audit report. Those carry no export stamp (or a different
// one) and must never be mistaken for the export itself, so a screen doc is identified by SHAPE, not
// by being a .json that isn't on a blacklist: a real one carries `nodes[]` (a single-screen pull) or
// `layers[]`/`pageDirs[]` (a page walk). A blacklist would need updating every time a new output
// file is added; this does not.
function looksLikeExport(doc: unknown): boolean {
  if (!doc || typeof doc !== "object") return false;
  const files = field(doc, "files");
  return Array.isArray(field(doc, "nodes")) || Array.isArray(field(doc, "layers")) || Array.isArray(field(doc, "pageDirs")) ||
     Array.isArray(field(doc, "components")) || Array.isArray(field(doc, "variables")) || (!!files && typeof files === "object");
}

/** One file that may carry the stamp: its path, its stamp, and the human label of what it came from. */
interface SnapshotCandidate { file: string; exportedAt: unknown; sourceFile: string | undefined }

// Every other top-level .json of the export, newest first, that looks like an export (an older single-screen pull's
// design/<Screen>.json). Top level only — never a recursive walk, since this runs on every figma_status/doctor call and
// design/assets/ can hold thousands of files. An unreadable or unparseable one is passed over: only the named files'
// problems are reported (export-reader's).
function topLevelCandidates(dir: string): SnapshotCandidate[] {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const rest: Array<{ f: string; mtime: number }> = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".json") || e.name === MANIFEST) continue;
    const f = path.join(dir, e.name);
    try { rest.push({ f, mtime: fs.statSync(f).mtimeMs }); } catch { /* vanished mid-read */ }
  }
  rest.sort((a, b) => b.mtime - a.mtime);
  const out: SnapshotCandidate[] = [];
  for (const { f } of rest) {
    let doc: unknown;
    try { doc = JSON.parse(fs.readFileSync(f, "utf8")) as unknown; } catch { continue; }
    if (!looksLikeExport(doc)) continue; // a generated file (tokens.*.json, target.json, an audit)
    // A screen doc has no `file` (that is a design-system field); its `screen` is the human label.
    const screen = field(doc, "screen");
    out.push({ file: f, exportedAt: field(doc, "exportedAt"), sourceFile: asText(field(doc, "file")) || (typeof screen === "string" ? screen : undefined) });
  }
  return out;
}

/** The stamp figma_status and doctor report, read off one freshness reading (export-reader.ts readExportFreshness):
 *  the design system's, else the page walk's, else a top-level screen doc's. A STAMPED export always wins over an
 *  unstamped one — design/variables.json is the case that forces this: a single-screen pull writes it alongside the
 *  screen doc, it is export-shaped (variables[]), and it carries no exportedAt of its own. null when nothing is
 *  exported; the first unusable export file when nothing usable is there. */
export function snapshotInfoOf(fresh: ExportFreshness): SnapshotInfo | SnapshotParseError | null {
  const named: SnapshotCandidate[] = [];
  if (fresh.designSystem) named.push({ file: fresh.designSystem.from, exportedAt: fresh.designSystem.stamp.exportedAt, sourceFile: fresh.designSystem.stamp.file });
  if (fresh.index) named.push({ file: fresh.index.from, exportedAt: fresh.index.exportedAt, sourceFile: fresh.index.sourceFile });
  const isStamped = (c: SnapshotCandidate): boolean => !!c.exportedAt;
  let pick = named.find(isStamped);
  if (!pick) {
    const rest = topLevelCandidates(fresh.root);
    pick = rest.find(isStamped) ?? named[0] ?? rest[0];
  }
  if (!pick) {
    const p = fresh.problems[0];
    return p ? { file: path.join(fresh.root, ...p.file.split("/")), error: `${p.file} ${p.error}` } : null; // null: no export on disk yet — not an error
  }
  const { exportedAt, ageMs, problem } = snapshotAge({ exportedAt: pick.exportedAt });
  const label = path.basename(pick.file);
  const warning =
    problem === "missing" ? `no exportedAt stamp in ${label} — freshness unknown (re-export with the current plugin)`
    : problem === "unparseable" ? `exportedAt ('${exportedAt}') is not a parseable timestamp`
    : undefined;
  return { file: pick.file, exportedAt, ageMs, sourceFile: pick.sourceFile, warning };
}

export function readSnapshotInfo(outDir?: string): SnapshotInfo | SnapshotParseError | null {
  // export-reader.ts's one precedence (the legacy flat layout included: a project that exported before design/export/
  // existed must still report its snapshot, not "nothing yet"), which write-out.ts writes by too.
  return snapshotInfoOf(readExportFreshness(exportRoot(outDir)));
}

/** The newest screen row of the export's index. `file` is the screen JSON's path relative to the export dir, as the
 *  index records it. */
export interface LastScreenExport {
  name: string | undefined;
  id: string;
  file: string | undefined;
  exportedAt: string;
  ageMs: number;
  sourceFile?: string;
}

// Which screen was exported LAST, read off one freshness reading (export-reader.ts: every row of the root
// pages/index.json and every page index, each screen once; newest stamp wins, a page walk's rows dated by the root
// index's top-level `exportedAt`). null when no row has a parseable stamp — the same "nothing to report" figma_status
// gives any other absent export.
export function lastScreenOf(fresh: ExportFreshness, now?: number): LastScreenExport | null {
  const best = fresh.newestScreen;
  if (!best) return null;
  const { name, id, file, sourceFile } = best.row;
  return {
    name: typeof name === "string" ? name : undefined,
    id,
    file: typeof file === "string" ? file : undefined,
    exportedAt: best.exportedAt,
    ageMs: (now || Date.now()) - best.t,
    ...(typeof sourceFile === "string" && sourceFile ? { sourceFile } : {}),
  };
}

export function lastScreenExport(outDir?: string, now?: number): LastScreenExport | null {
  return lastScreenOf(readExportFreshness(exportRoot(outDir)), now);
}
