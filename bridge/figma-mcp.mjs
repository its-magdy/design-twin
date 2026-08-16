#!/usr/bin/env node
// GENERATED from src/figma-mcp.ts by build.js — run `npm run build`.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRequire } from "node:module";
const require2 = createRequire(import.meta.url);
const { READ_OPTS } = require2("./read-opts.js");
const { createBridge, TIMEOUTS, exportTimeout, errMsg } = require2("./server-core.js");
const { parseNodeId, toNodeId } = require2("./node-id.js");
const bridge = createBridge();
function textResult(obj) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}
function errorResult(e) {
  return { content: [{ type: "text", text: errMsg(e) }], isError: true };
}
const guarded = (fn) => async (...a) => {
  try {
    return await fn(...a);
  } catch (e) {
    return errorResult(e);
  }
};
function stripAssets(r) {
  if (!r || !Array.isArray(r.assets)) return r;
  const light = { ...r, assets: r.assets.map((a) => ({ id: a.id, name: a.name, format: a.format, ...a.kind ? { kind: a.kind } : {} })) };
  if (r.assets.length) light.assetsNote = "Asset bytes omitted from context \u2014 re-run with writeToDisk:true to write them to <outDir>/assets/.";
  return light;
}
const { writeAny, assertInsideCwd } = require2("./write-out.js");
const wlog = (m) => console.error("[figma-mcp] " + m);
function exportResult(a, r) {
  if (!a || !a.writeToDisk) return textResult(stripAssets(r));
  assertInsideCwd(a.outDir);
  const written = writeAny(a.outDir, r, wlog);
  return textResult({
    ...written,
    note: "Export written to disk; node payloads intentionally omitted from this result. Read the files under outDir (start with the index) to inspect them at your own granularity."
  });
}
const writeShape = {
  writeToDisk: z.boolean().optional().describe("Write the export to disk and return a compact index (counts + file paths) instead of the node payloads. REQUIRED to get asset bytes \u2014 they are never returned inline \u2014 and the right choice for anything large, since inline results are capped and truncated."),
  outDir: z.string().optional().describe("Directory for writeToDisk, relative to the directory this MCP server was started in (i.e. your project). Default: FIGMA_EXPORT_DIR or 'design'.")
};
const readOptsShape = Object.fromEntries(
  READ_OPTS.map((o) => [o.name, z.boolean().optional().describe(o.describe)])
);
const READ_OPT_KEYS = Object.keys(readOptsShape);
const readOpts = (a) => Object.fromEntries(READ_OPT_KEYS.map((k) => [k, !!a[k]]));
const READ_ONLY = { readOnlyHint: true };
const { readSnapshotInfo } = require2("./snapshot-meta.js");
const server = new McpServer({ name: "figma-bridge", version: "0.1.0" });
server.registerTool(
  "figma_status",
  { description: "Check whether the Figma plugin is connected to the bridge, and which page is open. Also reports the age of the last figma-pull export on disk (design-system.json's exportedAt), if any \u2014 so an agent can tell whether it's about to read a stale snapshot.", annotations: READ_ONLY },
  guarded(async () => {
    const snapshot = readSnapshotInfo();
    if (!bridge.isConnected()) return textResult({ connected: false, hint: "Open the Figma file and run the plugin.", snapshot });
    return textResult({ connected: true, ...await bridge.request("ping", {}), snapshot });
  })
);
server.registerTool(
  "figma_whoami",
  {
    description: "Identity and liveness of the CONNECTED plugin: a per-run instanceId, the file/page name, whether figma.fileKey is available, plus how long the socket has been up and how many times a newer connection displaced an older one (takeovers). The bridge holds exactly ONE plugin connection, so if two Figma files both run the plugin the second one silently displaces the first — a non-zero `takeovers`, or an instanceId that differs from a previous call, is how you detect that. A CHANGED instanceId across two calls from the same file means Figma tore down and re-ran the plugin runtime, not that you switched files. Costs nothing (no page load, no node walk, no assets).",
    annotations: READ_ONLY
  },
  guarded(async () => textResult({ plugin: await bridge.request("whoami", {}), connection: bridge.connectionInfo() }))
);
server.registerTool(
  "figma_get_selection",
  { description: "List the currently selected nodes (id, name, type) in the open Figma file.", annotations: READ_ONLY },
  guarded(async () => textResult(await bridge.request("getSelection", {})))
);
server.registerTool(
  "figma_list_pages",
  {
    description: "CHEAP structural index of the open file: pages, and (depth 2) their top-level frames with id/name/type/size. No recursion, no assets, no node properties. Call this FIRST to decide WHICH page or frame to export, then pass those ids to figma_export_full({page}) or figma_export_url. depth 1 is near-free (page names only, loads nothing); depth 2 loads every page, which Figma warns can be slow on large files \u2014 still far cheaper than an export.",
    inputSchema: {
      depth: z.union([z.literal(1), z.literal(2)]).optional().describe("1 = page names only (near-free). 2 = pages + their top-level frames (default).")
    },
    annotations: READ_ONLY
  },
  // Pass `depth` through unnormalised: listPages owns the default (and the 1-vs-2 clamp), so a third
  // tier there doesn't need a matching edit here.
  guarded(async (a) => textResult(await bridge.request("listPages", { depth: a && a.depth }, TIMEOUTS.list)))
);
server.registerTool(
  "figma_list_libraries",
  {
    description: "CHEAP discovery: which design libraries this file draws on \u2014 the local file's own published assets plus every ENABLED team library \u2014 with each one's variable collections and how many of its components this file uses. Call this BEFORE exporting, then scope the export to what you actually need (figma_list_pages -> figma_export_full({page})). Limits worth knowing: component counts are USAGE-derived (Figma exposes no API to enumerate a library's full contents), and libraries can only be enabled from the Figma UI \u2014 never via API \u2014 so results reflect whatever was enabled at call time. An EMPTY result is a normal outcome (free plan, or no library enabled), not a failure; check `warnings`. Requires a plugin built with the 'teamlibrary' permission \u2014 re-import the plugin in Figma if this returns nothing.",
    annotations: READ_ONLY
  },
  // Compacted here rather than passed through: the plugin's shape is already small, but an agent
  // reads this tool's result in full, so collapse each library's collections to name+count and keep
  // `warnings` (the field that explains an empty list) intact. Same spirit as stripAssets.
  guarded(async () => {
    const r = await bridge.request("listLibraries", {}, TIMEOUTS.list);
    const libraries = (r && r.libraries || []).map((l) => ({
      key: l.key,
      name: l.name,
      kind: l.kind,
      componentCount: l.componentCount,
      variableCollections: (l.variableCollections || []).map((c) => ({ key: c.key, name: c.name, variableCount: c.variableCount })),
      ...l.note ? { note: l.note } : {}
    }));
    const warnings = r && r.warnings || [];
    return textResult({
      libraries,
      warnings,
      ...libraries.length ? {} : {
        note: "No libraries reported \u2014 a NORMAL outcome, not necessarily an error. Check, in order: the plugin in Figma predates the 'teamlibrary' permission (re-import it); no team library is enabled for this file (enable it in the Figma UI \u2014 no API can); free plan (library variable collections are not exposed to plugins)."
      },
      countsNote: "componentCount is USAGE-derived \u2014 components of that library used in THIS file. Figma exposes no API to enumerate a library's full contents."
    });
  })
);
server.registerTool(
  "figma_list_children",
  {
    description: "CHEAP listing of ONE node's DIRECT children (id/name/type/size/hasChildren) \u2014 no recursion, no assets. Use it to drill into a frame that figma_list_pages surfaced before committing to a full export of it. Accepts a bare node id or a figma.com URL containing ?node-id=.",
    inputSchema: {
      nodeId: z.string().describe("A node id like '123:456' / '123-456', or a figma.com design URL containing ?node-id=...")
    },
    annotations: READ_ONLY
  },
  guarded(async (a) => {
    const nodeId = toNodeId(a.nodeId);
    if (!nodeId) return errorResult("Provide a node id (e.g. 123:456) or a Figma URL containing ?node-id=... \u2014 see figma_list_pages.");
    return textResult(await bridge.request("listChildren", { nodeId }, TIMEOUTS.list));
  })
);
server.registerTool(
  "figma_export_full",
  {
    description: "Export the design system (component + token catalog \u2014 always spans the WHOLE file) plus frame trees. Frames default to the CURRENT page; pass page:[ids] to export named page(s), or allPages:true to walk every page. Large \u2014 call figma_list_pages first to pick a target, and pass writeToDisk:true for anything beyond a quick look: it writes the export to your project and returns a compact index, which is the only way to get asset bytes and avoids the result cap truncating the tree.",
    inputSchema: {
      allPages: z.boolean().optional().describe("Export frame trees from every page. Can be very large and slow (measured >15 min on a 25-page file) \u2014 prefer `page` with ids from figma_list_pages, or the figma-pull CLI."),
      page: z.array(z.string()).optional().describe("Export these page(s) by id (preferred) or exact name, instead of the current page. Ids come from figma_list_pages. Cannot be combined with allPages \u2014 passing both is refused rather than silently resolved. An unknown or ambiguous name fails with the available pages listed."),
      ...readOptsShape,
      ...writeShape
    },
    annotations: READ_ONLY
  },
  // The budget follows the SCOPE, exactly as the figma-pull CLI's does: exportAll (15 min) only for
  // the whole-file walk, export (5 min) for the current page or a bounded page:[ids] pull. Handing
  // every scope the whole-file budget made the bounded pull — the one this tool's own description
  // tells you to prefer — wait 15 minutes to report a hang that a 5-minute limit would have caught,
  // and quietly undid the point of having tiers in the shared TIMEOUTS table at all.
  // `page` is forwarded only when non-empty — an empty array must not read as a selector (collect.ts
  // would warn and fall back to the current page).
  guarded(async (a) => {
    const page = Array.isArray(a.page) && a.page.length ? a.page : void 0;
    const allPages = !!a.allPages;
    return exportResult(a, await bridge.request(
      "exportFull",
      { allPages, page, ...readOpts(a) },
      exportTimeout({ allPages })
    ));
  })
);
server.registerTool(
  "figma_export_design_system",
  {
    description: "Export ONLY the design system \u2014 variables, styles, local + library components, hygiene report \u2014 with no page/frame walk and therefore no assets (assets are exported per-node during that walk). The cheap sibling of figma_export_full for callers who just want tokens/styles/components. One tradeoff: library (remote) variable completeness depends on nodes/styles actually walked in this session, so a bare design-system pull may see fewer of them than a full pull would \u2014 local variables, styles and components are unaffected. Pass writeToDisk:true for the design-system/ split.",
    inputSchema: { ...writeShape },
    annotations: READ_ONLY
  },
  // buildDesignSystem() walks every page's component catalog (loadAllPages + findAllWithCriteria), so
  // this is EXPORT-tier work despite taking no scope arguments — TIMEOUTS.list would undersell it.
  guarded(async (a) => exportResult(a, await bridge.request("exportDesignSystem", {}, TIMEOUTS.export)))
);
server.registerTool(
  "figma_export_selection",
  {
    description: "Export the current selection as compacted node JSON + variables + assets.",
    inputSchema: { ...readOptsShape, ...writeShape },
    annotations: READ_ONLY
  },
  guarded(async (a) => exportResult(a, await bridge.request("exportSelection", readOpts(a), exportTimeout({ selection: true }))))
);
server.registerTool(
  "figma_export_url",
  {
    description: "Given a Figma design URL (containing ?node-id=...) or a bare node id, select that node in the open file and export it as compacted node JSON + variables + an asset manifest. This is the 'paste a link and ask about it' path. Requires the file the link points to be OPEN in the Figma desktop app with the plugin running (the bridge reads the live file \u2014 it cannot fetch a link cold).",
    inputSchema: {
      url: z.string().describe("A figma.com design/file URL with ?node-id=..., or a bare node id like '123:456' / '123-456'."),
      ...readOptsShape,
      ...writeShape
    },
    annotations: READ_ONLY
  },
  guarded(async (a) => {
    const nodeId = parseNodeId(a.url);
    if (!nodeId) return errorResult("Couldn't find a node id in: " + a.url + " \u2014 paste a link that contains ?node-id=..., or the node id directly (e.g. 123:456).");
    return exportResult(a, await bridge.request("exportNode", { nodeId, ...readOpts(a) }, TIMEOUTS.export));
  })
);
server.registerTool(
  "figma_write",
  {
    description: "Apply a batch of safe write operations to the open Figma file. Each op: {op:'createFrame', name?, width?, height?, layoutMode?('HORIZONTAL'|'VERTICAL'), itemSpacing?, padding?[t,r,b,l], fill?(#hex), parentId?} | {op:'createText', text, fontSize?, fill?, parentId?} | {op:'setFill', nodeId, color(#hex)} | {op:'setText', nodeId, text}. Ops are applied in order and are NOT transactional: if one fails, the earlier ones stay applied and their node ids are reported alongside the error so you can continue or clean up.",
    inputSchema: {
      // Constrain `op` to the four ops the plugin actually implements — reject unknown ops at the
      // boundary rather than round-tripping them to the plugin. Other fields stay open (.passthrough).
      ops: z.array(z.object({ op: z.enum(["createFrame", "createText", "setFill", "setText"]) }).passthrough()).describe("Ordered list of write operations (each must have an `op` field).")
    },
    // destructiveHint MUST stay true. Per the MCP schema it asserts, when false, that "the tool
    // performs only additive updates" — but setFill/setText OVERWRITE properties on nodes the user
    // already has, and (as the description says) nothing here is transactional or rollback-able.
    // Clients use these hints to decide whether to put a human in the loop, so declaring `false`
    // suppressed the confirmation prompt on the one tool that irreversibly mutates a design file.
    // idempotentHint is likewise false: re-running a batch creates a SECOND set of frames/text.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  },
  guarded(async (a) => {
    const r = await bridge.request("write", { ops: a.ops || [] });
    if (r && r.ok === false) {
      const applied = Array.isArray(r.applied) ? r.applied : [];
      return errorResult(
        `Write failed at op ${r.failedAt}${r.failedOp ? " (" + r.failedOp + ")" : ""}: ${r.error}
${applied.length} earlier op(s) were applied and NOT rolled back:
` + JSON.stringify(applied, null, 2)
      );
    }
    return textResult(r);
  })
);
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[figma-mcp] MCP server up (stdio). Bridge listening on ws://localhost:" + bridge.port + ".");
}
main().catch((e) => {
  console.error("[figma-mcp] fatal:", errMsg(e));
  process.exit(1);
});
