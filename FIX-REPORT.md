# FIX-REPORT — livetest-3 (branch `fix/livetest-3`)

Evidence: `/Users/mohamedomarwork/design-twin-livetest-3` (read-only; never modified). Plan and per-wave
log: `FIX-PLAN.md`. Base commit 7568d78. Every prompt was executed by a subagent in its own git
worktree; the orchestrator re-ran each acceptance criterion against the real export before merging,
and no generated file was hand-edited (every merge was followed by `node claude-plugin/build-scripts.js`
and a clean `git status`).

## 1. Result in one table

| | count |
|---|---|
| non-positive findings in the index | 120 |
| closed | 113 |
| partially closed | 5 (31, 202, 209, 213, 221) |
| not closed | 1 (168 — needs an image-diff dependency) |
| rejected as not a bug | 1 (123) |

Suites at the final head (all run from the merged tree, `dtwin serve` daemon live on 8787):

| suite | before | after |
|---|---|---|
| test/design-to-code.test.js | 281 | 292 |
| test/audit.test.js | 70 | 96 |
| test/verify-build.test.js | 77 | 134 |
| test/plan-skeleton.test.js | — | 31 (new) |
| test/ui.test.js | 14 | 14 |
| test/cross-check.test.js | 47 | 56 |
| test/verify-screen.test.js | 44 | 120 |
| test/design-diff.test.js | 27 | 31 |
| test/identity.test.js | — | 48 (new) |
| test/resolve-screen.test.js | — | 27 (new) |
| test/harness.js (plugin, mock figma) | 414 | 414 |
| test/bridge.test.js | 528/529 | 577/577 (the old environmental failure is fixed: the doctor tests now pin a spare port) |

Every new test is driven by fixtures pruned from the real export in the test directory
(`test/fixtures/livetest3/**`, each with a `build.js`/`build.py` that regenerates it and asserts the
pruned file produces the same output as the full one).

## 2. Findings, one row each

Status: **C** closed · **P** partially closed · **N** not closed · **R** rejected (not a bug).
"Evidence" is the test that pins it or the command the orchestrator re-ran against the livetest export.

### Prompt 1 — token and component identity (13)

