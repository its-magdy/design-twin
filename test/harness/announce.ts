// What a write says when it changed nothing (writes.ts announce, #206): a batch refused before any op ran — an unknown
// image hash, a name that resolves to nothing, a bad op, a bad image table, Dev Mode, an op that failed and put itself
// back, a batch whose file changed while it waited for review, a write that threw — says so in Figma's toast AND
// replaces the plugin window's "Applying edits…" line (a `writes` message inside the write's run). An empty batch says
// nothing; a batch refused in its run because another waits for review says so on the status line only (the card's
// toast is up), and one refused before any run because a card is up says so in a toast only (the card stays).
import { readdirSync, readFileSync } from "node:fs";
import type { WriteOp } from "../../bridge/src/commands.ts";
import { ok } from "../assert.ts";
import { markRemoved, peekRemoved, type FakeCollection, type FakeNode, type PostedMessage } from "../fake-figma.ts";
import type { Case } from "./helpers.ts";
import { modeNode, modeScene, treeWorld } from "./writes.ts";

type World = Awaited<ReturnType<typeof treeWorld>>;

const HEAD = "Design Twin refused an edit request — nothing changed: ";
const UNKNOWN_HASH = "e".repeat(40);
const writesOf = (posted: readonly PostedMessage[]): PostedMessage[] => posted.filter((m) => m.type === "writes");
const lastWrites = (w: World): PostedMessage | undefined => [...w.posted].reverse().find((m) => m.type === "writes");

/** Let the plugin's pending promises run until `until` holds (or give up). */
async function tick(until: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !until(); i++) await new Promise((r) => setTimeout(r, 0));
}

/** One batch sent over the bridge, the way figma_write sends it: what the plugin posted while it ran. */
async function bridgeWrite(w: World, id: string, ops: WriteOp[], images?: Record<string, string>): Promise<PostedMessage[]> {
  return w.send({ type: "bridge", id, cmd: "write", args: { ops, ...(images ? { images } : {}) } });
}

/** The WriteResult a bridge write replied with. */
function replyOf(posted: readonly PostedMessage[]): { ok?: unknown; error?: unknown; refused?: unknown; applied?: unknown; images?: unknown } {
  const reply = posted.find((m) => m.type === "bridge-result");
  return reply && typeof reply.result === "object" && reply.result !== null ? reply.result : {};
}

/** A w×h GIF's bytes, base64 (the fake's createImage reads its size; different sizes are different bytes). */
const gif = (width: number, height: number): string =>
  Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.from([width, 0, height, 0, 0, 0, 0]), Buffer.from([0x3b])]).toString("base64");

/** Count the images the plugin makes (figma.createImage calls, the ones that threw included): `made()`, and `put back`. */
function countImages(w: World): { made: () => number; restore: () => void } {
  let n = 0;
  const real = w.figma.createImage;
  w.figma.createImage = (data: Uint8Array) => { n++; return real(data); };
  return { made: () => n, restore: () => { w.figma.createImage = real; } };
}

/** The panel's line after the write's run began: the last `writes` message posted after its run-begin, and before
 *  its run-end (run-end leaves the status alone, ui.template.html). */
function panelLine(posted: readonly PostedMessage[]): { text: unknown; ok: unknown; inRun: boolean } | null {
  const begin = posted.findIndex((m) => m.type === "run-begin" && m.label === "write");
  const end = posted.findIndex((m) => m.type === "run-end");
  const at = posted.map((m) => m.type).lastIndexOf("writes");
  const m = posted[at];
  if (at < 0 || !m) return null;
  return { text: m.text, ok: m.ok, inRun: begin >= 0 && begin < at && (end < 0 || at < end) };
}

/** A refusal said exactly once, the same sentence in the toast and on the panel, red. */
function saidOnce(w: World, fromToast: number, fromPosted: number, text: string): boolean {
  const toasts = w.notified.slice(fromToast);
  const lines = writesOf(w.posted.slice(fromPosted));
  return toasts.length === 1 && toasts[0] === text && lines.length === 1 && lines[0]?.text === text && lines[0]?.ok === false && lines[0]?.applied === 0;
}

export const cases: Case[] = [{
  name: "A batch refused before any op runs says so (writes.ts announce, #206): toast + the panel's line, never silent",
  async run() {
    const w = await treeWorld();

    // Over the bridge, the case seen live: an image fill with a hash the file does not have.
    let t = w.notified.length;
    let p = w.posted.length;
    const hashPosted = await bridgeWrite(w, "h1", [{ op: "createTree", tree: { name: "Card", fills: [{ type: "image", hash: UNKNOWN_HASH }] } }]);
    const hashText = HEAD + "ops[0] (createTree): tree.fills[0]: the file has no image with hash '" + UNKNOWN_HASH + "' (a `hash` names an image already in the file: the `hash` of an image fill in the read, or one a write's reply gave in `images`)";
    const hashLine = panelLine(hashPosted);
    ok(`[ANNOUNCE] an unknown image hash over the bridge: a red toast and the panel's line say it was refused, nothing changed, and why (got ${JSON.stringify(w.notified.slice(t))})`,
      saidOnce(w, t, p, hashText) && !w.alive().some((n) => n.name === "Card"));
    ok("[ANNOUNCE] …the line lands inside the write's run, so it replaces \"Applying edits requested over the bridge…\"", hashLine !== null && hashLine.inRun);

    // A name that resolves to nothing, checked before the first op runs (here a node id the file does not have).
    t = w.notified.length;
    p = w.posted.length;
    await bridgeWrite(w, "h2", [{ op: "patch", nodeId: "404:1", set: { name: "x" } }]);
    const refText = String(lastWrites(w)?.text);
    ok(`[ANNOUNCE] an unresolved reference: refused, nothing changed, and why (got ${JSON.stringify(refText)})`,
      saidOnce(w, t, p, refText) && refText === HEAD + "ops[0] (patch): no node with id '404:1' (invalid or removed)");

    // Several problems: every one, on one line.
    t = w.notified.length;
    p = w.posted.length;
    await bridgeWrite(w, "h3", [{ op: "patch", nodeId: "404:1", set: { name: "x" } }, { op: "patch", nodeId: "404:2", set: { name: "y" } }]);
    const twoText = String(lastWrites(w)?.text);
    ok(`[ANNOUNCE] two problems: both named, one line, nothing-changed said once (got ${JSON.stringify(twoText)})`,
      saidOnce(w, t, p, twoText) && twoText === HEAD + "2 problems: ops[0] (patch): no node with id '404:1' (invalid or removed); ops[1] (patch): no node with id '404:2' (invalid or removed)");

    // A bad op (refused by the plugin's own WRITE_OPS check: the __designExport surface, the harness).
    t = w.notified.length;
    p = w.posted.length;
    const bad = await w.api.applyWrites([{ op: "createFrame", name: "Fine" }, { op: "nope" }]);
    ok(`[ANNOUNCE] a bad op: refused, nothing changed, and why (got ${JSON.stringify(w.notified.slice(t))})`,
      !bad.ok && saidOnce(w, t, p, HEAD + String(bad.error)) && !w.alive().some((n) => n.name === "Fine"));

    // A bad image table.
    t = w.notified.length;
    p = w.posted.length;
    const table = await w.api.applyWrites([{ op: "createFrame", name: "Fine" }], { "not-an-image-id": "AAAA" });
    ok(`[ANNOUNCE] a bad image table: refused, nothing changed, and why — said once (got ${JSON.stringify(w.notified.slice(t))})`,
      !table.ok && /Nothing was changed\.$/.test(String(table.error)) && saidOnce(w, t, p, HEAD + String(table.error).replace(/\. Nothing was changed\.$/, "")));

    // An op that fails as it runs, and puts itself back: nothing changed either.
    w.trap.add("cornerRadius");
    t = w.notified.length;
    p = w.posted.length;
    const failed = await w.api.applyWrites([{ op: "createTree", tree: { name: "Trapped", radius: 4 } }]);
    w.trap.delete("cornerRadius");
    ok(`[ANNOUNCE] an op that failed and put itself back: refused, nothing changed, and why (got ${JSON.stringify(w.notified.slice(t))} for ${JSON.stringify(failed)})`,
      !failed.ok && failed.applied.length === 0 && !failed.restored && /cornerRadius/.test(String(failed.error)) && saidOnce(w, t, p, HEAD + String(failed.error)) && !w.alive().some((n) => n.name === "Trapped"));

    // An op whose node read fails as it runs (nothing landed): the same.
    const realGet = w.figma.getNodeByIdAsync;
    w.figma.getNodeByIdAsync = async () => { throw new Error("the file went away"); };
    t = w.notified.length;
    p = w.posted.length;
    const lostPosted = await bridgeWrite(w, "h4", [{ op: "setText", nodeId: "1:2", text: "x" }]);
    w.figma.getNodeByIdAsync = realGet;
    const lostLine = panelLine(lostPosted);
    ok(`[ANNOUNCE] an op that failed before it changed anything, over the bridge: refused, nothing changed, and why (got ${JSON.stringify(w.notified.slice(t))})`,
      saidOnce(w, t, p, HEAD + "the file went away") && lostLine !== null && lostLine.inRun);

    // A write that throws (here: the editor check itself): said inside its run, then the bridge gets the error.
    Object.defineProperty(w.figma, "editorType", { configurable: true, get: () => { throw new Error("the editor went away"); } });
    t = w.notified.length;
    p = w.posted.length;
    const threwPosted = await bridgeWrite(w, "h6", [{ op: "createFrame", name: "Never" }]);
    Object.defineProperty(w.figma, "editorType", { configurable: true, writable: true, value: "figma" });
    const threwReply = threwPosted.find((m) => m.type === "bridge-result");
    const threwLine = panelLine(threwPosted);
    const threwText = "Design Twin could not run an edit request — nothing changed: the editor went away";
    ok(`[ANNOUNCE] a write that throws: the toast and the panel say it could not run (got ${JSON.stringify(w.notified.slice(t))}, reply ${JSON.stringify(threwReply)})`,
      threwReply?.ok === false && threwReply.error === "the editor went away" && saidOnce(w, t, p, threwText) && threwLine !== null && threwLine.inRun && !w.alive().some((n) => n.name === "Never"));

    // An empty batch says nothing — not even with a bad image table beside it.
    t = w.notified.length;
    p = w.posted.length;
    const empty = await w.api.applyWrites([]);
    const emptyBad = await w.api.applyWrites([], { "not-an-image-id": "AAAA" });
    await bridgeWrite(w, "h5", []);
    ok("[ANNOUNCE] an empty batch says nothing (no toast, no panel line), whatever came with it",
      empty.ok && !emptyBad.ok && w.notified.length === t && writesOf(w.posted.slice(p)).length === 0);
  },
}, {
  name: "Dev Mode refuses the batch up front, and says so (#206)",
  async run() {
    const w = await treeWorld({ extra: { file: { editorType: "dev" } } });
    const t = w.notified.length;
    const p = w.posted.length;
    const posted = await bridgeWrite(w, "d1", [{ op: "createFrame", name: "Never" }]);
    const reply = posted.find((m) => m.type === "bridge-result");
    const r = reply && typeof reply.result === "object" && reply.result !== null ? reply.result as { ok?: unknown; error?: unknown } : {};
    const line = panelLine(posted);
    ok(`[ANNOUNCE] Dev Mode: refused, nothing changed, and why — inside the write's run (got ${JSON.stringify(w.notified.slice(t))})`,
      r.ok === false && /Dev Mode/.test(String(r.error)) && saidOnce(w, t, p, HEAD + String(r.error)) && line !== null && line.inRun);
  },
}, {
  name: "A write approved after a wait, refused because the file changed meanwhile, says so (#206)",
  async run() {
    const w = await treeWorld({ extra: { reviewer: "real" } });
    // A layer to change: made by a write applied at once (the box clear for it), then the box ticked again.
    await w.send({ type: "set-review-writes", on: false });
    const made = await w.api.applyWrites([{ op: "createFrame", name: "Target" }]);
    const id = String(made.applied[0]?.id);
    await w.send({ type: "set-review-writes", on: true });
    const from = w.posted.length;
    const reply = bridgeWrite(w, "a1", [{ op: "patch", nodeId: id, set: { name: "Renamed" } }]);
    await tick(() => w.posted.slice(from).some((m) => m.type === "review" || m.type === "bridge-result"));
    const card = w.posted.slice(from).find((m) => m.type === "review");
    ok("[ANNOUNCE] the write waits on a card", card !== undefined);
    // The designer deletes the layer while the card is up, then approves.
    const target = w.alive().find((n) => n.id === id);
    if (target && typeof target.remove === "function") (target.remove as () => void)();
    const t = w.notified.length;
    const p = w.posted.length;
    await w.send({ type: "review-answer", id: String(card?.id), action: "apply" });
    await tick(() => w.posted.slice(p).some((m) => m.type === "writes"));
    await reply;
    const text = String(lastWrites(w)?.text);
    const after = w.posted.slice(p);
    const approvedAt = after.findIndex((m) => m.type === "review-end" && m.end === "approved");
    const writesAt = after.findIndex((m) => m.type === "writes");
    ok(`[ANNOUNCE] approved, then refused: the toast and the panel replace "Applying the edits you approved…" with why (got ${JSON.stringify(text)})`,
      saidOnce(w, t, p, text) && text.startsWith(HEAD + "the file changed while the write waited for review: ops[0] (patch): ") && approvedAt >= 0 && approvedAt < writesAt);
  },
}, {
  name: "A write refused inside its run because another waits for review leaves the panel's \"Applying edits…\" line (#206)",
  async run() {
    const w = await treeWorld({ extra: { reviewer: "real" } });
    const from = w.posted.length;
    // Both sent at once: the second passes the bridge's own check (no card is up yet) and is refused in its run.
    const first = bridgeWrite(w, "q1", [{ op: "createFrame", name: "One" }]);
    const second = bridgeWrite(w, "q2", [{ op: "createFrame", name: "Two" }]);
    const posted2 = await second;
    const card = w.posted.slice(from).find((m) => m.type === "review");
    const reply2 = posted2.find((m) => m.type === "bridge-result");
    const r2 = reply2 && typeof reply2.result === "object" && reply2.result !== null ? reply2.result as { refused?: unknown } : {};
    const begins = w.posted.slice(from).filter((m) => m.type === "run-begin" && m.label === "write").length;
    const toastsAfterCard = w.notified.filter((n) => /refused/.test(n)).length;
    const line = lastWrites(w);
    ok(`[ANNOUNCE] the second write was refused inside a run of its own (got ${JSON.stringify(r2)}, ${begins} write runs)`, card !== undefined && r2.refused === "waiting" && begins === 2);
    ok(`[ANNOUNCE] …its run's line is replaced: refused, another waits for review, nothing changed (got ${JSON.stringify(line)})`,
      line?.text === "Design Twin refused another edit request while one waits for your review — nothing changed." && line.ok === false && line.applied === 0);
    ok("[ANNOUNCE] …said on the status line only: the card's own toast is up, and no second toast follows", toastsAfterCard === 0);
    await w.send({ type: "review-answer", id: String(card?.id), action: "reject" });
    await first;
  },
}, {
  name: "A write sent while a card is already up is refused before any run, and leaves the panel alone (#206)",
  async run() {
    const w = await treeWorld({ extra: { reviewer: "real" } });
    const from = w.posted.length;
    const first = bridgeWrite(w, "c1", [{ op: "createFrame", name: "One" }]);
    await tick(() => w.posted.slice(from).some((m) => m.type === "review"));
    const card = w.posted.slice(from).find((m) => m.type === "review");
    const t = w.notified.length;
    const p = w.posted.length;
    const posted = await bridgeWrite(w, "c2", [{ op: "createFrame", name: "Two" }]);
    const reply = posted.find((m) => m.type === "bridge-result");
    const r = reply && typeof reply.result === "object" && reply.result !== null ? reply.result as { refused?: unknown } : {};
    const after = w.posted.slice(p);
    // The bridge's own check (bridge.ts bridgeWrite): no run begins, so the panel never shows "Applying edits…" for it,
    // and it keeps the card's "review it below" line (no `writes` line, no new card). Figma's toast says it was refused.
    ok(`[ANNOUNCE] refused as waiting, with no run, no panel line and no second card (got ${JSON.stringify(after.map((m) => m.type))})`,
      card !== undefined && r.refused === "waiting" && !after.some((m) => m.type === "run-begin" || m.type === "writes" || m.type === "review" || m.type === "review-end"));
    ok(`[ANNOUNCE] …and the designer is told, in one toast (got ${JSON.stringify(w.notified.slice(t))})`,
      w.notified.length === t + 1 && w.notified[t] === "Design Twin refused another edit request while one waits for your review — nothing changed.");
    // The first card still answers: rejected, it ends as ever.
    const t2 = w.notified.length;
    await w.send({ type: "review-answer", id: String(card?.id), action: "reject" });
    const r1 = replyOf((await first).filter((m) => m.type !== "bridge-result" || m.id === "c1"));
    ok(`[ANNOUNCE] …the first card is intact: rejected, it ends as ever (got ${JSON.stringify(r1)}, ${JSON.stringify(w.notified.slice(t2))})`,
      r1.refused === "rejected" && w.notified.slice(t2).join("|") === "Design Twin did not apply the edit request — it was rejected. Nothing changed.");
  },
}, {
  name: "A write the plugin's wire guard refuses (an op missing a field the MCP schema let through) says so (#206)",
  async run() {
    const w = await treeWorld();
    const t = w.notified.length;
    const p = w.posted.length;
    // setFill with no colour: the MCP server's field schema passes it; the plugin's parseCommandRequest refuses it.
    const posted = await w.send({ type: "bridge", id: "m1", cmd: "write", args: { ops: [{ op: "setFill", nodeId: "1:2" }] } });
    const reply = posted.find((m) => m.type === "bridge-result");
    const err = String(reply?.error);
    ok(`[ANNOUNCE] a malformed op: the bridge gets the error, and the toast and the panel say it was refused, nothing changed, and why (got ${JSON.stringify(w.notified.slice(t))}, reply ${JSON.stringify(reply)})`,
      reply?.ok === false && /^bad write args: /.test(err) && saidOnce(w, t, p, HEAD + err) && !posted.some((m) => m.type === "run-begin"));
    // An empty one still says nothing.
    const t2 = w.notified.length;
    const p2 = w.posted.length;
    await w.send({ type: "bridge", id: "m2", cmd: "write", args: { ops: [] } });
    ok("[ANNOUNCE] …an empty one still says nothing", w.notified.length === t2 && writesOf(w.posted.slice(p2)).length === 0);
  },
}, {
  name: "A batch refused after a library import landed says what landed, never \"nothing changed\" (#206)",
  async run() {
    const w = await treeWorld({ kit: true });
    const before = w.alive().length;
    const t = w.notified.length;
    const p = w.posted.length;
    // The first instance's key is a library's (imported), the second's is no library's: refused once the import ran.
    const r = await w.api.applyWrites([{ op: "createTree", tree: { children: [{ component: "e".repeat(40) }, { component: "a".repeat(40) }] } }]);
    const text = String(lastWrites(w)?.text);
    ok(`[ANNOUNCE] a late import failure after another import landed: says it imported one, and why (got ${JSON.stringify(text)})`,
      r.ok === false && r.applied.length === 0 && w.alive().length === before && w.imports.includes("component " + "e".repeat(40))
      && saidOnce(w, t, p, text) && !/nothing changed/.test(text)
      && text.startsWith("Design Twin refused an edit request — no layer changed, but it had already imported 1 library item: ops[0] (createTree): tree.children[1].component: no component in this file or an enabled library has the key '" + "a".repeat(40) + "'"));
    // No import landed (the only key is no library's): nothing changed, as before.
    const t2 = w.notified.length;
    const p2 = w.posted.length;
    await w.api.applyWrites([{ op: "createTree", tree: { children: [{ component: "b".repeat(40) }] } }]);
    const text2 = String(lastWrites(w)?.text);
    ok(`[ANNOUNCE] …a late import failure with nothing imported still says nothing changed (got ${JSON.stringify(text2)})`,
      saidOnce(w, t2, p2, text2) && text2.startsWith(HEAD + "ops[0] (createTree): tree.children[0].component: no component"));
  },
}, {
  name: "A batch refused before it runs makes no image first; one refused after it made one says so (#206)",
  async run() {
    const w = await treeWorld();
    let made = 0;
    const realCreate = w.figma.createImage;
    w.figma.createImage = (data: Uint8Array) => { made++; return realCreate(data); };
    const gif = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.from([2, 0, 2, 0, 0, 0, 0]), Buffer.from([0x3b])]).toString("base64");
    const ID = "a".repeat(64), BAD_ID = "b".repeat(64);
    const fromFile = { type: "image" as const, file: "hero.gif", image: ID };

    // A valid image from disk beside a hash the file does not have: refused, and the image was never made.
    let t = w.notified.length;
    let p = w.posted.length;
    await w.api.applyWrites([{ op: "createTree", tree: { name: "Pic", fills: [fromFile, { type: "image", hash: UNKNOWN_HASH }] } }], { [ID]: gif });
    let text = String(lastWrites(w)?.text);
    ok(`[ANNOUNCE] an unknown hash beside an image from disk: refused, nothing changed, and no image made (made ${made}, got ${JSON.stringify(text)})`,
      made === 0 && saidOnce(w, t, p, text) && text.startsWith(HEAD + "ops[0] (createTree): tree.fills[1]: the file has no image with hash"));

    // A hash lookup that throws: a problem like any other, refused before an image is made.
    const realGet = w.figma.getImageByHash;
    w.figma.getImageByHash = () => { throw new Error("image lookup failed"); };
    t = w.notified.length;
    p = w.posted.length;
    await w.api.applyWrites([{ op: "createTree", tree: { name: "Pic", fills: [fromFile, { type: "image", hash: UNKNOWN_HASH }] } }], { [ID]: gif });
    w.figma.getImageByHash = realGet;
    text = String(lastWrites(w)?.text);
    ok(`[ANNOUNCE] a hash lookup that throws: refused with why, nothing changed, and no image made (made ${made}, got ${JSON.stringify(text)})`,
      made === 0 && saidOnce(w, t, p, text) && text === HEAD + "ops[0] (createTree): tree.fills[1]: Figma could not look up the image with hash '" + UNKNOWN_HASH + "' (image lookup failed)");

    // Any other problem in the batch (a node the file does not have): no image is made either.
    t = w.notified.length;
    p = w.posted.length;
    await w.api.applyWrites([{ op: "createTree", tree: { name: "Pic", fills: [fromFile] } }, { op: "patch", nodeId: "404:1", set: { name: "x" } }], { [ID]: gif });
    text = String(lastWrites(w)?.text);
    ok(`[ANNOUNCE] another op's problem: refused before any image is made (made ${made}, got ${JSON.stringify(text)})`,
      made === 0 && saidOnce(w, t, p, text) && text === HEAD + "ops[1] (patch): no node with id '404:1' (invalid or removed)");

    // An image Figma cannot open, after one it made: refused, and the panel says the made one is in the file.
    t = w.notified.length;
    p = w.posted.length;
    const r = await w.api.applyWrites([{ op: "createTree", tree: { name: "Pic", fills: [fromFile, { type: "image", file: "notes.gif", image: BAD_ID }] } }],
      { [ID]: gif, [BAD_ID]: Buffer.from("hello").toString("base64") });
    text = String(lastWrites(w)?.text);
    ok(`[ANNOUNCE] an image Figma cannot open, after one it made: says the one it added (made ${made}, got ${JSON.stringify(text)})`,
      r.ok === false && made === 2 && saidOnce(w, t, p, text) && !w.alive().some((n) => n.name === "Pic")
      && text.startsWith("Design Twin refused an edit request — no layer changed, but it had already loaded 1 image file into Figma: ops[0] (createTree): tree.fills[1]: 'notes.gif' is not an image Figma can open"));
    w.figma.createImage = realCreate;
  },
}, {
  name: "\"Allow edits\" turned off while an image is being made stops the batch before the next image (#206)",
  async run() {
    const w = await treeWorld();
    const real = w.figma.createImage;
    let made = 0;
    // The first image's size is read while the designer unticks "Allow edits".
    w.figma.createImage = (data: Uint8Array) => {
      made++;
      const img = real(data);
      if (made !== 1) return img;
      return { ...img, getSizeAsync: async () => { await w.allowEdits(false); return img.getSizeAsync(); } };
    };
    const A = "a".repeat(64), B = "c".repeat(64);
    const t = w.notified.length;
    const p = w.posted.length;
    const posted = await bridgeWrite(w, "r1", [{ op: "createTree", tree: { name: "Pic", fills: [{ type: "image", file: "one.gif", image: A }, { type: "image", file: "two.gif", image: B }] } }],
      { [A]: gif(2, 2), [B]: gif(3, 3) });
    w.figma.createImage = real;
    const r = replyOf(posted);
    const text = String(lastWrites(w)?.text);
    ok(`[ANNOUNCE] unticked between two images: the second is never made, and the batch is refused as edits-off (made ${made}, got ${JSON.stringify(r)})`,
      made === 1 && r.refused === "edits-off" && Array.isArray(r.applied) && r.applied.length === 0 && !w.alive().some((n) => n.name === "Pic"));
    ok(`[ANNOUNCE] …the agent is told no layer changed but one image was loaded, not "nothing was changed" (got ${JSON.stringify(r.error)})`,
      r.error === "Edits are off in the Design Twin plugin — tick 'Allow edits' in the plugin window, then retry. No layer was changed, but the batch had already loaded 1 image file into Figma.");
    ok(`[ANNOUNCE] …and the designer the same, in the toast and on the panel (got ${JSON.stringify(text)})`,
      saidOnce(w, t, p, text) && text === "Design Twin refused an edit request — 'Allow edits' is off. No layer changed, but it had already loaded 1 image file into Figma.");

    // Unticked before any image is made: the plain edits-off refusal, word for word.
    await w.allowEdits(true);
    w.figma.getImageByHash = ((get) => (hash: string) => { void w.allowEdits(false); return get(hash); })(w.figma.getImageByHash);
    const existing = real(Buffer.from(gif(4, 4), "base64"));
    const t2 = w.notified.length;
    const p2 = w.posted.length;
    const posted2 = await bridgeWrite(w, "r2", [{ op: "createTree", tree: { name: "Pic", fills: [{ type: "image", hash: existing.hash }, { type: "image", file: "one.gif", image: A }] } }], { [A]: gif(2, 2) });
    const r2 = replyOf(posted2);
    ok(`[ANNOUNCE] …unticked before the first image: the plain edits-off refusal (got ${JSON.stringify(r2)}, ${JSON.stringify(w.notified.slice(t2))})`,
      r2.refused === "edits-off" && r2.error === "Edits are off in the Design Twin plugin — tick 'Allow edits' in the plugin window, then retry. Nothing in the file was changed."
      && saidOnce(w, t2, p2, "Design Twin refused an edit request — 'Allow edits' is off."));
  },
}, {
  name: "A write that waits for review makes its images only once approved: a reject leaves none (#206)",
  async run() {
    const w = await treeWorld({ extra: { reviewer: "real" } });
    const count = countImages(w);
    const A = "a".repeat(64);
    const ops: WriteOp[] = [{ op: "createTree", tree: { name: "Pic", fills: [{ type: "image", file: "one.gif", image: A }] } }];
    const table = { [A]: gif(2, 2) };
    const cardOf = async (from: number): Promise<PostedMessage | undefined> => {
      await tick(() => w.posted.slice(from).some((m) => m.type === "review" || m.type === "bridge-result"));
      return w.posted.slice(from).find((m) => m.type === "review");
    };

    // Rejected: no image was ever made, so "Nothing changed." is true, word for word as before.
    let from = w.posted.length;
    let reply = bridgeWrite(w, "v1", ops, table);
    let card = await cardOf(from);
    const atCard = count.made();
    await w.send({ type: "review-answer", id: String(card?.id), action: "reject" });
    let r = replyOf(await reply);
    ok(`[ANNOUNCE] a write with an image waits on a card having made no image (made ${atCard})`, card !== undefined && atCard === 0);
    ok(`[ANNOUNCE] …rejected: still no image, and the rejection says nothing changed, as before (made ${count.made()}, got ${JSON.stringify(lastWrites(w)?.text)})`,
      count.made() === 0 && r.refused === "rejected" && lastWrites(w)?.text === "Design Twin did not apply the edit request — it was rejected. Nothing changed.");

    // Approved: the image is made then, and the layer has it.
    from = w.posted.length;
    reply = bridgeWrite(w, "v2", ops, table);
    card = await cardOf(from);
    await w.send({ type: "review-answer", id: String(card?.id), action: "apply" });
    r = replyOf(await reply);
    const pic = w.alive().find((n) => n.name === "Pic");
    const fills = pic && Array.isArray(pic.fills) ? pic.fills as Array<{ type?: unknown; imageHash?: unknown }> : [];
    const rows = Array.isArray(r.images) ? r.images as Array<{ hash?: unknown }> : [];
    ok(`[ANNOUNCE] …approved: the image is made once, and the new layer paints it (made ${count.made()}, got ${JSON.stringify(r)})`,
      count.made() === 1 && r.ok === true && rows.length === 1 && fills[0]?.type === "IMAGE" && fills[0]?.imageHash === rows[0]?.hash
      && lastWrites(w)?.text === "Design Twin applied 1 edit to this file.");

    // Approved, but the file changed while the card was up: refused when resolved again, before any image is made.
    await w.send({ type: "set-review-writes", on: false });
    const target = await w.api.applyWrites([{ op: "createFrame", name: "Target" }]);
    const id = String(target.applied[0]?.id);
    await w.send({ type: "set-review-writes", on: true });
    const before = count.made();
    from = w.posted.length;
    reply = bridgeWrite(w, "v3", [...ops, { op: "patch", nodeId: id, set: { name: "Renamed" } }], table);
    card = await cardOf(from);
    const node = w.alive().find((n) => n.id === id);
    if (node && typeof node.remove === "function") (node.remove as () => void)();
    await w.send({ type: "review-answer", id: String(card?.id), action: "apply" });
    r = replyOf(await reply);
    ok(`[ANNOUNCE] …approved after the file changed: refused before any image is made (made ${count.made() - before}, got ${JSON.stringify(r.error)})`,
      card !== undefined && count.made() === before && r.ok === false && /^the file changed while the write waited for review: .*Nothing was changed\.$/.test(String(r.error)));
    count.restore();
  },
}, {
  name: "A refusal after a library import or an image landed tells the agent so, not \"Nothing was changed\" (#206)",
  async run() {
    const w = await treeWorld({ kit: true });
    // The first instance's key is a library's (imported), the second's is no library's: refused once the import ran.
    const posted = await bridgeWrite(w, "i1", [{ op: "createTree", tree: { children: [{ component: "e".repeat(40) }, { component: "a".repeat(40) }] } }]);
    const r = replyOf(posted);
    ok(`[ANNOUNCE] a late import failure: the agent's error says the import landed (got ${JSON.stringify(r.error)})`,
      r.ok === false && r.error === "ops[0] (createTree): tree.children[1].component: no component in this file or an enabled library has the key '" + "a".repeat(40) +
        "'. No layer was changed, but the batch had already imported 1 library item.");
    // Nothing imported: word for word as before.
    const plain = replyOf(await bridgeWrite(w, "i2", [{ op: "createTree", tree: { children: [{ component: "b".repeat(40) }] } }]));
    ok(`[ANNOUNCE] …a refusal with nothing landed keeps "Nothing was changed." (got ${JSON.stringify(plain.error)})`,
      plain.ok === false && /^ops\[0\] \(createTree\): tree\.children\[0\]\.component: no component .*\. Nothing was changed\.$/.test(String(plain.error)));

    // An image that landed before one Figma cannot open: the same.
    const A = "a".repeat(64), BAD = "b".repeat(64);
    const img = replyOf(await bridgeWrite(w, "i3", [{ op: "createTree", tree: { name: "Pic", fills: [{ type: "image", file: "one.gif", image: A }, { type: "image", file: "notes.gif", image: BAD }] } }],
      { [A]: gif(2, 2), [BAD]: Buffer.from("hello").toString("base64") }));
    ok(`[ANNOUNCE] …an image loaded before a bad one: the agent's error says so (got ${JSON.stringify(img.error)})`,
      img.ok === false && /^ops\[0\] \(createTree\): tree\.fills\[1\]: 'notes\.gif' is not an image Figma can open \(.*\)\. No layer was changed, but the batch had already loaded 1 image file into Figma\.$/.test(String(img.error)));
    // Two problems, the import landed: the head says so.
    const two = replyOf(await bridgeWrite(w, "i4", [{ op: "createTree", tree: { children: [{ component: "e".repeat(40) }, { component: "a".repeat(40) }, { component: "c".repeat(40) }] } }]));
    ok(`[ANNOUNCE] …two late problems: the head says what landed (got ${JSON.stringify(two.error)})`,
      two.ok === false && String(two.error).startsWith("2 problems — no layer was changed, but the batch had already imported 1 library item:\nops[0] (createTree): "));
  },
}, {
  name: "An image Figma cannot open stops the images there: none after it is made (#206)",
  async run() {
    const w = await treeWorld();
    const count = countImages(w);
    const A = "a".repeat(64), BAD = "b".repeat(64);
    const t = w.notified.length;
    const p = w.posted.length;
    const r = await w.api.applyWrites([{ op: "createTree", tree: { name: "Pic", fills: [{ type: "image", file: "notes.gif", image: BAD }, { type: "image", file: "one.gif", image: A }] } }],
      { [BAD]: Buffer.from("hello").toString("base64"), [A]: gif(2, 2) });
    const text = String(lastWrites(w)?.text);
    count.restore();
    ok(`[ANNOUNCE] a bad image first: the valid one after it is never made, and nothing changed (made ${count.made()}, got ${JSON.stringify(text)}, ${JSON.stringify(r.error)})`,
      r.ok === false && count.made() === 1 && saidOnce(w, t, p, text) && text.startsWith(HEAD + "ops[0] (createTree): tree.fills[0]: 'notes.gif' is not an image Figma can open")
      && /\. Nothing was changed\.$/.test(String(r.error)));
  },
}, {
  name: "An image whose bytes the file already holds is never said to be added (#206)",
  async run() {
    const w = await treeWorld();
    const A = "a".repeat(64), BAD = "b".repeat(64);
    // Its bytes are in the file already (Figma's image table is content-addressed: createImage gives back that hash).
    w.figma.createImage(Buffer.from(gif(2, 2), "base64"));
    await w.api.applyWrites([{ op: "createTree", tree: { name: "Pic", fills: [{ type: "image", file: "one.gif", image: A }, { type: "image", file: "notes.gif", image: BAD }] } }],
      { [A]: gif(2, 2), [BAD]: Buffer.from("hello").toString("base64") });
    const text = String(lastWrites(w)?.text);
    ok(`[ANNOUNCE] reused bytes: says the image file was loaded, never that an image was added to the file (got ${JSON.stringify(text)})`,
      !/added/.test(text) && text.startsWith("Design Twin refused an edit request — no layer changed, but it had already loaded 1 image file into Figma: "));
  },
}];

