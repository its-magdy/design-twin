// The ONE definition of how a LIBRARY-file catalog is split across files — the sibling of
// design-system-layout.js, deliberately reusing its filenames and its slim-manifest shape.
//
// WHY A SECOND LAYOUT AT ALL. The two catalogs answer different questions and must not overwrite each
// other:
//   design/design-system/  = the catalog of the DESIGN file you are building screens from. Its
//                            variables are the subset your screens actually reference, so it is what
//                            codegen should emit — generating CSS from the full library would dump
//                            every unused primitive into the output.
//   design/libraries/<lib>/ = the COMPLETE catalog of one library file, exported by running the plugin
//                            inside that library. Its job is lookup/enrichment, not codegen: it is
//                            where you resolve what a token family really contains, and where a
//                            component's REAL property definitions live (the design file can only
//                            infer those from the instances that happen to be present).
// The join between them is `key` — durable cross-file identity, present on variables, collections,
// styles and components — NOT names, which collide across libraries.
//
// DIRECTORY IDENTITY is `<slug>-<fileKey8>`: a library is a FILE, and fileKey survives a rename, so a
// renamed library keeps writing to the same directory instead of forking into a second one. The slug is
// only there to keep the path human-readable. When figma.fileKey is unavailable the plugin says so in
// hygiene and we fall back to the slug alone — a rename then forks the directory, which is why it is
// warned about rather than silently absorbed.
//
// Kept dependency-free CJS for the same reason as its siblings: the Node CLI requires it and esbuild
// inlines it into the plugin bundle, so the disk writer and the browser-download writer emit the
// identical set of files.

const ROOT = "libraries";
const INDEX = "index.json"; // per-directory self-description; also the name of the libraries/ index
const TOKENS = "tokens.json";
const STYLES_PAINT = "styles.paint.json";
const STYLES_TEXT = "styles.text.json";
const STYLES_EFFECT = "styles.effect.json";
const STYLES_GRID = "styles.grid.json";
const COMPONENTS = "components.json";
const HYGIENE = "hygiene.json";

// Filesystem-safe, stable, lowercase. Same spirit as pages-layout.js's `safe`, kept local so this
// module stays dependency-free.
function slug(s) {
  return String(s || "library")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "library";
}

/**
 * @param {any} ds     the plugin's designSystem doc, as produced by collectLibraryFile
 * @param {string} sep path separator: "/" for real directories, "__" for flat download names.
 * @returns {{files: Array<{path: string, data: any}>, manifest: any, counts: any, dir: string}}
 *          `files` is every file to write INCLUDING the directory's own index.json (last).
 */
