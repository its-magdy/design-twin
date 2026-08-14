// Collectors (return data; shared by manual export AND the bridge). Each resets per-run state,
// applies read options, walks the requested scope, and returns the compact screen/layer/design-system docs.
import { Obj, safe, errMsg, exportedAt, nonEmpty } from "./util";
// Figma URLs carry `123-456`, the API wants `123:456`. bridge/node-id.js is "the ONE place that knows
// what a node id looks like and how it hides in a Figma URL" — esbuild inlines that dependency-free CJS
// module into the plugin bundle exactly as it does pages-layout.js, so the plugin uses the SAME parser
// as the bridge front-ends instead of a weaker replace(/-/g,":") that accepted less (no URLs, no
// percent-encoding, no nested-instance paths). toNodeId is its LENIENT entry point: a shape node-id.js
// doesn't recognise passes through and keeps working as before rather than becoming a new hard failure
// — the caller's own "node not found" error is the better message either way.
import { toNodeId } from "../../bridge/node-id.js";
import { assets, resetRun, manifest, runOpts, warn, loadAllPages } from "./state";
import { ReadOptName } from "../../bridge/read-opts.js";
import { serialize } from "./serialize";
import { collectReference, devResources } from "./assets";
import { simplifyFills } from "./paint";
import { buildDesignSystem } from "./components";
import { dumpVariables, resolvedModes } from "./variables";

// The read options are NOT restated here: they come from bridge/read-opts.js's ReadOptName, the same
// registry the CLI flag table and the MCP tool schema derive from. Only the options this entrypoint
// owns (scope selection) are spelled out below.
export interface CollectOpts extends Partial<Record<ReadOptName, boolean>> {
  allPages?: boolean;
  /** Export specific page(s) by id or name instead of the current page. Repeatable. Ignored when
   *  allPages is set. Resolution is id -> exact name -> unique case-insensitive name, and an
   *  ambiguous or unknown selector THROWS with the available pages listed (never picks one). */
  page?: string | string[];
}

// Serialize one exported root plus ALL its per-root enrichment: a reference PNG, Dev-Mode resource
// links, and the effective variable modes. These are independent single-node reads, so run them
// concurrently once the tree is known exportable — gated on `tree` so a hidden/dropped node never
// emits a stray reference asset. Keeping every root-only read here (rather than a `depth === 0`
// branch inside the recursive serializer) means "computed once per exported root" has ONE home.
// Callers attach ref/dev where their own doc shape wants them (inline vs sibling fields).
async function serializeWithRefs(node: SceneNode): Promise<{ tree: Obj | null; ref?: string; dev?: Obj[] }> {
  const tree = await serialize(node, 0);
  if (!tree) return { tree: null };
  const [ref, dev, modes] = await Promise.all([collectReference(node), devResources(node), resolvedModes(node)]);
  if (modes) tree.resolvedModes = modes;
  return { tree, ref: ref || undefined, dev: dev || undefined };
}

// Serialize a root and attach the enrichment inline (the shape both single-scope collectors want).
async function rootTree(node: SceneNode): Promise<Obj | null> {
  const { tree, ref, dev } = await serializeWithRefs(node);
  if (!tree) return null;
  if (ref) tree.reference = ref;
  if (dev) tree.devResources = dev;
  return tree;
}

// Assemble the screen doc + sibling docs shared by collectSelection and collectNode. One place owns
// the screen-doc contract, so a new per-run field can't be added to one collector and missed on the
// other (which is how `measurements` nearly shipped half-wired).
// `title` is the human screen label; `fileBase` is what the output filename derives from — a
// multi-frame selection is titled "selection" but still files under its first frame's name.
async function screenResult(title: string, fileBase: string, nodes: Obj[]): Promise<Obj> {
  const screen: Obj = { exportedAt: exportedAt(), screen: title, nodes, manifest: manifest() };
  const measurements = collectMeasurements();
  if (measurements) screen.measurements = measurements;
  return { screenName: safe(fileBase), screen, variables: await dumpVariables(), assets: assets.slice() };
}