/** A card's preview, then its put-back, then a reject: the image the preview loaded stays, and the card says so. */
cases.push({
  name: "A previewed write put back and then rejected says the image its preview loaded stays (#206)",
  async run() {
    // 26 layers the file already has: a batch that renames them all is over the review limit, so its card offers a preview.
    const nodes: Record<string, { id: string; type: string; name: string; visible: boolean }> = {};
    for (let i = 1; i <= 26; i++) nodes["x:" + i] = { id: "x:" + i, type: "FRAME", name: "Old " + i, visible: true };
    const w = await treeWorld({ extra: { reviewer: "real", nodes } });
    const count = countImages(w);
    const A = "a".repeat(64);
    const ops: WriteOp[] = [{ op: "createTree", tree: { name: "Pic", fills: [{ type: "image", file: "one.gif", image: A }] } },
      ...Object.keys(nodes).map((id): WriteOp => ({ op: "patch", nodeId: id, set: { name: "New" } }))];
    const from = w.posted.length;
    const reply = bridgeWrite(w, "pv1", ops, { [A]: gif(2, 2) });
    await tick(() => w.posted.slice(from).some((m) => m.type === "review" || m.type === "bridge-result"));
    const card = w.posted.slice(from).find((m) => m.type === "review");
    const state = (s: string) => w.posted.slice(from).some((m) => m.type === "review-state" && m.state === s && m.note !== undefined && /Put back\. It still waits/.test(String(m.note)) === (s === "waiting"));
    await w.send({ type: "review-answer", id: String(card?.id), action: "preview" });
    await tick(() => state("previewing"));
    const madeAtPreview = count.made();
    await w.send({ type: "review-answer", id: String(card?.id), action: "put-back" });
    await tick(() => state("waiting"));
    ok(`[ANNOUNCE] a previewable card makes the image only for its preview (made ${madeAtPreview}; card ${JSON.stringify(card?.previewable)})`,
      card?.previewable === true && madeAtPreview === 1 && !w.alive().some((n) => n.name === "Pic"));
    await w.send({ type: "review-answer", id: String(card?.id), action: "reject" });
    const r = replyOf(await reply);
    const text = String(lastWrites(w)?.text);
    ok(`[ANNOUNCE] …rejected after the put-back: the toast and the agent say the image the preview loaded stays (got ${JSON.stringify(text)}, ${JSON.stringify(r.error)})`,
      r.refused === "rejected" && text === "Design Twin did not apply the edit request — it was rejected. No layer changed, but its preview had already loaded 1 image file into Figma."
      && r.error === "The designer rejected this write in the Design Twin plugin window. No layer was changed, but the batch had already loaded 1 image file into Figma. They gave no reason.");
    count.restore();
  },
});

/** A card with an image that offers a preview (26 existing layers renamed: over the review limit), previewed and put
 *  back: the image its preview loaded is in the file, no layer of the batch is. Then the designer deletes the layers of
 *  `drop` (x:1 by default), the way `how` says: "gone" (the default) from the lookup; "removed", still handed back by it
 *  but `removed` and on no page; "soft", still handed back NOT `removed` but on no page, its parent null (as Figma
 *  hands back a deleted main component: it keeps one, soft-deleted, for its instances and an undo); "under", the frame
 *  it sits in removed, it left NOT `removed` with that frame as its parent. `component` makes x:1 a local main
 *  component; the layers sit on the current page, x:1 in a frame there with "under". `late`: deleted only once the
 *  approved (or previewed) run has resolved the batch, as it makes the image (figma.createImage), not before. */
