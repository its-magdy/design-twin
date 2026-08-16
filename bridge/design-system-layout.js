// The ONE definition of how the design-system catalog is split across files — the sibling of
// pages-layout.js, and it exists for the same two reasons.
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
// repeated into every split file on purpose — snapshot-meta.js and tooling/drift-lint.js read
// `exportedAt` off whichever file they are handed, and tooling/tokens.js, map-bootstrap.js and
// drift-lint.js are now pointed at tokens.json / components.local.json directly.
//
// Kept dependency-free CJS for the same reason as pages-layout.js: the Node CLI requires it and
// esbuild inlines it into the plugin bundle, so the disk writer and the browser-download writer build
// the identical set of files.

// The parts live in a design-system/ SUBDIRECTORY, not next to design-system.json, because two
// of these names are already taken at the export root by files the user HAND-AUTHORS and cannot
// regenerate: design/tokens.json (Figma variable -> your code token) and design/components.json
// (Figma component -> your code component). A generated tokens.json at the root would overwrite the
// styling source of truth on every pull. The subdirectory keeps the taxonomy names AND that boundary:
// design/ root = your config + screens, design/design-system/ = the regenerable catalog.
const DIR = "design-system";
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
function isLibraryEntry(c) {
  return !!(c && c.remote === true);
}

/**
 * @param {any} ds     the plugin's designSystem doc
 * @param {string} sep path separator: "/" for real directories, "__" for flat download names — the
 *                     same single knob pages-layout.js has, and for the same reason (a browser
 *                     download cannot create directories).
 * @returns {{files: Array<{path: string, data: any}>, manifest: any, counts: any, dir: string}}
 *          `files` is every file to write INCLUDING the slim manifest (last).
 */
function buildDesignSystemLayout(ds, sep) {
  const d = ds || {};
  const join = (name) => DIR + (sep || "/") + name;
  // The stamp every split file carries. Written through byte for byte — nothing here re-derives it.
  const stamp = { exportedAt: d.exportedAt, file: d.file, colorProfile: d.colorProfile };
  const components = Array.isArray(d.components) ? d.components : [];
  const local = components.filter((c) => !isLibraryEntry(c));
  const library = components.filter(isLibraryEntry);
  const hygiene = Array.isArray(d.hygiene) ? d.hygiene : [];
  const styles = d.styles || {};
  const stylesPaint = Array.isArray(styles.paint) ? styles.paint : [];
  const stylesText = Array.isArray(styles.text) ? styles.text : [];
  const stylesEffect = Array.isArray(styles.effect) ? styles.effect : [];
  const stylesGrid = Array.isArray(styles.grid) ? styles.grid : [];

  const files = [
    { path: join(TOKENS), data: { ...stamp, collections: d.collections, variables: d.variables } },
    { path: join(STYLES_PAINT), data: { ...stamp, styles: stylesPaint } },
    { path: join(STYLES_TEXT), data: { ...stamp, styles: stylesText } },
    { path: join(STYLES_EFFECT), data: { ...stamp, styles: stylesEffect } },
    { path: join(STYLES_GRID), data: { ...stamp, styles: stylesGrid } },
    { path: join(COMPONENTS_LOCAL), data: { ...stamp, components: local } },
    { path: join(COMPONENTS_LIBRARY), data: { ...stamp, components: library } },
    { path: join(HYGIENE), data: { ...stamp, hygiene } },
  ];

  const counts = {
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
  const manifest = {
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
  files.push({ path: MANIFEST, data: manifest }); // the manifest itself stays at the export ROOT
  return { files, manifest, counts, dir: DIR };
}

module.exports = {
  buildDesignSystemLayout,
  isLibraryEntry,
  DESIGN_SYSTEM_FILES: {
    TOKENS, STYLES_PAINT, STYLES_TEXT, STYLES_EFFECT, STYLES_GRID, COMPONENTS_LOCAL, COMPONENTS_LIBRARY,
    HYGIENE, MANIFEST,
  },
};
