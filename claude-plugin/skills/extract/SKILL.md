---
name: extract
description: Get a design OUT of Figma and onto disk as JSON + assets, using the local "Design Twin" plugin (free Figma plan, no Figma API, no network egress). Use this whenever the user wants design data pulled, exported, synced, refreshed or re-pulled from Figma — "pull the login screen", "export this frame", "get the design system", "re-sync the tokens", "grab the components from Figma" — and ALSO whenever a build/codegen task needs files that aren't in design/ yet, or the ones there are stale. This is the step BEFORE writing any code; once files land in design/, hand off to build-screen.
argument-hint: "[what to pull: page, frame name, node id or Figma URL]"
---

# Extract a design from Figma

Get design data onto disk. Nothing here writes code — that's `build-screen`.

**Everything runs locally.** The Figma plugin's `allowedDomains` names only `ws://localhost`, so design data
never leaves the machine. There is no Figma API key and no cloud round-trip.

## Before anything: is the plugin running?

Every path needs the **Figma file open with the "Design Twin" plugin running**. None of this
is headless — the plugin *is* the reader. If the user hasn't started it: Figma desktop →
**Plugins → Development → Design Twin**.

Not imported yet? That's one-time setup — send them to `/designtwin:help`.

## Pick a path

Four ways to get data out: click the plugin's export buttons (manual), run the `dtwin` CLI, hold it
open as a daemon (`--serve`) for several pulls in a row, or go through a registered `figma-mcp` server.
What each is, when to reach for it, and how a connection actually gets opened is the **help**
skill's job, not this one — use it if the user hasn't got a connection working yet.

**Default to manual export when the bridge isn't already working.** It needs zero setup and always
works; walking a user through CLI/token setup mid-task is worse than just clicking the buttons.

**Only one bridge can hold port 8787** at a time (CLI, daemon, and MCP all bind it) — if the MCP
server is already running, use its own export tools with `writeToDisk: true` instead of also trying
the CLI.

## Discover, then scope — never open with a whole-file pull

A full pull on a real design file is enormous and most of it is irrelevant to the task. Spend two
cheap calls to find the one page you actually need:

```
dtwin list libraries          # which design libraries this file draws on
dtwin list                    # pages + their top-level frames, WITH IDS
dtwin list children <id>      # peek inside one node before committing
dtwin pull design --page <id> # then deep-pull only that page
dtwin pull design --node <id> # or just ONE node (a link someone pasted, a single component)
```

Each command is shorthand for a flag that still works (`dtwin --list-libraries`, `--list`,
`--children <id>`, `dtwin design --page <id>`) — an older install without the commands takes those.
If a command hangs or times out, run **`dtwin doctor`** before anything else: it says whether the
cause is the token, the port, the daemon or the plugin.

**`dtwin` comes from the `designtwin` npm package.** If it isn't on PATH, you are probably working
inside a clone of the Design Twin repo itself — there, every `dtwin` above is
`node bridge/figma-pull.js`. If neither is available, the CLI isn't installed: fall back to Path A
(the plugin's own export buttons), which needs nothing.

MCP twins: `figma_list_libraries` → `figma_list_pages` → `figma_list_children` →
`figma_export_full({page:[id]})`.

Two narrower pulls worth knowing: `design --design-system` gets tokens/styles/components with **no**
page walk and no assets; `design --as-library "<name>"` gets a library file's complete catalog (run it
with the *library* open, not the file consuming it).

**After `build-screen` generates code for one component**, `dtwin screenshot <id>` gets a fresh PNG of
just that node to compare the output against — cheaper than re-exporting, and a tighter check than the
one whole-frame reference PNG every export already carries (which is too zoomed-out to eyeball a small
component inside a dense screen). MCP twin: `figma_screenshot`.

**The full command + flag surface is `dtwin help`** (and `bridge/README.md` in a clone of the Design Twin
repo) — read it rather than guessing at flags; an unknown flag is refused with a suggestion. This
skill owns the decision of *which* pull to run; that reference owns *how*.

## Through the MCP instead

The server is registered as `designtwin`, so a tool's full name is `mcp__designtwin__<tool>` (e.g.
`mcp__designtwin__figma_list_pages`) — call it by that name if the short one isn't found.

**Pass `writeToDisk: true` on any export past a quick look.** Inline results are capped (25k tokens by
default), so a real page export is silently truncated without it — and asset bytes are never returned
inline at all, so it's the only way to get `design/assets/`.

## Check what landed before declaring success

Every export doc carries a **`manifest`**: `nodes`, `skipped`, `truncated`, `assetsFailed`,
`warnings`. Read it. A truncated tree or a failed asset produces a screen that *looks* buildable and
silently isn't, so say so now rather than letting `build-screen` discover it halfway through.

Also confirm the shape on disk — `design/pages/index.json` (+ per-page dirs), or
`design/<screen>.json`, plus `design/design-system/` and `design/assets/`.

**Check the reference screenshot landed.** Every export renders one PNG per top-level frame and
points at it from the screen JSON's root `reference` field (a path relative to `design/`, e.g.
`assets/<id>_ref.png`). `build-screen` validates against it, and without it fidelity checking is
guesswork — so confirm that file exists. Only if `reference` is absent (the manifest `warnings` will
say "reference screenshot failed/empty") ask the user to export a PNG of the frame by hand (Figma
right-click → Export) to `design/<screen>.png`.

## Then hand off

Report briefly: what landed, anything the manifest flagged, and whether the PNG exists. Then
**`/designtwin:audit-design <screen>`** to check the design is buildable (missing states, contrast,
touch targets, designer questions), and **`/designtwin:build-screen <screen>`** to build it.

If something failed — bridge offline, `EADDRINUSE`, empty library list, 401 — the symptom→fix list is
the **help** skill's `references/troubleshooting.md`. Load it; don't debug from memory.
