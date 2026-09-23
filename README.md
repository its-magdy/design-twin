# Design Twin

> Figma → code with Claude Code, on the **free** Figma plan, with nothing leaving your machine.

Design Twin exports a Figma design through the **Figma Plugin API** (not the REST API or a paid Dev
Mode seat). The design, its variables and its assets are written to your project's `design/export/`
as stack-neutral JSON. Claude Code skills then review the design, build it in your stack reusing your
components and tokens, check the result against the design, and re-sync the code when the design
changes. The Figma plugin can only reach `ws://localhost`, so it cannot phone home.

[![test](https://github.com/its-magdy/design-twin/actions/workflows/test.yml/badge.svg)](https://github.com/its-magdy/design-twin/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

- [How it works](#how-it-works)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Set up your project](#set-up-your-project)
- [Usage](#usage)
- [Command reference](#command-reference)
- [Where files land](#where-files-land)
- [Running tests](#running-tests)
- [Further reading](#further-reading)
- [License](#license)

---

## How it works

The repo ships **three products**, installed separately:

| Piece | What it is | How you install it |
|---|---|---|
| `figma-plugin/` | The Figma-side extractor. Reads the open file and exports JSON, variables, and SVG/PNG assets. | Imported into Figma desktop from its manifest |
| `bridge/` | The `dtwin` CLI and the MCP server. Both talk to the Figma plugin over a localhost WebSocket (port `8787`). | `npm install` + `npm link` from a clone (not on npm yet) |
| `claude-plugin/` | The `designtwin` Claude Code plugin: skills, stack profiles and agents. It has no dependencies. | `claude plugin install` |

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

## Prerequisites

- The **Figma desktop app**. A browser tab can't import a development plugin. Any plan works, including free.
- **Node.js 18+** (CI runs on 20).
- **Claude Code**, for the skills.
- **git**, to clone this repo.

---

## Installation

### 1. Clone and install the CLI

```bash
git clone https://github.com/its-magdy/design-twin.git
cd design-twin/bridge
npm install
npm link          # puts `dtwin` on your PATH
dtwin --version
```

If you skip `npm link`, use `node /path/to/design-twin/bridge/figma-pull.js` wherever this README says `dtwin`.

### 2. Import the Figma plugin

In Figma desktop, go to **Plugins → Development → Import plugin from manifest…** and pick
`design-twin/figma-plugin/manifest.json`.

`code.js` is committed pre-built, so there is nothing to build. After pulling a new version of this
repo, import the manifest again, or new permissions (such as library reads) quietly return nothing.

### 3. Install the Claude Code plugin

```bash
claude plugin marketplace add its-magdy/design-twin
claude plugin install designtwin@designtwin-marketplace
```

From a local clone, use `claude plugin marketplace add /path/to/design-twin` instead. To try it for
one session without installing, run `claude --plugin-dir /path/to/design-twin/claude-plugin`.

Skills load under the `designtwin:` namespace. Run `/designtwin:help` to confirm the plugin is installed.

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
With `--mcp`, it merges a `designtwin` server entry into `./.mcp.json`. Enable it with `/mcp`, then
restart Claude Code.

### 2. Connect the Figma plugin

```bash
dtwin token show      # prints the per-user bridge token (~/.config/design-twin/bridge-token)
```

Open your Figma file and run **Plugins → Development → Design Twin**. Paste the token into the
plugin's **Bridge token** field. You only have to do this once.

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
  and position with the design. The verdict is computed from `design/verify/<Screen>.report.json`, so
  a pass is never just asserted. Anything nobody probed is reported as `not-probed`, never as passed.
- **sync-design** keeps the hand edits you made after the build. Commit `design/` so a previous export exists to diff against.

### No terminal?

Skip the bridge entirely. In the Figma plugin, click **Export current selection** and save the
**Download …** links into `design/export/`, putting assets under `design/export/assets/`. The skills
work the same way on those files.

---

## Command reference

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
| `dtwin mcp` | Run the MCP server (what `.mcp.json` points at) |

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
`figma_export_selection`, `figma_export_url`, `figma_export_design_system`, `figma_write`.

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
  `codeconnect.local.json`, and the `plan/`, `audit/`, `verify/` and `sync/` directories. Skills
  write these, and they can't be regenerated. Commit them.

Projects set up before this split keep their export directly in `design/`. Everything still finds
it there, and `dtwin doctor` reports which layout it found.

---

## Running tests

Everything runs offline, without Figma:

```bash
npm ci --prefix bridge && npm ci --prefix figma-plugin
node test/harness.js              # Figma plugin extractor, against a mock `figma`
node test/bridge.test.js          # CLI + bridge
node test/design-to-code.test.js  # tokens, maps, drift-lint
```

Every other `test/*.test.js` suite runs the same way. `TESTING.md` lists each suite, its expected
count, and the live-Figma checks. The plugin's `code.js`, `bridge/figma-mcp.mjs` and
`claude-plugin/scripts/` are committed build output. After editing their sources, rebuild them:

```bash
npm run build --prefix figma-plugin
npm run build --prefix bridge
node claude-plugin/build-scripts.js
```

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
