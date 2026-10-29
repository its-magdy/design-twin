// export-verdict.ts — ONE verdict on the export on disk, the answer `dtwin doctor` formats and figma_status returns.
//
// export-reader.ts reads an export's freshness per source (readExportFreshness: the design system's stamp, the page
// walk's, every screen grouped by the Figma file it came from). This judges that reading, once:
//
//   - sources: what the export draws on — the screens of each Figma file (and those pulled before rows were stamped,
//     a group of their own, never another source's), the design system, a page walk's own index when it lists no
//     screen, and (only when nothing above carries a stamp) a top-level screen doc of the older flat layout. Each
//     with its newest stamp, its age, and why it has none ("missing" / "unparseable").
//   - newest: the newest parseable stamp of them all, and which source and file it came from. An export mixing a
//     design system from one Figma file with screens from another is dated, and attributed, by what was pulled last
//     — never by whichever single document happened to be read first.
//   - stale: newest older than STALE_MS (the threshold drift-lint's stale-snapshot warning uses too).
//   - unknownFreshness: why there is no age at all, when no source carries a usable stamp.
//   - problems: every manifest, part or index that is there but unusable.
//   - lastScreen: the newest screen row (figma_status's `lastScreenExport`).
//
// Wording is the caller's: doctor turns this into its export lines, figma_status hands it to an agent as data.
// Never throws: a missing or unreadable file adds nothing, and the reason is in `problems`.
import fs from "node:fs";
import path from "node:path";
import { DESIGN_SYSTEM_FILES } from "./design-system-layout.ts";
import { readExportFreshness, resolveInside } from "./export-reader.ts";
import type { ExportFreshness, ExportProblem } from "./export-reader.ts";

/** How old the newest stamp may be before the export is stale — drift-lint's default max-age too. */
export const STALE_MS = 24 * 60 * 60 * 1000;

/** Why a source (or the whole export) has no usable age: no stamp at all, or one that is not a date. */
export type StampProblem = "missing" | "unparseable";

/** What snapshotAge reports. `problem` is set only when there is no usable age. */
export interface SnapshotAge {
  exportedAt: string | undefined;
  ageMs: number | undefined;
  problem?: StampProblem;
}

// A parsed JSON document's own field, read the way plain JS reads `doc && doc.x`: undefined for a
// falsy doc and for anything that is not an object carrying the key.
function field(doc: unknown, key: string): unknown {
  return doc && typeof doc === "object" && key in doc ? (doc as Record<string, unknown>)[key] : undefined;
}

// A stamp is a string in every export this repo writes; a truthy non-string (hand-edited JSON) is
// stringified rather than passed through, so the declared `string` holds.
const asText = (v: unknown): string | undefined => (v ? (typeof v === "string" ? v : String(v)) : undefined);

// The ONE freshness rule, shared with design-to-code/drift-lint.ts: given a parsed document, what is its
// export timestamp and how old is it? Callers own the POLICY (max-age threshold, warning codes,
// wording); this owns only "which field, and is it parseable". Two copies of the parse rule meant
// figma_status and drift-lint could disagree about the same file on disk.
export function snapshotAge(doc: unknown, now?: number): SnapshotAge {
  const exportedAt = asText(field(doc, "exportedAt"));
  if (!exportedAt) return { exportedAt: undefined, ageMs: undefined, problem: "missing" };
  const t = Date.parse(exportedAt);
  if (Number.isNaN(t)) return { exportedAt, ageMs: undefined, problem: "unparseable" };
  return { exportedAt, ageMs: (now || Date.now()) - t };
}

/** One thing the export draws on. */
export interface ExportSource {
  /** `screens`: the indexed screens of one Figma file; `design-system`; `page-walk`: pages/index.json's own stamp, for
   *  an index listing no screen; `screen-doc`: a top-level screen doc of the older flat layout */
  readonly kind: "screens" | "design-system" | "page-walk" | "screen-doc";
  /** the Figma file it came from (a screen doc's `screen` label stands in); null when not recorded */
  readonly sourceFile: string | null;
  /** how many screens (`screens` only) */
  readonly count?: number;
  /** its newest stamp; for `screens`, the newest parseable one among its rows */
  readonly exportedAt: string | undefined;
  readonly ageMs: number | undefined;
  /** why there is no age */
  readonly problem?: StampProblem;
  /** the file (absolute) that stamp was read from; for `screens`, the newest one's screen file */
  readonly file?: string;
}

