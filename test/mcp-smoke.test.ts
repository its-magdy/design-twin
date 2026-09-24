// Behavioural smoke test for the MCP server: boot the REAL bridge/src/figma-mcp.ts over stdio with the
// SDK's own client, list its tools, and call the ones that need no Figma connection.
//   node test/mcp-smoke.test.ts
// bridge.test.ts checks src/figma-mcp.ts by reading its SOURCE text; nothing there would catch a tool whose
// schema fails at registration time, or a server that writes a log line to stdout and corrupts the
// protocol stream. This does.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ok, report } from "./assert.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ProgressNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
// "ws" ships no types of its own; @types/ws (a bridge devDependency) provides them.
import WebSocket from "ws";
import type { RawData } from "ws";
import type { Cmd, ScreenReply } from "../bridge/src/commands.ts";
// Type-only: erased before Node runs this file, so the server module is NOT imported here (it is
// booted as a subprocess below — importing it would start a real bridge + stdio transport).
import type { GetComponentModule, DriftLintModule } from "../bridge/src/figma-mcp.ts";
import type * as GetComponentMod from "../design-to-code/get-component.ts";
import type * as DriftLintMod from "../design-to-code/drift-lint.ts";
import { isUnknownArray } from "../bridge/src/json-util.ts";

// Compile-time only. figma-mcp.ts declares its OWN view of the two design-to-code modules it loads
// lazily (it cannot reference them: rootDir is bridge/src). Nothing else ties those local interfaces to
// the real modules, so drift between them would only show at runtime, inside a tool call. The test
// program sees both trees, so it checks here that the real modules still satisfy the server's view.
type Assert<T extends true> = T;
// Exported only so noUnusedLocals accepts a type whose whole job is to be checked, never referenced.
export type McpLayerConformance = [
  Assert<typeof GetComponentMod extends GetComponentModule ? true : false>,
  Assert<typeof DriftLintMod extends DriftLintModule ? true : false>,
];

// A tools/call JSON-RPC reply as the SDK client hands it back: a CallToolResult, or the legacy
// `{ toolResult }` compatibility shape (never sent by this server, so reading it fails the check).
type JsonRpcReply = Awaited<ReturnType<Client["callTool"]>>;
/** The text of a reply's first content block — throws (like the untyped `r.content[0].text` did) when there is none. */
function firstText(r: JsonRpcReply): string {
  const content: unknown = "content" in r ? r.content : undefined;
  const c: unknown = isUnknownArray(content) ? content[0] : undefined;
  if (typeof c !== "object" || c === null || !("type" in c) || c.type !== "text" || !("text" in c) || typeof c.text !== "string") throw new Error("tool reply has no text content");
  return c.text;
}
// The one bridge -> plugin frame this fake plugin reads: `{ id, cmd, args }` (server-core does not export it).
interface CommandFrame { id: string; cmd: Cmd; args?: Record<string, unknown> }
// figma_write's dryRun result — figma-mcp.ts previewWrites() (an inferred return type, not exported): the fields read below.
interface WritePreview { dryRun: boolean; applied: boolean; creates: number; overwrites: number; invalid: number; steps: Array<{ target: string | null; invalid?: string }> }
// The compact result exportResult() returns once an export is written to disk: only its note is read.
interface WrittenExport { note: string }

const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-mcp-"));

