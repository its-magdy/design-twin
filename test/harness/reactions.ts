// Prototype interactions and flows (writes: setReactions, setFlowStart, clearFlowStart; figma-plugin/src/reactions.ts,
// docs/write-plane-spec.md decision 22): destinations resolved by name or id against the file before anything runs,
// never guessed; the reactions written in Figma's own form; the old ones kept and put back when a later op fails; flow
// starting points set, renamed and cleared on the frame's page; the review card in plain words.
import type { WriteOp, WriteResult } from "../../bridge/src/commands.ts";
import { lineText } from "../../bridge/src/review-card.ts";
import { ok } from "../assert.ts";
import type { FakeNode, PostedMessage } from "../fake-figma.ts";
import type { Case } from "./helpers.ts";
import { treeWorld } from "./writes.ts";

type World = Awaited<ReturnType<typeof treeWorld>>;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Page 1 (current) holds the fixtures "Existing A" (1:1) and "Existing B" (1:2), then: "Home" (a "Sign in" button, a
 *  "Footer" text and a "Cards" list holding a "Card"), "Details", "Menu" and two frames both named "Twin". "Screens"
 *  holds "Elsewhere". A component set "Toggle" (State=Off, State=On) whose Off variant holds a "Knob". */
async function protoWorld(extra: Parameters<typeof treeWorld>[0] = {}) {
  const w = await treeWorld(extra);
  const made = await w.api.applyWrites([
    { op: "createTree", tree: { name: "Home", handle: "home", children: [{ name: "Sign in", handle: "btn" }, { name: "Footer", text: "v1", handle: "footer" }, { name: "Cards", handle: "cards", children: [{ name: "Card", handle: "card" }] }] } },
    { op: "createTree", tree: { name: "Details", handle: "details" } },
    { op: "createTree", tree: { name: "Menu", handle: "menu" } },
    { op: "createTree", tree: { name: "Twin", handle: "twin1" } },
    { op: "createTree", tree: { name: "Twin", handle: "twin2" } },
    { op: "createTree", page: "Screens", tree: { name: "Elsewhere", handle: "elsewhere" } },
    { op: "createTree", tree: { type: "COMPONENT_SET", name: "Toggle", variant: { children: [{ name: "Knob" }] }, columns: ["State"], rows: [["Off"], ["On"]] } },
  ]);
  if (!made.ok) throw new Error("protoWorld: the screens did not build: " + String(made.error));
  const h: Record<string, string> = {};
  for (const a of made.applied) if (a.handles) Object.assign(h, a.handles);
  const byId = (id: string): FakeNode => { const n = w.made.find((m) => m.id === id); if (!n) throw new Error("no node " + id); return n; };
  const variants = w.made.filter((m) => m.type === "COMPONENT" && isObj(m.parent) && m.parent.type === "COMPONENT_SET");
  // The Off variant's knob (a base variant's layers take no handle: every variant has one).
  const knob = w.made.find((m) => m.name === "Knob" && isObj(m.parent) && /Off/.test(String(m.parent.name)));
  if (knob) h.knob = String(knob.id);
  return { ...w, h, byId, variants };
}
const write = (w: World, ops: WriteOp[]): Promise<WriteResult> => w.api.applyWrites(ops.map((o) => ({ ...o })));
const reactionsOf = (n: FakeNode): unknown[] => (Array.isArray(n.reactions) ? n.reactions : []);
const lastCard = (w: World): PostedMessage | undefined => [...w.posted].reverse().find((m) => m.type === "review");
const pageOf = (w: World, name: string): FakeNode => {
  const pg = (w.figma.root.children as FakeNode[]).find((p) => p.name === name);
  if (!pg) throw new Error("no page " + name);
  return pg;
};

