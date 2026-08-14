---
name: figma-help
description: Orientation and help for THIS repo's free-plan Figma→code workflow. Invoke as /figma-help when the user asks how to use this tool, how to set it up, how to export a screen, which of the three paths (manual / figma-pull CLI / figma-mcp) to use, or when something isn't working (plugin won't import, port 8787 busy, bridge token, MCP not connecting, empty design/). Explains the workflow and routes to the right doc; it does NOT itself build a screen — that's /figma-to-code.
---

# Using this tool (free-plan Figma → code)

This repo feeds a Figma design to Claude Code **on a free Figma plan, with zero network egress**.
A self-authored plugin (`allowedDomains: ["none"]`) extracts the design as stack-neutral JSON + real
assets; the `/figma-to-code` skill turns that into code for any stack.

Your job when this skill is invoked: figure out **what the user is trying to do**, give the exact
steps, and hand off. Don't dump everything — route.

## First, orient the user: there are three ways to move a design → `design/`

| Path | When to use | What runs |
|------|-------------|-----------|
| **A. Manual export** (default, zero setup) | One screen, or first time | Plugin UI buttons → download files into `design/` by hand |
| **B. `figma-pull` CLI** (read, automated) | Bulk / repeated pulls | `node bridge/figma-pull.js` hosts a loopback WS; plugin auto-connects and pushes; CLI writes files and exits |
| **B+. `figma-pull --serve`** (daemon) | Many pulls in a row | Same CLI, but the bridge stays open until `--stop`; later invocations route through it and skip the plugin reconnect |
| **C. `figma-mcp` server** (write / interactive) | "Check this, now pull that" + code→design | stdio MCP + persistent loopback WS; opt-in, **disabled by default** |

All of them require the **Figma file open with the plugin running** — nothing is headless.

**B, B+ and C all bind port 8787, so exactly one can run at a time.** This is the single most common
confusion: whichever starts second exits with `EADDRINUSE`. Consequences worth stating up front:
- While the **MCP server** is running, `figma-pull` cannot run. Use `writeToDisk: true` on the MCP
  export tools instead — that is the MCP path's way to get files (and the **only** way to get asset
  bytes, which are never returned inline).
- While a **daemon** (`--serve`) is running, ordinary `figma-pull` commands work normally — they
  detect it and route through it. Nothing to change in how you invoke them.
- To run two bridges deliberately, set `FIGMA_BRIDGE_PORT` on one of them.
Once files are in `design/`, building code is identical for all three: **`/figma-to-code <screen>`**.

## One-time setup (do once per machine)
1. **Import the plugin.** Figma desktop → **Plugins → Development → Import plugin from manifest…** →
   pick `figma-plugin/manifest.json`.
2. **(Optional) config maps** so the agent reuses your components/tokens instead of regenerating:
   - `design/target.json` — which stack (auto-detected if absent).
   - `design/tokens.json` — Figma variable → your code token (styling source of truth).
   - `design/components.json` — Figma component → your code component + import (reuse source of truth).
     **Auto-seed it** from Code Connect files in the repo: `node bridge/seed-components.js` (scans
     `*.figma.tsx` / `figma.connect(...)` / `@FigmaConnect`, fills `component`/`source`/`nodeId`; you add
     `import`/`props`). Export `design-system.json` first so node-ids resolve to real component names.
   Shapes are in the root `README.md` "One-time setup".
3. **(Only for paths B/C)** `cd bridge && npm install`, then set a stable bridge token:
   `export FIGMA_BRIDGE_TOKEN="$(openssl rand -hex 24)"` (add to your shell profile) and paste it into
   the plugin's **Bridge token** field once. See `bridge/README.md`.

## Path A — manual export (recommended default)
1. In Figma, select the frame → **Plugins → Development → Design Export for AI**.
2. Click one of:
   - **Export current selection** → produces `<screen>.json` + `variables.json` (+ assets).
   - **Export design system + all page frames** → produces `design-system.json` + `pages/index.json`
     (+ assets); click **Download layers (N)** to save one file per top-level layer, grouped per Figma
     page, into `design/pages/<page>/`.
3. In the plugin's **Downloads** list, save every `Download <name>` link into `design/`, and click
   **Download assets (N)** → save into `design/assets/`.
