// Re-sending a keyed tree spec updates its earlier result in place (docs/write-plane-spec.md decision 11).
//
// A createTree op whose spec root carries a `key` is looked up here once the batch's trees have resolved (tree.ts
// resolveTreeOps: page, fonts, design-system names — every name the new spec uses, so every name an update needs). When
// the document holds a live result for the key (keyed-store.ts), the spec it was built from is read back off its nodes
// and planned against the new one (bridge/src/tree-diff.ts planUpdate); the op then updates that result instead of
// building a second one. Without one (never built, or deleted since) the op builds as usual and stamps what it built.
//
// Applying (applyUpdate), every step is a Change the batch can put back, like every other op's:
//   1. each kept node whose fields changed: its patch (patch.ts applyPatch, which keeps what it replaces) and the few
//      fields set directly (absolute, grow, alignSelf, clip, sizeLimits, strokesInLayout, x, y);
//   2. each node the new spec adds, or builds anew in place of an old one, built as the last child of its frame and
//      stamped (tree.ts buildSubtree);
//   3. each frame whose spec children change order or gain a node: its children put in the new order (the designer's
//      own layers keep their places);
//   4. the stored spec of every kept node that changed.
// The nodes the new spec drops (and the ones built anew) are removed only once the whole batch has landed, with the
// batch's deletes (writes.ts): a removed node cannot be brought back. Before anything runs, a node to be removed that
// holds a layer this key did not build (the designer's own) refuses the batch: a re-send removes only what it built.
//
// The reply is the root id and the key, and only what changed: the nodes updated (id, handle, fields), how many nodes
// were built and removed, the ids of new handles — `unchanged: true` when the spec is the one sent last time.
import type { AppliedWrite, WriteOp } from "../../bridge/src/commands.ts";
import { checkPatch } from "../../bridge/src/patch-spec.ts";
import { planUpdate, type ChildOrder, type ExtraField, type OldNode, type Plan } from "../../bridge/src/tree-diff.ts";
import type { TreeNodeSpec } from "../../bridge/src/tree-spec.ts";
import { KEY_DATA, readIndex, SPEC_DATA, stampNode } from "./keyed-store";
import { applyPatch, resolvePatchNode, type PatchTarget } from "./patch";
import { buildSubtree, createdCount, newMade, type TreeTarget } from "./tree";
import type { Change, OpProblem } from "./write-batch";