function buildLibraryLayout(ds, sep) {
  const d = ds || {};
  const s = sep || "/";
  const source = d.source || {};
  const fileKey = source.fileKey ? String(source.fileKey) : "";
  // Only the first 8 chars: enough to disambiguate two libraries, short enough to keep the path
  // readable. The FULL key is recorded in the index, so nothing depends on the truncation.
  const dirName = slug(source.libraryName || d.file) + (fileKey ? "-" + fileKey.slice(0, 8) : "");
  const dir = ROOT + s + dirName;
  const join = (name) => dir + s + name;

  // The stamp every split file carries, plus `source`. `exportedAt`/`file` stay top-level and
  // unmodified so snapshot-meta.js and tooling/drift-lint.js keep reading them off whichever file they
  // are handed; `source` is additive and tells a consumer this is a library catalog, not a design
  // file's — a distinction that is otherwise invisible, because inside the library file every object
  // is local and `remote` is therefore false on all of them.
  const stamp = { exportedAt: d.exportedAt, file: d.file, colorProfile: d.colorProfile, source: d.source };

  const variables = Array.isArray(d.variables) ? d.variables : [];
  const collections = Array.isArray(d.collections) ? d.collections : [];
  const styles = d.styles || {};
  const stylesPaint = Array.isArray(styles.paint) ? styles.paint : [];
  const stylesText = Array.isArray(styles.text) ? styles.text : [];
  const stylesEffect = Array.isArray(styles.effect) ? styles.effect : [];
  const stylesGrid = Array.isArray(styles.grid) ? styles.grid : [];
  const hygiene = Array.isArray(d.hygiene) ? d.hygiene : [];

  // Inside a library file every component IS local, so there is no local/library partition to make
  // (design-system-layout.js splits on `remote` because a design file's catalog genuinely mixes both).
  // A remote entry here would belong to a DIFFERENT library — that library's export to make, not this
  // one's — so it is dropped and reported rather than filed under this library's name.
  const all = Array.isArray(d.components) ? d.components : [];
  const components = all.filter((c) => !(c && c.remote === true));
  const foreign = all.length - components.length;
  const hyg = foreign
    ? hygiene.concat(
        foreign + " component(s) consumed from ANOTHER library were dropped from this catalog — " +
          "export that library separately; a library's catalog only claims what it defines."
      )
    : hygiene;

  const files = [
    { path: join(TOKENS), data: Object.assign({}, stamp, { collections, variables }) },
    { path: join(STYLES_PAINT), data: Object.assign({}, stamp, { styles: stylesPaint }) },
    { path: join(STYLES_TEXT), data: Object.assign({}, stamp, { styles: stylesText }) },
    { path: join(STYLES_EFFECT), data: Object.assign({}, stamp, { styles: stylesEffect }) },
    { path: join(STYLES_GRID), data: Object.assign({}, stamp, { styles: stylesGrid }) },
    { path: join(COMPONENTS), data: Object.assign({}, stamp, { components }) },
    { path: join(HYGIENE), data: Object.assign({}, stamp, { hygiene: hyg }) },
  ];

  // Publish status is only meaningful in library mode, so summarise it where a human will see it: how
  // much of this library is actually live for consumers vs. sitting unpublished in the file.
  const publishCounts = {};
  for (const c of components) if (c && c.publish) publishCounts[c.publish] = (publishCounts[c.publish] || 0) + 1;
  for (const v of variables) if (v && v.publish) publishCounts[v.publish] = (publishCounts[v.publish] || 0) + 1;

  const counts = {
    collections: collections.length,
    variables: variables.length,
    stylesPaint: stylesPaint.length,
    stylesText: stylesText.length,
    stylesEffect: stylesEffect.length,
    stylesGrid: stylesGrid.length,
    components: components.length,
    hygiene: hyg.length,
  };

  const manifest = Object.assign({}, stamp, {
    // Same pointer-map shape as design-system.json: relative paths exactly as written, separator and
    // all, so a consumer joins them against the export dir and needs to know nothing else.
    files: {
      tokens: join(TOKENS),
      stylesPaint: join(STYLES_PAINT),
      stylesText: join(STYLES_TEXT),
      stylesEffect: join(STYLES_EFFECT),
      stylesGrid: join(STYLES_GRID),
      components: join(COMPONENTS),
      hygiene: join(HYGIENE),
    },
    counts,
    publish: Object.keys(publishCounts).length ? publishCounts : undefined,
  });
  files.push({ path: join(INDEX), data: manifest });

  return { files, manifest, counts, dir, dirName };
}

/**
 * The libraries/ index: one row per library exported so far. Merged rather than overwritten, because
 * each library is a SEPARATE plugin run in a SEPARATE file — a second library's export must not erase
 * the first one's row. Rows are keyed by directory name (fileKey-derived), so re-exporting the same
 * library replaces its own row and nothing else.
 *
 * @param {any} prev  the previously written index, or null/undefined on the first export
 * @param {any} built the return value of buildLibraryLayout
 * @returns {any} the index to write
 */
function mergeLibrariesIndex(prev, built) {
  const rows = prev && Array.isArray(prev.libraries) ? prev.libraries.slice() : [];
  const m = built.manifest;
  const source = m.source || {};
  const row = {
    dir: built.dirName,
    libraryName: source.libraryName || m.file,
    file: m.file,
    fileKey: source.fileKey,
    collectionKeys: source.collectionKeys,
    exportedAt: m.exportedAt,
    counts: m.counts,
    publish: m.publish,
    index: built.dirName + "/" + INDEX,
  };
  const i = rows.findIndex((r) => r && r.dir === built.dirName);
  if (i >= 0) rows[i] = row;
  else rows.push(row);
  rows.sort((a, b) => String(a.dir).localeCompare(String(b.dir)));
  // No top-level `file`/`exportedAt` stamp here on purpose: this index spans SEVERAL Figma files, and
  // `file` is contractually "which one file did this come from" (snapshot-meta.js reads it as
  // sourceFile). Each row carries its own stamp instead, so per-library staleness stays visible.
  return { libraries: rows, generatedAt: new Date().toISOString() };
}

module.exports = { buildLibraryLayout, mergeLibrariesIndex, ROOT, INDEX };
