// hidden.ts — the ONE rule for "does this layer render?", shared by every script that reads a node
// tree (verify-screen.ts's expectation / comparison / instance list / interaction list / tag
// coverage, audit.ts's finding emitters, drift-lint.ts's screen-coverage wording).
//
// The export marks a layer the designer switched off with `"hidden": true` on that node, and Figma
// does not render any of its descendants either. It does NOT use `visible: false` — and `"visible"`
// also appears in the export as a component PROPERTY name (`"visible": "Show Breadcrumb"`), so a
// grep for "visible" gives a confidently wrong answer (livetest-3 finding 34). verify-screen.js used
// to test `n.visible === false`, which never matched a single real node, and so emitted 83 of 272
// Jet Roles specs, 61 of 112 instances and 22 of 28 interactions for layers nobody draws (findings
// 97/126/157/159/181/185). audit.js had the right predicate and then emitted findings for hidden
// nodes anyway (finding 74).
//
// So: a node is hidden iff it, or any ancestor, carries a truthy `hidden`. Nothing else.
import type { IrNode } from "./types.ts";

/** What walkWithHidden hands its visitor beside the node. */
export interface WalkContext {
  hidden: boolean;
  parentHidden: boolean;
  path: string;
  parent: IrNode | null;
  depth: number;
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

/**
 * Walk a tree, calling fn(node, { hidden, parentHidden, path, parent, depth }) for every node, hidden ones
 * included (callers decide what to do with them — audit.ts still wants a hidden "Error toast" as
 * evidence that an error state was designed). `hidden` is the inherited predicate above.
 */
function walkWithHidden(root: IrNode | null | undefined, fn: WalkVisitor, opts?: WalkOptions): void {
  const pathOf = (opts && opts.pathOf) || ((n: IrNode, i: number) => n.name || n.type || String(i));
  (function go(node: IrNode | null | undefined, parentHidden: boolean, path: string, parent: IrNode | null, depth: number): void {
    if (!node || typeof node !== "object") return;
    const hidden = isHidden(node, parentHidden);
    fn(node, { hidden, parentHidden: !!parentHidden, path, parent, depth });
    const kids = Array.isArray(node.children) ? node.children : [];
    for (const [i, kid] of kids.entries()) go(kid, hidden, (path ? path + " > " : "") + pathOf(kid, i), node, depth + 1);
  })(root, false, root ? pathOf(root, 0) : "", null, 0);
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

export { hiddenSelf, isHidden, walkWithHidden, hiddenIds, hiddenRoots };
