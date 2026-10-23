# `design-to-code/` — the design-to-code layer (who / what / how / why)

This directory turns the extractor's faithful JSON into **reused real components and real tokens**
instead of pixel-regenerated lookalikes. It is the free-plan equivalent of Figma's (Org/Enterprise-only)
Code Connect + a design-token pipeline. Full design rationale + sources: [`../docs/design-to-code-spec.md`](../docs/design-to-code-spec.md).

## Why it exists
The plugin extracts *what a design looks like*, but codegen only ever sees the JSON — so with no link
from a Figma component to your code component, it regenerates a worse copy of a `<Button>` you already
have, and hardcodes hex instead of referencing your tokens. This layer sits **between extraction and
codegen** and provides that link. Key point: the extractor already emits everything needed on the Figma
side (component publish `key` + props + `componentPropertyDefinitions`, tier-classified variables with
modes/aliases) — so this layer only adds the **code side** (import paths, prop translations) + emitters + a lint.

## Who uses it
| Audience | Uses it for |
|---|---|
| **You / the design-system owner** | Author the component map once per repo (bootstrap → fill in code targets → confirm). |
| **The codegen agent** (`build-screen` skill) | Consults the map + emitted tokens so it reuses your components/tokens. *(resolver wiring is the deferred, repo-specific step.)* |
| **The review agent** (`audit-design` skill) + `build-screen`'s gate | Runs `audit.ts` on a screen before any code: what's unbound, undesigned, inaccessible, or won't translate to the target platform. |
| **CI / pre-commit** | Runs `drift-lint` so a Figma change that breaks the map fails the build instead of shipping silently. |