// A node's STRUCTURAL summary — the only shape the cheap index tools emit (id/name/type/size), shared
// by listPages and listChildren so a new field can't be added to one index and missed on the other.
function summarize(nd: SceneNode): Obj {
  const o: Obj = { name: nd.name, id: nd.id, type: nd.type };
  if ("width" in nd) { o.w = Math.round((nd as any).width); o.h = Math.round((nd as any).height); }
  if ((nd as any).visible === false) o.hidden = true;
  return o;
}

// Load ONE page, degrading to a warning. Deliberately not loadAllPagesAsync: the docs are explicit
// ("Calling this method may be slow for large documents, and should be avoided unless absolutely
// necessary"). The total work is identical when you do end up walking every page, but it is paid
// incrementally, a page that throws costs only itself, and it does not leave the whole document
// resident (and the documentchange bookkeeping enabled) for the rest of the plugin session.
// Returns false when the page has no loadAsync at all (older API surface / test doubles) so a caller
// scanning for a node can skip it rather than assume it was loaded.
async function loadPageSafely(page: PageNode, sink: (msg: string) => void, what: string): Promise<boolean> {
  if (typeof (page as any).loadAsync !== "function") return false;
  try {
    await (page as any).loadAsync();
  } catch (e) {
    sink("page '" + page.name + "' failed to load" + (what ? " " + what : "") + ": " + errMsg(e));
    return false;
  }
  return true;
}

// PageNode.children THROWS on a page that isn't current and wasn't loaded (dynamic-page access), and
// an unreadable page must never look like an EMPTY one — that is the failure mode where an index
// quietly becomes a lie and the caller concludes the content does not exist. Both the export walk and
// the cheap index used to carry their own copy of this catch + warning, down to near-identical
// wording; `consequence` is the only part that legitimately differs. Returns null when unreadable.
function pageChildren(page: PageNode, sink: (msg: string) => void, consequence: string): ReadonlyArray<SceneNode> | null {
  try {
    return page.children;
  } catch (e) {
    sink("page '" + page.name + "' could not be read (not loaded) — " + consequence + ": " + errMsg(e));
    return null;
  }
}

// id -> node, for every id-addressed entry point. ONE resolution policy, in one place: try the cheap
// lookup first (under dynamic-page access getNodeByIdAsync only sees LOADED pages, and the node is
// almost always on the page the user is already looking at), then load pages ONE AT A TIME, stopping
// the moment it resolves — never the blanket loadAllPagesAsync the docs say to avoid. collectNode and
// listChildren each used to carry their own version of this, down to a byte-identical "not in the open
// file" message, so the incremental-scan fix landed on one and not the other.
async function findNodeById(nodeId: string, sink: (msg: string) => void): Promise<BaseNode> {
  let node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    for (const page of figma.root.children) {
      // `continue`, not `break`: one page that can't be loaded must cost only that page. Breaking
      // abandoned the whole scan on the FIRST such page, so a node on any later page reported "not in
      // the open file" — a wrong answer, where skipping reports a merely incomplete one.
      if (!(await loadPageSafely(page, sink, "during node lookup"))) continue;
      node = await figma.getNodeByIdAsync(nodeId);
      if (node) break;
    }
  }
  if (!node) throw new Error("Node " + nodeId + " is not in the open file — open the Figma file this link points to, then retry.");
  return node;
}

