// [LIVE] liveness frames + the per-node abandon check (the live stall), and [ASSET-RACE].
import { ok } from "../assert.ts";
import { must } from "../fixtures.ts";
import type { FakeNode, PostedMessage } from "../fake-figma.ts";
import { ABANDONED, gate, settle, type Case } from "./helpers.ts";
import { world } from "./scene.ts";

export const cases: Case[] = [{
  // One case: queued frames are about runs overlapping on one run chain, and the variant-walk abandon is
  // followed by a direct export that checks what that abandoned run left behind (skipAssets restored).
  name: "[LIVE] liveness frames + the per-node abandon check (the live stall)",
  async run() {
    // A cold direct pull was aborted by the CLI's 20 s stall check while the plugin was working: the
    // plugin's first frame for an exportNode was its first per-asset tick, and a run queued behind an
    // earlier one said nothing at all. Now a bridge run queued behind another posts a `queued` progress
    // frame (ui.html relays it over the socket), and an abandoned walk stops within one node.
    const w = world();
    const { api, figma, posted } = w;
    const handler = must(figma.ui.onmessage, "figma.ui.onmessage");
    const queuedFrames = (): PostedMessage[] => posted.filter((m) => m.type === "progress" && m.phase === "queued");

    // a bridge run that arrives while a UI run executes posts `queued` at once, before its run-begin.
    posted.length = 0;
    const gU = gate(), startU = gate();
    const pU = settle(api.serializeRun(async () => { startU.open(); await gU.p; return "U"; }, { source: "ui", label: "live-ui" }));
    await startU.p;
    const pB = settle(api.serializeRun(async () => "B", { source: "bridge", label: "exportNode", requestId: "live-b" }));
    const queuedEarly = queuedFrames().map((m) => JSON.stringify(m)).join("|");
    gU.open();
    await pU; const rB = await pB;
    const qAt = posted.findIndex((m) => m.type === "progress" && m.phase === "queued");
    const bBeganAt = posted.findIndex((m) => m.type === "run-begin" && m.label === "exportNode");
    // pre-change: fails — nothing was posted for a bridge run until its run-begin.
    ok("a bridge run queued behind an executing UI run posts {type:\"progress\",phase:\"queued\",source:\"bridge\",label} at once, before its run-begin",
      queuedEarly === '{"type":"progress","phase":"queued","source":"bridge","label":"exportNode","requestId":"live-b"}' && qAt >= 0 && bBeganAt > qAt && rB.v === "B");
    // the queued frame (above) and the run-begin name the bridge request, so the bridge can hand
    // the relayed `start` / `queued` to that request only.
    const bBegin = posted[bBeganAt];
    ok("a bridge run's run-begin carries its requestId (the queued frame above carries it too)",
      !!bBegin && bBegin.type === "run-begin" && bBegin.requestId === "live-b");
    // A bridge run with nothing ahead of it, and a UI run queued behind another, post no `queued` frame.
    posted.length = 0;
    await api.serializeRun(async () => "alone", { source: "bridge", label: "exportNode", requestId: "live-alone" });
    const gU2 = gate(), startU2 = gate();
    const pU2 = settle(api.serializeRun(async () => { startU2.open(); await gU2.p; return "U2"; }, { source: "ui", label: "live-ui-2" }));
    await startU2.p;
    const pU3 = settle(api.serializeRun(async () => "U3", { source: "ui", label: "live-ui-3" }));
    gU2.open();
    await pU2; await pU3;
    ok("…a bridge run with nothing ahead of it and a UI run queued behind another post no `queued` frame",
      queuedFrames().length === 0);
    // (control) the run-begin of a bridge run carries source "bridge" — what ui.html relays as `start`.
    ok("the run-begin of a bridge run is posted with source \"bridge\" and its label",
      posted.some((m) => m.type === "run-begin" && m.source === "bridge" && m.label === "exportNode"));

    // (b2) an abandon armed MID-SERIALIZE stops the walk before the next node. collectNode has
    // no page/frame safe point and these nodes paint nothing, so before the per-node check the walk
    // read every sibling and delivered the doc to a caller that had gone.
    posted.length = 0;
    let readAfter = 0;
    const counted = (id: string): FakeNode => ({ type: "FRAME", id, visible: true, width: 10, height: 10, layoutMode: "NONE", children: [],
      get name() { readAfter++; return "After " + id; } });
    const trap: FakeNode = { type: "FRAME", name: "Trap", id: "lv:2", visible: true, width: 10, height: 10, layoutMode: "NONE",
      get children() { void handler({ type: "cancel", id: "lv-req" }); return []; } };
    const liveRoot: FakeNode = { type: "FRAME", name: "Live", id: "lv:1", visible: true, width: 100, height: 100, layoutMode: "NONE",
      exportAsync: async () => new Uint8Array([137, 80, 78, 71]), children: [trap, counted("lv:3"), counted("lv:4")] };
    w.scene.nodes["lv:1"] = liveRoot;
    figma.skipInvisibleInstanceChildren = false;
    await handler({ type: "bridge", id: "lv-req", cmd: "exportNode", args: { nodeId: "lv:1", css: false } });
    const resL = posted.find((m) => m.type === "bridge-result");
    // pre-change: fails — ok:true, both siblings read (readAfter 2).
    ok("an abandon armed mid-serialize aborts before the next node: bridge-result ok:false with ABANDONED_MESSAGE, no sibling read after the trap",
      !!resL && resL.ok === false && resL.id === "lv-req" && resL.error === ABANDONED && resL.result === undefined && readAfter === 0);
    ok("…the run is closed out as abandoned, and skipInvisibleInstanceChildren is untouched",
      JSON.stringify(posted.filter((m) => m.type === "run-end")) === '[{"type":"run-end","abandoned":true}]' && figma.skipInvisibleInstanceChildren === false);
    // The same node with no abandon exports normally — the check costs a clean run nothing.
    posted.length = 0;
    readAfter = 0;
    Object.defineProperty(trap, "children", { value: [], configurable: true }); // the getter becomes a plain value: no cancel this time
    await handler({ type: "bridge", id: "lv-req-2", cmd: "exportNode", args: { nodeId: "lv:1", css: false } });
    const resL2 = posted.find((m) => m.type === "bridge-result");
    ok("…and without an abandon the same node exports in full",
      !!resL2 && resL2.ok === true && readAfter >= 2);

    // [ASSET-RACE] an UNQUEUED command answered during an export must not drop that export's
    // assets. main.ts released the module asset array after EVERY bridge reply, so a `ping` that landed
    // mid-walk emptied the array the export was filling: the result lost the icons collected before it,
    // while the node tree still pointed at their files.
    posted.length = 0;
    let pingP: Promise<void> | null = null;
    const raceIcon = (id: string, body: string, gate?: () => Promise<unknown>): FakeNode => ({ type: "VECTOR", name: "glyph-" + id, visible: true, id, width: 16, height: 16,
      fills: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 1 }],
      exportAsync: async () => { if (gate) await gate(); return body; } });
    const pingTrap: FakeNode = { type: "FRAME", name: "PingTrap", id: "ar:t", visible: true, width: 10, height: 10, layoutMode: "NONE",
      get children() { pingP ??= handler({ type: "bridge", id: "ar-ping", cmd: "ping", args: {} }); return []; } };
    const raceRoot: FakeNode = { type: "FRAME", name: "Race", id: "ar:1", visible: true, width: 100, height: 100, layoutMode: "NONE",
      exportAsync: async () => new Uint8Array([137, 80, 78, 71]),
      children: [raceIcon("ar:a", "<svg>first</svg>"), pingTrap, raceIcon("ar:b", "<svg>second</svg>", () => must(pingP, "ping sent"))] };
    w.scene.nodes["ar:1"] = raceRoot;
    await handler({ type: "bridge", id: "ar-req", cmd: "exportNode", args: { nodeId: "ar:1", css: false } });
    const resPing = posted.find((m) => m.type === "bridge-result" && m.id === "ar-ping");
    const resRace = posted.find((m) => m.type === "bridge-result" && m.id === "ar-req");
    const raceSvgs = resRace && resRace.ok ? (resRace.result as { assets: { format: string; from?: string[]; id: string }[] }).assets.filter((a) => a.format === "svg").map((a) => a.id).sort() : [];
    // pre-change: fails — raceSvgs is ["ar:b"]: the ping's reply released "ar:a" mid-export.
    ok("[ASSET-RACE] a ping answered mid-export leaves the export's earlier assets in its result",
      !!resPing && resPing.ok === true && JSON.stringify(raceSvgs) === '["ar:a","ar:b"]');
    ok("[ASSET-RACE] …and once that export has settled its asset tables hold nothing",
      JSON.stringify(w.api.assetRetention()) === JSON.stringify({ assets: 0, byContent: 0, byName: 0 }));

    // inside the catalog's variant walk: each variant's serialize is wrapped in a catch that
    // WARNS and moves on (components.ts), so the per-node throw is swallowed there — the collector's
    // backstop must still refuse to deliver, and the walk's toggles must be restored by their finally.
    posted.length = 0;
    let variantKidsRead = 0;
    const vTrap: FakeNode = { type: "FRAME", name: "VTrap", id: "lvv:3", visible: true, width: 4, height: 4, layoutMode: "NONE",
      get children() { void handler({ type: "cancel", id: "lv-ds" }); return []; } };
    const vAfter: FakeNode = { type: "FRAME", id: "lvv:4", visible: true, width: 4, height: 4, layoutMode: "NONE", children: [],
      get name() { variantKidsRead++; return "VAfter"; } };
    const lvSet: FakeNode = { type: "COMPONENT_SET", id: "lvset:1", name: "Chip", key: "lvsetkey",
      componentPropertyDefinitions: { State: { type: "VARIANT", variantOptions: ["A", "B"] } } };
    const lvA: FakeNode = { type: "COMPONENT", id: "lvv:1", name: "State=A", key: "lvkey_a", parent: lvSet, visible: true, children: [vTrap, vAfter] };
    const lvB: FakeNode = { type: "COMPONENT", id: "lvv:2", name: "State=B", key: "lvkey_b", parent: lvSet, visible: true,
      get children() { variantKidsRead++; return []; } };
    const lvPage = { name: "Chips", id: "p:lv", loadAsync: async () => {},
      findAllWithCriteria: ({ types }: { types: string[] }) => (types.indexOf("COMPONENT_SET") !== -1 ? [lvSet, lvA, lvB] : []) };
    figma.root.children = [lvPage];
    figma.skipInvisibleInstanceChildren = false;
    const rDs = await settle(api.serializeRun(() => api.collectDesignSystemOnly({ variantVisuals: true }), { source: "bridge", label: "exportDesignSystem", requestId: "lv-ds" }));
    // pre-change: fails — the variant walk ran to the end and the design-system doc was delivered.
    ok("an abandon inside the variant walk (whose per-variant catch swallows it) still rejects with ABANDONED_MESSAGE — no doc",
      rDs.v === null && rDs.err?.message === ABANDONED && variantKidsRead === 0);
    ok("…and skipInvisibleInstanceChildren is back to its value before the run (the catalog's finally)",
      figma.skipInvisibleInstanceChildren === false);
    // runOpts.skipAssets was set by the variant walk and must be restored by its finally: the next
    // export of a vector really exports it.
    let liveSvg = 0;
    const vecFrame: FakeNode = { type: "FRAME", name: "VecHost", id: "lvx:1", visible: true, width: 20, height: 20, layoutMode: "NONE",
      exportAsync: async () => new Uint8Array([137, 80, 78, 71]),
      children: [{ type: "VECTOR", name: "Dot", id: "lvx:2", visible: true, width: 8, height: 8,
        fills: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 1 }], fillGeometry: [{ data: "M0 0L8 0L8 8Z", windingRule: "NONZERO" }],
        exportAsync: async () => { liveSvg++; return "<svg width=\"8\" height=\"8\"><path d=\"M0 0h8\"/></svg>"; } }] };
    w.scene.nodes["lvx:1"] = vecFrame;
    const afterVar = await api.collectNode("lvx:1", { css: false });
    ok("…and the variant walk's skipAssets toggle was restored (the next export renders its vector)",
      liveSvg === 1 && typeof afterVar.screen.nodes[0]?.children?.[0]?.asset === "string");
  },
}];
