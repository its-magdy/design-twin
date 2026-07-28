# Design-to-code layer — verified spec (ADR)

Status: **accepted (repo-agnostic core built; resolver deferred to a target repo)**
Date: 2026-07-23
Verified by: 4 parallel research agents against authoritative sources (Figma Code Connect docs,
W3C DTCG format, Style Dictionary, Tokens Studio, Anima/Locofy/Builder.io, and two Figma GitHub issues).

This document is the source of truth for the layer that turns the extractor's faithful JSON into
**reused real components + real tokens**, instead of pixel-regenerated lookalikes. It complements
`ARCHITECTURE.md` (the read/write planes) and the `figma-to-code` skill (the codegen consumer).

## Problem

`figma-plugin/code.js` extracts *what a design looks like* (comprehensively — see the read-gaps audit).
But codegen only ever sees the JSON, so:

1. A Figma component instance has no link to your code component → the AI regenerates a worse copy
   of a `<Button>` you already have.
2. Colors/spacing are literals in the JSON → the AI hardcodes hex instead of referencing your tokens.
3. Real files are often **unstructured** (hardcoded hex, detached frames, no auto-layout) or have a
   **style-guide page** that the screens don't actually reference — so there's nothing wired to hook into.

The extractor is faithful; the fix is a layer *between* extraction and codegen.

## Key insight

The extractor already emits the **entire left-hand side** of every mapping model for free:
per-instance `component` + `props` + a catalog with `componentPropertyDefinitions` (carrying the stable
publish `key`, prop `type`, `default`, VARIANT `options`, INSTANCE_SWAP `preferredValues`), and
tier-classified variables with modes/aliases/`codeSyntax`. This is the same metadata Figma's paid
`figma connect create` fetches from its REST API, and the same input DTCG/Style Dictionary want. So this
is not a big build — it is **authoring the right-hand side (code targets) + two mechanical emitters +
a lint**, plus a normalization pass for degraded input.

## Architecture

```
                         ┌─ tokens.dtcg.json ──▶ Style Dictionary (or built-in CSS emitter)
Figma ──▶ extractor ─────┤                        ──▶ per-stack tokens (CSS vars / Tailwind / Swift / Compose)
 (code.js, unchanged)    └─ codeconnect.local.json (authored) ─┐
                                                               ▼
   raw export ─▶ NORMALIZE (grade · snap-to-token · fuzzy-match · harvest page) ─▶ enriched JSON
                                                               ▼
     codegen resolver: instance ──map hit?──▶ real component (mapped island)
                                              └──miss────▶ lean generated markup (fallback)
```

## Decisions (each traceable to a source)

### Tokens — DTCG interchange + preserved references
- **DTCG JSON is the interchange, not the destination.** Emit DTCG, then fan out with Style Dictionary
  (or the built-in CSS emitter). Do not hand-write CSS in the plugin. (Figma resource library; Tokens Studio.)
- **Preserve the reference graph.** `dumpVariables()` already resolves aliases to token *names*; emit
  those as DTCG `{color.neutral.900}` references, NOT flattened hex. `outputReferences: true` in Style
  Dictionary then compiles to `var(--color-neutral-900)` so a mode swap needs zero component edits.
  This is the single biggest themeability lever. (Style Dictionary formats doc; alwaystwisted parts 7–8.)
- **Three tiers, enforced not just recorded.** Literals live only in primitives; semantic/component
  tiers must be references. A "semantic" token holding a raw hex is a themeability smell → flag it.
- **Modes → theme axis.** Primitives once under `:root`; semantic layer per mode
  (`[data-theme="dark"]`, …); `defaultModeId` → base. Web `[data-theme]` + `prefers-color-scheme`
  fallback; SwiftUI asset-catalog appearances or `Color(light:dark:)`; Compose two `ColorScheme`s.
- **Color**: carry `display-p3` components when `documentColorProfile` is P3 (always with a `hex`
  sRGB fallback — do not downgrade at extraction). Keep alpha. (DTCG 2025.10 structured color.)
  Note: Style Dictionary v4 does not yet fully support 2025.10 structured `$value`; the `hex` fallback covers it.

### Components / variants / props — key-based map + transform vocabulary
- **Key on the stable component `key`; name is a low-confidence fallback only.** Name-matching is the
  documented root cause of breakage. Every serious tool persists an explicit editable map; AI is only
  a suggestion layer. (Code Connect; Anima; Locofy; Builder.io.)
- **Transform vocabulary by Figma property type:** VARIANT → enum prop (value-table, must be
  exhaustive); BOOLEAN → bool prop or child view; TEXT → string/`children`; INSTANCE_SWAP → slot
  (resolved recursively). (Code Connect React/SwiftUI/Compose.)
- **Default-omission:** partial-map → `undefined` → prop dropped; seed defaults from
  `componentPropertyDefinitions.defaultValue`. (SwiftUI `hideDefault`; React `undefined` omission.)
- **Resolution algorithm:** `detachedInfo` → markup guard → key lookup → most-specific
  `variantOverride` wins → prop transforms → recursive slots/children → **override reconciliation**
  (consume covered overrides, escape/demote uncovered ones, never silently drop) → compose mapped
  islands inside lean fallback markup.

