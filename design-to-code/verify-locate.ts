// verify-locate.ts — which screen export and which verify reports a plan is about (locateExport, locateReports).
// plan-status.ts computes a plan's status from them (verify-build's checks read them too); verify-screen --migrate
// (verify-migrate.ts) checks, through plan-status, that a rename leaves every plan finding the reports it found.
import fs from "node:fs";
import path from "node:path";
import { nodeIdFromStem } from "../bridge/src/pages-layout.ts"; // the node id in a `<Layer>__<id>` stem (the exporter's own file naming)
import { DESIGN_DIR, EXPORT_DIR, VERIFY_DIR } from "../bridge/src/project-layout.ts";
import { isProbeIdentity, isReportBehaviour, isVerifyReport } from "./doc-guards.ts";
import { isLayerFile, isScreenDoc, screenExportOf, screenRoots } from "./export-shape.ts";
import { readJsonOrNull } from "../bridge/src/read-json.ts";
import { readExportIndex, type ExportIndex } from "../bridge/src/export-reader.ts";
import { canonical } from "./run-cache.ts";
import { planNode, setNodeOf } from "./node-artefacts.ts";
import { setBaseOf, setFactsOf, setFile, type SetFacts } from "./verify-sets.ts";
import { isJsonObject } from "./types.ts";
import type { IndexRow, IrNode, Plan, ScreenDoc, VerifyDelta, VerifyReport } from "./types.ts";
import { reportInputs } from "./report-freshness.ts";
import type { ReportInputs } from "./report-freshness.ts";

// Stricter than project-layout's findExportDir (any export marker): the plan's screen is looked up in pages/,
// so design/export counts only once it holds pages/ — else the pre-split design/ is tried.
function exportDirOf(cwd: string): string {
  const e = path.join(cwd, EXPORT_DIR);
  return fs.existsSync(path.join(e, "pages")) ? e : path.join(cwd, DESIGN_DIR); // pre-split projects
}

/** One verify-dir report as every plan's lookup reads it: parsed once, its set's facts read once (on first need). */
interface ReportEntry { f: string; abs: string; stem: string; r: VerifyReport; facts: SetFacts | null; mtimeMs: number | null }
/**
 * One command's reads of the verify dirs and export indexes, shared by every plan it looks up — each report parsed once,
 * each set's expectation read once, each export index read once — rather than every report re-read (three times) for
 * each plan: 500 reports cost ~1,500 file reads per plan looked up. A snapshot: it is right while nothing those files
 * hold is rewritten, so a command that writes reports, expectations or exports between lookups (verify-migrate) takes a
 * new one, or passes none — each call then reads afresh, as before.
 */
export interface LocateCache {
  readonly reports: Map<string, ReportEntry[] | null>;
  readonly indexes: Map<string, ExportIndex>;
}
export const locateCache = (): LocateCache => ({ reports: new Map(), indexes: new Map() });

/** The export's index (bridge/src/export-reader.ts: every screen row once, the root index's and every page index's), read once per cache. */
function exportIndexOf(exportDir: string, cache?: LocateCache): ExportIndex {
  if (!cache) return readExportIndex(exportDir);
  let ix = cache.indexes.get(exportDir);
  if (!ix) { ix = readExportIndex(exportDir); cache.indexes.set(exportDir, ix); }
  return ix;
}

/** locateExport()'s result: the screen export a plan describes, plus what the index knows about it. `staleFile`: the
 *  plan's `file` header when the index files that export's node under another file now (read instead), else null. */
export interface ExportHit { file: string; doc: ScreenDoc; row: IndexRow | null; nodeId: string | null; layerName: string; sameNameRows: number; staleFile: string | null }

const docNodeId = (doc: ScreenDoc): string | null => screenExportOf(doc)?.nodeId || screenRoots(doc)[0]?.id || null;

/** Two spellings of one file: their real paths (the on-disk case, symlinks followed) compare equal — so a header that
 *  differs from the index's spelling only in case (a case-insensitive disk) is the same file. */
