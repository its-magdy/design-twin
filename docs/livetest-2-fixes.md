# Live test 2 — finding → fix

The adversarial end-to-end run (`FINDINGS.md`, 103 entries; `FIDELITY.md`, the measurement tables)
against two connected Figma files on a free plan. This table maps each finding to what changed, or
says why it did not.

Status vocabulary: **fixed** · **fixed (docs)** · **won't fix** (with the reason) · **kept** (a
positive the tests now hold in place).

## Layout changes this run forced

Two shapes changed, and every path below follows from them.

1. **A single-screen pull files into `pages/`, like every other pull.** Flat `design/<Screen>.json`
   named files from the layer alone, so two frames called `Popup` overwrote each other and a `--node`
   project had no index, no page context and nothing `sync-design` or `verify` could address.
   Now: `pages/<Page>/<Screen>__<node-id>.json`, with `.vars.json` and `.assets.json` beside it and a
   merged `pages/index.json`.
2. **`design/export/` is the only thing `dtwin` writes.** `design/` held two incompatible kinds of
   file under one name — regenerable export and irreplaceable decisions — and "delete `design/` and
   re-pull" destroyed the second kind. `design/README.md` states the split; `dtwin doctor` reports
   which layout a project uses and keeps the old flat one working.

## Priority 1 — blockers

| # | Finding | Status | Where |
|---|---|---|---|
| 35, 64 | `--node` pull REPLACES `design/variables.json`; earlier screens lose their tokens | fixed | `bridge/variables-merge.js` (new), `bridge/write-out.js` — union keyed on each variable's Figma key, per-pull slice kept verbatim beside the screen, value conflicts recorded in `_conflicts` + `hygiene` rather than resolved silently |
| 37, 41, 98, 65, 69 | a screen whose tokens/components come from a different library is silently accepted | fixed | `design-to-code/cross-check.js` (new): foreign collection keys, 0%-catalog coverage, name collisions with different values, name+structure fallback marked `verified:false`, ambiguous names left unmatched. `drift-lint --screen` replaces the meaningless "318/318 mapped" with coverage of the screen and exits 1 at 0% |
| 56 | audit-design reasons only inside one screen JSON | fixed | `design-to-code/audit.js --design-system` folds the cross-file pass in; the report leads with "Does this screen come from that design system?" and the token-binding table now says what "bound" means |
| 102, 99–101, 80, 85, 92, 81 | "verified"/"pass" over a build with ~35% of sampled values wrong | fixed | `design-to-code/verify-screen.js` (new): `--expect` emits the design's numbers as data (so nobody retypes them into a comment), `--compare` diffs per node per field against explicit tolerances, plus component coverage and `reactions`-driven interaction checks. The verdict is computed; `<Screen>.report.json` is always written |

## Priority 2 — output shape and architecture

| # | Finding | Status | Where |
|---|---|---|---|
| 103 | no feature-based architecture, never asked | fixed (docs) | `build-screen` SKILL |
| 96, 97, 42, 50 | assets named by node-id path, duplicated per instance | fixed | per-screen `<Screen>.assets.json` with content hashes names the duplicates; plugin-side naming |
| 73 | icons export with the Dark-mode colour baked in | fixed (docs) | `build-screen` profiles |
| 72 | huge flattened SVG illustrations not flagged at export | fixed | `bridge/write-out.js` warns at pull time with the byte count and `<path>` count |
| 79 | Light mode derived purely from token modes is unreadable | fixed | `cross-check.js` `single-mode-export` |
| 47 | `sync-design` paths don't fit a `--node` export | fixed | the `pages/` unification makes its documented paths correct for every pull shape |

## Priority 3 — CLI / docs correctness

| # | Finding | Status | Where |
|---|---|---|---|
| 4 | `dtwin mcp --help` starts the server | fixed | `bridge/figma-pull.js` |
| 5 | `dtwin screenshot --help` errors | fixed | `bridge/figma-pull.js` |
| 8, 90 | `init --help` promises `target.json`; the run skips it | fixed | `bridge/init.js` — always written, `profile:null` when undetected |
| 9 | `init`'s next steps ignore the multi-client rule | fixed | `bridge/init.js` |
| 10 | `init` tells an already-installed plugin user to install it | fixed | `bridge/init.js` detects the installed plugin |
| 13 | `fileKey` null makes one documented `--client` form dead | fixed (docs) | |
| 14 | `whoami` stats missing | fixed | |
| 17 | contradictory library warning | fixed | |
| 18 | `list` calls SECTION/TEXT nodes "top-level frames" | fixed | |
| 19, 63 | emoji / trailing-space names | fixed (docs) + fixed | filenames now carry the node id |
| 20, 31, 34 | three different answers for where the screenshot PNG lands | fixed | one directory: `assets/` |
| 27 | `componentsDir` never written | fixed | |
| 28, 49 | counts and outputs undocumented | fixed (docs) | |
| 43, 44 | undocumented manifest keys, `codeSyntax`/`annotations` absent | fixed (docs) | |
| 48 | doctor reports the wrong file as "the export" | fixed | `bridge/doctor.js` lists every Figma file the export mixes |
| 57 | `platformAssumed` JSON contradicts the prose | fixed (docs) | |
| 59 | audit hand-off only in chat | fixed (docs) | |
| 60 | build-screen's first step reads a plugin-internal file | fixed (docs) | |
| 74 | MISSING-token rule deadlocks on unbound raw values | fixed (docs) | |
| 78 | `status.json` timestamp off by 16h | fixed (docs) | |
| 87, 88 | Stop-hook false positives | fixed | `design-to-code/verify-build.js` |
| 2, 23 | help assumes a repo clone | fixed (docs) | |
| 16 | `list libraries` 12s with no progress | fixed | |
| 30, 45 | radius `Full` = 1e9, float noise | fixed | `cross-check.js` sentinel check + export-side rounding |

## Deliberately not fixed

| # | Why |
|---|---|
| 50 (assets accumulate, never pruned) | A read command that deletes files is a worse failure than a directory that grows. Each screen now ships an `.assets.json` index naming exactly what it uses, with content hashes and duplicate groups, so the question "which of these can I delete" is answerable — the deletion stays the user's. |
| 71 (only 3 of 13 rows carry a `navigate` reaction) | Nothing in the export distinguishes "the designer stopped wiring" from "only these rows navigate". Verification now drives every designed edge and reports the ones never exercised, which surfaces the gap without guessing the intent. |
| 75, 76 (Docker on arm64; Playwright install cost) | Environment, not plugin. The verifier now states the Playwright download cost before spending it. |
| 24, 25, 32, 36, 40, 54, 58, 61, 66, 67, 68, 82, 86, 89 | Positives. Each is held in place by a check in the suites rather than left to luck. |

## Test suites

| suite | before | after |
|---|---|---|
| `test/harness.js` | 395 | 414 |
| `test/bridge.test.js` | 492 | 529 |
| `test/verify-build.test.js` | 64 | 77 |
| `test/cross-check.test.js` | — | 47 (new) |
| `test/verify-screen.test.js` | — | 44 (new) |
| design-to-code / audit / ui / design-diff / mcp | 281 / 70 / 14 / 27 / 16 | unchanged |
