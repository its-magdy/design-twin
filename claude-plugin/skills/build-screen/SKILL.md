---
name: build-screen
description: Build a front-end screen as real, production-quality code from a Figma export, for ANY stack (React/Tailwind, CSS Modules, React Native, SwiftUI, Jetpack Compose, Flutter, or a custom target). Use this whenever the user wants a design turned into code — "implement the login screen", "build this frame", "code up the settings page", "make this design real", "match the Figma" — or points at a design/ export or a Figma frame, even if they don't say which stack. Resolves the target stack, audits the design for missing states and untranslatable values, maps every node to existing components and tokens before coding, builds leaf-first with exact unit conversions per platform, then verifies by rendering and comparing against the reference screenshot. If design/ is empty or stale, use the extract skill first.
hooks:
  Stop:
    - hooks:
        - type: command
          command: node "${CLAUDE_PLUGIN_ROOT}/scripts/verify-build.js"
---

# Figma → code (any stack)

Turn a Figma export into a faithful, maintainable screen for whatever stack the project uses. The
design data comes from the local **Design Twin** plugin, saved into `design/`. The export JSON is a
**stack-neutral intermediate representation (IR)** with exact values and units; a target *profile*
says how each value becomes code on that stack.

A frame is one ideal moment. Shipping code handles every other moment too — other states, sizes,
languages, font scales and themes — so this skill maps and verifies, not just transcribes.

## Bundled references — load on demand, not up front

| File | Load it when |
|------|--------------|
| `profiles/<profile>.md` | **Always**, once the target is resolved (step 0). Layout, text metrics, effects, strokes, insets, a11y/RTL and motion conversions for that stack. A project-root `profiles/<profile>.md` overrides the bundled one — check there first. |
| `references/ir-fields.md` | Before mapping (step 2) — what every node field means, with units. Re-open whenever a node has a key you don't recognise. |
| `references/export-layout.md` | You need to **find** a file: page index, tokens/styles/component catalogs, a pulled library, a browser-downloaded (flat `__`) export. |
| `references/verify.md` | Step 5 — how to render and compare on web / iOS / Android / RN / Flutter, and the fix loop. |
| `../audit-design/SKILL.md` | Step 1, when no audit exists for this screen and it's more than a trivial component. |

## Inputs

- **The screen JSON** — `design/pages/index.json` → page → its `index` → the layer's `file` (both
  pointers relative to `design/`; open `design/<pointer>` verbatim), or `design/<screen>.json`.
- **The reference render** — visual ground truth. Its path is the screen JSON's root `reference`
  field, relative to `design/` (e.g. `assets/<id>_ref.png`); a hand-exported `design/<screen>.png` is
  the fallback when that field is absent. **Always read it.**
- **`design/design-system/`** — tokens, styles and component catalogs; **`design/assets/`** — real
  icon/image files.
- **`codeconnect.local.json`** (repo root) — Figma component → code component, keyed by the stable
  publish **`key`**. Scaffold with `node "${CLAUDE_PLUGIN_ROOT}/scripts/map-bootstrap.js" design/design-system/components.local.json
  --out codeconnect.local.json` (re-running merges, never overwrites your edits). *(Legacy name-keyed
  `design/components.json` may exist; prefer `codeconnect.local.json`.)*
- **`design/tokens.dtcg.json`** (`node "${CLAUDE_PLUGIN_ROOT}/scripts/tokens.js"`) plus **`design/tokens.json`**
  overrides — Figma value → your token.
- **`design/audit/<screen>.json|md`** — the pre-build audit, if run.
- **`design/target.json`** — which stack to emit (optional; auto-detected in step 0).

## Hint priority — when sources disagree about a node, earlier wins

1. `codeconnect.local.json` mapping → use the mapped code component; translate `props` via the entry's
   value-table.
2. Designer `annotations` / `devStatusNote` / node names → follow as constraints.
3. A variable's `codeSyntax.{WEB,ANDROID,iOS}` (see `references/export-layout.md`) → that string **is**
   the token verdict, no grep needed — it's the designer's own code name, not a guess.
