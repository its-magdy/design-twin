# Verifying a built screen against the design

"Looks about right" is not a check. Render the result under controlled conditions, compare it to the
export in layers (structure → numbers → pixels), fix the largest gap first, and report the evidence.

## Contents
- [The build's verify step in full](#the-builds-verify-step-in-full)
- [Several frames](#several-frames)
- [The visual-verifier](#the-visual-verifier)
- [Readiness: make renders comparable](#readiness-make-renders-comparable)
- [Per-stack rendering](#per-stack-rendering)
- [Compare in layers](#compare-in-layers)
- [Beyond the ideal frame](#beyond-the-ideal-frame)
- [The fix loop](#the-fix-loop)
- [Saying you're alive](#saying-youre-alive)
- [When you can't render](#when-you-cant-render)

## The build's verify step in full

Step 5 of build-screen, every command and rule; the skill body has the loop.

- Static: build + typecheck + lint; grep the new code for raw hex/px literals and inline SVG.
- **Live render is the default path, not the fallback.** Check `package.json`/`node_modules` for a dev server
  and Playwright (or the stack's equivalent from `verify.md`'s table); if present, render the actual screen and
  diff **computed styles** (`getComputedStyle` — `backgroundColor`, padding, gap, font metrics, or the platform
  equivalent) against the IR's `layout`/`fills`/token values, not just a visual read of the `.png`. Computed
  colours come back as `rgb()`/`rgba()` — convert one side rather than string-matching `rgb(229, 231, 235)` against `#E5E7EB`.
- **Getting a dev server up is itself a step, not an assumption.** Follow whatever the repo already
  documents (a `README`/`Makefile`/`package.json` script, a `docker-compose.yml`) — the first
  attempt at an unfamiliar or cross-arch setup (e.g. a container built for a different CPU
  architecture than the host) commonly needs one platform-specific flag before it boots; treat that
  failure as a one-line environment fix to make and record, not a reason to fall back to
  `static-only`. Only fall back once starting it has genuinely been tried and failed.
- **Measure per node, against the design's own numbers.** Generate the expectation and diff it —
  close every page and browser of the app you opened BEFORE running the probe or `--compare` (both write
  into `design/verify/`, and a dev server reloads a page still open on it):

  ```
  bun --no-install --no-env-file "<scripts>/verify-screen.js" --expect <screen json> --out design/verify
  bun --no-install --no-env-file "<scripts>/verify-probe.js" --expected design/verify/<Layer>__<id>.expected.json \
    --url <url> --out design/verify [--steps <plan.json>]   # web: renders, measures every node, writes <Layer>__<id>.measured.json + .png
  bun --no-install --no-env-file "<scripts>/verify-screen.js" --compare \
    design/verify/<Layer>__<id>.expected.json design/verify/<Layer>__<id>.measured.json --out design/verify
  ```

  `--out` is the verify directory; the set is named by the frame's node (`<Layer>__<id>`, never a name you
  pick), and a second set of the node — another theme or width — is `--expect --variant <slug>`
  (`<Layer>__<id>.<slug>`). There is no `--force`. A legacy-named set of the node (a nickname, `<Screen>@320`,
  `<Screen>-r1`) is a note at `--expect`, which writes the `<Layer>__<id>` set beside it; `--compare` and the probe
  refuse a legacy-named expectation. Rename the old sets with `verify-screen.js --migrate` (a dry run), then
  `--migrate --apply` (the verify skill, step 2, has what it skips).
  Web measurements come from the shipped probe (`verify-probe.js`), never a hand-written one. Pass the plan
  found in step 2 as `--steps <plan.json>` (and as `verify-build`'s argument): only a NEW plan is named
  `design/plan/<Layer>__<id>.json`; an existing plan keeps whatever name it has, and a variant set
  (`<Layer>__<id>.<slug>`) uses its node's plan — no slugged plan exists. A frame that is not its plan's
  `nodeId` (a modal in its primary screen's plan) is found by no tool: pass `--plan <that plan>` to `--expect`
  and `--compare`, and that plan as `--steps`. A plan with no `navigate` runs no steps; after every load the probe waits for the screen root's tag
  (`--ready` defaults to `[data-dt-node="<frame id>"]`: a step's click can land on another page — a login bounce —
  and only the root check tells). The probe also drives the overlay/swap `on_click`/`on_press` interactions
  and the plan's `expect: "dialog"` rows itself (evidence only: `ok: true` or `ok: null`, never `ok: false`);
  the verifier does not re-drive those. A page that scrolls sideways at the design width is a high waivable
  delta (`overflowX`) on the root frame.

  What `--expect` emits, what `--compare` grades, and the run a probe without `--run` starts (it is refused while
  a verifier's run of the screen is open) are in `references/verify.md` (*Numbers*). Read the expectation's rows rather than retyping
  them into a code comment, and report the verdict `--compare` computes: it exits non-zero unless the verdict is
  `pass` or `pass-with-deviations` — waivers and descopes are the user's word, never yours.
- Render the screen at the frame's exact size (`box.w`×`box.h`, fonts loaded, animations off) with
  the stack's tooling, and also look: **structure** (every tree node present, nothing duplicated)
  and **pixels** against the `.png` — clipped/overlapping text first, then spacing, alignment,
  colour. The numbers are the script's job; your eyes catch what numbers can't express.
- **Re-render immediately before saving any screenshot you will cite as evidence.** A dev server
  with hot reload picks up edits mid-pass, so a saved screenshot can show strings the shipped
  code does not have — while the same plan block cites it as proof they were fixed. An artifact that does not
  depict the build it claims to depict is worse than none.
- Re-render key states, a large font scale, the other theme, and RTL when supported.
- Fix the largest discrepancy first, at most **5 rounds** per component, and never buy pixels with worse code —
  `references/verify.md` (*The fix loop*) has the rules; a residual difference goes in `deviations[]` with its reason.
- Only if the project genuinely has no dev server/rendering tooling available (checked, not
  assumed) fall back to a structural + visual self-review against the `.png` — and report it as
  "not rendered — reviewed statically", never as a verified match.
- **Record the evidence in the plan** under `verification`: on web `--compare … --record-plan` writes the
  tool-owned `verification.recorded` block from the report (never edit it), and you still write `coverage`
  (`hook-and-status.md` has both shapes).
- **The `Stop` hook** (`verify-build.js`) checks the built code against the plan as your turn ends: it
  **blocks** on a raw colour the plan resolved to a token, a visible node with no anchor, (web) no
  `data-dt-node` tag, and a hand edit of `verification.recorded`, and warns on the rest; run it by hand with
  `bun --no-install --no-env-file "<scripts>/verify-build.js" <plan.json>`.
- **Status is computed, never stored**:
  `bun --no-install --no-env-file "<scripts>/verify-build.js" --status <plan.json>` derives it from the
  hook's result, the hashes of `files[]` and the verify report. Write `status` yourself only as `"abandoned"`
  or `"awaiting-user"` (and back to `"pending"`); `hook-and-status.md` lists every status and what blocks.

**Reporting the evidence.** Resolve whatever the `Stop` hook blocked on earlier in the turn first. Per frame, report
the evidence (`verification.recorded.mode` — or `verification.mode` where nothing records it —, what you rendered,
the `--compare` verdict and coverage line) and the status you expect: `pass` → `verified`; `pass-with-deviations`
→ `verified-with-deviations`, with each accepted delta (node, field, designed → built, the user's reason) listed
under the evidence — accepted is not "matches".

## Several frames

Every designed frame you build gets its own expectation and compare: a feature of N frames (a list, its empty state,
an add form, a dialog, a detail view) is N sets, each named by its node. A frame that lives in another frame's plan (a
modal in its screen's plan) takes `--plan <that plan>` at `--expect` and `--compare` and that plan as `--steps`; a
second set of one node (another theme or width) is `--expect --variant <slug>`. A state the probe cannot reach by
`navigate` steps alone (it never types or chooses) needs a fixture or a deep link the app already offers, recorded in
the plan; until one exists, report the frame "not verified" with that reason. A shared shell or component is compared
in every frame that uses it — a delta in one use is a prop the component lacks, never a reason to stop comparing.
Classify what is left once: actionable (fix it), the designer's or the user's (a question), or a method limit (say so)
— rounds are for actionable rows only.

## The visual-verifier

For step 5's render-and-compare, prefer the **`designtwin:visual-verifier`** agent over checking your own work:
hand it `design/verify/<Layer>__<id>.expected.json`; it renders, measures every node, drives the designed interactions
and writes `design/verify/<Layer>__<id>.measured.json` — measurements, not a verdict. You run
`bun --no-install --no-env-file "<scripts>/verify-screen.js" --compare design/verify/<Layer>__<id>.expected.json design/verify/<Layer>__<id>.measured.json [--interactions design/verify/<Layer>__<id>.evidence.json] --record-plan --out design/verify`
on what it wrote (`--interactions` when it wrote that file; `--record-plan` records the report in the plan's
`verification` block), fix the high-severity deltas, and re-verify — every verifier pass (each re-verify round)
gets a NEW run (`--status <Layer>__<id> --phase queued --new-run`, its id passed to the verifier): an ended run takes no
more writes, and `--wait` on an old id returns at once on that run's old `done` only until a later run replaces the
status — after that it ends in exit 5, `stalled` once that run's status stops changing (`--stall`), at the latest on
`--timeout`. Your own probe without `--run` is such a later run: it
replaces the live status with its own run's, and the published `design/verify/<Layer>__<id>.status.json` too once that run
ends `done` (a `failed` one publishes nothing).

It runs for minutes and reports progress into the run cache (`node_modules/.cache/designtwin-verify/`; published as
`design/verify/<Layer>__<id>.status.json` at `done`). **Wait with `verify-screen.js --wait <Layer>__<id> --run <id>` rather than
assuming it hung** (exit 0 done, 1 failed or `blocked` on permissions, 5 timeout or no progress, 6 run cache not
accessible); the run protocol has the rest, including why it takes longer inside a build than on its own.

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
emulates reduced motion and switches animations/transitions off, waits for `--ready` — by default the screen root's
tag `[data-dt-node="<frame id>"]`, so a page that is not the screen is exit 4, never measured (`--ready none` waits
for nothing; an untagged root on a page that shows at least half of the screen root's other tags, and no other screen's tagged root, is measured with a note, and a plan with
`tagging.off` has no default — `measurable.md`) — then requires a quiet window (no navigation, no DOM churn) before measuring, and detects reloads (one re-run,
then exit 4 with nothing written). It does not use `networkidle` — Playwright's docs discourage it, and a
page with polling or a dev-server socket never reaches it. Do not re-implement any of this by hand.

A screen that is a section of the app (chosen by component state, not the URL) is reached with `--steps <plan.json>`
(the plan's `navigate`: `click` / `waitFor` / `goto <same-origin path>` — closed, navigation-only, exactly one visible
match per `click` (a `waitFor` needs at least one), a click never submits; replayed on every page load, a failing step while measuring is exit 4 with
nothing written; a click either changes the page in place or navigates to ANOTHER URL — a click that reloads the same URL
loses what it built, one re-run, then exit 4 naming the step (a link to the URL already shown counts as a `goto` for the load the click starts); a click that lands on another page,
a login bounce, is still the step's own, and the default `--ready` on the screen root's tag is what tells it apart; a
plan with no `navigate` runs no steps). The plan's `route` is advisory. After measuring, the probe drives the overlay/swap `on_click` /
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
   `<Layer>__<id>.diff.png`; start at the hot regions, then still compare the whole reference and build side by side
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
`--interactions <file>`), then writes `design/verify/<Layer>__<id>.report.json`. Driving each designed interaction is the
probe's job (the `visual-verifier` agent drives the rest and records the selector it drove); anything nobody drove
is reported `not-probed`, never `pass`. It exits non-zero unless the verdict is `pass` or `pass-with-deviations`
(nothing open, and ≥1 delta the user accepted or interaction the user descoped — waivers and descopes are the user's
word, recorded through the verify skill). That verdict is computed, and it is what you report.

Every measured file the probe writes names its run. Without `--run` (your own loop) the probe starts a run of its own,
prints `run <id>`, and ends it: `done` once the files are written, `failed` on an exit 3/4 — so `--compare` judges your
measurement by that run, and a re-run is a new run. It never measures beside another open run of the screen: while a
`visual-verifier` or verify-skill run is in flight (it writes the same `design/verify/<Layer>__<id>.*` files) the probe
refuses with exit 2 before starting anything — wait for that run
(`bun --no-install --no-env-file "<scripts>/verify-screen.js" --wait <Layer>__<id> --run <id>`), or, only if nothing is running it any more (its agent
stopped or crashed), end it: `bun --no-install --no-env-file "<scripts>/verify-screen.js" --status <Layer>__<id> --phase failed --run <id>`.

Every non-zero exit, an error, or a stop signal (Ctrl-C, a command timeout's SIGTERM, a closed terminal) ends your own
run `failed` before the probe exits. Two cases leave it at `measuring` — a probe killed outright (SIGKILL), and an exit
whose last status write was refused (the probe then prints the command that records it) — so the run records the
probe's pid, host and a deadline (its start + `--max-time` + 120 s): the next probe without `--run` ends it `failed`
itself (it says so on stderr) once that pid is gone on the same machine or, on any host, the deadline has passed, and
goes on. Before the deadline, when it cannot tell — the run was started on another host, or the pid is running — it
refuses, naming that probe's own run, when and by which pid it started; if no probe is running, end it with the
`--status <Layer>__<id> --phase failed --run <id>` command it prints. A probe that was stopped or slept past its deadline
finishes in its run when nobody took it over; when a later probe did, it finds the status naming that run and writes
nothing more (exit 2, or 128 + the signal's number when a stop signal ended it, or 1 after an error). An own run that
ends `done` replaces the published `design/verify/<Layer>__<id>.status.json` with its run's (the pid and host stay in the
run cache, never in that file); one that ends `failed` publishes nothing — only the live status says so.

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
why}]}` (yours to write) — and, on web, let `verify-screen.js --compare … --record-plan` write `verification.recorded`, the
tool's block (the report's sha256, verdict, headline and counts, `mode` — `static-only` + its `reason` for a static-only
measured file —, `renderer`, `artifacts`, open `deltas`, `a11y` from `report.behaviour.summary`), which you never edit;
elsewhere, when an
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
- Never trade maintainability for pixels: a round that adds absolute positioning, a magic offset, or a fixed size
  the export does not declare (absent `widthMode`/`heightMode` is a declaration), or replaces a token with a
  literal, is a regression even when the screenshot got closer. Record the residual in `deviations[]` (with a reason) instead —
  the record's `deltas` belong to `--record-plan`, which writes `verification.recorded` whole (a hand edit there blocks the Stop hook).
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
