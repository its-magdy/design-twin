# Installing and setting up Design Twin

The [README's 5-minute path](../README.md#first-screen-in-5-minutes) is the short version. This page has every
install route, what `dtwin init` does, the steps an agent can and can't run for you, and how to upgrade. Every flag,
the bridge token and the daemon are covered in [`bridge/README.md`](../bridge/README.md).

---

- [Prerequisites](#prerequisites)
- [Install the CLI](#install-the-cli)
- [Import the Figma plugin](#import-the-figma-plugin)
- [Install the Claude Code plugin](#install-the-claude-code-plugin)
- [Set up your project](#set-up-your-project)
- [Setting up as an agent](#setting-up-as-an-agent)
- [Upgrading](#upgrading)

---

## Prerequisites

- The **Figma desktop app**. A browser tab can't import a development plugin. Any plan works, including free.
- **[Bun](https://bun.sh/install) 1.4.2+** (CI runs 1.4.3, and the 1.4.2 floor on Linux). Everything here runs on Bun — the
  CLI, the MCP server, the plugin's scripts and hooks; Node is not supported. Install: `curl -fsSL https://bun.sh/install | bash`
  (macOS, Linux) or `powershell -c "irm bun.sh/install.ps1 | iex"` (Windows).
- **Claude Code**, for the skills.
- **git**, only if you install from a clone.

---

## Install the CLI

### With Bun

```bash
bun add -g @design-twin/dtwin   # puts `dtwin` in ~/.bun/bin (on your PATH via the Bun installer)
dtwin --version
```

`npm i -g @design-twin/dtwin` works too, but `dtwin` runs on Bun either way: without Bun on PATH it stops at
`env: bun: No such file or directory`.

### With Homebrew

Homebrew (macOS, Linux) installs Bun as a dependency:

```bash
brew install its-magdy/tap/dtwin
dtwin --version
```

How the formula pins its dependencies is in [`bridge/README.md`](../bridge/README.md#install-once).

### From a clone

To work on the code:

```bash
git clone https://github.com/its-magdy/design-twin.git
cd design-twin
bun install --frozen-lockfile
(cd bridge && bun link)   # puts `dtwin` in ~/.bun/bin (on your PATH via the Bun installer); no build step
dtwin --version
```

In a clone, if you skip `bun link`, use `bun --no-install --no-env-file /path/to/design-twin/bridge/src/figma-pull.ts`
wherever these docs say `dtwin` — the two flags keep your project's `.env` out of the bridge and stop Bun fetching a
missing package from the registry (the linked `dtwin` gets them from its shebang, `#!/usr/bin/env -S bun …`, which needs
an `env` with `-S`: GNU coreutils ≥ 8.30 or macOS; on BusyBox/Alpine, run the `bun --no-install --no-env-file …` form
instead).

---

## Import the Figma plugin

```bash
dtwin plugin install   # copies the plugin to a per-user folder that never moves, and prints its manifest path
```

Then, once, in Figma desktop: **Plugins → Development → Import plugin from manifest…** and pick that `manifest.json`
(`dtwin plugin path` prints it again; the folder is hidden, so on macOS press ⌘⇧G in the file picker and paste the
path). `dtwin init` does the install too. In a clone, import `design-twin/figma-plugin/manifest.json` directly instead.

`code.js` and `ui.html` are pre-built (committed in the repo, copied into the package), so there is nothing to build.

---

## Install the Claude Code plugin

```bash
claude plugin marketplace add its-magdy/design-twin
claude plugin install designtwin@designtwin-marketplace
```

From a local clone, use `claude plugin marketplace add /path/to/design-twin` instead. To try it for one session
without installing, run `claude --plugin-dir /path/to/design-twin/claude-plugin`.

Skills load under the `designtwin:` namespace. Run `/designtwin:help` to confirm the plugin is installed.

---

## Set up your project

Run these in the root of the app you are **building**, not in the Design Twin repo.

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
`bun` that ran `dtwin init`, as `bun --no-install --no-env-file <package>/src/figma-mcp.ts` — `<package>` is the
installed package, or `bridge/` in a clone). Restart Claude Code in the project folder and approve the `designtwin`
server when it asks; `/mcp` shows its status.

### 2. Connect the Figma plugin

```bash
dtwin token show      # prints the per-user bridge token (~/.config/design-twin/bridge-token)
```

Open your Figma file and run **Plugins → Development → Design Twin**. Expand **Connect to Claude Code
(optional)**, paste the token into **Bridge token**, and press **Save**. You only have to do this once.

The plugin only reads until you tick **Allow edits** in its window. Tick it only when you want Claude to write to
the file through `figma_write`. The setting is per user and covers every file, so untick it when you are done.

### 3. Check everything

```bash
dtwin doctor
```

`dtwin doctor` checks the token, the port, the daemon, the plugin connection and the project layout.
It changes nothing, and for each problem it prints the next step to take.

### 4. Map your code

Recommended. The two map files are described in the README's
[Map your code to the design](../README.md#map-your-code-to-the-design).

---

## Setting up as an agent

If you are an agent setting this up for a user, run these in the root of the project being **built**, one at a time.
Three steps are clicks in Figma that only the user can do, and restarting Claude Code is theirs too. Ask for them;
don't try to script them.

1. Check for the CLI: `dtwin --version`. If it prints a version, skip to step 3.
2. Install it. If `brew` is on PATH, run `brew install its-magdy/tap/dtwin` (it brings Bun). Otherwise check
   `bun --version`; if Bun is missing, ask the user to install it from [bun.sh/install](https://bun.sh/install), then
   run `bun add -g @design-twin/dtwin`.
3. Install the Claude Code plugin:
   ```bash
   claude plugin marketplace add its-magdy/design-twin
   claude plugin install designtwin@designtwin-marketplace
   ```
4. Set up the project:
   ```bash
   dtwin init --mcp          # design/, target.json, bridge token, plugin copy, .mcp.json entry
   dtwin plugin path         # the manifest.json the user imports into Figma
   dtwin token show          # the token the user pastes into the plugin
   ```
   `dtwin init` ends by printing the steps only the user can do. Relay them as written.

The user's part:

1. In Figma desktop: **Plugins → Development → Import plugin from manifest…** and pick the file `dtwin plugin path` printed (once).
2. In Figma desktop: run **Plugins → Development → Design Twin**. Open **Connect to Claude Code (optional)**, paste the token, and press **Save** (once).
3. Restart Claude Code in the project folder and approve the `designtwin` MCP server when it asks; `/mcp` shows its status.
4. Only before a `figma_write`: tick **Allow edits** in the plugin window. It is off by default, and nothing on the bridge or MCP side can turn it on.

Wait for the user to confirm, then check:

```bash
dtwin doctor --wait 60    # every check, with the next step for each failure
```

- Before the user's Figma steps, doctor's plugin check fails. That is expected.
- If Claude Code has already started the MCP server, doctor can't probe the plugin: the check is skipped and it
  tells you to call `figma_status`. Call `mcp__designtwin__figma_status` instead; a connected file there means it worked.
- On any other ✗, do its `next` line. If that doesn't clear it, run `/designtwin:help <symptom>`. Its
  troubleshooting reference matches each `dtwin doctor` failure to a fix.

Working on the Design Twin repo itself? The `designtwin` plugin isn't installed there, and `dtwin` is
`bun bridge/src/figma-pull.ts`. Read [`CLAUDE.md`](../CLAUDE.md) first.

---

## Upgrading

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
