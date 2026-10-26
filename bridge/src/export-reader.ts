// export-reader.ts — the READING side of an export: the one module every reader of the export layout asks, beside the
// modules that WRITE it (pages-layout.ts the pages/ tree, design-system-layout.ts the design-system split, both written
// by write-out.ts). It owns six things, and no reader re-derives any of them:
//
//   1) WHICH export: exportRoot(dir) — the dir given, else FIGMA_EXPORT_DIR, else this project's export (project-layout
//      findExportDir: design/export, or design/ on the older flat layout). write-out.ts writes where this reads. A
//      reader handed the design dir instead asks exportInDesignDir.
//   2) EVERY SCREEN: readExportIndex(root). An export indexes its screens twice: the root pages/index.json (`layers`,
//      flattened across pages, plus `pageDirs`) and each page's own pages/<dir>/index.json. The two disagree by design:
//      a page walk REPLACES the root index with that walk's pages alone (pages-layout.ts buildPageLayout, written whole
//      by write-out.ts), while the page indexes of an earlier walk stay on disk and stay true. So "the root's `layers`"
//      is not "every screen": a screen the first walk exported is in its page's index only once a second walk covers
//      other pages. The index gives one answer:
//        - rows: every row of the root index, then of every page index on disk (each `pageDirs` entry's index, then
//          every pages/<dir>/index.json), each screen once. Two rows are one screen by the WRITER's identity
//          (pages-layout.ts sameScreenRow, the rule mergeScreenIndex replaces a row by: the same file, or the same node
//          of the same Figma file — the key when both rows carry one, else the file name; an unstamped row and a
//          stamped one by their pageId), so a reader never keeps a row the next write would replace. The root's row
//          (the newest write) beats a page index's. Between two page indexes' rows of one screen — a page renamed in
//          Figma between pulls files the screen under a second dir, and the old dir's index keeps the old row — the
//          row whose screen file was written last wins: every export rewrites the screen's file, while an index's own
//          write time says nothing of its rows (a single-screen pull rewrites a page index and carries its other rows
//          over unchanged).
//        - isExported(id): some index lists the node.
//        - fileOf(row): the row's screen file, inside the export root only (a hand-edited `file` with `..` reads nothing).
//        - exportedAtOf(row): when the row's screen was pulled — its own stamp, else (a page walk stamps its root index
//          once) the root index's, for a row the root index lists.
//        - problems: every index that is there but unusable, by its export-relative name.
//   3) THE DESIGN SYSTEM'S STAMP: readDesignSystemStamp(root) — design-system.json's exportedAt/file/colorProfile, else
//      those a split part carries (design-system-layout.ts stamps every part).
//   4) A MANIFEST POINTER: designSystemPart(root, part) — the file design-system.json's `files.<part>` names, inside the
//      export only, or one sentence saying why there is none.
//   5) THE COMPONENT CATALOG: readComponentCatalog(root) — its rows and where they came from: the `files.componentsLocal`
//      pointer (the split layout), else design-system.json's own inline `components` (an export from before the split);
//      or why there is none.
//   6) FRESHNESS, PER SOURCE: readExportFreshness(root) — the design system's stamp (3), the page walk's, every screen (2)
//      grouped by the Figma file it came from, and the newest screen. doctor's export summary and figma_status's
//      snapshot / lastScreenExport (snapshot-meta.ts) are each one reading of it.
//
// Nothing here throws: a missing or unreadable file adds nothing, and a reader that reports it gets the reason.
import fs from "node:fs";
import path from "node:path";
import { EXPORT_DIR, EXPORT_SUBDIR, findExportDir, looksLikeExportDir } from "./project-layout.ts";
import { sameScreenRow } from "./pages-layout.ts";
import { DESIGN_SYSTEM_DIR, DESIGN_SYSTEM_FILES } from "./design-system-layout.ts";
import { isRecord } from "./json-util.ts";
import { readJson } from "./read-json.ts";
import type { DocGuard, ReadResult } from "./read-json.ts";
import type { DesignSystemManifest, DesignSystemStamp, IndexRow, PageDirEntry } from "./doc-types.ts";

const PAGES = "pages";
const INDEX = "index.json";

/** The export root a reader reads: `dir` when given, else FIGMA_EXPORT_DIR, else this project's export (project-layout
 *  findExportDir: design/export, or design/ on the older flat layout) — absolute, resolved against `cwd`. */
export function exportRoot(dir?: string | null, cwd: string = process.cwd()): string {
  return path.resolve(cwd, dir || process.env.FIGMA_EXPORT_DIR || findExportDir(cwd).rel);
}

