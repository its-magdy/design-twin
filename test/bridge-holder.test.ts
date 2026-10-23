// The bridge holder (bridge/src/bridge-holder.ts) through its interface, in-process: a fake bridge factory and a fake
// daemon side stand in for server-core and the daemon socket, so the sharing rules — who binds, when it is published,
// whether a session that lost its client may exit, and that everything is let go exactly once — are checked without
// a port, a socket or a subprocess. test/mcp-lifecycle.test.ts and test/mcp-share.test.ts still boot the real MCP
// server for what only a process shows (stdin, signals, exit codes).
//   bun test/bridge-holder.test.ts
import { check, report } from "./assert.ts";
import { bridgeHolder } from "../bridge/src/bridge-holder.ts";
import type { BridgeFactory, DaemonSide, Lifetime, OwnBridge } from "../bridge/src/bridge-holder.ts";
import type { BridgeSettings } from "../bridge/src/settings.ts";
import type { DaemonActivity, DaemonBridge, DaemonConnection, ServeHandle } from "../bridge/src/daemon.ts";
import type { ConnectionInfo } from "../bridge/src/server-core.ts";
import { NO_DAEMON_TOKEN } from "../bridge/src/daemon.ts";
import { setTimeout as sleep } from "node:timers/promises";

const SETTINGS: BridgeSettings = {
  port: 8787,
  token: { ok: true, resolved: { token: "t", source: "env", path: null, created: false } },
  maxPayload: { mb: 128, bytes: 128 * 1024 * 1024 },
  idleMs: 60000,
  idleRaw: undefined,
  ephemeralPort: false,
};

const CONNECTION: ConnectionInfo = {
  connId: null, connected: false, connectedAt: null, connectionUptimeMs: 0, connectionsThisRun: 0, clientsConnected: 0,
  clients: [], takeovers: 0, lastTakeoverAt: null,
};

interface FakeBridge extends OwnBridge { closes: number; listenError: boolean }

/** A bridge factory whose bridges bind at once — or, with `held`, report a held port (through onListenError when given
 *  one, as server-core does; without one, the real thing would exit the process, which no case here asks for). */
function bridges({ held = false, bindMs = 0 }: { held?: boolean; bindMs?: number } = {}) {
  const made: FakeBridge[] = [];
  const factory: BridgeFactory = (_settings, opts) => {
    let ready: () => void = () => {};
    const listening = new Promise<void>((r) => { ready = r; });
    const b: FakeBridge = {
      port: _settings.port,
      closes: 0,
      listenError: false,
      isConnected: () => false,
      requestWithClient: () => Promise.reject(new Error("no plugin in this suite")),
      awaitClient: () => Promise.resolve(),
      connectionInfo: () => CONNECTION,
      listClients: () => [],
      close() { b.closes++; },
      listening,
      savedToken: () => "t",
    };
    made.push(b);
    setTimeout(() => {
      if (!held) { ready(); return; }
      b.listenError = true;
      opts.onListenError?.(new Error(`[bridge] port ${_settings.port} is already in use`));
    }, bindMs);
    return b;
  };
  return { factory, made };
}

interface Served { bridge: DaemonBridge; idleMs: number; shutdowns: number; idleOuts: number[]; activity: DaemonActivity; handle: ServeHandle }

/** The daemon side: `live` makes connect() find a daemon; serve() records what it was given, and its shutdown closes
 *  the served bridge, as daemon.ts does. */
function daemonSide({ live = false, assert = null, serveMs = 0, serveFails = null }: { live?: boolean; assert?: string | null; serveMs?: number; serveFails?: string | null } = {}) {
  const served: Served[] = [];
  let connects = 0;
  const conn: DaemonConnection = {
    sock: "/tmp/fake-daemon.sock",
    request: () => Promise.reject(new Error("unused")),
    requestWithClient: () => Promise.reject(new Error("unused")),
  };
  const side: DaemonSide = {
    async connect() { connects++; return live ? conn : null; },
    status: async () => null,
    async assertNoDaemon() { if (assert) throw new Error(assert); return "/tmp/fake-daemon.sock"; },
    async serve(bridge, o) {
      await sleep(serveMs);
      if (serveFails) throw new Error(serveFails);
      const s: Served = {
        bridge, idleMs: o.idleMs, shutdowns: 0, idleOuts: [],
        activity: { frames: 0, inFlight: 0, lastActivity: Date.now() },
        handle: {
          sock: "/tmp/fake-daemon.sock",
          shutdown() { s.shutdowns++; bridge.close(); },
          activity: () => s.activity,
          idleOut(ms) { s.idleOuts.push(ms); },
        },
      };
      served.push(s);
      return s.handle;
    },
  };
  return { side, served, connects: () => connects, setLive(v: boolean) { live = v; } };
}

