// design-system-dir.ts — what a `--design-system <dir>` holds, and the --as-library exports beside it.
// Shared by audit.ts and cross-check.ts, so the split files are read in one place (and a library dir's
// components.json is not missed). Kept out of catalog-input.ts so the other CLIs that inline
// that module do not also pull in these guards.
import fs from "node:fs";
import path from "node:path";
import type { ComponentsCatalog, IndexRow, IrNode, TextStylesDoc, TokensDoc } from "./types.ts";
import { isScreenDoc, screenRoots } from "./export-shape.ts";
import { readOptionalDoc, readSplitFile } from "./catalog-input.ts";
import { readJsonOrNull } from "./read-json.ts";
import { isComponentsCatalog, isLibrariesIndex, isPageIndex, isPagesRootIndex, isTextStylesDoc, isTokensDoc } from "./doc-guards.ts";
import { DESIGN_SYSTEM_FILES } from "../bridge/src/design-system-layout.ts";
import { COMPONENTS as LIBRARY_COMPONENTS, INDEX as LIBRARIES_INDEX, ROOT as LIBRARIES_DIR } from "../bridge/src/library-layout.ts";

const { TOKENS, STYLES_TEXT, COMPONENTS_LOCAL, COMPONENTS_LIBRARY } = DESIGN_SYSTEM_FILES;

// `--design-system <dir>` names one of TWO layouts (bridge/src/design-system-layout.ts and
// library-layout.ts): a design file's design-system/ (components.local.json + the sampled
// components.library.json) or a --as-library export's libraries/<dir>/, whose catalog is
// components.json — the library's own full definitions. Reading only components.local.json would make a
// library dir silently lose its whole component catalog.
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
  const local = path.join(dir, COMPONENTS_LOCAL);
  // a --as-library export: components.json and no components.local.json
  const isLibrary = !fs.existsSync(local) && fs.existsSync(path.join(dir, LIBRARY_COMPONENTS));
  return {
    tokens: readOptionalDoc(path.join(dir, TOKENS), "design-system tokens", isTokensDoc),
    components: readOptionalDoc(isLibrary ? path.join(dir, LIBRARY_COMPONENTS) : local, "component catalog", isComponentsCatalog),
    componentsLibrary: readOptionalDoc(path.join(dir, COMPONENTS_LIBRARY), "library component catalog", isComponentsCatalog),
    stylesText: readOptionalDoc(path.join(dir, STYLES_TEXT), "text styles", isTextStylesDoc),
    componentsFile: isLibrary ? LIBRARY_COMPONENTS : COMPONENTS_LOCAL,
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
    roots.push(path.basename(parent) === LIBRARIES_DIR ? path.dirname(parent) : parent);
  }
  return roots.find((r) => fs.existsSync(path.join(r, LIBRARIES_DIR, LIBRARIES_INDEX))) ?? null;
}
// Every library the index lists. Read-only discovery: a missing or malformed index or catalog is
// "no library", never an exit — the audit must still run on a project that has none.
function findLibraryExports(screenFile: string | undefined, dsDir: string | undefined): LibraryExport[] {
  const root = exportRootOf(screenFile, dsDir);
  if (!root) return [];
  const index = readJsonOrNull(path.join(root, LIBRARIES_DIR, LIBRARIES_INDEX), isLibrariesIndex);
  if (!index) return [];
  return index.libraries
    .filter((r) => r.dir && r.dir !== "." && r.dir !== ".." && !/[\\/]/.test(r.dir)) // a directory NAME, never a path out of libraries/
    .map((r) => {
      const rel = path.join(root, LIBRARIES_DIR, r.dir);
      return { rel, name: r.libraryName || r.dir, collectionKeys: r.collectionKeys || [], components: readJsonOrNull(path.join(rel, LIBRARY_COMPONENTS), isComponentsCatalog) };
    });
}

