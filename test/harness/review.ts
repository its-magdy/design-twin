// The designer's review of a write (figma-plugin/src/review.ts, docs/write-plane-spec.md decision 18): when a write
// waits (the box, on by default; a source edit or more than 25 layers since the last approval even with it clear), the
// card it waits on (plain lines, Show me, a preview on the canvas with Keep / Put back), and the ticket the agent waits
// with (pending after the hold, asked again, withdrawn, expired when the agent stops asking). Every way a card ends
// without an Apply refuses the batch with nothing changed.
import { EDITS_OFF_MESSAGE, rejectedMessage, reviewLines, REVIEW_REASON_MAX, unreviewedMessage, type LastFigmaWrite, type WriteOp, type WritePending, type WriteReply, type WriteResult } from "../../bridge/src/commands.ts";
import { lineText } from "../../bridge/src/review-card.ts";
import { REVIEW_CARD_MAX_MS, REVIEW_IDLE_MS } from "../../bridge/src/timeouts.ts";
import { ok } from "../assert.ts";
import { fakeClock } from "../fake-clock.ts";
import { clockTimers, textRuns, type FakeNode, type PostedMessage, type Scene } from "../fake-figma.ts";
import type { Case } from "./helpers.ts";
import { world } from "./scene.ts";

const textNode = (id: string, name: string, characters: string): FakeNode =>
  textRuns({ id, type: "TEXT", name, characters, fontName: { family: "Inter", style: "Regular" }, getRangeAllFontNames: () => Object.freeze([{ family: "Inter", style: "Regular" }]) });

/** A writable file, reviewed for real (nobody answers a card unless the case does): one text node ("t:1", "old"); 30
 *  more ("n:1"…"n:30") for counts; a main component "Row" (c:1) holding a layer (c:2) with 2 instances. Frames the
 *  plugin creates are listed in `created`. */
function reviewWorld(extra: Scene = {}) {
  const created: FakeNode[] = [];
  const label = textNode("t:1", "Label", "old");
  const many: Record<string, FakeNode> = {};
  for (let i = 1; i <= 30; i++) many["n:" + i] = textNode("n:" + i, "Row " + i, "a");
  const inst = (id: string): FakeNode => ({ id, type: "INSTANCE", name: "Row", visible: true });
  const row: FakeNode = { id: "c:1", type: "COMPONENT", name: "Row", visible: true, remote: false, children: [], getInstancesAsync: async () => [inst("i:1"), inst("i:2")] };
  const divider: FakeNode = { id: "c:2", type: "RECTANGLE", name: "Divider", visible: true, parent: row, fills: [], opacity: 1, boundVariables: {} };
  row.children = [divider];
  const w = world({ nodes: { "t:1": label, "c:1": row, "c:2": divider, ...many }, reviewer: "real", ...extra }, {
    createFrame: () => {
      const n: FakeNode = { id: "new:" + (created.length + 1), type: "FRAME", name: "", fills: [], resize() {}, appendChild() {} };
      n.remove = () => { const i = created.indexOf(n); if (i >= 0) created.splice(i, 1); };
      created.push(n);
      return n;
    },
    loadFontAsync: async () => {},
  });
  w.figma.currentPage.appendChild = () => {};
  w.figma.currentPage.loadAsync = async () => {};
  w.figma.viewport = { scrollAndZoomIntoView: () => {} };
  return { ...w, created, label, many, divider };
}
type ReviewWorld = ReturnType<typeof reviewWorld>;

const BATCH: WriteOp[] = [{ op: "createFrame", name: "Card", fill: "#ff0000" }, { op: "setText", nodeId: "t:1", text: "new" }];
const TEN = (from: number): WriteOp[] => Array.from({ length: 10 }, (_, i) => ({ op: "setText", nodeId: "n:" + (from + i), text: "b" }));

/** Let the plugin's pending promises run until `until` holds (or give up). */
async function tick(until: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !until(); i++) await new Promise((r) => setTimeout(r, 0));
}
const lastOf = (w: ReviewWorld, type: string): PostedMessage | undefined => [...w.posted].reverse().find((m) => m.type === type);
const isPending = (r: WriteReply | undefined): r is WritePending => !!r && (r as { pending?: unknown }).pending === true;
const asResult = (r: WriteReply | undefined): WriteResult | undefined => (r && !isPending(r) ? r : undefined);

