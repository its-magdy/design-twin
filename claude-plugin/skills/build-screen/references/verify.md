# Verifying a built screen against the design

"Looks about right" is not a check. Render the result under controlled conditions, compare it to the
export in layers (structure → numbers → pixels), fix the largest gap first, and report the evidence.

## Contents
- [Readiness: make renders comparable](#readiness-make-renders-comparable)
- [Per-stack rendering](#per-stack-rendering)
- [Compare in layers](#compare-in-layers)
- [Beyond the ideal frame](#beyond-the-ideal-frame)
- [The fix loop](#the-fix-loop)
- [Saying you're alive](#saying-youre-alive)
- [When you can't render](#when-you-cant-render)

## Readiness: make renders comparable
Most false diffs come from the render, not the code:
- Size = the root `box.w × box.h` of the exported frame (points/dp = Figma px at 1x). Match the
  reference's scale: the `.png` is usually exported at 2x — compare at the same scale or downsample.
  The web probe renders at the reference's scale itself (`referenceImage` in the expectation) — nothing to set up there.
- Fonts loaded before capture (web: `await document.fonts.ready`; mobile: bundled fonts registered).
  A missing font makes every text box differ — fix that first.
- Animations and transitions off; carets hidden; images decoded; deterministic sample data equal to the
  design's text content.
- Same theme mode as `resolvedModes`, same locale/direction as the design.
- Remove drawn system chrome from comparison (status bar/home indicator areas) — the build uses real
  insets there.

**On web the shipped probe does all of this** (`<scripts>/verify-probe.js`): it waits for `document.fonts.ready`,
emulates reduced motion and switches animations/transitions off, optionally waits for `--ready <selector>`,
then requires a quiet window (no navigation, no DOM churn) before measuring, and detects reloads (one re-run,
then exit 4 with nothing written). It does not use `networkidle` — Playwright's docs discourage it, and a
page with polling or a dev-server socket never reaches it. Do not re-implement any of this by hand.

A screen that is a section of the app (chosen by component state, not the URL) is reached with `--steps <plan.json>`
(the plan's `navigate`: `click` / `waitFor` / `goto <same-origin path>` — closed, navigation-only, exactly one visible
match per `click` (a `waitFor` needs at least one), a click never submits; replayed on every page load, a failing step while measuring is exit 4 with
nothing written; a click either changes the page in place or navigates to ANOTHER URL — a click that reloads the same URL
loses what it built, one re-run, then exit 4 naming the step (a link to the URL already shown counts as a `goto` for the load the click starts); always pass `--ready` with the screen root's tag, or end the
steps with a `waitFor` of it — a click that lands on another page, a login bounce, is still the step's own). The plan's `route` is advisory. After measuring, the probe drives the overlay/swap `on_click` /
`on_press` interactions and plan `expect: "dialog"` rows (`on_click` / `on_press` only) itself — skipping a disabled
opener (`:disabled` / `[disabled]` / `aria-disabled`, on it or an ancestor) and one that would submit a form (`ok: null`), revealing a hover-hidden opener, clicking with the real
mouse, watching the dialog contract (`:modal`, `dialog[open]`, `[role=dialog]`, `[role=alertdialog]`,
`[aria-modal="true"]`, `:popover-open`) with the destination frame's `data-dt-node` on or inside the opened element (or on a newly visible ancestor of it) — and
records `ok: true` or `ok: null`, never `ok: false`. Do not re-drive those rows, and a detector you write by hand uses
the same contract, never `[role=dialog]` alone. The probe also reads the page's sideways overflow at the design width
(`overflowX`, a high waivable delta on the root frame).

## Per-stack rendering
Use what the project already has; suggest adding the lightest option if nothing exists, and ask before
installing dependencies.

| Stack | Render | Structure dump |
|---|---|---|
| Web (React/Tailwind/CSS Modules) | `<scripts>/verify-probe.js` (drives the project's Playwright and measures; `--check` first; `--steps <plan.json>` for a screen reached by clicks). By hand only for looking around: Playwright (or the Playwright MCP): `page.setViewportSize({width: w, height: h})`, `deviceScaleFactor` matching the `.png`, `locator.screenshot()` of the screen root | `getBoundingClientRect()` + `getComputedStyle()` per element; axe-core for a11y |
| iOS SwiftUI / UIKit | swift-snapshot-testing (`assertSnapshot(of: view, as: .image(layout: .fixed(width: w, height: h)))`), or an Xcode Preview / `xcrun simctl io booted screenshot` on a matching device | `.recursiveDescription` / `dump` strategy for the view hierarchy; Accessibility Inspector |
| Android Compose | Roborazzi (Robolectric, renders `@Preview`s, `captureRoboImage`) or Paparazzi; `@Preview(widthDp = w, heightDp = h)`; `compose-preview-screenshot-testing` | Roborazzi `.uitree.json` / `composeTestRule.onRoot().printToLog()` semantics tree |
| React Native | Detox/Maestro screenshot on a simulator/emulator at the frame's size; or react-native-web + Playwright for layout-only checks | `toJSON()` from react-test-renderer; accessibility props |
| Flutter | Golden tests: `tester.view.physicalSize = Size(w, h) * dpr`, `matchesGoldenFile`; `flutter run` screenshot | `debugDumpApp()` / `find.*` semantics |

**These tools are used here as renderers, not as regression tests.** Their own pass/fail compares
against a previously recorded image, which is not the Figma reference — and with nothing recorded yet
they fail by design: Flutter's `matchesGoldenFile` fails until `flutter test --update-goldens` writes
the golden, swift-snapshot-testing records the image and fails that first run, Playwright's
`toHaveScreenshot` writes the "actual" and reports the missing snapshot. So run them in record mode
(`--update-goldens`, `recordRoborazziDebug`, `recordPaparazzi`, `record: .all`) or take a plain
screenshot, then compare the image they wrote against the reference yourself. A red first run is not
a finding, and a green later run says only that nothing changed since the recording — neither is
evidence the screen matches the design. Android's Compose Preview Screenshot Testing is still alpha;
prefer Roborazzi or Paparazzi when the project has either.
A native screen needs something addressable to render: emit the stack's preview (`#Preview`,
`@Preview`, a widget test pumping the screen, a Storybook story) as part of the build.

## Compare in layers
Work top-down; a structural miss makes pixel diffs meaningless.

1. **Structure.** Every visible node in the IR tree has a counterpart; nothing is duplicated (two
   icons, doubled padding from a container + a parent inset); hidden (`hidden:true`) layers are
   conditional, not rendered.
2. **Numbers.** For key elements compare rendered bounds and styles to the IR: `box` w/h, `layout.gap`
   and `padding`, `font.size`/line height/letter spacing (after unit conversion), `radius`, stroke
   width, colors (resolve the token; compare hex). Feed back concrete deltas — "title line box 34→28pt",
   "card gap 12→16" — not "spacing looks off".
3. **Pixels.** Web: the probe diffs its render against the reference — read `report.visual` and open
   `<S>.diff.png`; start at the hot regions, then still compare the whole reference and build side by side
   (1-px lines, light greys/tints and text-only changes rarely become regions). The diff is pixelmatch-style
   YIQ with anti-aliasing detection and shift tolerance; informational, never the verdict; a 1–3 % text-edge
   floor is normal. Other stacks: side-by-side or overlay against `design/<screen>.png` (or a fresh `--screenshot <id>`
   for one component). Look first for clipped or overlapping text and missing elements, then
   alignment and spacing, then color and effects. When a pixel-diff tool is available, align the images
   before diffing so a 1px global offset doesn't drown real differences; prefer a perceptual/SSIM
   score plus the numeric checks over raw pixel equality.
4. **Accessibility.** Web: the probe runs the behaviour battery and axe-core (when the project has it) on the page
   it measured — read `report.behaviour`; a hand-run axe (`@axe-core/playwright`) or keyboard tab-through is only for what the probe
   reports `not-run`. iOS: Accessibility
   Inspector / VoiceOver labels, Dynamic Type at AX sizes. Android: accessibility scanner / semantics
   tree, font scale 2.0. Touch targets at platform minimums.

**Numbers: what `--expect`, the probe and `--compare` do.** `--expect` emits the spec as data — font
family/weight/size/line-height/colour, background, radius, padding, gap, size, and the literal text — one row per
node, read straight off the export. Read those rows rather than retyping them into a code comment: one build's
wrong text styles traced to exactly that — a component carrying the comment "heading 20/Semi Bold, subtitle
16/Regular" which contradicted the export, and no later step re-read the node.

`--compare` has **no browser**: it diffs the measured computed styles against the spec with explicit tolerances and
grades the interaction results the probe recorded (in `measured.json`'s `interactions[]`, or a separate
`--interactions <file>`), then writes `design/verify/<Screen>.report.json`. Driving each designed interaction is the
probe's job (the `visual-verifier` agent drives the rest and records the selector it drove); anything nobody drove
is reported `not-probed`, never `pass`. It exits non-zero unless the verdict is `pass` or `pass-with-deviations`
(nothing open, and ≥1 delta the user accepted or interaction the user descoped — waivers and descopes are the user's
word, recorded through the verify skill). That verdict is computed, and it is what you report.

A probe without `--run` writes an **unbound** measured file (it names no run): `--compare` grades it as your evidence,
and an ended run's `<Screen>.status.json` beside it (a `visual-verifier` or verify-skill run at `done`, `failed` or
`blocked`) only adds a note — as long as you measured AFTER that run ended (an older measured file is still judged by
the run: measure again). A run still in flight makes `--compare` `incomplete` — wait for it
(`node <scripts>/verify-screen.js --wait <Screen> --run <id>`), or, only if nothing is running it any more (its agent
stopped or crashed), end it: `node <scripts>/verify-screen.js --status <Screen> --phase failed --run <id>`.

**Known approximations** (listed in the plan: shadow spread on iOS, blur radius conversions, diamond
gradients, progressive blur, noise/glass, P3 colors, Figma-vs-platform text rasterizing) are excluded
from "must match" — note their residual difference instead of iterating on them.

**"The reference is downscaled" is not a reason to downgrade a difference.** The reference PNG is
rendered above 1x (a 1440×1100 frame exports at ~2048px wide) and *is* what the designer sees, so
when a build looks visibly worse than it at 1:1, that is a real delta — severity `medium` at least,
with what you saw. Downscaling can hide a difference; it cannot invent one. Only call a difference
cosmetic when you can name the mechanism that makes it invisible to a user.

**A grainy or speckled illustration is the common case of this**, and it is an asset
problem rather than a build problem — the cause and the fix are in `export-layout.md`'s
[heavy vector assets](export-layout.md#heavy-vector-assets). The short version: Figma emits a noise
texture as thousands of separate paths, every renderer antialiases each one, and the speckle is the
result. Report it as a real delta naming that cause; the fix is a re-export on the design side, never
a redraw or a blur in your stack.

**Values come from the export JSON** — the expectation is built from it and the compare grades against it.
The PNG is the layout and visual aid (and the visual-diff input): a PNG pixel that disagrees with a JSON value
(a text colour, say) is not a build defect — anti-aliased glyph edges and colour-profile conversion move
sampled pixels. Report it as a designer question with both values, and never change the build to match the PNG.

## Beyond the ideal frame
Render at least once each, when the stack supports it:
- Each interaction state with a design (or a derived default) — pressed/disabled/focus/error/selected.
- Loading, empty and error data states.
- Large font scale (Android 2.0, iOS accessibility XL+, web 200% zoom): no clipping, no overlap.
- The other theme mode, if tokens have one.
- RTL, if the app ships an RTL locale.
- A narrow and a wide width (small phone / tablet, or web breakpoints) for fill/hug behavior.

Record what you covered in the plan's `verification.coverage` — `{rendered:[…], notChecked:[{what,
why}]}` (yours to write) — and, on web, let `verify-screen.js --compare … --record-plan` write the rest of `verification`
(`mode` — `static-only` + its `reason` for a static-only measured file —, `renderer`, `artifacts`, open `deltas`, `a11y` from
`report.behaviour.summary`, `recorded`); elsewhere, when an
accessibility check ran, `verification.a11y` — `{tool, violations, warnings, report}`, copied from `report.behaviour.summary`. One
rendered frame is a legitimate result; an unstated one is not, because the report would then read as
"verified" for states nobody looked at. The Stop hook only warns when these are missing.

## The fix loop
- Record the differences you already know about as `deviations[]` (with a reason) when you build them, not after the
  report lists them; a line-height taller than its fixed text box is a choice to make deliberately, not a delta to chase.
- Fix the largest structural or numeric delta first, re-render, re-compare. Keep a one-line log per
  round (what changed, what the delta became).
- Cap at **5 rounds per component**, and stop sooner when a round fixes nothing. If a fix to one value
  breaks another (margin vs padding ping-pong), the constraints conflict — step back to the plan,
  split the component, or report it.
- Never trade maintainability for pixels: a round that adds absolute positioning, a fixed size or a
  magic offset to a node the export lays out with auto layout, or replaces a token with a literal,
  is a regression even when the screenshot got closer. Record the residual in `deviations[]` (with a reason) instead —
  `verification.deltas` belongs to `--record-plan`, which replaces any row it did not write.
- After two approaches fail on the same issue, stop and re-read the IR and profile for that node; you're
  probably misreading a unit or a sizing mode.

## Saying you're alive
A full verify pass is minutes, not seconds, and every stack's render step is silent while it works — a dev server
booting, a simulator coming up, a Gradle task compiling, a golden test warming. So report status as you go,
through the tool, and wait on a run with the tool rather than a poll loop. The one copy of that protocol — the
`--status` / `--wait` commands and exit codes, run ids, the run cache, staging and publishing, closing pages
before the probe writes, rebuilding a preview, processes, permission denials, timings — is the verify skill's
`references/run-protocol.md`, which the skill that sent you here links beside this file.

## When you can't render
Rendering is the default, not an optional extra — check `package.json`/`node_modules` (or the
platform equivalent) for a dev server and the tooling in the table above before concluding it's
unavailable. Only if that check confirms nothing exists, do the fallback: structural walk of the tree
against the code, a numeric check of every converted value against the IR, and a careful visual read
of the `.png` for clipped text, overlaps, spacing and color. Report it as "not rendered — reviewed
statically", never as a verified match.
