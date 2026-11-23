// The designer's review of a write (docs/write-plane-spec.md decision 18): the card in the plugin window, and the
// ticket the agent waits on. One designed whole:
//
// WHEN A WRITE WAITS is bridge/src/review-policy.ts (writes.ts asks it once the batch has resolved): "Review each
// change first" (this module's checkbox: ON when never set, saved per user, set only from the window — relay.ts turns
// socket frames into `bridge`/`cancel` messages only), or, whatever the box says, a source edit, a bulk change by rule,
// or more than REVIEW_LAYER_LIMIT existing layers changed since the designer's last approval. That count lives here, per
// plugin session. "Allow edits" stays the master switch: with it off a batch is refused before it is ever reviewed.
//
// THE CARD lists the batch in plain words (bridge/src/review-card.ts lines, old → new values with colour swatches; the
// dry run's sentences under a collapsed Details), says why it waited, has a Show me per line and Show all (select and
// zoom, or pan to where a new frame lands: no undo step), and Apply / Reject with an optional reason that goes back to
// the agent. ONE card at a time: a write that arrives while one is up is refused at once, naming the waiting ticket
// (Figma's toast tells the designer; the card stays as it is).
// When it goes up, the last red toast comes down and Figma's toast says a write waits (a minimised window is noticed).
//
// PREVIEW ON CANVAS, offered for a source edit or a bulk change (review-policy.ts previewOffered): the batch is applied
// as it would be on Apply, and the card turns to Keep / Put back. Keep: the batch stays, as an applied write. Put back:
// it is undone (write-batch.ts restoreChanges, the put-back a failure uses) and the card is back to Apply / Reject.
// A preview is in the file, so everyone in it sees it. Undo history: the preview is one step, its put-back a second, so a
// Cmd-Z after Put back brings the preview back (a second Cmd-Z takes it away again) — the plugin cannot drop a step.
// A card that ends while previewing (withdrawn, expired, out of time) puts the preview back first; with "Allow edits"
// turned off it stays, and the reply says so. Not offered with a delete or a keyed re-send, which cannot be put back.
// What a closed plugin window or a reloaded Figma leaves on the canvas nobody can put back: the plugin is gone.
// Every action on a card runs after the one before it (Card.chain), and the window enables its buttons again only when
// told the card's state: so a Put back clicked while the preview is still landing is done, never dropped.
//
// THE TICKET is the plugin's, not the MCP server's: a write that waits answers its bridge request `{pending, ticket}`
// after the hold (REVIEW_HOLD_MS, under the MCP client's 60 s call timeout) and keeps its card up; `writeTicket`
// (figma_write {ticket}) waits again and answers the result once there is one. A finished outcome is kept a while
// (FINISHED_KEEP, FINISHED_MS), so asking again answers at once — and an MCP server restart loses nothing. A card ends
// when the designer answers; when the agent withdraws it (figma_write {ticket, cancel: true}); when no one has asked for
// it within REVIEW_IDLE_MS of its last pending answer ("expired": the agent stopped waiting); after REVIEW_CARD_MAX_MS in
// all; or when "Allow edits" is unticked. The plugin window closing ends everything with it: nothing waiting is applied.
// figma_status reads the last outcome (lastWrite below), including one answered after its agent stopped asking.
import { rejectedMessage, reviewReason, unreviewedMessage, EDITS_OFF_MESSAGE, pendingNote, type LastFigmaWrite, type UnreviewedEnd, type WriteOp, type WritePending, type WriteReply, type WriteResult } from "../../bridge/src/commands.ts";
import { lineText, type CardLine } from "../../bridge/src/review-card.ts";
import { REVIEW_CARD_MAX_MS, REVIEW_HOLD_MAX_MS, REVIEW_HOLD_MS, REVIEW_IDLE_MS } from "../../bridge/src/timeouts.ts";
import { panTo, selectAndZoom, SHOW_CAP, type Spot } from "./review-reads";
import { editsAllowedNow } from "./edits";
import { clearErrorToast, toast } from "./toast";
import type { ReviewCardLine, ReviewEnd, ReviewEndMsg, ReviewMsg, ReviewState, ReviewStateMsg } from "./messages";
import { errMsg } from "./util";
import { landedResult, mergeLanded, type Landed } from "./write-batch";

