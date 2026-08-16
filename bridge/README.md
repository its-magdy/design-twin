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

> **Re-import the plugin — required for library reads.** The manifest now declares
> `"permissions": ["teamlibrary"]`, without which Figma denies the team-library APIs. A plugin
> imported before this change keeps running happily and simply returns **no libraries** — a silent
> empty result, not an error. If `--list-libraries` / `figma_list_libraries` shows nothing, re-import
> `figma-plugin/manifest.json` (Plugins → Development → Import plugin from manifest…) first.

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

A full pull writes `design/design-system.json` as a slim MANIFEST (`exportedAt`/`file`/`colorProfile`,
`files` pointers, `counts`) over the catalog split under `design/design-system/`, one file per Figma
concept: `tokens.json` (variable collections → modes → variables), one file per style type —
`styles.paint.json`/`styles.text.json`/`styles.effect.json`/`styles.grid.json` — (the separate
Paint/Text/Effect/Grid style system), `components.local.json` (components that are real nodes in this
file), `components.library.json` (`remote: true` — consumed from a published library, recovered from
instances, props possibly inferred) and `hygiene.json` (the lint report). Every part repeats the
`exportedAt` stamp, so `tooling/` reads freshness off whichever part it is handed. The split files sit
in a subdirectory because `design/tokens.json` and `design/components.json` at the export root are your
hand-authored, non-regenerable config maps.

```
# from the repo root, with the Figma file open + plugin running:
node bridge/figma-pull.js design                  # design-system.json + design-system/ + CURRENT-page frames + assets/
node bridge/figma-pull.js design --all-pages      # like above, but frame trees from EVERY page
node bridge/figma-pull.js design --selection      # just the current selection
node bridge/figma-pull.js design --design-system  # ONLY design-system.json + design-system/ — no page
                                                   # walk, no assets/ (the cheap "tokens only" pull)
```
**Recommended workflow — discover, then scope.** Never open with a whole-file pull. Work down from
cheap questions to expensive ones, which is also what Figma's own agent guidance recommends
(discover first, then scope by library):
```
node bridge/figma-pull.js --list-libraries      # 1. WHICH libraries does this file draw on?
node bridge/figma-pull.js --list                # 2. WHERE is what — pages + top-level frames (ids)
node bridge/figma-pull.js --children <id>       # 3. (optional) peek inside one frame
node bridge/figma-pull.js design --page <id>    # 4. pull only what you need
```

### `--list-libraries` — the library discovery step
```
node bridge/figma-pull.js --list-libraries
```
Prints an aligned table of the libraries this file uses — the local file's own published assets plus
every **enabled** team library — with each one's variable collections (and variable counts) and how
many of its components this file uses. It's the library-scoped sibling of `--list`: same cost tier
(no recursion, no node properties, no assets), same `--timeout`, prints to stdout and writes nothing.

Three honest limits, because they change what the numbers mean:
- **Component counts are usage-derived.** Figma exposes **no API to enumerate a library's contents**,
  so the count is "components of that library used in *this* file", not the library's size.
- **Libraries can only be enabled from the Figma UI** (Assets panel → Libraries) — no API can enable
  one. An export is therefore silently scoped to whatever was enabled at export time; if a component
  looks unresolved, an unenabled library is the first thing to check.
- **An empty result is normal**, not a failure: free plans don't expose library variable collections,
  and a file with no library enabled genuinely has none. The output says so rather than printing an
  empty table. It is also what a **stale plugin** looks like — see the re-import callout above.

Scope note: the **design system** (variables, styles, component catalog) always spans the whole
file. **Frame trees** default to the current page; `--all-pages` walks every page (each screen is
tagged with its `page` name). All-pages can be large — the CLI is the right tool for it because it
streams to disk, not into the context window. `--design-system` narrows the OTHER way: it skips the
frame walk (and therefore the assets a walk would export) and writes only `design-system.json` +
`design-system/` — tokens, styles, local + library components, hygiene. One honest limit: library
(remote) *variables* are recovered from nodes/styles actually walked, so a run with no page walk sees
fewer of them than a full pull would; local variables, styles and components are unaffected. It shares
`--selection`/`--all-pages`/`--page`'s scope slot (pass only one) and, like `--list`/`--list-libraries`,
refuses the read-option flags (`--css`/`--measurements`/…) since there is no node walk for them to apply to.
It waits for the plugin to connect, pulls, writes files to `design/`, and exits. The agent then
Reads those files — big payloads live on disk, not in the context window.

Allowlist it in Claude Code so it runs without a prompt (`.claude/settings.json`):
```
{ "permissions": { "allow": ["Bash(node bridge/figma-pull.js:*)"] } }
```

### Keep the connection open: `--serve` (daemon)
Each one-shot run above waits for the plugin to reconnect. For several pulls in a row, hold the bridge
open and let later invocations reuse it:
```
node bridge/figma-pull.js --serve          # holds the bridge open until stopped (Ctrl-C works too)
node bridge/figma-pull.js --daemon-status  # is one up, and is the plugin connected?
node bridge/figma-pull.js --stop
```
Every ordinary command detects a running daemon and **routes through it automatically** — same
invocations, no reconnect, no second bridge to collide on 8787.

