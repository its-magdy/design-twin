# Export layout — what lands in `design/`, and which file to open

Read this when you need to **find** something: which file holds the tokens, where a page's layers
live, how a browser-downloaded export differs from a CLI one.
For what the fields on a node mean once you've opened it, see `ir-fields.md`.

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

`design/design-system.json` is a slim MANIFEST (`exportedAt`/`file`/`colorProfile`, a `files` pointer
map, `counts`). The catalog itself is split under `design/design-system/`, one file per Figma concept,
so you load only the part you need. **Read the part(s) you need early** — after the manifest gate
above — to learn the system before building.

- **`design-system/tokens.json`** — `collections` (Figma's variable collections, each with its
  `modes`) + `variables` (each with `tier` primitive/semantic, `scopes`, and `codeSyntax`
  `{WEB,ANDROID,iOS}` when the designer set it — prefer that platform string over hand-mapping).
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

  Only load that file for a component you're actually building; resolve one entry and follow either
  pointer with:
  ```
  node tooling/get-component.js design/design-system/components.local.json <key|id|name>
  ```
- **`design-system/components.library.json`** — the same shape for components consumed from a
  published LIBRARY (`remote: true`). These are recovered by walking instances, so their props are a
  SAMPLE of what this file uses, not the component's full API — don't treat an absent prop as
  nonexistent.
- **`design-system/hygiene.json`** — `hygiene`, design-system smells (unbound values, variant
  explosion, broken aliases).

## `libraries/` — a separately pulled LIBRARY file

`design/libraries/index.json` is **optional, present only if a LIBRARY file was pulled separately**
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

`design/pages/index.json` is the root, run-wide manifest + a lean `pageDirs[]`
(`{page,pageId,dir,index,layers}`, where `index` points at that page's own index file — NOT the full
layer list).

- `page` is the display name and is **not unique** — Figma allows two pages with the same name. If a
  name matches more than one entry, tell them apart by `pageId` (the stable Figma page id), never by
  the disambiguating suffix on `dir`.
- Flow: find the Figma PAGE you want → open `design/<index>` for that page (its `layers[]`:
  names/ids, each with a `file` pointer) → read ONLY that layer's file.
- **Both `index` and `file` are already relative to `design/`.** The path to open is
  `design/<pointer>` — do NOT prepend `pages/<dir>/` a second time, and do not reassemble either path
  from `dir` (that only works on the CLI layout, not the browser-download one).

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
`design/pages/…` or just follow the pointers.

## Single-screen exports, assets, config maps

- `design/<screen>.json` — a single screen exported on its own (same tree shape), when not using
  `design/pages/`.
- `design/<screen>.png` — reference screenshot (visual ground truth). **Always read it** — JSON gives
  exact values, the image tells you if the result *looks* right.
- `design/assets/*` — real SVG/PNG icons/images referenced by `asset` fields. Never redraw an icon.
- `design/tokens.json` — Figma variable/value → **your** code token (in the form your target uses).
- `design/components.json` — Figma component name → **your** code component + import path. Can be
  **auto-seeded from Code Connect files** in the repo: `node bridge/seed-components.js` (fills
  `component` + `source` + `nodeId`; you add `import`/`props`). If it's missing/thin, offer to run it.
- `design/variables.json` — full Figma variable snapshot (for the drift check).
- `design/target.json` — the target stack config (optional; auto-detected if absent).
- `profiles/<profile>.md` — how to translate the IR into a specific stack. A project can override or
  add one by placing `profiles/<profile>.md` at its own repo root; **check there first**, fall back to
  this skill's bundled `profiles/`.
