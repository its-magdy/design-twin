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
// A component spec (a COMPONENT or COMPONENT_SET root) is keyed by its name (component-build.ts): the one local component
// of that name a write made is its earlier result. A set's variants pair by handle, name, then order (tree-diff.ts), so a
// renamed variant keeps its node; every rename is a patch, so it lands before a new variant is built. Its property
// definitions and its layers' wiring are brought to the new spec too: each reference that goes is unwired before the
// patches (unwireGoing), a field that stays bound is never patched (it follows the property's default), definitions are
// added and edited and new references wired after the builds (syncComponent), and a definition the spec drops is
// deleted after the batch's removals, last of all (writes.ts).
//
// The reply is the root id and the key, and only what changed: the nodes updated (id, handle, fields), how many nodes
// were built and removed, the ids of new handles — `unchanged: true` when the spec is the one sent last time.
import type { AppliedWrite, WriteImpactStep, WriteOp } from "../../bridge/src/commands.ts";
import { checkPatch } from "../../bridge/src/patch-spec.ts";
import { checkTree } from "../../bridge/src/tree-check.ts";
import { ownSpec, planUpdate, type ChildOrder, type ExtraField, type Plan } from "../../bridge/src/tree-diff.ts";
import type { TreeNodeSpec } from "../../bridge/src/tree-spec.ts";
import { KEY_DATA, readIndex, readOld, SPEC_DATA, stampNode } from "./keyed-store";
import { applyPatch, resolvePatchNode, type PatchTarget } from "./patch";
import { buildSubtree, checkMade, createdCount, madeFrom, madeNodes, newMade, stampAll, type TreeTarget } from "./tree";
import { componentKey, componentRootOf } from "../../bridge/src/component-spec.ts";
import { arrangeVariants, componentReply, existingComponent, planDefs, planWiring, syncComponent, textsFollowing, unwireGoing, type DefsPlan } from "./component-build";
import { RestoreStopped, type Change, type OpProblem } from "./write-batch";
import { goneFrom, inDocument, nodeById, stillInDocument, stillToRestore, takeBack } from "./node-lookup";
import { pageHolding } from "./places";
import { matchByName } from "../../bridge/src/name-match.ts";
import { idLike } from "../../bridge/src/place-spec.ts";

/** A createTree op that updates the result its key names. */
export interface KeyedUpdate {
  key: string;
  root: FrameNode | ComponentNode | ComponentSetNode;
  /** a component spec: its name, and what its property definitions need to equal the spec's */
  component?: { name: string; defs: DefsPlan } | undefined;
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
  const n = await nodeById(id);
  if (!n || n.type !== "FRAME" || n.removed || n.getPluginData(KEY_DATA) !== key) return null;
  // Deleted while its page loaded (node-lookup.ts): there is no result, as if it had gone before the batch.
  return (await loadPageOf(n)) && inDocument(n) ? n : null;
}
/** Load the page `n` is on (dynamic-page: before its children are read); false when it is on none. */
async function loadPageOf(n: BaseNode): Promise<boolean> {
  let p: BaseNode | null = n.parent;
  while (p && p.type !== "PAGE") p = p.parent;
  if (!p || p.type !== "PAGE") return false;
  await p.loadAsync();
  return true;
}
/** Figma's cap on one plugin data entry (100 kB), less room for the key. */
const MAX_STAMP_BYTES = 99000;
/** `s`'s size in UTF-8 bytes. */
function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}
/** Every node of a keyed spec whose own fields are too big to store on it, by path. */
function oversized(s: TreeNodeSpec, path: string, out: string[]): string[] {
  const bytes = utf8Bytes(JSON.stringify(ownSpec(s)));
  if (bytes > MAX_STAMP_BYTES) out.push(path + ": its own fields are " + bytes + " bytes, more than a keyed spec can store on a node (" + MAX_STAMP_BYTES + "); shorten its text, or leave out the key");
  (s.children || []).forEach((c, i) => oversized(c, path + ".children[" + i + "]", out));
  return out;
}

