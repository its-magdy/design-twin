# Design Twin — bridge

**figma-pull (read CLI) + figma-mcp (write MCP).**

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
could otherwise drive the plugin), so the token is the real gate.

**You do not have to set anything up.** The first time a bridge starts it generates a token, saves it,
prints it once, and reuses it forever after. Paste it into the plugin's **Bridge token** field (the
plugin saves it per-user in `clientStorage`) and neither side asks again.

```
dtwin --token-status    # where it lives, which source wins, its fingerprint — never the token
dtwin --show-token      # print the token itself (stdout only, so `dtwin --show-token | pbcopy` works)
dtwin --rotate-token    # replace it — you must then re-paste it into the plugin
dtwin --forget-token    # delete it; the next bridge start mints a new one
dtwin --token-file <p>  # read the token from <p> for this run instead of the stored one
```

**Where it is stored**

| OS | Path |
|---|---|
| macOS / Linux | `$XDG_CONFIG_HOME/design-twin/bridge-token`, else `~/.config/design-twin/bridge-token` |
| Windows | `%APPDATA%\design-twin\bridge-token` |

Written `0600` (owner only) in a `0700` directory, atomically. `DESIGNTWIN_CONFIG_DIR` overrides the
directory outright — for a container, a CI runner, or a test.

**Precedence** — first match wins:

1. `--token-file <path>`
2. `FIGMA_BRIDGE_TOKEN` (the CI / ephemeral escape hatch)
3. the saved file
4. otherwise: generate one, save it, print it once

There is deliberately **no `--token <value>` flag**. Process arguments are world-readable through
`ps` and `/proc/<pid>/cmdline`, so a value flag would hand the secret to every other user on the
machine for as long as the command runs. A *path* is not a secret; the file it points at is.

`FIGMA_BRIDGE_TOKEN` still works and still wins over the file, so nothing that already exports it
changes. It is no longer the recommended setup, for two reasons: exported environment variables
propagate to every child process and leak into logs, and it has to be re-exported in every shell.
When both are present `--token-status` says so explicitly — a saved token silently shadowed by an
env var is otherwise a genuinely confusing state to debug.

**What this protects against, and what it doesn't.** The `0600` file stops *other users* on the
machine. It does not stop another process running as *you* — only an OS keychain would, and this
bridge deliberately doesn't use one: `keytar` is archived, its live replacements are native binaries
with per-platform install friction, and that is disproportionate for a loopback token that grants no
authority beyond driving a Figma plugin you already have open. If that trade doesn't suit your
environment, keep the token in your own secret manager and pass `--token-file`.

## Set a project up: `dtwin init`

Run in the root of the project you are **building** (not this repo):

```
dtwin init             # design/ + design/export/, README, target.json, bridge token, next steps
dtwin init --mcp       # …and register this MCP server in ./.mcp.json (merged, never overwritten)
dtwin init --dry-run   # print what it would do; write nothing, mint no token
```

It lays out the project as two halves, and the split is the point:

```
design/
  export/                  <- dtwin writes ONLY here. rm -rf and re-pull loses nothing.
    pages/<Page>/<Screen>__<node-id>.json    one screen, any pull shape — carries `sourceFile` (the
                                              connected Figma file this pull actually talked to; absent
                                              on a screen pulled before this field existed, never
                                              guessed from another file's export)
    pages/index.json                          every screen pulled, each row also carrying `sourceFile`
    design-system/                            tokens, styles, component catalogs
    variables.json                            the union of every screen's tokens (merged, never replaced)
    assets/                                   named after the Figma layer, deduped by content
  README.md                what dtwin owns vs what you own
  target.json              the stack (profile: null when nothing was detected — build-screen fills it in)
  codeconnect.local.json   Figma component -> your code component. HAND-OWNED.
  plan/ audit/ verify/     decisions and evidence from the skills
```

