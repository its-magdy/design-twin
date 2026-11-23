// What every write op shares (writes.ts): a problem found while resolving, the refusal that lists them all, and a
// change that can be undone when a later op of the batch fails (docs/write-plane-spec.md decisions 14, 15, 16). Every
// op that changes the file returns a Change, so a batch that fails partway puts back everything it did.
import type { AppliedWrite, WriteResult } from "../../bridge/src/commands.ts";
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
  /** Put the change back. `allowed` is asked after every await: once "Allow edits" is off it throws RestoreStopped. */
  restore(allowed: () => boolean): void | Promise<void>;
  /** One of the layers a patchWhere changed (the same object for every one of them): a reply that lists what was put
   *  back counts them in one row instead of a row each. */
  group?: object;
}

/** The rows of `changes` as a reply lists what was put back: each change's own row, but the layers one patchWhere
 *  changed as one `{matched: n}` row, so the reply does not grow with its matches. */
export function restoredRows(changes: readonly Change[]): AppliedWrite[] {
  const out: AppliedWrite[] = [];
  const rows = new Map<object, AppliedWrite>();
  for (const c of changes) {
    if (!c.group) { out.push(c.applied); continue; }
    const row = rows.get(c.group);
    if (row) { row.matched = (row.matched || 0) + 1; continue; }
    const fresh: AppliedWrite = { matched: 1 };
    rows.set(c.group, fresh);
    out.push(fresh);
  }
  return out;
}
/** A restore stopped because the designer turned "Allow edits" off while it ran: what it had not put back stays. */
export class RestoreStopped extends Error {}

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
    try { await c.restore(allowed); restored.push(c); } catch (e) {
      if (e instanceof RestoreStopped) {
        failed.push("'Allow edits' was turned off while the batch was being put back, so " + countChanges(left.slice(i)).replace(/ earlier /g, " ") + " stay applied (in part, for " + c.what + ")");
        break;
      }
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

/** What a batch added to the file besides its changes, which nothing puts back: the library items it imported, the
 *  images it loaded (images.ts makeImages: bytes the file may already hold, so never called new ones). Neither is a
 *  layer; a refusal that came after one says so, to the designer (writes.ts announce) and to the agent (landedResult). */
export interface Landed { imported: number; images: number }

export const hasLanded = (l: Landed): boolean => l.imported > 0 || l.images > 0;
const plural = (n: number, what: string): string => n + " " + what + (n === 1 ? "" : "s");

/** "loaded 1 image file into Figma and imported 2 library items" */
export function landedText(l: Landed): string {
  const parts: string[] = [];
  if (l.images) parts.push("loaded " + plural(l.images, "image file") + " into Figma");
  if (l.imported) parts.push("imported " + plural(l.imported, "library item"));
  return parts.join(" and ");
}

/** The sentence a refusal's error carries in place of "Nothing was changed." once something landed (landedResult). */
export const landedNote = (l: Landed): string => "No layer was changed, but the batch had already " + landedText(l) + ".";

/** The sentence a failure's error ends with once something landed and it says no "Nothing was changed." to replace: an
 *  op failed as it ran (its layers put back, or some kept), or a preview could not all be put back (landedResult). */
export const landedStays = (l: Landed): string => "The batch had already " + landedText(l) + "; that stays.";

/** What a card's runs landed between them (review.ts: its previews, then the run it ends with). A run of the same batch
 *  loads the same images and imports the same items, so the most any run landed, not their sum. */
export function mergeLanded(a: Landed, b: Landed): Landed {
  return { images: Math.max(a.images, b.images), imported: Math.max(a.imported, b.imported) };
}

/**
 * A failure as the agent gets it, once something landed before it (an import, an image): its "Nothing was changed."
 * (or "Nothing in the file was changed.", or a list's "N problems — nothing was changed:") says what landed instead.
 * One with no such sentence (an op that failed as it ran) gets one: landedNote when no layer stays and none was put
 * back, else landedStays. Anything else — a success, an error that says it already, or nothing landed — is returned
 * as it is, word for word.
 */
export function landedResult(r: WriteResult, l: Landed): WriteResult {
  if (r.ok || !hasLanded(l) || typeof r.error !== "string") return r;
  let error = r.error.replace(/Nothing (in the file )?was changed\./, landedNote(l));
  if (error === r.error) error = r.error.replace(/^(\d+ problems) — nothing was changed:\n/, "$1 — no layer was changed, but the batch had already " + landedText(l) + ":\n");
  if (error === r.error && r.error.indexOf(landedText(l)) < 0) {
    const untouched = !r.applied.length && !(r.restored && r.restored.length);
    error = r.error + (/\.$/.test(r.error) ? " " : ". ") + (untouched ? landedNote(l) : landedStays(l));
  }
  return error === r.error ? r : { ...r, error };
}
