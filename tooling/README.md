# `tooling/` — the design-to-code layer (who / what / how / why)

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
| **CI / pre-commit** | Runs `drift-lint` so a Figma change that breaks the map fails the build instead of shipping silently. |

## What's here
| File | What it does |
|---|---|
| `tokens.js` | Variables → **W3C DTCG JSON** (aliases preserved as `{group.token}` references — the themeability lever; structured color w/ P3 + hex fallback) **and** a zero-dependency **CSS emitter** (`:root` + `[data-theme]` blocks). Usable without Style Dictionary. |
| `map-schema.json` | JSON Schema for `codeconnect.local.json` — the authored source of truth for the map shape. |
| `map-validate.js` | No-dependency structural validator; returns `{ok, errors:[{path,message}]}`, never throws on bad input. |
| `drift-lint.js` | Joins the map against the live component catalog **by stable `key`**; reports orphaned entries, unmapped components, stale/uncovered props, and kind/enum mismatches. Catches the exact bug Figma's own Code Connect ships silently (issue #337). |
| `map-bootstrap.js` | Scaffolds `codeconnect.local.json` from the catalog with props pre-translated and `status:"needs-review"` — the free-plan `figma connect create`. Re-run merges (preserves confirmed entries). |

## How to use it (the workflow)
```
# 1. Export the design system from Figma (existing plugin flow) -> design-system.json manifest
#    + design/design-system/{tokens,styles.paint,styles.text,styles.effect,styles.grid,
#                            components.local,components.library,hygiene}.json
#    NOTE: pass the SPLIT files below, never design-system.json — that is now a slim pointer
#    manifest and carries no variables/components (the tools fail loud if you hand it one).
# 2. Scaffold the component map (fill in the TODO import paths afterwards):
node tooling/map-bootstrap.js design/design-system/components.local.json > codeconnect.local.json
# 3. Validate the map shape:
node tooling/map-validate.js codeconnect.local.json
# 4. Check it against the current Figma catalog (run this in CI / pre-commit):
node tooling/drift-lint.js codeconnect.local.json design/design-system/components.local.json
# 5. Emit code tokens:
node tooling/tokens.js design/design-system/tokens.json ./out    # -> out/tokens.dtcg.json + out/tokens.css
#    (or feed tokens.dtcg.json to Style Dictionary for Tailwind/SwiftUI/Compose output)
```
Then the codegen step consults `codeconnect.local.json` (a mapped instance → your component; an unmapped
one → generated markup) and emits token references instead of literals.

## The map: `codeconnect.local.json`
Keyed by the **stable component publish `key`** (name is a low-confidence fallback only). Prop transforms
are **declarative value-tables — no functions, no eval** (validated by Figma's own "files are not
executed" design). Full shape in `map-schema.json`; each entry:
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
  "status": "needs-review"                              // -> active once a human confirms it
}
```

## Relationship to the existing `design/` maps
The repo already had a simpler `design/components.json` (`{import, component, props}`) and `design/tokens.json`,
plus `bridge/seed-components.js` (which seeds the component map from *code-side* Code Connect files).
`tooling/` is the **formalized superset**: a schema'd, validated, drift-checked, bootstrappable map plus a
DTCG token pipeline. `bridge/seed-components.js` seeds from the code side; `tooling/map-bootstrap.js` seeds
from the Figma side — they are complementary. Consolidating the codegen skill onto the `tooling/` format is
part of the deferred resolver work (needs a target repo).

## Validating on a real file
`node test/tooling.test.js` (122 checks) runs on **mock** data. Before trusting the tooling on real
output, walk the **Layer C checklist in `../TESTING.md`** — it runs the token emitter, bootstrap,
validator, and drift-lint against a genuine export (`design/design-system/`) and injects each drift class to confirm
the lint catches it.

## Status
Repo-agnostic core: **built, offline-tested (122 checks), and adversarially reviewed across FOUR rounds**.
Findings converged 28 → ~6 → 1 → ~0 real: round 1 found 28 bugs; round 2 (reviewing the fixes) found ~6
fix-introduced regressions; round 3 found 1 more (a stub-refresh that destroyed human edits → reverted);
round 4 found one narrow fix (asymmetric ambiguous-prop guard) and otherwise only LOW/pathological or
test-coverage items (closed). All fixed with tagged regression tests; the validator is ajv-verified (0
divergences / 10,733 inputs) and the pipeline composes end-to-end. Two documented low/pathological
limitations remain (see the spec). Deferred: the codegen resolver (needs your target repo) and the
degraded-input normalization pass (needs ΔE-threshold research). **Not yet run in LIVE Figma.**
