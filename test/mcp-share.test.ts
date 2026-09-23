// Two MCP servers on one port — i.e. two Claude Code sessions in projects that both registered
// `designtwin`. The second used to die on EADDRINUSE; it must share the first one's bridge, and take
// the bridge over when that session ends.
//   node test/mcp-share.test.ts
import path from "node:path";
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

(async () => {
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
  await wait(200);
  report();
})();
