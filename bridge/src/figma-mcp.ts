#!/usr/bin/env -S bun --no-install --no-env-file
// figma-mcp — WRITE plane (also exposes read tools).
// Exposes an MCP server to Claude Code over STDIO, and internally hosts the localhost WebSocket
// bridge the Figma plugin connects to. Use for code -> design (interactive authoring). For bulk
// reads prefer the dtwin CLI (files on disk).
//
// Run via .mcp.json: { "mcpServers": { "designtwin": { "type":"stdio",
//   "command":"<abs path to bun>", "args":["--no-install","--no-env-file","<abs path>/bridge/src/figma-mcp.ts"] } } }
// — Bun runs the TypeScript source directly, for an npm install and a repo checkout alike (the package
// ships src/; there is no build). `dtwin init --mcp` writes exactly that entry, naming the bun that ran
// it and the figma-mcp.ts beside it; the two flags are the shebang's (figma-pull.ts says why).
//
// ESM TypeScript like the rest of bridge/src/ (the MCP SDK is ESM-only). The bridge core and the other
// bridge modules are imported directly, typed by their own source.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";

// The bridge core. `request`'s `timeoutMs` (3rd) is server-core's default-120s budget: exports on a
// real design-system file routinely run longer than that — the dtwin CLI scales its own default
// for the same reason — so the export tools below pass an explicit, larger budget rather than
// inheriting a default tuned for small commands like ping/getSelection. `target` (4th) selects WHICH
// connected Figma file the command goes to — a connId, a fileKey, or part of the file name. Omitted
// with one file connected, required with several (the bridge refuses rather than guessing; see
// server-core's resolveClient).
import { createBridge } from "./server-core.ts";
import { createRoute } from "./route.ts";
import type { RouteRequest, Upstream } from "./route.ts";
import { TIMEOUTS, NAMED_CLIENT_WAIT_MS } from "./timeouts.ts";
import { errMsg } from "./errmsg.ts";
import { runRead, tickMessage } from "./read-run.ts";
import type { ReadRun } from "./read-run.ts";
import type { ConnectionInfo, ProgressTick } from "./server-core.ts";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
// The command/reply contract shared with the plugin (commands.ts): every route request below is
// typed per command from it, so a tool cannot read a reply field the plugin never sends.
import { EDITS_OFF_MESSAGE, WRITE_OP_NAMES, writeOpPreview, type Cmd, type Commands, type ExportReply, type WriteOp } from "./commands.ts";
// TIMEOUTS is the per-command budget table shared with the dtwin CLI. Every EXPORT tool needs a
// budget well above server-core's 120s default (tuned for ping/getSelection, not for a walk of every
// node on a page) — a whole-file walk is the slow case, but a single big frame is the same shape of
// work, and inheriting the small default would make figma_export_url die at 120s on exactly the
// screen you most wanted. An export's tier is the read plan's (read-plan.ts, below), so this front-end
// cannot restate (or omit) a tier the CLI has.
// What an export tool SENDS — command, arguments, budget — is the read plan's (read-plan.ts), the same one
// the CLI sends; each tool's declared read options come from the scopes in the same registry rows.
import { planRead, readOptsFor } from "./read-plan.ts";
import type { PlanOf, ReadCmd, ReadPlan, ReadRefusal, ReadScopeKind } from "./read-plan.ts";
import { ifDefined } from "./json-util.ts";
import type { ReadOptNameFor } from "./read-opts.ts";
import { parseNodeId, toNodeId } from "./node-id.ts";
import { HEX_COLOR_RE, HEX_COLOR_HINT } from "./hex-color.ts";

// WHO holds the bridge. Port 8787 has one owner at a time, and this server does not insist on being it: with
// `dtwin serve` running, or a second Claude Code session open, it routes through that process's daemon socket; when
// it opens the bridge itself, it publishes it there so the NEXT session (or a `dtwin pull`) shares it instead of
// fighting for the port — and takes the bridge over when its owner goes. All of that is the bridge holder's
// "session" lifetime (bridge-holder.ts); this file only tells it when the client has left or a signal says stop.
import { bridgeHolder, daemonSide } from "./bridge-holder.ts";
import type { Holder } from "./bridge-holder.ts";
import { readSettings } from "./settings.ts";
import * as daemon from "./daemon.ts";
import { exitFlushed, installQueuedConsole } from "./stdio.ts";
import { clientPresence, processIO } from "./client-presence.ts";
// The holder, made on first use from the settings this process was started with (startServer reads them first and
// exits on a bad port; a suite that loads this module in process has set its environment before the first call).
let holder: Holder | null = null;
function session(): Holder {
  if (holder) return holder;
  const r = readSettings();
  if (!r.ok) throw new Error(r.problem);
  holder = bridgeHolder("session", { settings: r.settings, createBridge, daemon: daemonSide, log: wlog });
  return holder;
}
// Every tool reaches the plugin through ONE route (route.ts), over whichever side holds the bridge — this
// process or a daemon (holder above, re-resolved per call). The route owns the rules, the same ones the CLI
// gets: a call with no `client`, or a bare c<N> connId, is resolved against what is connected now; a NAMED
// client (file name / fileKey) waits up to NAMED_CLIENT_WAIT_MS for that file — every open plugin window
// redials on its own clock (timeouts.ts PLUGIN_REDIAL_MS), so right after this process opened the bridge only
// one of two open files may have landed yet (seen live) — and then resolveClient reports whatever IS connected.
// Only an export hears progress ticks (withProgress relays them as notifications/progress, MCP spec 2025-06-18,
// basic/utilities/progress; through a daemon they come as progress frames, which also re-arm the socket's outer
// guard). No stall check: a long-lived server's connection is warm. Every reply is checked against commands.ts
// on arrival, and says WHICH connected file answered (null from a daemon too old to relay it) — what the export
// tools stamp as `sourceFile` and whoami describes. `signal` is the tool call's own: the SDK aborts
// `extra.signal` on notifications/cancelled, and stdin closing aborts every in-flight call (callSignal below);
// the plugin then gets a cancel frame for the request, whichever side holds the bridge.
const route = createRoute(() => session().upstream(), { connectWaitMs: 0, oneShot: false, namedWaitMs: NAMED_CLIENT_WAIT_MS });
/** A request's reply alone. */
const ask = async <C extends Cmd>(cmd: C, args: Commands[C]["args"], o: RouteRequest): Promise<Commands[C]["reply"]> => (await route.request(cmd, args, o)).reply;
// The socket half of whoami for `connId` — the connection a request was answered by, not the first live one.
// Through a daemon `via` names the shared bridge; only a daemon too old to send its connection gets the 3-field
// stub, its missing fields reported as undefined, never guessed.
async function connectionInfo(connId: string | null): Promise<ConnectionInfo | (ConnectionInfo & { via: string }) | { via: string; port: number | undefined; pluginConnected: boolean | undefined } | null> {
  const { connection, owner } = await route.connectionInfo(connId);
  if (owner.kind === "own") return connection;
  const via = "shared bridge (pid " + (owner.pid ?? "?") + ")";
  if (connection) return { via, ...connection };
  return { via, port: owner.port ?? undefined, pluginConnected: owner.pluginConnected ?? undefined };
}

