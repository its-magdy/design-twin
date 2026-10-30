# How `--compare` grades — the rules behind the verdict

The verify skill's step 4 names the four verdicts; this file is how each input is graded. Read it when a report
line needs explaining, before telling the user why a node or interaction landed where it did.

## Contents
- [`--record-plan` in full](#--record-plan-in-full)
- Run integrity
- Unmeasured is not passed
- Page overflow at the design width (`overflowX`)
- Interaction states and plan interactions
- Tag coverage, shared shells and foreign tags
- How a node was matched caps its severity
- `match (size)`: the element may not be the node
- Text width
- Values a layer cannot show
- Opacity, table rows, strokes
- Excluded by method; numbers are px

## Run integrity

`--compare` reports `incomplete` when the measured file names no expectation, does not match it, or the status says
the verifier had not finished, or the status of the measured file's own run names another measured file, or no
status of the measured file's run records it — even with high mismatches: those numbers belong to an unverified
run, so they are listed but never graded `fail`. Every measured file the probe writes names its run: `--run <id>`'s,
or — without `--run`, build-screen's own loop — a run the probe starts and ends itself (`done`, or `failed` on an exit
3/4), so it is judged by that run like any other. A measured file that names no run (written by hand on a native
stack, or by an older probe) is judged by the run whose status is beside it: `incomplete` unless that run is at
`measured` or `done` and its status records this very file (its sha256 — `--status <Layer>__<id> --phase measured --run
<id>` records it). No timestamp decides which run a file belongs to. With no status beside it at all there is no run to
judge it by: nothing is said, and its interaction rows are agent evidence.

## Unmeasured is not passed

`notMeasured` has one row per node spec that got no measurement (so `nodesExpected − nodesMeasured` is exactly its
length); `fieldsNotMeasured` lists values a measured node did not report. Both block the pass. Silence is not
evidence.

## Page overflow at the design width (`overflowX`)

The probe reads `measured.page` in the measurement pass (`scrollWidth` vs `clientWidth` of the document at the
measured viewport). A page that scrolls sideways at the design width is a HIGH delta on the root frame (field
`overflowX`, expected `clientWidth`, actual `scrollWidth`) — waivable: recorded as in step 6 with
`--node <frame id> --field overflowX`, only when the user says it is intended. It is not judged (coverage
`pageOverflow` says why, nothing graded) when the frame is designed to scroll horizontally, the viewport is not the
design width, the overflow is clipped (`overflow-x: hidden`/`clip` on the page: a note only), or the page was not
measured. `position: fixed` elements never count; an off-canvas absolutely-positioned or transformed drawer does.
`coverage.pageOverflow` reads `ok` | `overflows` | `clipped` | `not measured` | `not at design width` |
`designed to scroll`.

## Interaction states and plan interactions

Interaction states, not two: `pass` (driven, with the selector), `fail` (driven, did not work), `not-probed`
(nobody drove it — neither passed nor failed), `undesigned` (its destination was never exported: counted in the
headline, never blocks a pass; a probe showing it working still passes — decided at `--expect` from
`pages/index.json` and every `pages/<page>/index.json`, per Figma file — a `change_to` to a component variant never
counts as undesigned — so re-run `--expect` after exporting that destination), `descoped` (the user decided it
stays inert — see step 6).

The export cannot carry every control a design implies, so the plan's `interactions[]` rows —
`{nodeId, trigger, expect: "dialog" | "url" | "selector:<css>", destinationId}` (`destinationId` required for
`dialog`, whose trigger must be `on_click` or `on_press`) — are merged into the expectation at `--expect`
(`--plan <plan.json>`, else the ONE plan in `design/plan/` that describes the frame — its `nodeId`, else the id its
`<Layer>__<id>.json` name carries; several are exit 2 before anything is written: keep one, or pass `--plan`;
`--compare` picks the plan by the same rule, except that the plan file `--expect` merged from
wins while it still exists — an input note says so — and when that file is gone the reason names both plans and
asks for `--compare … --plan <its path now>` or `--expect … --plan <the plan you intend>`). A row naming no visible
export node, an unknown `expect`, a `dialog` without `destinationId` or on another trigger, or one duplicating an
export row (the export wins) is dropped, and `--expect` says why. Their hash binds the expectation: change
`plan.interactions` after `--expect` and `--compare` is `incomplete` until `--expect` is re-run (with the `--plan`
it names, when it names one; recording a waiver still works). A plan with `navigate` and a probe run without
`--steps` gets an input note. The report's `inputs.reach` records the `--steps` that reached the screen.

