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
import { must } from "./fixtures.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ProgressNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { JSONRPCMessage, Progress } from "@modelcontextprotocol/sdk/types.js";
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
    ok("dryRun separates creates from overwrites and flags an invalid op", preview.creates === 1 && preview.overwrites === 2 && preview.invalid === 1 && preview.steps[1]?.target === "1:2" && /missing text/.test(preview.steps[2]?.invalid ?? ""));

    const bad = await client.callTool({ name: "figma_write", arguments: { ops: [{ op: "deleteEverything" }] } }).catch((e: unknown) => ({ isError: true, thrown: String(e instanceof Error ? e.message : e) }));
    ok("an op outside the four implemented ones is rejected at the schema boundary", bad.isError === true);

    const status = await client.callTool({ name: "figma_status", arguments: {} });
    ok("figma_status answers with no plugin connected (no hang, parseable JSON)", (() => { try { JSON.parse(firstText(status)) as unknown; return true; } catch { return false; } })());

    // design_drift_lint applies the same map gate as the CLI: a structurally invalid map is a tool error
    // listing the [map-invalid] findings, never linted (and rejected before the export is even read).
    fs.writeFileSync(path.join(CWD, "bad-map.json"), JSON.stringify({ components: "not-an-object", bogus: 1 }));
    const invalid = await client.callTool({ name: "design_drift_lint", arguments: { map: "bad-map.json" } });
    ok("design_drift_lint rejects an invalid map as a tool error mentioning map-invalid", invalid.isError === true && /\[map-invalid\]/.test(firstText(invalid)) && /not a valid component map/.test(firstText(invalid)));

    // DT-26 on the MCP path: the same catalog set as the CLI — components.library.json beside the named
    // catalog and every pulled library — so an entry for a library component is not orphaned; a broken
    // components.library.json is skipped, never an exit of the server process.
    {
      const ex = path.join(CWD, "ddl");
      fs.mkdirSync(path.join(ex, "design-system"), { recursive: true });
      fs.mkdirSync(path.join(ex, "libraries", "acme-kit"), { recursive: true });
      fs.writeFileSync(path.join(ex, "design-system.json"), JSON.stringify({ files: { componentsLocal: "design-system/components.local.json" } }));
      fs.writeFileSync(path.join(ex, "design-system", "components.local.json"), JSON.stringify({ exportedAt: new Date().toISOString(), components: [{ key: "k-local", id: "1:1", name: "Row", type: "COMPONENT" }] }));
      fs.writeFileSync(path.join(ex, "libraries", "index.json"), JSON.stringify({ libraries: [{ dir: "acme-kit", libraryName: "Acme Kit" }] }));
      fs.writeFileSync(path.join(ex, "libraries", "acme-kit", "components.json"), JSON.stringify({ exportedAt: new Date().toISOString(), components: [{ key: "k-lib", name: "Button", type: "COMPONENT_SET" }] }));
      fs.writeFileSync(path.join(ex, "design-system", "components.library.json"), JSON.stringify({ exportedAt: new Date().toISOString(), components: [{ key: "k-sample", name: "Chip", type: "COMPONENT", remote: true }] }));
      const entry = (key: string, name: string) => ({ figma: { key, name }, code: { module: "src/ui/" + name + ".tsx", export: name } });
      fs.writeFileSync(path.join(CWD, "lib-map.json"), JSON.stringify({ version: 1, components: { "k-local": entry("k-local", "Row"), "k-lib": entry("k-lib", "Button"), "k-sample": entry("k-sample", "Chip") } }));
      const lint = async () => {
        const r = await client.callTool({ name: "design_drift_lint", arguments: { map: "lib-map.json", exportDir: "ddl" } });
        return { isError: r.isError === true, text: firstText(r) };
      };
      const both = await lint();
      ok("[DT-26] design_drift_lint resolves entries against components.library.json and libraries/<dir>/components.json (no orphans)",
        !both.isError && !/orphaned-entry/.test(both.text) && /"ok":\s*true/.test(both.text) && /acme-kit/.test(both.text) && /components\.library\.json/.test(both.text));
      fs.writeFileSync(path.join(ex, "design-system", "components.library.json"), "{ not json");
      const broken = await lint();
      ok("[DT-26] design_drift_lint skips a broken components.library.json (the entry is orphaned) and the server stays up",
        !broken.isError && /orphaned-entry/.test(broken.text) && /k-sample/.test(broken.text) && !/k-lib'/.test(broken.text));
    }

    // design_get_component follows design-system.json's files.componentsLocal pointer: a wrong-shaped
    // manifest is a tool error that says so (not "Cannot read properties of null" / a path.join
    // TypeError), and a pointer that leaves the server's directory is refused before anything is read.
    {
      const dsx = path.join(CWD, "dsx");
      fs.mkdirSync(dsx, { recursive: true });
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-mcp-outside-"));
      fs.writeFileSync(path.join(outside, "components.local.json"), JSON.stringify({ components: [{ key: "k1", id: "1:1", name: "Btn" }] }));
      const get = async (manifest: string) => {
        fs.writeFileSync(path.join(dsx, "design-system.json"), manifest);
        const r = await client.callTool({ name: "design_get_component", arguments: { handle: "Btn", exportDir: "dsx" } });
        return { isError: r.isError === true, text: firstText(r) };
      };
      const nul = await get("null");
      const num = await get(JSON.stringify({ files: { componentsLocal: 5 } }));
      const esc = await get(JSON.stringify({ files: { componentsLocal: path.relative(dsx, path.join(outside, "components.local.json")) } }));
      fs.writeFileSync(path.join(dsx, "components.local.json"), JSON.stringify({ components: [{ key: "k1", id: "1:1", name: "Btn" }] }));
      const good = await get(JSON.stringify({ files: { componentsLocal: "components.local.json" } }));
      ok("design_get_component: a null / non-string-pointer manifest is a tool error naming it as not a manifest",
        nul.isError && /is not a design-system manifest/.test(nul.text) && num.isError && /is not a design-system manifest/.test(num.text) && /componentsLocal/.test(num.text));
      ok("design_get_component: a componentsLocal pointer that leaves the server directory is refused",
        esc.isError && /files\.componentsLocal must stay inside the directory this server was started in/.test(esc.text));
      ok("design_get_component: a valid manifest still resolves (control)", !good.isError && /"k1"/.test(good.text));
    }

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
    ok("a small export still comes back INLINE", !small.isError && (JSON.parse(firstText(small)) as ScreenReply).screen.nodes[0]?.children?.length === 3);
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
    const seen: Progress[] = [];
    const withProgress = await client.callTool({ name: "figma_export_selection", arguments: {} }, undefined, { onprogress: (p) => seen.push(p) });
    const p0 = must(seen[0], "first progress notification");
    const p1 = must(seen[1], "second progress notification");
    ok("export tools forward the plugin's progress as notifications/progress (increasing, with a message)",
      !withProgress.isError && seen.length === 2 && p0.progress < p1.progress && p1.message === "pages, page 2 of 2 (P2), 20 nodes");
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
    if (prev) transport.onmessage = prev; else delete transport.onmessage;
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
      const seen2: Progress[] = [];
      const via = await client2.callTool({ name: "figma_export_selection", arguments: {} }, undefined, { onprogress: (p) => seen2.push(p) });
      const s0b = must(seen2[0], "first daemon-routed progress notification");
      const s1b = must(seen2[1], "second daemon-routed progress notification");
      ok("a DAEMON-ROUTED export (a second session sharing this one's bridge) forwards the plugin's progress as notifications/progress too",
        !via.isError && (JSON.parse(firstText(via)) as ScreenReply).screen.nodes[0]?.children?.length === 3
        && seen2.length === 2 && s0b.progress < s1b.progress && s1b.message === "pages, page 2 of 2 (P2), 20 nodes");
      burst = true;
      const wire2: string[] = [];
      const prev2 = transport2.onmessage;
      transport2.onmessage = (m: JSONRPCMessage) => {
        if ("method" in m && m.method === "notifications/progress") wire2.push("progress");
        else if ("id" in m && "result" in m) wire2.push("result");
        prev2?.(m);
      };
      for (let i = 0; i < 3; i++) await client2.callTool({ name: "figma_export_selection", arguments: {} }, undefined, { onprogress: () => {} });
      if (prev2) transport2.onmessage = prev2; else delete transport2.onmessage;
      ok("…and with ticks and the reply sent in ONE turn, every daemon-relayed notifications/progress is on the wire before its result (3 runs)",
        wire2.join(",") === Array(3).fill("progress,progress,result").join(","));
      burst = false;
    } finally {
      await client2.close().catch(() => {});
    }
    ticks = 0;

    // A NAMED `client` is waited for (figma-mcp.ts bridge.request, same bounded wait as `--client
    // <name>` in the CLI and the daemon): the fake plugin above never identified, so "Late File"
    // matches nothing when the call starts; a second window that says hello 400 ms later must be
    // routed to, not refused. A bare connId never waits: an unknown `c9` fails at once.
    const late = new WebSocket("ws://127.0.0.1:8789/?token=smoke-test-token", { origin: "null" });
    const pinged: string[] = [];
    late.on("message", (raw: RawData) => {
      const m = JSON.parse(String(raw)) as CommandFrame;
      pinged.push(m.cmd);
      if (m.cmd === "ping") late.send(JSON.stringify({ id: m.id, ok: true, result: { pong: true, page: "Cover", file: "Late File" } }));
    });
    await new Promise((res, rej) => { late.on("open", res); late.on("error", rej); });
    const t0 = Date.now();
    const pending = client.callTool({ name: "figma_status", arguments: { client: "Late File" } });
    setTimeout(() => late.send(JSON.stringify({ type: "hello", instanceId: "fig-late", file: "Late File" })), 400);
    const routed = await pending;
    const routedMs = Date.now() - t0;
    // With a `client`, figma_status pings first and lists the roster after (so the roster shows the
    // window the ping reached, identified); the ping's own `file` is the proof it was routed by name.
    const statusOf = (r: JsonRpcReply): { pong?: boolean; file?: string } => JSON.parse(firstText(r)) as { pong?: boolean; file?: string };
    ok("a NAMED client that lands after the call started is waited for and routed to (not refused on the first file that connected)",
      !routed.isError && pinged.includes("ping") && statusOf(routed).pong === true && statusOf(routed).file === "Late File");
    ok("…and the wait ends as soon as the name matches, not at the 15 s window (took " + routedMs + " ms)", routedMs >= 300 && routedMs < 5000);
    const t1 = Date.now();
    const bare = await client.callTool({ name: "figma_status", arguments: { client: "c9" } });
    ok("a bare connId that nobody has is refused at once with the connected list (no wait)",
      bare.isError === true && /no connected Figma file matches 'c9'/.test(firstText(bare)) && /Late File/.test(firstText(bare)) && Date.now() - t1 < 2000);
    late.close();
    plugin.close();
    await new Promise((r) => setTimeout(r, 200)); // both sockets gone: the bridge has NO client now

    // LIVE 2026-09-25 (§5.2c): with NOTHING connected — every window mid-redial right after a bridge
    // restart — `figma_status {client:"<name>"}` answered `connected:false` in 10 ms: its zero-clients
    // early return skipped the named wait that bridge.request() gives every other tool. Now the ping
    // (and its wait) comes first. The old code fails the first check (no pong, connected:false) and the
    // second (a bare connId with nothing connected was `connected:false`, not the refusal every other
    // tool gives).
    const t2 = Date.now();
    const pending0 = client.callTool({ name: "figma_status", arguments: { client: "Late File 2" } });
    const late2 = new WebSocket("ws://127.0.0.1:8789/?token=smoke-test-token", { origin: "null" });
    late2.on("message", (raw: RawData) => {
      const m = JSON.parse(String(raw)) as CommandFrame;
      if (m.cmd === "ping") late2.send(JSON.stringify({ id: m.id, ok: true, result: { pong: true, page: "Cover", file: "Late File 2" } }));
    });
    await new Promise((res, rej) => { late2.on("open", res); late2.on("error", rej); });
    setTimeout(() => late2.send(JSON.stringify({ type: "hello", instanceId: "fig-late-2", file: "Late File 2" })), 400);
    const routed0 = await pending0;
    const s0 = JSON.parse(firstText(routed0)) as { connected?: boolean; pong?: boolean; file?: string; clients?: Array<{ file?: string | null }> };
    ok("figma_status with a NAMED client and NOTHING yet connected waits for that window and answers connected:true with its pong and roster (took " + (Date.now() - t2) + " ms)",
      !routed0.isError && s0.connected === true && s0.pong === true && s0.file === "Late File 2" &&
      Array.isArray(s0.clients) && s0.clients.some((c) => c.file === "Late File 2") && Date.now() - t2 < 5000);
    late2.close();
    await new Promise((r) => setTimeout(r, 200));
    const t3 = Date.now();
    const bare0 = await client.callTool({ name: "figma_status", arguments: { client: "c9" } });
    ok("figma_status with a bare connId and nothing connected is refused at once like every other tool (no wait, not connected:false)",
      bare0.isError === true && Date.now() - t3 < 2000);
  } catch (e) {
    ok("MCP smoke run completed without throwing — " + (e instanceof Error ? e.message : e), false);
  } finally {
    await client.close().catch(() => {});
  }
  report();
})();