4. Bound `tokens` / `styles` without `codeSyntax` → grep the project's real token source for an exact
   match.
5. Raw values (`fills` hex, `layout.gap`) with no bound token → this is a **MISSING** row per step 2,
   not a "snap to the closest token" — an approximate match is exactly the silent hardcoding-by-proxy
   step 2 forbids. Record it as MISSING and get the user's decision.
6. `layout.mode:"absolute"` coordinates → loosest; infer the flow from the screenshot.

## There is no build command

This skill *is* the build step: the agent reads the export JSON/PNG directly and writes the
target-stack source files itself (steps 0–6 below), the same way it would write any other feature
code in this repo. The scripts invoked along the way — audit and drift-lint in step 1, and the
`Stop`-hook check in step 5 — all live at `${CLAUDE_PLUGIN_ROOT}/scripts/`, shipped with this
plugin; those are checks, not generators. Everything else (mapping, coding, verifying) is done by
the agent, not a tool.

## Procedure

Copy this checklist into your notes and keep it updated:

```
- [ ] 0. Target resolved, profile loaded
- [ ] 1. Gates passed (manifest, freshness, dev status, audit read)
- [ ] 2. Mapping plan written and self-reviewed
- [ ] 3. Built leaf → composite → screen
- [ ] 4. States, font scaling, theme, RTL handled
- [ ] 5. Verified: static checks, render + compare, fix loop ≤ 8 rounds
- [ ] 6. Report delivered
```

0. **Resolve the target.** `design/target.json` `profile` if present; else detect: `package.json`
   deps (`react-native` → react-native; `tailwindcss` → web-tailwind; `*.module.css` →
   web-css-modules), `*.xcodeproj`/`Package.swift` → swiftui, Compose in `build.gradle(.kts)` →
   android-compose, `pubspec.yaml` with flutter → flutter. Confirm the guess and offer to write
   `design/target.json`. **Load the profile** and follow it for every step below.

