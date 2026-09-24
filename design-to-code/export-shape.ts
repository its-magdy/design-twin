// export-shape.ts — the ONE answer to "which nodes does this screen document hold?"
//
// A screen reaches the design-to-code tools in three shapes, all written by this repo's own pull:
//   ScreenExport  a `--node`/`--selection` pull          { exportedAt, screen, nodes: [IrNode…], manifest, … }
//   LayerFile     a page-walk layer file                  { name, id, page, tree: IrNode, … }
//   IrNode        a bare node tree (a tree saved on its own, a catalog variant's node, a test fixture)
// Seven modules used to re-derive the roots with seven slightly different rules (one required `type &&
// id`, four took `id || type`, one took ANY object as a node, one refused bare trees). They all call
// screenRoots() now; `ScreenDoc` in types.ts is the union of the three shapes.
import { isJsonObject } from "./types.ts";
import type { IrNode, LayerFile, Manifest, ScreenDoc, ScreenExport } from "./types.ts";

/**
 * A serialized IR node: an object with a string `id` and a string `type`, and — when present — an
 * array `children`. `name` is not checked: the producer always writes it, and every reader already
 * tolerates a missing one (`n.name || …`). Children are not checked recursively; each walker guards
 * the entries it visits.
 */
export function isIrNode(x: unknown): x is IrNode {
  return isJsonObject(x) && typeof x.id === "string" && typeof x.type === "string" && (x.children === undefined || Array.isArray(x.children));
}

/** A `--node`/`--selection` pull: an object whose `nodes` is an array of nodes. */
export function isScreenExport(x: unknown): x is ScreenExport {
  return isJsonObject(x) && Array.isArray(x.nodes) && x.nodes.every(isIrNode);
}

/** A page-walk layer file: an object whose `tree` is a node (and which has no `nodes` array). */
export function isLayerFile(x: unknown): x is LayerFile {
  return isJsonObject(x) && !Array.isArray(x.nodes) && isIrNode(x.tree);
}

/** Any of the three screen shapes. */
export function isScreenDoc(x: unknown): x is ScreenDoc {
  return isScreenExport(x) || isLayerFile(x) || isIrNode(x);
}
isScreenDoc.expected = "a screen export: {nodes:[…]} whose every node has a string id and type, a layer file {tree: node}, or a bare node {id, type, …}";

/**
 * The root node(s) of a screen document, in document order: a ScreenExport's `nodes`, a LayerFile's
 * `tree`, or the bare node itself. Anything else — null, an array, an object of another kind, a
 * `nodes` array holding a non-node — has no roots.
 */
export function screenRoots(doc: unknown): IrNode[] {
  if (isScreenExport(doc)) return doc.nodes;
  if (isLayerFile(doc)) return [doc.tree];
  if (isIrNode(doc)) return [doc];
  return [];
}

/** The document-level fields a reader may want beside the roots (only a ScreenExport carries them). */
export function screenExportOf(doc: ScreenDoc | null | undefined): ScreenExport | null {
  return isScreenExport(doc) ? doc : null;
}

/** The pull's manifest (a ScreenExport's or a LayerFile's; a bare node carries none). */
export function manifestOf(doc: ScreenDoc | null | undefined): Manifest | undefined {
  return isScreenExport(doc) || isLayerFile(doc) ? doc.manifest : undefined;
}
