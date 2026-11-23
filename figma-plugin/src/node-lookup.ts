// The write path's lookup by id (#206). getNodeByIdAsync resolves to null for an id the file does not have, but not
// always for a node the designer deleted. Figma keeps a deleted main component, soft-deleted, so its instances and an
// undo can bring it back, and its id still resolves to it. The typings say such a component "do[es] not always have a
// parent". `removed` alone does not catch it: seen live, a component deleted after a preview was put back still
// resolved after the delete, Apply changed it, and the reply called that applied, though the page no longer showed it.
// A change to a node like that lands nowhere anyone can see. So every lookup a write makes goes through here, and a
// node counts only when it is in the document: not `removed`, and its parent chain climbs to the document (a page's
// parent). A node with no parent, or one under a parent that is itself detached, is no node. The one exception is a
// library component (or one of its variants): Figma hands one back with no parent by design, it is a source to use
// (an instance of it), never a layer to change, and a write refuses changing it on its own. The read plane (collect.ts,
// run.ts) keeps its own lookups.
//
// A batch resolves every op before the first one runs, and holds the nodes it found; the file can change at any await
// after that (an image being made, a library import, a font load, an earlier op's own awaits). So a node held from
// before is checked again (stillInDocument) before the op reads it at all, and after each of its own awaits (holding):
// gone by then, the op fails with the error its lookup would have given, and the batch is put back as for any failed
// op. Before, not only right before the change: a removed node's handle reads only `id`, `removed` and `type` (seen
// live: `name` threw "in get_name: The node with id … does not exist"), so a read of anything else would fail the op
// with that instead of saying the node is missing.

/** The node with `id`, or null when the file has none: an invalid id, a node that is removed, or one that is detached
 *  from the document (no parent chain up to it), short of a library component. */
export async function nodeById(id: string): Promise<BaseNode | null> {
  const n = await figma.getNodeByIdAsync(id);
  return n && inDocument(n) ? n : null;
}

/** Whether `n` is in the document: not removed, and its parent chain ends at the document node. A library component
 *  (or a variant in a library set) counts too: it has no parent by design. Walks once up the chain; ES2019. */
export function inDocument(n: BaseNode): boolean {
  let top: BaseNode = n;
  for (;;) {
    if (top.removed) return false;
    const p: BaseNode | null = top.parent;
    if (!p) break;
    top = p;
  }
  if (top.type === "DOCUMENT") return true;
  return (top.type === "COMPONENT" || top.type === "COMPONENT_SET") && top.remote === true;
}

/** What a lookup by id that found nothing says: "no node with id '1:2' (invalid or removed)" (`what`: node, parent…). */
export function noNode(id: string, what = "node"): string {
  return "no " + what + " with id '" + id + "' (invalid or removed)";
}

/** A node a write resolved earlier and held across an await: throws noNode (after `prefix`) when it is no longer in the
 *  document. Called right before the change that uses it. */
export function stillInDocument(n: BaseNode, what = "node", prefix = ""): void {
  if (!inDocument(n)) throw new Error(prefix + noNode(n.id, what));
}

/** A node a batch's resolve (before any op runs) held across an await: when it is no longer in the document, `bad` gets
 *  the error its lookup would have given (after `prefix`) and true comes back, so the caller drops it without reading
 *  anything else of it. */
export function goneFrom(n: BaseNode, bad: (message: string) => void, what = "node", prefix = ""): boolean {
  if (inDocument(n)) return false;
  bad(prefix + noNode(n.id, what));
  return true;
}

/** goneFrom over every node of `nodes` a resolve holds (the layers a rule walked, the pages it loaded): the first one no
 *  longer in the document goes to `bad`, only it (one problem however many went with it), and true comes back. */
export function goneAmong(nodes: readonly BaseNode[], bad: (message: string) => void, what = "node", prefix = ""): boolean {
  for (const n of nodes) if (goneFrom(n, bad, what, prefix)) return true;
  return false;
}

/** Take back nodes a write made (a build's, a createText's): each one is removed, unless it or a node it is under is
 *  removed already (gone with it: there is nothing to take back, and its fields throw when read). One only detached (out
 *  of the document, not removed) is removed: it is the write's own. A remove() Figma refuses throws, for the caller. */
export function takeBack(nodes: readonly SceneNode[]): void {
  for (const n of nodes) if (!removedWith(n)) n.remove();
}
/** `n` or a node it is under is removed (`removed` read first at each step: a removed node's parent throws). Such a node
 *  took what a write set on it with it: its fields throw when read, and nothing of it is in the file to put back. One
 *  only detached (out of the document, not removed) still reads, and a put-back still puts it back. */
export function removedWith(n: BaseNode): boolean {
  for (let a: BaseNode | null = n; a; a = a.parent) if (a.removed) return true;
  return false;
}

/** For a put-back that awaits (a variable looked up to bind back, a text style set back): the node it puts back,
 *  checked after each of its awaits. Removed by then (removedWith), there is nothing left to put back on it and its
 *  fields throw: it throws noNode, and the batch's put-back (write-batch.ts restoreChanges) says the change went with the
 *  node, never that it stays. */
export function stillToRestore(n: BaseNode, what = "node"): void {
  if (removedWith(n)) throw new Error(noNode(n.id, what));
}

/** `consent` for a change that holds `n` across its awaits (a text style set, a patch's fonts): each call checks `n` is
 *  still in the document (stillInDocument), then consent. Every such change calls its consent after each await and
 *  before it reads or changes anything again, so a node deleted or detached during one is never read (a removed node's
 *  fields throw) nor changed: the op fails as its lookup would have, and the batch is put back. */
export function holding(n: BaseNode, consent: () => void, what = "node", prefix = ""): () => void {
  return () => {
    stillInDocument(n, what, prefix);
    consent();
  };
}
