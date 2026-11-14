// Copies (createTree `clone`): a spec node that copies an existing node, with only its differences (docs/write-plane-spec.md
// decisions 6, 14, 15, 17).
//
// A copy's spec names its source by id, gives the copy's own differences as patch fields, and its layers' differences
// as `edits` (a layer of the source — its exact name, unique in the source, or its id — → a patch). The spec has been
// checked whole already (bridge/src/tree-spec.ts checkTreeWith, its patches by patch-spec.ts checkPatch). What only the
// file can answer is answered here, before the first op of the batch runs (resolveClones): the source exists and can be
// copied (a layer, not a page or a main component; a frame when the copy is the root), every edit names exactly one
// layer of it, and each patch fits the layer it names (patch.ts resolvePatchNode: a text for `text`, its fonts load, its
// names resolve). Every problem of every copy is listed in one refusal, with the rest of the batch.
//
// Building, a copy is made where the tree's other nodes are (tree.ts): Figma's clone() duplicates the source with every
// layer and value, it is put in its parent, and the edits are mapped onto the copy's layers by their place in the
// source (the copy's layers have new ids). Its patches are set once every node of the tree is made, each checked right
// then against the copy where it now is (patch.ts patchCopy). Any throw on the way removes the tree's root, the copy
// with it, so a copy lands whole with the rest of its tree or leaves no trace; the source is never changed.
//
// Plugin API facts this leans on (@figma/plugin-typings):
//   * SceneNode.clone() duplicates the node "parented under figma.currentPage"; nested main components are cloned as
//     instances of the original. A copy has the source's plugin data, so the keyed stamps a source carries are cleared.
//   * Under documentAccess "dynamic-page" a node on another page is read only once that page is loaded (loadAsync).
import { cloneEdits, clonePatch } from "../../bridge/src/tree-check.ts";
import { nearestNames, quoteList } from "../../bridge/src/name-match.ts";
import { nodeKind, type TreeNodeSpec } from "../../bridge/src/tree-spec.ts";
import type { PatchSet } from "../../bridge/src/patch-spec.ts";
import { KEY_DATA, SPEC_DATA } from "./keyed-store";
import { resolvePatchNode, type PatchTarget } from "./patch";
import { patchUses, type Use } from "./tree-refs";

/** A copy whose source and edits resolved. */
export interface CloneTarget {
  source: SceneNode;
  /** the patch of the copy itself, resolved against the source (null when the spec patches only its layers) */
  self: PatchTarget | null;
  /** each edit's patch, resolved against the layer of the source it names */
  edits: PatchTarget[];
}
/** A patch to set on a layer of a copy once the tree is made. */
export interface CopyPatch { target: PatchTarget; node: SceneNode }

const label = (n: BaseNode): string => "'" + n.name + "' (" + n.id + ")";
/** What reads as an id (`12:34`, a layer inside an instance `I12:3;4:5`) rather than a layer name. */
const NODE_ID = /^I?[^\s:]+:[^\s]+$/;

/** Every layer below `n` (the instances' own layers included), in document order. */
function layersBelow(n: SceneNode, out: SceneNode[]): SceneNode[] {
  if (!("children" in n)) return out;
  for (const c of n.children) { out.push(c); layersBelow(c, out); }
  return out;
}

/** The layer of `source` an edit names: its id, else its exact name, which must be unique below the source. */
function findLayer(source: SceneNode, ref: string): { ok: SceneNode } | { error: string } {
  const all = layersBelow(source, []);
  // An id names one layer outright; anything else is a name, which must be unique below the source.
  const byId = all.find((n) => n.id === ref);
  if (byId) return { ok: byId };
  const hits = all.filter((n) => n.name === ref);
  if (!hits.length && NODE_ID.test(ref)) return { error: "'" + ref + "' is not the id or the name of a layer of " + label(source) };
  const first = hits[0];
  if (hits.length === 1 && first) return { ok: first };
  if (hits.length > 1) return { error: "matches " + hits.length + " layers of " + label(source) + "; name one by its id: " + hits.slice(0, 3).map(label).join(", ") };
  const near = nearestNames(ref, all.map((n) => n.name));
  return { error: "no layer of " + label(source) + " is named '" + ref + "'" + (near.length ? "; closest: " + quoteList(near) : "") };
}

