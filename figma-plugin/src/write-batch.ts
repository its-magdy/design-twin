// What every write op shares (writes.ts): a problem found while resolving, the refusal that lists them all, and a
// change that can be undone when a later op of the batch fails (docs/write-plane-spec.md decisions 14, 15, 16). Every
// op that changes the file returns a Change, so a batch that fails partway puts back everything it did.
import type { AppliedWrite, WriteResult } from "../../bridge/src/commands.ts";
import { removedWith } from "./node-lookup";
import { errMsg } from "./util";

/** One reason an op cannot run, against its op index. */
export interface OpProblem {
  index: number;
  op: string;
  message: string;
}

/** What a refusal came after (batchRefusal): what the batch had landed (an image, an import), and the sentences of the
 *  changes it could not put back (restoreChanges `failed`). */
export interface RefusalAfter { landed?: Landed; failed?: readonly string[] }

/**
 * The refusal for a batch whose ops did not all resolve: every problem, one per line, and what that left in the file,
 * said once, where the refusal is made — so it is true however the error is prefixed afterwards (a review's "the file
 * changed…", a preview's "…it failed: "). Nothing landed and nothing failed to go back: "Nothing was changed." (a list:
 * "N problems — nothing was changed:"). Something landed: landedNote (a list: "N problems — no layer was changed, but
 * the batch had already …:"). A change that could not be put back: never "nothing changed"; the sentence says what stays.
 */
export function batchRefusal(problems: readonly OpProblem[], after: RefusalAfter = {}): string {
  const line = (p: OpProblem): string => "ops[" + p.index + "] (" + p.op + "): " + p.message;
  const first = problems[0];
  const landed = after.landed && hasLanded(after.landed) ? after.landed : null;
  const failed = after.failed && after.failed.length ? after.failed : null;
  if (failed) {
    const kept = " Not all of the batch could be put back: " + failed.join("; ") + "." + (landed ? " " + landedStays(landed) : "");
    if (problems.length === 1 && first) return line(first) + "." + kept;
    return problems.length + " problems:\n" + problems.map(line).join("\n") + "\n" + kept.slice(1);
  }
  if (problems.length === 1 && first) return line(first) + ". " + (landed ? landedNote(landed) : "Nothing was changed.");
  return problems.length + " problems — " + (landed ? "no layer was changed, but the batch had already " + landedText(landed) : "nothing was changed") + ":\n" + problems.map(line).join("\n");
}

/** Why a batch was refused, as the designer's one line (writes.ts announce): its error without what the sentence
 *  around it already says — batchRefusal's "Nothing was changed." or what landed (landedNote, landedStays), a list's
 *  "— nothing was changed" head (or what landed) wherever the list starts, after a review's or a preview's words
 *  included — its problems joined with "; ". */
export function refusalReason(error: string | undefined): string {
  return (error || "unknown error").replace(/\. (Nothing was changed|No layer was changed, but the batch had already [^.:\n]*|The batch had already [^.:\n]*; that stays)\.$/, "")
    .replace(/(\d+ problems) — (nothing was changed|no layer was changed, but the batch had already [^.:\n]*):\n/, "$1: ").replace(/\n/g, "; ");
}

/** An applied change, and how to undo it. `kind` names it in a sentence ("variable mode change", "created tree"). A
 *  restore may await (a text style is set back with setTextStyleIdAsync). */