// Page selectors (ids or names) -> the pages to walk, deduped and in selector order. Module level, so
// the policy below is readable — and testable — without running a whole export.
// Self-healing errors (the pattern Figma's own get_metadata uses, and git's ambiguous-SHA behaviour):
// a failed lookup returns the valid choices so the caller can correct itself.
// Figma ALLOWS duplicate page names, so the exact-name path needs the same ambiguity guard as the
// case-insensitive one — it was pick-first, which is the more likely collision AND the one with no
// safety net. Never guess: this tool is agent-driven, with no tty to prompt. One `pick` so the two
// passes cannot disagree on the policy or on the wording of the error.
function resolvePages(wanted: ReadonlyArray<string>, all: ReadonlyArray<PageNode>): PageNode[] {
  const avail = () => all.map((p) => `${p.id} ${JSON.stringify(p.name)}`).join("\n  ");
  const pick = (sel: string, matches: PageNode[], how: string): PageNode | null => {
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(`page name ${JSON.stringify(sel)} is ambiguous (${matches.length} pages ${how}) — use its id. Available pages:\n  ${avail()}`);
    }
    return null;
  };
  const resolveOne = (sel: string): PageNode => {
    const byId = all.find((p) => p.id === sel);
    if (byId) return byId;
    const exact = pick(sel, all.filter((p) => p.name === sel), "share it");
    if (exact) return exact;
    const ci = pick(sel, all.filter((p) => p.name.trim().toLowerCase() === sel.toLowerCase()), "match ignoring case");
    if (ci) return ci;
    throw new Error(`no page matches ${JSON.stringify(sel)}. Available pages:\n  ${avail()}`);
  };
  const picked: PageNode[] = [];
  for (const sel of wanted) {
    const p = resolveOne(sel);
    if (!picked.some((x) => x.id === p.id)) picked.push(p);
  }
  return picked;
}

function applyOpts(opts?: CollectOpts): void {
  for (const k of Object.keys(runOpts) as Array<keyof typeof runOpts>) runOpts[k] = !!(opts && (opts as any)[k]);
}

// getCSSAsync (Figma's own CSS oracle) is opt-in because it's one async call PER NODE — O(nodes) on a
// big frame. But for the "inspect one small component" path it's cheap and high-value, so DEFAULT it
// ON when the caller didn't specify AND the exported subtree is small. Large/full exports keep it off
// unless explicitly requested. An explicit css:false/true always wins (only `undefined` auto-resolves).
const CSS_AUTO_NODE_CAP = 60;
// Counts only far enough to answer "is this subtree at or under the cap?" — the exact size of a big
// tree is never wanted, and walking to find it is the cost this gate exists to avoid.
function subtreeIsSmall(node: any): boolean {
  let count = 0;
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    if (++count > CSS_AUTO_NODE_CAP) return false;
    if (n && "children" in n && Array.isArray(n.children)) {
      for (const c of n.children) stack.push(c);
    }
  }
  return true;
}
function autoCss(opts: CollectOpts | undefined, node: any): CollectOpts {
  // Spread, not a field-by-field clone: a hand-written copy silently DROPS any newly added read
  // option on exactly the single-selection / single-node paths, which is the hardest gap to notice.
  const o: CollectOpts = { ...opts };
  if (o.css === undefined && subtreeIsSmall(node)) o.css = true;
  return o;
}

// The canvas colour behind a page's frames (and the separate one prototypes play against). Codegen
// has no other signal for what a screen sits ON — a dark-canvas file whose frames are transparent
// renders white without it. Figma's own defaults (white / the #f5f5f5 canvas grey) carry no intent, so
// they are omitted: this field appearing at all means the designer chose something.
const DEFAULT_PAGE_BG = ["#ffffff", "#f5f5f5", "#e5e5e5"];
function isDefaultBg(f: Obj[] | undefined): boolean {
  return !f || (f.length === 1 && f[0].type === "solid" && DEFAULT_PAGE_BG.indexOf(f[0].color) !== -1);
}
// Reuses simplifyFills rather than hand-reading `.color`: page backgrounds are full Paint[] (an image
// or gradient canvas is legal), and a second reader here would be a permanently-lagging copy of paint.ts.
async function pageBackground(page: PageNode): Promise<Obj | undefined> {
  const p = page as any;
  const out: Obj = {};
  const bg = await simplifyFills(p.backgrounds);
  if (!isDefaultBg(bg)) out.background = bg;
  const proto = await simplifyFills(p.prototypeBackgrounds);
  if (!isDefaultBg(proto)) out.prototypeBackground = proto;
  return nonEmpty(out);
}

// Size hints for the cheap index. The skill instructs an agent to "read ONLY that file", but real
// layer files measured 5.3-7.6 MB with nothing in the index to warn about it — so the agent either
// blows its context or has to open the file to find out how big it is. `bytes` is the serialized
// length of exactly what lands in that layer's file; `nodes` is its subtree count. Both are computed
// from the tree already in hand, so neither costs a Plugin-API read.
function countNodes(tree: Obj): number {
  let n = 1;
  const kids = tree.children;
  if (Array.isArray(kids)) for (const k of kids) n += countNodes(k);
  return n;
}