export type { ReviewEnd };

// ---------------------------------------------------------------- "Review each change first"

const KEY = "reviewWrites";
/** The box as saved: null until the designer first sets it, which reads as ON. */
let saved: boolean | null = null;

// Read once, when the bundle is evaluated (as edits.ts does). No write runs before it settles: writes.ts awaits
// reviewWrites().
const loaded: Promise<void> = (async () => {
  try {
    const v: unknown = await figma.clientStorage.getAsync(KEY);
    saved = typeof v === "boolean" ? v : null;
  } catch (e) {
    console.error("[export] could not read the 'Review each change first' setting; it reads as on:", e);
    saved = null;
  }
})();

/** Whether every write waits for the designer ("Review each change first"; on when never set). */
export async function reviewWrites(): Promise<boolean> {
  await loaded;
  return saved !== false;
}

/** The designer ticked or cleared the box (the window's checkbox only). Takes effect for the next batch, then is saved. */
export async function setReviewWrites(value: boolean): Promise<boolean> {
  await loaded;
  saved = value;
  try {
    await figma.clientStorage.setAsync(KEY, value);
  } catch (e) {
    console.error("[export] could not save the 'Review each change first' setting:", e);
  }
  return value;
}

// ---------------------------------------------------------------- the layer count since the last approval

let sinceApproval = 0;
/** The existing layers changed since the designer last approved a write, this plugin session (review-policy.ts). */
export function layersSinceApproval(): number { return sinceApproval; }
/** A batch that did not wait changed `n` existing layers. */
export function countUnreviewed(n: number): void { sinceApproval += n; }

// ---------------------------------------------------------------- the card

/** What writes.ts hands a card: the batch, what it shows, and how to run it. */
export interface CardInput {
  ops: readonly WriteOp[];
  lines: CardLine[];
  /** each line's Show me: the layers (by id, at most SHOW_CAP), or where a new frame lands */
  shows: Array<{ ids: string[]; total: number; spot?: Spot }>;
  /** the dry run's sentences (commands.ts reviewLines), for Details */
  details: string[];
  why: string;
  previewable: boolean;
  /** apply the batch, resolved again against the file as it is now (a scheduled run of its own). `prior`: what the
   *  card's previews landed (Card.landed), which a refusal or failure of this run says too */
  apply(prior: Landed): Promise<WriteResult>;
  /** apply it as a preview: the result, how to put it back, and what it and the previews before it added that nothing
   *  puts back (`prior`, as for apply) */
  preview(prior: Landed): Promise<{ result: WriteResult; putBack: () => Promise<WriteResult | null>; landed?: Landed }>;
  /** say what a batch came to (writes.ts announce: Figma's toast and the window's status line) */
  announce(r: WriteResult, landed?: Landed): void;
}

export interface Card {
  ticket: string;
  input: CardInput;
  state: ReviewState;
  /** set while a preview is on the canvas */
  previewed: { result: WriteResult; putBack: () => Promise<WriteResult | null> } | null;
  /** what its previews loaded or imported (images, library items: writes.ts), which a put-back leaves: a card that ends
   *  unapplied says so instead of "nothing was changed" */
  landed: Landed;
  /** every action on the card, one after another */
  chain: Promise<void>;
  /** settles once, with the batch's outcome */
  outcome: Promise<WriteResult>;
  settle(r: WriteResult): void;
  done: boolean;
  /** polls holding for the outcome now */
  waiters: Array<(r: WriteResult) => void>;
  idle: ReturnType<typeof setTimeout> | undefined;
  cap: ReturnType<typeof setTimeout> | undefined;
  opened: number;
}

