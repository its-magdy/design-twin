// screen-inputs.ts — a screen plus what surrounds it, resolved once for audit.ts and cross-check.ts.
//
// Both CLIs judge one or more screen exports against the files beside them: each screen's own variable slice
// (<Screen>.vars.json) and asset manifest (<Screen>.assets.json), the export's merged variables.json, the design
// system (a design file's design-system/ or a --as-library export's libraries/<dir>/), the --as-library exports
// beside the export, the component map and the export's other screens. They used to assemble that context line for
// line in two places, with different defaults; here it is assembled once:
//
//   - variables: slice-sources.ts variablesContext — --variables, else the export root's union, else (a lone screen) its
//     own slice; a stale design/variables.json above design/export/ is never read, and is warned about.
//   - design system: --design-system, else the design-system/ of the export the first screen sits in, else — for a screen
//     in no export at all — that of the cwd's export (project-layout.ts findExportDir); never another export's beside a
//     screen whose own has none. Read in either layout (design-system-dir.ts readDesignSystemDir).
//   - map: --map (read fail-loud), else design/codeconnect.local.json or ./codeconnect.local.json; a found map that is
//     broken only labels nothing (a warning), since it labels proposals and decides nothing.
//   - siblings: every other screen the export indexes (bridge/src/export-reader.ts), read only when a report has proposals.
//
// An optional input that is not there is no input (crossCheck says which checks that cost) and a note saying where it
// was looked for; one that is there but broken is an error (variables) or the fail-loud exit of readDocFile (a screen,
// a design-system split file, a named map). The notes are the CLI's stderr lines, in order.
import fs from "node:fs";
import path from "node:path";
import { findExportDir, findMapFile } from "../bridge/src/project-layout.ts";
import { DESIGN_SYSTEM_DIR } from "../bridge/src/design-system-layout.ts";
import { readDocFile } from "./catalog-input.ts";
import { findLibraryExports, readDesignSystemDir } from "./design-system-dir.ts";
import type { DesignSystemDir, LibraryExport } from "./design-system-dir.ts";
import { isCodeConnectMap } from "./map-validate.ts";
import { isScreenAssetsDoc } from "./doc-guards.ts";
import { exportRootOfScreen, pagesRootOfScreen, readExportIndex, screenSiblingFile } from "../bridge/src/export-reader.ts";
import { isScreenDoc } from "./export-shape.ts";
import { readJson, readJsonOrNull } from "../bridge/src/read-json.ts";
import { variablesContext } from "./slice-sources.ts";
import type { SliceSources } from "./slice-sources.ts";
import type { CrossCheckInput, CrossCheckScreen } from "./cross-check.ts";
import type { CodeConnectMap, ComponentsCatalog, ScreenAssetsDoc, ScreenDoc, TokensDoc } from "./types.ts";

/** One screen as both CLIs read it: crossCheck's screen, plus its file and asset manifest (null when absent or unreadable —
 *  it is advice). */
export interface ScreenInput extends CrossCheckScreen {
  doc: ScreenDoc;
  file: string;
  assets: ScreenAssetsDoc | null;
}

/** The design system read, where from, and whether the user named it (`given`) or it was found beside the export. */
export type ScreenDesignSystem = DesignSystemDir & { dir: string; given: boolean };

/** A screen plus what surrounds it (see the top of the file). Field names are crossCheck's, so the context is its input. */
export interface ScreenInputs {
  screens: ScreenInput[];
  variables: TokensDoc | null;
  variablesPath: string | null;
  sliceSources: SliceSources | null;
  /** null when no design-system dir was given and none was found */
  designSystem: ScreenDesignSystem | null;
  libraries: LibraryExport[];
  map: CodeConnectMap | null;
  mapFile: string | null;
  siblings: (() => CrossCheckScreen[]) | null;
  /** the CLI's stderr lines: what was read, what was not there, what was ignored */
  notes: string[];
}

export interface ScreenInputsFlags {
  variables?: string | undefined;
  designSystem?: string | undefined;
  /** a map the user named: read fail-loud */
  map?: string | undefined;
  /** the CLI has a --map flag (the warning for a broken found map names it) */
  mapFlag?: boolean | undefined;
}

// The OTHER screens of the export a screen file sits in (<root>/pages/<Page>/<Screen>.json; every screen its index
// knows about — bridge/src/export-reader.ts), minus the files being checked. A thunk: nothing is read until a report has proposals
// to label. null when a file is not inside such an export (a legacy design/<Screen>.json) — sharedWith is then unknown, not 0.
export function exportSiblings(files: readonly string[]): (() => CrossCheckScreen[]) | null {
  const checked = new Set(files.map((f) => path.resolve(f)));
  const roots = new Set<string>();
  for (const f of checked) { const root = exportRootOfScreen(f); if (root !== null) roots.add(root); }
  if (!roots.size) return null;
  return () => {
    const out: CrossCheckScreen[] = [];
    const seen = new Set<string>(checked);
    for (const root of roots) {
      const ix = readExportIndex(root);
      for (const row of ix.rows) {
        const file = ix.fileOf(row); // a path inside the export only
        if (file === null || seen.has(file)) continue;
        seen.add(file);
        const doc = readJsonOrNull(file, isScreenDoc);
        if (doc) out.push({ doc, label: path.basename(file, ".json") });
      }
    }
    return out;
  };
}

