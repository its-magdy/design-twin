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
// "ws" ships no types of its own; @types/ws (a bridge devDependency) provides them.
import WebSocket from "ws";
import type { RawData } from "ws";
import type { RequestArgs } from "../bridge/src/server-core.ts";
import type { ScreenExport } from "../bridge/src/doc-types.ts";
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
interface CommandFrame { id: string; cmd: string; args?: RequestArgs }
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
    plugin.on("message", (raw: RawData) => {
      const m = JSON.parse(String(raw)) as CommandFrame;
      if (m.cmd !== "exportSelection") return;
      const children = Array.from({ length: kids }, (_, i) => ({ id: "9:" + i, name: "Row " + i, type: "FRAME", box: { x: 0, y: i * 40, w: 390, h: 40 }, fills: [{ type: "solid", color: "#ffffff" }] }));
      plugin.send(JSON.stringify({ id: m.id, ok: true, result: { exportedAt: "2026-09-21T00:00:00Z", screen: "Big", manifest: { nodes: kids + 1 }, nodes: [{ id: "9:999", name: "Big", type: "FRAME", box: { x: 0, y: 0, w: 390, h: 844 }, children }], assets: [] } }));
    });
    const small = await client.callTool({ name: "figma_export_selection", arguments: {} });
    ok("a small export still comes back INLINE", !small.isError && (JSON.parse(firstText(small)) as ScreenExport).nodes[0].children!.length === 3);
    kids = 1500; // ~200 KB of indented JSON — far past the 25k-token default
    const big = await client.callTool({ name: "figma_export_selection", arguments: {} });
    const idx = JSON.parse(firstText(big)) as WrittenExport;
    ok("an export past the client's output cap is written to disk on its own, and the result says why", !big.isError && firstText(big).length < 8000 && /WITHOUT being asked/.test(idx.note) && /k tokens/.test(idx.note) && fs.existsSync(path.join(CWD, "design")));
    const refused = await client.callTool({ name: "figma_export_selection", arguments: { writeToDisk: false } });
    ok("…and an explicit writeToDisk:false is an error with the size, never a truncated result", refused.isError === true && /writeToDisk:false was passed/.test(firstText(refused)));
    plugin.close();
  } catch (e) {
    ok("MCP smoke run completed without throwing — " + (e instanceof Error ? e.message : e), false);
  } finally {
    await client.close().catch(() => {});
  }
  report();
})();
