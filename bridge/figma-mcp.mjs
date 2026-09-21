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
const daemon = require2("./daemon.js");
let own = null;
async function holder() {
  if (own) return { own };
  const via = await daemon.connect();
  if (via) return { via };
  const mine = createBridge();
  own = mine;
  const shared = Object.assign(Object.create(mine), { close: () => {
    own = null;
    mine.close();
  } });
  daemon.serve(shared, { idleMin: 0, signals: false, log: (m) => console.error("[figma-mcp] " + m) }).catch((e) => console.error("[figma-mcp] not sharing the bridge with other sessions: " + errMsg(e)));
  return { own: mine };
}
const bridge = {
  async request(cmd, args, timeoutMs = TIMEOUTS.command, target) {
    const h = await holder();
    if ("own" in h) return h.own.request(cmd, args, timeoutMs, target);
    return h.via.request({ cmd, args, timeoutMs, client: target }, timeoutMs + 3e4);
  },
  async listClients() {
    const h = await holder();
    return "own" in h ? h.own.listClients() : (await daemon.status() || {}).clients || [];
  },
  async connectionInfo() {
    const h = await holder();
    if ("own" in h) return h.own.connectionInfo();
    const st = await daemon.status() || {};
    return { via: "shared bridge (pid " + st.pid + ")", port: st.port, pluginConnected: st.pluginConnected };
  }
};
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
const clientShape = {
  client: z.string().optional().describe("WHICH connected Figma file to talk to \u2014 a connId (from figma_list_clients), a fileKey, or part of the file's name. The bridge accepts one connection per open Figma file, so a design file and the library it draws on can both be connected at once. Omit when only one file is connected. With several connected, omitting this is an ERROR listing the choices rather than a guess \u2014 an export from the wrong file is indistinguishable from a correct one.")
};
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
const server = new McpServer({ name: "designtwin", version: "0.1.0" });
server.registerTool(
  "figma_status",
  {
    description: "Check which Figma files are connected to the bridge, and which page each has open. Several files can be connected at once (one per open Figma file running the plugin) \u2014 the `clients` array lists them, and each row's connId is what you pass as `client` to every other tool. Also reports the age of the last dtwin export on disk (design-system.json's exportedAt), if any \u2014 so an agent can tell whether it's about to read a stale snapshot.",
    inputSchema: { ...clientShape },
    annotations: READ_ONLY
  },
  guarded(async (a) => {
    const snapshot = readSnapshotInfo();
    const clients = await bridge.listClients();
    if (!clients.length) return textResult({ connected: false, hint: "Open the Figma file and run the plugin.", snapshot });
    if (clients.length > 1 && !(a && a.client)) {
      return textResult({
        connected: true,
        clients,
        snapshot,
        note: "Several Figma files are connected. Pass `client` (connId, fileKey, or part of the file name) to every tool call, or it will be refused rather than guess which file you meant."
      });
    }
    return textResult({ connected: true, clients, ...await bridge.request("ping", {}, TIMEOUTS.command, a && a.client), snapshot });
  })
);
server.registerTool(
  "figma_list_clients",
  {
    description: "WHICH Figma files are currently connected to the bridge \u2014 the discovery step before addressing one. Each row gives a connId (the routing key), the file name, its fileKey when available, the open page, and how long it has been connected. Pass any of connId / fileKey / part of the file name as `client` on the other tools. The bridge accepts one connection per open Figma file, so a design file and the library it draws on can be driven in the same session without either displacing the other. Costs nothing \u2014 it reads the bridge's own registry and never touches the plugin, so it answers even while every connected file is busy with a long export.",
    annotations: READ_ONLY
  },
  guarded(async () => {
    const clients = await bridge.listClients();
    return textResult({
      clients,
      count: clients.length,
      // The EMPTY case has to explain itself: nothing connected is the normal state before the plugin
      // is opened, not a broken bridge.
      ...clients.length ? {} : {
        note: 'Nothing connected. Open a file in Figma and run "Design Twin" (Plugins \u2192 Development) \u2014 it auto-connects and announces itself. You can open it in several files at once; each becomes a separate row here.'
      },
      ...clients.some((c) => !c.identified) ? {
        identifiedNote: "A row with identified:false is connected but has not announced itself yet (or is an older plugin build that does not) \u2014 address it by connId."
      } : {}
    });
  })
);
server.registerTool(
  "figma_whoami",
  {
    description: "Identity and liveness of ONE connected plugin: a per-run instanceId, the file/page name, whether figma.fileKey is available, and how long its socket has been up. Use figma_list_clients to see every connected file; use this to interrogate one of them. A CHANGED instanceId across two calls addressing the same file means Figma tore down and re-ran the plugin runtime (the connection survived, the runtime did not) \u2014 worth knowing if a long-idle file starts behaving oddly. Costs nothing (no page load, no node walk, no assets).",
    inputSchema: { ...clientShape },
    annotations: READ_ONLY
  },
  guarded(async (a) => textResult({
    plugin: await bridge.request("whoami", {}, TIMEOUTS.command, a && a.client),
    connection: await bridge.connectionInfo()
  }))
);
server.registerTool(
  "figma_get_selection",
  {
    description: "List the currently selected nodes (id, name, type) in a connected Figma file.",
    inputSchema: { ...clientShape },
    annotations: READ_ONLY
  },
  guarded(async (a) => textResult(await bridge.request("getSelection", {}, TIMEOUTS.command, a && a.client)))
);
server.registerTool(
  "figma_list_pages",
  {
    description: "CHEAP structural index of the open file: pages, and (depth 2) their top-level frames with id/name/type/size. No recursion, no assets, no node properties. Call this FIRST to decide WHICH page or frame to export, then pass those ids to figma_export_full({page}) or figma_export_url. depth 1 is near-free (page names only, loads nothing); depth 2 loads every page, which Figma warns can be slow on large files \u2014 still far cheaper than an export.",
    inputSchema: {
      ...clientShape,
      depth: z.union([z.literal(1), z.literal(2)]).optional().describe("1 = page names only (near-free). 2 = pages + their top-level frames (default).")
    },
    annotations: READ_ONLY
  },
  // Pass `depth` through unnormalised: listPages owns the default (and the 1-vs-2 clamp), so a third
  // tier there doesn't need a matching edit here.
  guarded(async (a) => textResult(await bridge.request("listPages", { depth: a && a.depth }, TIMEOUTS.list, a && a.client)))
);
server.registerTool(
  "figma_list_libraries",
  {
    description: "CHEAP discovery: which design libraries this file draws on \u2014 the local file's own published assets plus every ENABLED team library \u2014 with each one's variable collections and how many of its components this file uses. Call this BEFORE exporting, then scope the export to what you actually need (figma_list_pages -> figma_export_full({page})). Limits worth knowing: component counts are USAGE-derived (Figma exposes no API to enumerate a library's full contents), and libraries can only be enabled from the Figma UI \u2014 never via API \u2014 so results reflect whatever was enabled at call time. An EMPTY result is a normal outcome (free plan, or no library enabled), not a failure; check `warnings`. Requires a plugin built with the 'teamlibrary' permission \u2014 re-import the plugin in Figma if this returns nothing.",
    inputSchema: { ...clientShape },
    annotations: READ_ONLY
  },
  // Compacted here rather than passed through: the plugin's shape is already small, but an agent
  // reads this tool's result in full, so collapse each library's collections to name+count and keep
  // `warnings` (the field that explains an empty list) intact. Same spirit as stripAssets.
  guarded(async (a) => {
    const r = await bridge.request("listLibraries", {}, TIMEOUTS.list, a && a.client);
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
      ...clientShape,
      nodeId: z.string().describe("A node id like '123:456' / '123-456', or a figma.com design URL containing ?node-id=...")
    },
    annotations: READ_ONLY
  },
  guarded(async (a) => {
    const nodeId = toNodeId(a.nodeId);
    if (!nodeId) return errorResult("Provide a node id (e.g. 123:456) or a Figma URL containing ?node-id=... \u2014 see figma_list_pages.");
    return textResult(await bridge.request("listChildren", { nodeId }, TIMEOUTS.list, a && a.client));
  })
);
server.registerTool(
  "figma_export_full",
  {
    description: "Export the design system (component + token catalog \u2014 always spans the WHOLE file) plus frame trees. Frames default to the CURRENT page; pass page:[ids] to export named page(s), or allPages:true to walk every page. Large \u2014 call figma_list_pages first to pick a target, and pass writeToDisk:true for anything beyond a quick look: it writes the export to your project and returns a compact index, which is the only way to get asset bytes and avoids the result cap truncating the tree.",
    inputSchema: {
      ...clientShape,
      allPages: z.boolean().optional().describe("Export frame trees from every page. Can be very large and slow (measured >15 min on a 25-page file) \u2014 prefer `page` with ids from figma_list_pages, or the dtwin CLI."),
      page: z.array(z.string()).optional().describe("Export these page(s) by id (preferred) or exact name, instead of the current page. Ids come from figma_list_pages. Cannot be combined with allPages \u2014 passing both is refused rather than silently resolved. An unknown or ambiguous name fails with the available pages listed."),
      ...readOptsShape,
      ...writeShape
    },
    annotations: READ_ONLY
  },
  // The budget follows the SCOPE, exactly as the dtwin CLI's does: exportAll (15 min) only for
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
      exportTimeout({ allPages }),
      a && a.client
    ));
  })
);
server.registerTool(
  "figma_export_design_system",
  {
    description: "Export ONLY the design system \u2014 variables, styles, local + library components, hygiene report \u2014 with no page/frame walk and therefore no assets (assets are exported per-node during that walk). The cheap sibling of figma_export_full for callers who just want tokens/styles/components. One tradeoff: library (remote) variable completeness depends on nodes/styles actually walked in this session, so a bare design-system pull may see fewer of them than a full pull would \u2014 local variables, styles and components are unaffected. Pass writeToDisk:true for the design-system/ split. Each catalogued component/variant carries its own fills/strokes/effects/cornerRadius/opacity/blendMode (componentsLocal[].visuals) \u2014 components DEFINED in this file only, not ones consumed from a published library (pull dtwin --as-library on the source library file for those). Pass variantVisuals:true to also attach each COMPONENT_SET's variants' REAL layout/fills/radius/tokens (componentsLocal[].variants) \u2014 the master-component source of truth, not the set wrapper's own selection-chrome visuals. It is the ONE read option this tool accepts (the others need a node/page walk this tool skips); one extra node walk per variant, so it is slower on a large design system.",
    inputSchema: { ...clientShape, variantVisuals: readOptsShape.variantVisuals, ...writeShape },
    annotations: READ_ONLY
  },
  // buildDesignSystem() walks every page's component catalog (loadAllPages + findAllWithCriteria), so
  // this is EXPORT-tier work despite taking no scope arguments — TIMEOUTS.list would undersell it.
  guarded(async (a) => exportResult(a, await bridge.request("exportDesignSystem", { variantVisuals: a && a.variantVisuals }, TIMEOUTS.export, a && a.client)))
);
server.registerTool(
  "figma_export_selection",
  {
    description: "Export the current selection as compacted node JSON + variables + assets.",
    inputSchema: { ...clientShape, ...readOptsShape, ...writeShape },
    annotations: READ_ONLY
  },
  guarded(async (a) => exportResult(a, await bridge.request("exportSelection", readOpts(a), exportTimeout({ selection: true }), a && a.client)))
);
server.registerTool(
  "figma_export_url",
  {
    description: "Given a Figma design URL (containing ?node-id=...) or a bare node id, select that node in the open file and export it as compacted node JSON + variables + an asset manifest. This is the 'paste a link and ask about it' path. Requires the file the link points to be OPEN in the Figma desktop app with the plugin running (the bridge reads the live file \u2014 it cannot fetch a link cold).",
    inputSchema: {
      ...clientShape,
      url: z.string().describe("A figma.com design/file URL with ?node-id=..., or a bare node id like '123:456' / '123-456'."),
      ...readOptsShape,
      ...writeShape
    },
    annotations: READ_ONLY
  },
  guarded(async (a) => {
    const nodeId = parseNodeId(a.url);
    if (!nodeId) return errorResult("Couldn't find a node id in: " + a.url + " \u2014 paste a link that contains ?node-id=..., or the node id directly (e.g. 123:456).");
    return exportResult(a, await bridge.request("exportNode", { nodeId, ...readOpts(a) }, TIMEOUTS.export, a && a.client));
  })
);
server.registerTool(
  "figma_screenshot",
  {
    description: "On-demand PNG of ONE node \u2014 the visual-validation counterpart to figma_export_* (which already attach a whole-frame reference PNG to every exported root). Use this to check a SPECIFIC component/instance buried in a dense screen against the code you generated for it, without re-exporting or walking the whole frame. Mirrors Figma's own get_screenshot tool (single-node scope, called on demand after get_metadata/figma_list_children, as a validation step) rather than pre-rendering every node up front. Pass writeToDisk:true to get the actual PNG file \u2014 REQUIRED, since asset bytes are never returned inline.",
    inputSchema: {
      ...clientShape,
      nodeId: z.string().describe("A node id like '123:456' / '123-456', or a figma.com design URL containing ?node-id=..."),
      scale: z.number().positive().optional().describe("Override the default render scale (auto, capped at 2048px on the longest side)."),
      ...writeShape
    },
    annotations: READ_ONLY
  },
  guarded(async (a) => {
    const nodeId = toNodeId(a.nodeId);
    if (!nodeId) return errorResult("Provide a node id (e.g. 123:456) or a Figma URL containing ?node-id=... \u2014 see figma_list_pages.");
    return exportResult(a, await bridge.request("screenshot", { nodeId, scale: a.scale }, TIMEOUTS.export, a && a.client));
  })
);
function previewWrites(ops) {
  const steps = ops.map((o, i) => {
    const creates = o.op === "createFrame" || o.op === "createText";
    const missing = o.op === "createText" ? o.text == null ? ["text"] : [] : o.op === "setFill" ? ["nodeId", "color"].filter((k) => o[k] == null) : o.op === "setText" ? ["nodeId", "text"].filter((k) => o[k] == null) : [];
    return {
      index: i,
      op: o.op,
      effect: creates ? "creates" : "overwrites",
      target: creates ? o.parentId ? `new node under ${o.parentId}` : "new node on the current page" : o.nodeId || null,
      ...o.op === "setFill" ? { newFill: o.color } : {},
      ...o.op === "setText" || o.op === "createText" ? { newText: o.text } : {},
      ...missing.length ? { invalid: `missing ${missing.join(", ")}` } : {}
    };
  });
  return {
    dryRun: true,
    applied: false,
    creates: steps.filter((s) => s.effect === "creates").length,
    overwrites: steps.filter((s) => s.effect === "overwrites").length,
    invalid: steps.filter((s) => "invalid" in s).length,
    steps,
    note: "Nothing was changed. Overwrites cannot be undone from here (only Cmd-Z in Figma). Re-call without dryRun to apply."
  };
}
server.registerTool(
  "figma_write",
  {
    description: "Apply a batch of safe write operations to the open Figma file. Each op: {op:'createFrame', name?, width?, height?, layoutMode?('HORIZONTAL'|'VERTICAL'), itemSpacing?, padding?[t,r,b,l], fill?(#hex), parentId?} | {op:'createText', text, fontSize?, fill?, parentId?} | {op:'setFill', nodeId, color(#hex)} | {op:'setText', nodeId, text}. Ops are applied in order and are NOT transactional: if one fails, the earlier ones stay applied and their node ids are reported alongside the error so you can continue or clean up. There is no undo from here (only the designer's own Cmd-Z) \u2014 so for anything that OVERWRITES (setFill/setText), call once with dryRun:true, show the user the preview, and only then apply.",
    inputSchema: {
      ...clientShape,
      // Constrain `op` to the four ops the plugin actually implements — reject unknown ops at the
      // boundary rather than round-tripping them to the plugin. Other fields stay open (.passthrough).
      ops: z.array(z.object({ op: z.enum(["createFrame", "createText", "setFill", "setText"]) }).passthrough()).describe("Ordered list of write operations (each must have an `op` field)."),
      dryRun: z.boolean().optional().describe("true = validate the batch and return a preview of what each op would create/overwrite, WITHOUT touching the Figma file (needs no plugin connection).")
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
    if (a.dryRun) return textResult(previewWrites(a.ops || []));
    const r = await bridge.request("write", { ops: a.ops || [] }, TIMEOUTS.command, a && a.client);
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
function loadLayer(mod, tool) {
  try {
    return require2("../design-to-code/" + mod);
  } catch (e) {
    throw new Error(
      `${tool} needs the design-to-code layer, which is not present in this install. It ships with the Design Twin repository, not with the published npm package \u2014 run this MCP server from a repo checkout (node bridge/figma-mcp.mjs) to use it. Everything else on this server works either way.`
    );
  }
}
const getComponent = (catalogFile, handle) => loadLayer("get-component.js", "design_get_component").getComponent(
  catalogFile,
  handle
);
const driftLint = (map, catalog, opts) => loadLayer("drift-lint.js", "design_drift_lint").driftLint(
  map,
  catalog,
  opts
);
const nodeFs = require2("node:fs");
const nodePath = require2("node:path");
function componentsLocalPath(exportDir) {
  const dir = assertInsideCwd(exportDir);
  const manifestPath = nodePath.join(dir, "design-system.json");
  let manifest;
  try {
    manifest = JSON.parse(nodeFs.readFileSync(manifestPath, "utf8"));
  } catch (e) {
    throw new Error(
      `No design export found at ${manifestPath}. Run an export first (figma_export_design_system with writeToDisk:true, or the dtwin CLI), or pass exportDir.`
    );
  }
  const rel = manifest && manifest.files && manifest.files.componentsLocal;
  if (!rel) throw new Error(`${manifestPath} has no files.componentsLocal pointer \u2014 re-export with a current dtwin.`);
  return nodePath.join(dir, rel);
}
const exportDirShape = {
  exportDir: z.string().optional().describe(
    "Directory holding the design export, relative to the directory this server was started in. Default: FIGMA_EXPORT_DIR or 'design'."
  )
};
server.registerTool(
  "design_get_component",
  {
    description: "Read ONE component out of the design export on disk, with its real variant node trees. Handle is the component's stable publish `key` (preferred \u2014 survives renames), its node id, or its exact name (an ambiguous name is an ERROR listing the keys, never a guess). Use this when building a screen and you need one component's actual variant visuals: the catalog is deliberately slim, so every COMPONENT_SET's heavy per-variant node trees live in their own file and this is the tool that follows that pointer. Needs NO Figma connection and costs nothing \u2014 it reads files an earlier export already wrote.",
    inputSchema: {
      handle: z.string().describe("Component publish key, node id, or exact name. Keys come from design_drift_lint or the components.local.json catalog."),
      ...exportDirShape
    },
    annotations: READ_ONLY
  },
  guarded(async (a) => {
    const res = getComponent(componentsLocalPath(a.exportDir), a.handle);
    if (!res.found) return errorResult(`No component matches '${a.handle}' in the export. Try its publish key or id.`);
    if (!res.detail) {
      return textResult({
        component: res.component,
        detail: null,
        note: "No node trees were exported for this component \u2014 re-run the export with variantVisuals:true to get its variant visuals."
      });
    }
    return textResult({ component: res.component, detail: res.detail });
  })
);
server.registerTool(
  "design_drift_lint",
  {
    description: "Check a codeconnect.local.json map against the design export for DRIFT, and report snapshot staleness. Joins on the stable publish `key`, so it catches the case Figma's own Code Connect ships silently (its node-id join misses renamed/republished components \u2014 issue #337): orphaned map entries, unmapped components, stale or uncovered props, kind/enum mismatches. Also warns when the export on disk is older than --max-age. Run it before building a screen (so you find out the map is wrong BEFORE generating code against it) and in CI/pre-commit. Needs NO Figma connection.",
    inputSchema: {
      map: z.string().optional().describe("Path to the map, relative to the server's start directory. Default: 'codeconnect.local.json'."),
      maxAgeHours: z.number().optional().describe("Warn if the export snapshot is older than this many hours. Omit for the built-in default."),
      ...exportDirShape
    },
    annotations: READ_ONLY
  },
  guarded(async (a) => {
    const mapPath = assertInsideCwd(a.map || "codeconnect.local.json");
    let map;
    try {
      map = JSON.parse(nodeFs.readFileSync(mapPath, "utf8"));
    } catch (e) {
      throw new Error(
        `Could not read the map at ${mapPath}: ${errMsg(e)}. Scaffold one with \`node design-to-code/map-bootstrap.js <componentsLocal> > codeconnect.local.json\`.`
      );
    }
    const catalog = JSON.parse(nodeFs.readFileSync(componentsLocalPath(a.exportDir), "utf8"));
    const res = driftLint(map, catalog, a.maxAgeHours ? { maxAgeMs: a.maxAgeHours * 36e5 } : void 0);
    return textResult({ ok: res.errors.length === 0, ...res });
  })
);
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const h = await holder();
  console.error("[figma-mcp] MCP server up (stdio). " + ("own" in h ? "Bridge listening on ws://localhost:" + h.own.port + "." : "Sharing the bridge already running at " + h.via.sock + "."));
}
main().catch((e) => {
  console.error("[figma-mcp] fatal:", errMsg(e));
  process.exit(1);
});
