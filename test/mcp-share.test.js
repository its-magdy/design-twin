// Two MCP servers on one port — i.e. two Claude Code sessions in projects that both registered
// `designtwin`. The second used to die on EADDRINUSE; it must share the first one's bridge, and take
// the bridge over when that session ends.
//   node test/mcp-share.test.js
const path = require("path");
const { spawn } = require("child_process");
const { check, report } = require("./assert");

const MCP = path.join(__dirname, "..", "bridge", "figma-mcp.mjs");
const env = { ...process.env, FIGMA_BRIDGE_PORT: "8789", FIGMA_BRIDGE_TOKEN: "s".repeat(40) };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { for (const t0 = Date.now(); Date.now() - t0 < ms; await wait(100)) if (fn()) return true; return false; };

function start() {
  const p = spawn(process.execPath, [MCP], { env, stdio: ["pipe", "pipe", "pipe"] });
  p.err = ""; p.out = ""; p.code = undefined;
  p.stderr.on("data", (d) => (p.err += d));
  p.stdout.on("data", (d) => (p.out += d));
  p.on("exit", (c) => (p.code = c));
  p.send = (o) => p.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\n");
  p.reply = (id) => p.out.split("\n").find((l) => l.includes(`"id":${id}`));
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
  check("a tool call through the shared bridge answers", await until(() => b.reply(2)) && /Nothing connected/.test(b.reply(2)));
  a.kill();
  await until(() => a.code !== undefined || a.killed);
  await wait(500);
  b.send({ id: 3, method: "tools/call", params: { name: "figma_list_clients", arguments: {} } });
  check("when the first session ends, the second takes the bridge over", await until(() => b.reply(3)) && !/"isError":true/.test(b.reply(3)) && /Bridge|daemon listening/.test(b.err.split("Sharing")[1] || ""));
  b.kill();
  await wait(200);
  report();
})();