// ---------------------------------------------------------------- every catalog a map may point into
/** One component catalog read for drift-lint / map-bootstrap, and where it came from. */
export interface CatalogSource {
  file: string;
  catalog: ComponentsCatalog;
  /** named: the positional argument · extra: a --catalog · library: libraries/<dir>/components.json ·
   *  library-sample: components.library.json (components seen used from remote libraries, props sampled) */
  role: "named" | "extra" | "library" | "library-sample";
}
// A map entry may be keyed to a component that lives in a pulled library (libraries/<dir>/components.json)
// or that the design file only uses from one (design-system/components.library.json). Reading only the
// named catalog made every such entry `orphaned-entry` and kept map-bootstrap --screen from stubbing it.
// Order = precedence when two catalogs carry the same key: the named one, each --catalog, the full
// library definitions, then the sampled rows (fewest props). A file already in the list is not read twice.
// Discovered files that are absent or unreadable are skipped with a warning (like findLibraryExports);
// only a --catalog the user named fails loud (exit 2).
/** One catalog found beside the named one; `catalog` is null when the file is there but is not a readable catalog. */
export interface DiscoveredCatalog { file: string; role: "library" | "library-sample"; catalog: ComponentsCatalog | null }
// The ONE discovery order (CLI and MCP): every libraries/<dir>/components.json of the export, then the
// sampled components.library.json beside the named catalog. Never exits, never throws on a bad file —
// an absent file is left out, a present-but-broken one comes back with catalog:null for the caller to report.
function discoverCatalogs(namedFile: string, screenFile?: string): DiscoveredCatalog[] {
  const dir = path.dirname(namedFile);
  const out: DiscoveredCatalog[] = [];
  const seen = new Set([path.resolve(namedFile)]);
  const add = (file: string, role: DiscoveredCatalog["role"], catalog: ComponentsCatalog | null): void => {
    if (seen.has(path.resolve(file)) || !fs.existsSync(file)) return;
    seen.add(path.resolve(file));
    out.push({ file, role, catalog });
  };
  for (const lib of findLibraryExports(screenFile, dir)) add(path.join(lib.rel, LIBRARY_COMPONENTS), "library", lib.components);
  const sample = path.join(dir, COMPONENTS_LIBRARY);
  add(sample, "library-sample", readJsonOrNull(sample, isComponentsCatalog));
  return out;
}
// The CLI's set: the named catalog, each --catalog (the user named it: a broken one fails loud, exit 2),
// then discoverCatalogs' files — a broken DISCOVERED file is reported through `onSkip` and left out,
// like the MCP tool does (it was never asked for).
function readCatalogSet(namedFile: string, named: ComponentsCatalog, extraFiles: readonly string[], screenFile?: string, onSkip?: (file: string) => void): CatalogSource[] {
  const out: CatalogSource[] = [{ file: namedFile, catalog: named, role: "named" }];
  const seen = new Set([path.resolve(namedFile)]);
  for (const f of extraFiles) {
    if (seen.has(path.resolve(f))) continue;
    seen.add(path.resolve(f));
    out.push({ file: f, role: "extra", catalog: readSplitFile(f, "component catalog (--catalog)", isComponentsCatalog, "components", "design-system/components.library.json") });
  }
  for (const d of discoverCatalogs(namedFile, screenFile)) {
    if (seen.has(path.resolve(d.file))) continue;
    seen.add(path.resolve(d.file));
    if (d.catalog) out.push({ file: d.file, role: d.role, catalog: d.catalog });
    else if (onSkip) onSkip(d.file);
  }
  return out;
}
/** Every catalog's components in precedence order, the first row per key kept (the union a screen's
 *  instances are looked up in). Rows without a key are all kept. */
function unionCatalog(sources: readonly CatalogSource[]): ComponentsCatalog {
  const first = sources[0];
  const keys = new Set<string>();
  const components: ComponentsCatalog["components"] = [];
  for (const s of sources) for (const c of s.catalog.components) {
    if (c.key) { if (keys.has(c.key)) continue; keys.add(c.key); }
    components.push(c);
  }
  return { ...(first ? first.catalog : {}), components };
}
/** The one line naming every catalog read. */
const catalogSetLine = (sources: readonly CatalogSource[]): string =>
  `catalogs read (${sources.length}): ` + sources.map((s) => `${s.file} [${s.role}, ${s.catalog.components.length} component(s)]`).join(", ");

// ---------------------------------------------------------------- the frames beside a screen
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
  /** the id of every exported frame — the root index's rows and every page index's (pages/<dir>/index.json),
   *  which can list frames the root's `layers` does not. Absent: read `layers` alone. */
  exportedIds?: Set<string>;
}
// Disk only — the audit-design skill runs without Figma by default, and "is this state drawn
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
  // a prototype target is "exported" when ANY index lists it. Page rows are not added to `layers` (the
  // same-page state sweep above reads those, and a page index's rows would change what it offers).
  const exportedIds = new Set(layers.map((l) => l.id));
  for (const pd of index.pageDirs) {
    if (!pd.dir || /[\\/]/.test(pd.dir) || pd.dir === "..") continue; // a directory inside pages/ only
    for (const l of readJsonOrNull(path.join(pages, pd.dir, "index.json"), isPageIndex)?.layers ?? []) exportedIds.add(l.id);
  }
  return { layers, unexportedShots: [...shots].sort(), textsOf, exportedIds };
}

export { readDesignSystemDir, findLibraryExports, findExportNeighbours, discoverCatalogs, readCatalogSet, unionCatalog, catalogSetLine };
