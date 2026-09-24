// The ONE definition of how the design-system catalog is split across files — the sibling of
// pages-layout.ts, and it exists for the same two reasons.
//
// 1) SIZE. design-system.json used to be a single flat object holding every variable, every style,
//    every component and a lint report. On a real design-system file that is the biggest document in
//    the export after the layer tree, and an agent that only wants the token table had to load the
//    component catalog with it.
// 2) TAXONOMY. Those keys are not one thing. Figma's own model has three separate systems, verified
//    against developers.figma.com:
//      - Variables live in VariableCollections; a collection owns `modes` and `variableIds`, and every
//        Variable defines a value per mode (resolvedType COLOR/FLOAT/STRING/BOOLEAN).
//        -> tokens.json
//      - Styles are the older, separate system: PaintStyle/TextStyle/EffectStyle/GridStyle, each its
//        own BaseStyle object with its own id/name/description. Variables can be BOUND into a style's
//        fields (`boundVariables`), which is a reference between the two systems, not a merger.
//        -> styles.paint.json / styles.text.json / styles.effect.json / styles.grid.json (see below —
//        split the same way tokens/components/hygiene are, and for the same reason: a caller after only
//        typography no longer has to load every gradient and shadow in the file to get it)
//      - Components/ComponentSets are a third concept, with variant properties of their own.
//        -> components.local.json / components.library.json
//    The component split is a correctness fix, not just tidiness: entries flagged `remote: true` are
//    NOT nodes in this file. They are library mains recovered by walking instances (see libraries.ts),
//    so they have no id/page/pageId and their props may be INFERRED from the sample of instances
//    present. Mixing them into one array with real local components meant every consumer had to know
//    that half the rows are a different kind of thing. Now the filename says it.
// 3) hygiene is a lint-style report ABOUT the data, not data — it gets its own file.
//
// design-system.json stays, slim: the stamp (`exportedAt`/`file`/`colorProfile`) plus a `files`
// pointer map, so an existing consumer that opens design-system.json still finds its way. The stamp is
// repeated into every split file on purpose — snapshot-meta.ts and design-to-code/drift-lint.ts read
// `exportedAt` off whichever file they are handed, and design-to-code/tokens.ts, map-bootstrap.ts and
// drift-lint.ts are now pointed at tokens.json / components.local.json directly.
//
// Kept dependency-free (no Node imports, ES2019-safe) for the same reason as pages-layout.ts: the
// Node CLI imports it and esbuild inlines it into the plugin bundle, so the disk writer and the
// browser-download writer build the identical set of files.

// The parts live in a design-system/ SUBDIRECTORY, not next to design-system.json, because two
// of these names are already taken at the export root by files the user HAND-AUTHORS and cannot
// regenerate: design/tokens.json (Figma variable -> your code token) and design/components.json
// (Figma component -> your code component). A generated tokens.json at the root would overwrite the
// styling source of truth on every pull. The subdirectory keeps the taxonomy names AND that boundary:
// design/ root = your config + screens, design/design-system/ = the regenerable catalog.
import { safe } from "./pages-layout.ts"; // same filesystem-boundary sanitiser pages-layout.ts uses for layer files
import type { PageLayoutFile } from "./pages-layout.ts";
import { ifDefined } from "./json-util.ts";
import type {
  DesignSystemStamp, DesignSystemManifest, TokensDoc, PaintStylesDoc, TextStylesDoc, EffectStylesDoc, GridStylesDoc,
  HygieneDoc, CatalogVariant, CatalogComponent, ComponentsCatalog, ComponentDetailFile, DesignSystemStyles,
  DesignSystemDoc,
} from "./doc-types.ts";

/** Every document the split writes, in `files` order: tokens, the four style files, the two
 *  component catalogs, hygiene, any per-component detail files, and the slim manifest (last). */
export type DesignSystemFileData =
  | TokensDoc | PaintStylesDoc | TextStylesDoc | EffectStylesDoc | GridStylesDoc | ComponentsCatalog | HygieneDoc
  | ComponentDetailFile | DesignSystemManifest;

export interface DesignSystemLayout {
  /** Every file to write, INCLUDING the slim manifest (last). */
  files: Array<PageLayoutFile<DesignSystemFileData>>;
  /** The slim manifest alone: stamp + `files` pointer map + `counts`. */
  manifest: DesignSystemManifest;
  counts: DesignSystemManifest["counts"];
  /** The subdirectory the split parts live under ("design-system"). */
  dir: string;
}

