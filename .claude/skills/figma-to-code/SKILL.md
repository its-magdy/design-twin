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
- `design/design-system.json` — whole-file context: `variables` (each with `tier`
  primitive/semantic, `scopes`, and `codeSyntax` `{WEB,ANDROID,iOS}` when the designer set it — prefer
  that platform string over hand-mapping), `styles`, a `components` catalog where each prop is
  `{key,type,options,default}` (`options` = a variant's states), and a `hygiene` array of design-system
  smells (unbound values, variant explosion, broken aliases). **Read this early** (after the manifest
  gate below) to learn the system before building.
- `design/screens.json` — full-page export: `index` (all screen names/ids) + `screens[]` each with a
  compacted node `tree`. Use `index` to pick the screen; build from its `tree`.
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
- Every export doc has a **`manifest`** (`nodes`/`skipped`/`truncated`/`assetsFailed`/`warnings`).
  **Read it first** — if anything was truncated or an asset failed, tell the user before building rather
  than shipping a silently-incomplete screen.
- `design/<screen>.json` — a single screen exported on its own (same tree shape), when not using screens.json.
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
  `design-system.json`/IR first → the user's codebase → common patterns only when neither settles it.
  Match what's already there; don't impose new conventions.
- **Missing screen → STOP.** If the requested screen isn't in `screens.json`'s `index` (or its JSON is
  missing/empty), ask — don't guess or build from the `.png` alone.
- Match the surrounding codebase's conventions and the profile's output section.
