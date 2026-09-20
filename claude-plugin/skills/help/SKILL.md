---
name: help
description: Orientation, connection, one-time setup and troubleshooting for Design Twin, the free-plan Figma→code workflow. Use this whenever the user asks a discovery-shaped question — "how does this work", "what can this plugin do", "how do I connect Claude to Figma", "is there a CLI", "what's the MCP server for", "how do I set this up", which export path to use — even if they don't name a command; when they are about to try a Figma task but have no connection set up yet; and whenever something is broken (plugin won't import, port 8787 busy / EADDRINUSE, bridge token / 401, plugin stays offline, MCP not connecting, empty library list, stale snapshot, scripts not found). It orients, routes and diagnoses; it does not export (that's extract), review a design (that's audit-design) or write code (that's build-screen).
---

# Design Twin — what it is, how to connect, what to do when it breaks

Design Twin feeds a Figma design to Claude Code **on a free Figma plan, with zero network egress**.
A self-authored Figma plugin (`allowedDomains`: loopback only) extracts the design as stack-neutral
JSON + real assets into `design/`; `/designtwin:audit-design` reviews it for implementation gaps, and
`/designtwin:build-screen` turns it into code for any stack.

**Your job when this skill is invoked: figure out what the user is trying to do and give them the
exact next step.** Orientation → this file. Something broken → read
[`references/troubleshooting.md`](references/troubleshooting.md), match the symptom, give the fix —
don't debug a bridge error from memory.

Nothing here is headless: the target Figma file must be **open in the desktop app with the "Design
Twin" plugin running** (Figma desktop → Plugins → Development → Design Twin).

## The three ways to reach a Figma file

| | Manual export | `dtwin` CLI | `figma-mcp` server |
|---|---|---|---|
| What it is | Clicking the plugin's own export buttons, saving downloads into `design/` | A one-shot (or `--serve` daemon) local process that pulls data and writes it to `design/` on disk | A persistent MCP server, registered in the project being *built*, that Claude calls as tools mid-conversation |
| Setup | **None** — no bridge, no token | `npm install` once; the token generates itself on first start (paste it into the plugin once) | Same install as the CLI, plus a `.mcp.json` registration — same token, nothing extra |
| Direction | Read only | Read only | Read **and** a small set of safe writes (create a frame/text, set a fill, set text) |
| Best for | One screen, or a first try before setting anything up | Bulk/repeated pulls, CI-style extraction | Interactive back-and-forth, "check this, now pull that", code → design writes |

**Default to manual export for a brand-new user** — it needs nothing installed and always works.
Reach for the CLI or MCP once someone's pulling repeatedly or wants Claude to query Figma live.

**The one thing to say up front: the CLI, its `--serve` daemon and the MCP server all bind port 8787
(loopback), so exactly one can hold it at a time.** Whichever starts second exits with `EADDRINUSE`.
- While the **MCP server** runs, `dtwin` cannot. Use `writeToDisk: true` on the MCP export tools
  instead — that is the MCP path's way to get files, and the **only** way to get asset bytes.
- While a **daemon** (`dtwin --serve`) runs, ordinary `dtwin` commands work normally — they detect
  it and route through it. Nothing changes in how you invoke them.
- To run two bridges deliberately, set `FIGMA_BRIDGE_PORT` on one (`8788` or `8789` — the only other
  ports the plugin can dial).

## What each one lets Claude actually do

**Through the CLI**, Claude runs `dtwin` (inside a clone of the Design Twin repo: `node
bridge/figma-pull.js`). `dtwin --help` prints every flag; a mistyped flag is refused, not ignored.
- Discover structure cheaply before pulling anything heavy: `--whoami` (which file am I on),
  `--list-clients`, `--list-libraries`, `--list-pages` / `--list` (pages + frame ids),
  `--children <id>` (peek one frame).
- Pull a real export: `dtwin design` (current page), `--all-pages`, `--selection`, `--page <id>`,
  `--node <id|figma-url>`, `--design-system` (tokens/styles/components only, no page walk),
  `--as-library "<name>"` (a whole library file's catalog — run with the *library* open).
- Visually check ONE component after generating code for it: `--screenshot <id>` — an on-demand PNG,
  cheaper than re-exporting and tighter than the one whole-frame reference PNG every export carries.
- Keep the connection warm across several pulls with `dtwin --serve` instead of reconnecting every time.

**Through the MCP server**, once registered in the target project, Claude gets live tools instead of
shelling out: `figma_status`, `figma_whoami`, `figma_list_clients`, `figma_get_selection`,
`figma_list_libraries`, `figma_list_pages`, `figma_list_children`, `figma_export_full` /
`figma_export_design_system` / `figma_export_selection` / `figma_export_url`, `figma_screenshot`,
`design_get_component`, `design_drift_lint`, and `figma_write` for the small set of safe writes. The
standout move is pasting a Figma link mid-conversation — `figma_export_url` reads that exact node
live, so "what spacing does this use?" gets answered from the real file, not a stale export.

## One-time setup (once per machine)

**Shortcut:** with the CLI installed, run **`dtwin init`** in the root of the project being built (add
`--mcp` to also register the MCP server; `--dry-run` to preview). It creates `design/`, writes
`design/target.json` for the detected stack, makes sure a bridge token exists, merges `.mcp.json`
without overwriting anything, and prints the steps that are clicks in Figma. The manual version:

1. **Import the Figma plugin.** Figma desktop → **Plugins → Development → Import plugin from
   manifest…** → pick `figma-plugin/manifest.json` from a clone of the Design Twin repo.
2. **Pick a lane:**
   - **Just one screen, nothing installed** → click the plugin's export buttons and save the downloads
     into `design/`. Done.
   - **The CLI** → in the Design Twin clone: `cd bridge && npm install`. There is no token to make by
     hand: the first bridge start generates one, saves it per-user
     (`~/.config/design-twin/bridge-token`, `0600`; `%APPDATA%` on Windows) and prints it once — paste
     it into the plugin's **Bridge token** field (Save) and neither side asks again.
     `dtwin --show-token` reprints it, `--rotate-token` replaces it, `--token-status` says which token
     is in play without disclosing it. Then `dtwin --list` to see what's there.
   - **Live MCP tools in the project being built** → same install as the CLI, plus a `.mcp.json` *in
     that project* pointing at the absolute path of `bridge/figma-mcp.mjs` (`dtwin init --mcp` writes
     it); enable it via `/mcp` and restart. No token goes in that file — the MCP server reads the same per-user stored token.
3. **(Optional) config maps** so the agent reuses your components/tokens instead of regenerating —
   `design/target.json` (stack, auto-detected if absent), `design/tokens.json` (Figma variable → your
   code token — hand-authored; do NOT confuse with the generated `design/design-system/tokens.json`,
   which is Figma's own raw values), and the component map `codeconnect.local.json` (scaffold it with
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/map-bootstrap.js" design/design-system/components.local.json --out codeconnect.local.json`).
   `build-screen` documents all three.

## Then run it

Running an export is the **extract** skill's job — it owns path selection, the discover-then-scope
order, and the manifest check afterwards. Hand off to **`/designtwin:extract`** rather than reciting
commands here. Then: **`/designtwin:audit-design <screen>`** (is it buildable?) →
**`/designtwin:build-screen <screen>`**.

## Where the long-form docs live

These are files in the Design Twin repository, **not** in the project being built — point a user at
them only if they have a clone: `README.md` (workflow, config-map shapes), `bridge/README.md` (full
CLI + MCP surface, token, daemon, limits), `figma-plugin/README.md` (the plugin's UI and outputs),
`ARCHITECTURE.md` (CLI vs MCP front-ends, security). Without a clone, `dtwin --help` and the skills in this
plugin are the reference.

## Subagents this plugin ships

- **`designtwin:screen-builder`** — builds one screen with `build-screen` preloaded, in its own
  context. Used for multi-screen fan-out.
- **`designtwin:visual-verifier`** — renders a built screen, compares it to the Figma reference, and
  returns the differences. Never edits app code.

## Related

- **Something broken:** [`references/troubleshooting.md`](references/troubleshooting.md).
- **Get the design out of Figma:** `/designtwin:extract`.
- **Check the design is buildable first (states, tokens, a11y, designer questions):** `/designtwin:audit-design <screen>`.
- **Build a screen from it:** `/designtwin:build-screen <screen>` — it handles multi-screen fan-out
  itself (one layer per subagent, so each screen's large JSON stays out of the main context).