4. Also export a **PNG** of the frame (Figma right-click → Export) → `design/<screen>.png`.
   The plugin doesn't emit PNGs itself; the screenshot is visual ground truth and the skill always reads it.
5. `/figma-to-code <screen>`.

## Path B — figma-pull CLI (automated read)
```
# repo root, Figma file open + plugin running:
node bridge/figma-pull.js design             # full: design-system.json + pages/<page>/ (one file per layer) + assets/
node bridge/figma-pull.js design --selection # just the current selection
node bridge/figma-pull.js --list-pages       # cheap: page names only (prints to stdout, writes nothing)
node bridge/figma-pull.js --list             # cheap: pages + their top-level frames
node bridge/figma-pull.js --children <id>    # cheap: one node's direct children (peek before a full pull)
node bridge/figma-pull.js design --page <id> # deep-pull one or more named pages (repeatable --page)
```
The three cheap commands print structural fields only (id/name/type/size), so they take **no read
options** — `--css` / `--measurements` / `--plugin-data` / `--motion` / `--shared-data` / `--no-assets`
are refused there rather than silently ignored. Pass those to the `--page` pull instead. `--timeout`
does apply to them.
It prints `listening on ws://localhost:8787`, waits for the plugin to connect, writes files, and exits.
Then `/figma-to-code <screen>`. Allowlist it to skip the prompt: add
`"Bash(node bridge/figma-pull.js:*)"` to `.claude/settings.json` → `permissions.allow`.

## Path B+ — keep the connection open (daemon)
Every one-shot run above waits for the plugin to reconnect. For a run of several pulls, hold the
bridge open instead:
```
node bridge/figma-pull.js --serve          # holds it open until stopped (Ctrl-C also stops it)
node bridge/figma-pull.js --daemon-status  # is one up, and is the plugin connected?
node bridge/figma-pull.js --stop
```
Every ordinary command then **routes through it automatically** — same invocations, no reconnect, and
no `EADDRINUSE` from a second bridge. `--serve` / `--stop` / `--daemon-status` each own the whole
invocation: combining one with a pull or a read option is refused rather than silently dropping the
export you typed.

If `--serve` says *"a figma-pull daemon is already running"*, one is up — use `--stop`. A socket file
left behind by a crash is detected and cleaned up automatically, not treated as a live daemon.

The daemon **shuts itself down after 120 min idle** (`FIGMA_DAEMON_IDLE_MIN`, `0` disables) so an
abandoned one can't hold port 8787 forever. The clock resets on every request and an in-flight export
holds it off, so a long `--all-pages` pull is never cut short.

## Path C — figma-mcp (write / interactive, opt-in)
The MCP is registered in `.mcp.json` but **disabled** in `.claude/settings.local.json`
(`disabledMcpjsonServers: ["figma"]`). To use it: run `/mcp` and enable **figma** (or remove it from
that array), then restart Claude Code. Pre-approve tools with `"mcp__figma__*"` in `permissions.allow`.
Tools: `figma_status`, `figma_get_selection`, `figma_list_pages`, `figma_list_children`,
`figma_export_full`, `figma_export_selection`, `figma_export_url`,
`figma_write` (a small fixed set of safe ops — createFrame / createText / setFill / setText; **no
arbitrary code execution**). Call `figma_list_pages` FIRST — it is the cheap index (pages + top-level
frames, no recursion, no assets) you use to pick a target for `figma_export_full({page:[id]})`, instead
of exporting the whole file into context. For code→design authoring, prefer the Figma MCP server's own
`/figma-generate-design` / `/figma-use` skills.

**Pass `writeToDisk: true` for anything past a quick look.** Every export tool takes it (plus an
optional `outDir`). It writes through the same writer the CLI uses and returns a compact index —
counts and file paths — which you then Read/Grep at your own granularity. Two reasons it is not
optional in practice: asset bytes are **never** returned inline, so this is the only way to get
`assets/` from the MCP path; and inline results are capped (25k tokens by default,
`MAX_MCP_OUTPUT_TOKENS`), so a real page export is silently truncated without it.

`outDir` resolves against **the directory the MCP server was started in** — i.e. the project you are
building, not this repo. Default: `FIGMA_EXPORT_DIR`, else `design/`.

To use the bridge from another project, add a `.mcp.json` there pointing at an **absolute** path to
`bridge/figma-mcp.mjs`, and put `figma` in `enabledMcpjsonServers` (not `disabled…`) in that project's
`.claude/settings.local.json`, with the same `FIGMA_BRIDGE_TOKEN`.

