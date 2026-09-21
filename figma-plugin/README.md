# Design Twin — plugin (main thread)

The plugin's read/extraction logic is written in **TypeScript** (`src/*.ts`) and bundled to
**`code.js`** — the file `manifest.json` loads as `main`. `code.js` is committed, so the plugin
imports into Figma with **zero build** for consumers. You only build when you edit `src/`.

## Layout

```
src/
  main.ts        entry: showUI, message + bridge wiring, test surface
  collect.ts     collectSelection / collectNode / collectFull / collectScreenshot (+ read options)
  serialize.ts   the recursive SceneNode -> compact JSON serializer
  paint.ts       fills & strokes (Paint union)
  effects.ts     shadows / blur / noise / glass / texture / shader (Effect union)
  layout.ts      auto-layout & grid -> flex/grid intent
  text.ts        TEXT / TEXT_PATH typography + styled-text runs
  variables.ts   design tokens, style refs, variable modes, boundVariables resolution
  prototype.ts   reactions / actions / transitions (the free interaction layer)
  components.ts   instances, component-prop refs/overrides, whole-file design-system catalog
  assets.ts      vector/icon -> SVG, image -> PNG, reference PNG (whole-frame + on-demand single-node), dev-resource links
  writes.ts      minimal, explicit, no-eval write ops (code -> design)
  state.ts       per-run mutable state + id->name memo caches + read options
  progress.ts    export progress frames + the cancellation flag/error (main thread -> ui.html)
  util.ts        pure helpers (hex, base64, rounding)
figma-augment.d.ts  local typing shims for API newer than the pinned typings (empty by default)
build.js         esbuild bundle script
```

## Dev Mode

The manifest's `editorType` is `["figma", "dev"]`, so the plugin also appears in **Dev Mode's** plugin
list — where the developers who consume the export actually work. Every read and export works there.
Dev Mode is read-only for plugins, so the MCP `figma_write` ops are refused with a message to switch
to Design mode (`applyWrites` in `src/writes.ts`). After pulling this change, **re-import the plugin
from its manifest** — Figma reads `editorType` only at import.

## Develop

```sh
npm install          # @figma/plugin-typings + esbuild + typescript
npm run typecheck    # tsc --noEmit  (the whole point: catches property-name / mixed / null bugs)
npm run build        # esbuild src/main.ts -> code.js  (commit the result)
npm run watch        # rebuild on save
```

Then in Figma: **Plugins → Development → Import plugin from manifest…** → `manifest.json`.
After a rebuild, close & reopen the plugin window (a stale window runs stale `code.js`).

## Type-safety notes

- `tsconfig.json` omits `"dom"` from `lib` on purpose — the plugin main thread has no browser
  globals, and `@figma/plugin-typings` ships its own narrow `console`/`fetch`/timers.
- The Figma globals (`figma`, `__html__`, `RGB`, …) are loaded via `"types": ["@figma/plugin-typings"]`
  with **no explicit `typeRoots`** — bundler module resolution then finds the scoped package. Don't
  switch this back to `typeRoots: ["./node_modules/@figma"]`: the TypeScript 7 native compiler no
  longer auto-includes packages found that way, so the globals would go missing (`Cannot find name
  'figma'`). Adding an explicit `typeRoots` alongside `types` also breaks it (`TS2688`).
- The serializer reads across the whole `SceneNode` union with `"x" in node` guards, so it types
  `node` broadly and uses `(node as any)` for dynamic-key loops and beta props; the **value-level**
  typing (Paint/Effect/text/variable shapes) lives in the helper modules, which is where the
  historical silent-drop bugs actually were.

## Progress & cancel

A whole-file (`allPages`) pull can run 10+ minutes, so every **queued** run — manual *and*
bridge-triggered — is bracketed by `serializeRun` (`src/state.ts`) and reports itself to `ui.html`:

| main → UI | when |
| --- | --- |
| `{type:"run-begin", source:"ui"\|"bridge", label}` | the run actually starts executing (not when it was queued) |
| `{type:"progress", phase:"pages"\|"assets"\|"design-system", source, label, page:{index,of,name,pageId}, nodes, assets}` | page boundaries + phase changes (unthrottled) and at most every ~250ms within a page |
| `{type:"run-end"}` | success, failure or cancellation alike |
| `{type:"cancel-ack", accepted, label}` | answer to a Cancel click (`accepted:false` = nothing was running) |