// ---- result helpers ----
function textResult(obj: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text" as const, text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}
// Takes the thrown value, not a pre-stringified message: the coercion lives once in server-core
// (`errMsg`) for the whole Bun side.
function errorResult(e: unknown) {
  return { content: [{ type: "text" as const, text: errMsg(e) }], isError: true as const };
}

// Every tool handler needs the same "turn a throw into an isError result" wrapper — a tool that
// forgets it throws through the MCP transport instead. Applying it at registration makes that
// impossible to forget and collapses each handler to its one expression.
const guarded = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => async (...a: A) => {
  try { return await fn(...a); } catch (e) { return errorResult(e); }
};

// Read results carry asset payloads (base64 PNG / SVG strings) that would dump megabytes of noise
// straight into the agent's context. Strip the payloads to a lightweight manifest — the figma-pull
// CLI is the path that actually writes asset bytes to disk.
/** An asset row with its bytes stripped: identity only. */
interface LightAsset { id: string; name: string; format: string; kind?: string }
function stripAssets(r: ExportReply): object {
  if (!("assets" in r)) return r; // a catalog-only pull carries no assets at all
  const light: Omit<typeof r, "assets"> & { assets: LightAsset[]; assetsNote?: string } =
    { ...r, assets: r.assets.map((a) => ({ id: a.id, name: a.name, format: a.format, ...(a.kind ? { kind: a.kind } : {}) })) };
  if (r.assets.length) light.assetsNote = "Asset bytes omitted from context — re-run with writeToDisk:true to write them to <outDir>/assets/.";
  return light;
}

// writeToDisk is the answer to the two things the in-context path cannot do: asset BYTES (stripAssets
// throws them away by design) and payloads past the MCP result cap (25k tokens by default, so a real
// page export is truncated). Writing the export and returning the compact index instead is also the
// cheaper path in context by a wide margin — the agent then Reads/Greps the files at whatever
// granularity it actually needs. It is opt-in, not the default, because a small selection export is
// genuinely more useful inline than as a file path — but only while it FITS. An inline result past the
// client's cap is not "more useful", it is cut off mid-JSON (a real design-system export measured
// 589 KB ≈ 147k tokens against a 25k cap). So an oversized inline result goes to disk on its own and
// says so; an explicit writeToDisk:false is refused with the size instead, never silently truncated.
//
// This matters more than it looks: the CLI cannot be used as the disk path WHILE the MCP server is
// running, because both call createBridge() and bind port 8787 — the second to start hits EADDRINUSE
// and exits (server-core.ts). Before this, an MCP-only session had no way to get assets at all.
import { writeAny, assertInsideCwd, inlineLimitChars } from "./write-out.ts";
import { decideDelivery, describeWrite } from "./delivery.ts";
import { prettyJsonWithin } from "./json-size.ts";
import { findMapFile } from "./project-layout.ts";
import { exportRoot, readComponentCatalog } from "./export-reader.ts";
import type { Stamped } from "./write-out.ts";
import type { CatalogComponent, ComponentDetailFile } from "./doc-types.ts";

// stderr, never stdout: stdout IS the MCP stdio transport, and a stray line there corrupts the
// protocol stream.
const wlog = (m: string) => console.error("[figma-mcp] " + m);

// MCP progress (spec 2025-06-18, basic/utilities/progress): "When a party wants to receive progress
// updates for a request, it includes a progressToken in the request metadata", and the receiver MAY
// then send notifications/progress carrying that token, where "The progress value MUST increase with
// each notification". The plugin's relayed progress ticks become those notifications — progress is a
// running tick count (the plugin's own counters can reset per page), the message says where the walk
// is. No token, no listener: nothing is sent to a client that did not ask.
//
// Ordering: the bridge hands a tick to the callback synchronously from the socket's message handler
// (the WebSocket's when this process holds the bridge; the daemon socket's reader, frame by frame and
// always ahead of the reply frame, when a daemon does), so a tick and the reply that lands in the same event-loop turn would otherwise race — the tool
// result could reach stdout before the last notification, which the client then drops (it does not
// know the token any more). The SDK's own progressExample.js `await`s each sendNotification; a callback cannot,
// so `withProgress` collects every send and awaits them all before the tool result is returned (the
// stdio transport's send() resolves once the frame is written, so the order on the wire is
// notifications first, result last). A send that fails (the client went away) is swallowed: the
// export itself carries on and its result is still the answer.
type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type OnTick = (t: ProgressTick) => void;
async function withProgress<R>(extra: ToolExtra | undefined, run: (onTick: OnTick | undefined) => Promise<R>): Promise<R> {
  const progressToken = extra?._meta?.progressToken;
  if (!extra || progressToken === undefined) return run(undefined);
  let progress = 0;
  // Spec (basic/utilities/progress): "Progress notifications MUST stop after completion" — and Claude Code
  // has torn a stdio server down over a notification whose token was no longer in flight. So a
  // tick that lands once run() has settled (a late frame from the plugin or the daemon), or after the call
  // was cancelled, is dropped here; no notification ever carries a `total`, so none reads as a final one.
  let settled = false;
  const pending: Promise<void>[] = [];
  const onTick: OnTick = (t) => {
    if (settled || extra.signal.aborted || presence.gone.aborted) return;
    pending.push(extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress: ++progress, message: tickMessage(t) } })
      .catch(() => { /* the client went away; the export itself carries on */ }));
  };
  try {
    return await run(onTick);
  } finally {
    settled = true;
    // Every entry already has its rejection handled, so this never throws and never masks run()'s
    // own error; it only holds the result until the last notification is on the wire.
    await Promise.all(pending);
  }
}

// Whether the MCP client is still there (client-presence.ts): stdin ending or closing, a write to stdout finding it
// gone, or a signal — whichever comes first — aborts `presence.gone`, which every tool call's bridge requests carry
// beside the SDK's own per-call signal; what the process does then is the bridge holder's decision (clientLeft).
const presence = clientPresence(processIO(), () => session());
const callSignal = (extra: ToolExtra | undefined): AbortSignal => (extra ? AbortSignal.any([extra.signal, presence.gone]) : presence.gone);

/** The two writeShape arguments every export tool reads — what Zod parses them to, not a restatement. */
type WriteArgs = z.output<z.ZodObject<typeof writeShape>>;

// One export, run (read-run.ts): the read plan sent to the file the call names, its ticks relayed as progress
// notifications, cancelled with the call, timed, and stamped with WHICH connected file answered — the same
// `sourceFile` the CLI writes (figma-pull.ts), on written and inline results alike.
function pull<C extends ReadCmd>(extra: ToolExtra | undefined, plan: PlanOf<C>, client: string | undefined, progress = true): Promise<ReadRun<C>> {
  const run = (onTick: OnTick | undefined): Promise<ReadRun<C>> => runRead(route, plan, { target: client, onProgress: onTick, signal: callSignal(extra) });
  return progress ? withProgress(extra, run) : run(undefined);
}

// The most recent write THIS server made (per process — gone on restart). figma_status reports
// it beside lastScreenExport (which is read from disk), so an agent can see what an implicit spill touched.
// `prevKept`: how many .prev copies an implicit full/design-system spill kept (0 when none differed).
interface LastWrite { tool: string; at: string; implicit: boolean; file: string; prev?: string; prevKept?: number }
let lastWrite: LastWrite | null = null;

// An outDir the caller NAMED (or a writeToDisk:true, which writes to the default) is
// checked BEFORE the export, so a refused path costs no plugin walk — the plugin is never asked.
// exportResult still checks again after it (the one case left: FIGMA_EXPORT_DIR alone plus an implicit
// spill — pre-checking that would refuse every inline call for a user whose env names a directory
// outside the project). writeToDisk:false writes nothing, so its outDir is not checked.
function preflightOut(a: WriteArgs): void {
  // `outDir: ""` is not a named outDir: resolveOutDir treats it as absent too (the env/default dir).
  if (a.writeToDisk === true || (a.writeToDisk !== false && !!a.outDir)) assertInsideCwd(a.outDir);
}