/** The export a design dir holds, by findExportDir's rule one level down: `<designDir>/export`, else `<designDir>`
 *  itself when that is an export (the older flat layout). For a reader handed the design dir rather than the export. */
export function exportInDesignDir(designDir: string): string {
  const sub = path.join(designDir, EXPORT_SUBDIR);
  return !looksLikeExportDir(sub) && looksLikeExportDir(designDir) ? path.resolve(designDir) : path.resolve(sub);
}

/** `base` joined with a "/"-separated relative path, resolved, when it lies strictly inside `within` (default `base`) —
 *  else null (a pointer or a referenceImage.path with `..` segments never reads a file outside the export). Lexical
 *  only: no file is touched, and a symlink placed inside is followed (no writer here makes one). */
export function resolveInside(base: string, rel: string, within: string = base): string | null {
  const root = path.resolve(within), file = path.resolve(base, ...rel.split("/"));
  return file.startsWith(root + path.sep) ? file : null;
}

/** A pointer an export document holds ("/"-separated, relative to the export root), resolved inside the root only;
 *  an absolute pointer is refused too. */
const inside = (root: string, rel: unknown): string | null => (typeof rel === "string" && rel && !path.isAbsolute(rel) ? resolveInside(root, rel) : null);

/** An export file that is there but unusable: its name relative to the export root ("/"-spelt), and why. */
export interface ExportProblem { readonly file: string; readonly error: string }
const relOf = (root: string, file: string): string => path.relative(root, file).split(path.sep).join("/");
const problemOf = (root: string, file: string, read: ReadResult<unknown>): ExportProblem | null =>
  "error" in read && !read.missing ? { file: relOf(root, file), error: read.error } : null;

// ---------------------------------------------------------------- the index's guards
// Each checks the fields this module reads, and nothing more. A null row (an older index could hold one) is skipped.
// Each `Object.assign` is marked pure so a bundle that inlines this module for one helper drops the guards it never calls.
const optStr = (x: unknown): boolean => x === undefined || typeof x === "string";
const isIndexRowLike = (x: unknown): x is IndexRow => isRecord(x) && typeof x.id === "string" && typeof x.name === "string";
const isRowList = (x: unknown): x is Array<IndexRow | null> => Array.isArray(x) && x.every((r) => r === null || isIndexRowLike(r));
/** pages/index.json as read: `pageDirs` entries are checked for their `dir`/`index` pointers only. */
interface RootIndexOnDisk { pageDirs: Array<Partial<Pick<PageDirEntry, "dir" | "index">>>; layers?: Array<IndexRow | null>; exportedAt?: string }
const isPagesRootIndex: DocGuard<RootIndexOnDisk> = /* @__PURE__ */ Object.assign(
  (x: unknown): x is RootIndexOnDisk => isRecord(x) && Array.isArray(x.pageDirs) && x.pageDirs.every((d) => isRecord(d) && optStr(d.dir) && optStr(d.index))
    && (x.layers === undefined || isRowList(x.layers)) && optStr(x.exportedAt),
  { expected: "the export's pages/index.json: an object with a `pageDirs` array (and `layers`, when present, an array of {id, name, file})" });
const isPageIndex: DocGuard<{ layers: Array<IndexRow | null> }> = /* @__PURE__ */ Object.assign(
  (x: unknown): x is { layers: Array<IndexRow | null> } => isRecord(x) && isRowList(x.layers),
  { expected: "a page index (pages/<Page>/index.json): an object with a `layers` array of {id, name, file}" });

// ---------------------------------------------------------------- where the index lives
/** A screen export's sibling file of `kind`: `<stem>.vars.json` (its variable slice) or `<stem>.assets.json` (its asset
 *  manifest) — pages-layout.ts screenPaths' names, beside the screen. */
export function screenSiblingFile(screenFile: string, kind: "vars" | "assets"): string {
  return screenFile.replace(/\.json$/i, "") + "." + kind + ".json";
}

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

// ---------------------------------------------------------------- every screen
/** One export's index, read once. */
export interface ExportIndex {
  /** the export root, as given */
  readonly root: string;
  /** pages/index.json was read */
  readonly indexed: boolean;
  /** why pages/index.json is there but unusable; null when it was read or is absent */
  readonly rootProblem: string | null;
  /** every index that is there but unusable (the root's among them): its rows are not in `rows` */
  readonly problems: readonly ExportProblem[];
  /** every indexed screen once: the root index's rows, then the page indexes' (see the top of the file) */
  readonly rows: readonly IndexRow[];
  /** pages/index.json's own `exportedAt` (a page walk stamps its root index once); undefined when absent */
  readonly rootExportedAt: string | undefined;
  /** some index lists the node */
  isExported(id: string): boolean;
  /** the row's screen file (absolute), when its `file` lies inside the export root; else null */
  fileOf(row: Pick<IndexRow, "file">): string | null;
  /** when the row's screen was pulled: its own `exportedAt`, else the root index's for a row the root index lists (a
   *  page walk stamps its root index once); undefined when neither is there */
  exportedAtOf(row: IndexRow): string | undefined;
}

