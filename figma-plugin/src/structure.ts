// Moving and deleting nodes (writes: move, delete) — only nodes this plugin session created (docs/write-plane-spec.md
// decision 17; session.ts keeps the list).
//
// Both are resolved before the batch runs, every problem listed: the node exists and this session created it (for a
// delete, everything below it too: a delete takes it all), the new parent exists, can hold children, is not inside an
// instance and is not the node itself or below it, and the index fits.
//
// A move is a Change: it keeps the parent, the place among its siblings and the x/y the node had, and a later op failing
// puts it back. A deleted node cannot be brought back through the Plugin API, so writes.ts runs the deletes last, once
// every other op of the batch has landed: a batch never needs to undo one.
//
// Plugin API facts this leans on (@figma/plugin-typings): insertChild(index, child) reparents (or reorders) a node;
// appendChild adds it last; a node inside an instance cannot take new children; under documentAccess "dynamic-page" a
// page must be loaded (loadAsync) before a node is appended to it.
import type { AppliedWrite, WriteOp } from "../../bridge/src/commands.ts";
import { createdThisSession, foreignBelow } from "./session";
import type { Change, OpProblem } from "./write-batch";

type Parent = PageNode | (SceneNode & ChildrenMixin);
export interface MoveTarget { node: SceneNode; parent: Parent; index: number | undefined }
export interface DeleteTarget { node: SceneNode }

const label = (n: BaseNode): string => "'" + n.name + "' (" + n.id + ")";
const NOT_OURS = "this plugin session did not create it; a write moves or deletes only nodes it created since the plugin window was opened";
/** Why a delete is refused when a node below the one named was not created this session. */
const holds = (node: BaseNode, foreign: BaseNode): string => "node " + label(node) + " holds " + label(foreign) + ", which this plugin session did not create; a delete takes everything below a node, and a write deletes only nodes it created since the plugin window was opened";

/** The instance `n` is part of (itself, or one above it), or null. */
function instanceAround(n: BaseNode): BaseNode | null {
  for (let p: BaseNode | null = n; p; p = p.parent) if (p.type === "INSTANCE") return p;
  return null;
}
/** `n` is `of` or below it. */
function within(n: BaseNode, of: BaseNode): boolean {
  for (let p: BaseNode | null = n; p; p = p.parent) if (p.id === of.id) return true;
  return false;
}

/** Resolve every move and delete op of a batch against the file and this session. */
export async function resolveStructureOps(ops: readonly WriteOp[]): Promise<{ moves: Map<number, MoveTarget>; deletes: Map<number, DeleteTarget>; problems: OpProblem[] }> {
  const moves = new Map<number, MoveTarget>();
  const deletes = new Map<number, DeleteTarget>();
  const problems: OpProblem[] = [];
  for (const [index, op] of ops.entries()) {
    if (op.op !== "move" && op.op !== "delete") continue;
    const bad = (message: string): void => { problems.push({ index, op: op.op, message }); };
    const nd = op.nodeId ? await figma.getNodeByIdAsync(op.nodeId) : null;
    if (!nd) { bad("no node with id '" + String(op.nodeId) + "' (invalid or removed)"); continue; }
    if (nd.type === "DOCUMENT" || nd.type === "PAGE") { bad(label(nd) + " is a " + nd.type + "; " + NOT_OURS); continue; }
    const node = nd;
    if (!createdThisSession(node.id)) { bad("node " + label(node) + ": " + NOT_OURS); continue; }
    if (op.op === "delete") {
      const foreign = foreignBelow(node);
      if (foreign) { bad(holds(node, foreign)); continue; }
      deletes.set(index, { node });
      continue;
    }
    const pd = op.parentId ? await figma.getNodeByIdAsync(op.parentId) : null;
    if (!pd) { bad("no parent with id '" + String(op.parentId) + "' (invalid or removed)"); continue; }
    if (pd.type === "DOCUMENT" || !("insertChild" in pd)) { bad("parent " + label(pd) + " is a " + pd.type + ", which cannot have children"); continue; }
    const inst = instanceAround(pd);
    if (inst) { bad("parent " + label(pd) + " is " + (inst === pd ? "an instance" : "inside the instance " + label(inst)) + ", which cannot take new children"); continue; }
    if (within(pd, node)) { bad("parent " + label(pd) + " is " + (pd.id === node.id ? "the node itself" : "inside the node") + "; a node cannot move into itself"); continue; }
    if (pd.type === "PAGE") await pd.loadAsync(); // dynamic-page: before its children are read or it is appended to
    const room = pd.children.length - (node.parent && node.parent.id === pd.id ? 1 : 0);
    if (op.index !== undefined && op.index > room) { bad("index " + op.index + " is past the end: " + label(pd) + " would have " + room + " other child" + (room === 1 ? "" : "ren") + " (0 is first; leave `index` out for last)"); continue; }
    moves.set(index, { node, parent: pd, index: op.index });
  }
  return { moves, deletes, problems };
}

/** Move a resolved node, keeping where it was. */
export function applyMove(t: MoveTarget): Change {
  const { node, parent } = t;
  const from = node.parent;
  if (!from || !("insertChild" in from)) throw new Error("node " + label(node) + " has no parent to move it from");
  const at = from.children.indexOf(node);
  const x = node.x, y = node.y;
  if (t.index === undefined) parent.appendChild(node);
  else parent.insertChild(t.index, node);
  const applied: AppliedWrite = { id: node.id, parentId: parent.id };
  return {
    applied,
    kind: "moved node",
    what: "the move of " + label(node),
    restore() {
      from.insertChild(Math.min(at, from.children.length - (node.parent && node.parent.id === from.id ? 1 : 0)), node);
      if (node.x !== x) node.x = x;
      if (node.y !== y) node.y = y;
    },
  };
}

/** Delete a resolved node (checked again: an op of this batch may have put a node below it). Cannot be undone. */
export function applyDelete(t: DeleteTarget): AppliedWrite {
  const foreign = foreignBelow(t.node);
  if (foreign) throw new Error(holds(t.node, foreign));
  const id = t.node.id;
  t.node.remove();
  return { id, deleted: true };
}

/** Every node id at or below `n` (an instance's sublayers included): what a delete of `n` takes with it. */
export function idsBelow(n: BaseNode, out: Set<string> = new Set()): Set<string> {
  out.add(n.id);
  if ("children" in n) for (const c of n.children) idsBelow(c, out);
  return out;
}
