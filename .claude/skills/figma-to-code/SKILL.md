---
name: figma-to-code
description: Build a front-end screen as code from a Figma export, for ANY stack (React/Tailwind, CSS Modules, React Native, SwiftUI, Jetpack Compose, or a custom target). Use when the user asks to implement/build a screen from a design/<screen>.json export (from the "Design Export for AI" plugin) or points at a Figma export. Resolves the target stack, reads the compacted node JSON + assets + token/component maps, generates the component, then self-corrects against the reference screenshot.
---

# Figma → code (any stack)

Turn a Figma export into a faithful, maintainable screen for whatever stack the project uses.
Free-plan workflow: the design data comes from the local **Design Export for AI** plugin (no Figma
API, no MCP), saved into `design/`. The export JSON is a **stack-neutral intermediate representation
(IR)**; this skill translates it into the project's actual framework via a target *profile*.

## Inputs (in the repo)
- `design/design-system.json` — a slim MANIFEST (`exportedAt`/`file`/`colorProfile`, a `files` pointer
  map, `counts`). The catalog itself is split under `design/design-system/`, one file per Figma
  concept, so you load only the part you need. **Read the part(s) you need early** (after the manifest
  gate below) to learn the system before building:
  - `design-system/tokens.json` — `collections` (Figma's variable collections, each with its `modes`)
    + `variables` (each with `tier` primitive/semantic, `scopes`, and `codeSyntax` `{WEB,ANDROID,iOS}`
    when the designer set it — prefer that platform string over hand-mapping).
  - `design-system/styles.paint.json` / `styles.text.json` / `styles.effect.json` / `styles.grid.json`
    — one file per style type, each holding its `styles` array. Figma's style system is SEPARATE from
    variables; a style can bind variables into its fields, but it is its own object.
  - `design-system/components.local.json` — the `components` catalog for components that really live
    in this file, each prop `{key,type,options,default}` (`options` = a variant's states).
  - `design-system/components.library.json` — the same shape for components consumed from a published
    LIBRARY (`remote: true`). These are recovered by walking instances, so their props are a SAMPLE of
    what this file uses, not the component's full API — don't treat an absent prop as nonexistent.
  - `design-system/hygiene.json` — `hygiene`, design-system smells (unbound values, variant explosion,
    broken aliases).
- `design/libraries/index.json` — **optional, present only if a LIBRARY file was pulled separately**
  (`figma-pull --as-library`). Each row points at `libraries/<slug>-<fileKey8>/index.json`, whose
  `tokens.json` / `styles.*.json` / `components.json` have the SAME shape as their `design-system/`
  twins. Use it as a **secondary lookup, never as the codegen source**:
  - **Generate from `design-system/`.** It holds the subset this design file actually references.
    Emitting from a library catalog ships every unused primitive in the library.
  - **Consult the library catalog to resolve gaps.** It is the authority on what a token family really
    contains and on a component's REAL props — `components.library.json` above only samples the props
    the instances in this file happen to use, and the library catalog has the full definitions.
  - **Join on `key`, never on names.** `key` is durable cross-file identity; collection and variable
    names collide across libraries.
  - Each entry carries `publish: current | changed | unpublished`. Prefer `current`; treat
    `unpublished` as a draft that consumers cannot use yet, and say so rather than silently building on it.
- `design/pages/index.json` — the root, run-wide manifest + a lean `pageDirs[]` (`{page,pageId,dir,index,layers}`, where `index` points at that page's own index file —
  NOT the full layer list). `page` is the display name and is **not unique** — Figma allows two pages
  with the same name, so if a name matches more than one entry, tell them apart by `pageId` (the stable
  Figma page id) rather than by the disambiguating suffix on `dir`. Use it to find the Figma PAGE you want, then open `design/<index>` for that
  page (its `layers[]`: names/ids, each with a `file` pointer) to pick the one you want, then read ONLY
  that file. **Both `index` and `file` are already relative to `design/`**, so the path to open is
  `design/<pointer>` — do NOT prepend `pages/<dir>/` a second time, and do not reassemble either path
  from `dir` (that only works on the CLI layout, not the browser-download one). Split
  per-page, per-file (not bundled into one JSON, and not dumped flat across every page) specifically so
  you never have to load every OTHER page's — or layer's — data to build one. "Layer" is Figma's own
  term for any top-level node swept off a page (its Layers-panel vocabulary; a page can hold many);
  "screen" stays reserved below for a single node YOU deliberately select.
- **Node `tree` may carry** (all optional): `reactions` (prototype interactions — trigger + navigation
  + transition/easing, incl. `set_variable`/`set_variable_mode`/`conditional` actions → wire real
  navigation + state, not a dead button), `scroll`/`clip` (scroll container vs fixed), `sizeLimits`/`pin`
  (responsive), `runs` (mixed-format text — render each run; may carry `textStyle`/`fillStyle`/`openType`/`indent`),
  `layout.inferred` (flex inferred from a non-auto-layout frame — trust it but sanity-check against the `.png`),
  `box`/`renderBox` (resolved page-space pixel size — the ground-truth dimensions for auto-layout/grid
  children that have no `x`/`y`), `variableModes` (this subtree is pinned to a theme mode, e.g. Dark →
  emit under that theme), `resolvedModes` (root only — the **effective** theme inherited from the page/
  ancestor; use it when a single-node export has no `variableModes` of its own, or you'll build the Light
  variant of a Dark design), `overlay` (frame is a modal/popover — position/scrim/close-on-click-outside),
  `strokesInLayout` (border-box), `aspectRatio`/`cornerSmoothing`/`maskType`, `propRefs`/`overrides`
  (prop-driven layers), `detachedFrom` (was detached from a component — map it back), `tableCells`
  (a table's cell grid), `missingFont` (Figma is substituting a fallback — the recorded `font.family`
  may not match the render; pin a webfont or flag it), `css` (Figma's own computed CSS for the node when
  present — a strong hint, but reconcile against tokens rather than pasting verbatim), `devResources`
  (designer's linked Jira/Storybook/GitHub URLs — handoff context).
  - `layout.display:"grid"` with `columns`/`rows`/`columnGap`/`rowGap`/`columnSizes`/`rowSizes`
    (per-track `{type,value}`, `type` one of `flex`/`fixed`/`hug`)/`autoFlow`/`autoTracks` on the
    container, and per-child `gridColumnSpan`/`gridRowSpan`/`gridColumnStart`/`gridRowStart`/
    `gridJustifySelf`/`gridAlignSelf` (`start`/`center`/`end`) — see the profile's Grid section.
  - `clip:true` (Figma `clipsContent`) + `layout.scroll` (Figma `overflowDirection`, values
    `horizontal`/`vertical`/`both`) → overflow handling. `fixedChildren` **if present** (a count of
    leading children pinned while the rest scrolls — sticky headers/footers/FABs) → `position:sticky`/
    `fixed` on those children, not plain flow.
  - `flows` (top-level in the full export: `{page, pageId, nodeId, name}` per prototype entry point —
    distinct from per-node `reactions`) → candidate
    top-level routes/screens; a `reactions` entry with `navigation` → route change (SPA nav / deep link),
    `overlay` → modal/sheet component, `set_variable`/`set_variable_mode` → local state / theme toggle.
    Ignore purely presentational triggers you can't action (e.g. `mediaHitTime` scrub points) rather than
    guessing.
  - `layoutGrids`, `measurements` (Dev-Mode redline `start`/`end`/`offset`/`text`), `devStatus`/
    `devStatusNote`, `devResources` are **implementation hints for you, the agent** — never render them
    as UI. `layoutGrids` informs the responsive column structure you choose; `measurements` cross-checks
    spacing values you already have from `layout`/`box`.
  - `exposedInstances`, `propRefs`, `overrides`, `detachedFrom` → before writing new markup for an
    instance's sublayer, check whether it's prop-driven (`propRefs`) or instance-overridden (`overrides`)
    and map that back onto the **existing** mapped component's props/variants rather than hand-building
    the divergence. `detachedFrom` (`{key}` or `{componentId}`) means the node used to be an instance —
    look that component up in `components.json` and reuse it unless the detach was clearly intentional.
  - `effects[].type` incl. `noise`/`glass`/`texture`/`shader` and `background_blur` (backdrop) vs
    `layer_blur` (foreground) → CSS `backdrop-filter: blur()` for `background_blur`, `filter: blur()` for
    `layer_blur`. `noise`/`glass`/`texture`/`shader` have no direct CSS equivalent — approximate simple
    cases (a subtle `noise` as a repeating SVG/PNG grain overlay) but **rasterize via the exported asset**
    when the effect is load-bearing to the look; don't invent a shader.
  - `truncate:true` (Figma `ENDING` truncation) → `text-overflow:ellipsis` + `white-space:nowrap`/
    `overflow:hidden` (or `-webkit-line-clamp` when paired with `maxLines`); `maxLines:N` → line-clamp to
    N lines; `autoResize` (`width_and_height`/`height`/`truncate`/`none`) → whether the box should
    hug/wrap or clip. **Figma's own line breaks are not authoritative** — Figma uses a different text
    engine than browsers, so don't copy manual `\n` placement as gospel; let the real text wrap and only
    honor an explicit line break if it looks intentional (e.g. a short heading) against the `.png`.
  - `intrinsicSize` (on image fills, `{w,h}`) → the image's natural aspect ratio; use it for
    `aspect-ratio`/placeholder sizing so layout doesn't jump before the asset loads.
  - `blendMode` (lowercased CSS blend mode name) → `mix-blend-mode`; `rotation` (radians) → `transform:
    rotate()`; `flipped` (mirrored via a negative-determinant transform) → `transform: scaleX(-1)` (or Y,
    check which axis via the `.png`); `skew` → `transform: skewX()`, in DEGREES (unlike `rotation`).
  - A `geometry` field on a vector-shaped node (`fills`/`strokes`: arrays of SVG path `d` strings, plus
    `w`/`h`) means that node's SVG export failed and there is NO asset file for it — render the paths as
    an inline SVG (`<svg viewBox="0 0 w h"><path d="..."/></svg>`) rather than recreating the shape in CSS.
- **Interaction states.** Before shipping any interactive element (button, input, link, row), check
  `design/design-system/components.local.json`'s (or `components.library.json`'s) `components` catalog
  for that component's variant `options` — hover/
  focus/disabled/error/selected states are usually modeled as variant values, not separate nodes. Focus
  states are the most commonly missed and are an accessibility regression (keyboard-only users lose their
  place) — always implement a visible `:focus-visible` style even when the design only shows hover.
- **If the export came from the plugin's "Download layers" button instead of the figma-pull CLI**, the
  same files arrive FLAT with `__` where the CLI writes `/` (`pages__<dir>__<name>__<id>.json`,
  `pages__<dir>__index.json`, `pages__index.json`) — browsers are required to strip directory
  information from a download, so the hierarchy is encoded in the filename. Each `file` pointer already
  matches what landed on disk, so the rule is unchanged: open `design/<file>` verbatim, whichever
  layout you're looking at. Either re-nest them into `design/pages/…` or just follow the pointers.
- Every export doc has a **`manifest`** (`nodes`/`skipped`/`truncated`/`assetsFailed`/`warnings`).
  **Read it first** — if anything was truncated or an asset failed, tell the user before building rather
  than shipping a silently-incomplete screen.
- `design/<screen>.json` — a single screen exported on its own (same tree shape), when not using `design/pages/`.
- `design/<screen>.png` — reference screenshot (visual ground truth). **Always read it** — JSON gives
  exact values, the image tells you if the result *looks* right.
- `design/assets/*` — real SVG/PNG icons/images referenced by `asset` fields. Never redraw an icon.
- `design/tokens.json` — Figma variable/value → **your** code token (in the form your target uses).
- `design/components.json` — Figma component name → **your** code component + import path. Can be
  **auto-seeded from Code Connect files** in the repo: `node bridge/seed-components.js` (fills `component`
  + `source` + `nodeId`; you add `import`/`props`). If it's missing/thin, offer to run it.
- `design/variables.json` — full Figma variable snapshot (for the drift check).
- `design/target.json` — the target stack config (optional; auto-detected if absent).
- `profiles/<profile>.md` — how to translate the IR into a specific stack.

## Procedure

**Treat the export as a reference for intent + exact values, not a spec to transcribe** — adapt it to
the target's language, framework, component library, and conventions; match the surrounding code.

**Hint priority — when multiple sources describe the same node, earlier wins:**
1. `components.json` mapping → use the mapped code component directly (pass `props`/variants through).
2. Node `name` / annotations / designer notes in the IR → follow as constraints.
3. Bound `tokens` (via `tokens.json`) → the project's token system.
4. Raw `fills`/hex + `layout.mode:"absolute"` coords → loosely structured; treat as intent, lean on the screenshot.

0. **Resolve the target.**
   - If `design/target.json` exists, use its `profile`.
   - Else **auto-detect** from the repo: `package.json` deps (`react-native` → react-native;
     `tailwindcss` → web-tailwind; CSS Modules / `*.module.css` → web-css-modules), `*.xcodeproj` or
     `Package.swift` → swiftui, `build.gradle(.kts)` with Compose → android-compose. Confirm the guess
     with the user, and offer to write `design/target.json` so it's cached.
   - **Load `profiles/<profile>.md`** and follow its IR-translation rules for the steps below.
1. **Read** `design/<screen>.json` and the matching `.png`. Skim top-down before writing anything.
   For a large/complex screen, **build top-down and incrementally**: scaffold the outer structure
   first, then implement one section/subtree at a time, validating each before moving on — don't build
   on a broken foundation.
2. **Drift check.** Compare `variables.json` against `tokens.json`. If a `tokens` value in the screen
   JSON has no entry in `tokens.json`, STOP and list the missing tokens rather than hardcoding a literal.
3. **Reuse before generating.** For every node with a `component` field, look it up in
   `components.json` and **import the existing component** (pass `props` through). Reuse existing
   **layout primitives/patterns** in the codebase too, not only components. Only generate new markup
   for nodes with no mapping — a missing **component** mapping is expected (generate it); a missing
   **token** is not (see step 2).
4. **Layout.** Translate each node's `layout` block using the profile:
   - `display:flex` + `flexDirection`/`gap`/`padding`/`justifyContent`/`alignItems` → the profile's
     stack construct (flexbox, HStack/VStack, Row/Column…).
   - `widthMode`/`heightMode`: `fill` → stretch, `hug` → content-sized, `fixed` → fixed **only if
     unavoidable**.
   - `layout.mode:"absolute"` means the design had NO auto layout — **infer** a sensible flow layout;
     do NOT translate raw coordinates into absolute positioning.
   - `layout.display:"grid"` → the profile's Grid section (CSS grid / grid utility classes / native grid
     construct); don't flatten a real grid down to nested flex rows.
   - `clip`/`layout.scroll`/`fixedChildren` → the profile's Scroll & sticky section.
5. **Styling.** Prefer `tokens` (semantic names via `tokens.json`) over raw `fills`/values. Use raw
   values only when a node has no bound token; pick the nearest existing token when one obviously matches.
6. **Assets.** Import `asset` files from `design/assets/` per the profile (some stacks need conversion).
   **Never hand-write or inline an `<svg>`/`<path>`, author your own icon file, or leave a placeholder**
   — you don't have the real vector data, so anything you draw is wrong. Reuse a project icon/component
   in place of an exported asset **only if its glyph clearly matches — a name match is not enough**.
   Size every icon explicitly (square container, set both width+height, clip overflow; leaf image fills
   it) — never `auto`, which blows the image up to its intrinsic size.
7. **Text.** Use `text` + `font`; map size/weight/lineHeight to the type scale via `tokens.json`.
8. **Self-correct (two passes).**
   - **Structural:** every node in the `tree` is present, hierarchy/nesting matches, nothing dropped.
   - **Visual:** re-read the `.png` and check first for **clipped/cropped text and overlapping
     elements** (common and easy to miss), then spacing/alignment/color. The `.png` is for orientation
     and validation — **never build the screen from the screenshot alone** when the JSON `tree` exists.
   End with a short report: nodes you had to generate (no `components.json` mapping), tokens missing
   from `tokens.json`, and any visual discrepancy you couldn't resolve.

## Rules (quick recap of the failure modes — all detailed inline above)
- **Stack-native layout, never absolute positioning** unless the design is genuinely absolute.
- **Tokens, not literals.** A hardcoded value where a token exists is a bug.
- **Reuse, don't regenerate.** Re-implementing a mapped component is a bug.
- **Don't invent icons.** Use the exported asset; never inline your own `<svg>`.
- **Convention fallback ladder** when something's ambiguous (naming, which primitive, structure):
  `design-system/`/IR first → the user's codebase → common patterns only when neither settles it.
  Match what's already there; don't impose new conventions.
- **Missing screen → STOP.** If the requested screen/layer isn't in its page's `pages/<dir>/index.json`
  `layers[]` (or its JSON is missing/empty), ask — don't guess or build from the `.png` alone.
- Match the surrounding codebase's conventions and the profile's output section.