type Deleted = "gone" | "removed" | "soft" | "under";
async function previewedAndPutBack(id: string, opts: { drop?: readonly string[]; how?: Deleted; component?: boolean; late?: boolean } = {}): Promise<{ w: World; card: PostedMessage | undefined; reply: Promise<PostedMessage[]>; hash: () => string | undefined; from: number }> {
  const nodes: Record<string, FakeNode> = {};
  for (let i = 1; i <= 26; i++) nodes["x:" + i] = { id: "x:" + i, type: "FRAME", name: "Old " + i, visible: true };
  if (opts.component) Object.assign(nodes["x:1"] ?? {}, { type: "COMPONENT", key: "local-x:1", remote: false, description: "", getInstancesAsync: async () => [] });
  const w = await treeWorld({ extra: { reviewer: "real", nodes } });
  const how = opts.how ?? "gone";
  for (const n of Object.values(nodes)) n.parent = w.pages.current;
  const holder: FakeNode = { id: "h:1", type: "FRAME", name: "Holder", visible: true, parent: w.pages.current, removed: false };
  if (how === "under") for (const x of opts.drop || ["x:1"]) { const n = nodes[x]; if (n) n.parent = holder; }
  let hash: string | undefined;
  const real = w.figma.createImage;
  w.figma.createImage = (data: Uint8Array) => { const img = real(data); hash = img.hash; return img; };
  const A = "a".repeat(64);
  const ops: WriteOp[] = [{ op: "createTree", tree: { name: "Pic", fills: [{ type: "image", file: "one.gif", image: A }] } },
    ...Object.keys(nodes).map((nodeId): WriteOp => ({ op: "patch", nodeId, set: { name: "New" } }))];
  const from = w.posted.length;
  const reply = bridgeWrite(w, id, ops, { [A]: gif(2, 2) });
  await tick(() => w.posted.slice(from).some((m) => m.type === "review" || m.type === "bridge-result"));
  const card = w.posted.slice(from).find((m) => m.type === "review");
  const state = (s: string) => w.posted.slice(from).some((m) => m.type === "review-state" && m.state === s && m.note !== undefined && /Put back\. It still waits/.test(String(m.note)) === (s === "waiting"));
  await w.send({ type: "review-answer", id: String(card?.id), action: "preview" });
  await tick(() => state("previewing"));
  await w.send({ type: "review-answer", id: String(card?.id), action: "put-back" });
  await tick(() => state("waiting"));
  w.figma.createImage = real;
  // The designer removes a layer the batch renames: the batch no longer resolves.
  const drop = (): void => {
    for (const x of opts.drop || ["x:1"]) {
      const n = w.scene.nodes[x];
      if (how === "gone") delete w.scene.nodes[x];
      else if (!n) continue;
      else if (how === "removed") markRemoved(n);
      else if (how === "soft") n.parent = null;
    }
    if (how === "under") markRemoved(holder);
  };
  // Late: while the next run makes its image (an await, after the batch resolved and before its first op runs).
  if (opts.late) w.figma.createImage = (data: Uint8Array) => { w.figma.createImage = real; drop(); return real(data); };
  else drop();
  return { w, card, reply, hash: () => hash, from };
}

const PIC_HASH = "a".repeat(64);
/** An op that loads an image from disk (`images` gives PIC_HASH its bytes). */
const PIC: WriteOp = { op: "createTree", tree: { name: "Pic", fills: [{ type: "image", file: "one.gif", image: PIC_HASH }] } };
const LOADED_STAYS = " The batch had already loaded 1 image file into Figma; that stays.";
/** One op whose node goes partway through its batch: the op (by the ids of lateWorld's nodes), the id that goes, and
 *  the error the op fails with then. */
interface Late { what: string; op: (h: LateIds) => WriteOp; gone: (h: LateIds) => string; want: (h: LateIds) => string }
interface LateIds { mine: string; box: string; label: string; chip: string; keyed: string }

/** A world with a frame "40:1" that takes variable modes (a Theme collection: Light, Dark), and what this session made in
 *  it: two frames (Mine, Box), a text (Label), a main component (Chip) and a keyed result ("late"). */
async function lateWorld(): Promise<{ w: World; h: LateIds }> {
  const w = await treeWorld({ extra: { ...modeScene(), nodes: { "40:1": modeNode("40:1", "Themed") } } });
  const themed = w.scene.nodes["40:1"];
  if (themed) themed.parent = w.pages.current;
  const r = await w.api.applyWrites([
    { op: "createFrame", name: "Mine" }, { op: "createFrame", name: "Box" }, { op: "createText", text: "a" },
    { op: "createTree", tree: { type: "COMPONENT", name: "Chip" } }, { op: "createTree", tree: { key: "late", name: "Keyed" } },
  ]);
  const ids = r.applied.map((a) => String(a.id));
  if (!r.ok || ids.length !== 5) throw new Error("lateWorld: the setup batch failed: " + JSON.stringify(r));
  const [mine = "", box = "", label = "", chip = "", keyed = ""] = ids;
  return { w, h: { mine, box, label, chip, keyed } };
}

/** What a failed batch must leave as it was: every node of lateWorld's, its name, text, fills, modes and children (its own
 *  parent is left out: the case detaches it). */
function snapshotOf(w: World, h: LateIds): string {
  const ids: string[] = [h.mine, h.box, h.label, h.chip, h.keyed, "40:1"];
  return JSON.stringify(ids.map((id) => {
    const n = w.scene.nodes[id];
    // A removed node's fields throw when read (markRemoved): what it held, read past that.
    const f = (k: string): unknown => (n ? peekRemoved(n, k) : undefined);
    return n ? [f("name"), f("characters"), f("fills"), f("explicitVariableModes"), ((f("children") || []) as FakeNode[]).map((c) => c.id)] : null;
  }));
}

/** A node's name, read past a removal (markRemoved). */
const nameOf = (w: World, id: string): unknown => { const n = w.scene.nodes[id]; return n ? peekRemoved(n, "name") : undefined; };

const LOADED_NOTE = "No layer was changed, but the batch had already loaded 1 image file into Figma.";
const CHANGED = "the file changed while the write waited for review: ops[1] (patch): no node with id 'x:1' (invalid or removed)";

cases.push({
  name: "A previewed write put back, then approved and refused because the file changed, says the preview's image stays (#206)",
  async run() {
    const { w, card, reply, hash } = await previewedAndPutBack("pa1");
    const t = w.notified.length;
    const p = w.posted.length;
    await w.send({ type: "review-answer", id: String(card?.id), action: "apply" });
    const r = replyOf(await reply);
    const text = String(lastWrites(w)?.text);
    const h = hash();
    ok(`[ANNOUNCE] the preview's image is still in the file (hash ${String(h)})`, h !== undefined && w.figma.getImageByHash(h) !== null && !w.alive().some((n) => n.name === "Pic"));
    ok(`[ANNOUNCE] …approved, then refused: the agent is told the preview's image stays (got ${JSON.stringify(r.error)})`,
      r.ok === false && r.error === CHANGED + ". " + LOADED_NOTE);
    ok(`[ANNOUNCE] …and the designer the same, in the toast and on the panel (got ${JSON.stringify(text)}, ${JSON.stringify(w.notified.slice(t))})`,
      saidOnce(w, t, p, text) && text === "Design Twin refused an edit request — no layer changed, but it had already loaded 1 image file into Figma: " + CHANGED);
  },
}, {
  name: "A previewed write put back, then previewed again and refused because the file changed, says the first preview's image stays (#206)",
  async run() {
    const { w, card, reply, hash } = await previewedAndPutBack("pa2");
    const t = w.notified.length;
    const p = w.posted.length;
    await w.send({ type: "review-answer", id: String(card?.id), action: "preview" });
    const r = replyOf(await reply);
    const text = String(lastWrites(w)?.text);
    const h = hash();
    const head = "The designer asked to preview this write on the canvas, and it failed: ";
    ok(`[ANNOUNCE] previewed again, refused: the first preview's image is still in the file (hash ${String(h)})`, h !== undefined && w.figma.getImageByHash(h) !== null);
    ok(`[ANNOUNCE] …the agent is told it stays (got ${JSON.stringify(r.error)})`, r.ok === false && r.error === head + CHANGED + ". " + LOADED_NOTE);
    ok(`[ANNOUNCE] …and the designer the same (got ${JSON.stringify(text)}, ${JSON.stringify(w.notified.slice(t))})`,
      saidOnce(w, t, p, text) && text === "Design Twin refused an edit request — no layer changed, but it had already loaded 1 image file into Figma: " + head + CHANGED);
  },
}, {
  name: "An op that fails after an image was loaded puts its layers back and says the image stays (#206)",
  async run() {
    const w = await treeWorld();
    const A = "a".repeat(64);
    let hash: string | undefined;
    const real = w.figma.createImage;
    w.figma.createImage = (data: Uint8Array) => { const img = real(data); hash = img.hash; return img; };
    // Op 0 lands (with the image), op 1 fails as it runs: op 0 is put back, the image stays.
    w.trap.add("cornerRadius");
    let t = w.notified.length;
    let p = w.posted.length;
    const r = await w.api.applyWrites([{ op: "createTree", tree: { name: "Pic", fills: [{ type: "image", file: "one.gif", image: A }] } }, { op: "createTree", tree: { name: "Trapped", radius: 4 } }],
      { [A]: gif(2, 2) });
    let text = String(lastWrites(w)?.text);
    ok(`[ANNOUNCE] a failed op after an image: its layers are put back, the image is in the file (got ${JSON.stringify(r)})`,
      r.ok === false && r.applied.length === 0 && (r.restored || []).length === 1 && !w.alive().some((n) => n.name === "Pic") && hash !== undefined && w.figma.getImageByHash(hash) !== null);
    ok(`[ANNOUNCE] …the agent is told the image stays (got ${JSON.stringify(r.error)})`,
      /cornerRadius/.test(String(r.error)) && String(r.error).endsWith(" The batch had already loaded 1 image file into Figma; that stays."));
    ok(`[ANNOUNCE] …and the designer the same (got ${JSON.stringify(text)})`,
      saidOnce(w, t, p, text) && text.startsWith("Design Twin undid 1 earlier change after an edit failed, but it had already loaded 1 image file into Figma: ") && /cornerRadius/.test(text) && !/that stays/.test(text));

    // The first op fails, after the image was loaded, with nothing to put back: the agent hears what landed.
    t = w.notified.length;
    p = w.posted.length;
    const first = await w.api.applyWrites([{ op: "createTree", tree: { name: "Pic", radius: 4, fills: [{ type: "image", file: "one.gif", image: A }] } }], { [A]: gif(2, 2) });
    text = String(lastWrites(w)?.text);
    w.trap.delete("cornerRadius");
    w.figma.createImage = real;
    ok(`[ANNOUNCE] …the first op fails after the image: the agent is told no layer changed but the image was loaded (got ${JSON.stringify(first.error)})`,
      first.ok === false && first.applied.length === 0 && !first.restored && /cornerRadius/.test(String(first.error)) && String(first.error).endsWith(". " + LOADED_NOTE));
    ok(`[ANNOUNCE] …and the designer the same (got ${JSON.stringify(text)})`,
      saidOnce(w, t, p, text) && text.startsWith("Design Twin refused an edit request — no layer changed, but it had already loaded 1 image file into Figma: ") && /cornerRadius/.test(text) && !/No layer was changed/.test(text));
  },
}, {
  name: "A local variable a batch made and its rollback removed is never counted as a library import (#206)",
  async run() {
    const w = await treeWorld({ kit: true });
    const t = w.notified.length;
    const p = w.posted.length;
    // The variable is the batch's own (op 0); the tree names it, and a component key no library has: refused once the
    // create table ran, which is put back.
    const r = await w.api.applyWrites([
      { op: "createVariables", collection: "Local", variables: [["local/bg", "color", "#ffffff"]] },
      { op: "createTree", tree: { name: "Card", fills: [{ type: "solid", tokens: { color: "local/bg" } }], children: [{ component: "a".repeat(40) }] } },
    ]);
    const text = String(lastWrites(w)?.text);
    ok(`[ANNOUNCE] refused late, the create table put back (got ${JSON.stringify(r)})`,
      r.ok === false && r.applied.length === 0 && !w.alive().some((n) => n.name === "Card") && !Object.values(w.scene.variables).some((v) => v.name === "local/bg"));
    ok(`[ANNOUNCE] …the agent is not told a library item was imported (got ${JSON.stringify(r.error)})`, !/imported/.test(String(r.error)));
    ok(`[ANNOUNCE] …nor the designer (got ${JSON.stringify(text)})`, saidOnce(w, t, p, text) && !/imported/.test(text));
  },
});

// ---- #206 review 4: a layer deleted after a preview whose id still resolves, several problems after a preview, a
// preview stopped by "Allow edits", and a put-back that failed.