// One export, delivered: the pure step (delivery.ts) decides inline / written / refused and words the note, from the
// change report write-out returns for an implicit spill; this does the measuring, the writing and the bookkeeping.
function exportResult(tool: string, a: WriteArgs, run: ReadRun<ReadCmd>, opts?: { scale?: number | undefined }) {
  const r: Stamped<ExportReply> = run.reply;
  // The clock rides along inline too (top level); `write` is 0 — nothing was written. The text only when it fits: a
  // real export is tens of megabytes, so the size is measured without serialising it.
  const d = decideDelivery(a.writeToDisk, (limit) => prettyJsonWithin({ ...stripAssets(r), durationMs: run.durationMs() }, limit), inlineLimitChars());
  if (d.kind === "refuse") throw new Error(d.message);
  if (d.kind === "inline") return textResult(d.text);
  // Validate BEFORE writing anything: a rejected outDir must not leave a half-written export behind.
  // guarded() turns the throw into an isError result naming the offending path.
  const dir = assertInsideCwd(a.outDir);
  // An IMPLICIT spill must not silently replace what is on disk: it keeps `.prev` copies (keepPrev), and the change
  // report says which — kept, replaced, and the earlier ones still there. An explicit write keeps nothing.
  const { changes, ...written } = run.write((stamped) => writeAny(a.outDir, stamped, wlog, { scale: opts && opts.scale, keepPrev: d.implicit }));
  const wrote = written.wrote;
  const said = describeWrite(d, "screen" in wrote ? { kind: "screen", dir, screen: wrote.screen, changes }
    : "reference" in wrote ? { kind: "screenshot", dir, reference: wrote.reference, changes }
    : { kind: "export", dir, changes });
  lastWrite = { tool, at: new Date().toISOString(), implicit: d.implicit, file: said.file, ...ifDefined("prev", said.prev), ...ifDefined("prevKept", said.prevKept) };
  // A screenshot's node size and render scale (from the plugin; absent from an older one) beside the
  // PNG's own pixel size (writeScreenshot reads it from the bytes).
  const shot = "reference" in r ? { ...ifDefined("w", r.w), ...ifDefined("h", r.h), ...ifDefined("scale", r.scale) } : {};
  return textResult({ ...shot, ...written, durationMs: run.durationMs(), note: said.note });
}

// Shared by every export tool, so the pair cannot end up declared on some and not others — the exact
// failure mode the readOptsShape comment below records for skipAssets (Zod strips undeclared keys, so
// an option a tool forgets to declare is silently dropped before the handler sees it).
// WHICH connected Figma file a tool talks to. Declared on every tool that reaches the plugin, for the
// same reason writeShape is shared: a tool that forgets to declare it has the argument silently
// STRIPPED by Zod before the handler runs, so `client` would be accepted and ignored — routing the
// call to whatever file the bridge picked, with no error to notice.
// An array parameter that also accepts what some clients actually send for one — a JSON-encoded array
// string ('["1:2"]'; Claude Code has stringified array/object args on their way to tools/call)
// or a bare string where a one-element array was meant — including one that starts with "[" but does not
// parse as a JSON array (a page named "[WIP] Screens"). Anything else (a number, an object) reaches z.array
// unchanged and fails its validation. The
// advertised JSON Schema is still the inner `type: "array"` (zod's pipe emits its input side's target —
// mcp-smoke checks it through listTools), so a well-behaved client sees no change.
function tolerantStringArray() {
  return z.preprocess((v: unknown): unknown => {
    if (typeof v !== "string") return v;
    const t = v.trim();
    if (!t.startsWith("[")) return [v];
    // a page literally named "[WIP] Screens" is not JSON (or not an array): it is still one bare name
    try { const p: unknown = JSON.parse(t); return Array.isArray(p) ? p : [v]; } catch { return [v]; }
  }, z.array(z.string()));
}

const clientShape = {
  client: z.string().optional().describe("WHICH connected Figma file to talk to — a connId (from figma_list_clients), a fileKey, or part of the file's name. The bridge accepts one connection per open Figma file, so a design file and the library it draws on can both be connected at once. Omit when only one file is connected. With several connected, omitting this is an ERROR listing the choices rather than a guess — an export from the wrong file is indistinguishable from a correct one."),
};

const writeShape = {
  writeToDisk: z.boolean().optional().describe("Write the export to disk and return a compact index (counts + file paths) instead of the node payloads. REQUIRED to get asset bytes — they are never returned inline — and the right choice for anything beyond one small frame. Omitted: a result that fits the client's output cap comes back inline, a larger one is written to disk automatically (the note says so). false: never write — a result too large to return is an error."),
  outDir: z.string().optional().describe("Directory for writeToDisk, relative to the directory this MCP server was started in (i.e. your project). Default: FIGMA_EXPORT_DIR or 'design/export'."),
};

// ---- read options, per export tool (opt-in; each costs extra Plugin-API work) ----
// DERIVED from bridge/src/read-opts.ts — the ONE registry the CLI flag table and the plugin's own run reads
// come from too — rather than a fifth hand-written list of the same names and help text. A restated
// literal is how skipAssets went missing on two of the three export tools: the MCP SDK validates args
// with z.object(inputSchema) and hands the callback `parseResult.data`, and Zod's default object mode
// STRIPS unknown keys — so an option a tool's schema does not declare is silently dropped before the
// handler ever sees it. Each tool declares exactly the options its read scope takes (the rows' `scopes`),
// so what reaches the handler is what the read plan forwards.
function readOptsShapeFor<K extends ReadScopeKind>(kind: K): Record<ReadOptNameFor<K>, z.ZodOptional<z.ZodBoolean>> {
  return Object.fromEntries(readOptsFor(kind).map((o) => [o.name, z.boolean().optional().describe(o.describe)])) as Record<ReadOptNameFor<K>, z.ZodOptional<z.ZodBoolean>>;
}

// The read plan, or a refusal: unreachable while each tool declares only its scope's options (the SDK strips
// the rest first), and an error naming them if a schema ever declares more than its scope takes.
function planned<P extends ReadPlan>(p: P | ReadRefusal): P {
  if ("refused" in p) throw new Error(`${p.refused.join(", ")} ${p.refused.length > 1 ? "are read options" : "is a read option"} that a ${p.scope} export does not read`);
  return p;
}

const READ_ONLY = { readOnlyHint: true } as const;

// figma_status reports the verdict on the export on disk (export-verdict.ts — the one `dtwin doctor` formats) so an
// agent can see how stale, and how mixed, its LAST EXPORT is without shelling out. That is distinct from bridge
// connectivity, so nothing exported is not an error, just `snapshot: null`.
import { readExportVerdict, statusSnapshot } from "./export-verdict.ts";

// The version the server reports in its MCP `initialize` answer: the package's own, never a literal that
// drifts from it.
import pkg from "../package.json" with { type: "json" };
const server = new McpServer({ name: "designtwin", version: pkg.version });

