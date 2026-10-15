# Probe driving and interaction evidence

How the shipped probe reaches a screen and drives its interactions, and the evidence rules for every interaction
the agent drives itself. The verify skill and the visual-verifier agent follow this one copy.

## Contents
- Reaching a screen that is a section of the app (`--steps`)
- Which page loads belong to a step
- The overlay drive and the dialog contract
- Interactions the agent drives
- Evidence precedence
- States, painters and inferred rows

## Reaching a screen that is a section of the app (`--steps`)

A screen picked by component state, not by the URL, is not reached by `--url` alone: the probe would measure the
default section and read every spec as "not measured". The plan's `navigate` list takes the page to the screen —
pass the screen's plan to `--steps` (a JSON array of steps works too); a plan with no `navigate` list runs no
steps, and the probe says so in a `note` line. The plan's `route` stays advisory free text: it never reaches the screen.

The vocabulary is CLOSED and navigation-only — `{"click": "<selector>"}`, `{"waitFor": "<selector>"}`,
`{"goto": "/same-origin/path"}`; no fill, press or hover. A `click` selector must match EXACTLY ONE visible
element; a `waitFor` succeeds once AT LEAST ONE visible element matches. A click never submits a form
(`[type=submit]`, or a typeless button inside a `<form>`, on the element or at its click point, is refused), so the
steps are idempotent — never write a step that changes state — and they are replayed after every page load, before
`--ready`: in the measurement pass, its re-run after a same-URL reload and on every page the probe drives an
interaction on. A step that fails while measuring is exit 4 and nothing is written (the log names the step; exit 2
for a bad steps file); on a driving page it only makes that row `ok: null` ("not-run").

After every load and the steps the probe waits for the screen root's tag — `--ready` defaults to
`[data-dt-node="<frame id>"]`, the expectation's frame: a click's navigation to another URL is the step's own even
when the app sends it elsewhere (an expired session bouncing to a login page), and only the root check tells that
page from the screen. A root that never shows is exit 4 naming the default; pass `--ready <selector>` only for a
root tagged otherwise, and `--ready none` only to wait for nothing. The probe records
`measured.reach` (`steps`, `sha256`, `source`, `url`) and prints where the steps ended (`reach … → <url>`);
`--compare` reports it under `inputs.reach` (`matchesPlan` when the plan has `navigate`), and a mismatch is an input
note, never a verdict.

## Which page loads belong to a step

A `goto` step's load is its own; so is a `click` step's navigation — a document load that goes to ANOTHER URL than
the page shows (the fragment ignored), whether its request starts while the click runs or LATER (until the next
`click` / `goto` step or the end of the steps): `await save(); location.href = "/other"` after any delay is the
step's own navigation. A step's own load is never counted in `afterInitialLoad`, and every settle first waits for
the document to finish loading (`document.readyState` `"complete"`; at most 10 s per document, then it measures
anyway, with the note "the document had not finished loading", and no later settle waits for that document again;
the probe's own loads — the first `--url` load and a `goto` — wait for the load event up to `--timeout` instead,
so a slow page is measured fully loaded, and one whose document arrived but never finishes loading is then measured
with the note "the page had not finished loading when the goto gave up"; a server that never answers — or a page
that goes on to one before its load — is still "could not load"). A page that rendered and then cancelled its own
navigation is measured as it stands; "could not load" names the cause in plain words — a URL that answers with no
document (e.g. 204 No Content) or starts a file download is not a page.

A new document at the SAME URL (`location.reload()`, a dev-server reload, `location.href = location.href`) is never
a step's own — not even one the click's handler starts at once (`draw(); location.reload()`) — except a `click` on a
link (the element or its closest `a[href]`, same tab) to the URL the page already shows (a "refresh" link, the URL
tab already open): that load is the step's own, like a `goto`'s (only the load the click itself starts; a later
same-URL load is a reload). After a click that changed the page IN PLACE (no navigation), such a reload wipes what
the click built: the pass is re-run once with the steps replayed; the same again is exit 4 "the page reloaded
(<url> again, not a navigation) after step N … had changed it in place". That is a step problem, not a dev-server
one: reach the screen by its own URL (`--url` or a `goto` step) or by a click that navigates to another URL. A
reload after a `goto` or after a click's own navigation is only waited for (it counts in `afterInitialLoad`), never
a re-run.

## The overlay drive and the dialog contract

