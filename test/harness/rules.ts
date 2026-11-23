// A bulk patch by rule (writes: patchWhere, figma-plugin/src/rules.ts; docs/write-plane-spec.md decision 8): every rule
// kind and every scope, the dry run's counts per page and samples, the token a run over the threshold must carry and
// the refusal when the matches changed, the whole run as one undo step put back whole on a failure, and the review it
// always waits for — recounted on approval, refused on drift.
import type { RuleMatch } from "../../bridge/src/rule-spec.ts";
import type { WriteImpactReply, WriteOp, WriteReply, WriteResult } from "../../bridge/src/commands.ts";
import { lineText } from "../../bridge/src/review-card.ts";
import { ok } from "../assert.ts";
import { markRemoved, type FakeNode, type PostedMessage } from "../fake-figma.ts";
import type { Case } from "./helpers.ts";
import { treeWorld } from "./writes.ts";

type World = Awaited<ReturnType<typeof treeWorld>>;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isImpact = (v: unknown): v is WriteImpactReply => isObj(v) && Array.isArray(v.steps);

/** A screen: a title, a red card, a footer reading `footer`, a chip bound to the brand colour, a Badge instance. */
const screen = (name: string, footer = "Terms v1"): Record<string, unknown> => ({
  name, children: [
    { name: "Title", text: name },
    { name: "Card", radius: 4, fills: [{ type: "solid", color: "#ff0000" }] },
    { name: "Card faint", radius: 4, fills: [{ type: "solid", color: "#ff0000", opacity: 0.5 }] },
    { name: "Footer", text: footer },
    { name: "Chip", fills: [{ type: "solid", tokens: { color: "color/brand" } }] },
    { component: "Badge" },
  ],
});

/** A file with the kit: two screens on "Page 1" (current), two on "Screens", and a main component whose layer reads
 *  "Terms v1" (never matched: it is a source). */
async function ruleWorld(extra: Parameters<typeof treeWorld>[0] = {}) {
  const w = await treeWorld({ kit: true, ...extra });
  const made = await w.api.applyWrites([
    { op: "createTree", tree: screen("Home") }, { op: "createTree", tree: screen("Profile") },
    { op: "createTree", tree: screen("Orders"), page: "Screens" }, { op: "createTree", tree: screen("Help"), page: "Screens" },
    { op: "createTree", tree: { type: "COMPONENT", name: "Legal", children: [{ name: "Footer", text: "Terms v1" }] } },
  ]);
  if (!made.ok) throw new Error("ruleWorld: the screens did not build: " + String(made.error));
  const texts = (): FakeNode[] => w.alive().filter((n) => n.type === "TEXT");
  const footers = (): FakeNode[] => texts().filter((n) => n.name === "Footer" && !inComponent(n));
  return { ...w, texts, footers };
}
const inComponent = (n: FakeNode): boolean => { for (let p: unknown = n.parent; isObj(p); p = p.parent) if (p.type === "COMPONENT") return true; return false; };

const write = (w: World, ops: WriteOp[]): Promise<WriteResult> => w.api.applyWrites(ops.map((o) => ({ ...o })));
async function impact(w: World, ops: WriteOp[]): Promise<WriteImpactReply | null> {
  const posted = await w.send({ type: "bridge", id: "imp" + w.posted.length, cmd: "writeImpact", args: { ops } });
  const r = [...posted].reverse().find((m) => m.type === "bridge-result");
  const result: unknown = r && r.ok ? r.result : null;
  return isImpact(result) ? result : null;
}
const matchOf = async (w: World, op: WriteOp): Promise<{ match?: RuleMatch; problem?: string }> => {
  const step = (await impact(w, [op]))?.steps[0];
  return { ...(step?.match ? { match: step.match } : {}), ...(step?.problem !== undefined ? { problem: step.problem } : {}) };
};
const TEXT_RULE: WriteOp = { op: "patchWhere", where: { text: "Terms v1" }, scope: "file", set: { text: "Terms v2" } };
const lastCard = (w: World): PostedMessage | undefined => [...w.posted].reverse().find((m) => m.type === "review");