server.registerTool(
  "figma_status",
  {
    description: "Check which Figma files are connected to the bridge, and which page each has open. Several files can be connected at once (one per open Figma file running the plugin) — the `clients` array lists them, and each row's connId is what you pass as `client` to every other tool. Also reports the export on disk, if any, as `snapshot`: the newest stamp's exportedAt/ageMs/sourceFile, `stale` (older than `staleAfterMs`), `sources` (the screens of each Figma file, and the design system, each with its own age) and `problems` (files there but unusable) — so an agent can tell whether it's about to read a stale or mixed snapshot — plus `lastScreenExport` (the newest screen in pages/index.json) and `lastWrite` (the last file this server wrote, and whether that was an implicit spill).",
    inputSchema: { ...clientShape },
    annotations: READ_ONLY,
  },
  guarded(async (a, extra) => {
    // One verdict on the export (export-verdict.ts) answers both the snapshot and the newest screen row (disk);
    // lastWrite is this server's own last write (session).
    const verdict = readExportVerdict(exportRoot());
    const snapshot = statusSnapshot(verdict);
    const ledger = { lastScreenExport: verdict.lastScreen, lastWrite };
    if (!(a && a.client)) {
      const clients = await route.listClients();
      if (!clients.length) return textResult({ connected: false, hint: "Open the Figma file and run the plugin.", snapshot, ...ledger });
      // With several connected, an unaddressed ping would be REFUSED — so report the roster instead of
      // failing. "Which files can I talk to?" is exactly what this tool is for.
      if (clients.length > 1) {
        return textResult({
          connected: true,
          clients,
          snapshot,
          ...ledger,
          note: "Several Figma files are connected. Pass `client` (connId, fileKey, or part of the file name) to every tool call, or it will be refused rather than guess which file you meant.",
        });
      }
    }
    // The ping comes BEFORE the roster is listed: the request wrapper above is where a named `client` is waited
    // for (NAMED_CLIENT_WAIT_MS, the same rule as `--client <name>`), and live (2026-09-25, §5.2c) right
    // after a bridge restart — every window mid-redial, nothing connected yet — the zero-clients early
    // return above answered `connected: false` in 10 ms for a file that landed two seconds later. With a
    // `client` the early returns are skipped, so the wait applies; listing after the ping also means the
    // roster shows the window the ping reached, identified. A bare connId never waits (resolveClient's
    // own refusal, as for every other tool).
    const pong = await ask("ping", {}, { timeoutMs: TIMEOUTS.command, target: a && a.client, signal: callSignal(extra) });
    return textResult({ connected: true, clients: await route.listClients(), ...pong, snapshot, ...ledger });
  })
);

// The discovery step for multi-file work: which files can I talk to, and what do I call them? Reads
// the bridge's OWN registry and never touches the plugin, so it answers instantly even while every
// connected file is mid-export — the same "cheap index you consult before committing" role
// figma_list_pages plays for a file's contents.
server.registerTool(
  "figma_list_clients",
  {
    description:
      "WHICH Figma files are currently connected to the bridge — the discovery step before addressing " +
      "one. Each row gives a connId (the routing key), the file name, its fileKey when available, the " +
      "open page, and how long it has been connected. Pass any of connId / fileKey / part of the file " +
      "name as `client` on the other tools. The bridge accepts one connection per open Figma file, so a " +
      "design file and the library it draws on can be driven in the same session without either " +
      "displacing the other. Costs nothing — it reads the bridge's own registry and never touches the " +
      "plugin, so it answers even while every connected file is busy with a long export.",
    annotations: READ_ONLY,
  },
  guarded(async () => {
    const clients = await route.listClients();
    return textResult({
      clients,
      count: clients.length,
      // The EMPTY case has to explain itself: nothing connected is the normal state before the plugin
      // is opened, not a broken bridge.
      ...(clients.length ? {} : {
        note: "Nothing connected. Open a file in Figma and run \"Design Twin\" (Plugins → Development) — it auto-connects and announces itself. You can open it in several files at once; each becomes a separate row here.",
      }),
      ...(clients.some((c) => !c.identified) ? {
        identifiedNote: "A row with identified:false is connected but has not announced itself yet (or is an older plugin build that does not) — address it by connId.",
      } : {}),
    });
  })
);

// Identity of ONE connection. Distinct from figma_list_clients (which files are there?) — this asks a
// specific plugin instance who it is, which is how a runtime teardown is detected: the socket survives
// and the connId is unchanged, but the instanceId is new.
server.registerTool(
  "figma_whoami",
  {
    description:
      "Identity and liveness of ONE connected plugin: a per-run instanceId, the file/page name, whether " +
      "figma.fileKey is available, and how long its socket has been up. Use figma_list_clients to see " +
      "every connected file; use this to interrogate one of them. A CHANGED instanceId across two calls " +
      "addressing the same file means Figma tore down and re-ran the plugin runtime (the connection " +
      "survived, the runtime did not) — worth knowing if a long-idle file starts behaving oddly. Costs " +
      "nothing (no page load, no node walk, no assets).",
    inputSchema: { ...clientShape },
    annotations: READ_ONLY,
  },
  // `connection` describes the socket that ANSWERED, not whichever file connected first.
  guarded(async (a, extra) => {
    const sent = await route.request("whoami", {}, { target: a && a.client, signal: callSignal(extra) });
    return textResult({ plugin: sent.reply, connection: await connectionInfo(sent.client ? sent.client.connId : null) });
  })
);

server.registerTool(
  "figma_get_selection",
  {
    description: "List the currently selected nodes (id, name, type) in a connected Figma file.",
    inputSchema: { ...clientShape },
    annotations: READ_ONLY,
  },
  guarded(async (a, extra) => textResult(await ask("getSelection", {}, { timeoutMs: TIMEOUTS.command, target: a && a.client, signal: callSignal(extra) })))
);

// The cheap map. This is the tool an agent should reach for FIRST: every other read here
// deep-serializes, so without it the only way to learn what a file holds was to export all of it —
// measured 12+ minutes and tens of MB on a real design system, straight into the context window.
server.registerTool(
  "figma_list_pages",
  {
    description:
      "CHEAP structural index of the open file: pages, and (depth 2) their top-level frames with " +
      "id/name/type/size. No recursion, no assets, no node properties. Call this FIRST to decide WHICH " +
      "page or frame to export, then pass those ids to figma_export_full({page}) or figma_export_url. " +
      "depth 1 is near-free (page names only, loads nothing); depth 2 loads every page, which Figma " +
      "warns can be slow on large files — still far cheaper than an export.",
    inputSchema: {
      ...clientShape,
      depth: z.union([z.literal(1), z.literal(2)]).optional().describe("1 = page names only (near-free). 2 = pages + their top-level frames (default)."),
    },
    annotations: READ_ONLY,
  },
  // Pass `depth` through unnormalised: listPages owns the default (and the 1-vs-2 clamp), so a third
  // tier there doesn't need a matching edit here.
  guarded(async (a, extra) => textResult(await ask("listPages", ifDefined("depth", a && a.depth), { timeoutMs: TIMEOUTS.list, target: a && a.client, signal: callSignal(extra) })))
);