`design/` used to hold both halves, so "delete design/ and re-pull" — the obvious way to recover from
a bad export — silently destroyed a hand-mapped component map. Projects created before the split keep
their export directly in `design/`; every command still finds it and `dtwin doctor` says which layout
it found.

It needs no bridge, plugin or free port. It never overwrites: an existing `target.json`, an existing
`designtwin` entry in `.mcp.json` (or this server already registered under any other name), or an
unparseable `.mcp.json` are all left alone and reported. The server is registered as `designtwin`,
never `figma` — that is the name Figma's own MCP server usually has, and Claude Code loads one server
per name, so the two sit side by side. `--mcp` is
opt-in because a registered MCP server holds port 8787 for as long as Claude Code runs (`dtwin`
commands still work — they route through it, see "One bridge, shared" below). The two
steps it cannot do — importing the plugin into Figma and pasting the token — it prints.

## Commands at a glance

```
dtwin list                        # what is in the file: pages + top-level frames, with ids
dtwin pull --page Screens  # export ONE page into ./design/export
dtwin screenshot 12:34            # a reference PNG of one node
dtwin doctor                      # something not working? start here
```

Every command is shorthand for a flag, and **the flags keep working unchanged** — the rest of this
README documents the flags, and either spelling is fine everywhere:

| Command | Same as |
|---|---|
| `dtwin pull [outDir] [flags]` | `dtwin [outDir] [flags]` |
| `dtwin list` · `list pages` · `list libraries` · `list clients` | `--list` · `--list-pages` · `--list-libraries` · `--list-clients` |
| `dtwin list children <id\|url>` | `--children <id\|url>` |
| `dtwin screenshot <id\|url> [--scale N]` | `--screenshot <id\|url>` |
| `dtwin whoami` | `--whoami` |
| `dtwin serve` · `stop` · `status` | `--serve` · `--stop` · `--daemon-status` |
| `dtwin token` · `token show` · `token rotate` · `token forget` | `--token-status` · `--show-token` · `--rotate-token` · `--forget-token` |
| `dtwin help` | `--help` |
| `dtwin doctor` · `dtwin init` · `dtwin mcp` | their own entry points (no flag form) |

A command is only recognised as the **first** argument, so `dtwin design` still means "pull into
`./design`". For an output directory spelled like a command, write `dtwin pull list` or `dtwin ./list`.

## Something not working: `dtwin doctor`

Every failure looks the same from outside — a pull that waits, then times out. `doctor` tells the
causes apart, marks each check ✓ / ! / ✗, and gives the one next step:

```
dtwin doctor            # exit code 1 only if a check is ✗ (a note, !, is not a failure)
dtwin doctor --wait 30  # wait longer for the plugin to connect (default 10s; it retries every 3s)
dtwin doctor --json     # { ok, checks: [{ id, title, status, detail, next }] }
```

1. **Node.js** version against this package's `engines`.
2. **Bridge token** — saved or not, where, loose file permissions, and whether `FIGMA_BRIDGE_TOKEN` is
   shadowing the saved one. Fingerprint only, never the token.
3. **Daemon** — running or not, and which files are connected to it.
4. **Port** (`FIGMA_BRIDGE_PORT`, one of 8787/8788/8789) — free, held by the daemon, held by another
   bridge (almost always the MCP server), or held by something unrelated.
5. **Figma plugin** — can it actually connect? If a plugin is running with a *different* token, doctor
   says so with both fingerprints, instead of the "nothing connected" that case otherwise looks like.
6. **Project** (the current directory) — `design/`, `design/target.json`, which export LAYOUT it
   found, the age of the last export, **which Figma files that export mixes**, the component map
   (`design/codeconnect.local.json`, or the older repo-root location), and the `.mcp.json`
   registration (a legacy `figma` key still works; new setups use `designtwin`).

   The "which Figma files" line exists because the freshness line describes exactly one file — the
   snapshot doctor happened to pick — and on a project whose screens came from a different Figma file
   than its design system it confidently named the wrong one. When an export mixes sources, doctor
   now lists all of them and points at `/designtwin:audit-design`, whose cross-file check proves
   whether the screens and the design system really are the same system.