After measuring, the shipped probe drives every expectation row that is an `overlay` or `swap` action with an
`on_click` / `on_press` trigger, and every plan row with `expect: "dialog"` (source `plan`; `--expect` keeps such a
row only with an `on_click` / `on_press` trigger), each on a fresh page (steps replayed). A disabled opener
(`:disabled`, `[disabled]` or `aria-disabled="true"`, on it or on an ancestor) is not driven, and an opener that
would submit a form (`[type=submit]`, or a typeless button inside a `<form>`, on it or at its click point) is not
clicked — both `ok: null` with the reason. Otherwise it reveals a hover-hidden opener by hovering it first (as for
the hover states), clicks the element tagged with the row's `nodeId` with the real mouse (`activation: "mouse"`; a
covered or non-actionable opener gets a `"synthetic"` in-page click, which is never a user activation and stays
`ok: null`), and watches up to 2 s for a newly visible element of the dialog contract, in order: `:modal`,
`dialog[open]`, `[role=dialog]`, `[role=alertdialog]`, `[aria-modal="true"]`, `:popover-open` (`detectedBy` names
the first; a destination tag newly appearing without one is `selector-appeared`).

It records the rows in `measured.json`'s `interactions[]` as `ok: true` or `ok: null` — never `ok: false`: a miss
is `ok: null` with the missing piece in `detail`, and nothing detected is `not-probed`, not a failure. `ok: true`
needs exactly one opener, a mouse activation, something of the contract opened (an allowed outcome), no document
load, and the destination frame's `data-dt-node` tag on or INSIDE the opened element (or on an ancestor of it that
became visible with it — never on one that was already visible). A builder who does not tag the dialog's root with
its destination frame id gets `not-probed`, never a pass.

Do not re-drive a row the probe drove with `ok: true`. A row the probe left `ok: null` stays the agent's to drive if
it can; that evidence is graded on its own terms (below), and a probe miss never overrides it.

## Interactions the agent drives

The agent drives every designed row the probe does not — navigate, `change_to`, hover and pressed rows, and an
overlay row the probe left `ok: null` — and names the components it judges genuinely absent. Results go in
`<Screen>.evidence.json` — staged in the run's stage dir and published into `design/verify/` at `done`, never
written there directly — an object `{"interactions": [...], "components": [{"setName", "present": false,
"detail"}], "inferred": [...]}` (`inferred` is optional) that the caller passes to `--compare` as `--interactions` (a bare JSON array of
interaction rows also works). They never go into `measured.json`.

One result per `nodeId` + `trigger`: `{"nodeId", "trigger", "ok": true|false|null, "selector", "selectorCount",
"outcome", "navEvents", "detail"}`.

- **`nodeId` and `trigger` are copied VERBATIM from the expectation row** (`on_click`, not `on_click (name
  link)`): a result whose pair matches no row is counted under "matched no designed interaction" and credits
  nothing.
- `selector` is the exact selector driven and `selectorCount` how many elements it matched
  (`document.querySelectorAll(selector).length`). `ok: true` without both, or with a count of 0, is not a pass —
  `--compare` turns it into `not-probed`.
- **`outcome`** is what actually happened: `url-changed`, `dialog-opened`, `selector-appeared`, `state-changed` or
  `none`. **`navEvents`** is the number of DOCUMENTS LOADED in the main frame during that interaction — a reload or
  a full (cross-document) navigation. Count page `load` events between driving and reading the outcome, or set a
  marker before (`window.__dtMark = 1`) and check it after (gone = a new document). An in-page URL change
  (`pushState`, a `#hash`) loads no document: `navEvents` 0 — never count `framenavigated`, which fires for those
  too.
- A pass needs exactly ONE matched element (`selectorCount` 1), an outcome allowed for the designed action, and no
  unexpected document load. Only a navigate, back or url action may load a document (`navEvents` >= 1, with
  `url-changed`); an in-page `url-changed` (`navEvents` 0) passes wherever the action allows `url-changed`. An
  overlay opened as a route, or a tab kept in the query string, records what appeared (`dialog-opened`,
  `selector-appeared`, `state-changed`), not the URL. Anything else — evidence with no `outcome`/`navEvents`,
  `ok: null`, or no evidence — is `not-probed`. Never infer an outcome from the `detail` text.
