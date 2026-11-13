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
/** What is wrong with moving `node` into `parent` at `index` in the file as it is now (null when nothing): the parent is
 *  not in an instance, not the node or below it, and the index fits its children. */
function placeProblem(node: SceneNode, parent: BaseNode & ChildrenMixin, index: number | undefined): string | null {
  const inst = instanceAround(parent);
  if (inst) return "parent " + label(parent) + " is " + (inst === parent ? "an instance" : "inside the instance " + label(inst)) + ", which cannot take new children";
  if (within(parent, node)) return "parent " + label(parent) + " is " + (parent.id === node.id ? "the node itself" : "inside the node") + "; a node cannot move into itself";
  const room = parent.children.length - (node.parent && node.parent.id === parent.id ? 1 : 0);
  if (index !== undefined && index > room) return "index " + index + " is past the end: " + label(parent) + " would have " + room + " other child" + (room === 1 ? "" : "ren") + " (0 is first; leave `index` out for last)";
  return null;
}

/**
 * Resolve every move and delete op of a batch against the file and this session. What can only change by an earlier
 * op of the same batch — where a node sits, what a parent holds, what a delete takes with it — is checked here when no
 * earlier op could have changed it (`changesBefore`), and otherwise right before the op runs (applyMove, the deletes'
 * own check in writes.ts), against the file as the earlier ops left it.
 */
export async function resolveStructureOps(ops: readonly WriteOp[], changesBefore: (index: number) => boolean): Promise<{ moves: Map<number, MoveTarget>; deletes: Map<number, DeleteTarget>; problems: OpProblem[] }> {
  const moves = new Map<number, MoveTarget>();
  const deletes = new Map<number, DeleteTarget>();
  const problems: OpProblem[] = [];
  // Deletes run after every other op, so any other op in the batch can change what a delete takes with it.
  const others = ops.some((o) => o.op !== "delete" && o.op !== "setVariableMode" && o.op !== "clearVariableMode");
  for (const [index, op] of ops.entries()) {
    if (op.op !== "move" && op.op !== "delete") continue;
    const bad = (message: string): void => { problems.push({ index, op: op.op, message }); };
    const nd = op.nodeId ? await figma.getNodeByIdAsync(op.nodeId) : null;
    if (!nd) { bad("no node with id '" + String(op.nodeId) + "' (invalid or removed)"); continue; }
    if (nd.type === "DOCUMENT" || nd.type === "PAGE") { bad(label(nd) + " is a " + nd.type + "; " + NOT_OURS); continue; }
    const node = nd;
    if (!createdThisSession(node.id)) { bad("node " + label(node) + ": " + NOT_OURS); continue; }
    if (op.op === "delete") {
      const foreign = others ? null : foreignBelow(node);
      if (foreign) { bad(holds(node, foreign)); continue; }
      deletes.set(index, { node });
      continue;
    }
    const pd = op.parentId ? await figma.getNodeByIdAsync(op.parentId) : null;
    if (!pd) { bad("no parent with id '" + String(op.parentId) + "' (invalid or removed)"); continue; }
    if (pd.type === "DOCUMENT" || !("insertChild" in pd)) { bad("parent " + label(pd) + " is a " + pd.type + ", which cannot have children"); continue; }
    if (pd.type === "PAGE") await pd.loadAsync(); // dynamic-page: before its children are read or it is appended to
    if (!changesBefore(index)) {
      const wrong = placeProblem(node, pd, op.index);
      if (wrong) { bad(wrong); continue; }
    }
    moves.set(index, { node, parent: pd, index: op.index });
  }
  return { moves, deletes, problems };
}

/** A delete's own check, right before the deletes run: nothing below the node is another's (an earlier op of the
 *  batch may have changed what is below it). Throws. */
export function checkDelete(t: DeleteTarget): void {
  const foreign = foreignBelow(t.node);
  if (foreign) throw new Error(holds(t.node, foreign));
}

/** Move a resolved node, keeping where it was. */
export function applyMove(t: MoveTarget): Change {
  const { node, parent } = t;
  const wrong = placeProblem(node, parent, t.index); // the file as the earlier ops of the batch left it
  if (wrong) throw new Error(wrong);
  const from = node.parent;
  if (!from || !("insertChild" in from)) throw new Error("node " + label(node) + " has no parent to move it from");
  const at = from.children.indexOf(node);
  const x = node.x, y = node.y, w = node.width, h = node.height;
  // How its size is decided (reparenting can change it: a FILL child leaving auto-layout becomes fixed).
  const sizing = "layoutSizingHorizontal" in node ? { h: node.layoutSizingHorizontal, v: node.layoutSizingVertical } : null;
  if (t.index === undefined) parent.appendChild(node);
  else parent.insertChild(t.index, node);
  const applied: AppliedWrite = { id: node.id, parentId: parent.id };
  return {
    applied,
    kind: "moved node",
    what: "the move of " + label(node),
    restore() {
      from.insertChild(Math.min(at, from.children.length - (node.parent && node.parent.id === from.id ? 1 : 0)), node);
      if ((node.width !== w || node.height !== h) && "resize" in node) node.resize(w, h);
      if (sizing && "layoutSizingHorizontal" in node) {
        const inFlex = !!node.parent && "layoutMode" in node.parent && node.parent.layoutMode !== "NONE";
        const ownFlex = "layoutMode" in node && node.layoutMode !== "NONE";
        const fits = (m: string): boolean => (m === "FILL" ? inFlex : m === "HUG" ? ownFlex || node.type === "TEXT" : inFlex || ownFlex);
        if (node.layoutSizingHorizontal !== sizing.h && fits(sizing.h)) node.layoutSizingHorizontal = sizing.h;
        if (node.layoutSizingVertical !== sizing.v && fits(sizing.v)) node.layoutSizingVertical = sizing.v;
      }
      if (node.x !== x) node.x = x;
      if (node.y !== y) node.y = y;
    },
  };
}

/** Delete a resolved node (checked again: an op of this batch may have put a node below it). Cannot be undone. */
export function applyDelete(t: DeleteTarget): AppliedWrite {
  checkDelete(t);
  const id = t.node.id;
  t.node.remove();
  return { id, deleted: true };
}

/** Every node at or below `n` in the file (an instance's sublayers included). */
function nodesBelow(n: BaseNode, out: BaseNode[] = []): BaseNode[] {
  out.push(n);
  if ("children" in n) for (const c of n.children) nodesBelow(c, out);
  return out;
}

/** Every node id a delete of `n` takes with it, once the batch's moves have run (deletes run last): what is below `n`
 *  in the file and stays there, and what a move puts below it. */
export function idsDeletedWith(n: BaseNode, moves: ReadonlyMap<number, MoveTarget>): Set<string> {
  const movedTo = new Map<string, BaseNode>();
  for (const [, m] of [...moves].sort((a, b) => a[0] - b[0])) movedTo.set(m.node.id, m.parent);
  const up = (x: BaseNode): BaseNode | null => movedTo.get(x.id) ?? x.parent;
  // Moves that would nest nodes in each other (refused when they run) can make a loop here: each node is visited once.
  const under = (x: BaseNode): boolean => {
    const seen = new Set<string>();
    for (let p: BaseNode | null = x; p && !seen.has(p.id); p = up(p)) { if (p.id === n.id) return true; seen.add(p.id); }
    return false;
  };
  const candidates = [...nodesBelow(n), ...[...moves.values()].flatMap((m) => nodesBelow(m.node))];
  const out = new Set<string>();
  for (const c of candidates) if (under(c)) out.add(c.id);
  return out;
}
