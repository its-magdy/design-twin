# Export layout — what lands on disk, and which file to open

Read this when you need to **find** something: which file holds the tokens, where a page's layers
live, how a browser-downloaded export differs from a CLI one.
For what the fields on a node mean once you've opened it, see `ir-fields.md`.

## `design/export/` is dtwin's; the rest of `design/` is yours

Everything a pull writes lands under `design/export/` and nowhere else — so that directory can be
deleted and re-pulled without taking `design/target.json`, `design/codeconnect.local.json`,
`design/plan/`, `design/audit/` or `design/verify/` with it. Those are decisions and evidence, and
none of them is regenerable. `design/README.md` (written by `dtwin init`) says the same where someone
about to delete files will see it.

A project created before this split keeps its export directly in `design/`. Every path below works
either way — drop the `export/` segment — and `dtwin doctor` reports which layout it found.

## Contents
- [Read the manifest first](#read-the-manifest-first)
- [`design-system.json` + `design-system/`](#design-systemjson--design-system)
- [`libraries/` — a separately pulled LIBRARY file](#libraries--a-separately-pulled-library-file)
- [`pages/index.json` — finding a screen](#pagesindexjson--finding-a-screen)
- [Browser "Download layers" flat naming](#browser-download-layers-flat-naming)
- [Single-screen exports, assets, config maps](#single-screen-exports-assets-config-maps)

## Read the manifest first

Every export doc has a **`manifest`** (`nodes`/`skipped`/`truncated`/`assetsFailed`/`warnings`).
**Read it before building** — if anything was truncated or an asset failed, tell the user rather than
shipping a silently-incomplete screen.

## `design-system.json` + `design-system/`

`design/export/design-system.json` is a slim MANIFEST (`exportedAt`/`file`/`colorProfile`, a `files` pointer
map, `counts`). The catalog itself is split under `design/export/design-system/`, one file per Figma concept,
so you load only the part you need. **Read the part(s) you need early** — after the manifest gate
above — to learn the system before building.

- **`design-system/tokens.json`** — `collections` (Figma's variable collections, each with its
  `modes`) + `variables` (each with `tier` primitive/semantic, `scopes`, and `codeSyntax`
  `{WEB,ANDROID,iOS}` when the designer set it — prefer that platform string over hand-mapping).
  A variable's `values` is keyed by mode: each is a hex/number, or `{aliasOf:"other/token"}` — a
  semantic token pointing at a primitive. Follow the alias to get the value; keep the SEMANTIC name
  as the token you map to code.
- **`design-system/styles.paint.json`** / `styles.text.json` / `styles.effect.json` /
  `styles.grid.json` — one file per style type, each holding its `styles` array. Figma's style system
  is SEPARATE from variables; a style can bind variables into its fields, but it is its own object.
- **`design-system/components.local.json`** — the `components` catalog for components that really
  live in this file, each prop `{key,type,options,default}` (`options` = a variant's states). Each
  entry also carries `visuals: {fills,strokes,effects,radius,opacity,blendMode}` — the
  component/variant NODE's own base paint (not a specific instance's overrides, and a variant SET's
  `visuals` is the set node's own paint, not per-variant).

  A `COMPONENT_SET` entry's `variants[]` keeps only `id`/`name`/`key`/`values` here — its real
  per-variant node trees (opt-in `--variant-visuals`) are split into a sibling
  `design-system/components/<name>__<id>.json`, pointed at by the entry's `variantsFile` (absent when
  nothing was exported for that set). A standalone `COMPONENT` (not inside a set) gets the same
  treatment under `--variant-visuals`, but its own node tree is pointed at by `nodeFile` on the entry
  instead (no `variants[]` to hang it off of).

  Only load that file for a component you're actually building. Resolve one entry and follow either
  pointer with the **`design_get_component`** MCP tool (`{handle:"<key|id|name>"}` — no Figma connection
  needed, it reads the export on disk), or on the command line:
  ```
  node "${CLAUDE_PLUGIN_ROOT}/scripts/get-component.js" design/export/design-system/components.local.json <key|id|name>
  ```
- **`design-system/components.library.json`** — the same shape for components consumed from a
  published LIBRARY (`remote: true`). These are recovered by walking instances, so their props are a
  SAMPLE of what this file uses, not the component's full API — don't treat an absent prop as
  nonexistent.
- **`design-system/hygiene.json`** — `hygiene`, design-system smells at the CATALOG level: variables
  with ALL_SCOPES, semantic variables holding raw values, broken aliases, variant explosion (>30
  combos), unnamed/duplicate components. It does **not** check whether individual nodes use unbound
  raw values — `node "${CLAUDE_PLUGIN_ROOT}/scripts/audit.js"` (the audit-design skill) does that per screen.
- **`design/audit/<screen>.{md,json}`** — the pre-build audit, if one was run (`/designtwin:audit-design`):
  verdict, findings, component state coverage, designer questions and the defaults assumed.

## `libraries/` — a separately pulled LIBRARY file

`design/export/libraries/index.json` is **optional, present only if a LIBRARY file was pulled separately**
(`figma-pull --as-library`). Each row points at `libraries/<slug>-<fileKey8>/index.json`, whose
`tokens.json` / `styles.*.json` / `components.json` have the SAME shape as their `design-system/`
twins. Use it as a **secondary lookup, never as the codegen source**:

- **Generate from `design-system/`.** It holds the subset this design file actually references.
  Emitting from a library catalog ships every unused primitive in the library.
- **Consult the library catalog to resolve gaps.** It is the authority on what a token family really
  contains and on a component's REAL props — `components.library.json` above only samples the props
  the instances in this file happen to use.
- **Join on `key`, never on names.** `key` is durable cross-file identity; collection and variable
  names collide across libraries.
- Each entry carries `publish: current | changed | unpublished`. Prefer `current`; treat
  `unpublished` as a draft consumers cannot use yet, and say so rather than silently building on it.

## `pages/index.json` — finding a screen

`design/export/pages/index.json` is the root, run-wide manifest + a lean `pageDirs[]`
(`{page,pageId,dir,index,layers}`, where `index` points at that page's own index file — NOT the full
layer list).

- `page` is the display name and is **not unique** — Figma allows two pages with the same name. If a
  name matches more than one entry, tell them apart by `pageId` (the stable Figma page id), never by
  the disambiguating suffix on `dir`.
- Flow: find the Figma PAGE you want → open its `index` (its `layers[]`: names/ids, each with a
  `file` pointer) → read ONLY that layer's file.
- **Both `index` and `file` are already relative to the export dir.** The path to open is
  `design/export/<pointer>` — do NOT prepend `pages/<dir>/` a second time, and do not reassemble
  either path from `dir` (that only works on the CLI layout, not the browser-download one).
- **How a name becomes a filename.** Every path segment is sanitised: each run of characters that is
  not a letter or a digit becomes one `_`. Real Figma names make that visible — a page named `✅ Team space ` (emoji,
  trailing space) files under `__Team_space_`, a frame whose name ends in a space gains a trailing
  `_`, and pages literally named `---` or `-` turn up more often than you would expect. The names in the INDEX are the
  real ones; the directory and file names are a filesystem artefact. Two more consequences: distinct
  names that fold alike get a `_2` suffix rather than sharing a directory, and page identity is
  `pageId`, never the page name (Figma places no uniqueness constraint on page names).
  Asset filenames keep the hyphen — it is the commonest character in an icon name — so they read
  `arrow-down.svg`, not `arrow_down.svg`.
- **Single screens live here too.** A `--node`/selection pull files into the same tree, at
  `pages/<Page>/<Screen>__<node-id>.json`, and adds a row to these indexes as it goes. The node id is
  in the filename because a frame NAME does not identify a frame: two `Popup`s on one page are two
  screens, and a name ending in a space sanitises to a trailing `_`. Read the index; never
  reconstruct a filename from a screen name.

Split per-page, per-file (not bundled into one JSON, and not dumped flat across every page)
specifically so you never have to load every OTHER page's — or layer's — data to build one.

"Layer" is Figma's own term for any top-level node swept off a page (its Layers-panel vocabulary; a
page can hold many); "screen" stays reserved for a single node YOU deliberately select.

**Missing screen → STOP.** If the requested screen/layer isn't in its page's index `layers[]` (or its
JSON is missing/empty), ask — don't guess or build from the `.png` alone.

## Browser "Download layers" flat naming

If the export came from the plugin's **Download layers** button instead of the `figma-pull` CLI, the
same files arrive FLAT with `__` where the CLI writes `/`:
`pages__<dir>__<name>__<id>.json`, `pages__<dir>__index.json`, `pages__index.json`.

Browsers are required to strip directory information from a download, so the hierarchy is encoded in
the filename. Each `file` pointer already matches what landed on disk, so **the rule is unchanged**:
open `design/<file>` verbatim, whichever layout you're looking at. Either re-nest them into
`design/export/pages/…` or just follow the pointers.

## Single-screen exports, assets, config maps

- `design/export/pages/<Page>/<Screen>__<id>.json` — a single screen exported on its own, from
  `--node <id>` or a selection. Root keys are `exportedAt`, `screen` (the human label), `page`,
  `pageId`, `nodeId`, `nodes[]` (the trees, same shape as a layer file's `tree`) and `manifest`.
  It writes three siblings and one shared file:
  - `…__<id>.vars.json` — exactly the variables THIS screen binds, verbatim, as this pull saw them.
  - `…__<id>.assets.json` — every asset the screen references, with a content hash per file, plus
    `duplicates` (byte-identical files under different names), `monochrome` (SVGs whose every
    fill/stroke is one colour — the ones safe to recolour to `currentColor` at render time) and
    `heavy` (too large to inline).
  - a row in `pages/<Page>/index.json` and `pages/index.json`.
  - `design/export/variables.json` — the **union** of every screen pulled into this directory. It
    accumulates: a second pull merges into it, keyed on each variable's Figma key, so an earlier
    screen's tokens survive. Two screens that resolve one variable differently leave a `_conflicts`
    entry and a `hygiene` line; read those before generating a theme.

  A single-screen pull does **not** write `design/export/design-system/`.
- The reference PNG is rendered **above 1x** (a 1440x1100 frame came back 2048x1565, ~1.42x) — the
  scale is chosen to fit a pixel budget, so it is not a round number and not worth assuming. Read the
  image's real dimensions and compare against `box.w`/`box.h` rather than treating the PNG's pixels as
  layout units (px / pt / dp — Figma px at 1x, whatever your stack calls them).
- The reference screenshot (visual ground truth) — held by the `reference` field — **`nodes[0].reference` in a single-screen
  `design/<screen>.json`** (the field sits on the node, and there is one per exported node), or the
  **root `reference`** of a page-walk layer file (`design/export/pages/<page>/<name>__<id>.json`, where it
  sits beside `tree`), as a path relative to
  `design/` (e.g. `assets/<id>_ref.png`). A hand-exported `design/<screen>.png` is the fallback when
  the field is genuinely absent — not when you looked in the other file's place for it. **Always read it** — JSON gives exact values, the image
  tells you if the result *looks* right.
- `design/export/assets/*` — real SVG/PNG icons/images referenced by `asset` fields. Never redraw an
  icon. Files are named after their Figma layer's last path segment (`icons/linear/arrow-down` →
  `arrow-down.svg`), and identical artwork reached through several instance paths is ONE file with
  every node id recorded on it. Two different icons whose names collide are told apart by a short
  content hash (`arrow-down-3f1a9c.svg`), never by overwriting. Image *fills* are the exception: a fill
  carries a `hash`, not a path, and the byte lands at `assets/img_<hash>.<ext>` — the screen's
  `.assets.json` indexes all of it, so read that rather than re-deriving the convention.
  The filename is the PRODUCER's: never rename a file inside `design/export/assets/`, because that
  name is how a re-pull knows which icon changed.
- <a id="heavy-vector-assets"></a>**Some exported SVGs are flattened textures, and every stack suffers
  for it.** Figma has no vector primitive for a noise/grain/scatter effect, so on SVG export it
  approximates one by emitting *thousands of individual `<path>` elements* — one real illustration
  came back as 1523 paths and 2.4 MB for a 239x215 graphic. Nothing is wrong with the export: it
  asked Figma for the format that node's own `exportSettings` named, and got a faithful answer. The
  cost lands at render time, wherever that is. Every renderer shades and antialiases each path
  independently, so the result looks visibly speckled next to Figma's own canvas (and next to the
  reference PNG, which is a raster of that canvas), and a few thousand paths is slow to parse and
  draw on *any* platform's vector pipeline — see your profile's **Assets** section for what it costs
  there specifically.

  Spot it before you build, not after you render: `grep -c '<path' design/export/assets/<id>.svg` in the
  hundreds-plus, or an SVG over ~200 KB, is the whole tell. The fix is on the **design side** — the
  designer rasterises that layer, or sets the node's `exportSettings` to PNG, and you re-pull.
  Do not redraw the illustration, do not hand-simplify the paths, and do not chase the speckle with
  a blur or an opacity tweak in your own stack: all three replace a faithful asset with a guess, and
  the next re-pull silently undoes them. Report it as a real visual difference and say what it is.
- `design/tokens.dtcg.json` — Figma variables emitted as W3C DTCG tokens (`node "${CLAUDE_PLUGIN_ROOT}/scripts/tokens.js" <design/export/design-system/tokens.json or design/export/variables.json> design/`;
  add `--web tailwind` for a Tailwind v4 `theme.css`, `--native <profile>` for a native token file),
  with `design/tokens.json` as the hand-written override layer: Figma variable/value → **your** code
  token, in the form your target uses.
- `design/codeconnect.local.json` — Figma component → **your** code component +
  import path, keyed by the component's stable publish **`key`** so a rename in Figma can't silently
  unmap it. Scaffold from the Figma side with `node "${CLAUDE_PLUGIN_ROOT}/scripts/map-bootstrap.js" design/export/design-system/components.local.json --out design/codeconnect.local.json`, or auto-seed the code
  side from **Code Connect files** in the repo with `node bridge/seed-components.js`. Check it with
  the **`design_drift_lint`** MCP tool before building. If it's missing/thin, offer to run those.
  *(Older projects keep this file at the repo ROOT; `dtwin doctor` finds either and says which. A
  legacy `design/components.json` keyed by component NAME also exists in some projects; it cannot
  detect drift, so prefer `design/codeconnect.local.json` where both are present.)*
- `design/export/variables.json` — full Figma variable snapshot (for the drift check).
- `design/target.json` — the target stack config (optional; auto-detected if absent).
- `profiles/<profile>.md` — how to translate the IR into a specific stack. A project can override or
  add one by placing `profiles/<profile>.md` at its own repo root; **check there first**, fall back to
  this skill's bundled `profiles/`.
