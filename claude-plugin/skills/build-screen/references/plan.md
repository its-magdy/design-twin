# The plan, and building from it

Steps 2 and 3 of the build, in full. The plan (`design/plan/<Layer>__<id>.json`) is what the Stop hook, `sync-design` and
the verifier find a screen by; you fill only its decisions.

## The plan (step 2)

First, if you will script against the export JSON at all (a walker, a count,
a check), read `design/export/SCHEMA.md` — the scripting quick keys (`text` not `characters`, `box.w`
not `width`, `hidden` on ancestors, `scroll`, `fixedChildren`); field names guessed from Figma's Plugin
API are wrong. Then **generate** the plan rather than hand-transcribing it (hand-copied plans let hidden
layers, mistyped token names and wrong values "pass"):

```
bun --no-install --no-env-file "<scripts>/plan-skeleton.js" <screen json> <screen .vars.json> \
  design/export/design-system --out design/plan/<Layer>__<id>.json [--route /<route>] [--seed-from design/plan/<sibling>.json]
```

A new plan is named by its node: `design/plan/<Layer>__<id>.json`, the `stem` resolve-screen printed (the one the
node's verify set already has, if any). Another name for a new plan, or a second plan of a node that already has
one, is refused (exit 2, naming the file to use); an existing plan is merged under whatever name it has.

It writes what the export already knows: the header (`screenName`, `nodeId`, `file`) every skill
finds the plan by; `tokens[]` — every bound variable with its Figma `key`, its `value` in this
frame's mode and its design-system match (rows bound only by hidden layers come pre-marked
`hidden-only`); `components[]` — every **visible** instance with key/variant/props and its
`catalog` identity (by key, or cross-check's name+signature proposal, or `{by:"ambiguous", candidates:[…]}`
when several catalog entries share the name and none verifies — a lead to pick from, never a match; component identity comes
from there and from `design/codeconnect.local.json`, never from an attribute you place in markup);
`anchors{}` — every visible node id; `anchorsSuggested[]` — where to start filling them (the screen frame itself, first, as `"screen"` — a frame that is
an instance is the whole list; the root's sections,
each outermost instance, and each container whose children are mostly rows of one shape — three or more, i.e.
a `.map()`; the dividers between its rows go with it; its other children, such as a search bar above the rows, are listed on their own; `covers` says how
many nodes it stands for; refreshed on every re-run, not part of `counts`); `hidden[]` — what is not built. **You fill only the
decisions:** `codeToken`/`verdict`/`decision` per token, `mapModule`/`verdict` per component,
`mapModule` on anchors (step 3: the frame itself plus the `anchorsSuggested` ids first, the rest is covered by its nearest mapped ancestor), `route` (advisory free text — it never reaches a screen), `navigate` and
`interactions` when the screen needs them (step 3), `target`, `architecture`, `files[]` (step 3),
`deviations[]` as `{nodeId, field, designed, built, reason}` (record a deviation you already know about when you
build it, with its reason — the verifier never writes one; a `field: "reference"` row says the reference PNG is
only a stand-in there, e.g. an illustration you do not reproduce, and `--compare` shows that on the visual line without
waiving a delta), `allowedLiterals[]` when needed, and `verification` (step 5). Re-running it merges; filled fields survive. `--seed-from <plan>` (repeatable) pre-fills still-empty rows from
a sibling screen's plan when the token (same key and value) or component (same set key) is the same
thing; seeded rows carry `seededFrom` — review them, they are never overwritten once filled. The `Stop` hook checks the
built code against this file, so it must exist before step 3. **On a large export, filling in
these decisions genuinely takes several turns — that is normal and does not need a status.**
`status` stays `"pending"` the whole time a decision is still being worked out; `"awaiting-user"`
is for a real external block (a MISSING token, an audit blocker, a map needing review), not for a plan that is
still being filled in mid-session. Sections to decide (show large-screen plans to the user too):
- **Architecture** → the `architecture` object, decided *before* the first file and recorded so
  the next feature can follow it. **Inspect the repo first and follow what is already there**; only
  on a genuinely fresh scaffold propose a layout, get a yes, and record it. Where code goes is a
  real decision, and leaving it to taste produces a layout nobody can extend.
  `references/architecture.md` has the detection checklist, the default layout per stack, and how
  the catalog — not taste — decides what counts as a shared component.
- **Component inventory** → `components[]` (one row per visible instance, already listed): a mapped
  code component (`verdict:"reused"`, `mapModule` = its file or import path), a native platform
  control (per the profile), or `verdict:"new"`. Rows of one repeated component get the same
  answer. A new component for something that exists in the codebase is a bug; check by structure,
  not name — glob the project's actual component files/exports rather than relying on memory. A cross-check
  name match is a lead, not a mapping: such a row is `verdict:"new"` with `matchedByName`.
