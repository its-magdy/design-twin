// ONE run's context: everything a read accumulates or decides while it executes — its read options and delivery
// shape, the counters, the warnings, the asset table and its dedupe tables, the id->name memo caches, the cancel
// flag and the page the walk is on. A run is a fresh object, so there is nothing to reset between two runs: the
// scheduler (state.ts bracket) opens one when a run starts executing and closes it when the run settles, and the
// next run starts from a new one. A collector claims the open run (claimRun) and fixes its read options once
// (Run.useReads); everything below it — serialize, assets, variables, progress — reads the run in progress (run()).
//
// Ambient rather than threaded through every signature: the reads that need it are leaves (a memo lookup in
// variables.ts, a counter in assets.ts) reached through dozens of helpers, and the scheduler guarantees at most
// one run is in progress — an exclusive run executes alone, a scene read waits on the same chain and claims no run,
// and an identity read (ping, whoami) touches none of this.
import type { Asset, Manifest } from "../../bridge/src/doc-types.ts";
import { readOptDefaults, type ReadOptName } from "../../bridge/src/read-opts.ts";
import type { ProgressPage, RunInfo } from "./progress";

/** One exported asset — doc-types' Asset, re-exported under the name every module here imports it by. */
export type { Asset };

/** The opt-in reads a run makes (bridge/src/read-opts.ts names them). Fixed once per run. */
export type ReadOpts = Readonly<Record<ReadOptName, boolean>>;

export interface RunStats {
  nodes: number;
  assetsFailed: number;
  /** Nodes that WOULD have exported an asset but were skipped via the run's skipAssets read (--no-assets). */
  assetsSkipped: number;
  /** Vector/icon nodes with NO visible paint (or zero area) — nothing to render, so the export was
   *  never attempted. Deliberately NOT `assetsFailed` and deliberately NOT warned: a live run reported
   *  807 "failures" that were overwhelmingly this case, which buried the real ones. Counted so the
   *  number is still visible, silent so it isn't noise. */
  assetsSkippedInvisible: number;
  /** Real export failures that were RECOVERED as inline path geometry (see assets.ts geometryOf). */
  assetsGeometry: number;
  /** Graphics that are hidden (the node or an ancestor `visible:false`) — never sent to exportAsync,
   *  which returns no SVG for them; the node stays a leaf with `assetSkipped: "hidden"`. */
  assetsHidden: number;
  /** Nodes kept as hidden: `visible:false` themselves or anywhere under a hidden ancestor. */
  hiddenNodes: number;
  truncated: number;
}

/** What a collector says about its reply when it claims the run. */
export interface Delivery {
  /** Whether the reply delivers assets at all. The design-system-only and library-file replies carry no `assets`
   *  field, so an image fill's ORIGINAL bytes read there (getBytesAsync + base64) would go nowhere: readSourceImage
   *  keeps the intrinsic size (it is on the paint record) and skips the bytes. Not a read option — no caller chooses
   *  it; it follows from the reply's shape. Default true. */
  sourceBytes?: boolean;
}

// Resolve a Figma id to its .name at most once per run — a design system reuses the same handful of
// variable/style ids across hundreds of nodes, so this collapses O(nodes) Plugin-API round-trips to
// O(distinct ids). Per run by construction: a re-export opens a new run, so it picks up renamed tokens.
type Named = { name: string };
type NamedFetch<T extends Named> = (id: string) => Promise<T | null>;
export interface MemoName<T extends Named = Named> {
  (id: string): Promise<string | undefined>;
  /** Every id looked up during this run — i.e. every id the document actually REFERENCES. */
  ids(): string[];
  /** The FETCHED object behind an id (null if it didn't resolve), from the same cache as the name.
   *  Lets a later pass reuse what the walk already retrieved instead of re-fetching by id. */
  obj(id: string): Promise<T | null>;
}
function memoName<T extends Named>(fetch: NamedFetch<T>): MemoName<T> {
  // Cache the PROMISE, not the resolved value. The extractor fans these lookups out concurrently
  // (Promise.all over text runs, paints, styles), and a value-cache is only written after `await`
  // resolves — so every duplicate reference issued while the first fetch was in flight missed the
  // cache and made its own round trip. One paragraph sharing a text style would cost one call
  // per run; a design system where 40 styles reference color/primary cost 40.
  const cache = new Map<string, Promise<T | null>>();
  const get = (id: string): Promise<T | null> => {
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
  }) as MemoName<T>;
  fn.obj = get;
  // The cache keys double as the run's reference set: varName.ids() is exactly the variables the
  // nodes/styles/component props bound to, which is how dumpVariables finds LIBRARY variables that
  // getLocalVariablesAsync (local-only, per the Plugin API) cannot enumerate.
  fn.ids = () => Array.from(cache.keys());
  return fn;
}

// PER-NODE warnings that recur — one per failed asset export, one per missing font — are not pushed
// individually: a real export that did so produced 896 entries, ~800 of them the same two sentences with a
// different node name, which is not a diagnostics list an agent can read: the handful of one-off
// warnings that actually needed attention were buried in it. Kinded warnings are COUNTED instead, and
// the manifest emits ONE line per kind carrying the count plus a few examples. The manifest's shape is
// unchanged — still a flat string[] — so every consumer ("read warnings first") keeps working.
const WARN_EXAMPLES = 10;