/** The first layer at or below `n` (not inside an instance) that `key` did not build, or null. */
function foreignIn(n: SceneNode, key: string): SceneNode | null {
  if (n.getPluginData(KEY_DATA) !== key) return n;
  // Every container but an instance (whose layers are its component's): a copy brings groups and other containers in.
  if (n.type === "INSTANCE" || !("children" in n)) return null;
  for (const c of n.children) {
    const f = foreignIn(c, key);
    if (f) return f;
  }
  return null;
}

/** "leave `page` out", "leave `section` and `createSection` out": the placement fields of `fields` that `op` carries, to
 *  leave out (a create flag left in without its name is refused). */
function leaveOut(op: WriteOp, fields: readonly ("page" | "createPage" | "section" | "createSection")[]): string {
  const has = fields.filter((f) => op[f] !== undefined).map((f) => "`" + f + "`");
  return "leave " + (has.length > 1 ? has.slice(0, -1).join(", ") + " and " + has[has.length - 1] : has.join("")) + " out";
}

/** Whether name `ref` matches `item` alone among `items` (by id or by name, as a page or section is looked up). */
function onlyOne<T extends BaseNode>(ref: string, items: readonly T[], item: T): boolean {
  const m = matchByName(ref, items, (n) => n.name, (n) => [n.id]);
  return m.kind === "one" && m.item === item;
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
    // A component spec is keyed by its name (component-build.ts).
    const comp = op.op === "createTree" ? componentRootOf(op.tree) : null;
    if (op.op !== "createTree" || !isObj(op.tree) || (typeof op.tree.key !== "string" && !comp)) continue;
    const key = comp ? componentKey(comp.name) : String(op.tree.key);
    const what = comp ? "component '" + comp.name + "'" : "tree.key '" + key + "'";
    const bad = (message: string): void => { problems.push({ index, op: op.op, message }); };
    const first = seen.get(key);
    if (first !== undefined) { bad(comp ? "component '" + comp.name + "' is also made by ops[" + first + "]; one batch makes or updates a component once" : "tree.key '" + key + "' is also the key of ops[" + first + "]; one batch updates a result once"); continue; }
    seen.set(key, index);
    const t = targets.get(index);
    if (!t) continue; // refused for its page or fonts already
    // Checked before anything is built: a stamp that cannot be stored would fail the batch partway.
    const big = oversized(t.spec, "tree", []);
    if (big.length) { for (const m of big) bad(m); continue; }
    let root: FrameNode | ComponentNode | ComponentSetNode | null = null;
    if (comp) {
      const found = await existingComponent(comp.type, comp.name);
      if ("problem" in found) { bad(found.problem); continue; }
      if ("ours" in found && (await loadPageOf(found.ours)) && inDocument(found.ours)) root = found.ours;
    } else root = await findResult(key);
    if (!root) continue; // built fresh, and stamped
    // The page and section the op names, held across the result's page load (node-lookup.ts): gone, it is missing, never
    // read.
    const namedPage = op.page !== undefined ? t.dest.page.node : null;
    if (namedPage && goneFrom(namedPage, bad, "page")) continue;
    const namedSection = op.section !== undefined && t.dest.section ? t.dest.section.node : null;
    if (namedSection && goneFrom(namedSection, bad, "section")) continue;
    // An update stays where its result is: a page or section the op names must be the result's (one the batch would
    // make is not: nothing is made for an update).
    const on = pageHolding(root);
    if (op.page !== undefined && on && on !== t.dest.page.node) {
      // Its section too: left in, it would be looked for on the page the op then lands on.
      bad(what + ": its result " + label(root) + " is on page '" + on.name + "', not '" + t.dest.page.name + "'; an update stays where the result is — " + leaveOut(op, ["page", "createPage", "section", "createSection"]));
      continue;
    }
    const inSection = root.parent && root.parent.type === "SECTION" ? root.parent : null;
    const s = t.dest.section;
    if (op.section !== undefined && s && (!s.node || inSection !== s.node)) {
      // A section the batch would make shares no node with the result's, even when it has the same name (the result's
      // is on another page): said as a new one, where it would be, and the result's page to name instead.
      const away = on && on !== t.dest.page.node ? on : null;
      const where = inSection ? " is in section '" + inSection.name + "'" + (away ? " on page '" + away.name + "'" : "") : " is not in a section";
      const named = s.node ? ", not '" + s.name + "'" : ", but `section` '" + s.name + "' would be a new section on " + (t.dest.page.current ? "the current page '" : "page '") + t.dest.page.name + "'";
      // The other way there, when the op asks for a section to make: the result's page, and its section unless the op
      // names that already (naming the page alone would still ask for a section it does not have). The result on another
      // page means `page` was left out (one naming another page than the result's is refused above).
      // By name only when each name it would send matches the result's alone (on its page, and in the file), and its
      // section's name is not one that looks like an id (a link's 77-7: the wire refuses it with `createSection`, as a
      // name to make); else by its section's id, which names its page too (and is never a name to make: sent with no
      // `createSection`).
      const same = !!inSection && s.name === inSection.name;
      const page = !s.node && inSection
        ? idLike(inSection.name) || !(on && onlyOne(inSection.name, on.findAllWithCriteria({ types: ["SECTION"] }), inSection) && (!away || onlyOne(away.name, figma.root.children, away)))
          ? ", or name its section by its id: `section: '" + inSection.id + "'`" + (op.createSection === true ? " with no `createSection`" : "")
          : away
            ? same ? ", or name its page: `page: '" + away.name + "'`" : ", or name its section and its page: `section: '" + inSection.name + "', page: '" + away.name + "'`"
            : same ? "" : ", or name its section: `section: '" + inSection.name + "'`"
        : "";
      bad(what + ": its result " + label(root) + where + named + "; an update stays where the result is — " + leaveOut(op, ["section", "createSection"]) + page);
      continue;
    }
    const old = readOld(root, key);
    if (!old) { bad(what + ": the spec stored on its result " + label(root) + " cannot be read; " + (comp ? "give the component another name to build it again" : "give the spec another key to build it again")); continue; }
    const plan = planUpdate(old, t.spec);
    const before = problems.length;
    for (const b of plan.builds) {
      if (!b.replaces) continue;
      const f = foreignIn(b.replaces, key);
      if (f) bad(b.path + ": " + label(b.replaces) + " is built anew (its type, component, font or a dropped property changed), but it holds " + label(f) + ", which this key did not build; move that layer out first");
    }
    for (const r of plan.removals) {
      const f = foreignIn(r, key);
      if (f) bad(what + ": " + label(r) + " is no longer in the spec, but it holds " + label(f) + ", which this " + (comp ? "component's spec" : "key") + " did not build; move that layer out, or keep the node in the spec");
    }
    // A component: its definitions and its layers' wiring planned first, so a patch never writes a field that stays bound
    // to a property (its text or visibility follows the property's default instead; Figma refuses the write).
    const owner = root;
    const defs = comp && owner.type !== "FRAME" ? planDefs(owner, t.spec, t.refs, bad) : null;
    if (defs) {
      defs.wiring = planWiring(defs, plan.kept);
      const bound = new Map(defs.wiring.map((w) => [w.ref, w.stays] as const));
      for (const u of plan.updates) {
        const stays = bound.get(u.ref);
        if (!u.set || !stays) continue;
        if (stays.indexOf("characters") >= 0) delete u.set.text;
        if (stays.indexOf("visible") >= 0) delete u.set.hidden;
        if (!Object.keys(u.set).length) u.set = null;
      }
      // Each text is held across the earlier texts' font loads and its own (node-lookup.ts): gone, it is missing, never read.
      for (const n of textsFollowing(defs)) {
        if (goneFrom(n, bad, "node", what + ": ")) continue;
        const fonts = n.fontName === figma.mixed ? n.getRangeAllFontNames(0, n.characters.length) : [n.fontName];
        for (const f of fonts) {
          const m = await loadFont(f);
          if (goneFrom(n, bad, "node", what + ": ")) break;
          if (m) bad(what + ": " + label(n) + " follows a property whose default changes, and its " + m);
        }
      }
    }
    const patches = new Map<number, PatchTarget>();
    for (const [i, u] of plan.updates.entries()) {
      if (!u.set) continue;
      // Held across the earlier patches' awaits (their fonts): gone by now, it is missing, and its name is never read.
      if (goneFrom(u.ref, bad, "node", u.path + ": ")) continue;
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
    if (problems.length === before) t.update = { key, root, plan, patches, ...(comp && defs ? { component: { name: comp.name, defs } } : {}) };
  }
  return { problems };
}