- **Token map** → `tokens[]` (every bound variable, already listed with its `figmaName` and `key`;
  add a row, `figmaName: null`, for a raw unbound value you write as a literal; *Names come from
  Figma* says why the name carries the weight). Prefer `codeSyntax.{WEB,ANDROID,iOS}` (the designer's
  code name, `references/export-layout.md`); else grep the project's palette/theme source (`tailwind.config.*`,
  `--color-*`/`@theme` CSS vars, `theme.ts`, `*.xcassets` colorsets, `Color.kt`/`Dimens.kt`,
  `ColorScheme`/`ThemeExtension` in Dart — not `design/export/design-system/tokens.json`, which is Figma's
  raw values, so copy no hex straight out of it). The verdict is either the **exact** matching token
  (same hex/value or token name actually found by grep — not "closest existing token") or
  **MISSING**. On a project that has **no** token source of its own yet, generate one once rather than
  hand-writing one per screen (two screens built in separate sessions then disagree about what
  `color/primary` is called): `bun --no-install --no-env-file "<scripts>/tokens.js" …` — `--native <profile>` on a
  native stack, the `--web` target your web profile names, no flag for plain `tokens.css`; `theme-tokens.md`
  says which input to feed it — a shell shared by several screens needs every screen's tokens — and how to
  wire the file in. A project that already has a theme keeps it, and its names win. Fill a MISSING row only
  with the user's answer — a token defined for a different role/surface, picked because it's close or already
  imported elsewhere, is silent hardcoding by proxy, the bug this rule exists to catch. Any **MISSING** row
  **blocks step 3**: set the plan's `status` to `"awaiting-user"`, stop and ask the user whether to add the
  token or which specific fallback to use; on the answer, record it as that row's `decision` and set `status`
  back to `"pending"`.

  **"MISSING" means the token was expected and is not there — not "this value has no token".** A
  raw value with no variable bound is built exactly as exported with a one-line `decision` ("no
  variable is bound; kept as a one-off literal") — complete, no user input, the audit's own
  default. Stop and ask only for a value that *should* have a token: a colour the rest of the
  screen themes, a spacing step the design system names differently, a step-1 collision where you
  cannot tell which value is right. Thirteen questions about drawn values waste your one round-trip.
- **Layout tree** — stacks/grids/native containers, each axis sized from the IR (absent `widthMode`/`heightMode` is
  the declared fixed size; the profile's *Sizing* card); system chrome drawn in the frame (status bar, home
  indicator) becomes insets, not views.
- **State matrix** — interaction states per control (from variant options + audit), screen data
  states (loading/empty/error), and which are designed vs defaulted. If every frame is one width, add
  the designer question "desktop-only design — how should narrow widths behave?" and build the
  profile's default.
- **Unit conversions** — list the text metrics, strokes, shadows, blurs, gradients and transitions
  that need the profile's conversion, and mark approximations (spread on iOS, blur radius, diamond
  gradients) so verification doesn't chase them.