1. **Gather and gate.**
   - Read the export `manifest` (`truncated`/`assetsFailed`/`warnings`). Anything incomplete → tell
     the user before building. Missing screen → hand off to `/designtwin:extract`; never build from the
     `.png` alone.
   - Run the drift check: `mcp__designtwin__design_drift_lint` MCP tool (or
     `node "${CLAUDE_PLUGIN_ROOT}/scripts/drift-lint.js"`). Fix an `ok:false` map before generating
     against it; heed a stale-snapshot warning. No `codeconnect.local.json` at all → **stop**: run
     `node "${CLAUDE_PLUGIN_ROOT}/scripts/map-bootstrap.js" design/design-system/components.local.json
     --out codeconnect.local.json` and have the user confirm the stub
     entries before continuing. Building without a map means every component instance is legitimately
     "new" — that's the failure this skill exists to prevent, not an edge case to shrug past.
   - Read the `.png`, then skim the tree top-down. Collect every `annotations[]` and `devStatusNote`.
     Theme first: `variableModes`/`resolvedModes` tell you which mode this frame shows.
   - **Audit.** If `design/audit/<screen>.json` exists, read its verdict, findings and questions. If
     not, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/audit.js" <screen json> --platform <p> --catalog
     design/design-system/components.local.json --out design/audit/<screen> --gate --grid <N>`, where
     `<N>` is the design's real spacing step from `design/design-system/tokens.json`/`layoutGrids`, not
     the 4px default (which silently under-flags an 8px-grid system) (or follow
     `../audit-design/SKILL.md` for a full review on a big or unfamiliar screen). This command
     **is not optional and is not "by hand" if it's missing** — `${CLAUDE_PLUGIN_ROOT}/scripts/` ships
     with this plugin. `--gate` makes the process exit non-zero on any blocker; a non-zero exit **stops
     the build** until the user decides. Open questions get the audit's stated default, recorded in the
     final report — never a silent invention.

2. **Map before coding.** Write the plan to **`design/plan/<screen>.json`** — not "in your notes":
   `{screen, status:"pending", files:[], tokens:[{value,kind,codeToken,verdict,decision?}],
   components:[{name,key,mapModule,verdict}], allowedLiterals:[{value,reason}]?}` (step 5 adds
   `verification`). This file is what step 5's `Stop` hook (wired in this
   skill's frontmatter) checks the built code against, so it must exist and be accurate before step 3 —
   a plan that only lives in your notes is invisible to that check and the mistake reappears at the end
   as a rubber-stamped "done" that the user has to catch by hand. Sections to fill in (show large-screen
   plans to the user too, this isn't only for the hook):
   - **Component inventory** → the `components[]` array. Every `INSTANCE`: mapped code component (via
     `mainComponent.key`/`setKey`), a native platform control (per the profile's native-controls list),
     or `verdict:"new"`. A new component for something that exists in the codebase is a bug; check by
     structure, not name — glob the project's actual component files/exports, don't rely on memory.
   - **Token map** → the `tokens[]` array. One row per distinct Figma color/spacing/radius/type-style/
     effect value in the node tree. Prefer the variable's `codeSyntax.{WEB,ANDROID,iOS}` when Figma
     provides one (see `references/export-layout.md`) — that's the designer's own code name and beats
     hand-mapping. Otherwise grep the project's actual palette/theme source file (`tailwind.config.*`,
     `--color-*`/`@theme` CSS vars, `theme.ts`, `*.xcassets` colorsets, `Color.kt`/`Dimens.kt`,
     `ColorScheme`/`ThemeExtension` in Dart — not `design/design-system/tokens.json`, which is Figma's
     raw values, never copy hex straight out of it). The verdict is either the **exact** matching token
     (same hex/value or token name actually found by grep — not "closest existing token") or
     **MISSING**. Do not fill a MISSING row with a token defined for a different role/surface just
     because it's close or already imported elsewhere — that's silent hardcoding by proxy and the bug
     this rule exists to catch. Any **MISSING** row **blocks step 3**: stop and ask the user whether to
     add the token or which specific fallback to use, and record the answer as that row's `decision`.
     Don't proceed to coding with an unresolved MISSING row.
   - **Layout tree** — stacks/grids/native containers with fill/hug/fixed per node; system chrome
     drawn in the frame (status bar, home indicator) becomes insets, not views.
   - **State matrix** — interaction states per control (from variant options + audit), screen data
     states (loading/empty/error), and which are designed vs defaulted.
   - **Unit conversions** — list the text metrics, strokes, shadows, blurs, gradients and transitions
     that need the profile's conversion, and mark approximations (spread on iOS, blur radius, diamond
     gradients) so verification doesn't chase them.
   - **Assets** — each `asset` file and how it's imported for this stack.
   Then **self-review the plan**: every visible node accounted for? any literal where a token exists?
   any hand-built native control? any fixed size that should hug/fill? Fix the plan, then build.
   *Multi-screen:* scaffold navigation/routing and shared sample data first.

   **Two mistakes seen in practice — check the plan for them explicitly:**
   - A node named Status Bar / Home Indicator / 9:41 / Keyboard appears in the plan as a view or
     composable. Delete it from the layout tree; the plan says "inset" instead (`Scaffold`/
     `WindowInsets.safeDrawing`, SwiftUI safe area, CSS `env(safe-area-inset-*)`). A "simplified mock"
     of system chrome is still a bug.
   - Text metrics converted without units. Worked example for `font.size` 28,
     `letterSpacing {value:-2, unit:"percent"}`, `lineHeight {value:120, unit:"percent"}`:
     Compose `letterSpacing = (-0.02).em`, `lineHeight = 1.2.em` · SwiftUI `.tracking(-0.56)` ·
     CSS `letter-spacing: -0.02em; line-height: 1.2` · Flutter `letterSpacing: -0.56, height: 1.2`.
     Percent → divide by 100; the sign is kept.

3. **Build leaf → composite → screen.** Implement the smallest pieces first (new components, token
   additions), each compiling and checked before composing. For a large screen scaffold the outer
   structure, then one section at a time. As each file lands, add its path to the plan's `files[]`
   array (paths relative to the project root) — the `Stop` hook only inspects files listed there, so
   a file missing from `files[]` is a file this skill's own gate never checks; an empty list, or a
   listed path that isn't on disk, fails the gate outright. Rules while building:
   - **Layout** — the profile's stack constructs from `layout`; `fill` → stretch, `hug` → intrinsic,
     fixed only when truly fixed; `sizeLimits` → min/max. `layout.mode:"absolute"` means no auto layout
     — infer a flow, never transcribe coordinates. Real grids stay grids. `clip`/`scroll`/
     `fixedChildren` → the profile's scroll & sticky section.
   - **Text** — map to the type scale by style name; convert `lineHeight`/`letterSpacing` **with their
     units** per the profile (percent ≠ px). Every data-driven text gets an overflow rule (`truncate`/
     `maxLines`/wrap). Never lock text containers to a fixed height. Use start/end alignment.
   - **Styling** — tokens over literals; paint `opacity` vs node `opacity` are different; strokes honor
     `align` (inside/outside/center) and per-side `weights`; shadows keep `spread` where the stack can.
   - **Assets** — import `asset` files per the profile. **Never hand-write an `<svg>`/`<path>`, draw
     your own icon, or leave a placeholder** — the only exception is a node carrying `geometry` (export
     failed; its paths are provided). Reuse a project icon only if the glyph clearly matches. Size every
     icon explicitly (square container, both dimensions set).
   - **Instances** — before writing anything for an instance's sublayer, check `propRefs`,
     `overrides` and `exposedInstances` on the node: a prop-driven or overridden sublayer becomes a
     **prop on the mapped component**, never hand-built markup beside it. `detachedFrom` (`{key}`/
     `{componentId}`) was an instance — look that component up in `codeconnect.local.json` and reuse it.
   - **Hints are not output** — `layoutGrids`, `measurements`, `devStatus`/`devStatusNote` and
     `devResources` inform structure and let you sanity-check spacing; never render them as UI.
   - **Interactions** — `reactions` become real navigation/state, not dead buttons; `overlay` →
     the stack's modal/sheet; transitions use the given duration (seconds → ms) and easing.

4. **States, scaling, theme, direction.** Before calling a component done:
   - Every interaction state in the matrix, including a **visible focus indicator** even if undrawn,
     and pressed feedback on touch.
   - Screen data states: loading, empty, error (designed or the audit's default), not just the ideal.
   - Font scaling: layout survives 200% text (Android) / accessibility sizes (iOS) / 200% zoom (web)
     without clipping; touch targets ≥ 44pt iOS / 48dp Android / 24px web (44 recommended).
   - Theme: colors come from tokens that resolve per mode; nothing hardcoded that breaks dark mode.
   - RTL: start/end padding and alignment; directional icons mirror.
   - Accessibility semantics: accessible names for icon-only buttons, headings, grouping, decorative
     images hidden from assistive tech.

5. **Verify — evidence, not "looks right".** Follow `references/verify.md`:
   - Static: build + typecheck + lint; grep the new code for raw hex/px literals and inline SVG.
   - **Live render is the default path, not the fallback.** Before assuming no rendering tooling
     exists, check `package.json`/`node_modules` for a dev server and Playwright (or the stack's
     equivalent from the table in `verify.md`). If present, use them: launch the dev server, render
     the actual screen, and diff **computed styles** (`getComputedStyle` — `backgroundColor`, padding,
     gap, font metrics, etc., or the platform equivalent) against the IR's `layout`/`fills`/token
     values — not just a visual read of the `.png`. Computed colors come back as `rgb()`/`rgba()`, not
     hex — convert one side before comparing, don't string-match `rgb(229, 231, 235)` against `#E5E7EB`
     and call it a mismatch.
   - Render the screen at the frame's exact size (`box.w`×`box.h`, fonts loaded, animations off) with
     the stack's tooling, then compare: **structure** (every tree node present, nothing duplicated),
     **numbers** (sizes, spacing, font metrics against the IR), and **pixels** against the `.png` —
     look first for clipped/overlapping text, then spacing, alignment, color.
   - Re-render key states, a large font scale, the other theme, and RTL when supported.
   - Fix the largest discrepancy first; log each round. Stop after **8 rounds** per component — if it
     oscillates, the constraints conflict: split the component or report the gap. Don't chase marked
     approximations.
   - Only if the project genuinely has no dev server/rendering tooling available (checked, not
     assumed) fall back to a structural + visual self-review against the `.png` — and report it as
     "not rendered — reviewed statically", never as a verified match.
   - **Record the evidence in the plan** — the `Stop` hook blocks "done" without it. After a render:
     `verification: {mode:"rendered", renderer, artifacts:[<screenshot/report paths that exist on
     disk>], deltas:[<residual differences, [] if none>]}`. With genuinely nothing to render with:
     `verification: {mode:"static-only", reason:<what you checked for and didn't find>}`. The hook
     sets `status` itself — `"verified"` only for a rendered check, `"static-only"` otherwise — so
     never write `status` by hand, except `"abandoned"` for a plan the user decided not to finish.
     The hook fails a literal only where the plan resolved that value to a token (in any spelling:
     `#hex`, `0xFF…`, `rgb()`, `[16px]`); a value with no token (a one-off shadow `rgba()`, `text-[15px]`)
     is fine. A resolved value that must appear literally (the theme file that defines it is in
     `files[]`) goes in `allowedLiterals` with a reason.

