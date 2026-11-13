// The designer's review of a write (review.ts): "Review each write" holds a batch until the designer applies or rejects
// it in the plugin window, and every way the wait can end without an Apply refuses the batch with nothing changed.
import { EDITS_OFF_MESSAGE, rejectedMessage, reviewLines, REVIEW_REASON_MAX, unreviewedMessage, writeOpPreview, type WriteOp, type WriteResult } from "../../bridge/src/commands.ts";
import { REVIEW_WAIT_MS } from "../../bridge/src/timeouts.ts";
import { ok } from "../assert.ts";
import { fakeClock } from "../fake-clock.ts";
import { clockTimers, textRuns, type FakeNode, type PostedMessage, type Scene } from "../fake-figma.ts";
import type { Case } from "./helpers.ts";
import { world } from "./scene.ts";

/** A writable file: one text node ("t:1", "old"), frames the plugin creates are listed in `created`. */
function reviewWorld(extra: Scene = {}) {
  const created: FakeNode[] = [];
  const label: FakeNode = textRuns({ id: "t:1", type: "TEXT", name: "Label", characters: "old", fontName: { family: "Inter", style: "Regular" }, getRangeAllFontNames: () => Object.freeze([{ family: "Inter", style: "Regular" }]) });
  const w = world({ nodes: { "t:1": label }, ...extra }, {
    createFrame: () => {
      const n: FakeNode = { id: "new:frame", type: "FRAME", name: "", fills: [], resize() {}, appendChild() {} };
      n.remove = () => { const i = created.indexOf(n); if (i >= 0) created.splice(i, 1); };
      created.push(n);
      return n;
    },
    loadFontAsync: async () => {},
  });
  w.figma.currentPage.appendChild = () => {};
  w.figma.currentPage.loadAsync = async () => {};
  return { ...w, created, label };
}
type ReviewWorld = ReturnType<typeof reviewWorld>;

const BATCH: WriteOp[] = [{ op: "createFrame", name: "Card", fill: "#ff0000" }, { op: "setText", nodeId: "t:1", text: "new" }];

/** Let the plugin's pending promises run until `until` holds (or give up). */
async function tick(until: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !until(); i++) await new Promise((r) => setTimeout(r, 0));
}
const lastOf = (w: ReviewWorld, type: string): PostedMessage | undefined => [...w.posted].reverse().find((m) => m.type === type);

/** Send a bridge `write` and wait until its review card is up (or it already answered). */
async function writeAwaitingReview(w: ReviewWorld, id: string, ops: WriteOp[] = BATCH) {
  const from = w.posted.length;
  const reply = w.send({ type: "bridge", id, cmd: "write", args: { ops } }).then((posted) => {
    const r = posted.find((m) => m.type === "bridge-result" && m.id === id);
    return (r && r.result) as WriteResult | undefined;
  });
  await tick(() => w.posted.slice(from).some((m) => m.type === "review" || (m.type === "bridge-result" && m.id === id)));
  const card = w.posted.slice(from).find((m) => m.type === "review");
  return { reply, card };
}

const untouched = (w: ReviewWorld): boolean => w.created.length === 0 && w.label.characters === "old";

