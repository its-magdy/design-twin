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
// TWO writers materialise this: bridge/src/figma-pull.ts writes real nested directories, and the plugin's
// browser-download path (figma-plugin/src/main.ts) cannot — the HTML spec says user agents "should
// ignore any directory or path information provided by ... any download attribute", so `pages/Foo/bar
// .json` lands flat under a mangled name and every `file:` pointer with a slash was already dangling.
// It encodes the same hierarchy in the FILENAME instead. That separator is the ONLY difference, so it
// is the only knob here — everything else (bucketing, dir disambiguation, file naming, index shape,
// pageDirs) is computed once, in this file, and each caller only writes bytes. Kept dependency-free
// (no Node imports, ES2019-safe) so the Node CLI can import it and esbuild can inline it into the
// plugin bundle — it type-checks under the plugin's tsconfig as well as the bridge's.

import type { LayerFile, IndexRow, PageDirEntry, PageIndex, PagesRootIndex, LayersDoc } from "./doc-types.ts";
import { ifDefined } from "./json-util.ts";

/** One file a layout builder emits: where it lands (joined with the caller's separator — emit this
 *  verbatim) and its contents as an object (the caller decides how to stringify it). */
export interface PageLayoutFile<T> {
  path: string;
  data: T;
}

export interface PageLayout {
  /**
   * layersDoc minus layers/index, plus the computed `pageDirs` — one entry per page, carrying
   * `{page, pageId?, dir, index, layers}`. Pages are bucketed by `pageId`; `page` is a display name
   * and is NOT unique (Figma allows two pages of the same name), so `pageId` is the field to match
   * on. It is absent on exports written before page ids were emitted. Becomes pages/index.json.
   */
  meta: PagesRootIndex;
  layerFiles: Array<PageLayoutFile<LayerFile>>;
  /** One per page: where its index.json lands, and what goes in it (`{page, pageId?, layers}`). */
  indexFiles: Array<PageLayoutFile<PageIndex>>;
  /** Path of the root pages index, joined with the caller's separator. */
  rootIndex: string;
}

/** The fields the title/text walkers below read. Any IR node — or a partial one, or `{}` — fits. */
export interface TextWalkNode {
  name?: string;
  type?: string;
  text?: string;
  /** a hidden DESCENDANT and its subtree are skipped by every walker; the walk's own root is read even
   *  when hidden (a hidden frame pulled on its own keeps its title and texts — M-4) */
  hidden?: boolean;
  /** any iterable: an IR node's array, or the plugin's lazy live-node adapter (collect.ts titleOf) */
  children?: Iterable<TextWalkNode>;
}

