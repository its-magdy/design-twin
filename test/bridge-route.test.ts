// The bridge route (bridge/src/route.ts) against BOTH of its adapters: one contract, run twice.
//   bun test/bridge-route.test.ts
// The own adapter is a real server-core bridge; the daemon adapter is the same kind of bridge served by a real
// daemon socket (daemon.serve, in this process) and reached through daemon.connect — what a second dtwin command
// or MCP server sees. The plugins are fake WebSocket clients that say hello and answer each command. Every bridge
// binds an ephemeral port and every socket lives in a private temp XDG_RUNTIME_DIR, so the suite never contends
// with a bridge or daemon you have open.
// The contract: what a route answers is the same whichever adapter is under it. The policy cases after it
// (the connect window spent once, the stall check, the never-connected guard) are the rules the route owns.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakePlugin, HANG, type FakePlugin, type Handlers } from "./fake-plugin.ts";
import { check, report } from "./assert.ts";
import { screenReply } from "./fixtures.ts";
import { setTimeout as sleep } from "node:timers/promises";
import type { ProgressTick } from "../bridge/src/server-core.ts";
import type { Route, RoutePolicy } from "../bridge/src/route.ts";
import type { ListPagesReply, PingReply } from "../bridge/src/commands.ts";

const TOKEN = "bridge-route-test-token";
process.env.FIGMA_BRIDGE_TOKEN = TOKEN;
process.env.XDG_RUNTIME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-route-")); // mkdtemp: 0700, ours
// server-core reads FIGMA_BRIDGE_TOKEN at load time, so it is imported after the assignment above.
const core = await import("../bridge/src/server-core.ts");
const daemon = await import("../bridge/src/daemon.ts");
const { createRoute, ownUpstream, daemonUpstream, servedBridge, isExportClass } = await import("../bridge/src/route.ts");

const asErr = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));
const failure = (p: Promise<unknown>): Promise<string> => p.then(() => "resolved", (e: unknown) => asErr(e).message);

// ---------------------------------------------------------------- the fake plugin

const ping = (file: string): PingReply => ({ pong: true, page: "Home", file });
const node = (file: string) => screenReply({ screenName: file, nodeId: "1:2", page: "Home", pageId: "0:1", screen: { screen: file, exportedAt: "2026-10-01T00:00:00.000Z", nodes: [] } });
const pages = (file: string): ListPagesReply => ({ exportedAt: "2026-10-01T00:00:00.000Z", file, depth: 1, pages: [], manifest: { pages: 0, warnings: [] } });
const answers = (file: string): Handlers => ({ ping: () => ping(file), exportNode: () => node(file), listPages: () => pages(file) });
const MUTE = (): typeof HANG => HANG; // never answers

/** Dials `port`, says hello as `file`, answers with `handlers` (any other command is never answered). */
async function plugin(port: number, file: string, handlers: Handlers = answers(file)): Promise<FakePlugin> {
  const p = fakePlugin(port, {
    token: TOKEN, hello: { instanceId: "fig-" + file, file, fileKey: "KEY" + file.toUpperCase(), page: "Home", pluginVersion: "0.0.0" },
    on: handlers, unhandled: HANG,
  });
  await p.opened;
  await sleep(50); // the hello lands before the caller asks anything
  return p;
}
const sent = (p: FakePlugin): string[] => p.commands().map((c) => c.cmd);

// ---------------------------------------------------------------- the two adapters

interface Rig { name: string; port: number; route(policy: RoutePolicy): Route; stop(): void }
let sockPort = 19797; // a socket NAME per daemon rig (the bridge's own TCP port is ephemeral)

async function bridge() {
  const b = core.createBridge(0, { settleMs: 0, heartbeatMs: 0 });
  await b.listening;
  const port = b.boundPort();
  if (port === null) throw new Error("the bridge did not bind");
  return { b, port };
}

async function ownRig(): Promise<Rig> {
  const { b, port } = await bridge();
  const up = ownUpstream(b);
  return { name: "own", port, route: (policy) => createRoute(async () => up, policy), stop: () => b.close() };
}