let current: Card | null = null;
let seq = 0;

/** Finished outcomes, by ticket: a repeat answers at once. The newest FINISHED_KEEP, for FINISHED_MS. */
const FINISHED_KEEP = 20;
const FINISHED_MS = 30 * 60000;
const finished = new Map<string, { result: WriteResult; at: number }>();
let last: LastFigmaWrite | null = null;

/** The last write's outcome for figma_status (ping), or the write waiting now. */
export function lastWrite(): LastFigmaWrite | null { return last; }
/** The ticket of the write waiting for the designer now, if one is. */
export function waitingTicket(): string | null { return current ? current.ticket : null; }

function remember(ticket: string | undefined, r: WriteResult, unseen: boolean): void {
  const outcome: LastFigmaWrite["outcome"] = r.refused ? r.refused : r.ok ? "applied" : "failed";
  const text = r.ok ? r.applied.length + " op(s) applied" : r.error || "not applied";
  last = { ...(ticket ? { ticket } : {}), at: new Date().toISOString(), outcome, text, ...(unseen ? { unseen: true as const } : {}) };
  if (!ticket) return;
  finished.set(ticket, { result: r, at: Date.now() });
  while (finished.size > FINISHED_KEEP) { const k = finished.keys().next().value; if (k === undefined) break; finished.delete(k); }
}
/** The outcome of a write that did not wait (writes.ts): figma_status reports it too. */
export function rememberWrite(r: WriteResult): void { remember(undefined, r, false); }

const post = (m: ReviewMsg | ReviewEndMsg | ReviewStateMsg): void => { try { figma.ui.postMessage(m); } catch (e) { console.error("[export] could not post to the window:", e); } };

/** Put a card up for a batch that waits. Refused by the caller first when one is already up (waitingTicket). */
export function openCard(input: CardInput): Card {
  const ticket = "rv-" + (++seq) + "-" + Math.random().toString(36).slice(2, 7);
  let settle: (r: WriteResult) => void = () => {};
  const outcome = new Promise<WriteResult>((res) => { settle = res; });
  const card: Card = { ticket, input, state: "waiting", previewed: null, landed: { imported: 0, images: 0 }, chain: Promise.resolve(), outcome, settle, done: false, waiters: [], idle: undefined, cap: undefined, opened: Date.now() };
  current = card;
  card.cap = setTimeout(() => act(card, () => end(card, { end: "timed-out" })), REVIEW_CARD_MAX_MS);
  const lines: ReviewCardLine[] = input.lines.map((l, i) => {
    const s = input.shows[i];
    return { head: l.head, rows: l.rows, ...(l.tail !== undefined ? { tail: l.tail } : {}), ...(s && s.ids.length ? { show: { n: s.ids.length, total: s.total } } : s && s.spot ? { show: { n: 0, total: 0, spot: true as const } } : {}) };
  });
  post({ type: "review", id: ticket, lines, details: input.details, why: input.why, previewable: input.previewable, waitMs: REVIEW_CARD_MAX_MS });
  clearErrorToast();
  toast("Design Twin: Claude Code wants to change this file — review it in the plugin window.");
  last = { ticket, at: new Date().toISOString(), outcome: "waiting", text: input.lines.map(lineText).join("; ") };
  return card;
}

/** Run `step` on `card` after every action before it. A step that throws ends nothing: it is logged. */
function act(card: Card, step: () => Promise<void> | void): Promise<void> {
  card.chain = card.chain.then(async () => {
    if (card.done) return;
    try { await step(); } catch (e) { console.error("[export] a review step failed:", e); }
  });
  return card.chain;
}

function setState(card: Card, state: ReviewState, note?: string): void {
  card.state = state;
  post({ type: "review-state", id: card.ticket, state, ...(note ? { note } : {}) });
}