/** Throws when a node an update is about to remove now holds a layer its key did not build (one an op of the same batch,
 *  or the designer, put there since the batch was checked): it is run on every removal before the first one. */
export function checkRemoval(u: KeyedUpdate, n: SceneNode): void {
  if (!inDocument(n)) return; // gone already: nothing of it is removed (writes.ts), and it is never read
  const f = foreignIn(n, u.key);
  if (f) throw new Error(label(n) + " is to be removed (the spec with key '" + u.key + "' no longer has it), but it now holds " + label(f) + ", which that key did not build; nothing was removed");
}

/** The ids of every node of the file an update changes, builds in or reorders (its root included). */
export function touchedBy(u: KeyedUpdate): Set<string> {
  const out = new Set<string>([u.root.id]);
  for (const x of u.plan.updates) out.add(x.ref.id);
  for (const b of u.plan.builds) out.add(b.parent.id);
  for (const o of u.plan.orders) out.add(o.parent.id);
  for (const st of u.plan.stamps) out.add(st.ref.id);
  for (const h of u.plan.handles) out.add(h.ref.id);
  return out;
}

/** The ids of the existing layers a planned update changes, for the review's count (docs/write-plane-spec.md decision
 *  18): every kept node whose fields change, every kept node that changes place among its frame's spec children, and
 *  every node it removes (dropped, or built anew) with what this key built below it. Not the root when only its children
 *  change, nor a frame that only gains a child, nor a stored spec (plugin data). The session's own are left in: the
 *  count leaves them out. */
