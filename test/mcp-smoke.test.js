// Behavioural smoke test for the MCP server: boot the REAL bridge/figma-mcp.mjs over stdio with the
// SDK's own client, list its tools, and call the ones that need no Figma connection.
//   node test/mcp-smoke.test.js
// bridge.test.js checks the built .mjs by reading its SOURCE; nothing there would catch a tool whose
// schema fails at registration time, or a server that writes a log line to stdout and corrupts the
// protocol stream. This does.
const path = require("path");
const { ok, report } = require("./assert");
const sdk = (p) => require(require.resolve("@modelcontextprotocol/sdk/" + p, { paths: [path.join(__dirname, "..", "bridge")] }));
const { Client } = sdk("client/index.js");
const { StdioClientTransport } = sdk("client/stdio.js");

(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, "..", "bridge", "figma-mcp.mjs")],
    // A spare allowed port so a developer's live bridge on 8787 doesn't fail the run, and a fixed
    // token so booting never mints/saves one into the user's real config dir.
    env: { ...process.env, FIGMA_BRIDGE_PORT: "8789", FIGMA_BRIDGE_TOKEN: "smoke-test-token" },
    stderr: "ignore",
  });
  const client = new Client({ name: "mcp-smoke", version: "0.0.0" });
  try {
    await client.connect(transport);
    ok("server boots and completes the MCP handshake over stdio", true);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    ok("lists the full tool surface (15)", tools.length === 15 && ["figma_status", "figma_export_url", "figma_screenshot", "figma_write", "design_drift_lint"].every((n) => names.includes(n)));
    ok("every tool has a description and an object input schema", tools.every((t) => t.description && t.inputSchema && t.inputSchema.type === "object"));
    const write = tools.find((t) => t.name === "figma_write");
    ok("figma_write is the ONLY non-read-only tool, and is marked destructive", write.annotations.destructiveHint === true && write.annotations.readOnlyHint === false
      && tools.filter((t) => !(t.annotations && t.annotations.readOnlyHint)).map((t) => t.name).join() === "figma_write");
    ok("figma_write exposes dryRun", !!write.inputSchema.properties.dryRun);

    const dry = await client.callTool({ name: "figma_write", arguments: { dryRun: true, ops: [{ op: "createFrame", name: "Card" }, { op: "setFill", nodeId: "1:2", color: "#ff0000" }, { op: "setText", nodeId: "1:3" }] } });
    const preview = JSON.parse(dry.content[0].text);
    ok("dryRun previews without a plugin connected, and applies nothing", !dry.isError && preview.dryRun === true && preview.applied === false);
    ok("dryRun separates creates from overwrites and flags an invalid op", preview.creates === 1 && preview.overwrites === 2 && preview.invalid === 1 && preview.steps[1].target === "1:2" && /missing text/.test(preview.steps[2].invalid));

    const bad = await client.callTool({ name: "figma_write", arguments: { ops: [{ op: "deleteEverything" }] } }).catch((e) => ({ isError: true, thrown: String(e && e.message) }));
    ok("an op outside the four implemented ones is rejected at the schema boundary", bad.isError === true);

    const status = await client.callTool({ name: "figma_status", arguments: {} });
    ok("figma_status answers with no plugin connected (no hang, parseable JSON)", (() => { try { JSON.parse(status.content[0].text); return true; } catch { return false; } })());
  } catch (e) {
    ok("MCP smoke run completed without throwing — " + (e && e.message), false);
  } finally {
    await client.close().catch(() => {});
  }
  report();
})();
