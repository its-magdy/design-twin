// Behavioural smoke test for the MCP server: boot the REAL bridge/src/figma-mcp.ts over stdio with the
// SDK's own client, list its tools, and call the ones that need no Figma connection.
//   bun test/mcp-smoke.test.ts
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
// The plugin stand-in — see fake-plugin.ts.
import { fakePlugin, fail, HANG, type FakePlugin } from "./fake-plugin.ts";
import { malformed } from "./fixtures.ts";
import { EDITS_OFF_MESSAGE } from "../bridge/src/commands.ts";
import type { PingReply, ScreenReply, ScreenshotReply, WhoamiReply, WriteResult } from "../bridge/src/commands.ts";
import type { BridgeFrame, CommandFrame } from "../bridge/src/server-core.ts";
// Type-only: erased before Bun runs this file, so the server module is NOT imported here (it is
// booted as a subprocess below — importing it would start a real bridge + stdio transport).
import type { GetComponentModule, DriftLintModule } from "../bridge/src/figma-mcp.ts";
import type * as GetComponentMod from "../design-to-code/get-component.ts";
import type * as DriftLintMod from "../design-to-code/drift-lint.ts";
import { isUnknownArray } from "../bridge/src/json-util.ts";
import { LAYER, missingHints } from "../bridge/pack.ts";
import { MCP_TOOLS, planeOf } from "../bridge/src/mcp-tools.ts";
import { setTimeout as sleep } from "node:timers/promises";

