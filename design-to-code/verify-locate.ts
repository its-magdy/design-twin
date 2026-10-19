// verify-locate.ts — which screen export and which verify reports a plan is about (locateExport, locateReports).
// verify-build computes a plan's status from them; verify-screen --migrate (verify-migrate.ts) checks that a rename
// leaves every plan finding the reports it found. A module of its own so --migrate does not bundle verify-build.
import fs from "node:fs";
import path from "node:path";
import { sha256Hex } from "../bridge/src/hash.ts";
import { nodeIdFromStem } from "../bridge/src/pages-layout.ts"; // the node id in a `<Layer>__<id>` stem (the exporter's own file naming)
import { DESIGN_DIR, EXPORT_DIR, VERIFY_DIR } from "../bridge/src/project-layout.ts";
import { isPageIndex, isPagesRootIndex, isProbeIdentity, isReportBehaviour, isVerifyReport } from "./doc-guards.ts";
import { isLayerFile, isScreenDoc, screenExportOf, screenRoots } from "./export-shape.ts";
import { readJsonOrNull } from "./read-json.ts";
import { canonical } from "./run-cache.ts";
import { nodeIdFromSetName } from "./verify-sets.ts";
import { isJsonObject } from "./types.ts";
import type { CodeInputs, IndexRow, IrNode, Plan, ScreenDoc, VerifyDelta, VerifyReport } from "./types.ts";

// Stricter than project-layout's findExportDir (any export marker): the plan's screen is looked up in pages/,
// so design/export counts only once it holds pages/ — else the pre-split design/ is tried.
function exportDirOf(cwd: string): string {
  const e = path.join(cwd, EXPORT_DIR);
  return fs.existsSync(path.join(e, "pages")) ? e : path.join(cwd, DESIGN_DIR); // pre-split projects
}