// The suite reports its own failures (report() sets the exit code); nothing awaits the IIFE.
void (async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(import.meta.dirname, "..", "bridge", "src", "figma-mcp.ts")],
    // A spare allowed port so a developer's live bridge on 8787 doesn't fail the run, and a fixed
    // token so booting never mints/saves one into the user's real config dir.
    env: { ...process.env, FIGMA_BRIDGE_PORT: "8789", FIGMA_BRIDGE_TOKEN: "smoke-test-token", MAX_MCP_OUTPUT_TOKENS: "" },
    cwd: CWD,
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
    if (!write) throw new Error("figma_write is not listed");
    ok("figma_write is the ONLY non-read-only tool, and is marked destructive", write.annotations?.destructiveHint === true && write.annotations.readOnlyHint === false
      && tools.filter((t) => !(t.annotations && t.annotations.readOnlyHint)).map((t) => t.name).join() === "figma_write");
    ok("figma_write exposes dryRun", !!write.inputSchema.properties?.dryRun);

    const dry = await client.callTool({ name: "figma_write", arguments: { dryRun: true, ops: [{ op: "createFrame", name: "Card" }, { op: "setFill", nodeId: "1:2", color: "#ff0000" }, { op: "setText", nodeId: "1:3" }] } });
    const preview = JSON.parse(firstText(dry)) as WritePreview;
    ok("dryRun previews without a plugin connected, and applies nothing", !dry.isError && preview.dryRun === true && preview.applied === false);
    ok("dryRun separates creates from overwrites and flags an invalid op", preview.creates === 1 && preview.overwrites === 2 && preview.invalid === 1 && preview.steps[1].target === "1:2" && /missing text/.test(preview.steps[2].invalid ?? ""));

    const bad = await client.callTool({ name: "figma_write", arguments: { ops: [{ op: "deleteEverything" }] } }).catch((e: unknown) => ({ isError: true, thrown: String(e instanceof Error ? e.message : e) }));
    ok("an op outside the four implemented ones is rejected at the schema boundary", bad.isError === true);

    const status = await client.callTool({ name: "figma_status", arguments: {} });
    ok("figma_status answers with no plugin connected (no hang, parseable JSON)", (() => { try { JSON.parse(firstText(status)) as unknown; return true; } catch { return false; } })());

    // design_drift_lint applies the same map gate as the CLI: a structurally invalid map is a tool error
    // listing the [map-invalid] findings, never linted (and rejected before the export is even read).
    fs.writeFileSync(path.join(CWD, "bad-map.json"), JSON.stringify({ components: "not-an-object", bogus: 1 }));
    const invalid = await client.callTool({ name: "design_drift_lint", arguments: { map: "bad-map.json" } });
    ok("design_drift_lint rejects an invalid map as a tool error mentioning map-invalid", invalid.isError === true && /\[map-invalid\]/.test(firstText(invalid)) && /not a valid component map/.test(firstText(invalid)));

    // ---- the inline size guard, end to end, with a fake plugin answering the export.
    const plugin = new WebSocket("ws://127.0.0.1:8789/?token=smoke-test-token", { origin: "null" });
    await new Promise((res, rej) => { plugin.on("open", res); plugin.on("error", rej); });
    let kids = 3;
    let ticks = 0; // progress frames to send before the reply, as ui.html relays a bridge-triggered run's
    let burst = false;
    plugin.on("message", (raw: RawData) => {
      const m = JSON.parse(String(raw)) as CommandFrame;
      if (m.cmd !== "exportSelection") return;
      for (let i = 1; i <= ticks; i++) plugin.send(JSON.stringify({ type: "progress", phase: "pages", page: { index: i, of: ticks, name: "P" + i }, nodes: i * 10 }));
      const children = Array.from({ length: kids }, (_, i) => ({ id: "9:" + i, name: "Row " + i, type: "FRAME", box: { x: 0, y: i * 40, w: 390, h: 40 }, fills: [{ type: "solid", color: "#ffffff" }] }));
      // The REAL exportSelection shape (figma-plugin/src/collect.ts screenResult) — the bridge now
      // checks every reply against commands.ts before a tool sees it.
      const screen = { exportedAt: "2026-09-21T00:00:00Z", screen: "Big", manifest: { nodes: kids + 1 }, nodes: [{ id: "9:999", name: "Big", type: "FRAME", box: { x: 0, y: 0, w: 390, h: 844 }, children }] };
      const answer = () => plugin.send(JSON.stringify({ id: m.id, ok: true, result: { screenName: "Big", screen, variables: { collections: [], variables: [], hygiene: [] }, assets: [] } }));
      // `burst` = the WORST timing: every tick and the reply in the same event-loop turn. Otherwise
      // the reply trails the ticks by 50 ms (a real run's ticks are >=250 ms apart and long before
      // its reply). The SDK CLIENT (1.30: Protocol._onnotification dispatches on a microtask,
      // _onresponse deletes the progress handler synchronously) drops a notification that shares a
      // stdout read chunk with the response, so `onprogress` delivery is only asserted with the
      // delay; the burst case asserts what the SERVER owns — the order on the wire.
      if (ticks && !burst) setTimeout(answer, 50); else answer();
    });
    const small = await client.callTool({ name: "figma_export_selection", arguments: {} });
    ok("a small export still comes back INLINE", !small.isError && (JSON.parse(firstText(small)) as ScreenReply).screen.nodes[0].children?.length === 3);
    kids = 1500; // ~200 KB of indented JSON — far past the 25k-token default
    const big = await client.callTool({ name: "figma_export_selection", arguments: {} });
    const idx = JSON.parse(firstText(big)) as WrittenExport;
    ok("an export past the client's output cap is written to disk on its own, and the result says why", !big.isError && firstText(big).length < 8000 && /WITHOUT being asked/.test(idx.note) && /k tokens/.test(idx.note) && fs.existsSync(path.join(CWD, "design")));
    const refused = await client.callTool({ name: "figma_export_selection", arguments: { writeToDisk: false } });
    ok("…and an explicit writeToDisk:false is an error with the size, never a truncated result", refused.isError === true && /writeToDisk:false was passed/.test(firstText(refused)));

    // MCP progress: a call that carries a progressToken (the SDK client adds one for `onprogress`) gets
    // the plugin's relayed ticks as notifications/progress, with a strictly increasing `progress`.
    kids = 3;
    ticks = 2;
    const seen: Array<{ progress: number; message?: string }> = [];
    const withProgress = await client.callTool({ name: "figma_export_selection", arguments: {} }, undefined, { onprogress: (p) => seen.push(p) });
    ok("export tools forward the plugin's progress as notifications/progress (increasing, with a message)",
      !withProgress.isError && seen.length === 2 && seen[0].progress < seen[1].progress && seen[1].message === "pages, page 2 of 2 (P2), 20 nodes");
    // Wire order under the worst timing: the raw frames the client transport hands up, in order.
    // Before withProgress held the result back, the last notification was written AFTER the result
    // (fire-and-forget sendNotification vs. the reply resolving in the same turn) — and a
    // notifications/progress after its result is one no client can use.
    burst = true;
    const wire: string[] = [];
    const prev = transport.onmessage;
    transport.onmessage = (m: JSONRPCMessage) => {
      if ("method" in m && m.method === "notifications/progress") wire.push("progress");
      else if ("id" in m && "result" in m) wire.push("result");
      prev?.(m);
    };
    for (let i = 0; i < 5; i++) await client.callTool({ name: "figma_export_selection", arguments: {} }, undefined, { onprogress: () => {} });
    transport.onmessage = prev;
    ok("…and with ticks and the reply sent in ONE turn, every notifications/progress is on the wire before its result (5 runs)",
      wire.join(",") === Array(5).fill("progress,progress,result").join(","));
    burst = false;
    const quiet: unknown[] = [];
    client.setNotificationHandler(ProgressNotificationSchema, (n) => { quiet.push(n); });
    await client.callTool({ name: "figma_export_selection", arguments: {} });
    ok("…and a call WITHOUT a progressToken is sent none", quiet.length === 0);

    // Daemon-routed: a SECOND MCP server on the same port cannot bind it (this one holds the bridge), so
    // it can only answer an export by routing through the daemon socket this one serves (figma-mcp.ts
    // resolveHolder). The plugin's ticks must reach ITS client as notifications/progress too (MCP spec
    // 2025-06-18, basic/utilities/progress) — relayed as daemon progress frames (daemon.ts).
    const transport2 = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(import.meta.dirname, "..", "bridge", "src", "figma-mcp.ts")],
      env: { ...process.env, FIGMA_BRIDGE_PORT: "8789", FIGMA_BRIDGE_TOKEN: "smoke-test-token", MAX_MCP_OUTPUT_TOKENS: "" },
      cwd: CWD,
      stderr: "ignore",
    });
    const client2 = new Client({ name: "mcp-smoke-2", version: "0.0.0" });
    try {
      await client2.connect(transport2);
      const seen2: Array<{ progress: number; message?: string }> = [];
      const via = await client2.callTool({ name: "figma_export_selection", arguments: {} }, undefined, { onprogress: (p) => seen2.push(p) });
      ok("a DAEMON-ROUTED export (a second session sharing this one's bridge) forwards the plugin's progress as notifications/progress too",
        !via.isError && (JSON.parse(firstText(via)) as ScreenReply).screen.nodes[0].children?.length === 3
        && seen2.length === 2 && seen2[0].progress < seen2[1].progress && seen2[1].message === "pages, page 2 of 2 (P2), 20 nodes");
      burst = true;
      const wire2: string[] = [];
      const prev2 = transport2.onmessage;
      transport2.onmessage = (m: JSONRPCMessage) => {
        if ("method" in m && m.method === "notifications/progress") wire2.push("progress");
        else if ("id" in m && "result" in m) wire2.push("result");
        prev2?.(m);
      };
      for (let i = 0; i < 3; i++) await client2.callTool({ name: "figma_export_selection", arguments: {} }, undefined, { onprogress: () => {} });
      transport2.onmessage = prev2;
      ok("…and with ticks and the reply sent in ONE turn, every daemon-relayed notifications/progress is on the wire before its result (3 runs)",
        wire2.join(",") === Array(3).fill("progress,progress,result").join(","));
      burst = false;
    } finally {
      await client2.close().catch(() => {});
    }
    ticks = 0;
    plugin.close();
  } catch (e) {
    ok("MCP smoke run completed without throwing — " + (e instanceof Error ? e.message : e), false);
  } finally {
    await client.close().catch(() => {});
  }
  report();
})();
