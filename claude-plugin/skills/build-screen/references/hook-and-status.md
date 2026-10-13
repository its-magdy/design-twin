# The plan's `verification` block, the Stop hook, and the computed status

Build-screen step 5 records the evidence in the plan; the `Stop` hook checks the built code against the plan when
the turn ends; and the status is computed from both, never stored. This file is the detail behind those three
bullets of the step. `<scripts>` is the plugin's scripts folder — build-screen gives its real path.

## Contents
- Record the evidence in the plan (`verification`)
- What the Stop hook checks
- Run it by hand
- Status is computed, never stored

## Record the evidence in the plan (`verification`)

On web, `--compare … --record-plan` writes the tool-owned keys from the report — `mode` (`"static-only"` + its
`reason` when the measured file was static-only), `renderer`, `artifacts`, the open high/medium `deltas`, `a11y`
(from `report.behaviour.summary`, when the behaviour checks ran) and a `recorded` block with the report's sha256 —
and leaves your hand keys alone; **you still write `coverage`:{rendered:[…], notChecked:[{what, why}]}** (and any
notes). It owns `deltas`: a row you wrote there is replaced (with a note) — a residual you chose to keep goes in
`deviations[]`, with its reason.

Elsewhere (or by hand) the shape is `{mode:"rendered", renderer, artifacts:[<paths on disk>], deltas:[<the
report's open high/medium deltas, [] if none>], coverage:{…}, a11y:{tool, violations, warnings, report}?}` (copied from
`report.behaviour.summary`) — an `a11y` result and an a11y entry in `notChecked` never sit side by side (the hook
flags a block that contradicts itself). A recorded block older than its report draws a warning: re-run
`--compare --record-plan` after the last change. Nothing can render: `{mode:"static-only", reason:<what you checked
for and didn't find>}`.

## What the Stop hook checks

The `Stop` hook (`verify-build.js`, as your turn ends) checks the plans your session wrote (Write/Edit, or
plan-skeleton's `--out`) and the plan whose `files[]` alone lists a file you wrote with Write/Edit — it does not
read other shell commands, so edit the plan and the code with Write/Edit, not `sed`/`cp`/a redirect. A session that claims no
plan checks nothing — an orchestrator that only delegated, or one that edited only files several plans share; the
screen-builder's own hook still gates each delegated build.

It **blocks** on: a raw colour in a source file of `files[]` whose value the plan resolved to a real token (`#hex`,
`0xFF…`, `rgb()`; comments, prose strings and `.svg`/`.json` files are not scanned, and a line that *defines* a
token, e.g. `--color-figma-brand-600: #5B5FC7`, is not a usage), a visible design node with no anchor, and — web
profiles — no `data-dt-node` tag in any plan's files.

The rest warns: merged Figma tokens, missing a11y/coverage evidence, tag coverage below 50%, `[16px]` where a token
exists, a `reused` module nothing that renders the screen imports, a colour `codeToken` declared nowhere (skipped
when the project has a `tailwind.config.*` — Tailwind v3 colours live there), a no-token row (`codeToken:
null`/`MISSING`) without a `decision` ("no token exists, kept as a one-off literal" is complete), header gaps, a
deviation without `{nodeId, field, designed, built, reason}` or one that says a node was left out while the plan
still reuses or anchors it, and an `auditGate` whose `overridden` misses a current blocker id or whose `reason` is
empty.

A resolved value that must stay literal goes in `allowedLiterals`: `{"value": "#5B5FC7", "reason": "…"}` (exact
string, alpha included) or `{"file": "…", "reason": "…"}` for a generated token file.

## Run it by hand

Run it the same way the Stop hook does: `node "<scripts>/verify-build.js" design/plan/<Layer>__<id>.json` (the plan
path is a positional argument). It reads the hook's JSON from stdin only when fd 0 is not a TTY; a piped payload
that delivers nothing within 1 s is treated as "no payload"; the whole read is capped at 60 s naming what it was
still waiting on. A manual run from a terminal never blocks on stdin at all.

## Status is computed, never stored

The hook records its result and a hash of every file in `files[]` — and of every module the plan's
anchors/components map (`mapModule`: a project-relative file; one with no extension resolves like an import,
`.tsx`/`.ts`/`.jsx`/`.js` then `/index.*`; an `@/`/`~/` alias or a package is not hashed — `--status` and the
verify report name it once) — under `verification.hook`; `node "<scripts>/verify-build.js" --status
design/plan/<screen>.json` derives the status:

- `verified` only when the hook passed, no listed file changed since, **and** the screen's
  `design/verify/<…>.report.json` (schema @2, `--compare` run from the project root) says `pass` and measured this
  design and these files — compared by content hash, never by time, so a no-change re-pull or a `touch` changes
  nothing;
- `verified-with-deviations` when it says `pass-with-deviations` instead;
- else `failed`, `stale`, `unverified` (no, old or out-of-date report — including one computed before the plan's
  `waivers[]`/`descopes[]` last changed), `static-only`, `blocked` or `pending`.

Write `status` yourself only as `"abandoned"` (not to be finished) or `"awaiting-user"` when you end the turn to ask
something the build is blocked on (MISSING token, audit blocker, map review; a step-1 pause creates
`{screen, status:"awaiting-user", files:[]}`), and back to `"pending"` when you resume — the hook skips a paused
plan and never approves one.
