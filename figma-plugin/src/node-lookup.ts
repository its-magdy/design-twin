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