| # | sev | status | what changed | evidence |
|---|---|---|---|---|
| 21 | blocker | C | `variables-merge.js` records same-name/different-key pairs in `_conflicts` and a `CONFLICT (same name)` hygiene line | `test/identity.test.js`; re-merge of the 5 real slices → 2 conflicts (`Space 4` sameValue:false, `Space 2` sameValue:true) |
| 31 | friction | P | cross-check now reads the screen's sibling `.vars.json` without flags and reports `token-absent-from-design-system` (13 names on positions); pull-time reporting in `figma-pull.js` not added | `cross-check.js positions… --design-system …` (no `--variables`) |
| 35 | cosmetic | C | docs: `.vars.json` = every collection the screen references (a superset of what it binds) | extract/build-screen SKILL.md |
| 40 | blocker | C | collision attributed to the screen whose own slice holds both keys; others get `token-name-collision-elsewhere` info naming the owning screens | positions: 5 → 3 blockers, none for `Space 4`; Create Activity Type still blocked on key 64928e3a |
| 44 | blocker | C | DTCG/CSS/Tailwind emitters keyed by Figma key; colliding names emitted with an 8-hex key suffix, warning names both keys, values and source slices | `tokens.js variables.json out --web tailwind` → `--spacing-figma-space-4-e26d506e: 24px` + `…-64928e3a: 16px` |
| 94 | blocker | C | collision detected on the emitted identifier, not only the source name | `--spacing-figma-space-3: 16px` + `--spacing-figma-space-3-a96c665b: 12px`, warning names the pair |
| 95 | blocker | C | skills state the input rule: design-system `tokens.json` → screen's own `.vars.json` → union only for all-screens work | extract/build-screen SKILL.md; screen slice → `--spacing-figma-space-4: 24px` |
| 96 | friction | C | 1e9 sentinel emitted as the platform idiom (`9999px`, `.infinity`, `double.infinity`, `CircleShape`) | `grep 1000000000 theme.css tokens.css` → none |
| 106 | friction | C | same as 40, seen from audit.js (which merges cross-check's findings) | positions audit no longer carries the `Space 4` blocker |
| 137 | friction | C | same as 40/94 on Global Policies; screen-slice run keeps `Space 3`=16 and `(Space 3)`=12 | identity suite |
| 183 | blocker | C | Tailwind `@theme` emits under a `figma-` sub-namespace (`--radius-figma-xl` → `rounded-figma-xl`); framework `rounded-xl` untouched | `grep -c "^  --radius-xl:" theme.css` → 0; `profiles/web-tailwind.md` |
| 211 | blocker | C | `design-diff.js diffTokens()` keyed by `v.key`; clash test covers same-collection pairs | 24→25 on key e26d…: 1 change named by key; other key: 1 change; rows reordered: 0 |
| 226 | blocker | C | `catalog-rekeyed` blocker with name+prop-signature proposals (new `component-match.js`); `map-bootstrap.js --from-proposals` stubs only confirmed matches; never auto-accepts | positions 26 proposals / 15 residual, Global Policies 23 / 15 — name-for-name and id-for-id equal to `scripts-test/out/components/mapping.json` |

### Prompt 2 — make the verifier honest (45)

| # | sev | status | what changed | evidence |
|---|---|---|---|---|
| 74 | blocker | C | audit.js emitters skip hidden nodes and hidden ancestry (`hidden.js`) | positions audit: 0 findings cite hidden nodes; `I7314:87216;6:87` absent |
| 79 | blocker | C | component identity comes from the catalog match / `codeconnect.local.json`, stated in skeleton, skill and agent | `plan-skeleton.js` rows; build-screen SKILL.md |
| 97 | blocker | C | one hidden predicate in `--expect`, `--compare`, instances, interactions, coverage | positions `--expect`: 186/51/6 with 0/0/0 hidden (was 272/112/28 with 83/61/22) |
| 98 | friction | C | drawn-hovered rows measured via `states.hover`; delta token is the token bound to the delta's field | delta on `20173:142096` carries `Backgrounds/Row Hover` |
| 100 | friction | C | hook's hex scan skips comments and prose strings | `test/verify-build.test.js` on the real `Header.tsx` |
| 107 | friction | C | metric renamed to tag coverage; skill states the `.map()` row-i rule and the shared-shell rule | build-screen SKILL.md; drift-lint wording |
| 126 | blocker | C | same as 97 on Global Policies | 154/42/1 with 0 hidden (was 233/87/12 with 75/45/11) |
| 127 | blocker | C | docs and `--help` say `--compare` has no browser; new `--interactions <file>` evidence channel | verify SKILL.md, build-screen SKILL.md, README.md |
| 128 | friction | C | eight false-positive families each have a rule | real GP probe: 0 high deltas (was 4) |
| 129 | friction | C | shared shell matched through the component's internal path | `[lt3-fp]` tests |
| 131 | blocker | C | `reused` check resolves imports by module path/suffix (relative and `@/` alias pass) | GP plan: 6 false blocks → 0 |
| 132 | friction | C | non-source files (`.svg`, `.json`, `.md`, images) not scanned | verify-build tests |
| 133 | friction | C | stdin read only when not a TTY; silent pipe = no payload after 1 s; 60 s cut-off | 100-run loop, 0 failures |
| 139 | friction | C | see 107 | — |
| 153 | friction | C | `--expect` names stale `.measured.json`/`.report.json` beside it; report records both sha256s | verify-screen tests |
| 155 | blocker | C | hook never writes `status`; `verify-build.js --status` computes it from hook result + report verdict + file hashes | livetest copy: Job Roles → `failed`, stored `verified` removed |
| 156 | friction | C | `verification{}` self-contradictions warned | fires on the real Job Roles plan |
| 157 | blocker | C | hidden-layer interactions never graded | positions: 22 hidden interactions gone |
| 158 | friction | C | third state `not-probed`, excluded from failed count | real JR: 4 fail / 2 not-probed |
| 159 | blocker | C | `missingComponents` removed; `componentsAbsent` counts only probe-reported absence; tag coverage labelled as such | positions: 0 absent (was "31 missing") |
| 160 | friction | C | token on a delta is the field's token | see 98 |
| 161 | friction | C | see 128 | real JR probe: 0 high (was 2) |
| 162 | blocker | C | field in `FIELDS` absent from every measurement is a headline "NEVER MEASURED" line | headline: `'borderRadius' present in 0 of 78 measurements (probe sent 'radius')` |
| 163 | friction | C | text compared through `textBox`/text nodes on padded containers when the probe reports `tag` | verify-screen tests |
| 164 | blocker | C | frame-relative `x`/`y` in `FIELDS` | JR pagination → `high … bottom edge at y=1366 in a 1236-high frame` |
| 165 | friction | C | coverage in the headline; `nodesExpected − nodesMeasured == nodesNotMeasured` | 186 − 78 = 108 |
| 166 | friction | C | `--compare` records artifact paths + sha256; no screenshot → `incomplete` | verify-screen tests |
| 169 | friction | C | see 159 | — |
| 170 | friction | C | `data-dt-node` on a wrong inner element reported as such | `[lt3-fp]` |
| 173 | cosmetic | C | radius now compared (see 162) | the four dropped JR radii appear as deltas with a correct probe |
| 177 | cosmetic | C | pseudo-element limit stated; `placeholderText`/`placeholderColor` fields | report `limits` |
| 181 | blocker | C | see 97; overwrite of an identical expectation reported as unchanged | second `--expect` → "already identical" |
| 182 | blocker | C | see 162; GP card 16-vs-12 caught with a correct probe | verify-screen tests |
| 184 | friction | C | no id in both `notMeasured` and measured | coverage arithmetic test |
| 185 | friction | C | see 159 (GP: 0 absent, was "52 missing") | — |
| 186 | blocker | C | visual-verifier must quote the expectation/export line it contradicts | `agents/visual-verifier.md` |
| 187 | blocker | C | an interaction pass must name the `[data-dt-node]` selector it drove with `selectorCount ≥ 1`; hidden-layer results ignored | verify-screen tests |
| 188 | friction | C | hidden hovers never probed (see 157) | — |
| 189 | blocker | C | see 155 (GP → `blocked`) | — |
| 190 | friction | C | see 166 | — |
| 192 | friction | C | see 164 | GP Status header → `x 1296.81 → 1315.75 Δ 18.94` |
| 193 | cosmetic | C | size tolerance 2 → 1 px | filter button 111.83×38 now flagged |
| 194 | friction | C | see 128 | — |
| 195 | blocker | C | see 162/165 (never-measured is loud) | — |
| 196 | friction | C | `deviations[]` entry schema `{nodeId, field, designed, built, reason}` warned | GP plan: one warning over 7 entries |
| 198 | cosmetic | C | `rotate`/`::placeholder`/`border-spacing`/slack traps listed for the agent | `agents/visual-verifier.md` |

### Prompt 3 — screen resolution (13)

| # | sev | status | what changed | evidence |
|---|---|---|---|---|
| 16 | friction | C | root `pages/index.json` carries `layers[]` rows (name, title, texts, id, page, size, files, sourceFile) | live re-pull: `{"name":"positions ","title":"Job Roles"}` |
| 17 | friction | C | `title` = text of the frame's `Page Title`-shaped instance, else first TEXT in reading order; never a nav label | `System Configurations` → `title: "Global Policies"` |
| 19 | friction | C | candidate list shows id, size, node count, reference PNG, `dtwin screenshot <id>` | `resolve-screen.js` output |
| 70 | blocker | C | one shared `resolve-screen.js`: node id → exact layer name → indexed title → plan header; a text-search hit is never a result | pre-fix index: "Job Role" → candidate list, exit 1 (was silently Job Role Details) |
| 71 | friction | C | stop-and-list is the rule | `test/resolve-screen.test.js` |
| 72 | friction | C | audit `--out` defaults to `<Layer>__<id>` | re-audit produces one pair |
| 73 | friction | C | same | — |
| 90 | blocker | C | "Job Roles" → 7314:87192 via indexed title | new index |
| 120 | blocker | C | "Global Policies" → 1359:21337 via title; nav-label hits are candidates only | new index |
| 150 | friction | C | verify step 1 uses the resolver | verify SKILL.md |
| 151 | friction | C | plan header `screenName`/`nodeId`/`route`/`file` written by `plan-skeleton.js`, validated by the hook | `validatePlanHeader()` in hook warnings |
| 152 | friction | C | `verify-screen.js --out` defaults to `<Layer>__<id>` | one artefact set per screen |
| 200 | friction | C | sync-design step 1 uses the resolver; must not conclude "never built" from a name miss | sync-design SKILL.md |

### Prompt 4 — the skills' commands and diagnostics (18)

| # | sev | status | what changed | evidence |
|---|---|---|---|---|
| 2 | friction | C | `init --help` lists exactly the four things init creates | fs diff after `init` == help text (test) |
| 14 | blocker | C | every `dtwin pull design …` example → `dtwin pull --node <id>`; CLI warns when the outDir already contains `export/` | `grep -rn "dtwin pull design "` → 0; `dtwin design --list` warns |
| 15 | blocker | C | doctor names the layout it read and warns about a parallel tree | both-layouts copy: `! Layout: found BOTH layouts…` |
| 33 | friction | C | screens stamped with `sourceFile`; doctor counts per source and says "source not recorded" for old exports | `5 screen(s) (source not recorded…) + design system from 'Design System - NERA (Copy)'`; live pull → `sourceFile: "TeamSmart (Copy)"` |
| 38 | blocker | C | cross-check auto-discovers `design/export/variables.json`, prints the path, warns about a stale sibling | same 3 blockers with and without `--variables` |
| 39 | friction | C | same | — |
| 43 | friction | C | audit headline states the grid and flags a non-4 design-system scale | `grid 4px (default — not given)` |
| 99 | friction | C | see 133; manual form documented (positional plan path) | build-screen SKILL.md |
| 103 | friction | C | `map-bootstrap.js --screen` scopes stubs to the screen; skill runs coverage first | design-to-code tests |
| 111 | cosmetic | C | `pending` vs `awaiting-user` spelled out | build-screen SKILL.md |
| 113 | cosmetic | C | dev-server step recorded, not assumed | build-screen SKILL.md |
| 138 | friction | C | see 38 | — |
| 143 | friction | C | "evolving a shared component the catalog covers 0% of" | references/architecture.md |
| 201 | blocker | C | see 14 (sync-design step 3) | — |
| 203 | friction | C | `ok: false` whenever a check is a "not checked" warn | doctor tests on a spare port |
| 208 | friction | C | sync-design has a design-system re-pull branch with `--client <the design-system file>` | sync-design SKILL.md |
| 215 | friction | C | snapshot list = all nine `--design-system` files | sync-design SKILL.md |
| 133 | friction | C | (docs half; implementation under Prompt 2) | — |

### Prompt 5 — bridge and assets (22 + 13)

| # | sev | status | what changed | evidence |
|---|---|---|---|---|
| 13 | friction | C | `mkdirSync(outDir)` removed; writers create their own subtrees | `dtwin nonexistent` → exit 1, nothing created |
| 23 | blocker | C | `writeAssets` is refuse-or-version, case-folded, content-first; never clobbers | live 3-screen pull + re-pull: 0/0/0 hash mismatches (was 14/39) |
| 24 | friction | C | content already on disk under any name is reused, not rewritten | 0 byte-identical pairs on disk (was 3) |
| 25 | friction | C | SVG numbers rounded to 0.1 px (incl. scientific notation) before comparing/hashing; bytes on disk untouched | three `arrow-down*` files = three distinct icons |
| 27 | friction | C | `duplicates` computed over the shared `assets/` dir | all three manifests: `duplicates: []` |
| 28 | cosmetic | C | reference PNG split into `reference[]`, excluded from `count`/`totalBytes` | manifest |
| 30 | friction | C | `assetsGeometry` ≥ 10% warns at pull time | live: `warn 40 of 383 nodes (10%) fell back to raw geometry` |
| 104 | friction | C | see 23 | — |
| 124 | blocker | C | case-folded uniqueness in plugin `register()` and in `writeAssets` | `angle-left-*.svg` and `Angle-left.svg` coexist |
| 125 | blocker | C | see 23/24 — suffix is content-derived, not pull-order | — |
| 197 | friction | C | root cause = 124 | — |
| 202 | blocker | P | no-daemon export path: upfront warning naming `dtwin serve` + stall detector (abort ≈20 s with no plugin activity, `FIGMA_BRIDGE_STALL_MS`); plugin progress now relayed over the socket; no auto-start, `<15 s` not guaranteed | `test/bridge.test.js` stall tests; live no-daemon run owed by the owner |
| 204 | friction | C | doctor: missing daemon is a warn naming `dtwin serve` | doctor test |
| 205 | friction | C | `--snapshot` refuses to overwrite a different baseline without `--force` (keeps `.prev`); dirs documented | design-diff tests |
| 206 | friction | C | snapshot copies `.vars.json`, `.assets.json`, `pages/index.json`, all nine design-system files | design-diff tests |
| 209 | blocker | P | `c<n>` documented and printed as a reconnect-order label, not an identifier; not made stable across restarts | `list clients` output note; README |
| 210 | blocker | C | `list clients` honours the connect wait | bridge tests (fake client) |
| 213 | blocker | P | see 202 | — |
| 216 | friction | C | `waitForIdentified()` before resolving a name/fileKey | bridge tests; live through daemon 10/10 |
| 218 | blocker | C | `variables.json` gets `exportedAt` derived from `_slices[].at`; diff freshness falls back to slice times | `exportedAt` present after live pull |
| 221 | friction | P | see 209 | — |
| 222 | blocker | C | normalised asset comparison in `design-diff.js` (shared `bridge/svg-normalize.js`) | `[svg-tolerance]` tests on the real drift pairs |
| 223 | blocker | C | see 218 | — |

### Prompt 6 — sweep (9)

| # | sev | status | what changed | evidence |
|---|---|---|---|---|
| 13 | friction | C | (done by Prompt 5) | verified again |
| 80 | friction | C | audit-design SKILL states the per-screen cost and a batch form (`audit.js --json` loop) | SKILL.md (223 lines) |
| 123 | friction | R | not reproducible: `drift-lint.js` exits 1 at 0% coverage, directly and piped; the original run piped through `tail` | `[P6-123]` test pins the non-zero exit |
| 136 | friction | C | first-class `auditGate` in the plan; skeleton pre-fills it; hook warns when blockers are not covered | plan-skeleton on positions → 5 blocker ids, `overridden: []` |
| 168 | cosmetic | N | pixel-diff % needs an image-diff dependency | — |
| 171 | friction | C | verifier still reports it (pinned) | verify-screen test |
| 172 | friction | C | `self-inconsistent-geometry` audit finding (fixed box: overflow only; hug box: any mismatch) | positions: header + 12 rows fire; sidebar rows do not |
| 174 | cosmetic | C | verifier still reports it (pinned) | verify-screen test |
| 225 | friction | C | `--web`/`--native` write only the target file; `--also-generic` for the handoff set; one line names the canonical file | `tokens.js … --web tailwind` → `theme.css` only |

## 3. Public surface that changed, and where the docs moved with it

| change | docs updated |
|---|---|
| New scripts `resolve-screen.js`, `plan-skeleton.js` (in `build-scripts.js` ENTRIES) | all five skills, `design-to-code/README.md`, TESTING.md |
| `verify-build.js`: never stores `status`; new `--status [--json]`; plan path positional when stdin is a TTY; blocks on two conditions | build-screen SKILL.md, sync-design SKILL.md, verify SKILL.md, agents, hooks.json (`timeout: 90`) |
| `verify-screen.js`: `verify-expectation@2` / `verify-report@2`; `missingComponents` removed; `--interactions <file>`; `--out` default `<Layer>__<id>` | verify SKILL.md + references, build-screen SKILL.md, README.md |
| `audit.js`: `--out` default `<Layer>__<id>`; grid in headline; `self-inconsistent-geometry` | audit-design SKILL.md |
| `tokens.js`: Tailwind names under `figma-`; key-suffixed duplicates; sentinel idiom; target-only output, `--also-generic` | `profiles/web-tailwind.md`, `profiles/web-css-modules.md`, extract + build-screen SKILL.md |
| `cross-check.js`: `catalog-rekeyed`, `componentProposals`, auto-discovered `variables.json`, hidden nodes skipped | extract + build-screen SKILL.md |
| `map-bootstrap.js --from-proposals`, `--screen` | build-screen SKILL.md, design-to-code/README.md |
| `design-diff.js --snapshot` refuse-or-version + `--force`, sibling copies, `baseline`/`warned` in JSON | sync-design SKILL.md |
| `dtwin` CLI: `list clients` waits; `--client` name waits for `identified`; outDir-is-`design/` warning; no-daemon export warning + stall detector (`FIGMA_BRIDGE_STALL_MS`); `list` next-step hints | bridge/README.md, help SKILL.md |
| Export format: root `pages/index.json` `layers[]` with `title`/`texts`/`sourceFile`; screen JSON `sourceFile`; `variables.json` `exportedAt` + same-name `_conflicts`; manifest `reference[]`; asset names content-deduped | bridge/README.md, help SKILL.md, `design/README.md` template |
| Plugin bundle (`figma-plugin/code.js`, `ui.html`): case-folded asset names, normalised content hash, progress relayed over the socket | rebuilt and committed; **must be re-run in Figma to take effect** |

## 4. Disagreements with the findings / prompts

1. **Prompt 2 §2.9(a)** (hook measures the rendered DOM through a browser): rejected. There is no
   renderer in the plugin and a Stop hook that launches one would stall every build. The hook reads
   the verify report, skips comments/SVGs in its scan, and blocks on two static conditions.
2. **Finding 123**: not a bug. Direct and piped runs both exit 1 today; the original run's pipeline
   swallowed the exit code. Pinned by a test so it stays that way.
3. **Prompt 1 criterion 1** ("24 for a screen whose .vars.json binds the 24-valued key" from the merged
   file): the merged file has no notion of "the screen". Read as: both keys emitted under distinct
   names, warning names both, and the skills tell you to generate from the screen's own slice.
4. **Prompt 5's 0.01 px tolerance**: 0.1 px was used because two-decimal rounding splits real
   re-exports of the same icon across a rounding boundary (shown on the real `arrow-down*.svg`).
5. **Prompt 5 criterion 3** ("starts a daemon or fails < 15 s"): auto-starting a daemon from a pull
   was judged too risky for this pass; the stall detector aborts at ≈20 s with the right message.
6. **Finding 13** moved from Prompt 6 to Prompt 5 (same line of code).

## 5. New findings from verification (numbered from 300, not fixed)

- **300 — friction.** The first `--design-system` pull in a plugin session under-counts library
  components (68 vs 71) and their `uses`; the second and third pulls agree. Consistent with Figma
  loading pages lazily. Pre-existing (no prompt touched `libraries.ts`/`components.ts`). Fix
  direction: `figma.loadAllPagesAsync()` before counting instances. Finding 214's "bit-for-bit
  deterministic" holds only from the second pull onward.
- **301 — unreproduced.** One pull from the main checkout crashed with a Node stack trace while the
  same command succeeded before and after; the output was not captured. Not seen again in ~20 pulls.

## 6. Owner-only items still open

1. Re-run **Plugins → Development → Design Twin** in both Figma files. The bundle in Figma is still
   the pre-fix one, so the plugin-side asset hashing, case folding and progress relay have been
   tested only offline (harness + unit tests) and through the bridge half of the pipeline.
2. The no-daemon live checks (Prompt 5 criteria 1–3): the orchestrator's sandbox refused to stop the
   running `dtwin serve`. Commands are in FIX-PLAN.md's Wave B log.
3. Prompt 7's skill invocations (`/designtwin:*` from a consumer project) and Phase 7b's four real
   Figma edits.

## 7. Prompt 7 re-test

_(filled in when the re-test agent reports — see the end of this file)_
