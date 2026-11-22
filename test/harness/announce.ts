// What a write says when it changed nothing (writes.ts announce, #206): a batch refused before any op ran — an unknown
// image hash, a name that resolves to nothing, a bad op, a bad image table, Dev Mode, an op that failed and put itself
// back, a batch whose file changed while it waited for review, a write that threw — says so in Figma's toast AND
// replaces the plugin window's "Applying edits…" line (a `writes` message inside the write's run). An empty batch says
// nothing; a batch refused because another waits for review says so on the status line only (the card's toast is up).
import type { WriteOp } from "../../bridge/src/commands.ts";
import { ok } from "../assert.ts";
import type { PostedMessage } from "../fake-figma.ts";
import type { Case } from "./helpers.ts";
import { treeWorld } from "./writes.ts";

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
async function bridgeWrite(w: World, id: string, ops: WriteOp[]): Promise<PostedMessage[]> {
  return w.send({ type: "bridge", id, cmd: "write", args: { ops } });
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
    // and it keeps the card's "review it below" line. No second toast either: the card's is up.
    ok(`[ANNOUNCE] refused as waiting, with no run, no panel line and no toast (got ${JSON.stringify(after.map((m) => m.type))}, ${JSON.stringify(w.notified.slice(t))})`,
      card !== undefined && r.refused === "waiting" && !after.some((m) => m.type === "run-begin" || m.type === "writes") && w.notified.length === t);
    await w.send({ type: "review-answer", id: String(card?.id), action: "reject" });
    await first;
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
      && text.startsWith("Design Twin refused an edit request — no layer changed, but it had already added 1 image to the file: ops[0] (createTree): tree.fills[1]: 'notes.gif' is not an image Figma can open"));
    w.figma.createImage = realCreate;
  },
}];