export class Run {
  /** Who asked for this run, or null for a run driven directly (no scheduler — the `__designExport` test
   *  surface): such a run posts no progress and no cancel can reach it. */
  readonly info: RunInfo | null;
  private readOpts: ReadOpts = readOptDefaults();
  private readsFixed = false;
  private delivery: Required<Delivery> = { sourceBytes: true };
  private claimed = false;
  readonly stats: RunStats = { nodes: 0, assetsFailed: 0, assetsSkipped: 0, assetsSkippedInvisible: 0, assetsGeometry: 0,
    assetsHidden: 0, hiddenNodes: 0, truncated: 0 };
  /** Per-run diagnostics so the agent knows what was and wasn't captured (never silent truncation). */
  private readonly warnings: string[] = [];
  private readonly grouped = new Map<string, { count: number; examples: string[] }>();
  /** The run's exported assets — { id, name, format, file, base64/text }. */
  readonly assets: Asset[] = [];
  /** assets.ts's naming tables: content hash -> the file already written for it, and taken basename (case-folded)
   *  -> the hash that owns it. `byContent` holds the same Asset objects (base64/text payloads) as `assets`. */
  readonly assetFiles = { byContent: new Map<string, { file: string; asset: Asset }>(), byName: new Map<string, string>() };
  /** Intrinsic pixel size per image hash, resolved once per run via getImageByHash().getSizeAsync(). A design
   *  reuses the same image across many fills/nodes, so memoize to avoid O(nodes) downloads. Holds the in-flight
   *  PROMISE: paints resolve concurrently, so a value-cache let two fills sharing a hash both miss — costing a
   *  second download AND pushing the source bytes into `assets` twice. */
  readonly imageSizes = new Map<string, Promise<{ w: number; h: number } | undefined>>();
  readonly varName = memoName((id) => figma.variables.getVariableByIdAsync(id));
  readonly styleName = memoName((id) => figma.getStyleByIdAsync(id));
  /** Prototype destinations. */
  readonly nodeName = memoName((id) => figma.getNodeByIdAsync(id));
  /** Variable collections, read to turn a node's pinned variable-mode ids into human names (theming). A file has a
   *  handful reused across every node, so the whole object is cached per run (its .modes list too) — the same
   *  memo, through `.obj`. */
  readonly collection = memoName<VariableCollection>((id) =>
    figma.variables && figma.variables.getVariableCollectionByIdAsync
      ? figma.variables.getVariableCollectionByIdAsync(id)
      : Promise.resolve(null)).obj;
  /** Who asked this run to stop, if anyone: the designer's Cancel button, or the bridge giving up on the request
   *  (progress.ts requestAbandon). One field rather than two flags so the run fails with exactly one, truthful
   *  message. Starts null with the run, so a cancel that landed while nothing was running — or after the run it
   *  was meant for had already finished — cannot kill the next one. */
  cancel: "designer" | "abandoned" | null = null;
  /** The page the walk is on (progress.ts enterPage), so the ticks that are not page boundaries can say WHERE they
   *  are. */
  page: ProgressPage | undefined = undefined;
  /** When this run last posted a throttled progress frame. */
  lastPost = 0;

  constructor(info: RunInfo | null) {
    this.info = info;
  }

  /** The opt-in reads this run makes: all off until its collector names them (useReads). */
  get reads(): ReadOpts {
    return this.readOpts;
  }

  /** Fix this run's read options. Once per run: a read cannot change what it reads halfway through, so a walk that
   *  needs a different policy says so in its own arguments (serialize.ts AssetPolicy). */
  useReads(opts: Partial<Record<ReadOptName, boolean | undefined>> | undefined): void {
    if (this.readsFixed) throw new Error("a run's read options are fixed once, by its collector");
    this.readsFixed = true;
    const r = readOptDefaults();
    for (const k of Object.keys(r) as ReadOptName[]) r[k] = !!(opts && opts[k]);
    this.readOpts = r;
  }

  /** See Delivery.sourceBytes. */
  get sourceBytes(): boolean {
    return this.delivery.sourceBytes;
  }

  /** Bound, so it can be handed on as a warning sink (`findNodeById(id, r.warn)`). */
  readonly warn = (msg: string): void => {
    this.warnings.push(msg);
  };

  /** `kind` is the stable grouping key (a sentence with no node-specific text in it); `ref` identifies
   *  the node — pass "<name> (<id>)" so the examples are actionable. */
  readonly warnKind = (kind: string, ref: string): void => {
    let g = this.grouped.get(kind);
    if (!g) {
      g = { count: 0, examples: [] };
      this.grouped.set(kind, g);
    }
    g.count++;
    if (ref && g.examples.length < WARN_EXAMPLES) g.examples.push(ref);
  };

