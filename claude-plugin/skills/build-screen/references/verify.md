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
- Fonts loaded before capture (web: `await document.fonts.ready`; mobile: bundled fonts registered).
  A missing font makes every text box differ — fix that first.
- Animations and transitions off; carets hidden; images decoded; deterministic sample data equal to the
  design's text content.
- Same theme mode as `resolvedModes`, same locale/direction as the design.
- Remove drawn system chrome from comparison (status bar/home indicator areas) — the build uses real
  insets there.

## Per-stack rendering
Use what the project already has; suggest adding the lightest option if nothing exists, and ask before
installing dependencies.

| Stack | Render | Structure dump |
|---|---|---|
| Web (React/Tailwind/CSS Modules) | Playwright (or the Playwright MCP): `page.setViewportSize({width: w, height: h})`, `deviceScaleFactor` matching the `.png`, `locator.screenshot()` of the screen root | `getBoundingClientRect()` + `getComputedStyle()` per element; axe-core for a11y |
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
3. **Pixels.** Side-by-side or overlay against `design/<screen>.png` (or a fresh `--screenshot <id>`
   for one component). Look first for clipped or overlapping text and missing elements, then
   alignment and spacing, then color and effects. When a pixel-diff tool is available, align the images
   before diffing so a 1px global offset doesn't drown real differences; prefer a perceptual/SSIM
   score plus the numeric checks over raw pixel equality.
4. **Accessibility.** Web: axe-core through `@axe-core/playwright` (Playwright's own accessibility
   guide uses it) on the same page you screenshotted, keyboard tab-through with visible focus. iOS: Accessibility
   Inspector / VoiceOver labels, Dynamic Type at AX sizes. Android: accessibility scanner / semantics
   tree, font scale 2.0. Touch targets at platform minimums.

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

## Beyond the ideal frame
Render at least once each, when the stack supports it:
- Each interaction state with a design (or a derived default) — pressed/disabled/focus/error/selected.
- Loading, empty and error data states.
- Large font scale (Android 2.0, iOS accessibility XL+, web 200% zoom): no clipping, no overlap.
- The other theme mode, if tokens have one.
- RTL, if the app ships an RTL locale.
- A narrow and a wide width (small phone / tablet, or web breakpoints) for fill/hug behavior.

Record what you covered in the plan's `verification.coverage` — `{rendered:[…], notChecked:[{what,
why}]}` — and, when an accessibility check ran, `verification.a11y` — `{tool, violations}`. One
rendered frame is a legitimate result; an unstated one is not, because the report would then read as
"verified" for states nobody looked at. The Stop hook only warns when these are missing.

## The fix loop
- Fix the largest structural or numeric delta first, re-render, re-compare. Keep a one-line log per
  round (what changed, what the delta became).
- Cap at **5 rounds per component**, and stop sooner when a round fixes nothing. If a fix to one value
  breaks another (margin vs padding ping-pong), the constraints conflict — step back to the plan,
  split the component, or report it.
- Never trade maintainability for pixels: a round that adds absolute positioning, a fixed size or a
  magic offset to a node the export lays out with auto layout, or replaces a token with a literal,
  is a regression even when the screenshot got closer. Report the residual in `deltas` instead.
- After two approaches fail on the same issue, stop and re-read the IR and profile for that node; you're
  probably misreading a unit or a sizing mode.

## Saying you're alive
A full verify pass is minutes, not seconds, and every stack's render step is silent while it works —
a dev server booting, a simulator coming up, a Gradle task compiling, a golden test warming. Observed
in practice: a pass that ran ~25 minutes with the caller unable to distinguish progress from a hang.
So **write a status file as you go**: `design/verify/<screen>.status.json`, rewritten at each step
with `{"screen", "phase", "detail", "at": "<ISO>"}`, where `phase` is

`starting` → `renderer-found` → `renderer-ready` → `rendered` → `comparing` → `done` (or `failed`)

`renderer-ready` is whatever "ready to capture" means on your stack — dev server answering, simulator
booted, emulator up, test harness compiled. One Write per phase is the whole cost.

The caller polls that file instead of guessing: a changed `at` means working, an `at` that has not
moved in several minutes means genuinely stuck, and `phase` says which step to blame. Delete nothing
— the final `done`/`failed` record is useful afterwards.

**On timings, so nobody chases a phantom:** the same verifier legitimately takes far longer inside a
build than standalone, and that is not a bug. Standalone is one capture against finished code with
the renderer often already warm. Inside a build it runs *once per fix round* — render → report
deltas → the builder edits → re-render — each paying its own cold start, and cold start is the
expensive part on every stack (a simulator boot or a Gradle build more so than a dev server). One
observed run: ~25 min inside a build with two fix rounds, ~3.5 min standalone afterwards. Budget
per-round, and treat a *phase* that stops advancing for minutes as the real hang.

## When you can't render
Rendering is the default, not an optional extra — check `package.json`/`node_modules` (or the
platform equivalent) for a dev server and the tooling in the table above before concluding it's
unavailable. Only if that check confirms nothing exists, do the fallback: structural walk of the tree
against the code, a numeric check of every converted value against the IR, and a careful visual read
of the `.png` for clipped text, overlaps, spacing and color. Report it as "not rendered — reviewed
statically", never as a verified match.