export const cases: Case[] = [{
  name: "setReactions: destinations by name and id, written in Figma's form with its defaults, the old list replaced and counted",
  async run() {
    const w = await protoWorld();
    const btn = w.byId(w.h.btn ?? "");
    const r = await write(w, [{ op: "setReactions", nodeId: btn.id, reactions: [
      { trigger: "on_click", actions: [{ type: "node", destination: "Details", transition: { type: "smart_animate" } }] },
      { trigger: "after_timeout", timeout: 2000, actions: [{ type: "back" }] },
      { trigger: "on_hover", actions: [{ type: "node", navigation: "overlay", destinationId: w.h.menu ?? "" }] },
      { trigger: "mouse_enter", delay: 200, actions: [{ type: "url", url: "https://example.com", openInNewTab: true }, { type: "close" }] },
      { trigger: "on_key_down", keyCodes: [13], actions: [{ type: "node", destination: "Existing B", transition: { type: "slide_in", direction: "left", duration: 0.5, easing: "custom_cubic_bezier", cubicBezier: { x1: 0.2, y1: 0, x2: 0.4, y2: 1 } } }] },
    ] }]);
    ok(`[PROTO] applied: the reply counts the reactions and the ones replaced (got ${JSON.stringify(r)})`, r.ok && JSON.stringify(r.applied) === JSON.stringify([{ id: btn.id, reactions: 5, replaced: 0 }]));
    const got = reactionsOf(btn);
    const want = [
      { trigger: { type: "ON_CLICK" }, actions: [{ type: "NODE", destinationId: w.h.details, navigation: "NAVIGATE", transition: { type: "SMART_ANIMATE", easing: { type: "EASE_OUT" }, duration: 0.3 } }] },
      { trigger: { type: "AFTER_TIMEOUT", timeout: 2000 }, actions: [{ type: "BACK" }] },
      { trigger: { type: "ON_HOVER" }, actions: [{ type: "NODE", destinationId: w.h.menu, navigation: "OVERLAY", transition: null }] },
      { trigger: { type: "MOUSE_ENTER", delay: 200, deprecatedVersion: false }, actions: [{ type: "URL", url: "https://example.com", openInNewTab: true }, { type: "CLOSE" }] },
      { trigger: { type: "ON_KEY_DOWN", device: "KEYBOARD", keyCodes: [13] }, actions: [{ type: "NODE", destinationId: "1:2", navigation: "NAVIGATE",
        transition: { type: "SLIDE_IN", direction: "LEFT", matchLayers: false, easing: { type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1: 0.2, y1: 0, x2: 0.4, y2: 1 } }, duration: 0.5 } }] },
    ];
    ok(`[PROTO] the layer holds them in Figma's form: names resolved to ids, defaults (ease out, 0.3 s, instant = no transition) filled (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want));
    const again = await write(w, [{ op: "setReactions", nodeId: btn.id, reactions: [{ actions: [{ type: "back" }] }] }]);
    ok("[PROTO] a second list replaces the first (on_click by default), the reply says 5 were replaced",
      again.ok && again.applied[0]?.reactions === 1 && again.applied[0]?.replaced === 5 && JSON.stringify(reactionsOf(btn)) === JSON.stringify([{ trigger: { type: "ON_CLICK" }, actions: [{ type: "BACK" }] }]));
    const cleared = await write(w, [{ op: "setReactions", nodeId: btn.id, reactions: [] }]);
    ok("[PROTO] [] removes them all", cleared.ok && cleared.applied[0]?.reactions === 0 && cleared.applied[0]?.replaced === 1 && reactionsOf(btn).length === 0);
  },
}, {
  name: "setReactions: a name never guessed — none, several, another page, a layer inside a frame, a missing id, an id the name contradicts; every problem at once, nothing changed",
  async run() {
    const w = await protoWorld();
    const btn = w.byId(w.h.btn ?? "");
    const node = (destination: string, more: Record<string, unknown> = {}) => ({ actions: [{ type: "node", destination, ...more }] });
    const r = await write(w, [{ op: "setReactions", nodeId: btn.id, reactions: [
      node("Detail"), node("Twin"), node("Elsewhere"), { actions: [{ type: "node", destinationId: w.h.elsewhere ?? "" }] }, node("Card"), { actions: [{ type: "node", destinationId: w.h.card ?? "" }] }, node("99:99"),
      { actions: [{ type: "node", destinationId: w.h.details ?? "", destination: "Menu" }] },
    ] }, { op: "setFlowStart", nodeId: w.h.details ?? "", name: "Main" }]);
    const e = String(r.error);
    ok(`[PROTO-REFUSE] refused whole, every problem listed (got ${JSON.stringify(e)})`, !r.ok && /^8 problems — nothing was changed:/.test(e));
    ok("[PROTO-REFUSE] a name that matches nothing: the closest names", /reactions\[0\]\.actions\[0\]: destination 'Detail' matches no frame at the top of page 'Page 1'.*; closest: 'Details'/.test(e));
    ok("[PROTO-REFUSE] a name that matches several: their ids", new RegExp("reactions\\[1\\]\\.actions\\[0\\]: destination 'Twin' names 2 of them .* pass one's id: 'Twin' \\(" + String(w.h.twin1) + "\\), 'Twin' \\(" + String(w.h.twin2) + "\\)").test(e));
    ok("[PROTO-REFUSE] a frame on another page, by name (not one of this page's) and by id (said to be on that page)",
      /reactions\[2\]\.actions\[0\]: destination 'Elsewhere' matches no frame at the top of page 'Page 1'/.test(e)
      && new RegExp("reactions\\[3\\]\\.actions\\[0\\]: destination 'Elsewhere' \\(" + String(w.h.elsewhere) + "\\) is on page 'Screens'; a prototype connection stays on its own page \\('Page 1'\\)").test(e));
    ok("[PROTO-REFUSE] a layer inside a frame is no destination (by id: said where it is)",
      /reactions\[4\]\.actions\[0\]: destination 'Card' matches no frame/.test(e) && new RegExp("reactions\\[5\\]\\.actions\\[0\\]: destination 'Card' \\(" + String(w.h.card) + "\\) is a FRAME inside 'Cards', not a frame at the top").test(e));
    ok("[PROTO-REFUSE] a missing id", /reactions\[6\]\.actions\[0\]: destination: no node with id '99:99'/.test(e));
    ok("[PROTO-REFUSE] an id and a name that name different nodes", new RegExp("reactions\\[7\\]\\.actions\\[0\\]: `destinationId` '" + String(w.h.details) + "' is 'Details', but `destination` says 'Menu'").test(e));
    ok("[PROTO-REFUSE] nothing changed: no reactions, no flow", reactionsOf(btn).length === 0 && (pageOf(w, "Page 1").flowStartingPoints as unknown[]).length === 0);
    const kinds = await write(w, [{ op: "setReactions", nodeId: pageOf(w, "Page 1").id, reactions: [] }, { op: "setReactions", nodeId: "1:1", reactions: [] }, { op: "setReactions", nodeId: "77:7", reactions: [] }]);
    ok(`[PROTO-REFUSE] a page has no interactions; a layer without the API is said by its kind; a missing node (got ${JSON.stringify(kinds.error)})`, !kinds.ok
      && /ops\[0\] \(setReactions\): 'Page 1' \(0:1\) is a PAGE; prototype interactions are on a layer/.test(String(kinds.error))
      && /ops\[1\] \(setReactions\): 'Existing A' \(1:1\) is a FRAME, which has no prototype interactions/.test(String(kinds.error))
      && /ops\[2\] \(setReactions\): no node with id '77:7'/.test(String(kinds.error)));
  },
}, {
  name: "setReactions: scroll_to stays in the layer's frame, change_to in its component set, an overlay offset needs a Manual overlay",
  async run() {
    const w = await protoWorld();
    const btn = w.byId(w.h.btn ?? "");
    const ok1 = await write(w, [{ op: "setReactions", nodeId: btn.id, reactions: [{ actions: [{ type: "node", navigation: "scroll_to", destination: "Footer" }] }] }]);
    ok(`[PROTO-NAV] scroll_to a layer of the same frame, by name (got ${JSON.stringify(ok1.error)})`, ok1.ok && JSON.stringify(reactionsOf(btn)) === JSON.stringify([{ trigger: { type: "ON_CLICK" }, actions: [{ type: "NODE", destinationId: w.h.footer, navigation: "SCROLL_TO", transition: null }] }]));
    const other = await write(w, [{ op: "setReactions", nodeId: btn.id, reactions: [{ actions: [{ type: "node", navigation: "scroll_to", destinationId: w.h.details ?? "" }] }] }]);
    ok(`[PROTO-NAV] scroll_to another frame is refused (got ${JSON.stringify(other.error)})`, !other.ok && /is a FRAME, not a layer inside 'Home' \(scroll_to stays in the layer's own frame\)/.test(String(other.error)));
    const off = w.variants.find((v) => /Off/.test(String(v.name)));
    const knob = w.h.knob ?? "";
    const toggled = await write(w, [{ op: "setReactions", nodeId: knob, reactions: [{ actions: [{ type: "node", navigation: "change_to", destination: "State=On", transition: { type: "smart_animate", duration: 0.2 } }] }] }]);
    const on = w.variants.find((v) => /On/.test(String(v.name)));
    ok(`[PROTO-NAV] change_to a variant of the same set, by its variant name (got ${JSON.stringify(toggled.error)})`, toggled.ok && !!off && !!on
      && JSON.stringify(reactionsOf(w.byId(knob))[0]) === JSON.stringify({ trigger: { type: "ON_CLICK" }, actions: [{ type: "NODE", destinationId: on?.id, navigation: "CHANGE_TO", transition: { type: "SMART_ANIMATE", easing: { type: "EASE_OUT" }, duration: 0.2 } }] }));
    const outside = await write(w, [{ op: "setReactions", nodeId: btn.id, reactions: [{ actions: [{ type: "node", navigation: "change_to", destination: "State=On" }] }] }]);
    ok(`[PROTO-NAV] change_to outside a component set is refused (got ${JSON.stringify(outside.error)})`, !outside.ok && /change_to switches an interactive component to another variant, and 'Sign in' .* is not a variant of a component set or inside one/.test(String(outside.error)));
    const menu = w.byId(w.h.menu ?? "");
    const offset = { actions: [{ type: "node", navigation: "overlay", destination: "Menu", overlayOffset: { x: 10, y: 20 } }] };
    const centred = await write(w, [{ op: "setReactions", nodeId: btn.id, reactions: [offset] }]);
    ok(`[PROTO-NAV] an overlay offset on an overlay Figma centres is refused, saying why (got ${JSON.stringify(centred.error)})`, !centred.ok && /overlayOffset: the overlay 'Menu' is positioned in the centre \(the default\), and an offset applies only to one set to Manual/.test(String(centred.error)));
    menu.overlayPositionType = "MANUAL"; // the designer set it in the Prototype panel
    const manual = await write(w, [{ op: "setReactions", nodeId: btn.id, reactions: [offset] }]);
    const action = (reactionsOf(btn)[0] as { actions: Array<Record<string, unknown>> }).actions[0];
    ok(`[PROTO-NAV] …and written once the overlay is Manual (got ${JSON.stringify(manual.error)})`, manual.ok && JSON.stringify(action?.overlayRelativePosition) === JSON.stringify({ x: 10, y: 20 }));
  },
}, {
  name: "setReactions and flows are put back whole when a later op of the batch fails; a destination the batch deletes is refused",
  async run() {
    const w = await protoWorld();
    const btn = w.byId(w.h.btn ?? "");
    const first = await write(w, [{ op: "setReactions", nodeId: btn.id, reactions: [{ actions: [{ type: "back" }] }] }, { op: "setFlowStart", nodeId: w.h.home ?? "", name: "Main" }]);
    ok("[PROTO-BACK] set up: one reaction, one flow", first.ok && reactionsOf(btn).length === 1);
    const before = JSON.stringify(reactionsOf(btn));
    const flowsBefore = JSON.stringify(pageOf(w, "Page 1").flowStartingPoints);
    w.trap.add("characters");
    const r = await write(w, [
      { op: "setReactions", nodeId: btn.id, reactions: [{ actions: [{ type: "node", destination: "Details" }] }] },
      { op: "setFlowStart", nodeId: w.h.home ?? "", name: "Renamed" },
      { op: "setFlowStart", nodeId: w.h.details ?? "", name: "Second" },
      { op: "patch", nodeId: w.h.footer ?? "", set: { text: "v2" } },
    ]);
    w.trap.delete("characters");
    ok(`[PROTO-BACK] the batch failed at the patch and put back the reactions and both flow changes (got ${JSON.stringify(r)})`, !r.ok && r.failedAt === 3 && (r.restored ?? []).length === 3
      && JSON.stringify(reactionsOf(btn)) === before && JSON.stringify(pageOf(w, "Page 1").flowStartingPoints) === flowsBefore);
    const madeNow = await write(w, [{ op: "createTree", tree: { name: "Temp", handle: "temp" } }]);
    const temp = madeNow.applied[0]?.handles?.temp ?? "";
    const gone = await write(w, [{ op: "setReactions", nodeId: btn.id, reactions: [{ actions: [{ type: "node", destinationId: temp }] }] }, { op: "delete", nodeId: temp }]);
    ok(`[PROTO-BACK] a destination the same batch deletes is refused (got ${JSON.stringify(gone.error)})`, !gone.ok && new RegExp("ops\\[0\\] \\(setReactions\\): destination '" + temp + "' is deleted by ops\\[1\\] of this batch").test(String(gone.error)));
  },
}, {
  name: "flows: setFlowStart makes a top frame a starting point (renamed in place), clearFlowStart removes it; names unique per page, never guessed",
  async run() {
    const w = await protoWorld();
    const page = (): Array<{ nodeId: string; name: string }> => pageOf(w, "Page 1").flowStartingPoints as Array<{ nodeId: string; name: string }>;
    const a = await write(w, [{ op: "setFlowStart", nodeId: w.h.home ?? "", name: "Onboarding" }, { op: "setFlowStart", nodeId: w.h.details ?? "", name: "Browse" }]);
    ok(`[FLOWS] two flows, in order, the reply naming each (got ${JSON.stringify(a)})`, a.ok && JSON.stringify(page()) === JSON.stringify([{ nodeId: w.h.home, name: "Onboarding" }, { nodeId: w.h.details, name: "Browse" }])
      && JSON.stringify(a.applied) === JSON.stringify([{ id: w.h.home, flow: "Onboarding" }, { id: w.h.details, flow: "Browse" }]));
    const renamed = await write(w, [{ op: "setFlowStart", nodeId: w.h.home ?? "", name: "Sign up" }]);
    ok("[FLOWS] the same frame again renames its flow in place (first stays first), the reply says from what", renamed.ok && page()[0]?.name === "Sign up" && page().length === 2 && renamed.applied[0]?.from === "Onboarding");
    const clash = await write(w, [{ op: "setFlowStart", nodeId: w.h.menu ?? "", name: "Browse" }]);
    ok(`[FLOWS] a name another frame's flow has is refused (got ${JSON.stringify(clash.error)})`, !clash.ok && new RegExp("page 'Page 1' already has a flow 'Browse' \\(it starts at " + String(w.h.details) + "\\)").test(String(clash.error)) && page().length === 2);
    const inner = await write(w, [{ op: "setFlowStart", nodeId: w.h.card ?? "", name: "X" }, { op: "clearFlowStart", nodeId: w.h.menu ?? "" }]);
    ok(`[FLOWS] a layer inside a frame starts no flow; clearing a frame that starts none is refused (got ${JSON.stringify(inner.error)})`, !inner.ok
      && /ops\[0\] \(setFlowStart\): 'Card' .* is a FRAME inside 'Cards'; a flow starts from a frame at the top of its page/.test(String(inner.error))
      && /ops\[1\] \(clearFlowStart\): 'Menu' .* starts no flow on page 'Page 1' \(its flows: 'Sign up', 'Browse'\)/.test(String(inner.error)));
    const cleared = await write(w, [{ op: "clearFlowStart", nodeId: w.h.home ?? "" }]);
    ok("[FLOWS] clearFlowStart removes it, the reply names the flow it started", cleared.ok && JSON.stringify(page()) === JSON.stringify([{ nodeId: w.h.details, name: "Browse" }]) && cleared.applied[0]?.from === "Sign up" && cleared.applied[0]?.flow === undefined);
    const elsewhere = await write(w, [{ op: "setFlowStart", nodeId: w.h.elsewhere ?? "", name: "Browse" }]);
    ok("[FLOWS] flows are per page: the same name on another page is fine", elsewhere.ok && (pageOf(w, "Screens").flowStartingPoints as unknown[]).length === 1);
  },
}, {
  name: "the review card says a prototype change in plain words: the layer, how many it had, what each trigger does, by destination names",
  async run() {
    const w = await protoWorld({ extra: { clientStorage: { reviewWrites: true } } });
    const btn = w.byId(w.h.btn ?? "");
    const r = await write(w, [
      { op: "setReactions", nodeId: btn.id, reactions: [{ actions: [{ type: "node", destinationId: w.h.details ?? "", transition: { type: "dissolve" } }] }, { trigger: "after_timeout", timeout: 1500, actions: [{ type: "back" }] }] },
      { op: "setFlowStart", nodeId: w.h.home ?? "", name: "Main" },
    ]);
    const card = lastCard(w);
    const lines = (card?.lines ?? []).map((l) => lineText({ ...l, ops: [] }));
    ok(`[PROTO-CARD] the lines (got ${JSON.stringify(lines)})`, r.ok && lines.length === 2
      && lines[0] === "Layer 'Sign in': prototype none → on click → go to 'Details' (dissolve 300 ms); after 1.5 s → back"
      && lines[1] === "Frame 'Home': flow start none → 'Main'");
    ok(`[PROTO-CARD] Show me has the one layer each line changes (got ${JSON.stringify((card?.lines ?? []).map((l) => l.show))})`, (card?.lines ?? []).every((l) => l.show?.n === 1));
  },
}, {
  name: "the batch's own changes count: flow ops see the ones before them, scroll_to stays in a variant, a keyed re-send's removal or a move of a destination is refused",
  async run() {
    const w = await protoWorld();
    const flows = (): string => JSON.stringify(pageOf(w, "Page 1").flowStartingPoints);
    const twice = await write(w, [{ op: "setFlowStart", nodeId: w.h.home ?? "", name: "Main" }, { op: "setFlowStart", nodeId: w.h.details ?? "", name: "Main" }]);
    ok(`[PROTO-BATCH] two frames given one flow name in one batch: refused before anything ran (got ${JSON.stringify(twice)})`, !twice.ok && twice.failedAt === 1 && (twice.restored ?? []).length === 0
      && /page 'Page 1' already has a flow 'Main'/.test(String(twice.error)) && flows() === "[]");
    const setThenClear = await write(w, [{ op: "setFlowStart", nodeId: w.h.details ?? "", name: "Later" }, { op: "clearFlowStart", nodeId: w.h.details ?? "" }]);
    ok(`[PROTO-BATCH] a set then a clear of the same frame composes (got ${JSON.stringify(setThenClear.error)})`, setThenClear.ok && flows() === "[]");
    await write(w, [{ op: "setFlowStart", nodeId: w.h.home ?? "", name: "Main" }]);
    const handOver = await write(w, [{ op: "clearFlowStart", nodeId: w.h.home ?? "" }, { op: "setFlowStart", nodeId: w.h.details ?? "", name: "Main" }]);
    ok(`[PROTO-BATCH] a clear frees its name for a later set in the same batch (got ${JSON.stringify(handOver.error)})`, handOver.ok && flows() === JSON.stringify([{ nodeId: w.h.details, name: "Main" }]));
    const knob = w.h.knob ?? "";
    const inSet = await write(w, [{ op: "setReactions", nodeId: knob, reactions: [{ actions: [{ type: "node", navigation: "scroll_to", destination: "Knob" }] }] }]);
    ok(`[PROTO-BATCH] scroll_to from a variant's layer looks only inside that variant (got ${JSON.stringify(inSet.error)})`, !inSet.ok && /destination 'Knob' matches no layer inside 'State=Off'/.test(String(inSet.error)));
    const keyed = await write(w, [{ op: "createTree", tree: { key: "screen", name: "Keyed", children: [{ name: "Top", handle: "top" }, { name: "Bottom", handle: "bottom" }] } }]);
    const kh = keyed.applied[0]?.handles ?? {};
    const drop = await write(w, [{ op: "setReactions", nodeId: kh.top ?? "", reactions: [{ actions: [{ type: "node", navigation: "scroll_to", destinationId: kh.bottom ?? "" }] }] },
      { op: "createTree", tree: { key: "screen", name: "Keyed", children: [{ name: "Top", handle: "top" }] } }]);
    ok(`[PROTO-BATCH] a destination the batch's keyed re-send removes is refused (got ${JSON.stringify(drop.error)})`, !drop.ok
      && new RegExp("ops\\[0\\] \\(setReactions\\): destination '" + String(kh.bottom) + "' is removed by the keyed re-send in ops\\[1\\]").test(String(drop.error)));
    const temp = (await write(w, [{ op: "createTree", tree: { name: "Moving", handle: "m" } }])).applied[0]?.handles?.m ?? "";
    const moved = await write(w, [{ op: "setReactions", nodeId: w.h.btn ?? "", reactions: [{ actions: [{ type: "node", destinationId: temp }] }] }, { op: "move", nodeId: temp, parentId: w.h.home ?? "" }]);
    ok(`[PROTO-BATCH] a destination the batch moves is refused (got ${JSON.stringify(moved.error)})`, !moved.ok && new RegExp("destination '" + temp + "' is moved by ops\\[1\\] of this batch").test(String(moved.error)));
  },
}];
