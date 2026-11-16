// The designer's review of a write (docs/write-plane-spec.md decision 18): the PLAIN form — a card in the plugin window
// that lists, in words, what a batch is about to do, with Apply and Reject and an optional typed reason that goes back
// to the agent. How a richer review is shown, when it applies and how the agent waits are not decided yet (they are
// being prototyped), so this module is deliberately small and is the only place the decision lives: writes.ts asks
// awaitReview() once per batch, after every op resolved and before the file is touched, and gets an outcome back. A
// later form replaces this module and the card's markup; the outcome and the lines it shows (commands.ts reviewLines,
// the dry run's own description) stay.
//
// "Review each write" is a second checkbox under "Allow edits", and like it: off by default (writes apply directly,
// as before), saved per user in clientStorage, and set only by the window's own checkbox — relay.ts turns socket
// frames into `bridge`/`cancel` messages only, so nothing on the bridge side can turn review off or answer a card.
// "Allow edits" stays the master switch: with it off a batch is refused before it ever reaches review.
//
// A card never waits forever. It ends, and the batch is refused with nothing changed, when:
//   - nobody answers within the wait (REVIEW_WAIT_MS, less than the bridge's write budget, so this reply wins);
//   - the request is withdrawn: the bridge gave up on it or its socket closed (progress.ts requestAbandon, which
//     reaches here through Run.onCancel), so a designer can never apply a write its agent has stopped waiting for;
//   - the designer presses Cancel on the running write (progress.ts requestCancel);
//   - the designer unticks "Allow edits" while it waits (main.ts calls endReviews).
// When the plugin window closes, the plugin stops with it: the bridge rejects the request on the disconnect, and
// nothing was applied.
import { reviewLines, reviewReason, type WriteOp } from "../../bridge/src/commands.ts";
import { REVIEW_WAIT_MS } from "../../bridge/src/timeouts.ts";
import { activeRun } from "./run";
import type { ReviewEnd, ReviewEndMsg, ReviewMsg } from "./messages";
import { forgetCard, rememberCard, reviewProto, type OpLayers } from "./review-proto";

export type { ReviewEnd };

const KEY = "reviewWrites";

let on = false;
// PROTOTYPE (#174): whether the box was ever set — "checkbox-forced" reads a box never set as ON.
let set = false;

// Read once, when the bundle is evaluated (as edits.ts does). Until it settles review reads as OFF, but no write runs
// before it settles: writes.ts awaits reviewWrites().
const loaded: Promise<void> = (async () => {
  try {
    const v: unknown = await figma.clientStorage.getAsync(KEY);
    on = v === true;
    set = typeof v === "boolean";
  } catch (e) {
    console.error("[export] could not read the Review each write setting; review stays off:", e);
    on = false;
  }
})();

/** Whether a write waits for the designer's Apply/Reject (after the saved setting has been read). */
export async function reviewWrites(): Promise<boolean> {
  await loaded;
  if (!set && (await reviewProto()).when === "checkbox-forced") return true;
  return on;
}
/** PROTOTYPE (#174): the box as saved, undefined when never set (review-policy.ts reviewDecision reads it). */
export async function reviewCheckbox(): Promise<boolean | undefined> {
  await loaded;
  return set ? on : undefined;
}

/** The designer ticked or cleared "Review each write". Takes effect for the next batch, then is saved. */
export async function setReviewWrites(value: boolean): Promise<boolean> {
  await loaded;
  on = value;
  set = true;
  try {
    await figma.clientStorage.setAsync(KEY, value);
  } catch (e) {
    console.error("[export] could not save the Review each write setting:", e);
  }
  return on;
}

/** How a review ended: `approved` lets the batch run; anything else refuses it whole. `reason` is the designer's text
 *  on a rejection (commands.ts reviewReason: trimmed and capped; absent when empty). */
export interface ReviewOutcome { end: ReviewEnd; reason?: string }

interface Pending { settle(o: ReviewOutcome): void }
const pending = new Map<string, Pending>();
let seq = 0;

/** PROTOTYPE (#174): what a card adds to the plain lines (all optional; none = today's card), the Show me targets the
 *  main thread keeps while it is up, and how long it waits (a ticket-mode write sends a longer one). */
export interface CardExtras { form?: ReviewMsg["form"]; why?: string; shows?: ReviewMsg["shows"]; drawings?: ReviewMsg["drawings"]; layers?: readonly OpLayers[]; waitMs?: number }

/** Show the card for `ops` and wait for the designer. Resolves once — never rejects. */
export function awaitReview(ops: readonly WriteOp[], extras: CardExtras = {}): Promise<ReviewOutcome> {
  const id = "review-" + ++seq;
  const run = activeRun();
  return new Promise<ReviewOutcome>((resolve) => {
    // A stop that landed before the card went up (the bridge gave up while the batch resolved): no card at all.
    if (run && run.cancel) { resolve({ end: run.cancel === "designer" ? "cancelled" : "withdrawn" }); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onCancel = (): void => settle({ end: run && run.cancel === "designer" ? "cancelled" : "withdrawn" });
    const settle = (o: ReviewOutcome): void => {
      if (!pending.delete(id)) return; // already ended: one outcome per card
      forgetCard(id);
      if (timer !== undefined) clearTimeout(timer);
      if (run && run.onCancel === onCancel) run.onCancel = null;
      // The window takes the card down whatever ended it, and says why when no click of the designer's did.
      const ended: ReviewEndMsg = { type: "review-end", id, end: o.end };
      figma.ui.postMessage(ended);
      resolve(o);
    };
    pending.set(id, { settle });
    if (run) run.onCancel = onCancel;
    const waitMs = extras.waitMs !== undefined ? extras.waitMs : REVIEW_WAIT_MS;
    timer = setTimeout(() => settle({ end: "timed-out" }), waitMs);
    if (extras.layers) rememberCard(id, extras.layers);
    const card: ReviewMsg = { type: "review", id, lines: reviewLines(ops), waitMs };
    if (extras.form !== undefined) card.form = extras.form;
    if (extras.why !== undefined) card.why = extras.why;
    if (extras.shows !== undefined) card.shows = extras.shows;
    if (extras.drawings !== undefined) card.drawings = extras.drawings;
    figma.ui.postMessage(card);
  });
}

/** The designer pressed Apply or Reject on card `id` (main.ts, from the window). A card that has already ended (it
 *  timed out, or was withdrawn a moment before the click) ignores the click: the window has been told it ended. */
export function answerReview(id: string, apply: boolean, reason?: string): void {
  const p = pending.get(id);
  if (!p) return;
  const said = reviewReason(reason);
  p.settle(apply ? { end: "approved" } : { end: "rejected", ...(said !== undefined ? { reason: said } : {}) });
}

/** End every card that is waiting with `end` (main.ts: "Allow edits" was unticked). */
export function endReviews(end: ReviewEnd): void {
  for (const p of [...pending.values()]) p.settle({ end });
}