/** The card is over with `r` (the batch's outcome): every poll waiting gets it; it is kept for a repeat. */
function finish(card: Card, r: WriteResult): void {
  if (card.done) return;
  card.done = true;
  if (card.idle !== undefined) clearTimeout(card.idle);
  if (card.cap !== undefined) clearTimeout(card.cap);
  if (current === card) current = null;
  const seen = card.waiters.length > 0;
  remember(card.ticket, r, !seen);
  for (const w of card.waiters.splice(0)) w(r);
  card.settle(r);
}

/** How a card ends: the designer's answer, or a stop nobody here clicked for. */
type Ending = { end: "approved" } | { end: "kept" } | { end: "rejected"; reason?: string } | { end: UnreviewedEnd } | { end: "edits-off" };

async function end(card: Card, e: Ending): Promise<void> {
  if (card.done) return;
  const msg: ReviewEndMsg = { type: "review-end", id: card.ticket, end: e.end };
  if (e.end === "approved" || e.end === "kept") {
    post(msg);
    // The designer approved: the count starts again whatever the batch comes to.
    sinceApproval = 0;
    let r: WriteResult;
    if (e.end === "kept" && card.previewed) {
      r = card.previewed.result;
      card.input.announce(r);
    } else {
      setState(card, "busy");
      // A refusal of the approved run says what the card's previews left too (writes.ts runBatch, from card.landed).
      try { r = await card.input.apply(card.landed); } catch (e2) { r = landedResult({ ok: false, applied: [], error: "the approved write could not run: " + errMsg(e2) }, card.landed); }
    }
    finish(card, r);
    return;
  }
  // Anything else: nothing of the batch stays. A preview on the canvas is put back first — unless "Allow edits" is off,
  // after which the plugin changes nothing, not even to undo its own preview.
  const refusal = refusalFor(e);
  const p = card.previewed;
  if (p) {
    if (e.end === "edits-off" || !editsAllowedNow()) {
      post(msg);
      const r: WriteResult = landedResult({ ok: false, applied: p.result.applied, refused: "edits-off", error: "'Allow edits' was turned off while a preview of this write was on the canvas, so the preview stays applied (listed in `applied`); nothing was put back." }, card.landed);
      card.input.announce(r);
      finish(card, r);
      return;
    }
    setState(card, "busy", "Putting the preview back…");
    const failed = await p.putBack();
    card.previewed = null;
    post(msg);
    if (failed) { const f = landedResult(failed, card.landed); card.input.announce(f, card.landed); finish(card, f); return; }
    const r = landedResult({ ...refusal, error: (refusal.error || "") + " (A preview of it was on the canvas; it was put back.)" }, card.landed);
    card.input.announce(r, card.landed);
    finish(card, r);
    return;
  }
  post(msg);
  // A preview put back earlier may have left an image or an import: said (landedResult); else word for word as ever.
  const r = landedResult(refusal, card.landed);
  card.input.announce(r, card.landed);
  finish(card, r);
}

function refusalFor(e: Ending): WriteResult {
  if (e.end === "rejected") return { ok: false, applied: [], refused: "rejected", error: rejectedMessage(e.reason), ...(e.reason !== undefined ? { reason: e.reason } : {}) };
  if (e.end === "edits-off" || e.end === "approved" || e.end === "kept") return { ok: false, applied: [], refused: "edits-off", error: EDITS_OFF_MESSAGE };
  return { ok: false, applied: [], refused: "unreviewed", error: unreviewedMessage(e.end, e.end === "expired" ? REVIEW_IDLE_MS : REVIEW_CARD_MAX_MS) };
}

// ---------------------------------------------------------------- the designer's actions (the window's buttons)

/** What the window's buttons ask of card `id`. */
export type CardAction = "apply" | "reject" | "preview" | "keep" | "put-back";

