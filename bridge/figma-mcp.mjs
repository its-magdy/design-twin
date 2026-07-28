#!/usr/bin/env node
// GENERATED from src/figma-mcp.ts by build.js — run `npm run build`.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRequire } from "node:module";
const require2 = createRequire(import.meta.url);
const { createBridge } = require2("./server-core.js");
const { parseNodeId } = require2("./node-id.js");
const bridge = createBridge();
function textResult(obj) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}
function errorResult(e) {
  const message = typeof e === "string" ? e : String(e && e.message || e);
  return { content: [{ type: "text", text: message }], isError: true };
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
  if (r.assets.length) light.assetsNote = "Asset bytes omitted from context \u2014 run the figma-pull CLI to write them to design/assets/.";
  return light;
}
const readOptsShape = {
  css: z.boolean().optional().describe("Include Figma's OWN computed CSS per node (getCSSAsync) \u2014 the design-to-code oracle. One async call per node, so larger/slower; use for a screen you're implementing."),
  measurements: z.boolean().optional().describe("Include Dev-Mode measurement redlines (spacing specs the designer placed) for the current page. Dev Mode only."),
  pluginData: z.boolean().optional().describe("Include own-scope plugin data (getPluginData) stamped on nodes \u2014 round-trip metadata. Usually empty unless the write plane wrote it."),
  motion: z.boolean().optional().describe("Include motion/animation reads (timelines, manual keyframe tracks, animations, applied animation styles). Free via the Plugin API; useful for Slides/prototype animation. Can be verbose."),
  sharedData: z.boolean().optional().describe("Include cross-plugin shared data (getSharedPluginData) \u2014 notably Tokens Studio applied tokens (the semantic token layer on files without native Figma Variables). Free; per-node.")
};
const readOpts = (a) => ({ css: !!a.css, measurements: !!a.measurements, pluginData: !!a.pluginData, motion: !!a.motion, sharedData: !!a.sharedData });
const READ_ONLY = { readOnlyHint: true };
const server = new McpServer({ name: "figma-bridge", version: "0.1.0" });
server.registerTool(
  "figma_status",
  { description: "Check whether the Figma plugin is connected to the bridge, and which page is open.", annotations: READ_ONLY },
  guarded(async () => {
    if (!bridge.isConnected()) return textResult({ connected: false, hint: "Open the Figma file and run the plugin." });
    return textResult({ connected: true, ...await bridge.request("ping", {}) });
  })
);
server.registerTool(
  "figma_get_selection",
  { description: "List the currently selected nodes (id, name, type) in the open Figma file.", annotations: READ_ONLY },
  guarded(async () => textResult(await bridge.request("getSelection", {})))
);
server.registerTool(
  "figma_export_full",
  {
    description: "Export the design system (component + token catalog \u2014 always spans the WHOLE file) plus frame trees. Frames default to the CURRENT page only; pass allPages:true to walk every page. Large \u2014 prefer the figma-pull CLI for bulk reads (it writes to disk); use this for quick inspection.",
    inputSchema: {
      allPages: z.boolean().optional().describe("Export frame trees from every page, not just the current one. Can be very large \u2014 the figma-pull CLI is better for whole-file pulls."),
      ...readOptsShape
    },
    annotations: READ_ONLY
  },
  guarded(async (a) => textResult(stripAssets(await bridge.request("exportFull", { allPages: !!a.allPages, ...readOpts(a) }))))
);
server.registerTool(
  "figma_export_selection",
  { description: "Export the current selection as compacted node JSON + variables + assets.", inputSchema: { ...readOptsShape }, annotations: READ_ONLY },
  guarded(async (a) => textResult(stripAssets(await bridge.request("exportSelection", readOpts(a)))))
);
server.registerTool(
  "figma_export_url",
  {
    description: "Given a Figma design URL (containing ?node-id=...) or a bare node id, select that node in the open file and export it as compacted node JSON + variables + an asset manifest. This is the 'paste a link and ask about it' path. Requires the file the link points to be OPEN in the Figma desktop app with the plugin running (the bridge reads the live file \u2014 it cannot fetch a link cold).",
    inputSchema: {
      url: z.string().describe("A figma.com design/file URL with ?node-id=..., or a bare node id like '123:456' / '123-456'."),
      ...readOptsShape
    },
    annotations: READ_ONLY
  },
  guarded(async (a) => {
    const nodeId = parseNodeId(a.url);
    if (!nodeId) return errorResult("Couldn't find a node id in: " + a.url + " \u2014 paste a link that contains ?node-id=..., or the node id directly (e.g. 123:456).");
    return textResult(stripAssets(await bridge.request("exportNode", { nodeId, ...readOpts(a) })));
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
  console.error("[figma-mcp] fatal:", e.message);
  process.exit(1);
});
