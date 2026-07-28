// Collectors (return data; shared by manual export AND the bridge). Each resets per-run state,
// applies read options, walks the requested scope, and returns the compact screen/design-system docs.
import { Obj, safe, errMsg } from "./util";
import { assets, resetRun, manifest, runOpts, warn } from "./state";
import { serialize } from "./serialize";
import { collectReference, devResources } from "./assets";
import { buildDesignSystem } from "./components";
import { dumpVariables, resolvedModes } from "./variables";

export interface CollectOpts {
  allPages?: boolean;
  css?: boolean;
  measurements?: boolean;
  pluginData?: boolean;
  motion?: boolean;
  sharedData?: boolean;
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
  const screen: Obj = { exportedAt: new Date().toISOString(), screen: title, nodes, manifest: manifest() };
  const measurements = collectMeasurements();
  if (measurements) screen.measurements = measurements;
  return { screenName: safe(fileBase), screen, variables: await dumpVariables(), assets: assets.slice() };
}

function applyOpts(opts?: CollectOpts): void {
  for (const k of Object.keys(runOpts) as Array<keyof typeof runOpts>) runOpts[k] = !!(opts && (opts as any)[k]);
}

// getCSSAsync (Figma's own CSS oracle) is opt-in because it's one async call PER NODE — O(nodes) on a
// big frame. But for the "inspect one small component" path it's cheap and high-value, so DEFAULT it
// ON when the caller didn't specify AND the exported subtree is small. Large/full exports keep it off
// unless explicitly requested. An explicit css:false/true always wins (only `undefined` auto-resolves).
const CSS_AUTO_NODE_CAP = 60;
function subtreeSize(node: any, cap: number): number {
  let count = 0;
  const stack = [node];
  while (stack.length && count <= cap) {
    const n = stack.pop();
    count++;
    if (n && "children" in n && Array.isArray(n.children)) {
      for (const c of n.children) stack.push(c);
    }
  }
  return count;
}
function autoCss(opts: CollectOpts | undefined, node: any): CollectOpts {
  // Spread, not a field-by-field clone: a hand-written copy silently DROPS any newly added read
  // option on exactly the single-selection / single-node paths, which is the hardest gap to notice.
  const o: CollectOpts = { ...opts };
  if (o.css === undefined && subtreeSize(node, CSS_AUTO_NODE_CAP) <= CSS_AUTO_NODE_CAP) o.css = true;
  return o;
}