const sameFile = (a: string, b: string): boolean => path.resolve(a) === path.resolve(b) || canonical(a) === canonical(b);

/** The Figma file a pull came from, as an export stamps it (write-out.ts): its name and key; null when unstamped. */
function sourceOf(doc: ScreenDoc): { file: string; key: string | null } | null {
  const exp = screenExportOf(doc);
  const file = exp ? exp.sourceFile : isLayerFile(doc) ? doc.sourceFile : undefined;
  if (!file) return null;
  return { file, key: exp?.sourceFileKey || null };
}
/** Whether an index row is of the Figma file `src` (the key decides when both carry one, else the file name, as
 *  pages-layout.ts reads two rows of one node); null when either side is unstamped. */
function sameSource(r: IndexRow, src: { file: string; key: string | null } | null): boolean | null {
  if (!src || !r.sourceFile) return null;
  return r.sourceFileKey && src.key ? r.sourceFileKey === src.key : r.sourceFile === src.file;
}
/** Whether every stamped row of the index is of one Figma file (sameSource with the first, and at most one file key
 *  among them — two files may share a name): a single-file project, where an unstamped export (an older pull) is of
 *  that file too. */
function oneSource(rows: readonly IndexRow[]): boolean {
  const first = rows.find((r) => r.sourceFile);
  if (!first?.sourceFile) return true;
  if (new Set(rows.flatMap((r) => r.sourceFile && r.sourceFileKey ? [r.sourceFileKey] : [])).size > 1) return false;
  const src = { file: first.sourceFile, key: first.sourceFileKey || null };
  return rows.every((r) => !r.sourceFile || sameSource(r, src) === true);
}

// The screen export a plan describes: its `file` header (project-relative, or relative to
// design/export as the index writes it), else its `nodeId`, else the node id in its `screen` stem or
// its own filename, looked up in the export index. The export index has the last word on where a node's export is: when
// no row of the header's node (that doc's root id, else the plan's nodeId) files it under the header's file, but one
// readable row files it elsewhere — a re-pull after a layer rename leaves the old file behind — that file is read and
// `staleFile` names the header's. Node ids repeat across Figma files (the index merges several), so the row taken is the
// one of the header's Figma file (its source stamp), else the one unstamped row — for an unstamped header, the one row of
// any stamp only when the whole index is of one Figma file; several, or only other files' rows, keep the header (with no
// row: a row of its node id may be another file's).
// Returns { file, doc, row, … } or null.
function locateExport(plan: Plan, planFile: string | undefined, cwd: string, cache?: LocateCache): ExportHit | null {
  const exportDir = exportDirOf(cwd);
  const tryFile = (rel: string | null | undefined): { file: string; doc: ScreenDoc } | null => {
    if (!rel) return null;
    for (const f of [path.resolve(cwd, rel), path.resolve(exportDir, rel)]) {
      const doc = readJsonOrNull(f, isScreenDoc);
      if (doc) return { file: f, doc };
    }
    return null;
  };
  let hit = tryFile(plan.file && /\.json$/i.test(plan.file) ? plan.file : null);
  const ix = exportIndexOf(exportDir, cache);
  const rows = ix.rows;
  // a row's screen file: the index's pointer, read inside the export only
  const tryRow = (r: IndexRow): { file: string; doc: ScreenDoc } | null => {
    const f = ix.fileOf(r);
    const doc = f === null ? null : readJsonOrNull(f, isScreenDoc);
    return f !== null && doc ? { file: f, doc } : null;
  };
  // the plan's node (node-artefacts.ts planNode), then — a lookup hint, not its identity — the id in its `screen` stem
  const ids = [planNode(plan, planFile), nodeIdFromStem(plan.screen)].filter((id): id is string => !!id);
  let row: IndexRow | null = null;
  for (const id of ids) { row = rows.find((r) => r.id === id) || null; if (row) break; }
  let staleFile: string | null = null;
  let noRow = false; // the header is kept and no row of its Figma file files it: no row, not one found by node id below
  if (hit && plan.file) {
    const id = docNodeId(hit.doc) || plan.nodeId || null;
    const header = hit;
    // node ids repeat across Figma files: every readable row of the id, and whether one of them is the header's file
    const filed = (id ? rows.filter((r) => r.id === id) : []).flatMap((r) => { const now = tryRow(r); return now ? [{ r, now }] : []; });
    const own = filed.find((x) => sameFile(x.now.file, header.file));
    if (own) { if (!row || row.id === id) row = own.r; }
    else {
      const src = sourceOf(header.doc);
      const fromSource = filed.filter((x) => sameSource(x.r, src) === true);
      // a row whose Figma file is unknown: an unstamped row; for an unstamped header, a stamped row too only when the
      // whole index is of one Figma file (else it may be another file's node)
      const unknown = filed.filter((x) => sameSource(x.r, src) === null && (src !== null || !x.r.sourceFile || oneSource(rows)));
      // the replacement: the one row of the header's Figma file, else the one row whose file is unknown — never a row of
      // another Figma file, never a pick among several
      const pick = fromSource.length === 1 ? fromSource[0] : !fromSource.length && unknown.length === 1 ? unknown[0] : undefined;
      if (pick) { hit = pick.now; row = pick.r; staleFile = plan.file; }
      else { row = null; noRow = true; } // a row of the id may be another Figma file's
    }
  }
  if (!hit && row) hit = tryRow(row);
  if (!hit) return null;
  const root: IrNode | undefined = screenRoots(hit.doc)[0];
  const exp = screenExportOf(hit.doc);
  const nodeId = docNodeId(hit.doc);
  const layerName = String((exp && exp.screen) || (root && root.name) || "");
  if (!row && !noRow) row = rows.find((r) => r.id === nodeId) || null;
  return Object.assign(hit, { row, nodeId, layerName, sameNameRows: rows.filter((r) => String(r.name || "").trim() === layerName.trim()).length, staleFile });
}

