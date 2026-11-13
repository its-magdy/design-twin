<!-- npm renders no <picture> and no repo-relative paths: one absolute PNG, dark ink on its own white tile so it reads in npm dark mode too. -->
<img alt="Design Twin" src="https://raw.githubusercontent.com/its-magdy/design-twin/main/assets/wordmark-light.png" height="56">

# Design Twin — `dtwin`

> Figma → code with Claude Code, on the **free** Figma plan. No REST API key, no cloud service in between: the design
> goes from your Figma app to your coding agent and nowhere else.

`@design-twin/dtwin` is the **`dtwin` CLI** (pulls a design onto disk) and the **MCP server** (the same reads as live
tools, plus the only write path) of [Design Twin](https://github.com/its-magdy/design-twin). It also ships the Figma
plugin they talk to. The bridge is local and loopback-only: the plugin's UI iframe (its window) is a WebSocket **client**,
and these processes are the **server** (`127.0.0.1:8787`). Nothing touches the internet. See
[ARCHITECTURE.md](https://github.com/its-magdy/design-twin/blob/main/ARCHITECTURE.md) for the full design.

**Quick start**, in the project you are building, after the install below:

```
dtwin init --mcp   # design/, the bridge token, the Figma plugin's copy, a .mcp.json entry
dtwin plugin path  # import this manifest once: Figma desktop → Plugins → Development → Import plugin from manifest…
dtwin token show   # paste into the plugin: Connect to Claude Code (optional) → Bridge token → Save
dtwin doctor       # checks everything and names the next step
dtwin list         # then: dtwin pull --node <id>
```

For the Claude Code skills (audit, build, verify, sync), see the
[project README](https://github.com/its-magdy/design-twin#readme): its
[first screen in 5 minutes](https://github.com/its-magdy/design-twin#first-screen-in-5-minutes) goes from install
to a built screen, and [known limitations](https://github.com/its-magdy/design-twin#known-limitations--platform-support)
covers what it needs (Figma desktop, Bun) and where it runs.

- [Install (once)](#install-once)
- [Set a project up: `dtwin init`](#set-a-project-up-dtwin-init)
- [Commands at a glance](#commands-at-a-glance)
- [The Figma plugin: `dtwin plugin`](#the-figma-plugin-dtwin-plugin)
- [Seed the component map from Code Connect: `dtwin seed`](#seed-the-component-map-from-code-connect-dtwin-seed)
- [Something not working: `dtwin doctor`](#something-not-working-dtwin-doctor)
- [Read: figma-pull (CLI)](#read-figma-pull-cli--recommended-for-bulk-extraction)
- [Write / interactive: figma-mcp (MCP over stdio)](#write--interactive-figma-mcp-mcp-over-stdio)
- [Notes / limits](#notes--limits)

## Install (once)
It needs [Bun](https://bun.sh/install) ≥ 1.4.2 (`engines.bun`) on your PATH; Node is not supported. Install Bun
first (`curl -fsSL https://bun.sh/install | bash`, or `powershell -c "irm bun.sh/install.ps1 | iex"` on Windows), then
the package, `@design-twin/dtwin`, from npm:
```
bun add -g @design-twin/dtwin   # puts `dtwin` in ~/.bun/bin (on your PATH via the Bun installer)
```
`npm i -g @design-twin/dtwin` installs the same thing, but `dtwin` still runs on Bun: without Bun on PATH it stops at
`env: bun: No such file or directory`. The package also carries the built Figma plugin, which `dtwin plugin install`
(or `dtwin init`) copies to a per-user folder for you to import once — see [The Figma plugin: `dtwin plugin`](#the-figma-plugin-dtwin-plugin) —
and the design-to-code bundles the MCP server's `design_get_component` / `design_drift_lint` load (`layer/`).

Or with Homebrew (macOS, Linux), which installs Bun for you and keeps both up to date with `brew upgrade`:
```
brew install its-magdy/tap/dtwin
```
The formula installs the same npm package into Homebrew's prefix; every release updates it. Paths `dtwin init` writes
(the `.mcp.json` server entry) are spelt through `$(brew --prefix)/opt/dtwin/…`, which
survives an upgrade — not the versioned `Cellar/dtwin/<version>/` folder the next `brew upgrade` deletes. The Figma
plugin is imported from its per-user copy (`dtwin plugin`), which `brew upgrade` leaves where it is.
The package carries its own `bun.lock` (the versions and sha512s this repo's lockfile pins, dependencies of
dependencies too), and the formula installs from it with `--frozen-lockfile`. So a Homebrew install gets the exact
dependency tree the release was tested with, never a newer one published since. `bun add -g`, `npm i -g`, `npx` and
`bunx` do not read a package's own lockfile and resolve the dependency ranges fresh.

Or from a clone (to work on the code):
```
git clone https://github.com/its-magdy/design-twin.git && cd design-twin
bun install --frozen-lockfile   # @modelcontextprotocol/sdk (+ zod), for every workspace
cd bridge && bun link           # puts `dtwin` in ~/.bun/bin (on your PATH); nothing to build
```
Or skip the link and run `bun --no-install --no-env-file /path/to/design-twin/bridge/src/figma-pull.ts` wherever
this README says `dtwin` (those two flags are what the bin's shebang adds: without them, Bun loads the `.env` of the
project you run it in and may fetch a missing package from the registry).
The `dtwin` bin's shebang needs an `env` that understands `-S` (GNU coreutils ≥ 8.30, macOS, FreeBSD). Where it
does not (BusyBox — Alpine and other minimal images), `dtwin` fails before Bun starts; run it as
`bun --no-install --no-env-file "$(command -v dtwin)" …` (or the path above) instead.

The plugin manifest allows the bridge in **both** dev and published builds
(`allowedDomains: ws://localhost:{8787,8788,8789}`). Those three ports are the only ones the plugin can dial — `FIGMA_BRIDGE_PORT` is
validated against them and exits rather than binding a port nothing could ever reach.

> **Library reads need the manifest's permission.** The manifest declares `"permissions": ["teamlibrary"]`,
> without which Figma denies the team-library APIs. A plugin still running an older manifest keeps working
> and simply returns **no libraries** — a silent empty result, not an error. If `--list-libraries` /
> `figma_list_libraries` shows nothing, turn on Plugins → Development → **Hot reload plugin** and reopen the plugin;
> if it is still empty, re-import the manifest `dtwin plugin path` prints (Plugins → Development → Import plugin from
> manifest…). Updates need no re-import: `dtwin plugin update` (or any dtwin that starts a bridge) replaces the files
> in place, and with hot reload on, reopening the plugin runs them — a changed manifest's permissions included.

### Bridge token (required)
The bridge authenticates every connection with a shared token — loopback binding alone is not
access control (a sandboxed browser iframe on any site the user visits sends `Origin: null` and
could otherwise drive the plugin), so the token is the real gate.

**You do not have to set anything up.** The first time a bridge starts it generates a token, saves it,
prints it once, and reuses it forever after. Paste it into the plugin's **Bridge token** field, under the
window's collapsed **Connect to Claude Code (optional)** section, and press **Save** (the plugin keeps it
per-user in `clientStorage`); neither side asks again.

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

`FIGMA_BRIDGE_TOKEN` works and wins over the file. It is not the recommended setup, for two reasons: exported environment variables
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
dtwin init --mcp       # …and register this MCP server in ./.mcp.json (merged; a broken entry of ours is repaired)
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
    SCHEMA.md                                 scripting quick keys (generated beside the data; same text
                                              as the top of ir-fields.md; rewritten only when its text
                                              changes, a SCHEMA.md of your own is never touched)
    variables.json                            the union of every screen's tokens (merged, never replaced)
    assets/                                   named after the Figma layer, deduped by content
  README.md                what dtwin owns vs what you own
  target.json              the stack (profile: null when nothing was detected — build-screen fills it in)
  codeconnect.local.json   Figma component -> your code component. HAND-OWNED.
  plan/ audit/ verify/     decisions and evidence from the skills
```

The two halves live apart so that "delete design/export/ and re-pull" — the obvious way to recover from
a bad export — never touches a hand-mapped component map. Projects created before the split keep
their export directly in `design/`; every command still finds it and `dtwin doctor` says which layout
it found.

It needs no bridge, plugin or free port. It never overwrites: an existing `target.json`, an existing
`designtwin` entry in `.mcp.json` (or this server already registered under any other name), or an
unparseable `.mcp.json` are all left alone and reported. The one exception is an entry of **ours** that
can no longer start — its `bun` or `figma-mcp.ts` is gone (a deleted clone, a `brew upgrade` that removed
the versioned bun it named), or it is a Node-era entry (`node …/bridge/dist/figma-mcp.js`), or bun runs it
without `--no-install --no-env-file`, or it runs the package by name (`bunx @design-twin/dtwin mcp`, which fetches it
from the registry or Bun's cache at every start): `--mcp` re-points that entry, under its own key and keeping its other
fields, at this install, and prints `REPAIRED …` with what was wrong (`--dry-run` only prints it). The entry
names the bun on your PATH when that is the bun running init (`~/.bun/bin/bun`, Homebrew's
`/opt/homebrew/bin/bun` — paths that survive an upgrade), else the running bun's own path. Run from a
`bunx` cache (`bunx @design-twin/dtwin init`), `--mcp` refuses to register anything: Bun replaces or deletes that
cache on its own, so install the package for good first. The server is registered as `designtwin`,
never `figma` — that is the name Figma's own MCP server usually has, and Claude Code loads one server
per name, so the two sit side by side. `--mcp` is
opt-in because a registered MCP server holds port 8787 for as long as Claude Code runs (`dtwin`
commands still work — they route through it, see "One bridge, shared" below). The two
steps it cannot do — importing the plugin into Figma and pasting the token — it prints.

## Commands at a glance

```
dtwin list                        # what is in the file: pages + top-level frames, with ids
dtwin pull --page Screens         # export ONE page into ./design/export
dtwin screenshot 12:34            # a reference PNG of one node
dtwin doctor                      # something not working? start here
dtwin seed                        # components.json from the Code Connect files in your code (offline)
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
| `dtwin version` | `--version` · `-v` |
| `dtwin doctor` · `dtwin init` · `dtwin mcp` · `dtwin seed` · `dtwin outline` · `dtwin plugin` | their own entry points (no flag form) |

Every verb has its own page: `dtwin <verb> --help` (e.g. `dtwin whoami --help`, `dtwin serve --help`) prints
that verb's flags and exits without starting a bridge. `outDir` is **positional** (`dtwin pull my-dir`):
`--out` / `-o` / `--output` / `--out-dir` / `--dir` are refused with a hint saying so. The port is chosen
only by the `FIGMA_BRIDGE_PORT` environment variable (8787, 8788 or 8789; there is no `--port` flag, and
`DTWIN_PORT` is not read — `dtwin` and `doctor` warn when it is set).

A command is only recognised as the **first** argument, so `dtwin my-dir` still means "pull into
`./my-dir`". For an output directory spelled like a command, write `dtwin pull list` or `dtwin ./list`.
A first word that is not a verb but is an obvious guess at one (`dtwin export`, `dtwin ls`, `dtwin check`) is
refused with the real verb instead of being taken as an output folder; `dtwin pull export` still exports into
`./export`.
With no outDir the export lands in `design/export` — the only place doctor, cross-check, audit and
build-screen read. Never pull into bare `design`: that writes a second, parallel export tree beside
`design/export/` (dtwin warns when it sees one).

## The Figma plugin: `dtwin plugin`

The plugin is not on Figma Community; it is imported into Figma **desktop** as a development plugin (Plugins →
Development → Import plugin from manifest…). Figma remembers the manifest's path, so the folder must not move — and a
path inside the npm package does (Bun's and npm's
global folders differ, a Node version manager gives each Node its own, a `bunx` cache comes and goes, an uninstall
deletes it). So the package's plugin is copied to one per-user folder, beside the bridge token, and imported from there
once:

```
dtwin plugin install     # copy it to <config dir>/figma-plugin and print the one-time import step (--open shows it)
dtwin plugin update      # the same, then says to reopen the plugin (and when the manifest changed too)
dtwin plugin status      # (default) installed where, and is it this dtwin's? (--json)
dtwin plugin path        # the manifest to import, on stdout
dtwin plugin uninstall   # remove the copied files (then remove the plugin in Figma: Plugins → Manage plugins)
```

`<config dir>` is the bridge token's: `~/.config/design-twin` (or `$XDG_CONFIG_HOME/design-twin`), `%APPDATA%\design-twin`
on Windows, `DESIGNTWIN_CONFIG_DIR` overriding both. The folder is hidden in a file picker: on macOS press ⌘⇧G and paste
the path; on Windows paste it into the File name box. `dtwin init` installs (or refreshes) the copy and prints the same
step. Install writes only the files that differ, each one atomically, under a lock, and is safe to run any number of times.

**Updates need no command.** Once a copy is installed, every `dtwin` that starts a bridge (a command, `dtwin serve`, the
MCP server) first brings it up to its own package's files, so after `bun add -g @design-twin/dtwin@latest` (or
`brew upgrade dtwin`) you only
reopen the plugin — with Plugins → Development → **Hot reload plugin** on. With it on, reopening runs the replaced
`code.js` / `ui.html` and picks up a changed manifest's permissions too (seen in Figma desktop 126); with it off, Figma
kept running the code it had already loaded. An update whose manifest changed says so, with re-importing as the
fallback if a new permission still does not work. Nothing is created that you did not
install, the network is never touched, and a `dtwin` running from a **repo checkout** never refreshes the copy —
developers import `figma-plugin/manifest.json` from the checkout itself (`dtwin plugin path` prints that one there).
`dtwin doctor` reports the copy as its "Plugin files" check.

## Seed the component map from Code Connect: `dtwin seed`

If the project you are building already has Code Connect files, they are the Figma-component →
code-component map you would otherwise write by hand. `dtwin seed` reads them — template files
(`// url=` + `// component=` + `// source=` headers), `figma.connect(...)` calls, and `@FigmaConnect`
(SwiftUI/Compose) — and fills `components.json`:

```
dtwin seed                     # scan . and merge into design/components.json
dtwin seed src design          # [codeRoot] [outDir]
dtwin seed --dry-run           # scan and report what it would add; write nothing
```

It only reads source files: no bridge, plugin or token, and never the network. The merge is
fill-missing-only — an existing entry's hand-authored fields are never overwritten — and each new
entry leaves `import` and `props` for you to fill in. A mapping that carries only a node id (no
component name) is named through `<outDir>/export/design-system.json` (or `<outDir>/design-system.json` on the
older flat layout), so export the design system first;
without it such mappings are skipped and the run says so. In a clone of this repo the same script
also runs directly: `bun bridge/src/seed-components.ts [codeRoot] [outDir] [--dry-run]`.

## Something not working: `dtwin doctor`

Every failure looks the same from outside — a pull that waits, then times out. `doctor` tells the
causes apart, marks each check ✓ / ! / ✗, and gives the one next step:

```
dtwin doctor            # exit code 1 only if a check is ✗ (a note, !, is not a failure)
dtwin doctor --wait 30  # wait longer for the plugin to connect (default 10s; it retries every second)
dtwin doctor --json     # { ok, checks: [{ id, title, status, detail, next, skipped }] }
```

`ok` is false when a check is ✗ **or** `skipped` (a check that could not run — the plugin probe while something
else holds the port, or before a token exists — is a ! marked `skipped: true`, since nothing it would have verified was).

Once a plugin connects, the probe can run up to ~6.5 s past `--wait`: the bridge's settle (so a second
open file is seen), then each file's `hello` (so it is named).

1. **Bun** version against this package's `engines.bun` (≥ 1.4.2).
2. **Bridge token** — saved or not, where, loose file permissions, and whether `FIGMA_BRIDGE_TOKEN` is
   shadowing the saved one. Fingerprint only, never the token.
3. **Daemon** — running or not, and which files are connected to it (on Windows: a note that it is not
   supported there, and why).
4. **Port** (`FIGMA_BRIDGE_PORT`, one of 8787/8788/8789) — free, held by the daemon, held by another
   bridge (almost always the MCP server), or held by something unrelated.
5. **Figma plugin** — can it actually connect? If a plugin is running with a *different* token, doctor
   says so with both fingerprints, instead of the "nothing connected" that case otherwise looks like.
6. **Plugin files** — the per-user plugin copy `dtwin plugin` manages: installed or not, where, and whether it
   matches this dtwin.
7. **Project** (the current directory) — `design/`, `design/target.json` and the profile build-screen will use
   (bundled or custom, plus the project's own `design/profile.md` when it exists), which export LAYOUT it
   found, the age of the last export (its newest stamp; stale past 24h), **which Figma files that export mixes**, the component map
   (`design/codeconnect.local.json`, or the older repo-root location), and the `.mcp.json`
   registration (a legacy `figma` key still works; new setups use `designtwin`). A registered entry that
   cannot start — its command or `figma-mcp.ts` missing, Node-shaped (`node`, a `bridge/dist` script), bun
   without `--no-install --no-env-file`, a script in a `bunx` cache, or the package run by name
   (`bunx @design-twin/dtwin mcp`) — is a ✗ naming `dtwin init --mcp`,
   which repairs it. `DT_TEST_EPHEMERAL_PORT` (a test-only seam) set in the environment is a note too.

   The "which Figma files" line exists because one stamp describes exactly one file, and on a project
   whose screens came from a different Figma file than its design system it would name the wrong one.
   doctor lists every source with its own age — the screens of each Figma file, the design system — and
   when they are more than one Figma file it points at `/designtwin:audit-design`, whose cross-file check
   proves whether the screens and the design system really are the same system. `figma_status`'s
   `snapshot` is the same verdict (bridge/src/export-verdict.ts), so the two never disagree.

It changes nothing: no token is created, no file written. Check 5 opens a bridge for a few seconds,
so it only runs when the port is free **and** a token already exists; when a daemon is up doctor asks
the daemon instead, and when something else holds the port it identifies the holder with a plain HTTP
request (a bridge answers `426`) rather than a WebSocket — a WebSocket client would be registered as a
plugin and disturb whoever owns that bridge.

## Read: figma-pull (CLI) — recommended for bulk extraction

Every direct run ends with `done in 12.4s — waited 9.8s for the plugin to connect · export 2.4s · write 0.2s`
(or `via the running daemon · export (incl. any wait for the plugin) 2.6s` when a daemon answered: the
daemon waits for a not-yet-connected plugin inside the request, so that wait is in the export figure). A long "waited" figure is the plugin
re-dialling a fresh one-shot bridge (it retries every second, one port at a time, slower in a background window), not the export
itself; the line says so past 5 s. `dtwin serve` in another terminal keeps one bridge open and the plugin
connected, so every later command skips that wait.

`dtwin help` (or `--help` / `-h`) prints the quick start, the command table and every flag below, and
exits — no bridge is started, no token minted.
An unknown or mistyped flag is an error with a suggestion (`--lst` → "did you mean --list?"), never
silently ignored — a typo must never fall through to a full pull.

A full pull writes `design/export/design-system.json` as a slim MANIFEST (`exportedAt`/`file`/`colorProfile`,
`files` pointers, `counts`) over the catalog split under `design/export/design-system/`, one file per Figma
concept: `tokens.json` (variable collections → modes → variables), one file per style type —
`styles.paint.json`/`styles.text.json`/`styles.effect.json`/`styles.grid.json`/`styles.animation.json` — (the
separate Paint/Text/Effect/Grid style system, plus custom animation styles), `components.local.json` (components that are real nodes in this
file — a `COMPONENT_SET`'s heavy per-variant node trees, or a standalone `COMPONENT`'s own node tree,
are NOT inlined here; they live in a sibling `design-system/components/<name>__<id>.json`, pointed at
by that entry's `variantsFile`/`nodeFile`, opt-in via `--variant-visuals`; see `design-to-code/get-component.ts`
below), `components.library.json` (`remote: true` —
consumed from a published library, recovered from instances, props possibly inferred) and
`hygiene.json` (the lint report: notes on the file's upkeep, such as unnamed or duplicate components, variant
explosions, broken aliases and `ALL_SCOPES` variables). Every part repeats the
`exportedAt` stamp, so `design-to-code/` reads freshness off whichever part it is handed. The split files sit
in a subdirectory because `design/tokens.json` and `design/components.json` are your
hand-authored, non-regenerable config maps.

```
# from your project root, with the Figma file open + plugin running:
dtwin pull                    # design-system.json + design-system/ + CURRENT-page frames + assets/
dtwin pull --all-pages        # like above, but frame trees from EVERY page
dtwin pull --selection        # just the current selection
dtwin pull --design-system    # ONLY design-system.json + design-system/ — no page
                              # walk, no assets/ (the cheap "tokens only" pull)
dtwin pull --as-library "Acme UI"
                              # the COMPLETE catalog of a LIBRARY file — run this
                              # with the LIBRARY open, not the file that uses it
dtwin pull --node <id>        # ONE node, fully exported (properties + assets) —
                              # see "--node <id>" below
```
**Pull flags.** Each read below is opt-in (it costs extra Plugin-API work) and applies to a pull that walks
nodes (`--node`, `--page`, `--selection`, `--all-pages` or a plain `dtwin pull`):

| Flag | What it adds or changes |
|---|---|
| `--css` | Figma's own computed CSS per node (`getCSSAsync`) |
| `--measurements` | Measurement redlines (spacing specs the designer placed) for the exported page(s); does not require Dev Mode |
| `--plugin-data` | Own-scope plugin data (`getPluginData`) stamped on nodes; usually empty unless the write plane wrote it |
| `--motion` | Motion/animation reads: timelines, manual keyframe tracks, animations, applied animation styles. Can be verbose |
| `--shared-data` | Cross-plugin shared data (`getSharedPluginData`), notably Tokens Studio applied tokens on files without native Figma Variables |
| `--variant-visuals` | Walks each `COMPONENT_SET`'s variants and records their real layout/fills/radius/tokens/css; slower on large systems. The one read option `--design-system` and `--as-library` also accept |
| `--no-assets` | Skips the per-node SVG/PNG export pass (the dominant cost on a big file); structure and tokens are unaffected, and the manifest reports how many were skipped |
| `--timeout N` | Seconds to allow; see "`--timeout <seconds>`" below |
| `--client <connId\|fileKey\|name>` | Which file, when several are connected; see `--list-clients` below |

The list commands (`list`, `list pages`, `list children`, `list clients`, `list libraries`, `whoami`) take
none of the read options: they are refused rather than ignored. `list clients` and `list libraries` print a
table; add `--json` for machine output (the other list commands already print JSON and accept it as a no-op).

**Recommended workflow — discover, then scope.** Never open with a whole-file pull. Work down from
cheap questions to expensive ones, which is also what Figma's own agent guidance recommends
(discover first, then scope):
```
dtwin whoami                   # 0. (optional) which file am I actually connected to?
dtwin list pages               # 1. page NAMES only (near-free — loads no page)
dtwin list                     # 2. WHERE is what — pages + top-level layers (ids)
dtwin list children <id>       # 3. peek inside one frame / SECTION
dtwin pull --node <id>         # 4. pull just that ONE node, real export + its own assets
dtwin pull --page <id>         # 4b. (only for a whole page)
dtwin screenshot <id>          # 5. (optional) visually check ONE component after generating code for it
```
`dtwin list libraries` is a side step, not part of that order (the slowest read): run it to learn which
library owns a token, or before an `--as-library` pull.
(The flag spellings — `--whoami`, `--list-libraries`, `--list-pages`, `--list`, `--children`,
`--screenshot` — are the same commands; the sections below are titled by flag.)

### `--timeout <seconds>` — waiting for the plugin

Every command that needs Figma first waits for the plugin to connect:
`--timeout <seconds>` bounds that wait as well as the command itself. Without the flag it is 10
minutes at a terminal and 90 seconds when stderr is not a TTY (an agent's shell, CI) — then
`no Figma plugin connected within Ns`, exit 1, with the next step. Once connected, the command has its
own budget: 300 s for a plain pull, `--page` or `--node`, 900 s with `--all-pages`, 120 s for `--selection`,
and 300 s for the list commands. `--timeout N` replaces both the connect wait and that budget with N seconds.
`--timeout` takes at most 2147483 seconds (about 24 days, the longest delay one JavaScript timer holds);
`Infinity`, `0`, a negative or a larger number is refused with a usage error rather than run as an
export that times out at once.

### `--node <id>` — one node, fully exported

```
dtwin pull --node 123:456                            # -> design/export/pages/<Page>/<Name>__123_456.json
dtwin pull --node "https://figma.com/design/KEY/App?node-id=123-456"   # a pasted link works too
```

A REAL export scoped to exactly one node — the CLI twin of the MCP `figma_export_url` tool ("paste a
link and ask about it," see below). It runs the full `serialize()` walk (the plugin's node-to-JSON tree walk) on that node's subtree and
exports the assets found inside it, exactly as a `--page` pull would for that subtree, just rooted
lower. Accepts a bare id, dash form, percent-encoded id, a nested-instance path, or a whole figma.com
URL — the same lenient parsing `--children`/`--screenshot` use.

Don't confuse it with its two neighbors:
- `--children <id>` peeks at one node's **direct children only** — no recursion, no assets, for
  deciding whether to pull further. Each row has `childCount`; rows sharing name + size also get a
  `title` (the first visible text), and the listing warns once per such group ("N children share name
  … and size … — told apart by `title`/`childCount`"). When the titles match too, those rows also get
  `distinctTexts` (up to 3 texts that row shows and its twins do not); the listing shares one budget of
  node reads, and a group with a row it runs out on gets none, with one warning naming them. When a row has
  no `distinctTexts`, screenshot each candidate.
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
                                                         plus duplicates / monochrome / heavy; rows carry
                                                         name / owner / context / usedBy (search those,
                                                         not file names)
design/export/pages/<Page>/index.json                    merged, one row per screen pulled
design/export/pages/index.json                           merged, one row per page
design/export/variables.json                             the UNION of every screen's slice
design/export/assets/                                    shared, deduped by content
```

A pull prints these asset lines: `warn  N node(s) fell back to raw geometry …` (any fallback, naming the
nodes), `warn  … too heavy to inline` (or "a raster image embedded in an SVG shell" when it is one), and
`info  N hidden graphic(s) not exported (assetSkipped:"hidden"); M reuse a visible twin's file` and
`info  N node(s) hidden (themselves or under a hidden ancestor) kept in the tree (conditional UI)` (only
the ones hidden themselves carry `hidden:true`). A root that is hidden itself or under a
hidden ancestor is exported with a warning (its graphics are not rendered, its reference may be blank).
A file a hidden node reuses from another screen is listed in this screen's `.assets.json` with
`reusedFrom`.
`duplicates` is found by a tolerant compare (def ids and numbers within ±0.01 ignored — except an
embedded image's scale/offset/tile, the numbers of a transform on `<use>`/`<image>` and of a `<pattern>`'s
x/y/width/height, compared relatively, within 1 %), so the same artwork re-exported under another name
is one file.

Three consequences worth knowing:

- **The node id is in the filename**, because a frame NAME does not identify a frame: two frames both
  called `Popup` would otherwise overwrite each other, and a frame whose name ends in a space files as
  `Name___<id>.json`, which looks like a typo. Read `pages/index.json` — it carries each screen's real
  name, page, node id, size and the paths to all three files — rather than reconstructing a filename.
- **`variables.json` MERGES.** Each pull's slice is unioned in, keyed on each variable's Figma key, so
  pulling screen B never deletes screen A's tokens — replacing the file would leave A's theme
  unresolvable, silently, while the build still rendered from the raw hex beside every binding. The raw
  per-pull slice is kept verbatim as the screen's `.vars.json`. When two screens resolve one variable
  differently the newest wins and the disagreement is recorded under `_conflicts` and in `hygiene`.
  It holds only the variables bound by the pulled nodes — to find the variable behind a library colour,
  look it up on the library catalog: `bun --no-install --no-env-file <scripts>/tokens.js <library>/tokens.json --lookup <hex>` (`ffbc1c`, or a quoted `'#ffbc1c'`:
  an unquoted `#` starts a shell comment). `<scripts>` is the Claude Code plugin's `scripts/` folder:
  `claude-plugin/scripts/` in a clone of the repo, or `${CLAUDE_PLUGIN_ROOT}/scripts` in a Claude Code session
  with the `designtwin` plugin installed.
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
dtwin --screenshot 123:456 --scale 0.25   # override the default (auto, capped at 2048px on the longest side);
                                          # writes assets/123_456_shot@0.25x.png, never the reference's name
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

It prints `{id, name, type, w, h, scale, png:{w,h}, reference}` on stdout: `w`/`h` are the node's size, `scale`
the factor the plugin rendered at, `png` the written file's pixel size (keys that do not apply are omitted).

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
daemon) and the reconnect race went the other way between runs. Prefer the **file name**
(a substring match, e.g. `--client "App"`) or the **fileKey** when one is available — both are stable
across restarts; `c1`/`c2` are only for telling two *currently open* files apart in one sitting, exactly
like `--list-clients`' own listing does. Under a running `dtwin serve` daemon, connIds are assigned
once per plugin connection and stay stable until that plugin's window disconnects/reconnects.

A named target (file name or fileKey) is **waited for**: each open plugin window redials on its own
clock (every second, one of the three allowed ports at a time), so right after a bridge starts only one of two open files may be connected yet. Once a
first plugin is connected, `dtwin` gives the named file up to 15 s more (or `--timeout`, whichever is
shorter) to land before resolving the name; a name that never matches then fails with the list of
what *is* connected. A bare `c<N>` never waits for its file. The MCP `client` argument gets the same
wait on every tool: holding the bridge, up to 15 s for a first plugin to connect and then up to 15 s
more for the name; routed through a daemon, the same two windows, spent by the daemon's bridge.

**A fresh bridge settles before it guesses.** For 3.5 s after a bridge's first plugin connects (one
walk of the three ports at a redial a second, plus a moment for the next window's hello), a command
with **no** `--client`, or one whose `--client` is a file name — whole or partial: names repeat (two `Untitled`) and a name matches as
a substring (`App` also matches `App (Copy)`) — is held: a second open file may still be redialling,
and without it the command would silently go to whichever file landed first instead of being refused
as ambiguous. The hold outlasts a shorter `--timeout`, which only bounds how long to wait for a first
plugin. A connId or fileKey is routed at once. A bridge that has had its plugins connected for 3.5 s
pays nothing — a `dtwin serve` daemon, a running MCP session — until one of them leaves while others
stay: that window is probably redialling, so the 3.5 s start again. Wherever a command waits like this
— the one-shot CLI's own bridge, a daemon request that carries a connect window, any bridge still
settling — a file name, no `--client` and `--list-clients` are also held, within the connect window (or
the settle, when that ends later), while another connected window has not yet said which file it is
(usually a few milliseconds; 3 s per window that never says), so a
refusal or a listing names that file instead of showing it as unidentified; a window that never says is
listed unidentified. Whatever the settle and those holds add up to, the wait ends at most 3 s past the
longer of the settle and its window (the window capped at 15 s), counted from when a plugin went live —
a window that keeps connecting and dropping without saying which file it is cannot hold a command.
`--list-clients` on its own bridge waits the same 3.5 s, so it lists every window that redialled in
that time; a settled MCP session or `dtwin serve` daemon reads its list directly, with no wait. A window
that redials more slowly (Figma throttles a background window's timers) can still land after that;
with two files open, address the one you mean.

`--client` is an **address**, not a scope — it composes with every other flag:
```
dtwin design/base --client "Marketing" --page 12:34
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
Prints both halves of the connection (`connection` is the **addressed** file's socket — the one `--client`
picked — not whichever connected first): what the **plugin** says it is (`instanceId` minted per plugin
run, `file`, `page`, and whether `figma.fileKey` is available) and what the **socket** did
(`connId`, uptime, `connectionsThisRun`, `takeovers`).

Use `--list-clients` to see *which* files are connected; use `--whoami` to interrogate **one** of them
(`--client` selects it). What the fields tell you:

| What you see | What it means |
| --- | --- |
| `instanceId` **changed** between two calls addressing the *same* file | Figma tore down and re-ran the plugin runtime. The socket survived and the `connId` is unchanged — only the runtime restarted (see the note below) |
| `fileKeyAvailable: false` | `figma.fileKey` is gated to private plugins, so this file is addressed by `connId` or name instead. Normal for a locally-imported plugin |
| `takeovers` > 0 | Never happens — connections coexist, so the field is always `0`. It stays so a reader of this field sees `0` rather than the key vanishing |

> **Runtime teardown.** At least one comparable project ([`southleft/figma-console-mcp#67`](https://github.com/southleft/figma-console-mcp/issues/67))
> reports Figma destroying the plugin's JS execution context every 1–3 minutes regardless of focus.
> This repo's own live runs contradict that (a 25-page `--all-pages` export ran >15 min to
> completion — hence `TIMEOUTS.exportAll`), so it may be setup-specific. If you plan to leave a
> connection **idle** while working in another file, check it with `--whoami` first: a changed
> `instanceId` is the symptom. Related and better attested: an *occluded* Figma window is fine, a
> **minimized** one gets its renderer suspended.

> **Background tab.** Measured live (one page through the daemon): with the exporting
> file's tab in front, 31–38 progress ticks and ~2,500 nodes per 10 s; with another file's tab in
> front, 3–5 ticks and ~15 nodes per 10 s — about 100× slower; then 27 ticks in the first 10 s after
> switching back and the normal 31–38 from the second window on. The export completes either way,
> but a `--timeout` sized for the foreground fires. Figma Desktop is an Electron app; Electron's
> `backgroundThrottling` (default `true`) is "Whether to throttle animations and timers when the
> page becomes background", and the plugin's walk advances on Figma API awaits, so it is the tab
> that is throttled. Keep the exporting file's tab in front.

MCP twin: `figma_whoami`.

### `--list-libraries` — which library owns a token
```
dtwin --list-libraries
```
Prints an aligned table of the libraries this file uses — the local file's own published assets plus
every **enabled** team library — with each one's variable collections (and variable counts) and how
many of its components this file uses. It's the library-scoped sibling of `--list`: no tree export, no node
properties, no assets, same `--timeout`, prints to stdout and writes nothing — but the slowest read there
is, a few seconds up to ~15 s (about 2 s on a file with no libraries enabled), because it walks every
instance in the file and makes one Figma call per enabled library variable collection.

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
dtwin pull --as-library "Acme UI"     # -> design/export/libraries/<slug>-<fileKey8>/
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

Because the layout matches `design-system/`, existing tooling runs on it unchanged (this npm package does not
ship `design-to-code/`: run it from a clone of the repo, or use the same script the `designtwin` Claude Code
plugin ships as `scripts/tokens.js`):
```
bun design-to-code/tokens.ts design/export/libraries/acme-kit-ab12cd34/tokens.json ./out   # DTCG + CSS, no special-casing
```
The generated `tokens.css` / `theme.css` start with a provenance line (`designtwin-source: <dir>/<input> · <n>
variables · sha256 <12>`); `tokens.js <input> --check <file>` exits 0 when the file is current, 1 when the
input has changed since (stale), 2 when the file has no such line (regenerate once) or names a different source file (pass that one; a design-system `tokens.json` and a library's are told apart by their parent directory) or the command line is wrong (usage errors are 2 there, never 1). `--lookup <hex>`
(repeatable; `ffbc1c` or a quoted `'#ffbc1c'`) lists the COLOR variables with that exact value, per mode, following aliases.

Scope note: the **design system** (variables, styles, component catalog) always spans the whole
file. **Frame trees** default to the current page; `--all-pages` walks every page (each screen is
tagged with its `page` name). All-pages can be large — the CLI is the right tool for it because it
streams to disk, not into the context window. `--design-system` narrows the OTHER way: it skips the
frame walk (and therefore the assets a walk would export) and writes only `design-system.json` +
`design-system/` — tokens, styles, local + library components, hygiene. One honest limit: on a file
that CONSUMES a library, `--design-system` returns that file's OWN tokens, styles and components plus only
the library (remote) variables something in the file references (a page pull adds the ones its nodes
bind) — never the library's catalog. For that, open the LIBRARY file and run `--as-library "<name>"`
(CLI only); the tell is `remote: true` on the variables and `hygiene.json`'s count line. It shares
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
   `bun design-to-code/get-component.ts design/export/design-system/components.local.json <key|id|name>`
   (from a clone of the repo; the `designtwin` Claude Code plugin ships the same script as `scripts/get-component.js`).
2. It only covers components DEFINED in this file. Components consumed from a published library
   (the `remote:true` entries, recovered via instance-walk — see the honest-limits note above) are
   not covered here; pull `--as-library` on the *source* library file for those. There is no
   client-side fix for this — Figma exposes no API to enumerate a library's contents from a
   consuming file (see `--list-libraries` above), so this is a hard ceiling, not a gap.

**Duplicate component names.** The catalog build already flags a component name reused elsewhere in
the file (e.g. two unrelated "Action Buttons" component sets) as `duplicate component name: '<name>'`
in `hygiene`. `--design-system`/full pulls echo `hygiene` to stderr as soon as the write completes
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
dtwin --stop           # or: dtwin stop
```
Every ordinary command detects a running daemon and **routes through it automatically** — same
invocations, no reconnect, no second bridge to collide on 8787.

Why a daemon rather than "a flag that just leaves the connection open": a long-running CLI has no way
to receive further commands, so it would hold the port while being unreachable — blocking the MCP
server and every other CLI call. Instead one process (`--serve`) owns the bridge and each later
invocation is a thin client over a unix socket, `designtwin-<port>.sock`, in a directory only you can
access: `$XDG_RUNTIME_DIR` when it is set (and private), else `$TMPDIR/designtwin-<uid>/`, created
`0700`. The socket takes no token, so dtwin refuses that directory if it is a symlink, owned by
another user, or open to group/other — remove it, or point `XDG_RUNTIME_DIR` or `TMPDIR` at a
directory only you can access. Until then ordinary commands and the MCP server run without a daemon
(the refusal is printed once on stderr), `--serve` / `--stop` refuse, and `dtwin doctor` fails its
daemon check with the same message. The location follows `XDG_RUNTIME_DIR` / `TMPDIR`, so two processes
started with different values (a terminal, and an MCP server launched by an app) see different daemons.
A daemon started by an earlier dtwin version listens at `$TMPDIR/designtwin-<port>.sock`: `--stop`
stops it too, and a port-in-use error names that socket.

> **On Windows** the daemon listens on a named pipe, `\\.\pipe\designtwin-<port>-<hash>`, named from the
> bridge token. A pipe cannot be made private to your account the way the socket's directory is (its
> default access lets any local user open it, and a client cannot check who created it), so before any
> request both ends prove they hold the bridge token — a mutual HMAC challenge over fresh nonces from each
> side (`bridge/src/daemon-auth.ts`). A process that cannot prove it is dropped without a word, and a
> squatter holding the pipe name is refused by every command (nothing is sent to it): `--serve` says so,
> and commands fall back to opening their own bridge. What it cannot stop: a squatter can still deny you
> the daemon (move it with `dtwin --rotate-token`), and the pipe is only as private as the token file —
> `%APPDATA%\design-twin\bridge-token` is per-user; `dtwin doctor` warns when the token comes from a file
> outside your profile. With no token saved yet there is nothing to name the pipe with: start a bridge once
> first. `--rotate-token` / `--forget-token` stop a running daemon first (on every OS), since nothing
> could find it under the new token while it still held the port.

Behaviour worth knowing:
- Requests are **forwarded as they arrive**; the **plugin** decides what may run alongside what, in each
  file, for every caller (a daemon client, the MCP server holding the bridge, the plugin window's own
  buttons). Each command declares how it runs (`bridge/src/commands.ts` `runKind`): exports, screenshots
  and writes run one at a time, in arrival order; the selection and the listings (`list pages` / `list` /
  `list children`, `list libraries`) wait for the run ahead of them, because they read layers and an
  export's catalogue walk briefly hides hidden layers inside instances (`skipInvisibleInstanceChildren`);
  the identity reads (`ping`, `whoami`) answer at once, even during an export. Two files are two plugins,
  so a pull of one file never waits on another file's export.
- Every request id is unique per bridge (`r<nonce>-<seq>`) and a reply only settles the request on the
  connection it was sent to, so a late reply from an abandoned earlier request cannot answer the
  next one. When the plugin is connected but sends nothing the stall message says so ("the plugin is
  connected but sent nothing for '<cmd>' … it is busy"): an earlier export is still running in that file,
  or a long cold first read of a large page. Retry, or use a warm plugin (`dtwin serve`).
  The plugin sends a `start` frame when a bridge run begins and a `queued` frame when it arrives behind
  another run, so "connected but silent" is distinguishable from "waiting its turn".
- An **abandoned request is cancelled in the plugin**: when a command times out, when the one-shot
  stall check gives up, when the bridge shuts down, or when the client that asked (a Ctrl-C'd CLI, an
  ended MCP session) disconnects from the daemon before its reply, the bridge tells the plugin to stop
  that work rather than leaving it to finish for nobody (the plugin checks for the cancel at every node, so it
  stops within a node, not at the end of the page; one long single `exportAsync` still runs to its end) —
  and one the plugin still has queued is dropped without ever running. The next run in that file starts
  when the abandoned one has actually stopped, not when the cancel was sent.
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
- **An MCP server that owns the bridge exits when its client goes away** (stdin closes, or stdout breaks),
  at once, unless another process has used its shared socket; then it keeps serving and idles out on the
  same `FIGMA_DAEMON_IDLE_MIN` window (default 120 min, `0` = never), since other sessions route through
  it. This deliberately departs from the MCP stdio binding's "exit promptly when stdin closes". SIGINT,
  SIGTERM and SIGHUP cancel in-flight reads, remove the socket and exit 0, even while serving others.

## Write / interactive: figma-mcp (MCP over stdio)
Register it in the project you are *building*: a `.mcp.json`
there that runs `bridge/src/figma-mcp.ts` on Bun — `"command"`: the absolute path of `bun`, `"args"`:
`["--no-install", "--no-env-file", "<abs path>/bridge/src/figma-mcp.ts"]` — under the key `designtwin` (`dtwin init --mcp`
writes exactly that, with the `bun` and the install — package or clone — that ran it; an absolute `bun` keeps working when Claude Code is
started without `~/.bun/bin` on its PATH). Claude Code then launches it over stdio, and its tools surface as
`mcp__designtwin__<tool>` (e.g. `mcp__designtwin__figma_status`).
No token needs to go in that `.mcp.json`: the MCP server reads the same per-user stored token the CLI
does, so the one you already pasted into the plugin keeps working (set `FIGMA_BRIDGE_TOKEN` in the
registration only if you deliberately want the MCP on a *different* token from the CLI).
The server also hosts the bridge WebSocket the plugin connects to. Built on `@modelcontextprotocol/sdk`
with the `McpServer` + `registerTool` + zod pattern (tool schemas are zod, validated per call).

Tools (15): `figma_status`, `figma_list_clients`, `figma_whoami`, `figma_get_selection`, `figma_list_libraries`,
`figma_list_pages`, `figma_list_children`, `figma_export_full`, `figma_export_design_system`, `figma_export_selection`, `figma_export_url`,
`figma_screenshot` (an on-demand PNG of ONE node — the single-node visual-validation counterpart to the
export tools' whole-frame reference PNG; see `--screenshot` above),
`figma_write` (batch of safe ops — createTree (a whole screen in one op) / patch (change an existing node by id) / move / delete / setVariable / setStyle (change a local variable or style once, and everything using it follows) / createFrame / createText / setFill / setText / setVariableMode / clearVariableMode; **no arbitrary code
execution**, unlike some community servers; a `fill` / `color` must be a hex colour — `#rgb`, `#rgba`,
`#rrggbb` or `#rrggbbaa` with the `#`, never a name like `red` — and anything else is refused (by the
schema here, and by the plugin for a write from another client) instead of painted as a wrong colour; `dryRun: true` returns a preview of what each op would
create, overwrite, move or delete without touching the file — a batch that fails partway is put back whole, but one
that landed is undone only by the designer's Cmd-Z, so preview anything that overwrites; refused outright when the file is in read-only Dev Mode — and **refused unless the designer has
ticked "Allow edits"** in the plugin window, see below), and two that read the export already on disk and
need no Figma connection — `design_get_component` (one component's variant node trees) and
`design_drift_lint` (the component map vs the export; see below). The frame-walking export tools accept opt-in read flags
`css` / `measurements` / `pluginData` / `motion` / `sharedData`; `figma_export_design_system` doesn't
take them (it never walks a node — see below) but DOES take `variantVisuals`, since the component
catalog it builds is exactly what that flag enriches.

**Parameters.** Every `figma_*` tool also takes an optional `client` (a connId, fileKey or part of the file name;
needed only when several files are connected), except `figma_list_clients`, which takes nothing. Every export tool
and `figma_screenshot` also take the optional `writeToDisk` and `outDir` (see `writeToDisk` below). "Walk options" are the optional
booleans `css`, `measurements`, `pluginData`, `motion`, `sharedData`, `variantVisuals` and `skipAssets` (the
`dtwin pull` flags of the same meaning).

| Tool | Required | Optional | Returns |
|---|---|---|---|
| `figma_status` | — | — | connected files (`clients`), the export on disk (`snapshot`), the last export and write |
| `figma_list_clients` | — | — | one row per connected file: `connId`, name, `fileKey`, open page |
| `figma_whoami` | — | — | one plugin's identity: `instanceId`, file and page, `editsAllowed` |
| `figma_get_selection` | — | — | what is selected in Figma right now |
| `figma_list_libraries` | — | — | the libraries the file uses, with their collections and component counts |
| `figma_list_pages` | — | `depth` (`1` page names only, `2` pages + top-level frames; default 2) | pages, and their top-level frames with ids |
| `figma_list_children` | `nodeId` (an id or a figma.com URL) | — | one node's direct children |
| `figma_export_full` | — | `page` (ids or names), `allPages` (not both), walk options | design system + frame trees (inline, or an index with `writeToDisk`) |
| `figma_export_design_system` | — | `variantVisuals` | variables, styles, components, hygiene |
| `figma_export_selection` | — | `format` (`outline` default, `json`), walk options | the selection's outline; with `format: "json"`, its node JSON, variables, assets |
| `figma_export_url` | `url` (a figma.com URL with `?node-id=`, or a bare id) | `format` (`outline` default, `json`), walk options | that node's outline; with `format: "json"`, its node JSON, variables, assets |
| `figma_screenshot` | `nodeId` (an id or a URL) | `scale` (> 0) | a PNG of one node (the bytes only with `writeToDisk`) |
| `figma_write` | `ops` (at most 50, applied in order, all or nothing) | `dryRun` | the ids of applied ops (a `createTree`: the root id, counts, the ids of nodes with a `handle` and the `unbound` count; a keyed re-send: only what changed), any `warnings`; with `dryRun`, a preview and `editsAllowed` (and, for a source edit with a plugin connected, what follows it: `affects`) |
| `design_get_component` | `handle` (publish key, node id or exact name) | `exportDir` | one catalog entry and its variant node trees |
| `design_drift_lint` | — | `map`, `maxAgeHours`, `catalogs`, `screens`, `exportDir` | drift findings, snapshot age, and `screenCoverage` with `screens` |

`figma_write`'s ops (a hex colour is `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`; a create with no `parentId` lands on
the current page):

| `op` | Required | Optional |
|---|---|---|
| `createFrame` | — | `parentId`, `name`, `width` + `height` (both, or no resize), `layoutMode` (`HORIZONTAL` \| `VERTICAL`), `itemSpacing`, `padding` (`[top, right, bottom, left]`), `fill` (hex; `""` is the same as leaving it out: Figma's default fill stays) |
| `createText` | `text` | `parentId`, `fontSize`, `fill` (hex; `""` is the same as leaving it out: Figma's default fill stays) |
| `setFill` | `nodeId`, `color` (hex) | — |
| `setText` | `nodeId`, `text` | — |
| `setVariableMode` | `nodeId`, `collection`, `mode` | — |
| `clearVariableMode` | `nodeId`, `collection` | — |
| `createTree` | `tree` (one nested node spec, below), or `treeFile` (a path to the same spec as a JSON file) | `page` (a page's exact name or id; the current page when absent) |
| `patch` | `nodeId`, `set` (the fields to change, below) | — |
| `move` | `nodeId`, `parentId` (a node this plugin session created, and its new parent) | `index` (its place among the new parent's children, 0 first; last when absent) |
| `delete` | `nodeId` (a node this plugin session created) | — |
| `setVariable` | `variable` (a local variable's exact name, key or id), and `values` (mode name or modeId → value) or `value` (a collection with one mode) | — |
| `setStyle` | `style` (a local paint, text or effect style's exact name, key or id), `set` (the fields to change, below) | — |

**A batch is all or nothing.** Every op is checked before the first one runs (names, nodes, fonts, the fields each
node has), and a batch with any problem is refused whole, every problem listed. Then each op keeps what it replaces:
if one fails partway, everything the batch already did is put back — values restored, nodes it created removed, moved
nodes returned to their parent and place — and listed as `restored`. Deletes run last, once everything else has landed,
because a deleted node cannot be brought back. The batch is one Cmd-Z step for the designer.
A check that reads the file's current state (a node's or its parent's auto-layout, its variant, its paints, where a node
sits and what a parent holds) runs up front for an op no earlier op of the batch could affect; after such an op it
runs right before the op applies, against the file as the earlier ops left it, so a batch that turns a parent's
auto-layout on and then fills a child is accepted, and one that cannot work fails there and is put back whole. Names
(components, variables, text styles, pages, collections) always resolve against the file as it is before the batch:
renaming a component and naming it by its new name, or changing a component and relying on that change in a
`createTree` instance, takes two calls.

`setVariableMode` sets a node's explicit mode for one variable collection, so a dark or brand version of a screen is
the same frame with one op; `clearVariableMode` puts the node back on the mode it inherits from its parent.
`collection` is a local collection's exact name, or a collection's exact id or key; `mode` is a mode's exact name
in that collection, or its modeId. Names are case-sensitive and never guessed: before any op of the batch runs, the
plugin resolves every one, and a name that matches nothing or more than one thing (or a missing node, or a node
type that cannot carry a mode) refuses the whole batch, listing every problem with up to three candidates. A
library collection the file does not use yet is refused by name (using it means importing one of its variables,
which a write cannot do yet); one the file already uses works by its exact id. The reply names the collection and
the mode before and after (`inherited` when none was set), and the dry run says the same change in words (it does
not read the file, so it names the new mode only). If a later op of the batch fails, the mode changes are put back
with the rest of the batch.

`createTree` creates a whole screen in one op. `tree` is the root frame, written the way the read export writes a
node: the same field names and values, defaults left out, no ids and no parent references. A node is a `FRAME`, a
`TEXT` when it has `text`, or an `INSTANCE` when it names a `component` (`type` may say so). The fields a write sets so far:

| Field | Value |
|---|---|
| `type` | `FRAME` \| `TEXT` \| `INSTANCE` (default: `INSTANCE` when the node has `component`, `TEXT` when it has `text`, else `FRAME`; the root is a frame) |
| `name`, `hidden` | as read; `hidden: true` creates the node hidden |
| `handle` | a name of your own; the reply maps each handle to the created node's id (unique in the spec; not `__proto__`, which Figma's message passing drops) |
| `key` | the root only: a stable name for the result (at most 200 characters); the same key sent again updates that result in place (below) |
| `box` | `{w, h}`: the node's size (the read's page-coordinate `x`/`y` in it are accepted and set nothing) |
| `layout` | `{display: "flex", flexDirection: "row" \| "column", gap, padding: [t, r, b, l], justifyContent, alignItems, flexWrap: "wrap", rowGap, columnGap, alignContent: "space-between", reverseZ}`, or `{mode: "absolute", width, height}` for none (an auto-layout field beside `mode: "absolute"` is refused) |
| `widthMode`, `heightMode` | `fill` (in an auto-layout parent) \| `hug` (an auto-layout frame, or text); fixed when left out |
| `grow`, `alignSelf`, `absolute` | a child's role in its auto-layout parent; an `absolute` child is out of the flow, so it cannot `fill`, `grow: 1` or `alignSelf: "stretch"` |
| `x`, `y` | the root: page coordinates; a child: its place in a parent without auto-layout, or an `absolute` one |
| `sizeLimits` | `{minWidth, maxWidth, minHeight, maxHeight}`, each above 0 (leave one out for no limit) |
| `strokesInLayout` | `true`: the strokes count toward the auto-layout size; on a frame without auto-layout it has no effect (a warning) |
| `fills` | `[{type: "solid", color: "#hex", opacity?}]`; a frame without `fills` has none (not Figma's white) |
| `strokes` | `{colors: ["#hex"], weight, weights: {top, right, bottom, left}, align: "inside" \| "outside" \| "center"}`; the read's default `variableWidth: {profile: "uniform"}` is accepted |
| `radius` | a number, or `{tl, tr, br, bl}` |
| `opacity`, `clip` | as read; a frame without `clip: true` does not clip |
| `text` | the characters (a TEXT node only) |
| `font` | `{family, weight (the style name, e.g. "Semi Bold"), size, color, align, valign, lineHeight: {unit, value} or {unit: "auto"}, letterSpacing: {unit, value}, case, decoration, variationSettings: {wght: 560, …}}`; Inter Regular when left out. A `variationSettings` axis the family lacks is refused before the build; the read's `weightValue` is accepted and follows `weight` |
| `autoResize`, `truncate`, `maxLines` | as read; a text with `box` and no `autoResize` keeps a fixed box, one with neither grows with its text; `maxLines` needs `truncate: true` (else a warning) |
| `renderBox`, `reference` | the read's render bounds and its reference-image path: accepted, and they set nothing |
| `children` | the child nodes, in order |
| `component`, `props` | an `INSTANCE`: the component (a component set or component by exact name, or a component's key or id) and its property values by name — a variant's value, a text, a boolean (`{Size: "Large", Label: "Pay", Icon: true}`; a property's full `name#id` key works too). An instance takes `name`, `handle`, `hidden`, `box`, `x`/`y`, its place in an auto-layout parent and `opacity`; its content comes from the component, so `children`, `fills` and the rest are refused on it |
| `fills[].tokens` | `{color: variable}`: the paint is bound to a colour variable (the raw `color` may then be left out) |
| `tokens` | Figma's bindable fields → a variable: `itemSpacing`, `counterAxisSpacing`, `paddingTop`/`Right`/`Bottom`/`Left`, `topLeftRadius`/`topRightRadius`/`bottomRightRadius`/`bottomLeftRadius`, `width`, `height`, `minWidth`/`maxWidth`/`minHeight`/`maxHeight`, `strokeWeight` and the per-side stroke weights, `opacity` (a number variable each), and `fills` / `strokes` (colour variables, one per paint; with no raw list, one bound paint each). A text binds `width`, `height`, `opacity`, `strokeWeight`, `fills`, `strokes`; an instance `width`, `height`, `opacity` |
| `styles` | `{text: style}` on a TEXT: the text style (its font, size, line height, letter spacing, case and decoration; those `font` fields are then accepted and not set, with a warning) |

A variable, component or text style is named by its exact name (case-sensitive, never guessed), or by its exact key or
id. A variable not in the file but in an enabled library is found by name too; a library component or text style is
named by its key (the Plugin API lists no library components or styles). A name that matches nothing or more than one
thing, a variable of the wrong type for its field (a number on a paint), a property the component lacks or a variant
value it does not have, or an instance that hugs when its component has no auto-layout — every one is listed in one
refusal, each with up to three candidates, before anything runs. Importing a library item is itself a write: it runs
only after the whole batch resolved, with "Allow edits" still on, and a key no enabled library publishes refuses the
batch then (an item already imported stays available in the file; nothing is built). Raw values still work: the reply
counts them as `unbound` (each raw colour, spacing, radius and stroke weight, and each text without a text style).

Every other field of the read export (`effects`, `textTokens`, `mainComponent`, `runs`, …) is refused by name, saying
why; a key the read export does not have is refused with the closest field names. Everything is checked before the file
is touched: the spec itself (by the dry run, the bridge and the plugin alike), then the `page` name, every font and
every design-system name against the file, with up to three candidates for each miss — and a bad spec, page, font or
name refuses the whole batch.
The tree is built hidden, then moved to its page and shown only when every node is in place, so it lands whole or not
at all; if a later op of the batch fails, the tree is removed and listed as `restored`. Without `x`/`y` on the root,
the new frame goes 100 px right of the rightmost frame on the page, level with the topmost, so it overlaps nothing.
The reply is small: `{id, created: {frames, texts, instances}, handles, unbound}` for the tree (`instances`, `handles`
and `unbound` only when there are any), plus `warnings` for anything that had no effect (an `x`/`y` inside auto-layout,
`strokesInLayout` without auto-layout, `maxLines` without `truncate`, a `font` field a text style sets). So a
read node can be fed back in: what the read writes on an ordinary frame or text is accepted. The dry run says the change in one sentence: the frame, its size and layout,
the node counts, where it lands, the handles, the fonts, the components, variables and text styles it names, and how
many raw values stay unbound (it does not read the file, so the names are checked when applied). A spec holds at most 500 nodes.

**A spec from disk.** `treeFile` names a JSON file holding the spec (the value `tree` would have), relative to the
directory the MCP server was started in and inside it, at most 2 MB. The server reads it into `tree` before anything
else looks at the batch, so a spec given by path is checked, previewed and applied exactly like the same spec inline,
and the plugin never sees the path. A missing file, one that is not JSON, a path outside the project, a `treeFile`
beside a `tree`, or one on another op refuses the whole call with nothing changed. A spec a script produced costs the
model nothing to send, and a corrected one is sent again by the same path. The CLI has no write command: writes stay on
the MCP server.

**Re-send updates in place.** A root `key` is stored on the result (as this plugin's own plugin data: the key and each
node's own spec fields on every node it builds, and the root's id under the key on the document). When a spec with the
same key comes back and the result is still in the file, it is updated instead of a second one being built:

- each node is matched to the one built from the spec sent last time — by `handle`, then by a `name` unique among its
  siblings on both sides, then in order (two named nodes pair only when the names are the same);
- a matched node keeps its id, and only the fields that differ from the spec sent last time are set (through the same
  code as `patch`, plus `x`/`y`, `absolute`, `grow`, `alignSelf`, `clip`, `sizeLimits` and `strokesInLayout`), so
  whatever the designer changed by hand in the meantime stays unless the new spec changes that field; a field the new
  spec drops goes back to what a fresh build leaves it at (no fills on a frame, opacity 1, no auto-layout, …);
- a node the new spec adds is built in its frame; one it drops is removed; one that changed type or component, or whose
  change cannot be made in place (a text's `font`, `truncate`, `maxLines` or sizing mode, a dropped text style, an
  instance's dropped property, name or size), is built anew in the old one's place, which is removed;
- a frame whose children change order is reordered, and a layer the designer added inside keeps its place.

Removals run last, with the batch's deletes; a node to be removed that holds a layer this key did not build refuses
the batch (move the layer out, or keep the node in the spec). Everything else is put back like any op's if the batch
fails, and the update is one Cmd-Z step. `page` must be left out or name the page the result is on. One key may appear
once per batch. If the result was deleted, the key builds a new one.

The reply lists only what changed: `{id, key, changed: [{id, handle?, fields}], created, removed, reordered, handles}`
(each part only when there is any; `handles` only for nodes built now or newly given a handle), or
`{id, key, unchanged: true}` when the spec is the one sent last time. A fix round of one text is a reply of about 25
tokens.

`patch` changes an existing node by id. `set` names the node's fields the way the read export (and a `createTree` spec)
names them, and only the fields given change; each is checked with the rule the tree spec uses for the same field:

| Field | Value |
|---|---|
| `name`, `hidden` | the layer name; `hidden: true` hides it, `false` shows it |
| `opacity` | 0 to 1 |
| `text`, `styles` | a TEXT's characters; `{text: style}` sets its text style (by exact name, key or id) |
| `autoResize` | a TEXT: `width_and_height` \| `height` \| `truncate` \| `none` |
| `fills` | `[{type: "solid", color, opacity?, tokens?: {color: variable}}]`, replacing the paints (`[]` for none) |
| `strokes` | any of `{colors, weight, weights: {top, right, bottom, left}, align}`; only the parts given change (`colors: []` removes them) |
| `radius` | a number, or any of `{tl, tr, br, bl}` |
| `layout` | any of the tree spec's `layout` fields, only those given change (`display: "flex"` turns auto-layout on; on a frame that has it, `{gap: 12}` alone is enough); `flexWrap: "nowrap"`, `alignContent: "auto"` and `reverseZ: false` turn those off; `{mode: "absolute"}` removes auto-layout |
| `box` | `{w, h}` or either one: a fixed size (a TEXT's box is fixed: its `autoResize` becomes `none`, or `height` when only `w` is given) |
| `widthMode`, `heightMode` | `fill` (in an auto-layout parent) \| `hug` (with auto-layout, or a TEXT) \| `fixed` |
| `tokens` | as in a tree spec, a field → a variable; `null` unbinds the field and keeps its value |
| `props` | an INSTANCE's property values by name, as in a tree spec (a variant's value, a text, a boolean) |

Before anything runs, the plugin checks that the node exists and has each field (a `text` on a frame, `props` on a
frame, a gap on a frame without auto-layout, `fill` in a parent without auto-layout are refused by name), that every
variable, text style, property and variant value resolves exactly as in a tree spec (a library variable named in a
patch is imported only once the whole batch resolved), and that the fonts a text change needs load. Any other field
(`font`, `x`, `children`, …) is refused by name. The reply is `{id}` per patch (with `unbound` when raw colours,
spacing, radii or stroke weights were set where a variable could stand). The dry run shows one row per field
(`fields: [{field, to}]`) and the change in one sentence.

`move` and `delete` work only on nodes this plugin session created — since the plugin window was opened, by
`createFrame`, `createText` or `createTree` (with everything below them). A delete takes everything below the node,
so it is refused when anything there was not created this session; a move is refused into the node itself, into an
instance, or past the end of the new parent's children. An op that names a node a delete of the same batch removes is
refused up front. The reply is `{id, parentId}` for a move and `{id, deleted: true}` for a delete.

**Source edits** change a design-system source once, and Figma carries the change to everything that uses it: one op
instead of one per node, and the nodes stay bound. Only this file's own sources can be changed: a variable, style or
component that lives in another library file is refused, naming the library when Figma says which (it does for a
variable; for a style or a component only the file's library registry, document plugin data `libraryRegistry`, can).
A library variable the file already uses is found by its key even when its library is no longer enabled (through the
local variables that alias it and the local styles bound to it): it can be bound in a spec, a patch or a style's
`tokens` with no import, and a source edit of it is refused as a library's. A file on a Figma plan that allows fewer
modes than a copied collection has refuses a value for a mode past the limit; the error names the mode and the plan,
and the batch is put back.

- `setVariable` sets a local variable's value per mode. `values` maps a mode's exact name (or its modeId) to a value as
  the read export's `values` writes one: a hex colour for a colour variable, a number, a string, `true`/`false`, or
  `{aliasOf: <variable name, key or id>}` (an alias of the same type; one that would make a loop is refused). `value`
  sets the only mode of a one-mode collection (refused, listing the modes, when there are several). A composed colour
  is refused by name. The reply is `{id, modes}`.
- `setStyle` changes a local style. `set` takes the read export's style field names, and only those given change; a
  style is one kind, so fields of two kinds are refused:

  | Kind | Fields |
  |---|---|
  | paint | `paints`: `[{type: "solid", color, opacity?, tokens?: {color: variable}}]`, replacing the paints |
  | text | `font` (family), `weight` (style name), `size`, `lineHeight` (`{unit: "px" \| "percent", value}` or `{unit: "auto"}`), `letterSpacing` (`{unit: "px" \| "percent", value}`), `case` (`original` \| `upper` \| `lower` \| `title` \| `small_caps` \| `small_caps_forced`), `decoration` (`none` \| `underline` \| `strikethrough`), `paragraphSpacing`, `paragraphIndent`; `tokens` (a field — `fontFamily`, `fontStyle`, `fontWeight`, `fontSize`, `lineHeight`, `letterSpacing`, `paragraphSpacing`, `paragraphIndent` — → a variable's name, key or id; `null` unbinds and keeps the value; bound after the raw values) |
  | effect | `effects`: `[{type: "drop_shadow" \| "inner_shadow", color, offset: {x, y}, radius, spread?, behindNode?}]` and `[{type: "layer_blur" \| "background_blur", radius}]`, replacing the effects |
  | any | `name`, `description` |

  The style's fonts (now and after) must load (when its font is bound to a variable an earlier op of the batch changes,
  they are checked when the edit applies). The reply is `{id}`.
- A `patch` of a main component (or of a layer inside one) is a source edit too: every instance follows. A layer
  inside a library component is refused.

With a plugin connected, the dry run asks it what each source edit carries to (`writeImpact`, a read that needs no
"Allow edits"): `affects.nodes` counts the layers that use the variable or style (directly, through an alias, or
through a style bound to the variable), `affects.styles` and `affects.variables` the styles and aliases bound to a
variable, and `affects.instances` a main component's instances. A source edit the file refuses as it is now shows
`refusedByFile` with the reason. With no plugin connected the preview says the counts are missing, rather than
guessing. If a later op of the batch fails, a source edit is put back with the rest (a variable's old values and
aliases, a style's paints, effects, fonts and its bound variables).

### "Allow edits" — the plugin changes nothing until the designer opts in
The plugin window has an **Allow edits** checkbox, **off by default**. While it is off the plugin only reads:
every `figma_write` batch is refused whole, before any op runs, and the tool returns this error (nothing in the
file changed):

> Edits are off in the Design Twin plugin — tick 'Allow edits' in the plugin window, then retry. Nothing in the file was changed.

That is not something an agent can fix. **Ask the user to tick "Allow edits" in the Design Twin plugin window,
then retry the same call.** The plugin's main thread holds the setting and checks it on every write; nothing on
the bridge side can turn it on.

- **Dry run still works while it is off.** `dryRun: true` previews the batch as before and adds `editsAllowed`
  (read from the plugin's `whoami`): `false` → a real write would be refused right now (the preview also carries
  `wouldRefuse` with the sentence above); `true` → it would be applied; `null` → unknown (no plugin connected,
  several connected with no `client`, or a plugin built before the opt-in). Check it before asking the user to
  review a preview, so the request to tick the box comes in the same breath.
- **The setting is per user, for every file.** It is saved in Figma's `clientStorage`, which is already scoped
  to one user and this plugin. It is not per file: the plugin cannot reliably name a file (`fileKey` is only for
  private plugins, and file names repeat), and a per-file flag stored in the document would itself be an edit.
  Untick it when you are done.

### "Review each write" — the designer applies or rejects each batch
Under **Allow edits** the plugin window has a second checkbox, **Review each write**, also **off by default** (off,
writes apply at once). When it is on, a `figma_write` batch that resolves against the file does not run: the window
shows a card listing what the batch would do, one plain line per op (the same description the dry run gives), with
**Apply**, **Reject** and a box for a reason. The tool call waits for the answer.

- **Apply** runs the batch as usual (one Cmd-Z step).
- **Reject** refuses it with nothing changed. The error carries the reason the designer typed (up to 500 characters):

  > The designer rejected this write in the Design Twin plugin window. Nothing in the file was changed. Their reason: "…"

  Act on the reason; don't resend the same batch.
- **Nobody answers within 5 minutes**: refused with nothing changed ("Nobody applied or rejected this write …").
  The write's bridge budget is 6 minutes, so this reply always comes first.
- **The call is cancelled, or the bridge drops** while the card is up: the card is withdrawn, so a designer can never
  apply a write nobody is waiting for. Closing the plugin window stops the plugin, and the bridge rejects the call on
  the disconnect; nothing was applied.
- **"Allow edits" is unticked while the card is up**: refused at once as edits-off. "Allow edits" off is still checked
  first, before any card.

A dry run reports `reviewWrites: true` when it is on, and its note says a real write will wait. Only the window's
checkbox can set it (saved per user, like Allow edits); nothing on the bridge side can turn it off or answer a card.
This is the plainest form of the review: how a richer review is shown, when it applies and how the agent waits is
still being prototyped.
- **No write is silent.** Each applied batch (and each refused one) shows a Figma toast and a line in the plugin
  window, e.g. "Design Twin applied 3 edits to this file."
- `dtwin whoami` prints the state (`edits: off — …` / `edits: ALLOWED — …`) and `editsAllowed` is in its JSON.

### The screen outline — the default inline answer for one screen
`figma_export_url` and `figma_export_selection` answer inline with an **outline**: one line per node (type, name, id,
size, layout, component, text, font, paints, tokens, styles), with values that repeat hoisted into `$X` tables once.
The first line names the level. Over the inline limit it falls back, in order:

| Level | What is on it |
|---|---|
| `full` | every node with its layout, text, fonts, paints, tokens and styles |
| `layout` | every node's identity, size, layout and component, and the first characters of its text |
| `sections` | the screen's top-level sections with their ids, to read one at a time |

The JSON stays the source of truth. A field a level leaves out is counted in a `Not shown` line, and the manifest's
truncation counts and warnings are in the header at every level. `format: "json"` returns the raw node JSON inline
when it fits. A screen too big for that is still written to disk on its own, and its outline then comes as a second
text block beside the JSON index. With `writeToDisk: false` nothing is written and you get the outline alone. `dtwin
outline <screen.json> [--budget N]` prints the same view for a file already on disk.

### `writeToDisk` — the export path that doesn't go through the context window
Every export tool takes `writeToDisk: true` (plus an optional `outDir`). It writes the export through
the same `write-out.ts` the CLI uses — same layout, by construction — and returns a **compact index**
(counts + file paths) instead of the node payloads. The agent then Reads/Greps those files at whatever
granularity it needs. Written JSON is compact with one node per line, so a line offset pages a screen and a
grep hit is one node's line.

Use it for anything past a quick look. Two things make it not optional:
- **Asset bytes are never returned inline** (they'd dump megabytes of base64 into context), so
  `writeToDisk` is the *only* way to get `assets/` out of the MCP path.
- **Inline MCP results are capped** (25k tokens by default, `MAX_MCP_OUTPUT_TOKENS`, and never above
  48,000 characters — under Claude Code's own 50,000-character persist threshold). The server
  measures the result before returning it: one that would not fit is **written to disk on its own**
  and the index's `note` says so (a real design-system export is several times the limit). Passing
  `writeToDisk: false` opts out of that — an oversized result is then an error naming the size,
  never a payload cut off mid-JSON (a screen's outline still comes back, unless you asked for `format: "json"`).

Every export result (written or inline) carries `sourceFile` (the Figma file it came from) and
`durationMs {total, request, write}`. When an implicit spill replaces a file whose content differs (the stamps
`exportedAt`/`generatedAt` aside), the previous one is kept one level as `<file>.prev` and the note names it. A screen
spill (`figma_export_url`/`figma_export_selection`) keeps ONLY `<screen>.json.prev` (`wrote.prev`) — its `.vars.json`,
`.assets.json`, `pages/index.json` and the merged `variables.json` are replaced with no copy, so a restored `.prev` is
paired with the NEW siblings. A page/full/design-system spill keeps one per changed JSON file under `pages/` and
`design-system/` plus `design-system.json`, listed in `wrote.prevKept`, with the count. `figma_status` reports
`snapshot` — the export on disk, the verdict `dtwin doctor`'s export line words: `exportedAt`/`ageMs`/`sourceFile`/`file`
of its NEWEST stamp (whichever source was pulled last — not the design system's by default), `warning` when no source
carries a usable stamp, `stale` (older than `staleAfterMs`, 24h), `sources[]` (`{kind: "screens"|"design-system"|
"page-walk"|"screen-doc", sourceFile, count?, exportedAt, ageMs, problem?, file?}` — the screens of each Figma file, `sourceFile:
null` for rows an older bridge did not stamp) and `problems[]` (files there but unusable); `{file, error, problems}` when
the only export file there is unusable; null when nothing is exported — plus
`lastScreenExport` (the newest screen on disk: name, id, file, exportedAt, ageMs) and `lastWrite` (this server process's
last export: tool, time, whether implicit, file, `prev`, `prevKept` count). `figma_whoami`'s `connection` is the addressed
client's. `page`, `screens` and `catalogs` arguments accept an array, a JSON-encoded array string or a bare string.
`design_drift_lint` runs the CLI's own lint run: `screens: string[]` (the CLI's `--screen`) adds `screenCoverage`
with its warnings, `catalogs: string[]` (the CLI's `--catalog`) adds catalogs the map may point into, both under the
working directory. A file the CLI would refuse (exit 2: a missing or non-catalog file, a broken `catalogs` entry, a
non-screen) is a tool error with the CLI's message; an unreadable discovered catalog is a `catalog-unreadable` warning. An interrupted tool call (Claude Code's cancel,
or the session ending) cancels the in-flight read in the plugin; `figma_write` is never cancelled, since a
write cannot be un-applied.

`outDir` resolves against **the directory the MCP server was started in** — i.e. the project you're
building, not this repo. Default `FIGMA_EXPORT_DIR` or `design/export/`, the same var `figma_status` reads. The `design_*` tools'
`exportDir` defaults the same way (`FIGMA_EXPORT_DIR`, else the project's export — `design/export/`, or `design/` on
the older flat layout), and `design_drift_lint`'s `map` to `design/codeconnect.local.json` (or a root
`codeconnect.local.json` an older project still has).
With `writeToDisk: true` or an explicit `outDir` it is checked before the export (inside the project
lexically or by real path), so a refused path never costs a read; a server started at the filesystem root accepts none.

> **One bridge, shared.** Port 8787 has one owner at a time. The MCP server and `dtwin serve` both
> publish the bridge they own on a local socket, and everything that starts later — a `dtwin` command,
> a second Claude Code session's MCP server — routes through it instead of binding the port again.
> When the owner exits, the next MCP call opens the bridge itself (the plugin reconnects on its own).
> The one holder that does NOT share is a plain one-shot `dtwin pull` with no daemon: while it runs,
> another `dtwin` command that needs the port exits with `EADDRINUSE`, while an MCP server stays up and
> only that tool call errors — retry it once the pull is done. `writeToDisk` is still the simplest way
> to get files from inside an MCP session. On Windows the shared socket is a named pipe guarded by a
> token handshake (see the `--serve` section); sharing otherwise works the same.

**Look before you pull.** `figma_list_pages` (and `figma_list_children` to drill into one frame) return
a cheap structural index — ids, names, types, sizes; no recursion, no assets, no node properties. Every
other read here deep-serializes, so without them the only way to learn what a file holds was to export
all of it: measured 12+ minutes and tens of MB straight into the context window on a real design
system. Use the index to pick a target, then `figma_export_full({ page: ["<id>"] })` — or
`skipAssets: true`, which is close to free here since asset bytes are stripped from MCP results anyway.

`figma_list_libraries` (optional `client`, like every Figma tool) is a side step, not part of that order: it answers **which design
libraries** the file draws on — which library owns a token, or what to name in an `--as-library` pull. Its result is deliberately
compact — libraries, their variable collections, and usage-derived component counts — because a
discovery call that costs context defeats its own purpose. The same three limits apply as for the CLI
flag above (usage-derived counts, UI-only library enablement, empty-is-normal), and the tool reports
them in-result rather than leaving an empty list ambiguous. It is a discovery read (no export) but the
slowest one — a few seconds up to ~15 s (about 2 s on a file with no libraries enabled): it walks every
instance and makes one Figma call per enabled library collection. Recommended order for one
screen: `figma_status` → `figma_list_pages {depth:1}` → `figma_list_children` → `figma_export_url
{url:"<node id>", writeToDisk:true}`; `figma_export_full({ page: [...] })` only for a whole page, and
`figma_list_libraries` when you need to know which library owns a token.

**Only want the design system?** `figma_export_design_system` skips the page/frame walk (and the
assets that walk would produce) and returns just variables/styles/components/hygiene — the MCP twin of
the CLI's `--design-system` flag. Same `writeToDisk`/`outDir` contract as the other export tools; same
one honest gap, too: on a file that CONSUMES a library this returns that file's own tokens plus only the
library variables something in it references — never the library's catalog (that is `--as-library`, CLI
only, run with the library open).

### "Paste a link and ask about it" (`figma_export_url`)
CLI twin: `dtwin pull --node <id>` (see above) — same underlying `exportNode` op, so a pull from
either surface lands in the identical shape.

Keep Claude Code and the MCP running for the whole session; the plugin stays connected to your
open file. Then just paste a Figma link and ask — Claude pulls the node the link points to and
answers from live data, as many times as you like (free, no per-request cap):
```
you: here's the header — https://figma.com/design/KEY/App?node-id=123-456 — what spacing does it use?
→ Claude calls figma_export_url(url); the plugin exports node 123:456 live.
```
It reads the **live open file** — it can't fetch a link cold. The file the link points to must be
open in the Figma desktop app with the plugin running. A URL carries `node-id` in dash form
(`123-456`); the plugin normalises it to Plugin-API colon form (`123:456`). A read by id leaves your
selection, viewport and current page alone (so an agent reading between two of its writes adds no undo step);
to see the node, open the link or select it yourself.

Pre-approve tools in `.claude/settings.json`:
```
{ "permissions": { "allow": ["mcp__designtwin__*"] } }
```

## Notes / limits
- The Figma file must be **open** with the plugin running for either path (never headless).
- One process owns port 8787 at a time. `figma-mcp` and `dtwin serve` share the bridge they own
  (later `dtwin` commands and MCP servers route through it); only a one-shot pull does not. A `dtwin`
  command that then finds the port taken exits immediately with a clear `EADDRINUSE` message; an MCP
  server stays up and that one tool call errors — retry it after the pull.
- Windows: the daemon is a named pipe named from the bridge token, and every connection proves the token
  first (`daemon-auth.ts`). A daemon started under an EARLIER token cannot be found or stopped by name —
  `--rotate-token` stops it before rotating, so that only happens to one started with a different
  `FIGMA_BRIDGE_TOKEN`.
- Each response travels as one WebSocket frame, and a frame may be at most `FIGMA_BRIDGE_MAX_PAYLOAD_MB` (default 128; clamped just under
  4096). A value that is not a number above 0 falls back to 128 with a warning — there is no "unlimited".
  An export over it fails with a message quoting the cap in force.
- Image assets travel as base64 (not JSON int-arrays) — ~3.5–4x smaller on the wire.
- Profiling: `DTWIN_TIMINGS=1` prints one `[dtwin] timings {…}` JSON line on stderr at the end of a
  `dtwin` command; `DTWIN_TIMINGS=<file>` appends it to that file instead (JSON Lines). It holds the
  connect / export / write split, when each plugin phase (`queued`, `page`, `designSystem`, `assets`, …)
  was first and last heard, the queue wait, the reply's asset count and decoded bytes, and peak RSS —
  counts and times only, never a file, page or layer name, a key or document content. Off by default.
- Hidden-graphic reuse (`assetFrom`) compares the node's own rotation/flip and box only, not an
  ancestor's, and not which slot of its parent the icon sits in (two icons of one component in one
  parent variant count as one, even if that variant colours them differently); across screens it depends on pull order (a screen pulled before its twin's screen keeps
  `assetSkipped:"hidden"`, and re-pulling it later changes its JSON with nothing changed in Figma), and
  each `.assets.json` row offers one `reuseKey`. With an old plugin still loaded, the geometry warning
  may name hidden nodes — re-run the plugin.
- A cross-screen twin comes from any screen JSON on disk, however old: a screen pulled before its icon
  component was redrawn hands its old file to a hidden node of a screen pulled today (the IR carries no
  component version to check). Re-pull every screen in a sync.
- `list children` titles a colliding row from its "Page Title" slot; when that search runs past its node
  cap (a very large frame), the row's `title` falls back to the first text — which can differ from the
  title the pages index gives the same screen after a pull. `distinctTexts` reads the same way, with a
  budget of 20000 node reads for the whole listing (a group with a row it cuts off gets none — see the warning).

## For contributors

Notes for working on the bridge itself, in a clone of the repo.

- **Languages:** the whole bridge is **TypeScript** (ESM) under `src/` — `figma-pull.ts` (read CLI),
  `server-core.ts` (WS core), `figma-mcp.ts` (MCP server), and the modules they share. From a checkout,
  Bun runs it directly with **zero build** (`bun bridge/src/figma-pull.ts …`, `bun bridge/src/figma-mcp.ts`), and the
  package ships the same TypeScript: its `dtwin` bin — what `bun add -g` or `bun link` puts on your PATH — is `src/figma-pull.ts`,
  whose shebang is `#!/usr/bin/env -S bun --no-install --no-env-file` (so a `.env` or a missing package in the
  project you run it from can neither change its environment nor make Bun fetch a module from the registry;
  `env -S` needs GNU coreutils ≥ 8.30 or a BSD/macOS `env` — on BusyBox, call `bun --no-install --no-env-file` on
  the file yourself, see Install above).
  The WebSocket server is Bun's own (`Bun.serve`), so the only runtime dependencies are the MCP SDK and zod.
  `bun run typecheck` is `tsc --noEmit` (the only check: there is no emit step).
- This repo has no `.mcp.json` on purpose, so the MCP server never starts while you are working *on* the bridge.
- Responses are not chunked. If very large pages outgrow the frame cap, chunking is the fix (see
  [ARCHITECTURE.md, "Verified mechanism details"](https://github.com/its-magdy/design-twin/blob/main/ARCHITECTURE.md#verified-mechanism-details-build-to-these)).
- Write ops are a deliberately small, explicit set — a new op is a name in `WRITE_OP_NAMES` and a row in `WRITE_OPS`
  (`src/commands.ts`), its fields in `figma_write`'s op schema (`src/figma-mcp.ts`), and a case in `applyWrite()` in
  `../figma-plugin/src/writes.ts` (rebuild `code.js`).