// Filesystem-boundary sanitiser for names that become paths. Asset filenames are NOT derived here —
// the plugin names each asset (assets.ts) and the node tree's `asset` path is built from that same
// string, so re-deriving the convention could silently point every path at a missing file.
export function safe(id: unknown): string {
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
// Every walker below skips a hidden CHILD (and so its subtree), never the node it was called on: `shown`.
const shown = (c: TextWalkNode | null | undefined): c is TextWalkNode => !!c && typeof c === "object" && !c.hidden;

export function firstByName(node: TextWalkNode | null | undefined, name: string): TextWalkNode | null {
  if (!node || typeof node !== "object") return null;
  if (node.name === name) return node;
  for (const c of node.children || []) {
    const found = shown(c) ? firstByName(c, name) : null;
    if (found) return found;
  }
  return null;
}

// Figma's own placeholder for an unbound TEXT override inside a component instance renders the
// literal string "Text" (verified in the real export: a `Page Title` instance's leading `Breadcrumb`
// child carries one, "Back to Employees" style nav trails do too) — never a real title, so it is
// excluded rather than trusted as "the first text we found".
const PLACEHOLDER_TEXT = new Set(["text", "label"]);

export function firstText(node: TextWalkNode | null | undefined): string | null {
  if (!node || typeof node !== "object") return null;
  if (node.type === "TEXT" && typeof node.text === "string") {
    const t = node.text.trim();
    if (t && !PLACEHOLDER_TEXT.has(t.toLowerCase())) return node.text;
  }
  for (const c of node.children || []) {
    const found = shown(c) ? firstText(c) : null;
    if (found) return found;
  }
  return null;
}

// Within the Page Title slot, the layer that actually carries the visible title is itself named
// "Title" (verified across all five real screens in the test export: `Page Title > Title(FRAME) >
// Title Side(FRAME) > Title(TEXT)`, sitting AFTER a `Breadcrumb`/back-link instance that comes first
// in reading order but carries only nav chrome and unbound placeholder text). Preferring the node
// literally named "Title" over "first TEXT in the subtree" is what keeps the breadcrumb from winning.
function firstNamedText(node: TextWalkNode | null | undefined, name: string): string | null {
  if (!node || typeof node !== "object") return null;
  if (node.type === "TEXT" && node.name === name && typeof node.text === "string" && node.text.trim()) {
    return node.text;
  }
  for (const c of node.children || []) {
    const found = shown(c) ? firstNamedText(c, name) : null;
    if (found) return found;
  }
  return null;
}

// The frame's own `Page Title`-shaped instance's text first (finding 120's fix: a value that is
// scoped to THIS frame, not repeated on every sibling), else the first TEXT node in the whole tree
// in reading order (placeholder text excluded either way). If nothing yields a non-empty string,
// return undefined — JSON.stringify drops an undefined value, so the row simply carries no `title`
// (never a guessed/wrong one).
export function deriveTitle(root: TextWalkNode | null | undefined): string | undefined {
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
export function collectTexts(root: TextWalkNode | null | undefined, limit?: number): string[] {
  const n = limit || 8;
  const seen = new Set<string>();
  const out: string[] = [];
  (function walk(node: TextWalkNode | null | undefined, isRoot: boolean): void {
    if (!node || typeof node !== "object" || (node.hidden && !isRoot) || out.length >= n) return;
    if (node.type === "TEXT" && typeof node.text === "string") {
      const t = node.text.trim();
      if (t && !seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
    for (const c of node.children || []) {
      if (out.length >= n) break;
      walk(c, false);
    }
  })(root, true);
  return out;
}

// A page's build state: its identity, its directory, and the index rows collected for it.
interface PageBucket {
  page: string;
  pageId?: string;
  dir: string;
  index: string;
  entries: IndexRow[];
}

/**
 * @param layersDoc  the collector's layersDoc ({layers, index, ...manifest fields})
 * @param sep        path separator: "/" for real directories, "__" for flat download names
 */
export function buildPageLayout(layersDoc: LayersDoc | null | undefined, sep: string): PageLayout {
  const doc: LayersDoc = layersDoc || {};
  const { layers, index, ...rest } = doc;
  const join = (...parts: string[]): string => ["pages"].concat(parts).join(sep);
  const byPage = new Map<string, PageBucket>(); // page IDENTITY (id, or name pre-pageId) -> { dir, entries: [{...index[i], file}] }
  const pages: PageBucket[] = [];
  const layerFiles: Array<PageLayoutFile<LayerFile>> = [];
  // safe() folds every non-alphanumeric to "_", so DISTINCT page names collide ("Design System" /
  // "Design/System" / "Design-System" all -> "Design_System"). Sharing a directory meant the second
  // page's index.json OVERWROTE the first's, leaving the first page's layer files on disk but absent
  // from every index — invisible to any agent following the manifest. Layer filenames already carry
  // an id suffix for exactly this reason; page dirs get the same.
  const usedDirs = new Set<string>();
  const uniqueDir = (name: string): string => {
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
      const dir = uniqueDir(pageName);
      // `index` is a POINTER, like every layer entry's `file`, not something the consumer reassembles
      // from `dir` — a consumer rebuilding `pages/<dir>/index.json` would be right on exactly one of
      // the two layouts. Emitting the real relative path on both makes the rule uniform: open
      // `<outDir>/<index>` verbatim, whichever layout you were handed.
      bucket = { page: pageName, ...ifDefined("pageId", l.pageId), dir, index: join(dir, "index.json"), entries: [] };
      byPage.set(key, bucket);
      pages.push(bucket);
    }
    const base = safe(l.name || "layer") + "__" + safe(l.id) + ".json";
    // P4 #33: layersDoc.sourceFile is stamped by write-out.ts's writeExport (from what figma-pull.ts
    // resolved the connected client to be) — carry it onto every per-layer file too, same field a
    // single-screen pull's writeScreen stamps, so doctor's exportSourceCounts() reads one field regardless
    // of which pull shape produced the screen.
    const src = layersDoc && layersDoc.sourceFile ? { sourceFile: layersDoc.sourceFile } : {};
    layerFiles.push({
      path: join(bucket.dir, base),
      data: { name: l.name, id: l.id, ...ifDefined("page", l.page), ...ifDefined("pageId", l.pageId), ...src, tree: l.tree, ...ifDefined("reference", l.reference), ...ifDefined("devResources", l.devResources) },
    });
    // title/texts come from THIS layer's own tree (findings 16/17/70/90/120) — computed here, once,
    // so both the per-page index and the root index (below) carry the same values for the same layer.
    const title = l.tree ? deriveTitle(l.tree) : undefined;
    const texts = l.tree ? collectTexts(l.tree) : undefined;
    // The collector pushes `layers` and `index` in lockstep (collect.ts), so row i exists. If a
    // hand-built layersDoc ever runs short, the row is undefined and the entry is written without its
    // name/id, exactly as the spread of undefined always did. Object.assign (not a spread) because it
    // keeps that runtime while its typing (`{} & (Row | undefined) & …`) drops the undefined branch;
    // same keys, same order, same values as `{ ...row, title, texts, ...src, file }`.
    bucket.entries.push(Object.assign({}, (index || [])[i], { title, texts, ...src, file: join(bucket.dir, base) }));
  });
  // `pageId` is what makes two same-named entries tellable apart by a consumer — without it the only
  // difference between them would be the disambiguating "_2" on a directory name, which is a
  // filesystem artefact, not identity. Omitted (not null) on pre-pageId exports: JSON.stringify drops
  // an undefined value, so the field's ABSENCE means "this export predates page ids", not "no page".
  const pageDirs: PageDirEntry[] = pages.map((b) => ({ page: b.page, ...ifDefined("pageId", b.pageId), dir: b.dir, index: b.index, layers: b.entries.length }));
  // A consumer is told to read the ROOT index (extract/SKILL.md), not walk every pageDirs.index one
  // hop down (finding 16) — so the root carries the same per-screen rows the per-page index does,
  // flattened across every page. Additive: pageDirs keeps its own shape/consumers (doctor.ts et al).
  // Object.assign onto the rest-copy (not a fresh literal) keeps the key order the JS wrote: the
  // manifest fields first, then pageDirs, then layers.
  const meta: PagesRootIndex = Object.assign(rest, { pageDirs, layers: pages.flatMap((b) => b.entries) });
  // The per-page index CONTENTS, not just its path — same reasoning as layerFiles. Both writers used
  // to spell `{ page, layers: entries }` out themselves, which put the one shape this module exists to
  // single-source back into two files; now they only stringify and write.
  const indexFiles: Array<PageLayoutFile<PageIndex>> = pages.map((b) => ({ path: b.index, data: { page: b.page, ...ifDefined("pageId", b.pageId), layers: b.entries } }));
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
export const NO_PAGE_DIR = "_unfiled";

/** Where a page/node identity can sit on the single-screen result screenPaths is handed. */
interface ScreenIdentity {
  page?: string;
  pageId?: string;
  nodeId?: string;
}

/**
 * What screenPaths reads: the plugin's single-screen result (`{screenName, screen: ScreenExport, …}`,
 * whose `screen` carries the page/node identity) or a bare screen doc carrying it at top level. On a
 * ScreenExport itself `screen` is the human label string — which has no identity fields, exactly as
 * `"label".page` is undefined in plain JS.
 */
export interface ScreenPathsInput extends ScreenIdentity {
  screenName?: string;
  screen?: string | ScreenIdentity;
}

/** Where ONE single-screen export's files land. The node id is part of the base name because a frame
 *  NAME does not identify a frame — two frames called `Popup` on one page are two screens. */
export interface ScreenPaths {
  /** The page's display name, or null on an export written before page identity was emitted. */
  page: string | null;
  pageId: string | null;
  nodeId: string | null;
  /** The sanitised page directory under pages/ (`_unfiled` when the page is unknown). */
  dir: string;
  /** `<safeName>__<safeNodeId>` — the stem every sibling file below shares. */
  base: string;
  screen: string;
  variables: string;
  assets: string;
  index: string;
  rootIndex: string;
}

export function screenPaths(screenDoc: ScreenPathsInput, sep: string): ScreenPaths {
  const join = (...parts: string[]): string => ["pages"].concat(parts).join(sep);
  const inner = screenDoc.screen && typeof screenDoc.screen === "object" ? screenDoc.screen : undefined;
  const page = screenDoc.page || (inner && inner.page);
  const pageId = screenDoc.pageId || (inner && inner.pageId);
  // An export written before the plugin emitted page identity still has to land somewhere, and
  // somewhere PREDICTABLE — a bucket named for what it is beats inventing a page that was never read.
  const dir = page ? safe(page) : NO_PAGE_DIR;
  const nodeId = screenDoc.nodeId || (inner && inner.nodeId);
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
//
// `prev` is whatever is on disk (read back as untyped JSON — possibly written by an older version, or
// hand-edited), so it is narrowed, never trusted: rows already there are carried through as `unknown`.
// Only the row THIS pull adds is typed.

/** One single-screen row (write-out.ts writeScreen `entry`): an IndexRow whose page identity is
 *  `null` on an unfiled screen (screenPaths' `page`/`pageId`), not absent. */
export type ScreenIndexRow = Omit<IndexRow, "page" | "pageId"> & { page?: string | null; pageId?: string | null };

/** A page's index.json after a merge: the typed identity, the carried-through rows, and any other
 *  field the previous index held (kept verbatim). */
export interface MergedPageIndex {
  [field: string]: unknown;
  page: string | null | undefined;
  pageId: string | null | undefined;
  layers: unknown[];
}

/** pages/index.json after a single-screen merge (see mergeRootIndex). */
export interface MergedRootIndex {
  [field: string]: unknown;
  pageDirs: unknown[];
  layers?: unknown[];
}

const isRecord = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object";

// Keeps a previous row unless it is the one being replaced — `l && l.file !== file` in plain JS
// (a truthy non-object has no `.file`, so it is kept).
const notFile = (file: string) => (l: unknown): boolean => (isRecord(l) ? l.file !== file : !!l);

export function mergeScreenIndex(prev: unknown, entry: ScreenIndexRow): MergedPageIndex {
  const base: Record<string, unknown> = isRecord(prev) ? prev : {};
  const layers: unknown[] = Array.isArray(base.layers) ? base.layers.filter(notFile(entry.file)) : [];
  layers.push(entry);
  return Object.assign({}, base, { page: entry.page, pageId: entry.pageId, layers });
}

// The root pages/index.json is the ONE entry point a consumer opens without knowing which pull shape
// produced the tree: it lists every page directory, whether that page arrived as a whole-page sweep
// or as single screens pulled one at a time.
// `entry` is the SAME row shape a full-page pull puts in meta.layers (name, id, title, texts, file,
// …) — so the root index looks identical to a consumer regardless of which pull shape produced it
// (finding 16: the root is the ONE file every skill is told to read).
export function mergeRootIndex(prev: unknown, paths: ScreenPaths, layerCount: number, entry?: ScreenIndexRow): MergedRootIndex {
  const base: Record<string, unknown> = isRecord(prev) ? prev : {};
  const pageDirs: unknown[] = Array.isArray(base.pageDirs)
    ? base.pageDirs.filter((p: unknown) => (isRecord(p) ? p.dir !== paths.dir : !!p))
    : [];
  pageDirs.push({ page: paths.page, pageId: paths.pageId, dir: paths.dir, index: paths.index, layers: layerCount });
  const result: MergedRootIndex = Object.assign({}, base, { pageDirs });
  if (entry) {
    const layers: unknown[] = Array.isArray(base.layers) ? base.layers.filter(notFile(entry.file)) : [];
    layers.push(entry);
    result.layers = layers;
  }
  return result;
}
