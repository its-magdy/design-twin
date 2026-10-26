// The MCP server's lifecycle (stdin EOF, signals) and the MCP half of the outDir pre-check
// and the .prev kept on a full spill.
//   bun test/mcp-lifecycle.test.ts
// Boots the REAL bridge/src/figma-mcp.ts as a subprocess and speaks MCP's stdio JSON-RPC to it by hand
// (an SDK client cannot destroy its own stdout pipe or end stdin without the SIGTERM that follows), with
// a fake plugin on the bridge's WebSocket and raw frames on the daemon socket it serves.
//
// Port rule: NOTHING here binds 8787–8789. The server runs with server-core's test seam
// DT_TEST_EPHEMERAL_PORT=1, which binds the bridge on an ephemeral port and prints it
// (`[bridge] DT_TEST_EPHEMERAL_PORT: 8789 -> <port>`); FIGMA_BRIDGE_PORT=8789 then only names the daemon
// socket, which lives under a short per-run TMPDIR
// (/tmp/dtl-…: a unix socket path is capped at 104 bytes on macOS, and /var/folders/… is too long; Windows
// has no /tmp, and its daemon is a named pipe, so there BASE is under os.tmpdir()).
// HOME (USERPROFILE, APPDATA on Windows) is isolated and the token fixed, so nothing is minted into a real
// config dir. On Windows each server gets a token of its own instead: the pipe is named from the token, not
// TMPDIR, so that is what keeps the servers apart there. The blocks that drive the socket with raw
// (unauthenticated) frames and check its FILE are POSIX's (daemonSection); the pipe and its handshake are
// daemon-sock.test.ts's.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { startMcp } from "./children.ts";
import { fakePlugin as dialPlugin, HANG, type FakePlugin } from "./fake-plugin.ts";
import { ok, report } from "./assert.ts";
import * as daemon from "../bridge/src/daemon.ts";
import { thisHost } from "../bridge/src/settings.ts";
import { addressAt } from "./bridge-settings.ts";
import { fakeClock } from "./fake-clock.ts";
import type { DaemonBridge } from "../bridge/src/daemon.ts";
import type { Cmd, Commands, FullExportReply, ScreenReply } from "../bridge/src/commands.ts";
import type { Sent } from "../bridge/src/route.ts";
import { malformed } from "./fixtures.ts";
import { setTimeout as sleep } from "node:timers/promises";

const TOKEN = "lifecycle-test-token";
// Short, and resolved: /tmp is /private/tmp on macOS, and the server's getcwd() is the resolved form.
const BASE = fs.realpathSync.native(fs.mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "dtl-")));
// The test process's own TMPDIR, for the in-process daemons (sockPath reads os.tmpdir() on every call).
const OWN_TMP = path.join(BASE, "t");
fs.mkdirSync(OWN_TMP);
process.env.TMPDIR = OWN_TMP;
// The socket goes to XDG_RUNTIME_DIR when that is set; unset here (and in every spawned server's env) so
// each process's socket follows its own TMPDIR and the servers below stay apart.
delete process.env.XDG_RUNTIME_DIR;

async function until(cond: () => boolean, ms: number, step = 25): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(step); }
  return cond();
}
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const rec = (x: unknown): Record<string, unknown> => (isRecord(x) ? x : {});

// ---------------------------------------------------------------- the daemon socket, raw
/** One request/reply over a daemon socket (newline-delimited JSON). Resolves null on no answer. */
function sockReq(sock: string, frame: object, ms = 3000): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let buf = "";
    let done = false;
    const finish = (v: Record<string, unknown> | null) => { if (!done) { done = true; clearTimeout(t); try { c.destroy(); } catch { /* gone */ } resolve(v); } };
    const c = net.createConnection(sock);
    const t = setTimeout(() => finish(null), ms);
    c.setEncoding("utf8");
    c.on("error", () => finish(null));
    c.on("close", () => finish(null));
    c.on("connect", () => c.write(JSON.stringify(frame) + "\n"));
    c.on("data", (d: string) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i < 0) return;
      try { finish(rec(JSON.parse(buf.slice(0, i)) as unknown)); } catch { finish(null); }
    });
  });
}
/** A raw socket that sends one frame and stays open (a forwarded request in flight). */
function openRaw(sock: string, frame: object): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(sock);
    c.on("error", reject);
    c.on("connect", () => { c.write(JSON.stringify(frame) + "\n"); resolve(c); });
  });
}