/** The page `n` is on (null when it is on none). */
function pageOf(n: BaseNode): PageNode | null {
  let p: BaseNode | null = n.parent;
  while (p && p.type !== "PAGE") p = p.parent;
  return p && p.type === "PAGE" ? p : null;
}

/** A patch problem from resolvePatchNode (`set.text: …`, or a sentence) under the copy's path. */
const under = (at: string, m: string): string => (m.indexOf("set.") === 0 ? at + m.slice(3) : at + ": " + m);

/** Every copy of a spec, with its path (`labels`: the path the agent wrote, for a node a fragment placed). */
export function copiesOf(s: TreeNodeSpec, path: string, labels: ReadonlyMap<object, string>, out: Array<{ s: TreeNodeSpec; path: string; root: boolean }>, root = true): Array<{ s: TreeNodeSpec; path: string; root: boolean }> {
  const lab = labels.get(s);
  const at = lab !== undefined ? lab : path;
  if (nodeKind(s) === "CLONE") out.push({ s, path: at, root });
  (s.children || []).forEach((c, i) => copiesOf(c, at + ".children[" + i + "]", labels, out, false));
  return out;
}

/** Every design-system name a copy's patches use (patch-spec.ts names, under the copy's path). */
export function cloneUses(index: number, s: TreeNodeSpec, path: string): Use[] {
  const out: Use[] = [];
  const add = (set: PatchSet, at: string): void => {
    for (const u of patchUses(index, set)) out.push({ ...u, op: "createTree", path: at + u.path.slice(3) });
  };
  const self = clonePatch(s);
  if (self) add(self, path);
  for (const [k, set] of cloneEdits(s)) add(set, path + ".edits[" + JSON.stringify(k) + "]");
  return out;
}

/**
 * Resolve the copies of one createTree op: each source, each edit's layer, each patch against what it changes. Every
 * problem goes to `bad`. `fontsLater`: an earlier op of the batch edits a variable, so a text's fonts are loaded when
 * its patch applies. The targets' `refs` are empty: the caller fills them from its resolution of the spec's names.
 */
export async function resolveClones(copies: ReadonlyArray<{ s: TreeNodeSpec; path: string; root: boolean }>, loadFont: (f: FontName) => Promise<string | null>, bad: (message: string) => void, fontsLater: boolean): Promise<Map<TreeNodeSpec, CloneTarget>> {
  const out = new Map<TreeNodeSpec, CloneTarget>();
  for (const { s, path, root } of copies) {
    const id = s.clone;
    if (id === undefined) continue;
    const at = path + ".clone";
    const nd = await figma.getNodeByIdAsync(id);
    if (!nd) { bad(at + ": no node with id '" + id + "' (invalid or removed)"); continue; }
    if (nd.type === "DOCUMENT" || nd.type === "PAGE") { bad(at + ": " + label(nd) + " is a " + nd.type + "; a copy is of a layer on a page"); continue; }
    if (nd.type === "COMPONENT" || nd.type === "COMPONENT_SET") { bad(at + ": " + label(nd) + " is a main component; place an instance of it (`component`) instead of a copy of it"); continue; }
    if (root && nd.type !== "FRAME") { bad(at + ": the root copy is a screen, so its source must be a FRAME; " + label(nd) + " is a " + nd.type + " — put the copy in a frame"); continue; }
    const page = pageOf(nd);
    if (page) await page.loadAsync(); // dynamic-page: before the source's layers are read
    const before = { n: 0 };
    const say = (m: string): void => { before.n++; bad(m); };
    // `later`: the checks that read the file as it is now (auto-layout, the parent's) are run against the copy, in its
    // place, right before its patch is set (patchCopy): the copy's parent is not the source's.
    const self = clonePatch(s);
    const selfTarget = self ? await resolvePatchNode(nd, self, true, loadFont, (m) => say(under(path, m)), fontsLater) : null;
    const edits: PatchTarget[] = [];
    const named = new Map<string, string>();
    for (const [ref, set] of cloneEdits(s)) {
      const where = path + ".edits[" + JSON.stringify(ref) + "]";
      const layer = findLayer(nd, ref);
      if ("error" in layer) { say(where + ": " + layer.error); continue; }
      const twice = named.get(layer.ok.id);
      if (twice !== undefined) { say(where + ": names " + label(layer.ok) + ", which the edit '" + twice + "' names too; give its fields in one edit"); continue; }
      named.set(layer.ok.id, ref);
      const t = await resolvePatchNode(layer.ok, set, true, loadFont, (m) => say(under(where, m)), fontsLater);
      if (t) edits.push(t);
    }
    if (before.n) continue;
    out.set(s, { source: nd, self: selfTarget, edits });
  }
  return out;
}

