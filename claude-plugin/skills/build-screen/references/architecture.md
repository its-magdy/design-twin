# Where the code goes

`build-screen` step 2 records an `architecture` object in the plan before writing any file. This is
how to decide what goes in it.

The reason it is a recorded decision rather than a matter of taste: a build that picks a layout ad
hoc produces something nobody can extend. The live run that prompted this file emitted a flat
`src/{screens,components/{ui,layout,jobroles},data,lib,styles}` — two screens of one feature in a
global `screens/`, that feature's own table and modals under `components/jobroles/` beside the
generic `Button`/`Field`/`Modal`, mock data and the provider global, and the generic set named by the
builder instead of after the design system's catalog. Every individual choice was defensible. The
sum of them meant a second feature built later would have had nothing to reuse *by design-system
name*, and no recorded reason for the split.

## 1. Follow what is already there

Matching a neighbouring feature beats any convention this file could name, so look before proposing.

```bash
ls src 2>/dev/null; ls app 2>/dev/null; ls lib 2>/dev/null
find src app lib -maxdepth 2 -type d 2>/dev/null | head -40
```

What you are looking for, in rough order of how strongly it decides the answer:

- A `features/`, `modules/`, `domains/` or `pages/` directory with more than one entry — that IS the
  convention; add yours beside them and mirror the internal shape of the closest one.
- A single existing feature, however it is laid out. One precedent is still a precedent.
- A component library directory (`components/ui`, `ui/`, `design-system/`, `packages/ui`) — shared
  components go there, whatever you do about the feature.
- Import conventions: path aliases in `tsconfig.json`/`jsconfig.json`/`vite.config`, barrel files,
  `index.ts` re-exports. Follow them; a screen that imports differently from every other file is
  friction on every future edit.
- A router's own expectations (Next.js `app/`, Expo Router, SvelteKit) — those dictate file location
  and are not negotiable.

Record what you matched: `{convention: "followed", source: "src/features/billing"}`. That single
field is what stops the next build re-litigating the question.

## 2. Only on a fresh scaffold, propose

When there is genuinely nothing to match, propose this and get a yes before writing files:

```
src/
  components/<CatalogName>/   shared design-system components, one dir per catalog entry,
                              named and propped after the Figma component
  features/<feature>/
    screens/                  the routed screens
    components/               pieces used only by this feature
    data/                     this feature's types and sample/mock data
    hooks/                    this feature's state
  layout/                     the app shell every feature renders inside
  styles/                     the generated theme file and nothing else
```

Per stack, the same shape under different names: SwiftUI `Features/<Feature>/{Views,Components,Models}`
plus a shared `DesignSystem/`; Compose `feature/<feature>/` plus `core/designsystem/`; Flutter
`lib/features/<feature>/{presentation,widgets,data}` plus `lib/design_system/`. Follow the platform's
own idiom over this table if the project's ecosystem has a strong one.

Record it as `{convention: "proposed", shared: "src/components", features: "src/features"}`.

## 3. The catalog decides shared-vs-feature, not taste

This is the part that was an accident on the live run, and it does not have to be a judgement call.

- A component whose `mainComponent.setKey` resolves in `design-system/components.local.json` is a
  **design-system component**. It goes in the shared directory and takes the catalog entry's name and
  prop names, so the next feature can find it by the name the designer uses.
- A component that cross-check matched only **by name** (`verified: false`) is a strong candidate for
  the same treatment — use the catalog's name and shape — but mark the plan row `verdict:"new"` and
  say in the report that the mapping is unverified.
- Anything else is **feature-local** until a second feature needs it. Promoting it then is a small,
  obvious refactor; guessing now that a table row is reusable is how a shared directory fills with
  things one screen uses.

When there is no catalog at all (a single-screen pull), say so in the plan's `architecture.notes`:
the split you chose is then a reasonable guess, not a derived fact, and the next person should know
which it was.

**Evolving a shared component the catalog covers 0% of.** On a screen whose catalog match rate is
0% (`catalog-covers-nothing`, or every instance is `matchedByName` only), the FIRST screen to build a
given design-system component is also the one that shapes its code — there is no existing shared
implementation to conform to yet. Build it in the shared directory under the catalog's own name and
props (never the feature folder, even though nothing will fail if you put it there today), sized to
what this screen actually needs; record in `architecture.notes` that it is the first real
implementation of that catalog entry, not a finished one. The second screen that uses the same
catalog key must **extend the existing shared component** — add the prop or variant it needs — never
duplicate it into its own feature folder because the first version doesn't quite fit. A builder
working from weaker instructions than "reuse, don't regenerate" has nothing here to catch a `DataTable`
silently copied into a feature folder instead of extended; treat a same-catalog-key component that
already exists in the shared directory as a hard signal to extend, not to re-derive.

## 4. What the plan records

```json
"architecture": {
  "convention": "followed",
  "source": "src/features/billing",
  "shared": "src/components",
  "features": "src/features/job-roles",
  "notes": "no component catalog was exported, so shared-vs-feature is a judgement call here"
}
```

Four fields and a sentence. The point is that the next build reads a decision instead of inferring
one from the file tree — and that when the split turns out to be wrong, there is something to
disagree with.