export function changedBy(plan: Plan<SceneNode>, key: string): string[] {
  const out: string[] = [];
  for (const u of plan.updates) out.push(u.ref.id);
  for (const o of plan.orders) {
    // The kept children's order now and in the new spec: one that moves among them is moved.
    const kept: SceneNode[] = [];
    for (const e of o.order) if ("ref" in e) kept.push(e.ref);
    const now = (o.parent as FrameNode).children.filter((c) => kept.indexOf(c) >= 0);
    kept.forEach((n, i) => { if (now[i] !== n) out.push(n.id); });
  }
  const gone = (x: SceneNode): void => {
    if (x.removed) return;
    if (x.getPluginData(KEY_DATA) === key) out.push(x.id);
    if (x.type !== "INSTANCE" && "children" in x) for (const c of x.children) gone(c);
  };
  for (const r of plan.removals) gone(r);
  for (const b of plan.builds) if (b.replaces) gone(b.replaces);
  return out;
}

/** The dry run's half for a keyed re-send (the `writeImpact` command): for each createTree whose key (or component
 *  name) the file has a result for, how many of the existing layers it would change — planned against the spec as sent,
 *  this session's own left out. Reads only. */
export async function keyedImpact(ops: readonly WriteOp[], own: (id: string) => boolean): Promise<WriteImpactStep[]> {
  const steps: WriteImpactStep[] = [];
  for (const [index, op] of ops.entries()) {
    if (op.op !== "createTree" || !isObj(op.tree)) continue;
    const comp = componentRootOf(op.tree);
    if (typeof op.tree.key !== "string" && !comp) continue;
    try {
      const checked = checkTree(op.tree);
      if (checked.problems.length || !checked.expanded) continue;
      const key = comp ? componentKey(comp.name) : String(op.tree.key);
      let root: FrameNode | ComponentNode | ComponentSetNode | null = null;
      if (comp) {
        const found = await existingComponent(comp.type, comp.name);
        if ("ours" in found && (await loadPageOf(found.ours))) root = found.ours;
      } else root = await findResult(key);
      if (!root) continue;
      const old = readOld(root, key);
      if (!old) continue;
      const ids = new Set<string>();
      for (const id of changedBy(planUpdate(old, checked.expanded), key)) if (!own(id)) ids.add(id);
      steps.push({ index, op: op.op, changedLayers: ids.size });
    } catch {
      // Not counted: the write itself reports what is wrong with it.
    }
  }
  return steps;
}

