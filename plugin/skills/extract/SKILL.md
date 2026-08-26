---
name: extract
description: Get a design OUT of Figma and onto disk as JSON + assets, using the local "Design Twin" plugin (free Figma plan, no Figma API, no network egress). Use this whenever the user wants design data pulled, exported, synced, refreshed or re-pulled from Figma — "pull the login screen", "export this frame", "get the design system", "re-sync the tokens", "grab the components from Figma" — and ALSO whenever a build/codegen task needs files that aren't in design/ yet, or the ones there are stale. This is the step BEFORE writing any code; once files land in design/, hand off to build-screen.
---

# Extract a design from Figma

Get design data onto disk. Nothing here writes code — that's `build-screen`.

**Everything runs locally.** The Figma plugin declares `allowedDomains: ["none"]`, so design data
never leaves the machine. There is no Figma API key and no cloud round-trip.

## Before anything: is the plugin running?

Every path needs the **Figma file open with the "Design Twin" plugin running**. None of this
is headless — the plugin *is* the reader. If the user hasn't started it: Figma desktop →
**Plugins → Development → Design Twin**.

Not imported yet? That's one-time setup — send them to `/designtwin:help`.

## Pick a path

| Path | Use when | How |
|---|---|---|
| **A. Manual** | One screen, first time, or the bridge isn't set up | Click the plugin's export buttons, save the downloads into `design/` |
| **B. CLI** | Anything repeated or bulk | `node bridge/figma-pull.js …` — hosts a loopback socket, the plugin pushes, files land, it exits |
| **B+. Daemon** | Several pulls in a row | `--serve` holds the connection open so each pull skips the reconnect wait |
| **C. MCP** | Interactive "look at this, now pull that", or design *writes* | Registered in the project you're building, not in this repo |

**Default to A when the bridge isn't already working.** It needs zero setup and always works. B is
better once someone is pulling repeatedly, but it needs `npm install` and a bridge token first, and
walking a user through that mid-task is worse than just clicking the buttons.

**Only one bridge can hold port 8787.** B, B+ and C all bind it; whichever starts second dies with
`EADDRINUSE`. If the MCP server is already running you cannot also run the CLI — use the MCP's own
export tools with `writeToDisk: true` instead.

## Discover, then scope — never open with a whole-file pull

A full pull on a real design file is enormous and most of it is irrelevant to the task. Spend two
cheap calls to find the one page you actually need:

```
node bridge/figma-pull.js --list-libraries   # which design libraries this file draws on
node bridge/figma-pull.js --list             # pages + their top-level frames, WITH IDS
node bridge/figma-pull.js --children <id>    # peek inside one node before committing
node bridge/figma-pull.js design --page <id> # then deep-pull only that page
```

MCP twins: `figma_list_libraries` → `figma_list_pages` → `figma_list_children` →
`figma_export_full({page:[id]})`.

Two narrower pulls worth knowing: `design --design-system` gets tokens/styles/components with **no**
page walk and no assets; `design --as-library "<name>"` gets a library file's complete catalog (run it
with the *library* open, not the file consuming it).

**The full flag surface lives in `bridge/README.md`** — read it rather than guessing at flags. This
skill owns the decision of *which* pull to run; that file owns *how*.

## Through the MCP instead

**Pass `writeToDisk: true` on any export past a quick look.** Inline results are capped (25k tokens by
default), so a real page export is silently truncated without it — and asset bytes are never returned
inline at all, so it's the only way to get `design/assets/`.

## Check what landed before declaring success

Every export doc carries a **`manifest`**: `nodes`, `skipped`, `truncated`, `assetsFailed`,
`warnings`. Read it. A truncated tree or a failed asset produces a screen that *looks* buildable and
silently isn't, so say so now rather than letting `build-screen` discover it halfway through.

Also confirm the shape on disk — `design/pages/index.json` (+ per-page dirs), or
`design/<screen>.json`, plus `design/design-system/` and `design/assets/`.

**The screenshot is not optional and the plugin cannot produce it.** Ask the user to export a PNG of
the frame (Figma right-click → Export) to `design/<screen>.png`. `build-screen` validates against it,
and without it fidelity checking is guesswork.

## Then hand off

Report briefly: what landed, anything the manifest flagged, and whether the PNG exists. Then
**`/designtwin:build-screen <screen>`**.

If something failed — bridge offline, `EADDRINUSE`, empty library list, 401 — the symptom→fix list is
in **`/designtwin:help`**. Don't debug it from memory.