## What's here
| File | What it does |
|---|---|
| `design-diff.ts` | What changed between two exports of one screen, the token file, or the component catalog. Screens are matched by node **id**: changed fields by LEAF path (`fills[0].stops[2].color`) with before → after, added/removed subtrees (top-most node only), reordered children, a variant swap as one change, re-drawn assets (byte hash), root-level facts (flows, modes). Tokens are keyed by collection + name and modes are diffed; catalog components by `key`. The baseline is chosen, not assumed: a snapshot or HEAD copy that is the same export as the file is dropped, then the newest wins, and the report opens with a warning when that happened or when the new export is truncated. Position-only movement is counted, not listed. `--snapshot` keeps the previous export before a re-pull (refuse-or-version: an existing, changed snapshot is replaced only once a diff has used it against the export still on disk, or with `--force`, which alone keeps the old one as `<name>.prev`); without one it diffs against git `HEAD`. Given the export directory instead of a file, both `--snapshot` and the diff cover `variables.json` plus every design-system and `libraries/<dir>/` file present, the diff as one report (a section per changed file, a line for the unchanged, a reason for each file not compared). Drives the `sync-design` skill. |
| `tokens.ts` | Variables → **W3C DTCG JSON** (aliases preserved as `{group.token}` references — the themeability lever; structured color w/ P3 + hex fallback), a **DTCG Resolver Module 2025.10** document (`tokens.resolver.json` + per-mode set files under `tokens/`: each multi-mode collection becomes a modifier whose contexts are its modes, and a context file carries only what differs from the default mode) **and** a zero-dependency **CSS emitter** (`:root` + `[data-theme]` blocks — one per collection and mode: a mode name only one collection has stays `[data-theme="<mode>"]`, one several collections share becomes `[data-theme-<collection>="<mode>"]` per collection, with a warning naming the attributes, since Figma picks a mode per collection). Usable without Style Dictionary. `--web tailwind` writes `theme.css` instead of that generic set (pass `--also-generic` to write both) — an `@theme` block for Tailwind v4, each variable under the namespace that earns it a utility (`--color-*`/`--spacing-*`/`--radius-*`/`--text-*`/`--font-*` — a STRING is a font family when scoped `FONT_FAMILY`, by name only under `ALL_SCOPES`; other STRINGs such as a font-style name are left out with a warning) and the same per-collection mode blocks as the CSS, since `@theme` cannot be nested. It also prints (never writes) the `@source not "<path to design/>";` line that keeps Tailwind v4.1+ from compiling class names quoted in `design/` notes. `--native swiftui\|compose\|flutter\|react-native` writes ONE native token file (`tokens-native.ts`) instead — again, `--also-generic` keeps the generic set too: modes resolved, in each platform's documented theming shape (Compose `@Immutable` data class + `staticCompositionLocalOf`, Flutter `ThemeExtension`, SwiftUI struct + `EnvironmentValues`, typed per-mode objects for React Native) — Style Dictionary cannot read DTCG 2025.10 / the Resolver yet (style-dictionary#1590). The readers both emitters share (name segments, default modes, the fully-rounded sentinel, the FLOAT unit decision) live in `tokens-core.ts`. |
| `map-validate.ts` | **The** source of truth for the `codeconnect.local.json` shape: a no-dependency structural validator; returns `{ok, errors:[{path,message}]}`, never throws on bad input. There is no separate JSON Schema file to keep in sync with it. |
| `drift-lint.ts` | Joins the map against the live component catalog **by stable `key`**; reports orphaned entries, unmapped components, stale/uncovered props, and kind/enum mismatches. Catches the exact bug Figma's own Code Connect ships silently (issue #337). Reads the catalog you name **plus** `components.library.json` beside it, every `libraries/*/components.json` of the export it sits in, and any repeatable `--catalog <file>` — a component from a pulled library is mapped, not orphaned (the first line names every catalog read). `--screen` adds the coverage of that screen; 0% (and `catalog-rekeyed`) is a warning with a question to confirm, not an exit 1. |
| `audit.ts` | Pre-build design audit for one or more screen/layer files: token-binding %, off-grid spacing, touch targets per platform (web 24 / iOS 44 / Android 48), WCAG contrast over composited backgrounds, fixed-size text, drawn status bars/home indicators, component state coverage from variant options, undrawn loading/empty/error states, and effects that don't translate to the target. Writes `design/audit/<screen>.{json,md}`; never fails a build. Used by the `audit-design` and `build-screen` skills. |
| `map-bootstrap.ts` | Scaffolds `codeconnect.local.json` from the catalog with props pre-translated and `status:"needs-review"` — the free-plan `figma connect create`. Re-run merges (preserves confirmed entries). `--from-proposals <cross-check report.json>` stubs only cross-check's CONFIRMED name+prop-signature matches, filed under the screen's own instance key; `--screen <screen.json>` scopes a full bootstrap to the components that screen's own visible instances reference, instead of every component in the catalog — taken from the named catalog, `components.library.json` beside it, the export's `libraries/*/components.json` and any repeatable `--catalog <file>` (a full bootstrap stays the named catalog only). |
| `cross-check.ts` | The cross-FILE join between one or more screens and the design system they claim to come from: foreign/re-keyed variable collections, token name collisions (this screen's vs. elsewhere), text styles and components missing from the export, and confirmed-or-not component-match proposals. Auto-discovers `design/export/variables.json` (never a stale `design/variables.json` sibling) and prints the exact path it used. |
| `verify-screen.ts` | Per-node comparison of a rendered build against the design's own expectation: geometry/typography/color tolerances, component coverage, and `--interactions`-driven trigger checks (each row records the exact selector driven and its match count — an unmeasured expectation is not a passed one; a pass needs one matched element, an allowed `outcome` and no unexpected `navEvents` — documents loaded during the interaction). `--status`/`--wait`/`--publish` run the verifier's status v2 handshake (`verify-run.ts`: atomic writes, run id + rev + file shas; the live status and the stage dir live in the run cache `node_modules/.cache/designtwin-verify/`, outside every dev-server watch; `done` checks, then publishes the staged artefacts and the final status into `design/verify/`). Its parts live in `verify-shared.ts` (what --expect and --compare agree on), `verify-expect.ts`, `verify-compare.ts` and `verify-report-md.ts`. |
| `verify-build.ts` | The build-screen Stop hook: blocks on a raw literal where the plan resolved a token and on an un-anchored visible node; prints each plan's computed (never stored) status via `--status`. |
| `verifier-guard.ts` | The visual-verifier subagent's PreToolUse hook (`claude-plugin/hooks/hooks.json`; a plugin agent's own frontmatter hooks are ignored): for that agent only (the payload's `agent_type`), refuses a write outside `design/verify/` and the run cache (or to a tool-owned file there), a pattern kill, a dependency or Playwright browser install and `dangerouslyDisableSandbox` — a deny decision on stdout, exit 0; anything it cannot read is allowed and logged. Reads its payload through `hook-input.ts`, shared with `verify-build.ts`. |
| `node-artefacts.ts` | A project's artefacts by node: which plan, verify sets and audit report belong to a node, which node each is of (a plan: its `nodeId`, else the id its own `<Layer>__<id>` file name carries; a verify set: its own files, else its name; an audit report: its `nodeIds[]`), and the one "one node, one X" refusal. verify-screen, plan-skeleton, audit, the audit gate, verify-build, verify-migrate, resolve-screen and screen-key all ask it. |
| `report-freshness.ts` | What a verify report was computed against and whether that still holds: `--compare` stamps the code (content hashes, git HEAD) and the plan's waivers through it, and a plan's status (plan-status.ts) judges a report fresh or stale with typed reasons (the export, the expectation on disk, the code, the waivers — by content, never a clock), each worded once. It also binds a measured file to its expectation and run (`--compare`'s integrity reasons, `--status --phase measured/done`'s refusals) and reads a plan's `verification.recorded` against its report. The git calls go through an injected `Git`. |
| `plan-status.ts` | A plan's status, computed and never stored: the lifecycle a person sets (`pending`, `awaiting-user`, `abandoned`), the Stop hook's record against the plan and its code now (typed: unchecked, plan changed, blocked, edited by hand, stale, passed — the older planHash formula still accepted), whether the hook still has work on the plan, and the precedence over that and what the verify report says (its freshness judged by report-freshness). verify-build (its fast path and `--status`) and verify-screen `--migrate` ask it. |
| `verify-sets.ts` | The verify-set name grammar (`<Layer>__<id>[.<variant>]`) and a set's files: each file's path by kind (`setFile`: expectation, report, measured, status, evidence, the probe's diff, …), the `--migrate` journal, and the one rule for which files only the verify tools write (`isToolOwned`: never written by hand — the verifier's guard — nor copied in by `--publish`). Every verify tool spells a set's files through it. |
| `screen-inputs.ts` | A screen plus what surrounds it, resolved once for `audit.ts` and `cross-check.ts`: each screen's doc, own `.vars.json` slice and `.assets.json`, the variables union (`--variables`, else the export root's `variables.json`, else a lone screen's own slice), the design system in either layout (`--design-system`, else the `design-system/` of the screen's export, else of the cwd's), the `libraries/` exports, the component map (`--map`, else the discovered one — broken only warns), and the export's other screens; each optional input not there is a note. `crossCheckInputOf` is the one mapping from that context to crossCheck's input — the audit's cross-file pass hands its context through it. |
| `export-index.ts` | Every screen an export knows about: the root `pages/index.json` and every `pages/<dir>/index.json` on disk (a page walk replaces the root with its own pages, so an earlier walk's screens are in their page's index only), each screen once (one node of one Figma file; the root's row wins), whether a node is exported, and a row's screen file — inside the export only. resolve-screen, screen-key, verify-locate, verify-screen `--expect`, verify-migrate, screen-inputs' siblings (audit and cross-check), audit's neighbours, plan-skeleton and design-diff all ask it; none builds an index path. `screenSiblingFile` is a screen's `.vars.json` / `.assets.json` name. |
| `resolve-screen.ts` | The one node-id → exact layer name → indexed `title` → plan `screenName`/`route` resolver every skill uses to turn a human's screen name into one exact file, instead of guessing a filename. |
| `verify-probe.ts` | The shipped web probe: renders the built screen with the **project's own** Playwright (never bundled or installed), measures every expectation row the same way every run, drives the listed overlay interactions, runs the behaviour/accessibility checks and an informational visual diff against the Figma reference, and writes `<Layer>__<id>.measured.json` for `verify-screen.ts --compare`. `--check` reports whether a renderer is available. Its parts live in `probe-*.ts` and `visual-diff.ts`. |
| `plan-skeleton.ts` | Generates a new plan's (`design/plan/<Layer>__<id>.json`) skeleton from the export — bound tokens, visible component instances, anchors, suggested anchors, hidden subtrees — so the model fills in only the decisions. `--out` on an existing plan merges (model-filled fields kept); `--seed-from` fills empty rows from a sibling plan. Its `visibility` helper is the one "which nodes are actually on screen" rule `verify-build.ts` uses too. |
| `get-component.ts` | Prints ONE catalog entry in full — its variants with their real node trees, from the detail file its `variantsFile` pointer names — resolved by `key`, then id, then name (the same handle drift-lint and map-bootstrap print). |

## How to use it (the workflow)
```
# 1. Export the design system from Figma (existing plugin flow) -> design/export/design-system.json manifest
#    + design/export/design-system/{tokens,styles.paint,styles.text,styles.effect,styles.grid,
#                            styles.animation,components.local,components.library,hygiene}.json
#    NOTE: pass the SPLIT files below, never design-system.json — that is a slim pointer
#    manifest and carries no variables/components (the tools fail loud if you hand it one).
# 2. Scaffold the component map (fill in the TODO import paths afterwards):
bun design-to-code/map-bootstrap.ts design/export/design-system/components.local.json --out design/codeconnect.local.json
# 3. Validate the map shape:
bun design-to-code/map-validate.ts design/codeconnect.local.json
# 4. Check it against the current Figma catalog (run this in CI / pre-commit):
bun design-to-code/drift-lint.ts design/codeconnect.local.json design/export/design-system/components.local.json
# 5. Emit code tokens:
bun design-to-code/tokens.ts design/export/design-system/tokens.json ./out    # -> out/tokens.dtcg.json + out/tokens.css
#                                                                             #    + out/tokens.resolver.json + out/tokens/*.json
# the input is design/export/variables.json instead when the export was a single-screen pull
bun design-to-code/tokens.ts design/export/variables.json ./out --web tailwind  # -> out/theme.css (Tailwind v4 @theme) only;
#                                                                             #    add --also-generic for the set above too
#    (or feed tokens.dtcg.json to Style Dictionary for Tailwind/SwiftUI/Compose output; feed
#     tokens.resolver.json to any DTCG 2025.10 resolver-aware tool to pick a theme/mode)
```
Then the codegen step consults `codeconnect.local.json` (a mapped instance → your component; an unmapped
one → generated markup) and emits token references instead of literals.

## The map: `codeconnect.local.json`
Keyed by the **stable component publish `key`** (name is a low-confidence fallback only). Prop transforms
are **declarative value-tables — no functions, no eval** (validated by Figma's own "files are not
executed" design). Full shape is enforced by `map-validate.ts` (and documented here); each entry:
```jsonc
"<component key>": {
  "figma": { "key": "…", "name": "Button" },          // key = identity; name = advisory
  "code":  { "module": "@/ui/Button", "export": "Button" },
  "props": {
    "Variant":  { "kind": "enum", "codeProp": "variant", "values": { "Primary": "primary" } },
    "Disabled": { "kind": "boolean", "codeProp": "disabled", "default": false, "omitDefault": true },
    "Label":    { "kind": "string", "codeProp": "children" },
    "Icon":     { "kind": "instance", "slot": "icon" }   // recursive: swapped child resolves to its own entry
  },
  "status": "needs-review",                             // -> active once a human confirms it
  "note": "Icon slot mapped by hand"                    // optional free text for people; must be a string, no tool reads it
}
```

## Relationship to `dtwin seed` and `design/components.json`
There are two component maps with different jobs. `design/codeconnect.local.json` (this directory's
format; the path is `MAP_FILE` in `bridge/src/project-layout.ts`) is the schema'd, validated, drift-checked,
bootstrappable map the tools above read and the `build-screen` skill consults. `dtwin seed`
(`bridge/src/seed-components.ts`) is a separate, code-side seeder: it reads Code Connect files from your
codebase and merges Figma component name, import and source into `design/components.json`
(`{import, component, props}`), fill-missing-only, never clobbering hand-authored fields. Nothing in
`design-to-code/` reads `design/components.json`. Likewise `design/tokens.json` is the hand-written
override layer (Figma variable path to your token) that the `build-screen` skill reads; `tokens.ts` never
does, it emits from `design/export/variables.json` (or the split `design-system/tokens.json`).
`map-bootstrap.ts` seeds the map from the Figma side, `dtwin seed` from the code side; they are
complementary.

## Validating on a real file
`bun test/design-to-code.test.ts` runs on **mock** data. Before trusting the tooling on real
output, walk the **Layer C checklist in `../TESTING.md`** — it runs the token emitter, bootstrap,
validator, and drift-lint against a genuine export (`design/export/design-system/`) and injects each drift class to confirm
the lint catches it.

## Status
Repo-agnostic core: **built and offline-tested**, with regression tests for every fixed bug; the validator
is checked against an ajv oracle (0 divergences / 10,733 inputs) and the pipeline composes end-to-end. Two
documented low/pathological limitations remain (see the spec). Deferred: the codegen resolver (needs your
target repo) and the degraded-input normalization pass (needs ΔE-threshold research).