Why a daemon rather than "a flag that just leaves the connection open": a long-running CLI has no way
to receive further commands, so it would hold the port while being unreachable — blocking the MCP
server and every other CLI call. Instead one process (`--serve`) owns the bridge and each later
invocation is a thin client over a unix socket in `$TMPDIR`.

Behaviour worth knowing:
- Requests are **serialized**. The plugin is single-threaded and its heavy commands mutate shared
  per-run state (`serializeRun` in `bridge.ts`), so the daemon runs one at a time, in arrival order —
  exactly like a sequence of one-shot runs.
- `--serve` / `--stop` / `--daemon-status` each own the whole invocation; combining one with a pull or
  a read option is refused rather than silently dropping the export you typed.
- A stale socket left by a crashed daemon reads as "no daemon" and is replaced, rather than making
  every later run fail against a file nobody is listening on.
- A second `--serve` is **refused**, not allowed to steal the live socket.
- **Idle shutdown after 120 min** (`FIGMA_DAEMON_IDLE_MIN`, `0` disables). A daemon outlives the
  terminal that started it, so this reaps abandoned ones instead of leaving port 8787 held by a
  process you've forgotten. It is deliberately generous, the clock resets on every request, and a
  request in flight holds it off entirely — a 15-minute `--all-pages` export is never cut short by
  its own daemon. `--daemon-status` shows how much of the window is used.

## Write / interactive: figma-mcp (MCP over stdio)
Registered via `../.mcp.json`. Start Claude Code in the repo; it launches `figma-mcp.mjs` over stdio.
The server also hosts the bridge WebSocket the plugin connects to. Built on `@modelcontextprotocol/sdk`
with the `McpServer` + `registerTool` + zod pattern (tool schemas are zod, validated per call).

Tools: `figma_status`, `figma_get_selection`, `figma_list_libraries`, `figma_list_pages`, `figma_list_children`,
`figma_export_full`, `figma_export_design_system`, `figma_export_selection`, `figma_export_url`,
`figma_write` (batch of safe ops — createFrame / createText / setFill / setText; **no arbitrary code
execution**, unlike some community servers). The frame-walking export tools accept opt-in read flags
`css` / `measurements` / `pluginData` / `motion` / `sharedData`; `figma_export_design_system` doesn't
take them — it never walks a node (see below).

### `writeToDisk` — the export path that doesn't go through the context window
Every export tool takes `writeToDisk: true` (plus an optional `outDir`). It writes the export through
the same `write-out.js` the CLI uses — same layout, by construction — and returns a **compact index**
(counts + file paths) instead of the node payloads. The agent then Reads/Greps those files at whatever
granularity it needs.

Use it for anything past a quick look. Two things make it not optional:
- **Asset bytes are never returned inline** (they'd dump megabytes of base64 into context), so
  `writeToDisk` is the *only* way to get `assets/` out of the MCP path.
- **Inline MCP results are capped** (25k tokens by default, `MAX_MCP_OUTPUT_TOKENS`), so a real page
  export is silently truncated without it.

`outDir` resolves against **the directory the MCP server was started in** — i.e. the project you're
building, not this repo. Default `FIGMA_EXPORT_DIR` or `design/`, the same var `figma_status` reads.

> **One bridge at a time.** `figma-pull` and `figma-mcp` both call `createBridge()` and bind port
> 8787; whichever starts second hits `EADDRINUSE` and exits. So the CLI **cannot** run while the MCP
> server is up — that's what `writeToDisk` exists to make unnecessary. Set `FIGMA_BRIDGE_PORT` if you
> genuinely need both.

**Look before you pull.** `figma_list_pages` (and `figma_list_children` to drill into one frame) return
a cheap structural index — ids, names, types, sizes; no recursion, no assets, no node properties. Every
other read here deep-serializes, so without them the only way to learn what a file holds was to export
all of it: measured 12+ minutes and tens of MB straight into the context window on a real design
system. Use the index to pick a target, then `figma_export_full({ page: ["<id>"] })` — or
`skipAssets: true`, which is close to free here since asset bytes are stripped from MCP results anyway.

`figma_list_libraries` (no arguments) is the step *before* that: it answers **which design libraries**
the file draws on, so an export can be scoped to the one you care about. Its result is deliberately
compact — libraries, their variable collections, and usage-derived component counts — because a
discovery call that costs context defeats its own purpose. The same three limits apply as for the CLI
flag above (usage-derived counts, UI-only library enablement, empty-is-normal), and the tool reports
them in-result rather than leaving an empty list ambiguous. Recommended order:
`figma_list_libraries` → `figma_list_pages` → `figma_export_full({ page: [...] })`.

**Only want the design system?** `figma_export_design_system` skips the page/frame walk (and the
assets that walk would produce) and returns just variables/styles/components/hygiene — the MCP twin of
the CLI's `--design-system` flag. Same `writeToDisk`/`outDir` contract as the other export tools; same
one honest gap, too: library (remote) variable completeness depends on nodes/styles actually walked in
this session, so a bare design-system pull may see fewer of them than a full pull would.

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