- **A dialog detector you write yourself uses the SAME contract the probe does — never a `[role=dialog]`-only
  detector.** An element newly visible that matches, in this order, `:modal`, `dialog[open]`, `[role=dialog]`,
  `[role=alertdialog]`, `[aria-modal="true"]`, `:popover-open` (each in its own try/catch: an unknown selector
  throws), polled every 100 ms for up to 2 s after the click (a framework commits a dialog a frame or two later),
  and the destination frame's `data-dt-node` tag must be on or inside it (or on a NEWLY visible ancestor of it —
  never one visible before the click). A native `<dialog>` opened with `showModal()` carries no role — a
  `[role=dialog]` detector reads it as "nothing opened".
- Drive the element that carries that node's id (or that you matched to it); a node is credited only with a result
  from its own control.
- Not driven? `"ok": null` with the reason — it is reported `not-probed`, not `fail`. Driven and it did not do what
  the export says? `"ok": false` with what happened.
- A row marked `destinationExported: false` (its destination was never exported) is still driven and recorded like
  any other; `--compare` reports it `undesigned`, which never fails the screen. A control that looks deliberately
  inert is still recorded as it behaves — descoping it is the user's decision, and the agent never writes waivers or
  descopes.
- **components**: which of the expectation's `instances` render, by `setName` (or by `nodeId` for a specific
  element). A component genuinely NOT in the build is `{"setName": "…", "present": false, "detail": "<what you
  looked for>"}` — the only thing that fails a screen for a missing component. A missing tag is not absence.

## Evidence precedence

Probe rows are authoritative only in a run with an intact status chain (`--run <id>`'s, or the run a probe without
`--run` starts itself): `measured.json` carries the shipped
probe's identity and a run id, the run's status names this very file's sha256, and the run has no integrity
problem. A `by` field in a file means nothing. In such a run a probe pass (full evidence: selector, one match, an
allowed outcome, no document load; destination tag inside) overrides an agent row that disagrees — the disagreement
becomes an input note and `overridden` on the result; a probe pass without the destination inside is not a pass; a
probe miss (`ok: null`) or a row cut by the time budget never overrides an agent row that has full evidence, and
with none the row is `not-probed` with the probe's detail. When the file is not run-bound its rows are graded as
agent evidence, with an input note. Known limit: the binding is the run's status chain, nothing more — a measured
file written by hand and recorded with `--status --phase measured` binds too, but its rows gain no pass power beyond
what the evidence rules and the destination tag already demand (it can only override that run's own agent rows).

Each graded interaction result says `evidenceFrom` (`probe` | `agent`) and, for a probe row, `activation` /
`detectedBy` / `revealedBy`; the headline coverage counts `interactionsByProbe` ("N driven by the shipped probe
(dialog contract)"). A detail that quotes the evidence says `probe said:` for the run-bound probe's row and
`agent evidence said:` otherwise.

## States, painters and inferred rows

**States are measured on the node that owns them.** A control inside a row the designer drew hovered carries
`drawnStateFrom` (the row's id); the probe hovers that OWNER at a point clear of the control, so the row's `:hover`
is on and the control's own is not (`hoverVia` names the element it hovered). Measuring by hand, do the same: hover
the owner, not the control. A note "hovered the element itself" means no free point or no tagged owner was found —
tag the owner with its id.

When an element's own background is transparent, the colour compared is the one of the ancestor (or same-box child)
that paints it (`paintedBy`; one input note lists them). A sibling or overlay painting over the element is not seen
(it may pass), and an element its own children paint all over gets no painter (compared as transparent).

`states` sit beside `styles` on a node (`nodes[].states`), never inside it — a `states` key inside `styles` is
listed as an unknown key and never read.

**Hover and press feedback is more than a background.** Before calling a hover or press "no change", read
background, colour, `filter`, `opacity`, `box-shadow`, `transform` and `outline` with the element in that state —
all of them are readable with `getComputedStyle` (and `rotate`, which `transform` does not show). The probe's
effective-paint check (`paintedBy`) covers `backgroundColor` only; the others are the agent's to look at, as a
`note`.

**Inferred, not designed.** What the build does that the design never drew is listed in its own report section,
never graded and never in the verdict: plan-declared interactions (the export carries no link), interactions whose
destination was never exported, a state measured on a node whose design draws no such state (`states` on a spec
without `drawnState`), and the agent's own `inferred[]` rows in the evidence file — `{nodeId?, state, built, why?}`,
e.g. an error message, an empty list, an open dropdown or a loading state the design has no frame for. The headline
says `· N inferred (not designed)`; the section reads "judged against best practice and the design's intent, never
'matched'". Say what you saw, for the designer to confirm or draw — not that it is right or wrong, and never as a
pass.
