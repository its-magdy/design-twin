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
import { errMsg } from "./errmsg.ts";
import { findExportDir } from "./project-layout.ts";

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

// Which file carries the freshness stamp, in order of how much of the design it covers.
// design-system.json only exists after a `--design-system` or full pull; `pages/index.json` after a
// page walk; a single-screen pull (`--node`/selection) writes ONLY `design/<Screen>.json`. Reporting
// "nothing exported yet" to someone who has just exported a screen is wrong and sends them to re-run
// a pull they already ran (live run #5), so a screen doc counts as an export too — it is exactly as
// stamped as the others.
// `named: true` means the filename alone identifies it as an export, so its shape is not second-
// guessed (a hand-trimmed design-system.json is still a design-system.json). Only the DISCOVERED
// files have to earn it via looksLikeExport.
interface SnapshotCandidate { f: string; named: boolean }

function snapshotCandidates(dir: string): SnapshotCandidate[] {
  const out: SnapshotCandidate[] = [{ f: path.join(dir, "design-system.json"), named: true },
               { f: path.join(dir, "pages", "index.json"), named: true }];
  // Then any other top-level .json, newest first. Top level only — never a recursive walk, since this
  // runs on every figma_status/doctor call and design/assets/ can hold thousands of files.
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  const rest: Array<{ f: string; mtime: number }> = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".json") || e.name === "design-system.json") continue;
    const f = path.join(dir, e.name);
    try { rest.push({ f, mtime: fs.statSync(f).mtimeMs }); } catch { /* vanished mid-read */ }
  }
  rest.sort((a, b) => b.mtime - a.mtime);
  return out.concat(rest.map((r) => ({ f: r.f, named: false })));
}

export function readSnapshotInfo(outDir?: string): SnapshotInfo | SnapshotParseError | null {
  // Same resolution order as write-out.ts's resolveOutDir, plus the legacy flat layout: a project
  // that exported before design/export/ existed must still report its snapshot, not "nothing yet".
  const dir = outDir || process.env.FIGMA_EXPORT_DIR || findExportDir(process.cwd()).dir;
  const cands = snapshotCandidates(dir);
  let file: string | null = null, doc: unknown = null, parseError: SnapshotParseError | null = null;
  let fallback: { file: string; doc: unknown } | null = null;
  for (const { f: cand, named } of cands) {
    let raw: string;
    try { raw = fs.readFileSync(cand, "utf8"); } catch { continue; }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (e) {
      // A corrupt export is worth reporting even though a later candidate might still be readable —
      // but only for a file we KNOW was meant to be an export. Remember it and keep looking.
      if (named && parseError === null) parseError = { file: cand, error: path.basename(cand) + " is not valid JSON: " + errMsg(e) };
      continue;
    }
    if (!named && !looksLikeExport(parsed)) continue; // a generated file (tokens.*.json, target.json, an audit)
    // A STAMPED export always wins over an unstamped one. design/variables.json is the case that
    // forces this: a single-screen pull writes it alongside the screen doc, it is export-shaped
    // (variables[]), and it carries no exportedAt of its own — so picking purely by order would
    // report "freshness unknown" while a perfectly stamped screen doc sat right next to it.
    if (!field(parsed, "exportedAt")) { if (fallback === null) fallback = { file: cand, doc: parsed }; continue; }
    file = cand; doc = parsed; break;
  }
  if (file === null && fallback !== null) { file = fallback.file; doc = fallback.doc; }
  if (file === null) return parseError; // null when there is simply no export on disk yet — not an error
  const label = path.basename(file);
  // A screen doc has no `file` (that is a design-system field); its `screen` is the human label, so
  // fall back to it rather than reporting the source as unknown.
  const screen = field(doc, "screen");
  const sourceFile = asText(field(doc, "file")) || (typeof screen === "string" ? screen : undefined);
  const { exportedAt, ageMs, problem } = snapshotAge(doc);
  const warning =
    problem === "missing" ? `no exportedAt stamp in ${label} — freshness unknown (re-export with the current plugin)`
    : problem === "unparseable" ? `exportedAt ('${exportedAt}') is not a parseable timestamp`
    : undefined;
  return { file, exportedAt, ageMs, sourceFile, warning };
}

/** The newest screen row of the root pages/index.json (F-07). `file` is the screen JSON's path relative
 *  to the export dir, as the index records it. */
export interface LastScreenExport {
  name: string | undefined;
  id: string;
  file: string | undefined;
  exportedAt: string;
  ageMs: number;
  sourceFile?: string;
}

// F-07: which screen was exported LAST, read from disk — the root pages/index.json's `layers[]` rows,
// newest `exportedAt` wins (a page walk's rows carry no stamp of their own and fall back to the index's
// top-level `exportedAt`). Never throws: a missing, garbled or row-less index (or no parseable stamp) is
// null, the same "nothing to report" figma_status gives any other absent export.
export function lastScreenExport(outDir?: string, now?: number): LastScreenExport | null {
  const dir = outDir || process.env.FIGMA_EXPORT_DIR || findExportDir(process.cwd()).dir;
  let doc: unknown;
  try { doc = JSON.parse(fs.readFileSync(path.join(dir, "pages", "index.json"), "utf8")) as unknown; } catch { return null; }
  const rows = field(doc, "layers");
  if (!Array.isArray(rows)) return null;
  const rootStamp = asText(field(doc, "exportedAt"));
  let best: { row: unknown; t: number; at: string } | null = null;
  for (const row of rows) {
    const id = field(row, "id");
    if (typeof id !== "string" || !id) continue;
    const at = asText(field(row, "exportedAt")) || rootStamp;
    const t = at ? Date.parse(at) : NaN;
    if (!at || Number.isNaN(t)) continue;
    if (!best || t >= best.t) best = { row, t, at }; // a tie goes to the later row: merges append the newest pull
  }
  if (!best) return null;
  const name = field(best.row, "name"), file = field(best.row, "file"), src = field(best.row, "sourceFile");
  return {
    name: typeof name === "string" ? name : undefined,
    id: String(field(best.row, "id")),
    file: typeof file === "string" ? file : undefined,
    exportedAt: best.at,
    ageMs: (now || Date.now()) - best.t,
    ...(typeof src === "string" && src ? { sourceFile: src } : {}),
  };
}
