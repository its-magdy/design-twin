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

// --------------------------------------------------------- title / texts (findings 16, 17, 70, 90, 120)
//
// The Figma LAYER name is not the name a user reads on screen: `positions ` (trailing space) IS "Job
// Roles"; `System Configurations` IS "Global Policies". A user who types the name they see gets
// nothing from the index unless the index also carries that visible title. It must come from the
// frame's OWN title slot, never from a sidebar/nav label drawn on every sibling screen (finding 120:
// "Global Policies" also appears as a `Sub titles` nav item on all three Organization-management
// screens) — so the rule is: the first TEXT node inside a descendant literally named "Page Title",
// and ONLY that; anywhere else and we would rather carry no title than a wrong one.
function firstByName(node, name) {
  if (!node || typeof node !== "object") return null;
  if (node.name === name) return node;
  for (const c of node.children || []) {
    const found = firstByName(c, name);
    if (found) return found;
  }
  return null;
}

// Figma's own placeholder for an unbound TEXT override inside a component instance renders the
// literal string "Text" (verified in the real export: a `Page Title` instance's leading `Breadcrumb`
// child carries one, "Back to Employees" style nav trails do too) — never a real title, so it is
// excluded rather than trusted as "the first text we found".
const PLACEHOLDER_TEXT = new Set(["text", "label"]);

function firstText(node) {
  if (!node || typeof node !== "object") return null;
  if (node.type === "TEXT" && typeof node.text === "string") {
    const t = node.text.trim();
    if (t && !PLACEHOLDER_TEXT.has(t.toLowerCase())) return node.text;
  }
  for (const c of node.children || []) {
    const found = firstText(c);
    if (found) return found;
  }
  return null;
}

// Within the Page Title slot, the layer that actually carries the visible title is itself named
// "Title" (verified across all five real screens in the test export: `Page Title > Title(FRAME) >
// Title Side(FRAME) > Title(TEXT)`, sitting AFTER a `Breadcrumb`/back-link instance that comes first
// in reading order but carries only nav chrome and unbound placeholder text). Preferring the node
// literally named "Title" over "first TEXT in the subtree" is what keeps the breadcrumb from winning.
function firstNamedText(node, name) {
  if (!node || typeof node !== "object") return null;
  if (node.type === "TEXT" && node.name === name && typeof node.text === "string" && node.text.trim()) {
    return node.text;
  }
  for (const c of node.children || []) {
    const found = firstNamedText(c, name);
    if (found) return found;
  }
  return null;
}

// The frame's own `Page Title`-shaped instance's text first (finding 120's fix: a value that is
// scoped to THIS frame, not repeated on every sibling), else the first TEXT node in the whole tree
// in reading order (placeholder text excluded either way). If nothing yields a non-empty string,
// return undefined — JSON.stringify drops an undefined value, so the row simply carries no `title`
// (never a guessed/wrong one).
function deriveTitle(root) {
  const slot = firstByName(root, "Page Title");
  if (slot) {
    const named = firstNamedText(slot, "Title");
    if (named) return named;
    const anyText = firstText(slot);
    if (anyText) return anyText;
  }
  const fallback = firstText(root);
  return fallback || undefined;
}

// The first N distinct, non-empty text strings in the tree, in reading order — a coarse fingerprint
// a text search (or a human eyeballing the index) can match against, independent of the layer name.
function collectTexts(root, limit) {
  const n = limit || 8;
  const seen = new Set();
  const out = [];
  (function walk(node) {
    if (!node || typeof node !== "object" || out.length >= n) return;
    if (node.type === "TEXT" && typeof node.text === "string") {
      const t = node.text.trim();
      if (t && !seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
    for (const c of node.children || []) {
      if (out.length >= n) break;
      walk(c);
    }
  })(root);
  return out;
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
    // title/texts come from THIS layer's own tree (findings 16/17/70/90/120) — computed here, once,
    // so both the per-page index and the root index (below) carry the same values for the same layer.
    const title = l.tree ? deriveTitle(l.tree) : undefined;
    const texts = l.tree ? collectTexts(l.tree) : undefined;
    bucket.entries.push({ ...((index || [])[i]), title, texts, file: join(bucket.dir, base) });
  });
  // `pageId` is what makes two same-named entries tellable apart by a consumer — without it the only
  // difference between them would be the disambiguating "_2" on a directory name, which is a
  // filesystem artefact, not identity. Omitted (not null) on pre-pageId exports: JSON.stringify drops
  // an undefined value, so the field's ABSENCE means "this export predates page ids", not "no page".
  meta.pageDirs = pages.map((b) => ({ page: b.page, pageId: b.pageId, dir: b.dir, index: b.index, layers: b.entries.length }));
  // A consumer is told to read the ROOT index (extract/SKILL.md), not walk every pageDirs.index one
  // hop down (finding 16) — so the root carries the same per-screen rows the per-page index does,
  // flattened across every page. Additive: pageDirs keeps its own shape/consumers (doctor.js et al).
  meta.layers = pages.flatMap((b) => b.entries);
  // The per-page index CONTENTS, not just its path — same reasoning as layerFiles. Both writers used
  // to spell `{ page, layers: entries }` out themselves, which put the one shape this module exists to
  // single-source back into two files; now they only stringify and write.
  const indexFiles = pages.map((b) => ({ path: b.index, data: { page: b.page, pageId: b.pageId, layers: b.entries } }));
  // `pages`/`byPage` stay BUILD STATE, deliberately not returned: the same page list is already public
  // as meta.pageDirs (dir + index + layer count), and returning a second view of it invited each writer
  // to pick a different one — three shapes to keep in sync for one list. Writers mkdir from pageDirs.
  return { meta, layerFiles, indexFiles, rootIndex: join("index.json") };
}