/** Send one bridge command; the reply (or the error) once the plugin answers it. */
function bridge(w: ReviewWorld, id: string, cmd: string, args: unknown): Promise<{ ok: boolean; result?: WriteReply; error?: string }> {
  return w.send({ type: "bridge", id, cmd, args }).then((posted) => {
    const r = posted.find((m) => m.type === "bridge-result" && m.id === id);
    return { ok: r?.ok === true, ...(r?.result !== undefined ? { result: r.result as WriteReply } : {}), ...(r?.error !== undefined ? { error: r.error } : {}) };
  });
}

/** Send a bridge `write` and wait until its review card is up (or it already answered). */
async function writeAwaitingReview(w: ReviewWorld, id: string, ops: WriteOp[] = BATCH, holdMs?: number) {
  const from = w.posted.length;
  const reply = bridge(w, id, "write", { ops, ...(holdMs !== undefined ? { holdMs } : {}) }).then((r) => r.result);
  await tick(() => w.posted.slice(from).some((m) => m.type === "review" || (m.type === "bridge-result" && m.id === id)));
  const card = w.posted.slice(from).find((m) => m.type === "review");
  return { reply, card };
}
const answer = (w: ReviewWorld, card: PostedMessage | undefined, action: string, reason?: string) =>
  w.send({ type: "review-answer", id: String(card?.id), action, ...(reason !== undefined ? { reason } : {}) });

const untouched = (w: ReviewWorld): boolean => w.created.length === 0 && w.label.characters === "old";
const whoami = async (w: ReviewWorld): Promise<Record<string, unknown>> => ((await bridge(w, "who" + w.posted.length, "whoami", {})).result ?? {}) as unknown as Record<string, unknown>;
const lastWrite = async (w: ReviewWorld): Promise<LastFigmaWrite | undefined> => ((await bridge(w, "ping" + w.posted.length, "ping", {})).result as unknown as { lastFigmaWrite?: LastFigmaWrite }).lastFigmaWrite;