function indexRows(exportDir: string): IndexRow[] {
  const root = readJsonOrNull(path.join(exportDir, "pages", "index.json"), isPagesRootIndex);
  if (!root) return [];
  if (root.layers) return root.layers;
  const rows: IndexRow[] = [];
  for (const pd of root.pageDirs) {
    const idx = readJsonOrNull(path.join(exportDir, pd.index || path.join("pages", pd.dir || "", "index.json")), isPageIndex);
    if (idx) rows.push(...idx.layers);
  }
  return rows;
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

// The screen export a plan describes: its `file` header (project-relative, or relative to
// design/export as the index writes it), else its `nodeId`, else the node id in its `screen` stem or
// its own filename, looked up in the export index. The export index has the last word on where a node's export is: when
// no row of the header's node (that doc's root id, else the plan's nodeId) files it under the header's file, but one
// readable row files it elsewhere — a re-pull after a layer rename leaves the old file behind — that file is read and
// `staleFile` names the header's. Node ids repeat across Figma files (the index merges several), so the row taken is the
// one of the header's Figma file (its source stamp), else the one unstamped row; several, or only other files' rows,
// keep the header.
// Returns { file, doc, row, … } or null.
function locateExport(plan: Plan, planFile: string | undefined, cwd: string): ExportHit | null {
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
  const rows = indexRows(exportDir);
  const ids = [plan.nodeId, nodeIdFromStem(plan.screen), planFile ? nodeIdFromStem(path.basename(planFile, ".json")) : null].filter((id): id is string => !!id);
  let row: IndexRow | null = null;
  for (const id of ids) { row = rows.find((r) => r.id === id) || null; if (row) break; }
  let staleFile: string | null = null;
  if (hit && plan.file) {
    const id = docNodeId(hit.doc) || plan.nodeId || null;
    const header = hit;
    // node ids repeat across Figma files: every readable row of the id, and whether one of them is the header's file
    const filed = (id ? rows.filter((r) => r.id === id) : []).flatMap((r) => { const now = tryFile(r.file); return now ? [{ r, now }] : []; });
    const own = filed.find((x) => sameFile(x.now.file, header.file));
    if (own) { if (!row || row.id === id) row = own.r; }
    else {
      const src = sourceOf(header.doc);
      const fromSource = filed.filter((x) => sameSource(x.r, src) === true);
      const unknown = filed.filter((x) => sameSource(x.r, src) === null);
      // the replacement: the one row of the header's Figma file, else the one row whose file is unknown — never a row of
      // another Figma file, never a pick among several
      const pick = fromSource.length === 1 ? fromSource[0] : !fromSource.length && unknown.length === 1 ? unknown[0] : undefined;
      if (pick) { hit = pick.now; row = pick.r; staleFile = plan.file; }
    }
  }
  if (!hit && row) hit = tryFile(row.file);
  if (!hit) return null;
  const root: IrNode | undefined = screenRoots(hit.doc)[0];
  const exp = screenExportOf(hit.doc);
  const nodeId = docNodeId(hit.doc);
  const layerName = String((exp && exp.screen) || (root && root.name) || "");
  if (!row) row = rows.find((r) => r.id === nodeId) || null;
  return Object.assign(hit, { row, nodeId, layerName, sameNameRows: rows.filter((r) => String(r.name || "").trim() === layerName.trim()).length, staleFile });
}

/** The node id a plan is of, as locateReports reads it: its `nodeId`, else its export's, else the id in its `screen`
 *  stem or its own file name; null when none names one. */
function planNodeId(plan: Plan, planFile: string | undefined, exp: ExportHit | null): string | null {
  return plan.nodeId || (exp && exp.nodeId) || nodeIdFromStem(plan.screen) || (planFile ? nodeIdFromStem(path.basename(planFile, ".json")) : null);
}

/** A verify report as locateReports() summarises it for the status computation. */
/** How locateReports() tied a report to the plan (first that matches, in this order). */
export type ReportMatch = "name" | "nodeId" | "expectation frame" | "layer name";
export interface ReportRef {
  rel: string; matchedBy: ReportMatch; schema: string | null; verdict: VerifyReport["verdict"] | null; headline: string | null; why: string[]; deltas: VerifyDelta[] | null;
  exportedAt: string | null; measuredAt: string | null; mtimeMs: number; exportContentSha256: string | null; code: CodeInputs | null;
  expectationChanged: boolean; expectationRel: string | null;
  /** inputs.waivers.sha256: the plan waivers/descopes the compare applied (null = recorded none — an older report). */
  waiversSha256: string | null;
  /** report.behaviour, summarised (null = none or unreadable — a report without a behaviour section). Warnings only. */
  behaviour: { ran: boolean; why: string | null; fail: number; warn: number; failed: string[] } | null;
  /** report.inputs.probe is the shipped probe's identity (not "unknown" / absent: a hand-written or non-web measured file) */
  shippedProbe: boolean;
}

// Reports are found by name first — `<Layer>__<id>` (the set verify-screen names the node), the plan's
// own name, its `screen` — then by content: a report whose `nodeId` is the plan's (or whose set name carries it, a
// variant's `<Layer>__<id>.<slug>` too), whose sibling
// `<stem>.expected.json` is this frame's (`frame.nodeId`, verify-expectation@2), or whose `screen` is
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
function locateReports(plan: Plan, planFile: string | undefined, cwd: string, exp: ExportHit | null | undefined): ReportRef[] {
  const dir = path.join(cwd, VERIFY_DIR);
  if (!fs.existsSync(dir)) return [];
  const e = exp === undefined ? locateExport(plan, planFile, cwd) : exp;
  const stems = new Set([
    plan.file ? path.basename(String(plan.file)).replace(/\.json$/i, "") : null,
    e ? path.basename(e.file).replace(/\.json$/i, "") : null,
    planFile ? path.basename(planFile, ".json") : null,
    plan.screen ? String(plan.screen) : null,
  ].filter((s): s is string => !!s));
  const nodeId = planNodeId(plan, planFile, e);
  const layer = e ? e.layerName.trim() : null;
  const out: ReportRef[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".report.json")).sort()) {
    const abs = path.join(dir, f);
    const r = readJsonOrNull(abs, isVerifyReport);
    if (!r) continue;
    const stem = f.replace(/\.report\.json$/, "");
    let by: ReportMatch | null = null;
    const expFile = path.join(dir, stem + ".expected.json");
    // A set retired by the guard's printed migration (`<old>.expected.json.retired`) is history, not this screen's report
    if (!fs.existsSync(expFile) && fs.existsSync(expFile + ".retired")) continue;
    // Only the expectation's frame.nodeId is read here, so only that is required of the file.
    const expFrame = (): string | null => { const x = readJsonOrNull(expFile, isJsonObject); return x && isJsonObject(x.frame) && typeof x.frame.nodeId === "string" ? x.frame.nodeId : null; };
    if (stems.has(stem)) by = "name";
    else if (nodeId && (r.nodeId === nodeId || nodeIdFromSetName(stem) === nodeId)) by = "nodeId";
    else if (nodeId && fs.existsSync(expFile) && expFrame() === nodeId) by = "expectation frame";
    else if (e && layer && e.sameNameRows <= 1 && String(r.screen || "").trim() === layer) by = "layer name";
    if (!by) continue;
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(abs).mtimeMs; } catch { /* ignore */ }
    // @2: which expectation the report was computed against, and whether that file still says the same
    const want = r.inputs && r.inputs.expectationSha256;
    let expectationChanged = false;
    if (want && fs.existsSync(expFile)) { try { expectationChanged = sha256Hex(fs.readFileSync(expFile)) !== want; } catch { /* ignore */ } }
    out.push({ rel: path.relative(cwd, abs).split(path.sep).join("/"), matchedBy: by, schema: r.schema || null, verdict: r.verdict || null, headline: r.headline || null,
      why: r.why || [], deltas: r.deltas || null, exportedAt: r.exportedAt || null, measuredAt: r.measuredAt || null, mtimeMs,
      exportContentSha256: (r.inputs && r.inputs.exportContentSha256) || null, code: (r.inputs && r.inputs.code) || null,
      expectationChanged, expectationRel: expectationChanged ? path.relative(cwd, expFile).split(path.sep).join("/") : null,
      waiversSha256: (r.inputs && r.inputs.waivers && typeof r.inputs.waivers.sha256 === "string" && r.inputs.waivers.sha256) || null,
      behaviour: behaviourRef(r.behaviour), shippedProbe: isProbeIdentity(r.inputs && r.inputs.probe) });
  }
  return out;
}

export { exportDirOf, indexRows, locateExport, locateReports, planNodeId };