// The library-scoped discovery call, and the other half of "look before you pull": figma_list_pages
// answers WHERE things are in this file, this one answers WHICH design libraries the file draws on.
// Same cheap tier (TIMEOUTS.list), no arguments, and the result is deliberately COMPACT — a handful
// of rows — because a discovery call that costs real context defeats its own purpose.
server.registerTool(
  "figma_list_libraries",
  {
    description:
      "The SLOWEST discovery read (a few seconds to ~15 s: it walks every instance and makes one Figma call per enabled library variable collection; about 2 s when no libraries are enabled): which design libraries this file draws on — the local file's own published " +
      "assets plus every ENABLED team library — with each one's variable collections and how many of " +
      "its components this file uses. Not part of the default discovery order (figma_status -> " +
      "figma_list_pages -> figma_list_children -> figma_export_url): call it to learn which library owns a " +
      "token, or before a CLI `dtwin pull --as-library`. Limits worth knowing: component " +
      "counts are USAGE-derived (Figma exposes no API to enumerate a library's full contents), and " +
      "libraries can only be enabled from the Figma UI — never via API — so results reflect whatever " +
      "was enabled at call time. An EMPTY result is a normal outcome (free plan, or no library " +
      "enabled), not a failure; check `warnings`. Requires a plugin built with the 'teamlibrary' " +
      "permission — re-import the plugin in Figma if this returns nothing.",
    inputSchema: { ...clientShape },
    annotations: READ_ONLY,
  },
  // Compacted here rather than passed through: the plugin's shape is already small, but an agent
  // reads this tool's result in full, so collapse each library's collections to name+count and keep
  // `warnings` (the field that explains an empty list) intact. Same spirit as stripAssets.
  guarded(async (a, extra) => {
    const r = await ask("listLibraries", {}, { timeoutMs: TIMEOUTS.list, target: a && a.client, signal: callSignal(extra) });
    const libraries = r.libraries.map((l) => ({
      key: l.key,
      name: l.name,
      kind: l.kind,
      componentCount: l.componentCount,
      variableCollections: l.variableCollections.map((c) => ({ key: c.key, name: c.name, variableCount: c.variableCount })),
      ...(l.note ? { note: l.note } : {}),
    }));
    const warnings = r.warnings;
    return textResult({
      libraries,
      warnings,
      ...(libraries.length
        ? {}
        : {
            note:
              "No libraries reported — a NORMAL outcome, not necessarily an error. Check, in order: " +
              "the plugin in Figma predates the 'teamlibrary' permission (re-import it); no team " +
              "library is enabled for this file (enable it in the Figma UI — no API can); free plan " +
              "(library variable collections are not exposed to plugins).",
          }),
      countsNote: "componentCount is USAGE-derived — components of that library used in THIS file. Figma exposes no API to enumerate a library's full contents.",
    });
  })
);

// The node-scoped twin: listPages depth 2 stops at a page's top-level frames, and peeking INSIDE one
// otherwise meant a full recursive export of it.
server.registerTool(
  "figma_list_children",
  {
    description:
      "CHEAP listing of ONE node's DIRECT children (id/name/type/size/childCount/hasChildren) — no recursion, no " +
      "assets. Rows that share name + size also carry a `title` (first visible text), with one warning per group; when their titles match too, `distinctTexts` (up to 3 texts that row shows and its twins do not; a very large listing skips it with a warning). Use it to drill into a frame that figma_list_pages surfaced before committing to a full " +
      "export of it. Accepts a bare node id or a figma.com URL containing ?node-id=.",
    inputSchema: {
      ...clientShape,
      nodeId: z.string().describe("A node id like '123:456' / '123-456', or a figma.com design URL containing ?node-id=..."),
    },
    annotations: READ_ONLY,
  },
  guarded(async (a, extra) => {
    const nodeId = toNodeId(a.nodeId);
    if (!nodeId) return errorResult("Provide a node id (e.g. 123:456) or a Figma URL containing ?node-id=... — see figma_list_pages.");
    return textResult(await ask("listChildren", { nodeId }, { timeoutMs: TIMEOUTS.list, target: a && a.client, signal: callSignal(extra) }));
  })
);

server.registerTool(
  "figma_export_full",
  {
    description:
      "Export the design system (component + token catalog — always spans the WHOLE file) plus frame " +
      "trees. Frames default to the CURRENT page; pass page:[ids] to export named page(s), or " +
      "allPages:true to walk every page. Large — call figma_list_pages first to pick a target, and " +
      "pass writeToDisk:true for anything beyond a quick look: it writes the export to your project " +
      "and returns a compact index, which is the only way to get asset bytes and avoids the result " +
      "cap truncating the tree.",
    inputSchema: {
      ...clientShape,
      allPages: z.boolean().optional().describe("Export frame trees from every page. Can be very large and slow (measured >15 min on a 25-page file) — prefer `page` with ids from figma_list_pages, or the dtwin CLI."),
      page: tolerantStringArray().optional().describe("Export these page(s) by id (preferred) or exact name, instead of the current page. Ids come from figma_list_pages. Cannot be combined with allPages — passing both is refused rather than silently resolved. An unknown or ambiguous name fails with the available pages listed."),
      ...readOptsShapeFor("pages"),
      ...writeShape,
    },
    annotations: READ_ONLY,
  },
  // The budget follows the SCOPE, exactly as the dtwin CLI's does (one read plan for both): exportAll (15 min) only for
  // the whole-file walk, export (5 min) for the current page or a bounded page:[ids] pull. Handing
  // every scope the whole-file budget made the bounded pull — the one this tool's own description
  // tells you to prefer — wait 15 minutes to report a hang that a 5-minute limit would have caught,
  // and quietly undid the point of having tiers in the shared TIMEOUTS table at all.
  // An empty `page` is the current page (the plan sends no selector for it). The allPages+page conflict is
  // refused by collectFull itself (one guard, every caller) — no copy of the rule here. This path always
  // needs a connected plugin anyway, so there is nothing to answer faster.
  guarded(async (a, extra) => {
    preflightOut(a);
    const plan = planned(planRead({ kind: "pages", allPages: !!a.allPages, pages: a.page ?? [] }, a));
    return exportResult("figma_export_full", a, await pull(extra, plan, a && a.client));
  })
);

server.registerTool(
  "figma_export_design_system",
  {
    description:
      "Export ONLY the design system — variables, styles, local + library components, hygiene report — " +
      "with no page/frame walk and therefore no assets (assets are exported per-node during that walk). " +
      "The cheap sibling of figma_export_full for callers who just want tokens/styles/components. One " +
      "tradeoff: on a file that CONSUMES a library this returns that file's OWN tokens, styles and components " +
      "plus only the library variables something in the file references (flagged remote:true) — never the " +
      "library's catalog; for that, run `dtwin pull --as-library \"<name>\"` (CLI) inside the library file. " +
      "A design-system export takes ~15–40 s on a real file and reports progress only to clients that send a " +
      "progress token. Pass writeToDisk:true for the design-system/ split. " +
      "Each catalogued component/variant carries its own fills/strokes/effects/cornerRadius/opacity/blendMode " +
      "(componentsLocal[].visuals) — components DEFINED in this file only, not ones consumed from a published " +
      "library (pull dtwin --as-library on the source library file for those). Pass variantVisuals:true " +
      "to also attach each COMPONENT_SET's variants' REAL layout/fills/radius/tokens (componentsLocal[].variants) " +
      "— the master-component source of truth, not the set wrapper's own selection-chrome visuals. It is the " +
      "ONE read option this tool accepts (the others need a node/page walk this tool skips); one extra node " +
      "walk per variant, so it is slower on a large design system.",
    inputSchema: { ...clientShape, ...readOptsShapeFor("designSystem"), ...writeShape },
    annotations: READ_ONLY,
  },
  // buildDesignSystem() walks every page's component catalog (loadAllPages + findAllWithCriteria), so
  // this is EXPORT-tier work despite taking no scope arguments — TIMEOUTS.list would undersell it.
  guarded(async (a, extra) => {
    preflightOut(a);
    return exportResult("figma_export_design_system", a, await pull(extra, planned(planRead({ kind: "designSystem" }, a)), a && a.client));
  })
);