/** How many nodes of the result the removals take: the removed ones and what this key built below them, as the file
 *  is now (an instance is one node). */
export function removalCount(u: KeyedUpdate): number {
  let n = 0;
  const count = (x: SceneNode): void => {
    if (x.removed) return;
    if (x.getPluginData(KEY_DATA) === u.key) n++;
    if (x.type !== "INSTANCE" && "children" in x) for (const c of x.children) count(c);
  };
  // One out of the document already is not removed by the update (writes.ts), so it is not counted.
  for (const x of removalsOf(u)) if (inDocument(x)) count(x);
  return n;
}

/** The nodes an update removes once its batch has landed: the ones the new spec dropped, and the ones built anew. */
export function removalsOf(u: KeyedUpdate): SceneNode[] {
  const out = u.plan.removals.slice();
  for (const b of u.plan.builds) if (b.replaces) out.push(b.replaces);
  return out;
}

const ALIGN_SELF = { min: "MIN", center: "CENTER", max: "MAX", stretch: "STRETCH" } as const;
const LIMITS = ["minWidth", "maxWidth", "minHeight", "maxHeight"] as const;
/** The direct fields that place a node in its parent's flow: set before its patch (a `fill` needs the node back in the
 *  flow first). The rest after it (they can need the auto-layout the patch turns on). */
export const PLACE_FIELDS: readonly ExtraField[] = ["absolute", "grow", "alignSelf"];
const AFTER_FIELDS: readonly ExtraField[] = ["clip", "sizeLimits", "strokesInLayout", "x", "y"];

/** The variable a number field of `n` is bound to (its id), or null. */
function boundTo(n: SceneNode, k: string): string | null {
  const bv: unknown = "boundVariables" in n ? n.boundVariables : undefined;
  const a: unknown = isObj(bv) ? bv[k] : undefined;
  return isObj(a) && typeof a.id === "string" ? a.id : null;
}

/**
 * Set the direct fields `fields` (those of `only`) of a kept node from its new spec. Its Change is on `changes` before
 * the first field is set, so one that throws partway is put back with the batch. A size limit is set raw, then bound
 * again to the variable the new spec names (`variables`: the batch's resolved ones); its restore binds back the ones it
 * had.
 */