| UI → main | |
| --- | --- |
| `{type:"cancel"}` | the Cancel button |

`source:"bridge"` is what lets a designer see that a CLI/MCP pull — and which command — is walking
their file, and stop it. Cancelling only **sets a flag**: an in-flight `exportAsync` cannot be
interrupted, so the walk aborts itself at its next safe point (between pages, between top-level
frames, at each per-node asset export) by throwing `progress.ts`'s cancellation error. That throw is
the guarantee no partial export is ever delivered as a complete one; on a bridge-triggered run it
rides out as `bridge-result.error` so the CLI/MCP **fails fast** instead of waiting out its timeout.
The flag is cleared at the *start* of every run, so a stale cancel cannot kill the next export.

## Read options (opt-in)

`collectFull` / `collectSelection` / `collectNode` accept `{ css?, measurements?, pluginData?, motion?, sharedData?, variantVisuals? }`:

- **`css`** — Figma's own computed CSS per node (`getCSSAsync`), the design-to-code oracle. One
  async call **per node**, so it stays opt-in for large/full exports — but it **auto-enables** for a
  single-node or small (≤60-node) selection (the "inspect one component" path), where the cost is
  negligible. An explicit `css: true`/`false` always wins over the auto-behavior.
- **`measurements`** — Dev-Mode measurement redlines for the current page (`getMeasurements`, sync).
- **`pluginData`** — own-scope `getPluginData` stamped on nodes (round-trip metadata).
- **`motion`** — motion/animation reads (timelines, manual keyframe tracks, animations, applied styles).
- **`sharedData`** — cross-plugin shared data (`getSharedPluginData`), notably **Tokens Studio** applied
  tokens — the semantic token layer on files without native Figma Variables.
- **`variantVisuals`** — walks each `COMPONENT_SET`'s variant children (design-system pull only) and
  attaches `entry.variants[]` with each variant's real `layout`/`fills`/`radius`/`tokens`/`css` — the
  master-component source of truth, not the set wrapper's own selection-chrome visuals. A standalone
  `COMPONENT` (not inside a set) gets the same walk and its tree attached as `entry.node` instead. One
  node walk per variant/component, so it's slower on large systems; off by default.

`inferredVariables` token suggestions (for fields with no explicit binding) are always on. Image
`intrinsicSize` + original source bytes (`getImageByHash`) and parametric shape reads (ellipse
`arc`, star/polygon `shape`, `booleanOp`) are always on. Every `INSTANCE` also emits `mainComponent`
(`{name,id,key,remote,setId,setKey,setName,variant}`) alongside the unchanged `component` name string —
the join key back to the component catalog — always on, no flag. Reachable from the bridge: MCP tool
args (`css`/`measurements`/`pluginData`/`motion`/`sharedData`/`variantVisuals`) and the `figma-pull`
CLI flags (`--css` / `--measurements` / `--plugin-data` / `--motion` / `--shared-data` / `--variant-visuals`).

## The plugin window

- **Follows Figma's theme.** `showUI` passes `themeColors: true` and `ui.html` takes every color from
  Figma's `--figma-color-*` variables (the old light literals are only `var()` fallbacks).
- **Exporting by hand needs no setup.** The connection controls live in a collapsed **Connect to
  Claude Code (optional)** section; the pill in its header shows the state without opening it:
  `not set up` · `connecting…` · `connected` · `waiting` (the bridge went away — normal after a
  one-shot pull) · `not running` (every allowed port tried, nothing answered) · `token rejected`
  (red; the section opens itself and says to run `dtwin --show-token`).
- **Why "token rejected" is possible at all:** a browser socket cannot read an HTTP 401, so the bridge
  admits the plugin's iframe just long enough to close it with code `4401` — see `admit` in
  `bridge/server-core.js`. It is never registered as a client.
- `test/ui.test.js` runs `ui.html`'s script against a fake DOM + WebSocket and covers these states.

