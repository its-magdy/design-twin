// The CLI against a FAKE plugin (timing line, screenshot size, whoami addressing).
//   node test/cli-pull.test.ts
// The real `dtwin` process is spawned (it opens its own bridge on FIGMA_BRIDGE_PORT=8789, like a user's
// direct pull with no daemon running); the plugin side is a plain `ws` client that dials in, says hello and
// answers each command — the same shape bridge.test.ts fakes. Port 8789 is this suite's alone (bridge.test.ts
// binds above it), so the chain runs it after bridge.test.ts, never beside it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import type { RawData } from "ws";
import { check, report } from "./assert.ts";
import { manifest, screenReply } from "./fixtures.ts";
import { formatDone } from "../bridge/src/figma-pull.ts";
import { DAEMON_UNSUPPORTED, daemonSupported } from "../bridge/src/daemon.ts";
import type { Asset } from "../bridge/src/doc-types.ts";

const PORT = 8789;
const TOKEN = "cli-pull-test-token";
const CLI = path.join(import.meta.dirname, "..", "bridge", "src", "figma-pull.ts");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the fake plugin

type Handler = (args: unknown, emit: (frame: Record<string, unknown>) => void) => unknown;
interface FakePlugin { opened: Promise<void>; stop(): void }

/** Dials the bridge (retrying until it listens — the CLI is still starting), announces itself, answers commands. */
function fakePlugin(hello: { instanceId: string; file: string; fileKey: string }, handlers: Record<string, Handler>, opts: { startAfterMs?: number } = {}): FakePlugin {
  let stopped = false;
  let ws: WebSocket | null = null;
  let resolveOpened: () => void = () => {};
  const opened = new Promise<void>((r) => { resolveOpened = r; });
  const dial = () => {
    if (stopped) return;
    const c = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${TOKEN}`, { origin: "null" });
    ws = c;
    c.on("error", () => { /* not listening yet — the close handler redials */ });
    c.on("open", () => { c.send(JSON.stringify({ type: "hello", ...hello, page: "Home", pluginVersion: "0.0.0" })); resolveOpened(); });
    c.on("message", (b: RawData) => {
      const m = JSON.parse(b.toString()) as { id?: string; cmd?: string; args?: unknown };
      if (!m.id || !m.cmd) return;
      const h = handlers[m.cmd];
      if (!h) { c.send(JSON.stringify({ id: m.id, ok: false, error: `fake plugin has no ${m.cmd}` })); return; }
      c.send(JSON.stringify({ id: m.id, ok: true, result: h(m.args, (f) => c.send(JSON.stringify(f))) }));
    });
    c.on("close", () => { if (!stopped) setTimeout(dial, 100); });
  };
  setTimeout(dial, opts.startAfterMs ?? 0);
  return { opened, stop: () => { stopped = true; if (ws) ws.terminate(); } };
}

// ---------------------------------------------------------------- the CLI

interface Ran { code: number | null; stdout: string; stderr: string }
function dtwin(cwd: string, args: string[]): Promise<Ran> {
  return new Promise((resolve) => {
    const env: Record<string, string | undefined> = { ...process.env, FIGMA_BRIDGE_TOKEN: TOKEN, FIGMA_BRIDGE_PORT: String(PORT) };
    delete env.FIGMA_BRIDGE_TOKEN_FILE;
    delete env.DTWIN_PORT;
    const p = spawn(process.execPath, [CLI, ...args], { cwd, env });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    p.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    const kill = setTimeout(() => p.kill("SIGKILL"), 40000);
    p.on("close", (code) => { clearTimeout(kill); resolve({ code, stdout, stderr }); });
  });
}
const json = (s: string): Record<string, unknown> | null => { try { const v: unknown = JSON.parse(s); return v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v)) : null; } catch { return null; } };

// A 4x3 PNG header (signature + IHDR) — all pngSize reads. Only the size matters to the CLI.
const png = (() => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write("IHDR", 12, "latin1"); b.writeUInt32BE(4, 16); b.writeUInt32BE(3, 20);
  return b.toString("base64");
})();
const refAsset: Asset = { id: "1:2", name: "Sample Frame", format: "png", file: "1_2_ref.png", base64: png, kind: "reference" };
const shotReply = (extra: Record<string, unknown>) => ({ id: "1:2", name: "Sample Frame", type: "FRAME", reference: "assets/1_2_ref.png", manifest: manifest(), assets: [refAsset], ...extra });
const nodeReply = () => screenReply({ screenName: "Sample Frame", nodeId: "1:2", page: "Home", pageId: "0:1", screen: { screen: "Sample Frame", exportedAt: "2026-10-01T00:00:00.000Z", nodes: [{ type: "FRAME", id: "1:2", name: "Sample Frame", box: { w: 10, h: 10, x: 0, y: 0 } }] } });
const whoamiReply = (instanceId: string, file: string, fileKey: string) => ({ instanceId, startedAt: 1, uptimeMs: 5000, file, page: "Home", pageId: "0:1", editorType: "figma", pluginVersion: "0.0.0", fileKey, fileKeyAvailable: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-pull-"));
try {
  // a direct pull ends with where the time went.
  console.log("\ncli pull — the `done in …` timing line:");
  {
    const dir = path.join(tmp, "time");
    fs.mkdirSync(dir);
    const plugin = fakePlugin({ instanceId: "fig-a", file: "Sample App", fileKey: "KEYA" }, { exportNode: () => nodeReply() }, { startAfterMs: 400 });
    const r = await dtwin(dir, ["pull", "out", "--node", "1:2", "--timeout", "30"]);
    plugin.stop();
    check("the pull succeeds against the fake plugin and writes the screen", r.code === 0 && fs.existsSync(path.join(dir, "out", "pages", "index.json")));
    const m = /\[dtwin\] done in (\d+\.\d)s — waited (\d+\.\d)s for the plugin to connect · export (\d+\.\d)s · write (\d+\.\d)s/.exec(r.stderr);
    check("stderr has `done in … waited … for the plugin to connect · export … · write …`", m !== null);
    check("the connect wait is real (the plugin dialled in ~0.4 s late) and total >= connect", m !== null && Number(m[2]) >= 0.3 && Number(m[1]) >= Number(m[2]));
    check("a short wait does not print the reconnect hint", !/plugin reconnecting/.test(r.stderr));
    check("the bare `done.` line is gone", !/\[dtwin\] done\.\s*$/m.test(r.stderr));
  }
  // a `queued` frame (the plugin's run waits behind another in that file) is said once; `start` never is.
  console.log("\ncli pull — queued behind another run:");
  {
    const dir = path.join(tmp, "queued");
    fs.mkdirSync(dir);
    const plugin = fakePlugin({ instanceId: "fig-a", file: "Sample App", fileKey: "KEYA" }, {
      exportNode: (_a, emit) => {
        emit({ type: "progress", phase: "queued", source: "bridge", label: "exportNode" });
        emit({ type: "progress", phase: "queued", source: "bridge", label: "exportNode" });
        emit({ type: "progress", phase: "start" });
        return nodeReply();
      },
    });
    const r = await dtwin(dir, ["pull", "out", "--node", "1:2", "--timeout", "30"]);
    plugin.stop();
    const said = r.stderr.split("\n").filter((l) => /queued behind another export in that file/.test(l));
    check("the pull still succeeds", r.code === 0);
    check("stderr has the queued line exactly once (two frames sent)", said.length === 1 && /^\[dtwin\] queued behind another export in that file — waiting \(up to --timeout\)/.test(said[0] ?? ""));
    const dir2 = path.join(tmp, "started");
    fs.mkdirSync(dir2);
    const p2 = fakePlugin({ instanceId: "fig-a", file: "Sample App", fileKey: "KEYA" }, { exportNode: (_a, emit) => { emit({ type: "progress", phase: "start" }); return nodeReply(); } });
    const r2 = await dtwin(dir2, ["pull", "out", "--node", "1:2", "--timeout", "30"]);
    p2.stop();
    check("a `start` frame alone prints no queued line", r2.code === 0 && !/queued/.test(r2.stderr));
  }
  // The pure formatter: the daemon variant, and the hint at >= 5 s of connect wait.
  {
    const slow = { totalMs: 27200, connectMs: 24100, exportMs: 2800, writeMs: 300, viaDaemon: false };
    const own = formatDone(slow, "darwin");
    check("formatDone: a 24 s connect wait prints the line and the reconnect hint naming `dtwin serve`",
      own[0] === "done in 27.2s — waited 24.1s for the plugin to connect · export 2.8s · write 0.3s" && own.length === 2 && /reconnecting/.test(own[1] ?? "") && /dtwin serve/.test(own[1] ?? ""));
    const ownWin = formatDone(slow, "win32");
    check("formatDone on Windows: the same line and hint, without `dtwin serve` (no daemon there)",
      ownWin[0] === own[0] && ownWin.length === 2 && /reconnecting/.test(ownWin[1] ?? "") && !/dtwin serve/.test(ownWin[1] ?? ""));
    check("formatDone: 4.9 s of wait → no hint; 5.0 s → hint",
      formatDone({ totalMs: 6000, connectMs: 4900, exportMs: 1000, writeMs: 0, viaDaemon: false }).length === 1 && formatDone({ totalMs: 6000, connectMs: 5000, exportMs: 1000, writeMs: 0, viaDaemon: false }).length === 2);
    const via = formatDone({ totalMs: 3100, connectMs: 0, exportMs: 2800, writeMs: 300, viaDaemon: true });
    check("formatDone: via the daemon there is no connect-wait claim and no hint", via.length === 1 && /via the running daemon/.test(via[0] ?? "") && !/waited/.test(via[0] ?? "") && /2\.8s · write 0\.3s/.test(via[0] ?? ""));
    // the daemon waits for its plugin inside the request, so "no reconnect" can be false.
    check("formatDone: via the daemon, no '(no reconnect)' claim; the export figure says it includes any plugin wait",
      via[0] === "done in 3.1s — via the running daemon · export (incl. any wait for the plugin) 2.8s · write 0.3s");
  }

  // the screenshot JSON carries the node size, the scale and the PNG's own size.
  console.log("\ncli pull — screenshot size:");
  {
    const dir = path.join(tmp, "shot");
    fs.mkdirSync(dir);
    const plugin = fakePlugin({ instanceId: "fig-a", file: "Sample App", fileKey: "KEYA" }, { screenshot: () => shotReply({ w: 1440, h: 1236, scale: 1.4222 }) });
    const r = await dtwin(dir, ["screenshot", "1:2", "shots", "--timeout", "30"]);
    plugin.stop();
    const j = json(r.stdout);
    check("the command succeeds and writes the PNG", r.code === 0 && fs.existsSync(path.join(dir, "shots", "assets", "1_2_ref.png")));
    check("stdout JSON has w, h, scale from the plugin", !!j && j.w === 1440 && j.h === 1236 && j.scale === 1.4222);
    check("…and png:{w:4,h:3} read from the bytes", !!j && JSON.stringify(j.png) === JSON.stringify({ w: 4, h: 3 }));
    check("…plus the existing id/name/type/reference", !!j && j.id === "1:2" && j.name === "Sample Frame" && j.type === "FRAME" && j.reference === "assets/1_2_ref.png");
    check("the screenshot run also ends with the timing line", /\[dtwin\] done in \d+\.\ds — waited/.test(r.stderr));
  }
  {
    // An older plugin sends no w/h/scale: the keys are omitted (never null), png still comes from the bytes.
    const dir = path.join(tmp, "shot-old");
    fs.mkdirSync(dir);
    const plugin = fakePlugin({ instanceId: "fig-a", file: "Sample App", fileKey: "KEYA" }, { screenshot: () => shotReply({}) });
    const r = await dtwin(dir, ["screenshot", "1:2", "shots", "--timeout", "30"]);
    plugin.stop();
    const j = json(r.stdout);
    check("an older plugin (no w/h/scale): those keys are absent, png is still there", !!j && !("w" in j) && !("h" in j) && !("scale" in j) && JSON.stringify(j.png) === JSON.stringify({ w: 4, h: 3 }));
  }

  // whoami describes the ADDRESSED file's socket.
  console.log("\ncli pull — whoami addresses the right connection:");
  {
    const dir = path.join(tmp, "who");
    fs.mkdirSync(dir);
    // The CLI is started first (the plugins dial IT). A dials first so it is c1; B dials only once A is
    // connected, so it is c2. The CLI is already waiting for a file named "Bravo" by then.
    const ran = dtwin(dir, ["whoami", "--client", "Bravo", "--timeout", "30"]);
    const a = fakePlugin({ instanceId: "fig-a", file: "App Alpha", fileKey: "KEYA" }, { whoami: () => whoamiReply("fig-a", "App Alpha", "KEYA") });
    await a.opened;
    const b = fakePlugin({ instanceId: "fig-b", file: "App Bravo", fileKey: "KEYB" }, { whoami: () => whoamiReply("fig-b", "App Bravo", "KEYB") });
    const r = await ran;
    a.stop(); b.stop();
    const j = json(r.stdout);
    const conn = j && j.connection && typeof j.connection === "object" ? Object.fromEntries(Object.entries(j.connection)) : null;
    const plug = j && j.plugin && typeof j.plugin === "object" ? Object.fromEntries(Object.entries(j.plugin)) : null;
    check("the command succeeds and addresses the second file's plugin", r.code === 0 && !!plug && plug.instanceId === "fig-b");
    check("`--client <c2's name>` → connection.connId is c2, not the first client's c1", !!conn && conn.connId === "c2");
    check("the socket line on stderr names c2", /\[dtwin\] socket c2 up /.test(r.stderr));
  }
  // The same through a running daemon (`dtwin serve`): the connection comes from the daemon's status, narrowed
  // to the addressed file by connectionFor; the timing line says it went via the daemon.
  // A second command while a one-shot command holds the port (no daemon to route through) exits 1 with
  // the port-in-use text — on Windows the one that says sharing is not supported there.
  console.log("\ncli pull — the port held by another one-shot command:");
  {
    const dir = path.join(tmp, "held");
    fs.mkdirSync(dir);
    const env: Record<string, string | undefined> = { ...process.env, FIGMA_BRIDGE_TOKEN: TOKEN, FIGMA_BRIDGE_PORT: String(PORT) };
    delete env.FIGMA_BRIDGE_TOKEN_FILE;
    delete env.DTWIN_PORT;
    const holder = spawn(process.execPath, [CLI, "whoami", "--timeout", "30"], { cwd: dir, env });
    const closed = new Promise((r) => holder.once("close", r));
    let held = "";
    holder.stderr.on("data", (d: Buffer) => { held += d.toString(); });
    try {
      let bound = false;
      for (let i = 0; i < 100 && !bound; i++) { await sleep(100); bound = /listening on ws:\/\/localhost:8789/.test(held); }
      check("fixture: a one-shot whoami (no plugin yet) holds 8789", bound);
      const r = await dtwin(dir, ["whoami", "--timeout", "5"]);
      const text = daemonSupported()
        ? /\[bridge\] port 8789 is already in use — another dtwin bridge or MCP server is running\. Stop it first, or set FIGMA_BRIDGE_PORT/
        : /\[bridge\] port 8789 is already in use — another MCP session or dtwin command holds the bridge, and sharing it between sessions is not supported on Windows \(yet\)\. Close the other one first, or set FIGMA_BRIDGE_PORT/;
      check(daemonSupported()
        ? "a second command exits 1 with the port-in-use text"
        : "a second command exits 1 with the port-in-use text: another session or command holds the bridge, sharing is not supported on Windows, close it",
      r.code === 1 && text.test(r.stderr));
    } finally {
      holder.kill("SIGKILL");
      await closed;
    }
  }

  console.log("\ncli pull — through a daemon:");
  if (!daemonSupported()) {
    console.log("  (skipped: the daemon is not supported on Windows — `dtwin serve` refuses, so there is none to route through; the refusals are checked instead)");
    const dir = path.join(tmp, "daemon");
    fs.mkdirSync(dir);
    const lines = (s: string) => s.split("\n").filter((l) => l.trim() && !/ExperimentalWarning|--trace-warnings/.test(l)).join("\n");
    const serve = await dtwin(dir, ["serve"]);
    check("on Windows `dtwin serve` exits 1 with one line, the reason (no stack)", serve.code === 1 && lines(serve.stderr) === "[dtwin] error: " + DAEMON_UNSUPPORTED);
    const stop = await dtwin(dir, ["stop"]);
    check("…and so does `dtwin stop`", stop.code === 1 && lines(stop.stderr) === "[dtwin] error: " + DAEMON_UNSUPPORTED);
    const st = await dtwin(dir, ["status"]);
    check("…while `dtwin status` reports no daemon, with the reason (exit 0)",
      st.code === 0 && /"daemon": false/.test(st.stdout) && lines(st.stderr) === "[dtwin] no daemon is running: " + DAEMON_UNSUPPORTED);
  } else {
    const dir = path.join(tmp, "daemon");
    fs.mkdirSync(dir);
    const env: Record<string, string | undefined> = { ...process.env, FIGMA_BRIDGE_TOKEN: TOKEN, FIGMA_BRIDGE_PORT: String(PORT) };
    delete env.DTWIN_PORT;
    const serve = spawn(process.execPath, [CLI, "serve"], { cwd: dir, env, stdio: "ignore" });
    try {
      let up = false;
      for (let i = 0; i < 60 && !up; i++) { await sleep(250); up = /"pid"/.test((await dtwin(dir, ["status"])).stdout); }
      check("the daemon came up on 8789", up);
      const a = fakePlugin({ instanceId: "fig-a", file: "App Alpha", fileKey: "KEYA" }, { whoami: () => whoamiReply("fig-a", "App Alpha", "KEYA"), exportNode: (_a, emit) => { emit({ type: "progress", phase: "queued", source: "bridge", label: "exportNode" }); return nodeReply(); } });
      await a.opened;
      const b = fakePlugin({ instanceId: "fig-b", file: "App Bravo", fileKey: "KEYB" }, { whoami: () => whoamiReply("fig-b", "App Bravo", "KEYB") });
      await b.opened;
      await sleep(300);
      const r = await dtwin(dir, ["whoami", "--client", "Bravo", "--timeout", "30"]);
      const j = json(r.stdout);
      const conn = j && j.connection && typeof j.connection === "object" ? Object.fromEntries(Object.entries(j.connection)) : null;
      check("through the daemon, `--client Bravo` → connection.connId is c2", r.code === 0 && !!conn && conn.connId === "c2" && /the daemon/.test(String(j?.connectionFrom)));
      const p = await dtwin(dir, ["pull", "out", "--node", "1:2", "--client", "Alpha", "--timeout", "30"]);
      // the daemon waits for a not-yet-connected plugin inside the request, so the line claims no
      // "no reconnect" and labels the export figure as including any such wait.
      check("through the daemon the done line says so, with no connect-wait claim", p.code === 0 && /\[dtwin\] done in \d+\.\ds — via the running daemon · export \(incl\. any wait for the plugin\) \d+\.\ds · write \d+\.\ds/.test(p.stderr) && !/waited/.test(p.stderr) && !/no reconnect\)/.test(p.stderr));
      check("through the daemon the queued line is also printed once", (p.stderr.match(/queued behind another export in that file/g) ?? []).length === 1);
      a.stop(); b.stop();
    } finally {
      await dtwin(dir, ["stop"]);
      serve.kill("SIGKILL");
    }
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

report();