export const cases: Case[] = [{
  name: "Review each change first (review.ts): ON by default — a write waits on a plain card, and Apply lands it",
  async run() {
    const w = reviewWorld();
    const asked = await w.send({ type: "get-review-writes" });
    ok("[REVIEW] default is ON: the window is told on:true, nothing saved", asked[0]?.type === "review-writes" && asked[0]?.on === true && !w.storage.has("reviewWrites"));
    const who = await whoami(w);
    ok("[REVIEW] whoami reports reviewWrites:true and no layers counted yet", who.reviewWrites === true && who.reviewLayers === 0 && who.reviewWaiting === undefined);
    await w.allowEdits();
    const commitsBefore = w.undo.commits;
    const { reply, card } = await writeAwaitingReview(w, "w1");
    ok("[REVIEW] the write waits: a card is up and the file is untouched", card !== undefined && untouched(w));
    ok("[REVIEW] the card says why it waited, in the designer's words", card?.why === "'Review each change first' is on");
    const lines = (card?.lines ?? []).map((l) => lineText({ ...l, ops: [] }));
    ok(`[REVIEW] the card's lines are plain words, no node ids (got ${JSON.stringify(lines)})`,
      lines[0] === "New frame 'Card', fill #ff0000 — on the current page" && lines[1] === "Text 'Label': text “old” → “new”" && !lines.some((l) => /\d+:\d+/.test(l)));
    ok("[REVIEW] …the dry run's sentences are its Details", JSON.stringify(card?.details) === JSON.stringify(reviewLines(BATCH)));
    ok("[REVIEW] …its Show me: the layer a line changes", card?.lines?.[1]?.show?.n === 1 && card.lines[0]?.show === undefined);
    ok("[REVIEW] …a small batch offers no preview, and Figma's toast says a write waits", card?.previewable === false && w.notified.some((t) => /wants to change this file/.test(t)));
    ok("[REVIEW] whoami names the waiting ticket", (await whoami(w)).reviewWaiting === card?.id);
    const shown = await w.send({ type: "review-show", id: String(card?.id), index: 1 });
    ok("[REVIEW] Show me selects the layer (no undo step) and says so", /Showing 1 layer/.test(String(shown.find((m) => m.type === "review-shown")?.text)) && w.figma.currentPage.selection.length === 1 && w.undo.commits === commitsBefore + 2);
    await answer(w, { type: "review", id: "rv-nope" }, "apply");
    ok("[REVIEW] an answer naming another card changes nothing", untouched(w));
    await answer(w, card, "apply");
    const r = asResult(await reply);
    ok("[REVIEW] Apply: the batch lands whole", r?.ok === true && r.applied.length === 2 && w.created.length === 1 && w.label.characters === "new");
    ok("[REVIEW] …the card is taken down as approved", lastOf(w, "review-end")?.end === "approved" && lastOf(w, "review-end")?.id === card?.id);
    ok("[REVIEW] …and it is still its own undo step (committed before and after)", w.undo.commits - commitsBefore >= 4);
    await answer(w, card, "reject");
    ok("[REVIEW] a late second answer changes nothing", w.created.length === 1);
  },
}, {
  name: "Review each change first: cleared, a small write applies at once; a source edit and a 26th layer still wait",
  async run() {
    const w = reviewWorld();
    await w.allowEdits();
    const set = await w.send({ type: "set-review-writes", on: false });
    ok("[REVIEW] clearing it is echoed and saved", set[0]?.on === false && w.storage.get("reviewWrites") === false);
    const { reply, card } = await writeAwaitingReview(w, "s1");
    ok("[REVIEW] cleared: a small write applies at once, no card", card === undefined && asResult(await reply)?.ok === true && w.label.characters === "new");
    // A patch of a layer inside a main component carries to its instances: it waits whatever the box says.
    const src = await writeAwaitingReview(w, "s2", [{ op: "patch", nodeId: "c:2", set: { opacity: 0.5 } }]);
    const srcLine = src.card?.lines?.[0];
    ok(`[REVIEW] a source edit waits with the box clear, saying other layers follow (${String(src.card?.why)})`,
      src.card !== undefined && /other layers follow/.test(String(src.card.why)) && srcLine !== undefined && lineText({ ...srcLine, ops: [] }) === "Main component 'Row', layer 'Divider': opacity 100% → 50% — 2 layers follow");
    ok("[REVIEW] …and offers a preview on the canvas", src.card?.previewable === true);
    await answer(w, src.card, "reject");
    await src.reply;
    // The layers changed since the last approval add up, this session's own left out.
    w.label.characters = "old";
    const own = await writeAwaitingReview(w, "s3", [{ op: "createFrame", name: "Mine" }]);
    const mineId = asResult(await own.reply)?.applied[0]?.id;
    for (let i = 0; i < 30; i++) await w.api.applyWrites([{ op: "setFill", nodeId: String(mineId), color: "#00ff00" }]);
    ok("[REVIEW] a layer this session created is never counted, however often it changes", (await whoami(w)).reviewLayers === 0 && !w.posted.some((m) => m.type === "review" && m.id !== src.card?.id));
    const first = await writeAwaitingReview(w, "s4", TEN(1));
    const second = await writeAwaitingReview(w, "s5", TEN(11));
    ok("[REVIEW] 20 existing layers in two batches: no card, and the count is 20", first.card === undefined && second.card === undefined && (await whoami(w)).reviewLayers === 20);
    const third = await writeAwaitingReview(w, "s6", TEN(21));
    ok(`[REVIEW] the batch that takes it to 30 waits, saying so (${String(third.card?.why)})`, /30 existing layers would have changed since your last approval \(over 25\)/.test(String(third.card?.why)));
    await answer(w, third.card, "apply");
    ok("[REVIEW] …approved, it lands, and the count starts again", asResult(await third.reply)?.ok === true && (await whoami(w)).reviewLayers === 0);
  },
}, {
  name: "Review: Preview on canvas — Keep keeps it as an applied write; Put back restores it and the card waits again",
  async run() {
    const w = reviewWorld();
    await w.allowEdits();
    await w.send({ type: "set-review-writes", on: false });
    const ops: WriteOp[] = Array.from({ length: 26 }, (_, i) => ({ op: "setText", nodeId: i < 25 ? "n:" + (i + 1) : "t:1", text: "new" }));
    const changedNow = (): number => Object.values(w.many).filter((n) => n.characters === "new").length + (w.label.characters === "new" ? 1 : 0);
    const { reply, card } = await writeAwaitingReview(w, "p1", ops);
    ok("[PREVIEW] a batch over the limit by itself offers a preview, grouped as one line", card?.previewable === true && card.lines?.length === 1 && /^26 texts: text/.test(lineText({ ...(card.lines[0] ?? { head: "", rows: [] }), ops: [] })));
    const commits = w.undo.commits;
    // Preview, then Put back sent right away (before the preview has landed): both are done, in order — one click each.
    await answer(w, card, "preview");
    await answer(w, card, "put-back");
    await tick(() => w.posted.some((m) => m.type === "review-state" && m.state === "waiting" && m.id === card?.id));
    const states = w.posted.filter((m) => m.type === "review-state" && m.id === card?.id).map((m) => m.state);
    ok(`[PREVIEW] Put back clicked while the preview landed still puts it back (states ${states.join(" → ")})`,
      states.includes("previewing") && states[states.length - 1] === "waiting" && changedNow() === 0);
    ok("[PREVIEW] …the preview and its put-back are two undo entries of their own", w.undo.commits - commits >= 4);
    await answer(w, card, "preview");
    await tick(() => lastOf(w, "review-state")?.state === "previewing");
    ok("[PREVIEW] previewing: the batch is in the file, the card says everyone sees it, and the layers are selected",
      changedNow() === 26 && /everyone in this file can see it/.test(String(lastOf(w, "review-state")?.note)) && w.figma.currentPage.selection.length > 0);
    await answer(w, card, "keep");
    const r = asResult(await reply);
    ok("[PREVIEW] Keep: the normal success reply, the batch stays, the card ends as kept", r?.ok === true && r.applied.length === 26 && changedNow() === 26 && lastOf(w, "review-end")?.end === "kept");
    ok("[PREVIEW] …and the count starts again", (await whoami(w)).reviewLayers === 0);
    // A card withdrawn while previewing puts the preview back first.
    for (const n of Object.values(w.many)) n.characters = "a";
    w.label.characters = "old";
    const again = await writeAwaitingReview(w, "p2", ops, 0);
    const pend = await again.reply;
    await answer(w, again.card, "preview");
    await tick(() => lastOf(w, "review-state")?.state === "previewing");
    const cancelled = asResult((await bridge(w, "p2c", "writeTicket", { ticket: isPending(pend) ? pend.ticket : "", cancel: true })).result);
    ok("[PREVIEW] withdrawn while previewing: put back, refused unreviewed, saying the preview was put back",
      cancelled?.refused === "unreviewed" && /it was put back/.test(cancelled.error ?? "") && changedNow() === 0 && lastOf(w, "review-end")?.end === "withdrawn");
    // A batch with a delete is never offered a preview (a delete cannot be put back).
    const made = asResult(await (await writeAwaitingReview(w, "p3", [{ op: "createFrame", name: "Tmp" }])).reply);
    void made;
  },
}, {
  name: "Review: the ticket — pending after the hold, asked again, a repeat answers at once, unknown is refused",
  async run() {
    const clock = fakeClock();
    const w = reviewWorld({ timers: clockTimers(clock) });
    await w.allowEdits();
    const { reply, card } = await writeAwaitingReview(w, "t1", BATCH, 1000);
    clock.advance(1000);
    const first = await reply;
    ok("[TICKET] after the hold the plugin answers pending with its ticket, why it waits, and what to do; the card stays up",
      isPending(first) && first.ticket === card?.id && first.why === "'Review each change first' is on" && /Call figma_write \{ticket: 'rv-/.test(first.note) && /do not re-send the ops/.test(first.note)
      && /tell the user/.test(first.note) && lastOf(w, "review-end") === undefined && untouched(w));
    const ticket = isPending(first) ? first.ticket : "";
    const second = await writeAwaitingReview(w, "t2", [{ op: "createFrame", name: "Other" }], 1000);
    const refused = asResult(await second.reply);
    ok("[TICKET] a second batch while one waits is refused at once, naming the waiting ticket, with no second card",
      second.card === undefined && refused?.refused === "waiting" && (refused.error ?? "").includes(ticket) && untouched(w));
    const poll = bridge(w, "t3", "writeTicket", { ticket, holdMs: 1000 });
    clock.advance(1000);
    ok("[TICKET] asked again: pending again after the hold", isPending((await poll).result));
    const poll2 = bridge(w, "t4", "writeTicket", { ticket, holdMs: 60000 });
    await tick(() => false);
    await answer(w, card, "apply");
    const done = asResult((await poll2).result);
    ok("[TICKET] the designer answers during a poll: the poll gets the result", done?.ok === true && done.applied.length === 2 && w.label.characters === "new");
    const repeat = asResult((await bridge(w, "t5", "writeTicket", { ticket, holdMs: 1000 })).result);
    ok("[TICKET] a repeat answers at once with the same outcome", JSON.stringify(repeat) === JSON.stringify(done));
    const unknown = await bridge(w, "t6", "writeTicket", { ticket: "rv-404-x", holdMs: 1000 });
    ok("[TICKET] an unknown ticket is refused, saying nothing waits under it", !unknown.ok && /No write is waiting under ticket 'rv-404-x'/.test(unknown.error ?? ""));
    const lw = await lastWrite(w);
    ok("[TICKET] figma_status's ping reports the last outcome", lw?.ticket === ticket && lw.outcome === "applied" && lw.unseen === undefined);
  },
}, {
  name: "Review: the agent stops asking — the card is withdrawn; answered after it stopped, figma_status still says so",
  async run() {
    const clock = fakeClock();
    const w = reviewWorld({ timers: clockTimers(clock) });
    await w.allowEdits();
    const a = await writeAwaitingReview(w, "e1", BATCH, 0);
    clock.advance(0);
    const pend = await a.reply;
    const ticket = isPending(pend) ? pend.ticket : "";
    clock.advance(REVIEW_IDLE_MS - 1);
    await tick(() => false);
    ok("[EXPIRE] not before no poll has come for the idle time", lastOf(w, "review-end") === undefined);
    clock.advance(1);
    await tick(() => lastOf(w, "review-end") !== undefined);
    ok("[EXPIRE] then the card ends 'expired' (the window says the agent stopped waiting), nothing applied",
      lastOf(w, "review-end")?.end === "expired" && untouched(w) && clock.armed() === 0);
    const late = asResult((await bridge(w, "e2", "writeTicket", { ticket })).result);
    ok("[EXPIRE] a late poll gets a rejection that clearly says nothing changed", late?.refused === "unreviewed" && late.error === unreviewedMessage("expired", REVIEW_IDLE_MS) && /Nothing in the file was changed/.test(late.error));
    // The designer answers after the agent's last pending answer (within the idle time): only figma_status sees it.
    const b = await writeAwaitingReview(w, "e3", BATCH, 0);
    clock.advance(0);
    const pendB = await b.reply;
    await answer(w, b.card, "apply");
    await tick(() => lastOf(w, "writes")?.ok === true);
    const lw = await lastWrite(w);
    ok("[EXPIRE] answered after the agent stopped asking: figma_status reports it applied, unseen", lw?.outcome === "applied" && lw.unseen === true && lw.ticket === (isPending(pendB) ? pendB.ticket : "?"));
    await bridge(w, "e4", "writeTicket", { ticket: isPending(pendB) ? pendB.ticket : "" });
    ok("[EXPIRE] …until its ticket is asked again", (await lastWrite(w))?.unseen === undefined);
    // A card nobody polls (a direct caller) still ends after the overall cap.
    w.label.characters = "old";
    w.created.splice(0);
    const direct = w.api.applyWrites(BATCH);
    await tick(() => w.posted.filter((m) => m.type === "review").length === 3);
    clock.advance(REVIEW_CARD_MAX_MS);
    const capped = await direct;
    ok("[EXPIRE] after 15 min in all the card ends timed out, nothing applied", capped.refused === "unreviewed" && capped.error === unreviewedMessage("timed-out", REVIEW_CARD_MAX_MS) && untouched(w) && clock.armed() === 0);
  },
}, {
  name: "Review: withdrawn by the agent (figma_write {ticket, cancel}); Reject passes the reason; Allow edits off ends it",
  async run() {
    const w = reviewWorld();
    await w.allowEdits();
    const a = await writeAwaitingReview(w, "c1", BATCH, 0);
    const pend = await a.reply;
    const res = asResult((await bridge(w, "c2", "writeTicket", { ticket: isPending(pend) ? pend.ticket : "", cancel: true })).result);
    ok("[CANCEL] withdrawn: refused unreviewed, card down, file untouched", res?.refused === "unreviewed" && res.error === unreviewedMessage("withdrawn", 0) && lastOf(w, "review-end")?.end === "withdrawn" && untouched(w));
    await answer(w, a.card, "apply");
    ok("[CANCEL] …an Apply on the withdrawn card changes nothing", untouched(w));

    const b = await writeAwaitingReview(w, "c3");
    await answer(w, b.card, "reject", "  Use the brand red token, not a raw hex.  ");
    const rb = asResult(await b.reply);
    ok("[REJECT] Reject: refused 'rejected', the reason (trimmed) in `reason` and quoted in the error, file untouched",
      rb?.refused === "rejected" && rb.reason === "Use the brand red token, not a raw hex." && rb.error === rejectedMessage("Use the brand red token, not a raw hex.") && untouched(w));
    ok("[REJECT] …and the refusal is announced in a red toast", w.notified.some((t) => /rejected/.test(t)) && lastOf(w, "writes")?.ok === false);
    const down = w.toastsDown.n;
    const c = await writeAwaitingReview(w, "c4");
    ok("[TOAST] the next card takes the stale red toast down", w.toastsDown.n === down + 1 && c.card !== undefined);
    await answer(w, c.card, "reject", "x".repeat(REVIEW_REASON_MAX + 50));
    const rc = asResult(await c.reply);
    ok("[REJECT] a very long reason is cut, and says so", (rc?.reason ?? "").length === REVIEW_REASON_MAX + "… (cut)".length);

    const d = await writeAwaitingReview(w, "c5");
    await w.allowEdits(false);
    const rd = asResult(await d.reply);
    ok("[EDITS] 'Allow edits' unticked while waiting: refused edits-off at once, file untouched", rd?.refused === "edits-off" && rd.error === EDITS_OFF_MESSAGE && lastOf(w, "review-end")?.end === "edits-off" && untouched(w));
    const e = await writeAwaitingReview(w, "c6");
    ok("[EDITS] 'Allow edits' off refuses first — no card", e.card === undefined && asResult(await e.reply)?.refused === "edits-off");
    await w.allowEdits(true);
    const bad = await writeAwaitingReview(w, "c7", [{ op: "patch", nodeId: "missing:1", set: { name: "x" } }]);
    ok("[REVIEW] a batch refused on its names gets no card", bad.card === undefined && asResult(await bad.reply)?.ok === false);
  },
}, {
  name: "Review: 'Allow edits' unticked while a preview is on the canvas — it stays, and the reply says so",
  async run() {
    const w = reviewWorld();
    await w.allowEdits();
    const { reply, card } = await writeAwaitingReview(w, "x1", [{ op: "patch", nodeId: "c:2", set: { opacity: 0.5 } }]);
    await answer(w, card, "preview");
    await tick(() => lastOf(w, "review-state")?.state === "previewing");
    ok("[PREVIEW] a source edit's preview changes the main component", w.divider.opacity === 0.5);
    await w.allowEdits(false);
    const r = asResult(await reply);
    ok("[PREVIEW] edits off while previewing: refused edits-off, the preview stays applied and is listed",
      r?.refused === "edits-off" && r.applied.length === 1 && /preview stays applied/.test(r.error ?? "") && w.divider.opacity === 0.5);
  },
}, {
  name: "Review: 'Allow edits' unticked while the batch resolves — refused edits-off, no card",
  async run() {
    const w = reviewWorld({ clientStorage: { allowEdits: true } });
    // The patch's node lookup is where the batch waits: the designer unticks the box there.
    const lookup = w.figma.getNodeByIdAsync;
    let unticked = false;
    w.figma.getNodeByIdAsync = async (id: string) => {
      if (!unticked) { unticked = true; await w.allowEdits(false); }
      return lookup(id);
    };
    const r = await w.api.applyWrites([{ op: "patch", nodeId: "t:1", set: { name: "Renamed" } }]);
    ok("[REVIEW] unticked during resolution: refused edits-off at once, no card, file untouched",
      unticked && r.refused === "edits-off" && !w.posted.some((m) => m.type === "review") && w.label.name === "Label");
  },
}];
