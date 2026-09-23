---
name: help
description: Orientation, connection, one-time setup and troubleshooting for Design Twin, the free-plan Figma→code workflow. Use this whenever the user asks a discovery-shaped question — "how does this work", "what can this plugin do", "how do I connect Claude to Figma", "is there a CLI", "what's the MCP server for", "how do I set this up", which export path to use — even if they don't name a command; when they are about to try a Figma task but have no connection set up yet; and whenever something is broken (plugin won't import, port 8787 busy / EADDRINUSE, bridge token / 401, plugin stays offline, MCP not connecting, empty library list, stale snapshot, scripts not found). It orients, routes and diagnoses; it does not export (that's extract), review a design (that's audit-design), write code (that's build-screen) or update built code after a design change (that's sync-design).
argument-hint: "[question or symptom]"
---

# Design Twin — what it is, how to connect, what to do when it breaks

Design Twin feeds a Figma design to Claude Code **on a free Figma plan, with zero network egress**.
A self-authored Figma plugin (`allowedDomains`: loopback only) extracts the design as stack-neutral
JSON + real assets into **`design/export/`**; `/designtwin:audit-design` reviews it for
implementation gaps, and `/designtwin:build-screen` turns it into code for any stack.

**`design/export/` is the only place a pull writes.** Everything beside it under `design/` —
`target.json`, `codeconnect.local.json`, `plan/`, `audit/`, `verify/` — is decisions and evidence you
own and cannot regenerate, so `rm -rf design/export && re-pull` is always safe. `dtwin init` drops a
`design/README.md` saying so. Projects created before this split keep their export directly in
`design/`; everything still finds it, and `dtwin doctor` reports which layout it found.

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

**The one thing to say up front: port 8787 (loopback) has one owner at a time, and the owner shares.**
- While the **MCP server** or a **daemon** (`dtwin serve`) holds it, ordinary `dtwin` commands and a
  second Claude Code session's MCP server work normally — they detect the owner and route through
  it. Nothing changes in how you invoke them. Inside an MCP session, `writeToDisk: true` on the
  export tools is still the simplest way to get files, and the **only** MCP way to get asset bytes.
- The exception is a plain one-shot `dtwin pull` with no daemon: it does not share, so an MCP server
  or second pull started while it runs exits with `EADDRINUSE`. Wait for it, or use `dtwin serve`.
- To run two bridges deliberately, set `FIGMA_BRIDGE_PORT` on one (`8788` or `8789` — the only other
  ports the plugin can dial).

## What each one lets Claude actually do

**Through the CLI**, Claude runs `dtwin`. Check `which dtwin` first — it is normally already a
global binary, and only if it is missing are you inside a clone of the Design Twin repo, where every
`dtwin` is `node bridge/figma-pull.js`. `dtwin help` prints a quick start, the commands and every
flag, and each command answers `--help` with its own page (`dtwin screenshot --help`,
`dtwin list --help`, `dtwin pull --help`, `dtwin mcp --help`) without doing anything else while doing
so. A mistyped flag is refused, not ignored. Each command is shorthand for a flag (`dtwin list pages`
= `dtwin --list-pages`) and the flag spellings keep working — use either.
- **Anything not working → `dtwin doctor` first.** It checks the token, the port, the daemon, whether
  the plugin can connect (and whether it has the *right* token) and the project, changes nothing, and
  prints the next step for each problem.
- Discover structure cheaply before pulling anything heavy: `dtwin whoami` (which file am I on),
  `dtwin list clients`, `dtwin list pages` / `dtwin list` (pages + their top-level LAYERS with ids —
  SECTIONs and groups too, so on a sectioned file the real screens are one `list children` deeper),
  `dtwin list children <id>` (peek one frame). `dtwin list libraries` answers which library owns a
  token but is the slowest read there is (5-15s); it prints progress while it works.
