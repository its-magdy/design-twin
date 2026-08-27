---
name: help
description: Orientation, one-time setup and troubleshooting for the free-plan Figma→code workflow. Invoke as /designtwin:help when the user asks how this tool works, how to set it up, which of the three export paths to use, or when something is broken (plugin won't import, port 8787 busy, bridge token / 401, MCP not connecting, empty library list, stale snapshot). It routes and diagnoses; it does not export (that's extract) and does not write code (that's build-screen).
disable-model-invocation: true
---

# Using this tool (free-plan Figma → code)

Design Twin feeds a Figma design to Claude Code **on a free Figma plan, with zero network egress**.
A self-authored plugin (`allowedDomains`: loopback only) extracts the design as stack-neutral JSON + real
assets; the `/designtwin:build-screen` skill turns that into code for any stack.

**Your job when this skill is invoked: figure out what the user is trying to do, give them the exact
next step, and point at the one doc that covers it. Route — do not re-explain what the docs already say.**

## Where the real docs live — send the user here rather than paraphrasing

| Doc | Covers |
|-----|--------|
| `README.md` | The workflow, one-time setup, per-screen loop, config-map shapes, why this shape, plugin packaging |
| `bridge/README.md` | **The full CLI + MCP surface** — install, token, every `figma-pull` flag, `--list-clients`/`--whoami`/`--list-libraries`/`--as-library`, the `--serve` daemon, MCP tools, `writeToDisk`, limits |
| `ARCHITECTURE.md` | The two-plane design, plugin two-context model, full API surface, security |
| `figma-plugin/README.md` | The Figma-side plugin: import, UI buttons, what each export produces |
| `plugin/skills/build-screen/SKILL.md` | How the agent actually builds a screen (+ its `references/`, `profiles/`) |
| `plugin/skills/extract/SKILL.md` | How an export actually gets run (path choice, discover-then-scope) |

## Step 1 — which of the three paths?

| Path | When to use | What runs |
|------|-------------|-----------|
| **A. Manual export** (default, zero setup) | One screen, or first time | Plugin UI buttons → download files into `design/` by hand |
| **B. `figma-pull` CLI** (read, automated) | Bulk / repeated pulls | `dtwin` hosts a loopback WS; plugin auto-connects and pushes; CLI writes files and exits |
| **B+. `figma-pull --serve`** (daemon) | Many pulls in a row | Same CLI, but the bridge stays open until `--stop`; later invocations route through it |
| **C. `figma-mcp` server** (write / interactive) | "Check this, now pull that" + code→design | stdio MCP + persistent loopback WS; opt-in, **disabled by default** |

All of them require the **Figma file open with the plugin running** — nothing is headless.
Once files are in `design/`, building code is identical for all three: **`/designtwin:build-screen <screen>`**.

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

## Step 3 — run it

Running an export is the **extract** skill's job, not this one — it owns path selection, the
discover-then-scope order, and the manifest check afterwards. Hand off to
**`/designtwin:extract`** rather than reciting commands here; the full flag surface is in
`bridge/README.md`.

Then build: **`/designtwin:build-screen <screen>`**.

## Troubleshooting — match the symptom, give the fix

- **Plugin isn't in the menu / a manifest change didn't take** → re-import via *Import plugin from
  manifest…*. It lives under **Plugins → Development**, not the main plugin list.
- **`EADDRINUSE` / bridge hangs on connect** → port 8787 is held; only one bridge at a time. Check
  `dtwin --daemon-status` first — if a daemon is up, ordinary commands route
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
- **`design/` is empty / `/designtwin:build-screen` can't find files** → nothing exported yet. `design/` is a
  generated drop-target and doesn't exist until an export runs. Do Path A/B first.
- **Wrong stack generated** → set `design/target.json`, or add a profile at your project's own repo
  root (copy `plugin/skills/build-screen/profiles/_template.md`) — it overrides the bundled profiles.
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

- **Get the design out of Figma:** `/designtwin:extract`.
- **Build a screen from it:** `/designtwin:build-screen <screen>`.
- **Build many screens:** `build-screen` handles the fan-out itself — it delegates one layer per
  subagent so each screen's large JSON stays out of the main context.
