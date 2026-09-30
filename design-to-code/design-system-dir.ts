// design-system-dir.ts — what a `--design-system <dir>` holds, and the --as-library exports beside it.
// Shared by audit.ts and cross-check.ts (their CLIs used to read the split files each on their own, and
// both read only components.local.json). Kept out of catalog-input.ts so the other CLIs that inline
// that module do not also pull in these guards.
import fs from "node:fs";
import path from "node:path";
import type { ComponentsCatalog, IndexRow, IrNode, TextStylesDoc, TokensDoc } from "./types.ts";
import { isScreenDoc, screenRoots } from "./export-shape.ts";
import { readOptionalDoc } from "./catalog-input.ts";
import { readJsonOrNull } from "./read-json.ts";
import { isComponentsCatalog, isLibrariesIndex, isPagesRootIndex, isTextStylesDoc, isTokensDoc } from "./doc-guards.ts";

// `--design-system <dir>` names one of TWO layouts (bridge/src/design-system-layout.ts and
// library-layout.ts): a design file's design-system/ (components.local.json + the sampled
// components.library.json) or a --as-library export's libraries/<dir>/, whose catalog is
// components.json — the library's own full definitions. Reading only components.local.json made a
// library dir silently lose its whole component catalog (DT-11).
/** What a design-system directory holds, whichever layout it is. Absent files are null. */
export interface DesignSystemDir {
  tokens: TokensDoc | null;
  components: ComponentsCatalog | null;
  componentsLibrary: ComponentsCatalog | null;
  stylesText: TextStylesDoc | null;
  /** the catalog's file name (components.local.json, or components.json in a library dir) */
  componentsFile: string;
  /** the dir is a --as-library export */
  isLibrary: boolean;
}
function readDesignSystemDir(dir: string): DesignSystemDir {
  const local = path.join(dir, "components.local.json");
  // a --as-library export: components.json and no components.local.json
  const isLibrary = !fs.existsSync(local) && fs.existsSync(path.join(dir, "components.json"));
  return {
    tokens: readOptionalDoc(path.join(dir, "tokens.json"), "design-system tokens", isTokensDoc),
    components: readOptionalDoc(isLibrary ? path.join(dir, "components.json") : local, "component catalog", isComponentsCatalog),
    componentsLibrary: readOptionalDoc(path.join(dir, "components.library.json"), "library component catalog", isComponentsCatalog),
    stylesText: readOptionalDoc(path.join(dir, "styles.text.json"), "text styles", isTextStylesDoc),
    componentsFile: isLibrary ? "components.json" : "components.local.json",
    isLibrary,
  };
}

// ---------------------------------------------------------------- libraries/ beside the export
/** One --as-library export listed in <export>/libraries/index.json. */
export interface LibraryExport {
  /** the directory as a path the user can pass back (`--design-system <rel>`) */
  rel: string;
  name: string;
  collectionKeys: string[];
  /** its components.json; null when absent or unreadable (discovery never fails the run) */
  components: ComponentsCatalog | null;
}
// The export root a screen file sits in: <root>/pages/<Page>/<Screen>__<id>.json. Else the root a
// --design-system dir sits in (<root>/design-system or <root>/libraries/<dir>). Null if neither fits.
function exportRootOf(screenFile: string | undefined, dsDir: string | undefined): string | null {
  const roots: string[] = [];
  if (screenFile) {
    const pages = path.dirname(path.dirname(screenFile));
    if (path.basename(pages) === "pages") roots.push(path.dirname(pages));
  }
  if (dsDir) {
    const parent = path.dirname(path.normalize(dsDir));
    roots.push(path.basename(parent) === "libraries" ? path.dirname(parent) : parent);
  }
  return roots.find((r) => fs.existsSync(path.join(r, "libraries", "index.json"))) ?? null;
}
// Every library the index lists. Read-only discovery: a missing or malformed index or catalog is
// "no library", never an exit — the audit must still run on a project that has none.
function findLibraryExports(screenFile: string | undefined, dsDir: string | undefined): LibraryExport[] {
  const root = exportRootOf(screenFile, dsDir);
  if (!root) return [];
  const index = readJsonOrNull(path.join(root, "libraries", "index.json"), isLibrariesIndex);
  if (!index) return [];
  return index.libraries
    .filter((r) => r.dir && r.dir !== "." && r.dir !== ".." && !/[\\/]/.test(r.dir)) // a directory NAME, never a path out of libraries/
    .map((r) => {
      const rel = path.join(root, "libraries", r.dir);
      return { rel, name: r.libraryName || r.dir, collectionKeys: r.collectionKeys || [], components: readJsonOrNull(path.join(rel, "components.json"), isComponentsCatalog) };
    });
}

