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

    // [M4] design_drift_lint with NO arguments on a `dtwin init` project: the map defaults to the project
    // layout's design/codeconnect.local.json and the export to design/export (like the CLI), not to a root
    // codeconnect.local.json and a bare design/. Its own server, started in that project.
    {
      const proj = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-mcp-layout-"));
      const ex = path.join(proj, "design", "export");
      fs.mkdirSync(path.join(ex, "design-system"), { recursive: true });
      fs.writeFileSync(path.join(ex, "design-system.json"), JSON.stringify({ files: { componentsLocal: "design-system/components.local.json" } }));
      fs.writeFileSync(path.join(ex, "design-system", "components.local.json"), JSON.stringify({ exportedAt: new Date().toISOString(), components: [{ key: "k-row", id: "1:1", name: "Row", type: "COMPONENT" }] }));
      const mapFile = path.join(proj, "design", "codeconnect.local.json");
      fs.writeFileSync(mapFile, JSON.stringify({ version: 1, components: { "k-row": { figma: { key: "k-row", name: "Row" }, code: { module: "src/ui/Row.tsx", export: "Row" } } } }));
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "FIGMA_EXPORT_DIR") env[k] = v;
      const tl = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(import.meta.dirname, "..", "bridge", "src", "figma-mcp.ts")],
        env: { ...env, FIGMA_BRIDGE_PORT: "8789", FIGMA_BRIDGE_TOKEN: "smoke-test-token", MAX_MCP_OUTPUT_TOKENS: "" },
        cwd: proj,
        stderr: "ignore",
      });
      const cl = new Client({ name: "mcp-smoke-layout", version: "0.0.0" });
      try {
        await cl.connect(tl);
        const r = await cl.callTool({ name: "design_drift_lint", arguments: {} });
        const text = firstText(r);
        ok("[M4] no-argument design_drift_lint on a design/export + design/codeconnect.local.json project → ok", r.isError !== true && /"ok":\s*true/.test(text));
        fs.rmSync(mapFile);
        const miss = await cl.callTool({ name: "design_drift_lint", arguments: {} });
        const missText = firstText(miss);
        ok("[M4] …and with no map, the error and its scaffold hint name design/codeconnect.local.json",
          miss.isError === true && /map-bootstrap\.ts <componentsLocal> > design[/\\]codeconnect\.local\.json/.test(missText));
      } finally {
        await cl.close().catch(() => {});
        fs.rmSync(proj, { recursive: true, force: true });
      }
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
    // Review 1 L-2: the limit is already at the 48,000-char cap, so the hint must not say the variable raises it.
    ok("[L-2] the size message says MAX_MCP_OUTPUT_TOKENS can only lower the limit (it never raises it past the cap)",
      /MAX_MCP_OUTPUT_TOKENS can only lower this/.test(firstText(refused)) && !/raises it/.test(firstText(refused)) && !/raises it/.test(idx.note));

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

    // ---- group 14 (CLI/MCP parity). Two fake plugins that identify themselves: "Sample App" answers the
    // exports, "Acme Kit" only whoami. Every check reads the result defensively, so a server from before
    // these fixes fails them with ✗ instead of throwing.
    {
      const rec = (x: unknown): Record<string, unknown> => (x && typeof x === "object" && !Array.isArray(x) ? { ...x } : {});
      const parse = (r: JsonRpcReply): Record<string, unknown> => { try { return rec(JSON.parse(firstText(r)) as unknown); } catch { return {}; } };
      const frames: Array<{ who: string; m: Record<string, unknown> }> = [];
      let rows = 3;
      let hang = false;
      // A 4×3 PNG's signature + IHDR: all pngSize reads.
      const png = Buffer.alloc(33);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
      png.writeUInt32BE(13, 8); png.write("IHDR", 12, "ascii"); png.writeUInt32BE(4, 16); png.writeUInt32BE(3, 20); png[24] = 8; png[25] = 6;
      const fake = async (file: string, instanceId: string): Promise<WebSocket> => {
        const ws = new WebSocket("ws://127.0.0.1:8789/?token=smoke-test-token", { origin: "null" });
        ws.on("message", (raw: RawData) => {
          const m = rec(JSON.parse(String(raw)) as unknown);
          frames.push({ who: file, m });
          const id = m.id, cmd = m.cmd;
          if (typeof cmd !== "string") return;
          const answer = (result: unknown) => ws.send(JSON.stringify({ id, ok: true, result }));
          if (cmd === "whoami") return answer({ instanceId, file, fileKey: null, page: "Page", pluginVersion: null });
          if (cmd === "ping") return answer({ pong: true, page: "Page", file });
          if (cmd === "exportFull") return ws.send(JSON.stringify({ id, ok: false, error: "smoke: page args captured" }));
          if (cmd === "screenshot") {
            return answer({ id: "9:1", name: "Shot", type: "FRAME", reference: "refs/Shot_ref.png", manifest: { nodes: 1 }, w: 1440, h: 1236, scale: 1.4222,
              assets: [{ id: "9:1", name: "Shot", format: "png", kind: "reference", file: "Shot_ref.png", base64: png.toString("base64") }] });
          }
          if (cmd !== "exportNode" || hang) return;
          const children = Array.from({ length: rows }, (_, i) => ({ id: "9:" + (i + 10), name: "Row " + i, type: "FRAME", box: { x: 0, y: i * 40, w: 390, h: 40 }, fills: [{ type: "solid", color: "#ffffff" }] }));
          answer({ screenName: "Sample", nodeId: "9:1", page: "Page", pageId: "0:1",
            screen: { exportedAt: "2026-10-07T00:00:00.000Z", screen: "Sample", manifest: { nodes: rows + 1 }, nodes: [{ id: "9:1", name: "Sample", type: "FRAME", box: { x: 0, y: 0, w: 390, h: 844 }, children }] },
            variables: { collections: [], variables: [], hygiene: [] }, assets: [] });
        });
        await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
        ws.send(JSON.stringify({ type: "hello", instanceId, file }));
        return ws;
      };
      const p1 = await fake("Sample App", "fig-sample");
      const p2 = await fake("Acme Kit", "fig-acme");
      await new Promise((r) => setTimeout(r, 200));
      const roster = parse(await client.callTool({ name: "figma_list_clients", arguments: {} }));
      const rosterRows = Array.isArray(roster.clients) ? roster.clients.map(rec) : [];
      const c2 = rosterRows.find((c) => c.file === "Acme Kit")?.connId;
      const c1 = rosterRows.find((c) => c.file === "Sample App")?.connId;

      // [WHO-2] DT-03/F-01: whoami's `connection` is the socket that answered, not the first one connected.
      const who = parse(await client.callTool({ name: "figma_whoami", arguments: { client: String(c2) } }));
      ok("[WHO-2] figma_whoami {client: c2} → connection.connId is c2 (not the first connected file)",
        typeof c2 === "string" && c1 !== c2 && rec(who.plugin).file === "Acme Kit" && rec(who.connection).connId === c2);

      // [L5-1] written export carries sourceFile (screen JSON + pages/index.json row); [F27-1] durationMs.
      const exportDir = path.join(CWD, "design", "export");
      const wrote = parse(await client.callTool({ name: "figma_export_url", arguments: { url: "9:1", client: "Sample App", writeToDisk: true } }));
      const screenFile = String(rec(wrote.wrote).screen ?? "");
      const readJ = (f: string): Record<string, unknown> => { try { return rec(JSON.parse(fs.readFileSync(f, "utf8")) as unknown); } catch { return {}; } };
      const rootRows = (): Array<Record<string, unknown>> => { const l = readJ(path.join(exportDir, "pages", "index.json")).layers; return Array.isArray(l) ? l.map(rec) : []; };
      ok("[L5-1] an MCP-written screen export carries sourceFile (the screen JSON and its pages/index.json row)",
        screenFile.endsWith("Sample__9_1.json") && readJ(screenFile).sourceFile === "Sample App" && rootRows().some((r) => r.id === "9:1" && r.sourceFile === "Sample App"));
      const dur = (x: Record<string, unknown>) => rec(x.durationMs);
      const wd = dur(wrote);
      ok("[F27-1] a written export result carries durationMs {total ≥ request ≥ 0, write ≥ 0}",
        typeof wd.total === "number" && typeof wd.request === "number" && typeof wd.write === "number" && wd.total >= wd.request && wd.request >= 0 && wd.write >= 0);
      // [L5-2] + [F27-1] inline.
      const inline = parse(await client.callTool({ name: "figma_export_url", arguments: { url: "9:1", client: "Sample App" } }));
      const id2 = dur(inline);
      ok("[L5-2] an INLINE export result carries sourceFile too", rec(inline.screen).screen === "Sample" && inline.sourceFile === "Sample App");
      ok("[F27-1] …and durationMs at its top level", typeof id2.total === "number" && typeof id2.request === "number" && id2.total >= id2.request && id2.request >= 0);

      // [F06-1] an IMPLICIT spill over a differing screen keeps <screen>.json.prev and names it.
      fs.writeFileSync(screenFile, JSON.stringify({ marker: "hand-edited", nodes: [] }));
      rows = 1500;
      const spill = parse(await client.callTool({ name: "figma_export_url", arguments: { url: "9:1", client: "Sample App" } }));
      const prevFile = screenFile + ".prev";
      ok("[F06-1] an implicit spill keeps the replaced screen as <screen>.json.prev, and the note names both",
        /WITHOUT being asked/.test(String(spill.note)) && fs.existsSync(prevFile) && /hand-edited/.test(fs.readFileSync(prevFile, "utf8")) &&
        String(spill.note).includes(prevFile) && String(spill.note).includes(screenFile) && rec(spill.wrote).prev === prevFile);
      ok("[F27-1] …and the spilled result carries durationMs too", typeof dur(spill).write === "number");
      // [F07-1] figma_status: lastWrite (this session) + lastScreenExport (disk).
      const st = parse(await client.callTool({ name: "figma_status", arguments: { client: "Sample App" } }));
      const lw = rec(st.lastWrite), lse = rec(st.lastScreenExport);
      ok("[F07-1] figma_status reports lastWrite {tool, implicit:true, file, prev} for that spill",
        lw.tool === "figma_export_url" && lw.implicit === true && lw.file === screenFile && lw.prev === prevFile && typeof lw.at === "string");
      ok("[F07-1] …and lastScreenExport from pages/index.json (id 9:1, its sourceFile)", lse.id === "9:1" && lse.sourceFile === "Sample App" && typeof lse.ageMs === "number");
      // [L-4] re-spilling the SAME design keeps no new .prev, but the note and lastWrite still name the one from before.
      const respill = parse(await client.callTool({ name: "figma_export_url", arguments: { url: "9:1", client: "Sample App" } }));
      const lw2 = rec(rec(parse(await client.callTool({ name: "figma_status", arguments: { client: "Sample App" } }))).lastWrite);
      ok("[L4-1] a re-spill of an unchanged design leaves the original .prev alone and the note names it",
        /hand-edited/.test(((): string => { try { return fs.readFileSync(prevFile, "utf8"); } catch { return ""; } })()) && rec(respill.wrote).prev === undefined && String(respill.note).includes(`An earlier version is still at ${prevFile}`));
      ok("[L4-1] …and lastWrite.prev names it", lw2.implicit === true && lw2.prev === prevFile);
      // [F06-2] an EXPLICIT pull over the same file keeps nothing (by design).
      fs.rmSync(prevFile, { force: true });
      fs.writeFileSync(screenFile, JSON.stringify({ marker: "hand-edited-2", nodes: [] }));
      const explicit = parse(await client.callTool({ name: "figma_export_url", arguments: { url: "9:1", client: "Sample App", writeToDisk: true } }));
      ok("[F06-2] an explicit writeToDisk:true overwrite keeps no .prev", rec(explicit.wrote).screen === screenFile && !fs.existsSync(prevFile) && !/kept at/.test(String(explicit.note)));
      rows = 3;

      // [SHOT-3] DT-06: the written screenshot result carries the node size, render scale and PNG size.
      const shot = parse(await client.callTool({ name: "figma_screenshot", arguments: { nodeId: "9:1", client: "Sample App", writeToDisk: true } }));
      ok("[SHOT-3] figma_screenshot writeToDisk → w/h/scale from the plugin and png:{w,h} from the bytes",
        shot.w === 1440 && shot.h === 1236 && shot.scale === 1.4222 && rec(shot.png).w === 4 && rec(shot.png).h === 3);

      // [D87] tolerant arrays: `page` as a JSON-encoded string or a bare string reaches the plugin as an array;
      // the advertised schema stays type:array.
      const pageArgs = async (page: unknown): Promise<unknown> => {
        const n = frames.length;
        await client.callTool({ name: "figma_export_full", arguments: { page, client: "Sample App" } });
        const f = frames.slice(n).find((x) => x.m.cmd === "exportFull");
        return f ? rec(f.m.args).page : "not sent";
      };
      const asJson = await pageArgs('["0:1","0:2"]');
      const bareStr = await pageArgs("0:1");
      ok("[D87] page as a JSON-encoded array string reaches the plugin as that array", JSON.stringify(asJson) === '["0:1","0:2"]');
      ok("[D87] page as a bare string reaches the plugin as a one-element array", JSON.stringify(bareStr) === '["0:1"]');
      // Review 1 L-1: a bare page name that starts with "[" but is not a JSON array is still one name.
      const bracketed = await pageArgs("[WIP] Screens");
      const bracketedObj = await pageArgs('["unclosed"');
      ok(`[L-1] a bare page name starting with "[" ("[WIP] Screens") reaches the plugin as a one-element array (got ${JSON.stringify(bracketed)})`,
        JSON.stringify(bracketed) === '["[WIP] Screens"]' && JSON.stringify(bracketedObj) === '["[\\"unclosed\\""]');
      const { tools: tools2 } = await client.listTools();
      const prop = (tool: string, key: string): Record<string, unknown> => rec(rec(tools2.find((t) => t.name === tool)?.inputSchema.properties)[key]);
      ok("[D87] listTools still advertises page and screens as type:array of strings",
        prop("figma_export_full", "page").type === "array" && rec(prop("figma_export_full", "page").items).type === "string" &&
        prop("design_drift_lint", "screens").type === "array" && rec(prop("design_drift_lint", "screens").items).type === "string");

      // [F30-1] design_drift_lint `screens` = the CLI's --screen: 2 instances, one mapped → 1/2, 50%.
      fs.writeFileSync(path.join(CWD, "ddl", "s.json"), JSON.stringify({ nodes: [{ id: "5:1", type: "FRAME", name: "S", children: [
        { id: "5:2", type: "INSTANCE", name: "Row", mainComponent: { key: "k-local", name: "Row" } },
        { id: "5:3", type: "INSTANCE", name: "Other", mainComponent: { key: "k-other", name: "Other" } },
      ] }] }));
      fs.writeFileSync(path.join(CWD, "ddl", "not-a-screen.json"), JSON.stringify({ hello: 1 }));
      const lintS = async (screens: unknown) => client.callTool({ name: "design_drift_lint", arguments: { map: "lib-map.json", exportDir: "ddl", screens } });
      const cov = rec(parse(await lintS(["ddl/s.json"])).screenCoverage);
      ok("[F30-1] design_drift_lint screens:[…] → screenCoverage inMap 1 / distinct 2 / mapPct 50, with the unmapped warning",
        cov.inMap === 1 && cov.distinct === 2 && cov.mapPct === 50 && Array.isArray(cov.warnings) && cov.warnings.some((w) => rec(w).code === "screen-coverage" && /'Other' \(1x\)/.test(String(rec(w).message))));
      ok("[F30-1] …the same through a JSON-encoded string (D87)", rec(parse(await lintS('["ddl/s.json"]')).screenCoverage).mapPct === 50);
      const notScreen = await lintS(["ddl/not-a-screen.json"]);
      ok("[F30-1] a non-screen file is a tool error naming it (the server stays up)", notScreen.isError === true && /not-a-screen\.json is not a screen export/.test(firstText(notScreen)));

      // [CANCEL-1] D82: a cancelled tool call cancels the plugin's request (notifications/cancelled →
      // extra.signal → server-core's cancel frame).
      hang = true;
      const ac = new AbortController();
      const n0 = frames.length;
      const cancelled = client.callTool({ name: "figma_export_url", arguments: { url: "9:1", client: "Sample App" } }, undefined, { signal: ac.signal }).catch(() => "aborted");
      await new Promise((r) => setTimeout(r, 300));
      const sentId = frames.slice(n0).find((f) => f.m.cmd === "exportNode")?.m.id;
      ac.abort();
      await cancelled;
      await new Promise((r) => setTimeout(r, 300));
      ok("[CANCEL-1] an aborted figma_export_url → the plugin receives {type:\"cancel\"} for that request",
        typeof sentId === "string" && frames.slice(n0).some((f) => f.m.type === "cancel" && f.m.id === sentId));

      // [CANCEL-3] D82 via a daemon: a second MCP server shares this one's bridge through the daemon socket;
      // its cancelled call closes that socket, the daemon abandons the request, and the plugin is told.
      {
        const transport3 = new StdioClientTransport({
          command: process.execPath,
          args: [path.join(import.meta.dirname, "..", "bridge", "src", "figma-mcp.ts")],
          env: { ...process.env, FIGMA_BRIDGE_PORT: "8789", FIGMA_BRIDGE_TOKEN: "smoke-test-token", MAX_MCP_OUTPUT_TOKENS: "" },
          cwd: CWD,
          stderr: "ignore",
        });
        const client3 = new Client({ name: "mcp-smoke-3", version: "0.0.0" });
        try {
          await client3.connect(transport3);
          const ac3 = new AbortController();
          const n3 = frames.length;
          const viaCall = client3.callTool({ name: "figma_export_url", arguments: { url: "9:1", client: "Sample App" } }, undefined, { signal: ac3.signal }).catch(() => "aborted");
          const until = Date.now() + 3000;
          while (Date.now() < until && !frames.slice(n3).some((f) => f.m.cmd === "exportNode")) await new Promise((r) => setTimeout(r, 50));
          const sentId3 = frames.slice(n3).find((f) => f.m.cmd === "exportNode")?.m.id;
          ac3.abort();
          await viaCall;
          const until2 = Date.now() + 1500;
          while (Date.now() < until2 && !frames.slice(n3).some((f) => f.m.type === "cancel" && f.m.id === sentId3)) await new Promise((r) => setTimeout(r, 50));
          ok("[CANCEL-3] an aborted call on a DAEMON-ROUTED session → the plugin receives {type:\"cancel\"} for that request",
            typeof sentId3 === "string" && frames.slice(n3).some((f) => f.m.type === "cancel" && f.m.id === sentId3));
        } finally {
          await client3.close().catch(() => {});
        }
      }

      // [CANCEL-2] D82 amendment: the client going away (stdin end) aborts the in-flight request too — the
      // SDK's stdio transport does not notice stdin ending. client.close() ends stdin and waits 2 s before
      // SIGTERM, so a cancel frame inside that window can only come from the stdin watch.
      const n1 = frames.length;
      void client.callTool({ name: "figma_export_url", arguments: { url: "9:1", client: "Sample App" } }).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      const sentId2 = frames.slice(n1).find((f) => f.m.cmd === "exportNode")?.m.id;
      const tClose = Date.now();
      const closing = client.close().catch(() => {});
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline && !frames.slice(n1).some((f) => f.m.type === "cancel" && f.m.id === sentId2)) await new Promise((r) => setTimeout(r, 50));
      ok("[CANCEL-2] stdin closing (the client exited) → the plugin receives {type:\"cancel\"} for the in-flight request (within " + (Date.now() - tClose) + " ms)",
        typeof sentId2 === "string" && frames.slice(n1).some((f) => f.m.type === "cancel" && f.m.id === sentId2));
      await closing;
      p1.close();
      p2.close();
    }
  } catch (e) {
    ok("MCP smoke run completed without throwing — " + (e instanceof Error ? e.message : e), false);
  } finally {
    await client.close().catch(() => {});
  }
  report();
})();
