// design-system-dir.ts — what a `--design-system <dir>` holds, and the --as-library exports beside it.
// Shared by audit.ts and cross-check.ts (their CLIs used to read the split files each on their own, and
// both read only components.local.json). Kept out of catalog-input.ts so the other CLIs that inline
// that module do not also pull in these guards.
import fs from "node:fs";
import path from "node:path";
import type { ComponentsCatalog, TextStylesDoc, TokensDoc } from "./types.ts";
import { readOptionalDoc } from "./catalog-input.ts";
import { readJsonOrNull } from "./read-json.ts";
import { isComponentsCatalog, isLibrariesIndex, isTextStylesDoc, isTokensDoc } from "./doc-guards.ts";

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

export { readDesignSystemDir, findLibraryExports };
