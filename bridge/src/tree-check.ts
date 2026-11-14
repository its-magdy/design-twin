// tree-check.ts — the one check of a createTree spec (tree-spec.ts checkTreeWith), with a copy's patches checked by
// patch-spec.ts checkPatch. Its own module because patch-spec.ts builds its rules from tree-spec.ts's when it loads:
// tree-spec.ts importing checkPatch back would make the two load in a cycle. Every reader of a spec imports these:
// figma_write's dry run and the wire check (commands.ts), and the plugin (figma-plugin/src/tree.ts).
//
// Pure: the plugin bundle imports it.
import { checkPatch, isPatchSet, type PatchSet } from "./patch-spec.ts";
import { checkTreeWith, type TreeCheck, type TreeNodeSpec } from "./tree-spec.ts";

/** Every problem with a spec (empty when it is valid), what a valid one makes, and the tree the plugin builds from it
 *  (its fragments placed and its row tables spread). */
export function checkTree(spec: unknown): TreeCheck {
  return checkTreeWith(spec, checkPatch);
}

/** `v` is a spec checkTree accepts. The plugin builds only a spec that passed this (and builds its `expanded` tree). */
export function isTreeSpec(v: unknown): v is TreeNodeSpec {
  return checkTree(v).problems.length === 0;
}

/** A copy's own fields that are not a patch of it: its source, its edits and its place in the parent. */
export const CLONE_PLACE_FIELDS: readonly string[] = ["clone", "edits", "handle", "key", "x", "y", "absolute", "grow", "alignSelf"];

/** The patch a copy's spec makes of the copy itself (every field but its source, edits and place), or null when it makes
 *  none. Only for a spec checkTree accepted: its fields passed checkPatch there. */
export function clonePatch(s: TreeNodeSpec): PatchSet | null {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) if (v !== undefined && CLONE_PLACE_FIELDS.indexOf(k) < 0) out[k] = v;
  return Object.keys(out).length && isPatchSet(out) ? out : null;
}

/** A copy's edits as patches, by the layer each names (only for a spec checkTree accepted). */
export function cloneEdits(s: TreeNodeSpec): Array<[string, PatchSet]> {
  const out: Array<[string, PatchSet]> = [];
  for (const [k, v] of Object.entries(s.edits || {})) if (isPatchSet(v)) out.push([k, v]);
  return out;
}
