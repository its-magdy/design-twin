// The MCP server's lifecycle (G20: FU-stdin D130, signals D131, R1/R2) and the MCP half of FU-outDir (D132)
// and FU-spill-prev (D133).
//   node test/mcp-lifecycle.test.ts
// Boots the REAL bridge/src/figma-mcp.ts as a subprocess and speaks MCP's stdio JSON-RPC to it by hand
// (an SDK client cannot destroy its own stdout pipe or end stdin without the SIGTERM that follows), with
// a fake plugin on the bridge's WebSocket and raw frames on the daemon socket it serves.
//
// Port rule: NOTHING here binds 8787–8789. The server runs under test/fixtures/no-shared-port.mjs, which
// rewrites its TCP listen to an ephemeral port and prints it (`[no-shared-port] 8789 -> <port>`);
// FIGMA_BRIDGE_PORT=8789 then only names the daemon socket, which lives under a short per-run TMPDIR
// (/tmp/dtl-…: a unix socket path is capped at 104 bytes on macOS, and /var/folders/… is too long).
// HOME is isolated and the token fixed, so nothing is minted into a real config dir.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import WebSocket from "ws";
import type { RawData } from "ws";
import { ok, report } from "./assert.ts";
import * as daemon from "../bridge/src/daemon.ts";
import type { DaemonBridge } from "../bridge/src/daemon.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const MCP = path.join(ROOT, "bridge", "src", "figma-mcp.ts");
const PRELOAD = path.join(import.meta.dirname, "fixtures", "no-shared-port.mjs");
const TOKEN = "lifecycle-test-token";
// Short, and resolved: /tmp is /private/tmp on macOS, and the server's getcwd() is the resolved form.
const BASE = fs.realpathSync.native(fs.mkdtempSync("/tmp/dtl-"));
// The test process's own TMPDIR, for the in-process daemons (sockPath reads os.tmpdir() on every call).
const OWN_TMP = path.join(BASE, "t");
fs.mkdirSync(OWN_TMP);
process.env.TMPDIR = OWN_TMP;
// The socket goes to XDG_RUNTIME_DIR when that is set; unset here (and in every spawned server's env) so
// each process's socket follows its own TMPDIR and the servers below stay apart.
delete process.env.XDG_RUNTIME_DIR;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
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
  p: ChildProcessWithoutNullStreams;
  dir: string;
  cwd: string;
  sock: string;
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
/** Spawn figma-mcp under the no-shared-port preload. `tmp` defaults to a fresh dir of its own. */
function startServer(opts: { env?: Record<string, string>; tmp?: string; cwd?: string } = {}): Server {
  const dir = path.join(BASE, "s" + ++seq);
  const home = path.join(dir, "home");
  const tmp = opts.tmp ?? path.join(dir, "t");
  const cwd = opts.cwd ?? path.join(dir, "cwd");
  for (const d of [home, tmp, cwd]) fs.mkdirSync(d, { recursive: true });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const k of ["FIGMA_DAEMON_IDLE_MIN", "FIGMA_EXPORT_DIR", "FIGMA_BRIDGE_TOKEN_FILE", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "APPDATA"]) delete env[k];
  Object.assign(env, { HOME: home, TMPDIR: tmp, FIGMA_BRIDGE_PORT: "8789", FIGMA_BRIDGE_TOKEN: TOKEN, MAX_MCP_OUTPUT_TOKENS: "" }, opts.env ?? {});
  const p = spawn(process.execPath, ["--import", PRELOAD, MCP], { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
  let err = "";
  let exit: Exit | null = null;
  p.stderr.setEncoding("utf8");
  p.stderr.on("data", (d: string) => { err += d; });
  p.on("exit", (code, signal) => { exit = { code, signal, at: Date.now() }; });
  p.stdin.on("error", () => { /* the server went away first */ });
  p.stdout.on("error", () => { /* destroyed on purpose (LIFE-7) */ });
  const waiting = new Map<number, (v: Record<string, unknown>) => void>();
  let out = "";
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (d: string) => {
    out += d;
    let i;
    while ((i = out.indexOf("\n")) >= 0) {
      const line = out.slice(0, i);
      out = out.slice(i + 1);
      let m: unknown;
      try { m = JSON.parse(line) as unknown; } catch { continue; }
      const r = rec(m);
      if (typeof r.id === "number") {
        const w = waiting.get(r.id);
        waiting.delete(r.id);
        if (w) w(r.error !== undefined ? { rpcError: r.error } : rec(r.result));
      }
    }
  });
  let rpcId = 0;
  const send = (o: object) => { try { p.stdin.write(JSON.stringify(o) + "\n"); } catch { /* closed */ } };
  const rpc = (method: string, params: object, ms = 15000) => new Promise<Record<string, unknown> | null>((resolve) => {
    const id = ++rpcId;
    const t = setTimeout(() => { waiting.delete(id); resolve(null); }, ms);
    waiting.set(id, (v) => { clearTimeout(t); resolve(v); });
    send({ jsonrpc: "2.0", id, method, params });
  });
  const s: Server = {
    p, dir, cwd,
    sock: daemon.sockPath(8789, { env: {}, tmpdir: tmp }),
    err: () => err,
    exit: () => exit,
    wsPort: () => { const m = /\[no-shared-port\] 8789 -> (\d+)/.exec(err); return m ? Number(m[1]) : null; },
    rpc,
    call: async (name, args, ms) => {
      const r = await rpc("tools/call", { name, arguments: args }, ms);
      if (!r) return null;
      const content = r.content;
      const first = Array.isArray(content) ? rec(content[0]) : {};
      const text = typeof first.text === "string" ? first.text : JSON.stringify(r);
      let json: Record<string, unknown> = {};
      try { json = rec(JSON.parse(text) as unknown); } catch { /* an error text */ }
      return { isError: r.isError === true, text, json };
    },
    kill: () => { if (!exit) { try { p.kill("SIGKILL"); } catch { /* gone */ } } },
  };
  servers.push(s);
  return s;
}
/** Up = the stdio transport is connected and (owner) the daemon socket is being served. */
async function up(s: Server, owner = true): Promise<boolean> {
  const done = await until(() => /MCP server up/.test(s.err()) && (!owner || (/daemon listening on/.test(s.err()) && s.wsPort() !== null)), 20000);
  if (!done) console.log("   (server did not come up; stderr:)\n" + s.err().split("\n").map((l) => "   | " + l).join("\n"));
  return done;
}
async function initialize(s: Server): Promise<boolean> {
  const r = await s.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-lifecycle", version: "0.0.0" } });
  s.p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return !!r && isRecord(r.serverInfo);
}

