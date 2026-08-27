# bridge — figma-pull (read CLI) + figma-mcp (write MCP)

Local, loopback-only bridge between Claude Code and the **Design Twin** Figma plugin.
The plugin's hidden UI iframe is a WebSocket **client**; these processes are the **server**
(`127.0.0.1:8787`). Nothing touches the internet. See `../ARCHITECTURE.md` for the full design.

## Install (once)
```
cd bridge
npm install        # ws + @modelcontextprotocol/sdk (+ zod, and build deps for the MCP server)
```
The plugin manifest allows the bridge in **both** dev and published builds
(`allowedDomains: ws://localhost:{8787,8788,8789}`), so re-import the plugin in Figma after pulling
these changes. Those three ports are the only ones the plugin can dial — `FIGMA_BRIDGE_PORT` is
validated against them and exits rather than binding a port nothing could ever reach.

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
file — a `COMPONENT_SET`'s heavy per-variant node trees, or a standalone `COMPONENT`'s own node tree,
are NOT inlined here; they live in a sibling `design-system/components/<name>__<id>.json`, pointed at
by that entry's `variantsFile`/`nodeFile`, opt-in via `--variant-visuals`; see `tooling/get-component.js`
below), `components.library.json` (`remote: true` —
consumed from a published library, recovered from instances, props possibly inferred) and
`hygiene.json` (the lint report). Every part repeats the
`exportedAt` stamp, so `tooling/` reads freshness off whichever part it is handed. The split files sit
in a subdirectory because `design/tokens.json` and `design/components.json` at the export root are your
hand-authored, non-regenerable config maps.

```
# from the repo root, with the Figma file open + plugin running:
dtwin design                  # design-system.json + design-system/ + CURRENT-page frames + assets/
dtwin design --all-pages      # like above, but frame trees from EVERY page
dtwin design --selection      # just the current selection
dtwin design --design-system  # ONLY design-system.json + design-system/ — no page
                                                   # walk, no assets/ (the cheap "tokens only" pull)
dtwin design --as-library NERA # the COMPLETE catalog of a LIBRARY file — run this
                                                   # with the LIBRARY open, not the file that uses it
```
**Recommended workflow — discover, then scope.** Never open with a whole-file pull. Work down from
cheap questions to expensive ones, which is also what Figma's own agent guidance recommends
(discover first, then scope by library):
```
dtwin --whoami              # 0. (optional) which file am I actually connected to?
dtwin --list-libraries      # 1. WHICH libraries does this file draw on?
dtwin --list-pages          # 1b. page NAMES only (near-free — loads no page)
dtwin --list                # 2. WHERE is what — pages + top-level frames (ids)
dtwin --children <id>       # 3. (optional) peek inside one frame
dtwin design --page <id>    # 4. pull only what you need
```

### `--list-clients` / `--client` — working with two Figma files at once
```
dtwin --list-clients
```
The bridge accepts **one connection per open Figma file**, so a design file and the library it draws
on can both be connected. Each plugin announces itself on connect (and on every reconnect), so the
listing shows what you can address:

```
2 Figma files connected:

  c1    "App — Base"
        page "Home" · fileKey KEYBASE · up 12m
  c2    "NERA Library"
        page "Tokens" · no fileKey (private-plugin API not in effect) · up 3m

Address one with --client <connId | fileKey | part of the file name>, e.g. --client "App".
```

`--client` is an **address**, not a scope — it composes with every other flag:
```
dtwin design/base --client c1 --page 12:34
dtwin design/lib  --client "NERA" --as-library "NERA"
```
Give each file its own output directory, as above, and their exports never collide.

**With one file connected, omit it** — nothing changes from the single-file workflow. **With several,
omitting it is an error** that lists your choices:

```
2 Figma files are connected to the bridge — say which one to use.
  c1  "App — Base"  fileKey KEYBASE
  c2  "NERA Library"
Pass the connId, the fileKey, or part of the file name (CLI: --client <id|name>; MCP: client: "<id|name>").
```

That refusal is deliberate. An export pulled from the wrong file is indistinguishable from a correct
one — it writes the same shape of JSON to the same directory and reports success — so the bridge
refuses rather than picking, the same call `adb` makes with "more than one device".

MCP twins: `figma_list_clients`, plus a `client` argument on every tool. `figma_status` lists the
roster instead of failing when several are connected.

### `--whoami` — who is connected (and can two files connect at once?)
```
dtwin --whoami
```
Prints both halves of the connection: what the **plugin** says it is (`instanceId` minted per plugin
run, `file`, `page`, and whether `figma.fileKey` is available) and what the **socket** did
(`connId`, uptime, `connectionsThisRun`, `takeovers`).

Use `--list-clients` to see *which* files are connected; use `--whoami` to interrogate **one** of them
(`--client` selects it). What the fields tell you:

| What you see | What it means |
| --- | --- |
| `instanceId` **changed** between two calls addressing the *same* file | Figma tore down and re-ran the plugin runtime. The socket survived and the `connId` is unchanged — only the runtime restarted (see the note below) |
| `fileKeyAvailable: false` | `figma.fileKey` is gated to private plugins, so this file is addressed by `connId` or name instead. Normal for a locally-imported plugin |
| `takeovers` > 0 | Should never happen now — connections coexist. Retained so an older reader of this field sees `0` rather than the key vanishing |

