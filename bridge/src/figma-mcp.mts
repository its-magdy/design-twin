// figma-mcp — WRITE plane (also exposes read tools).
// Exposes an MCP server to Claude Code over STDIO, and internally hosts the localhost WebSocket
// bridge the Figma plugin connects to. Use for code -> design (interactive authoring). For bulk
// reads prefer the dtwin CLI (files on disk).
//
// Run via .mcp.json: { "mcpServers": { "figma": { "type":"stdio",
//   "command":"node", "args":["./bridge/figma-mcp.mjs"] } } }
//
// TypeScript source; built to figma-mcp.mjs (ESM, required by the ESM-only MCP SDK). The bridge core
// (server-core.js) and the dtwin CLI stay plain CJS — only this entry is ESM.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRequire } from "node:module";

// The bridge core is CJS with no type declarations — pull it in via createRequire (robust ESM->CJS
// interop) and describe the surface we use.
interface Bridge {
  // `timeoutMs` is server-core's third parameter (default 120s). Exports on a real design-system file
  // routinely run longer than that — the dtwin CLI learned this the hard way and now scales its
  // own default — so the export tools below pass an explicit, larger budget rather than inheriting
  // a default tuned for small commands like ping/getSelection.
  // `target` (4th) selects WHICH connected Figma file the command goes to — a connId, a fileKey, or
  // part of the file name. Omitted with one file connected, required with several (the bridge refuses
  // rather than guessing; see server-core's resolveClient).
  request(cmd: string, args?: unknown, timeoutMs?: number, target?: string): Promise<any>;
  isConnected(): boolean;
  listClients(): any[];
  connectionInfo(): any;
  port: number;
}
const require = createRequire(import.meta.url);
// TIMEOUTS is the per-command budget table shared with the dtwin CLI. Every EXPORT tool needs a
// budget well above server-core's 120s default (tuned for ping/getSelection, not for a walk of every
// node on a page) — a whole-file walk is the slow case, but a single big frame is the same shape of
// work and used to inherit the small default, which meant figma_export_url died at 120s on exactly the
// screen you most wanted. Reading the tiers from server-core is what keeps the two front-ends aligned.
// `exportTimeout` carries the scope -> tier RULE alongside the table, so this front-end cannot
// restate (or, as it once did, omit) a tier the CLI has.
// The ONE registry of read options (shared with the dtwin CLI and the plugin's runOpts).
// Types come from its .d.ts; the values via createRequire, same as every other CJS module here.
import type { ReadOptDef, ReadOptName } from "../read-opts.js";
const { READ_OPTS } = require("./read-opts.js") as { READ_OPTS: ReadOptDef[] };

const { createBridge, TIMEOUTS, exportTimeout, errMsg } = require("./server-core.js") as {
  createBridge: () => Bridge;
  TIMEOUTS: { command: number; selection: number; list: number; export: number; exportAll: number };
  exportTimeout: (scope?: { selection?: boolean; allPages?: boolean }) => number;
  errMsg: (e: unknown) => string;
};
const { parseNodeId, toNodeId } = require("./node-id.js") as {
  parseNodeId: (s?: string) => string | undefined;
  toNodeId: (s?: string) => string;
};

const bridge = createBridge();

