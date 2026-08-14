// The ONE definition of the pages/ layout an export lands in — shared by both writers.
//
// layers.json used to bundle EVERY exported top-level node into one file — measured 24MB on a real
// design-system export, unworkable for an agent that only wants to load one at a time. Split further:
// one directory per Figma PAGE (mirroring Figma's own Page > Frame containment — a page can hold many
// layers, never the reverse; "layer" is Figma's OWN term for any object in the file, per its Layers
// panel — "screen" stays reserved for a hand-picked single selection, not this indiscriminate sweep),
// one small file per layer inside it (safe(name) + safe(id), so same-named frames on different pages
// still can't collide — and pages themselves are bucketed by their ID, since page NAMES aren't unique
// either), a per-page index.json (so an agent working ONE page never has to load every
// OTHER page's manifest), plus a slim root pages/index.json carrying the run-wide manifest (manifest
// is accumulated per-RUN, not per-layer — see state.ts) and a `pageDirs` pointer to each page's
// directory + index file.
//
// TWO writers materialise this: bridge/figma-pull.js writes real nested directories, and the plugin's
// browser-download path (figma-plugin/src/main.ts) cannot — the HTML spec says user agents "should
// ignore any directory or path information provided by ... any download attribute", so `pages/Foo/bar
// .json` lands flat under a mangled name and every `file:` pointer with a slash was already dangling.
// It encodes the same hierarchy in the FILENAME instead. That separator is the ONLY difference, so it
// is the only knob here — everything else (bucketing, dir disambiguation, file naming, index shape,
// pageDirs) is computed once, in this file, and each caller only writes bytes. Kept dependency-free
// CJS so the Node CLI can require it and esbuild can inline it into the plugin bundle.

// Filesystem-boundary sanitiser for names that become paths. Asset filenames are NOT derived here —
// the plugin names each asset (assets.ts) and the node tree's `asset` path is built from that same
// string, so re-deriving the convention could silently point every path at a missing file.
function safe(id) {
  return String(id).replace(/[^a-zA-Z0-9]/g, "_");
}

/**
 * @param {any} layersDoc  the collector's layersDoc ({layers, index, ...manifest fields})
 * @param {string} sep     path separator: "/" for real directories, "__" for flat download names
 * @returns {{meta: any, layerFiles: Array<{path: string, data: any}>,
 *            indexFiles: Array<{path: string, data: any}>, rootIndex: string}}
 */
function buildPageLayout(layersDoc, sep) {
  const { layers, index, ...meta } = layersDoc || {};
  const join = (...parts) => ["pages"].concat(parts).join(sep);
  const byPage = new Map(); // page IDENTITY (id, or name pre-pageId) -> { dir, entries: [{...index[i], file}] }
  const pages = [];
  const layerFiles = [];
  // safe() folds every non-alphanumeric to "_", so DISTINCT page names collide ("Design System" /
  // "Design/System" / "Design-System" all -> "Design_System"). Sharing a directory meant the second
  // page's index.json OVERWROTE the first's, leaving the first page's layer files on disk but absent
  // from every index — invisible to any agent following the manifest. Layer filenames already carry
  // an id suffix for exactly this reason; page dirs get the same.
  const usedDirs = new Set();
  const uniqueDir = (name) => {
    const base = safe(name) || "page";
    if (!usedDirs.has(base)) { usedDirs.add(base); return base; }
    let i = 2;
    while (usedDirs.has(base + "_" + i)) i++;
    usedDirs.add(base + "_" + i);
    return base + "_" + i;
  };
  (layers || []).forEach((l, i) => {
    const pageName = l.page || "(no page)";
    // Bucket on the page ID, not its name. Figma's Plugin API documents NO uniqueness constraint on
    // PageNode.name (it is just "the name that appears in the layers panel", user-editable), and two
    // pages really can both be called "Screens" — collect.ts's resolveOne refuses an ambiguous name
    // for that reason. Keyed by name, those two DISTINCT pages merged into one bucket: one dir, one
    // index listing both, and a pageDirs entry claiming a layer count for a page that doesn't exist
    // as one page in Figma. uniqueDir() never fired, because only one bucket was ever created.
    // Fall back to the name when pageId is absent so exports written before it still lay out.
    const key = l.pageId || "name:" + pageName;
    let bucket = byPage.get(key);
    if (!bucket) {
      // The DIRECTORY still comes from the name (dirs are for humans reading the tree); uniqueDir()
      // suffixes the duplicate, exactly as it already did for distinct names that fold alike.
      bucket = { page: pageName, pageId: l.pageId, dir: uniqueDir(pageName), entries: [] };
      byPage.set(key, bucket);
      // `index` is a POINTER, like every layer entry's `file`, not something the consumer reassembles
      // from `dir` — a consumer rebuilding `pages/<dir>/index.json` would be right on exactly one of
      // the two layouts. Emitting the real relative path on both makes the rule uniform: open
      // `<outDir>/<index>` verbatim, whichever layout you were handed.
      bucket.index = join(bucket.dir, "index.json");
      pages.push(bucket);
    }
    const base = safe(l.name || "layer") + "__" + safe(l.id) + ".json";
    layerFiles.push({
      path: join(bucket.dir, base),
      data: { name: l.name, id: l.id, page: l.page, pageId: l.pageId, tree: l.tree, reference: l.reference, devResources: l.devResources },
    });
    bucket.entries.push({ ...((index || [])[i]), file: join(bucket.dir, base) });
  });
  // `pageId` is what makes two same-named entries tellable apart by a consumer — without it the only
  // difference between them would be the disambiguating "_2" on a directory name, which is a
  // filesystem artefact, not identity. Omitted (not null) on pre-pageId exports: JSON.stringify drops
  // an undefined value, so the field's ABSENCE means "this export predates page ids", not "no page".
  meta.pageDirs = pages.map((b) => ({ page: b.page, pageId: b.pageId, dir: b.dir, index: b.index, layers: b.entries.length }));
  // The per-page index CONTENTS, not just its path — same reasoning as layerFiles. Both writers used
  // to spell `{ page, layers: entries }` out themselves, which put the one shape this module exists to
  // single-source back into two files; now they only stringify and write.
  const indexFiles = pages.map((b) => ({ path: b.index, data: { page: b.page, pageId: b.pageId, layers: b.entries } }));
  // `pages`/`byPage` stay BUILD STATE, deliberately not returned: the same page list is already public
  // as meta.pageDirs (dir + index + layer count), and returning a second view of it invited each writer
  // to pick a different one — three shapes to keep in sync for one list. Writers mkdir from pageDirs.
  return { meta, layerFiles, indexFiles, rootIndex: join("index.json") };
}

module.exports = { buildPageLayout, safe };