export const cases: Case[] = [{
  name: "patchWhere, text rule over the file: the dry run counts per page with samples, the run changes exactly those, waits on the card",
  async run() {
    const w = await ruleWorld();
    const others = w.texts().filter((n) => n.name !== "Footer" || inComponent(n)).map((n) => [n, n.characters] as const);
    const { match, problem } = await matchOf(w, TEXT_RULE);
    ok(`[RULE] the dry run counts 4 matches on 2 pages, never a source's layer (got ${JSON.stringify(match)}${problem ?? ""})`,
      problem === undefined && match?.total === 4 && JSON.stringify(match.pages) === JSON.stringify([{ page: "Page 1", count: 2 }, { page: "Screens", count: 2 }]));
    ok("[RULE] …with 3 samples (id, name, page) and a token for exactly these, not needed at 4", match?.samples.length === 3 && match.samples[0]?.name === "Footer" && match.samples[0]?.page === "Page 1" && /^4\.[0-9a-f]{16}$/.test(match.token) && match.needsToken === false);
    ok("[RULE] the dry run changed nothing", w.footers().every((n) => n.characters === "Terms v1"));
    const snaps: string[] = [];
    const commit = w.figma.commitUndo;
    w.figma.commitUndo = () => { snaps.push(w.footers().map((n) => String(n.characters)).join("|")); commit(); };
    const r = await write(w, [TEXT_RULE]);
    ok(`[RULE] applied: one row with the count and the pages, no id list (got ${JSON.stringify(r)})`, r.ok && r.applied.length === 1 && r.applied[0]?.matched === 4 && r.applied[0]?.pages === 2 && r.applied[0]?.id === undefined);
    ok("[RULE] every footer reads the new text; the component's layer and every other text are untouched",
      w.footers().every((n) => n.characters === "Terms v2") && others.every(([n, t]) => n.characters === t));
    ok(`[RULE] one undo step: no commit ever saw part of the change (got ${JSON.stringify(snaps)})`, snaps.every((s) => s === "Terms v1|Terms v1|Terms v1|Terms v1" || s === "Terms v2|Terms v2|Terms v2|Terms v2") && snaps.at(-1)?.startsWith("Terms v2") === true);
    const card = lastCard(w);
    const line = card?.lines?.[0];
    ok(`[RULE] it waited on a card even with review off: a bulk change by rule (why: ${String(card?.why)})`, /picks by a rule/.test(String(card?.why)) && card?.previewable === true);
    ok(`[RULE] the card's line: count, rule, old → new, pages; Show me holds the 4 (got ${line ? JSON.stringify(lineText({ ...line, ops: [] })) : "none"})`,
      !!line && lineText({ ...line, ops: [] }) === "4 layers matching text “Terms v1”: text “Terms v1” → “Terms v2” — on 'Page 1' (2), 'Screens' (2)" && line.show?.n === 4);
  },
}, {
  name: "patchWhere scopes: the current page by default, listed pages, the selection; a page name never guessed",
  async run() {
    const w = await ruleWorld();
    const count = async (scope: WriteOp["scope"]): Promise<string> => { const m = await matchOf(w, { ...TEXT_RULE, ...(scope === undefined ? { scope: undefined } : { scope }) }); return m.match ? String(m.match.total) : String(m.problem); };
    ok("[RULE] no scope: the current page", (await count(undefined)) === "2" && (await count("page")) === "2");
    ok("[RULE] listed pages, by name or id", (await count(["Screens"])) === "2" && (await count(["0:2", "Page 1"])) === "4");
    ok(`[RULE] a page name that matches two pages is refused, naming them by id (got ${await count(["Archive"])})`, /page 'Archive' matches 2 pages — name one by id: 'Archive' \(0:3\), 'Archive' \(0:4\)/.test(await count(["Archive"])));
    ok(`[RULE] one that matches none is refused with the closest (got ${await count(["Screen"])})`, /no page is named 'Screen'; closest: 'Screens'/.test(await count(["Screen"])));
    const home = w.alive().find((n) => n.name === "Home");
    w.figma.currentPage.selection = home ? [home] : [];
    ok("[RULE] the selection: the selected layers and everything inside them", (await count("selection")) === "1");
    w.figma.currentPage.selection = [];
    ok("[RULE] an empty selection is refused, saying so", /nothing is selected/.test(await count("selection")));
    const r = await write(w, [{ ...TEXT_RULE, scope: ["Screens"] }]);
    ok("[RULE] a run on one page changes that page only", r.ok && r.applied[0]?.matched === 2 && w.footers().filter((n) => n.characters === "Terms v2").length === 2);
  },
}, {
  name: "patchWhere rule kinds: fill, name pattern, variable, instance of a component, several at once",
  async run() {
    const w = await ruleWorld();
    const total = async (where: Record<string, string>): Promise<string> => { const m = await matchOf(w, { op: "patchWhere", where, scope: "file", set: { opacity: 0.5 } }); return m.match ? String(m.match.total) : String(m.problem); };
    ok("[RULE] fill: a visible solid of that colour, opacity included", (await total({ fill: "#ff0000" })) === "4" && (await total({ fill: "#ff000080" })) === "4" && (await total({ fill: "#00ff00" })) === "0");
    ok("[RULE] name: * is any run", (await total({ name: "Card*" })) === "8" && (await total({ name: "Card" })) === "4" && (await total({ name: "*faint" })) === "4");
    ok("[RULE] variable: the layers bound to it, by name or id", (await total({ variable: "color/brand" })) === "4" && (await total({ variable: "VariableID:30:1" })) === "4");
    ok(`[RULE] a variable name never guessed: none (closest) or several (got ${await total({ variable: "color/brnd" })} / ${await total({ variable: "color/text" })})`,
      /no variable .* is named 'color\/brnd'; closest: 'color\/brand'/.test(await total({ variable: "color/brnd" })) && /'color\/text' matches 2 variables/.test(await total({ variable: "color/text" })));
    ok("[RULE] instanceOf: the instances of the component", (await total({ instanceOf: "Badge" })) === "4");
    ok(`[RULE] a component name never guessed (got ${await total({ instanceOf: "Bdge" })})`, /no instance .* is of a component named 'Bdge'; closest: 'Badge'/.test(await total({ instanceOf: "Bdge" })));
    ok("[RULE] every kind given must hold", (await total({ name: "Footer", text: "Terms v1" })) === "4" && (await total({ name: "Title", text: "Terms v1" })) === "0" && (await total({ name: "Card*", fill: "#ff000080" })) === "4");
    const r = await write(w, [{ op: "patchWhere", where: { fill: "#ff0000", name: "Card" }, scope: "file", set: { radius: 12 } }]);
    const cards = w.alive().filter((n) => n.name === "Card");
    ok(`[RULE] a run by fill and name sets the field on each (got ${JSON.stringify(r)})`, r.ok && r.applied[0]?.matched === 4 && cards.every((n) => n.cornerRadius === 12) && w.alive().filter((n) => n.name === "Card faint").every((n) => n.cornerRadius === 4));
  },
}, {
  name: "patchWhere tokens: over 25 matches a run needs the dry run's token, and one whose matches changed is refused",
  async run() {
    const w = await ruleWorld();
    const many = await write(w, [{ op: "createTree", tree: { name: "List", children: Array.from({ length: 26 }, (_, i) => ({ name: "Row " + i, text: "Legacy" })) } }]);
    const op: WriteOp = { op: "patchWhere", where: { text: "Legacy" }, set: { text: "Current" } };
    const rows = (): FakeNode[] => w.texts().filter((n) => /^Row /.test(String(n.name)));
    const bare = await write(w, [op]);
    ok(`[RULE] 26 matches without a token: refused, nothing changed (got ${String(bare.error)})`, many.ok && !bare.ok && /matches 26 layers \(over 25\): dry-run the batch first/.test(String(bare.error)) && rows().every((n) => n.characters === "Legacy"));
    const { match } = await matchOf(w, op);
    ok("[RULE] the dry run says the token is needed", match?.needsToken === true && match.total === 26);
    // One more layer matches before the run: the token no longer stands for these matches.
    const last = w.texts().find((n) => n.name === "Title" && n.characters === "Home");
    const lastWas = last?.characters;
    if (last) last.characters = "Legacy";
    const drift = await write(w, [{ ...op, token: match?.token }]);
    ok(`[RULE] a token whose matches changed is refused, saying then and now (got ${String(drift.error)})`, !drift.ok && /changed since the dry run that gave its token \(26 then, 27 now\)/.test(String(drift.error)) && rows().every((n) => n.characters === "Legacy"));
    if (last) last.characters = lastWas;
    const r = await write(w, [{ ...op, token: match?.token }]);
    ok(`[RULE] with the token of these matches it runs (got ${JSON.stringify(r).slice(0, 200)})`, r.ok && r.applied[0]?.matched === 26 && rows().every((n) => n.characters === "Current"));
    const none = await write(w, [{ op: "patchWhere", where: { text: "Nothing reads this" }, set: { text: "x" } }]);
    ok(`[RULE] a run that matches nothing is refused (got ${String(none.error)})`, !none.ok && /matches no layer on the current page/.test(String(none.error)));
  },
}, {
  name: "patchWhere all or nothing: a layer the patch does not fit refuses the batch up front; a failure later puts every match back",
  async run() {
    const w = await ruleWorld();
    const misfit = await write(w, [{ op: "patchWhere", where: { name: "Footer" }, scope: "file", set: { props: { Size: "Large" } } }]);
    ok(`[RULE] layers it cannot patch: one problem, counted, a few named (got ${String(misfit.error)})`, !misfit.ok && /4 of the 4 layers its rule matches cannot take this patch/.test(String(misfit.error)) && /set\.props: only on an INSTANCE node/.test(String(misfit.error)) && /\| …/.test(String(misfit.error)));
    const card = w.alive().find((n) => n.name === "Card");
    w.trap.add("opacity");
    const r = await write(w, [TEXT_RULE, { op: "patch", nodeId: String(card?.id), set: { opacity: 0.5 } }]);
    w.trap.delete("opacity");
    ok(`[RULE] the op after it fails: all 4 matches are put back and listed as restored (one row however many matched; got ${JSON.stringify(r).slice(0, 300)})`,
      !r.ok && r.failedAt === 1 && r.restored?.length === 1 && r.restored[0]?.matched === 4 && r.applied.length === 0 && w.footers().every((n) => n.characters === "Terms v1"));
    // A delete of the same batch that takes a matched layer: refused up front.
    const made = await write(w, [{ op: "createTree", tree: { name: "Temp", handle: "t", children: [{ name: "Footer", text: "Terms v1" }] } }]);
    const temp = made.applied[0]?.handles?.t;
    const both = await write(w, [{ ...TEXT_RULE, scope: "page" }, { op: "delete", nodeId: String(temp) }]);
    ok(`[RULE] a match the batch deletes is refused up front (got ${String(both.error)})`, !both.ok && /its rule matches '.*', which ops\[1\] of this batch removes/.test(String(both.error)));
  },
}, {
  name: "patchWhere review: always waits, counted again on approval — the batch is refused when the matches drifted from the card's",
  async run() {
    const w = await ruleWorld({ extra: { reviewer: "real", clientStorage: { reviewWrites: false } } });
    const send = async (id: string): Promise<{ reply: Promise<WriteReply | undefined>; card: PostedMessage | undefined }> => {
      const from = w.posted.length;
      const reply = w.send({ type: "bridge", id, cmd: "write", args: { ops: [TEXT_RULE] } }).then((posted) => {
        const r = posted.find((m) => m.type === "bridge-result" && m.id === id);
        return r && r.ok ? (r.result as WriteReply) : undefined;
      });
      for (let i = 0; i < 200 && !w.posted.slice(from).some((m) => m.type === "review"); i++) await new Promise((res) => setTimeout(res, 0));
      return { reply, card: w.posted.slice(from).find((m) => m.type === "review") };
    };
    const first = await send("w1");
    ok("[RULE] a card is up and nothing changed yet", first.card !== undefined && w.footers().every((n) => n.characters === "Terms v1"));
    // The designer edits the file while the card is up: one more layer now matches.
    const title = w.texts().find((n) => n.characters === "Home");
    if (title) title.characters = "Terms v1";
    await w.send({ type: "review-answer", id: String(first.card?.id), action: "apply" });
    const r = await first.reply;
    const res = r && !("pending" in r) ? r : undefined;
    ok(`[RULE] approved after a drift: refused, nothing changed (got ${JSON.stringify(res).slice(0, 300)})`,
      !!res && !res.ok && /the file changed while the write waited for review: .*not the ones the card showed \(4 then, 5 now, or on other pages\)/.test(String(res.error)) && w.footers().every((n) => n.characters === "Terms v1"));
    if (title) title.characters = "Home";
    const second = await send("w2");
    await w.send({ type: "review-answer", id: String(second.card?.id), action: "apply" });
    const r2 = await second.reply;
    const res2 = r2 && !("pending" in r2) ? r2 : undefined;
    ok("[RULE] approved with the card's matches: applied", !!res2 && res2.ok && res2.applied[0]?.matched === 4 && w.footers().every((n) => n.characters === "Terms v2"));
  },
}, {
  name: "patchWhere review fixes: Show me does not move a selection rule's scope; a match moved to another page is drift; a variant by itself",
  async run() {
    const w = await ruleWorld({ extra: { reviewer: "real", clientStorage: { reviewWrites: false } } });
    const send = async (id: string, ops: WriteOp[]): Promise<{ reply: Promise<WriteReply | undefined>; card: PostedMessage | undefined }> => {
      const from = w.posted.length;
      const reply = w.send({ type: "bridge", id, cmd: "write", args: { ops } }).then((posted) => {
        const r = posted.find((m) => m.type === "bridge-result" && m.id === id);
        return r && r.ok ? (r.result as WriteReply) : undefined;
      });
      for (let i = 0; i < 200 && !w.posted.slice(from).some((m) => m.type === "review"); i++) await new Promise((res) => setTimeout(res, 0));
      return { reply, card: w.posted.slice(from).find((m) => m.type === "review") };
    };
    const result = async (p: Promise<WriteReply | undefined>): Promise<WriteResult | undefined> => { const r = await p; return r && !("pending" in r) ? r : undefined; };
    // The selection is one screen; Show me selects its matched layer instead, then Apply.
    const home = w.alive().find((n) => n.name === "Home");
    w.figma.currentPage.selection = home ? [home] : [];
    const sel = await send("s1", [{ ...TEXT_RULE, scope: "selection" }]);
    await w.send({ type: "review-show", id: String(sel.card?.id), index: 0 });
    const shownSel = w.figma.currentPage.selection.map((n) => String(n.name));
    await w.send({ type: "review-answer", id: String(sel.card?.id), action: "apply" });
    const r1 = await result(sel.reply);
    ok(`[RULE] Show me changed the selection (${JSON.stringify(shownSel)}), yet Apply looks where the card did (got ${JSON.stringify(r1).slice(0, 200)})`,
      shownSel.join() === "Footer" && !!r1 && r1.ok && r1.applied[0]?.matched === 1);
    // A whole-file rule waits; one match moves to another page meanwhile: the card's pages are no longer true.
    const moving = w.footers().find((n) => n.characters === "Terms v1");
    const file = await send("s2", [TEXT_RULE]);
    const screensPage = w.pages.screens;
    if (moving && typeof screensPage.appendChild === "function") (screensPage.appendChild as (c: FakeNode) => void)(moving);
    await w.send({ type: "review-answer", id: String(file.card?.id), action: "apply" });
    const r2 = await result(file.reply);
    ok(`[RULE] a match moved to another page while the card was up: refused (got ${JSON.stringify(r2).slice(0, 300)})`, !!r2 && !r2.ok && /not the ones the card showed/.test(String(r2.error)));
  },
}, {
  name: "patchWhere: a variant by itself or its whole set; the dry run checks the patch's names; rules pick from the file before the batch; a token is this session's",
  async run() {
    const w = await ruleWorld();
    const made = await write(w, [{ op: "createTree", tree: { name: "Buttons", children: [{ component: "Button", props: { Size: "Large" } }, { component: "Button", props: { Size: "Large" } }, { component: "Button" }] } }]);
    const total = async (where: Record<string, string>): Promise<string> => { const m = await matchOf(w, { op: "patchWhere", where, scope: "file", set: { opacity: 0.5 } }); return m.match ? String(m.match.total) : String(m.problem); };
    ok(`[RULE] instanceOf a set: every variant's instances; one variant by id or its own name: its own (got ${await total({ instanceOf: "Button" })} / ${await total({ instanceOf: "5:6" })} / ${await total({ instanceOf: "Size=Large" })})`,
      made.ok && (await total({ instanceOf: "Button" })) === "3" && (await total({ instanceOf: "5:6" })) === "2" && (await total({ instanceOf: "Size=Large" })) === "2");
    const refs = await matchOf(w, { op: "patchWhere", where: { name: "Card" }, scope: "file", set: { tokens: { opacity: "not/a/token" } } });
    ok(`[RULE] the dry run refuses a name the patch uses that the file lacks (got ${String(refs.problem)})`, /not\/a\/token/.test(String(refs.problem)));
    const chain = await write(w, [{ ...TEXT_RULE, set: { text: "Terms v2" } }, { ...TEXT_RULE, where: { text: "Terms v2" }, set: { text: "Terms v3" } }]);
    ok(`[RULE] every rule picks from the file as it was before the batch: the second matches nothing yet (got ${String(chain.error)})`, !chain.ok && /ops\[1\].*matches no layer/.test(String(chain.error)) && w.footers().every((n) => n.characters === "Terms v1"));
    // A token another plugin session gave (another file with the same ids, or this file after a reload) is refused.
    const many = { op: "createTree" as const, tree: { name: "List", children: Array.from({ length: 26 }, (_, i) => ({ name: "Row " + i, text: "Legacy" })) } };
    const other = await ruleWorld();
    await write(w, [many]);
    await write(other, [many]);
    const op: WriteOp = { op: "patchWhere", where: { text: "Legacy" }, set: { text: "Current" } };
    const theirs = (await matchOf(other, op)).match?.token;
    const ours = (await matchOf(w, op)).match;
    const foreign = await write(w, [{ ...op, token: theirs }]);
    ok(`[RULE] another session's token for the same ids is refused (got ${String(foreign.error)})`, !!theirs && !!ours && theirs !== ours.token && !foreign.ok && /26 then and now: other layers, or a token from before the plugin was reloaded/.test(String(foreign.error)));
  },
}, {
  name: "patchWhere: a match the designer deletes while another match resolves is named missing, never read (#206)",
  async run() {
    const w = await ruleWorld();
    const last = w.footers().at(-1);
    if (!last) throw new Error("no footer to match");
    const realLoad = w.figma.loadFontAsync;
    if (!realLoad) throw new Error("the world loads no fonts");
    let hits = 0;
    // The first match's patch resolves (its fonts load): the designer deletes the last match then.
    w.figma.loadFontAsync = async (f: { family: string; style: string }) => {
      const inPatch = new Error().stack?.includes("resolvePatchNode") === true;
      await realLoad(f);
      if (inPatch && !hits++) markRemoved(last);
    };
    const r = await write(w, [TEXT_RULE]);
    w.figma.loadFontAsync = realLoad;
    const missing = "(" + String(last.id) + ", page 'Screens'): no node with id '" + String(last.id) + "' (invalid or removed)";
    ok(`[RULE] a match removed while another resolves: refused, that match named missing by id, no read error (got ${String(r.error)})`,
      hits === 1 && !r.ok && r.applied.length === 0 && String(r.error).includes("1 of the 4 layers its rule matches cannot take this patch") && String(r.error).includes(missing) && !String(r.error).includes("in get_"));
  },
}];
