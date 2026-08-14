// Per-run mutable state + id->name memo caches. esbuild bundles every module into one scope,
// so these module-level singletons are genuinely shared across the extractor.

import { errMsg } from "./util";
import { readOptDefaults, ReadOptName } from "../../bridge/read-opts.js";

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
  /** Nodes that WOULD have exported an asset but were skipped via runOpts.skipAssets (--no-assets). */
  assetsSkipped: number;
  /** Vector/icon nodes with NO visible paint (or zero area) — nothing to render, so the export was
   *  never attempted. Deliberately NOT `assetsFailed` and deliberately NOT warned: a live run reported
   *  807 "failures" that were overwhelmingly this case, which buried the real ones. Counted so the
   *  number is still visible, silent so it isn't noise. */
  assetsSkippedInvisible: number;
  /** Real export failures that were RECOVERED as inline path geometry (see assets.ts geometryOf). */
  assetsGeometry: number;
  truncated: number;
}

export const assets: Asset[] = []; // { id, name, format, file, base64/text }

// Per-run read options, mutated by the collect entrypoints and read in serialize. The NAMES and their rationale live in bridge/read-opts.js — the ONE registry
// shared with the CLI flag table and the MCP tool schema (esbuild inlines that dependency-free CJS
// module into this bundle, the same way it inlines pages-layout.js). Adding an option there is what
// turns it on here; this file only owns the fact that the values are per-run mutable state.
export const runOpts: Record<ReadOptName, boolean> = readOptDefaults();

// Intrinsic pixel size per image hash, resolved once per run via getImageByHash().getSizeAsync().
// A design reuses the same image across many fills/nodes, so memoize to avoid O(nodes) downloads.
// Holds the in-flight PROMISE: paints resolve concurrently, so a value-cache let two fills sharing a
// hash both miss — costing a second download AND pushing the source bytes into `assets` twice.
export const imageSizeCache = new Map<string, Promise<{ w: number; h: number } | undefined>>();

// Per-run diagnostics so the agent knows what was and wasn't captured (never silent truncation).
export let warnings: string[] = [];
// ONE spelling of the zeroed counters — resetRun() uses the same factory, so adding a counter to
// RunStats is one edit the compiler checks, not two literals that can silently drift apart.
const newStats = (): RunStats => ({ nodes: 0, assetsFailed: 0, assetsSkipped: 0, assetsSkippedInvisible: 0, assetsGeometry: 0, truncated: 0 });
export let stats: RunStats = newStats();

export function warn(msg: string): void {
  warnings.push(msg);
}

// PER-NODE warnings that recur — one per failed asset export, one per missing font — used to be pushed
// individually. A real export produced 896 entries, ~800 of them the same two sentences with a
// different node name, which is not a diagnostics list an agent can read: the handful of one-off
// warnings that actually needed attention were buried in it. Kinded warnings are COUNTED instead, and
// manifest() emits ONE line per kind carrying the count plus a few examples. The manifest's shape is
// unchanged — still a flat string[] — so every consumer ("read warnings first") keeps working.
const WARN_EXAMPLES = 10;
let grouped: Map<string, { count: number; examples: string[] }> = new Map();

/** `kind` is the stable grouping key (a sentence with no node-specific text in it); `ref` identifies
 *  the node — pass "<name> (<id>)" so the examples are actionable. */
export function warnKind(kind: string, ref: string): void {
  let g = grouped.get(kind);
  if (!g) {
    g = { count: 0, examples: [] };
    grouped.set(kind, g);
  }
  g.count++;
  if (ref && g.examples.length < WARN_EXAMPLES) g.examples.push(ref);
}

function groupedWarnings(): string[] {
  const out: string[] = [];
  grouped.forEach((g, kind) => {
    let line = kind + ": " + g.count + " node(s)";
    if (g.examples.length) {
      line += " — e.g. " + g.examples.join("; ");
      if (g.count > g.examples.length) line += " (+" + (g.count - g.examples.length) + " more)";
    }
    out.push(line);
  });
  return out;
}

const SKIP_ASSETS_NOTE = (n: number): string =>
  `--no-assets: ${n} node(s) that would have exported an SVG/PNG were skipped; ` +
  `each is marked 'assetSkipped: true' in the tree and stays a leaf, exactly as the full export ` +
  `serializes it (structure, layout and tokens are unaffected). The per-root reference ` +
  `screenshot is still captured — it is one render per exported root, not per node.`;

// The documented manifest shape (ARCHITECTURE.md / TESTING.md) is {nodes, skipped, truncated,
// assetsFailed, warnings}. `skipped` is DERIVED, not counted: depth truncation is the only thing that
// drops a node, so a second counter incremented at the same single site could only ever drift.
export function manifest() {
  // Derived HERE rather than at each collect entrypoint: the warning belongs to every doc that carries
  // a manifest, and putting it at one call site (as it first was) meant a --no-assets SELECTION dropped
  // its assets silently — the exact never-silent break the counter exists to prevent.
  // Appended to the RETURNED copy, never pushed into `warnings`: manifest() is a read, and a read that
  // mutates needed an "did I already push this?" guard to stay correct across repeat calls. Deriving it
  // makes repeat calls identical by construction, with no guard to get wrong.
  const note = runOpts.skipAssets && stats.assetsSkipped ? SKIP_ASSETS_NOTE(stats.assetsSkipped) : null;
  // Grouped warnings are appended to the RETURNED copy for the same reason the note above is: they are
  // derived from the counters, so repeat calls stay identical by construction.
  const all = warnings.concat(groupedWarnings());
  return { ...stats, skipped: stats.truncated, warnings: note ? all.concat(note) : all };
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
// collection object per run (not just its name — we also need its .modes list). memoName is exactly
// that cache (promise-held, throw-and-reject normalised to null, reset per run); `.obj` hands back the
// fetched collection rather than its name, so this needs no second copy of the machinery.
const collectionLookup = memoName((id) =>
  figma.variables && figma.variables.getVariableCollectionByIdAsync
    ? figma.variables.getVariableCollectionByIdAsync(id)
    : Promise.resolve(null));
export const getCollection = collectionLookup.obj as (id: string) => Promise<VariableCollection | null>;

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

// The blanket document load, with its one guard. Two callers need it (the all-pages export walk and
// the component catalog, which spans every page by definition) and both used to carry a byte-similar
// feature-check + try/catch, differing only in the consequence they name. That made the dynamic-page
// loading POLICY two edits rather than one — which matters because collect.ts argues for replacing
// this blanket load with per-page loadAsync, a change that would otherwise land on one caller only.
export async function loadAllPages(consequence: string): Promise<void> {
  if (!figma.loadAllPagesAsync) return;
  try {
    await figma.loadAllPagesAsync();
  } catch (e) {
    warn("loadAllPagesAsync failed (" + consequence + "): " + errMsg(e));
  }
}

export function resetRun(): void {
  releaseAssets();
  warnings = [];
  grouped = new Map();
  stats = newStats();
  varName.reset();
  styleNameLookup.reset();
  nodeNameLookup.reset();
  collectionLookup.reset();
  imageSizeCache.clear();
}