function applyExtras(n: SceneNode, s: TreeNodeSpec, fields: readonly ExtraField[], only: readonly ExtraField[], variables: ReadonlyMap<string, Variable>, changes: Change[]): void {
  const todo = only.filter((f) => fields.indexOf(f) >= 0);
  if (!todo.length) return;
  const kept: Array<[string, unknown]> = [];
  const limits = todo.indexOf("sizeLimits") >= 0;
  const bound: Array<[(typeof LIMITS)[number], string | null]> = limits ? LIMITS.map((k) => [k, boundTo(n, k)]) : [];
  // A limit can grow or shrink the node: its size and how it is decided are put back after the limits.
  const size = limits ? { w: n.width, h: n.height, sizing: (["layoutSizingHorizontal", "layoutSizingVertical"] as const).map((k) => [k, k in n ? Reflect.get(n, k) : undefined] as const) } : null;
  changes.push({
    applied: { id: n.id },
    kind: "updated node",
    what: "the place, clipping or size limits of " + label(n),
    on: n,
    async restore(allowed) {
      for (const [k, v] of kept.slice().reverse()) Reflect.set(n, k, v);
      if (size) {
        if ((n.width !== size.w || n.height !== size.h) && "resize" in n) n.resize(size.w, size.h);
        for (const [k, v] of size.sizing) if (v !== undefined && Reflect.get(n, k) !== v) Reflect.set(n, k, v);
      }
      // Each variable looked up is an await: the node removed meanwhile has nothing left to bind back, and its fields
      // throw (node-lookup.ts stillToRestore: the batch's put-back says the change went with it).
      for (const [k, id] of bound) {
        if (boundTo(n, k) === id) continue;
        const v = id ? await figma.variables.getVariableByIdAsync(id) : null;
        stillToRestore(n);
        if (id && !allowed()) throw new RestoreStopped("'Allow edits' was turned off");
        n.setBoundVariable(k, v);
      }
    },
  });
  const put = (k: string, v: unknown): void => {
    if (!(k in n)) return;
    const was: unknown = Reflect.get(n, k);
    if (was === v) return;
    // Recorded once it is set: a setter that throws changed nothing to put back.
    if (!Reflect.set(n, k, v)) throw new Error("cannot set " + k);
    kept.push([k, was]);
  };
  const parent = n.parent;
  const onPage = !parent || parent.type === "PAGE";
  const inFlex = !!parent && "layoutMode" in parent && parent.layoutMode !== "NONE";
  for (const f of todo) {
    // The place in an auto-layout flow means nothing outside one (and Figma refuses some of it there).
    if (f === "absolute" && inFlex) put("layoutPositioning", s.absolute === true ? "ABSOLUTE" : "AUTO");
    else if (f === "grow" && inFlex) put("layoutGrow", s.grow !== undefined ? s.grow : 0);
    else if (f === "alignSelf" && inFlex) put("layoutAlign", s.alignSelf !== undefined ? ALIGN_SELF[s.alignSelf] : "INHERIT");
    else if (f === "clip") put("clipsContent", s.clip === true);
    else if (f === "sizeLimits") {
      for (const k of LIMITS) put(k, s.sizeLimits && s.sizeLimits[k] !== undefined ? s.sizeLimits[k] : null);
      // A raw limit unbinds its variable: the ones the new spec names are bound again.
      for (const k of LIMITS) {
        const ref = s.tokens && s.tokens[k];
        const v = ref !== undefined ? variables.get(ref) : undefined;
        if (v && boundTo(n, k) !== v.id) n.setBoundVariable(k, v);
      }
    } else if (f === "strokesInLayout") put("strokesIncludedInLayout", s.strokesInLayout === true);
    else if ((f === "x" || f === "y") && s[f] !== undefined && (onPage || !inFlex || s.absolute === true)) put(f, s[f]);
  }
}

/** Whether `n` is one of `parent`'s children now. A removed node is no one's (and Figma throws on reading any field of
 *  it but `id`, `removed` and `type`, its `parent` included: so `removed` is read first). */
const childOf = (n: SceneNode, parent: BaseNode): boolean => !n.removed && n.parent === parent;

/** Put `parent`'s children in `want` order (each a child of it), node by node from the first place. */
function arrange(parent: FrameNode, want: readonly SceneNode[]): void {
  for (const [i, n] of want.entries()) {
    if (!childOf(n, parent)) continue;
    if (parent.children[i] !== n) parent.insertChild(i, n);
  }
}

/** Put a frame's spec children in the new order; the designer's own layers keep their places. Its Change is on `changes`
 *  before the first move: a move Figma refuses partway puts back the ones before it here, so the op leaves nothing (as a
 *  patch does); one that cannot be put back stays on the list, and the batch reports it. Synchronous, its put-back too:
 *  it never awaits, so nothing the update holds can change between one order and the next (node-lookup.ts). */