// ---------------------------------------------------------------- a fake plugin
interface Frame { m: Record<string, unknown>; at: number }
interface Plugin { ws: WebSocket; frames: Frame[]; hang: boolean; full: (() => object) | null; close(): void }
const screenReply = () => ({
  screenName: "Sample",
  screen: { exportedAt: "2026-10-01T00:00:00.000Z", screen: "Sample", manifest: { nodes: 1 }, nodes: [{ id: "9:1", name: "Sample", type: "FRAME", box: { x: 0, y: 0, w: 100, h: 100 } }] },
  variables: { collections: [], variables: [], hygiene: [] },
  assets: [],
});
async function fakePlugin(port: number): Promise<Plugin> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${TOKEN}`, { origin: "null" });
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  ws.on("error", () => { /* the server went away */ });
  const pl: Plugin = { ws, frames: [], hang: false, full: null, close: () => { try { ws.terminate(); } catch { /* gone */ } } };
  ws.on("message", (raw: RawData) => {
    let v: unknown;
    try { v = JSON.parse(String(raw)) as unknown; } catch { return; }
    const m = rec(v);
    pl.frames.push({ m, at: Date.now() });
    const id = m.id;
    if (typeof m.cmd !== "string" || typeof id !== "string") return;
    const answer = (result: object) => ws.send(JSON.stringify({ id, ok: true, result }));
    if (m.cmd === "ping") return answer({ pong: true, page: "Page A", file: "Sample File" });
    if (pl.hang) return;
    if (m.cmd === "exportNode" || m.cmd === "exportSelection") return answer(screenReply());
    if (m.cmd === "exportFull" && pl.full) return answer(pl.full());
  });
  ws.send(JSON.stringify({ type: "hello", instanceId: "fig-1", file: "Sample File", page: "Page A" }));
  await sleep(150);
  return pl;
}
const cmdFrames = (pl: Plugin, cmd: string) => pl.frames.filter((f) => f.m.cmd === cmd);
const cancelFor = (pl: Plugin, id: unknown) => pl.frames.find((f) => f.m.type === "cancel" && f.m.id === id);

// A full export (exportFull reply) whose inline JSON is far past the 48k-char cap: one big layer + one small.
function fullReply(): object {
  const stamp = new Date().toISOString();
  const rows = Array.from({ length: 500 }, (_, i) => ({ id: `1:${100 + i}`, name: `Row ${i}`, type: "TEXT", box: { x: 0, y: i * 40, w: 390, h: 40 }, characters: `Row label ${i}` }));
  return {
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
  };
}
const walk = (d: string): string[] => {
  let ents: fs.Dirent[] = [];
  try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return []; }
  return ents.flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
};
const prevsUnder = (d: string) => walk(d).filter((f) => f.endsWith(".prev")).sort();
const read = (f: string): string => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };

// ---------------------------------------------------------------- in-process daemon fakes
function fakeBridge(): { b: DaemonBridge; closes(): number; pending(): number; requests(): number; release(): void } {
  let closes = 0;
  let requests = 0;
  const waiters: Array<() => void> = [];
  const b: DaemonBridge = {
    port: 0, isConnected: () => true, waitForConnection: async () => {},
    request: (cmd) => { requests++; return cmd === "listPages" ? new Promise((r) => { waiters.push(() => r({})); }) : Promise.resolve({}); },
    close: () => { closes++; },
  };
  return { b, closes: () => closes, pending: () => waiters.length, requests: () => requests, release: () => { for (const w of waiters.splice(0)) w(); } };
}

/** One block of checks: a throw (an API missing at an older revision, say) fails that block, not the run. */
async function section(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); } catch (e) { ok(`[${name}] ran without throwing — ${e instanceof Error ? e.message : String(e)}`, false); }
}

void (async () => {
  try {
    // ============================================================ in-process: the serve() handle
    console.log("daemon.serve() handle — activity() and idleOut() (IDLE-1..3):");
    await section("IDLE-1/2", async () => {
      const f = fakeBridge();
      const h = await daemon.serve(f.b, { port: 19793, idleMin: 0, signals: false, crashHandlers: false });
      const before = h.activity().frames;
      const alive = await daemon.probe(h.sock);
      ok("[IDLE-1] activity().frames is 0 before anything used the socket, 1 after one probe", before === 0 && alive && h.activity().frames === 1);
      ok("[IDLE-1] …inFlight 0 and a recent lastActivity", h.activity().inFlight === 0 && Date.now() - h.activity().lastActivity < 2000);
      const st = await sockReq(h.sock, { cmd: "__status" });
      ok("[IDLE-1] idleMin 0 → __status idleMs null (disabled)", rec(st?.result).idleMs === null);
      h.idleOut(300);
      const st2 = rec((await sockReq(h.sock, { cmd: "__status" }))?.result);
      ok("[IDLE-2] idleOut(300) → __status reports idleMs 300", st2.idleMs === 300);
      const t0 = Date.now();
      const shut = await until(() => f.closes() > 0, 2000);
      ok(`[IDLE-2] idleOut(300) on a quiet socket → shut down, bridge closed, socket file gone (${Date.now() - t0} ms)`,
        shut && !fs.existsSync(h.sock) && !(await daemon.probe(h.sock, 500)));
      h.shutdown();
      ok("[IDLE-2] shutdown() is idempotent (bridge closed once)", f.closes() === 1);
    });
    await section("IDLE-2 in flight", async () => {
      const f = fakeBridge();
      const h = await daemon.serve(f.b, { port: 19794, idleMin: 0, signals: false, crashHandlers: false });
      const c = await openRaw(h.sock, { cmd: "listPages", args: {}, timeoutMs: 20000 });
      await until(() => f.pending() === 1, 2000);
      h.idleOut(300);
      await sleep(1000);
      ok("[IDLE-2] a forwarded request in flight holds the idle shutdown off (still live at +1 s)", f.closes() === 0 && h.activity().inFlight === 1 && fs.existsSync(h.sock));
      const tRel = Date.now();
      f.release();
      const shut = await until(() => f.closes() > 0, 2000);
      ok(`[IDLE-2] …and it shuts down within 2 s of the request finishing (${Date.now() - tRel} ms)`, shut && !fs.existsSync(h.sock));
      c.destroy();
    });
    await section("IDLE-3", async () => {
      const f = fakeBridge();
      const h = await daemon.serve(f.b, { port: 19795, idleMin: 0, signals: false, crashHandlers: false });
      await sleep(700);
      const t0 = Date.now();
      h.idleOut(500); // the socket has been quiet 700 ms already: the check at once shuts it, no 500 ms tick
      const shut = await until(() => f.closes() > 0, 100, 5);
      ok(`[IDLE-3] idleOut after the window has already passed → shut down at once, not at the first tick (${Date.now() - t0} ms)`, shut);
      h.shutdown();
    });
    await section("IDLE env", async () => {
      ok("[IDLE] idleMsFromEnv: default 120 min, 0 and an unparsable value disable it, 0.5 → 30 s",
        daemon.idleMsFromEnv({}) === 7200000 && daemon.idleMsFromEnv({ FIGMA_DAEMON_IDLE_MIN: "0" }) === 0 &&
        daemon.idleMsFromEnv({ FIGMA_DAEMON_IDLE_MIN: "soon" }) === 0 && daemon.idleMsFromEnv({ FIGMA_DAEMON_IDLE_MIN: "0.5" }) === 30000);
      ok("[IDLE] one idle formatting helper, daemon.humanMs: 2 h → \"120 min\", 1.2 s → \"1s\"",
        typeof daemon.humanMs === "function" && daemon.humanMs(7200000) === "120 min" && daemon.humanMs(1200) === "1s");
    });
    await section("STOPPED", async () => {
      // [STOPPED] a frame that lands after shutdown() on a connection opened before it is refused, never
      // forwarded to the (closed) bridge.
      const f = fakeBridge();
      const h = await daemon.serve(f.b, { port: 19796, idleMin: 0, signals: false, crashHandlers: false });
      const c = net.createConnection(h.sock);
      c.setEncoding("utf8");
      c.on("error", () => { /* closed under us */ });
      let got = "";
      c.on("data", (d: string) => { got += d; });
      await new Promise<void>((r) => { c.on("connect", () => r()); });
      c.write(JSON.stringify({ cmd: "__ping", id: "p1" }) + "\n");
      await until(() => got.includes("\n"), 2000);
      h.shutdown();
      got = "";
      c.write(JSON.stringify({ cmd: "listPages", args: {}, id: "r2", timeoutMs: 2000 }) + "\n");
      await until(() => got.includes("\n"), 2000);
      let r: Record<string, unknown> = {};
      try { r = rec(JSON.parse(got.split("\n")[0] ?? "") as unknown); } catch { /* no reply */ }
      await sleep(50);
      ok(`[STOPPED] a frame after the daemon shut down is refused (ok:false, "has shut down"), not forwarded to the closed bridge (got ${JSON.stringify(r)}, ${f.requests()} forwarded)`,
        r.ok === false && r.id === "r2" && /has shut down/.test(String(r.error)) && f.requests() === 0);
      c.destroy();
    });

    // ============================================================ the MCP server after its client goes away
    console.log("\nfigma-mcp — after the MCP client goes away (LIFE-1..9):");
    await section("LIFE-1", async () => {
      // [LIFE-1] owner, socket never used → exits at once.
      const s = startServer();
      if (await up(s)) {
        const t0 = Date.now();
        s.p.stdin.end();
        await until(() => s.exit() !== null, 5000);
        const e = s.exit();
        ok(`[LIFE-1] owner, shared socket never used → stdin EOF → exit code 0 within 5 s (${e ? e.at - t0 : "-"} ms)`, !!e && e.code === 0);
        ok("[LIFE-1] …the socket file is gone, and the log says why", !fs.existsSync(s.sock) && /no other dtwin command or session used the shared bridge/.test(s.err()));
      } else ok("[LIFE-1] server came up", false);
    });
    await section("LIFE-2", async () => {
      // [LIFE-2] owner, another process used the socket, FIGMA_DAEMON_IDLE_MIN=1 → keeps serving.
      const s = startServer({ env: { FIGMA_DAEMON_IDLE_MIN: "1" } });
      if (await up(s)) {
        const st0 = await sockReq(s.sock, { cmd: "__status" });
        ok("[LIFE-2] while the client is here, the served socket has no idle window (idleMs null)", rec(st0?.result).idleMs === null);
        s.p.stdin.end();
        await sleep(2000);
        ok("[LIFE-2] socket used by another process → stdin EOF → still alive at +2 s", s.exit() === null);
        const st = rec((await sockReq(s.sock, { cmd: "__status" }))?.result);
        ok(`[LIFE-2] …__status answers with idleMs 60000 (FIGMA_DAEMON_IDLE_MIN=1) (got ${String(st.idleMs)})`, st.idleMs === 60000);
        ok("[LIFE-2] …and stderr says it is still serving, and for how long", /still serving it, shutting down after 1 min without one \(FIGMA_DAEMON_IDLE_MIN\)/.test(s.err()));
        const t0 = Date.now();
        await sockReq(s.sock, { cmd: "__shutdown" });
        await until(() => s.exit() !== null, 5000);
        const e = s.exit();
        ok(`[LIFE-2] …then __shutdown (dtwin stop) → exit code 0 within 5 s (${e ? e.at - t0 : "-"} ms)`, !!e && e.code === 0 && !fs.existsSync(s.sock));
      } else ok("[LIFE-2] server came up", false);
    });
    await section("LIFE-3", async () => {
      // [LIFE-3] as LIFE-2, a 1.2 s window → idles out on its own.
      const s = startServer({ env: { FIGMA_DAEMON_IDLE_MIN: "0.02" } });
      if (await up(s)) {
        await sockReq(s.sock, { cmd: "__ping" });
        const t0 = Date.now();
        s.p.stdin.end();
        await until(() => s.exit() !== null, 6000);
        const e = s.exit();
        ok(`[LIFE-3] FIGMA_DAEMON_IDLE_MIN=0.02 (1.2 s) → idles out and exits 0 within 6 s of stdin EOF (${e ? e.at - t0 : "-"} ms)`, !!e && e.code === 0);
        ok("[LIFE-3] …the socket file is gone, and the log names the idle shutdown", !fs.existsSync(s.sock) && /idle for 1s — shutting down/.test(s.err()));
      } else ok("[LIFE-3] server came up", false);
    });
    await section("LIFE-4", async () => {
      // [LIFE-4] an MCP export in flight when stdin ends → the plugin gets its cancel frame before the exit.
      const s = startServer();
      if (await up(s) && await initialize(s)) {
        const pl = await fakePlugin(s.wsPort() ?? 0);
        pl.hang = true;
        void s.call("figma_export_url", { url: "9:1" });
        await until(() => cmdFrames(pl, "exportNode").length > 0, 5000);
        const sent = cmdFrames(pl, "exportNode")[0]?.m.id;
        s.p.stdin.end();
        await until(() => s.exit() !== null, 5000);
        const e = s.exit();
        const cancel = cancelFor(pl, sent);
        ok("[LIFE-4] an export in flight when stdin ends → exit code 0", !!e && e.code === 0);
        ok("[LIFE-4] …and the plugin received {type:\"cancel\", id} for it BEFORE the process exited",
          typeof sent === "string" && !!cancel && !!e && cancel.at <= e.at);
        pl.close();
      } else ok("[LIFE-4] server came up", false);
    });
    await section("LIFE-5", async () => {
      // [LIFE-5] SIGTERM while owning and serving others — another process's export in flight on the
      // shared socket → exit 0, socket file gone, and the plugin is told to stop THAT export (only the
      // daemon's shutdown sends this one: the request is not this server's own call).
      const s = startServer();
      if (await up(s)) {
        const pl = await fakePlugin(s.wsPort() ?? 0);
        pl.hang = true;
        const other = await openRaw(s.sock, { cmd: "exportNode", args: { nodeId: "9:1" }, timeoutMs: 20000 });
        other.on("error", () => { /* the server went away */ });
        await until(() => cmdFrames(pl, "exportNode").length > 0, 5000);
        const sent = cmdFrames(pl, "exportNode")[0]?.m.id;
        s.p.kill("SIGTERM");
        await until(() => s.exit() !== null, 5000);
        const e = s.exit();
        const cancel = cancelFor(pl, sent);
        ok(`[LIFE-5] SIGTERM while owning → exit code 0, not a signal death (got code ${String(e?.code)}, signal ${String(e?.signal)})`, !!e && e.code === 0 && e.signal === null);
        ok("[LIFE-5] …the socket file is gone, and the log names the signal", !fs.existsSync(s.sock) && /SIGTERM — closing the bridge and exiting/.test(s.err()));
        ok("[LIFE-5] …and the plugin received the cancel frame for the OTHER process's forwarded export before the exit",
          typeof sent === "string" && !!cancel && !!e && cancel.at <= e.at);
        other.destroy();
        pl.close();
      } else ok("[LIFE-5] server came up", false);
    });
    await section("LIFE-5/R2", async () => {
      // [LIFE-5/R2] Claude Code's stop sequence: SIGINT, SIGTERM 100 ms later — with a read in flight.
      const s = startServer();
      if (await up(s) && await initialize(s)) {
        const pl = await fakePlugin(s.wsPort() ?? 0);
        pl.hang = true;
        void s.call("figma_export_url", { url: "9:1" });
        await until(() => cmdFrames(pl, "exportNode").length > 0, 5000);
        const sent = cmdFrames(pl, "exportNode")[0]?.m.id;
        const t0 = Date.now();
        s.p.kill("SIGINT");
        await sleep(100);
        if (s.exit() === null) s.p.kill("SIGTERM");
        await until(() => s.exit() !== null, 3000);
        const e = s.exit();
        const cancel = cancelFor(pl, sent);
        // The child exits on its own ~150 ms timer; < 2000 ms proves that timer (not leave()'s 3 s backstop)
        // ended it without being a load-sensitive bound — "once" and "cancel first" are checked below.
        ok(`[LIFE-5/R2] SIGINT then SIGTERM 100 ms apart → exit code 0 on the signal handler's own timer, not the 3 s backstop (${e ? e.at - t0 : "-"} ms)`,
          !!e && e.code === 0 && e.signal === null && e.at - t0 < 2000);
        ok("[LIFE-5/R2] …the handler ran once (one shutdown line, none for the second signal)",
          (s.err().match(/— closing the bridge and exiting/g) ?? []).length === 1 && /SIGINT — closing the bridge/.test(s.err()));
        ok("[LIFE-5/R2] …and the plugin received the cancel frame for the read in flight before the exit",
          typeof sent === "string" && !!cancel && !!e && cancel.at <= e.at);
        ok("[LIFE-5/R2] …socket file gone", !fs.existsSync(s.sock));
        pl.close();
      } else ok("[LIFE-5/R2] server came up", false);
    });
    await section("LIFE-6", async () => {
      // [LIFE-6] routed through a daemon (not holding the bridge) → exits at once. Passes at HEAD too:
      // a regression guard for the via path.
      const f = fakeBridge();
      const fake = await daemon.serve(f.b, { port: 8789, idleMin: 0, signals: false, crashHandlers: false }); // a socket name only
      const s = startServer({ tmp: OWN_TMP });
      if (await up(s, false)) {
        ok("[LIFE-6] fixture: the server routes through the test's daemon", /Sharing the bridge already running at/.test(s.err()));
        const t0 = Date.now();
        s.p.stdin.end();
        await until(() => s.exit() !== null, 5000);
        const e = s.exit();
        ok(`[LIFE-6] routed via a daemon → stdin EOF → exit code 0 within 5 s (${e ? e.at - t0 : "-"} ms; a regression guard — passes at HEAD)`, !!e && e.code === 0);
        ok("[LIFE-6] …and the daemon it routed through is untouched", f.closes() === 0 && (await daemon.probe(fake.sock)));
      } else ok("[LIFE-6] server came up", false);
      fake.shutdown();
    });
    await section("LIFE-7/R1", async () => {
      // [LIFE-7/R1] the parent is gone for real: its stdout read end destroyed, then stdin ended, with an
      // export in flight. The aborted call's result goes to a dead pipe (EPIPE) — the orphan serving
      // others must survive it.
      const s = startServer();
      if (await up(s) && await initialize(s)) {
        const pl = await fakePlugin(s.wsPort() ?? 0);
        pl.hang = true;
        await sockReq(s.sock, { cmd: "__status" }); // another process uses the shared bridge
        // With a progressToken, so every plugin tick becomes a notifications/progress write to stdout.
        void s.rpc("tools/call", { name: "figma_export_url", arguments: { url: "9:1" }, _meta: { progressToken: "life-7" } });
        await until(() => cmdFrames(pl, "exportNode").length > 0, 5000);
        const reqId = cmdFrames(pl, "exportNode")[0]?.m.id;
        s.p.stdout.destroy();
        // MED-1: the client is killed — both pipes break, but the plugin's progress ticks reach stdout BEFORE
        // stdin's end is seen. The first such write hits EPIPE; with no stdout 'error' listener yet, that
        // was an uncaught exception that killed the orphan.
        let n = 0;
        const ticks = setInterval(() => { for (let k = 0; k < 5; k++) { try { pl.ws.send(JSON.stringify({ type: "progress", requestId: reqId, phase: "walk", nodes: ++n })); } catch { /* gone */ } } }, 5);
        await until(() => s.exit() !== null || /went away \(stdout closed\)/.test(s.err()), 3000);
        await sleep(100);
        clearInterval(ticks);
        ok(`[LIFE-7/R1] progress ticks after stdout is gone (stdin still open; ${n} sent) → alive, and the closed stdout counts as the client going away`,
          s.exit() === null && /the MCP client went away \(stdout closed\); other dtwin commands\/sessions use this shared bridge/.test(s.err()));
        s.p.stdin.end();
        await sleep(2000);
        ok("[LIFE-7/R1] stdout gone + stdin EOF with an export in flight → still alive at +2 s", s.exit() === null);
        ok("[LIFE-7/R1] …no EPIPE / uncaught exception on stderr", !/EPIPE|uncaught exception/i.test(s.err()));
        const st = await sockReq(s.sock, { cmd: "__status" });
        ok("[LIFE-7/R1] …and __status still answers on the shared socket", st !== null && st.ok === true && rec(st.result).daemon === true);
        await sockReq(s.sock, { cmd: "__shutdown" });
        await until(() => s.exit() !== null, 5000);
        ok("[LIFE-7/R1] …and dtwin stop then ends it (exit 0)", s.exit()?.code === 0);
        pl.close();
      } else ok("[LIFE-7/R1] server came up", false);
    });
    await section("LIFE-8", async () => {
      // [LIFE-8] used, but quiet for longer than the window when the client goes → exits at once and says
      // so; it never logs "still serving" first.
      const s = startServer({ env: { FIGMA_DAEMON_IDLE_MIN: "0.01" } }); // 600 ms
      if (await up(s)) {
        await sockReq(s.sock, { cmd: "__ping" });
        await sleep(900);
        const t0 = Date.now();
        s.p.stdin.end();
        await until(() => s.exit() !== null, 5000);
        const e = s.exit();
        ok(`[LIFE-8] socket used, then quiet past the window (0.6 s) → stdin EOF → exit 0 at once (${e ? e.at - t0 : "-"} ms)`, !!e && e.code === 0 && e.at - t0 < 3000);
        ok("[LIFE-8] …the log says why (none in the last 1s), and never says \"still serving\"",
          /used this shared bridge \(1 request\(s\)\), but none in the last 1s \(FIGMA_DAEMON_IDLE_MIN\) — closing it and exiting/.test(s.err()) && !/still serving/.test(s.err()));
      } else ok("[LIFE-8] server came up", false);
    });
    await section("LIFE-9", async () => {
      // [LIFE-9] the idle window is off: FIGMA_DAEMON_IDLE_MIN=0 is named as such; an unparsable value is
      // quoted as what it is, not reported as "=0".
      const runs = await Promise.all(["0", "soon"].map(async (v) => {
        const s = startServer({ env: { FIGMA_DAEMON_IDLE_MIN: v } });
        if (!(await up(s))) return { v, s, ok: false };
        await sockReq(s.sock, { cmd: "__ping" });
        s.p.stdin.end();
        await until(() => /still serving it/.test(s.err()) || s.exit() !== null, 5000);
        await sockReq(s.sock, { cmd: "__shutdown" });
        await until(() => s.exit() !== null, 5000);
        return { v, s, ok: true };
      }));
      const [zero, soon] = runs;
      ok("[LIFE-9] servers came up", !!zero && !!soon && zero.ok && soon.ok);
      if (zero && soon) {
        ok("[LIFE-9] FIGMA_DAEMON_IDLE_MIN=0 → \"never shuts down on its own (FIGMA_DAEMON_IDLE_MIN=0)\"",
          /never shuts down on its own \(FIGMA_DAEMON_IDLE_MIN=0\)/.test(zero.s.err()));
        ok("[LIFE-9] FIGMA_DAEMON_IDLE_MIN=soon → the raw value is quoted as not a number of minutes (not \"=0\")",
          /never shuts down on its own \(FIGMA_DAEMON_IDLE_MIN="soon" is not a number of minutes above 0/.test(soon.s.err()) && !/FIGMA_DAEMON_IDLE_MIN=0\)/.test(soon.s.err()));
      }
    });
    await section("OUT-3", async () => {
      // [OUT-3] `outDir: ""` is not a named outDir: with FIGMA_EXPORT_DIR outside the project, an inline-sized
      // call is not refused before the export (resolveOutDir treats "" as absent too).
      const outside = path.join(BASE, "outside-export");
      const s = startServer({ env: { FIGMA_EXPORT_DIR: outside } });
      if (await up(s) && await initialize(s)) {
        const pl = await fakePlugin(s.wsPort() ?? 0);
        const r = await s.call("figma_export_url", { url: "9:1", outDir: "" });
        ok(`[OUT-3] outDir "" + FIGMA_EXPORT_DIR outside the cwd → the inline result, plugin asked once (got ${r ? (r.isError ? "an error: " + r.text.slice(0, 160) : "an inline result") : "no answer"})`,
          !!r && !r.isError && rec(r.json.screen).screen === "Sample" && cmdFrames(pl, "exportNode").length === 1 && !fs.existsSync(outside));
        pl.close();
      } else ok("[OUT-3] server came up", false);
      s.p.stdin.end();
    });

    // ============================================================ outDir pre-check, .prev on a full spill
    console.log("\nfigma-mcp — outDir checked before the export (OUT-1/2), .prev on a full spill (SPILL-1):");
    await section("OUT/SPILL", async () => {
      const s = startServer();
      if (await up(s) && await initialize(s)) {
        const pl = await fakePlugin(s.wsPort() ?? 0);
        const asks = () => cmdFrames(pl, "exportNode").length;
        const n0 = asks();
        const esc = await s.call("figma_export_url", { url: "9:1", writeToDisk: true, outDir: "../escape" });
        ok("[OUT-1] writeToDisk:true + outDir '../escape' → isError naming outDir", !!esc && esc.isError && /outDir must stay inside/.test(esc.text) && esc.text.includes("../escape"));
        ok("[OUT-1] …and the plugin was never asked (no exportNode frame)", asks() === n0);
        const esc2 = await s.call("figma_export_url", { url: "9:1", outDir: "../escape" });
        ok("[OUT-1] writeToDisk omitted + an explicit bad outDir → refused before the export too", !!esc2 && esc2.isError && /outDir must stay inside/.test(esc2.text) && asks() === n0);
        const escShot = await s.call("figma_screenshot", { nodeId: "9:1", writeToDisk: true, outDir: "../escape" });
        const escFull = await s.call("figma_export_full", { writeToDisk: true, outDir: "/" });
        const escDs = await s.call("figma_export_design_system", { outDir: "../escape" });
        const escSel = await s.call("figma_export_selection", { writeToDisk: true, outDir: "../escape" });
        ok("[OUT-1] …the same for figma_screenshot / figma_export_full / figma_export_design_system / figma_export_selection (no frame sent)",
          [escShot, escFull, escDs, escSel].every((r) => !!r && r.isError && /outDir must stay inside/.test(r.text)) &&
          pl.frames.filter((f) => typeof f.m.cmd === "string" && f.m.cmd !== "ping").length === n0);
        const inline = await s.call("figma_export_url", { url: "9:1", writeToDisk: false, outDir: "../escape" });
        ok("[OUT-1] writeToDisk:false + a bad outDir → the inline result (nothing is written, so nothing is refused)",
          !!inline && !inline.isError && rec(inline.json.screen).screen === "Sample" && asks() === n0 + 1);

        // [OUT-2] the server's cwd reached through a symlink.
        const alias = path.join(s.dir, "alias");
        fs.symlinkSync(s.cwd, alias, "dir");
        const viaAlias = await s.call("figma_export_url", { url: "9:1", writeToDisk: true, outDir: path.join(alias, "d") });
        ok("[OUT-2] outDir = <alias of the cwd>/d with writeToDisk:true → written under the cwd (inside after realpath)",
          !!viaAlias && !viaAlias.isError && walk(path.join(s.cwd, "d")).some((f) => f.endsWith(".json")));
        if (viaAlias && viaAlias.isError) console.log("   (OUT-2 got: " + viaAlias.text.slice(0, 300) + ")");

        // [SPILL-1] an implicit full spill over a hand-edited layer file keeps <layer>.json.prev.
        pl.full = fullReply;
        const first = await s.call("figma_export_full", { writeToDisk: true });
        const out = typeof first?.json.outDir === "string" ? first.json.outDir : path.join(s.cwd, "design", "export");
        const layer = walk(path.join(out, "pages")).find((f) => f.endsWith(".json") && !f.endsWith("index.json") && read(f).includes("\"Panel\""));
        ok("[SPILL-1] fixture: an explicit export wrote the layer files, and kept nothing", !!first && !first.isError && !!layer && prevsUnder(out).length === 0);
        if (!first || first.isError || !layer) console.log("   (SPILL-1 explicit export got: " + (first ? first.text.slice(0, 400) : "no answer") + "; files: " + walk(out).map((f) => path.relative(out, f)).join(", ") + ")");
        if (layer) {
          const edited = '{"hand":"edited layer"}';
          fs.writeFileSync(layer, edited);
          const spill = await s.call("figma_export_full", {});
          const note = String(spill?.json.note ?? "");
          const kept = rec(spill?.json.wrote).prevKept;
          if (spill && !/WITHOUT being asked/.test(note)) console.log("   (SPILL-1 got: " + (spill.text.slice(0, 400)) + ")");
          ok("[SPILL-1] fixture: the reply is past the inline cap, so it spilled implicitly", /WITHOUT being asked/.test(note));
          ok("[SPILL-1] the replaced layer file is kept as <layer>.json.prev with the hand-edited text", read(layer + ".prev") === edited && prevsUnder(out).length === 1);
          ok(`[SPILL-1] …wrote.prevKept lists it (got ${JSON.stringify(kept)})`, Array.isArray(kept) && kept.length === 1 && kept[0] === layer + ".prev");
          ok("[SPILL-1] …and the note names the count and the .prev", /previous version of each changed file — 1 file\(s\) under pages\/ or design-system\/ \(or design-system\.json\), e\.g\. /.test(note) && note.includes(layer + ".prev") && /\.prev \(one level/.test(note));
          const lw = rec(rec((await s.call("figma_status", {}))?.json).lastWrite);
          ok(`[SPILL-1] figma_status.lastWrite.prevKept === 1 (implicit) (got ${JSON.stringify(lw)})`, lw.prevKept === 1 && lw.implicit === true && lw.tool === "figma_export_full");
          const again = await s.call("figma_export_full", {});
          const note2 = String(again?.json.note ?? "");
          ok("[SPILL-1] a re-spill of the unchanged design keeps no new .prev, the earlier one is untouched",
            prevsUnder(out).length === 1 && read(layer + ".prev") === edited && rec(again?.json.wrote).prevKept === undefined);
          ok("[SPILL-1] …and the note says the earlier versions are still kept", /Earlier versions are still kept as 1 \.prev file\(s\)/.test(note2));
          fs.rmSync(layer + ".prev");
          fs.writeFileSync(layer, edited);
          const explicit = await s.call("figma_export_full", { writeToDisk: true });
          ok("[SPILL-1] an explicit writeToDisk:true over a hand-edited file keeps nothing (D80)",
            !!explicit && !explicit.isError && prevsUnder(out).length === 0 && rec(explicit.json.wrote).prevKept === undefined && !/\.prev/.test(String(explicit.json.note)));
        }
        pl.close();
      } else ok("[OUT/SPILL] server came up", false);
      s.p.stdin.end();
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