/** A createTree op that updates the result its key names. */
export interface KeyedUpdate {
  key: string;
  root: FrameNode;
  plan: Plan<SceneNode>;
  /** the resolved patch of each update that has one, by its index in `plan.updates` */
  patches: Map<number, PatchTarget>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const label = (n: BaseNode): string => "'" + n.name + "' (" + n.id + ")";

/** The live result the document holds for `key`, its page loaded; null when there is none (never built, or gone). */
async function findResult(key: string): Promise<FrameNode | null> {
  const id = readIndex(key);
  if (!id) return null;
  const n = await figma.getNodeByIdAsync(id);
  if (!n || n.type !== "FRAME" || n.removed || n.getPluginData(KEY_DATA) !== key) return null;
  let p: BaseNode | null = n.parent;
  while (p && p.type !== "PAGE") p = p.parent;
  if (!p || p.type !== "PAGE") return null;
  await p.loadAsync(); // dynamic-page: before its children are read
  return n;
}

/** The earlier spec, read back off the nodes `key` built (null when `n`'s stored spec is unreadable). */
function readOld(n: SceneNode, key: string): OldNode<SceneNode> | null {
  let spec: unknown;
  try { spec = JSON.parse(n.getPluginData(SPEC_DATA)) as unknown; } catch { return null; }
  if (!isObj(spec)) return null;
  const children: Array<OldNode<SceneNode>> = [];
  if (n.type === "FRAME") {
    for (const c of n.children) {
      if (c.getPluginData(KEY_DATA) !== key) continue; // a layer the designer added: not part of the spec
      const o = readOld(c, key);
      if (o) children.push(o);
    }
  }
  return { ref: n, spec, children };
}

/** The first layer at or below `n` (not inside an instance) that `key` did not build, or null. */
function foreignIn(n: SceneNode, key: string): SceneNode | null {
  if (n.getPluginData(KEY_DATA) !== key) return n;
  if (n.type !== "FRAME") return null;
  for (const c of n.children) {
    const f = foreignIn(c, key);
    if (f) return f;
  }
  return null;
}

/**
 * For every createTree op of a batch whose spec carries a key the file already has a result for: plan the update and
 * resolve its patches, setting the op's target `update`. A key used by two ops of one batch, a `page` other than the
 * result's, and a node to be removed that holds the designer's own layers are refused, with the rest of the batch.
 */
export async function resolveKeyed(ops: readonly WriteOp[], targets: ReadonlyMap<number, TreeTarget>): Promise<{ problems: OpProblem[] }> {
  const problems: OpProblem[] = [];
  const seen = new Map<string, number>();
  const loaded = new Map<string, Promise<string | null>>();
  const loadFont = (f: FontName): Promise<string | null> => {
    const k = f.family + "|" + f.style;
    let p = loaded.get(k);
    if (!p) {
      p = figma.loadFontAsync(f).then(() => null, () => "font '" + f.family + " " + f.style + "' is not available in this file");
      loaded.set(k, p);
    }
    return p;
  };
  for (const [index, op] of ops.entries()) {
    if (op.op !== "createTree" || !isObj(op.tree) || typeof op.tree.key !== "string") continue;
    const key = op.tree.key;
    const bad = (message: string): void => { problems.push({ index, op: op.op, message }); };
    const first = seen.get(key);
    if (first !== undefined) { bad("tree.key '" + key + "' is also the key of ops[" + first + "]; one batch updates a result once"); continue; }
    seen.set(key, index);
    const t = targets.get(index);
    if (!t) continue; // refused for its page or fonts already
    const root = await findResult(key);
    if (!root) continue; // built fresh, and stamped
    if (op.page !== undefined && root.parent && root.parent.id !== t.page.id) {
      bad("tree.key '" + key + "': its result " + label(root) + " is on page '" + root.parent.name + "', not '" + t.page.name + "'; an update stays where the result is — leave `page` out");
      continue;
    }
    const old = readOld(root, key);
    if (!old) { bad("tree.key '" + key + "': the spec stored on its result " + label(root) + " cannot be read; give the spec another key to build it again"); continue; }
    const plan = planUpdate(old, t.spec);
    const before = problems.length;
    for (const b of plan.builds) {
      if (!b.replaces) continue;
      const f = foreignIn(b.replaces, key);
      if (f) bad(b.path + ": " + label(b.replaces) + " is built anew (its type, component, font or a dropped property changed), but it holds " + label(f) + ", which this key did not build; move that layer out first");
    }
    for (const r of plan.removals) {
      const f = foreignIn(r, key);
      if (f) bad("tree.key '" + key + "': " + label(r) + " is no longer in the spec, but it holds " + label(f) + ", which this key did not build; move that layer out, or keep the node in the spec");
    }
    const patches = new Map<number, PatchTarget>();
    for (const [i, u] of plan.updates.entries()) {
      if (!u.set) continue;
      const say = (m: string): void => bad(u.path + " (" + label(u.ref) + "): " + m);
      const checked = checkPatch(u.set);
      if (checked.problems.length) { for (const m of checked.problems) say(m); continue; }
      // `later`: the checks that read the file as it is now run right before the patch applies, after the updates of
      // the frames above it.
      const p = await resolvePatchNode(u.ref, u.set, true, loadFont, say);
      if (!p) continue;
      p.refs = t.refs; // every name the update uses is in the new spec, which resolveTreeOps resolved
      patches.set(i, p);
    }
    if (problems.length === before) t.update = { key, root, plan, patches };
  }
  return { problems };
}

/** The nodes an update removes once its batch has landed: the ones the new spec dropped, and the ones built anew. */
export function removalsOf(u: KeyedUpdate): SceneNode[] {
  const out = u.plan.removals.slice();
  for (const b of u.plan.builds) if (b.replaces) out.push(b.replaces);
  return out;
}

const ALIGN_SELF = { min: "MIN", center: "CENTER", max: "MAX", stretch: "STRETCH" } as const;
const LIMITS = ["minWidth", "maxWidth", "minHeight", "maxHeight"] as const;
/** The order the direct fields are set in: the place in the flow before the position. */
const EXTRA_ORDER: readonly ExtraField[] = ["absolute", "grow", "alignSelf", "clip", "sizeLimits", "strokesInLayout", "x", "y"];

/** Set the direct fields of a kept node from its new spec, keeping what they replace. */
function applyExtras(n: SceneNode, s: TreeNodeSpec, fields: readonly ExtraField[]): Change {
  const kept: Array<[string, unknown]> = [];
  const put = (k: string, v: unknown): void => {
    if (!(k in n)) return;
    const was: unknown = Reflect.get(n, k);
    if (was === v) return;
    kept.push([k, was]);
    if (!Reflect.set(n, k, v)) throw new Error("cannot set " + k);
  };
  const parent = n.parent;
  const onPage = !parent || parent.type === "PAGE";
  const inFlex = !!parent && "layoutMode" in parent && parent.layoutMode !== "NONE";
  for (const f of EXTRA_ORDER) {
    if (fields.indexOf(f) < 0) continue;
    // The place in an auto-layout flow means nothing outside one (and Figma refuses some of it there).
    if (f === "absolute" && inFlex) put("layoutPositioning", s.absolute === true ? "ABSOLUTE" : "AUTO");
    else if (f === "grow" && inFlex) put("layoutGrow", s.grow !== undefined ? s.grow : 0);
    else if (f === "alignSelf" && inFlex) put("layoutAlign", s.alignSelf !== undefined ? ALIGN_SELF[s.alignSelf] : "INHERIT");
    else if (f === "clip") put("clipsContent", s.clip === true);
    else if (f === "sizeLimits") for (const k of LIMITS) put(k, s.sizeLimits && s.sizeLimits[k] !== undefined ? s.sizeLimits[k] : null);
    else if (f === "strokesInLayout") put("strokesIncludedInLayout", s.strokesInLayout === true);
    else if ((f === "x" || f === "y") && s[f] !== undefined && (onPage || !inFlex || s.absolute === true)) put(f, s[f]);
  }
  return {
    applied: { id: n.id },
    kind: "updated node",
    what: "the place and clipping of " + label(n),
    restore() { for (const [k, v] of kept.slice().reverse()) Reflect.set(n, k, v); },
  };
}

/** Put `parent`'s children in `want` order (each a child of it), node by node from the first place. */
function arrange(parent: FrameNode, want: readonly SceneNode[]): void {
  for (const [i, n] of want.entries()) {
    if (n.parent !== parent) continue;
    if (parent.children[i] !== n) parent.insertChild(i, n);
  }
}

/** Put a frame's spec children in the new order; the designer's own layers keep their places. */
function applyOrder(o: ChildOrder<SceneNode>, built: readonly SceneNode[]): Change {
  const parent = o.parent as FrameNode;
  const was = parent.children.slice(); // a copy: Figma's array is frozen, and live
  const nodes: SceneNode[] = [];
  for (const e of o.order) {
    const n = "ref" in e ? e.ref : built[e.build];
    if (n && n.parent === parent) nodes.push(n);
  }
  // The slots the spec's children hold now (built ones were appended last), in place order, take them in spec order.
  const slots = was.map((c, i) => (nodes.indexOf(c) >= 0 ? i : -1)).filter((i) => i >= 0);
  const want = was.slice();
  slots.forEach((slot, k) => { const n = nodes[k]; if (n) want[slot] = n; });
  arrange(parent, want);
  return {
    applied: { id: parent.id },
    kind: "reordered frame",
    what: "the order of the layers in " + label(parent),
    restore() { arrange(parent, was.filter((c) => c.parent === parent)); },
  };
}

/** Store the new own spec on every kept node whose spec changed; put back the old ones on restore. */
function restamp(stamps: Plan<SceneNode>["stamps"], key: string): Change {
  const was = stamps.map((s) => [s.ref, s.ref.getPluginData(SPEC_DATA)] as const);
  for (const s of stamps) stampNode(s.ref, key, s.spec);
  return {
    applied: {},
    kind: "stored spec",
    what: "the spec stored on " + stamps.length + " node(s)",
    restore() { for (const [n, v] of was) n.setPluginData(SPEC_DATA, v); },
  };
}

/**
 * Apply a planned update: every change it makes goes onto `changes` as it lands, so the batch can put all of it back.
 * `consent` is checked before each step and after each await. The nodes to remove are left to the batch (removalsOf).
 */
export async function applyUpdate(t: TreeTarget, u: KeyedUpdate, consent: () => void, allowed: () => boolean, changes: Change[]): Promise<AppliedWrite> {
  const { plan, key } = u;
  const changed: NonNullable<AppliedWrite["changed"]> = [];
  for (const [i, up] of plan.updates.entries()) {
    const p = u.patches.get(i);
    if (p) { consent(); await applyPatch(p, consent, allowed, changes); }
    if (up.extras.length) { consent(); changes.push(applyExtras(up.ref, up.spec, up.extras)); }
    changed.push({ id: up.ref.id, ...(up.spec.handle !== undefined ? { handle: up.spec.handle } : {}), fields: up.fields });
  }
  const made = newMade(t.refs);
  const built: SceneNode[] = [];
  for (const b of plan.builds) {
    consent();
    const from = made.pairs.length;
    const n = await buildSubtree(b.spec, b.parent as FrameNode, made, consent);
    for (const [m, s] of made.pairs.slice(from)) stampNode(m, key, s);
    changes.push({ applied: { id: n.id }, kind: "created node", what: "the new node " + label(n), restore() { n.remove(); } });
    built.push(n);
  }
  for (const o of plan.orders) { consent(); changes.push(applyOrder(o, built)); }
  if (plan.stamps.length) { consent(); changes.push(restamp(plan.stamps, key)); }

  const applied: AppliedWrite = { id: u.root.id, key };
  if (changed.length) applied.changed = changed;
  if (plan.builds.length) applied.created = createdCount(made);
  const removed = removalsOf(u).length;
  if (removed) applied.removed = removed;
  const reordered = plan.orders.filter((o) => o.order.every((e) => "ref" in e)).length;
  if (reordered) applied.reordered = reordered;
  const handles: Record<string, string> = {};
  for (const h of plan.handles) Object.defineProperty(handles, h.handle, { value: h.ref.id, enumerable: true, writable: true, configurable: true });
  for (const [h, id] of made.handles) Object.defineProperty(handles, h, { value: id, enumerable: true, writable: true, configurable: true });
  if (Object.keys(handles).length) applied.handles = handles;
  if (!changed.length && !plan.builds.length && !removed && !plan.orders.length && !applied.handles) applied.unchanged = true;
  return applied;
}
