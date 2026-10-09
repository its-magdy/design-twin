// Two MCP servers on one port — i.e. two Claude Code sessions in projects that both registered
// `designtwin`. The second used to die on EADDRINUSE; it must share the first one's bridge, and take
// the bridge over when that session ends.
//   node test/mcp-share.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import * as daemon from "../bridge/src/daemon.ts";
import { check, report } from "./assert.ts";

const MCP = path.join(import.meta.dirname, "..", "bridge", "src", "figma-mcp.ts");
const env = { ...process.env, FIGMA_BRIDGE_PORT: "8789", FIGMA_BRIDGE_TOKEN: "s".repeat(40) };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => unknown, ms = 8000) => { for (const t0 = Date.now(); Date.now() - t0 < ms; await wait(100)) if (fn()) return true; return false; };

/** One MCP server subprocess, with its stdio accumulated and a raw JSON-RPC writer/reader on top. */
interface McpProc {
  proc: ChildProcessWithoutNullStreams;
  err: string;
  out: string;
  /** exit code; undefined while running (null when killed by a signal) */
  code: number | null | undefined;
  send(o: { id?: number; method: string; params?: object }): void;
  /** the raw reply line carrying this JSON-RPC id, if it has arrived */
  reply(id: number): string | undefined;
}

function start(procEnv: NodeJS.ProcessEnv = env): McpProc {
  const proc = spawn(process.execPath, [MCP], { env: procEnv, stdio: ["pipe", "pipe", "pipe"] });
  const p: McpProc = {
    proc, err: "", out: "", code: undefined,
    send: (o) => { proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\n"); },
    reply: (id) => p.out.split("\n").find((l) => l.includes(`"id":${id}`)),
  };
  proc.stderr.on("data", (d: Buffer) => (p.err += String(d)));
  proc.stdout.on("data", (d: Buffer) => (p.out += String(d)));
  proc.on("exit", (c) => (p.code = c));
  return p;
}

const init = { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };

// Windows: no daemon (daemon.ts daemonSupported), so nothing is shared. The first server holds the bridge
// and says once why it does not share it; a second one stays up, and its tool calls are errors saying
// the bridge is held by another session and sharing is not supported there — until the first one ends,
// when the second takes the port itself (it re-resolves per call). A held port and concurrent first
// calls behave as everywhere else.
async function windows(): Promise<void> {
  console.log("  (skipped: the daemon is not supported on Windows — no session shares its bridge, so the sharing, mute-socket and squatted-directory checks have nothing to run on; the one-holder behaviour is checked instead)");
  const notSharing = "not sharing the bridge with other sessions: " + daemon.DAEMON_UNSUPPORTED;
  const heldText = /port 8789 is already in use — another MCP session or dtwin command holds the bridge, and sharing it between sessions is not supported on Windows \(yet\)\. Close the other one first/;
  const a = start();
  check("first server opens the bridge itself", await until(() => /Bridge listening on ws:\/\/localhost:8789/.test(a.err)));
  check("…and says once, on stderr, that it does not share it, with the reason — no socket listen is tried",
    a.err.split(notSharing).length === 2 && !/daemon listening|EACCES/.test(a.err));
  const b = start();
  check("second server stays up and reports at startup that another session holds the bridge, unshared on Windows",
    await until(() => /no bridge yet: \[bridge\] /.test(b.err) && heldText.test(b.err)) && b.code === undefined);
  b.send(init);
  await until(() => b.reply(1));
  b.send({ method: "notifications/initialized" });
  b.send({ id: 2, method: "tools/call", params: { name: "figma_list_clients", arguments: {} } });
  check("…and its tool call is a tool error saying so (close the other one), not a dead server",
    await until(() => b.reply(2)) && /"isError":true/.test(b.reply(2) ?? "") && heldText.test(b.reply(2) ?? "") && b.code === undefined);
  a.proc.kill();
  await until(() => a.code !== undefined || a.proc.killed);
  await wait(500);
  b.send({ id: 3, method: "tools/call", params: { name: "figma_list_clients", arguments: {} } });
  check("when the first session ends, the second takes the bridge over (and says it does not share it)",
    await until(() => b.reply(3)) && !/"isError":true/.test(b.reply(3) ?? "") && b.err.split(notSharing).length === 2);
  b.proc.kill();
  await until(() => b.code !== undefined);
  await wait(300);

  // Concurrent first calls: one bridge, both answer. No probe delay holds the window open here (no daemon
  // socket to probe), so this is the plain case.
  const c = start();
  c.proc.stdin.write([init, { method: "notifications/initialized" },
    { id: 2, method: "tools/call", params: { name: "figma_list_clients", arguments: {} } },
    { id: 3, method: "tools/call", params: { name: "figma_status", arguments: {} } }]
    .map((o) => JSON.stringify({ jsonrpc: "2.0", ...o }) + "\n").join(""));
  const both = await until(() => c.reply(2) && c.reply(3));
  check("two concurrent tool calls both answer, neither as an error", both && !/"isError":true/.test((c.reply(2) ?? "") + (c.reply(3) ?? "")));
  check("…from ONE bridge (createBridge ran once) and the process is still up",
    (c.err.match(/auth: using FIGMA_BRIDGE_TOKEN/g) || []).length === 1 && c.code === undefined);
  c.proc.kill();
  await until(() => c.code !== undefined);
  await wait(300);

  // A port held by something that is not a dtwin bridge: a tool error naming the port, the server stays up.
  const squatter = net.createServer();
  await new Promise<void>((r) => squatter.listen(8789, "127.0.0.1", () => r()));
  const d = start();
  d.send(init);
  await until(() => d.reply(1));
  d.send({ method: "notifications/initialized" });
  d.send({ id: 2, method: "tools/call", params: { name: "figma_list_clients", arguments: {} } });
  check("a held port is a TOOL error naming the port, not a dead MCP server",
    await until(() => d.reply(2)) && /"isError":true/.test(d.reply(2) ?? "") && /already in use/.test(d.reply(2) ?? "") && d.code === undefined);
  d.proc.kill();
  await until(() => d.code !== undefined);
  squatter.close();
}

// The suite reports its own failures (report() sets the exit code); nothing awaits the IIFE.
void (async () => {
  if (!daemon.daemonSupported()) {
    await windows();
    report();
    return;
  }
  const a = start();
  check("first server opens the bridge itself", await until(() => /Bridge listening on ws:\/\/localhost:8789/.test(a.err)));
  await until(() => /daemon listening/.test(a.err));
  const b = start();
  check("second server shares it instead of exiting on EADDRINUSE", await until(() => /Sharing the bridge already running/.test(b.err)) && b.code === undefined);
  b.send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  await until(() => b.reply(1));
  b.send({ method: "notifications/initialized" });
  b.send({ id: 2, method: "tools/call", params: { name: "figma_list_clients", arguments: {} } });
  check("a tool call through the shared bridge answers", await until(() => b.reply(2)) && /Nothing connected/.test(b.reply(2) ?? ""));
  a.proc.kill();
  await until(() => a.code !== undefined || a.proc.killed);
  await wait(500);
  b.send({ id: 3, method: "tools/call", params: { name: "figma_list_clients", arguments: {} } });
  check("when the first session ends, the second takes the bridge over", await until(() => b.reply(3)) && !/"isError":true/.test(b.reply(3) ?? "") && /Bridge|daemon listening/.test(b.err.split("Sharing")[1] || ""));
  b.proc.kill();
  await until(() => b.code !== undefined);
  await wait(300);

  // Concurrent first calls. holder() used to resolve per call: main()'s startup resolution and two
  // tool calls sent in the same stdin write each saw no daemon and each called createBridge(), and the
  // second bind hit EADDRINUSE. To hold that window open deterministically, a MUTE listener sits on
  // the daemon socket path: it accepts and never answers, so every daemon probe waits out its 1.5s
  // timeout — long enough for all three resolutions to be in flight at once. createBridge prints its
  // "auth: using FIGMA_BRIDGE_TOKEN" line once per call — that line is the count of bridges opened.
  const sock = daemon.sockPath(8789); // the spawned servers inherit this env, so they resolve the same path
  try { fs.unlinkSync(sock); } catch { /* none left over */ }
  const mute = net.createServer(() => { /* accept, never reply */ });
  await new Promise<void>((r) => mute.listen(sock, () => r()));
  const c = start();
  c.proc.stdin.write([init, { method: "notifications/initialized" },
    { id: 2, method: "tools/call", params: { name: "figma_list_clients", arguments: {} } },
    { id: 3, method: "tools/call", params: { name: "figma_status", arguments: {} } }]
    .map((o) => JSON.stringify({ jsonrpc: "2.0", ...o }) + "\n").join(""));
  const both = await until(() => c.reply(2) && c.reply(3));
  check("two concurrent tool calls both answer, neither as an error", both && !/"isError":true/.test((c.reply(2) ?? "") + (c.reply(3) ?? "")));
  check("…from ONE bridge (createBridge ran once) and the process is still up",
    (c.err.match(/auth: using FIGMA_BRIDGE_TOKEN/g) || []).length === 1 && c.code === undefined);
  c.proc.kill();
  await until(() => c.code !== undefined);
  mute.close();
  try { fs.unlinkSync(sock); } catch { /* the MCP server's own daemon may have replaced/removed it */ }
  await wait(300);

  // A socket directory that is not private to this user (here: 0777, under the server's own TMPDIR)
  // is no daemon: the server holds the bridge itself, its tools work, and the refusal reaches stderr
  // once — never stdout, which is the JSON-RPC channel.
  const uid = process.getuid?.();
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-share-"));
  if (uid !== undefined) {
    const squatted = path.join(tmpBase, "squatted");
    fs.mkdirSync(path.join(squatted, `designtwin-${uid}`), { recursive: true });
    fs.chmodSync(path.join(squatted, `designtwin-${uid}`), 0o777);
    const rEnv: NodeJS.ProcessEnv = { ...env, TMPDIR: squatted };
    delete rEnv.XDG_RUNTIME_DIR;
    const r = start(rEnv);
    r.send(init);
    await until(() => r.reply(1));
    r.send({ method: "notifications/initialized" });
    r.send({ id: 2, method: "tools/call", params: { name: "figma_list_clients", arguments: {} } });
    r.send({ id: 3, method: "tools/call", params: { name: "figma_status", arguments: {} } });
    const answered = await until(() => r.reply(2) && r.reply(3));
    check("a refused socket directory: the MCP tools still answer, not as errors",
      answered && !/"isError":true/.test((r.reply(2) ?? "") + (r.reply(3) ?? "")) && r.code === undefined);
    check("…the refusal is on stderr once, and stdout carries only JSON-RPC",
      (r.err.match(/Going on without a daemon/g) ?? []).length === 1 &&
      r.out.split("\n").filter((l) => l.trim()).every((l) => { try { JSON.parse(l) as unknown; return true; } catch { return false; } }));
    r.proc.kill();
    await until(() => r.code !== undefined);
    await wait(300);
  }

  // A port held by something that is NOT a dtwin daemon (no socket to share through): the MCP server
  // used to process.exit(1) inside createBridge. It must stay up and report the held port per call.
  const squatter = net.createServer();
  await new Promise<void>((r) => squatter.listen(8789, "127.0.0.1", () => r()));
  const d = start();
  d.send(init);
  await until(() => d.reply(1));
  d.send({ method: "notifications/initialized" });
  d.send({ id: 2, method: "tools/call", params: { name: "figma_list_clients", arguments: {} } });
  check("a held port is a TOOL error naming the port, not a dead MCP server",
    await until(() => d.reply(2)) && /"isError":true/.test(d.reply(2) ?? "") && /already in use/.test(d.reply(2) ?? "") && d.code === undefined);
  d.proc.kill();
  await until(() => d.code !== undefined);
  // The same held port with a socket of ours at the location an earlier build's daemon used
  // (<tmpdir>/designtwin-<port>.sock): the error names it and how to stop it.
  if (uid !== undefined) {
    const oldBase = path.join(tmpBase, "old");
    fs.mkdirSync(oldBase);
    const oldDaemon = net.createServer(() => { /* accept, never reply */ });
    await new Promise<void>((r) => oldDaemon.listen(path.join(oldBase, "designtwin-8789.sock"), () => r()));
    const oEnv: NodeJS.ProcessEnv = { ...env, TMPDIR: oldBase };
    delete oEnv.XDG_RUNTIME_DIR;
    const o = start(oEnv);
    o.send(init);
    await until(() => o.reply(1));
    o.send({ method: "notifications/initialized" });
    o.send({ id: 2, method: "tools/call", params: { name: "figma_list_clients", arguments: {} } });
    check("a held port with an earlier build's daemon socket names it and `dtwin --stop`",
      await until(() => o.reply(2)) && /earlier version may be holding it \(socket [^)]*designtwin-8789\.sock\)/.test(o.reply(2) ?? "") && /dtwin --stop/.test(o.reply(2) ?? ""));
    o.proc.kill();
    await until(() => o.code !== undefined);
    oldDaemon.close();
  }
  fs.rmSync(tmpBase, { recursive: true, force: true });
  // Not awaited: close() waits for every connection to end, and a regression must fail, not hang.
  // report() exits the process.
  squatter.close();
  report();
})();