server.registerTool(
  "figma_export_selection",
  {
    description: "Export the current selection as compacted node JSON + variables + assets.",
    inputSchema: { ...clientShape, ...readOptsShapeFor("selection"), ...writeShape },
    annotations: READ_ONLY,
  },
  guarded(async (a, extra) => {
    preflightOut(a);
    return exportResult("figma_export_selection", a, await pull(extra, planned(planRead({ kind: "selection" }, a)), a && a.client));
  })
);

server.registerTool(
  "figma_export_url",
  {
    description:
      "Given a Figma design URL (containing ?node-id=...) or a bare node id, select that node in the " +
      "open file and export it as compacted node JSON + variables + an asset manifest. This is the " +
      "'paste a link and ask about it' path. Requires the file the link points to be OPEN in the Figma " +
      "desktop app with the plugin running (the bridge reads the live file — it cannot fetch a link cold).",
    inputSchema: {
      ...clientShape,
      url: z.string().describe("A figma.com design/file URL with ?node-id=..., or a bare node id like '123:456' / '123-456'."),
      ...readOptsShapeFor("node"),
      ...writeShape,
    },
    annotations: READ_ONLY,
  },
  guarded(async (a, extra) => {
    const nodeId = parseNodeId(a.url);
    if (!nodeId) return errorResult("Couldn't find a node id in: " + a.url + " — paste a link that contains ?node-id=..., or the node id directly (e.g. 123:456).");
    preflightOut(a);
    return exportResult("figma_export_url", a, await pull(extra, planned(planRead({ kind: "node", nodeId }, a)), a && a.client));
  })
);

server.registerTool(
  "figma_screenshot",
  {
    description:
      "On-demand PNG of ONE node — the visual-validation counterpart to figma_export_* (which already " +
      "attach a whole-frame reference PNG to every exported root). Use this to check a SPECIFIC " +
      "component/instance buried in a dense screen against the code you generated for it, without " +
      "re-exporting or walking the whole frame. Mirrors Figma's own get_screenshot tool (single-node " +
      "scope, called on demand after get_metadata/figma_list_children, as a validation step) rather " +
      "than pre-rendering every node up front. Pass writeToDisk:true to get the actual PNG file — " +
      "REQUIRED, since asset bytes are never returned inline.",
    inputSchema: {
      ...clientShape,
      nodeId: z.string().describe("A node id like '123:456' / '123-456', or a figma.com design URL containing ?node-id=..."),
      scale: z.number().positive().optional().describe("Override the default render scale (auto, capped at 2048px on the longest side)."),
      ...readOptsShapeFor("screenshot"), // none: a screenshot renders a PNG and walks nothing
      ...writeShape,
    },
    annotations: READ_ONLY,
  },
  guarded(async (a, extra) => {
    const nodeId = toNodeId(a.nodeId);
    if (!nodeId) return errorResult("Provide a node id (e.g. 123:456) or a Figma URL containing ?node-id=... — see figma_list_pages.");
    preflightOut(a);
    return exportResult("figma_screenshot", a, await pull(extra, planned(planRead({ kind: "screenshot", nodeId, scale: a.scale })), a && a.client, false), { scale: a.scale });
  })
);

// What a figma_write batch WOULD do, without doing it. creates = additive; overwrites = replaces a
// property on a node the user already has (the irreversible half).
// The op schema is the wire contract (commands.ts WriteOp) spelled in Zod: `op` is constrained to the
// four ops the plugin implements — rejected at the boundary rather than round-tripped — and the fields
// each op reads are typed. `.passthrough()` keeps a stray extra field flowing (the plugin ignores it).
// A fill/color is a hex colour: "red" or "#12" is refused here rather than painted as a wrong colour.
const hexColor = z.string().regex(HEX_COLOR_RE, `must be ${HEX_COLOR_HINT}`);
// createFrame/createText `fill` also takes "" (the plugin reads it as "no fill"); one regex alternative, so the
// published JSON schema keeps a single `pattern`. setFill's `color` stays strict: it has no "none".
const hexColorOrEmpty = z.string().regex(new RegExp(`^(?:${HEX_COLOR_RE.source.slice(1, -1)}|)$`), `must be ${HEX_COLOR_HINT}, or "" for no fill`);
const writeOpShape = z.object({
  op: z.enum(WRITE_OP_NAMES),
  parentId: z.string().optional(),
  name: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  layoutMode: z.enum(["HORIZONTAL", "VERTICAL"]).optional(),
  itemSpacing: z.number().optional(),
  padding: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  fill: hexColorOrEmpty.optional(),
  text: z.string().optional(),
  fontSize: z.number().optional(),
  nodeId: z.string().optional(),
  color: hexColor.optional(),
}).passthrough();

// Each step is commands.ts writeOpPreview — the op's WRITE_OPS row, which the plugin's wire check (writeOpError) reads too.
// `editsAllowed` is the plugin's "Allow edits" checkbox as its whoami reports it: false => a real write would be
// refused (and `wouldRefuse` says what to ask the designer); null => unknown (no plugin reachable, or one built
// before the opt-in).
function previewWrites(ops: WriteOp[], editsAllowed: boolean | null) {
  const steps = ops.map(writeOpPreview);
  return {
    dryRun: true,
    applied: false,
    creates: steps.filter((s) => s.effect === "creates").length,
    overwrites: steps.filter((s) => s.effect === "overwrites").length,
    invalid: steps.filter((s) => "invalid" in s).length,
    steps,
    editsAllowed,
    ...(editsAllowed === false ? { wouldRefuse: EDITS_OFF_MESSAGE } : {}),
    note: "Nothing was changed. Overwrites cannot be undone from here (only Cmd-Z in Figma). " +
      (editsAllowed === false
        ? "A real write would be REFUSED right now: 'Allow edits' is off in the Design Twin plugin window — ask the designer to tick it, then re-call without dryRun."
        : editsAllowed === null
          ? "Could not read the plugin's 'Allow edits' setting (no single plugin reachable); a real write is refused while it is off. Re-call without dryRun to apply."
          : "Re-call without dryRun to apply."),
  };
}

// The dry run's read of the "Allow edits" checkbox. Never waits for a plugin to connect (the preview must answer
// with none): nothing connected, several connected with no `client` named, or any failure, is `null` (unknown).
async function readEditsAllowed(a: { client?: string | undefined } | undefined): Promise<boolean | null> {
  try {
    const n = (await route.listClients()).length;
    if (n === 0 || (!(a && a.client) && n > 1)) return null;
    const who = await ask("whoami", {}, { timeoutMs: TIMEOUTS.command, target: a && a.client });
    return typeof who.editsAllowed === "boolean" ? who.editsAllowed : null;
  } catch {
    return null;
  }
}