## Troubleshooting (match the symptom, give the fix)
- **Plugin isn't in the menu / changed manifest not picked up** → re-import via *Import plugin from
  manifest…*; it lives under **Plugins → Development**, not the main plugin list.
- **`EADDRINUSE` / bridge hangs on connect** → port 8787 is already held. Only one of figma-pull /
  `--serve` daemon / figma-mcp can run at once. Check with `node bridge/figma-pull.js --daemon-status`
  first: if a daemon is up, ordinary CLI commands route through it automatically and you don't need to
  stop anything — this error means something *else* holds the port (usually the MCP server, or a
  stale `node`). If the MCP is the holder and you wanted files, use `writeToDisk: true` rather than
  killing it.
- **MCP is running and I need `assets/`** → asset bytes are never returned inline, and the CLI can't
  run alongside the MCP. Re-run the export with `writeToDisk: true`.
- **`--serve` says a daemon is already running** → one is up; `--stop` it. A socket file left by a
  crashed daemon is *not* treated as live — it's detected and replaced automatically.
- **Bridge stays "offline" in the plugin** → two causes: (a) no token pasted — the plugin shows
  `offline — paste the bridge token above` and won't even dial until you paste + Save the token; or
  (b) no server yet — the plugin UI is a WS *client* and only connects once figma-pull or the MCP is
  running. Fix the token first, start a server, and it auto-connects (retries every 3s).
- **Changed the port?** Don't — the plugin is pinned to `ws://localhost:8787` (manifest + `ui.html`).
  `FIGMA_BRIDGE_PORT` only moves the *server*, which the plugin then can't reach. Free 8787 instead.
- **Connection rejected / 401** → bridge token mismatch. The token the bridge prints (or your
  `FIGMA_BRIDGE_TOKEN`) must equal what's pasted in the plugin's **Bridge token** field. Re-paste + Save.
- **MCP `figma` not showing up** → it's disabled by default (see Path C); enable via `/mcp`, restart.
- **`design/` is empty / `/figma-to-code` can't find files** → nothing exported yet. `design/` is a
  generated drop-target and does not exist until an export runs. Do Path A/B first.
- **Async / `figma.mixed` errors while editing the plugin** → manifest uses `documentAccess:
  "dynamic-page"`, so all reads are async (`get…Async`) and mixed-value props must be guarded. See
  `ARCHITECTURE.md` "Verified mechanism details".
- **Wrong stack generated** → set `design/target.json`, or add a profile under `profiles/` (copy
  `profiles/_template.md`).
- **`stale-snapshot` / `unknown-freshness` from drift-lint** → the export in `design/` is older than
  24h (or carries no `exportedAt` stamp), so any "clean" result is against the snapshot, not the live
  file. Fix by re-running Path A/B. Threshold is tunable: `--max-age <hours>` or `DRIFT_MAX_AGE_HOURS`.
  Optional live check: set `FIGMA_TOKEN` + `FIGMA_FILE_KEY` and drift-lint compares the free REST
  `/meta` `lastModified` against the stamp — strictly opt-in, skipped silently when unset. The MCP
  `figma_status` tool also reports snapshot age.
- **Icons missing / lots of asset warnings** → expected warnings now aggregate by kind (one line with
  example nodes, not one per node). Vector nodes with no visible fill/stroke are skipped silently
  (`assetsSkippedInvisible`), and export failures fall back to a `geometry` field the codegen renders
  as inline SVG. A node that appears with neither `asset` nor `geometry` is a genuine failure — report it.

## Where the real docs live (point here, don't duplicate)
- `README.md` — the workflow, setup, per-screen loop, config-map shapes, why this shape.
- `ARCHITECTURE.md` — the verified two-plane design, plugin two-context model, full API surface, security.
- `bridge/README.md` — figma-pull + figma-mcp install, token, tools, limits.
- `.claude/skills/figma-to-code/SKILL.md` — how the agent actually builds a screen.
- `profiles/*.md` — per-stack IR→code translation rules.

## Related
- **Build a screen:** `/figma-to-code <screen>` (after files are in `design/`).
- **Build many screens:** the `figma-screen-builder` subagent isolates each screen's large JSON.