// ---------------------------------------------------------------- the frames beside a screen (DT-22 / F-18)
/** A frame's texts read from its own export: `all` (hidden layers included — an empty-state sentence can
 *  sit anywhere) and `shallow` (within 6 levels of the root: loading/error words deeper are data). */
export interface FrameTexts { all: string[]; shallow: string[] }
/** What the export knows about frames OTHER than the audited one, read off disk. */
export interface ExportNeighbours {
  /** every row of pages/index.json (id, name, page/pageId, title, texts) */
  layers: IndexRow[];
  /** a row's own texts, read on demand (only when a state is not found) and cached; null if unreadable */
  textsOf?: (row: IndexRow) => FrameTexts | null;
  /** node ids of frames screenshotted into assets/ (<id>_ref.png / <id>_shot@Nx.png) with no index row */
  unexportedShots: string[];
}
// Disk only — the audit-design skill runs without Figma by default (D12), and "is this state drawn
// somewhere else?" is mostly answerable from the index's titles/texts and the orphan screenshots.
// The index's own `texts` are the first 8 strings in reading order — on a real screen, the sidebar —
// so an empty-state sentence is never among them. For frames on the audited frame's page, read their
// export and collect every TEXT (depth kept, so the audit can apply its own depth rule).
function readFrameTexts(file: string): FrameTexts | null {
  const doc = readJsonOrNull(file, isScreenDoc);
  if (!doc) return null;
  const all: string[] = [], shallow: string[] = [];
  const walk = (n: IrNode, depth: number): void => {
    if (n.type === "TEXT" && typeof n.text === "string" && n.text.trim()) { all.push(n.text); if (depth <= 6) shallow.push(n.text); }
    for (const c of Array.isArray(n.children) ? n.children : []) walk(c, depth + 1);
  };
  for (const r of screenRoots(doc)) walk(r, 0);
  return { all, shallow };
}
function findExportNeighbours(screenFile: string): ExportNeighbours | null {
  const pages = path.dirname(path.dirname(screenFile));
  if (path.basename(pages) !== "pages") return null;
  const root = path.dirname(pages);
  const index = readJsonOrNull(path.join(pages, "index.json"), isPagesRootIndex);
  if (!index) return null;
  const layers = index.layers || [];
  const cache = new Map<string, FrameTexts | null>();
  const textsOf = (row: IndexRow): FrameTexts | null => {
    const f = row.file;
    if (!f || path.isAbsolute(f) || f.split(/[\\/]/).includes("..")) return null; // a path inside the export only
    if (!cache.has(f)) cache.set(f, readFrameTexts(path.join(root, f)));
    return cache.get(f) ?? null;
  };
  const known = new Set(layers.map((l) => l.id.replace(/[:;]/g, "_")));
  const shots = new Set<string>();
  let files: string[] = [];
  try { files = fs.readdirSync(path.join(root, "assets")); } catch { files = []; }
  for (const f of files) {
    // write-out.ts names: <safe id>_ref.png (or _ref-<hash>[_N].png when the name was taken), <safe id>_shot@<scale>x.png
    const m = /^(\d+_\d+)(?:_ref(?:-[0-9A-Za-z]+(?:_\d+)?)?|_shot@[\d.]+x)\.png$/.exec(f);
    if (m && m[1] && !known.has(m[1])) shots.add(m[1].replace("_", ":"));
  }
  return { layers, unexportedShots: [...shots].sort(), textsOf };
}

export { readDesignSystemDir, findLibraryExports, findExportNeighbours };