- **Assets** — each `asset` file and how it's imported for this stack.
Then **self-review the plan** against the expectation rows: every visible node accounted for? any literal where a
token exists? any hand-built native control? each axis sized as the IR declares it? Fix the plan, then build.
**Native control substitution:** when a drawn field becomes a native control (date/time picker, select),
the native element draws its own text, so carry the drawn placeholder/value colour onto it, record the
substitution in the plan as a `deviations[]` row `{nodeId, field: "control", designed, built, reason}`, and verify it
on the element's own text (the profile says how for its stack). A TEXT layer drawn as a field's hint and built as
its `placeholder` attribute gets `{nodeId, field: "placeholder", designed, built, reason}` (the TEXT's id) unless its
layer or token name already says "placeholder" — the verifier compares it as the placeholder only then; a drawn
value (a name in an edit field) is the control's value, never a placeholder.
*Multi-screen:* scaffold navigation/routing and shared sample data first.

**Names come from Figma, not from you.** A token's, component's or asset's name is the designer's, carried in
the export — derive the code identifier from it mechanically (`Schemes/On Primary` → `on-primary` /
`onPrimary`, in whatever form the profile gives). One Figma name is one code token even when two values coincide
in this mode (the Stop hook flags a `codeToken` reached from two `figmaName`s); a colour keeps its name whatever
you use it on; an exported asset keeps its file name; and where Figma genuinely has no name, ask the user — then
list every name you invented in the step-6 report. `references/names.md` has the reasons, the asset-name rule and
the `acknowledged` row for a deliberate share; read it before naming anything.

**Two mistakes seen in practice — check the plan for them explicitly:**
- A node named Status Bar / Home Indicator / 9:41 / Keyboard appears in the plan as a view or
  composable. Delete it from the layout tree; the plan says "inset" instead (`Scaffold`/
  `WindowInsets.safeDrawing`, SwiftUI safe area, CSS `env(safe-area-inset-*)`). A "simplified mock"
  of system chrome is still a bug.
- Text metrics converted without units. Worked example for `font.size` 28,
  `letterSpacing {value:-2, unit:"percent"}`, `lineHeight {value:120, unit:"percent"}`:
  Compose `letterSpacing = (-0.02).em`, `lineHeight = 1.2.em` · SwiftUI `.tracking(-0.56)` ·
  CSS `letter-spacing: -0.02em; line-height: 1.2` · Flutter `letterSpacing: -0.56, height: 1.2`.
  Percent → divide by 100; the sign is kept.

## Building from the plan (step 3)

Implement the smallest pieces first (new components, token
additions), each compiling and checked before composing. For a large screen scaffold the outer
structure, then one section at a time. As each file lands, add its path to `files[]`
(project-relative) — the `Stop` hook reads only the files listed there. In the same edit fill
`anchors["<node id>"].mapModule` with the file that renders that node — the frame, each section,
each instance. A node left empty is covered by its nearest filled ancestor, so twelve rows from one
`.map()` or a shell shared with another screen need one entry, not one per node; a visible node you
deliberately do not build gets `{"omitted": "<why>"}`. A visible node with no anchor at all is one
of the things the hook blocks on: `sync-design` keys its change list by node id, and an
unanchored subtree is code nobody can find.
Rules while building:
- **Fit the app, not just the design** — before the first file, do the detection in the profile's
  *Fit the existing app* section (strings/l10n, router, state, theme, styling library) and follow
  what you find; a neighbouring screen is the reference. A pixel-exact screen with hard-coded
  strings and its own navigation stack is not done.
- **Layout** — the profile's stack constructs from `layout`, each axis sized per its *Sizing* card (`fill` → stretch,
  `hug` → intrinsic, absent → the declared fixed size); `sizeLimits` → min/max. `layout.mode:"absolute"` means no auto layout
  inside that node (only on nodes that hold children; the node's own out-of-flow flag is `absolute:true`) — infer
  a flow rather than transcribing coordinates. Real grids stay grids. `clip`/`scroll`/`fixedChildren` (the LAST
  N entries of `children[]`) → the profile's scroll & sticky section.
- **Text** — map to the type scale by style name; convert `lineHeight`/`letterSpacing` **with their
  units** per the profile (percent ≠ px). Every data-driven text gets an overflow rule (`truncate`/
  `maxLines`/wrap). Let text containers size to their content rather than locking a fixed height. Use start/end
  alignment. A line-height taller than
  its fixed text box (the expectation lists it as "text box height", about Npx): choose deliberately — keep the designed
  line-height and let the text overflow its box as Figma does, or fit the box — and note which in `deviations`.
- **Styling** — tokens over literals; paint `opacity` vs node `opacity` are different; strokes honor
  `align` (inside/outside/center) and per-side `weights`; shadows keep `spread` where the stack can.
- **Assets** — import `asset` files per the profile, and use exported art only: no hand-written
  `<svg>`/`<path>`, no icon of your own, no placeholder — the only exception is a node carrying `geometry` (export
  failed; its paths are provided; a graphic with `assetSkipped:"hidden"` — hidden itself or under a hidden
  ancestor — has no file unless
  `assetFrom` names a visible twin whose file it reuses). An asset that has `sourceTransform` is already rotated
  or flipped in the file — apply no rotation or flip of your own. Reuse a project icon only if the glyph clearly matches. Size every
  icon explicitly (square container, both dimensions set).
  Of the exported files, import only those listed in THIS screen's `.assets.json`; another screen's file is that screen's art, never a substitute.

  The screen's `.assets.json` also flags `heavy` files (import by URL and ask for a PNG re-export), `monochrome`
  ones (recolour with `currentColor` at render time in one shared wrapper, leaving the file as exported) and
  `duplicates` (import one) — `references/assets.md` says how, forced colours included.
- **Instances** — before writing anything for an instance's sublayer, check `propRefs`,
  `overrides` and `exposedInstances` on the node: a prop-driven or overridden sublayer becomes a
  **prop on the mapped component**, never hand-built markup beside it. `detachedFrom` (`{key}`/
  `{componentId}`) was an instance — look that component up in `design/codeconnect.local.json` and reuse it.
- **Hints are not output** — `layoutGrids`, `measurements`, `devStatus`/`devStatusNote` and
  `devResources` inform structure and let you sanity-check spacing; they are never rendered as UI.
- **Interactions** — `reactions` become real navigation/state, not dead buttons; `overlay` →
  the stack's modal/sheet; transitions use the given duration (seconds → ms) and easing. The export
  hands over the whole interaction graph keyed by node id, and step 5 drives every edge of it — so
  a button wired to nothing fails verification instead of passing as a nice-looking mockup.
- **Make it measurable** (`references/measurable.md`): carry the node id into the markup on every element
  that implements a node one-to-one (`data-dt-node` on web, `accessibilityIdentifier`, `testTag`,
  `Semantics(identifier:)`) — a tag, not a comment, and never an invented id; on web the Stop hook blocks when
  no file carries `data-dt-node`. Tag a dialog or overlay's root with its destination frame id. A screen
  reached by clicks gets `plan.navigate`; an interaction the export cannot express goes in
  `plan.interactions`. To keep tags out of a deploy bundle, strip them at build time only behind an opt-in env
  the deploy build alone sets, never in the source.