// Dev-Mode measurement redlines (spacing specs the designer placed). SYNCHRONOUS API on PageNode —
// note: getMeasurements(), not getMeasurementsAsync(). Read from the page(s) BEING EXPORTED: this
// used to hardcode figma.currentPage, so a --page export of a non-current page silently attached the
// open page's redlines to a doc about a different page. Each entry is tagged with its page.
function collectMeasurements(pages?: ReadonlyArray<PageNode>): Obj[] | undefined {
  if (!runOpts.measurements) return undefined;
  const targets = pages && pages.length ? pages : [figma.currentPage];
  const out: Obj[] = [];
  for (const page of targets) {
    const p = page as any;
    if (typeof p.getMeasurements !== "function") continue;
    try {
      const ms = p.getMeasurements();
      if (!Array.isArray(ms) || !ms.length) continue;
      const side = (e: any) => (e ? { nodeId: e.node && e.node.id, side: e.side } : undefined);
      for (const m of ms) {
        // Always tagged, even for a single-page run. Emitting `page` only when targets.length > 1 gave
        // consumers two shapes for one field and made the single-page case the one where you cannot
        // tell WHICH page a redline came from without cross-referencing the doc's own scope.
        const o: Obj = { page: page.name, pageId: page.id, start: side(m.start), end: side(m.end) };
        if (m.freeText) o.text = m.freeText;
        if (m.offset != null) o.offset = m.offset;
        out.push(o);
      }
    } catch (e) {
      // NOT "Dev Mode only" — per developers.figma.com only addMeasurement/editMeasurement/
      // deleteMeasurement carry that restriction; the READ does not. Naming the wrong cause sends
      // someone off to open Dev Mode instead of reading the actual error.
      warn("measurements unavailable for page '" + page.name + "': " + errMsg(e));
    }
  }
  return out.length ? out : undefined;
}

export async function collectSelection(opts?: CollectOpts): Promise<Obj> {
  resetRun();
  const sel = figma.currentPage.selection;
  if (!sel.length) throw new Error("Select at least one frame first.");
  // Single small selection ("inspect one component") auto-enables the CSS oracle; multi-select keeps
  // it opt-in (a several-frame selection is closer to a full export than a component inspect).
  applyOpts(sel.length === 1 ? autoCss(opts, sel[0]) : opts);
  const nodes: Obj[] = [];
  for (const nd of sel) {
    const tree = await rootTree(nd);
    if (tree) nodes.push(tree);
  }
  return screenResult(sel.length === 1 ? sel[0].name : "selection", sel[0].name, nodes);
}

// Walk up to the owning PAGE node (needed to switch pages before selecting a linked node).
function pageOf(node: BaseNode): PageNode | null {
  let n: BaseNode | null = node;
  while (n && n.type !== "PAGE") n = n.parent;
  return n && n.type === "PAGE" ? (n as PageNode) : null;
}

// Export a single node addressed by id — the plane behind "paste a Figma link and ask".
export async function collectNode(rawId: string, opts?: CollectOpts): Promise<Obj> {
  resetRun();
  const nodeId = toNodeId(rawId);
  if (!nodeId) throw new Error("No node id provided.");
  const node = await findNodeById(nodeId, warn);
  applyOpts(autoCss(opts, node)); // single-node export → auto-enable the CSS oracle when the tree is small
  // Bring it into view so you can see what's being read. Best-effort.
  try {
    const page = pageOf(node);
    if (page && page !== figma.currentPage) await figma.setCurrentPageAsync(page);
    if ("visible" in node && node.parent) figma.currentPage.selection = [node as SceneNode];
    if (figma.viewport && "visible" in node) figma.viewport.scrollAndZoomIntoView([node as SceneNode]);
  } catch (e) {}
  const tree = await rootTree(node as SceneNode);
  if (!tree) throw new Error("Node " + nodeId + " is hidden or not exportable.");
  return screenResult(node.name, node.name, [tree]);
}

