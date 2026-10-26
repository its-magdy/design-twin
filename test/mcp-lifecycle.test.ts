// The MCP server as a real process: two smoke tests of its lifecycle (stdin EOF with an export in flight; stdout gone while
// serving another process, then SIGTERM — the rules are test/client-presence.test.ts's and test/bridge-holder.test.ts's,
// in process), the serve() handle over a real socket, and the MCP half of the outDir pre-check and the .prev kept on a full spill.
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
    // Two smoke tests of the real process. Which event decides that the client has gone, the abort every call carries
    // and the exit timing are test/client-presence.test.ts's (in process, fake streams and signals); whether the process
    // then exits or serves other sessions on and idles out is test/bridge-holder.test.ts's (clientLeft). What only the
    // process shows is the wiring: the transport's stdin ending reaches the holder, the plugin gets its cancel frame,
    // and the process exits 0 with the socket gone.
    await section("stdin EOF with an export in flight", async () => {
      const s = startServer();
      if (await up(s) && await initialize(s)) {
        const pl = await fakePlugin(s.wsPort() ?? 0, s.token);
        pl.hang = true;
        void s.call("figma_export_url", { url: "9:1" });
        await until(() => cmdFrames(pl, "exportNode").length > 0, 5000);
        const sent = cmdFrames(pl, "exportNode")[0]?.id;
        const t0 = Date.now();
        s.p.stdin?.end();
        await until(() => s.exit() !== null, 5000);
        const e = s.exit();
        const cancel = cancelFor(pl, sent);
        ok(`an export in flight when stdin ends → exit code 0 within 5 s (${e ? e.at - t0 : "-"} ms)`, !!e && e.code === 0);
        ok("…and the plugin received {type:\"cancel\", id} for it BEFORE the process exited",
          typeof sent === "string" && !!cancel && !!e && cancel.at <= e.at);
        // A pipe (Windows) has no file to be gone: there the log alone says it.
        ok("…the socket file is gone, and the log says why",
          (process.platform === "win32" || !fs.existsSync(s.sock)) && /the MCP client went away \(stdin closed\) and no other dtwin command or session used the shared bridge/.test(s.err()));
        pl.close();
      } else ok("server came up", false);
    });
    // The other half only the process shows (POSIX: on Windows child.kill ends the process outright, and the raw socket
    // frames are POSIX's): Bun reports a write to a closed stdout as an 'error' event, which the presence catches — the
    // process serving another session survives it — and SIGTERM runs the handler instead of the default death: exit 0,
    // a cancel frame for the other process's forwarded export before it, the socket file gone.
    await daemonSection("stdout gone while serving another process, then SIGTERM", async () => {
      const s = startServer();
      if (await up(s) && await initialize(s)) {
        const pl = await fakePlugin(s.wsPort() ?? 0, s.token);
        pl.hang = true;
        // Another process's export, forwarded through the shared socket and left in flight: the socket is in use.
        const other = await openRaw(s.sock, { cmd: "exportNode", args: { nodeId: "9:2" }, timeoutMs: 20000 });
        other.on("error", () => { /* the server went away */ });
        // This session's own export, with a progressToken: every plugin tick becomes a notifications/progress write.
        void s.rpc("tools/call", { name: "figma_export_url", arguments: { url: "9:1" }, _meta: { progressToken: "life-7" } });
        await until(() => cmdFrames(pl, "exportNode").length >= 2, 5000);
        const frames = cmdFrames(pl, "exportNode");
        const forwarded = frames.find((f) => JSON.stringify(f.args).includes("9:2"))?.id;
        const own = frames.find((f) => JSON.stringify(f.args).includes("9:1"))?.id;
        // The client is killed: its read end of our stdout closes, and the ticks reach stdout before stdin's end.
        s.p.stdout?.destroy();
        let n = 0;
        const ticks = setInterval(() => { for (let k = 0; k < 5; k++) { try { pl.fake.progress({ ...(own !== undefined ? { requestId: own } : {}), phase: "walk", nodes: ++n }); } catch { /* gone */ } } }, 5);
        await until(() => s.exit() !== null || /went away \(stdout closed\)/.test(s.err()), 3000);
        await sleep(100);
        clearInterval(ticks);
        ok(`progress ticks after stdout is gone (${n} sent) → alive, the closed stdout is the client going away, and no EPIPE / uncaught exception`,
          s.exit() === null && /the MCP client went away \(stdout closed\); other dtwin commands\/sessions use this shared bridge/.test(s.err()) &&
          !/EPIPE|uncaught exception/i.test(s.err()));
        s.p.kill("SIGTERM");
        await until(() => s.exit() !== null, 5000);
        const e = s.exit();
        const cancel = cancelFor(pl, forwarded);
        ok(`…then SIGTERM → exit code 0, not a signal death (got code ${String(e?.code)}, signal ${String(e?.signal)})`, !!e && e.code === 0 && e.signal === null);
        ok("…the plugin received the cancel frame for the OTHER process's forwarded export before the exit",
          typeof forwarded === "string" && !!cancel && !!e && cancel.at <= e.at);
        ok("…the socket file is gone, and the log names the signal", !fs.existsSync(s.sock) && /SIGTERM — closing the bridge and exiting/.test(s.err()));
        other.destroy();
        pl.close();
      } else ok("server came up", false);
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
