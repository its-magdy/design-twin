---
name: extract
description: Get a design OUT of Figma and onto disk as JSON + assets, using the local "Design Twin" plugin (free Figma plan, no Figma API, no network egress). Use this whenever the user wants design data pulled, exported, refreshed or re-pulled from Figma — "pull the login screen", "export this frame", "get the design system", "get me the colors", "set up my theme from Figma", "grab the components from Figma" — and ALSO whenever a build/codegen task needs files that aren't in design/export/ yet, or the ones there are stale. This is the step BEFORE writing any code; once files land, hand off to build-screen. When a screen that is ALREADY built must catch up with a changed design, use sync-design — it snapshots before re-pulling.
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

## Where things land

`dtwin` writes to **`design/export/` and nowhere else**. Everything beside it under `design/` —
`target.json`, `codeconnect.local.json`, `plan/`, `audit/`, `verify/` — is decisions and evidence a
human or a later step owns, and no pull touches them.

That boundary is the point: `rm -rf design/export && re-pull` is the natural way to recover from a
bad export, and it used to take a hand-mapped component map with it. `design/README.md` (written by
`dtwin init`) says the same thing where someone deleting files will actually see it.

A project created before this split keeps its export directly in `design/`; every tool still finds
it, and `dtwin doctor` says which layout it found.

## Pick a path

Four ways to get data out: click the plugin's export buttons (manual), run the `dtwin` CLI, hold it
open as a daemon (`dtwin serve`) for several pulls in a row, or go through a registered MCP server.
What each is, when to reach for it, and how a connection actually gets opened is the **help**
skill's job, not this one — use it if the user hasn't got a connection working yet.

**Default to manual export when the bridge isn't already working.** It needs zero setup and always
works; walking a user through CLI/token setup mid-task is worse than just clicking the buttons.

**Only one bridge can hold port 8787** at a time (CLI, daemon, and MCP all bind it) — if the MCP
server is already running, use its own export tools with `writeToDisk: true` instead of also trying
the CLI.

**Where `dtwin` comes from.** Check `which dtwin` first — it is usually already on PATH, installed
globally from the `designtwin` npm package (and it can be on PATH by other means; don't assume npm).
Only if it is missing are you inside a clone of the Design Twin repo, where every `dtwin` below is
`node bridge/figma-pull.js`. If neither works, the CLI isn't installed: fall back to the plugin's own
export buttons, which need nothing.

## Discover, then scope — never open with a whole-file pull

A full pull on a real design file is enormous and most of it is irrelevant to the task. Spend two
cheap calls to find the one frame you actually need:

```
dtwin list                    # pages + their top-level LAYERS, with ids
dtwin list children <id>      # peek inside one node before committing
dtwin screenshot <id>         # look at a candidate before paying for a pull
dtwin pull design --node <id> # then deep-pull ONE screen
dtwin pull design --page <id> # or a whole page
dtwin list libraries          # which design libraries this file draws on — SLOW, see below
```

Every command answers `--help` with its own page (`dtwin screenshot --help`, `dtwin list --help`),
and none of them does anything else while doing so. If a command hangs or times out, run
**`dtwin doctor`** first: it says whether the cause is the token, the port, the daemon or the plugin.

**`dtwin list` reports LAYERS, not screens.** Its top-level array carries SECTION, GROUP, INSTANCE,
TEXT and RECTANGLE alongside FRAME, and on a sectioned file the real screens are one level *deeper*,
inside SECTIONs 9,000-36,000px wide. The summary line breaks the count down by type and the JSON
carries `type` per row; when you see SECTIONs, `list children <section id>` is the next call, not a
pull.

**`dtwin list libraries` is the slowest read there is** — 5-15s against half a second for `list`,
because it asks Figma about every enabled library's variable collections one at a time. It prints
progress while it works. Run it when you need to know which library owns a token, not as a warm-up.

**More than one Figma file open? Every command above needs `--client`.** The bridge routes per
connected plugin, so with two files connected it refuses rather than guessing:
"2 Figma files are connected to the bridge — say which one to use". That is not a failure — add
`--client <connId|part of the file name>` and re-run:

```
dtwin list clients                              # the address book: connId, file name, fileKey
dtwin list --client Marketing                   # …then scope every command to one file
dtwin pull design --node <id> --client Marketing
```

A partial file name works and is what to reach for. The docs also offer `fileKey`, but on a
self-imported plugin (the free-plan setup this tool targets) `figma.fileKey` is gated and reported as
`null` — so that form addresses nothing here. `dtwin doctor` names each connected file and says when
disambiguation will be needed. MCP twin: a `client: "<id|name>"` argument on every plugin-reaching tool.

MCP twins: `figma_list_libraries` → `figma_list_pages` → `figma_list_children` →
`figma_export_full({page:[id]})`.

Two narrower pulls worth knowing: `design --design-system` gets tokens/styles/components with **no**
page walk and no assets; `design --as-library "<name>"` gets a library file's complete catalog (run it
with the *library* open, not the file consuming it).

