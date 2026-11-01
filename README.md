<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/wordmark-dark.svg">
    <img alt="Design Twin" src="assets/wordmark-light.svg" height="72">
  </picture>
</h1>

> Figma → code with Claude Code, on the **free** Figma plan, with nothing leaving your machine.

Design Twin reads a Figma screen through a local plugin and has Claude Code build it in your stack, with your own
components and tokens, then measures the result against the design.

<!-- demo.gif goes here -->
<!-- TODO(owner): record a ~15 s demo (pull a frame → /designtwin:build-screen → verify report) and embed it here. -->

[![test](https://github.com/its-magdy/design-twin/actions/workflows/test.yml/badge.svg)](https://github.com/its-magdy/design-twin/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

- [First screen in 5 minutes](#first-screen-in-5-minutes)
- [Why Design Twin?](#why-design-twin)
- [Known limitations & platform support](#known-limitations--platform-support)
- [How it works](#how-it-works)
- [Quick start for agents](#quick-start-for-agents)
- [Installation details](#installation-details)
- [Set up your project](#set-up-your-project)
- [Usage](#usage)
- [Command reference](#command-reference)
- [Where files land](#where-files-land)
- [Running tests](#running-tests)
- [Further reading](#further-reading)
- [License](#license)

---

## First screen in 5 minutes

You need the **Figma desktop app** (any plan, including free) and **Claude Code**. Run the commands in the root of
the app you are building.

1. Install the `dtwin` CLI. Homebrew brings Bun with it; with `bun add`, install [Bun](https://bun.sh/install) first.
   ```bash
   brew install its-magdy/tap/dtwin      # or: bun add -g @design-twin/dtwin
   ```
2. Install the Claude Code plugin.
   ```bash
   claude plugin marketplace add its-magdy/design-twin
   claude plugin install designtwin@designtwin-marketplace
   ```
3. Set up the project. This creates `design/`, the bridge token, the Figma plugin's copy and an `.mcp.json` entry.
   Then enable the server with `/mcp` and restart Claude Code.
   ```bash
   dtwin init --mcp
   ```
4. Import the Figma plugin, once: in Figma desktop, **Plugins → Development → Import plugin from manifest…**, and
   pick the file this prints. On macOS the folder is hidden, so press ⌘⇧G in the file picker and paste the path.
   ```bash
   dtwin plugin path
   ```
5. Connect the plugin, once: run **Plugins → Development → Design Twin**, open **Connect to Claude Code
   (optional)**, paste the token this prints, and press **Save**.
   ```bash
   dtwin token show
   ```
6. In Claude Code, build a screen. Copy the frame's link in Figma (right-click it → **Copy/Paste as → Copy link to
   selection**), and keep the file open with the plugin running.
   ```
   /designtwin:build-screen <Figma frame link>
   ```

Something not working? `dtwin doctor` checks every piece and prints the next step for each failure, and
`/designtwin:help` covers the rest. For other install routes and upgrades, see
[Installation details](#installation-details).

---

## Why Design Twin?

Figma's own MCP server and Dev Mode, and most design-to-code tools, read the design through Figma's REST API or a
hosted service, and their limits follow your Figma plan and seat. Design Twin reads through the **Figma Plugin API**
instead: a plugin running in your own Figma desktop app, on your machine.

| | Design Twin | Figma's official MCP server / Dev Mode | Typical design-to-code tools |
|---|---|---|---|
| **Figma plan** | Any, including the free Starter plan. No Dev seat, and the Plugin API has no documented request quota | The desktop server needs a Dev or Full seat on a paid plan. View and Collab seats (the only seats on Starter) get 20 tool calls a month | Many read through the REST API, where View and Collab seats get up to 20 file reads a month (Figma documents as few as 6 a month for a file on the Starter plan) |
| **Where your design goes** | Nowhere. The plugin's manifest allows only `ws://localhost:8787`–`8789`, so it cannot reach the internet | The recommended remote server runs on Figma's hosted endpoint | Often a hosted service |
| **Your components and tokens** | Built in, free: `design/codeconnect.local.json` maps Figma components to yours, `design/tokens.json` maps variables to your tokens, and drift-lint checks the code against both | Code Connect, which needs a Dev or Full seat on the Professional, Organization or Enterprise plan. Variables over REST are Enterprise-only | Varies |
| **Checking the build** | `verify` renders the screen, measures every node against the design's own numbers and computes the verdict from that report. Anything nobody measured is `not-probed`, never a pass | Left to the agent | Varies |
| **Target stacks** | Web (Tailwind, CSS Modules), React Native, SwiftUI, Jetpack Compose, Flutter, or your own profile | Any, through the agent | Varies |

Figma's plan and rate-limit figures above were checked against
[developers.figma.com](https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/) on 2026-11-01.
Figma changes them often, so check there before relying on them.

---

## Known limitations & platform support

- **Figma desktop only.** A browser tab can't import a development plugin. The plugin is not listed on Figma
  Community, by design: you import it once as a development plugin, from the copy `dtwin` installs.
- **Bun is required.** The CLI, the MCP server, and the Claude Code plugin's scripts and hooks all run on
  [Bun](https://bun.sh/install) 1.4.2 or later. Node alone won't run them, even when installed with `npm`.
- **Claude Code for the skills.** The audit, build, verify and sync workflows are a Claude Code plugin.
- **Writes are deliberately small.** `figma_write` (MCP only) applies a few safe ops: create a frame or text, set a
  fill, set text. It runs no arbitrary code, and the plugin refuses every write until you tick **Allow edits** in its
  window. The box is off by default, and no agent can tick it.
- **Build quality varies by stack.** On web, `verify` drives a real Chromium through your project's Playwright and
  measures every node. On native stacks, it uses the stack's own tools (simulator, emulator, Flutter golden tests),
  which you set up. The Kotlin (Compose) and Dart (Flutter) token files have never been compiled in this repo's CI,
  which has no Android or Flutter toolchain.

| OS | Status |
|---|---|
| **macOS** | Tested with a live Figma file, and in CI (the quick suites, on macOS 15). |
| **Windows** | CI runs the quick suites on Windows, including the `dtwin serve` daemon, which uses a named pipe behind a token handshake there ([#12](https://github.com/its-magdy/design-twin/issues/12)). Live Figma runs so far have been on macOS. The Claude Code plugin's start-up hook needs `sh` (for example from Git Bash); without it, the hook errors. |
| **Linux** | CI runs every suite here, including the browser verify tests. Figma has no official desktop app for Linux, and the plugin can only reach `localhost`, so live pulls need Figma desktop on the same machine: a Mac or Windows PC. The skills also work on a manual export copied over from one. |

---

## How it works

The repo ships **three products**, installed separately:

| Piece | What it is | How you install it |
|---|---|---|
| `figma-plugin/` | The Figma-side extractor. Reads the open file and exports JSON, variables, and SVG/PNG assets. | `dtwin plugin install`, then imported once into Figma desktop from its manifest (or straight from a clone) |
| `bridge/` | The `dtwin` CLI and the MCP server. Both talk to the Figma plugin over a localhost WebSocket (port `8787`). | `bun add -g @design-twin/dtwin` or `brew install its-magdy/tap/dtwin` (or from a clone: root `bun install`, then `bun link` in `bridge/`) |
| `claude-plugin/` | The `designtwin` Claude Code plugin: skills, stack profiles and agents. It has no dependencies beyond Bun on PATH. | `claude plugin install` |

The plugin exports the design, its variables and its assets to your project's `design/export/` as stack-neutral
JSON. Claude Code skills then review the design, build it in your stack reusing your components and tokens, check
the result against the design, and re-sync the code when the design changes.

There are three ways to get a design out of Figma:

| Path | Setup | Best for |
|---|---|---|
| **Manual**: click **Export** in the Figma plugin, save the downloads into `design/export/` | Figma plugin only | A first try, or a single screen |
| **`dtwin` CLI**: pulls straight to disk | + bridge | Repeated or bulk pulls |
| **MCP server**: Claude calls Figma as live tools, and it is the only path that can write to Figma | + bridge + `.mcp.json` | Working back and forth ("check this, now pull that") |

Supported target stacks: `web-tailwind`, `web-css-modules`, `react-native`, `swiftui`,
`android-compose`, `flutter`. To add another, copy
`claude-plugin/skills/build-screen/profiles/_template.md` to `profiles/<name>.md` in your project.

---

## Quick start for agents

If you are an agent setting this up for a user, run these in the root of the project being **built**. Three steps
are clicks in Figma that only the user can do. Ask for them; don't try to script them.

```bash
which dtwin || bun add -g @design-twin/dtwin   # or: brew install its-magdy/tap/dtwin
dtwin --version
dtwin init --mcp          # design/, target.json, bridge token, plugin copy, .mcp.json entry
dtwin plugin path         # the manifest.json the user imports into Figma
dtwin token show          # the token the user pastes into the plugin
dtwin doctor              # every check, with the next step for each failure
```

The user's part, in Figma desktop:

1. **Plugins → Development → Import plugin from manifest…** and pick the file `dtwin plugin path` printed (once).
2. Run **Plugins → Development → Design Twin**. Open **Connect to Claude Code (optional)**, paste the token, and press **Save** (once).
3. Only before a `figma_write`: tick **Allow edits** in the plugin window. It is off by default, and no agent can turn it on.

Then `/designtwin:help` covers the rest. Its troubleshooting reference matches each `dtwin doctor` failure to a fix.
Working on this repo itself? Read [`CLAUDE.md`](CLAUDE.md) first.

---

## Installation details

### Prerequisites

- The **Figma desktop app**. A browser tab can't import a development plugin. Any plan works, including free.
- **[Bun](https://bun.sh/install) 1.4.2+** (CI runs 1.4.3, and the 1.4.2 floor on Linux). Everything here runs on Bun — the
  CLI, the MCP server, the plugin's scripts and hooks; Node is not supported. Install: `curl -fsSL https://bun.sh/install | bash`
  (macOS, Linux) or `powershell -c "irm bun.sh/install.ps1 | iex"` (Windows).
- **Claude Code**, for the skills.
- **git**, only if you install from a clone.

### The CLI

```bash
bun add -g @design-twin/dtwin   # puts `dtwin` in ~/.bun/bin (on your PATH via the Bun installer)
dtwin --version
```

`npm i -g @design-twin/dtwin` works too, but `dtwin` runs on Bun either way: without Bun on PATH it stops at
`env: bun: No such file or directory`.

Or with Homebrew (macOS, Linux), which installs Bun as a dependency:

```bash
brew install its-magdy/tap/dtwin
dtwin --version
```

Or from a clone (to work on the code):

```bash
git clone https://github.com/its-magdy/design-twin.git
cd design-twin
bun install
(cd bridge && bun link)   # puts `dtwin` in ~/.bun/bin (on your PATH via the Bun installer); no build step
dtwin --version
```

In a clone, if you skip `bun link`, use `bun --no-install --no-env-file /path/to/design-twin/bridge/src/figma-pull.ts` wherever this
README says `dtwin` — the two flags keep your project's `.env` out of the bridge and stop Bun fetching a missing package
from the registry (the linked `dtwin` gets them from its shebang, `#!/usr/bin/env -S bun …`, which needs an `env` with
`-S`: GNU coreutils ≥ 8.30 or macOS; on BusyBox/Alpine, run the `bun --no-install --no-env-file …` form instead).

How the Homebrew formula pins its dependencies, and the rest of the install notes, are in
[`bridge/README.md`](bridge/README.md#install-once).

### The Figma plugin

```bash
dtwin plugin install   # copies the plugin to a per-user folder that never moves, and prints its manifest path
```

Then, once, in Figma desktop: **Plugins → Development → Import plugin from manifest…** and pick that `manifest.json`
(`dtwin plugin path` prints it again; the folder is hidden, so on macOS press ⌘⇧G in the file picker and paste the
path). `dtwin init` does the install too. In a clone, import `design-twin/figma-plugin/manifest.json` directly instead.

`code.js` and `ui.html` are pre-built (committed in the repo, copied into the package), so there is nothing to build.

### The Claude Code plugin

```bash
claude plugin marketplace add its-magdy/design-twin
claude plugin install designtwin@designtwin-marketplace
```

From a local clone, use `claude plugin marketplace add /path/to/design-twin` instead. To try it for
one session without installing, run `claude --plugin-dir /path/to/design-twin/claude-plugin`.

Skills load under the `designtwin:` namespace. Run `/designtwin:help` to confirm the plugin is installed.

### Upgrading

```bash
bun add -g @design-twin/dtwin@latest   # or: brew upgrade dtwin
dtwin plugin status                    # confirms the plugin copy matches this dtwin
```

Then reopen the plugin in Figma, with hot reload on.

Upgrading the package updates the installed plugin copy in place the next time `dtwin` starts a bridge (or run
`dtwin plugin update`): with **Plugins → Development → Hot reload plugin** on, reopen the plugin and it runs the new
code — new manifest permissions included — with no re-import. (With hot reload off, Figma keeps running the code it
already loaded.) Re-import only if a new permission still does not work after that. The same goes for a clone after
`git pull`.

---

## Set up your project

Run these in the root of the app you are **building**, not in this repo.

### 1. Initialise

```bash
dtwin init            # add --mcp to also register the MCP server; --dry-run to preview
```

It creates:

```
design/
├── README.md        # explains which half of design/ is safe to delete
├── target.json      # detected stack profile (or null — build-screen asks on first run)
└── export/          # every pull lands here, and nowhere else
```

It also creates the bridge token if one doesn't exist, and it never overwrites an existing file.
With `--mcp`, it merges a `designtwin` server entry into `./.mcp.json` (it runs the server with the absolute path of the
`bun` that ran `dtwin init`, as `bun --no-install --no-env-file <package>/src/figma-mcp.ts` — `<package>` is the installed package, or `bridge/` in a clone). Enable it with `/mcp`, then
restart Claude Code.

### 2. Connect the Figma plugin

```bash
dtwin token show      # prints the per-user bridge token (~/.config/design-twin/bridge-token)
```

Open your Figma file and run **Plugins → Development → Design Twin**. Expand **Connect to Claude Code
(optional)**, paste the token into **Bridge token**, and press **Save**. You only have to do this once.

The plugin only reads until you tick **Allow edits** in its window. Tick it only when you want Claude to write to
the file through `figma_write`. The setting is per user, so untick it when you are done.

### 3. Check everything

```bash
dtwin doctor
```

`dtwin doctor` checks the token, the port, the daemon, the plugin connection and the project layout.
It changes nothing, and for each problem it prints the next step to take.

### 4. Map your code (recommended)

Without these files, Claude writes new components instead of reusing yours, and the drift check has
nothing to compare against:

| File | Maps | Written by |
|---|---|---|
| `design/codeconnect.local.json` | Figma component `key` → your component + import | Scaffolded by `/designtwin:build-screen` on first build; you confirm the stubs |
| `design/tokens.json` | Figma variable path → your token, e.g. `{ "color": { "color/primary": "colors.primary" } }` | You. Optional: variables with a `codeSyntax` in Figma need no entry |

---

## Usage

Keep the Figma file open with the Design Twin plugin running.

### 1. Find the screen

```bash
dtwin list                    # pages + top-level layers, with node ids
dtwin list children 12:34     # peek inside one frame or section
dtwin screenshot 12:34        # reference PNG of one node — look before you pull
```

### 2. Pull it

```bash
dtwin pull --node 12:34                                   # one screen (tree, variables, assets)
dtwin pull --node "https://www.figma.com/design/…?node-id=12-34"   # or paste a Figma link
dtwin pull --page 0:1                                     # one page
dtwin pull --design-system                                # tokens/styles/components only, no screens
```

Each pull writes to `design/export/` by default. To write somewhere else, pass a directory as the
first argument, for example `dtwin pull design/lib --node 12:34`.

### 3. Audit, build, verify, sync

In Claude Code:

```
/designtwin:audit-design <screen>   # pre-build review → design/audit/<screen>.md
/designtwin:build-screen <screen>   # build it in your stack, leaf components first
/designtwin:verify <screen>         # measure the rendered screen against the design → design/verify/
/designtwin:sync-design <screen>    # design changed? re-pull, diff by node id, patch only what moved
```

Plain-language requests work too, for example "is this design ready to build?" or "does this match the design?".

- **audit-design** checks token binding, the spacing grid, missing loading/empty/error states, touch
  targets, contrast, font scaling, theming, RTL, and effects that won't translate to your stack. It
  ends with a verdict and a list of questions for the designer, each with a default answer.
- **verify** renders the screen and compares every visible node's type, colour, radius, spacing, size
  and position with the design. The verdict is computed from `design/verify/<Layer>__<id>.report.json`, so
  a pass is never just asserted. Anything nobody probed is reported as `not-probed`, never as passed.
- **sync-design** keeps the hand edits you made after the build. Commit `design/` so a previous export exists to diff against.

### No terminal?

Skip the bridge entirely. In the Figma plugin, click **Export current selection** and save the
**Download …** links into `design/export/`, putting assets under `design/export/assets/`. The skills
work the same way on those files.

---

## Command reference

Every flag, the daemon, the token and the limits are in [`bridge/README.md`](bridge/README.md).

### `dtwin` CLI

| Command | Description |
|---|---|
| `dtwin init [--mcp] [--dry-run]` | Set up `design/` in the project you are building |
| `dtwin doctor [--wait N] [--json]` | Diagnose token, port, daemon, plugin, project |
| `dtwin list [pages\|libraries\|clients]` | Discover pages and layers, libraries in use, or connected files |
| `dtwin list children <id\|url>` | Direct children of one node |
| `dtwin screenshot <id\|url> [--scale N]` | PNG of one node → `design/export/assets/` |
| `dtwin pull [outDir] [flags]` | Export (see flags below) |
| `dtwin whoami` | Which Figma file/plugin is connected |
| `dtwin serve \| stop \| status` | Keep a background daemon connected so pulls skip the reconnect |
| `dtwin token [status\|show\|rotate\|forget]` | Manage the bridge token |
| `dtwin plugin [install\|update\|status\|path\|uninstall] [--open]` | The Figma plugin's per-user copy, imported once |
| `dtwin seed [codeRoot] [outDir] [--dry-run]` | `design/components.json` from your Code Connect files (offline) |
| `dtwin mcp` | Run the MCP server (what `.mcp.json` points at) |
| `dtwin --version` | Print the installed version |

Every command accepts `--help`. Unknown flags are rejected, not ignored.

### `dtwin pull` flags

| Flag | Exports |
|---|---|
| *(none)* | Design system + current page's frames + assets |
| `--node <id\|url>` | One node, fully (tree + assets) |
| `--page <id\|name>` | One page (repeatable) |
| `--selection` | The current Figma selection |
| `--all-pages` | Frames from every page |
| `--design-system` | Tokens, styles, components, hygiene report. No page walk |
| `--as-library <name>` | The full catalog of a **library** file (run it with the library file open) |
| `--client <fileKey\|name>` | Which file, when several are connected |
| `--timeout N` | Seconds to wait (default 300; 900 with `--all-pages`) |
| `--css` `--measurements` `--motion` `--variant-visuals` `--plugin-data` `--shared-data` | Opt-in extra reads |

### Claude Code skills

| Skill | Description |
|---|---|
| `/designtwin:help` | Orientation, setup, troubleshooting (port 8787, token/401, empty libraries…) |
| `/designtwin:extract` | Get a design onto disk: discover first, then scope the pull |
| `/designtwin:audit-design <screen>` | Pre-build implementation review |
| `/designtwin:build-screen <screen>` | Build the screen in your stack |
| `/designtwin:verify <screen>` | Rendered screen vs. design, per node |
| `/designtwin:sync-design <screen>` | Patch built code after a design change |

### MCP tools

Registered as `designtwin`, so tools appear as `mcp__designtwin__<tool>`:
`figma_status`, `figma_whoami`, `figma_list_clients`, `figma_list_pages`, `figma_list_children`,
`figma_list_libraries`, `figma_get_selection`, `figma_screenshot`, `figma_export_full`,
`figma_export_selection`, `figma_export_url`, `figma_export_design_system`, `figma_write`. Two more read the export
already on disk and need no Figma connection: `design_get_component` and `design_drift_lint`.

`figma_write` applies a small set of safe ops (create a frame or text, set a fill, set text) and runs no arbitrary
code. Pass `dryRun: true` to preview a batch. The plugin refuses every write until the user ticks **Allow edits**.

Pass `writeToDisk: true` to the export tools for anything large. It's also the only way to get asset
files through MCP. A running MCP server or `dtwin serve` daemon owns port `8787` and shares it with
later `dtwin` commands. If another program is using the port, set `FIGMA_BRIDGE_PORT` to `8788` or
`8789`.

---

## Where files land

`design/` has two halves:

- **`design/export/`** is written only by `dtwin` and the Figma plugin. You can delete it and pull again without losing anything.
  - `pages/<Page>/<Name>__<node-id>.json`: one file per screen. Beside each one sit a `.vars.json`
    with the variables it uses and a `.assets.json` with its assets.
  - `variables.json`: all variables from every screen pulled, merged by variable key.
  - `assets/`: icons and images, deduplicated by content, plus one reference PNG per frame.
  - `design-system/`: tokens, styles, local and library components, and the hygiene report.
  - `libraries/<slug>-<fileKey8>/`: output of `--as-library` pulls.
- **Everything else is yours.** This includes `target.json`, `tokens.json`,
  `codeconnect.local.json`, and the `plan/`, `audit/`, `verify/` and `changes/` directories. Skills
  write these, and they can't be regenerated. Commit them.

Projects set up before this split keep their export directly in `design/`. Everything still finds
it there, and `dtwin doctor` reports which layout it found.

---

## Running tests

Everything runs offline, without Figma:

```bash
bun install --frozen-lockfile
bun test/harness.ts              # Figma plugin extractor, against a mock `figma`
bun test/bridge.test.ts          # CLI + bridge
bun test/design-to-code.test.ts  # tokens, maps, drift-lint
```

Every other `test/*.test.ts` suite runs the same way.

- `bun run test` runs every suite in order (serially, output live) and ends with a summary — one row per suite, exit 1
  if any failed, no suite is skipped after a failure. `bun test/run-suites.ts <name>…` runs a subset.
- `bun run test:fast` skips four of the slow browser (probe e2e) suites — about 3 minutes instead of ~20 — and says so
  loudly at the end; CI's other matrix legs run them. Run `bun run test` before committing.
- A bare `bun test` is Bun's own test runner, pointed by `bunfig.toml` at `test/spawn-stress/` only.
- `DT_E2E_POOL=<n>` sets how many probes the browser suites run at once.

[`TESTING.md`](TESTING.md) lists each suite and the live-Figma checks (the run-suites summary is the authority for
check counts).

The plugin's `code.js` and `ui.html` and `claude-plugin/scripts/` are committed build output (the bridge has none: it
runs and ships as TypeScript). After editing their sources, rebuild them:

```bash
bun run build
```

That runs each workspace's own build — esbuild → `figma-plugin/code.js` and `figma-plugin/ui.html` for the plugin
(the bridge has nothing to build) — and then `bun claude-plugin/build-scripts.ts` to re-bundle
`claude-plugin/scripts/`.

CI fails if the committed build output doesn't match what the sources produce.

---

## Further reading

- [`ARCHITECTURE.md`](ARCHITECTURE.md): the plugin's two-context model, CLI vs MCP, and the security model
- [`bridge/README.md`](bridge/README.md): every CLI flag, the daemon, MCP tools, and limits
- [`figma-plugin/README.md`](figma-plugin/README.md): editing the extractor
- [`design-to-code/README.md`](design-to-code/README.md) and [`docs/design-to-code-spec.md`](docs/design-to-code-spec.md): the token pipeline, component map and drift-lint
- [`TESTING.md`](TESTING.md): test layers and expected counts

---

## License

[MIT](LICENSE) © Mohamed Magdy Omar