// Containers first, then loose top-level canvas content — a standalone TEXT note, a logo VECTOR, an
// image RECTANGLE, a TABLE placed directly on the page is real design too. Anything else (SLICE, etc.)
// is warned, not dropped.
// A Set, not an array: this is tested once per top-level child on every page walk, and a linear scan
// of 15 strings is pure waste when the membership test is the whole point of the list.
const TOP_LEVEL_TYPES = new Set([
  "FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "GROUP", "SECTION",
  "TEXT", "RECTANGLE", "ELLIPSE", "POLYGON", "STAR", "LINE", "VECTOR", "BOOLEAN_OPERATION", "TABLE",
]);

// ---------------------------------------------------------------- cheap structural index
// The MAP, not the territory. Every other read command deep-serializes (serializeWithRefs per frame),
// so the only way to learn what a file contains was to export all of it — a measured 12+ minutes on a
// real design system even with --no-assets. This walks pages and their TOP-LEVEL children only, with
// NO recursion and NO asset export, so cost is O(pages x top-level children) instead of O(all nodes).
//
// Mirrors Figma's own two dials (REST `?depth=1|2`, MCP get_metadata -> get_design_context):
//   depth 1 -> page names only. Loads nothing: figma.root.children yields PageNodes whose `name` reads
//     without a loadAsync. NOTE this one is INFERRED, not documented — the dynamic-page docs specify
//     only that PageNode.children throws when unloaded, and say nothing about `name`. Every other API
//     claim in this file is doc-grounded; treat this as the observed behaviour it is. If it ever
//     regresses, depth 1 fails loudly (a throw), not silently, so it is a safe thing to be wrong about.
//   depth 2 -> pages + their top-level frames (default). Loads each page individually, as needed.
// Structural fields ONLY (id/name/type/size). Deliberately no variable or component counts: those are
// soft, driftable numbers an agent would treat as decision-grade, and they belong in their own op.
//
// Reuses TOP_LEVEL_TYPES so "what counts as a frame" cannot drift from collectFull's own index.
export async function listPages(opts?: { depth?: number }): Promise<Obj> {
  const depth = opts && opts.depth === 1 ? 1 : 2;
  const localWarnings: string[] = [];
  const sink = (m: string) => localWarnings.push(m);
  // Page NAMES come off figma.root.children without loading anything; only reading a page's CHILDREN
  // requires it to be loaded (PageNode.children THROWS otherwise under dynamic-page access) — done
  // per page in the walk below rather than with one blanket loadAllPagesAsync. Read the getter once:
  // each read crosses the sandbox bridge and materialises a fresh wrapper array.
  const roots = figma.root.children;
  const currentId = figma.currentPage && figma.currentPage.id;
  const pages: Obj[] = [];
  let frameCount = 0;
  // At depth 2 EVERY page gets loaded (there is no early exit, unlike listChildren's lookup scan), and
  // the loads are independent — so issue them together rather than paying 25 round trips end-to-end on
  // a 25-page file. Same shape as collectFull's named-page path. Still per page, not
  // loadAllPagesAsync: a page that throws costs only itself (see loadPageSafely).
  if (depth >= 2) {
    await Promise.all(roots.map((p) => loadPageSafely(p, sink, "— its frames may be missing")));
  }
  for (const page of roots) {
    const entry: Obj = { name: page.name, id: page.id };
    if (page.id === currentId) entry.current = true;
    if (depth >= 2) {
      const children = pageChildren(page, sink, "its frames are NOT listed");
      if (!children) {
        entry.unreadable = true;
        pages.push(entry);
        continue;
      }
      const frames = children.filter((nd) => TOP_LEVEL_TYPES.has(nd.type)).map(summarize);
      frameCount += frames.length;
      entry.frames = frames;
    }
    pages.push(entry);
  }
  return {
    exportedAt: exportedAt(),
    file: figma.root.name,
    depth,
    pages,
    manifest: { pages: pages.length, frames: depth >= 2 ? frameCount : undefined, warnings: localWarnings },
  };
}