const DIR = "design-system";
const COMPONENTS_DIR = "components"; // sibling subdir of design-system/, holds one detail file per COMPONENT_SET
const TOKENS = "tokens.json";
const STYLES_PAINT = "styles.paint.json";
const STYLES_TEXT = "styles.text.json";
const STYLES_EFFECT = "styles.effect.json";
const STYLES_GRID = "styles.grid.json";
const COMPONENTS_LOCAL = "components.local.json";
const COMPONENTS_LIBRARY = "components.library.json";
const HYGIENE = "hygiene.json";
const MANIFEST = "design-system.json";

// A library entry is one the plugin flagged `remote: true` (components.ts sets it for a consumed
// library main). The task's other signal — "has id/page/pageId" — is the same partition seen from the
// local side; `remote` is the flag the producer actually writes, so that is what we key on, and
// anything without it is treated as local.
export function isLibraryEntry(c: { remote?: unknown } | null | undefined): boolean {
  return !!(c && c.remote === true);
}

/**
 * @param ds   the plugin's designSystem doc
 * @param sep  path separator: "/" for real directories, "__" for flat download names — the
 *             same single knob pages-layout.ts has, and for the same reason (a browser
 *             download cannot create directories).
 * @returns    `files` is every file to write INCLUDING the slim manifest (last).
 */