const DAEMON_TOKEN = "bridge-route-daemon-token";
async function daemonRig(): Promise<Rig> {
  const { b, port } = await bridge();
  const name = sockPort++;
  // The token named on both ends, so on Windows the pipe is named from it and never the user's saved one.
  const h = await daemon.serve(servedBridge(b), { port: name, idleMin: 0, signals: false, crashHandlers: false, token: DAEMON_TOKEN });
  const conn = await daemon.connect(name, { token: DAEMON_TOKEN });
  if (!conn) throw new Error("daemon.connect() returned null right after serve()");
  const up = daemonUpstream(conn, () => daemon.status(name, { token: DAEMON_TOKEN }));
  return { name: "daemon", port, route: (policy) => createRoute(async () => up, policy), stop: () => h.shutdown() };
}

// stallMs is set (and short) so a persistent route that DID stall-check would show it.
const PERSISTENT: RoutePolicy = { connectWaitMs: 0, oneShot: false, stallMs: 300, namedWaitMs: 600 };

// ---------------------------------------------------------------- the contract, once per adapter

async function contract(make: () => Promise<Rig>): Promise<void> {
  {
    const rig = await make();
    const t = `[${rig.name}]`;
    const route = rig.route(PERSISTENT);
    try {
      check(`${t} nothing connected: resolveClient's not-connected text, at once`,
        /^Figma plugin not connected\. Open the file in Figma and run the plugin\.$/.test(await failure(route.request("ping", {}))));
      check(`${t} nothing connected: listClients is empty`, (await route.listClients()).length === 0);

      const a = await plugin(rig.port, "Alpha");
      const one = await route.request("ping", {});
      check(`${t} one file, unaddressed: answered by it, and the reply names it`, one.reply.file === "Alpha" && one.client?.connId === "c1" && one.client.file === "Alpha");

      const b = await plugin(rig.port, "Bravo");
      check(`${t} two files, unaddressed: refused, listing both`,
        /^2 Figma files are connected to the bridge — say which one to use\.\n {2}c1 {2}"Alpha".*\n {2}c2 {2}"Bravo"/.test(await failure(route.request("ping", {}))));
      const byId = await route.request("ping", {}, { target: "c2" });
      check(`${t} a connId routes to that file`, byId.reply.file === "Bravo" && byId.client?.connId === "c2");
      const byName = await route.request("ping", {}, { target: "Alpha" });
      check(`${t} a file name routes to that file`, byName.reply.file === "Alpha" && byName.client?.connId === "c1");

      const rows = await route.listClients();
      check(`${t} listClients: both files, by connId`, rows.map((r) => `${r.connId}:${r.file}`).join(",") === "c1:Alpha,c2:Bravo");

      const info = await route.connectionInfo("c2");
      check(`${t} connectionInfo(c2) describes c2's socket, not the first one`,
        info.connection !== null && info.connection.connId === "c2" && info.connection.clientsConnected === 2);
      check(`${t} connectionInfo says who holds the bridge`,
        rig.name === "own" ? info.owner.kind === "own" : info.owner.kind === "daemon" && info.owner.pid === process.pid);

      // A named file that is not connected yet is waited for (the named window), then routed.
      const late = route.request("ping", {}, { target: "Charlie" }).then((o) => o.reply.file, (e: unknown) => asErr(e).message);
      await sleep(150);
      const c = await plugin(rig.port, "Charlie");
      const got = await late;
      check(`${t} a named file that lands inside the named window is waited for`, got === "Charlie");
      c.terminate();
      await sleep(50);

      // …and one that never lands fails after the window with resolveClient's text, which lists what IS there.
      const t0 = Date.now();
      const never = await failure(route.request("ping", {}, { target: "Delta" }));
      const waited = Date.now() - t0;
      check(`${t} a named file that never lands: resolveClient's no-match text`, /^no connected Figma file matches 'Delta'\. Connected:\n {2}c1/.test(never));
      check(`${t} …after the named window, not at once and not the whole connect window (${waited} ms)`, waited >= 450 && waited < 5000);

      // Progress: an export-class command hears its ticks, in order; any other command never does.
      const ticks: string[] = [];
      const pb: Handlers = { ...answers("Echo"), exportNode: (_, ctx) => {
        ctx.progress({ phase: "pages", page: { index: 1, of: 2, name: "P1" }, nodes: 10, assets: null });
        ctx.progress({ phase: "assets", page: null, nodes: null, assets: 3 });
        return node("Echo");
      }, listPages: (_, ctx) => {
        ctx.progress({ phase: "pages", page: null, nodes: 1, assets: null });
        return pages("Echo");
      } };
      const e = await plugin(rig.port, "Echo", pb);
      const onProgress = (k: ProgressTick) => { ticks.push(k.phase ?? "?"); };
      await route.request("exportNode", { nodeId: "1:2" }, { target: "Echo", onProgress });
      check(`${t} an export hears its progress ticks, in order`, ticks.join(",") === "pages,assets");
      ticks.length = 0;
      await route.request("listPages", {}, { target: "Echo", onProgress });
      check(`${t} a non-export command never hears a tick`, ticks.length === 0);

      // Cancel: the caller's signal aborts the request, and the plugin is told.
      const m = await plugin(rig.port, "Mute", { ...answers("Mute"), exportNode: MUTE });
      const ac = new AbortController();
      const pending = failure(route.request("exportNode", { nodeId: "1:2" }, { target: "Mute", signal: ac.signal, timeoutMs: 10000 }));
      await sleep(200);
      ac.abort(new Error("caller gave up"));
      const why = await pending;
      for (let i = 0; i < 40 && m.cancels.length === 0; i++) await sleep(25);
      check(`${t} an aborted request rejects (${why})`, why !== "resolved");
      check(`${t} …and the plugin gets a cancel frame for it`, sent(m).includes("exportNode") && m.cancels.length === 1);

      for (const p of [a, b, e, m]) p.terminate();
    } finally {
      rig.stop();
    }
  }
  {
    // A one-shot route over this adapter: the window is the policy's, and a file landing inside it is waited for.
    const rig = await make();
    const t = `[${rig.name} one-shot]`;
    try {
      const route = rig.route({ connectWaitMs: 3000, oneShot: true, stallMs: 300, namedWaitMs: 600 });
      setTimeout(() => { void plugin(rig.port, "Late"); }, 300);
      const got = await route.request("ping", {}).then((o) => o.reply.file, (e: unknown) => asErr(e).message);
      check(`${t} a file that lands inside the connect window answers`, got === "Late");
    } finally {
      rig.stop();
    }
  }
  {
    // The CLI's explicit window (`--timeout 1`) is the window for a NAMED target too, through either adapter:
    // the policy is the CLI's own (no namedWaitMs), so a named file is not stretched to NAMED_CLIENT_WAIT_MS.
    const rig = await make();
    const t = `[${rig.name} one-shot, --timeout 1]`;
    try {
      const route = rig.route({ connectWaitMs: 1000, oneShot: true });
      let t0 = Date.now();
      const none = await failure(route.request("ping", {}, { target: "Bravo" }));
      let took = Date.now() - t0;
      check(`${t} a named file, no plugin ever connected: fails after the 1 s window, not 15 s (${took} ms)`,
        none !== "resolved" && took >= 800 && took < 3000);
      // A second command: a fresh one-shot route (one per CLI process), now with another file connected.
      const a = await plugin(rig.port, "Alpha");
      t0 = Date.now();
      const other = await failure(rig.route({ connectWaitMs: 1000, oneShot: true }).request("ping", {}, { target: "Bravo" }));
      took = Date.now() - t0;
      check(`${t} a named file while another is connected: resolveClient's no-match text within the window (${took} ms)`,
        /^no connected Figma file matches 'Bravo'\. Connected:\n {2}c1 {2}"Alpha"/.test(other) && took < 3000);
      a.terminate();
    } finally {
      rig.stop();
    }
  }
}