// Every page index file, each once (absolute): each pageDirs entry's `index` pointer (else pages/<dir>/index.json), then
// every other pages/<dir>/index.json on disk — a page an earlier walk exported is listed by no pageDirs entry any more.
function pageIndexFiles(root: string, pageDirs: RootIndexOnDisk["pageDirs"]): string[] {
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
  const rootFile = rootIndexFile(root);
  const read = readJson(rootFile, isPagesRootIndex);
  const rootDoc = "doc" in read ? read.doc : null;
  const problems: ExportProblem[] = [];
  const rootProblem = problemOf(root, rootFile, read);
  if (rootProblem) problems.push(rootProblem);
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
  // A row with no `file` (hand-edited; the guards ask only for id and name) shares no file with another such row.
  const probeOf = (row: IndexRow): IndexRow => (hasFile(row) ? row : { ...row, file: "\u0000no file " + rows.length });
  // sameScreenRow(older, newer) is the writer's rule, and it is not symmetric: asked with the newer row second
  const sameScreen = (older: IndexRow, newer: IndexRow): boolean => (hasFile(older) && older.file === newer.file) || sameScreenRow(probeOf(older), newer);
  const keep = (row: IndexRow, isRoot: boolean): void => {
    rows.push(row);
    const bucket = byId.get(row.id);
    if (bucket) bucket.push(row); else byId.set(row.id, [row]);
    if (hasFile(row)) files.add(row.file);
    if (isRoot) fromRoot.add(row);
  };
  // one screen, one row (see the top of the file). The root's rows come first: the writer merged them already, and the
  // first of two it left is kept. A page index's row is dropped beside a root row of its screen; beside page rows of its
  // screen it replaces every one of them when its screen file was written after each, else it is dropped.
  const take = (row: IndexRow, isRoot: boolean): void => {
    const candidates = [...(byId.get(row.id) ?? []), ...(hasFile(row) && files.has(row.file) ? rows.filter((k) => k.file === row.file && k.id !== row.id) : [])];
    if (isRoot) { if (!candidates.some((k) => sameScreen(row, k))) keep(row, true); return; }
    const newer = (k: IndexRow): boolean => writtenAt(row) > writtenAt(k);
    const conflicts = candidates.filter((k) => (fromRoot.has(k) || !newer(k) ? sameScreen(row, k) : sameScreen(k, row)));
    if (!conflicts.length) { keep(row, false); return; }
    if (conflicts.some((k) => fromRoot.has(k) || !newer(k))) return;
    const at = Math.min(...conflicts.map((k) => rows.indexOf(k))); // the earliest: removing the others leaves it in place
    for (const k of conflicts) {
      rows.splice(rows.indexOf(k), 1);
      const bucket = byId.get(k.id) ?? [];
      bucket.splice(bucket.indexOf(k), 1);
      if (!bucket.length) byId.delete(k.id);
      if (hasFile(k) && !rows.some((r) => r.file === k.file)) files.delete(k.file);
    }
    keep(row, false);
    rows.splice(rows.length - 1, 1);
    rows.splice(at, 0, row);
  };
  for (const row of rootDoc?.layers ?? []) if (row) take(row, true);
  for (const f of pageIndexFiles(root, rootDoc?.pageDirs ?? [])) {
    const page = readJson(f, isPageIndex);
    const problem = problemOf(root, f, page);
    if (problem) problems.push(problem);
    if ("doc" in page) for (const row of page.doc.layers) if (row) take(row, false);
  }
  const rootStamp = rootDoc?.exportedAt || undefined;
  return {
    root,
    indexed: rootDoc !== null,
    rootProblem: rootProblem && rootProblem.error,
    problems,
    rows,
    rootExportedAt: rootStamp,
    isExported: (id) => byId.has(id),
    fileOf: (row) => inside(root, row.file),
    exportedAtOf: (row) => (typeof row.exportedAt === "string" && row.exportedAt) || (fromRoot.has(row) ? rootStamp : undefined),
  };
}

