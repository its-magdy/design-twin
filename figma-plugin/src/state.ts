// Per-run mutable state + id->name memo caches. esbuild bundles every module into one scope,
// so these module-level singletons are genuinely shared across the extractor.

export interface Asset {
  id: string;
  name: string;
  format: string;
  /** Basename this asset must be written as. The PRODUCER names the file (assets.ts) and the node
   *  tree's `asset` path is built from the same string, so a consumer never re-derives the convention
   *  — a mismatch here would silently point every `asset:` path at a file that isn't on disk. */
  file: string;
  base64?: string;
  text?: string;
  kind?: string;
}

export interface RunStats {
  nodes: number;
  assetsFailed: number;
  truncated: number;
}

export const assets: Asset[] = []; // { id, name, format, file, base64/text }

// Per-run read options. `css` and `measurements` gate the heavier Tier-1 reads (getCSSAsync is
// one async call PER NODE, so it's opt-in). Mutated by the collect entrypoints; read in serialize.
// `sharedData` reads cross-plugin namespaces (e.g. Tokens Studio applied tokens) — opt-in.
export const runOpts = { css: false, measurements: false, pluginData: false, motion: false, sharedData: false };

// Intrinsic pixel size per image hash, resolved once per run via getImageByHash().getSizeAsync().
// A design reuses the same image across many fills/nodes, so memoize to avoid O(nodes) downloads.
// Holds the in-flight PROMISE: paints resolve concurrently, so a value-cache let two fills sharing a
// hash both miss — costing a second download AND pushing the source bytes into `assets` twice.
export const imageSizeCache = new Map<string, Promise<{ w: number; h: number } | undefined>>();

// Per-run diagnostics so the agent knows what was and wasn't captured (never silent truncation).
export let warnings: string[] = [];
export let stats: RunStats = { nodes: 0, assetsFailed: 0, truncated: 0 };

export function warn(msg: string): void {
  warnings.push(msg);
}

// The documented manifest shape (ARCHITECTURE.md / TESTING.md) is {nodes, skipped, truncated,
// assetsFailed, warnings}. `skipped` is DERIVED, not counted: depth truncation is the only thing that
// drops a node, so a second counter incremented at the same single site could only ever drift.
export function manifest() {
  return { ...stats, skipped: stats.truncated, warnings: warnings.slice() };
}

// Resolve a Figma id to its .name at most once per export run — a design system reuses
// the same handful of variable/style ids across hundreds of nodes, so this collapses O(nodes)
// Plugin-API round-trips to O(distinct ids). reset() drops the cache between export runs so a
// re-export picks up renamed tokens.
type NamedFetch = (id: string) => Promise<{ name: string } | null>;
export interface MemoName {
  (id: string): Promise<string | undefined>;
  reset(): void;
  /** Every id looked up during this run — i.e. every id the document actually REFERENCES. */
  ids(): string[];
  /** The FETCHED object behind an id (null if it didn't resolve), from the same cache as the name.
   *  Lets a later pass reuse what the walk already retrieved instead of re-fetching by id. */
  obj(id: string): Promise<any>;
}
function memoName(fetch: NamedFetch): MemoName {
  // Cache the PROMISE, not the resolved value. The extractor fans these lookups out concurrently
  // (Promise.all over text runs, paints, styles), and a value-cache is only written after `await`
  // resolves — so every duplicate reference issued while the first fetch was in flight missed the
  // cache and made its own round trip. One paragraph sharing a text style used to cost one call
  // per run; a design system where 40 styles reference color/primary cost 40.
  const cache = new Map<string, Promise<{ name: string } | null>>();
  const get = (id: string): Promise<{ name: string } | null> => {
    let p = cache.get(id);
    if (!p) {
      // fetch can throw synchronously as well as reject — normalise both to null.
      try { p = Promise.resolve(fetch(id)).catch(() => null); } catch (e) { p = Promise.resolve(null); }
      cache.set(id, p);
    }
    return p;
  };
  const fn = (async (id: string) => {
    const o = await get(id);
    return o ? o.name : undefined;
  }) as MemoName;
  fn.reset = () => cache.clear();
  fn.obj = get;
  // The cache keys double as the run's reference set: varName.ids() is exactly the variables the
  // nodes/styles/component props bound to, which is how dumpVariables finds LIBRARY variables that
  // getLocalVariablesAsync (local-only, per the Plugin API) cannot enumerate.
  fn.ids = () => Array.from(cache.keys());
  return fn;
}

export const varName = memoName((id) => figma.variables.getVariableByIdAsync(id));
export const styleNameLookup = memoName((id) => figma.getStyleByIdAsync(id));
export const nodeNameLookup = memoName((id) => figma.getNodeByIdAsync(id)); // prototype destinations

// Variable collections are read to turn a node's pinned variable-mode ids into human names
// (theming). A file has a handful of collections reused across every node, so cache the whole
// collection object per run (not just its name — we also need its .modes list).
// Promise-cached for the same reason as memoName above: mode resolution runs concurrently across
// nodes, so caching the resolved value would let duplicate in-flight lookups all miss.
const collectionCache = new Map<string, Promise<VariableCollection | null>>();
export function getCollection(id: string): Promise<VariableCollection | null> {
  let p = collectionCache.get(id);
  if (!p) {
    try {
      p = figma.variables && figma.variables.getVariableCollectionByIdAsync
        ? Promise.resolve(figma.variables.getVariableCollectionByIdAsync(id)).catch(() => null)
        : Promise.resolve(null);
    } catch (e) {
      p = Promise.resolve(null);
    }
    collectionCache.set(id, p);
  }
  return p;
}

// Serialize every state-mutating run. All the singletons above (assets/stats/warnings/memo caches)
// are shared across the one bundled scope, so two overlapping runs — a double-click, or a bridge
// pull arriving mid manual export — would interleave through resetRun() and emit corrupted/truncated
// output. Route each run through this tail-promise chain so they execute one at a time. fn is always
// invoked with no args (the prior run's result must never leak in as an argument), and a failed run
// still lets the next one proceed.
let runChain: Promise<unknown> = Promise.resolve();
export function serializeRun<T>(fn: () => Promise<T>): Promise<T> {
  const next = runChain.then(() => fn(), () => fn());
  runChain = next.then(() => {}, () => {});
  return next;
}

// Drop the run's asset payloads once they've been handed to the caller. Every collector returns
// assets.slice(), so after that the module array is pure retained garbage — and it holds every base64
// PNG/SVG of the export (tens of MB) for the whole idle period until the NEXT run's resetRun().
export function releaseAssets(): void {
  assets.length = 0;
}

export function resetRun(): void {
  assets.length = 0;
  warnings = [];
  stats = { nodes: 0, assetsFailed: 0, truncated: 0 };
  varName.reset();
  styleNameLookup.reset();
  nodeNameLookup.reset();
  collectionCache.clear();
  imageSizeCache.clear();
}