/** Every write-path lookup by id that is not node-lookup.ts's: the plugin's sources, outside the read plane. */
function rawLookups(): string[] {
  const dir = new URL("../../figma-plugin/src/", import.meta.url);
  const READ_PLANE = new Set(["collect.ts", "run.ts", "node-lookup.ts"]);
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".ts") || READ_PLANE.has(f)) continue;
    readFileSync(new URL(f, dir), "utf8").split("\n").forEach((line, i) => { if (/getNodeByIdAsync\(/.test(line) && !/^\s*\/\//.test(line)) out.push(f + ":" + (i + 1)); });
  }
  return out;
}

/** A local main component's id, in Figma's form (the resolver of a tree's `component` looks it up by id only then). */
const GONE_COMPONENT = "40:3";

cases.push({
  name: "A layer deleted after a preview, whose id still resolves (removed, or soft-deleted: not removed but on no page), refuses the approved write (#206)",
  async run() {
    // As Figma hands them back after the delete: a removed frame; a main component kept soft-deleted for its instances
    // and an undo (not `removed`, its parent null); a plain frame left the same way; a frame whose holder was removed.
    const runs: Array<[string, { how: Deleted; component?: boolean }]> = [
      ["a removed frame", { how: "removed" }],
      ["a soft-deleted main component (not removed, no parent)", { how: "soft", component: true }],
      ["a frame not removed but with no parent", { how: "soft" }],
      ["a frame whose holder was removed (it is not)", { how: "under" }],
    ];
    for (const [what, opts] of runs) {
      const { w, card, reply, hash } = await previewedAndPutBack("rm-" + opts.how + String(!!opts.component), opts);
      const t = w.notified.length;
      const p = w.posted.length;
      await w.send({ type: "review-answer", id: String(card?.id), action: "apply" });
      const r = replyOf(await reply);
      const text = String(lastWrites(w)?.text);
      const h = hash();
      ok(`[ANNOUNCE] ${what} is missing: the approved write is refused, nothing of it lands (got ${JSON.stringify(r)})`,
        card?.previewable === true && r.ok === false && Array.isArray(r.applied) && r.applied.length === 0 && !w.alive().some((n) => n.name === "Pic")
        && nameOf(w, "x:1") === "Old 1" && nameOf(w, "x:2") === "Old 2");
      ok(`[ANNOUNCE] …${what}: the agent is told the file changed, and that the preview's image stays (got ${JSON.stringify(r.error)})`,
        r.error === CHANGED + ". " + LOADED_NOTE && h !== undefined && w.figma.getImageByHash(h) !== null);
      ok(`[ANNOUNCE] …${what}: and the designer the same, never "applied" (got ${JSON.stringify(text)}, ${JSON.stringify(w.notified.slice(t))})`,
        saidOnce(w, t, p, text) && text === "Design Twin refused an edit request — no layer changed, but it had already loaded 1 image file into Figma: " + CHANGED);
    }
  },
}, {
  name: "Every op that names a node by id treats a removed or detached node as missing (#206)",
  async run() {
    // The same three layers, deleted three ways Figma can hand them back: removed; not removed but detached from the
    // document (its parent null, as a soft-deleted main component is); not removed but under a removed frame.
    // Removed: every field but id, removed and type throws when read, as Figma's does (markRemoved).
    const holder = markRemoved({ id: "h:9", type: "FRAME", name: "Holder", visible: true });
    const ways: Array<[string, Record<string, unknown>, boolean]> = [
      ["a removed node", { removed: false, parent: null }, true],
      ["a detached node (not removed, no parent)", { removed: false, parent: null }, false],
      ["a node under a removed frame (not removed itself)", { removed: false, parent: holder }, false],
    ];
    for (const [how, gone, remove] of ways) {
      const w = await treeWorld({ extra: { nodes: {
        "r:1": { id: "r:1", type: "FRAME", name: "Gone frame", fills: [], visible: true, ...gone },
        "r:2": { id: "r:2", type: "TEXT", name: "Gone text", characters: "a", fontName: { family: "Inter", style: "Regular" }, fills: [], visible: true, ...gone },
        // An id as Figma gives one: the component resolver looks a ref up by id only when it reads as one (tree-refs.ts).
        [GONE_COMPONENT]: { id: GONE_COMPONENT, type: "COMPONENT", name: "Gone component", key: "local-" + GONE_COMPONENT, remote: false, visible: true, componentPropertyDefinitions: {}, ...gone },
      } } });
      // Instanceable, so a lookup that still found it would build the instance: the refusal can only come from the lookup.
      let instanced = 0;
      const comp = w.scene.nodes[GONE_COMPONENT];
      if (comp) comp.createInstance = () => { instanced++; return { id: "I40:3", type: "INSTANCE", name: "Gone component", visible: true }; };
      if (remove) for (const id of ["r:1", "r:2", GONE_COMPONENT]) { const n = w.scene.nodes[id]; if (n) markRemoved(n); }
      const looked: string[] = [];
      const lookup = w.figma.getNodeByIdAsync;
      w.figma.getNodeByIdAsync = (id: string) => { looked.push(id); return lookup(id); };
      const made = await w.api.applyWrites([{ op: "createFrame", name: "Mine" }]);
      const mine = String(made.applied[0]?.id);
      // Each: the op, the refusal it gets, and the id it must look up by id to get it.
      const tries: Array<[string, WriteOp[], RegExp, string]> = [
        ["setFill", [{ op: "setFill", nodeId: "r:1", color: "#ff0000" }], /no node with id 'r:1' \(invalid or removed\)/, "r:1"],
        ["setText", [{ op: "setText", nodeId: "r:2", text: "b" }], /no node with id 'r:2' \(invalid or removed\)/, "r:2"],
        ["patch", [{ op: "patch", nodeId: "r:1", set: { name: "x" } }], /no node with id 'r:1' \(invalid or removed\)/, "r:1"],
        ["patch of a deleted main component", [{ op: "patch", nodeId: GONE_COMPONENT, set: { name: "x" } }], /no node with id '40:3' \(invalid or removed\)/, GONE_COMPONENT],
        ["setVariableMode", [{ op: "setVariableMode", nodeId: "r:1", collection: "Theme", mode: "Dark" }], /no node with id 'r:1' \(invalid or removed\)/, "r:1"],
        ["delete", [{ op: "delete", nodeId: "r:1" }], /no node with id 'r:1' \(invalid or removed\)/, "r:1"],
        ["move of it", [{ op: "move", nodeId: "r:1", parentId: "1:1" }], /no node with id 'r:1' \(invalid or removed\)/, "r:1"],
        ["move into it", [{ op: "move", nodeId: mine, parentId: "r:1" }], /no parent with id 'r:1' \(invalid or removed\)/, "r:1"],
        ["createFrame into it", [{ op: "createFrame", name: "Child", parentId: "r:1" }], /parent 'r:1' not found \(invalid or removed id\)/, "r:1"],
        ["a copy of it", [{ op: "createTree", tree: { clone: "r:1" } }], /no node with id 'r:1' \(invalid or removed\)/, "r:1"],
        ["an instance of it", [{ op: "createTree", tree: { children: [{ component: GONE_COMPONENT }] } }], /component: component '40:3' matches no component in this file/, GONE_COMPONENT],
      ];
      for (const [what, ops, want, id] of tries) {
        const before = w.alive().length;
        const asked = looked.length;
        const r = await w.api.applyWrites(ops);
        ok(`[ANNOUNCE] ${what}, ${how}: refused as missing, nothing changed (got ${JSON.stringify(r)})`,
          r.ok === false && r.applied.length === 0 && want.test(String(r.error)) && w.alive().length === before && instanced === 0
          && nameOf(w, "r:1") === "Gone frame" && peekRemoved(w.scene.nodes["r:2"] ?? {}, "characters") === "a" && nameOf(w, GONE_COMPONENT) === "Gone component");
        // Refused by the lookup itself: the id was looked up (a ref that does not read as an id never is, tree-refs.ts).
        ok(`[ANNOUNCE] …${what}, ${how}: the write looked '${id}' up by id (looked up: ${JSON.stringify(looked.slice(asked))})`, looked.slice(asked).includes(id));
      }
    }
    // A library component has no parent by design (and neither has its own layer's chain a page): it is still found,
    // and a patch of it or inside it is refused as the library's, not as missing.
    const lib: FakeNode = { id: "lib:1", type: "COMPONENT", name: "Avatar", key: "e".repeat(40), remote: true, parent: null, removed: false, visible: true, getInstancesAsync: async () => [] };
    const dot: FakeNode = { id: "lib:2", type: "FRAME", name: "Dot", parent: lib, removed: false, visible: true, fills: [] };
    lib.children = [dot];
    const w = await treeWorld({ extra: { nodes: { "lib:1": lib, "lib:2": dot } } });
    for (const [what, nodeId] of [["a library component", "lib:1"], ["a layer inside one", "lib:2"]] as const) {
      const r = await w.api.applyWrites([{ op: "patch", nodeId, set: { name: "x" } }]);
      ok(`[ANNOUNCE] ${what} is found by id, never missing: refused as the library's (got ${JSON.stringify(r.error)})`,
        r.ok === false && /lives in another library file/.test(String(r.error)) && !/no node with id/.test(String(r.error)) && lib.name === "Avatar" && dot.name === "Dot");
    }
    const raw = rawLookups();
    ok(`[ANNOUNCE] …every write-path lookup by id goes through node-lookup.ts nodeById (raw lookups: ${JSON.stringify(raw)})`, raw.length === 0);
  },
}, {
  name: "Two layers deleted after a preview: the refusal lists both and says the preview's image stays, never \"nothing was changed\" (#206)",
  async run() {
    for (const how of ["gone", "removed", "soft"] as const) {
      const { w, card, reply } = await previewedAndPutBack("two-" + how, { drop: ["x:1", "x:2"], how });
      const t = w.notified.length;
      const p = w.posted.length;
      await w.send({ type: "review-answer", id: String(card?.id), action: "apply" });
      const r = replyOf(await reply);
      const text = String(lastWrites(w)?.text);
      const lines = "ops[1] (patch): no node with id 'x:1' (invalid or removed)\nops[2] (patch): no node with id 'x:2' (invalid or removed)";
      ok(`[ANNOUNCE] two problems after a preview (${how}): the agent gets both, and what landed, once (got ${JSON.stringify(r.error)})`,
        r.ok === false && r.error === "the file changed while the write waited for review: 2 problems — no layer was changed, but the batch had already loaded 1 image file into Figma:\n" + lines);
      ok(`[ANNOUNCE] …and the designer the same, both on one line (got ${JSON.stringify(text)}, ${JSON.stringify(w.notified.slice(t))})`,
        saidOnce(w, t, p, text) && text === "Design Twin refused an edit request — no layer changed, but it had already loaded 1 image file into Figma: the file changed while the write waited for review: 2 problems: " + lines.replace("\n", "; "));
    }
    // Previewed again instead: the same, after the preview's own head.
    const { w, card, reply } = await previewedAndPutBack("two-again", { drop: ["x:1", "x:2"] });
    const t = w.notified.length;
    const p = w.posted.length;
    await w.send({ type: "review-answer", id: String(card?.id), action: "preview" });
    const r = replyOf(await reply);
    const text = String(lastWrites(w)?.text);
    ok(`[ANNOUNCE] …previewed again: no "nothing was changed" anywhere (got ${JSON.stringify(r.error)}, ${JSON.stringify(text)})`,
      r.ok === false && !/nothing (in the file )?was changed/i.test(String(r.error)) && /2 problems — no layer was changed, but the batch had already loaded 1 image file into Figma:\n/.test(String(r.error))
      && saidOnce(w, t, p, text) && !/nothing was changed/i.test(text) && /: 2 problems: ops\[1\]/.test(text));
  },
}, {
  name: "\"Allow edits\" turned off while an image preview is on the canvas: the designer is told the image too (#206)",
  async run() {
    const nodes: Record<string, { id: string; type: string; name: string; visible: boolean }> = {};
    for (let i = 1; i <= 26; i++) nodes["x:" + i] = { id: "x:" + i, type: "FRAME", name: "Old " + i, visible: true };
    const w = await treeWorld({ extra: { reviewer: "real", nodes } });
    const A = "a".repeat(64);
    const ops: WriteOp[] = [{ op: "createTree", tree: { name: "Pic", fills: [{ type: "image", file: "one.gif", image: A }] } },
      ...Object.keys(nodes).map((nodeId): WriteOp => ({ op: "patch", nodeId, set: { name: "New" } }))];
    const from = w.posted.length;
    const reply = bridgeWrite(w, "off1", ops, { [A]: gif(2, 2) });
    await tick(() => w.posted.slice(from).some((m) => m.type === "review" || m.type === "bridge-result"));
    const card = w.posted.slice(from).find((m) => m.type === "review");
    await w.send({ type: "review-answer", id: String(card?.id), action: "preview" });
    await tick(() => w.posted.slice(from).some((m) => m.type === "review-state" && m.state === "previewing"));
    const t = w.notified.length;
    const p = w.posted.length;
    await w.allowEdits(false);
    const r = replyOf(await reply);
    const text = String(lastWrites(w)?.text);
    ok(`[ANNOUNCE] unticked during an image preview: the preview stays, and the agent hears of the image (got ${JSON.stringify(r.error)})`,
      r.refused === "edits-off" && w.alive().some((n) => n.name === "Pic") && /The batch had already loaded 1 image file into Figma; that stays\.$/.test(String(r.error)));
    ok(`[ANNOUNCE] …and the designer too, in the toast and on the panel (got ${JSON.stringify(text)}, ${JSON.stringify(w.notified.slice(t))})`,
      w.notified.slice(t).length === 1 && w.notified[t] === text && writesOf(w.posted.slice(p)).length === 1
      && text === "Design Twin applied 27 edits, then stopped — 'Allow edits' was turned off. It had already loaded 1 image file into Figma.");
  },
}, {
  name: "A refusal whose put-back failed never says \"Nothing was changed\" (#206)",
  async run() {
    const w = await treeWorld({ kit: true });
    // The batch's own collection cannot be removed again: its put-back fails, and the collection stays.
    const realCreate = w.figma.variables.createVariableCollection;
    if (!realCreate) throw new Error("the fake has no createVariableCollection");
    w.figma.variables.createVariableCollection = (name: string) => {
      const c: FakeCollection & { remove?: () => void } = realCreate(name);
      c.remove = () => { throw new Error("in Figma: the collection is in use"); };
      return c;
    };
    const t = w.notified.length;
    const p = w.posted.length;
    const r = await w.api.applyWrites([
      { op: "createVariables", collection: "Local", variables: [["local/bg", "color", "#ffffff"]] },
      { op: "createTree", tree: { name: "Card", fills: [{ type: "solid", tokens: { color: "local/bg" } }], children: [{ component: "a".repeat(40) }] } },
    ]);
    w.figma.variables.createVariableCollection = realCreate;
    const text = String(lastWrites(w)?.text);
    const kept = Object.values(w.scene.collections).some((c) => c.name === "Local");
    ok(`[ANNOUNCE] a put-back that failed: the collection stays, listed as applied (got ${JSON.stringify(r)})`,
      r.ok === false && kept && r.applied.length > 0 && /could not undo/.test(String(r.error)));
    ok(`[ANNOUNCE] …the agent is never told nothing was changed (got ${JSON.stringify(r.error)})`,
      !/nothing (in the file )?was changed/i.test(String(r.error)) && /^ops\[1\] \(createTree\): tree\.children\[0\]\.component: no component .*\. Not all of the batch could be put back: could not undo /.test(String(r.error)));
    ok(`[ANNOUNCE] …nor the designer (got ${JSON.stringify(text)})`, w.notified.slice(t).length === 1 && w.notified[t] === text && writesOf(w.posted.slice(p)).length === 1
      && !/nothing (was )?changed/i.test(text) && /could not undo/.test(text));
  },
});

// ---- #206 review 6: a node detached after the batch resolved, before the op that holds it runs.

cases.push({
  name: "A layer deleted while an approved write makes its image (after it resolved) fails as missing: put back, never \"applied\" (#206)",
  async run() {
    // The race seen in review: Preview, Put back, Apply; the layer goes while the approved run makes its image, after the
    // run resolved the batch against the file. A soft-deleted main component; a plain frame left the same way; a removed one.
    const runs: Array<[string, { how: Deleted; component?: boolean }]> = [
      ["a soft-deleted main component", { how: "soft", component: true }],
      ["a frame detached (not removed, no parent)", { how: "soft" }],
      ["a removed frame", { how: "removed" }],
    ];
    for (const [what, opts] of runs) {
      const { w, card, reply, hash } = await previewedAndPutBack("late-" + opts.how + String(!!opts.component), { ...opts, late: true });
      const t = w.notified.length;
      const p = w.posted.length;
      await w.send({ type: "review-answer", id: String(card?.id), action: "apply" });
      const r = replyOf(await reply) as { ok?: unknown; error?: unknown; applied?: unknown; restored?: unknown; failedAt?: unknown };
      const text = String(lastWrites(w)?.text);
      const h = hash();
      ok(`[ANNOUNCE] ${what} after the run resolved: the approved write fails at it and is put back whole (got ${JSON.stringify(r)})`,
        r.ok === false && r.failedAt === 1 && Array.isArray(r.applied) && r.applied.length === 0 && Array.isArray(r.restored) && r.restored.length === 1
        && !w.alive().some((n) => n.name === "Pic") && nameOf(w, "x:1") === "Old 1" && nameOf(w, "x:2") === "Old 2");
      ok(`[ANNOUNCE] …${what}: the agent is told it is missing, and that the image stays (got ${JSON.stringify(r.error)})`,
        r.error === "no node with id 'x:1' (invalid or removed)." + LOADED_STAYS && h !== undefined && w.figma.getImageByHash(h) !== null);
      ok(`[ANNOUNCE] …${what}: and the designer the same, never "applied" (got ${JSON.stringify(text)}, ${JSON.stringify(w.notified.slice(t))})`,
        saidOnce(w, t, p, text) && text === "Design Twin undid 1 earlier change after an edit failed, but it had already loaded 1 image file into Figma: no node with id 'x:1' (invalid or removed)");
    }
  },
}, {
  name: "Every op whose node is deleted after its batch resolved (while the batch makes its image) fails as missing, and the batch is put back (#206)",
  async run() {
    // Each op runs twice in a world of its own: as is (it lands: the case is a real one), and with its node removed or
    // detached while the batch makes its image, after the batch resolved, before the op runs.
    const tries: Late[] = [
      { what: "setFill", op: (h) => ({ op: "setFill", nodeId: h.mine, color: "#ff0000" }), gone: (h) => h.mine, want: (h) => "setFill: no node with id '" + h.mine + "' (invalid or removed)" },
      { what: "setText", op: (h) => ({ op: "setText", nodeId: h.label, text: "b" }), gone: (h) => h.label, want: (h) => "setText: no node with id '" + h.label + "' (invalid or removed)" },
      { what: "patch", op: (h) => ({ op: "patch", nodeId: h.mine, set: { name: "Renamed" } }), gone: (h) => h.mine, want: (h) => "no node with id '" + h.mine + "' (invalid or removed)" },
      { what: "patch of a main component", op: (h) => ({ op: "patch", nodeId: h.chip, set: { name: "Renamed" } }), gone: (h) => h.chip, want: (h) => "no node with id '" + h.chip + "' (invalid or removed)" },
      { what: "patchWhere", op: () => ({ op: "patchWhere", where: { name: "Mine" }, set: { name: "Renamed" } }), gone: (h) => h.mine, want: (h) => "'Mine' (" + h.mine + "), one of the 1 layers its rule matches: no node with id '" + h.mine + "' (invalid or removed)" },
      { what: "setVariableMode", op: () => ({ op: "setVariableMode", nodeId: "40:1", collection: "Theme", mode: "Dark" }), gone: () => "40:1", want: () => "no node with id '40:1' (invalid or removed)" },
      { what: "clearVariableMode", op: () => ({ op: "clearVariableMode", nodeId: "40:1", collection: "Theme" }), gone: () => "40:1", want: () => "no node with id '40:1' (invalid or removed)" },
      { what: "delete", op: (h) => ({ op: "delete", nodeId: h.mine }), gone: (h) => h.mine, want: (h) => "no node with id '" + h.mine + "' (invalid or removed)" },
      { what: "move of it", op: (h) => ({ op: "move", nodeId: h.mine, parentId: h.box }), gone: (h) => h.mine, want: (h) => "no node with id '" + h.mine + "' (invalid or removed)" },
      { what: "move into it", op: (h) => ({ op: "move", nodeId: h.mine, parentId: h.box }), gone: (h) => h.box, want: (h) => "no parent with id '" + h.box + "' (invalid or removed)" },
      { what: "createFrame into it", op: (h) => ({ op: "createFrame", name: "Child", parentId: h.box }), gone: (h) => h.box, want: (h) => "parent '" + h.box + "' not found (invalid or removed id)" },
      { what: "createText into it", op: (h) => ({ op: "createText", text: "Child", parentId: h.box }), gone: (h) => h.box, want: (h) => "parent '" + h.box + "' not found (invalid or removed id)" },
      { what: "a copy of it", op: (h) => ({ op: "createTree", tree: { clone: h.mine } }), gone: (h) => h.mine, want: (h) => "no node with id '" + h.mine + "' (invalid or removed)" },
      { what: "an instance of it", op: () => ({ op: "createTree", tree: { name: "Holder", children: [{ component: "Chip" }] } }), gone: (h) => h.chip, want: (h) => "no component with id '" + h.chip + "' (invalid or removed)" },
      { what: "a swap property's default", op: () => ({ op: "createTree", tree: { type: "COMPONENT", name: "Card", props: { Glyph: { type: "INSTANCE_SWAP", default: "Chip" } } } }), gone: (h) => h.chip, want: (h) => "no component with id '" + h.chip + "' (invalid or removed)" },
      { what: "a keyed re-send of it", op: () => ({ op: "createTree", tree: { key: "late", name: "Keyed again" } }), gone: (h) => h.keyed, want: (h) => "no node with id '" + h.keyed + "' (invalid or removed)" },
    ];
    const ways: Array<[string, ((n: FakeNode) => void) | null]> = [
      ["as is", null],
      ["removed", (n) => { markRemoved(n); }],
      ["detached (not removed, no parent)", (n) => { n.parent = null; }],
    ];
    for (const t of tries) {
      for (const [how, detach] of ways) {
        const { w, h } = await lateWorld();
        const op = t.op(h);
        const id = t.gone(h);
        let hash: string | undefined;
        const real = w.figma.createImage;
        w.figma.createImage = (data: Uint8Array) => { const n = w.scene.nodes[id]; if (detach && n) detach(n); const img = real(data); hash = img.hash; return img; };
        const before = snapshotOf(w, h);
        const r = await w.api.applyWrites([PIC, op], { [PIC_HASH]: gif(2, 2) });
        w.figma.createImage = real;
        if (!detach) {
          ok(`[ANNOUNCE] ${t.what}, ${how}: it lands (got ${JSON.stringify(r)})`, r.ok === true && r.applied.length === 2);
          continue;
        }
        ok(`[ANNOUNCE] ${t.what}, its node ${how} after the batch resolved: fails at it, put back whole, its node untouched (got ${JSON.stringify(r)})`,
          r.ok === false && r.failedAt === 1 && r.applied.length === 0 && (r.restored || []).length === 1 && !w.alive().some((n) => n.name === "Pic")
          && snapshotOf(w, h) === before && hash !== undefined && w.figma.getImageByHash(hash) !== null);
        ok(`[ANNOUNCE] …${t.what}, ${how}: missing, as it would be before the batch ran, and the image stays (got ${JSON.stringify(r.error)})`,
          r.error === t.want(h) + "." + LOADED_STAYS);
      }
    }
  },
}, {
  name: "A node deleted while its own op waits for a font fails as missing (#206)",
  async run() {
    // The op's own await, between its lookup and its first change: a font load.
    const tries: Late[] = [
      { what: "setText", op: (h) => ({ op: "setText", nodeId: h.label, text: "b" }), gone: (h) => h.label, want: (h) => "setText: no node with id '" + h.label + "' (invalid or removed)" },
      { what: "setFill of a text", op: (h) => ({ op: "setFill", nodeId: h.label, color: "#ff0000" }), gone: (h) => h.label, want: (h) => "setFill: no node with id '" + h.label + "' (invalid or removed)" },
      { what: "patch of a text", op: (h) => ({ op: "patch", nodeId: h.label, set: { text: "b" } }), gone: (h) => h.label, want: (h) => "no node with id '" + h.label + "' (invalid or removed)" },
      { what: "createText into a frame", op: (h) => ({ op: "createText", text: "Child", parentId: h.box }), gone: (h) => h.box, want: (h) => "parent '" + h.box + "' not found (invalid or removed id)" },
    ];
    for (const t of tries) {
      // As is; detached (no parent); removed (its fields then throw when read: markRemoved).
      const ways: Array<[string, ((n: FakeNode) => void) | null]> = [["as is", null], ["detached", (n) => { n.parent = null; }], ["removed", (n) => { markRemoved(n); }]];
      for (const [how, detach] of ways) {
        const { w, h } = await lateWorld();
        const id = t.gone(h);
        const load = w.figma.loadFontAsync;
        if (!load) throw new Error("the fake has no loadFontAsync");
        // Every font load once the batch runs (its first op has made "First") detaches it: the last one before the op's
        // change is what counts. (One while the batch resolves: the next case.)
        w.figma.loadFontAsync = async (f) => { const n = w.scene.nodes[id]; if (detach && n && w.alive().some((x) => x.name === "First")) detach(n); return load(f); };
        const before = snapshotOf(w, h);
        const r = await w.api.applyWrites([{ op: "createFrame", name: "First" }, t.op(h)]);
        w.figma.loadFontAsync = load;
        if (!detach) {
          ok(`[ANNOUNCE] ${t.what}, as is: it lands (got ${JSON.stringify(r)})`, r.ok === true && r.applied.length === 2);
          continue;
        }
        ok(`[ANNOUNCE] ${t.what}, its node ${how} during a font load: missing, put back whole, its node untouched (got ${JSON.stringify(r)})`,
          r.ok === false && r.failedAt === 1 && r.applied.length === 0 && (r.restored || []).length === 1 && r.error === t.want(h)
          && !w.alive().some((n) => n.name === "First") && snapshotOf(w, h) === before);
      }
    }
  },
});

// ---- #206 review 7: a node deleted during an op's own await (a text style being set), after the op checked it; and a
// keyed reorder that fails partway.

/** Two ways the designer can take a held node out of the document during an await: detached (no parent, out of its
 *  parent's layers: as a soft-deleted main component is), or removed (markRemoved: its fields then throw when read). */
const OUT: Array<[string, (n: FakeNode) => void]> = [
  ["detached", (n) => { const p = n.parent; if (p && typeof p === "object") { const q = p as FakeNode; q.children = (q.children ?? []).filter((c) => c !== n); } n.parent = null; }],
  ["removed", (n) => { markRemoved(n); }],
];

/** A node's children, read past a removal (markRemoved). */
const kidsOf = (n: FakeNode | undefined): FakeNode[] => (n ? (peekRemoved(n, "children") as FakeNode[] | undefined) ?? [] : []);
const namesOf = (list: readonly FakeNode[]): unknown[] => list.map((c) => peekRemoved(c, "name"));

cases.push({
  name: "A keyed re-send whose build parent goes while a new child's text style is set fails as missing: nothing added to it, put back (#206)",
  async run() {
    for (const [how, out] of OUT) {
      const w = await treeWorld({ kit: true });
      const tree = (rest: Array<Record<string, unknown>> = []) => ({ key: "race", name: "Race", children: [{ name: "Parent", handle: "parent", children: rest }] });
      const first = await w.api.applyWrites([{ op: "createTree", tree: tree() }]);
      const root = w.scene.nodes[String(first.applied[0]?.id)];
      const parentId = String(first.applied[0]?.handles?.parent);
      const parent = w.scene.nodes[parentId];
      let styled = 0;
      // The first new child's style await: the designer deletes the frame both new children go into.
      w.hooks.onStyle = async () => { if (!styled++ && parent) out(parent); };
      const t = w.notified.length;
      const p = w.posted.length;
      const r = replyOf(await bridgeWrite(w, "r7-keyed-" + how, [{ op: "createTree", tree: tree([{ name: "Wait", text: "Wait", styles: { text: "Body" } }, { name: "Later" }]) }])) as { ok?: unknown; error?: unknown; applied?: unknown; failedAt?: unknown };
      w.hooks.onStyle = undefined;
      const text = String(lastWrites(w)?.text);
      ok(`[ANNOUNCE] keyed, its build parent ${how} during a child's style await: fails as missing, nothing applied (got ${JSON.stringify(r)})`,
        styled === 1 && r.ok === false && r.failedAt === 0 && Array.isArray(r.applied) && r.applied.length === 0 && r.error === "no node with id '" + parentId + "' (invalid or removed)");
      // Detached, the frame keeps nothing of the batch; removed, "Wait" was in it when it went (and went with it): never
      // "Later", built after it went.
      const left = namesOf(kidsOf(parent));
      ok(`[ANNOUNCE] …${how}: no new child is left anywhere, none added once the frame was gone (children ${JSON.stringify(left)})`,
        (how === "detached" ? left.length === 0 : !left.includes("Later")) && !w.alive().some((n) => n.name === "Wait" || n.name === "Later") && kidsOf(root).length === 0);
      ok(`[ANNOUNCE] …${how}: the designer is told nothing changed, and why (got ${JSON.stringify(text)})`,
        saidOnce(w, t, p, text) && text === HEAD + "no node with id '" + parentId + "' (invalid or removed)");
    }
  },
}, {
  name: "A tree whose page goes while one of its texts' style is set fails as missing: nothing lands on the page, nothing stays (#206)",
  async run() {
    for (const [how, out] of OUT) {
      const w = await treeWorld({ kit: true });
      const dest = w.pages.screens;
      let styled = 0;
      w.hooks.onStyle = async () => { if (!styled++) out(dest); };
      const t = w.notified.length;
      const p = w.posted.length;
      const r = replyOf(await bridgeWrite(w, "r7-page-" + how, [{ op: "createTree", page: "Screens", tree: { name: "New tree", children: [{ name: "Wait", text: "Wait", styles: { text: "Body" } }] } }])) as { ok?: unknown; error?: unknown; applied?: unknown; failedAt?: unknown };
      w.hooks.onStyle = undefined;
      const text = String(lastWrites(w)?.text);
      const want = "no page with id '" + String(dest.id) + "' (invalid or removed)";
      ok(`[ANNOUNCE] a tree, its page ${how} during a style await: fails as missing, nothing applied (got ${JSON.stringify(r)})`,
        styled === 1 && r.ok === false && r.failedAt === 0 && Array.isArray(r.applied) && r.applied.length === 0 && r.error === want);
      ok(`[ANNOUNCE] …${how}: the tree is on no page, the gone one included (its layers ${JSON.stringify(namesOf(kidsOf(dest)))})`,
        kidsOf(dest).length === 0 && !w.alive().some((n) => n.name === "New tree" || n.name === "Wait"));
      ok(`[ANNOUNCE] …${how}: the designer is told nothing changed, and why (got ${JSON.stringify(text)})`, saidOnce(w, t, p, text) && text === HEAD + want);
    }
  },
});

cases.push({
  name: "A keyed re-send whose next build's frame goes during an earlier build's await builds nothing into it (#206)",
  async run() {
    for (const [how, out] of OUT) {
      const w = await treeWorld({ kit: true });
      const tree = (a: Array<Record<string, unknown>> = [], b: Array<Record<string, unknown>> = []) =>
        ({ key: "two", name: "Two", children: [{ name: "First", handle: "first", children: a }, { name: "Second", handle: "second", children: b }] });
      const made = await w.api.applyWrites([{ op: "createTree", tree: tree() }]);
      const secondId = String(made.applied[0]?.handles?.second);
      const second = w.scene.nodes[secondId];
      let styled = 0;
      // First's new child awaits its style: the designer deletes Second, which the next new child goes into.
      w.hooks.onStyle = async () => { if (!styled++ && second) out(second); };
      const r = await w.api.applyWrites([{ op: "createTree", tree: tree([{ name: "Wait", text: "Wait", styles: { text: "Body" } }], [{ name: "Later" }]) }]);
      w.hooks.onStyle = undefined;
      ok(`[ANNOUNCE] keyed, the next build's frame ${how} during an earlier build: fails as missing, put back, nothing built into it (got ${JSON.stringify(r)}, ${JSON.stringify(namesOf(kidsOf(second)))})`,
        styled === 1 && r.ok === false && r.applied.length === 0 && r.error === "no node with id '" + secondId + "' (invalid or removed)" && (r.restored || []).length === 1
        && kidsOf(second).length === 0 && !w.alive().some((n) => n.name === "Wait" || n.name === "Later"));
    }
  },
});

cases.push({
  name: "A patch whose node goes while its text style is set fails as missing, its text never written (#206)",
  async run() {
    for (const [how, out] of OUT) {
      const w = await treeWorld({ kit: true });
      const made = await w.api.applyWrites([{ op: "createTree", tree: { name: "Target", children: [{ name: "Text", text: "original", handle: "text" }] } }]);
      const id = String(made.applied[0]?.handles?.text);
      const node = w.scene.nodes[id];
      let styled = 0;
      w.hooks.onStyle = async () => { if (!styled++ && node) out(node); };
      const t = w.notified.length;
      const p = w.posted.length;
      const r = replyOf(await bridgeWrite(w, "r7-patch-" + how, [{ op: "patch", nodeId: id, set: { text: "updated", styles: { text: "Body" } } }])) as { ok?: unknown; error?: unknown; applied?: unknown; failedAt?: unknown };
      w.hooks.onStyle = undefined;
      const text = String(lastWrites(w)?.text);
      const want = "no node with id '" + id + "' (invalid or removed)";
      ok(`[ANNOUNCE] a patch, its node ${how} during its style await: fails as missing, its text unchanged (got ${JSON.stringify(r)}, text ${JSON.stringify(node ? peekRemoved(node, "characters") : null)})`,
        styled === 1 && r.ok === false && r.failedAt === 0 && typeof r.error === "string" && r.error.startsWith(want) && node !== undefined && peekRemoved(node, "characters") === "original");
      // Detached, the patch's style is put back and nothing stays; removed, a node Figma reads nothing of cannot be put
      // back, and the reply says so rather than "nothing changed".
      if (how === "detached") {
        ok(`[ANNOUNCE] …detached: put back, nothing applied, and the designer is told nothing changed (got ${JSON.stringify(text)})`,
          Array.isArray(r.applied) && r.applied.length === 0 && r.error === want && saidOnce(w, t, p, text) && text === HEAD + want);
      } else {
        const lost = want + "; could not undo the changes to 'Text' (" + id + ") (it was deleted from the file after the patch changed it)";
        ok(`[ANNOUNCE] …removed: the patch stays listed, the reply says it went with the node, never "nothing changed" (got ${JSON.stringify(r)})`,
          Array.isArray(r.applied) && r.applied.length === 1 && r.error === lost);
        ok(`[ANNOUNCE] …removed: and the designer the same (got ${JSON.stringify(text)})`,
          w.notified.slice(t).length === 1 && w.notified[t] === text && text === "Design Twin applied 1 edit that could not be put back after one failed: " + lost);
      }
    }
  },
});

cases.push({
  name: "A patch whose text goes while the batch resolves (a font it keeps loading) is refused whole as missing, never with Figma's read error (#206)",
  async run() {
    for (const [how, out] of OUT) {
      const { w, h } = await lateWorld();
      const load = w.figma.loadFontAsync;
      if (!load) throw new Error("the fake has no loadFontAsync");
      let loads = 0;
      w.figma.loadFontAsync = async (f) => { loads++; const n = w.scene.nodes[h.label]; if (n && n.removed !== true && n.parent !== null) out(n); return load(f); };
      const before = snapshotOf(w, h);
      const r = await w.api.applyWrites([{ op: "patch", nodeId: h.label, set: { text: "b" } }]);
      w.figma.loadFontAsync = load;
      ok(`[ANNOUNCE] a patch, its text ${how} while the batch resolves: refused whole as missing (got ${JSON.stringify(r)})`,
        loads > 0 && r.ok === false && r.failedAt === 0 && r.applied.length === 0 && r.error === "ops[0] (patch): no node with id '" + h.label + "' (invalid or removed). Nothing was changed." && snapshotOf(w, h) === before);
    }
  },
});

cases.push({
  name: "A keyed reorder that fails at its second move is put back, so \"nothing changed\" is true (#206)",
  async run() {
    const w = await treeWorld();
    const tree = (names: string[]) => ({ key: "order", name: "Order", children: names.map((name) => ({ name, handle: name })) });
    const first = await w.api.applyWrites([{ op: "createTree", tree: tree(["A", "B", "C"]) }]);
    const root = w.scene.nodes[String(first.applied[0]?.id)];
    if (!root) throw new Error("no keyed root");
    const insert = root.insertChild as (index: number, node: unknown) => void;
    let calls = 0;
    // Figma refusing the second move (injected: a reorder of three is two moves).
    root.insertChild = (index: number, node: unknown) => { if (++calls === 2) throw new Error("insertChild refused"); insert(index, node); };
    const t = w.notified.length;
    const p = w.posted.length;
    const r = replyOf(await bridgeWrite(w, "r7-order", [{ op: "createTree", tree: tree(["C", "B", "A"]) }])) as { ok?: unknown; error?: unknown; applied?: unknown; restored?: unknown };
    root.insertChild = insert;
    const text = String(lastWrites(w)?.text);
    ok(`[ANNOUNCE] a reorder refused at its second move: the first move is put back, A B C as before (got ${JSON.stringify(namesOf(kidsOf(root)))}, ${JSON.stringify(r)})`,
      calls >= 2 && r.ok === false && Array.isArray(r.applied) && r.applied.length === 0 && JSON.stringify(namesOf(kidsOf(root))) === JSON.stringify(["A", "B", "C"]));
    ok(`[ANNOUNCE] …the designer is told nothing changed, and why, and it is true (got ${JSON.stringify(text)})`, saidOnce(w, t, p, text) && text === HEAD + "insertChild refused");

    // Every move refused after the first: the first cannot be put back either, and the reply says it stays.
    calls = 0;
    root.insertChild = (index: number, node: unknown) => { if (++calls >= 2) throw new Error("insertChild refused"); insert(index, node); };
    const t2 = w.notified.length;
    const r2 = replyOf(await bridgeWrite(w, "r7-order-stuck", [{ op: "createTree", tree: tree(["C", "B", "A"]) }])) as { ok?: unknown; error?: unknown; applied?: unknown };
    root.insertChild = insert;
    const text2 = String(lastWrites(w)?.text);
    const stuck = "insertChild refused; could not undo the order of the layers in 'Order' (" + String(root.id) + ") (insertChild refused)";
    ok(`[ANNOUNCE] …a first move that cannot be put back stays, listed as applied, and the agent is told (got ${JSON.stringify(r2)}, ${JSON.stringify(namesOf(kidsOf(root)))})`,
      r2.ok === false && Array.isArray(r2.applied) && r2.applied.length === 1 && r2.error === stuck);
    ok(`[ANNOUNCE] …and the designer the same, never "nothing changed" (got ${JSON.stringify(text2)})`,
      w.notified.slice(t2).length === 1 && text2 === "Design Twin applied 1 edit that could not be put back after one failed: " + stuck);
  },
});

// ---- #206 review 8: every node an op holds across an await is checked after it, before it is read, changed, removed or
// reported (node-lookup.ts holding); a build whose cleanup cannot remove what it made says what stays.

/** The node of a world named `name` (alive or not: the batch's own `made`, read past a removal). */
const madeNamed = (w: World, name: string): FakeNode | undefined => w.made.find((n) => peekRemoved(n, "name") === name);

cases.push({
  name: "A tree whose styled text goes while its own style is set fails as missing: the tree does not land, nothing stays (#206)",
  async run() {
    for (const [how, out] of OUT) {
      const w = await treeWorld({ kit: true });
      let gone = "";
      w.hooks.onStyle = async () => { const s = madeNamed(w, "Styled"); if (s && !gone) { gone = String(s.id); out(s); } };
      const t = w.notified.length;
      const p = w.posted.length;
      const r = replyOf(await bridgeWrite(w, "r8-styled-" + how, [{ op: "createTree", tree: { name: "Container", children: [{ name: "Styled", text: "Text", styles: { text: "Body" }, handle: "styled" }] } }])) as { ok?: unknown; error?: unknown; applied?: unknown; failedAt?: unknown };
      w.hooks.onStyle = undefined;
      const text = String(lastWrites(w)?.text);
      const want = "no node with id '" + gone + "' (invalid or removed)";
      ok(`[ANNOUNCE] a tree, its styled text ${how} during its own style await: fails as missing, nothing applied (got ${JSON.stringify(r)})`,
        gone !== "" && r.ok === false && r.failedAt === 0 && Array.isArray(r.applied) && r.applied.length === 0 && r.error === want);
      ok(`[ANNOUNCE] …${how}: the tree is not in the file (alive ${JSON.stringify(w.alive().map((n) => n.name))})`, !w.alive().some((n) => n.name === "Container" || n.name === "Styled"));
      ok(`[ANNOUNCE] …${how}: the designer is told nothing changed, and why (got ${JSON.stringify(text)})`, saidOnce(w, t, p, text) && text === HEAD + want);
    }
  },
}, {
  name: "A tree whose other styled text goes during a style await fails as missing, whether it was styled before or is styled after (#206)",
  async run() {
    for (const [how, out] of OUT) {
      for (const [which, at] of [["styled before it", 2], ["still to be styled", 1]] as const) {
        const w = await treeWorld({ kit: true });
        let calls = 0;
        let gone = "";
        // The second style await takes out the first text (already styled); the first takes out the second (not yet).
        w.hooks.onStyle = async () => {
          if (++calls !== at) return;
          const s = madeNamed(w, at === 2 ? "A" : "B");
          if (s) { gone = String(s.id); out(s); }
        };
        const r = await w.api.applyWrites([{ op: "createTree", tree: { name: "Pair", children: [{ name: "A", text: "A", styles: { text: "Body" } }, { name: "B", text: "B", styles: { text: "Body" } }] } }]);
        w.hooks.onStyle = undefined;
        ok(`[ANNOUNCE] a tree, a text ${which} ${how} during another's style await: fails as missing, nothing applied, nothing stays (got ${JSON.stringify(r)})`,
          gone !== "" && r.ok === false && r.applied.length === 0 && r.error === "no node with id '" + gone + "' (invalid or removed)" && !w.alive().some((n) => n.name === "Pair"));
      }
    }
  },
}, {
  name: "A copy whose patched text goes during the patch's style await fails as missing: its text is never set (#206)",
  async run() {
    for (const [how, out] of OUT) {
      const w = await treeWorld({ kit: true });
      const first = await w.api.applyWrites([{ op: "createTree", tree: { name: "Source", children: [{ name: "Title", text: "original", handle: "title" }] } }]);
      const sourceTitle = String(first.applied[0]?.handles?.title);
      let gone: FakeNode | undefined;
      w.hooks.onStyle = async () => {
        if (gone) return;
        gone = w.made.find((n) => n.type === "TEXT" && peekRemoved(n, "name") === "Title" && n.id !== sourceTitle);
        if (gone) out(gone);
      };
      const t = w.notified.length;
      const p = w.posted.length;
      const r = replyOf(await bridgeWrite(w, "r8-copy-" + how, [{ op: "createTree", tree: { clone: String(first.applied[0]?.id), name: "Copy", edits: { Title: { text: "updated", styles: { text: "Body" } } } } }])) as { ok?: unknown; error?: unknown; applied?: unknown };
      w.hooks.onStyle = undefined;
      const text = String(lastWrites(w)?.text);
      const want = "no node with id '" + String(gone?.id) + "' (invalid or removed)";
      ok(`[ANNOUNCE] a copy, its patched text ${how} during the style await: fails as missing, nothing applied, its text never set (got ${JSON.stringify(r)}, text ${JSON.stringify(gone ? peekRemoved(gone, "characters") : null)})`,
        gone !== undefined && r.ok === false && Array.isArray(r.applied) && r.applied.length === 0 && r.error === want && peekRemoved(gone, "characters") !== "updated");
      ok(`[ANNOUNCE] …${how}: no copy stays, the source is untouched, and the designer is told nothing changed (got ${JSON.stringify(text)})`,
        !w.alive().some((n) => n.name === "Copy") && w.scene.nodes[sourceTitle]?.characters === "original" && saidOnce(w, t, p, text) && text === HEAD + want);
    }
  },
}, {
  name: "A copy whose patched layer goes during another text's style await fails as missing, never read (#206)",
  async run() {
    for (const [how, out] of OUT) {
      const w = await treeWorld({ kit: true });
      const first = await w.api.applyWrites([{ op: "createTree", tree: { name: "Source", children: [{ name: "Title", text: "original", handle: "title" }] } }]);
      const sourceTitle = String(first.applied[0]?.handles?.title);
      let gone: FakeNode | undefined;
      // The tree's own text awaits its style before the copy's patch runs: the copy's layer goes then.
      w.hooks.onStyle = async () => {
        if (gone) return;
        gone = w.made.find((n) => n.type === "TEXT" && peekRemoved(n, "name") === "Title" && n.id !== sourceTitle);
        if (gone) out(gone);
      };
      const r = await w.api.applyWrites([{ op: "createTree", tree: { name: "Holder", children: [{ name: "Wait", text: "Wait", styles: { text: "Body" } }, { clone: String(first.applied[0]?.id), name: "Copy", edits: { Title: { text: "updated" } } }] } }]);
      w.hooks.onStyle = undefined;
      ok(`[ANNOUNCE] a copy's patched layer ${how} before its patch runs: fails as missing, nothing applied, nothing stays (got ${JSON.stringify(r)})`,
        gone !== undefined && r.ok === false && r.applied.length === 0 && r.error === "no node with id '" + String(gone.id) + "' (invalid or removed)"
        && !w.alive().some((n) => n.name === "Holder") && w.scene.nodes[sourceTitle]?.characters === "original");
    }
  },
}, {
  name: "A createText with no parent whose page goes while its font loads fails as missing: no text is left on that page (#206)",
  async run() {
    const w = await treeWorld();
    const dest = w.pages.current;
    const survivor = w.pages.screens;
    const realLoad = w.figma.loadFontAsync;
    if (!realLoad) throw new Error("the world loads no fonts");
    let hit = false;
    w.figma.loadFontAsync = async (f: { family: string; style: string }) => {
      await realLoad(f);
      if (hit || !w.made.some((n) => n.type === "TEXT")) return;
      hit = true;
      w.figma.currentPage = survivor;
      dest.parent = null;
    };
    const t = w.notified.length;
    const p = w.posted.length;
    const r = replyOf(await bridgeWrite(w, "r8-create-text", [{ op: "createText", text: "Hello" }])) as { ok?: unknown; error?: unknown; applied?: unknown };
    w.figma.loadFontAsync = realLoad;
    const text = String(lastWrites(w)?.text);
    const want = "no page with id '" + String(dest.id) + "' (invalid or removed)";
    ok(`[ANNOUNCE] createText, its current page detached during the font load: fails as missing, nothing applied (got ${JSON.stringify(r)})`,
      hit && r.ok === false && Array.isArray(r.applied) && r.applied.length === 0 && r.error === want);
    ok(`[ANNOUNCE] …no text is left on the old page or the new one, and the designer is told nothing changed (got ${JSON.stringify(text)})`,
      !(dest.children ?? []).some((n) => n.type === "TEXT") && !(survivor.children ?? []).some((n) => n.type === "TEXT") && saidOnce(w, t, p, text) && text === HEAD + want);
  },
}, {
  name: "A build whose cleanup cannot remove what it made says it stays, never \"nothing changed\" (#206)",
  async run() {
    // A new tree, a new component and a keyed re-send's new child, each failing during a style await (its page detached,
    // or Figma refusing the style), and Figma refusing the remove() that would have taken back what it built. What stays
    // in the document is listed as applied; a node left only inside a detached frame is in no page, so nothing stays.
    type Build = { what: string; stuck: string; kind: string; fail: "detach" | "refuse"; first?: WriteOp[]; dest: (w: World, f: Record<string, unknown> | undefined) => FakeNode | undefined; op: WriteOp; stays: boolean };
    const keyedFirst: WriteOp[] = [{ op: "createTree", tree: { key: "stuck", name: "Stuck", children: [{ name: "Box", handle: "box" }] } }];
    const keyedOp: WriteOp = { op: "createTree", tree: { key: "stuck", name: "Stuck", children: [{ name: "Box", handle: "box", children: [{ name: "Added", children: [{ name: "Wait", text: "Wait", styles: { text: "Body" } }] }] }] } };
    const boxOf = (w: World, f: Record<string, unknown> | undefined): FakeNode | undefined => w.scene.nodes[String((f?.handles as Record<string, string> | undefined)?.box)];
    const builds: Build[] = [
      { what: "a new tree", stuck: "New tree", kind: "the unfinished tree", fail: "detach", stays: true, dest: (w) => w.pages.screens,
        op: { op: "createTree", page: "Screens", tree: { name: "New tree", children: [{ name: "Wait", text: "Wait", styles: { text: "Body" } }] } } },
      { what: "a new component", stuck: "Stuck badge", kind: "the unfinished component", fail: "detach", stays: true, dest: (w) => w.pages.screens,
        op: { op: "createTree", page: "Screens", tree: { type: "COMPONENT", name: "Stuck badge", children: [{ name: "Wait", text: "Wait", styles: { text: "Body" } }] } } },
      { what: "a keyed re-send's new child", stuck: "Added", kind: "the unfinished node", fail: "refuse", stays: true, first: keyedFirst, dest: boxOf, op: keyedOp },
      { what: "a keyed re-send's new child in a detached frame", stuck: "Added", kind: "the unfinished node", fail: "detach", stays: false, first: keyedFirst, dest: boxOf, op: keyedOp },
    ];
    for (const b of builds) {
      const w = await treeWorld({ kit: true });
      const firstReply = b.first ? (await w.api.applyWrites(b.first)).applied[0] as Record<string, unknown> | undefined : undefined;
      const dest = b.dest(w, firstReply);
      let stuck: FakeNode | undefined;
      w.hooks.onStyle = async () => {
        if (stuck || !dest) return;
        stuck = madeNamed(w, b.stuck);
        if (stuck) stuck.remove = () => { throw new Error("remove refused"); };
        if (b.fail === "refuse") throw new Error("style refused");
        const q = dest.parent as FakeNode | null;
        if (q && Array.isArray(q.children)) q.children = q.children.filter((c) => c !== dest);
        dest.parent = null;
      };
      const t = w.notified.length;
      const p = w.posted.length;
      const r = replyOf(await bridgeWrite(w, "r8-stuck-" + b.stuck + b.fail, [b.op])) as { ok?: unknown; error?: unknown; applied?: unknown };
      w.hooks.onStyle = undefined;
      const text = String(lastWrites(w)?.text);
      const why = b.fail === "refuse" ? "style refused" : b.first ? "no node with id '" + String(dest?.id) + "' (invalid or removed)" : "no page with id '" + String(dest?.id) + "' (invalid or removed)";
      const applied = Array.isArray(r.applied) ? r.applied as Array<Record<string, unknown>> : [];
      if (!b.stays) {
        ok(`[ANNOUNCE] ${b.what}, not removable: in no page, so nothing stays and nothing is listed (got ${JSON.stringify(r)})`,
          stuck !== undefined && r.ok === false && applied.length === 0 && r.error === why && saidOnce(w, t, p, text) && text === HEAD + why);
        continue;
      }
      const want = why + "; could not undo " + b.kind + " '" + b.stuck + "' (" + String(stuck?.id) + ") (remove refused)";
      ok(`[ANNOUNCE] ${b.what} that cannot be removed after it failed: listed as applied, the reply says it stays (got ${JSON.stringify(r)})`,
        stuck !== undefined && r.ok === false && applied.length === 1 && applied[0]?.id === stuck.id && r.error === want);
      ok(`[ANNOUNCE] …the designer is told it could not be put back, never "nothing changed" (got ${JSON.stringify(text)})`,
        w.notified.slice(t).length === 1 && text === "Design Twin applied 1 edit that could not be put back after one failed: " + want);
    }
  },
});

cases.push({
  name: "A copy that fails before it is in its tree and cannot be removed is said to stay, never \"nothing changed\" (#206)",
  async run() {
    // Figma refusing to put the copy in its frame, or to clear its plugin data (a child copy, and a copy as the root), and
    // then refusing its remove(): it is left on the page it was made on, outside the tree the cleanup removes.
    const runs: Array<{ what: string; refuse: "append" | "data"; asRoot: boolean; why: string }> = [
      { what: "a child copy its frame refused", refuse: "append", asRoot: false, why: "appendChild refused" },
      { what: "a child copy whose plugin data Figma refused", refuse: "data", asRoot: false, why: "in Figma: cannot set plugin data on Source" },
      { what: "a root copy whose plugin data Figma refused", refuse: "data", asRoot: true, why: "in Figma: cannot set plugin data on Source" },
    ];
    for (const c of runs) {
      const w = await treeWorld();
      const first = await w.api.applyWrites([{ op: "createTree", tree: { name: "Source", children: [{ name: "Title", text: "original" }] } }]);
      const src = w.scene.nodes[String(first.applied[0]?.id)];
      if (!src || typeof src.clone !== "function") throw new Error("no source to copy");
      const realClone = src.clone as () => FakeNode;
      let copy: FakeNode | undefined;
      src.clone = () => {
        const made = realClone();
        copy = made;
        made.remove = () => { throw new Error("remove refused"); };
        if (c.refuse === "append") {
          const at = made.parent;
          Object.defineProperty(made, "parent", { configurable: true, enumerable: true, get: () => at, set: () => { throw new Error("appendChild refused"); } });
        }
        return made;
      };
      if (c.refuse === "data") w.trap.add("setPluginData");
      const t = w.notified.length;
      const tree = c.asRoot ? { clone: String(src.id), name: "Copy" } : { name: "Holder", children: [{ clone: String(src.id), name: "Copy" }] };
      const r = replyOf(await bridgeWrite(w, "r8-stray-" + c.refuse + String(c.asRoot), [{ op: "createTree", tree }])) as { ok?: unknown; error?: unknown; applied?: unknown };
      w.trap.clear();
      const text = String(lastWrites(w)?.text);
      const want = c.why + "; could not undo the unfinished copy 'Source' (" + String(copy?.id) + ") (remove refused)";
      const applied = Array.isArray(r.applied) ? r.applied as Array<Record<string, unknown>> : [];
      ok(`[ANNOUNCE] ${c.what}, not removable: listed as applied, the reply says it stays (got ${JSON.stringify(r)})`,
        copy !== undefined && r.ok === false && applied.length === 1 && applied[0]?.id === copy.id && r.error === want && !w.alive().some((n) => n.name === "Holder"));
      ok(`[ANNOUNCE] …the designer is told it could not be put back (got ${JSON.stringify(text)})`,
        w.notified.slice(t).length === 1 && text === "Design Twin applied 1 edit that could not be put back after one failed: " + want);
    }
  },
});

cases.push({
  name: "A copy's text patched after a variable edit, gone while its fonts load, fails as missing: its text is never set (#206)",
  async run() {
    for (const [how, out] of OUT) {
      const w = await treeWorld();
      const first = await w.api.applyWrites([{ op: "createTree", tree: { name: "Source", children: [{ name: "Title", text: "original", handle: "title" }] } }]);
      const sourceTitle = String(first.applied[0]?.handles?.title);
      const realLoad = w.figma.loadFontAsync;
      if (!realLoad) throw new Error("the world loads no fonts");
      let gone: FakeNode | undefined;
      // A variable edit earlier in the batch: the copy's text fonts load as its patch applies (no style await after them).
      w.figma.loadFontAsync = async (f: { family: string; style: string }) => {
        await realLoad(f);
        if (gone) return;
        gone = w.made.find((n) => n.type === "TEXT" && peekRemoved(n, "name") === "Title" && n.id !== sourceTitle);
        if (gone) out(gone);
      };
      const r = await w.api.applyWrites([
        { op: "createVariables", collection: "Tokens", modes: ["Default"], variables: [["color/ink", "color", "#111111"]] },
        { op: "createTree", tree: { clone: String(first.applied[0]?.id), name: "Copy", edits: { Title: { text: "updated" } } } },
      ]);
      w.figma.loadFontAsync = realLoad;
      ok(`[ANNOUNCE] a copy's text ${how} while its fonts load (after a variable edit): fails as missing, put back, its text never set (got ${JSON.stringify(r)})`,
        gone !== undefined && r.ok === false && r.failedAt === 1 && r.applied.length === 0 && r.error === "no node with id '" + String(gone.id) + "' (invalid or removed)"
        && peekRemoved(gone, "characters") !== "updated" && !w.alive().some((n) => n.name === "Copy"));
    }
  },
}, {
  name: "A component set whose parts all refuse removal after it failed is said to stay once, as the set (#206)",
  async run() {
    const w = await treeWorld({ kit: true });
    const dest = w.pages.screens;
    let set: FakeNode | undefined;
    w.hooks.onStyle = async () => {
      if (set) return;
      set = w.made.find((n) => n.type === "COMPONENT_SET");
      for (const n of w.made) if (n.type === "COMPONENT" || n.type === "COMPONENT_SET") n.remove = () => { throw new Error("remove refused"); };
      const q = dest.parent as FakeNode | null;
      if (q && Array.isArray(q.children)) q.children = q.children.filter((c) => c !== dest);
      dest.parent = null;
    };
    const r = await w.api.applyWrites([{ op: "createTree", page: "Screens", tree: { type: "COMPONENT_SET", name: "Stuck set", children: [
      { type: "COMPONENT", name: "Size=S", children: [{ name: "Wait", text: "Wait", styles: { text: "Body" } }] }, { type: "COMPONENT", name: "Size=M" }] } }]);
    w.hooks.onStyle = undefined;
    const want = "no page with id '" + String(dest.id) + "' (invalid or removed); could not undo the unfinished component 'Stuck set' (" + String(set?.id) + ") (remove refused)";
    ok(`[ANNOUNCE] a set and its variants that cannot be removed: one row, the set, its variants not listed again (got ${JSON.stringify(r)})`,
      set !== undefined && r.ok === false && r.applied.length === 1 && r.applied[0]?.id === set.id && r.error === want);
  },
}, {
  name: "A keyed re-send's new group whose copy fails before it is in the group says the copy stays (#206)",
  async run() {
    const w = await treeWorld();
    const src = await w.api.applyWrites([{ op: "createTree", tree: { name: "Source", children: [{ name: "Title", text: "original" }] } }]);
    const srcNode = w.scene.nodes[String(src.applied[0]?.id)];
    if (!srcNode || typeof srcNode.clone !== "function") throw new Error("no source to copy");
    await w.api.applyWrites([{ op: "createTree", tree: { key: "grp", name: "Grp", children: [{ name: "Box" }] } }]);
    const realClone = srcNode.clone as () => FakeNode;
    let copy: FakeNode | undefined;
    srcNode.clone = () => {
      const made = realClone();
      copy = made;
      const at = made.parent;
      made.remove = () => { throw new Error("remove refused"); };
      Object.defineProperty(made, "parent", { configurable: true, enumerable: true, get: () => at, set: () => { throw new Error("appendChild refused"); } });
      return made;
    };
    const r = await w.api.applyWrites([{ op: "createTree", tree: { key: "grp", name: "Grp", children: [{ name: "Box" }, { name: "Group", children: [{ clone: String(srcNode.id), name: "Copy" }] }] } }]);
    const want = "appendChild refused; could not undo the unfinished copy 'Source' (" + String(copy?.id) + ") (remove refused)";
    ok(`[ANNOUNCE] a keyed re-send's new group, its copy refused and not removable: the copy is listed, the group is gone (got ${JSON.stringify(r)})`,
      copy !== undefined && r.ok === false && r.applied.length === 1 && r.applied[0]?.id === copy.id && r.error === want && !w.alive().some((n) => n.name === "Group"));
  },
});

cases.push({
  name: "A keyed variant removal re-checks the variant after the orphan count: a layer the designer put in it meanwhile refuses it (#206)",
  async run() {
    const w = await treeWorld();
    const spec = (names: string[]) => ({ type: "COMPONENT_SET", name: "Button", children: names.map((name) => ({ type: "COMPONENT", name: "Size=" + name })) });
    const first = await w.api.applyWrites([{ op: "createTree", tree: spec(["S", "M", "L"]) }]);
    const root = w.scene.nodes[String(first.applied[0]?.id)];
    const doomed = (root?.children ?? []).find((n) => n.name === "Size=L");
    if (!root || !doomed) throw new Error("no set to re-send");
    const makeFrame = w.figma.createFrame;
    if (!makeFrame) throw new Error("the world makes no frames");
    const foreign = makeFrame();
    foreign.name = "Designer's layer";
    const realInstances = doomed.getInstancesAsync as () => Promise<unknown[]>;
    let calls = 0;
    // The orphan count's await as the removals run (the review's own count reads it first): the designer drops a layer
    // of their own into the variant.
    doomed.getInstancesAsync = async () => { if (new Error().stack?.includes("orphanWarnings") && calls++ === 0) (doomed.appendChild as (n: unknown) => void)(foreign); return realInstances(); };
    const t = w.notified.length;
    const p = w.posted.length;
    const r = replyOf(await bridgeWrite(w, "r8-foreign", [{ op: "createTree", tree: spec(["S", "M"]) }])) as { ok?: unknown; error?: unknown; applied?: unknown };
    const text = String(lastWrites(w)?.text);
    const want = "'Size=L' (" + String(doomed.id) + ") is to be removed (the spec with key 'dtwin/component:Button' no longer has it), but it now holds 'Designer's layer' (" + String(foreign.id) + "), which that key did not build; nothing was removed";
    ok(`[ANNOUNCE] a variant that gained a designer's layer during the orphan count: refused, nothing removed (got ${JSON.stringify(r)})`,
      calls >= 1 && r.ok === false && Array.isArray(r.applied) && r.applied.length === 0 && r.error === want);
    ok(`[ANNOUNCE] …the variant and the designer's layer are both still in the file (alive ${JSON.stringify(w.alive().map((n) => n.name))})`,
      w.alive().includes(foreign) && w.alive().includes(doomed) && foreign.parent === doomed);
    // (The batch waited for review first, so the card's own toast came before this one.)
    ok(`[ANNOUNCE] …the designer is told nothing changed, and why (got ${JSON.stringify(text)})`, w.notified.slice(t).at(-1) === text && writesOf(w.posted.slice(p)).length === 1 && text === HEAD + want);
  },
}, {
  name: "A keyed re-send whose result goes during the orphan count removes nothing from it and fails as missing (#206)",
  async run() {
    for (const [how, out] of OUT) {
      const w = await treeWorld();
      const spec = (names: string[]) => ({ type: "COMPONENT_SET", name: "Button", props: names.length > 2 ? { Label: { type: "TEXT", default: "Go" } } : undefined, children: names.map((name) => ({ type: "COMPONENT", name: "Size=" + name })) });
      const first = await w.api.applyWrites([{ op: "createTree", tree: spec(["S", "M", "L"]) }]);
      const root = w.scene.nodes[String(first.applied[0]?.id)];
      const doomed = (root?.children ?? []).find((n) => n.name === "Size=L");
      if (!root || !doomed) throw new Error("no set to re-send");
      const realInstances = doomed.getInstancesAsync as () => Promise<unknown[]>;
      let calls = 0;
      // The designer deletes the whole set while the variant's instances are counted as the removals run.
      doomed.getInstancesAsync = async () => { if (new Error().stack?.includes("orphanWarnings") && calls++ === 0) out(root); return realInstances(); };
      const r = await w.api.applyWrites([{ op: "createTree", tree: spec(["S", "M"]) }]);
      ok(`[ANNOUNCE] a set ${how} during the orphan count: fails as missing, no variant removed from it, no property deleted (got ${JSON.stringify(r)})`,
        calls >= 1 && r.ok === false && r.applied.length === 0 && r.error === "no node with id '" + String(root.id) + "' (invalid or removed)"
        && doomed.removed !== true && Object.keys(peekRemoved(root, "componentPropertyDefinitions") ?? {}).some((k) => k.startsWith("Label#")));
    }
  },
}, {
  name: "A keyed order-only re-send whose kept child goes during an earlier op's await fails as missing: no reorder is reported (#206)",
  async run() {
    for (const [how, out] of OUT) {
      const w = await treeWorld({ kit: true });
      const tree = (names: string[]) => ({ key: "order", name: "Order", children: names.map((name) => ({ name, handle: name })) });
      const first = await w.api.applyWrites([{ op: "createTree", tree: tree(["A", "B", "C"]) }]);
      const root = w.scene.nodes[String(first.applied[0]?.id)];
      const missing = w.scene.nodes[String(first.applied[0]?.handles?.C)];
      if (!root || !missing) throw new Error("no keyed result");
      let hooks = 0;
      w.hooks.onStyle = async () => { if (!hooks++) out(missing); };
      const r = replyOf(await bridgeWrite(w, "r8-order-" + how, [
        { op: "createTree", tree: { name: "Earlier", children: [{ name: "Wait", text: "Wait", styles: { text: "Body" } }] } },
        { op: "createTree", tree: tree(["C", "B", "A"]) },
      ])) as { ok?: unknown; error?: unknown; applied?: unknown; failedAt?: unknown; restored?: unknown };
      w.hooks.onStyle = undefined;
      const text = String(lastWrites(w)?.text);
      const want = "no node with id '" + String(missing.id) + "' (invalid or removed)";
      ok(`[ANNOUNCE] an order-only re-send, a kept child ${how} during an earlier op: fails as missing, the earlier op put back (got ${JSON.stringify(r)})`,
        hooks === 1 && r.ok === false && r.failedAt === 1 && Array.isArray(r.applied) && r.applied.length === 0 && Array.isArray(r.restored) && r.restored.length === 1 && r.error === want);
      ok(`[ANNOUNCE] …${how}: the rest keep their order (got ${JSON.stringify(namesOf(kidsOf(root)))}), the earlier tree is gone, and the designer is told (got ${JSON.stringify(text)})`,
        JSON.stringify(namesOf(kidsOf(root))) === JSON.stringify(how === "detached" ? ["A", "B"] : ["A", "B"]) && !w.alive().some((n) => n.name === "Earlier")
        && text === "Design Twin undid 1 earlier change after an edit failed: " + want);
    }
  },
}, {
  name: "A keyed re-send whose patched node or new child goes during a later build's await fails as missing (#206)",
  async run() {
    for (const [how, out] of OUT) {
      for (const which of ["patched", "built"] as const) {
        const w = await treeWorld({ kit: true });
        const tree = (a: string, extra: Array<Record<string, unknown>>) => ({ key: "k", name: "K", children: [{ name: a, handle: "a" }, ...extra] });
        const first = await w.api.applyWrites([{ op: "createTree", tree: tree("A", []) }]);
        const aNode = w.scene.nodes[String(first.applied[0]?.handles?.a)];
        if (!aNode) throw new Error("no keyed result");
        let calls = 0;
        let gone: FakeNode | undefined;
        // The second new child's style await: the designer deletes the renamed child, or the first new child.
        w.hooks.onStyle = async () => {
          if (++calls !== 2) return;
          gone = which === "patched" ? aNode : madeNamed(w, "X");
          if (gone) out(gone);
        };
        const r = await w.api.applyWrites([{ op: "createTree", tree: tree("A2", [{ name: "X", text: "X", styles: { text: "Body" } }, { name: "Y", text: "Y", styles: { text: "Body" } }]) }]);
        w.hooks.onStyle = undefined;
        const missing = "no node with id '" + String(gone?.id) + "' (invalid or removed)";
        // A patched node removed takes its change with it: that cannot be put back, and the reply says so (a detached one
        // is put back).
        const kept = which === "patched" && how === "removed";
        ok(`[ANNOUNCE] a keyed re-send, its ${which} node ${how} during a later build: fails as missing, nothing else stays (got ${JSON.stringify(r)})`,
          gone !== undefined && r.ok === false && !w.alive().some((n) => n.name === "X" || n.name === "Y") && (kept
            ? r.applied.length === 1 && r.applied[0]?.id === gone.id && r.error === missing + "; could not undo the changes to 'A' (" + String(gone.id) + ") (it was deleted from the file after the patch changed it)"
            : r.applied.length === 0 && r.error === missing));
      }
    }
  },
}, {
  name: "A node the batch made and the designer deleted before a later op failed counts as put back, not \"could not undo\" (#206)",
  async run() {
    const w = await treeWorld({ kit: true });
    let made: FakeNode | undefined;
    w.hooks.onStyle = async () => { made = madeNamed(w, "Made first"); if (made) markRemoved(made); throw new Error("style refused"); };
    const r = await w.api.applyWrites([
      { op: "createFrame", name: "Made first", width: 10, height: 10 },
      { op: "createTree", tree: { name: "Later", children: [{ name: "Wait", text: "Wait", styles: { text: "Body" } }] } },
    ]);
    w.hooks.onStyle = undefined;
    ok(`[ANNOUNCE] a frame the batch made, deleted by the designer before a later op failed: put back, nothing left listed (got ${JSON.stringify(r)})`,
      made !== undefined && r.ok === false && r.failedAt === 1 && r.applied.length === 0 && (r.restored || []).length === 1 && r.error === "style refused");
  },
});

cases.push({
  name: "A variant to be removed that the designer deletes during its own orphan count is not read: the re-send lands (#206)",
  async run() {
    const w = await treeWorld();
    const spec = (names: string[]) => ({ type: "COMPONENT_SET", name: "Button", children: names.map((name) => ({ type: "COMPONENT", name: "Size=" + name })) });
    const first = await w.api.applyWrites([{ op: "createTree", tree: spec(["S", "M", "L"]) }]);
    const root = w.scene.nodes[String(first.applied[0]?.id)];
    const doomed = (root?.children ?? []).find((n) => n.name === "Size=L");
    if (!root || !doomed) throw new Error("no set to re-send");
    const placed = await w.api.applyWrites([{ op: "createTree", tree: { name: "Uses it", children: [{ component: "Button", props: { Size: "L" } }] } }]);
    const realInstances = doomed.getInstancesAsync as () => Promise<unknown[]>;
    let counted = -1;
    // The designer deletes the variant itself while its instances are counted (the count still comes back).
    doomed.getInstancesAsync = async () => {
      const asRemoved = new Error().stack?.includes("orphanWarnings") === true; // read before the await (it loses the caller)
      const found = await realInstances();
      if (asRemoved && counted < 0) { counted = found.length; markRemoved(doomed); }
      return found;
    };
    const r = await w.api.applyWrites([{ op: "createTree", tree: spec(["S", "M"]) }]);
    ok(`[ANNOUNCE] a variant deleted during its own orphan count: the re-send lands, no warning names it, no read error (got ${JSON.stringify(r)})`,
      placed.ok === true && counted === 1 && r.ok === true && !(r.warnings ?? []).some((m) => m.includes("Size=L")));
  },
});

// ---- #206 review 8, before the batch runs: a node a resolve holds across an await (a page load, a font load) is checked
// after it; gone, it is reported missing with the rest of the refusal, never read (a removed node's fields throw).

cases.push({
  name: "A copy whose source goes while its page loads (or while an edit resolves) is refused as missing, never read (#206)",
  async run() {
    for (const when of ["page load", "page load (no edits)", "edit's font load"] as const) {
      const w = await treeWorld();
      const first = await w.api.applyWrites([{ op: "createTree", tree: { name: "Source", children: [{ name: "Title", text: "original" }, { name: "Sub", text: "sub" }] } }]);
      const source = w.scene.nodes[String(first.applied[0]?.id)];
      if (!source) throw new Error("no source");
      let hits = 0;
      if (when !== "edit's font load") {
        const original = w.pages.current.loadAsync as () => Promise<void>;
        w.pages.current.loadAsync = async () => { await original(); if (!hits++) markRemoved(source); };
      } else {
        const realLoad = w.figma.loadFontAsync;
        if (!realLoad) throw new Error("the world loads no fonts");
        w.figma.loadFontAsync = async (f: { family: string; style: string }) => {
          const inPatch = new Error().stack?.includes("resolvePatchNode") === true;
          await realLoad(f);
          if (inPatch && !hits++) markRemoved(source);
        };
      }
      const t = w.notified.length;
      const p = w.posted.length;
      const edits = when === "page load (no edits)" ? {} : { edits: { Title: { text: "updated" }, Sub: { text: "new sub" } } };
      const r = replyOf(await bridgeWrite(w, "r8-preflight-" + when, [{ op: "createTree", tree: { clone: String(source.id), name: "Copy", ...edits } }])) as { ok?: unknown; error?: unknown; applied?: unknown };
      const text = String(lastWrites(w)?.text);
      const missing = "tree.clone: no node with id '" + String(source.id) + "' (invalid or removed)";
      ok(`[ANNOUNCE] a copy's source removed during its ${when}: refused, the source named missing, no read error (got ${JSON.stringify(r)})`,
        hits > 0 && r.ok === false && Array.isArray(r.applied) && r.applied.length === 0 && String(r.error).includes(missing) && !String(r.error).includes("in get_"));
      ok(`[ANNOUNCE] …${when}: the designer is told nothing changed (got ${JSON.stringify(text)})`, saidOnce(w, t, p, text) && text.startsWith(HEAD) && text.includes(missing) && !w.alive().some((n) => n.name === "Copy"));
    }
  },
}, {
  name: "A tree whose page goes while its fonts load is refused as missing, never loaded (#206)",
  async run() {
    const w = await treeWorld();
    const dest = w.pages.screens;
    const realLoad = w.figma.loadFontAsync;
    if (!realLoad) throw new Error("the world loads no fonts");
    let hits = 0;
    w.figma.loadFontAsync = async (f: { family: string; style: string }) => { await realLoad(f); if (!hits++) markRemoved(dest); };
    const r = await w.api.applyWrites([{ op: "createTree", page: "Screens", tree: { name: "New", children: [{ name: "T", text: "T", font: { family: "Inter", weight: "Bold" } }] } }]);
    w.figma.loadFontAsync = realLoad;
    ok(`[ANNOUNCE] a tree's page removed while its fonts load: refused, the page named missing (got ${JSON.stringify(r)})`,
      hits > 0 && r.ok === false && r.applied.length === 0 && r.error === "ops[0] (createTree): no page with id '" + String(dest.id) + "' (invalid or removed). Nothing was changed.");
  },
}, {
  name: "A keyed re-send whose result goes while its page loads builds afresh; one whose kept node goes while another resolves is refused (#206)",
  async run() {
    {
      const w = await treeWorld();
      const tree = (t: string) => ({ key: "fresh", name: "Fresh", children: [{ name: "Box", handle: "box", opacity: t === "a" ? 1 : 0.5 }] });
      const first = await w.api.applyWrites([{ op: "createTree", tree: tree("a") }]);
      const root = w.scene.nodes[String(first.applied[0]?.id)];
      if (!root) throw new Error("no keyed result");
      const original = w.pages.current.loadAsync as () => Promise<void>;
      let hits = 0;
      w.pages.current.loadAsync = async () => { const mine = new Error().stack?.includes("loadPageOf") === true; await original(); if (mine && !hits++) markRemoved(root); };
      const r = await w.api.applyWrites([{ op: "createTree", tree: tree("b") }]);
      ok(`[ANNOUNCE] a keyed result removed while its page loads: no result, so the re-send builds a new one, never reading the old (got ${JSON.stringify(r)})`,
        hits === 1 && r.ok === true && r.applied[0]?.id !== root.id && r.applied[0]?.created?.frames === 2);
    }
    for (const [how, out] of OUT) {
      const w = await treeWorld();
      const tree = (a: string, b: string) => ({ key: "two", name: "Two", children: [{ name: "T1", text: a, handle: "t1" }, { name: "T2", text: b, handle: "t2" }] });
      const first = await w.api.applyWrites([{ op: "createTree", tree: tree("a", "b") }]);
      const t2 = w.scene.nodes[String(first.applied[0]?.handles?.t2)];
      if (!t2) throw new Error("no keyed result");
      const realLoad = w.figma.loadFontAsync;
      if (!realLoad) throw new Error("the world loads no fonts");
      let hits = 0;
      // T1's patch resolves first (its fonts load): the designer deletes T2 then.
      w.figma.loadFontAsync = async (f: { family: string; style: string }) => {
        const inPatch = new Error().stack?.includes("resolvePatchNode") === true;
        await realLoad(f);
        if (inPatch && !hits++) out(t2);
      };
      const r = await w.api.applyWrites([{ op: "createTree", tree: tree("a2", "b2") }]);
      w.figma.loadFontAsync = realLoad;
      ok(`[ANNOUNCE] a keyed re-send, a kept node ${how} while another's patch resolves: refused, named missing, never read (got ${JSON.stringify(r)})`,
        hits === 1 && r.ok === false && r.applied.length === 0 && r.error === "ops[0] (createTree): tree.children[1]: no node with id '" + String(t2.id) + "' (invalid or removed). Nothing was changed.");
    }
  },
}, {
  name: "A move whose node or new parent goes while the parent's page loads is refused as missing, never read (#206)",
  async run() {
    for (const which of ["node", "parent"] as const) {
      const w = await treeWorld();
      const made = await w.api.applyWrites([{ op: "createFrame", name: "Mover", width: 10, height: 10 }]);
      const mover = w.scene.nodes[String(made.applied[0]?.id)];
      const dest = w.pages.screens;
      if (!mover) throw new Error("no frame to move");
      const original = dest.loadAsync as () => Promise<void>;
      let hits = 0;
      dest.loadAsync = async () => { await original(); if (!hits++) markRemoved(which === "node" ? mover : dest); };
      const r = await w.api.applyWrites([{ op: "move", nodeId: String(mover.id), parentId: String(dest.id) }]);
      const want = which === "node" ? "no node with id '" + String(mover.id) + "' (invalid or removed)" : "no parent with id '" + String(dest.id) + "' (invalid or removed)";
      ok(`[ANNOUNCE] a move, its ${which} removed while the parent page loads: refused as missing (got ${JSON.stringify(r)})`,
        hits > 0 && r.ok === false && r.applied.length === 0 && r.error === "ops[0] (move): " + want + ". Nothing was changed.");
    }
  },
});

// ---- #206 review 9: the loops inside one op (a rule's matches, a keyed re-send's subtrees), every cleanup path, and the
// rollback of a node the batch made: what an op holds across an await is checked after it (node-lookup.ts).

cases.push({
  name: "A createText whose own text goes while its font loads fails as missing: it is not written, put back or left anywhere (#206)",
  async run() {
    for (const [how, out] of OUT) {
      const w = await treeWorld();
      const realLoad = w.figma.loadFontAsync;
      if (!realLoad) throw new Error("the world loads no fonts");
      let gone: FakeNode | undefined;
      w.figma.loadFontAsync = async (f: { family: string; style: string }) => {
        await realLoad(f);
        if (gone) return;
        gone = w.made.find((n) => n.type === "TEXT");
        if (gone) out(gone);
      };
      const t = w.notified.length;
      const p = w.posted.length;
      const r = replyOf(await bridgeWrite(w, "r9-text-" + how, [{ op: "createText", text: "Written after" }])) as { ok?: unknown; error?: unknown; applied?: unknown };
      w.figma.loadFontAsync = realLoad;
      const text = String(lastWrites(w)?.text);
      const want = "no node with id '" + String(gone?.id) + "' (invalid or removed)";
      ok(`[ANNOUNCE] createText, its text ${how} during its font load: fails as missing, nothing applied (got ${JSON.stringify(r)})`,
        gone !== undefined && r.ok === false && Array.isArray(r.applied) && r.applied.length === 0 && r.error === want);
      ok(`[ANNOUNCE] …${how}: the text is never written nor put back on a page (alive ${JSON.stringify(w.alive().map((n) => n.id))}), and the designer is told nothing changed (got ${JSON.stringify(text)})`,
        gone !== undefined && peekRemoved(gone, "characters") !== "Written after" && !w.alive().some((n) => n.type === "TEXT") && saidOnce(w, t, p, text) && text === HEAD + want);
    }
  },
}, {
  name: "A keyed re-send's earlier new subtree whose layer goes during a later subtree's style await fails as missing (#206)",
  async run() {
    for (const [how, out] of OUT) {
      const w = await treeWorld({ kit: true });
      const base = { key: "multi", name: "Root" };
      const first = await w.api.applyWrites([{ op: "createTree", tree: base }]);
      let gone: FakeNode | undefined;
      w.hooks.onStyle = async () => { if (gone) return; gone = madeNamed(w, "Early text"); if (gone) out(gone); };
      const r = await w.api.applyWrites([{ op: "createTree", tree: { ...base, children: [
        { name: "Early group", handle: "early", children: [{ name: "Early text", handle: "earlyText", text: "Early" }] },
        { name: "Late group", handle: "late", children: [{ name: "Late text", text: "Late", styles: { text: "Body" } }] },
      ] } }]);
      w.hooks.onStyle = undefined;
      ok(`[ANNOUNCE] a keyed re-send, an earlier subtree's layer ${how} during a later one's style await: fails as missing, no handle for it (got ${JSON.stringify(r)})`,
        first.ok === true && gone !== undefined && r.ok === false && r.applied.length === 0 && r.error === "no node with id '" + String(gone.id) + "' (invalid or removed)");
      ok(`[ANNOUNCE] …${how}: neither new group stays, the result does (alive ${JSON.stringify(w.alive().map((n) => n.name))})`,
        !w.alive().some((n) => n.name === "Early group" || n.name === "Late group" || n.name === "Late text") && w.alive().some((n) => n.name === "Root"));
    }
  },
}, {
  name: "A rule whose page goes while it loads is refused as missing, never walked (#206)",
  async run() {
    for (const [how, out] of OUT) {
      const w = await treeWorld();
      const page = w.pages.screens;
      const original = page.loadAsync as () => Promise<void>;
      let hits = 0;
      page.loadAsync = async () => { await original(); if (!hits++) out(page); };
      const r = await w.api.applyWrites([{ op: "patchWhere", scope: [String(page.name)], where: { name: "*" }, set: { hidden: true } }]);
      ok(`[ANNOUNCE] patchWhere, its page ${how} while it loads: refused as missing (got ${JSON.stringify(r)})`,
        hits > 0 && r.ok === false && r.applied.length === 0 && r.error === "ops[0] (patchWhere): no page with id '" + String(page.id) + "' (invalid or removed). Nothing was changed.");
    }
  },
}, {
  name: "A rule whose layer on one page goes while a later page loads is refused as missing, never read (#206)",
  async run() {
    for (const [how, out] of OUT) {
      const w = await treeWorld();
      const made = await w.api.applyWrites([{ op: "createFrame", name: "On page one", width: 10, height: 10 }]);
      const layer = w.scene.nodes[String(made.applied[0]?.id)];
      if (!layer) throw new Error("no layer");
      const later = w.pages.screens;
      const original = later.loadAsync as () => Promise<void>;
      let hits = 0;
      later.loadAsync = async () => { await original(); if (!hits++) out(layer); };
      const r = await w.api.applyWrites([{ op: "patchWhere", scope: "file", where: { name: "On page one" }, set: { hidden: true } }]);
      ok(`[ANNOUNCE] patchWhere over the file, a layer ${how} while a later page loads: refused as missing (got ${JSON.stringify(r)})`,
        hits > 0 && r.ok === false && r.applied.length === 0 && r.error === "ops[0] (patchWhere): no layer with id '" + String(layer.id) + "' (invalid or removed). Nothing was changed.");
    }
  },
}, {
  name: "A rule's variable or component match whose layer goes while the names resolve is refused as missing, never read (#206)",
  async run() {
    for (const [how, out] of OUT) {
      for (const where of [{ variable: "color/brand" }, { variable: "color/brand", name: "Target" }] as const) {
        const w = await treeWorld({ kit: true });
        const made = await w.api.applyWrites([{ op: "createTree", tree: { name: "Target", tokens: { fills: "color/brand" } } }]);
        const target = w.scene.nodes[String(made.applied[0]?.id)];
        if (!target) throw new Error("no target");
        const original = w.figma.variables.getLocalVariablesAsync;
        let hit = false;
        w.figma.variables.getLocalVariablesAsync = async () => { if (!hit) { hit = true; out(target); } return original(); };
        const r = await w.api.applyWrites([{ op: "patchWhere", where, set: { hidden: true } }]);
        w.figma.variables.getLocalVariablesAsync = original;
        ok(`[ANNOUNCE] patchWhere by ${JSON.stringify(where)}, its match ${how} while the variable resolves: refused as missing (got ${JSON.stringify(r)})`,
          hit && r.ok === false && r.applied.length === 0 && r.error === "ops[0] (patchWhere): no layer with id '" + String(target.id) + "' (invalid or removed). Nothing was changed.");
      }
      const w = await treeWorld({ kit: true });
      const made = await w.api.applyWrites([{ op: "createTree", tree: { name: "Badges", children: [{ component: "Badge", handle: "a" }, { component: "Badge", name: "Second", handle: "b" }] } }]);
      const a = w.scene.nodes[String(made.applied[0]?.handles?.a)];
      const b = w.scene.nodes[String(made.applied[0]?.handles?.b)];
      if (!a || !b) throw new Error("no instances");
      const main = a.getMainComponentAsync as () => Promise<unknown>;
      a.getMainComponentAsync = async () => { out(b); return main(); };
      const r = await w.api.applyWrites([{ op: "patchWhere", where: { instanceOf: "Badge", name: "Second" }, set: { hidden: true } }]);
      ok(`[ANNOUNCE] patchWhere by instanceOf, an instance ${how} while another's component resolves: refused as missing (got ${JSON.stringify(r)})`,
        made.ok === true && r.ok === false && r.applied.length === 0 && r.error === "ops[0] (patchWhere): no layer with id '" + String(b.id) + "' (invalid or removed). Nothing was changed.");
    }
  },
}, {
  name: "A rule's match whose page goes while a match's font loads names it by id, never reading the page (#206)",
  async run() {
    const w = await treeWorld();
    const made = await w.api.applyWrites([{ op: "createText", text: "Match", parentId: String(w.pages.screens.id) }]);
    const match = w.scene.nodes[String(made.applied[0]?.id)];
    if (!match) throw new Error("no match");
    const page = w.pages.screens;
    const realLoad = w.figma.loadFontAsync;
    if (!realLoad) throw new Error("the world loads no fonts");
    let hit = false;
    w.figma.loadFontAsync = async (f: { family: string; style: string }) => { await realLoad(f); if (!hit) { hit = true; markRemoved(page); } };
    const r = await w.api.applyWrites([{ op: "patchWhere", scope: [String(page.name)], where: { text: "Match" }, set: { text: "Changed" } }]);
    w.figma.loadFontAsync = realLoad;
    ok(`[ANNOUNCE] patchWhere, its match's page removed while the match's font loads: refused, the match named by id (got ${JSON.stringify(r)})`,
      hit && r.ok === false && r.applied.length === 0 && r.error === "ops[0] (patchWhere): 1 of the 1 layers its rule matches cannot take this patch — narrow the rule (another kind, a name) or the scope: (" + String(match.id) + "): no node with id '" + String(match.id) + "' (invalid or removed). Nothing was changed.");
  },
}, {
  name: "A rule's earlier match that goes during a later match's style await fails as missing, never reported applied (#206)",
  async run() {
    for (const [how, out] of OUT) {
      const w = await treeWorld({ kit: true });
      const made = await w.api.applyWrites([{ op: "createTree", tree: { name: "Host", children: [{ name: "First", text: "Change", handle: "first" }, { name: "Second", text: "Change", handle: "second" }] } }]);
      const first = w.scene.nodes[String(made.applied[0]?.handles?.first)];
      const second = w.scene.nodes[String(made.applied[0]?.handles?.second)];
      if (!first || !second) throw new Error("no matches");
      let calls = 0;
      w.hooks.onStyle = async () => { if (++calls === 2) out(first); };
      const r = await w.api.applyWrites([{ op: "patchWhere", where: { text: "Change" }, set: { styles: { text: "Body" }, text: "Changed" } }]);
      w.hooks.onStyle = undefined;
      const want = "'First' (" + String(first.id) + "), one of the 2 layers its rule matches: no node with id '" + String(first.id) + "' (invalid or removed)";
      ok(`[ANNOUNCE] patchWhere, its first match ${how} during the second's style await: fails as missing (got ${JSON.stringify(r)})`,
        calls === 2 && r.ok === false && typeof r.error === "string" && r.error.startsWith(want) && !r.applied.some((a) => a.matched !== undefined));
      ok(`[ANNOUNCE] …${how}: the second match is put back (text ${JSON.stringify(second.characters)})`, second.characters === "Change");
    }
  },
}, {
  name: "A tree whose child cannot be put in its frame leaves no new node anywhere (#206)",
  async run() {
    const w = await treeWorld();
    const createFrame = w.figma.createFrame;
    if (!createFrame) throw new Error("no createFrame");
    w.figma.createFrame = () => {
      const n = createFrame();
      n.appendChild = () => { throw new Error("append refused"); };
      return n;
    };
    const t = w.notified.length;
    const p = w.posted.length;
    const r = replyOf(await bridgeWrite(w, "r9-append", [{ op: "createTree", tree: { name: "Tree", children: [{ name: "Child", text: "Child" }] } }])) as { ok?: unknown; error?: unknown; applied?: unknown };
    w.figma.createFrame = createFrame;
    const text = String(lastWrites(w)?.text);
    ok(`[ANNOUNCE] a tree whose first append throws: refused, no node left on the page (alive ${JSON.stringify(w.alive().map((n) => [n.id, n.type]))}, got ${JSON.stringify(r)})`,
      r.ok === false && Array.isArray(r.applied) && r.applied.length === 0 && r.error === "append refused" && w.alive().length === 0);
    ok(`[ANNOUNCE] …and the designer is told nothing changed (got ${JSON.stringify(text)})`, saidOnce(w, t, p, text) && text === HEAD + "append refused");
  },
}, {
  name: "A build that fails takes back a layer it made that the designer moved out meanwhile; so does a later op's failure (#206)",
  async run() {
    for (const kind of ["tree", "component", "subtree", "tree, then a later op", "component, then a later op", "subtree, then a later op"] as const) {
      const w = await treeWorld({ kit: true });
      const later = kind.endsWith("later op");
      let first: { ok: boolean; applied: Array<{ id?: string }> } | null = null;
      if (kind.startsWith("subtree")) first = await w.api.applyWrites([{ op: "createTree", tree: { key: "k", name: "Root" } }]);
      let moved: FakeNode | undefined;
      w.hooks.onStyle = async () => {
        moved = madeNamed(w, "Styled");
        if (moved) (w.figma.currentPage.appendChild as (n: FakeNode) => void)(moved);
        if (!later) throw new Error("style refused");
      };
      const child = { name: "Styled", text: "Hello", styles: { text: "Body" } };
      const op: WriteOp = kind.startsWith("tree") ? { op: "createTree", tree: { name: "Tree", children: [child] } }
        : kind.startsWith("component") ? { op: "createTree", tree: { type: "COMPONENT", name: "Comp", children: [child] } }
        : { op: "createTree", tree: { key: "k", name: "Root", children: [{ name: "Group", children: [child] }] } };
      const ops: WriteOp[] = later ? [op, { op: "setFill", nodeId: "gone:1", color: "#fff" }] : [op];
      const t = w.notified.length;
      const p = w.posted.length;
      const r = replyOf(await bridgeWrite(w, "r9-moved-" + kind, ops)) as { ok?: unknown; error?: unknown; applied?: unknown };
      w.hooks.onStyle = undefined;
      const text = String(lastWrites(w)?.text);
      ok(`[ANNOUNCE] a ${kind} failing after its styled text was moved out of it: nothing applied, the text is not left on the page (alive ${JSON.stringify(w.alive().map((n) => n.name))}, got ${JSON.stringify(r)})`,
        (!kind.startsWith("subtree") || first?.ok === true) && moved !== undefined && r.ok === false && Array.isArray(r.applied) && r.applied.length === 0 && !w.alive().some((n) => n.name === "Styled"));
      if (kind === "tree") ok(`[ANNOUNCE] …the designer is told nothing changed (got ${JSON.stringify(text)})`, saidOnce(w, t, p, text) && text === HEAD + "style refused");
    }
  },
}, {
  name: "A keyed tree the batch made and the designer deleted before a later op failed puts the key's earlier result back in the index (#206)",
  async run() {
    const w = await treeWorld({ kit: true });
    const indexKey = "dtwin.key:index";
    const root = w.figma.root as FakeNode & { setPluginData(k: string, v: string): void; getPluginData(k: string): string };
    root.setPluginData(indexKey, "prior-id");
    let deleted: FakeNode | undefined;
    w.hooks.onStyle = async () => { deleted = madeNamed(w, "Earlier"); if (deleted) markRemoved(deleted); throw new Error("style rejected"); };
    const r = await w.api.applyWrites([
      { op: "createTree", tree: { key: "index", name: "Earlier" } },
      { op: "createTree", tree: { name: "Later", children: [{ text: "Later", styles: { text: "Body" } }] } },
    ]);
    w.hooks.onStyle = undefined;
    ok(`[ANNOUNCE] a keyed tree deleted by the designer before a later op failed: put back, the index names the earlier result again (got ${JSON.stringify(r)}, index ${JSON.stringify(root.getPluginData(indexKey))})`,
      deleted !== undefined && r.ok === false && r.failedAt === 1 && r.applied.length === 0 && (r.restored || []).length === 1 && root.getPluginData(indexKey) === "prior-id");
  },
}, {
  name: "A keyed re-send whose named page goes while its result's page loads is refused as missing, never read (#206)",
  async run() {
    for (const [how, out] of OUT) {
      const w = await treeWorld();
      const tree = { key: "same", name: "Root" };
      const first = await w.api.applyWrites([{ op: "createTree", tree }]);
      const page = w.pages.screens;
      const current = w.pages.current;
      const original = current.loadAsync as () => Promise<void>;
      let hits = 0;
      current.loadAsync = async () => { await original(); if (!hits++) out(page); };
      const r = await w.api.applyWrites([{ op: "createTree", page: String(page.id), tree: { ...tree, name: "Changed" } }]);
      current.loadAsync = original;
      ok(`[ANNOUNCE] a keyed re-send, its named page ${how} while the result's page loads: refused as missing (got ${JSON.stringify(r)})`,
        first.ok === true && hits > 0 && r.ok === false && r.applied.length === 0 && r.error === "ops[0] (createTree): no page with id '" + String(page.id) + "' (invalid or removed). Nothing was changed.");
    }
  },
}, {
  name: "A component found on one page and gone while a later page loads is no component: never read (#206)",
  async run() {
    for (const [how, out] of OUT) {
      // Placed by name: the name then matches nothing.
      const w = await treeWorld();
      const first = await w.api.applyWrites([{ op: "createTree", tree: { type: "COMPONENT", name: "Local source" } }]);
      const source = w.scene.nodes[String(first.applied[0]?.id)];
      if (!source) throw new Error("no component");
      const later = w.pages.screens;
      const original = later.loadAsync as () => Promise<void>;
      let hits = 0;
      later.loadAsync = async () => { await original(); if (!hits++) out(source); };
      const r = await w.api.applyWrites([{ op: "createTree", tree: { name: "Use source", children: [{ component: "Local source" }] } }]);
      later.loadAsync = original;
      ok(`[ANNOUNCE] an instance of a component ${how} while a later page loads: refused, the name matches nothing (got ${JSON.stringify(r)})`,
        hits > 0 && r.ok === false && r.applied.length === 0 && typeof r.error === "string" && r.error.startsWith("ops[0] (createTree): tree.children[0].component: component 'Local source' matches no component in this file"));
      // Re-sent by its name: there is no earlier result, so it builds afresh.
      const w2 = await treeWorld();
      const made = await w2.api.applyWrites([{ op: "createTree", tree: { type: "COMPONENT", name: "Card" } }]);
      const card = w2.scene.nodes[String(made.applied[0]?.id)];
      if (!card) throw new Error("no component");
      const later2 = w2.pages.screens;
      const original2 = later2.loadAsync as () => Promise<void>;
      let hits2 = 0;
      later2.loadAsync = async () => { await original2(); if (!hits2++) out(card); };
      const r2 = await w2.api.applyWrites([{ op: "createTree", tree: { type: "COMPONENT", name: "Card", children: [{ name: "Inside" }] } }]);
      later2.loadAsync = original2;
      ok(`[ANNOUNCE] a component re-sent by name, the earlier one ${how} while a later page loads: built afresh, never read (got ${JSON.stringify(r2)})`,
        hits2 > 0 && r2.ok === true && r2.applied[0]?.id !== card.id && r2.applied[0]?.created !== undefined);
    }
  },
}, {
  name: "A keyed variant removal whose variant is detached during the orphan count is not removed by the re-send, nor counted (#206)",
  async run() {
    for (const [how, out] of OUT) {
      const w = await treeWorld();
      const spec = (names: string[]) => ({ type: "COMPONENT_SET", name: "Button", children: names.map((name) => ({ type: "COMPONENT", name: "Size=" + name })) });
      const first = await w.api.applyWrites([{ op: "createTree", tree: spec(["S", "M", "L"]) }]);
      const root = w.scene.nodes[String(first.applied[0]?.id)];
      const doomed = (root?.children ?? []).find((n) => n.name === "Size=L");
      if (!root || !doomed) throw new Error("no set to re-send");
      let removedByPlugin = false;
      const remove = doomed.remove as () => void;
      doomed.remove = () => { removedByPlugin = true; remove(); };
      // A layer of the designer's own, dropped into the variant as it goes: it goes with it, and refuses nothing.
      const own = await w.api.applyWrites([{ op: "createFrame", name: "Own", width: 10, height: 10 }]);
      const foreign = w.scene.nodes[String(own.applied[0]?.id)];
      if (!foreign) throw new Error("no layer of the designer's");
      const realInstances = doomed.getInstancesAsync as () => Promise<unknown[]>;
      let hits = 0;
      doomed.getInstancesAsync = async () => {
        const counting = new Error().stack?.includes("orphanWarnings") === true;
        const found = await realInstances();
        if (counting && !hits++) { if (how === "detached") (doomed.appendChild as (n: FakeNode) => void)(foreign); out(doomed); }
        return found;
      };
      const r = await w.api.applyWrites([{ op: "createTree", tree: spec(["S", "M"]) }]);
      ok(`[ANNOUNCE] a keyed variant removal, the variant ${how} during its orphan count: the re-send lands, removes and counts nothing (got ${JSON.stringify(r)})`,
        hits === 1 && r.ok === true && !removedByPlugin && r.applied[0]?.removed === undefined && !r.applied.some((a) => a.deleted === true));
    }
  },
});

cases.push({
  name: "A copy whose earlier patched layer goes during a later layer's patch fails as missing, never landed without it (#206)",
  async run() {
    for (const [how, out] of OUT) {
      const w = await treeWorld({ kit: true });
      const first = await w.api.applyWrites([{ op: "createTree", tree: { name: "Source", children: [{ name: "Title", text: "a", handle: "title" }, { name: "Sub", text: "b", handle: "sub" }] } }]);
      const sourceTitle = String(first.applied[0]?.handles?.title);
      let calls = 0;
      let gone: FakeNode | undefined;
      // The second layer's style await: the designer deletes the copy's first patched layer.
      w.hooks.onStyle = async () => {
        if (++calls !== 2) return;
        gone = w.made.find((n) => n.type === "TEXT" && peekRemoved(n, "name") === "Title" && n.id !== sourceTitle);
        if (gone) out(gone);
      };
      const r = await w.api.applyWrites([{ op: "createTree", tree: { clone: String(first.applied[0]?.id), name: "Copy", edits: { Title: { text: "A", styles: { text: "Body" } }, Sub: { text: "B", styles: { text: "Body" } } } } }]);
      w.hooks.onStyle = undefined;
      ok(`[ANNOUNCE] a copy, its first patched layer ${how} during the second's style await: fails as missing, no copy stays (got ${JSON.stringify(r)})`,
        gone !== undefined && r.ok === false && r.applied.length === 0 && r.error === "no node with id '" + String(gone.id) + "' (invalid or removed)" && !w.alive().some((n) => n.name === "Copy"));
    }
  },
}, {
  name: "A component re-send whose text following a property goes while another's font loads is refused as missing, never read (#206)",
  async run() {
    for (const [how, out] of OUT) {
      const w = await treeWorld();
      const spec = (label: string) => ({ type: "COMPONENT", name: "Wrap", props: { Label: { type: "TEXT", default: label } }, children: [
        { name: "A", text: label, handle: "a", propRefs: { characters: "Label" } },
        { name: "B", text: label, handle: "b", propRefs: { characters: "Label" } },
      ] });
      const first = await w.api.applyWrites([{ op: "createTree", tree: spec("L") }]);
      const b = w.scene.nodes[String(first.applied[0]?.handles?.b)];
      if (!b) throw new Error("no component built: " + JSON.stringify(first));
      const realLoad = w.figma.loadFontAsync;
      if (!realLoad) throw new Error("the world loads no fonts");
      let hit = false;
      // The re-send's own font load for the texts that follow the edited property (read before the await loses the caller).
      w.figma.loadFontAsync = async (f: { family: string; style: string }) => {
        const keyed = new Error().stack?.includes("resolveKeyed") === true;
        await realLoad(f);
        if (keyed && !hit) { hit = true; out(b); }
      };
      const r = await w.api.applyWrites([{ op: "createTree", tree: spec("M") }]);
      w.figma.loadFontAsync = realLoad;
      ok(`[ANNOUNCE] a component re-send, a text following its edited property ${how} while another's font loads: refused as missing (got ${JSON.stringify(r)})`,
        hit && r.ok === false && r.applied.length === 0 && r.error === "ops[0] (createTree): component 'Wrap': no node with id '" + String(b.id) + "' (invalid or removed). Nothing was changed.");
      // Its own font, one the file no longer has, failing to load as the designer deletes it: missing, its name never read.
      const w2 = await treeWorld({ fonts: [["Ghost", "Regular"]] });
      const first2 = await w2.api.applyWrites([{ op: "createTree", tree: spec("L") }]);
      const b2 = w2.scene.nodes[String(first2.applied[0]?.handles?.b)];
      const load2 = w2.figma.loadFontAsync;
      if (!b2 || !load2) throw new Error("no component built: " + JSON.stringify(first2));
      await load2({ family: "Ghost", style: "Regular" });
      b2.fontName = { family: "Ghost", style: "Regular" }; // the designer's own font on it
      w2.figma.loadFontAsync = async (f: { family: string; style: string }) => {
        if (f.family !== "Ghost") return load2(f);
        out(b2);
        throw new Error("font not found");
      };
      const r2 = await w2.api.applyWrites([{ op: "createTree", tree: spec("M") }]);
      w2.figma.loadFontAsync = load2;
      ok(`[ANNOUNCE] a component re-send, a text following its edited property ${how} while its own font fails to load: refused as missing (got ${JSON.stringify(r2)})`,
        r2.ok === false && r2.applied.length === 0 && r2.error === "ops[0] (createTree): component 'Wrap': no node with id '" + String(b2.id) + "' (invalid or removed). Nothing was changed.");
    }
  },
});

cases.push({
  name: "A component two instances name, deleted while a text style between them loads its font, is refused as missing, never read (#206)",
  async run() {
    for (const [how, out] of OUT) {
      const w = await treeWorld({ kit: true });
      const badge = w.scene.nodes["5:3"];
      const realLoad = w.figma.loadFontAsync;
      if (!badge || !realLoad) throw new Error("no kit");
      let hit = false;
      // The heading's style font (only the style names it): the designer deletes the component the instances use.
      w.figma.loadFontAsync = async (f: { family: string; style: string }) => {
        await realLoad(f);
        if (f.style === "Bold" && !hit) { hit = true; out(badge); }
      };
      const r = await w.api.applyWrites([{ op: "createTree", tree: { name: "Badges", children: [
        { component: "Badge" }, { text: "Title", styles: { text: "Heading/H1" } }, { component: "Badge" },
      ] } }]);
      w.figma.loadFontAsync = realLoad;
      ok(`[ANNOUNCE] two instances of a component ${how} while a style's font loads between them: refused as missing (got ${JSON.stringify(r)})`,
        hit && r.ok === false && r.applied.length === 0 && r.error === "ops[0] (createTree): tree.children[2].component: no component with id '5:3' (invalid or removed). Nothing was changed.");
    }
  },
});

cases.push({
  name: "An instance whose component, or its swap value, goes while a swap value resolves is refused as missing, never read (#206)",
  async run() {
    for (const [how, out] of OUT) {
      // The swap value named twice, gone between: the second use is refused as missing.
      const w = await treeWorld({ kit: true });
      const badge = w.scene.nodes["5:3"];
      const realLoad = w.figma.loadFontAsync;
      if (!badge || !realLoad) throw new Error("no kit");
      let hit = false;
      w.figma.loadFontAsync = async (f: { family: string; style: string }) => {
        await realLoad(f);
        if (f.style === "Bold" && !hit) { hit = true; out(badge); }
      };
      const r = await w.api.applyWrites([{ op: "createTree", tree: { name: "Buttons", children: [
        { component: "Button", props: { Glyph: "Badge" } }, { text: "Title", styles: { text: "Heading/H1" } }, { component: "Button", props: { Glyph: "Badge" } },
      ] } }]);
      w.figma.loadFontAsync = realLoad;
      ok(`[ANNOUNCE] a swap value ${how} between two instances that name it: refused as missing (got ${JSON.stringify(r)})`,
        hit && r.ok === false && r.applied.length === 0 && typeof r.error === "string" && r.error.startsWith("ops[0] (createTree): tree.children[2].component: ") && r.error.includes("no component with id '5:3' (invalid or removed)"));
      // The instance's own component set, gone while its swap value (by id) is looked up.
      const w2 = await treeWorld({ kit: true });
      const button = w2.scene.nodes["5:1"];
      const lookup = w2.figma.getNodeByIdAsync;
      if (!button) throw new Error("no kit");
      w2.figma.getNodeByIdAsync = async (id: string) => { if (id === "5:3") out(button); return lookup(id); };
      const r2 = await w2.api.applyWrites([{ op: "createTree", tree: { name: "Buttons", children: [{ component: "Button", props: { Glyph: "5:3" } }] } }]);
      w2.figma.getNodeByIdAsync = lookup;
      ok(`[ANNOUNCE] an instance's component set ${how} while its swap value is looked up: refused as missing (got ${JSON.stringify(r2)})`,
        r2.ok === false && r2.applied.length === 0 && r2.error === "ops[0] (createTree): tree.children[0].component: no component with id '5:1' (invalid or removed). Nothing was changed.");
    }
  },
});
