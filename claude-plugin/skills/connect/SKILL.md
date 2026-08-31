---
name: connect
description: Explains how Claude Code can connect to a running Figma file through the Design Twin plugin — the dtwin CLI (a local read bridge) and the figma-mcp server (a live, interactive MCP connection) — and what each one lets Claude actually do once connected. Use this whenever the user asks a discovery-shaped question about this plugin: "how does this work", "how do I connect Claude to Figma", "what can this plugin do", "is there a CLI", "can Claude read my Figma file directly", "what's the MCP server for", "how do I set this up" — even if they don't name a command, don't know the plugin ships a CLI/MCP at all, or phrase it as general curiosity rather than a task. Also trigger if the user is clearly about to try a Figma-related task (pull a design, ask about a frame, mention design/ being empty) but hasn't set up a connection yet. Do not use this for actually running an export (that's the extract skill) or for troubleshooting an existing broken connection (that's the help skill, invoked as /designtwin:help) — this skill's job is purely orientation: what exists, and how to turn it on.
---

# Connecting Claude to Figma

Design Twin gives Claude Code three ways to reach a Figma file. The bridge-based two run entirely on
loopback (`ws://localhost:8787`, or `8788`/`8789` via `FIGMA_BRIDGE_PORT` — the only ports the plugin
can dial), no Figma API key, no network egress. None of the three is headless: the target Figma file
must be **open in the desktop app with the "Design Twin" plugin running** (Figma desktop → Plugins →
Development → Design Twin). If it isn't imported yet, that's one-time setup — send the user to
`/designtwin:help`.

## The three connections

| | Manual export | `dtwin` CLI | `figma-mcp` server |
|---|---|---|---|
| What it is | Clicking the plugin's own export buttons, saving downloads into `design/` | A one-shot (or `--serve` daemon) local process that pulls data and writes it to `design/` on disk | A persistent MCP server, registered in the project being *built*, that Claude calls as tools mid-conversation |
| Setup | **None** — no bridge, no token | `npm install` once, plus a bridge token | Same install as the CLI, plus a `.mcp.json` registration |
| Direction | Read only | Read only | Read **and** a small set of safe writes (create a frame/text, set a fill, set text) |
| Best for | One screen, or a first try before setting anything up | Bulk/repeated pulls, CI-style extraction | Interactive back-and-forth, "check this, now pull that", code → design writes |

**Default to manual export for a brand-new user** — it needs nothing installed and always works.
Reach for the CLI or MCP once someone's pulling repeatedly or wants Claude to query Figma live.

The CLI and MCP share one bridge, so **only one can hold the bridge port at a time** — whichever
starts second exits with `EADDRINUSE`. If the MCP server is already running, don't try to also start
the CLI; the MCP's own export tools take `writeToDisk: true` to get the same files the CLI would
produce.

## What each one lets Claude actually do

**Through the CLI**, Claude runs `dtwin` (inside this repo: `node bridge/figma-pull.js`) to:
- Discover structure cheaply before pulling anything heavy: `--whoami` (which file am I on),
  `--list-libraries`, `--list-pages` / `--list` (pages + frame ids), `--children <id>` (peek one frame).
- Pull a real export: `dtwin design` (current page), `--all-pages`, `--selection`, `--page <id>`,
  `--design-system` (tokens/styles/components only, no page walk), `--as-library "<name>"` (a whole
  library file's catalog — run with the *library* open).
- Keep the connection warm across several pulls with `dtwin --serve` (a daemon later commands route
  through automatically) instead of reconnecting every time.

**Through the MCP server**, once registered in the target project, Claude gets live tools instead of
shelling out: `figma_status`, `figma_get_selection`, `figma_list_libraries`, `figma_list_pages`,
`figma_list_children`, `figma_export_full` / `figma_export_design_system` / `figma_export_selection` /
`figma_export_url`, and `figma_write` for the small set of safe writes. The standout move here is
pasting a Figma link mid-conversation — `figma_export_url` reads that exact node live, so "what
spacing does this use?" gets answered from the real file, not a stale export.

## Getting a connection open — the short version

1. Figma desktop → the target file open → Plugins → Development → Design Twin (running).
2. Pick a lane:
   - **Just want one screen, nothing installed** → tell the user to click the plugin's export buttons
     and save the downloads into `design/`. Nothing else to set up.
   - **Want the CLI** → first run only: `cd bridge && npm install`. `dtwin` comes from the
     `designtwin` npm package — if it's not on PATH (e.g. working inside this repo itself), use
     `node bridge/figma-pull.js` instead. A bridge token is **required**, but nothing to generate by
     hand for a first try: the bridge prints one on start if `FIGMA_BRIDGE_TOKEN` isn't set — paste it
     into the plugin's **Bridge token** field once (Save) and it connects. Then `dtwin --list` to see
     what's there, followed by a real pull.
   - **Want Claude to query Figma live, mid-conversation, in another project** → same install as the
     CLI, and that project needs a `.mcp.json` pointing at an absolute path to `bridge/figma-mcp.mjs`,
     with `FIGMA_BRIDGE_TOKEN` set the same on both ends, then enable it via `/mcp` and restart. This
     repo itself registers no MCP server on purpose — that's for the project being *built*, not this one.
3. From here: pulling/exporting data is the **extract** skill's job — hand off to
   `/designtwin:extract`. Something not connecting? That's **help**'s job —
   `/designtwin:help` has the full troubleshooting list (port conflicts, token mismatches, stale
   plugin, etc). The full CLI flag reference and MCP tool list live in `bridge/README.md` — point
   there rather than reciting every flag here.

## Related

- **One-time setup, deep troubleshooting:** `/designtwin:help`.
- **Actually run a pull/export:** `/designtwin:extract`.
- **Build a screen from what landed:** `/designtwin:build-screen <screen>`.