/** A verify report as locateReports() summarises it for the status computation. */
/** How locateReports() tied a report to the plan (first that matches, in this order). */
export type ReportMatch = "name" | "nodeId" | "expectation frame" | "layer name";
export interface ReportRef {
  rel: string; matchedBy: ReportMatch; schema: string | null; verdict: VerifyReport["verdict"] | null; headline: string | null; why: string[]; deltas: VerifyDelta[] | null;
  measuredAt: string | null; mtimeMs: number;
  /** what the report was computed against (report-freshness.ts reportInputs) — judged there, never here */
  inputs: ReportInputs;
  /** report.behaviour, summarised (null = none or unreadable — a report without a behaviour section). Warnings only. */
  behaviour: { ran: boolean; why: string | null; fail: number; warn: number; failed: string[] } | null;
  /** report.inputs.probe is the shipped probe's identity (not "unknown" / absent: a hand-written or non-web measured file) */
  shippedProbe: boolean;
}

// Reports are found by name first — `<Layer>__<id>` (the set verify-screen names the node), the plan's
// own name, its `screen` — then by node: a report whose set is of the plan's node (node-artefacts.ts: the plan's
// planNode; the set's setNode — its expectation's frame, else the report's `nodeId`, the two disagreeing: none — else
// the id its set name carries, a variant's `<Layer>__<id>.<slug>` too), or whose `screen` is
// the frame's layer name when that name is unique in the export (the older `JetRoles.report.json`
// naming carries only the layer name). Every match counts; ONE failing report is enough to fail.
// Both report shapes are read: @1 (`verdict`, `why`) and @2 (`verdict` pass|pass-with-deviations|fail|
// incomplete, `headline`, `inputs.expectationSha256` — the expectation it was computed against,
// `inputs.waivers.sha256` — the plan waivers/descopes it applied).
// (read leniently: a malformed behaviour section is read as none — it never decides anything here)
function behaviourRef(x: unknown): ReportRef["behaviour"] {
  if (!isReportBehaviour(x)) return null;
  return { ran: x.ran, why: x.why ?? null, fail: x.summary.fail, warn: x.summary.warn, failed: x.checks.filter((c) => c.status === "fail").map((c) => c.id) };
}
// The verify dir's readable reports, sorted by file name, less the retired sets' — plan-independent, so a LocateCache
// holds them for every plan of the command. null when the dir does not exist.
function reportEntries(dir: string): ReportEntry[] | null {
  if (!fs.existsSync(dir)) return null;
  const out: ReportEntry[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => setBaseOf(x, "report") !== null).sort()) {
    const abs = path.join(dir, f);
    const r = readJsonOrNull(abs, isVerifyReport);
    if (!r) continue;
    const stem = setBaseOf(f, "report") ?? f;
    // A set retired by the guard's printed migration (`<old>.expected.json.retired`) is history, not this screen's report
    if (!fs.existsSync(setFile(path.join(dir, stem), "expected")) && fs.existsSync(setFile(path.join(dir, stem), "retired"))) continue;
    out.push({ f, abs, stem, r, facts: null, mtimeMs: null });
  }
  return out;
}
// The set's facts (verify-sets.ts setFacts) from the report already parsed and its expectation, read once per entry
const factsOf = (dir: string, x: ReportEntry): SetFacts =>
  (x.facts ??= setFactsOf(readJsonOrNull(setFile(path.join(dir, x.stem), "expected"), isJsonObject), x.r));