// ---- result helpers ----
function textResult(obj: unknown) {
  return { content: [{ type: "text" as const, text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}
// Takes the thrown value, not a pre-stringified message: every call site was writing the same
// coercion, which now lives once in server-core (`errMsg`) for the whole Node side.
function errorResult(e: unknown) {
  return { content: [{ type: "text" as const, text: errMsg(e) }], isError: true as const };
}

// Every tool handler needs the same "turn a throw into an isError result" wrapper — a tool that
// forgets it throws through the MCP transport instead. Applying it at registration makes that
// impossible to forget and collapses each handler to its one expression.
const guarded = <A extends unknown[]>(fn: (...a: A) => Promise<any>) => async (...a: A) => {
  try { return await fn(...a); } catch (e) { return errorResult(e); }
};

// Read results carry asset payloads (base64 PNG / SVG strings) that would dump megabytes of noise
// straight into the agent's context. Strip the payloads to a lightweight manifest — the figma-pull
// CLI is the path that actually writes asset bytes to disk.
function stripAssets(r: any) {
  if (!r || !Array.isArray(r.assets)) return r;
  const light = { ...r, assets: r.assets.map((a: any) => ({ id: a.id, name: a.name, format: a.format, ...(a.kind ? { kind: a.kind } : {}) })) };
  if (r.assets.length) light.assetsNote = "Asset bytes omitted from context — re-run with writeToDisk:true to write them to <outDir>/assets/.";
  return light;
}

// writeToDisk is the answer to the two things the in-context path cannot do: asset BYTES (stripAssets
// throws them away by design) and payloads past the MCP result cap (25k tokens by default, so a real
// page export is truncated). Writing the export and returning the compact index instead is also the
// cheaper path in context by a wide margin — the agent then Reads/Greps the files at whatever
// granularity it actually needs. It is opt-in, not the default, because a small selection export is
// genuinely more useful inline than as a file path.
//
// This matters more than it looks: the CLI cannot be used as the disk path WHILE the MCP server is
// running, because both call createBridge() and bind port 8787 — the second to start hits EADDRINUSE
// and exits (server-core.js). Before this, an MCP-only session had no way to get assets at all.
const { writeAny, assertInsideCwd } = require("./write-out.js") as {
  writeAny: (outDir: string | undefined, r: any, log?: (m: string) => void) => any;
  assertInsideCwd: (outDir?: string) => string;
};

// stderr, never stdout: stdout IS the MCP stdio transport, and a stray line there corrupts the
// protocol stream.
const wlog = (m: string) => console.error("[figma-mcp] " + m);

function exportResult(a: any, r: any) {
  if (!a || !a.writeToDisk) return textResult(stripAssets(r));
  // Validate BEFORE writing anything: a rejected outDir must not leave a half-written export behind.
  // guarded() turns the throw into an isError result naming the offending path.
  assertInsideCwd(a.outDir);
  const written = writeAny(a.outDir, r, wlog);
  return textResult({
    ...written,
    note: "Export written to disk; node payloads intentionally omitted from this result. Read the files under outDir (start with the index) to inspect them at your own granularity.",
  });
}

// Shared by every export tool, so the pair cannot end up declared on some and not others — the exact
// failure mode the readOptsShape comment below records for skipAssets (Zod strips undeclared keys, so
// an option a tool forgets to declare is silently dropped before the handler sees it).
// WHICH connected Figma file a tool talks to. Declared on every tool that reaches the plugin, for the
// same reason writeShape is shared: a tool that forgets to declare it has the argument silently
// STRIPPED by Zod before the handler runs, so `client` would be accepted and ignored — routing the
// call to whatever file the bridge picked, with no error to notice.
const clientShape = {
  client: z.string().optional().describe("WHICH connected Figma file to talk to — a connId (from figma_list_clients), a fileKey, or part of the file's name. The bridge accepts one connection per open Figma file, so a design file and the library it draws on can both be connected at once. Omit when only one file is connected. With several connected, omitting this is an ERROR listing the choices rather than a guess — an export from the wrong file is indistinguishable from a correct one."),
};

const writeShape = {
  writeToDisk: z.boolean().optional().describe("Write the export to disk and return a compact index (counts + file paths) instead of the node payloads. REQUIRED to get asset bytes — they are never returned inline — and the right choice for anything large, since inline results are capped and truncated."),
  outDir: z.string().optional().describe("Directory for writeToDisk, relative to the directory this MCP server was started in (i.e. your project). Default: FIGMA_EXPORT_DIR or 'design'."),
};

// ---- read options, shared across the export tools (opt-in; each costs extra Plugin-API work) ----
// DERIVED from bridge/read-opts.js — the ONE registry the CLI flag table and the plugin's own runOpts
// come from too — rather than a fifth hand-written list of the same names and help text. A restated
// literal is how skipAssets went missing on two of the three export tools: the MCP SDK validates args
// with z.object(inputSchema) and hands the callback `parseResult.data`, and Zod's default object mode
// STRIPS unknown keys — so an option that readOpts() maps but a tool's schema does not declare is
// silently dropped before the handler ever sees it. Deriving the schema is what actually makes "every
// export tool forwards every read option" true, rather than merely intended.
const readOptsShape = Object.fromEntries(
  READ_OPTS.map((o) => [o.name, z.boolean().optional().describe(o.describe)]),
) as Record<ReadOptName, z.ZodOptional<z.ZodBoolean>>;

// Local alias kept so the many call sites below read as before.
type ReadOpt = ReadOptName;
const READ_OPT_KEYS = Object.keys(readOptsShape) as ReadOpt[];
const readOpts = (a: Partial<Record<ReadOpt, boolean>>): Record<ReadOpt, boolean> =>
  Object.fromEntries(READ_OPT_KEYS.map((k) => [k, !!a[k]])) as Record<ReadOpt, boolean>;

const READ_ONLY = { readOnlyHint: true } as const;

// The design-system.json a figma-pull run left on disk carries its own `exportedAt`/`file` (stamped by
// the plugin — collect.ts/components.ts, not invented here). figma_status reads it opportunistically so
// an agent can see how stale its LAST EXPORT is without shelling out — this is snapshot age, distinct
// from bridge connectivity, so a missing/unreadable file is not an error, just `snapshot: null`.
// Lives in its own dependency-free CJS module (snapshot-meta.js, same pattern as node-id.js /
// errmsg.js) so the test suite can read it directly without importing this file — this file's
// top-level `createBridge()`/`main()` open a real WebSocket server and stdio transport, unsafe to
// trigger from a test.
const { readSnapshotInfo } = require("./snapshot-meta.js") as { readSnapshotInfo: (outDir?: string) => any };

const server = new McpServer({ name: "designtwin", version: "0.1.0" });

server.registerTool(
  "figma_status",
  {
    description: "Check which Figma files are connected to the bridge, and which page each has open. Several files can be connected at once (one per open Figma file running the plugin) — the `clients` array lists them, and each row's connId is what you pass as `client` to every other tool. Also reports the age of the last dtwin export on disk (design-system.json's exportedAt), if any — so an agent can tell whether it's about to read a stale snapshot.",
    inputSchema: { ...clientShape },
    annotations: READ_ONLY,
  },
  guarded(async (a: any) => {
    const snapshot = readSnapshotInfo();
    const clients = bridge.listClients();
    if (!clients.length) return textResult({ connected: false, hint: "Open the Figma file and run the plugin.", snapshot });
    // With several connected, an unaddressed ping would be REFUSED — so report the roster instead of
    // failing. "Which files can I talk to?" is exactly what this tool is for.
    if (clients.length > 1 && !(a && a.client)) {
      return textResult({
        connected: true,
        clients,
        snapshot,
        note: "Several Figma files are connected. Pass `client` (connId, fileKey, or part of the file name) to every tool call, or it will be refused rather than guess which file you meant.",
      });
    }
    return textResult({ connected: true, clients, ...(await bridge.request("ping", {}, TIMEOUTS.command, a && a.client)), snapshot });
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
    const clients = bridge.listClients();
    return textResult({
      clients,
      count: clients.length,
      // The EMPTY case has to explain itself: nothing connected is the normal state before the plugin
      // is opened, not a broken bridge.
      ...(clients.length ? {} : {
        note: "Nothing connected. Open a file in Figma and run \"Design Twin\" (Plugins → Development) — it auto-connects and announces itself. You can open it in several files at once; each becomes a separate row here.",
      }),
      ...(clients.some((c: any) => !c.identified) ? {
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
  guarded(async (a: any) => textResult({
    plugin: await bridge.request("whoami", {}, TIMEOUTS.command, a && a.client),
    connection: bridge.connectionInfo(),
  }))
);

server.registerTool(
  "figma_get_selection",
  {
    description: "List the currently selected nodes (id, name, type) in a connected Figma file.",
    inputSchema: { ...clientShape },
    annotations: READ_ONLY,
  },
  guarded(async (a: any) => textResult(await bridge.request("getSelection", {}, TIMEOUTS.command, a && a.client)))
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
  guarded(async (a: any) => textResult(await bridge.request("listPages", { depth: a && a.depth }, TIMEOUTS.list, a && a.client)))
);

// The library-scoped discovery call, and the other half of "look before you pull": figma_list_pages
// answers WHERE things are in this file, this one answers WHICH design libraries the file draws on.
// Same cheap tier (TIMEOUTS.list), no arguments, and the result is deliberately COMPACT — a handful
// of rows — because a discovery call that costs real context defeats its own purpose.
server.registerTool(
  "figma_list_libraries",
  {
    description:
      "CHEAP discovery: which design libraries this file draws on — the local file's own published " +
      "assets plus every ENABLED team library — with each one's variable collections and how many of " +
      "its components this file uses. Call this BEFORE exporting, then scope the export to what you " +
      "actually need (figma_list_pages -> figma_export_full({page})). Limits worth knowing: component " +
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
  guarded(async (a: any) => {
    const r = await bridge.request("listLibraries", {}, TIMEOUTS.list, a && a.client);
    const libraries = ((r && r.libraries) || []).map((l: any) => ({
      key: l.key,
      name: l.name,
      kind: l.kind,
      componentCount: l.componentCount,
      variableCollections: ((l.variableCollections || []) as any[]).map((c) => ({ key: c.key, name: c.name, variableCount: c.variableCount })),
      ...(l.note ? { note: l.note } : {}),
    }));
    const warnings = (r && r.warnings) || [];
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
      "CHEAP listing of ONE node's DIRECT children (id/name/type/size/hasChildren) — no recursion, no " +
      "assets. Use it to drill into a frame that figma_list_pages surfaced before committing to a full " +
      "export of it. Accepts a bare node id or a figma.com URL containing ?node-id=.",
    inputSchema: {
      ...clientShape,
      nodeId: z.string().describe("A node id like '123:456' / '123-456', or a figma.com design URL containing ?node-id=..."),
    },
    annotations: READ_ONLY,
  },
  guarded(async (a: any) => {
    const nodeId = toNodeId(a.nodeId);
    if (!nodeId) return errorResult("Provide a node id (e.g. 123:456) or a Figma URL containing ?node-id=... — see figma_list_pages.");
    return textResult(await bridge.request("listChildren", { nodeId }, TIMEOUTS.list, a && a.client));
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
      page: z.array(z.string()).optional().describe("Export these page(s) by id (preferred) or exact name, instead of the current page. Ids come from figma_list_pages. Cannot be combined with allPages — passing both is refused rather than silently resolved. An unknown or ambiguous name fails with the available pages listed."),
      ...readOptsShape,
      ...writeShape,
    },
    annotations: READ_ONLY,
  },
  // The budget follows the SCOPE, exactly as the dtwin CLI's does: exportAll (15 min) only for
  // the whole-file walk, export (5 min) for the current page or a bounded page:[ids] pull. Handing
  // every scope the whole-file budget made the bounded pull — the one this tool's own description
  // tells you to prefer — wait 15 minutes to report a hang that a 5-minute limit would have caught,
  // and quietly undid the point of having tiers in the shared TIMEOUTS table at all.
  // `page` is forwarded only when non-empty — an empty array must not read as a selector (collect.ts
  // would warn and fall back to the current page).
  guarded(async (a: any) => {
    const page = Array.isArray(a.page) && a.page.length ? a.page : undefined;
    const allPages = !!a.allPages;
    // The allPages+page conflict is refused by collectFull itself (one guard, every caller) — no copy
    // of the rule here. This path always needs a connected plugin anyway, so there is nothing to
    // answer faster.
    return exportResult(a, await bridge.request(
      "exportFull",
      { allPages, page, ...readOpts(a) },
      exportTimeout({ allPages }),
      a && a.client
    ));
  })
);

server.registerTool(
  "figma_export_design_system",
  {
    description:
      "Export ONLY the design system — variables, styles, local + library components, hygiene report — " +
      "with no page/frame walk and therefore no assets (assets are exported per-node during that walk). " +
      "The cheap sibling of figma_export_full for callers who just want tokens/styles/components. One " +
      "tradeoff: library (remote) variable completeness depends on nodes/styles actually walked in this " +
      "session, so a bare design-system pull may see fewer of them than a full pull would — local " +
      "variables, styles and components are unaffected. Pass writeToDisk:true for the design-system/ split. " +
      "Each catalogued component/variant carries its own fills/strokes/effects/cornerRadius/opacity/blendMode " +
      "(componentsLocal[].visuals) — components DEFINED in this file only, not ones consumed from a published " +
      "library (pull dtwin --as-library on the source library file for those). Pass variantVisuals:true " +
      "to also attach each COMPONENT_SET's variants' REAL layout/fills/radius/tokens (componentsLocal[].variants) " +
      "— the master-component source of truth, not the set wrapper's own selection-chrome visuals. It is the " +
      "ONE read option this tool accepts (the others need a node/page walk this tool skips); one extra node " +
      "walk per variant, so it is slower on a large design system.",
    inputSchema: { ...clientShape, variantVisuals: readOptsShape.variantVisuals, ...writeShape },
    annotations: READ_ONLY,
  },
  // buildDesignSystem() walks every page's component catalog (loadAllPages + findAllWithCriteria), so
  // this is EXPORT-tier work despite taking no scope arguments — TIMEOUTS.list would undersell it.
  guarded(async (a: any) => exportResult(a, await bridge.request("exportDesignSystem", { variantVisuals: a && a.variantVisuals }, TIMEOUTS.export, a && a.client)))
);

server.registerTool(
  "figma_export_selection",
  {
    description: "Export the current selection as compacted node JSON + variables + assets.",
    inputSchema: { ...clientShape, ...readOptsShape, ...writeShape },
    annotations: READ_ONLY,
  },
  guarded(async (a: any) => exportResult(a, await bridge.request("exportSelection", readOpts(a), exportTimeout({ selection: true }), a && a.client)))
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
      ...readOptsShape,
      ...writeShape,
    },
    annotations: READ_ONLY,
  },
  guarded(async (a: any) => {
    const nodeId = parseNodeId(a.url);
    if (!nodeId) return errorResult("Couldn't find a node id in: " + a.url + " — paste a link that contains ?node-id=..., or the node id directly (e.g. 123:456).");
    return exportResult(a, await bridge.request("exportNode", { nodeId, ...readOpts(a) }, TIMEOUTS.export, a && a.client));
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
      ...writeShape,
    },
    annotations: READ_ONLY,
  },
  guarded(async (a: any) => {
    const nodeId = toNodeId(a.nodeId);
    if (!nodeId) return errorResult("Provide a node id (e.g. 123:456) or a Figma URL containing ?node-id=... — see figma_list_pages.");
    return exportResult(a, await bridge.request("screenshot", { nodeId, scale: a.scale }, TIMEOUTS.export, a && a.client));
  })
);

// What a figma_write batch WOULD do, without doing it. creates = additive; overwrites = replaces a
// property on a node the user already has (the irreversible half).
function previewWrites(ops: any[]) {
  const steps = ops.map((o, i) => {
    const creates = o.op === "createFrame" || o.op === "createText";
    const missing = o.op === "createText" ? (o.text == null ? ["text"] : [])
      : o.op === "setFill" ? ["nodeId", "color"].filter((k) => o[k] == null)
      : o.op === "setText" ? ["nodeId", "text"].filter((k) => o[k] == null)
      : [];
    return {
      index: i,
      op: o.op,
      effect: creates ? "creates" : "overwrites",
      target: creates ? (o.parentId ? `new node under ${o.parentId}` : "new node on the current page") : o.nodeId || null,
      ...(o.op === "setFill" ? { newFill: o.color } : {}),
      ...(o.op === "setText" || o.op === "createText" ? { newText: o.text } : {}),
      ...(missing.length ? { invalid: `missing ${missing.join(", ")}` } : {}),
    };
  });
  return {
    dryRun: true,
    applied: false,
    creates: steps.filter((s) => s.effect === "creates").length,
    overwrites: steps.filter((s) => s.effect === "overwrites").length,
    invalid: steps.filter((s) => "invalid" in s).length,
    steps,
    note: "Nothing was changed. Overwrites cannot be undone from here (only Cmd-Z in Figma). Re-call without dryRun to apply.",
  };
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
      "(setFill/setText), call once with dryRun:true, show the user the preview, and only then apply.",
    inputSchema: {
      ...clientShape,
      // Constrain `op` to the four ops the plugin actually implements — reject unknown ops at the
      // boundary rather than round-tripping them to the plugin. Other fields stay open (.passthrough).
      ops: z.array(z.object({ op: z.enum(["createFrame", "createText", "setFill", "setText"]) }).passthrough()).describe("Ordered list of write operations (each must have an `op` field)."),
      dryRun: z.boolean().optional().describe("true = validate the batch and return a preview of what each op would create/overwrite, WITHOUT touching the Figma file (needs no plugin connection)."),
    },
    // destructiveHint MUST stay true. Per the MCP schema it asserts, when false, that "the tool
    // performs only additive updates" — but setFill/setText OVERWRITE properties on nodes the user
    // already has, and (as the description says) nothing here is transactional or rollback-able.
    // Clients use these hints to decide whether to put a human in the loop, so declaring `false`
    // suppressed the confirmation prompt on the one tool that irreversibly mutates a design file.
    // idempotentHint is likewise false: re-running a batch creates a SECOND set of frames/text.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  guarded(async (a: any) => {
    // The preview is built HERE, not plugin-side: it must work before a connection exists, and the
    // annotations above are only a hint — not every MCP client turns destructiveHint into a prompt.
    if (a.dryRun) return textResult(previewWrites(a.ops || []));
    const r = await bridge.request("write", { ops: a.ops || [] }, TIMEOUTS.command, a && a.client);
    // Partial failure is reported as an error result, but MUST still carry `applied` — those nodes
    // exist in the document and the agent needs their ids to continue or undo.
    if (r && r.ok === false) {
      const applied = Array.isArray(r.applied) ? r.applied : [];
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
// cost nothing. Until now the ../tooling layer was reachable only by a human typing `node design-to-code/...`
// — the agent had twelve figma_* tools and no way in, which is why the map and the codegen skill drifted
// into two different formats. Registering them here is what makes that layer exist for its actual
// consumer.
// Loaded LAZILY, on call, and never at module scope. ../design-to-code/ is a SIBLING of this package
// root (bridge/), so npm — whose `files` cannot reach outside the package root — does not ship it.
// Requiring it eagerly took the whole server down with MODULE_NOT_FOUND on an `npm i -g designtwin`
// install, killing the other twelve tools over two that merely could not work. Now the server always
// starts and only these two report, precisely, that they need the repo checkout.
function loadLayer<T>(mod: string, tool: string): T {
  try {
    return require("../design-to-code/" + mod) as T;
  } catch (e) {
    throw new Error(
      `${tool} needs the design-to-code layer, which is not present in this install. It ships with the ` +
        `Design Twin repository, not with the published npm package — run this MCP server from a repo ` +
        `checkout (node bridge/figma-mcp.mjs) to use it. Everything else on this server works either way.`
    );
  }
}
const getComponent = (catalogFile: string, handle: string) =>
  loadLayer<{ getComponent: (c: string, h: string) => any }>("get-component.js", "design_get_component").getComponent(
    catalogFile,
    handle
  );
const driftLint = (map: any, catalog: any, opts?: { maxAgeMs?: number }) =>
  loadLayer<{ driftLint: (m: any, c: any, o?: any) => any }>("drift-lint.js", "design_drift_lint").driftLint(
    map,
    catalog,
    opts
  );
const nodeFs = require("node:fs") as typeof import("node:fs");
const nodePath = require("node:path") as typeof import("node:path");

// Follow design-system.json's `files.componentsLocal` pointer rather than guessing the split layout's
// filenames — the manifest is the ONE place that records where the export actually landed.
function componentsLocalPath(exportDir?: string): string {
  const dir = assertInsideCwd(exportDir);
  const manifestPath = nodePath.join(dir, "design-system.json");
  let manifest: any;
  try {
    manifest = JSON.parse(nodeFs.readFileSync(manifestPath, "utf8"));
  } catch (e) {
    throw new Error(
      `No design export found at ${manifestPath}. Run an export first (figma_export_design_system with ` +
        `writeToDisk:true, or the dtwin CLI), or pass exportDir.`
    );
  }
  const rel = manifest && manifest.files && manifest.files.componentsLocal;
  if (!rel) throw new Error(`${manifestPath} has no files.componentsLocal pointer — re-export with a current dtwin.`);
  return nodePath.join(dir, rel);
}

const exportDirShape = {
  exportDir: z
    .string()
    .optional()
    .describe(
      "Directory holding the design export, relative to the directory this server was started in. Default: FIGMA_EXPORT_DIR or 'design'."
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
  guarded(async (a: any) => {
    const res = getComponent(componentsLocalPath(a.exportDir), a.handle);
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
      map: z.string().optional().describe("Path to the map, relative to the server's start directory. Default: 'codeconnect.local.json'."),
      maxAgeHours: z.number().optional().describe("Warn if the export snapshot is older than this many hours. Omit for the built-in default."),
      ...exportDirShape,
    },
    annotations: READ_ONLY,
  },
  guarded(async (a: any) => {
    const mapPath = assertInsideCwd(a.map || "codeconnect.local.json");
    let map: any;
    try {
      map = JSON.parse(nodeFs.readFileSync(mapPath, "utf8"));
    } catch (e) {
      throw new Error(
        `Could not read the map at ${mapPath}: ${errMsg(e)}. Scaffold one with ` +
          `\`node design-to-code/map-bootstrap.js <componentsLocal> > codeconnect.local.json\`.`
      );
    }
    const catalog = JSON.parse(nodeFs.readFileSync(componentsLocalPath(a.exportDir), "utf8"));
    const res = driftLint(map, catalog, a.maxAgeHours ? { maxAgeMs: a.maxAgeHours * 3600000 } : undefined);
    // Drift is a FINDING, not a tool failure — return it as a normal result so the agent reads the
    // errors instead of an isError blob it may discard. `ok` is the thing to branch on.
    return textResult({ ok: res.errors.length === 0, ...res });
  })
);

async function main() {
  // stdio is the transport Claude Code speaks; the WebSocket to the plugin is internal.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[figma-mcp] MCP server up (stdio). Bridge listening on ws://localhost:" + bridge.port + ".");
}

main().catch((e) => {
  console.error("[figma-mcp] fatal:", errMsg(e));
  process.exit(1);
});