It changes nothing: no token is created, no file written. Check 5 opens a bridge for a few seconds,
so it only runs when the port is free **and** a token already exists; when a daemon is up doctor asks
the daemon instead, and when something else holds the port it identifies the holder with a plain HTTP
request (a bridge answers `426`) rather than a WebSocket — a WebSocket client would be registered as a
plugin and disturb whoever owns that bridge.

## Read: figma-pull (CLI) — recommended for bulk extraction

`dtwin help` (or `--help` / `-h`) prints the quick start, the command table and every flag below, and
exits — no bridge is started, no token minted.
An unknown or mistyped flag is an error with a suggestion (`--lst` → "did you mean --list?"), never
silently ignored: a typo used to fall through to a full pull.

A full pull writes `design/export/design-system.json` as a slim MANIFEST (`exportedAt`/`file`/`colorProfile`,
`files` pointers, `counts`) over the catalog split under `design/export/design-system/`, one file per Figma
concept: `tokens.json` (variable collections → modes → variables), one file per style type —
`styles.paint.json`/`styles.text.json`/`styles.effect.json`/`styles.grid.json` — (the separate
Paint/Text/Effect/Grid style system), `components.local.json` (components that are real nodes in this
file — a `COMPONENT_SET`'s heavy per-variant node trees, or a standalone `COMPONENT`'s own node tree,
are NOT inlined here; they live in a sibling `design-system/components/<name>__<id>.json`, pointed at
by that entry's `variantsFile`/`nodeFile`, opt-in via `--variant-visuals`; see `design-to-code/get-component.js`
below), `components.library.json` (`remote: true` —
consumed from a published library, recovered from instances, props possibly inferred) and
`hygiene.json` (the lint report). Every part repeats the
`exportedAt` stamp, so `design-to-code/` reads freshness off whichever part it is handed. The split files sit
in a subdirectory because `design/tokens.json` and `design/components.json` are your
hand-authored, non-regenerable config maps.

```
# from the repo root, with the Figma file open + plugin running:
dtwin design                  # design-system.json + design-system/ + CURRENT-page frames + assets/
dtwin design --all-pages      # like above, but frame trees from EVERY page
dtwin design --selection      # just the current selection
dtwin design --design-system  # ONLY design-system.json + design-system/ — no page
                                                   # walk, no assets/ (the cheap "tokens only" pull)
dtwin design --as-library "Acme UI"  # the COMPLETE catalog of a LIBRARY file — run this
                                                   # with the LIBRARY open, not the file that uses it
dtwin design --node <id>      # ONE node, fully exported (properties + assets) —
                                                   # see "--node <id>" below
```
**Recommended workflow — discover, then scope.** Never open with a whole-file pull. Work down from
cheap questions to expensive ones, which is also what Figma's own agent guidance recommends
(discover first, then scope by library):
```
dtwin whoami                   # 0. (optional) which file am I actually connected to?
dtwin list libraries           # 1. WHICH libraries does this file draw on?
dtwin list pages               # 1b. page NAMES only (near-free — loads no page)
dtwin list                     # 2. WHERE is what — pages + top-level frames (ids)
dtwin list children <id>       # 3. (optional) peek inside one frame
dtwin pull --page <id>  # 4. pull only what you need — or just ONE node:
dtwin pull --node <id>  # 4b. (optional) just that ONE node, real export + its own assets
dtwin screenshot <id>          # 5. (optional) visually check ONE component after generating code for it
```
(The flag spellings — `--whoami`, `--list-libraries`, `--list-pages`, `--list`, `--children`,
`--screenshot` — are the same commands; the sections below are titled by flag.)

### `--node <id>` — one node, fully exported