- Pull a real export: `dtwin pull design` (current page; `dtwin design` is the same), `--all-pages`,
  `--selection`, `--page <id>`, `--node <id|figma-url>`, `--design-system` (tokens/styles/components
  only, no page walk), `--as-library "<name>"` (a whole library file's catalog — run with the *library* open).
- Visually check ONE component after generating code for it: `dtwin screenshot <id>` — an on-demand PNG,
  cheaper than re-exporting and tighter than the one whole-frame reference PNG every export carries.
- Keep the connection warm across several pulls with `dtwin serve` (`dtwin stop` / `dtwin status`)
  instead of reconnecting every time.

**Through the MCP server**, once registered in the target project (as `designtwin`, so each tool's full
name is `mcp__designtwin__<tool>`), Claude gets live tools instead of shelling out: `figma_status`, `figma_whoami`, `figma_list_clients`, `figma_get_selection`,
`figma_list_libraries`, `figma_list_pages`, `figma_list_children`, `figma_export_full` /
`figma_export_design_system` / `figma_export_selection` / `figma_export_url`, `figma_screenshot`,
`design_get_component`, `design_drift_lint`, and `figma_write` for the small set of safe writes. The
standout move is pasting a Figma link mid-conversation — `figma_export_url` reads that exact node
live, so "what spacing does this use?" gets answered from the real file, not a stale export.

## One-time setup (once per machine)

**Shortcut:** with the CLI installed, run **`dtwin init`** in the root of the project being built (add
`--mcp` to also register the MCP server; `--dry-run` to preview). It creates `design/` and
`design/export/`, writes `design/README.md` and `design/target.json` (the detected stack, or
`profile: null` for build-screen to fill in on its first run), makes sure a bridge token exists,
merges `.mcp.json` without overwriting anything, and prints the steps that are clicks in Figma. The
manual version:

1. **Import the Figma plugin.** Figma desktop → **Plugins → Development → Import plugin from
   manifest…** → pick `figma-plugin/manifest.json` from a clone of the Design Twin repo.
2. **Pick a lane:**
   - **Just one screen, nothing installed** → click the plugin's export buttons and save the downloads
     into `design/`. Done.
   - **The CLI** → `which dtwin`; if it isn't there, install the `designtwin` package, or in a clone
     of this repo `cd bridge && npm install`. There is no token to make by hand: the first bridge start generates one, saves it per-user
     (`~/.config/design-twin/bridge-token`, `0600`; `%APPDATA%` on Windows) and prints it once — paste
     it into the plugin's **Bridge token** field (Save) and neither side asks again.
     `dtwin token show` reprints it, `dtwin token rotate` replaces it, `dtwin token` says which token
     is in play without disclosing it (flag forms: `--show-token` / `--rotate-token` /
     `--token-status`). Then `dtwin doctor` to confirm the plugin connects, and `dtwin list` to see
     what's there.
     One bridge serves **several Figma files at once** — each open plugin window is one client. With
     more than one connected, every command that reaches the plugin needs `--client <connId|part of
     the file name>`, or it refuses rather than guessing; `dtwin list clients` is the address book and
     `dtwin doctor` says when you will need it. (MCP: a `client` argument on each tool.) A partial
     file name is the form to reach for: `figma.fileKey` is gated to private plugins, so on a
     self-imported plugin it is `null` and cannot address anything.
   - **Live MCP tools in the project being built** → same install as the CLI, plus a `.mcp.json` *in
     that project* pointing at the absolute path of `bridge/figma-mcp.mjs` (`dtwin init --mcp` writes
     it); enable it via `/mcp` and restart. No token goes in that file — the MCP server reads the same per-user stored token.
3. **(Optional) config maps** so the agent reuses your components/tokens instead of regenerating —
   `design/target.json` (stack, auto-detected if absent), `design/tokens.json` (Figma variable → your
   code token — hand-authored; do NOT confuse with the generated `design/export/design-system/tokens.json`,
   which is Figma's own raw values), and the component map `design/codeconnect.local.json` (scaffold it with
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/map-bootstrap.js" design/export/design-system/components.local.json --out design/codeconnect.local.json`).
   `build-screen` documents all three. Both `design/export/design-system/` paths above exist only after a
   `dtwin pull --design-system` (or a full pull) — see the table below.

## What a pull actually writes

Which files land depends on which pull ran, and expecting the full set after a single-screen pull is
the most common way to conclude an export "failed" when it did exactly what was asked:

| Pull | Writes (all under `design/export/`) |
|---|---|
| `dtwin pull --node <id>` (or a selection) | `pages/<Page>/<Screen>__<node-id>.json` (`exportedAt`, `screen`, `page`, `nodeId`, `nodes[]`, `manifest` — the reference PNG path is `nodes[0].reference`), plus `…__<id>.vars.json` (that screen's tokens) and `…__<id>.assets.json` (its assets, with content hashes) beside it, a row in `pages/index.json`, the merged `variables.json`, and `assets/` |
| `dtwin pull --page <id>` / `--all-pages` | the same `pages/` tree, one file per top-level layer (each with a ROOT `reference`), and `assets/` |
| `dtwin pull --design-system` | `design-system.json` (slim pointer manifest) + `design-system/` (`tokens.json`, `components.local.json`, `components.library.json`, `styles.*.json`, `hygiene.json`). No page walk, no assets |
| `dtwin screenshot <id>` | `assets/<id>_ref.png` — the same place a later `--node` pull of that frame writes its own reference, so there is never a second copy |

Single screens and whole pages land in **one** tree, so nothing downstream has to know which pull
produced a file. The node id is in the filename because a frame NAME does not identify a frame: two
`Popup`s on one page are two screens. Read `pages/index.json`; don't reconstruct filenames.

A single-screen pull writes **no `design-system/`**, and that is normal. `variables.json`
**accumulates** — a second screen's tokens merge in rather than replacing the first's. `dtwin doctor`
counts any of these as an export, and reports when one export mixes more than one Figma file.

## Then run it

Running an export is the **extract** skill's job — it owns path selection, the discover-then-scope
order, and the manifest check afterwards. Hand off to **`/designtwin:extract`** rather than reciting
commands here. Then: **`/designtwin:audit-design <screen>`** (is it buildable?) →
**`/designtwin:build-screen <screen>`**.

## Where the long-form docs live

**Without a clone of the Design Twin repo, the reference is `dtwin --help` (plus each command's own
`--help`) and the skills in this plugin** — including
[`references/troubleshooting.md`](references/troubleshooting.md), which lives inside this installed
plugin and is always readable. The repository docs are a different thing: `README.md` (workflow,
config-map shapes), `bridge/README.md` (full CLI + MCP surface, token, daemon, limits),
`figma-plugin/README.md` (the plugin's UI and outputs), `ARCHITECTURE.md` (CLI vs MCP front-ends,
security). Point a user at those only if they actually have a clone — the one-time setup step that
imports the Figma plugin does need one, since the npm package ships no `manifest.json`.

## Subagents this plugin ships

- **`designtwin:screen-builder`** — builds one screen with `build-screen` preloaded, in its own
  context. Used for multi-screen fan-out.
- **`designtwin:visual-verifier`** — renders a built screen, measures every node against the design's
  own numbers, checks that every component on the frame was actually built and that every designed
  interaction works, and writes the measurements to `design/verify/`. It returns measurements rather
  than a verdict: `verify-screen.js --compare` computes that, so "pass" is never something anyone
  asserts. Never edits app code.

## Related

- **Something broken:** [`references/troubleshooting.md`](references/troubleshooting.md).
- **Get the design out of Figma:** `/designtwin:extract`.
- **Check the design is buildable first (states, tokens, a11y, designer questions):** `/designtwin:audit-design <screen>`.
- **Build a screen from it:** `/designtwin:build-screen <screen>` — it handles multi-screen fan-out
  itself (one layer per subagent, so each screen's large JSON stays out of the main context).
- **Only check a built screen against its design (no code changes):** `/designtwin:verify <screen>` —
  renders it, compares it with the export and lists the differences with evidence. (It runs the
  `designtwin:visual-verifier` agent; `@agent-designtwin:visual-verifier` reaches the agent directly.)
- **A theme file from the Figma tokens** (CSS variables, or Swift / Kotlin / Dart / TS): part of
  `/designtwin:extract` — "set up my theme from Figma".
- **The design changed after you built it:** `/designtwin:sync-design <screen>` — diffs the old and
  new export and patches only what moved, keeping your hand edits. Commit `design/` so there is
  always a previous export to diff against.