// ---------------------------------------------------------------- cheap structural index (node-scoped)
// listPages depth 2 stops at a page's TOP-LEVEL frames — peeking INSIDE one of those meant either a
// full recursive collectNode() (every property, every asset, minutes on a big frame) or nothing. This
// closes that gap: list one node's DIRECT children only, same cost model as listPages depth 2 (no
// recursion beyond one level, no asset export), just scoped by node id instead of by page.
// Deliberately does NOT filter by TOP_LEVEL_TYPES — that filter exists to drop loose canvas litter at
// a PAGE's top level (SLICE, etc.); once you're a level inside a frame every child type is real content
// (TEXT, VECTOR, INSTANCE...), so nothing here should be silently dropped from the count.
export async function listChildren(rawId: string): Promise<Obj> {
  const nodeId = toNodeId(rawId);
  if (!nodeId) throw new Error("No node id provided.");
  const localWarnings: string[] = [];
  const node = await findNodeById(nodeId, (m) => localWarnings.push(m));
  if (!("children" in node)) throw new Error("Node " + nodeId + " (" + node.type + ") is a leaf — it has no children to list.");
  let kids: ReadonlyArray<SceneNode>;
  try {
    kids = (node as any).children;
  } catch (e) {
    throw new Error("Node " + nodeId + "'s children could not be read: " + errMsg(e));
  }
  const children: Obj[] = [];
  for (const nd of kids) {
    const c = summarize(nd);
    if ("children" in nd) c.hasChildren = (nd as any).children.length > 0;
    children.push(c);
  }
  return {
    exportedAt: exportedAt(),
    id: node.id,
    name: node.name,
    type: node.type,
    children,
    manifest: { children: children.length, warnings: localWarnings },
  };
}

