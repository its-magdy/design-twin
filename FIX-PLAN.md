# FIX-PLAN — livetest-3 (branch `fix/livetest-3`, base 7568d78)

Evidence: `/Users/mohamedomarwork/design-twin-livetest-3` (read-only). Prompts: `FIX-PROMPTS.md` there.
Orchestrator validated every prompt's reproduce block against this checkout on 2026-09-23 before any
fix was started. All headline claims reproduce, with the exceptions listed under "Disagreements".

## Baseline (before any fix)

| suite | result |
|---|---|
| test/design-to-code.test.js | 281/281 |
| test/audit.test.js | 70/70 |
| test/verify-build.test.js | 77/77 |
| test/ui.test.js | 14/14 |
| test/cross-check.test.js | 47/47 |
| test/verify-screen.test.js | 44/44 |
| test/design-diff.test.js | 27/27 |
| test/bridge.test.js | 528/529 — the one failure (`[doctor-cli] with no token, the plugin probe is SKIPPED`) is environmental: `FIGMA_BRIDGE_TOKEN` is exported in this shell and overrides the saved token. Run that suite with `env -u FIGMA_BRIDGE_TOKEN` to see 529/529. |
| test/harness.js | 414/414 |

Reproduced today (same numbers as the findings): `specs 272 hidden 83 / instances 112 hidden 61 /
interactions 28 hidden 22`; both plans `verified` vs reports `fail`; `--spacing-space-4: 16px`;
`--radius-xl: 16px` and `--radius-full: 1000000000px` from `design-system/tokens.json`; assets
MISMATCHED 14/39 (positions) and 15/43 (Job Role Details); `Angle-left.svg` single case-folded
file; `variables.json` has no `exportedAt`; root `pages/index.json` is a directory of directories;
cross-check 2 blockers without `--variables`, 5 with.

Live Figma IS available while this plan runs: `dtwin serve` daemon on 8787 (pid 45697) with both
`TeamSmart (Copy)` and `Design System - NERA (Copy)` connected. Read-only pulls into scratch dirs are
fine. **Nobody stops or restarts the shared daemon except the orchestrator.**

## How work is isolated

Every subagent works in its own git worktree (branch off `fix/livetest-3`), commits there, and
reports branch + path. The orchestrator merges into `fix/livetest-3` after verifying. Worktrees have
no `node_modules`: symlink `bridge/node_modules` and `figma-plugin/node_modules` from the main
checkout before running anything.

Tests: `node test/<name>.test.js` (each prints `N/N checks passed`, exit 0). Plugin: edit
`figma-plugin/src/*.ts` → `cd figma-plugin && npm run typecheck && npm run build` → commit
`figma-plugin/code.js` → `node test/harness.js`. Scripts: edit `design-to-code/*.js` →
`node claude-plugin/build-scripts.js` → commit `claude-plugin/scripts/*.js` (never hand-edit;
`test/design-to-code.test.js` fails if stale). A new CLI script must be added to `ENTRIES` in
`claude-plugin/build-scripts.js`.

## File ownership (who may edit which function)