**Several frames with the same name?** Real files have them — one page held two frames with the same
name and the same size, and `list children` returns only name/id/type/size, so nothing in that output
tells them apart. Don't take the first id: `dtwin screenshot <id>` renders ONE node to
`design/export/assets/<id>_ref.png` cheaply (no `serialize()`, no asset walk, well under a second
warm). Shoot each candidate, look, then pull the right one. That PNG lands in exactly the place a
later `--node` pull of the same frame writes its own reference, so shooting first costs nothing and
leaves no duplicate. Ask the user if the renders don't settle it.

**A state you need may be a sibling frame, not a missing design.** Before reporting "there is no
populated/empty/error state", run `dtwin list children <the parent section>`. On the live file the
populated table sat beside the empty one, named for what it holds rather than for the screen beside it — and a
three-second sweep answered what would otherwise have been a blocking designer question.

**The full command + flag surface is `dtwin help`** (and `bridge/README.md` in a clone) — read it
rather than guessing; an unknown flag is refused with a suggestion. This skill owns the decision of
*which* pull to run; that reference owns *how*.

## Through the MCP instead

The server is registered as `designtwin`, so a tool's full name is `mcp__designtwin__<tool>` (e.g.
`mcp__designtwin__figma_list_pages`) — call it by that name if the short one isn't found.

**Pass `writeToDisk: true` on any export past a quick look.** Inline results are capped (25k tokens by
default). An export too large to return is written to disk on its own and the result's `note` says
so, but asking for it up front is cheaper than discovering it — and asset bytes are never returned
inline at all, so it's the only way to get `assets/`.

## Check what landed before declaring success

Every export doc carries a **`manifest`**. Read all of it, not just the three fields that are
obviously about failure:

| key | what a non-zero value means |
|---|---|
| `nodes` | how much tree you got |
| `truncated`, `skipped` | the export did not finish the tree — treat as a failed pull |
| `assetsFailed` | a render failed and nothing replaced it |
| `warnings` | read every line |
| `assetsGeometry` | that many nodes took the **fallback** path: the render failed and their vector paths were inlined instead. `assetsFailed` stays 0, so the three obvious fields say "clean" while 13% of the nodes took a degraded route. Expect to hand-check those nodes. |
| `assetsSkippedInvisible` | vector nodes with nothing visible to render. Normal, and not a failure. |

**What lands depends on the pull**, so check for what your command actually produces:

- `--node <id>` / a selection → `design/export/pages/<Page>/<Screen>__<node-id>.json` (keys:
  `exportedAt`, `screen`, `page`, `pageId`, `nodeId`, `nodes[]`, `manifest`), plus three siblings:
  `…__<id>.vars.json` (the tokens THIS screen binds), `…__<id>.assets.json` (which assets it uses,
  with content hashes), and a row in `design/export/pages/index.json`. Also
  `design/export/variables.json` and `design/export/assets/`. **No `design/export/design-system/`** —
  that directory needs its own pull, and its absence here is normal, not a failed export.
- `--page <id>` / `--all-pages` → the same `pages/` tree, one file per top-level layer.
- `--design-system` → `design/export/design-system.json` (a slim pointer manifest — every entry under
  `files` resolves to something on disk) + `design/export/design-system/`: `tokens.json`,
  `components.local.json`, `components.library.json` (components this file *consumes* from
  elsewhere), `styles.{paint,text,effect,grid}.json`, `hygiene.json`. No page walk, no assets.

