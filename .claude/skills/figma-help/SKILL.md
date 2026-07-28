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
| **C. `figma-mcp` server** (write / interactive) | Push code→design, live tools | stdio MCP + persistent loopback WS; opt-in, **disabled by default** |

All three require the **Figma file open with the plugin running** — nothing is headless.
B and C share **port 8787**, so only one can run at a time.
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
   - **Export design system + all page frames** → produces `design-system.json` + `screens.json` (+ assets).
3. In the plugin's **Downloads** list, save every `Download <name>` link into `design/`, and click
   **Download assets (N)** → save into `design/assets/`.
4. Also export a **PNG** of the frame (Figma right-click → Export) → `design/<screen>.png`.
   The plugin doesn't emit PNGs itself; the screenshot is visual ground truth and the skill always reads it.
5. `/figma-to-code <screen>`.

## Path B — figma-pull CLI (automated read)
```
# repo root, Figma file open + plugin running:
node bridge/figma-pull.js design             # full: design-system.json + screens.json + assets/
node bridge/figma-pull.js design --selection # just the current selection
```
It prints `listening on ws://localhost:8787`, waits for the plugin to connect, writes files, and exits.
Then `/figma-to-code <screen>`. Allowlist it to skip the prompt: add
`"Bash(node bridge/figma-pull.js:*)"` to `.claude/settings.json` → `permissions.allow`.

## Path C — figma-mcp (write / interactive, opt-in)
The MCP is registered in `.mcp.json` but **disabled** in `.claude/settings.local.json`
(`disabledMcpjsonServers: ["figma"]`). To use it: run `/mcp` and enable **figma** (or remove it from
that array), then restart Claude Code. Pre-approve tools with `"mcp__figma__*"` in `permissions.allow`.
Tools: `figma_status`, `figma_get_selection`, `figma_export_full`, `figma_export_selection`,
`figma_write` (a small fixed set of safe ops — createFrame / createText / setFill / setText; **no
arbitrary code execution**). For code→design authoring, prefer the Figma MCP server's own
`/figma-generate-design` / `/figma-use` skills.

## Troubleshooting (match the symptom, give the fix)
- **Plugin isn't in the menu / changed manifest not picked up** → re-import via *Import plugin from
  manifest…*; it lives under **Plugins → Development**, not the main plugin list.
- **`EADDRINUSE` / bridge hangs on connect** → port 8787 is already held. Only one of figma-pull /
  figma-mcp can run at once — stop the other (and any stale `node` on 8787).
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

## Where the real docs live (point here, don't duplicate)
- `README.md` — the workflow, setup, per-screen loop, config-map shapes, why this shape.
- `ARCHITECTURE.md` — the verified two-plane design, plugin two-context model, full API surface, security.
- `bridge/README.md` — figma-pull + figma-mcp install, token, tools, limits.
- `.claude/skills/figma-to-code/SKILL.md` — how the agent actually builds a screen.
- `profiles/*.md` — per-stack IR→code translation rules.

## Related
- **Build a screen:** `/figma-to-code <screen>` (after files are in `design/`).
- **Build many screens:** the `figma-screen-builder` subagent isolates each screen's large JSON.
