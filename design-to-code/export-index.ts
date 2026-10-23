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
//     so a reader never keeps a row the next write would replace. The root's row (the newest write) beats a page
//     index's. Between two page indexes' rows of one screen — a page renamed in Figma between pulls files the screen
//     under a second dir, and the old dir's index keeps the old row — the row whose screen file was written last wins:
//     every export rewrites the screen's file, while an index's own write time says nothing of its rows (a
//     single-screen pull rewrites a page index and carries its other rows over unchanged).
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

/** The root of the pages/ tree a screen file sits in — `<root>/pages/<dir>/<Screen>.json` — whether or not its root
 *  index is there (readExportIndex still reads the page indexes of such a tree); else null. */
export function pagesRootOfScreen(screenFile: string): string | null {
  const pages = path.dirname(path.dirname(path.resolve(screenFile)));
  return path.basename(pages) === PAGES ? path.dirname(pages) : null;
}

/** The export root a screen file sits in — `<root>/pages/<dir>/<Screen>.json`, with `<root>/pages/index.json` there —
 *  else null (a legacy design/<Screen>.json, a file outside any export). */
export function exportRootOfScreen(screenFile: string): string | null {
  const root = pagesRootOfScreen(screenFile);
  return root !== null && hasExportIndex(root) ? root : null;
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

/** A pointer an index holds ("/"-separated, relative to the export root), resolved inside the root only. Lexical, as
 *  verify-shared.ts resolveInside: `..` and absolute pointers are refused; a symlink placed inside the export is followed
 *  (no writer here makes one). */
const inside = (root: string, rel: string | undefined): string | null => (rel && !path.isAbsolute(rel) ? resolveInside(root, rel) : null);

// Every page index file, each once (absolute): each pageDirs entry's `index` pointer (else pages/<dir>/index.json), then
// every other pages/<dir>/index.json on disk — a page an earlier walk exported is listed by no pageDirs entry any more.
function pageIndexFiles(root: string, pageDirs: ReadonlyArray<{ dir?: string; index?: string }>): string[] {
  const files: string[] = [];
  const add = (f: string | null): void => { if (f !== null && !files.includes(path.resolve(f))) files.push(path.resolve(f)); };
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
  const fromRoot = new Set<IndexRow>();
  // when the row's screen file was last written; -1 when it cannot be read (it loses to any row whose file is there)
  const written = new Map<IndexRow, number>();
  const writtenAt = (row: IndexRow): number => {
    let t = written.get(row);
    if (t === undefined) {
      const f = inside(root, row.file);
      try { t = f === null ? -1 : fs.statSync(f).mtimeMs; } catch { t = -1; }
      written.set(row, t);
    }
    return t;
  };
  const hasFile = (row: IndexRow): boolean => { const file: unknown = row.file; return typeof file === "string" && file !== ""; };
  // one screen, one row (see the top of the file). A row with no `file` (hand-edited; the guards ask only for id and
  // name) shares no file with another such row.
  const take = (row: IndexRow, isRoot: boolean): void => {
    const probe = hasFile(row) ? row : { ...row, file: "\u0000no file " + rows.length };
    const same = byId.get(row.id) ?? [];
    const kept = same.find((k) => sameScreenRow(probe, k)) ?? (hasFile(row) && files.has(row.file) ? rows.find((k) => k.file === row.file) : undefined);
    if (kept !== undefined) {
      // a page index's row replaces another page index's row of the screen when its file was written later
      if (isRoot || fromRoot.has(kept) || writtenAt(row) <= writtenAt(kept)) return;
      rows[rows.indexOf(kept)] = row;
      const bucket = byId.get(kept.id) ?? [];
      bucket.splice(bucket.indexOf(kept), 1);
      if (!bucket.length) byId.delete(kept.id);
      if (hasFile(kept)) files.delete(kept.file);
    } else rows.push(row);
    const bucket = byId.get(row.id);
    if (bucket) bucket.push(row); else byId.set(row.id, [row]);
    if (hasFile(row)) files.add(row.file);
    if (isRoot) fromRoot.add(row);
  };
  for (const row of rootDoc?.layers ?? []) take(row, true);
  for (const f of pageIndexFiles(root, rootDoc?.pageDirs ?? [])) {
    for (const row of readJsonOrNull(f, isPageIndex)?.layers ?? []) take(row, false);
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
