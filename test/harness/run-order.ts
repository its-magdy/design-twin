// [RUN-ORDER] which commands may run alongside which — the plugin's run scheduler (state.ts scheduleRun), driven
// through main.ts's real `bridge` handler from the run traits in bridge/src/commands.ts.
import { ok } from "../assert.ts";
import { must } from "../fixtures.ts";
import { skipAwareInstance, type FakeNode, type PostedMessage } from "../fake-figma.ts";
import { isRecord } from "../../bridge/src/json-util.ts";
import { ABANDONED, gate, settle, type Case } from "./helpers.ts";
import { world } from "./scene.ts";

/** Lets every queued microtask and a timer turn run: long enough for a run that is NOT held to answer. */
const turn = (): Promise<void> => new Promise((r) => setTimeout(r, 20));
/** Polls `cond` until it holds or ~2 s pass. */
const until = async (cond: () => boolean): Promise<void> => { for (let i = 0; i < 100 && !cond(); i++) await turn(); };

const resultFor = (posted: PostedMessage[], id: string): PostedMessage | undefined =>
  posted.find((m) => m.type === "bridge-result" && m.id === id);

/** A listChildren bridge-result's rows (empty for anything else). */
function childRows(m: PostedMessage | undefined): Array<Record<string, unknown>> {
  const r = m?.ok === true ? m.result : undefined;
  return isRecord(r) && Array.isArray(r.children) ? r.children.filter(isRecord) : [];
}

/** An instance with one visible and one hidden layer, whose `children` omits the hidden one while the world's
 *  figma.skipInvisibleInstanceChildren is on — the flag an export's catalogue walk holds across its awaits. */
function cardInstance(skipping: () => boolean): FakeNode {
  return skipAwareInstance({
    id: "9:1", name: "Card", type: "INSTANCE", width: 100, height: 40,
    children: [
      { id: "9:2", name: "Label", type: "TEXT", width: 80, height: 20 },
      { id: "9:3", name: "Badge", type: "FRAME", width: 10, height: 10, visible: false, children: [] },
    ],
  }, skipping);
}

