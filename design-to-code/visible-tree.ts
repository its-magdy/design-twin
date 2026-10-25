// visible-tree.ts — the ONE walk over an export's node tree, shared by every script that reads one (audit.ts,
// cross-check.ts, verify-expect.ts, plan-skeleton.ts, verify-build.ts, drift-lint.ts, component-match.ts, design-system-dir.ts).
// It owns three answers a visitor would otherwise work out by hand: does this layer render, what is it inside,
// and what does it sit on.
//
// Does it render. The export marks a layer the designer switched off with `"hidden": true` on that node, and
// Figma does not render any of its descendants either. It does NOT use `visible: false` — and `"visible"`
// also appears in the export as a component PROPERTY name (`"visible": "Show Breadcrumb"`), so a
// grep for "visible" gives a confidently wrong answer. Testing `n.visible === false` never matches a real
// node; a reader that tested it emitted, on one real screen, 83 of 272 specs, 61 of 112 instances and 22 of 28
// interactions for layers nobody draws; and even with the right predicate, no finding may be emitted for a hidden node.
// So: a node is hidden iff it, or any ancestor, carries a truthy `hidden`. Nothing else. `walkVisible` never
// shows a visitor a hidden layer; `walkWithHidden` shows every layer and says which are hidden.
//
// What it sits on (`backdrop`). Its ancestors' fills composited top-down, and at each level the EARLIER siblings
// stacked under the next one (`beneath`): in a parent that does not lay its children out (no auto layout), or for
// an `absolute` child laid over the flow, an earlier sibling whose box meets this one's paints under it — a caption
// laid over a photo, a fill-less card over a hero, gets its backdrop from a sibling, not an ancestor. Both contrast
// checks (audit.ts per screen, cross-check.ts per token pair) read this one backdrop, so they name the same surface.
import { parseHex, compositeOver } from "./color.ts";
import type { Rgba } from "./color.ts";
import type { Box, IrNode, Paint, PlanHiddenRoot } from "./types.ts";

/**
 * What a layer sits on. `color`: the composited colour (null = nothing painted; callers assume a white page).
 * `complex`: a gradient / image / video / pattern / shader lies under it with no opaque solid over it since — the
 * colour is not what renders. `token`: the variable bound to the topmost opaque solid, null when that solid is raw
 * or anything translucent or complex lies over it (a node-level `tokens.fills` with no `fills[]` — older exports,
 * hand-written inputs — still names it).
 */
export interface Backdrop { color: Rgba | null; complex: boolean; token: string | null }

/** One layer of the walk: the node and what the walk worked out about it. */
export interface WalkFrame {
  node: IrNode;
  /** the node or an ancestor carries `hidden` */
  hidden: boolean;
  /** what the node sits on: its ancestors and the siblings beneath it, composited (computed on first read) */
  readonly backdrop: Backdrop;
  /** the earlier siblings that paint under this node, bottom first (computed on first read) */
  readonly beneath: readonly IrNode[];
}
/** What a walk hands its visitor beside the node. */
export interface WalkContext {
  hidden: boolean;
  parentHidden: boolean;
  path: string;
  parent: IrNode | null;
  depth: number;
  /** the chain above the node, root first, parent last */
  ancestors: readonly WalkFrame[];
  readonly backdrop: Backdrop;
  readonly beneath: readonly IrNode[];
}
export type WalkVisitor = (node: IrNode, ctx: WalkContext) => void;
export interface WalkOptions {
  /** How a node names itself in `path` (default: name, else type, else its child index). */
  pathOf?: (node: IrNode, index: number) => string;
}

/** The node's own flag — never `visible`. Takes anything: the JS contract is "any value, false unless it is an object with a truthy `hidden`". */
const hiddenSelf = (node: unknown): boolean => !!(node && typeof node === "object" && "hidden" in node && node.hidden);

/** Hidden iff the node itself or any ancestor is hidden. `ancestorHidden` is the parent's result. */
const isHidden = (node: unknown, ancestorHidden: boolean | null | undefined): boolean => !!ancestorHidden || hiddenSelf(node);

// ---- backdrop
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };
const NOTHING: Backdrop = { color: null, complex: false, token: null };
const paintToken = (p: Paint): string | null => { const t = p.tokens && p.tokens.color; const s = Array.isArray(t) ? t[0] : t; return typeof s === "string" && s ? s : null; };

/** What `base` becomes once node n paints over it. A TEXT's fills are its glyph colour, never a surface. */
function paintOver(base: Backdrop, n: IrNode): Backdrop {
  if (n.type === "TEXT") return base;
  const fills = (Array.isArray(n.fills) ? n.fills : []).filter(Boolean);
  const nodeTok = n.tokens && typeof n.tokens.fills === "string" && n.tokens.fills ? n.tokens.fills : null;
  if (!fills.length) return nodeTok ? { ...base, token: nodeTok } : base;
  let { color, complex, token } = base;
  for (const f of fills) {
    if (f.opacity === 0 || f.visible === false) continue; // paints nothing
    if (f.type !== "solid") { complex = true; token = null; continue; }
    const c = parseHex(f.color);
    const tok = paintToken(f) ?? (fills.length === 1 ? nodeTok : null);
    if (!c) { token = tok; continue; }
    if (c.a <= 0) continue; // fully transparent: paints nothing
    color = color ? compositeOver(c, color) : c.a >= 1 ? c : compositeOver(c, WHITE);
    if (c.a >= 1) { complex = false; token = tok; } else token = null;
  }
  return { color, complex, token };
}

