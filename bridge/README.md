# bridge — figma-pull (read CLI) + figma-mcp (write MCP)

Local, loopback-only bridge between Claude Code and the **Design Export for AI** Figma plugin.
The plugin's hidden UI iframe is a WebSocket **client**; these processes are the **server**
(`127.0.0.1:8787`). Nothing touches the internet. See `../ARCHITECTURE.md` for the full design.

## Install (once)
```
cd bridge
npm install        # ws + @modelcontextprotocol/sdk (+ zod, and build deps for the MCP server)
```
The plugin manifest already allows the bridge in dev (`devAllowedDomains: ws://localhost:8787`),
so re-import the plugin in Figma after pulling these changes.

**Languages:** `figma-pull.js` (read CLI) and `server-core.js` (WS core) are plain CommonJS Node.
`figma-mcp` is **TypeScript** (`src/figma-mcp.mts`) built to **`figma-mcp.mjs`** (ESM, required by the
ESM-only MCP SDK). `figma-mcp.mjs` is committed, so it runs with **zero build**; only rebuild when you
edit the source:
```
npm run typecheck   # tsc --noEmit
npm run build       # esbuild src/figma-mcp.mts -> figma-mcp.mjs
```

### Bridge token (required)
The bridge authenticates every connection with a shared token — loopback binding alone is not
access control (a sandboxed browser iframe on any site the user visits sends `Origin: null` and
could otherwise drive the plugin). On start, the bridge either:
- uses `FIGMA_BRIDGE_TOKEN` if set (**recommended** — a stable value you paste once), or
- prints a random per-run token to the console.

Paste that token into the plugin's **Bridge token** field (stored per-user via `clientStorage`).
Set a stable token to avoid re-pasting:
```
export FIGMA_BRIDGE_TOKEN="$(openssl rand -hex 24)"   # add to your shell profile
```

## Read: figma-pull (CLI) — recommended for bulk extraction
```
# from the repo root, with the Figma file open + plugin running:
node bridge/figma-pull.js design             # design-system.json + CURRENT-page frames + assets/
node bridge/figma-pull.js design --all-pages # like above, but frame trees from EVERY page
node bridge/figma-pull.js design --selection # just the current selection
```
Scope note: the **design system** (variables, styles, component catalog) always spans the whole
file. **Frame trees** default to the current page; `--all-pages` walks every page (each screen is
tagged with its `page` name). All-pages can be large — the CLI is the right tool for it because it
streams to disk, not into the context window.
It waits for the plugin to connect, pulls, writes files to `design/`, and exits. The agent then
Reads those files — big payloads live on disk, not in the context window.

Allowlist it in Claude Code so it runs without a prompt (`.claude/settings.json`):
```
{ "permissions": { "allow": ["Bash(node bridge/figma-pull.js:*)"] } }
```

## Write / interactive: figma-mcp (MCP over stdio)
Registered via `../.mcp.json`. Start Claude Code in the repo; it launches `figma-mcp.mjs` over stdio.
The server also hosts the bridge WebSocket the plugin connects to. Built on `@modelcontextprotocol/sdk`
with the `McpServer` + `registerTool` + zod pattern (tool schemas are zod, validated per call).

Tools: `figma_status`, `figma_get_selection`, `figma_export_full`, `figma_export_selection`,
`figma_export_url`, `figma_write` (batch of safe ops — createFrame / createText / setFill /
setText; **no arbitrary code execution**, unlike some community servers). The export tools accept
opt-in read flags `css` / `measurements` / `pluginData` / `motion` / `sharedData`.

### "Paste a link and ask about it" (`figma_export_url`)
Keep Claude Code and the MCP running for the whole session; the plugin stays connected to your
open file. Then just paste a Figma link and ask — Claude pulls the node the link points to and
answers from live data, as many times as you like (free, no per-request cap):
```
you: here's the header — https://figma.com/design/KEY/App?node-id=123-456 — what spacing does it use?
→ Claude calls figma_export_url(url); the plugin selects node 123:456 and exports it live.
```
It reads the **live open file** — it can't fetch a link cold. The file the link points to must be
open in the Figma desktop app with the plugin running. A URL carries `node-id` in dash form
(`123-456`); the plugin normalises it to Plugin-API colon form (`123:456`) and switches pages /
scrolls the node into view so you can see what's being read.

Pre-approve tools in `.claude/settings.json`:
```
{ "permissions": { "allow": ["mcp__figma__*"] } }
```

## Notes / limits
- The Figma file must be **open** with the plugin running for either path (never headless).
- Only one of {figma-pull, figma-mcp} can hold port 8787 at a time — the second process now
  exits immediately with a clear `EADDRINUSE` message instead of hanging.
- Image assets travel as base64 (not JSON int-arrays) — ~3.5–4x smaller on the wire.
- v1 sends each response as a single WebSocket frame. If you hit very large pages, add chunking
  (see ARCHITECTURE.md "chunk large payloads").
- Write ops are a deliberately small, explicit set — extend `applyWrite()` in
  `../figma-plugin/src/writes.ts` (rebuild `code.js`) and add a matching `registerTool` here as needed.