/** The newest usable stamp of the export, and where it came from. */
export interface ExportNewest {
  readonly exportedAt: string;
  readonly ageMs: number;
  readonly kind: ExportSource["kind"];
  readonly sourceFile: string | null;
  readonly file: string | undefined;
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

/** The verdict on the export at `root`. */
export interface ExportVerdict {
  readonly root: string;
  /** some export is there — a source, or at least a file that is there but unusable */
  readonly exported: boolean;
  /** screens per Figma file (named ones first, then the unrecorded group), the design system, then the rest */
  readonly sources: readonly ExportSource[];
  readonly newest: ExportNewest | null;
  readonly staleAfterMs: number;
  /** newest is older than staleAfterMs */
  readonly stale: boolean;
  /** why freshness is unknown: set when there are sources and none carries a usable stamp */
  readonly unknownFreshness: string | undefined;
  /** the sources name more than one Figma file */
  readonly mixed: boolean;
  readonly problems: readonly ExportProblem[];
  readonly lastScreen: LastScreenExport | null;
}

// A top-level design/<Screen>.json (the older flat layout's single-screen pull) is identified by SHAPE: design/ also
// holds files this tool GENERATES from an export — tokens.dtcg.json, tokens.resolver.json, target.json, an audit
// report — which carry no export stamp and must never be mistaken for the export. A real one carries `nodes[]` (a
// single-screen pull) or `layers[]`/`pageDirs[]` (a page walk); a blacklist would need updating with every new output.
function looksLikeExport(doc: unknown): boolean {
  if (!doc || typeof doc !== "object") return false;
  const files = field(doc, "files");
  return Array.isArray(field(doc, "nodes")) || Array.isArray(field(doc, "layers")) || Array.isArray(field(doc, "pageDirs")) ||
     Array.isArray(field(doc, "components")) || Array.isArray(field(doc, "variables")) || (!!files && typeof files === "object");
}

/** One top-level export-shaped file: its path, its stamp, and its label. */
interface ScreenDoc { file: string; exportedAt: unknown; label: string | undefined }

// Every top-level .json of the export but the manifest, newest first, that looks like an export. Top level only —
// never a recursive walk, since this runs on every figma_status/doctor call and design/assets/ can hold thousands of
// files. An unreadable or unparseable one is passed over: only the named files' problems are reported.
function topLevelDocs(dir: string): ScreenDoc[] {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const rest: Array<{ f: string; mtime: number }> = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".json") || e.name === DESIGN_SYSTEM_FILES.MANIFEST) continue;
    const f = path.join(dir, e.name);
    try { rest.push({ f, mtime: fs.statSync(f).mtimeMs }); } catch { /* vanished mid-read */ }
  }
  rest.sort((a, b) => b.mtime - a.mtime);
  const out: ScreenDoc[] = [];
  for (const { f } of rest) {
    let doc: unknown;
    try { doc = JSON.parse(fs.readFileSync(f, "utf8")) as unknown; } catch { continue; }
    if (!looksLikeExport(doc)) continue;
    // A screen doc has no `file` (that is a design-system field); its `screen` is the human label.
    const screen = field(doc, "screen");
    out.push({ file: f, exportedAt: field(doc, "exportedAt"), label: asText(field(doc, "file")) || (typeof screen === "string" ? screen : undefined) });
  }
  return out;
}