// ---------------------------------------------------------------- the server under test
interface Exit { code: number | null; signal: NodeJS.Signals | null; at: number }
interface Server {
  p: ChildProcess;
  dir: string;
  cwd: string;
  sock: string;
  /** The bridge token it runs with (its own on Windows, see startServer). */
  token: string;
  err(): string;
  exit(): Exit | null;
  wsPort(): number | null;
  /** A JSON-RPC request; resolves with its `result` (or `{ rpcError }`), null after `ms`. */
  rpc(method: string, params: object, ms?: number): Promise<Record<string, unknown> | null>;
  call(name: string, args: object, ms?: number): Promise<{ isError: boolean; text: string; json: Record<string, unknown> } | null>;
  kill(): void;
}
let seq = 0;
const servers: Server[] = [];
/** Spawn figma-mcp with its bridge on an ephemeral port (DT_TEST_EPHEMERAL_PORT). `tmp` defaults to a fresh dir of its own. */
function startServer(opts: { env?: Record<string, string>; tmp?: string; cwd?: string } = {}): Server {
  const dir = path.join(BASE, "s" + ++seq);
  const home = path.join(dir, "home");
  const tmp = opts.tmp ?? path.join(dir, "t");
  const cwd = opts.cwd ?? path.join(dir, "cwd");
  for (const d of [home, tmp, cwd]) fs.mkdirSync(d, { recursive: true });
  const env: Record<string, string> = {};
  // Windows: a token per server, so each one's pipe (named from the token) is its own — as TMPDIR does on POSIX.
  const token = process.platform === "win32" ? `${TOKEN}-${seq}` : TOKEN;
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const k of ["FIGMA_DAEMON_IDLE_MIN", "FIGMA_EXPORT_DIR", "FIGMA_BRIDGE_TOKEN_FILE", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR"]) delete env[k];
  // The home and temp directory under each name a platform reads them by: HOME / TMPDIR (POSIX), and
  // USERPROFILE (os.homedir), TEMP / TMP (os.tmpdir), APPDATA (token-store's config dir) on Windows.
  Object.assign(env, {
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"), TMPDIR: tmp, TEMP: tmp, TMP: tmp,
    FIGMA_BRIDGE_PORT: "8789", FIGMA_BRIDGE_TOKEN: token, MAX_MCP_OUTPUT_TOKENS: "", DT_TEST_EPHEMERAL_PORT: "1",
  }, opts.env ?? {});
  // test/children.ts startMcp: its stdout/stderr accumulated, its exit recorded, a JSON-RPC client on top
  const m = startMcp({ env, cwd });
  const p = m.child;
  p.stdout?.on("error", () => { /* destroyed on purpose */ });
  const s: Server = {
    p, dir, cwd,
    sock: daemon.sockPath(daemon.daemonAddress({ ...thisHost(), port: 8789, token, tmpdir: tmp })),
    token,
    err: m.stderr,
    exit: m.exit,
    wsPort: () => { const w = /\[bridge\] DT_TEST_EPHEMERAL_PORT: 8789 -> (\d+)/.exec(m.stderr()); return w ? Number(w[1]) : null; },
    rpc: m.rpc,
    call: m.call,
    kill: () => { m.kill("SIGKILL"); },
  };
  servers.push(s);
  return s;
}
/** Up = the stdio transport is connected and (owner) the bridge is bound and the daemon socket is being served. */
const SERVED = /daemon listening on/;
async function up(s: Server, owner = true): Promise<boolean> {
  const done = await until(() => /MCP server up/.test(s.err()) && (!owner || (SERVED.test(s.err()) && s.wsPort() !== null)), 20000);
  if (!done) console.log("   (server did not come up; stderr:)\n" + s.err().split("\n").map((l) => "   | " + l).join("\n"));
  return done;
}
async function initialize(s: Server): Promise<boolean> {
  const r = await s.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-lifecycle", version: "0.0.0" } });
  s.p.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return !!r && isRecord(r.serverInfo);
}

// ---------------------------------------------------------------- a fake plugin
// `hang` and `full` are read by the handlers on every command, so a section flips them mid-run.
interface Plugin { fake: FakePlugin; hang: boolean; full: (() => FullExportReply) | null; close(): void }
// not a full ScreenReply on purpose: its screen manifest carries only `nodes`
const screenReply = (): ScreenReply => malformed<ScreenReply>({
  screenName: "Sample",
  screen: { exportedAt: "2026-10-01T00:00:00.000Z", screen: "Sample", manifest: { nodes: 1 }, nodes: [{ id: "9:1", name: "Sample", type: "FRAME", box: { x: 0, y: 0, w: 100, h: 100 } }] },
  variables: { collections: [], variables: [], hygiene: [] },
  assets: [],
});
async function fakePlugin(port: number, token = TOKEN): Promise<Plugin> {
  const pl: Plugin = {
    fake: dialPlugin(port, {
      token, hello: { instanceId: "fig-1", file: "Sample File", page: "Page A" }, unhandled: HANG,
      on: {
        ping: () => ({ pong: true, page: "Page A", file: "Sample File" }),
        exportNode: () => (pl.hang ? HANG : screenReply()),
        exportSelection: () => (pl.hang ? HANG : screenReply()),
        exportFull: () => (pl.hang || !pl.full ? HANG : pl.full()),
      },
    }),
    hang: false, full: null,
    close: () => { try { pl.fake.terminate(); } catch { /* gone */ } },
  };
  await pl.fake.opened;
  await sleep(150);
  return pl;
}
const cmdFrames = (pl: Plugin, cmd: Cmd) => pl.fake.commands(cmd);
const cancelFor = (pl: Plugin, id: unknown) => pl.fake.frames.find((f) => "type" in f.frame && f.frame.type === "cancel" && f.frame.id === id);

// A full export (exportFull reply) whose inline JSON is far past the 48k-char cap: one big layer + one small.
function fullReply(): FullExportReply {
  const stamp = new Date().toISOString();
  // not a full FullExportReply on purpose: a hand-written design system (collections/variables in a looser shape)
  const rows = Array.from({ length: 500 }, (_, i) => ({ id: `1:${100 + i}`, name: `Row ${i}`, type: "TEXT", box: { x: 0, y: i * 40, w: 390, h: 40 }, characters: `Row label ${i}` }));
  return malformed<FullExportReply>({
    designSystem: {
      file: "Sample File", exportedAt: stamp, colorProfile: "srgb",
      collections: [{ id: "c:1", name: "Core", modes: ["Light"] }],
      variables: [{ id: "v:1", name: "color/bg", type: "COLOR", collection: "Core", values: { Light: "#ffffff" } }],
      styles: { paint: [{ name: "Brand" }], text: [], effect: [], grid: [] },
      components: [{ key: "k1", name: "Widget", type: "COMPONENT", id: "2:1", page: "Page A", pageId: "1:0" }],
      hygiene: [],
    },
    layersDoc: {
      exportedAt: stamp,
      index: [{ id: "1:2", name: "Panel", type: "FRAME", pageId: "1:0", page: "Page A" }, { id: "1:5", name: "Sheet", type: "FRAME", pageId: "1:0", page: "Page A" }],
      layers: [
        { id: "1:2", name: "Panel", page: "Page A", pageId: "1:0", tree: { id: "1:2", name: "Panel", type: "FRAME", box: { x: 0, y: 0, w: 390, h: 20000 }, children: rows } },
        { id: "1:5", name: "Sheet", page: "Page A", pageId: "1:0", tree: { id: "1:5", name: "Sheet", type: "FRAME", box: { x: 0, y: 0, w: 390, h: 844 } } },
      ],
    },
    assets: [],
  });
}
const walk = (d: string): string[] => {
  let ents: fs.Dirent[] = [];
  try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return []; }
  return ents.flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
};
const prevsUnder = (d: string) => walk(d).filter((f) => f.endsWith(".prev")).sort();
const read = (f: string): string => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };

