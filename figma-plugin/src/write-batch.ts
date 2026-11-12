// What every write op that is resolved before its batch runs shares (writes.ts): a problem found while resolving,
// the refusal that lists them all, and a change that can be undone when a later op of the batch fails
// (docs/write-plane-spec.md decisions 14, 15). Variable modes (variable-modes.ts) and tree specs (tree.ts) use it.
import type { AppliedWrite } from "../../bridge/src/commands.ts";
import { errMsg } from "./util";

/** One reason an op cannot run, against its op index. */
export interface OpProblem {
  index: number;
  op: string;
  message: string;
}

/** The refusal for a batch whose ops did not all resolve: every problem, one per line. */
export function batchRefusal(problems: readonly OpProblem[]): string {
  const line = (p: OpProblem): string => "ops[" + p.index + "] (" + p.op + "): " + p.message;
  const first = problems[0];
  if (problems.length === 1 && first) return line(first) + ". Nothing was changed.";
  return problems.length + " problems — nothing was changed:\n" + problems.map(line).join("\n");
}

/** An applied change, and how to undo it. `kind` names it in a sentence ("variable mode change", "created tree"). */
export interface Change {
  applied: AppliedWrite;
  kind: string;
  /** What it is, for a sentence saying it could not be undone. */
  what: string;
  restore(): void;
}

/** Undo `changes`, newest first. Returns the ones undone and a sentence for each that could not be. */
export function restoreChanges(changes: readonly Change[]): { restored: Change[]; failed: string[] } {
  const restored: Change[] = [];
  const failed: string[] = [];
  for (const c of [...changes].reverse()) {
    try { c.restore(); restored.push(c); } catch (e) {
      failed.push("could not undo " + c.what + " (" + errMsg(e) + ")");
    }
  }
  return { restored, failed };
}

/** "1 earlier variable mode change", "2 earlier created trees and 1 earlier variable mode change": `changes` counted
 *  by kind, in first-seen order. */
export function countChanges(changes: readonly Change[]): string {
  const counts = new Map<string, number>();
  for (const c of changes) counts.set(c.kind, (counts.get(c.kind) || 0) + 1);
  return [...counts].map(([k, n]) => n + " earlier " + k + (n === 1 ? "" : "s")).join(" and ");
}
