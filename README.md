<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/wordmark-dark.svg">
    <img alt="Design Twin" src="assets/wordmark-light.svg" height="72">
  </picture>
</h1>

> Figma → code with Claude Code, on the **free** Figma plan, with nothing leaving your machine.

Design Twin reads a Figma screen through a local plugin and has Claude Code build it in your stack, with your own
components and tokens, then checks the result against the design.

<!-- demo.gif goes here -->
<!-- TODO(owner): record a ~15 s demo (pull a frame → /designtwin:build-screen → verify report) and embed it here. -->

[![test](https://github.com/its-magdy/design-twin/actions/workflows/test.yml/badge.svg)](https://github.com/its-magdy/design-twin/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

- [First screen in 5 minutes](#first-screen-in-5-minutes)
- [Why Design Twin?](#why-design-twin)
- [Known limitations & platform support](#known-limitations--platform-support)
- [How it works](#how-it-works)
- [Usage](#usage)
- [Command reference](#command-reference)
- [Where files land](#where-files-land)
- [Contributing and tests](#contributing-and-tests)
- [Further reading](#further-reading)
- [License](#license)

---

## First screen in 5 minutes

> **Setting this up as an agent?** Follow [docs/setup.md → Setting up as an agent](docs/setup.md#setting-up-as-an-agent):
> which commands you can run, and which Figma clicks only the user can do.

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
3. Set up the project. This creates `design/` (with your detected stack in `design/target.json`), the bridge token
   (a local secret, so only your Figma plugin can talk to `dtwin`), the Figma plugin's copy, and an `.mcp.json` entry
   for the Design Twin MCP server, which lets Claude call Figma as live tools. Then restart Claude Code in this
   folder and approve the `designtwin` server when it asks (or enable it under `/mcp`).
   ```bash
   dtwin init --mcp
   ```
4. Import the Figma plugin, once: in Figma desktop, **Plugins → Development → Import plugin from manifest…**, and
   pick the file this prints. The folder is hidden: on macOS press ⌘⇧G in the file picker and paste the path; on Windows paste it into the
   file picker's **File name** box.
   ```bash
   dtwin plugin path
   ```
5. Connect the plugin, once: run **Plugins → Development → Design Twin — Design Export for AI**, open **Connect to
   Claude Code (optional)**, paste the token this prints, and press **Save**.
   ```bash
   dtwin token show
   ```
6. In Claude Code, pull the screen. Copy the frame's link in Figma (right-click it → **Copy/Paste as → Copy link to
   selection**; the label varies between Figma versions), and keep the file open with the plugin running.
   ```
   /designtwin:extract <Figma frame link>
   ```
7. Build it.
   ```
   /designtwin:build-screen <Figma frame link>
   ```

Something not working? `dtwin doctor` checks every piece and prints the next step for each failure (while Claude
Code's MCP server holds the port, it skips the plugin check and asks you to call `figma_status` instead), and
`/designtwin:help` covers the rest. To check a web build against the design afterwards, `/designtwin:verify` needs
your dev server running and Playwright in the project (it asks before installing anything).

Other install routes (npm, a clone), what `dtwin init` writes, the steps an agent can run for you, and
upgrading are in [`docs/setup.md`](docs/setup.md).

---

## Why Design Twin?

Figma's own MCP server and Dev Mode are gated by your Figma plan and seat. Most other design-to-code tools read
through Figma's REST API, which has monthly limits. Design Twin reads through the **Figma Plugin API** instead: a
plugin in your own Figma desktop app, on your machine.

| | Design Twin | Figma's MCP server / Dev Mode | Typical design-to-code tools |
|---|---|---|---|
| **Figma plan** | Any, including free. No Dev seat, no documented request quota | Paid Dev or Full seat; otherwise 20 tool calls a month | REST reads: up to 20 a month on View and Collab seats, 6 for a Starter-plan file |
| **Where your design goes** | Your coding agent only. The plugin can reach `localhost` and nothing else | Figma's hosted server (recommended setup) | Often a hosted service |
| **Your components and tokens** | Component and token maps on any plan, checked against the live catalog | Code Connect: paid Dev or Full seat | Varies |
| **Checking the build** | Measured node by node (web); the verdict comes from the report | Left to the agent | Varies |
| **Target stacks** | Web, React Native, SwiftUI, Jetpack Compose, Flutter, or your own | Any, through the agent | Varies |

Figma's figures were checked against
[developers.figma.com](https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/) on 2026-11-01. Figma
changes them often, and its own pages don't always agree.

<details>
<summary>Figma's limits and how Design Twin differs, in detail</summary>

- **MCP server.** The desktop server needs a Dev or Full seat on a Professional, Organization or Enterprise plan (or
  Education or Government). On the Starter plan, and for View and Collab seats on any plan, it allows 20 tool calls a
  month. The recommended remote server runs on Figma's hosted endpoint.
- **REST API.** View and Collab seats get up to 20 file reads a month. Figma's own example is up to 6 a month for a
  file on the Starter plan. Variables over REST are Enterprise-only.
- **Code Connect.** Needs a Dev or Full seat on the Professional, Organization or Enterprise plan.
- **Plugin API.** No documented request quota, and it reads variables on every plan.

On the Design Twin side: the plugin's manifest allows only `ws://localhost:8787`–`8789`, and Design Twin needs no
Figma API key. `design/codeconnect.local.json` maps Figma components to yours and `design/tokens.json` maps variables
to your tokens; build-screen reads both, and drift-lint checks the component map against the live Figma catalog.
`verify` computes its verdict from what it measured, and any node left unmeasured blocks a pass.

</details>

---

## Known limitations & platform support

- **Your coding agent sees the design.** Nothing goes to Figma's servers or to us, but what Claude Code reads from
  `design/export/` goes to its model, like any file in your project.
- **Figma desktop only, and nothing is headless.** Every pull needs the file open in Figma desktop with the plugin
  running. The plugin is not on Figma Community, by design: you import it once as a development plugin.
- **Bun is required.** The CLI, the MCP server and the Claude Code plugin's scripts run on Bun 1.4.2 or later. Node
  alone won't run them.
- **Writes are deliberately small.** `figma_write` creates a frame or text, sets a fill or sets text, and only after
  you tick **Allow edits** in the plugin window.
- **Build checks vary by stack.** Web builds are measured node by node in Chromium. Native builds are rendered with
  the stack's own tools and compared as images. The generated Swift, Kotlin and Dart token files are not compiled in CI.

| OS | Status |
|---|---|
| **macOS** | Tested with a live Figma file, and in CI (the quick suites, on macOS 15). |
| **Windows** | CI runs the quick suites, including the `dtwin serve` daemon. Live Figma runs so far have been on macOS. The Claude Code plugin's start-up check needs `sh` (for example from Git Bash); without it you get one harmless hook error. |
| **Linux** | CI runs every suite, including the browser verify tests. Figma has no official Linux desktop app (unofficial builds exist, untested), and the plugin only reaches `localhost`, so live pulls need Figma desktop on the same machine: a Mac or Windows PC. The skills also work on a manual export copied over from one. |

More detail on these, and what else is good to know day to day, is under [Good to know](#good-to-know).

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

## Usage

Keep the Figma file open with the Design Twin plugin running.

### Find the screen

```bash
dtwin list                    # pages + top-level layers, with node ids
dtwin list children 12:34     # peek inside one frame or section
dtwin screenshot 12:34        # reference PNG of one node — look before you pull
```

### Pull it

```bash
dtwin pull --node 12:34                                   # one screen (tree, variables, assets)
dtwin pull --node "https://www.figma.com/design/…?node-id=12-34"   # or paste a Figma link
dtwin pull --page 0:1                                     # one page
dtwin pull --design-system                                # tokens/styles/components only, no screens
```

Each pull writes to `design/export/` by default. To write somewhere else, pass a directory as the
first argument, for example `dtwin pull design/lib --node 12:34`.

### Audit, build, verify, sync

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
  a pass is never just asserted. A node left unmeasured blocks a pass, and a designed interaction nobody drove is
  reported as `not-probed`, never as passed.
- **sync-design** keeps the hand edits you made after the build. Commit `design/` so a previous export exists to diff against.

### Map your code to the design

Recommended. Without these files, Claude writes new components instead of reusing yours, and the drift check has
nothing to compare against:

| File | Maps | Written by |
|---|---|---|
| `design/codeconnect.local.json` | Figma component `key` → your component + import | Scaffolded by `/designtwin:build-screen` on first build; you confirm the stubs |
| `design/tokens.json` | Figma variable path → your token, e.g. `{ "color": { "color/primary": "colors.primary" } }` | You. Optional: variables with a `codeSyntax` in Figma need no entry |

### No terminal?

Skip the bridge entirely. In the Figma plugin, click **Export current selection** and save the
**Download …** links into `design/export/`, putting assets under `design/export/assets/`. The skills
work the same way on those files.

### Good to know

- **One bridge, one port.** The MCP server or a `dtwin serve` daemon holds port `8787` and shares it with later
  `dtwin` commands. A plain one-shot `dtwin pull` does not share: a second pull started while it runs exits with
  `EADDRINUSE`. If another program is using the port, set `FIGMA_BRIDGE_PORT` to `8788` or `8789`.
- **Several Figma files open?** With more than one connected, every command needs `--client` to say which.
  `dtwin list clients` lists them.
- **Big files are slow.** A whole-file pull of a large file can take many minutes (the default budget is 300 s, and
  900 s with `--all-pages`), so pull one screen or page at a time.
- **Allow edits** is off by default and nothing on the bridge or MCP side can turn it on. Once ticked, it stays on for
  every file until you untick it. `figma_write` runs no arbitrary code.
- **Windows details.** The `dtwin serve` daemon runs over a named pipe with a token handshake there
  ([#61](https://github.com/its-magdy/design-twin/pull/61), closing [#12](https://github.com/its-magdy/design-twin/issues/12)).
  A few raw-socket daemon checks are POSIX-only and skipped on Windows CI.
- **The skills need Claude Code.** The `dtwin` CLI and the MCP server (a standard stdio MCP server) work without it.
- **Bun details.** Two of the Claude Code plugin's three hooks run on Bun, and the start-up check is a small `sh`
  script. Node alone won't run `dtwin`, even when installed with `npm`.
- **drift-lint and Figma's REST API.** drift-lint calls it for file metadata only if you set `FIGMA_FILE_KEY` and
  `FIGMA_TOKEN`.
- **Native stacks.** `verify` has no node-by-node probe there: the agent renders the screen with the stack's own tools
  (simulator, emulator, Flutter golden tests, which you set up) and compares images. Swift token output was
  type-checked with `swiftc` when the emitter was written; Kotlin and Dart never have been.

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
files through MCP.

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

Projects set up before `design/export/` existed keep their export directly in `design/`. Everything still finds
it there, and `dtwin doctor` reports which layout it found.

---

## Contributing and tests

Everything runs offline, without Figma:

```bash
bun install --frozen-lockfile
bun run test         # every suite, in order, with a summary
bun run test:fast    # skips the slow browser e2e suites: about 3 minutes instead of ~20
```

Working on this repo itself (human or agent)? The `designtwin` Claude Code plugin isn't installed here, and `dtwin`
is `bun bridge/src/figma-pull.ts`; read [`CLAUDE.md`](CLAUDE.md) first.

[`CONTRIBUTING.md`](CONTRIBUTING.md) covers setup, running single suites, rebuilding the committed build output, and
the rules CI enforces. [`TESTING.md`](TESTING.md) lists each suite and the live-Figma checks.

---

## Further reading

- [`docs/setup.md`](docs/setup.md): every install route, project setup, the agent setup steps, and upgrading
- [`ARCHITECTURE.md`](ARCHITECTURE.md): the plugin's two-context model, CLI vs MCP, and the security model
- [`bridge/README.md`](bridge/README.md): every CLI flag, the daemon, MCP tools, and limits
- [`figma-plugin/README.md`](figma-plugin/README.md): editing the extractor
- [`design-to-code/README.md`](design-to-code/README.md) and [`docs/design-to-code-spec.md`](docs/design-to-code-spec.md): the token pipeline, component map and drift-lint
- [`TESTING.md`](TESTING.md): test layers and expected counts

---

## License

[MIT](LICENSE) © Mohamed Magdy Omar