// ---------------------------------------------------------------- in-process daemon fakes
function fakeBridge(): { b: DaemonBridge; closes(): number } {
  let closes = 0;
  const b: DaemonBridge = {
    port: 0, isConnected: () => true,
    request: <C extends Cmd>() => { const sent: Sent<C> = { reply: malformed<Commands[C]["reply"]>({}), client: null }; return Promise.resolve(sent); },
    close: () => { closes++; },
  };
  return { b, closes: () => closes };
}

/** One block of checks: a throw (an API missing at an older revision, say) fails that block, not the run. */
async function section(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); } catch (e) { ok(`[${name}] ran without throwing — ${e instanceof Error ? e.message : String(e)}`, false); }
}
/** A block that drives the daemon socket with raw frames and checks its file (served, used by another
 *  process, or idled out): POSIX's. On Windows the pipe requires the handshake before any frame and has no
 *  file — driven end to end in daemon-sock.test.ts instead. */
async function daemonSection(name: string, fn: () => Promise<void>): Promise<void> {
  if (process.platform === "win32") { console.log(`  (skipped on Windows: ${name} — raw unauthenticated frames and a socket file are POSIX's; the pipe is daemon-sock.test.ts's)`); return; }
  return section(name, fn);
}

void (async () => {
  try {
    // ============================================================ in-process: the serve() handle
    // The idle decision, the in-flight hold, idleOut's check-at-once and a frame after shutdown are the served
    // session's rules (test/served-session.test.ts, on a fake clock). What is left here is the socket's half: frames
    // off the real socket are counted, idleOut reaches __status, and the session's idle shutdown releases the socket —
    // stepped on the daemon's injected fake clock, so no wait depends on load.
    console.log("daemon.serve() handle — activity() and idleOut() over the socket:");
    await daemonSection("idle shutdown on a quiet socket", async () => {
      const f = fakeBridge();
      const clock = fakeClock();
      const h = await daemon.serve(f.b, addressAt(19793), { idleMs: 0, signals: false, crashHandlers: false, clock });
      const before = h.activity().frames;
      const alive = await daemon.probe(h.sock);
      ok("activity().frames is 0 before anything used the socket, 1 after one probe, nothing in flight", before === 0 && alive && h.activity().frames === 1 && h.activity().inFlight === 0);
      const st = await sockReq(h.sock, { cmd: "__status" });
      ok("idleMs 0 → __status idleMs null (disabled)", rec(st?.result).idleMs === null);
      h.idleOut(300);
      const st2 = rec((await sockReq(h.sock, { cmd: "__status" }))?.result);
      ok("idleOut(300) → __status reports idleMs 300", st2.idleMs === 300);
      clock.advance(300);
      ok("the window passing on a quiet socket → shut down: bridge closed, socket file gone, nothing answers",
        f.closes() === 1 && !fs.existsSync(h.sock) && !(await daemon.probe(h.sock, 500)));
      h.shutdown();
      ok("shutdown() is idempotent (bridge closed once)", f.closes() === 1);
    });

    // ============================================================ the MCP server after its client goes away
    console.log("\nfigma-mcp — after the MCP client goes away:");
    await section("stdin EOF, owner, socket never used", async () => {
      // owner, socket never used → exits at once.
      const s = startServer();
      if (await up(s)) {
        const t0 = Date.now();
        s.p.stdin?.end();
        await until(() => s.exit() !== null, 5000);
        const e = s.exit();
        ok(`owner, shared socket never used → stdin EOF → exit code 0 within 5 s (${e ? e.at - t0 : "-"} ms)`, !!e && e.code === 0);
        // A pipe (Windows) has no file to be gone: there the log alone says it.
        ok("…the socket file is gone, and the log says why",
          (process.platform === "win32" || !fs.existsSync(s.sock)) && /no other dtwin command or session used the shared bridge/.test(s.err()));
      } else ok("server came up", false);
    });
    await daemonSection("stdin EOF, socket used by another process", async () => {
      // owner, another process used the socket, FIGMA_DAEMON_IDLE_MIN=1 → keeps serving.
      const s = startServer({ env: { FIGMA_DAEMON_IDLE_MIN: "1" } });
      if (await up(s)) {
        const st0 = await sockReq(s.sock, { cmd: "__status" });
        ok("while the client is here, the served socket has no idle window (idleMs null)", rec(st0?.result).idleMs === null);
        s.p.stdin?.end();
        await sleep(2000);
        ok("socket used by another process → stdin EOF → still alive at +2 s", s.exit() === null);
        const st = rec((await sockReq(s.sock, { cmd: "__status" }))?.result);
        ok(`…__status answers with idleMs 60000 (FIGMA_DAEMON_IDLE_MIN=1) (got ${String(st.idleMs)})`, st.idleMs === 60000);
        ok("…and stderr says it is still serving, and for how long", /still serving it, shutting down after 1 min without one \(FIGMA_DAEMON_IDLE_MIN\)/.test(s.err()));
        const t0 = Date.now();
        await sockReq(s.sock, { cmd: "__shutdown" });
        await until(() => s.exit() !== null, 5000);
        const e = s.exit();
        ok(`…then __shutdown (dtwin stop) → exit code 0 within 5 s (${e ? e.at - t0 : "-"} ms)`, !!e && e.code === 0 && !fs.existsSync(s.sock));
      } else ok("server came up", false);
    });
    await daemonSection("stdin EOF, short idle window idles out", async () => {
      // as above, a 1.2 s window → idles out on its own.
      const s = startServer({ env: { FIGMA_DAEMON_IDLE_MIN: "0.02" } });
      if (await up(s)) {
        await sockReq(s.sock, { cmd: "__ping" });
        const t0 = Date.now();
        s.p.stdin?.end();
        await until(() => s.exit() !== null, 6000);
        const e = s.exit();
        ok(`FIGMA_DAEMON_IDLE_MIN=0.02 (1.2 s) → idles out and exits 0 within 6 s of stdin EOF (${e ? e.at - t0 : "-"} ms)`, !!e && e.code === 0);
        ok("…the socket file is gone, and the log names the idle shutdown", !fs.existsSync(s.sock) && /idle for 1s — shutting down/.test(s.err()));
      } else ok("server came up", false);
    });
    await section("stdin EOF with an export in flight", async () => {
      // an MCP export in flight when stdin ends → the plugin gets its cancel frame before the exit.
      const s = startServer();
      if (await up(s) && await initialize(s)) {
        const pl = await fakePlugin(s.wsPort() ?? 0, s.token);
        pl.hang = true;
        void s.call("figma_export_url", { url: "9:1" });
        await until(() => cmdFrames(pl, "exportNode").length > 0, 5000);
        const sent = cmdFrames(pl, "exportNode")[0]?.id;
        s.p.stdin?.end();
        await until(() => s.exit() !== null, 5000);
        const e = s.exit();
        const cancel = cancelFor(pl, sent);
        ok("an export in flight when stdin ends → exit code 0", !!e && e.code === 0);
        ok("…and the plugin received {type:\"cancel\", id} for it BEFORE the process exited",
          typeof sent === "string" && !!cancel && !!e && cancel.at <= e.at);
        pl.close();
      } else ok("server came up", false);
    });
    await daemonSection("SIGTERM while serving another process", async () => {
      // SIGTERM while owning and serving others — another process's export in flight on the
      // shared socket → exit 0, socket file gone, and the plugin is told to stop THAT export (only the
      // daemon's shutdown sends this one: the request is not this server's own call).
      const s = startServer();
      if (await up(s)) {
        const pl = await fakePlugin(s.wsPort() ?? 0, s.token);
        pl.hang = true;
        const other = await openRaw(s.sock, { cmd: "exportNode", args: { nodeId: "9:1" }, timeoutMs: 20000 });
        other.on("error", () => { /* the server went away */ });
        await until(() => cmdFrames(pl, "exportNode").length > 0, 5000);
        const sent = cmdFrames(pl, "exportNode")[0]?.id;
        s.p.kill("SIGTERM");
        await until(() => s.exit() !== null, 5000);
        const e = s.exit();
        const cancel = cancelFor(pl, sent);
        ok(`SIGTERM while owning → exit code 0, not a signal death (got code ${String(e?.code)}, signal ${String(e?.signal)})`, !!e && e.code === 0 && e.signal === null);
        ok("…the socket file is gone, and the log names the signal", !fs.existsSync(s.sock) && /SIGTERM — closing the bridge and exiting/.test(s.err()));
        ok("…and the plugin received the cancel frame for the OTHER process's forwarded export before the exit",
          typeof sent === "string" && !!cancel && !!e && cancel.at <= e.at);
        other.destroy();
        pl.close();
      } else ok("server came up", false);
    });
    // Windows: child.kill("SIGINT" | "SIGTERM") ends the process outright (Node: "the process will always be
    // killed forcefully and abruptly"), so no handler of its own runs to be checked.
    if (process.platform === "win32") console.log("  (skipped: SIGINT then SIGTERM stop sequence — on Windows a signal sent with child.kill terminates the process outright, so its handler cannot run)");
    else await section("SIGINT then SIGTERM stop sequence", async () => {
      // Claude Code's stop sequence: SIGINT, SIGTERM 100 ms later — with a read in flight.
      const s = startServer();
      if (await up(s) && await initialize(s)) {
        const pl = await fakePlugin(s.wsPort() ?? 0, s.token);
        pl.hang = true;
        void s.call("figma_export_url", { url: "9:1" });
        await until(() => cmdFrames(pl, "exportNode").length > 0, 5000);
        const sent = cmdFrames(pl, "exportNode")[0]?.id;
        const t0 = Date.now();
        s.p.kill("SIGINT");
        await sleep(100);
        if (s.exit() === null) s.p.kill("SIGTERM");
        await until(() => s.exit() !== null, 3000);
        const e = s.exit();
        const cancel = cancelFor(pl, sent);
        // The child exits on its own ~150 ms timer; < 2000 ms proves that timer (not leave()'s 3 s backstop)
        // ended it without being a load-sensitive bound — "once" and "cancel first" are checked below.
        ok(`SIGINT then SIGTERM 100 ms apart → exit code 0 on the signal handler's own timer, not the 3 s backstop (${e ? e.at - t0 : "-"} ms)`,
          !!e && e.code === 0 && e.signal === null && e.at - t0 < 2000);
        ok("…the handler ran once (one shutdown line, none for the second signal)",
          (s.err().match(/— closing the bridge and exiting/g) ?? []).length === 1 && /SIGINT — closing the bridge/.test(s.err()));
        ok("…and the plugin received the cancel frame for the read in flight before the exit",
          typeof sent === "string" && !!cancel && !!e && cancel.at <= e.at);
        ok("…socket file gone", !fs.existsSync(s.sock));
        pl.close();
      } else ok("server came up", false);
    });
    await daemonSection("stdin EOF, routed through a daemon", async () => {
      // routed through a daemon (not holding the bridge) → exits at once (the via path).
      const f = fakeBridge();
      const fake = await daemon.serve(f.b, addressAt(8789), { idleMs: 0, signals: false, crashHandlers: false }); // a socket name only
      const s = startServer({ tmp: OWN_TMP });
      if (await up(s, false)) {
        ok("fixture: the server routes through the test's daemon", /Sharing the bridge already running at/.test(s.err()));
        const t0 = Date.now();
        s.p.stdin?.end();
        await until(() => s.exit() !== null, 5000);
        const e = s.exit();
        ok(`routed via a daemon → stdin EOF → exit code 0 within 5 s (${e ? e.at - t0 : "-"} ms)`, !!e && e.code === 0);
        ok("…and the daemon it routed through is untouched", f.closes() === 0 && (await daemon.probe(fake.sock)));
      } else ok("server came up", false);
      fake.shutdown();
    });
    await daemonSection("stdout gone, then stdin EOF", async () => {
      // the parent is gone for real: its stdout read end destroyed, then stdin ended, with an
      // export in flight. The aborted call's result goes to a dead pipe (EPIPE) — the orphan serving
      // others must survive it.
      const s = startServer();
      if (await up(s) && await initialize(s)) {
        const pl = await fakePlugin(s.wsPort() ?? 0, s.token);
        pl.hang = true;
        await sockReq(s.sock, { cmd: "__status" }); // another process uses the shared bridge
        // With a progressToken, so every plugin tick becomes a notifications/progress write to stdout.
        void s.rpc("tools/call", { name: "figma_export_url", arguments: { url: "9:1" }, _meta: { progressToken: "life-7" } });
        await until(() => cmdFrames(pl, "exportNode").length > 0, 5000);
        const reqId = cmdFrames(pl, "exportNode")[0]?.id;
        s.p.stdout?.destroy();
        // the client is killed — both pipes break, but the plugin's progress ticks reach stdout BEFORE
        // stdin's end is seen. The first such write hits EPIPE; with no stdout 'error' listener yet, that
        // would be an uncaught exception that kills the orphan.
        let n = 0;
        const ticks = setInterval(() => { for (let k = 0; k < 5; k++) { try { pl.fake.progress({ ...(reqId !== undefined ? { requestId: reqId } : {}), phase: "walk", nodes: ++n }); } catch { /* gone */ } } }, 5);
        await until(() => s.exit() !== null || /went away \(stdout closed\)/.test(s.err()), 3000);
        await sleep(100);
        clearInterval(ticks);
        ok(`progress ticks after stdout is gone (stdin still open; ${n} sent) → alive, and the closed stdout counts as the client going away`,
          s.exit() === null && /the MCP client went away \(stdout closed\); other dtwin commands\/sessions use this shared bridge/.test(s.err()));
        s.p.stdin?.end();
        await sleep(2000);
        ok("stdout gone + stdin EOF with an export in flight → still alive at +2 s", s.exit() === null);
        ok("…no EPIPE / uncaught exception on stderr", !/EPIPE|uncaught exception/i.test(s.err()));
        const st = await sockReq(s.sock, { cmd: "__status" });
        ok("…and __status still answers on the shared socket", st !== null && st.ok === true && rec(st.result).daemon === true);
        await sockReq(s.sock, { cmd: "__shutdown" });
        await until(() => s.exit() !== null, 5000);
        ok("…and dtwin stop then ends it (exit 0)", s.exit()?.code === 0);
        pl.close();
      } else ok("server came up", false);
    });
    await daemonSection("stdin EOF after a quiet socket", async () => {
      // used, but quiet for longer than the window when the client goes → exits at once and says
      // so; it never logs "still serving" first.
      const s = startServer({ env: { FIGMA_DAEMON_IDLE_MIN: "0.01" } }); // 600 ms
      if (await up(s)) {
        await sockReq(s.sock, { cmd: "__ping" });
        await sleep(900);
        const t0 = Date.now();
        s.p.stdin?.end();
        await until(() => s.exit() !== null, 5000);
        const e = s.exit();
        ok(`socket used, then quiet past the window (0.6 s) → stdin EOF → exit 0 at once (${e ? e.at - t0 : "-"} ms)`, !!e && e.code === 0 && e.at - t0 < 3000);
        ok("…the log says why (none in the last 1s), and never says \"still serving\"",
          /used this shared bridge \(1 request\(s\)\), but none in the last 1s \(FIGMA_DAEMON_IDLE_MIN\) — closing it and exiting/.test(s.err()) && !/still serving/.test(s.err()));
      } else ok("server came up", false);
    });
    await daemonSection("idle window off or unparsable", async () => {
      // the idle window is off: FIGMA_DAEMON_IDLE_MIN=0 is named as such; an unparsable value is
      // quoted as what it is, not reported as "=0".
      const runs = await Promise.all(["0", "soon"].map(async (v) => {
        const s = startServer({ env: { FIGMA_DAEMON_IDLE_MIN: v } });
        if (!(await up(s))) return { v, s, ok: false };
        await sockReq(s.sock, { cmd: "__ping" });
        s.p.stdin?.end();
        await until(() => /still serving it/.test(s.err()) || s.exit() !== null, 5000);
        await sockReq(s.sock, { cmd: "__shutdown" });
        await until(() => s.exit() !== null, 5000);
        return { v, s, ok: true };
      }));
      const [zero, soon] = runs;
      ok("servers came up", !!zero && !!soon && zero.ok && soon.ok);
      if (zero && soon) {
        ok("FIGMA_DAEMON_IDLE_MIN=0 → \"never shuts down on its own (FIGMA_DAEMON_IDLE_MIN=0)\"",
          /never shuts down on its own \(FIGMA_DAEMON_IDLE_MIN=0\)/.test(zero.s.err()));
        ok("FIGMA_DAEMON_IDLE_MIN=soon → the raw value is quoted as not a number of minutes (not \"=0\")",
          /never shuts down on its own \(FIGMA_DAEMON_IDLE_MIN="soon" is not a number of minutes above 0/.test(soon.s.err()) && !/FIGMA_DAEMON_IDLE_MIN=0\)/.test(soon.s.err()));
      }
    });
    await section("empty outDir with FIGMA_EXPORT_DIR outside the project", async () => {
      // `outDir: ""` is not a named outDir: with FIGMA_EXPORT_DIR outside the project, an inline-sized
      // call is not refused before the export (resolveOutDir treats "" as absent too).
      const outside = path.join(BASE, "outside-export");
      const s = startServer({ env: { FIGMA_EXPORT_DIR: outside } });
      if (await up(s) && await initialize(s)) {
        const pl = await fakePlugin(s.wsPort() ?? 0, s.token);
        const r = await s.call("figma_export_url", { url: "9:1", outDir: "" });
        ok(`outDir "" + FIGMA_EXPORT_DIR outside the cwd → the inline result, plugin asked once (got ${r ? (r.isError ? "an error: " + r.text.slice(0, 160) : "an inline result") : "no answer"})`,
          !!r && !r.isError && rec(r.json.screen).screen === "Sample" && cmdFrames(pl, "exportNode").length === 1 && !fs.existsSync(outside));
        pl.close();
      } else ok("server came up", false);
      s.p.stdin?.end();
    });

    // ============================================================ outDir pre-check, .prev on a full spill
    console.log("\nfigma-mcp — outDir checked before the export, .prev on a full spill:");
    await section("outDir pre-check and .prev on a full spill", async () => {
      const s = startServer();
      if (await up(s) && await initialize(s)) {
        const pl = await fakePlugin(s.wsPort() ?? 0, s.token);
        const asks = () => cmdFrames(pl, "exportNode").length;
        const n0 = asks();
        const esc = await s.call("figma_export_url", { url: "9:1", writeToDisk: true, outDir: "../escape" });
        ok("writeToDisk:true + outDir '../escape' → isError naming outDir", !!esc && esc.isError && /outDir must stay inside/.test(esc.text) && esc.text.includes("../escape"));
        ok("…and the plugin was never asked (no exportNode frame)", asks() === n0);
        const esc2 = await s.call("figma_export_url", { url: "9:1", outDir: "../escape" });
        ok("writeToDisk omitted + an explicit bad outDir → refused before the export too", !!esc2 && esc2.isError && /outDir must stay inside/.test(esc2.text) && asks() === n0);
        const escShot = await s.call("figma_screenshot", { nodeId: "9:1", writeToDisk: true, outDir: "../escape" });
        const escFull = await s.call("figma_export_full", { writeToDisk: true, outDir: "/" });
        const escDs = await s.call("figma_export_design_system", { outDir: "../escape" });
        const escSel = await s.call("figma_export_selection", { writeToDisk: true, outDir: "../escape" });
        ok("…the same for figma_screenshot / figma_export_full / figma_export_design_system / figma_export_selection (no frame sent)",
          [escShot, escFull, escDs, escSel].every((r) => !!r && r.isError && /outDir must stay inside/.test(r.text)) &&
          pl.fake.commands().filter((c) => c.cmd !== "ping").length === n0);
        const inline = await s.call("figma_export_url", { url: "9:1", writeToDisk: false, outDir: "../escape" });
        ok("writeToDisk:false + a bad outDir → the inline result (nothing is written, so nothing is refused)",
          !!inline && !inline.isError && rec(inline.json.screen).screen === "Sample" && asks() === n0 + 1);

        // the server's cwd reached through a symlink.
        const alias = path.join(s.dir, "alias");
        fs.symlinkSync(s.cwd, alias, "dir");
        const viaAlias = await s.call("figma_export_url", { url: "9:1", writeToDisk: true, outDir: path.join(alias, "d") });
        ok("outDir = <alias of the cwd>/d with writeToDisk:true → written under the cwd (inside after realpath)",
          !!viaAlias && !viaAlias.isError && walk(path.join(s.cwd, "d")).some((f) => f.endsWith(".json")));
        if (viaAlias && viaAlias.isError) console.log("   (alias outDir got: " + viaAlias.text.slice(0, 300) + ")");

        // an implicit full spill over a hand-edited layer file keeps <layer>.json.prev.
        pl.full = fullReply;
        const first = await s.call("figma_export_full", { writeToDisk: true });
        const out = typeof first?.json.outDir === "string" ? first.json.outDir : path.join(s.cwd, "design", "export");
        const layer = walk(path.join(out, "pages")).find((f) => f.endsWith(".json") && !f.endsWith("index.json") && read(f).includes("\"Panel\""));
        ok("fixture: an explicit export wrote the layer files, and kept nothing", !!first && !first.isError && !!layer && prevsUnder(out).length === 0);
        if (!first || first.isError || !layer) console.log("   (explicit export got: " + (first ? first.text.slice(0, 400) : "no answer") + "; files: " + walk(out).map((f) => path.relative(out, f)).join(", ") + ")");
        if (layer) {
          const edited = '{"hand":"edited layer"}';
          fs.writeFileSync(layer, edited);
          const spill = await s.call("figma_export_full", {});
          const note = String(spill?.json.note ?? "");
          const kept = rec(spill?.json.wrote).prevKept;
          if (spill && !/WITHOUT being asked/.test(note)) console.log("   (implicit spill got: " + (spill.text.slice(0, 400)) + ")");
          ok("fixture: the reply is past the inline cap, so it spilled implicitly", /WITHOUT being asked/.test(note));
          ok("the replaced layer file is kept as <layer>.json.prev with the hand-edited text", read(layer + ".prev") === edited && prevsUnder(out).length === 1);
          ok(`…wrote.prevKept lists it (got ${JSON.stringify(kept)})`, Array.isArray(kept) && kept.length === 1 && kept[0] === layer + ".prev");
          ok("…and the note names the count and the .prev", /previous version of each changed file — 1 file\(s\) under pages\/ or design-system\/ \(or design-system\.json\), e\.g\. /.test(note) && note.includes(layer + ".prev") && /\.prev \(one level/.test(note));
          // Both layer files (Panel, Sheet) were on disk from the explicit export, so the spill replaced 2 — changed or not.
          ok(`…and says it replaced the 2 existing layer files (got ${JSON.stringify(note.slice(0, 200))})`, /^Written to disk WITHOUT being asked: .*It replaced 2 existing screen file\(s\) under .*pages\. The previous version of each changed file/.test(note));
          const lw = rec(rec((await s.call("figma_status", {}))?.json).lastWrite);
          ok(`figma_status.lastWrite.prevKept === 1 (implicit) (got ${JSON.stringify(lw)})`, lw.prevKept === 1 && lw.implicit === true && lw.tool === "figma_export_full");
          const again = await s.call("figma_export_full", {});
          const note2 = String(again?.json.note ?? "");
          ok("a re-spill of the unchanged design keeps no new .prev, the earlier one is untouched",
            prevsUnder(out).length === 1 && read(layer + ".prev") === edited && rec(again?.json.wrote).prevKept === undefined);
          ok("…and the note says the earlier versions are still kept", /Earlier versions are still kept as 1 \.prev file\(s\)/.test(note2));
          ok("…after saying it replaced the 2 layer files again", /It replaced 2 existing screen file\(s\) under .*pages\. Earlier versions are still kept as 1 \.prev file\(s\)/.test(note2));
          fs.rmSync(layer + ".prev");
          fs.writeFileSync(layer, edited);
          const explicit = await s.call("figma_export_full", { writeToDisk: true });
          ok("an explicit writeToDisk:true over a hand-edited file keeps nothing",
            !!explicit && !explicit.isError && prevsUnder(out).length === 0 && rec(explicit.json.wrote).prevKept === undefined && !/\.prev/.test(String(explicit.json.note)));
        }
        pl.close();
      } else ok("server came up", false);
      s.p.stdin?.end();
    });
  } catch (e) {
    ok("mcp-lifecycle run completed without throwing — " + (e instanceof Error ? e.stack ?? e.message : String(e)), false);
  } finally {
    for (const s of servers) s.kill();
    await sleep(100);
    fs.rmSync(BASE, { recursive: true, force: true });
  }
  report();
})();
