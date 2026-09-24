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

function start(): McpProc {
  const proc = spawn(process.execPath, [MCP], { env, stdio: ["pipe", "pipe", "pipe"] });
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

// The suite reports its own failures (report() sets the exit code); nothing awaits the IIFE.
void (async () => {
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
  const sock = path.join(os.tmpdir(), "designtwin-8789.sock"); // daemon.ts sockPath(8789)
  try { fs.unlinkSync(sock); } catch { /* none left over */ }
  const mute = net.createServer(() => { /* accept, never reply */ });
  await new Promise<void>((r) => mute.listen(sock, () => r()));
  const c = start();
  const init = { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
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
  // Not awaited: close() waits for every connection to end, and a regression must fail, not hang.
  // report() exits the process.
  squatter.close();
  report();
})();