function holder(lifetime: Lifetime, b: ReturnType<typeof bridges>, d: ReturnType<typeof daemonSide>, settings: BridgeSettings = SETTINGS) {
  const logs: string[] = [];
  const h = bridgeHolder(lifetime, { settings, createBridge: b.factory, daemon: d.side, log: (m) => logs.push(m) });
  let why: string | null = null;
  void h.released.then((w) => { why = w; });
  return { h, logs, released: () => why };
}
const settled = () => sleep(5);
const errOf = async (p: Promise<unknown>): Promise<string | null> => { try { await p; return null; } catch (e) { return e instanceof Error ? e.message : String(e); } };

// ---------------------------------------------------------------- session (the MCP server)
console.log("\nsession:");
{
  const b = bridges({ bindMs: 20 });
  const d = daemonSide({ serveMs: 10 });
  const { h } = holder("session", b, d);
  const [u1, u2, u3] = await Promise.all([h.upstream(), h.upstream(), h.upstream()]);
  check("concurrent first calls bind ONE bridge and share it", b.made.length === 1 && u1 === u2 && u2 === u3 && u1.kind === "own");
  await settled();
  await sleep(15);
  check("the held bridge is published on the daemon socket with no idle window (the session has its own lifetime)",
    d.served.length === 1 && d.served[0]?.idleMs === 0);
  const h2 = h.held();
  check("held() names the port and the socket", h2.kind === "own" && h2.port === 8787 && h2.sock === "/tmp/fake-daemon.sock");
  check("a later call reuses it without asking the daemon again", (await h.upstream()) === u1 && d.connects() === 1);
}
{
  const b = bridges();
  const d = daemonSide({ live: true });
  const { h } = holder("session", b, d);
  const up = await h.upstream();
  check("a running daemon is preferred: requests go to its socket, no bridge is opened", up.kind === "daemon" && b.made.length === 0);
  check("held() says it routes through the daemon", h.held().kind === "daemon");
  d.setLive(false);
  const again = await h.upstream();
  check("routing through a daemon, every call re-resolves: once it has gone, the session takes the bridge over",
    again.kind === "own" && b.made.length === 1 && d.connects() === 2);
  h.release();
}
{
  const b = bridges({ held: true });
  const d = daemonSide();
  const { h, released } = holder("session", b, d);
  const err = await errOf(h.upstream());
  check("a held port is the call's error, not an exit (the session's process is the user's stdio session)",
    err !== null && err.includes("already in use") && b.made[0]?.closes === 1);
  check("…and it releases nothing: the session lives on", released() === null);
  const err2 = await errOf(h.upstream());
  check("…and the next call tries again (a failure is not remembered)", err2 !== null && b.made.length === 2);
}
{
  const b = bridges();
  const d = daemonSide();
  const { h, logs, released } = holder("session", b, d);
  await h.upstream();
  await settled();
  h.clientLeft("stdin closed");
  await settled();
  check("client left, nobody else used the shared socket → released at once, socket shut, bridge closed",
    released() !== null && d.served[0]?.shutdowns === 1 && b.made[0]?.closes === 1 &&
    logs.some((l) => l.includes("the MCP client went away (stdin closed) and no other dtwin command or session used the shared bridge")));
  check("upstream() after release is refused", (await errOf(h.upstream())) === "the bridge has been released");
}
{
  const b = bridges();
  const d = daemonSide();
  const { h, logs, released } = holder("session", b, d);
  await h.upstream();
  await settled();
  const s = d.served[0];
  if (s) s.activity = { frames: 3, inFlight: 1, lastActivity: Date.now() };
  h.clientLeft("stdin closed");
  await settled();
  check("client left, others used the socket → still serving, idle window switched to the settings' one",
    released() === null && s?.idleOuts.length === 1 && s.idleOuts[0] === SETTINGS.idleMs && s.shutdowns === 0 &&
    logs.some((l) => l.includes("still serving it, shutting down after 1 min without one")));
  h.clientLeft("stdin closed again");
  check("clientLeft counts once", s?.idleOuts.length === 1);
  // The idle shutdown (or `dtwin stop`) closes the served bridge from outside: nothing is left to do but go.
  s?.handle.shutdown();
  await settled();
  check("the shared bridge stopped from outside after the client left → released with that reason",
    released() === "the shared bridge was stopped after the MCP client went away — exiting" && b.made[0]?.closes === 1);
}
{
  const b = bridges();
  const d = daemonSide();
  const { h, released } = holder("session", b, d);
  await h.upstream();
  await settled();
  const s = d.served[0];
  if (s) s.activity = { frames: 2, inFlight: 0, lastActivity: Date.now() - 2 * SETTINGS.idleMs };
  h.clientLeft("stdout closed");
  await settled();
  check("client left, others used it but the window has already passed → released at once",
    released()?.includes("but none in the last 1 min") === true && s?.idleOuts.length === 0 && s.shutdowns === 1);
}
{
  const b = bridges();
  const d = daemonSide();
  const { h, logs } = holder("session", b, d, { ...SETTINGS, idleMs: 0, idleRaw: "0" });
  await h.upstream();
  await settled();
  const s = d.served[0];
  if (s) s.activity = { frames: 1, inFlight: 0, lastActivity: Date.now() };
  h.clientLeft("stdin closed");
  check("idle window off → still serving, and the log says it never stops on its own and why",
    s?.idleOuts[0] === 0 && logs.some((l) => l.includes("never shuts down on its own (FIGMA_DAEMON_IDLE_MIN=0)")));
  h.release();
}
{
  const b = bridges();
  const d = daemonSide();
  const { h, released } = holder("session", b, d);
  await h.upstream();
  await settled();
  // `dtwin stop` while the client is still here: the session forgets the bridge and binds again on the next call.
  d.served[0]?.handle.shutdown();
  await settled();
  check("the shared bridge stopped from outside while the client is here → not released", released() === null && h.held().kind === "none");
  const up = await h.upstream();
  check("…the next call takes the bridge again", up.kind === "own" && b.made.length === 2);
  h.release();
}
{
  const b = bridges({ bindMs: 30 });
  const d = daemonSide();
  const { h, released } = holder("session", b, d);
  const p = h.upstream();
  await sleep(5);
  h.clientLeft("stdin closed");
  const err = await errOf(p);
  check("the client left while the bridge was binding → the call fails, the new bridge is closed, nothing is published",
    err === "the MCP client went away before the bridge was up" && b.made[0]?.closes === 1 && d.served.length === 0 && released() !== null);
}
{
  const b = bridges();
  const d = daemonSide({ serveMs: 30 });
  const { h } = holder("session", b, d);
  await h.upstream();
  h.clientLeft("stdin closed"); // before the socket is up: nothing to share yet
  await sleep(50);
  check("the client left while the socket was binding → released at once, and the late socket is taken down again",
    b.made[0]?.closes === 1 && d.served.length === 1 && d.served[0]?.shutdowns === 1);
}
{
  const b = bridges();
  const d = daemonSide({ serveFails: "the socket is held" });
  const { h, logs, released } = holder("session", b, d);
  const up = await h.upstream();
  await settled();
  check("a socket that cannot be published is logged; the session keeps its own bridge",
    up.kind === "own" && logs.some((l) => l.startsWith("not sharing the bridge with other sessions")) && released() === null);
  h.release();
}
{
  const b = bridges();
  const d = daemonSide();
  const { h, logs, released } = holder("session", b, d);
  await h.upstream();
  await settled();
  h.release("first");
  h.release("second");
  h.clientLeft("late");
  await settled();
  check("release happens exactly once: one reason logged, one shutdown, one close",
    released() === "first" && logs.filter((l) => l === "first" || l === "second").length === 1 &&
    d.served[0]?.shutdowns === 1 && b.made[0]?.closes === 1);
}