function applyOrder(o: ChildOrder<SceneNode>, built: readonly SceneNode[], replaced: ReadonlyArray<SceneNode | null>, allowed: () => boolean, changes: Change[]): void {
  const parent = o.parent as FrameNode;
  const was = parent.children.slice(); // a copy: Figma's array is frozen, and live
  const nodes: SceneNode[] = [];
  const olds: SceneNode[] = [];
  for (const e of o.order) {
    const n = "ref" in e ? e.ref : built[e.build];
    if (n && childOf(n, parent)) nodes.push(n);
    const r = "build" in e ? replaced[e.build] : null;
    if (r && childOf(r, parent)) olds.push(r);
  }
  // The slots the spec's children hold now (built ones were appended last; a node built anew still has its old one
  // beside it) take them in spec order, then the old ones about to be removed: so a node built anew takes the place
  // of the one it replaces, and the designer's own layers keep theirs.
  const seq = nodes.concat(olds);
  const slots = was.map((c, i) => (seq.indexOf(c) >= 0 ? i : -1)).filter((i) => i >= 0);
  const want = was.slice();
  slots.forEach((slot, k) => { const n = seq[k]; if (n) want[slot] = n; });
  const putBack = (): void => { arrange(parent, was.filter((c) => childOf(c, parent))); };
  const change: Change = {
    applied: { id: parent.id },
    kind: "reordered frame",
    what: "the order of the layers in " + label(parent),
    on: parent,
    restore: putBack,
  };
  changes.push(change);
  try {
    arrange(parent, want);
  } catch (e) {
    if (allowed()) {
      try { putBack(); changes.splice(changes.indexOf(change), 1); } catch { /* the batch's restore tries again and reports it */ }
    }
    throw e;
  }
}

/** Store the new own spec on every kept node whose spec changed; its Change (on `changes` first) puts the old back. */
function restamp(stamps: Plan<SceneNode>["stamps"], key: string, changes: Change[]): void {
  const was = stamps.map((s) => [s.ref, s.ref.getPluginData(SPEC_DATA)] as const);
  changes.push({
    applied: {},
    kind: "stored spec",
    what: "the spec stored on " + stamps.length + " node(s)",
    // A node deleted since took its stored spec with it: nothing to put back on it (its fields throw when read).
    restore() { for (const [n, v] of was) if (!n.removed) n.setPluginData(SPEC_DATA, v); },
  });
  for (const s of stamps) stampNode(s.ref, key, s.spec);
}

/**
 * Apply a planned update: every change it makes goes onto `changes` as it lands, so the batch can put all of it back.
 * `consent` is checked before each step and after each await. The nodes to remove are left to the batch (removalsOf).
 * Every node the plan holds was resolved before the batch ran, and each step can await (a patch's fonts, a text style
 * set): so each step checks the node it uses is still in the document before it reads it (node-lookup.ts), and one
 * deleted or detached by then fails the op as missing, and the batch is put back.
 */