// ---------------------------------------------------------------- the single-screen twin
//
// A --node/--selection pull used to land FLAT: design/<Screen>.json, named from the layer alone. That
// gave a frame whose name ends in a space a file ending in `_`, let a second frame called `Popup`
// silently overwrite the first, and left the pull's variable slice and its assets with nowhere
// per-screen to live — while a --page pull of the very same frame wrote the nested layout above
// (live findings 47/50/63). Two layouts for one kind of content, and every downstream skill had to
// know which one it was looking at.
//
// So a screen files into the SAME tree: pages/<PageDir>/<Name>__<id>.json, with its token slice and
// its asset index as siblings. The difference from buildPageLayout is arrival, not shape — a page
// pull writes every layer at once and can compute its index in one pass, whereas screens accumulate
// one pull at a time, so the indexes here MERGE with whatever is already on disk (mergeScreenIndex
// below). The caller supplies the previous index; this module stays pure.
//
// `id` in the filename is the frame's own node id, which is what makes two same-named frames
// distinguishable — the same reason buildPageLayout suffixes its layer files.
const NO_PAGE_DIR = "_unfiled";

function screenPaths(screenDoc, sep) {
  const join = (...parts) => ["pages"].concat(parts).join(sep);
  const page = screenDoc.page || (screenDoc.screen && screenDoc.screen.page);
  const pageId = screenDoc.pageId || (screenDoc.screen && screenDoc.screen.pageId);
  // An export written before the plugin emitted page identity still has to land somewhere, and
  // somewhere PREDICTABLE — a bucket named for what it is beats inventing a page that was never read.
  const dir = page ? safe(page) : NO_PAGE_DIR;
  const nodeId = screenDoc.nodeId || (screenDoc.screen && screenDoc.screen.nodeId);
  const base = safe(screenDoc.screenName || "screen") + (nodeId ? "__" + safe(nodeId) : "");
  return {
    page: page || null,
    pageId: pageId || null,
    nodeId: nodeId || null,
    dir,
    base,
    screen: join(dir, base + ".json"),
    variables: join(dir, base + ".vars.json"),
    assets: join(dir, base + ".assets.json"),
    index: join(dir, "index.json"),
    rootIndex: join("index.json"),
  };
}

// Merge one screen's entry into a page index (or the root index's pageDirs), keyed on the FILE path —
// which is unique per (page, name, node id) by construction, so re-pulling the same frame replaces its
// row instead of appending a duplicate, and pulling a different frame with the same name adds one.
function mergeScreenIndex(prev, entry) {
  const base = prev && typeof prev === "object" ? prev : {};
  const layers = Array.isArray(base.layers) ? base.layers.filter((l) => l && l.file !== entry.file) : [];
  layers.push(entry);
  return Object.assign({}, base, { page: entry.page, pageId: entry.pageId, layers });
}

// The root pages/index.json is the ONE entry point a consumer opens without knowing which pull shape
// produced the tree: it lists every page directory, whether that page arrived as a whole-page sweep
// or as single screens pulled one at a time.
// `entry` is the SAME row shape a full-page pull puts in meta.layers (name, id, title, texts, file,
// …) — so the root index looks identical to a consumer regardless of which pull shape produced it
// (finding 16: the root is the ONE file every skill is told to read).
function mergeRootIndex(prev, paths, layerCount, entry) {
  const base = prev && typeof prev === "object" ? prev : {};
  const pageDirs = Array.isArray(base.pageDirs) ? base.pageDirs.filter((p) => p && p.dir !== paths.dir) : [];
  pageDirs.push({ page: paths.page, pageId: paths.pageId, dir: paths.dir, index: paths.index, layers: layerCount });
  const result = Object.assign({}, base, { pageDirs });
  if (entry) {
    const layers = Array.isArray(base.layers) ? base.layers.filter((l) => l && l.file !== entry.file) : [];
    layers.push(entry);
    result.layers = layers;
  }
  return result;
}

module.exports = { buildPageLayout, screenPaths, mergeScreenIndex, mergeRootIndex, deriveTitle, collectTexts, firstByName, firstText, safe, NO_PAGE_DIR };