// Export the design system + frame trees. Frame trees default to the CURRENT page; pass
// { allPages:true } to walk every page (opt-in — a whole multi-page file can be very large).
export async function collectFull(opts?: CollectOpts): Promise<Obj> {
  resetRun();
  applyOpts(opts);
  const allPages = !!(opts && opts.allPages);
  if (allPages) await loadAllPages("all-pages export may miss pages");
  // NAMED pages — the tier between "whatever page happens to be open" and "all 25 of them".
  // A real file makes --all-pages unfinishable, and the current-page default forces a human to
  // navigate in the UI first, which an agent driving the bridge cannot do. Pairs with listPages:
  // list -> pick page id(s) -> pull just those. Repeatable (`--page a --page b`) following the
  // accumulating-flag convention (docker -e, curl -H), which covers the bounded-subset case
  // --all-pages cannot.
  const rawWanted: string[] = opts && opts.page !== undefined
    ? (Array.isArray(opts.page) ? opts.page : [opts.page]).map((s) => String(s).trim())
    : [];
  // An explicitly-passed-but-empty selector is a CALLER bug (an interpolated variable that came out
  // blank). Silently falling back to the current page would export the wrong thing and say nothing.
  if (rawWanted.length && rawWanted.every((s) => !s)) {
    // Name the scope actually used. Hardcoding "the current page" was wrong whenever allPages was
    // also set, which is the one case where this warning fires and the fallback ISN'T the open page.
    warn("page selector was empty after trimming — ignored, exported " + (allPages ? "every page instead" : "the current page instead"));
  }
  const wanted = rawWanted.filter(Boolean);
  // Mutually exclusive scopes, refused HERE rather than only in the CLI's arg parser. The branch
  // below is `if (allPages) … else if (wanted)`, so allPages silently won and a caller who asked for
  // one page got all 25 — a plausible export of the WRONG scope, the failure you don't notice.
  // figma-pull refused it at parse time; the MCP path had no such check, and every future caller
  // would have needed its own. One guard at the collector covers all of them.
  if (allPages && wanted.length) {
    throw new Error("allPages and page select different scopes — pass only one (page:[ids] for a bounded pull, allPages for the whole file).");
  }

  let pages: ReadonlyArray<PageNode>;
  if (allPages) {
    pages = figma.root.children;
  } else if (wanted.length) {
    const picked = resolvePages(wanted, figma.root.children);
    // loadAsync() loads just THESE pages, and every one of them is going to be walked — so unlike the
    // scans above (which stop early) they can load CONCURRENTLY, N round trips deep instead of N in a
    // row. Deliberately NOT loadAllPagesAsync — the docs are explicit ("loading all pages can be slow
    // in large files... only load pages as needed"), and paying for all 25 to read one is the exact
    // cost this option exists to avoid. No setCurrentPageAsync either: that would yank the user's
    // editor to another page during a read-only export.
    await Promise.all(picked.map((p) => loadPageSafely(p, warn, "")));
    pages = picked;
  } else {
    pages = [figma.currentPage];
  }
  // "layers", not "screens": this sweeps EVERY top-level node on the walked page(s) indiscriminately —
  // real UI frames alongside design-system specimen sections and individual icon components (verified
  // live: a "🎨 Design System" page's top-level layers were mostly swatches/icons, not app screens).
  // "Screen" stays reserved for collectSelection/collectNode, where a human deliberately picked one node.
  const layers: Obj[] = [];
  const index: Obj[] = [];
  const flows: Obj[] = []; // prototype entry points = the app's navigation-graph roots
  const pageSettings: Obj[] = []; // per-page canvas backgrounds (only where the designer set one)
  for (const page of pages) {
    // A page that failed to load must be skipped with a word, not abort the whole export.
    const children = pageChildren(page, warn, "its frames are missing from this export");
    if (!children) continue;
    // Only once the page is known readable — the same dynamic-page rule applies to its other props.
    const bg = await pageBackground(page);
    if (bg) pageSettings.push({ page: page.name, pageId: page.id, ...bg });
    if (Array.isArray((page as any).flowStartingPoints)) {
      for (const fp of (page as any).flowStartingPoints) flows.push({ page: page.name, pageId: page.id, nodeId: fp.nodeId, name: fp.name });
    }
    const frames: SceneNode[] = [];
    for (const nd of children) {
      if (TOP_LEVEL_TYPES.has(nd.type)) frames.push(nd);
      else if (nd.visible !== false) warn("top-level " + nd.type + " '" + nd.name + "' on page '" + page.name + "' not exported (unhandled top-level type)");
    }
    for (const f of frames) {
      const { tree, ref, dev } = await serializeWithRefs(f);
      if (tree) {
        // `pageId` alongside `page`: PageNode.name is user-editable and the Plugin API documents no
        // uniqueness constraint on it — Figma really does allow two pages named "Screens" (resolveOne
        // above refuses an ambiguous name for exactly that reason). Anything keyed on the NAME merges
        // those two distinct pages into one; the id is the stable identity. Name stays for display.
        layers.push({ name: f.name, id: f.id, page: page.name, pageId: page.id, tree, reference: ref, devResources: dev });
        index.push({ name: f.name, id: f.id, type: f.type, page: page.name, pageId: page.id,
          nodes: countNodes(tree), bytes: JSON.stringify(tree).length });
      }
    }
  }
  // AFTER the page walk: buildDesignSystem ends in dumpVariables, which uses the ids resolved during
  // that walk to also emit the LIBRARY variables the layers reference (see variables.ts). Building it
  // first — as this used to — meant the dump ran against an empty reference set.
  const designSystem = await buildDesignSystem();
  // Measurements are a PER-PAGE read. Scoping them to figma.currentPage while exporting a DIFFERENT
  // page attached another page's redlines to this doc — silently, and mislabelled. Read them from
  // the page(s) actually walked.
  const measurements = collectMeasurements(pages);
  const layersDoc: Obj = {
    exportedAt: exportedAt(),
    // Three cases, not two. Folding an explicit --page into "current-page" left the consumer unable
    // to tell whether it got the page it asked for, next to a `page` field naming a page that was
    // never exported (the named page is loaded, NOT made current — so figma.currentPage is still
    // whatever the user happens to be looking at).
    scope: allPages ? "all-pages" : wanted.length ? "page" : "current-page",
    page: allPages || pages.length !== 1 ? undefined : pages[0].name,
    pages: allPages || pages.length > 1 ? pages.map((p) => p.name) : undefined,
    flows: flows.length ? flows : undefined,
    pageSettings: pageSettings.length ? pageSettings : undefined,
    measurements: measurements || undefined,
    index,
    layers,
    manifest: manifest(),
  };
  return { designSystem, layersDoc, assets: assets.slice() };
}