/** The designer pressed a button on card `id` (main.ts, from the window). A card that has ended ignores it. */
export function answerReview(id: string, action: CardAction, reason?: unknown): void {
  const card = current;
  if (!card || card.ticket !== id) return;
  void act(card, async () => {
    if (action === "apply" || action === "keep") {
      // Keep on a preview keeps it; Apply runs the batch (or keeps a preview already there).
      await end(card, card.previewed ? { end: "kept" } : { end: "approved" });
      return;
    }
    if (action === "reject") {
      const said = reviewReason(reason);
      await end(card, { end: "rejected", ...(said !== undefined ? { reason: said } : {}) });
      return;
    }
    if (action === "preview") {
      if (card.previewed || !card.input.previewable) { setState(card, card.state); return; }
      if (!editsAllowedNow()) { await end(card, { end: "edits-off" }); return; }
      setState(card, "busy", "Putting it on the canvas…");
      // One that throws ends the card as a failed preview (else the card stayed on "Putting it on the canvas…").
      let p: Awaited<ReturnType<CardInput["preview"]>>;
      // It is given what the card's earlier previews landed (their put-backs left it): a refusal of this one says it too.
      try { p = await card.input.preview(card.landed); } catch (e2) { p = { result: landedResult({ ok: false, applied: [], error: "the preview could not run: " + errMsg(e2) }, card.landed), putBack: async () => null, landed: card.landed }; }
      if (!p.result.ok) {
        // It could not land whole (what it did was put back, as for any failed batch): the card ends with that result.
        post({ type: "review-end", id: card.ticket, end: "failed" });
        const r: WriteResult = { ...p.result, error: "The designer asked to preview this write on the canvas, and it failed: " + (p.result.error || "unknown error") };
        card.input.announce(r, p.landed);
        finish(card, r);
        return;
      }
      card.previewed = p;
      // What it loaded or imported stays whatever the card comes to (a put-back takes back only its layers). A second
      // preview of the same batch loads the same images and items: the most either loaded, not their sum.
      if (p.landed) card.landed = mergeLanded(card.landed, p.landed);
      // Show what it changed: the lines' layers and anything it made.
      const ids: string[] = [];
      for (const s of card.input.shows) for (const x of s.ids) if (ids.length < SHOW_CAP) ids.push(x);
      for (const a of p.result.applied) if (a.id && ids.length < SHOW_CAP) ids.push(a.id);
      try { await selectAndZoom(ids); } catch (e) { console.error("[export] could not select the preview:", e); }
      setState(card, "previewing", "On the canvas now — everyone in this file can see it. Keep it, or put it back.");
      return;
    }
    // put-back
    if (!card.previewed) { setState(card, card.state); return; }
    setState(card, "busy", "Putting it back…");
    const failed = await card.previewed.putBack();
    card.previewed = null;
    if (failed) {
      post({ type: "review-end", id: card.ticket, end: "failed" });
      const f = landedResult(failed, card.landed);
      card.input.announce(f, card.landed);
      finish(card, f);
      return;
    }
    setState(card, "waiting", "Put back. It still waits for your answer.");
  });
}

/** Show me (line `index`, -1 for all of them) on card `id`: what the window says back. */
export async function showLines(id: string, index: number): Promise<string> {
  const card = current;
  if (!card || card.ticket !== id) return "That review has ended.";
  const pick = index < 0 ? card.input.shows : card.input.shows.slice(index, index + 1);
  const ids: string[] = [];
  let total = 0;
  for (const s of pick) { for (const x of s.ids) if (ids.length < SHOW_CAP && ids.indexOf(x) < 0) ids.push(x); total += s.total; }
  if (!ids.length) {
    const spot = pick.map((s) => s.spot).find((s) => !!s);
    if (!spot) return "Nothing to show: it changes no layer that exists yet.";
    await panTo(spot);
    return "Not built yet — this is where it will land.";
  }
  const n = await selectAndZoom(ids);
  return n ? "Showing " + n + (total > n ? " of " + total : "") + " layer" + (n === 1 ? "" : "s") + "." : "Those layers are not in the file any more.";
}