// ---------------------------------------------------------------- one-shot (a CLI command)
console.log("\none-shot:");
{
  const b = bridges();
  const d = daemonSide({ live: true });
  const { h } = holder("one-shot", b, d);
  const up = await h.upstream();
  check("a running daemon is used; no bridge is opened", up.kind === "daemon" && b.made.length === 0);
  h.release();
}
{
  const b = bridges();
  const d = daemonSide();
  const { h, released } = holder("one-shot", b, d);
  const [u1, u2] = await Promise.all([h.upstream(), h.upstream()]);
  check("no daemon → one bridge of its own, never published", u1 === u2 && u1.kind === "own" && b.made.length === 1 && d.served.length === 0);
  h.release();
  await settled();
  check("release closes it", b.made[0]?.closes === 1 && released() === "released");
}

// ---------------------------------------------------------------- serve (`dtwin serve`)
console.log("\nserve:");
{
  const b = bridges();
  const d = daemonSide({ assert: "a daemon is already running — dtwin stop" });
  const { h } = holder("serve", b, d);
  const err = await errOf(h.upstream());
  check("a live daemon is refused with its own message, before any bridge is opened", err === "a daemon is already running — dtwin stop" && b.made.length === 0);
}
{
  const b = bridges();
  const d = daemonSide({ assert: NO_DAEMON_TOKEN });
  const { h, released } = holder("serve", b, d);
  const up = await h.upstream();
  check("no saved token yet (nothing can be serving) → it serves, keyed on the bridge's token",
    up.kind === "own" && d.served.length === 1 && d.served[0]?.idleMs === SETTINGS.idleMs);
  d.served[0]?.handle.shutdown();
  await settled();
  check("the daemon shutting down (stop, idle, a signal) releases the holder", released() === "the daemon shut down" && b.made[0]?.closes === 1);
}
{
  const b = bridges();
  const d = daemonSide({ serveFails: "another daemon won the socket" });
  const { h, released } = holder("serve", b, d);
  const err = await errOf(h.upstream());
  await settled();
  check("a socket another daemon won → the call fails and the bridge is closed, without claiming a shutdown",
    err === "another daemon won the socket" && b.made[0]?.closes === 1 && released() === null);
}

report();
