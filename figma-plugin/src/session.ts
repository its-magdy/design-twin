// The nodes this plugin session created (docs/write-plane-spec.md decision 17: create anywhere, overwrite properties of
// existing nodes, delete and reparent only nodes created in the same session).
//
// A session is one run of the plugin: the set lives in the main thread's memory, so it starts empty each time the
// plugin window opens and nothing about it is written to the file. Every node a write creates is recorded with all
// the nodes below it (a createTree root and its frames, texts and instances); an instance's own sublayers belong to
// the instance and are not recorded. An id is recorded once its op has landed; a node a failed batch removes again
// is simply gone, so its id no longer resolves.

const created = new Set<string>();

/** Record `node` and every node below it (not inside an instance) as created this session. */
export function markCreated(node: BaseNode): void {
  created.add(node.id);
  if (node.type === "INSTANCE" || !("children" in node)) return;
  for (const c of node.children) markCreated(c);
}

/** `id` names a node this plugin session created. */
export function createdThisSession(id: string): boolean {
  return created.has(id);
}

/** The first node at or below `node` (not inside an instance) this session did not create, or null when it created
 *  them all — a delete takes everything below a node with it, so all of it must be the session's own. */
export function foreignBelow(node: BaseNode): BaseNode | null {
  if (!created.has(node.id)) return node;
  if (node.type === "INSTANCE" || !("children" in node)) return null;
  for (const c of node.children) {
    const f = foreignBelow(c);
    if (f) return f;
  }
  return null;
}