### Typing / validation / drift — no-eval data + a lint that beats Figma
- **No-eval is validated by Figma's own design:** Code Connect transforms are declarative value-tables;
  "files are not executed." The map is plain JSON data. Computed transforms only via a **whitelisted
  named-op registry** (e.g. `{ "transform": "pxToRem", "base": 16 }`), never inline functions.
- **Schema as single source of truth.** `tooling/map-schema.json` (JSON Schema) is the authored source;
  `tooling/map-validate.js` enforces it with structured errors (no runtime dependency — matches this
  repo's zero-dep style). If a build step is later adopted, a Zod schema deriving `z.infer` + the JSON
  Schema is the upgrade path.
- **Drift-lint beats the paid tool.** Figma Code Connect keys on node-id and has an open, unfixed bug
  (github.com/figma/code-connect/issues/337): a deleted/moved mapped component makes `publish` succeed
  *silently* with a broken link. Because we key on the stable `key`, `tooling/drift-lint.js` catches
  exactly that — plus unmapped components, prop-name mismatches, and prop-type/enum-value mismatches —
  at lint time. A pure rename produces zero drift.

### Degraded input — the normalization pass (design deferred build; thresholds need research)
Most real files are unstructured or have a decorative style-guide page. Handle via a pass that runs
only when the fidelity grade is low:
- **Grade** the input (% colors bound vs raw hex, % instances vs detached, % auto-layout vs absolute,
  % named layers) and surface it to the user *before* codegen — file prep is the highest-leverage activity.
- **Snap-to-token**: match raw values against the catalog — exact, then nearest within a ΔE threshold in
  a perceptual color space. Emit the token reference + a confidence in `manifest.warnings`. (ΔE threshold
  and color space still to be pinned by research before hardcoding.)
- **Fuzzy component match**: a detached/raw frame structurally equal to a catalog component → seed a
  `needs-review` map entry. `detachedInfo` is the strongest signal ("this was component X").
- **Harvest the style-guide page**: parse decorative swatches (rect fill + text label) into a synthetic
  token table, then snap screens against it. (Real Variables/Styles are already file-global and dumped.)
- **Clustering fallback** when nothing exists: dedupe distinct colors → local tokens, so even the worst
  input isn't 40 loose hexes. The reference screenshot is the safety net for self-correction.
- **Principles:** confidence on every recovered link; never silent invention; suggestion + human-confirm
  (`needs-review`), not auto-commit; conservative thresholds (leave a literal rather than snap wrong).

## Form factor
Push determinism into scripts + hooks; reserve skills/agents for judgment.
- Scripts (`tooling/*.js`): token emitter, validator, drift-lint, bootstrap, the mechanical parts of normalize.
- Hook: run drift-lint on export / pre-commit so drift is caught automatically.
- Skill/agent: the fuzzy-match confirm loop and the codegen resolver live in `figma-to-code` /
  `figma-screen-builder`, where model judgment meets the map.

## Build status
- **Built (repo-agnostic, harness-tested + adversarially reviewed):** `tooling/tokens.js`,
  `tooling/map-schema.json`, `tooling/map-validate.js`, `tooling/drift-lint.js`, `tooling/map-bootstrap.js`.
  Adversarially reviewed across **FOUR rounds** (4 agents each, all node-proven), findings converging
  28 → ~6 → 1 → ~0 real: round 1 found 28 confirmed bugs (validator too lenient vs its schema; drift-lint
  name-fallback masking the deleted-component case it advertises; token collisions/shorthand-hex/alpha-
  dropping fallback/unitless CSS; bootstrap merge data-loss); round 2 (reviewing the fixes) found ~6 fix-
  introduced regressions; round 3 found 1 more (a bootstrap stub-refresh destroying half-finished human
  edits → reverted to always-preserve); round 4 found one narrow fix (the ambiguous-prop guard was
  asymmetric — catalog-only; now symmetric) and otherwise only LOW/pathological or test-coverage items,
  and confirmed the whole pipeline composes end-to-end. All fixed; the validator is ajv-verified (0
  divergences / 10,733 inputs). `test/tooling.test.js` hardened 33→122 checks, a tagged regression test per
  finding, assertions pin values. Validate on real data via the **Layer C checklist in TESTING.md**.

  **Documented low/pathological limitations (not fixed — would risk regressions for scenarios normal use
  can't produce):** (1) bootstrap leaves a stale *guessed* export on an untouched, catalog-renamed stub —
  LOW, the entry is `needs-review` and human-reviewed anyway, no human data lost; (2) `prevByIdent`
  first-writer-wins can silently drop a prev entry whose map key equals a *different* live component's
  key while it is itself orphaned — MEDIUM data-loss but only reachable via a hand-mangled map (a
  bootstrapped map never produces it).
- **Deferred:** codegen resolver (needs a target repo); normalize thresholds (need ΔE + structural-
  similarity research); the visual self-correction diff loop; a11y enrichment.

## Sources
Figma Code Connect (react/swiftui/compose docs, CLI reference, issues #337 & #194) · W3C DTCG format
(designtokens.org) · Style Dictionary (styledictionary.com) · Tokens Studio · Anima / Locofy / Builder.io
design-to-code writeups · Figma REST component-types. Full URL list in the session research transcripts.