The filename carries the node id because frame names do not identify a frame: two `Popup`s on one
page are two different screens, and a name ending in a space sanitises to a trailing `_`. Read `pages/index.json` rather than reconstructing filenames — it carries each screen's
real name, page, node id, size and the paths to all three files.

`--design-system` counts and `dtwin list libraries` counts legitimately differ: the export includes
variables this file merely *references* from a published library, flagged `remote: true`, and
`hygiene.json`'s first line says how many. Both numbers are right; they are answering different
questions.

**`design/export/variables.json` accumulates — it is not per-pull state.** Each single-screen pull
merges its slice in, keyed on each variable's Figma key, so pulling screen B no longer deletes screen
A's tokens. The raw per-pull slice is also kept verbatim as the screen's `.vars.json` (every variable
in the collections that screen references — more than the ones its nodes actually bind). Names are
not unique across the union: two different variables (two keys) can both be called `Space 4` with
different values. Such a pair, and a variable two pulls resolve differently, is recorded under
`_conflicts` and as a `CONFLICT` line in `hygiene` — read those before generating a theme.

**Check the reference screenshot landed.** Every export renders one PNG per top-level frame and
points at it from a `reference` field holding a path relative to the export dir
(`assets/<id>_ref.png`). Where that field sits depends on the export: a single-screen pull puts it on
each node (`nodes[0].reference`), a page-walk layer file puts it at the root beside `tree`.
`build-screen` validates against it, so confirm the file exists. Only if `reference` is absent (the
manifest `warnings` will say so) ask the user to export a PNG by hand (Figma right-click → Export).

**Assets are named after their Figma layer and deduped by content.** `icons/linear/arrow-down` lands
as `arrow-down.svg`, not as a node-id path, and the same artwork reached through several instance
paths becomes one file with every node id recorded on it. Two different icons sharing a leaf name are
told apart by a short content hash, never by overwriting. Image *fills* are the one exception: they
carry a `hash` rather than a path, and the byte lands at `assets/img_<hash>.<ext>` —
`…__<id>.assets.json` indexes all of it, so read that instead of deriving the convention.

**A pull warns about assets too heavy to inline.** A flattened illustration exports as one SVG with
thousands of paths — the live run hit 2.47 MB, which inlined into a 2.71 MB JS bundle until it was
moved to a URL import. Import those by URL, or ask the designer to re-export as a PNG. Do not redraw
or simplify one yourself.

## Is this screen even from that design system?

Pulling the design system and then pulling a screen does **not** mean the two are related. Both may
be copies of one original, in which case names and values line up while every key differs; or the
screen may simply consume a library you never exported. That failure is invisible in either file
alone and produces a build that looks plausible and is themed from the wrong source.

One command answers it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cross-check.js" design/export/pages/<Page>/<Screen>__<id>.json \
  --design-system design/export/design-system