server.registerTool(
  "figma_write",
  {
    description:
      "Apply a batch of safe write operations to the open Figma file. Each op: " +
      "{op:'createFrame', name?, width?, height?, layoutMode?('HORIZONTAL'|'VERTICAL'), itemSpacing?, padding?[t,r,b,l], fill?(#hex), parentId?} | " +
      "{op:'createText', text, fontSize?, fill?, parentId?} | " +
      "{op:'setFill', nodeId, color(#hex)} | {op:'setText', nodeId, text}. " +
      "Ops are applied in order and are NOT transactional: if one fails, the earlier ones stay applied " +
      "and their node ids are reported alongside the error so you can continue or clean up. " +
      "There is no undo from here (only the designer's own Cmd-Z) — so for anything that OVERWRITES " +
      "(setFill/setText), call once with dryRun:true, show the user the preview, and only then apply. " +
      "The plugin applies nothing unless the designer has ticked 'Allow edits' in its window (off by default); " +
      "while it is off a write is refused with that instruction, and a dry run reports editsAllowed:false — " +
      "ask the designer to tick it, then retry.",
    inputSchema: {
      ...clientShape,
      // Constrain `op` to the four ops the plugin actually implements — reject unknown ops at the
      // boundary rather than round-tripping them to the plugin. Other fields stay open (.passthrough).
      ops: z.array(writeOpShape)
        // Writes are not transactional and cannot be undone from here, so a runaway batch is bounded:
        // 50 ops is several screens' worth of frames/text, and a larger job is simply several calls.
        .max(50, "at most 50 ops per call — split a larger job into several calls (writes cannot be undone from here)")
        .describe("Ordered list of write operations (each must have an `op` field). At most 50 per call."),
      dryRun: z.boolean().optional().describe("true = validate the batch and return a preview of what each op would create/overwrite, WITHOUT touching the Figma file (needs no plugin connection; when one is connected it also reports editsAllowed — false means a real write would be refused)."),
    },
    // destructiveHint MUST stay true. Per the MCP schema it asserts, when false, that "the tool
    // performs only additive updates" — but setFill/setText OVERWRITE properties on nodes the user
    // already has, and (as the description says) nothing here is transactional or rollback-able.
    // Clients use these hints to decide whether to put a human in the loop, so declaring `false`
    // suppressed the confirmation prompt on the one tool that irreversibly mutates a design file.
    // idempotentHint is likewise false: re-running a batch creates a SECOND set of frames/text.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  guarded(async (a) => {
    // The preview is built HERE, not plugin-side: it must work before a connection exists, and the
    // annotations above are only a hint — not every MCP client turns destructiveHint into a prompt.
    if (a.dryRun) return textResult(previewWrites(a.ops || [], await readEditsAllowed(a)));
    // No cancel signal here (unlike the reads): a write cannot be un-applied, and aborting the wait would
    // only lose the `applied` ids below.
    const r = await ask("write", { ops: a.ops || [] }, { target: a && a.client });
    // The designer has not consented: nothing was tried, so there is no op index and nothing to clean up. The
    // fix is the PERSON's (a checkbox in the plugin window), so say exactly that rather than "write failed".
    if (r.refused === "edits-off" && !r.applied.length) return errorResult(r.error || EDITS_OFF_MESSAGE);
    // Partial failure is reported as an error result, but MUST still carry `applied` — those nodes
    // exist in the document and the agent needs their ids to continue or undo.
    if (!r.ok) {
      const applied = r.applied;
      return errorResult(
        `Write failed at op ${r.failedAt}${r.failedOp ? " (" + r.failedOp + ")" : ""}: ${r.error}\n` +
          `${applied.length} earlier op(s) were applied and NOT rolled back:\n` +
          JSON.stringify(applied, null, 2)
      );
    }
    return textResult(r);
  })
);

// ---------------------------------------------------------------- design-to-code layer (no Figma)
// These two read the EXPORT ON DISK, not the live file, so they work with no plugin connected and
// cost nothing. The design-to-code layer is otherwise reachable only by a human typing `bun design-to-code/...`
// — without these the agent has the figma_* tools and no way in, and the map and the codegen skill drift
// into two different formats. Registering them here is what makes that layer exist for its actual
// consumer.
// Loaded LAZILY, on call, and never at module scope, from one of two places. In a repo checkout it is
// ../../design-to-code/<mod>.ts, a SIBLING of this package root (bridge/) — which npm's `files` cannot reach. So
// the npm package carries the layer as bundles instead: `prepack` (bridge/pack.ts) copies the committed,
// self-contained claude-plugin/scripts/<mod>.js into ../layer/. Neither there (a checkout without design-to-code/,
// a package packed without its prepack): importing eagerly would take the whole server down with a
// module-not-found, killing the other tools over two that merely cannot work — so the server always starts and only
// these two report, precisely, what is missing.
// The slice of each layer module this server calls, declared HERE (over doc-types.ts shapes) rather
// than as `typeof import("../../design-to-code/x.ts")`: even a type-only reference pulls that file and
// its imports into the bridge program, and the published package (src/ is TypeScript, the layer only bundles) would name files it
// does not ship (see doc-types.ts). So bridge/src has no dependency of any kind on the layer — only the
// dynamic import below, which fails soft. Mirrors design-to-code/get-component.ts GetComponentResult and
// design-to-code/drift-lint.ts runDriftLint(); keep them in step (test/mcp-smoke.test.ts checks the real modules still satisfy these at compile time).
export interface GetComponentModule {
  getComponent(catalogFile: string, handle: string):
    | { found: false }
    | { found: true; component: CatalogComponent; detail: ComponentDetailFile | null; detailPath?: string };
}
/** design-to-code/drift-lint.ts runDriftLint(): the one run the CLI prints and design_drift_lint returns. */
export interface DriftLintModule {
  runDriftLint(input: { mapFile: string; catalogFile: string; extraCatalogFiles?: readonly string[]; screenFiles?: readonly string[]; maxAgeMs?: number }):
    | { status: "unusable" | "map-invalid"; message: string }
    | { status: "linted"; errors: unknown[]; warnings: unknown[]; freshness: unknown; summary: unknown; catalogs: ReadonlyArray<{ file: string }>; coverage: { coverage: object; warnings: unknown[] } | null };
}
async function loadLayer<T>(mod: string, tool: string): Promise<T> {
  // The source in a checkout first (what the repo's tests run), else the package's bundle. Whether either is there
  // is asked of the file system, before the import: the import's own failure cannot say it — a missing
  // dependency OF the layer fails the same way, and the error's code and url fields differ between
  // runtimes (Bun reports neither the way Node did). Any error from an import of a file that IS there
  // is passed on as it is.
  const url = [new URL(`../../design-to-code/${mod}.ts`, import.meta.url), new URL(`../layer/${mod}.js`, import.meta.url)].find((u) => fs.existsSync(u));
  if (!url) {
    throw new Error(
      `${tool} needs the design-to-code layer, which is not present in this install: neither a repo checkout's ` +
        `design-to-code/${mod}.ts nor the npm package's layer/${mod}.js. Reinstall @design-twin/dtwin, or run this MCP ` +
        `server from a repo checkout (bun bridge/src/figma-mcp.ts). Everything else on this server works either way.`
    );
  }
  return (await import(url.href)) as T;
}
const getComponent = async (catalogFile: string, handle: string) =>
  (await loadLayer<GetComponentModule>("get-component", "design_get_component")).getComponent(
    catalogFile,
    handle
  );
const driftLintLayer = () => loadLayer<DriftLintModule>("drift-lint", "design_drift_lint");

// The export's component catalog is export-reader.ts readComponentCatalog's: the `files.componentsLocal` pointer
// (inside the export only), else an older export's inline components[] in design-system.json — the catalog `dtwin
// seed` reads too. No exportDir: export-reader's one precedence (FIGMA_EXPORT_DIR, else this project's export). The
// server adds only its own boundary: the export and the catalog file are held inside its start directory (a symlink
// out included), so these read tools never read outside the project.
function componentCatalogFile(exportDir?: string): string {
  const root = assertInsideCwd(exportRoot(exportDir), "exportDir");
  const catalog = readComponentCatalog(root);
  if ("error" in catalog) throw new Error(catalog.missing ? `${catalog.error}; from this server, figma_export_design_system with writeToDisk:true — or pass exportDir` : catalog.error);
  return assertInsideCwd(catalog.file, "the component catalog");
}