export const cases: Case[] = [{
  // Pre-change the plugin answered every listing at once, whatever was running; only a daemon's own queue held
  // one back, and only for that daemon's clients. The window's own export and the MCP server that holds the
  // bridge reached a listing straight into the skipInvisibleInstanceChildren window. Here the exclusive run ahead
  // is the window's (source "ui"), so no bridge-side queue could have seen it.
  name: "[RUN-ORDER] a scene read never overlaps an exclusive run, whoever started either; identity reads answer at once",
  async run() {
    const w = world();
    const { api, figma, posted } = w;
    const handler = must(figma.ui.onmessage, "figma.ui.onmessage");
    w.scene.nodes["9:1"] = cardInstance(() => figma.skipInvisibleInstanceChildren === true);

    // The exclusive run ahead: a manual export from the window that holds the flag on across an await, as the
    // component catalogue walk does.
    const hold = gate();
    const started = gate();
    const ui = settle(api.serializeRun(async () => {
      figma.skipInvisibleInstanceChildren = true;
      started.open();
      try { await hold.p; } finally { figma.skipInvisibleInstanceChildren = false; }
      return "ui";
    }, { source: "ui", label: "Export full file" }));
    await started.p;

    posted.length = 0;
    void handler({ type: "bridge", id: "q-children", cmd: "listChildren", args: { nodeId: "9:1" } });
    void handler({ type: "bridge", id: "q-sel", cmd: "getSelection", args: {} });
    void handler({ type: "bridge", id: "q-who", cmd: "whoami", args: {} });
    void handler({ type: "bridge", id: "q-ping", cmd: "ping", args: {} });
    await turn();
    // pre-change: fails — listChildren and getSelection answered at once, the listing without the hidden layer.
    ok("[RUN-ORDER] a listing and the selection read wait while an exclusive run executes",
      !resultFor(posted, "q-children") && !resultFor(posted, "q-sel"));
    ok("[RUN-ORDER] …while whoami and ping answer during it",
      resultFor(posted, "q-who")?.ok === true && resultFor(posted, "q-ping")?.ok === true);
    const queuedIds = posted.filter((m) => m.type === "progress" && m.phase === "queued").map((m) => m.requestId);
    ok(`[RUN-ORDER] …each waiting scene read is told it is queued (got ${JSON.stringify(queuedIds)})`,
      queuedIds.join(",") === "q-children,q-sel");

    hold.open();
    await ui;
    await turn();
    const rows = childRows(resultFor(posted, "q-children"));
    // pre-change: fails on the hidden row — the listing read `children` inside the window and missed "Badge".
    ok(`[RUN-ORDER] once it ends, the listing runs and sees the hidden layer (got ${JSON.stringify(rows.map((r) => r.name))})`,
      rows.map((r) => r.name).join(",") === "Label,Badge" && rows[1]?.hidden === true);
    ok("[RUN-ORDER] …and the selection read answers too", resultFor(posted, "q-sel")?.ok === true);
    // A scene read is not a run the window shows: no run-begin/run-end for it (only the window's own export's).
    ok("[RUN-ORDER] a scene read posts no run-begin or run-end",
      !posted.some((m) => (m.type === "run-begin" || m.type === "run-end") && "label" in m && m.label !== "Export full file")
      && posted.filter((m) => m.type === "run-begin").length === 0);

    // In an idle file a scene read answers at once, with nothing queued and no run chrome.
    posted.length = 0;
    await w.send({ type: "bridge", id: "q-idle", cmd: "listChildren", args: { nodeId: "9:1" } });
    ok("[RUN-ORDER] in an idle file a scene read answers at once: no queued frame, no run-begin",
      resultFor(posted, "q-idle")?.ok === true && !posted.some((m) => m.type === "progress" || m.type === "run-begin"));
  },
}, {
  name: "[RUN-ORDER] an export waits behind a scene read that arrived first, and a queued scene read the bridge cancels never runs",
  async run() {
    const w = world();
    const { api, figma, posted } = w;
    const handler = must(figma.ui.onmessage, "figma.ui.onmessage");

    // FIFO across kinds: a listing that is executing holds the export that arrives after it.
    const hold = gate();
    const reads: string[] = [];
    figma.getNodeByIdAsync = async (id: string) => {
      reads.push(id);
      if (id === "9:1") await hold.p;
      return w.scene.nodes[id] ?? null;
    };
    w.scene.nodes["9:1"] = cardInstance(() => false);
    posted.length = 0;
    void handler({ type: "bridge", id: "s-1", cmd: "listChildren", args: { nodeId: "9:1" } });
    await turn();
    const write = settle(api.serializeRun(async () => "export", { source: "bridge", label: "exportNode", requestId: "x-1" }));
    await turn();
    ok("[RUN-ORDER] an exclusive run that arrives while a scene read executes waits for it (no run-begin yet)",
      !posted.some((m) => m.type === "run-begin") && posted.some((m) => m.type === "progress" && m.phase === "queued" && m.requestId === "x-1"));
    hold.open();
    ok("[RUN-ORDER] …and runs once the read has answered", (await write).v === "export" && resultFor(posted, "s-1")?.ok === true);

    // A scene read queued behind an export, cancelled by its id before its turn: it fails ABANDONED unrun.
    const hold2 = gate();
    const started = gate();
    const exp = settle(api.serializeRun(async () => { started.open(); await hold2.p; return "x"; }, { source: "bridge", label: "exportFull", requestId: "x-2" }));
    await started.p;
    posted.length = 0;
    reads.length = 0;
    void handler({ type: "bridge", id: "s-2", cmd: "listChildren", args: { nodeId: "9:1" } });
    await turn();
    await handler({ type: "cancel", id: "s-2" });
    hold2.open();
    await exp;
    await turn();
    const r = resultFor(posted, "s-2");
    ok(`[RUN-ORDER] a queued scene read the bridge cancels answers ABANDONED and never reads the scene (reads: ${reads.join(",") || "none"})`,
      r?.ok === false && r.error === ABANDONED && reads.length === 0);
  },
}, {
  // Every command through main.ts's real `bridge` handler, so it is each command's DECLARED trait (commands.ts) that is
  // checked — not a run a case built itself. The expected sets are written out here, not read from the traits.
  name: "[RUN-ORDER] every command runs as its trait says: identity answers at once, the rest wait, only exclusive runs are bracketed",
  async run() {
    const w = world();
    const { api, figma, posted } = w;
    const handler = must(figma.ui.onmessage, "figma.ui.onmessage");
    w.scene.nodes["9:1"] = cardInstance(() => false);
    const sent: Array<[string, Record<string, unknown>]> = [
      ["ping", {}], ["whoami", {}], ["getSelection", {}], ["listPages", { depth: 1 }], ["listChildren", { nodeId: "9:1" }],
      ["listLibraries", {}], ["exportFull", { css: false }], ["exportDesignSystem", {}], ["exportLibrary", {}],
      ["exportSelection", { css: false }], ["exportNode", { nodeId: "9:1", css: false }], ["screenshot", { nodeId: "9:1" }],
      ["write", { ops: [] }],
    ];
    const hold = gate();
    const started = gate();
    const ui = settle(api.serializeRun(async () => { started.open(); await hold.p; return "ui"; }, { source: "ui", label: "Export full file" }));
    await started.p;
    posted.length = 0;
    for (const [cmd, args] of sent) void handler({ type: "bridge", id: "t-" + cmd, cmd, args });
    await turn();
    const answered = sent.map(([c]) => c).filter((c) => resultFor(posted, "t-" + c));
    ok(`[RUN-ORDER] with a run executing, exactly ping and whoami answer (got ${answered.join(",")})`, answered.join(",") === "ping,whoami");
    const queued = posted.filter((m) => m.type === "progress" && m.phase === "queued").map((m) => m.requestId);
    ok(`[RUN-ORDER] …and every other command is told it is queued, in arrival order (got ${queued.join(",")})`,
      queued.join(",") === sent.map(([c]) => c).filter((c) => c !== "ping" && c !== "whoami").map((c) => "t-" + c).join(","));
    hold.open();
    await ui;
    await until(() => sent.every(([c]) => resultFor(posted, "t-" + c)));
    const begun = posted.filter((m) => m.type === "run-begin").map((m) => m.label);
    ok(`[RUN-ORDER] once it ends every command answers, and only the exclusive ones are bracketed, one at a time in order (got ${begun.join(",")})`,
      sent.every(([c]) => resultFor(posted, "t-" + c)) &&
      begun.join(",") === "exportFull,exportDesignSystem,exportLibrary,exportSelection,exportNode,screenshot,write");
  },
}];
