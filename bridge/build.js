// Transpiles src/figma-mcp.ts -> figma-mcp.mjs (committed; .mcp.json loads it).
// bundle:false => types are stripped but every import/require is left intact, so Node resolves
// @modelcontextprotocol/sdk, zod, and the CJS ./server-core.js at runtime from node_modules / disk.
// server-core.js and figma-pull.js stay plain CJS — only the MCP entry is ESM/TS.
const esbuild = require("esbuild");
const path = require("path");

esbuild
  .build({
    entryPoints: [path.join(__dirname, "src", "figma-mcp.mts")],
    outfile: path.join(__dirname, "figma-mcp.mjs"),
    bundle: false, // leave imports/requires for Node to resolve
    format: "esm",
    platform: "node",
    target: "node18",
    banner: { js: "#!/usr/bin/env node\n// GENERATED from src/figma-mcp.ts by build.js — run `npm run build`." },
    logLevel: "info",
  })
  .then(() => console.log("[build] wrote figma-mcp.mjs"))
  .catch((e) => { console.error(e); process.exit(1); });