```

Run it after any pull that produced both, and report its blockers before offering to build. It reads
the screen's own `.vars.json` beside it, so a token collision is reported against the screen that
actually carries the colliding variable; a collision that belongs to another screen is only an
`info` note naming that screen — do not "fix" this screen's value to match it.

**`catalog-rekeyed` is not "wrong design system".** Duplicating a Figma file re-mints every component
key, so a copied design system matches its screens 0% by key while names and prop signatures still
agree. When that is what cross-check finds, it lists name + prop-signature matches under
`componentProposals` in its JSON (`--out design/audit/<screen>.cross` writes it), every one
`"confirmed": false`. Show the user that list — name, catalog id, evidence — and let them accept
entries; set `"confirmed": true` on the accepted ones, then
`node "${CLAUDE_PLUGIN_ROOT}/scripts/map-bootstrap.js" design/export/design-system/components.local.json --out design/codeconnect.local.json --from-proposals design/audit/<screen>.cross.json`
stubs exactly those, filed under the screen's own instance keys. Never confirm on the user's behalf:
the confirmation is the only thing that separates a real match from two components that share a name.
`/designtwin:audit-design` runs the same pass as part of its report; this is the standalone form for
when you have only just pulled.

## Tokens → a theme file the app can import

"Get me the colors" is not finished when the raw variables land — nothing in the app can import
those. Turn them into the stack's own theme file once, instead of re-mapping values on every screen.

**Choose the input by what the theme is for — the choice changes values, not just coverage:**

1. `design/export/design-system/tokens.json` when you pulled the design system — it is the library's
   own definition of every token, one variable per name.
2. Otherwise, the screen's own `design/export/pages/<Page>/<Screen>__<id>.vars.json` — the variables
   that screen's file references, so its names mean what that screen means.
3. `design/export/variables.json` (the union of every pull) only when you need every screen's tokens
   in one file, and then read its `_conflicts` first.

Why not the union by default: names repeat across screens' libraries. A union can hold two
`Space 4` — say 24 (the design system's) and 16 (one screen's local copy); a theme generated from the
union cannot give both screens the plain `space-4`, so each is emitted under its key
(`space-4-e26d506e`, `space-4-64928e3a`) and the screen that binds 24 must pick that one. Generated from
that screen's own `.vars.json`, it is simply `space-4: 24px`.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/tokens.js" design/export/design-system/tokens.json design/export/   # DTCG json + tokens.css + a tokens/ set dir
node "${CLAUDE_PLUGIN_ROOT}/scripts/tokens.js" design/export/design-system/tokens.json <css dir> --web tailwind
node "${CLAUDE_PLUGIN_ROOT}/scripts/tokens.js" design/export/design-system/tokens.json <theme dir> --native swiftui   # or compose | flutter | react-native
```

It writes more than a theme file: `tokens.dtcg.json`, `tokens.css`, `tokens.resolver.json` and a
`tokens/` directory of per-collection/per-mode set files — around 20 files for a real system. Point
it at a directory you are happy to have filled.

Pick the output by stack. `tokens.css` is plain `:root` custom properties — right for CSS Modules or
vanilla CSS, but **Tailwind generates no utilities from it**, so on Tailwind v4 use `--web tailwind`:
it writes `theme.css` (`@import "tailwindcss"` + an `@theme` block) with each variable under the
namespace that earns it a utility, inside a `figma-` sub-namespace — `--color-figma-*` → `bg-figma-…`/
`text-figma-…`, `--spacing-figma-*` → `p-figma-…`/`gap-figma-…`, `--radius-figma-*` → `rounded-figma-…`,
`--text-figma-*` → `text-figma-<size>` — and every non-default mode reassigning those properties in a
`[data-theme="…"]` block. The prefix is there because an `@theme` variable REPLACES Tailwind's own
of the same name: Figma's `XL` radius as `--radius-xl: 16px` silently turned every `rounded-xl` (12px)
in the project into 16px. So `rounded-xl` keeps Tailwind's meaning and the design's XL is
`rounded-figma-xl`. Import it as the app's entry CSS. Do not hand-write an
`@theme` block from bound token names: that is the per-screen re-mapping this step exists to stop.

**Read the warnings it prints.** Nothing is dropped any more, but one warning changes names: `N
different Figma variables share the name 'X' … resolve DIFFERENTLY` means both were emitted, each
suffixed with the first 8 characters of its key, and the warning lists each key's values and the
screens it came from. Pick the one the screen binds (by key, via the screen's `.vars.json`) — or
regenerate from that screen's own `.vars.json`, where the plain name usually survives. `… resolve
identically in every mode — emitted ONCE` and the rest — a name sanitised for CSS, a resolver file
renamed to avoid a collision — are informational.

The file is generated: say where it landed and how to wire it in (its header comment shows the one
line), don't hand-edit it, and re-run it after the next token pull. Variables only — text styles and
shadows are not emitted yet. If the project already has a theme file, do not add a second one beside
it; show the user the difference and ask which is the source of truth.

## Then hand off

Report briefly: what landed, anything the manifest flagged, whether the PNG exists, and any
cross-check blocker. Then **`/designtwin:audit-design <screen>`** to check the design is buildable
(missing states, contrast, touch targets, designer questions), and
**`/designtwin:build-screen <screen>`** to build it.

If something failed — bridge offline, `EADDRINUSE`, empty library list, 401 — the symptom→fix list is
the **help** skill's `references/troubleshooting.md`. Load it; don't debug from memory.