| file | Prompt 1 (Wave A) | Prompt 3 (Wave A) | Prompt 5 (Wave A) | Prompt 2 (Wave B) | Prompt 4 (Wave C) | Prompt 6 (Wave C) |
|---|---|---|---|---|---|---|
| `design-to-code/tokens.js` | emitters: `toDTCG`, `toCSS`/`cssVarName`, `toTailwind`/`TW_*`, sentinel | — | — | — | — | output-file selection for `--web/--native` (225) |
| `design-to-code/design-diff.js` | `diffTokens()` + its `keyed()` only | — | `previous()`, `at()`, asset-hash comparison, `--snapshot`, JSON `warned`/`baseline` | — | — | — |
| `design-to-code/cross-check.js` | `token-name-collision` attribution; component verdict (`catalog-rekeyed`, name+prop matching) | — | — | — | `--variables` auto-discovery + "not checked" note wording (135, 749) | — |
| `design-to-code/audit.js` | wording/logic of the 0%-by-key provenance finding | `--out` default naming (`<Layer>__<id>`) | — | hidden-node filtering of every emitter (74) | `--grid` echo in headline | optional `self-inconsistent-geometry` (172) |
| `design-to-code/drift-lint.js` | 0%-by-key verdict wording | — | — | coverage-metric wording | — | exit code (123) — investigate first |
| `design-to-code/map-bootstrap.js` | stub from confirmed name+prop matches | — | — | — | ordering (screen-coverage first) | — |
| `design-to-code/verify-screen.js` | — | `--out` default naming only | — | everything else (hidden filter, `FIELDS`, `compare`, coverage, `token:`, third state, `missingComponents`) | — | — |
| `design-to-code/verify-build.js` | — | plan header schema (`screenName`,`nodeId`,`route`,`file`) validation | — | hook reshape §2.9 (b)(c)(d)(e), `reused` check, hex scan scope, plan-vs-report reconciliation | docs only | `auditGate` (136) |
| new `design-to-code/plan-skeleton.js` | — | — | — | owner | — | — |
| new `design-to-code/resolve-screen.js` (recommended) | — | owner | — | — | — | — |
| `bridge/variables-merge.js` | `_conflicts` + `hygiene` for same-name/different-key | — | freshness signal (top-level `exportedAt` derived from `_slices[].at`) | — | — | — |
| `bridge/write-out.js` | — | `writeScreen` + index rows (`title`, `texts`, root index rows) | `writeAssets`, `writeScreenAssets` | — | — | — |
| `bridge/pages-layout.js` | — | owner | — | — | — | — |
| `bridge/server-core.js`, `bridge/daemon.js` | — | — | owner | — | — | — |
| `bridge/figma-pull.js` | — | — | `list clients` wait, client resolution, daemon guidance, **and** the line-854 `mkdirSync` move (finding 13, taken from Prompt 6) | — | outDir-is-`design/` warning | verify 13 only |
| `bridge/doctor.js` | — | — | `daemon` check (89) | — | export check (178–186), `ok` roll-up (311), parallel-layout warning | — |
| `bridge/init.js` | — | — | — | — | help text (153) | — |
| `figma-plugin/src/assets.ts` | — | — | owner (case fold, coordinate normalisation) | — | — | — |
| `claude-plugin/hooks/hooks.json` | — | — | — | owner | — | — |
| `claude-plugin/agents/visual-verifier.md` | — | — | — | owner | — | — |
| `skills/extract/SKILL.md` | tokens.js input rule (218–231) | shared resolution procedure ref; `pages/index.json` description (16) | — | — | pull examples (64–65, 91), cross-check command (205) | 225 rule |
| `skills/build-screen/SKILL.md` | tokens rule (72–74, 253), utility names | resolution ref (*Where everything is*) | — | `--compare` claim, `data-dt-node` expectation | 144, 158, 168, 187, 487, map-bootstrap ordering, dev-server step | 225, auditGate |
| `skills/build-screen/profiles/web-tailwind.md` | owner | — | — | — | — | — |
| `skills/build-screen/references/architecture.md` | — | — | — | — | evolving a shared component (143) | — |
| `skills/verify/SKILL.md`, `references/verify.md` | — | step 1 resolution | — | coverage-first verdict, no-browser correction, interaction-evidence channel | — | — |
| `skills/sync-design/SKILL.md` | — | step 1 resolution | steps 2–3: `.sync/`/`sync/`, `dtwin serve`, non-destructive snapshot | — | design-system branch with `--client`, 9-file snapshot list, pull command | — |
| `skills/audit-design/SKILL.md` | — | output-naming contract (72, 73) | — | — | — | per-screen cost / batch (80) |
| `skills/help/SKILL.md` | — | — | — | — | 120–131 | — |

Rule: if a prompt needs a change outside its column, it writes a note in its report instead of
editing, and the orchestrator routes it.

## Waves

- **A (parallel, worktrees):** P1 (Opus), P3 (Sonnet), P5 (Sonnet). Merge order: P3 → P5 → P1.
- **B (after A):** P2 split in two Opus agents that do not share files:
  - P2a — `verify-screen.js`, `audit.js` hidden emitters, `drift-lint.js` wording, `verify/SKILL.md`, `references/verify.md`, the `--compare` claim in `build-screen/SKILL.md`, `visual-verifier.md`.
  - P2b — `verify-build.js` (§2.9 b–e, 131, 100, 132, 155/189 reconciliation), `plan-skeleton.js` (§2.9 f), `hooks.json`, the hook/plan sections of `build-screen/SKILL.md`.
- **C (after B):** P4 (Sonnet), then P6 (Sonnet). Docs describe final flags.
- **D:** P7 (Opus, fresh, no fix context) — CLI/script-level re-test in a new empty directory. The
  parts that need a human (invoking `/designtwin:*` skills from a consumer session, and making four
  edits in Figma for Phase 7b) are handed to the owner with exact steps.

