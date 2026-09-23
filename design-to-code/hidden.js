// hidden.js — the ONE rule for "does this layer render?", shared by every script that reads a node
// tree (verify-screen.js's expectation / comparison / instance list / interaction list / tag
// coverage, audit.js's finding emitters, drift-lint.js's screen-coverage wording).
//
// The export marks a layer the designer switched off with `"hidden": true` on that node, and Figma
// does not render any of its descendants either. It does NOT use `visible: false` — and `"visible"`
// also appears in the export as a component PROPERTY name (`"visible": "Show Breadcrumb"`), so a
// grep for "visible" gives a confidently wrong answer (livetest-3 finding 34). verify-screen.js used
// to test `n.visible === false`, which never matched a single real node, and so emitted 83 of 272
// Job Roles specs, 61 of 112 instances and 22 of 28 interactions for layers nobody draws (findings
// 97/126/157/159/181/185). audit.js had the right predicate and then emitted findings for hidden
// nodes anyway (finding 74).
//
// So: a node is hidden iff it, or any ancestor, carries a truthy `hidden`. Nothing else.

/** The node's own flag — never `visible`. */
const hiddenSelf = (node) => !!(node && typeof node === "object" && node.hidden);

/** Hidden iff the node itself or any ancestor is hidden. `ancestorHidden` is the parent's result. */
const isHidden = (node, ancestorHidden) => !!ancestorHidden || hiddenSelf(node);

/**
 * Walk a tree, calling fn(node, { hidden, parentHidden, path, parent, depth }) for every node, hidden ones
 * included (callers decide what to do with them — audit.js still wants a hidden "Error toast" as
 * evidence that an error state was designed). `hidden` is the inherited predicate above.
 */
function walkWithHidden(root, fn, opts) {
  const pathOf = (opts && opts.pathOf) || ((n, i) => n.name || n.type || String(i));
  (function go(node, parentHidden, path, parent, depth) {
    if (!node || typeof node !== "object") return;
    const hidden = isHidden(node, parentHidden);
    fn(node, { hidden, parentHidden: !!parentHidden, path, parent, depth });
    const kids = Array.isArray(node.children) ? node.children : [];
    for (let i = 0; i < kids.length; i++) go(kids[i], hidden, (path ? path + " > " : "") + pathOf(kids[i], i), node, depth + 1);
  })(root, false, root && (pathOf(root, 0)), null, 0);
}

/** Every node id the designer switched off (the node and its whole subtree), in tree order. */
function hiddenIds(roots) {
  const out = [];
  for (const r of roots || []) walkWithHidden(r, (n, c) => { if (c.hidden && n.id) out.push(n.id); });
  return out;
}

/** The TOP of each hidden subtree — the layers that actually carry the flag under a visible parent. */
function hiddenRoots(roots) {
  const out = [];
  for (const r of roots || []) walkWithHidden(r, (n, c) => { if (c.hidden && !c.parentHidden) out.push(n); });
  return out;
}

module.exports = { hiddenSelf, isHidden, walkWithHidden, hiddenIds, hiddenRoots };