// Compile-time only. figma-mcp.ts declares its OWN view of the two design-to-code modules it loads
// lazily (it cannot reference them: the bridge package ships bridge/src and, in place of the layer, bundles of it). Nothing else ties those local interfaces to
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
// figma_write's dryRun result — figma-mcp.ts previewWrites() (an inferred return type, not exported): the fields read below.
interface WritePreview { dryRun: boolean; applied: boolean; creates: number; overwrites: number; invalid: number; steps: Array<{ target: string | null; invalid?: string }>; editsAllowed: boolean | null; wouldRefuse?: string; note: string }
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
    const bridgePkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "bridge", "package.json"), "utf8")) as { version: string };
    ok("the server reports its name and the package's own version (not a literal that drifts)",
      client.getServerVersion()?.name === "designtwin" && client.getServerVersion()?.version === bridgePkg.version);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    ok(`lists exactly MCP_TOOLS, in its order (${MCP_TOOLS.length})`, names.join() === MCP_TOOLS.map((t) => t.name).join());
    ok("each tool's readOnlyHint is its plane in MCP_TOOLS", tools.every((t) => (t.annotations?.readOnlyHint === true) === (planeOf(t.name) === "read")));
    ok("every tool has a description and an object input schema", tools.every((t) => t.description && t.inputSchema && t.inputSchema.type === "object"));
    const write = tools.find((t) => t.name === "figma_write");
    if (!write) throw new Error("figma_write is not listed");
    ok("figma_write is the ONLY non-read-only tool, and is marked destructive", write.annotations?.destructiveHint === true && write.annotations.readOnlyHint === false
      && tools.filter((t) => !(t.annotations && t.annotations.readOnlyHint)).map((t) => t.name).join() === "figma_write");
    ok("figma_write exposes dryRun", !!write.inputSchema.properties?.dryRun);

    const dry = await client.callTool({ name: "figma_write", arguments: { dryRun: true, ops: [{ op: "createFrame", name: "Card" }, { op: "setFill", nodeId: "1:2", color: "#ff0000" }, { op: "setText", nodeId: "1:3" }] } });
    const preview = JSON.parse(firstText(dry)) as WritePreview;
    ok("dryRun previews without a plugin connected, and applies nothing", !dry.isError && preview.dryRun === true && preview.applied === false);
    ok("…and with no plugin connected it cannot tell whether edits are allowed (editsAllowed:null), without waiting for one", preview.editsAllowed === null && preview.wouldRefuse === undefined);
    ok("dryRun separates creates from overwrites and flags an invalid op", preview.creates === 1 && preview.overwrites === 2 && preview.invalid === 1 && preview.steps[1]?.target === "1:2" && /missing text/.test(preview.steps[2]?.invalid ?? ""));

    const bad = await client.callTool({ name: "figma_write", arguments: { ops: [{ op: "deleteEverything" }] } }).catch((e: unknown) => ({ isError: true, thrown: String(e instanceof Error ? e.message : e) }));
    ok("an op outside the four implemented ones is rejected at the schema boundary", bad.isError === true);

    // fill / color are hex colours: a name or a malformed value is refused at the schema, not painted as a wrong colour.
    const callWrite = async (op: object): Promise<{ isError: boolean; text: string }> => {
      try {
        const r = await client.callTool({ name: "figma_write", arguments: { dryRun: true, ops: [op] } });
        return { isError: r.isError === true, text: firstText(r) };
      } catch (e) { return { isError: true, text: String(e instanceof Error ? e.message : e) }; }
    };
    const badFill = await callWrite({ op: "createFrame", fill: "red" });
    ok("figma_write refuses a colour name as a fill, naming the expected form", badFill.isError && /hex colour like #1A2B3C/.test(badFill.text));
    const badColor = await callWrite({ op: "setFill", nodeId: "1:2", color: "#12" });
    ok("figma_write refuses a malformed setFill color", badColor.isError && /hex colour like #1A2B3C/.test(badColor.text));
    ok("figma_write refuses a bare-digit colour and a createText fill that is not hex",
      (await callWrite({ op: "setFill", nodeId: "1:2", color: "ff0000" })).isError && (await callWrite({ op: "createText", text: "x", fill: "#gggggg" })).isError);
    ok("figma_write still accepts #rgb, #rgba, #rrggbb and #rrggbbaa", (await Promise.all(["#f00", "#f008", "#FF0000", "#ff000080"].map((c) => callWrite({ op: "setFill", nodeId: "1:2", color: c })))).every((r) => !r.isError));
    ok("figma_write accepts fill \"\" (no fill) on createFrame/createText but refuses color \"\" on setFill",
      !(await callWrite({ op: "createFrame", fill: "" })).isError && !(await callWrite({ op: "createText", text: "x", fill: "" })).isError &&
      (await callWrite({ op: "setFill", nodeId: "1:2", color: "" })).isError);
    ok("figma_write's published schema carries the hex pattern for fill and color", (() => {
      const item = JSON.stringify(write.inputSchema.properties?.ops);
      return /"fill":\{[^}]*"pattern"/.test(item) && /"color":\{[^}]*"pattern"/.test(item);
    })());

    const status = await client.callTool({ name: "figma_status", arguments: {} });
    ok("figma_status answers with no plugin connected (no hang, parseable JSON)", (() => { try { JSON.parse(firstText(status)) as unknown; return true; } catch { return false; } })());

    // design_drift_lint is the CLI's own run (design-to-code/drift-lint.ts runDriftLint — test/drift-lint-run.test.ts
    // checks the run and the CLI/tool parity). Here only the wiring over stdio: a run that is not linted is a tool
    // error carrying the run's message, a linted one a normal result.
    {
      const ex = path.join(CWD, "ddl");
      fs.mkdirSync(path.join(ex, "design-system"), { recursive: true });
      fs.writeFileSync(path.join(ex, "design-system.json"), JSON.stringify({ files: { componentsLocal: "design-system/components.local.json" } }));
      fs.writeFileSync(path.join(ex, "design-system", "components.local.json"), JSON.stringify({ exportedAt: new Date().toISOString(), components: [{ key: "k-local", id: "1:1", name: "Row", type: "COMPONENT" }] }));
      fs.writeFileSync(path.join(CWD, "lib-map.json"), JSON.stringify({ version: 1, components: { "k-local": { figma: { key: "k-local", name: "Row" }, code: { module: "src/ui/Row.tsx", export: "Row" } } } }));
      fs.writeFileSync(path.join(CWD, "bad-map.json"), JSON.stringify({ components: "not-an-object", bogus: 1 }));
      const invalid = await client.callTool({ name: "design_drift_lint", arguments: { map: "bad-map.json", exportDir: "ddl" } });
      ok("design_drift_lint: an invalid map is a tool error mentioning map-invalid", invalid.isError === true && /\[map-invalid\]/.test(firstText(invalid)) && /not a valid component map/.test(firstText(invalid)));
      const good = await client.callTool({ name: "design_drift_lint", arguments: { map: "lib-map.json", exportDir: "ddl" } });
      ok("design_drift_lint: a clean map is a normal result with ok:true and the catalogs read", good.isError !== true && /"ok":\s*true/.test(firstText(good)) && /"catalogsRead"/.test(firstText(good)));
    }

    // design_drift_lint with NO arguments on a `dtwin init` project: the map defaults to the project
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
        ok("no-argument design_drift_lint on a design/export + design/codeconnect.local.json project → ok", r.isError !== true && /"ok":\s*true/.test(text));
        fs.rmSync(mapFile);
        const miss = await cl.callTool({ name: "design_drift_lint", arguments: {} });
        const missText = firstText(miss);
        ok("…and with no map, the error and its scaffold hint name design/codeconnect.local.json",
          miss.isError === true && /map-bootstrap\.ts["']? <components\.local\.json> --out ["']?[^"'\n]*design[/\\]codeconnect\.local\.json/.test(missText));
      } finally {
        await cl.close().catch(() => {});
        fs.rmSync(proj, { recursive: true, force: true });
      }
    }

    // design_get_component / design_drift_lint read the export's component catalog through export-reader.ts
    // readComponentCatalog (test/export-reader.test.ts checks pre-split, split, missing pointer and pointer-outside-
    // the-export). Here only the wiring: the reader's refusal is the tool error, an older export's inline
    // components[] is read as `dtwin seed` reads it, and an exportDir outside the server's directory is refused.
    {
      const dsx = path.join(CWD, "dsx");
      fs.mkdirSync(dsx, { recursive: true });
      const get = async (manifest: string, exportDir = "dsx") => {
        fs.writeFileSync(path.join(dsx, "design-system.json"), manifest);
        const r = await client.callTool({ name: "design_get_component", arguments: { handle: "Btn", exportDir } });
        return { isError: r.isError === true, text: firstText(r) };
      };
      const nul = await get("null");
      ok("design_get_component: the reader's refusal is the tool error", nul.isError && /is not a design-system manifest/.test(nul.text));
      const inline = await get(JSON.stringify({ exportedAt: new Date().toISOString(), components: [{ key: "k-old", id: "1:1", name: "Btn" }] }));
      ok(`design_get_component: an older export's inline components[] resolves (got ${inline.text.slice(0, 160)})`, !inline.isError && /"k-old"/.test(inline.text));
      fs.writeFileSync(path.join(CWD, "old-map.json"), JSON.stringify({ version: 1, components: { "k-old": { figma: { key: "k-old", name: "Btn" }, code: { module: "src/ui/Btn.tsx", export: "Btn" } } } }));
      const lint = await client.callTool({ name: "design_drift_lint", arguments: { map: "old-map.json", exportDir: "dsx" } });
      ok(`design_drift_lint: an older export's inline components[] is linted (got ${firstText(lint).slice(0, 160)})`, lint.isError !== true && /"ok":\s*true/.test(firstText(lint)));
      fs.writeFileSync(path.join(dsx, "components.local.json"), JSON.stringify({ components: [{ key: "k1", id: "1:1", name: "Btn" }] }));
      const good = await get(JSON.stringify({ files: { componentsLocal: "components.local.json" } }));
      ok("design_get_component: a split export resolves through its pointer (control)", !good.isError && /"k1"/.test(good.text));
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-mcp-outside-"));
      const esc = await client.callTool({ name: "design_get_component", arguments: { handle: "Btn", exportDir: outside } });
      ok("design_get_component: an exportDir outside the server directory is refused",
        esc.isError === true && /exportDir must stay inside the directory this server was started in/.test(firstText(esc)));
    }

    // ---- the inline size guard, end to end, with a fake plugin answering the export.
    // It never identifies (no hello), and answers exportSelection only: every other command is left unanswered.
    let kids = 3;
    let ticks = 0; // progress frames to send before the reply, as ui.html relays a bridge-triggered run's
    let burst = false;
    const plugin = fakePlugin(8789, { token: "smoke-test-token", hello: false, unhandled: HANG, on: { exportSelection: (_args, ctx) => {
      for (let i = 1; i <= ticks; i++) ctx.progress({ phase: "pages", page: { index: i, of: ticks, name: "P" + i }, nodes: i * 10 });
      const children = Array.from({ length: kids }, (_, i) => ({ id: "9:" + i, name: "Row " + i, type: "FRAME", box: { x: 0, y: i * 40, w: 390, h: 40 }, fills: [{ type: "solid", color: "#ffffff" }] }));
      // The REAL exportSelection shape (figma-plugin/src/collect.ts screenResult) — the bridge now
      // checks every reply against commands.ts before a tool sees it.
      // Not a full ScreenReply on purpose: its screen manifest carries only `nodes`.
      const screen = { exportedAt: "2026-09-21T00:00:00Z", screen: "Big", manifest: { nodes: kids + 1 }, nodes: [{ id: "9:999", name: "Big", type: "FRAME", box: { x: 0, y: 0, w: 390, h: 844 }, children }] };
      const result = malformed<ScreenReply>({ screenName: "Big", screen, variables: { collections: [], variables: [], hygiene: [] }, assets: [] });
      // `burst` = the WORST timing: every tick and the reply in the same event-loop turn. Otherwise
      // the reply trails the ticks by 50 ms (a real run's ticks are >=250 ms apart and long before
      // its reply). The SDK CLIENT (1.30: Protocol._onnotification dispatches on a microtask,
      // _onresponse deletes the progress handler synchronously) drops a notification that shares a
      // stdout read chunk with the response, so `onprogress` delivery is only asserted with the
      // delay; the burst case asserts what the SERVER owns — the order on the wire.
      if (ticks && !burst) return new Promise<ScreenReply>((res) => { setTimeout(() => res(result), 50); });
      return result;
    } } });
    await plugin.opened;
    const small = await client.callTool({ name: "figma_export_selection", arguments: {} });
    ok("a small export still comes back INLINE", !small.isError && (JSON.parse(firstText(small)) as ScreenReply).screen.nodes[0]?.children?.length === 3);
    kids = 1500; // ~200 KB of indented JSON — far past the 25k-token default
    const big = await client.callTool({ name: "figma_export_selection", arguments: {} });
    const idx = JSON.parse(firstText(big)) as WrittenExport;
    ok("an export past the client's output cap is written to disk on its own, and the result says why", !big.isError && firstText(big).length < 8000 && /WITHOUT being asked/.test(idx.note) && /k tokens/.test(idx.note) && fs.existsSync(path.join(CWD, "design")));
    const refused = await client.callTool({ name: "figma_export_selection", arguments: { writeToDisk: false } });
    ok("…and an explicit writeToDisk:false is an error with the size, never a truncated result", refused.isError === true && /writeToDisk:false was passed/.test(firstText(refused)));
    // the limit is already at the 48,000-char cap, so the hint must not say the variable raises it.
    ok("the size message says MAX_MCP_OUTPUT_TOKENS can only lower the limit (it never raises it past the cap)",
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
      {
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
      }
    } finally {
      await client2.close().catch(() => {});
    }
    ticks = 0;

    // A NAMED `client` is waited for (figma-mcp.ts bridge.request, same bounded wait as `--client
    // <name>` in the CLI and the daemon): the fake plugin above never identified, so "Late File"
    // matches nothing when the call starts; a second window that says hello 400 ms later must be
    // routed to, not refused. A bare connId never waits: an unknown `c9` fails at once.
    const late = fakePlugin(8789, { token: "smoke-test-token", hello: false, unhandled: HANG, on: { ping: (): PingReply => ({ pong: true, page: "Cover", file: "Late File" }) } });
    await late.opened;
    const t0 = Date.now();
    const pending = client.callTool({ name: "figma_status", arguments: { client: "Late File" } });
    setTimeout(() => late.hello({ instanceId: "fig-late", file: "Late File" }), 400);
    const routed = await pending;
    const routedMs = Date.now() - t0;
    // With a `client`, figma_status pings first and lists the roster after (so the roster shows the
    // window the ping reached, identified); the ping's own `file` is the proof it was routed by name.
    const statusOf = (r: JsonRpcReply): { pong?: boolean; file?: string } => JSON.parse(firstText(r)) as { pong?: boolean; file?: string };
    ok("a NAMED client that lands after the call started is waited for and routed to (not refused on the first file that connected)",
      !routed.isError && late.commands("ping").length > 0 && statusOf(routed).pong === true && statusOf(routed).file === "Late File");
    ok("…and the wait ends as soon as the name matches, not at the 15 s window (took " + routedMs + " ms)", routedMs >= 300 && routedMs < 5000);
    const t1 = Date.now();
    const bare = await client.callTool({ name: "figma_status", arguments: { client: "c9" } });
    ok("a bare connId that nobody has is refused at once with the connected list (no wait)",
      bare.isError === true && /no connected Figma file matches 'c9'/.test(firstText(bare)) && /Late File/.test(firstText(bare)) && Date.now() - t1 < 2000);
    late.close();
    plugin.close();
    await sleep(200); // both sockets gone: the bridge has NO client now

    // ---- "Allow edits" (figma-plugin/src/edits.ts), as figma_write sees it. The fake plugin answers whoami with the
    // checkbox's state and refuses a write the way writes.ts does while it is off.
    let editsOn = false;
    const editsPlugin = fakePlugin(8789, { token: "smoke-test-token", hello: { instanceId: "fig-edits", file: "Edits File" }, unhandled: HANG, on: {
      whoami: (): WhoamiReply => ({ instanceId: "fig-edits", startedAt: 0, uptimeMs: 1, file: "Edits File", page: "Page", pageId: "0:1", editorType: "figma", pluginVersion: "0.0.0", fileKey: null, fileKeyAvailable: false, editsAllowed: editsOn }),
      write: (): WriteResult => editsOn ? { ok: true, applied: [{ id: "1:9" }] } : { ok: false, applied: [], refused: "edits-off", error: EDITS_OFF_MESSAGE },
    } });
    await editsPlugin.opened;
    const card = [{ op: "createFrame", name: "Card" }];
    const dryOff = JSON.parse(firstText(await client.callTool({ name: "figma_write", arguments: { dryRun: true, ops: card } }))) as WritePreview;
    ok("[EDITS] dryRun while edits are off still previews, and says a real write would be refused",
      dryOff.dryRun === true && dryOff.applied === false && dryOff.creates === 1 && dryOff.editsAllowed === false
      && dryOff.wouldRefuse === EDITS_OFF_MESSAGE && /would be REFUSED/.test(dryOff.note) && editsPlugin.commands("write").length === 0);
    const realOff = await client.callTool({ name: "figma_write", arguments: { ops: card } });
    ok("[EDITS] a write while edits are off is an error naming the fix (tick 'Allow edits'), not a generic failure",
      realOff.isError === true && firstText(realOff) === EDITS_OFF_MESSAGE && !/Write failed at op/.test(firstText(realOff)));
    editsOn = true;
    const dryOn = JSON.parse(firstText(await client.callTool({ name: "figma_write", arguments: { dryRun: true, ops: card } }))) as WritePreview;
    ok("[EDITS] dryRun with edits on reports editsAllowed:true and no refusal", dryOn.editsAllowed === true && dryOn.wouldRefuse === undefined);
    const realOn = await client.callTool({ name: "figma_write", arguments: { ops: card } });
    ok("[EDITS] a write with edits on is applied", !realOn.isError && (JSON.parse(firstText(realOn)) as WriteResult).applied[0]?.id === "1:9");
    editsPlugin.close();
    await sleep(200);

    // With NOTHING connected — every window mid-redial right after a bridge
    // restart — `figma_status {client:"<name>"}` must not answer `connected:false` in 10 ms: a zero-clients
    // early return would skip the named wait that bridge.request() gives every other tool. The ping
    // (and its wait) comes first. An early return fails the first check (no pong, connected:false) and the
    // second (a bare connId with nothing connected must give the refusal every other
    // tool gives, not `connected:false`).
    const t2 = Date.now();
    const pending0 = client.callTool({ name: "figma_status", arguments: { client: "Late File 2" } });
    const late2 = fakePlugin(8789, { token: "smoke-test-token", hello: false, unhandled: HANG, on: { ping: (): PingReply => ({ pong: true, page: "Cover", file: "Late File 2" }) } });
    await late2.opened;
    setTimeout(() => late2.hello({ instanceId: "fig-late-2", file: "Late File 2" }), 400);
    const routed0 = await pending0;
    const s0 = JSON.parse(firstText(routed0)) as { connected?: boolean; pong?: boolean; file?: string; clients?: Array<{ file?: string | null }> };
    ok("figma_status with a NAMED client and NOTHING yet connected waits for that window and answers connected:true with its pong and roster (took " + (Date.now() - t2) + " ms)",
      !routed0.isError && s0.connected === true && s0.pong === true && s0.file === "Late File 2" &&
      Array.isArray(s0.clients) && s0.clients.some((c) => c.file === "Late File 2") && Date.now() - t2 < 5000);
    late2.close();
    await sleep(200);
    const t3 = Date.now();
    const bare0 = await client.callTool({ name: "figma_status", arguments: { client: "c9" } });
    ok("figma_status with a bare connId and nothing connected is refused at once like every other tool (no wait, not connected:false)",
      bare0.isError === true && Date.now() - t3 < 2000);

    // ---- CLI/MCP parity. Two fake plugins that identify themselves: "Sample App" answers the
    // exports, "Acme Kit" only whoami. Every check reads the result defensively, so a server missing
    // a feature fails the check with ✗ instead of throwing.
    {
      const rec = (x: unknown): Record<string, unknown> => (x && typeof x === "object" && !Array.isArray(x) ? { ...x } : {});
      const parse = (r: JsonRpcReply): Record<string, unknown> => { try { return rec(JSON.parse(firstText(r)) as unknown); } catch { return {}; } };
      // What the bridge sent the two plugins: mark() is how many frames each has had so far, sentSince(n)
      // every frame either has had since (each plugin's own frames past its own count).
      const plugins: FakePlugin[] = [];
      const mark = (): number[] => plugins.map((p) => p.frames.length);
      const sentSince = (n: number[]): BridgeFrame[] => plugins.flatMap((p, i) => p.frames.slice(n[i] ?? 0).map((f) => f.frame));
      const isCmd = (f: BridgeFrame, cmd: string): f is CommandFrame => "cmd" in f && f.cmd === cmd;
      const isCancelOf = (f: BridgeFrame, id: unknown): boolean => "type" in f && f.type === "cancel" && f.id === id;
      let rows = 3;
      let hang = false;
      // A 4×3 PNG's signature + IHDR: all pngSize reads.
      const png = Buffer.alloc(33);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
      png.writeUInt32BE(13, 8); png.write("IHDR", 12, "ascii"); png.writeUInt32BE(4, 16); png.writeUInt32BE(3, 20); png[24] = 8; png[25] = 6;
      // Its replies are thin on purpose (a whoami with only its identity, manifests carrying only `nodes`);
      // a command it has no answer for — or exportNode while `hang` — is never answered.
      const fake = async (file: string, instanceId: string): Promise<FakePlugin> => {
        const p = fakePlugin(8789, {
          token: "smoke-test-token", hello: { instanceId, file }, unhandled: HANG,
          on: {
            whoami: () => malformed<WhoamiReply>({ instanceId, file, fileKey: null, page: "Page", pluginVersion: null }),
            ping: (): PingReply => ({ pong: true, page: "Page", file }),
            exportFull: () => fail("smoke: page args captured"),
            screenshot: () => malformed<ScreenshotReply>({ id: "9:1", name: "Shot", type: "FRAME", reference: "refs/Shot_ref.png", manifest: { nodes: 1 }, w: 1440, h: 1236, scale: 1.4222,
              assets: [{ id: "9:1", name: "Shot", format: "png", kind: "reference", file: "Shot_ref.png", base64: png.toString("base64") }] }),
            exportNode: () => {
              if (hang) return HANG;
              const children = Array.from({ length: rows }, (_, i) => ({ id: "9:" + (i + 10), name: "Row " + i, type: "FRAME", box: { x: 0, y: i * 40, w: 390, h: 40 }, fills: [{ type: "solid", color: "#ffffff" }] }));
              return malformed<ScreenReply>({ screenName: "Sample", nodeId: "9:1", page: "Page", pageId: "0:1",
                screen: { exportedAt: "2026-10-07T00:00:00.000Z", screen: "Sample", manifest: { nodes: rows + 1 }, nodes: [{ id: "9:1", name: "Sample", type: "FRAME", box: { x: 0, y: 0, w: 390, h: 844 }, children }] },
                variables: { collections: [], variables: [], hygiene: [] }, assets: [] });
            },
          },
        });
        plugins.push(p);
        await p.opened;
        return p;
      };
      const p1 = await fake("Sample App", "fig-sample");
      const p2 = await fake("Acme Kit", "fig-acme");
      await sleep(200);
      const roster = parse(await client.callTool({ name: "figma_list_clients", arguments: {} }));
      const rosterRows = Array.isArray(roster.clients) ? roster.clients.map(rec) : [];
      const c2 = rosterRows.find((c) => c.file === "Acme Kit")?.connId;
      const c1 = rosterRows.find((c) => c.file === "Sample App")?.connId;

      // whoami's `connection` is the socket that answered, not the first one connected.
      const who = parse(await client.callTool({ name: "figma_whoami", arguments: { client: String(c2) } }));
      ok("figma_whoami {client: c2} → connection.connId is c2 (not the first connected file)",
        typeof c2 === "string" && c1 !== c2 && rec(who.plugin).file === "Acme Kit" && rec(who.connection).connId === c2);

      // written export carries sourceFile (screen JSON + pages/index.json row); durationMs.
      const exportDir = path.join(CWD, "design", "export");
      const wrote = parse(await client.callTool({ name: "figma_export_url", arguments: { url: "9:1", client: "Sample App", writeToDisk: true } }));
      const screenFile = String(rec(wrote.wrote).screen ?? "");
      const readJ = (f: string): Record<string, unknown> => { try { return rec(JSON.parse(fs.readFileSync(f, "utf8")) as unknown); } catch { return {}; } };
      const rootRows = (): Array<Record<string, unknown>> => { const l = readJ(path.join(exportDir, "pages", "index.json")).layers; return Array.isArray(l) ? l.map(rec) : []; };
      ok("an MCP-written screen export carries sourceFile (the screen JSON and its pages/index.json row)",
        screenFile.endsWith("Sample__9_1.json") && readJ(screenFile).sourceFile === "Sample App" && rootRows().some((r) => r.id === "9:1" && r.sourceFile === "Sample App"));
      const dur = (x: Record<string, unknown>) => rec(x.durationMs);
      const wd = dur(wrote);
      ok("a written export result carries durationMs {total ≥ request ≥ 0, write ≥ 0}",
        typeof wd.total === "number" && typeof wd.request === "number" && typeof wd.write === "number" && wd.total >= wd.request && wd.request >= 0 && wd.write >= 0);
      // + inline.
      const inline = parse(await client.callTool({ name: "figma_export_url", arguments: { url: "9:1", client: "Sample App" } }));
      const id2 = dur(inline);
      ok("an INLINE export result carries sourceFile too", rec(inline.screen).screen === "Sample" && inline.sourceFile === "Sample App");
      ok("…and durationMs at its top level", typeof id2.total === "number" && typeof id2.request === "number" && id2.total >= id2.request && id2.request >= 0);

      // an IMPLICIT spill over a differing screen keeps <screen>.json.prev and names it.
      fs.writeFileSync(screenFile, JSON.stringify({ marker: "hand-edited", nodes: [] }));
      rows = 1500;
      const spill = parse(await client.callTool({ name: "figma_export_url", arguments: { url: "9:1", client: "Sample App" } }));
      const prevFile = screenFile + ".prev";
      ok("an implicit spill keeps the replaced screen as <screen>.json.prev, and the note names both",
        /WITHOUT being asked/.test(String(spill.note)) && fs.existsSync(prevFile) && /hand-edited/.test(fs.readFileSync(prevFile, "utf8")) &&
        String(spill.note).includes(prevFile) && String(spill.note).includes(screenFile) && rec(spill.wrote).prev === prevFile);
      ok("…and the spilled result carries durationMs too", typeof dur(spill).write === "number");
      // figma_status: lastWrite (this session) + lastScreenExport (disk).
      const st = parse(await client.callTool({ name: "figma_status", arguments: { client: "Sample App" } }));
      const lw = rec(st.lastWrite), lse = rec(st.lastScreenExport);
      ok("figma_status reports lastWrite {tool, implicit:true, file, prev} for that spill",
        lw.tool === "figma_export_url" && lw.implicit === true && lw.file === screenFile && lw.prev === prevFile && typeof lw.at === "string");
      ok("…and lastScreenExport from pages/index.json (id 9:1, its sourceFile)", lse.id === "9:1" && lse.sourceFile === "Sample App" && typeof lse.ageMs === "number");
      // The verdict on the export (export-verdict.ts, which test/export-verdict.test.ts checks) is what `snapshot` carries.
      const snap = rec(st.snapshot);
      ok(`…and \`snapshot\` is the export verdict: attributed to the screens' file, with its sources and staleness (got ${JSON.stringify(snap)})`,
        snap.sourceFile === "Sample App" && typeof snap.staleAfterMs === "number" && snap.stale === (Number(snap.ageMs) > snap.staleAfterMs)
        && Array.isArray(snap.sources) && snap.sources.map(rec).some((s) => s.kind === "screens" && s.sourceFile === "Sample App"));
      // re-spilling the SAME design keeps no new .prev, but the note and lastWrite still name the one from before.
      const respill = parse(await client.callTool({ name: "figma_export_url", arguments: { url: "9:1", client: "Sample App" } }));
      const lw2 = rec(rec(parse(await client.callTool({ name: "figma_status", arguments: { client: "Sample App" } }))).lastWrite);
      ok("a re-spill of an unchanged design leaves the original .prev alone and the note names it",
        /hand-edited/.test(((): string => { try { return fs.readFileSync(prevFile, "utf8"); } catch { return ""; } })()) && rec(respill.wrote).prev === undefined && String(respill.note).includes(`An earlier version is still at ${prevFile}`));
      ok("…and lastWrite.prev names it", lw2.implicit === true && lw2.prev === prevFile);
      // an EXPLICIT pull over the same file keeps nothing (by design).
      fs.rmSync(prevFile, { force: true });
      fs.writeFileSync(screenFile, JSON.stringify({ marker: "hand-edited-2", nodes: [] }));
      const explicit = parse(await client.callTool({ name: "figma_export_url", arguments: { url: "9:1", client: "Sample App", writeToDisk: true } }));
      ok("an explicit writeToDisk:true overwrite keeps no .prev", rec(explicit.wrote).screen === screenFile && !fs.existsSync(prevFile) && !/kept at/.test(String(explicit.note)));
      rows = 3;

      // the written screenshot result carries the node size, render scale and PNG size.
      const shot = parse(await client.callTool({ name: "figma_screenshot", arguments: { nodeId: "9:1", client: "Sample App", writeToDisk: true } }));
      ok("figma_screenshot writeToDisk → w/h/scale from the plugin and png:{w,h} from the bytes",
        shot.w === 1440 && shot.h === 1236 && shot.scale === 1.4222 && rec(shot.png).w === 4 && rec(shot.png).h === 3);

      // tolerant arrays: `page` as a JSON-encoded string or a bare string reaches the plugin as an array;
      // the advertised schema stays type:array.
      const pageArgs = async (page: unknown): Promise<unknown> => {
        const n = mark();
        await client.callTool({ name: "figma_export_full", arguments: { page, client: "Sample App" } });
        const f = sentSince(n).find((x): x is CommandFrame => isCmd(x, "exportFull"));
        return f ? rec(f.args).page : "not sent";
      };
      const asJson = await pageArgs('["0:1","0:2"]');
      const bareStr = await pageArgs("0:1");
      ok("page as a JSON-encoded array string reaches the plugin as that array", JSON.stringify(asJson) === '["0:1","0:2"]');
      ok("page as a bare string reaches the plugin as a one-element array", JSON.stringify(bareStr) === '["0:1"]');
      // a bare page name that starts with "[" but is not a JSON array is still one name.
      const bracketed = await pageArgs("[WIP] Screens");
      const bracketedObj = await pageArgs('["unclosed"');
      ok(`a bare page name starting with "[" ("[WIP] Screens") reaches the plugin as a one-element array (got ${JSON.stringify(bracketed)})`,
        JSON.stringify(bracketed) === '["[WIP] Screens"]' && JSON.stringify(bracketedObj) === '["[\\"unclosed\\""]');
      const { tools: tools2 } = await client.listTools();
      const prop = (tool: string, key: string): Record<string, unknown> => rec(rec(tools2.find((t) => t.name === tool)?.inputSchema.properties)[key]);
      ok("listTools still advertises page, screens and catalogs as type:array of strings",
        prop("figma_export_full", "page").type === "array" && rec(prop("figma_export_full", "page").items).type === "string" &&
        ["screens", "catalogs"].every((k) => prop("design_drift_lint", k).type === "array" && rec(prop("design_drift_lint", k).items).type === "string"));

      // design_drift_lint `screens` reaches the run as a list, whichever form it arrives in: 2 instances, one mapped → 50%.
      fs.writeFileSync(path.join(CWD, "ddl", "s.json"), JSON.stringify({ nodes: [{ id: "5:1", type: "FRAME", name: "S", children: [
        { id: "5:2", type: "INSTANCE", name: "Row", mainComponent: { key: "k-local", name: "Row" } },
        { id: "5:3", type: "INSTANCE", name: "Other", mainComponent: { key: "k-other", name: "Other" } },
      ] }] }));
      const lintS = async (screens: unknown) => client.callTool({ name: "design_drift_lint", arguments: { map: "lib-map.json", exportDir: "ddl", screens } });
      ok("design_drift_lint screens:[…] and a JSON-encoded string → the same screenCoverage (mapPct 50)",
        rec(parse(await lintS(["ddl/s.json"])).screenCoverage).mapPct === 50 && rec(parse(await lintS('["ddl/s.json"]')).screenCoverage).mapPct === 50);

      // a cancelled tool call cancels the plugin's request (notifications/cancelled →
      // extra.signal → server-core's cancel frame).
      hang = true;
      const ac = new AbortController();
      const n0 = mark();
      const cancelled = client.callTool({ name: "figma_export_url", arguments: { url: "9:1", client: "Sample App" } }, undefined, { signal: ac.signal }).catch(() => "aborted");
      await sleep(300);
      const sentId = sentSince(n0).find((f) => isCmd(f, "exportNode"))?.id;
      ac.abort();
      await cancelled;
      await sleep(300);
      ok("an aborted figma_export_url → the plugin receives {type:\"cancel\"} for that request",
        typeof sentId === "string" && sentSince(n0).some((f) => isCancelOf(f, sentId)));

      // Via a daemon: a second MCP server shares this one's bridge through the daemon socket;
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
          const n3 = mark();
          const viaCall = client3.callTool({ name: "figma_export_url", arguments: { url: "9:1", client: "Sample App" } }, undefined, { signal: ac3.signal }).catch(() => "aborted");
          const until = Date.now() + 3000;
          while (Date.now() < until && !sentSince(n3).some((f) => isCmd(f, "exportNode"))) await sleep(50);
          const sentId3 = sentSince(n3).find((f) => isCmd(f, "exportNode"))?.id;
          ac3.abort();
          await viaCall;
          const until2 = Date.now() + 1500;
          while (Date.now() < until2 && !sentSince(n3).some((f) => isCancelOf(f, sentId3))) await sleep(50);
          ok("an aborted call on a DAEMON-ROUTED session → the plugin receives {type:\"cancel\"} for that request",
            typeof sentId3 === "string" && sentSince(n3).some((f) => isCancelOf(f, sentId3)));
        } finally {
          await client3.close().catch(() => {});
        }
      }

      // The client going away (stdin end) aborts the in-flight request too — the
      // SDK's stdio transport does not notice stdin ending. client.close() ends stdin and waits 2 s before
      // SIGTERM, so a cancel frame inside that window can only come from the stdin watch.
      const n1 = mark();
      void client.callTool({ name: "figma_export_url", arguments: { url: "9:1", client: "Sample App" } }).catch(() => {});
      await sleep(300);
      const sentId2 = sentSince(n1).find((f) => isCmd(f, "exportNode"))?.id;
      const tClose = Date.now();
      const closing = client.close().catch(() => {});
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline && !sentSince(n1).some((f) => isCancelOf(f, sentId2))) await sleep(50);
      ok("stdin closing (the client exited) → the plugin receives {type:\"cancel\"} for the in-flight request (within " + (Date.now() - tClose) + " ms)",
        typeof sentId2 === "string" && sentSince(n1).some((f) => isCancelOf(f, sentId2)));
      await closing;
      p1.close();
      p2.close();
    }
  } catch (e) {
    ok("MCP smoke run completed without throwing — " + (e instanceof Error ? e.message : e), false);
  } finally {
    await client.close().catch(() => {});
  }

  // The published-package shape: bridge/ on its own, with no design-to-code/ beside it. Without layer/ (what
  // `prepack`, bridge/pack.ts, copies in) the two design_* tools say what is missing — decided by whether the layer
  // FILE exists (figma-mcp.ts loadLayer), not by the import's error fields — and the server stays up for every other
  // tool. With it, they answer from the bundles. Its bridge binds an ephemeral port (DT_TEST_EPHEMERAL_PORT) and its
  // daemon socket lives under a TMPDIR of its own.
  {
    const inst = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-inst-"));
    const repo = path.join(import.meta.dirname, "..");
    fs.cpSync(path.join(repo, "bridge", "src"), path.join(inst, "bridge", "src"), { recursive: true });
    fs.copyFileSync(path.join(repo, "bridge", "package.json"), path.join(inst, "bridge", "package.json"));
    fs.symlinkSync(path.join(repo, "node_modules"), path.join(inst, "node_modules"), "junction");
    const cwd = path.join(inst, "project");
    fs.mkdirSync(path.join(cwd, "design", "export", "design-system"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "design", "export", "design-system.json"), JSON.stringify({ files: { componentsLocal: "design-system/components.local.json" } }));
    fs.writeFileSync(path.join(cwd, "design", "export", "design-system", "components.local.json"), JSON.stringify({ components: [] }));
    const tmp = path.join(inst, "t");
    fs.mkdirSync(tmp);
    const instClient = new Client({ name: "mcp-smoke-install", version: "0.0.0" });
    try {
      await instClient.connect(new StdioClientTransport({
        command: process.execPath,
        args: [path.join(inst, "bridge", "src", "figma-mcp.ts")],
        env: { ...process.env, FIGMA_BRIDGE_PORT: "8788", FIGMA_BRIDGE_TOKEN: "smoke-test-token", MAX_MCP_OUTPUT_TOKENS: "", DT_TEST_EPHEMERAL_PORT: "1", TMPDIR: tmp, XDG_RUNTIME_DIR: "" },
        cwd,
        stderr: "ignore",
      }));
      const r = await instClient.callTool({ name: "design_get_component", arguments: { handle: "Btn" } });
      ok("an install without design-to-code/ or layer/: design_get_component is a tool error naming both places",
        r.isError === true && /needs the design-to-code layer, which is not present in this install/.test(firstText(r)) && /layer\/get-component\.js/.test(firstText(r)) && /bun bridge\/src\/figma-mcp\.ts/.test(firstText(r)));
      const dry = await instClient.callTool({ name: "figma_write", arguments: { dryRun: true, ops: [{ op: "createFrame", name: "Card" }] } });
      ok("…and the rest of the server works on (a figma_write dryRun answers)", !dry.isError && (JSON.parse(firstText(dry)) as WritePreview).dryRun === true);
      // The packed shape: the bundles pack.ts ships, in bridge/layer/. Asked per call, so the same server picks them up.
      fs.mkdirSync(path.join(inst, "bridge", "layer"));
      for (const n of LAYER) fs.copyFileSync(path.join(repo, "claude-plugin", "scripts", n + ".js"), path.join(inst, "bridge", "layer", n + ".js"));
      fs.writeFileSync(path.join(cwd, "design", "export", "design-system", "components.local.json"), JSON.stringify({ components: [{ key: "k-btn", id: "1:1", name: "Btn", type: "COMPONENT" }] }));
      const got = await instClient.callTool({ name: "design_get_component", arguments: { handle: "Btn" } });
      ok(`an install with layer/: design_get_component answers from the bundle (got ${firstText(got).slice(0, 120)})`,
        got.isError !== true && /"k-btn"/.test(firstText(got)));
      fs.writeFileSync(path.join(cwd, "map.json"), JSON.stringify({ components: "not-an-object" }));
      const lint = await instClient.callTool({ name: "design_drift_lint", arguments: { map: "map.json" } });
      // cli-args.ts shellQuote: double quotes, or single ones for a path holding a backslash (Windows)
      const hinted = /["']([^"']+map-validate\.js)["']/.exec(firstText(lint))?.[1];
      ok(`…design_drift_lint runs from the bundle, and its hint names a script the package ships (got ${firstText(lint).slice(-200)})`,
        lint.isError === true && /\[map-invalid\]/.test(firstText(lint)) && hinted !== undefined && fs.existsSync(hinted) &&
        // native realpath on both sides: macOS /var vs /private/var, Windows 8.3 short names (RUNNER~1)
        fs.realpathSync.native(hinted) === path.join(fs.realpathSync.native(inst), "bridge", "layer", "map-validate.js"));
    } catch (e) {
      ok("the install-shaped server ran without throwing — " + (e instanceof Error ? e.message : e), false);
    } finally {
      await instClient.close().catch(() => {});
      fs.rmSync(inst, { recursive: true, force: true });
    }
  }
  // Every script a shipped bundle's hints name is shipped too (pack.ts refuses to pack otherwise — this says so
  // before a release does).
  for (const n of LAYER) {
    const dangling = missingHints(fs.readFileSync(path.join(import.meta.dirname, "..", "claude-plugin", "scripts", n + ".js"), "utf8"), LAYER);
    ok(`packed layer: ${n}.js names only scripts the package ships${dangling.length ? " (not: " + dangling.join(", ") + ")" : ""}`, dangling.length === 0);
  }
  report();
})();