export interface Change {
  applied: AppliedWrite;
  kind: string;
  /** What it is, for a sentence saying it could not be undone. */
  what: string;
  /** Put the change back. `allowed` is asked after every await: once "Allow edits" is off it throws RestoreStopped.
   *  `ours` is the id of every node the batch made (batchMade): a made layer that holds only those is the batch's to take
   *  back whole, whichever op of it made each one (node-lookup.ts takeBack). */
  restore(allowed: () => boolean, ours: ReadonlySet<string>): void | Promise<void>;
  /** Every node it made (a change that made nodes): with every other change's, what the batch made (batchMade). */
  owns?: readonly SceneNode[];
  /** One of the layers a patchWhere changed (the same object for every one of them): a reply that lists what was put
   *  back counts them in one row instead of a row each. */
  group?: object;
  /** The node the change is on. Removed from the file since (the designer deleted it at one of the batch's awaits, or
   *  at one of the put-back's own), the change went with it: nothing of it is in the file, so it is neither put back
   *  nor listed as applied (restoreChanges `gone`), and its restore is not run (a removed node's fields throw when
   *  read). A node the batch made (`made`) is gone as it was before the batch, but its restore still runs: it takes back
   *  what else the build made (a layer moved out of it) and what it set outside its nodes (a key's index entry), and
   *  never reads a node already gone (node-lookup.ts takeBack). */
  on?: BaseNode;
  made?: true;
}

/** The id of every node the batch made, by every change on `changes` that made any (`owns`): one build's layer moved
 *  into another's is the batch's own in both, so a put-back or a cleanup takes it back with the layer that holds it. */
export function batchMade(changes: readonly Change[]): Set<string> {
  const out = new Set<string>();
  for (const c of changes) if (c.owns) for (const n of c.owns) out.add(n.id);
  return out;
}

/** `c` went with its node: one the batch did not make, removed from the file (node-lookup.ts removedWith). */
const wentWithNode = (c: Change): boolean => !c.made && c.on !== undefined && removedWith(c.on);

/** `c` made nodes and every one is removed (taken back with a layer of the batch that held it, or deleted by the
 *  designer): nothing of it is in the file, as before the batch, and its put-back would take back nothing. It is never
 *  said to stay. */
const asBefore = (c: Change): boolean => c.made === true && !!c.owns && c.owns.length > 0 && c.owns.every(removedWith);

/** What a reply says of a change that went with its node (or of a made one deleted whole): what it was, and that none
 *  of it stays. */
export const goneSentence = (c: Change): string => c.what + (c.made ? " was deleted from the file while the batch ran, so none of it stays" : " went with that layer: it was deleted from the file while the batch ran, so none of it stays");

/** `changes` that stay in the file when none is put back (the plugin changes nothing more once "Allow edits" is off):
 *  every one but those that went with their node, and the made ones deleted whole (asBefore). */