```
dtwin design --node 123:456                          # -> design/export/pages/<Page>/<Name>__123_456.json
dtwin design --node "https://figma.com/design/KEY/App?node-id=123-456" # a pasted link works too
```

A REAL export scoped to exactly one node — the CLI twin of the MCP `figma_export_url` tool ("paste a
link and ask about it," see below). It runs the full `serialize()` walk on that node's subtree and
exports the assets found inside it, exactly as a `--page` pull would for that subtree, just rooted
lower. Accepts a bare id, dash form, percent-encoded id, a nested-instance path, or a whole figma.com
URL — the same lenient parsing `--children`/`--screenshot` use.

Don't confuse it with its two neighbors:
- `--children <id>` peeks at one node's **direct children only** — no recursion, no assets, for
  deciding whether to pull further.
- `--screenshot <id>` renders a **PNG only** — skips `serialize()` and the asset walk entirely, for
  visual validation after you've already generated code.
- `--node <id>` is the one that actually **exports** — real node tree + real assets, just scoped
  smaller than a whole page.

It is a SCOPE flag like `--page`/`--selection`/`--all-pages`, so it's mutually exclusive with them,
and unlike `--screenshot` it composes with read options (`--css`, `--measurements`, etc.) since it
does a real walk.

It files into the **same `pages/` tree** a `--page` pull writes, so nothing downstream has to know
which pull produced a file:

```
design/export/pages/<Page>/<Name>__<node-id>.json        the screen tree
design/export/pages/<Page>/<Name>__<node-id>.vars.json   exactly the variables THIS screen binds
design/export/pages/<Page>/<Name>__<node-id>.assets.json its assets, with content hashes,
                                                         plus duplicates / monochrome / heavy
design/export/pages/<Page>/index.json                    merged, one row per screen pulled
design/export/pages/index.json                           merged, one row per page
design/export/variables.json                             the UNION of every screen's slice
design/export/assets/                                    shared, deduped by content
```

Three consequences worth knowing:

- **The node id is in the filename**, because a frame NAME does not identify a frame. Two frames both
  called `Popup` used to overwrite each other; a frame whose name ends in a space filed as `Name_.json`,
  which looks like a typo. Read `pages/index.json` — it carries each screen's real
  name, page, node id, size and the paths to all three files — rather than reconstructing a filename.
- **`variables.json` MERGES.** Each pull's slice is unioned in, keyed on each variable's Figma key, so
  pulling screen B no longer deletes screen A's tokens — which it used to do silently, leaving A's
  theme unresolvable while the build still rendered from the raw hex beside every binding. The raw
  per-pull slice is kept verbatim as the screen's `.vars.json`. When two screens resolve one variable
  differently the newest wins and the disagreement is recorded under `_conflicts` and in `hygiene`.
- **Assets are named after their Figma layer and deduped by content.** `icons/linear/arrow-down` lands
  as `arrow-down.svg`; the same artwork reached through several instance paths is one file carrying
  every node id that resolved to it; two different icons whose leaf names collide are separated by a
  short content hash, never by overwriting.

MCP twin: `figma_export_url` (also accepts a bare node id, not just a URL).

### `--screenshot <id>` — an on-demand PNG of one node

```
dtwin --screenshot 123:456                # writes design/export/assets/123_456_ref.png — the same
                                          # path a later --node pull of that frame writes its own
                                          # reference to, so there is never a second copy
dtwin --screenshot 123:456 --scale 3      # override the default (auto, capped at 2048px on the longest side)
```

Every export already carries **one** whole-frame reference PNG per exported root (`reference` in the
tree), for the codegen agent to self-check the overall page against. That's a weak validation target
for a **dense** screen, though — eyeballing one small component inside a huge flat image doesn't scale.
`--screenshot` is the single-node counterpart: pull it for *one* component/instance you just generated
code for, after `--list`/`--children` gave you its id, and compare it directly.

It is cheap next to a real export — it skips `serialize()` and the recursive asset walk entirely, so
`exportAsync` on the node itself is the only Plugin-API cost — but unlike `--list`/`--children` it
**writes a file** (it's a tiny export, not a structural index), so it can't be combined with a scope
flag, another index command, or a read option (`--css` etc. need a node walk this skips).

This mirrors Figma's own Dev Mode MCP server: `get_screenshot` is scoped to a single node/selection,
called **on demand** after `get_metadata`, specifically for post-generation visual validation — not a
bulk pre-render pass over every node, which would pay the same per-node cost `--no-assets` exists to
avoid, for a much bigger payload (PNG > structural JSON). If you want a component's reference image
without picking through instances one at a time, dedupe by the component's own id (or its
`mainComponent`) rather than pulling every instance of it.

MCP twin: `figma_screenshot`.

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
  c2    "Acme UI Library"
        page "Tokens" · no fileKey (private-plugin API not in effect) · up 3m

Address one with --client <connId | fileKey | part of the file name>, e.g. --client "App".
```

**`c1`/`c2` are display labels, not stable ids.** They are assigned in *reconnect order* for the
current bridge's lifetime — whichever plugin's WebSocket lands first becomes `c1`. Two runs of the
same `--client c1` can select **different Figma files** if the bridge restarted (no `dtwin serve`
daemon) and the reconnect race went the other way between runs (finding 209). Prefer the **file name**
(a substring match, e.g. `--client "App"`) or the **fileKey** when one is available — both are stable
across restarts; `c1`/`c2` are only for telling two *currently open* files apart in one sitting, exactly
like `--list-clients`' own listing does. Under a running `dtwin serve` daemon, connIds are assigned
once per plugin connection and stay stable until that plugin's window disconnects/reconnects.

`--client` is an **address**, not a scope — it composes with every other flag:
```
dtwin design/base --client c1 --page 12:34
dtwin design/lib  --client "Acme UI" --as-library "Acme UI"
```
Give each file its own output directory, as above, and their exports never collide.

**With one file connected, omit it** — nothing changes from the single-file workflow. **With several,
omitting it is an error** that lists your choices:

```
2 Figma files are connected to the bridge — say which one to use.
  c1  "App — Base"  fileKey KEYBASE
  c2  "Acme UI Library"
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

**Waiting for the plugin.** Every command that needs Figma first waits for the plugin to connect:
`--timeout <seconds>` bounds that wait as well as the command itself. Without the flag it is 10
minutes at a terminal and 90 seconds when stderr is not a TTY (an agent's shell, CI) — then
`no Figma plugin connected within Ns`, exit 1, with the next step. A first word that is not a verb
but is an obvious guess at one (`dtwin export`, `dtwin ls`, `dtwin check`) is refused with the real
verb instead of being taken as an output folder; `dtwin pull export` still exports into `./export`.

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
dtwin design --as-library "Acme UI"
```

`--list-libraries` tells you a library exists and how many variables its collections hold.
`--as-library` gets you the **values**: every variable with its full per-mode values, every paint /
text / effect / grid style, and every component with its **real** property definitions. Output lands
in `design/export/libraries/<slug>-<fileKey8>/` and **never touches `design-system/`** — the two catalogs
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
   library file. Rows accumulate in `design/export/libraries/index.json` — a second library is added, never
   substituted. A variable that aliases into a *different* library stays an unresolved reference until
   that library is exported too.

**Re-running is safe.** Every file is rewritten in place with a fresh stamp, and the directory is keyed
on `fileKey` (which survives a rename) so a renamed library keeps its directory instead of forking.
Files a previous export produced and this one did not are **reported as `STALE:`, never deleted** — a
read command does not remove files it did not create.

**How the two catalogs fit together.** They stay separate and join on `key` (durable cross-file
identity, present on variables, collections, styles and components — names collide across libraries):

| | `design/export/design-system/` | `design/export/libraries/<lib>/` |
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
node design-to-code/tokens.js design/export/libraries/nera-ab12cd34/tokens.json ./out   # DTCG + CSS, no special-casing
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
   `node design-to-code/get-component.js design/export/design-system/components.local.json <key|id|name>`.
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
there with an absolute path to this `figma-mcp.mjs`, under the key `designtwin` (`dtwin init --mcp`
writes exactly that). Claude Code then launches it over stdio, and its tools surface as
`mcp__designtwin__<tool>` (e.g. `mcp__designtwin__figma_status`).
No token needs to go in that `.mcp.json`: the MCP server reads the same per-user stored token the CLI
does, so the one you already pasted into the plugin keeps working (set `FIGMA_BRIDGE_TOKEN` in the
registration only if you deliberately want the MCP on a *different* token from the CLI).
The server also hosts the bridge WebSocket the plugin connects to. Built on `@modelcontextprotocol/sdk`
with the `McpServer` + `registerTool` + zod pattern (tool schemas are zod, validated per call).

Tools: `figma_status`, `figma_get_selection`, `figma_list_libraries`, `figma_list_pages`, `figma_list_children`,
`figma_export_full`, `figma_export_design_system`, `figma_export_selection`, `figma_export_url`,
`figma_screenshot` (an on-demand PNG of ONE node — the single-node visual-validation counterpart to the
export tools' whole-frame reference PNG; see `--screenshot` above),
`figma_write` (batch of safe ops — createFrame / createText / setFill / setText; **no arbitrary code
execution**, unlike some community servers; `dryRun: true` returns a preview of what each op would
create or overwrite without touching the file — there is no undo from the MCP side, so preview anything
that overwrites; refused outright when the file is in read-only Dev Mode). The frame-walking export tools accept opt-in read flags
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
- **Inline MCP results are capped** (25k tokens by default, `MAX_MCP_OUTPUT_TOKENS`). The server
  measures the result before returning it: one that would not fit is **written to disk on its own**
  and the index's `note` says so (a real design-system export is ~590 KB ≈ 147k tokens). Passing
  `writeToDisk: false` opts out of that — an oversized result is then an error naming the size,
  never a payload cut off mid-JSON.

`outDir` resolves against **the directory the MCP server was started in** — i.e. the project you're
building, not this repo. Default `FIGMA_EXPORT_DIR` or `design/`, the same var `figma_status` reads.

> **One bridge, shared.** Port 8787 has one owner at a time. The MCP server and `dtwin serve` both
> publish the bridge they own on a local socket, and everything that starts later — a `dtwin` command,
> a second Claude Code session's MCP server — routes through it instead of binding the port again.
> When the owner exits, the next MCP call opens the bridge itself (the plugin reconnects on its own).
> The one holder that does NOT share is a plain one-shot `dtwin pull` with no daemon: while it runs,
> anything else that needs the port exits with `EADDRINUSE`. `writeToDisk` is still the simplest way
> to get files from inside an MCP session.

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
CLI twin: `dtwin design --node <id>` (see above) — same underlying `exportNode` op, so a pull from
either surface lands in the identical shape.

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
{ "permissions": { "allow": ["mcp__designtwin__*"] } }
```

## Notes / limits
- The Figma file must be **open** with the plugin running for either path (never headless).
- One process owns port 8787 at a time. `figma-mcp` and `dtwin serve` share the bridge they own
  (later `dtwin` commands and MCP servers route through it); only a one-shot pull does not, and a
  process that then finds the port taken exits immediately with a clear `EADDRINUSE` message.
- Image assets travel as base64 (not JSON int-arrays) — ~3.5–4x smaller on the wire.
- v1 sends each response as a single WebSocket frame. If you hit very large pages, add chunking
  (see ARCHITECTURE.md "chunk large payloads").
- Write ops are a deliberately small, explicit set — extend `applyWrite()` in
  `../figma-plugin/src/writes.ts` (rebuild `code.js`) and add a matching `registerTool` here as needed.