export function buildDesignSystemLayout(ds: DesignSystemDoc | null | undefined, sep: string): DesignSystemLayout {
  const d: DesignSystemDoc = ds || {};
  const join = (name: string): string => DIR + (sep || "/") + name;
  // The stamp every split file carries. Written through byte for byte — nothing here re-derives it.
  const stamp: DesignSystemStamp = { ...ifDefined("exportedAt", d.exportedAt), ...ifDefined("file", d.file), ...ifDefined("colorProfile", d.colorProfile) };
  const components = Array.isArray(d.components) ? d.components : [];
  const rawLocal = components.filter((c) => !isLibraryEntry(c));
  const library = components.filter(isLibraryEntry);
  const hygiene = Array.isArray(d.hygiene) ? d.hygiene : [];

  // The heavy part of a COMPONENT_SET entry — variants[].node, a full serialized node tree per variant
  // (opt-in via runOpts.variantVisuals in components.ts) — is what makes components.local.json huge on
  // a real design-system file. Neither drift-lint.ts nor map-bootstrap.ts ever reads `.node` (both key
  // off name/id/key/type/props), so it is safe to split out unread. Everything else on the entry,
  // INCLUDING each variant's id/name/key/values, stays in the catalog byte for byte.
  const usedNames = new Set<string>();
  const uniqueDetailName = (name: string | undefined, id: string | undefined): string => {
    const base = safe(name || "component") + "__" + safe(id);
    if (!usedNames.has(base)) { usedNames.add(base); return base; }
    let i = 2;
    while (usedNames.has(base + "_" + i)) i++;
    usedNames.add(base + "_" + i);
    return base + "_" + i;
  };
  const componentFiles: Array<PageLayoutFile<ComponentDetailFile>> = [];
  const local = rawLocal.map((c): CatalogComponent => {
    // A standalone COMPONENT (variantVisuals also walks these now, components.ts) carries its own
    // node tree directly on `.node` rather than under `.variants[].node` — same reason to split it out
    // (unread by drift-lint.ts/map-bootstrap.ts, and it is the single biggest field on the entry), but
    // mirrored as its own nodeFile pointer since there is no variants array to slim here.
    if (c.type === "COMPONENT" && c.node) {
      const { node, ...rest } = c;
      const detailName = uniqueDetailName(c.name, c.id);
      const detailPath = DIR + (sep || "/") + COMPONENTS_DIR + (sep || "/") + detailName + ".json";
      componentFiles.push({
        path: detailPath,
        data: { ...stamp, ...ifDefined("id", c.id), ...ifDefined("key", c.key), name: c.name, node },
      });
      return { ...rest, nodeFile: detailPath };
    }
    if (c.type !== "COMPONENT_SET" || !Array.isArray(c.variants) || !c.variants.some((v) => v && v.node)) {
      return c; // no exported node trees (variantVisuals was off, or nothing serialized) -> no detail file, no pointer
    }
    // Object.assign + delete is `const { node, ...rest } = v || {}` (same keys, same order) without
    // destructuring a possibly-empty object.
    const slimVariants = c.variants.map((v): CatalogVariant => {
      const rest: CatalogVariant = Object.assign({}, v);
      delete rest.node;
      return rest;
    });
    const detailName = uniqueDetailName(c.name, c.id);
    const detailPath = DIR + (sep || "/") + COMPONENTS_DIR + (sep || "/") + detailName + ".json";
    componentFiles.push({
      path: detailPath,
      data: { ...stamp, ...ifDefined("setId", c.id), ...ifDefined("setKey", c.key), name: c.name, variants: c.variants },
    });
    return { ...c, variants: slimVariants, variantsFile: detailPath };
  });
  const styles: DesignSystemStyles = d.styles || {};
  const stylesPaint = Array.isArray(styles.paint) ? styles.paint : [];
  const stylesText = Array.isArray(styles.text) ? styles.text : [];
  const stylesEffect = Array.isArray(styles.effect) ? styles.effect : [];
  const stylesGrid = Array.isArray(styles.grid) ? styles.grid : [];

  const files: Array<PageLayoutFile<DesignSystemFileData>> = [
    { path: join(TOKENS), data: { ...stamp, ...ifDefined("collections", d.collections), ...ifDefined("variables", d.variables) } },
    { path: join(STYLES_PAINT), data: { ...stamp, styles: stylesPaint } },
    { path: join(STYLES_TEXT), data: { ...stamp, styles: stylesText } },
    { path: join(STYLES_EFFECT), data: { ...stamp, styles: stylesEffect } },
    { path: join(STYLES_GRID), data: { ...stamp, styles: stylesGrid } },
    { path: join(COMPONENTS_LOCAL), data: { ...stamp, components: local } },
    { path: join(COMPONENTS_LIBRARY), data: { ...stamp, components: library } },
    { path: join(HYGIENE), data: { ...stamp, hygiene } },
    ...componentFiles,
  ];

  const counts: DesignSystemManifest["counts"] = {
    collections: (d.collections || []).length,
    variables: (d.variables || []).length,
    stylesPaint: stylesPaint.length,
    stylesText: stylesText.length,
    stylesEffect: stylesEffect.length,
    stylesGrid: stylesGrid.length,
    components: local.length,
    libraryComponents: library.length,
    hygiene: hygiene.length,
  };

  // The pointer map carries the SAME relative paths the files actually landed under (separator and
  // all), so a consumer joins them against the export dir and needs to know nothing else — including
  // the download path, where the "directory" is really a "__" in the filename.
  const manifest: DesignSystemManifest = {
    ...stamp,
    files: {
      tokens: join(TOKENS),
      stylesPaint: join(STYLES_PAINT),
      stylesText: join(STYLES_TEXT),
      stylesEffect: join(STYLES_EFFECT),
      stylesGrid: join(STYLES_GRID),
      componentsLocal: join(COMPONENTS_LOCAL),
      componentsLibrary: join(COMPONENTS_LIBRARY),
      hygiene: join(HYGIENE),
    },
    counts,
  };
  // componentsDir is a POINTER, and a pointer that resolves to nothing is worse than an absent key:
  // a tool walking `files` verbatim got ENOENT on the one entry of nine that had never been written
  // (live finding 27). The directory only exists when a COMPONENT_SET actually produced a detail file
  // (variantVisuals is opt-in), so the key only exists then too.
  // Note the trailing separator: without it `design-system/components.local.json` — which is ALWAYS
  // written — matches the prefix `design-system/components` and the key never gets omitted.
  const detailPrefix = DIR + (sep || "/") + COMPONENTS_DIR + (sep || "/");
  if (files.some((f) => String(f.path).startsWith(detailPrefix))) {
    manifest.files.componentsDir = DIR + (sep || "/") + COMPONENTS_DIR;
  }
  files.push({ path: MANIFEST, data: manifest }); // the manifest itself stays at the export ROOT
  return { files, manifest, counts, dir: DIR };
}

export const DESIGN_SYSTEM_DIR: string = DIR;

// A type alias, not an interface: aliases carry an implicit string index signature, so
// Object.values<string>(DESIGN_SYSTEM_FILES) types as string[] (design-diff lists the sibling files).
/** Every file/dir name the split uses — the manifest's own name included (MANIFEST). */
export type DesignSystemFileNames = {
  TOKENS: string; STYLES_PAINT: string; STYLES_TEXT: string; STYLES_EFFECT: string; STYLES_GRID: string;
  COMPONENTS_LOCAL: string; COMPONENTS_LIBRARY: string; COMPONENTS_DIR: string; HYGIENE: string; MANIFEST: string;
};
export const DESIGN_SYSTEM_FILES: DesignSystemFileNames = {
  TOKENS, STYLES_PAINT, STYLES_TEXT, STYLES_EFFECT, STYLES_GRID, COMPONENTS_LOCAL, COMPONENTS_LIBRARY,
  COMPONENTS_DIR, HYGIENE, MANIFEST,
};