6. **Report** (short): files created/changed; components reused vs generated (from `design/plan/
   <screen>.json`'s `components[]`, not from memory); tokens missing or resolved (from `tokens[]`);
   states designed vs defaulted (with the defaults used); approximations; verification evidence (what
   was rendered and compared, residual differences); open designer questions. If the `Stop` hook
   (`${CLAUDE_PLUGIN_ROOT}/scripts/verify-build.js`) reported problems earlier in this turn, they must
   be resolved before this report is written — a report claiming "done" while the plan's `status` is
   still `"pending"` is the exact failure this hook exists to catch. Report the status the hook
   granted as it is: `"static-only"` is "built, not visually verified", not "matches the design".

## Building several screens in one session

Each layer's node JSON is large, and loading five into one context degrades all five. For more than
one screen, **delegate one layer per `designtwin:screen-builder` agent** after scaffolding shared
navigation and tokens: give it the layer name/id and the shared files to reuse. It has this skill
preloaded, runs the same Stop-hook gate, and reports back only files created, components reused,
missing tokens, defaults assumed, and unresolved fidelity gaps — under ~10 lines.

For step 5's render-and-compare, prefer the **`designtwin:visual-verifier`** agent over checking your
own work: it sees only the render, the reference `.png`, the export and the plan, writes its
screenshots to `design/verify/`, and returns `{mode, renderer, artifacts, deltas}` — copy that into
the plan's `verification` block, fix the high-severity deltas, and re-verify.

## Rules (the failure modes, in one place)

- **Stack-native layout, never absolute positioning** unless the design is genuinely absolute.
- **Tokens, not literals.** A hardcoded value where a token exists is a bug.
- **Reuse, don't regenerate** — mapped components and native platform controls both.
- **Don't invent icons.** Use the exported asset; never inline your own `<svg>`.
- **Units are part of the value.** `lineHeight`/`letterSpacing` percent vs px, `rotation` in degrees,
  transition `duration` in seconds — convert per the profile.
- **Theme before styling.** Check `variableModes`/`resolvedModes` or you'll build Light for a Dark design.
- **No system chrome as views.** Drawn status bars, home indicators and keyboards become insets.
- **Never invent a design decision silently.** Undesigned states/behaviors use the audit default and
  are listed in the report.
- **Evidence over assertion.** Report what was rendered and compared, not that it "matches".
- **Convention fallback ladder** when something's ambiguous: `design-system/`/IR → the user's
  codebase → common platform patterns. Match what's already there.
- **Missing screen → extract it, don't improvise** (`/designtwin:extract`).