/** End every card with `end` (main.ts: "Allow edits" was unticked). */
export function endReviews(e: "edits-off"): void {
  const card = current;
  if (card) void act(card, () => end(card, { end: e }));
}

// ---------------------------------------------------------------- the agent's side: hold, poll, withdraw

/** A hold as asked (holdMs), within 0…REVIEW_HOLD_MAX_MS; REVIEW_HOLD_MS when absent. */
export function holdOf(holdMs: number | undefined): number {
  return typeof holdMs === "number" && Number.isFinite(holdMs) ? Math.max(0, Math.min(REVIEW_HOLD_MAX_MS, holdMs)) : REVIEW_HOLD_MS;
}

function waited(card: Card): string {
  const s = Math.round((Date.now() - card.opened) / 1000);
  return s >= 60 ? Math.round(s / 60) + " min" : s + " s";
}

function pending(card: Card): WritePending {
  return { pending: true, ticket: card.ticket, why: card.input.why, waited: waited(card), note: pendingNote(card.ticket, REVIEW_IDLE_MS) };
}

/** Wait up to `holdMs` for card `card`'s outcome: it, or `pending` (and the idle clock starts). */
function hold(card: Card, holdMs: number): Promise<WriteReply> {
  if (card.idle !== undefined) { clearTimeout(card.idle); card.idle = undefined; }
  return new Promise<WriteReply>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const got = (r: WriteResult): void => { if (timer !== undefined) clearTimeout(timer); resolve(r); };
    card.waiters.push(got);
    timer = setTimeout(() => {
      const i = card.waiters.indexOf(got);
      if (i >= 0) card.waiters.splice(i, 1);
      // Nobody else is asking: the agent has REVIEW_IDLE_MS to ask again before the card is withdrawn.
      if (!card.done && !card.waiters.length) card.idle = setTimeout(() => act(card, () => end(card, { end: "expired" })), REVIEW_IDLE_MS);
      resolve(pending(card));
    }, holdMs);
  });
}

/** A write that waits, first answered: the outcome if the designer answers within the hold, else `pending`. */
export function holdNew(card: Card, holdMs: number): Promise<WriteReply> {
  return hold(card, holdMs);
}

/** The outcome of a card, however long it takes (a direct caller: the test surface). */
export function outcomeOf(card: Card): Promise<WriteResult> {
  return card.outcome;
}

/** `writeTicket`: wait again for ticket `ticket`, or withdraw it (`cancel`). A finished one answers at once. */
export async function answerTicket(ticket: string, holdMs: number, cancel: boolean): Promise<WriteReply> {
  const card = current && current.ticket === ticket ? current : null;
  if (card && !card.done) {
    // A withdrawal runs after whatever the card is doing: an approved batch already running cannot be withdrawn, so then
    // the outcome is that batch's (the withdrawal finds the card done and does nothing). Either way it is answered
    // through the same hold as a poll — the outcome if it is there in time, else pending (asked again, it answers the
    // outcome, kept like any other) — so a long apply or put-back never outlasts the agent's call.
    if (cancel) void act(card, () => end(card, { end: "withdrawn" }));
    return hold(card, holdMs);
  }
  const f = finished.get(ticket);
  if (f && Date.now() - f.at <= FINISHED_MS) {
    // Its agent has it now: figma_status stops calling it unseen.
    if (last && last.ticket === ticket && last.unseen) { const seen: LastFigmaWrite = { ...last }; delete seen.unseen; last = seen; }
    return f.result;
  }
  throw new Error("No write is waiting under ticket '" + ticket + "' in this file: it ended more than " + Math.round(FINISHED_MS / 60000) +
    " min ago, or the plugin window was closed or reloaded since (that drops a waiting card and applies nothing — a preview that was on the canvas stays). Read the file before sending the ops again.");
}