function locateReports(plan: Plan, planFile: string | undefined, cwd: string, exp: ExportHit | null | undefined, cache?: LocateCache): ReportRef[] {
  const dir = path.join(cwd, VERIFY_DIR);
  let entries = cache ? cache.reports.get(dir) : undefined;
  if (entries === undefined) {
    entries = reportEntries(dir);
    if (cache) cache.reports.set(dir, entries);
  }
  if (entries === null) return [];
  const e = exp === undefined ? locateExport(plan, planFile, cwd, cache) : exp;
  const stems = new Set([
    plan.file ? path.basename(String(plan.file)).replace(/\.json$/i, "") : null,
    e ? path.basename(e.file).replace(/\.json$/i, "") : null,
    planFile ? path.basename(planFile, ".json") : null,
    plan.screen ? String(plan.screen) : null,
  ].filter((s): s is string => !!s));
  const nodeId = planNode(plan, planFile);
  const layer = e ? e.layerName.trim() : null;
  const out: ReportRef[] = [];
  for (const x of entries) {
    const { r, stem, abs } = x;
    let by: ReportMatch | null = null;
    if (stems.has(stem)) by = "name";
    else if (nodeId && setNodeOf(stem, factsOf(dir, x)) === nodeId) by = factsOf(dir, x).expectedId === nodeId ? "expectation frame" : "nodeId";
    else if (e && layer && e.sameNameRows <= 1 && String(r.screen || "").trim() === layer) by = "layer name";
    if (!by) continue;
    if (x.mtimeMs === null) {
      x.mtimeMs = 0;
      try { x.mtimeMs = fs.statSync(abs).mtimeMs; } catch { /* ignore */ }
    }
    out.push({ rel: path.relative(cwd, abs).split(path.sep).join("/"), matchedBy: by, schema: r.schema || null, verdict: r.verdict || null, headline: r.headline || null,
      why: r.why || [], deltas: r.deltas || null, measuredAt: r.measuredAt || null, mtimeMs: x.mtimeMs, inputs: reportInputs(r),
      behaviour: behaviourRef(r.behaviour), shippedProbe: isProbeIdentity(r.inputs && r.inputs.probe) });
  }
  return out;
}

export { exportDirOf, exportIndexOf, locateExport, locateReports };