// The design-system dir to read: the one named, else design-system/ of the first screen's export, else (a screen in no
// export) of the cwd's export — when it exists. A screen whose own export has no design system gets none: another
// export's is another Figma file's, and its findings (collision blockers among them) would gate this screen. A path
// under the cwd is printed relative to it, as the user would type it.
function designSystemDirOf(firstFile: string | undefined, named: string | undefined): { dir: string; given: boolean } | null {
  if (named) return { dir: named, given: true };
  const shown = (abs: string): string => { const rel = path.relative(process.cwd(), abs); return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : abs; };
  const root = firstFile === undefined ? null : pagesRootOfScreen(firstFile);
  const dir = root !== null ? path.join(root, DESIGN_SYSTEM_DIR) : path.resolve(findExportDir(process.cwd()).rel, DESIGN_SYSTEM_DIR);
  return fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? { dir: shown(dir), given: false } : null;
}

/** The screen files and the flags, resolved (see the top of the file); `errors` when a variables file is there but
 *  unusable. A screen, a design-system split file or a named map that is broken ends the CLI (readDocFile). */
export function readScreenInputs(files: readonly string[], flags: ScreenInputsFlags = {}): { inputs: ScreenInputs } | { errors: string[] } {
  const ctx = variablesContext(files, flags.variables, { sliceFallback: true });
  if (ctx.invalid.length) return { errors: ctx.invalid.map((bad) => `error  variables: '${bad.file}' ${bad.error}`) };
  const notes: string[] = [];
  if (ctx.variablesPath) notes.push(`variables: ${ctx.variablesPath}`);
  else notes.push("note  no variables: no variables.json at the export root or beside the screen (pass --variables)");
  // A stale legacy-layout design/variables.json next to design/export/ is never auto-read, but it can carry a different,
  // older set of slices than the one actually checked: say it exists and was NOT the file used.
  if (ctx.staleLegacy) notes.push(`warn  ${ctx.staleLegacy} also exists and was NOT used (stale sibling of design/export/) — remove it or re-pull into design/export/.`);
  const screens: ScreenInput[] = files.map((f, i) => ({
    file: f, doc: readDocFile(f, "screen export", isScreenDoc), label: path.basename(f, ".json"),
    ...(ctx.own[i] ? { vars: ctx.own[i] } : {}),
    assets: readJsonOrNull(screenSiblingFile(f, "assets"), isScreenAssetsDoc),
  }));
  const firstFile = files[0];
  const at = designSystemDirOf(firstFile, flags.designSystem);
  const designSystem: ScreenDesignSystem | null = at === null ? null : { ...readDesignSystemDir(at.dir), ...at };
  if (at === null) notes.push(`note  no design system: none given, and no ${DESIGN_SYSTEM_DIR}/ beside the export (pass --design-system)`);
  else if (at.given && !fs.existsSync(at.dir)) notes.push(`note  --design-system ${at.dir} does not exist — no design system was read`);
  else notes.push(`design system: ${at.dir}${at.given ? "" : " (found beside the export; pass --design-system to choose another)"}`);
  // The --as-library exports beside the export (libraries/index.json), found from the screen's own path or the
  // design-system dir's — never a directory the user did not already pull into.
  const libraries = findLibraryExports(firstFile, at?.dir);
  let map: CodeConnectMap | null = null, mapFile: string | null = null;
  if (flags.map) { map = readDocFile(flags.map, "component map", isCodeConnectMap); mapFile = flags.map; }
  else {
    const found = findMapFile(process.cwd());
    const r = found.missing ? null : readJson(found.rel, isCodeConnectMap);
    if (r && "doc" in r) { map = r.doc; mapFile = found.rel; notes.push(`map: ${found.rel}`); }
    else if (r) notes.push(`warn  ${found.rel} ${r.error} — proposals are not labelled alreadyMapped${flags.mapFlag ? " (pass --map to fail on it)" : ""}`);
  }
  return {
    inputs: {
      screens, variables: ctx.variablesDoc, variablesPath: ctx.variablesPath, sliceSources: ctx.sliceSources,
      designSystem, libraries, map, mapFile, siblings: exportSiblings(files), notes,
    },
  };
}

/** The design system with a catalog the user named (audit's --catalog): it stands in when a NAMED design system has no
 *  catalog, and beats the catalog of one only found beside the export — the user named that catalog, not that dir. */
export function withCatalog(ds: ScreenDesignSystem | null, catalog: ComponentsCatalog | undefined): ScreenDesignSystem | null {
  if (ds === null || catalog === undefined) return ds;
  return { ...ds, components: ds.given ? ds.components || catalog : catalog };
}

/** What crossCheck needs from a screen context (ScreenInputs, or audit's options with its screens). */
export interface CrossFileContext {
  screens: CrossCheckScreen[];
  variables?: TokensDoc | null | undefined;
  variablesPath?: string | null | undefined;
  sliceSources?: SliceSources | null | undefined;
  designSystem?: Partial<DesignSystemDir> | null | undefined;
  map?: CodeConnectMap | null | undefined;
  siblings?: (() => CrossCheckScreen[]) | null | undefined;
}

/** The context as crossCheck's input — the one mapping from a design-system dir's fields to crossCheck's. `components`
 *  stands in for the design system's catalog when it has none (audit's --catalog). */
export function crossCheckInputOf(c: CrossFileContext, fallback: { components?: ComponentsCatalog | null | undefined } = {}): CrossCheckInput {
  const ds = c.designSystem;
  return {
    screens: c.screens,
    variables: c.variables ?? null,
    variablesPath: c.variablesPath ?? null,
    sliceSources: c.sliceSources ?? null,
    tokens: ds?.tokens ?? null,
    components: ds?.components || fallback.components || null,
    componentsLibrary: ds?.componentsLibrary ?? null,
    stylesText: ds?.stylesText ?? null,
    ...(ds?.componentsFile !== undefined ? { componentsFile: ds.componentsFile } : {}),
    ...(ds?.isLibrary !== undefined ? { designSystemIsLibrary: ds.isLibrary } : {}),
    map: c.map ?? null,
    siblings: c.siblings ?? null,
  };
}
