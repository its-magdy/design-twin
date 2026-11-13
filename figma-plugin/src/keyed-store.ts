// What a keyed tree spec leaves in the file (docs/write-plane-spec.md decision 11), as plugin data — this plugin's own,
// which no other plugin reads and which travels with the file:
//   * on every node the spec built: the key (KEY_DATA) and the node's own spec fields as applied (SPEC_DATA, JSON, no
//     children), so the spec sent last time can be read back off the nodes (keyed.ts) whatever the designer did since;
//   * on the document: the root's id under the key (one entry per key), so the result is found without a search.
// Figma caps one entry at 100 kB; a node's own fields are far below it (the children are not in it).
import { ownSpec } from "../../bridge/src/tree-diff.ts";
import type { TreeNodeSpec } from "../../bridge/src/tree-spec.ts";

export const KEY_DATA = "dtwin.key";
export const SPEC_DATA = "dtwin.spec";
const indexEntry = (key: string): string => "dtwin.key:" + key;

/** Mark `n` as built by the spec with `key` from `spec` (its own fields). */
export function stampNode(n: BaseNode, key: string, spec: TreeNodeSpec): void {
  n.setPluginData(KEY_DATA, key);
  n.setPluginData(SPEC_DATA, JSON.stringify(ownSpec(spec)));
}
/** The id the document holds for `key` ("" when none). */
export function readIndex(key: string): string {
  return figma.root.getPluginData(indexEntry(key));
}
/** Record `id` as the result of `key` ("" removes the entry). */
export function writeIndex(key: string, id: string): void {
  figma.root.setPluginData(indexEntry(key), id);
}