const exportDirShape = {
  exportDir: z
    .string()
    .optional()
    .describe(
      "Directory holding the design export, relative to the directory this server was started in. Default: FIGMA_EXPORT_DIR, else this project's export (design/export, or design/ on the older flat layout)."
    ),
};

server.registerTool(
  "design_get_component",
  {
    description:
      "Read ONE component out of the design export on disk, with its real variant node trees. Handle is the component's stable publish `key` (preferred — survives renames), its node id, or its exact name (an ambiguous name is an ERROR listing the keys, never a guess). Use this when building a screen and you need one component's actual variant visuals: the catalog is deliberately slim, so every COMPONENT_SET's heavy per-variant node trees live in their own file and this is the tool that follows that pointer. Needs NO Figma connection and costs nothing — it reads files an earlier export already wrote.",
    inputSchema: {
      handle: z.string().describe("Component publish key, node id, or exact name. Keys come from design_drift_lint or the components.local.json catalog."),
      ...exportDirShape,
    },
    annotations: READ_ONLY,
  },
  guarded(async (a) => {
    const res = await getComponent(componentCatalogFile(a.exportDir), a.handle);
    if (!res.found) return errorResult(`No component matches '${a.handle}' in the export. Try its publish key or id.`);
    // A catalog entry with no exported node tree is a real, non-error outcome (the export ran without
    // variantVisuals) — say so rather than returning an empty-looking success.
    if (!res.detail) {
      return textResult({
        component: res.component,
        detail: null,
        note: "No node trees were exported for this component — re-run the export with variantVisuals:true to get its variant visuals.",
      });
    }
    return textResult({ component: res.component, detail: res.detail });
  })
);

server.registerTool(
  "design_drift_lint",
  {
    description:
      "Check a codeconnect.local.json map against the design export for DRIFT, and report snapshot staleness. Joins on the stable publish `key`, so it catches the case Figma's own Code Connect ships silently (its node-id join misses renamed/republished components — issue #337): orphaned map entries, unmapped components, stale or uncovered props, kind/enum mismatches. Also warns when the export on disk is older than --max-age. Run it before building a screen (so you find out the map is wrong BEFORE generating code against it) and in CI/pre-commit. Needs NO Figma connection.",
    inputSchema: {
      map: z.string().optional().describe("Path to the map, relative to the server's start directory. Default: design/codeconnect.local.json (or a root codeconnect.local.json an older project still has)."),
      maxAgeHours: z.number().optional().describe("Warn if the export snapshot is older than this many hours. Omit for the built-in default."),
      catalogs: tolerantStringArray().optional().describe("More component catalog file(s) the map may point into, relative to the server's start directory — the CLI's --catalog (e.g. a library's components.json kept outside the export). components.library.json and every pulled library are read without it."),
      screens: tolerantStringArray().optional().describe("Screen export JSON file(s) (e.g. design/export/pages/<Page>/<Screen>__<id>.json), relative to the server's start directory — the CLI's --screen. Adds `screenCoverage`: how many of the component sets placed on THOSE screens your map covers (by key), with the same warnings the CLI prints. The number that matters before building a screen."),
      ...exportDirShape,
    },
    annotations: READ_ONLY,
  },
  guarded(async (a) => {
    // Every path is held inside the server's start directory; reading, checking and linting them is the CLI's
    // own run (design-to-code/drift-lint.ts runDriftLint), so the two cannot disagree on what a file means.
    // The project layout's map (design/codeconnect.local.json), or the root copy an older project still has.
    const mapFile = assertInsideCwd(a.map || findMapFile(process.cwd()).rel, "map");
    const catalogFile = componentCatalogFile(a.exportDir);
    const run = (await driftLintLayer()).runDriftLint({
      mapFile,
      catalogFile,
      extraCatalogFiles: (a.catalogs || []).map((f) => assertInsideCwd(f, "catalogs")),
      screenFiles: (a.screens || []).map((f) => assertInsideCwd(f, "screens")),
      ...(a.maxAgeHours ? { maxAgeMs: a.maxAgeHours * 3600000 } : {}),
    });
    if (run.status !== "linted") return errorResult(run.message);
    // Drift is a FINDING, not a tool failure — return it as a normal result so the agent reads the
    // errors instead of an isError blob it may discard. `ok` is the thing to branch on.
    return textResult({
      ok: run.errors.length === 0,
      catalogsRead: run.catalogs.map((c) => c.file),
      errors: run.errors,
      warnings: run.warnings,
      freshness: run.freshness,
      summary: run.summary,
      ...(run.coverage ? { screenCoverage: { ...run.coverage.coverage, warnings: run.coverage.warnings } } : {}),
    });
  })
);

// The server, started: stdio guards, signal handlers, the stdio transport, then the bridge. NOT run at import — only
// when this file is the process entry (`bun figma-mcp.ts`, the .mcp.json entry) or `dtwin mcp` calls runServer() once
// it has loaded this module — so a suite can load it and drive `server` in process.
async function startServer() {
  // This process IS the user's MCP session: a stray rejection is logged and the session stays up; an
  // uncaught exception is logged and exits 1 (daemon.ts installCrashHandlers says why). Before that exit waits on
  // stderr, the cleanup lets go of what this process holds — the daemon socket it serves (unlinked) and the bridge's
  // port — synchronously, so a Claude Code that restarts the server at once finds 8787 free.
  // The settings first, as the bridge core once did at its load: a port no plugin can reach leaves nothing to serve.
  const settings = readSettings();
  if (!settings.ok) {
    console.error(settings.problem);
    exitFlushed(1);
    return;
  }
  daemon.installCrashHandlers(wlog, () => { session().release(); });
  // Before anything can write to stdout (client-presence.ts says why its stdout guard cannot wait for the client to go):
  // the stdio guards, the signal handlers, and the exit once the holder has let go.
  presence.start();
  // console.* through the streams' queue (Bun drops a direct console write that meets a full pipe) — and ALL of it to
  // stderr: stdout carries the JSON-RPC the transport writes and nothing else.
  installQueuedConsole({ logTo: "stderr" });
  // stdio is the transport Claude Code speaks; the WebSocket to the plugin is internal.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  presence.watchStdin();
  // Resolve the bridge up front, so a port problem is reported at startup — but only REPORTED: the
  // stdio session stays up, every tool call retries the resolution, and a held port comes back as that
  // call's error (the port may be free by then). Exiting here killed the whole MCP server.
  let h: Upstream;
  try {
    h = await session().upstream();
  } catch (e) {
    console.error("[figma-mcp] MCP server up (stdio), but no bridge yet: " + errMsg(e) + " Tool calls will retry.");
    return;
  }
  console.error("[figma-mcp] MCP server up (stdio). " + (h.kind === "own"
    ? "Bridge listening on " + h.address + "."
    : "Sharing the bridge already running at " + h.address + "."));
}

/** Start the server as the process's MCP session: a startup failure is fatal (logged, exit 1). */
export function runServer(): void {
  startServer().catch((e) => {
    console.error("[figma-mcp] fatal:", errMsg(e));
    exitFlushed(1);
  });
}
export { server };

if (import.meta.main) runServer();
