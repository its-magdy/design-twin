# Making the screen measurable — tags, dialogs, `navigate`, `interactions`

Build-screen step 3 builds the screen so step 5 can measure it: every node carries its id, a dialog's root carries
its destination frame id, a screen reached by clicks has a `navigate` list, and an interaction the export cannot
express is declared in the plan. This file is the detail; the step links it.

## Contents
- Carry the node id into the markup
- Lists and shared shells
- Tag coverage and the opt-out
- Keeping tags out of a deploy bundle
- Tag a dialog or overlay's root
- A screen that is a section of the app (`plan.navigate`)
- An interaction the export cannot express (`plan.interactions`)

## Carry the node id into the markup

Tag every element that implements a node one-to-one: `data-dt-node="4210:1873"` on web, `accessibilityIdentifier`
on SwiftUI, `testTag` on Compose, `Semantics(identifier:)` on Flutter — so step 5 measures the right element instead
of guessing from text. **Tag, don't comment**: an id in a `// 4210:1873` comment measures nothing. Ids may come from
a lookup table (`data-dt-node={IDS.row}`) — the id string just has to appear in a listed file. Tags are a
measurement aid, never component identity — that is the plan's `components[]` (catalog match,
`design/codeconnect.local.json`).

**The screen root carries its frame id**: the element that is the frame gets `data-dt-node="<frame id>"`. Step 5's
probe waits for that tag after every load (its default `--ready`), so a page that is not the screen — a login bounce,
another section — is never measured. A root that cannot carry it (a shell shared by several screens keeps ONE
frame's ids, a layout component the screen does not own) still measures: when the frame's tag never shows but at
least half of the screen's other tags do, the probe measures the page as the screen after its `--timeout`, finds the
root by size and fill, and says so in a note (fewer is another section that shares the shell: exit 4) — so tag a
wrapper the screen owns with the frame id where you can. A project that
cannot tag at all (the opt-out below) has no tag to wait for: verify then passes `--ready <root selector>`, or
`--ready none`.

## Lists and shared shells

A `.map()` over designed rows tags rendered row *i* with designed row *i*'s id where one exists; a shell shared by
several screens may keep the ids of ONE frame (the one it was built from) — verify recovers much of it on the other
screens by component path, and by name path through the aliases `--expect` builds from the sibling exports (re-run
`--expect` after re-exporting a sibling), but not repeated names, a shell used twice, or a hand-written probe; a
per-screen id table (each screen's own ids from its export) still measures more. Either is fine — never invent ids.
Both follow the reuse rules; untagged sets are reported as tag coverage, never as "missing".

## Tag coverage and the opt-out

On a web profile the Stop hook counts tags across every plan's `files[]`: it **blocks** when no file carries
`data-dt-node` at all, warns below 50% coverage, and records `tagCoverage` in `verification.hook`. A project that
genuinely cannot tag says so in the plan: `"tagging": {"off": true, "reason": "<why>"}` (no reason, no opt-out).
The probe reads it from the plan passed as `--steps` and then waits for no frame tag by default (a note says so).

## Keeping tags out of a deploy bundle

Tags are dev evidence: to keep them out of a deploy bundle, strip `data-dt-node` at build time, only on an explicit
opt-in env that the deploy build alone sets — Next.js
`compiler: { reactRemoveProperties: process.env.DT_STRIP_TAGS === '1' ? { properties: ['^data-dt-node$'] } : false }`
(plain `true` strips only `^data-test`); Babel the same way, adding `babel-plugin-react-remove-properties` with
`properties: ['data-dt-node']` (an exact name) only when `DT_STRIP_TAGS === '1'`. Never key it on `NODE_ENV`:
`next build` is production, and verify measures preview builds, so verify measures a build that keeps the tags.
Never strip them in the source: the Stop hook counts them in source.

## Tag a dialog or overlay's root

Tag a dialog or overlay's root element with its destination frame id. The shipped probe clicks the opener and
accepts the dialog only when the destination frame's `data-dt-node` is on or inside the element that opened
(`:modal`, `dialog[open]`, `[role=dialog]`, `[role=alertdialog]`, `[aria-modal="true"]`, `:popover-open`), or on an
ancestor of it that became visible with it (never one visible before the click): put
`data-dt-node="<destination frame id>"` on the root of the modal/sheet (the one that carries the dialog role or
`showModal()`), not only on its inner content — an untagged dialog is `not-probed`, never a pass. A native
`<dialog>` needs no role for this.

## A screen that is a section of the app (`plan.navigate`)

A screen picked by state, not URL, gets `plan.navigate`: a short list of `{"click": "<selector>"}` /
`{"waitFor": "<selector>"}` / `{"goto": "/same-origin/path"}` steps that take a fresh page to it (each `click`
selector matches exactly one visible element, a `waitFor` at least one; no typing, no submitting — the probe
replays them many times; a `click` changes the page in place or navigates to another URL, never reloads the one it
is on). Step 5 passes the plan as `--steps`, and the probe waits for the screen root's tag (its default `--ready`) —
so tag the root with the frame id.

## An interaction the export cannot express (`plan.interactions`)

A dialog opened by a row action with no prototype reaction, say, goes in `plan.interactions` as
`{nodeId, trigger, expect: "dialog" | "url" | "selector:<css>", destinationId}` (`destinationId` required for
`dialog`, and a `dialog` row's trigger is `on_click` or `on_press` — the probe opens it by clicking an enabled,
non-submitting opener); `--expect` merges them (`--plan <plan.json>`, or the one plan that describes the frame — of
several, the one listing `files[]`) and drops, with the reason, any row it cannot grade. Change `plan.interactions`
afterwards and `--compare` is `incomplete` until `--expect` is re-run. `--compare` checks the plan file `--expect`
merged from while it exists (if that file moved, pass its new path as `--plan`).