/**
 * What a stack of layers (bottom first) paints over `under` — a control's own fills over its backdrop, under the same
 * paint rules as the backdrop. Null when none of them paints anything. `complex`: a non-solid is left uncovered (the
 * colour is not what renders). `tokenColor` resolves a node-level `tokens.fills` on a layer with no `fills[]`.
 */
function paintedOver(under: Rgba, layers: readonly IrNode[], tokenColor?: (token: string) => Rgba | null): { color: Rgba; complex: boolean } | null {
  let color = under, complex = false, painted = false;
  for (const n of layers) {
    if (n.type === "TEXT") continue;
    const fills = (Array.isArray(n.fills) ? n.fills : []).filter(Boolean);
    const nodeTok = n.tokens && typeof n.tokens.fills === "string" && n.tokens.fills ? n.tokens.fills : null;
    const lt = !fills.length && nodeTok && tokenColor ? tokenColor(nodeTok) : null;
    if (lt && lt.a > 0) { color = compositeOver(lt, color); painted = true; if (lt.a >= 1) complex = false; }
    for (const f of fills) {
      if (f.opacity === 0 || f.visible === false) continue;
      if (f.type !== "solid") { complex = true; painted = true; continue; }
      const c = parseHex(f.color);
      if (!c || c.a <= 0) continue;
      color = compositeOver(c, color);
      painted = true;
      if (c.a >= 1) complex = false;
    }
  }
  return painted ? { color, complex } : null;
}