/** The verdict on one freshness reading (export-reader.ts readExportFreshness), as of `now`. */
function verdictOf(fresh: ExportFreshness, now: number): ExportVerdict {
  const aged = (at: unknown): SnapshotAge => snapshotAge({ exportedAt: at }, now);
  const sources: ExportSource[] = [];
  const add = (kind: ExportSource["kind"], sourceFile: string | null | undefined, at: unknown, file: string | undefined, count?: number): void => {
    const { exportedAt, ageMs, problem } = aged(at);
    sources.push({ kind, sourceFile: sourceFile || null, ...(count === undefined ? {} : { count }), exportedAt, ageMs,
      ...(problem ? { problem } : {}), ...(file ? { file } : {}) });
  };
  const screenFile = (rel: unknown): string | undefined => (typeof rel === "string" && rel ? resolveInside(fresh.root, rel) ?? undefined : undefined);
  const named = fresh.screens.filter((g) => g.sourceFile !== null);
  for (const g of [...named, ...fresh.screens.filter((g) => g.sourceFile === null)]) add("screens", g.sourceFile, g.newestAt, screenFile(g.newestRow?.file), g.count);
  if (fresh.designSystem) add("design-system", fresh.designSystem.stamp.file, fresh.designSystem.stamp.exportedAt, fresh.designSystem.from);
  if (fresh.index && !fresh.screens.length) add("page-walk", fresh.index.sourceFile, fresh.index.exportedAt, fresh.index.from);
  // The older flat layout's single-screen pull wrote only design/<Screen>.json: an export too, consulted only when
  // nothing above is stamped. A stamped one wins over an unstamped one (design/variables.json — export-shaped, written
  // beside the screen doc, carrying no exportedAt of its own — is the case that forces it); an unstamped one is still
  // reported, with its warning, rather than "nothing exported".
  if (!sources.some((s) => s.exportedAt)) {
    const docs = topLevelDocs(fresh.root);
    const doc = docs.find((d) => !!d.exportedAt) ?? (sources.length ? undefined : docs[0]);
    if (doc) add("screen-doc", doc.label, doc.exportedAt, doc.file);
  }

  let newest: ExportNewest | null = null;
  for (const s of sources) {
    if (s.exportedAt === undefined || s.ageMs === undefined) continue;
    if (!newest || s.ageMs < newest.ageMs) newest = { exportedAt: s.exportedAt, ageMs: s.ageMs, kind: s.kind, sourceFile: s.sourceFile, file: s.file };
  }
  const first = sources[0];
  const label = (s: ExportSource): string => (s.file ? path.basename(s.file) : s.kind === "screens" ? "the screen index rows" : s.kind);
  const unknownFreshness = newest || !first ? undefined
    : first.problem === "unparseable" ? `exportedAt ('${first.exportedAt}') in ${label(first)} is not a parseable timestamp`
    : `no exportedAt stamp in ${label(first)} — freshness unknown (re-export with the current plugin)`;

  const best = fresh.newestScreen;
  const lastScreen: LastScreenExport | null = best && {
    name: typeof best.row.name === "string" ? best.row.name : undefined,
    id: best.row.id,
    file: typeof best.row.file === "string" ? best.row.file : undefined,
    exportedAt: best.exportedAt,
    ageMs: now - best.t,
    ...(typeof best.row.sourceFile === "string" && best.row.sourceFile ? { sourceFile: best.row.sourceFile } : {}),
  };

  return {
    root: fresh.root,
    exported: sources.length > 0 || fresh.problems.length > 0,
    sources,
    newest,
    staleAfterMs: STALE_MS,
    stale: newest !== null && newest.ageMs > STALE_MS,
    unknownFreshness,
    // a screen doc's label is a screen's name, not a Figma file's
    mixed: new Set(sources.filter((s) => s.kind !== "screen-doc" && s.sourceFile !== null).map((s) => s.sourceFile)).size > 1,
    problems: fresh.problems,
    lastScreen,
  };
}

/** The verdict on the export at `root` (export-reader.ts exportRoot resolves which), as of `now`. Never throws. */
export function readExportVerdict(root: string, now: number = Date.now()): ExportVerdict {
  return verdictOf(readExportFreshness(root), now);
}

/** figma_status's `snapshot`: the verdict in the shape that field has always had — the newest stamp's file, age and
 *  source (`warning` when there is none), or `{ file, error }` when the only export file there is unusable — with the
 *  verdict's attribution and staleness alongside. null when nothing is exported. */
export type StatusSnapshot =
  | { file: string; exportedAt: string | undefined; ageMs: number | undefined; sourceFile: string | undefined; warning: string | undefined;
      stale: boolean; staleAfterMs: number; sources: readonly ExportSource[]; problems: readonly ExportProblem[] }
  | { file: string; error: string; problems: readonly ExportProblem[] };

export function statusSnapshot(v: ExportVerdict): StatusSnapshot | null {
  const first = v.sources[0];
  if (!first) {
    const p = v.problems[0];
    return p ? { file: path.join(v.root, ...p.file.split("/")), error: `${p.file} ${p.error}`, problems: v.problems } : null;
  }
  const at = v.newest ?? first;
  return {
    file: at.file ?? v.root,
    exportedAt: at.exportedAt,
    ageMs: at.ageMs,
    sourceFile: at.sourceFile ?? undefined,
    warning: v.unknownFreshness,
    stale: v.stale,
    staleAfterMs: v.staleAfterMs,
    sources: v.sources,
    problems: v.problems,
  };
}