  /** The run's warnings: the one-off lines, then one line per kind (warnKind). A fresh array per call. */
  warningLines(): string[] {
    const out = this.warnings.slice();
    this.grouped.forEach((g, kind) => {
      let line = kind + ": " + g.count + " node(s)";
      if (g.examples.length) {
        line += " — e.g. " + g.examples.join("; ");
        if (g.count > g.examples.length) line += " (+" + (g.count - g.examples.length) + " more)";
      }
      out.push(line);
    });
    return out;
  }

  /** @internal claimRun's bookkeeping: the first collector to claim a scheduled run sets its delivery. */
  claim(delivery: Delivery | undefined): boolean {
    if (this.claimed) return false;
    this.claimed = true;
    if (delivery && delivery.sourceBytes === false) this.delivery = { sourceBytes: false };
    return true;
  }

  /** Drop the run's asset payloads (tens of MB of base64 PNG/SVG). A collector has already returned its own
   *  assets.slice(), and a run that THREW hands them to nobody; the dedupe tables go too, since `byContent` points
   *  at the same objects. Clearing drops the references only; the returned objects are never touched. */
  release(): void {
    this.assets.length = 0;
    this.assetFiles.byContent.clear();
    this.assetFiles.byName.clear();
  }
}

const SKIP_ASSETS_NOTE = (n: number): string =>
  `--no-assets: ${n} node(s) that would have exported an SVG/PNG were skipped; ` +
  `each is marked 'assetSkipped: true' in the tree and stays a leaf, exactly as the full export ` +
  `serializes it (structure, layout and tokens are unaffected). The per-root reference ` +
  `screenshot is still captured — it is one render per exported root, not per node.`;

/**
 * A run's manifest — a pure function of the run, so repeat calls are identical by construction and two runs can
 * never share one. The documented shape (ARCHITECTURE.md / TESTING.md) is {nodes, skipped, truncated, assetsFailed,
 * warnings} plus every RunStats counter. `skipped` is DERIVED, not counted: depth truncation is the only thing that
 * drops a node, so a second counter incremented at the same single site could only ever drift.
 */
export function manifestOf(r: Run): Manifest {
  // The --no-assets note belongs to every doc that carries a manifest: putting it at one call site (as it first
  // was) meant a --no-assets SELECTION dropped its assets silently.
  const note = r.reads.skipAssets && r.stats.assetsSkipped ? SKIP_ASSETS_NOTE(r.stats.assetsSkipped) : null;
  const all = r.warningLines();
  // Which OPT-IN reads actually ran. Without this, a consumer cannot tell "the designer never wrote
  // an annotation" from "annotations were not exported" — and on a real export `codeSyntax`,
  // `annotations`, `devStatusNote` and `measurements` were all absent, which silently killed two of
  // build-screen's six hint tiers with nothing to say so. `reads` names exactly what was asked for,
  // so an absent field is an answerable question rather than an ambiguous one.
  const reads = (Object.keys(r.reads) as ReadOptName[]).filter((k) => r.reads[k]);
  return { ...r.stats, skipped: r.stats.truncated, reads, warnings: note ? all.concat(note) : all };
}

// ---------------------------------------------------------------- the run in progress
// `current` is the run executing now: the scheduler's (info set) from openRun until closeRun, or — when a
// collector or serialize is driven directly, with no scheduler — a detached one (info null) that lasts until the
// next direct collector replaces it or a scheduled run opens. `last` is what assetRetention reports on.
let current: Run | null = null;
let last: Run | null = null;

function install(r: Run): Run {
  if (current && current !== r) current.release();
  current = r;
  last = r;
  return r;
}

/** The scheduler: a run starts executing. */
export function openRun(info: RunInfo): Run {
  return install(new Run(info));
}

/** The scheduler: that run has settled — success, failure or cancellation alike. Its asset payloads are dropped
 *  here, inside the run and not after the caller posts its reply: an identity read (ping, whoami) answers DURING a
 *  queued export, and the next queued run may already have started by the time a caller's continuation runs. */
export function closeRun(r: Run): void {
  r.release();
  if (current === r) current = null;
}

/** The scheduled run executing now, for progress and cancel — null between runs and for a directly-driven one. */
export function activeRun(): Run | null {
  return current && current.info ? current : null;
}

/** The run in progress, for the reads under a collector. Outside any run (serialize or buildDesignSystem driven
 *  directly), a detached run with every read option off. */
export function run(): Run {
  return current || install(new Run(null));
}

/** A collector's first step: the run it reads into. A scheduled run is claimed by the first collector that runs in
 *  it; driven directly, every collector call is a fresh detached run of its own. A second collector in one
 *  scheduled run is refused — one run has one set of read options and one reply. */
export function claimRun(delivery?: Delivery): Run {
  if (current && current.info) {
    if (!current.claim(delivery)) throw new Error("one collector per run: '" + current.info.label + "' already has its read");
    return current;
  }
  const r = install(new Run(null));
  r.claim(delivery);
  return r;
}

/** Test surface: what the most recent run's asset tables still hold (0s once it has settled). */
export function assetRetention(): { assets: number; byContent: number; byName: number } {
  return last
    ? { assets: last.assets.length, byContent: last.assetFiles.byContent.size, byName: last.assetFiles.byName.size }
    : { assets: 0, byContent: 0, byName: 0 };
}
