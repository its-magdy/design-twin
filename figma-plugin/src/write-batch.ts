// What every write op shares (writes.ts): a problem found while resolving, the refusal that lists them all, and a
// change that can be undone when a later op of the batch fails (docs/write-plane-spec.md decisions 14, 15, 16). Every
// op that changes the file returns a Change, so a batch that fails partway puts back everything it did.
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

/** An applied change, and how to undo it. `kind` names it in a sentence ("variable mode change", "created tree"). A
 *  restore may await (a text style is set back with setTextStyleIdAsync). */
export interface Change {
  applied: AppliedWrite;
  kind: string;
  /** What it is, for a sentence saying it could not be undone. */
  what: string;
  restore(): void | Promise<void>;
}

/** Undo `changes`, newest first. Returns the ones undone and a sentence for each that could not be. `allowed` is asked
 *  before each: once the designer has turned "Allow edits" off, the plugin changes nothing more, not even to undo its
 *  own work, and the rest are reported as kept. */
export async function restoreChanges(changes: readonly Change[], allowed: () => boolean): Promise<{ restored: Change[]; failed: string[] }> {
  const restored: Change[] = [];
  const failed: string[] = [];
  const left = [...changes].reverse();
  for (const [i, c] of left.entries()) {
    if (!allowed()) {
      failed.push("'Allow edits' was turned off while the batch was being put back, so " + countChanges(left.slice(i)).replace(/ earlier /g, " ") + " stay applied");
      break;
    }
    try { await c.restore(); restored.push(c); } catch (e) {
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
