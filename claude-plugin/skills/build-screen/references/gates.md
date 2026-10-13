# Step 1 gates — the component map and the audit, in detail

Build-screen step 1 runs three checks before any mapping: the cross-file check (what its findings mean is the
extract skill's `references/cross-check.md`, linked from the step), the component map, and the audit. This file is
the detail behind the last two. `<scripts>` is the plugin's scripts folder — build-screen gives its real path.

## Contents
- Component map: check for the catalog first
- The catalog exists: drift-lint with the screen
- No map yet: bootstrap only what this screen uses
- The catalog does not exist
- The audit gate
- Building past a blocked audit (`auditGate`)

## Component map: check for the catalog first

Every command below reads `design/export/design-system/components.local.json`, and a single-screen pull
(`dtwin pull --node <id>`) does **not** write it: that pull exports the screen, its assets and the variables,
nothing else. So `ls design/export/design-system/components.local.json` before anything, and take exactly one of
the branches below.

## The catalog exists: drift-lint with the screen

Run the drift check **with the screen**, which is the only form whose number means anything here:

```bash
node "<scripts>/drift-lint.js" design/codeconnect.local.json \
  design/export/design-system/components.local.json --screen <screen json>
```

Without `--screen` it prints how much of the CATALOG your map covers — a figure that read `318/318 components
mapped · 0 error(s)` on a map covering 0% of the screen about to be built, because it measures the catalog against
itself. With `--screen` it prints SCREEN COVERAGE; 0% (and `catalog-rekeyed`) is a warning with a confirm question,
exit 0, like the audit's. drift-lint (and MCP `design_drift_lint`) always reads the positional catalog plus
`components.library.json` beside it and the `design/export/libraries/*/components.json` listed in
`libraries/index.json` (repeatable `--catalog <file>`), printing which; map-bootstrap does the same only with
`--screen`/`--from-proposals` (a full bootstrap stubs just the named catalog). So a component from a pulled library
is mapped, not orphaned. Fix an `ok:false` map before generating against it; heed a stale-snapshot warning.

After any hand edit, check the map's shape with `node "<scripts>/map-validate.js" design/codeconnect.local.json` —
drift-lint assumes a well-formed map. Entry `status` is `active` | `deprecated` | `needs-review`; an optional
free-text `note` is allowed; any other key is rejected.

## No map yet: bootstrap only what this screen uses

No map at all → **stop**, but run the coverage/cross-check FIRST and bootstrap only what this screen actually uses —
a full bootstrap on a real catalog stubs every component in the file (hundreds, often none of them on the screen
about to be built) and produces a confirm list nobody can evaluate:

```bash
node "<scripts>/map-bootstrap.js" design/export/design-system/components.local.json \
  --out design/codeconnect.local.json --screen <screen json>
```

scopes the stubs to the keys/ids this screen's own visible instances reference. Have the user confirm only that
short list before continuing (a `designtwin:screen-builder` subagent cannot ask: it records the list in the plan,
sets `status:"awaiting-user"`, names the list in its hand-back and never confirms for the user; the orchestrator
asks) — or, when cross-check reported `catalog-rekeyed`, use the `--from-proposals` form from `cross-check.md`
instead (also already scoped to the screen's own instance keys).

## The catalog does not exist

The normal single-screen case. This is **not** a stop, and it is not a reason to run map-bootstrap anyway — it will
just tell you the file is missing. Offer the one-command fix: `dtwin pull --design-system` writes
`design/export/design-system/` and is cheap (tokens/styles/components only — no page walk, no assets), after which
you take the branch above. If the user declines, or no bridge is available, **build without a map**: every
`INSTANCE` gets `verdict:"new"` in the plan's `components[]`, you still check the codebase by structure for
something to reuse (step 2), and the step-6 report says in one line that no component catalog was exported, so
"new" here means "unverified against Figma's catalog", not "confirmed absent from the design system".

## The audit gate

If `design/audit/<screen>.json` exists, read its verdict, findings, `crossFile` and questions. If not, run

```bash
node "<scripts>/audit.js" <screen json> --platform <p> \
  --design-system design/export/design-system --out design/audit/<screen> --gate --grid <N>
```

where `<N>` is the design's real spacing step from the spacing scale in `design/export/design-system/tokens.json`
(not `layoutGrids`, which are column guides; the audit's `gridMismatch` names the step when they differ), not the
4px default (which silently under-flags an 8px-grid system). If the audit's **Not checked** list names a
`design/export/libraries/<dir>` export that owns most of the screen's variable collections by key, re-run with that
directory as `--design-system` and `--out design/audit/<screen>.library` (no `--gate` — the first report stays the
gate's input) and read both; with only a few collections in common, keep `design-system/` (or invoke the
`designtwin:audit-design` skill for a full review on a big or unfamiliar screen, passing the screen name as its
argument — it runs in its own context, sees nothing of this conversation, and hands back the verdict and
`design/audit/<screen>.md`).

The command is part of the build, and the script ships with this plugin, so it is never replaced by a check "by
hand". `--gate` makes the process exit non-zero on any blocker; a non-zero exit **stops the build** until the user
decides. Open questions get the audit's stated default, recorded in the final report — never a silent invention.

## Building past a blocked audit (`auditGate`)

If `design/audit/<screen>.json` exists and is Blocked and the user has decided to build past it, record that
decision in the plan's `auditGate: {auditFile, crossCheckFile, verdict, overridden: [<blocker ids>], reason,
decidedBy, decidedAt}` — a blocker id is the finding's `id`: its `code`, or `code@nodeId` when it carries a node (a
repeat gets `~2`); the legacy positional `code#i` is still accepted (with a warning mapping it to the stable id and
naming stale ones "(drop it)"), and so, for a finding with no node, is its bare
code (which is its id). `crossCheckFile` is the cross-check report beside the audit (`<audit>.cross.json`), when
there is one. `plan-skeleton.js` pre-fills it from the audit; the Stop hook warns (never blocks) if a current
blocker id is missing from `overridden` or `reason` is empty.
