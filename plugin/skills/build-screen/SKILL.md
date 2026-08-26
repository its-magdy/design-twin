---
name: build-screen
description: Build a front-end screen as real code from a Figma export, for ANY stack (React/Tailwind, CSS Modules, React Native, SwiftUI, Jetpack Compose, or a custom target). Use this whenever the user wants a design turned into code — "implement the login screen", "build this frame", "code up the settings page", "make this design real" — or points at a design/ export or a Figma frame, even if they don't say which stack. Resolves the target stack, reads the node JSON + assets + token/component maps, reuses existing components and tokens instead of regenerating them, then self-corrects against the reference screenshot. If design/ is empty or stale, use the extract skill first.
---

# Figma → code (any stack)

Turn a Figma export into a faithful, maintainable screen for whatever stack the project uses.
Free-plan workflow: the design data comes from the local **Design Twin** plugin (no Figma
API, no MCP), saved into `design/`. The export JSON is a **stack-neutral intermediate representation
(IR)**; this skill translates it into the project's actual framework via a target *profile*.

## Bundled references — load on demand, not up front

| File | Load it when |
|------|--------------|
| `profiles/<profile>.md` | **Always**, once you've resolved the target (step 0). The IR→stack translation rules. A project-root `profiles/<profile>.md` overrides the bundled one — check there first. |
| `references/export-layout.md` | You need to **find** a file: which page index, where the tokens/styles/component catalogs are, a separately pulled library, or a browser-downloaded (flat `__`) export. |
| `references/ir-fields.md` | A node has a field you don't recognise, or you're about to build anything interactive, scrolling, themed, animated, or grid-based. |

Read the export's **`manifest`** first in every case (`nodes`/`skipped`/`truncated`/`assetsFailed`/
`warnings`). If anything was truncated or an asset failed, tell the user **before** building rather
than shipping a silently-incomplete screen.

## The four inputs

- **`design/pages/index.json`** → find the page → its `index` → the layer's `file`. Both pointers are
  already relative to `design/`; open `design/<pointer>` verbatim. (Or `design/<screen>.json` for a
  single screen exported on its own.) Details: `references/export-layout.md`.
- **`design/<screen>.png`** — the reference screenshot, visual ground truth. **Always read it.**
- **`design/design-system/`** — tokens, styles and component catalogs; `design/assets/` — real icon
  and image files.
- **`design/tokens.json`** / **`components.json`** / **`target.json`** — your project's own maps:
  Figma value → your token, Figma component → your component, and which stack to emit.

## Hint priority — when multiple sources describe the same node, earlier wins

1. `components.json` mapping → use the mapped code component directly (pass `props`/variants through).
2. Node `name` / annotations / designer notes in the IR → follow as constraints.
3. Bound `tokens` (via `tokens.json`) → the project's token system.
4. Raw `fills`/hex + `layout.mode:"absolute"` coords → loosely structured; treat as intent, lean on
   the screenshot.

## Procedure

**Treat the export as a reference for intent + exact values, not a spec to transcribe** — adapt it to
the target's language, framework, component library, and conventions; match the surrounding code.

0. **Resolve the target.**
   - If `design/target.json` exists, use its `profile`.
   - Else **auto-detect** from the repo: `package.json` deps (`react-native` → react-native;
     `tailwindcss` → web-tailwind; CSS Modules / `*.module.css` → web-css-modules), `*.xcodeproj` or
     `Package.swift` → swiftui, `build.gradle(.kts)` with Compose → android-compose. Confirm the guess
     with the user, and offer to write `design/target.json` so it's cached.
   - **Load `profiles/<profile>.md`** — the calling project's own if present, else this skill's
     bundled one — and follow its IR-translation rules for every step below.
1. **Read** the screen JSON and the matching `.png`. Skim top-down before writing anything.
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
   - `layout.display:"grid"` → the profile's Grid section; don't flatten a real grid down to nested
     flex rows.
   - `clip`/`layout.scroll`/`fixedChildren` → the profile's Scroll & sticky section.
   - Field-by-field meanings: `references/ir-fields.md`.
5. **Styling.** Prefer `tokens` (semantic names via `tokens.json`) over raw `fills`/values. Use raw
   values only when a node has no bound token; pick the nearest existing token when one obviously matches.
6. **Assets.** Import `asset` files from `design/assets/` per the profile (some stacks need conversion).
   **Never hand-write or inline an `<svg>`/`<path>`, author your own icon file, or leave a placeholder**
   — you don't have the real vector data, so anything you draw is wrong. (The single exception is a
   node carrying `geometry`, where the export failed and the paths are handed to you.) Reuse a project
   icon/component in place of an exported asset **only if its glyph clearly matches — a name match is
   not enough**. Size every icon explicitly (square container, set both width+height, clip overflow;
   leaf image fills it) — never `auto`, which blows the image up to its intrinsic size.
7. **Text.** Use `text` + `font`; map size/weight/lineHeight to the type scale via `tokens.json`.
8. **Interaction states.** Before shipping any interactive element, check its variant `options` in the
   component catalog — hover/focus/disabled/error/selected are usually variant values, not separate
   nodes. Always ship a visible `:focus-visible` style even when the design only shows hover.
9. **Self-correct (two passes).**
   - **Structural:** every node in the `tree` is present, hierarchy/nesting matches, nothing dropped.
   - **Visual:** re-read the `.png` and check first for **clipped/cropped text and overlapping
     elements** (common and easy to miss), then spacing/alignment/color. The `.png` is for orientation
     and validation — **never build the screen from the screenshot alone** when the JSON `tree` exists.

   End with a short report: nodes you had to generate (no `components.json` mapping), tokens missing
   from `tokens.json`, and any visual discrepancy you couldn't resolve.

## Building several screens in one session

Each layer's node JSON is large, and loading five of them into one context degrades all five. When the
user asks for more than one screen, **delegate one layer per subagent**: give it the layer name/id,
tell it to use this skill, and ask it to report back only the files it created, the components it
reused, tokens missing from `tokens.json`, and any fidelity gap it couldn't resolve — under ~10 lines.
Keep only those summaries in the main thread.

This is context isolation, not a transport: extraction still comes from the plugin/CLI/MCP, and each
subagent reads the same `design/` files from disk.

## Rules (the failure modes, in one place)

- **Stack-native layout, never absolute positioning** unless the design is genuinely absolute.
- **Tokens, not literals.** A hardcoded value where a token exists is a bug.
- **Reuse, don't regenerate.** Re-implementing a mapped component is a bug.
- **Don't invent icons.** Use the exported asset; never inline your own `<svg>`.
- **Theme before styling.** Check `variableModes`/`resolvedModes` or you'll build the Light variant of
  a Dark design.
- **Convention fallback ladder** when something's ambiguous (naming, which primitive, structure):
  `design-system/`/IR first → the user's codebase → common patterns only when neither settles it.
  Match what's already there; don't impose new conventions.
- **Missing screen → extract it, don't improvise.** If the requested screen/layer isn't in its page's
  index `layers[]` (or its JSON is missing/empty), it was never exported. Hand off to
  `/designtwin:extract` rather than guessing or building from the `.png` alone. Same if `design/`
  doesn't exist at all.
- Match the surrounding codebase's conventions and the profile's output section.