// ---------------------------------------------------------------- the design system
/** A part design-system.json's `files` map points at. */
export type DesignSystemPart = keyof DesignSystemManifest["files"];
/** design-system.json as a reader sees it: the stamp and the `files` pointer map (each pointer checked when followed).
 *  A pre-split export inlined `components` here instead. */
export interface DesignSystemManifestView extends DesignSystemStamp { files?: Record<string, unknown>; components?: unknown }
const isStampLike = (x: unknown): x is DesignSystemStamp => isRecord(x) && optStr(x.exportedAt) && optStr(x.file) && optStr(x.colorProfile);
const isDesignSystemManifest: DocGuard<DesignSystemManifestView> = /* @__PURE__ */ Object.assign(
  (x: unknown): x is DesignSystemManifestView => isStampLike(x) && isRecord(x) && (x.files === undefined || isRecord(x.files)),
  { expected: "a design-system manifest: an object whose `exportedAt`, `file` and `colorProfile`, when present, are strings and whose `files`, when present, is an object of pointers" });
const isStampedPart: DocGuard<DesignSystemStamp> = /* @__PURE__ */ Object.assign(isStampLike,
  { expected: "a design-system part: an object whose `exportedAt`, `file` and `colorProfile`, when present, are strings" });

/** design-system.json of the export at `root`. */
export const designSystemManifestFile = (root: string): string => path.join(root, DESIGN_SYSTEM_FILES.MANIFEST);
/** design-system.json, read and checked (the reason, when unusable, follows the file name). */
export const readDesignSystemManifest = (root: string): ReadResult<DesignSystemManifestView> => readJson(designSystemManifestFile(root), isDesignSystemManifest);

const stampOf = (doc: DesignSystemStamp): DesignSystemStamp => {
  const s: DesignSystemStamp = {};
  if (doc.exportedAt !== undefined) s.exportedAt = doc.exportedAt;
  if (doc.file !== undefined) s.file = doc.file;
  if (doc.colorProfile !== undefined) s.colorProfile = doc.colorProfile;
  return s;
};

/** The design system's stamp and the file it was read from — design-system.json's, else that of
 *  design-system/tokens.json (every split part carries it); of the two, the first that carries `exportedAt`, else the
 *  first usable. null when neither is there and usable; `problems` names each that is there but unusable. */
export function readDesignSystemStamp(root: string): { stamp: DesignSystemStamp | null; from: string | null; problems: ExportProblem[] } {
  const problems: ExportProblem[] = [];
  const manifestFile = designSystemManifestFile(root);
  const manifest = readDesignSystemManifest(root);
  if ("doc" in manifest && manifest.doc.exportedAt) return { stamp: stampOf(manifest.doc), from: manifestFile, problems };
  const mp = problemOf(root, manifestFile, manifest);
  if (mp) problems.push(mp);
  const tokensFile = path.join(root, DESIGN_SYSTEM_DIR, DESIGN_SYSTEM_FILES.TOKENS);
  const tokens = readJson(tokensFile, isStampedPart);
  const tp = problemOf(root, tokensFile, tokens);
  if (tp) problems.push(tp);
  if ("doc" in tokens && tokens.doc.exportedAt) return { stamp: stampOf(tokens.doc), from: tokensFile, problems };
  if ("doc" in manifest) return { stamp: stampOf(manifest.doc), from: manifestFile, problems };
  return "doc" in tokens ? { stamp: stampOf(tokens.doc), from: tokensFile, problems } : { stamp: null, from: null, problems };
}

// A pointer of a manifest already read: the file, inside the export only, or why there is none.
function partOf(root: string, manifest: ReadResult<DesignSystemManifestView>, part: DesignSystemPart): { file: string } | { error: string } {
  const file = designSystemManifestFile(root);
  if ("error" in manifest) {
    return { error: manifest.missing
      ? `no design export found at ${file} — run an export first (a --design-system or full pull)`
      : `${file} ${manifest.error} — re-export with a current dtwin` };
  }
  const rel = manifest.doc.files?.[part];
  if (typeof rel !== "string" || !rel) return { error: `${file} has no files.${part} pointer — re-export with a current dtwin` };
  const target = inside(root, rel);
  return target === null ? { error: `${file} files.${part} ('${rel}') leads outside the export — re-export with a current dtwin` } : { file: target };
}

/** The file design-system.json's `files.<part>` pointer names (absolute), inside the export only — else why there is
 *  none, as one sentence naming the manifest. A reader that cannot go on without the part says it; one that can, may. */
export function designSystemPart(root: string, part: DesignSystemPart): { file: string } | { error: string } {
  return partOf(root, readDesignSystemManifest(root), part);
}

