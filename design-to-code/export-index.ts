// export-index.ts — every screen an export knows about: the READING side of bridge/src/pages-layout.ts's pages/ layout.
//
// An export indexes its screens twice: the root pages/index.json (`layers`, flattened across pages, plus `pageDirs`) and
// each page's own pages/<dir>/index.json. The two disagree by design: a page walk REPLACES the root index with that
// walk's pages alone (pages-layout.ts buildPageLayout, written whole by write-out.ts), while the page indexes of an
// earlier walk stay on disk and stay true. So "the root's `layers`" is not "every screen": a screen the first walk
// exported is in its page's index only once a second walk covers other pages. Every reader asks this module instead of
// reading either file itself, and gets one answer:
//
//   - rows: every row of the root index, then of every page index on disk (each `pageDirs` entry's index, then every
//     pages/<dir>/index.json), each screen once. Two rows are one screen by the WRITER's identity (pages-layout.ts
//     sameScreenRow, the rule mergeScreenIndex replaces a row by: the same file, or the same node of the same Figma
//     file — the key when both rows carry one, else the file name; an unstamped row and a stamped one by their pageId),
//     so a reader never keeps a row the next write would replace. The first row read is the newer one and wins: the
//     root's (the newest write) beats a page index's — a row a re-pull replaced in the root but left in another page's
//     index (a page renamed in Figma since) is that row's stale copy.
//   - isExported(id): some index lists the node.
//   - fileOf(row): the row's screen file, inside the export root only (a hand-edited `file` with `..` reads nothing).
//
// Nothing here throws: a missing or unreadable index adds no rows (the root's reason is kept for a caller that reports it).
import fs from "node:fs";
import path from "node:path";
import { EXPORT_DIR, EXPORT_SUBDIR } from "../bridge/src/project-layout.ts";
import { sameScreenRow } from "../bridge/src/pages-layout.ts";
import { isPageIndex, isPagesRootIndex } from "./doc-guards.ts";
import { readJson, readJsonOrNull } from "./read-json.ts";
import { resolveInside } from "./verify-shared.ts";
import type { IndexRow } from "./types.ts";

const PAGES = "pages";
const INDEX = "index.json";

/** The root index file of the export at `exportRoot`. */
export const rootIndexFile = (exportRoot: string): string => path.join(exportRoot, PAGES, INDEX);
/** Whether `exportRoot` holds an export index (pages/index.json). */
export const hasExportIndex = (exportRoot: string): boolean => fs.existsSync(rootIndexFile(exportRoot));

/** The export root a screen file sits in — `<root>/pages/<dir>/<Screen>.json`, with `<root>/pages/index.json` there —
 *  else null (a legacy design/<Screen>.json, a file outside any export). */
export function exportRootOfScreen(screenFile: string): string | null {
  const pages = path.dirname(path.dirname(path.resolve(screenFile)));
  if (path.basename(pages) !== PAGES) return null;
  const root = path.dirname(pages);
  return hasExportIndex(root) ? root : null;
}

/** The export root a mistaken dir points at: the first ancestor holding pages/index.json, else one that sits just below
 *  (`<dir>/export`, `<dir>/design/export`). null when there is none. */
export function findExportRoot(dir: string): string | null {
  const abs = path.resolve(dir);
  for (let d = path.dirname(abs); ; d = path.dirname(d)) {
    if (hasExportIndex(d)) return d;
    if (path.dirname(d) === d) break;
  }
  for (const sub of [EXPORT_SUBDIR, EXPORT_DIR]) {
    if (hasExportIndex(path.join(abs, sub))) return path.join(abs, sub);
  }
  return null;
}

/** One export's index, read once. */
export interface ExportIndex {
  /** the export root, as given */
  readonly root: string;
  /** pages/index.json was read */
  readonly indexed: boolean;
  /** why pages/index.json is there but unusable; null when it was read or is absent */
  readonly rootProblem: string | null;
  /** every indexed screen once: the root index's rows, then the page indexes' (see the top of the file) */
  readonly rows: readonly IndexRow[];
  /** some index lists the node */
  isExported(id: string): boolean;
  /** the row's screen file (absolute), when its `file` lies inside the export root; else null */
  fileOf(row: Pick<IndexRow, "file">): string | null;
}

/** A pointer an index holds ("/"-separated, relative to the export root), resolved inside the root only. */
const inside = (root: string, rel: string | undefined): string | null => (rel && !path.isAbsolute(rel) ? resolveInside(root, rel) : null);

// Every page index file, each once: each pageDirs entry's `index` pointer (else pages/<dir>/index.json), then every
// pages/<dir>/index.json on disk — a page an earlier walk exported is listed by no pageDirs entry any more.
function pageIndexFiles(root: string, pageDirs: ReadonlyArray<{ dir?: string; index?: string }>): string[] {
  const files: string[] = [];
  const add = (f: string | null): void => { if (f !== null && !files.includes(f)) files.push(f); };
  const ofDir = (dir: string | undefined): string | null =>
    dir && !/[\\/]/.test(dir) && dir !== ".." && dir !== "." ? path.join(root, PAGES, dir, INDEX) : null;
  for (const pd of pageDirs) add(pd.index ? inside(root, pd.index) : ofDir(pd.dir));
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(path.join(root, PAGES), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { /* no pages/ */ }
  for (const d of dirs) add(ofDir(d));
  return files;
}

/** The export at `exportRoot`'s index: every screen row once, under one merge rule. Never throws. */
export function readExportIndex(exportRoot: string): ExportIndex {
  const root = exportRoot;
  const read = readJson(rootIndexFile(root), isPagesRootIndex);
  const rootDoc = "doc" in read ? read.doc : null;
  const rows: IndexRow[] = [];
  const byId = new Map<string, IndexRow[]>();
  const files = new Set<string>();
  // a row is read after the rows that replace it (see the top of the file): it is dropped when one kept is its screen
  const take = (row: IndexRow): void => {
    const same = byId.get(row.id);
    if (files.has(row.file) || same?.some((kept) => sameScreenRow(row, kept))) return;
    if (same) same.push(row); else byId.set(row.id, [row]);
    files.add(row.file);
    rows.push(row);
  };
  for (const row of rootDoc?.layers ?? []) take(row);
  for (const f of pageIndexFiles(root, rootDoc?.pageDirs ?? [])) {
    for (const row of readJsonOrNull(f, isPageIndex)?.layers ?? []) take(row);
  }
  return {
    root,
    indexed: rootDoc !== null,
    rootProblem: "error" in read && !read.missing ? read.error : null,
    rows,
    isExported: (id) => byId.has(id),
    fileOf: (row) => inside(root, row.file),
  };
}
