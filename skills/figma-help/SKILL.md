---
name: figma-help
description: Orientation and help for THIS repo's free-plan Figma→code workflow. Invoke as /figma-help when the user asks how to use this tool, how to set it up, how to export a screen, which of the three paths (manual / figma-pull CLI / figma-mcp) to use, or when something isn't working (plugin won't import, port 8787 busy, bridge token, MCP not connecting, empty design/). Explains the workflow and routes to the right doc; it does NOT itself build a screen — that's /figma-to-code.
disable-model-invocation: true
---

# Using this tool (free-plan Figma → code)

This repo feeds a Figma design to Claude Code **on a free Figma plan, with zero network egress**.
A self-authored plugin (`allowedDomains: ["none"]`) extracts the design as stack-neutral JSON + real
assets; the `/figma-to-code` skill turns that into code for any stack.

**Your job when this skill is invoked: figure out what the user is trying to do, give them the exact
next step, and point at the one doc that covers it. Route — do not re-explain what the docs already say.**

## Where the real docs live — send the user here rather than paraphrasing

| Doc | Covers |
|-----|--------|
| `README.md` | The workflow, one-time setup, per-screen loop, config-map shapes, why this shape, plugin packaging |
| `bridge/README.md` | **The full CLI + MCP surface** — install, token, every `figma-pull` flag, `--list-clients`/`--whoami`/`--list-libraries`/`--as-library`, the `--serve` daemon, MCP tools, `writeToDisk`, limits |
| `ARCHITECTURE.md` | The two-plane design, plugin two-context model, full API surface, security |
| `figma-plugin/README.md` | The Figma-side plugin: import, UI buttons, what each export produces |
| `skills/figma-to-code/SKILL.md` | How the agent actually builds a screen (+ its `references/`, `profiles/`) |

## Step 1 — which of the three paths?

| Path | When to use | What runs |
|------|-------------|-----------|
| **A. Manual export** (default, zero setup) | One screen, or first time | Plugin UI buttons → download files into `design/` by hand |
| **B. `figma-pull` CLI** (read, automated) | Bulk / repeated pulls | `node bridge/figma-pull.js` hosts a loopback WS; plugin auto-connects and pushes; CLI writes files and exits |
| **B+. `figma-pull --serve`** (daemon) | Many pulls in a row | Same CLI, but the bridge stays open until `--stop`; later invocations route through it |
| **C. `figma-mcp` server** (write / interactive) | "Check this, now pull that" + code→design | stdio MCP + persistent loopback WS; opt-in, **disabled by default** |

All of them require the **Figma file open with the plugin running** — nothing is headless.
Once files are in `design/`, building code is identical for all three: **`/figma-to-code <screen>`**.

**The one thing to say up front: B, B+ and C all bind port 8787, so exactly one can run at a time.**
Whichever starts second exits with `EADDRINUSE`.
- While the **MCP server** runs, `figma-pull` cannot. Use `writeToDisk: true` on the MCP export tools
  instead — that is the MCP path's way to get files, and the **only** way to get asset bytes.
- While a **daemon** (`--serve`) runs, ordinary `figma-pull` commands work normally — they detect it
  and route through it. Nothing changes in how you invoke them.
- To run two bridges deliberately, set `FIGMA_BRIDGE_PORT` on one.

## Step 2 — one-time setup (once per machine)

1. **Import the plugin.** Figma desktop → **Plugins → Development → Import plugin from manifest…** →
   pick `figma-plugin/manifest.json`.
2. **(Optional) config maps** so the agent reuses your components/tokens instead of regenerating —
   `design/target.json` (stack, auto-detected if absent), `design/tokens.json` (Figma variable → your
   code token), `design/components.json` (Figma component → your code component + import). Shapes are
   in `README.md` → "One-time setup". Auto-seed the last one from Code Connect files:
   `node bridge/seed-components.js`.
3. **(Only for paths B/C)** `cd bridge && npm install`, then set a stable bridge token —
   `export FIGMA_BRIDGE_TOKEN="$(openssl rand -hex 24)"` in your shell profile — and paste it into the
   plugin's **Bridge token** field once. Details: `bridge/README.md` → "Bridge token".

## Step 3 — run the path

**Path A (manual).** Select the frame in Figma → **Plugins → Development → Design Export for AI** →
either **Export current selection** or **Export design system + all page frames**, then save every
`Download <name>` link into `design/` and **Download assets (N)** into `design/assets/`. Also export a
**PNG** of the frame (Figma right-click → Export) into `design/<screen>.png` — the plugin doesn't emit
PNGs and the skill always reads it. Button-by-button detail and the flat `__` download naming:
`figma-plugin/README.md`.

**Paths B / B+ / C.** The full command surface is in `bridge/README.md`. The only thing worth saying
from here is **the discovery order — discover, then scope, never open with a whole-file pull**:

```
node bridge/figma-pull.js --list-libraries    # which libraries this file draws on
node bridge/figma-pull.js --list             # pages + their top-level frames, with ids
node bridge/figma-pull.js --children <id>    # peek at one node's direct children
node bridge/figma-pull.js design --page <id> # deep-pull just that page
```

MCP twins: `figma_list_libraries` → `figma_list_pages` → `figma_list_children` →
`figma_export_full({page:[id]})`. **Pass `writeToDisk: true` for anything past a quick look** — inline
results are capped (`MAX_MCP_OUTPUT_TOKENS`, 25k default) and asset bytes are never returned inline.

Then: **`/figma-to-code <screen>`**.

## Troubleshooting — match the symptom, give the fix

- **Plugin isn't in the menu / a manifest change didn't take** → re-import via *Import plugin from
  manifest…*. It lives under **Plugins → Development**, not the main plugin list.
- **`EADDRINUSE` / bridge hangs on connect** → port 8787 is held; only one bridge at a time. Check
  `node bridge/figma-pull.js --daemon-status` first — if a daemon is up, ordinary commands route
  through it and nothing needs stopping, so this means something *else* holds the port (usually the
  MCP server, or a stale `node`). If the MCP is the holder and you wanted files, use `writeToDisk:
  true` rather than killing it.
- **Bridge stays "offline" in the plugin** → either no token pasted (the plugin says
  `offline — paste the bridge token above` and won't dial until you paste + Save), or no server is
  running yet — the plugin UI is a WS *client*. Fix the token, start a server, it auto-connects (3s retry).
- **Connection rejected / 401** → token mismatch. What the bridge prints (or `FIGMA_BRIDGE_TOKEN`) must
  equal the plugin's **Bridge token** field. Re-paste + Save.
- **Changed the port?** Don't — the plugin is pinned to `ws://localhost:8787` (manifest + `ui.html`).
  `FIGMA_BRIDGE_PORT` only moves the *server*, which the plugin then can't reach. Free 8787 instead.
- **`--list-libraries` / `figma_list_libraries` returns nothing** → in this order: (1) the plugin in
  Figma predates the manifest's `"permissions": ["teamlibrary"]` — **re-import it**; (2) no team
  library is enabled for the file (Figma UI → Assets → Libraries; no API can do this); (3) free plan.
  All three are normal, and the command's own output says which.
- **"N Figma files are connected — say which one to use"** → pass `--client` (CLI) or `client` (MCP);
  `--list-clients` shows the valid names. Refused rather than guessed on purpose: an export from the
  wrong file looks exactly like a correct one. Give each file its own output dir (`design/base`,
  `design/lib`) so exports don't collide.
- **A connection that sat idle came back as a different `instanceId`** → Figma restarted the plugin
  runtime. Don't leave the Figma window **minimized** (its renderer gets suspended); occluded is fine.
- **A component in an export has no library/main component** → its library probably wasn't enabled
  when the export ran. Enable it in Figma, re-pull; there is no API to enable it.
- **MCP `figma` not showing up** → **this repo registers no MCP server** (there is no `.mcp.json`
  here, by choice — see `bridge/README.md`). Path C is for the project you are *building*: add a
  `.mcp.json` there pointing at an absolute path to `bridge/figma-mcp.mjs`, with the same
  `FIGMA_BRIDGE_TOKEN`. Then enable it via `/mcp` and restart.
- **`design/` is empty / `/figma-to-code` can't find files** → nothing exported yet. `design/` is a
  generated drop-target and doesn't exist until an export runs. Do Path A/B first.
- **Wrong stack generated** → set `design/target.json`, or add a profile at your project's own repo
  root (copy `skills/figma-to-code/profiles/_template.md`) — it overrides the bundled profiles.
- **`stale-snapshot` / `unknown-freshness` from drift-lint** → the export in `design/` is older than
  24h (or has no `exportedAt`), so a "clean" result is against the snapshot, not the live file.
  Re-run Path A/B. Tunable: `--max-age <hours>` / `DRIFT_MAX_AGE_HOURS`.
- **Icons missing / lots of asset warnings** → warnings aggregate by kind. Invisible vector nodes are
  skipped silently; failed SVG exports fall back to a `geometry` field the codegen renders inline. A
  node with **neither** `asset` nor `geometry` is a genuine failure — report it.
- **Async / `figma.mixed` errors while editing the plugin** → the manifest uses
  `documentAccess: "dynamic-page"`, so all reads are async and mixed-value props must be guarded.
  See `ARCHITECTURE.md` → "Verified mechanism details".

## Related

- **Build a screen:** `/figma-to-code <screen>` (after files are in `design/`).
- **Build many screens:** `/figma-to-code` handles the fan-out itself — it delegates one layer per
  subagent so each screen's large JSON stays out of the main context.