/** Where `layer` is below `root`: the index at each level, root first (null when it is not below it). */
function placeIn(root: BaseNode, layer: BaseNode): number[] | null {
  const path: number[] = [];
  let n: BaseNode = layer;
  while (n !== root) {
    const p: BaseNode | null = n.parent;
    if (!p || !("children" in p)) return null;
    const child = n;
    path.unshift(p.children.findIndex((c) => c === child));
    n = p;
  }
  return path;
}
/** The layer at `path` below `root`. */
function at(root: SceneNode, path: readonly number[]): SceneNode | null {
  let n: SceneNode = root;
  for (const i of path) {
    if (!("children" in n)) return null;
    const c: SceneNode | undefined = n.children[i];
    if (!c) return null;
    n = c;
  }
  return n;
}

/** This plugin's keyed stamps on `n` and every layer below it (not an instance's own layers), cleared: a copy is not
 *  part of the result its source belongs to. With `key`, each layer is marked as that key's instead (no spec of its
 *  own: the copy's spec, on the copy, is what a re-send compares). */
export function restamp(n: SceneNode, key: string | null, self: boolean): void {
  if (!self) {
    n.setPluginData(KEY_DATA, key === null ? "" : key);
    n.setPluginData(SPEC_DATA, "");
  }
  if (n.type === "INSTANCE" || !("children" in n)) return;
  for (const c of n.children) restamp(c, key, false);
}

/**
 * Make the copy a resolved spec node names: its source cloned, its keyed stamps cleared, and its patches (its own, then
 * each edit's, mapped onto the copy's layer by place) queued on `patches` for once the tree is made. The copy is on
 * the current page until its caller puts it in its parent. Throws when the source no longer holds an edit's layer.
 */
export function makeCopy(r: CloneTarget, patches: CopyPatch[]): SceneNode {
  const places: Array<{ target: PatchTarget; path: number[] }> = [];
  for (const e of r.edits) {
    const p = placeIn(r.source, e.node);
    if (!p) throw new Error(label(e.node) + " is no longer inside " + label(r.source) + ", so its edit cannot be made on the copy");
    places.push({ target: e, path: p });
  }
  const copy = r.source.clone();
  copy.setPluginData(KEY_DATA, "");
  copy.setPluginData(SPEC_DATA, "");
  restamp(copy, null, true);
  if (r.self) patches.push({ target: r.self, node: copy });
  for (const { target, path } of places) {
    const n = at(copy, path);
    if (!n) { copy.remove(); throw new Error("the copy of " + label(r.source) + " has no layer where " + label(target.node) + " is"); }
    patches.push({ target, node: n });
  }
  return copy;
}