export function staying(changes: readonly Change[]): { stays: Change[]; gone: Change[] } {
  const gone = (c: Change): boolean => wentWithNode(c) || asBefore(c);
  return { stays: changes.filter((c) => !gone(c)), gone: changes.filter(gone) };
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

/** Undo `changes`, newest first. Returns the ones undone, a sentence for each that could not be, the ones that went with
 *  their node (`gone`: its layer was deleted while the batch ran, before its turn or at any put-back's await, its own
 *  or a later one's, so decided once all are done; nothing of it stays, and it is neither called undone nor "could not
 *  be undone"), and what stays: every change neither undone nor
 *  gone, which a reply lists as applied. `allowed` is asked before each: once the designer has turned "Allow edits" off,
 *  the plugin changes nothing more, not even to undo its own work, and the rest are reported as kept. */
export async function restoreChanges(changes: readonly Change[], allowed: () => boolean): Promise<{ restored: Change[]; failed: string[]; gone: Change[]; stays: Change[] }> {
  const restored: Change[] = [];
  const failures: Array<[Change, string]> = [];
  let stop: { rest: Change[]; tail: string } | null = null;
  const left = [...changes].reverse();
  const ours = batchMade(changes);
  const undo = (c: Change, e: unknown): string => "could not undo " + c.what + " (" + errMsg(e) + ")";
  for (const [i, c] of left.entries()) {
    if (!allowed()) { stop = { rest: left.slice(i), tail: "" }; break; }
    if (wentWithNode(c)) continue; // gone already: classified below
    try { await c.restore(allowed, ours); restored.push(c); } catch (e) {
      if (e instanceof RestoreStopped) { stop = { rest: left.slice(i), tail: " (in part, for " + c.what + ")" }; break; }
      failures.push([c, undo(c, e)]);
    }
  }
  // A made layer refused for what it held (node-lookup.ts takeBack) may hold nothing else once the older changes went
  // back (a layer the batch moved, put back where it was): each is tried again until none more goes, so what the reply
  // says stays, and why, is the file as the put-back left it. Only made ones: a take-back changes nothing when it throws.
  // "Allow edits" turned off before one was tried again since the last that went: its reason may no longer be true, so
  // it is not given; it stays because the put-back stopped, and is counted with what else stays for that.
  for (let more = !stop; more;) {
    more = false;
    const tried = new Set<Change>();
    for (const f of failures) {
      const c = f[0];
      if (!c.made || wentWithNode(c)) continue;
      if (!allowed()) { stop = { rest: [], tail: "" }; break; }
      try { await c.restore(allowed, ours); restored.push(c); failures.splice(failures.indexOf(f), 1); more = true; break; } catch (e) {
        if (e instanceof RestoreStopped) { stop = { rest: [], tail: "" }; break; }
        tried.add(c);
        f[1] = undo(c, e);
      }
    }
    if (stop) {
      const untried = failures.filter(([c]) => c.made && !wentWithNode(c) && !tried.has(c));
      for (const u of untried) failures.splice(failures.indexOf(u), 1);
      stop.rest = untried.map(([c]) => c);
    }
  }
  // Gone or not is decided once every put-back is done: a node can be deleted at any put-back's await, its own (after it
  // was put back, or one that threw) or a later one's. One removed by now took with it what was set on it, and what was
  // put back on it: it is gone, neither restored, nor "could not undo", nor applied.
  const gone = left.filter(wentWithNode);
  // A made one not put back (refused, or not reached once "Allow edits" was off) whose every node is removed by now
  // (taken back with a layer of the batch that held it, or deleted) is as its put-back would have left it: put back,
  // never "could not undo", never said to stay.
  const back = left.filter((c) => restored.indexOf(c) < 0 && asBefore(c));
  restored.push(...back);
  const settled = new Set([...gone, ...back]);
  const failed = failures.filter(([c]) => !settled.has(c)).map(([, s]) => s);
  // Not put back ("Allow edits" turned off): the ones that did not go with their node stay applied, and are counted.
  const kept = stop ? stop.rest.filter((c) => !settled.has(c)) : [];
  if (stop && kept.length) failed.push("'Allow edits' was turned off while the batch was being put back, so " + countChanges(kept).replace(/ earlier /g, " ") + " stay applied" + stop.tail);
  const isGone = new Set(gone);
  const done = new Set([...restored, ...gone]);
  return { restored: restored.filter((c) => !isGone.has(c)), failed, gone, stays: changes.filter((c) => !done.has(c)) };
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
 * (or "Nothing in the file was changed.") says what landed instead. One with no such sentence (an op that failed as it
 * ran) gets one: landedNote when no layer stays and none was put back, else landedStays. Anything else — a success, an
 * error that says it already (a batchRefusal given what landed), or nothing landed — is returned as it is, word for word.
 */
export function landedResult(r: WriteResult, l: Landed): WriteResult {
  if (r.ok || !hasLanded(l) || typeof r.error !== "string") return r;
  let error = r.error.replace(/Nothing (in the file )?was changed\./, landedNote(l));
  if (error === r.error && r.error.indexOf(landedText(l)) < 0) {
    const untouched = !r.applied.length && !(r.restored && r.restored.length);
    error = r.error + (/\.$/.test(r.error) ? " " : ". ") + (untouched ? landedNote(l) : landedStays(l));
  }
  return error === r.error ? r : { ...r, error };
}
