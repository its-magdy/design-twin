# Profile: web-css-modules (React + CSS Modules)

**Read `web-common.md` beside this file too** — sizing per axis, strokes, mixed text runs, effects, fills, native
controls, idiomatic web, interaction states, accessibility, motion and assets are the same for both web profiles
and are written there in plain CSS, which is this profile's syntax. This file has only what is specific to CSS
Modules.

## Contents
Layout · Grid · Scroll/clip/sticky · Theming · Text metrics · Tokens · Components · Output

**Layout (IR → CSS in `<screen>.module.css`)** — each child's size is *Sizing (per axis)* in `web-common.md`.
- `display:flex` → `display:flex`; `flexDirection` → `flex-direction`.
- `gap:N` is the main-axis gap → `column-gap:Npx` on a row, `row-gap:Npx` on a column (not the `gap`
  shorthand, which also sets the cross axis). `flexWrap:"wrap"` → `flex-wrap:wrap`, and its track gap:
  `rowGap` (a wrapping row) → `row-gap`, `columnGap` (a wrapping column) → `column-gap`. An absent track
  gap is 0 — emit none, or `0` if a `gap` shorthand is in play. A wrap's tracks → `align-content`: its
  `alignContent`, else from `alignItems` (`flex-start`/`center`/`flex-end`; `stretch` when every in-flow child is
  `alignSelf:"stretch"`; `baseline` → `flex-start`, with `align-items: baseline` aligning the items within each
  track) — never leave the initial `normal`, which behaves as `stretch` on a multi-line flex container.
- `padding:[t,r,b,l]` → `padding: t r b l` (px).
- `justifyContent` → `justify-content`; `alignItems` → `align-items` (absent → `flex-start`; `"baseline"` →
  `align-items: baseline`).

**Grid (`layout.display:"grid"`) → `display:grid`**
- `columns`/`rows` → `grid-template-columns: repeat(N, 1fr)` / `grid-template-rows: repeat(N, 1fr)` only
  when tracks are uniform.
- `columnSizes`/`rowSizes` (array of `{type:"flex"|"fixed"|"hug", value}`) → build the explicit template:
  `flex` → `Nfr`, `fixed` → `Npx`, `hug` → `auto`, e.g. `grid-template-columns: 1fr 200px auto;`. Prefer
  this over a uniform `repeat()` whenever tracks differ.
- `columnGap`/`rowGap` → `column-gap`/`row-gap` (the grid gap — distinct from the flex `gap` above; don't
  reuse `itemSpacing` for a grid container).
- `autoFlow` → `grid-auto-flow: row|column` (only emitted when non-default).
- `autoTracks` → `grid-auto-rows` when it varies from `auto`.
- Per-child `gridColumnSpan`/`gridRowSpan` → `grid-column: span N`/`grid-row: span N`; `gridColumnStart`/
  `gridRowStart` (0-based track index → 1-based CSS line) → `grid-column-start: {N+1}`/`grid-row-start: {N+1}`.
- `gridJustifySelf`/`gridAlignSelf` (`start`/`center`/`end`) → `justify-self`/`align-self`.

**Scroll, clip & sticky**
- `clip:true` → `overflow: hidden` on that container.
- `scroll` (`horizontal`/`vertical`/`both`) → `overflow-x: auto`/`overflow-y: auto`/`overflow: auto`
  (use `scroll` instead of `auto` only if the design clearly wants a persistent scrollbar).
- `fixedChildren` **if present** on a scroll container (the LAST N entries of `children[]` are pinned
  while the rest scrolls; place each by its `y`) → `position: sticky; top: 0` (a top bar — put it first
  in the DOM) or `position: sticky; bottom: 0` (a bottom bar), plus a `z-index`, on those N children;
  everything else scrolls normally. Absent → treat all children as normal flow.

**Theming (`resolvedModes`/`variableModes`)**
- `resolvedModes` (root only) tells you which mode (e.g. Light/Dark) this export is effectively rendered
  in — use it to pick the right custom-property scope when a subtree has no `variableModes` of its own.
- `variableModes` on a subtree pins it to a specific mode regardless of the page default — wrap that
  subtree in a class/attribute selector (e.g. `[data-theme="dark"]`) that redefines the CSS custom
  properties, instead of hardcoding its resolved colors inline.
- Keep both modes' values as CSS custom properties scoped by selector, not two copies of the component.

**Text metrics** — `font-size` in rem (px/16); fluid type → `clamp()` with rem bounds.
- `font.lineHeight`: `percent` → unitless `line-height: pct/100`; `px` → px/rem; `auto` → `normal`.
- `font.letterSpacing`: `percent` → `(pct/100)em`; `px` → px; absent = 0.
- `font.leadingTrim:"cap_height"` → `text-box: trim-both cap alphabetic` (Baseline 2026: Chrome 133,
  Safari 18.2, Firefox 154). `font.weight` is the verbatim style string — emit `font-weight: {weightValue}`.

**Tokens** — the right-hand value in `tokens.json` is a CSS custom property (e.g. `var(--color-primary)`).
Use it inside the module CSS (`color: var(--color-text)`), not inline literals.
- Generated theme: `bun --no-install --no-env-file "<scripts>/tokens.js" <variables file> <dir>` with **no** `--web` flag — `tokens.css` is the
  file for this stack (`:root` plus a `[data-theme="…"]` block per non-default mode; when several collections share a mode name each is scoped
  `[data-theme-<collection>="<mode>"]` and `tokens.js` warns which attributes to set). Its names keep
  the Figma name's case and turn `/` and spaces into `-`: `Primary/Primary` → `--Primary-Primary`,
  `Space 4` → `--Space-4`. CSS has no built-in scale for them to shadow, so there is no prefix.
- A name ending in `-<8 hex>` (`--Space-4-1a2b3c4d`) means two Figma variables share that name with
  different values; the suffix is the variable's key. Use the one whose key the screen's own
  `.vars.json` carries.

**Components** — import per `design/codeconnect.local.json`; `className={styles.x}`; pass Figma `props` through
(*Component reuse* in `web-common.md` before generating markup for an instance's sublayer).

**Output** — React function component `.tsx` + colocated `.module.css`, one screen per folder under `outputDir`.