// Dev-Mode measurement redlines (spacing specs the designer placed). SYNCHRONOUS API on PageNode —
// note: getMeasurements(), not getMeasurementsAsync(). Scoped to the current page.
function collectMeasurements(): Obj[] | undefined {
  const p = figma.currentPage as any;
  if (!runOpts.measurements || typeof p.getMeasurements !== "function") return undefined;
  try {
    const ms = p.getMeasurements();
    if (!Array.isArray(ms) || !ms.length) return undefined;
    const side = (e: any) => (e ? { nodeId: e.node && e.node.id, side: e.side } : undefined);
    return ms.map((m: any) => {
      const o: Obj = { start: side(m.start), end: side(m.end) };
      if (m.freeText) o.text = m.freeText;
      if (m.offset != null) o.offset = m.offset;
      return o;
    });
  } catch (e) {
    warn("measurements unavailable (Dev Mode only): " + errMsg(e));
    return undefined;
  }
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
  const nodeId = String(rawId || "").replace(/-/g, ":");
  if (!nodeId) throw new Error("No node id provided.");
  // Try the cheap lookup FIRST. Under dynamic-page access loadAllPagesAsync deserializes every page
  // in the file — the most expensive operation in the read plane — and this is the "paste a Figma
  // link and ask" path, where the node is almost always on the page already open. Only pay for the
  // full load when the id genuinely isn't resolvable yet.
  let node = await figma.getNodeByIdAsync(nodeId);
  if (!node && figma.loadAllPagesAsync) {
    try { await figma.loadAllPagesAsync(); } catch (e) { warn("loadAllPagesAsync failed (cross-page node lookup may miss): " + errMsg(e)); }
    node = await figma.getNodeByIdAsync(nodeId);
  }
  if (!node) throw new Error("Node " + nodeId + " is not in the open file — open the Figma file this link points to, then retry.");
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

const FRAME_TYPES = ["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "GROUP", "SECTION"];
// Loose top-level canvas content is real design too — a standalone TEXT note, a logo VECTOR, an image
// RECTANGLE, a TABLE placed directly on the page. Anything else (SLICE, etc.) is warned, not dropped.
const TOP_LEVEL_TYPES = FRAME_TYPES.concat(["TEXT", "RECTANGLE", "ELLIPSE", "POLYGON", "STAR", "LINE", "VECTOR", "BOOLEAN_OPERATION", "TABLE"]);

// Export the design system + frame trees. Frame trees default to the CURRENT page; pass
// { allPages:true } to walk every page (opt-in — a whole multi-page file can be very large).
export async function collectFull(opts?: CollectOpts): Promise<Obj> {
  resetRun();
  applyOpts(opts);
  const allPages = !!(opts && opts.allPages);
  if (allPages && figma.loadAllPagesAsync) {
    try { await figma.loadAllPagesAsync(); } catch (e) { warn("loadAllPagesAsync failed (all-pages export may miss pages): " + errMsg(e)); }
  }
  const pages = allPages ? figma.root.children : [figma.currentPage];
  const screens: Obj[] = [];
  const index: Obj[] = [];
  const flows: Obj[] = []; // prototype entry points = the app's navigation-graph roots
  for (const page of pages) {
    // PageNode.children THROWS on a page that isn't current and wasn't loaded (dynamic-page access),
    // so a failed loadAllPagesAsync above would otherwise abort the whole export right here — the
    // warning promised degradation the code didn't deliver. Skip the unreadable page and say which.
    let children: ReadonlyArray<SceneNode>;
    try {
      if (Array.isArray((page as any).flowStartingPoints)) {
        for (const fp of (page as any).flowStartingPoints) flows.push({ page: page.name, nodeId: fp.nodeId, name: fp.name });
      }
      children = page.children;
    } catch (e) {
      warn("page '" + page.name + "' could not be read (not loaded) — its frames are missing from this export: " + errMsg(e));
      continue;
    }
    const frames: SceneNode[] = [];
    for (const nd of children) {
      if (TOP_LEVEL_TYPES.includes(nd.type)) frames.push(nd);
      else if (nd.visible !== false) warn("top-level " + nd.type + " '" + nd.name + "' on page '" + page.name + "' not exported (unhandled top-level type)");
    }
    for (const f of frames) {
      const { tree, ref, dev } = await serializeWithRefs(f);
      if (tree) {
        screens.push({ name: f.name, id: f.id, page: page.name, tree, reference: ref, devResources: dev });
        index.push({ name: f.name, id: f.id, type: f.type, page: page.name });
      }
    }
  }
  // AFTER the page walk: buildDesignSystem ends in dumpVariables, which uses the ids resolved during
  // that walk to also emit the LIBRARY variables the screens reference (see variables.ts). Building it
  // first — as this used to — meant the dump ran against an empty reference set.
  const designSystem = await buildDesignSystem();
  const measurements = collectMeasurements();
  const screensDoc: Obj = {
    exportedAt: new Date().toISOString(),
    scope: allPages ? "all-pages" : "current-page",
    page: allPages ? undefined : figma.currentPage.name,
    pages: allPages ? pages.map((p) => p.name) : undefined,
    flows: flows.length ? flows : undefined,
    measurements: measurements || undefined,
    index,
    screens,
    manifest: manifest(),
  };
  return { designSystem, screensDoc, assets: assets.slice() };
}