## Disagreements with the findings / prompts (decided by the orchestrator)

1. **Prompt 2 §2.9(a) — "the hook must measure the rendered DOM".** Rejected as written. There is no
   renderer in the plugin (finding 127 itself proves `verify-screen.js` has no browser); a
   SubagentStop hook that launches Playwright would add a heavy dependency and a multi-second stall
   to every build. P2b instead: (i) the hex scan ignores comments, string-literal provenance notes,
   and any `.svg`/non-source file; (ii) the hook reads `design/verify/<Screen>.report.json` when it
   exists and treats `verdict: "fail"` as blocking `verified`; (iii) §2.9 (b)–(f) as written.
2. **Finding 123 (`drift-lint.js` exits 0).** Not reproducible: run today with the livetest map and
   catalog it prints the ERROR and exits **1**. The original run piped through `tail`/`tee`, which
   is the most likely source of the 0. P6 must reproduce with the exact pipeline before changing
   anything; if it cannot, it records the finding as not-a-bug with the command that proves it.
3. **Prompt 1 criterion 1** says `tokens.js` on the merged `variables.json` must emit 24 "for a
   screen whose .vars.json binds the 24-valued key". The merged file has no notion of "the screen".
   Read as: both keys are emitted under distinct, reachable identifiers, the warning names both keys
   / values / source slices, and the skills state the rule "generate a screen's theme from that
   screen's own `.vars.json` (or the design system's `tokens.json`), never from the union".
4. **Finding 13 moves from Prompt 6 to Prompt 5** (same line of `figma-pull.js` P5 already edits).
5. **Prompt 3 acceptance 3–4** describe skill prose. To make it testable the procedure is implemented
   once as a script (`resolve-screen.js`) that every skill calls; prose only points at it.
6. **Prompt 7** cannot be fully executed by a subagent: skills run only in a consumer Claude Code
   session and Phase 7b needs a human to edit Figma. The subagent runs everything CLI/script-level
   and writes a checklist for the owner for the rest.

## Wave A log (orchestrator)

- P1 verified against the livetest export (criteria 1–7 reproduced, proposals agree with
  `scripts-test/out/components/mapping.json` 26/15 name-for-name) and fast-forwarded into
  `fix/livetest-3` at bdc114f. Decision accepted: Tailwind tokens live under a `figma-` sub-namespace
  (`--radius-figma-xl` → `rounded-figma-xl`); `catalog-rekeyed` is a blocker that lists proposals,
  never auto-accepts; `map-bootstrap.js --from-proposals` is additive.
