// The write path's lookup by id (#206). getNodeByIdAsync resolves to null for an id the file does not have, but not
// always for a node the designer deleted: Figma keeps a deleted main component, soft-deleted (the typings: a component
// "could be … soft-deleted"), so its instances and an undo can bring it back, and its id still resolves to it — a node
// that is `removed`, on no page. A change to one lands nowhere anyone can see, and the reply would call it applied (seen
// live: a component deleted after a preview was put back, then Apply renamed it and said so). So every lookup a write
// makes goes through here, and a removed node is no node. The read plane (collect.ts, run.ts) keeps its own lookups.

/** The node with `id`, or null when the file has none: an invalid id, or a node that is removed. */
export async function nodeById(id: string): Promise<BaseNode | null> {
  const n = await figma.getNodeByIdAsync(id);
  return n && !n.removed ? n : null;
}
