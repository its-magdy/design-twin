// Variable modes on a node (writes: setVariableMode / clearVariableMode).
//
// A dark or brand version of a screen is the same nodes with a different mode for one collection, set on the
// screen's frame: every bound value below it follows, no per-node writes. This module resolves what a mode op
// names — the node, the collection, the mode — against the file BEFORE a batch runs, and applies a resolved op
// keeping what it replaced so writes.ts can put it back when a later op fails (docs/write-plane-spec.md 14, 15).
//
// Plugin API facts this leans on (@figma/plugin-typings, ExplicitVariableModesMixin):
//   * setExplicitVariableModeForCollection / clearExplicitVariableModeForCollection take the VariableCollection
//     OBJECT. The collection-id string overloads are deprecated and THROW under documentAccess "dynamic-page",
//     which this manifest declares.
//   * explicitVariableModes is keyed by collection id and holds only modes set on the node itself; a collection
//     missing from it is "inherited" (the node takes its parent's mode).
//   * A library collection is a VariableCollection only once the file has imported one of its variables
//     (figma.variables.importVariableByKeyAsync); figma.teamLibrary lists it as a LibraryVariableCollection with
//     a name and a key but no modes. Importing is itself a write that cannot be put back, and its modes are not
//     readable until it runs, so a library collection is refused by name here; one the file already uses is
//     reachable by its exact id (getVariableCollectionByIdAsync answers for it) and works like a local one.
import { INHERITED, type WriteOp } from "../../bridge/src/commands.ts";
import { matchByName, quoteList } from "../../bridge/src/name-match.ts";
import type { Change, OpProblem } from "./write-batch";

type ModeNode = BaseNode & ExplicitVariableModesMixin;

/** A mode op whose node, collection and mode all resolved. `modeId: null` clears the explicit mode. */
export interface ModeTarget {
  node: ModeNode;
  collection: VariableCollection;
  modeId: string | null;
}

const isModeOp = (op: WriteOp): boolean => op.op === "setVariableMode" || op.op === "clearVariableMode";

/** A collection, or why the name did not resolve. */
type Resolved<T> = { ok: T } | { error: string };

/**
 * Resolve every variable-mode op of a batch against the file. Every op is looked at, so the refusal lists every
 * bad name at once. The file's collections and the library list are read once per batch, and only when needed.
 */
export async function resolveModeOps(ops: readonly WriteOp[]): Promise<{ targets: Map<number, ModeTarget>; problems: OpProblem[] }> {
  const targets = new Map<number, ModeTarget>();
  const problems: OpProblem[] = [];
  let locals: VariableCollection[] | null = null;
  let library: LibraryVariableCollection[] | null = null;
  const localCollections = async (): Promise<VariableCollection[]> => {
    if (!locals) locals = await figma.variables.getLocalVariableCollectionsAsync();
    return locals;
  };
  const libraryCollections = async (): Promise<LibraryVariableCollection[]> => {
    if (library) return library;
    // Needs permissions:["teamlibrary"]; a plan without libraries throws. Either way: no library to name.
    try { library = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync(); } catch { library = []; }
    return library;
  };

  for (const [index, op] of ops.entries()) {
    if (!isModeOp(op)) continue;
    const bad = (message: string): void => { problems.push({ index, op: op.op, message }); };
    const nodeId = op.nodeId || "";
    const ref = op.collection || "";
    const nd = await figma.getNodeByIdAsync(nodeId);
    let node: ModeNode | null = null;
    if (!nd) bad("no node with id '" + nodeId + "' (invalid or removed)");
    else if (!("setExplicitVariableModeForCollection" in nd)) bad("node '" + nd.name + "' is a " + nd.type + ", which cannot carry a variable mode");
    else node = nd;

    const coll = await resolveCollection(ref, localCollections, libraryCollections);
    if ("error" in coll) { bad(coll.error); continue; }
    const collection = coll.ok;
    let modeId: string | null = null;
    if (op.op === "setVariableMode") {
      const mode = resolveMode(op.mode || "", collection);
      if ("error" in mode) { bad(mode.error); continue; }
      modeId = mode.ok;
    }
    if (node) targets.set(index, { node, collection, modeId });
  }
  return { targets, problems };
}

async function resolveCollection(
  ref: string,
  localCollections: () => Promise<VariableCollection[]>,
  libraryCollections: () => Promise<LibraryVariableCollection[]>,
): Promise<Resolved<VariableCollection>> {
  // An exact id names one collection: a local one, or a library one this file already uses.
  let byId: VariableCollection | null = null;
  try { byId = ref ? await figma.variables.getVariableCollectionByIdAsync(ref) : null; } catch { byId = null; }
  if (byId) return { ok: byId };
  const locals = await localCollections();
  const m = matchByName(ref, locals, (c) => c.name, (c) => [c.id, c.key]);
  if (m.kind === "one") return { ok: m.item };
  if (m.kind === "many") {
    return { error: "collection '" + ref + "' matches " + m.matches.length + " local collections — pass one's id: " + m.matches.slice(0, 3).map((c) => "'" + c.name + "' (" + c.id + ")").join(", ") };
  }
  const lib = (await libraryCollections()).filter((c) => c.name === ref || c.key === ref);
  if (lib.length) {
    const from = [...new Set(lib.map((c) => c.libraryName))];
    return { error: "collection '" + ref + "' is in the library " + quoteList(from) + ", and a library collection's mode can be set only once this file uses one of its variables (a write cannot import one yet) — use a local collection, or bind one of its variables in this file first" };
  }
  return { error: "collection '" + ref + "' matches no local variable collection" + (m.candidates.length ? "; closest: " + quoteList(m.candidates) : "; this file has none") };
}

function resolveMode(ref: string, collection: VariableCollection): Resolved<string> {
  const m = matchByName(ref, collection.modes, (md) => md.name, (md) => [md.modeId]);
  if (m.kind === "one") return { ok: m.item.modeId };
  if (m.kind === "many") {
    return { error: "mode '" + ref + "' appears " + m.matches.length + " times in collection '" + collection.name + "' — pass its modeId: " + m.matches.slice(0, 3).map((md) => "'" + md.name + "' (" + md.modeId + ")").join(", ") };
  }
  return { error: "mode '" + ref + "' is not in collection '" + collection.name + "'" + (m.candidates.length ? "; closest: " + quoteList(m.candidates) : "") };
}

/** A mode name for a reply: the mode's name in `collection`, INHERITED for none, the raw id if it is not there. */
function modeName(collection: VariableCollection, modeId: string | undefined | null): string {
  if (modeId === undefined || modeId === null) return INHERITED;
  const m = collection.modes.find((md) => md.modeId === modeId);
  return m ? m.name : modeId;
}

/** Apply a resolved mode op, keeping the mode it replaces. */
export function applyMode(t: ModeTarget): Change {
  const { node, collection, modeId } = t;
  const prev: string | undefined = (node.explicitVariableModes || {})[collection.id];
  if (modeId === null) node.clearExplicitVariableModeForCollection(collection);
  else node.setExplicitVariableModeForCollection(collection, modeId);
  return {
    applied: { id: node.id, collection: collection.name, from: modeName(collection, prev), to: modeName(collection, modeId) },
    kind: "variable mode change",
    what: "the '" + collection.name + "' mode on node " + node.id,
    restore() {
      if (prev === undefined) node.clearExplicitVariableModeForCollection(collection);
      else node.setExplicitVariableModeForCollection(collection, prev);
    },
  };
}