- P3 needed a second round: the text-search stage auto-resolved a single substring hit ("Job Role" →
  Job Role Details on the pre-fix index — finding 70 verbatim). Now only the four exact stages may
  resolve; a text-search hit is always a candidate list, exit 1, and an index without titles says so.
  Merge order changed to P1 → P3 → P5 so Wave B (which edits `verify-screen.js`/`verify-build.js`
  after P3's `--out`/plan-header changes) can start before P5 lands.
- P5 needed a second round: four `[args]` bridge tests are cwd-dependent (default outDir is layout-
  derived) and were mis-reported as pre-existing; `writeAssets` decided "same asset" on raw bytes so a
  drifted re-pull would still mint a suffixed file per pull; criterion 3 (the 300 s wedge) had no code
  change; 27 and 206 were left open. All five sent back. Accepted deviation: SVG coordinates are
  rounded to 0.1px, not 0.01px, because 2-decimal rounding splits real re-exports of the same icon
  across a rounding boundary (shown on the eight `arrow-down*.svg`). P5 also wires
  `assetsGeometryWarning()` into `writeScreen` once it rebases onto a head that contains P3.
- Live check on the main checkout, through the daemon: `--client "TeamSmart (Copy)"` resolved 10/10.
  The finding 216 race is the no-daemon path, which `waitForIdentified()` targets; re-check after P5.

## Wave B log (orchestrator)

- P5 needed a third round: `writeAssets` deduped by name only, so content already on disk under another
  name was written again and then reported in its own `duplicates` (finding 24 alive). Now content is
  checked against the shared `assets/` dir first; also fixed the SVG normaliser to handle scientific
  notation (`2.09808e-05` vs `-0.000406265`), which was the real reason chevrons kept multiplying.
  Verified live with three screens + a re-pull: 68 assets, 0 hash mismatches, 0 duplicate groups,
  0 byte-identical pairs, no new files on re-pull. Merged at 72e1b72. Plugin-side half untested live
  until the owner re-runs the plugin in Figma (the loaded bundle is still pre-fix).
- P2a verified on the livetest export: `--expect` 186/51/6 with 0 hidden rows (was 272/112/28 with
  83/61/22), deterministic; `--compare` headline names never-measured fields incl.
  `borderRadius (probe sent 'radius')`, 0 high deltas on the real JR probe (was 2), coverage
  186−78=108 consistent, `not-probed` state, `componentsAbsent` 0, audit no longer cites hidden
  nodes. Report schema is now `verify-report@2`; `missingComponents` is gone. Also fixed the same
  wrong `visible === false` predicate in `cross-check.js` (shared `hidden.js`). Merged at 70d6029.
- The no-daemon live checks (Prompt 5 criteria 1–3) need the owner's `dtwin serve` stopped; the
  orchestrator's sandbox refused to stop it. Left to the owner / Prompt 7 with exact commands.
- P4 started before P2b finished (files barely overlap); its Stop-hook doc lines (99/133) are held
  until P2b merges.
- P2b verified on a copy of the livetest project: the hook no longer stores `status` (both plans lose
  their stored `verified`); `verify-build.js --status` computes Job Roles → `failed` (from its fail
  report) and Global Policies → `blocked` (3 unanchored visible nodes); no-stdin loop 20/20 under 2 s;
  `plan-skeleton.js` for 7314:87192 → 45 tokens / 51 visible instances / 254 anchors / 0 hidden
  anchors. Blocks on exactly two conditions; everything else warns. Merged at 2807c1b.
- Wave C: P4 started before P2b landed (held its Stop-hook doc lines, released at 2807c1b); P6
  started before P4 landed (holds its one-sentence additions to the P4-owned skill files).

## Wave C log (orchestrator)

- P6 needed a second round: the new `self-inconsistent-geometry` audit finding fired 39 times on
  positions (sidebar rows whose children are shorter than a fixed box = normal cross-axis alignment).
  Rule tightened to: fixed/fill box → fire only on overflow; hug box → fire on any mismatch. Now 18
  hits: the finding-172 header + 12 rows, plus 5 genuine overflows. 123 confirmed not-a-bug (exit 1
  direct and piped), pinned by a test. 225 (`--also-generic`), 136 (`auditGate`), 80 verified.
  168 (pixel diff %) left undone — needs an image-diff dependency. Merged at 33d8e21; the merge
  combined two generated bundles textually, so the orchestrator committed a rebuild (acc513c).
- P4 round 1 verified: 0 `dtwin pull design ` examples left in the repo; outDir-trap warning; doctor
  names both layouts; cross-check auto-discovers `design/export/variables.json` and prints the path;
  init help matches the filesystem. Sent back for: finding 33 (doctor still attributes the export
  to the design-system file — screens carry no source-file stamp; granted `write-out.js` to add
  `sourceFile`), and its own new doctor test being machine-dependent (live daemon on 8787).

## Wave D log (orchestrator)

- P4 merged (rounds 2–3: `sourceFile` stamp + per-source doctor line; env-independent doctor tests →
  bridge 578/578 with the daemon running; `list`'s own next-step hint no longer recommends the trap;
  README `--client` example uses a file name). Head 1536c7d. Every suite green.
- Prompt 7 (fresh Opus, `design-twin-livetest-4/RETEST.md`): 39 pass / 5 fail / 9 not testable;
  new findings 310–333, two blockers (310 title-vs-layer-name ambiguity once a sibling is pulled;
  311 audit.js still reads the union). All routed back to the owning agents in one parallel round
  (P1: 311/318/326; P3: 310/313/315/319; P5: 312/320/322/323/324/327; P2b: 314/316/317/325;
  P4: 321/328/329). Orchestrator re-checks the five failed criteria after the merges.
- Regression round merged: P2b (307cb26, 48662b5), P1 (f118b05), P4 (58b371c), P3 (8e473bc), P5
  (e088029, after a rebase to resolve `bridge/doctor.js` against P4's token check). Two textual
  merges of generated bundles needed rebuild commits (acc513c, f08eddb). Final suites all green;
  bridge 593/593 with the daemon running. Orchestrator re-checked the five failed re-test
  criteria on the livetest-4 export: all pass. `main` and `refactor/design-to-code-layer` are
  fast-forwarded to the final head at the end (owner's request; both were direct ancestors).