// An icon's paint, not a surface: an asset leaf (figma-plugin/src/assets.ts) that is a path (VECTOR,
// BOOLEAN_OPERATION, LINE) or a flattened icon container (FRAME/INSTANCE/GROUP/COMPONENT), with no
// image/gradient fill. RECTANGLE/ELLIPSE/STAR/POLYGON leaves are shapes and can sit under text.
const INK_TYPES = new Set(["VECTOR", "BOOLEAN_OPERATION", "LINE", "FRAME", "INSTANCE", "GROUP", "COMPONENT"]);
function isIconInk(n: IrNode): boolean {
  if (!(n.asset || n.geometry || n.assetSkipped) || !INK_TYPES.has(String(n.type))) return false;
  return !(Array.isArray(n.fills) && n.fills.some((f) => f.type === "image" || f.type === "gradient"));
}
// Whether two page-space boxes intersect. Unknown when either lacks x/y (a flow child's box is only w/h —
// serialize.ts writes x/y only where the parent does not lay the child out): then assume they do.
function overlaps(a: Box | undefined, b: Box | undefined): boolean {
  if (!a || !b || typeof a.x !== "number" || typeof a.y !== "number" || typeof b.x !== "number" || typeof b.y !== "number") return true;
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
// Whether a sibling paints a surface a later sibling can sit on. A TEXT sibling's `fills` are its GLYPH colour and an
// icon's are its ink — neither paints a backdrop: counting them would make the 2nd and 3rd of three stacked white
// header labels "white on white, 1:1". A SHAPE the plugin also exports as an asset (an ELLIPSE avatar disc, a photo
// RECTANGLE) still does.
const paintsSurface = (n: IrNode): boolean => !hiddenSelf(n) && n.type !== "TEXT" && !isIconInk(n) && Array.isArray(n.fills) && n.fills.length > 0;
/** The earlier siblings of kids[i] stacked under it, bottom first. */
function beneathOf(parent: IrNode, kids: readonly IrNode[], i: number): IrNode[] {
  const child = kids[i];
  if (!child) return [];
  const stacks = !parent.layout || parent.layout.mode === "absolute";
  if (!stacks && !child.absolute) return [];
  return kids.slice(0, i).filter((s) => s && typeof s === "object" && paintsSurface(s) && overlaps(s.box, child.box));
}

/** A lazily computed, memoised value (the backdrop is only worked out for the nodes a visitor asks about). */
function memo<T>(fn: () => T): () => T {
  let cell: { v: T } | null = null;
  return () => (cell ??= { v: fn() }).v;
}

// ---- the walk
function walk(root: IrNode | null | undefined, fn: WalkVisitor, prune: boolean, opts?: WalkOptions): void {
  const pathOf = (opts && opts.pathOf) || ((n: IrNode, i: number) => n.name || n.type || String(i));
  (function go(node: IrNode | null | undefined, parentHidden: boolean, path: string, ancestors: readonly WalkFrame[], under: () => Backdrop, beneath: () => readonly IrNode[]): void {
    if (!node || typeof node !== "object") return;
    const hidden = isHidden(node, parentHidden);
    if (hidden && prune) return;
    const backdrop = memo(() => beneath().reduce(paintOver, under()));
    const parentFrame = ancestors[ancestors.length - 1];
    const frame: WalkFrame = { node, hidden, get backdrop() { return backdrop(); }, get beneath() { return beneath(); } };
    fn(node, {
      hidden, parentHidden: !!parentHidden, path, parent: parentFrame ? parentFrame.node : null, depth: ancestors.length, ancestors,
      get backdrop() { return backdrop(); }, get beneath() { return beneath(); },
    });
    const kids = Array.isArray(node.children) ? node.children : [];
    if (!kids.length) return;
    const inside = memo(() => paintOver(backdrop(), node));
    const chain = [...ancestors, frame];
    for (const [i, kid] of kids.entries()) go(kid, hidden, (path ? path + " > " : "") + pathOf(kid, i), chain, inside, memo(() => beneathOf(node, kids, i)));
  })(root, false, root ? pathOf(root, 0) : "", [], () => NOTHING, () => []);
}

/**
 * Walk a tree, calling fn(node, ctx) for every node, hidden ones included (callers decide what to do with them —
 * audit.ts still wants a hidden "Error toast" as evidence that an error state was designed). `ctx.hidden` is the
 * inherited predicate above.
 */
function walkWithHidden(root: IrNode | null | undefined, fn: WalkVisitor, opts?: WalkOptions): void {
  walk(root, fn, false, opts);
}

/** Walk the layers that render: a hidden layer and its whole subtree are never visited. */
function walkVisible(root: IrNode | null | undefined, fn: WalkVisitor, opts?: WalkOptions): void {
  walk(root, fn, true, opts);
}

/** Every node id the designer switched off (the node and its whole subtree), in tree order. */
function hiddenIds(roots: readonly IrNode[] | null | undefined): string[] {
  const out: string[] = [];
  for (const r of roots || []) walkWithHidden(r, (n, c) => { if (c.hidden && n.id) out.push(n.id); });
  return out;
}

/** The TOP of each hidden subtree — the layers that actually carry the flag under a visible parent. */
function hiddenRoots(roots: readonly IrNode[] | null | undefined): IrNode[] {
  const out: IrNode[] = [];
  for (const r of roots || []) walkWithHidden(r, (n, c) => { if (c.hidden && !c.parentHidden) out.push(n); });
  return out;
}

/** What walkNodes hands its visitor beside the node. */
export interface NodeContext { parent: IrNode | null; hidden: boolean; hiddenRoot: boolean; insideInstance: string | null }
export type NodeVisitor = (n: IrNode, ctx: NodeContext) => void;

/** Walk every node of `roots` with its ancestry and hidden state. `hiddenRoot`: the top of a hidden subtree;
 *  `insideInstance`: the nearest INSTANCE above the node — its internals belong to that component. */
function walkNodes(roots: readonly IrNode[] | null | undefined, visit: NodeVisitor): void {
  for (const r of roots || []) {
    walkWithHidden(r, (n, c) => {
      const above = c.ancestors.findLast((a) => a.node.type === "INSTANCE");
      visit(n, { parent: c.parent, hidden: c.hidden, hiddenRoot: c.hidden && !c.parentHidden, insideInstance: above ? above.node.id || null : null });
    });
  }
}

export interface VisibleEntry { node: IrNode; parentId: string | null; insideInstance: string | null }
/** A screen split by the one predicate: every layer that renders (by id, with its parent and enclosing instance), every
 *  hidden id, and the top of each hidden subtree with how many nodes it hides (itself included). */
export interface Visibility { visible: Map<string, VisibleEntry>; hidden: Set<string>; hiddenRoots: PlanHiddenRoot[] }

/** The visibility of the tree under `roots` (plan-skeleton's anchors and hidden[], verify-build's anchor and tag coverage). */
function visibility(roots: readonly IrNode[] | null | undefined): Visibility {
  const visible = new Map<string, VisibleEntry>(), hidden = new Set<string>(), hiddenRoots: PlanHiddenRoot[] = [];
  const count = new Map<string, PlanHiddenRoot>();
  walkNodes(roots, (n, ctx) => {
    if (!n.id) return;
    if (ctx.hidden) {
      hidden.add(n.id);
      if (ctx.hiddenRoot) { const root: PlanHiddenRoot = { id: n.id, name: n.name, type: n.type, nodes: 0 }; hiddenRoots.push(root); count.set(n.id, root); }
    } else visible.set(n.id, { node: n, parentId: ctx.parent ? ctx.parent.id : null, insideInstance: ctx.insideInstance });
  });
  // how many nodes each hidden root hides (itself included)
  const tally = (n: IrNode | null | undefined, root: string | null): void => {
    if (!n || typeof n !== "object") return;
    const r = root || (count.has(n.id) ? n.id : null);
    const entry = r ? count.get(r) : undefined; // r is always a key of count (root, or n.id when count has it)
    if (entry) entry.nodes++;
    for (const c of n.children || []) tally(c, r);
  };
  for (const r of roots || []) tally(r, null);
  return { visible, hidden, hiddenRoots };
}

export { hiddenSelf, isHidden, isIconInk, paintedOver, walkWithHidden, walkVisible, walkNodes, visibility, hiddenIds, hiddenRoots };