// ---------------------------------------------------------------- the rules a route owns, per policy

async function rules(): Promise<void> {
  check("isExportClass: the six commands that walk a tree", ["exportNode", "exportSelection", "exportFull", "exportDesignSystem", "exportLibrary", "screenshot"].every((c) => isExportClass(c)));
  check("isExportClass: never the index reads, pings or writes", ["ping", "whoami", "getSelection", "listPages", "listChildren", "listLibraries", "write"].every((c) => !isExportClass(c)));

  // The stall check: a one-shot route over its own bridge, export-class commands only.
  {
    const rig = await ownRig();
    try {
      const m = await plugin(rig.port, "Mute", { exportNode: MUTE, listPages: MUTE });
      const oneShot = rig.route({ connectWaitMs: 1000, oneShot: true, stallMs: 300 });
      let t0 = Date.now();
      const stalled = await failure(oneShot.request("exportNode", { nodeId: "1:2" }, { timeoutMs: 5000 }));
      check(`[stall] one-shot, own bridge, an export: the stall text after stallMs (${Date.now() - t0} ms)`,
        /^the plugin is connected but sent nothing for 'exportNode' \(node 1:2\) in 0s/.test(stalled) && Date.now() - t0 < 2500);
      t0 = Date.now();
      const listed = await failure(oneShot.request("listPages", {}, { timeoutMs: 1200 }));
      check("[stall] …a non-export command is not stall-checked: it runs to its timeout",
        /did not answer 'listPages' within 1s/.test(listed) && Date.now() - t0 >= 1100);
      const persistent = rig.route(PERSISTENT);
      const timedOut = await failure(persistent.request("exportNode", { nodeId: "1:2" }, { timeoutMs: 1200 }));
      check("[stall] a persistent route never stall-checks: the export runs to its timeout", /did not answer 'exportNode' within 1s/.test(timedOut));
      m.terminate();
    } finally {
      rig.stop();
    }
  }
  {
    const rig = await daemonRig();
    try {
      const m = await plugin(rig.port, "Mute", { exportNode: MUTE });
      const viaDaemon = await failure(rig.route({ connectWaitMs: 1000, oneShot: true, stallMs: 300 }).request("exportNode", { nodeId: "1:2" }, { timeoutMs: 1200 }));
      check("[stall] one-shot through a daemon: no stall check (its connection is warm), the export runs to its timeout",
        /did not answer 'exportNode' within 1s/.test(viaDaemon));
      m.terminate();
    } finally {
      rig.stop();
    }
  }

  // The connect window of a one-shot route over its own bridge is spent once, up front.
  {
    const rig = await ownRig();
    try {
      const route = rig.route({ connectWaitMs: 400, oneShot: true });
      check("[never] nothing ever connected: listClients is a legitimate empty answer", (await route.listClients()).length === 0);
      const never = await failure(route.request("ping", {}));
      check("[never] …and a command is the never-connected text, naming the window",
        /^no Figma plugin connected within 0s\. In Figma DESKTOP open the file/.test(never));
    } finally {
      rig.stop();
    }
  }
  {
    // `dtwin list clients` on a bridge it just opened: the open windows are mid-redial, so it waits too.
    const rig = await ownRig();
    try {
      const route = rig.route({ connectWaitMs: 5000, oneShot: true });
      setTimeout(() => { void plugin(rig.port, "Alpha"); }, 200);
      const rows = await route.listClients();
      check("[connect] one-shot listClients waits for a file still reconnecting, and lists it", rows.length === 1 && rows[0]?.file === "Alpha");
    } finally {
      rig.stop();
    }
  }
  {
    const rig = await ownRig();
    try {
      const route = rig.route({ connectWaitMs: 5000, oneShot: true });
      setTimeout(() => { void plugin(rig.port, "Alpha").then((p) => { setTimeout(() => p.terminate(), 300); }); }, 200);
      const c = await route.connect();
      check(`[connect] connect() waits for the first file and says how long (${c.waitedMs} ms)`, c.waitedMs >= 150 && c.waitedMs < 3000);
      check("[connect] …and is spent once: a second connect() waits no more", (await route.connect()).waitedMs === c.waitedMs);
      await sleep(500); // Alpha has left again
      const t0 = Date.now();
      const left = await failure(route.request("ping", {}));
      check("[connect] a file that connected and left: resolveClient's text, not the never-connected one",
        /^Figma plugin not connected\. Open the file in Figma and run the plugin\.$/.test(left));
      check(`[connect] …at once, not after another connect window (${Date.now() - t0} ms)`, Date.now() - t0 < 1000);
    } finally {
      rig.stop();
    }
  }
  {
    // A daemon route spends no window up front: the daemon waits inside each request.
    const rig = await daemonRig();
    try {
      check("[connect] through a daemon connect() waits for nothing", (await rig.route({ connectWaitMs: 5000, oneShot: true }).connect()).waitedMs === 0);
    } finally {
      rig.stop();
    }
  }
}

// The suite reports its own failures (report() sets the exit code); nothing awaits the IIFE.
void (async () => {
  try {
    console.log("contract — own bridge:");
    await contract(ownRig);
    console.log("contract — daemon socket:");
    await contract(daemonRig);
    console.log("route rules:");
    await rules();
  } catch (e) {
    check("the suite ran without throwing — " + asErr(e).message, false);
  }
  report();
})();