export async function applyUpdate(t: TreeTarget, u: KeyedUpdate, consent: () => void, allowed: () => boolean, changes: Change[]): Promise<AppliedWrite> {
  const { plan, key } = u;
  const changed: NonNullable<AppliedWrite["changed"]> = [];
  // A component: every reference that goes away is unwired before the patches (so they can write those fields).
  const unwired = u.component ? unwireGoing(u.component.defs, consent, changes) : [];
  for (const [i, up] of plan.updates.entries()) {
    const p = u.patches.get(i);
    stillInDocument(up.ref);
    if (up.extras.length) { consent(); applyExtras(up.ref, up.spec, up.extras, PLACE_FIELDS, t.refs.variables, changes); }
    if (p) { consent(); await applyPatch(p, consent, allowed, changes); }
    if (up.extras.length) { stillInDocument(up.ref); consent(); applyExtras(up.ref, up.spec, up.extras, AFTER_FIELDS, t.refs.variables, changes); }
    changed.push({ id: up.ref.id, ...(up.spec.handle !== undefined ? { handle: up.spec.handle } : {}), fields: up.fields });
  }
  const made = newMade(t.refs, t.clones);
  const built: SceneNode[] = [];
  for (const b of plan.builds) {
    consent();
    const from = madeFrom(made);
    const n = await buildSubtree(b.spec, b.parent as FrameNode | ComponentNode | ComponentSetNode, made, consent, changes);
    // On the list before it is stamped: a stamp that throws removes it with the batch. Every node it made goes back, not
    // only its top one: a layer the designer moved out of it since is the batch's too (tree.ts discard).
    const mine = madeNodes(made, from);
    const owns = [n, ...mine];
    changes.push({ applied: { id: n.id }, kind: "created node", what: "the new node " + label(n), on: n, made: true, owns, restore(_allowed, ours) { takeBack(owns, ours); } });
    stampAll(made, key, from.pairs);
    built.push(n);
  }
  // The builds were the op's last awaits (a reorder never awaits, nor does its put-back): every node it holds is checked once
  // here, before the reorders, the stamps, the component's wiring and the reply: each node of the result it keeps (the
  // result itself, the nodes it changed, reorders or restamps among them) and every node it just built, each subtree's
  // layers included (a later subtree's style await comes after an earlier one's). One deleted or
  // detached at an earlier op's await or at one of its own fails the op as missing: never silently left out of a
  // reorder, nor reported as changed or built.
  for (const k of plan.kept) stillInDocument(k.ref);
  checkMade(made);
  const replaced = plan.builds.map((b) => b.replaces);
  for (const o of plan.orders) { consent(); applyOrder(o, built, replaced, allowed, changes); }
  if (plan.stamps.length) {
    consent();
    restamp(plan.stamps, key, changes);
  }
  // A component: its new variants laid out in the set, its definitions and its layers' wiring brought to the spec.
  let props = new Map<string, string>();
  let rewired = 0;
  if (u.component) {
    const root = u.root;
    if (root.type === "COMPONENT_SET" && built.length) {
      consent();
      const size = { w: root.width, h: root.height };
      const at = root.children.map((c) => [c, c.x, c.y] as const);
      const sizing = root.layoutMode !== "NONE" ? { h: root.layoutSizingHorizontal, v: root.layoutSizingVertical } : null;
      changes.push({ applied: { id: root.id }, kind: "arranged set", what: "the variants' places in " + label(root), on: root, restore() {
        for (const [c, x, y] of at) if (!c.removed) { c.x = x; c.y = y; }
        // resize first: it makes both axes fixed, so the sizing modes are put back after it
        if (root.width !== size.w || root.height !== size.h) root.resize(size.w, size.h);
        if (sizing) { root.layoutSizingHorizontal = sizing.h; root.layoutSizingVertical = sizing.v; }
      } });
      arrangeVariants(root, t.spec, built.filter((n): n is ComponentNode => n.type === "COMPONENT" && n.parent === root));
    }
    const synced = syncComponent(u.component.defs, unwired, made.pairs, consent, changes);
    props = synced.props;
    rewired = synced.rewired;
  }

  const applied: AppliedWrite = { id: u.root.id, key };
  if (changed.length) applied.changed = changed;
  if (plan.builds.length) applied.created = createdCount(made);
  // Counted again right before the removals run (writes.ts), after the rest of the batch: a later op may move a node out.
  const removed = removalCount(u);
  if (removed) applied.removed = removed;
  const reordered = plan.orders.filter((o) => o.order.every((e) => "ref" in e)).length;
  if (reordered) applied.reordered = reordered;
  const handles: Record<string, string> = {};
  for (const h of plan.handles) Object.defineProperty(handles, h.handle, { value: h.ref.id, enumerable: true, writable: true, configurable: true });
  for (const [h, id] of made.handles) Object.defineProperty(handles, h, { value: id, enumerable: true, writable: true, configurable: true });
  if (Object.keys(handles).length) applied.handles = handles;
  const dropped = u.component ? u.component.defs.remove.length : 0;
  if (u.component) componentReply(applied, u.component.name, props, rewired);
  if (dropped && u.component) applied.propsRemoved = u.component.defs.remove.map((r) => r.name);
  if (!changed.length && !plan.builds.length && !removed && !plan.orders.length && !applied.handles && !props.size && !rewired && !dropped) applied.unchanged = true;
  return applied;
}