## Tag coverage, shared shells and foreign tags

**`untaggedInstanceSets` is tag coverage, not presence.** It lists instance sets the probe could not point at (no
`data-dt-node`, no reported setName). A list rendered by one `.map()` and a shared app shell tagged with another
frame's ids both leave gaps here by design, so it never fails a screen on its own — never read it as "N components
were never built".

**A shared shell is counted apart, for information.** An outermost instance whose nodes matched through another
screen's id (`tag-shared-path`, `tag-alias`, a shared component path) — or that the plan marks
`anchors[<id>].shared: true` — is a shared shell: the headline reads `nodes measured a/b (shared shell c/d)`, and
its untagged sets are listed under `untaggedInstanceSetsInShell`. The split never changes the verdict.

**Foreign tags are informational.** `data-dt-node` values on the page that name no node of this expectation — a
stale id prefix, another screen's id, an alias — are listed in `probe.foreignTags` (classified prefix drift / alias
/ unknown). They never change the verdict; a stale prefix is worth retagging.

## How a node was matched caps its severity

Every measured node says how it was found (`matchedBy`). A delta on a node matched by `text-ordinal` or `tag-alias`
is at most medium; by `position` or any other value a hand-written probe invents (`structural`, …), at most low — the
original severity stays on the delta as `cappedFrom`, and `cappedBy` says which cap(s) applied (`"match"` for this
one, `"size"` for the `match (size)` cap below). No cap for `tag`, `tag-shared-path`, `text`, `frame`, a shared
component path, the hand-written synonyms `data-dt-node` and `id` (read as `tag`), or no `matchedBy` at all. A
capped delta keeps its lower severity, but any capped delta blocks a plain pass: the verdict is `incomplete` ("N
delta(s) on low-confidence matches — tag these elements"), never `fail`, never `pass`. A tag on the node's own
element removes the cap.

## `match (size)`: the element may not be the node

When the matched element is at least twice (or at most half) the designed size on an axis AND at least 8px off (a
hug axis that only grew counts only when the other axis is off too; TEXT nodes, leaves and inline matches are
exempt, and a frame root's height that only grew counts only when its width is off too), the report adds one medium
`match (size)` row (designed `[w, h]` → built `[w, h]`) and caps every other delta of that node at low — they may
be measurements of the wrong element. Check which element carries the id. If the user confirms it IS the node, a
waiver on `match (size)` accepts the element and lifts ONLY the size cap — its other deltas count again at their own
severity, unless a match-confidence cap (`position`, `tag-alias`, `text-ordinal`, a hand-written value) also
applies: that one stays until the element is tagged.

## Text width

Hug text (auto width) is compared box to box, tolerance 1px. Fixed- or fill-width text is compared by ink: the
built text's width (`textBox`, a `Range` over its characters) against the design's rendered text width
(`renderBox.w`), tolerance 3px, labelled `width (text ink)` — the Figma box of a fixed-width text is listed under
`notComparable`. Width is not comparable only when the DESIGN truncates — its ink fills the box (ink ≥ box − 3px) or
it allows more than one line (`maxLines` > 1); a text set to truncate whose ink ends well inside its box is compared
by ink. A placeholder's width and x are not comparable (no `Range` reaches its characters). A TEXT node's x and
width come from `textBox` only, so the probe reports it for every TEXT node.

## Values a layer cannot show

A radius on a layer that draws nothing (no fill, stroke, effect or clip) is `notComparable`; so is padding a fixed
axis cannot show — per side: in an overfull fixed box only the side the content does not start from (start-aligned
→ the end side; centred, or `space-around`/`space-evenly`, → both), and both sides of a centred axis with equal
padding. On a wrapping auto-layout list's main axis the padding sets where it wraps, so it shows (even when
centred): that axis is overfull only when its largest child alone is wider than the inner width; on its cross axis
the content is the stacked lines (children packed into lines, each as tall as its largest child, plus the gap
between lines). A FRAME/INSTANCE id on a `display: inline` element measures its text's box, not a frame's: its
width, height, x, y, radius and padding are not measured — tag the element that owns the box.

## Opacity, table rows, strokes

**Opacity is stated on every node that paints or carries copy** (1 when the design leaves it at 100%), so a built
`opacity: 0` is a delta. A node drawn in a hover/focus state whose opacity was only measured at rest is not measured
for opacity (a hover-revealed control reads 0 at rest).

**Rows don't draw corners.** `border-radius` on a `<tr>` (or `<thead>`/`<tbody>`/`<tfoot>`) does not render,
whatever the computed style says: radius on such an id is not measured — report the corner cells' radii under the
id, or tag the cells.

**Strokes may be rings.** A stroke built as a ring (`box-shadow: 0 0 0 Npx`, Tailwind `ring` / `inset-ring`) or an
outline at offset 0 / −width / −width/2 (a centre stroke) is read as the border (`strokeFrom` says which, `strokeAlign` which side). A real border
width is compared against the design width as CSS draws it (Chromium floors a border to whole pixels, minimum 1px),
a ring's against the designed width; tolerance 0.5px either way, so a 1px design built with no stroke is a delta.

## Excluded by method; numbers are px

**Excluded by method** (`notComparable`, `unverifiable`) and the report's `limits` say what this method cannot see
(`::placeholder` colour unless reported, `::before`/`::after`, a `rotate` that reads `transform: none`, the fill of
an icon drawn by an `<img>`). Say them; they are not passes.

**Numbers are px.** A number or a `"20px"` string is compared as 20 (`letter-spacing: normal` is 0, and so is
`gap: normal` when the probe reports `display` flex/grid). A percentage, another unit, any other keyword, or a value
CSS cannot produce (a negative size, padding, radius, font-size or gap, opacity above 1, a row gap wider than its
table) is listed as not measured with the reason, never compared as text. An unverifiable value (an `<img>` icon's
fill) is counted in the headline; it does not block the verdict, and it is not a pass — compare the asset file.

## `--record-plan` in full

`--record-plan` writes the plan's `verification.recorded` block from this report, so nobody copies it in by hand. The block is the tool's, written whole every run: the report's file, sha256, verdict, headline and counts, `mode` (`"static-only"` + the measured file's `reason`, and no `renderer`, when it was static-only), `renderer`, `artifacts`, the open high/medium `deltas` and `a11y` (when the behaviour checks ran). Never edit it: `verify-build` **blocks** on a key it does not write, a value of the wrong kind, or a verdict, headline or count that the report it names (same sha256) does not say — or any other key that report decides (mode, reason, renderer, the deltas, a11y); the edit reopens a plan the hook had closed, and `--status` then reads blocked (or failed, when a report says fail — that comes first). Re-run `--compare --record-plan` (or restore the block); a residual the builder keeps goes in `deviations[]`, never in the record. The rest of `verification` — `coverage`, notes — is yours, and `deviations`, `waivers`, `descopes` and `status` are never touched. A plan recorded before the block held all of this (or filled by hand) keeps `mode`, `artifacts`, `deltas`, `a11y`… at the top level of `verification`; the first `--record-plan` removes the ones the new record holds (the record has its own, written from the report), with a note — a hand `a11y`, or a `reason` (static-only) or `renderer` (rendered) this report does not give, stays at the top level and is still read from there — and after that a key the record holds — or a hand `headline`/`verdict` — at the top level is ignored, with a warning; recording never reopens a plan (the hook's hash does not cover `verification`; a hook record from before that change is re-stamped in the same write). The plan is the one the compare already uses (`--plan <plan.json>`, else the ONE plan in `design/plan/` that describes the frame); none, or several and no `--plan`, is exit 2 before anything is compared. The plan records project-relative paths only: a report written outside the project (`--out` elsewhere) is exit 1 — the report stays written, the plan is not updated. If the report is edited or re-run later, `verify-build` warns that `plan.verification` records an older run — re-run `--compare --record-plan`; the report, not the plan, carries the verdict.