> **Runtime teardown.** At least one comparable project ([`southleft/figma-console-mcp#67`](https://github.com/southleft/figma-console-mcp/issues/67))
> reports Figma destroying the plugin's JS execution context every 1–3 minutes regardless of focus.
> This repo's own live runs contradict that (a 25-page `--all-pages` export ran >15 min to
> completion — hence `TIMEOUTS.exportAll`), so it may be setup-specific. If you plan to leave a
> connection **idle** while working in another file, check it with `--whoami` first: a changed
> `instanceId` is the symptom. Related and better attested: an *occluded* Figma window is fine, a
> **minimized** one gets its renderer suspended.

MCP twin: `figma_whoami`.

### `--list-libraries` — the library discovery step
```
dtwin --list-libraries
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

### `--as-library <name>` — the COMPLETE catalog of one library

```
# open the LIBRARY file in Figma (not the design file that consumes it), then:
dtwin design --as-library "NERA"
```

`--list-libraries` tells you a library exists and how many variables its collections hold.
`--as-library` gets you the **values**: every variable with its full per-mode values, every paint /
text / effect / grid style, and every component with its **real** property definitions. Output lands
in `design/libraries/<slug>-<fileKey8>/` and **never touches `design-system/`** — the two catalogs
describe different Figma files and answer different questions.

**Why it must run inside the library file.** From a consuming file the Plugin API simply does not have
this data: `getVariablesInLibraryCollectionAsync` returns `name`/`key`/`resolvedType` with **no
values**, and there is no API to enumerate a library's components at all. Inside the library every one
of those objects is *local*, so the ordinary local reads return the whole thing — no extra permissions,
no paid plan, no import step.

> **Deliberately not used: `importVariableByKeyAsync`.** It *would* resolve library values from a
> consuming file, and it is the obvious-looking answer. It is also a **write**: the `import*ByKeyAsync`
> family materialises into the current document (the plugin typings say exactly that of its sibling
> `importShaderAsync`), which is why those calls fail in read-only/Dev Mode. Using it here would make a
> read-plane command subscribe your file to hundreds of variables. This path reads and writes nothing.

**Four honest limits**, because they change what the output means:
1. **`publish` is per-object, and only meaningful here.** Each variable/style/component carries
   `publish: current | changed | unpublished` (`current` = published and in sync, `changed` =
   published but edited since, `unpublished` = never published). Figma answers `UNPUBLISHED` for
   *everything* when asked from a consuming file or a branch, so the normal `--design-system` pull
   deliberately omits the field rather than emit a confident wrong answer.
2. **What the last publish contained cannot be listed.** `publish` describes each *local* object's
   relationship to the library. A component deleted here but still live in the published library is
   invisible to any API — so this is the library file's **current state**, not a diff of what
   consumers see.
3. **Nothing is filtered for you.** Unpublished drafts are exported and *labelled*, never dropped:
   `hiddenFromPublishing` is forward-looking publish config, not publish state, so filtering on it
   would be wrong in both directions.
4. **One library per run.** A library is a file, so exporting several means running this once per
   library file. Rows accumulate in `design/libraries/index.json` — a second library is added, never
   substituted. A variable that aliases into a *different* library stays an unresolved reference until
   that library is exported too.

**Re-running is safe.** Every file is rewritten in place with a fresh stamp, and the directory is keyed
on `fileKey` (which survives a rename) so a renamed library keeps its directory instead of forking.
Files a previous export produced and this one did not are **reported as `STALE:`, never deleted** — a
read command does not remove files it did not create.

**How the two catalogs fit together.** They stay separate and join on `key` (durable cross-file
identity, present on variables, collections, styles and components — names collide across libraries):

| | `design/design-system/` | `design/libraries/<lib>/` |
|---|---|---|
| Which file | the design file you build screens from | one library file |
| Variables | the subset your screens reference | **all**, full per-mode values |
| Components | usage-derived; props *inferred* from instances present | **all**, real property definitions |
| Styles | local only | **all**, with `key` |
| Use it for | **codegen** — emit only what is used | **lookup/enrichment** — resolve what exists |

Emit CSS from the design file's catalog, not the library's, or you ship every unused primitive in the
library. The library catalog is what you consult to answer "what else does this token family offer?"
and "what props does this component *really* take?".

Because the layout matches `design-system/`, existing tooling runs on it unchanged:
```
node tooling/tokens.js design/libraries/nera-ab12cd34/tokens.json ./out   # DTCG + CSS, no special-casing
```

Scope note: the **design system** (variables, styles, component catalog) always spans the whole
file. **Frame trees** default to the current page; `--all-pages` walks every page (each screen is
tagged with its `page` name). All-pages can be large — the CLI is the right tool for it because it
streams to disk, not into the context window. `--design-system` narrows the OTHER way: it skips the
frame walk (and therefore the assets a walk would export) and writes only `design-system.json` +
`design-system/` — tokens, styles, local + library components, hygiene. One honest limit: library
(remote) *variables* are recovered from nodes/styles actually walked, so a run with no page walk sees
fewer of them than a full pull would; local variables, styles and components are unaffected. It shares
`--selection`/`--all-pages`/`--page`/`--as-library`'s scope slot (pass only one) and, like `--list`/`--list-libraries`,
refuses the read-option flags (`--css`/`--measurements`/…) since there is no node walk for them to apply to.
It waits for the plugin to connect, pulls, writes files to `design/`, and exits. The agent then
Reads those files — big payloads live on disk, not in the context window.

**`visuals`.** Every catalogued component/variant carries its own paint under `visuals` on each
`components.local.json` entry: `{ fills, strokes, effects, radius, opacity, blendMode }` — the same
fields `ComponentNode`/`ComponentSetNode` carry as any other node. This is always on, not a flag:
unlike `--css`/`--measurements`/asset export, these six are plain synchronous property reads (Figma's
Plugin API only marks the genuinely expensive calls `Async` — `getCSSAsync`, `exportAsync` — and
fills/strokes/effects/cornerRadius/opacity/blendMode aren't among them), so there's no walk-avoiding
reason to gate them the way `--design-system` gates a page walk. **Two honest limits:**
1. It's the component's own base look — a specific instance's overrides elsewhere in the file are
   not reflected, and a variant SET's `visuals` is the SET wrapper node's own paint (Figma's purple
   dashed selection chrome), not a per-variant one. Pass `--variant-visuals` to also walk each set's
   variants and attach their real `layout`/`fills`/`radius`/`tokens`/`css` under `entry.variants[]` —
   opt-in because it costs one extra node walk per variant. A standalone `COMPONENT` (not inside a
   set) gets the same walk, attached as `entry.node` instead — there's no set to enumerate variants
   of. `entry.props` (the prop *schema*) is unaffected either way; a variant's
   `componentPropertyDefinitions` throws, so per-variant `values` there come from `variantProperties`
   or, failing that, the variant name Figma guarantees is `"Prop=Val, ..."`. The node tree itself never
   lands in `components.local.json` — it is written to a sibling
   `design-system/components/<name>__<id>.json`, pointed at by that entry's `variantsFile` (sets) or
   `nodeFile` (standalone components) — absent when nothing was exported for that entry. `entry.variants[]`
   in the slim catalog keeps only `id`/`name`/`key`/`values`. Fetch one component's real node tree(s) with
   `node tooling/get-component.js design/design-system/components.local.json <key|id|name>`.
2. It only covers components DEFINED in this file. Components consumed from a published library
   (the `remote:true` entries, recovered via instance-walk — see the honest-limits note above) are
   not covered here; pull `--as-library` on the *source* library file for those. There is no
   client-side fix for this — Figma exposes no API to enumerate a library's contents from a
   consuming file (see `--list-libraries` above), so this is a hard ceiling, not a gap.

**Duplicate component names.** The catalog build already flags a component name reused elsewhere in
the file (e.g. two unrelated "Action Buttons" component sets) as `duplicate component name: '<name>'`
in `hygiene`. `--design-system`/full pulls now echo `hygiene` to stderr as soon as the write completes
(prefixed `hygiene (N):`), so this shows up in the run itself instead of requiring a manual
`hygiene.json` diff.

Allowlist it in Claude Code so it runs without a prompt (`.claude/settings.json`):
```
{ "permissions": { "allow": ["Bash(dtwin:*)"] } }
```

### Keep the connection open: `--serve` (daemon)
Each one-shot run above waits for the plugin to reconnect. For several pulls in a row, hold the bridge
open and let later invocations reuse it:
```
dtwin --serve          # holds the bridge open until stopped (Ctrl-C works too)
dtwin --daemon-status  # is one up, and is the plugin connected?
node bridge/dtwin --stop
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
**Not registered in this repo** — there is no `.mcp.json` here on purpose, so the MCP never starts
while you are working *on* the bridge. Register it in the project you are *building*: a `.mcp.json`
there with an absolute path to this `figma-mcp.mjs`, and the same `FIGMA_BRIDGE_TOKEN`. Claude Code
then launches it over stdio.
The server also hosts the bridge WebSocket the plugin connects to. Built on `@modelcontextprotocol/sdk`
with the `McpServer` + `registerTool` + zod pattern (tool schemas are zod, validated per call).

Tools: `figma_status`, `figma_get_selection`, `figma_list_libraries`, `figma_list_pages`, `figma_list_children`,
`figma_export_full`, `figma_export_design_system`, `figma_export_selection`, `figma_export_url`,
`figma_write` (batch of safe ops — createFrame / createText / setFill / setText; **no arbitrary code
execution**, unlike some community servers). The frame-walking export tools accept opt-in read flags
`css` / `measurements` / `pluginData` / `motion` / `sharedData`; `figma_export_design_system` doesn't
take them (it never walks a node — see below) but DOES take `variantVisuals`, since the component
catalog it builds is exactly what that flag enriches.

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