// ---------------------------------------------------------------- the component catalog
/** The export's component catalog: its rows and the file they were read from — `pointer`: the file design-system.json's
 *  `files.componentsLocal` names (the split layout); `inline`: design-system.json itself, whose own `components` array an
 *  export from before the split carries — or why there is none (`missing`: no design-system.json at all, i.e. nothing
 *  exported yet, which a reader that can go on without the catalog may pass over). Rows are as on disk: each reader
 *  checks the fields it reads. */
export type ComponentCatalog =
  | { readonly file: string; readonly source: "pointer" | "inline"; readonly components: readonly unknown[] }
  | { readonly error: string; readonly missing: boolean };
const isCatalogDoc: DocGuard<{ components: unknown[] }> = /* @__PURE__ */ Object.assign(
  (x: unknown): x is { components: unknown[] } => isRecord(x) && Array.isArray(x.components),
  { expected: "a component catalog: an object with a `components` array" });

/** The component catalog of the export at `root`: the `files.componentsLocal` pointer when the manifest has one, else
 *  the manifest's inline `components` (a pre-split export). Never throws. */
export function readComponentCatalog(root: string): ComponentCatalog {
  const manifest = readDesignSystemManifest(root);
  if ("doc" in manifest && manifest.doc.files?.componentsLocal === undefined && Array.isArray(manifest.doc.components)) {
    return { file: designSystemManifestFile(root), source: "inline", components: manifest.doc.components };
  }
  const part = partOf(root, manifest, "componentsLocal");
  if ("error" in part) return { error: part.error, missing: "error" in manifest && manifest.missing === true };
  const catalog = readJson(part.file, isCatalogDoc);
  return "doc" in catalog
    ? { file: part.file, source: "pointer", components: catalog.doc.components }
    : { error: `${part.file} ${catalog.error}`, missing: false };
}

// ---------------------------------------------------------------- freshness, per source
/** The screens one Figma file contributed: rows sharing a `sourceFile` (null: rows pulled before rows were stamped). */
export interface ScreenSource {
  readonly sourceFile: string | null;
  readonly count: number;
  /** the newest parseable stamp among them (exportedAtOf); undefined when none has one */
  readonly newestAt: string | undefined;
}
/** How fresh the export at `root` is, per source, read once: the design system's stamp, the page walk's, every screen
 *  grouped by the Figma file it came from, and the newest screen. */
export interface ExportFreshness {
  readonly root: string;
  /** readDesignSystemStamp's answer, when there is one: the stamp and the file (absolute) it was read from */
  readonly designSystem: { readonly stamp: DesignSystemStamp; readonly from: string } | null;
  /** pages/index.json's own stamp, when it was read */
  readonly index: { readonly from: string; readonly exportedAt: string | undefined } | null;
  /** every indexed screen (readExportIndex), grouped by source in first-seen order */
  readonly screens: readonly ScreenSource[];
  /** the row with the newest parseable stamp (a tie goes to the later row: merges append the newest pull) */
  readonly newestScreen: { readonly row: IndexRow; readonly exportedAt: string; readonly t: number } | null;
  /** every index, manifest or part that is there but unusable */
  readonly problems: readonly ExportProblem[];
}

/** The export at `root`'s freshness, per source. Never throws. */
export function readExportFreshness(root: string): ExportFreshness {
  const ix = readExportIndex(root);
  const ds = readDesignSystemStamp(root);
  const groups = new Map<string | null, { count: number; newestAt: string | undefined; t: number }>();
  let newestScreen: ExportFreshness["newestScreen"] = null;
  for (const row of ix.rows) {
    const at = ix.exportedAtOf(row);
    const t = at ? Date.parse(at) : NaN;
    const key = typeof row.sourceFile === "string" && row.sourceFile ? row.sourceFile : null;
    let g = groups.get(key);
    if (!g) { g = { count: 0, newestAt: undefined, t: -Infinity }; groups.set(key, g); }
    g.count++;
    if (at && !Number.isNaN(t) && t > g.t) { g.newestAt = at; g.t = t; }
    if (row.id && at && !Number.isNaN(t) && (!newestScreen || t >= newestScreen.t)) newestScreen = { row, exportedAt: at, t };
  }
  return {
    root,
    designSystem: ds.stamp && ds.from ? { stamp: ds.stamp, from: ds.from } : null,
    index: ix.indexed ? { from: rootIndexFile(root), exportedAt: ix.rootExportedAt } : null,
    screens: [...groups].map(([sourceFile, g]) => ({ sourceFile, count: g.count, newestAt: g.newestAt })),
    newestScreen,
    problems: [...ix.problems, ...ds.problems],
  };
}