export const cases: Case[] = [{
  name: "Review each write (review.ts): off by default — writes apply directly, as before",
  async run() {
    const w = reviewWorld();
    const asked = await w.send({ type: "get-review-writes" });
    ok("[REVIEW] default is OFF: the window is told on:false, nothing saved", asked[0]?.type === "review-writes" && asked[0]?.on === false && !w.storage.has("reviewWrites"));
    const who = await w.send({ type: "bridge", id: "who", cmd: "whoami", args: {} });
    ok("[REVIEW] whoami reports reviewWrites:false", (who.find((m) => m.type === "bridge-result")?.result as { reviewWrites?: unknown } | undefined)?.reviewWrites === false);
    await w.allowEdits();
    const { reply, card } = await writeAwaitingReview(w, "w0");
    const r = await reply;
    ok("[REVIEW] off: the write applies at once, no card", card === undefined && r?.ok === true && r.applied.length === 2 && w.created.length === 1 && w.label.characters === "new");
  },
}, {
  name: "Review each write: 'Allow edits' off refuses first — no card",
  async run() {
    const w = reviewWorld({ clientStorage: { reviewWrites: true } });
    const { reply, card } = await writeAwaitingReview(w, "w1");
    const r = await reply;
    ok("[REVIEW] edits off + review on: refused edits-off, no card, file untouched",
      card === undefined && r?.refused === "edits-off" && r.error === EDITS_OFF_MESSAGE && untouched(w));
  },
}, {
  name: "Review each write: the card lists the batch in plain words (the dry run's description); Apply lands it",
  async run() {
    const w = reviewWorld();
    await w.allowEdits();
    const set = await w.send({ type: "set-review-writes", on: true });
    ok("[REVIEW] ticking it is echoed and saved", set[0]?.type === "review-writes" && set[0]?.on === true && w.storage.get("reviewWrites") === true);
    const who = await w.send({ type: "bridge", id: "who", cmd: "whoami", args: {} });
    ok("[REVIEW] whoami reports reviewWrites:true", (who.find((m) => m.type === "bridge-result")?.result as { reviewWrites?: unknown } | undefined)?.reviewWrites === true);

    const commitsBefore = w.undo.commits;
    const { reply, card } = await writeAwaitingReview(w, "w2");
    ok("[REVIEW] the write waits: a card is up and the file is untouched", card !== undefined && untouched(w));
    ok("[REVIEW] the card shows one plain line per op — commands.ts reviewLines, built from the dry run's preview",
      JSON.stringify(card?.lines) === JSON.stringify(reviewLines(BATCH)) && card?.lines?.length === 2 &&
      card.lines[0] === "creates a frame 'Card' — new node on the current page, fill #ff0000" && /text becomes "new"/.test(card.lines[1] ?? "") && card.waitMs === REVIEW_WAIT_MS);
    // An answer for a card that is not up is ignored.
    await w.send({ type: "review-answer", id: "review-nope", apply: true });
    ok("[REVIEW] an answer naming another card changes nothing", untouched(w));
    await w.send({ type: "review-answer", id: String(card?.id), apply: true });
    const r = await reply;
    ok("[REVIEW] Apply: the batch lands whole", r?.ok === true && r.applied.length === 2 && w.created.length === 1 && w.label.characters === "new");
    ok("[REVIEW] …the card is taken down as approved", lastOf(w, "review-end")?.end === "approved" && lastOf(w, "review-end")?.id === card?.id);
    ok("[REVIEW] …and it is still its own undo step (committed before and after)", w.undo.commits - commitsBefore >= 2);
    // A second answer to the same card is ignored (the window disables its buttons; this is the main thread's half).
    await w.send({ type: "review-answer", id: String(card?.id), apply: false });
    ok("[REVIEW] a late second answer changes nothing", w.created.length === 1);

    // Every field a create sets is on its line (the live check found the fill missing).
    const made = reviewLines([{ op: "createFrame", name: "Row", width: 200, height: 40, layoutMode: "HORIZONTAL", itemSpacing: 8, padding: [1, 2, 3, 4], fill: "#00ff00", parentId: "1:2" }, { op: "createText", text: "Hello", fontSize: 18, fill: "#111111" }]);
    ok("[REVIEW] a create's line names its size, auto-layout, padding and fill; a text's its size and fill",
      made[0] === "creates a frame 'Row' — new node under 1:2, 200×40, row auto-layout, gap 8, padding 1 2 3 4, fill #00ff00"
      && made[1] === "creates a text \"Hello\" — new node on the current page, size 18, fill #111111");
    // A createTree and a patch show exactly the dry run's `change` sentence.
    const ops: WriteOp[] = [{ op: "createTree", tree: { name: "Panel", children: [{ text: "Hi" }] } }, { op: "patch", nodeId: "t:1", set: { name: "Title" } }];
    const lines = reviewLines(ops);
    ok("[REVIEW] createTree/patch lines are the dry run's change sentences", lines[0] === writeOpPreview(ops[0] as WriteOp, 0).change && lines[1] === writeOpPreview(ops[1] as WriteOp, 1).change);
  },
}, {
  name: "Review each write: Reject leaves the file untouched and the typed reason reaches the reply",
  async run() {
    const w = reviewWorld({ clientStorage: { reviewWrites: true } });
    await w.allowEdits();
    const { reply, card } = await writeAwaitingReview(w, "w3");
    await w.send({ type: "review-answer", id: String(card?.id), apply: false, reason: "  Use the brand red token, not a raw hex.  " });
    const r = await reply;
    ok("[REVIEW] Reject: refused 'rejected', nothing applied, file untouched", r?.ok === false && r.refused === "rejected" && r.applied.length === 0 && untouched(w));
    ok("[REVIEW] …the reason (trimmed) is in `reason` and quoted in the error",
      r?.reason === "Use the brand red token, not a raw hex." && r.error === rejectedMessage("Use the brand red token, not a raw hex.") && /Their reason: "Use the brand red token/.test(r.error));
    ok("[REVIEW] …and the refusal is announced", w.notified.some((t) => /rejected/.test(t)) && lastOf(w, "writes")?.ok === false);

    const second = await writeAwaitingReview(w, "w4");
    await w.send({ type: "review-answer", id: String(second.card?.id), apply: false, reason: "   " });
    const r2 = await second.reply;
    ok("[REVIEW] Reject with no reason: no `reason`, the error says none was given", r2?.refused === "rejected" && r2.reason === undefined && /no reason/.test(r2.error ?? "") && untouched(w));

    const third = await writeAwaitingReview(w, "w5");
    await w.send({ type: "review-answer", id: String(third.card?.id), apply: false, reason: "x".repeat(REVIEW_REASON_MAX + 50) });
    const r3 = await third.reply;
    ok("[REVIEW] a very long reason is cut, and says so", (r3?.reason ?? "").length === REVIEW_REASON_MAX + "… (cut)".length && /\(cut\)$/.test(r3?.reason ?? ""));
  },
}, {
  name: "Review each write: nobody answers — refused unreviewed when the wait runs out, never a hang",
  async run() {
    const clock = fakeClock();
    const w = reviewWorld({ clientStorage: { reviewWrites: true }, timers: clockTimers(clock) });
    await w.allowEdits();
    const { reply, card } = await writeAwaitingReview(w, "w6");
    ok("[REVIEW] the card's wait is armed", card !== undefined && clock.armed() === 1);
    clock.advance(REVIEW_WAIT_MS - 1);
    await tick(() => false);
    ok("[REVIEW] …not before the wait is up", lastOf(w, "review-end") === undefined && untouched(w));
    clock.advance(1);
    const r = await reply;
    ok("[REVIEW] timed out: refused 'unreviewed' with the plain reason, file untouched",
      r?.refused === "unreviewed" && r.error === unreviewedMessage("timed-out", REVIEW_WAIT_MS) && untouched(w));
    ok("[REVIEW] …the card is taken down as timed-out, and no timer is left", lastOf(w, "review-end")?.end === "timed-out" && clock.armed() === 0);
    await w.send({ type: "review-answer", id: String(card?.id), apply: true });
    ok("[REVIEW] an Apply after it timed out changes nothing", untouched(w));
  },
}, {
  name: "Review each write: the bridge gives up or drops, the designer cancels, or 'Allow edits' goes off — the card ends",
  async run() {
    const clock = fakeClock();
    const w = reviewWorld({ clientStorage: { reviewWrites: true }, timers: clockTimers(clock) });
    await w.allowEdits();

    // The bridge abandoned this request (its caller timed out, or the agent cancelled the call).
    const a = await writeAwaitingReview(w, "w7");
    await w.send({ type: "cancel", id: "w7" });
    const ra = await a.reply;
    ok("[REVIEW] bridge cancel by id: refused 'unreviewed' (withdrawn), file untouched, card down, timer cleared",
      ra?.refused === "unreviewed" && ra.error === unreviewedMessage("withdrawn", REVIEW_WAIT_MS) && untouched(w) && lastOf(w, "review-end")?.end === "withdrawn" && clock.armed() === 0);
    await w.send({ type: "review-answer", id: String(a.card?.id), apply: true });
    ok("[REVIEW] …an Apply on the withdrawn card changes nothing", untouched(w));

    // The socket closed (the MCP server or the bridge went away).
    const b = await writeAwaitingReview(w, "w8");
    await w.send({ type: "cancel", scope: "bridge" });
    const rb = await b.reply;
    ok("[REVIEW] bridge dropped: withdrawn, file untouched", rb?.refused === "unreviewed" && /withdrawn/.test(rb.error ?? "") && untouched(w));

    // The designer pressed the window's Cancel while it waited.
    const c = await writeAwaitingReview(w, "w9");
    await w.send({ type: "cancel" });
    const rc = await c.reply;
    ok("[REVIEW] designer's Cancel: refused 'unreviewed' (cancelled), file untouched", rc?.refused === "unreviewed" && rc.error === unreviewedMessage("cancelled", REVIEW_WAIT_MS) && untouched(w));

    // "Allow edits" unticked while it waited: refused as edits-off at once.
    const d = await writeAwaitingReview(w, "w10");
    await w.allowEdits(false);
    const rd = await d.reply;
    ok("[REVIEW] 'Allow edits' unticked while waiting: refused edits-off at once, file untouched",
      rd?.refused === "edits-off" && rd.error === EDITS_OFF_MESSAGE && untouched(w) && lastOf(w, "review-end")?.end === "edits-off" && clock.armed() === 0);

    // A batch that would be refused never puts a card up.
    await w.allowEdits(true);
    const bad = await writeAwaitingReview(w, "w11", [{ op: "patch", nodeId: "missing:1", set: { name: "x" } }]);
    const rbad = await bad.reply;
    ok("[REVIEW] a batch refused on its names gets no card", bad.card === undefined && rbad?.ok === false && rbad.refused === undefined);

    // Review turned off again: the next write applies directly.
    await w.send({ type: "set-review-writes", on: false });
    const e = await writeAwaitingReview(w, "w12");
    const re = await e.reply;
    ok("[REVIEW] unticked: writes apply directly again", e.card === undefined && re?.ok === true && w.label.characters === "new");
  },
}, {
  name: "Review each write: 'Allow edits' unticked while the batch resolves — refused edits-off, no card",
  async run() {
    const w = reviewWorld({ clientStorage: { reviewWrites: true, allowEdits: true } });
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
}, {
  name: "Review each write: direct applyWrites (the test surface) meets the same review",
  async run() {
    const w = reviewWorld({ clientStorage: { reviewWrites: true, allowEdits: true } });
    const pending = w.api.applyWrites([{ op: "createFrame", name: "Card", fill: "#ff0000" }, { op: "setText", nodeId: "t:1", text: "new" }]);
    await tick(() => w.posted.some((m) => m.type === "review"));
    const card = lastOf(w, "review");
    ok("[REVIEW] a direct caller waits for the card too", card !== undefined && untouched(w));
    await w.send({ type: "review-answer", id: String(card?.id), apply: false, reason: "not now" });
    const r = await pending;
    ok("[REVIEW] …and a Reject refuses it the same way", r.refused === "rejected" && r.reason === "not now" && untouched(w));
  },
}];
