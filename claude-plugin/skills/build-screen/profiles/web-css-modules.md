# Profile: web-css-modules (React + CSS Modules)

## Contents
Layout · Grid · Scroll/clip/sticky · Prototype reactions · Theming · Native controls ·
Idiomatic web (patterns by structure) · Hints, not output · Component reuse ·
Effects · Text metrics · Strokes · Fills · Text overflow · Images · Interaction states ·
Accessibility & RTL · Accessibility naming · Motion · Vector fallback · Tokens · Components · Assets · Fit the existing app ·
Output

**Layout (IR → CSS in `<screen>.module.css`)**
- `display:flex` → `display:flex`; `flexDirection` → `flex-direction`.
- `gap:N` → `gap:Npx`; `flexWrap:"wrap"` → `flex-wrap:wrap`.
- `padding:[t,r,b,l]` → `padding: t r b l` (px).
- `justifyContent` → `justify-content`; `alignItems` → `align-items` (incl. `"baseline"` →
  `align-items: baseline`).
- `widthMode:"fill"` → `flex:1` or `width:100%`; `"hug"` → `width:auto`/omit; `"fixed"` → `width:Npx` (avoid if possible).

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
- `layout.scroll` (`horizontal`/`vertical`/`both`) → `overflow-x: auto`/`overflow-y: auto`/`overflow: auto`
  (use `scroll` instead of `auto` only if the design clearly wants a persistent scrollbar).
- `fixedChildren` **if present** on a scroll container (count of leading children pinned while the rest
  scrolls) → `position: sticky; top: 0` (header) or `position: sticky; bottom: 0` (footer), plus a
  `z-index`, on that many leading children in DOM order; everything after scrolls normally. Absent →
  treat all children as normal flow.

**Prototype `reactions`/`flows` → behavior, not markup**
- `flows` (named entry points) are candidate top-level routes for your router; don't render them.
- A `reactions` entry with `trigger:"on_click"`/`"on_press"` + `actions[].navigation` → an `onClick`
  handler that does client-side navigation (`react-router` `navigate(destination)`, or an `<a>`/`<Link>`
  when the destination is a real route).
- `type:"overlay"` action → open a modal/dropdown/tooltip component (state toggle), using `overlay.
  position`/`overlay.closeOnClickOutside`/`overlay.background` on the target node for its behavior.
- `set_variable`/`set_variable_mode` actions → local component state (`useState`) or a theme-context
  toggle, keyed by the named `variable`/`collection`/`mode`.
- Ignore triggers you can't action from static code (`mediaHitTime` scrub points, `keyCodes` with no
  matching shortcut) rather than guessing at behavior.

**Theming (`resolvedModes`/`variableModes`)**
- `resolvedModes` (root only) tells you which mode (e.g. Light/Dark) this export is effectively rendered
  in — use it to pick the right custom-property scope when a subtree has no `variableModes` of its own.
- `variableModes` on a subtree pins it to a specific mode regardless of the page default — wrap that
  subtree in a class/attribute selector (e.g. `[data-theme="dark"]`) that redefines the CSS custom
  properties, instead of hardcoding its resolved colors inline.
- Keep both mode's values as CSS custom properties scoped by selector, not two copies of the component.

**Native controls, not rebuilt ones** — a Figma widget maps to the HTML element that already has the
behaviour, keyboard handling and accessibility; style it, don't rebuild it from `div`s. Checkbox →
`<input type="checkbox">`; radio group → `<input type="radio">` sharing a `name` inside `<fieldset>`/
`<legend>`; switch/toggle → `<input type="checkbox" role="switch">`; slider → `<input type="range">`;
text field → `<input>` with the right `type`/`inputmode`/`autocomplete` inferred from the field (email,
tel, password, one-time-code) and a real `<label>`; multi-line → `<textarea>`; dropdown/picker →
`<select>` unless the design needs rich options; date → `<input type="date">`; progress → `<progress>`;
modal/dialog → `<dialog>` + `showModal()` (focus trap, Esc and backdrop come free); menu/tooltip/
popover → the `popover` attribute; accordion/disclosure → `<details><summary>`. No native element:
spinner (CSS animation + `role="status"`), tabs and segmented controls (`role="tablist"` pattern with
arrow-key handling), combobox/autocomplete. **The project's own component or an installed headless
library (Radix, React Aria, Headless UI…) beats all of the above** — check `design/codeconnect.local.json` and
`package.json` before writing either.

**Idiomatic web (patterns by structure)** — decide from the node's STRUCTURE; its name is only a hint.
- Full-width bar pinned to the top of the root frame (`fixedChildren`, or first child with logo/title/
  actions) → `<header>`, `position: sticky`/`fixed` per the scroll section; a row of destinations inside it →
  `<nav>`. The main scrolling column → `<main>`; a bottom bar of links/legal → `<footer>`. One of each
  per page — if the app already has a layout/shell route, the screen renders INSIDE it, so don't emit
  a second header.
- A bottom bar of 3–5 icon+label destinations (mobile web) → `<nav>` with `<a aria-current="page">`,
  fixed to the bottom with `padding-bottom: env(safe-area-inset-bottom)`.
- N siblings with the same structure → `<ul><li>` rendered by ONE `.map()` over sample data with a
  stable `key`, never N pasted blocks. Rows of aligned cells under column labels → a real `<table>`.
  A wrapping set of equal cards → CSS grid (`repeat(auto-fill, minmax(…))`), not fixed columns copied
  from one frame width.
- A row that navigates → the whole row is one `<a>`; a card with one primary action → a single link/
  button (stretch it over the card with a pseudo-element), not nested interactive elements.
- A labelled group of inputs with a submit action → `<form>` with `onSubmit` (Enter submits, password
  managers work), not a `div` with a click handler on the button.
- **Don't double-inset**: the browser pads nothing, but the app's layout/container usually does. If a
  shell already applies the page gutter or max-width, drop the root frame's own horizontal padding
  instead of adding both. Drawn browser chrome, status bars, scrollbars and on-screen keyboards in
  the frame are never elements.
- The frame's width is ONE viewport, not a fixed canvas: the root is `width:100%` with a
  `max-width` when the design is centred, and fills are fluid. Add breakpoints only where the project
  already uses them or a second frame shows the other size.

**Hints, not output** — `layoutGrids`, `measurements`, `devStatus`/`devStatusNote`, `devResources` inform
your column structure and let you sanity-check spacing; never render them as visible UI.

**Component reuse** — before generating markup for an instance's sublayer, check `exposedInstances`,
`propRefs`, `overrides` on the node: a prop-driven or overridden sublayer maps to a **prop/variant** on
the already-mapped component (from `design/codeconnect.local.json`), not new markup. `detachedFrom` (`{key}` or
`{componentId}`) means the node used to be an instance of a component that may still exist in
`design/codeconnect.local.json` — look it up and reuse it unless the detach looks deliberate (genuinely bespoke).

**Effects → CSS**
- Figma blur ≈ 2× CSS blur (community-derived — verify visually): `background_blur` → `backdrop-filter:
  blur(radius/2 px)` (+ `-webkit-backdrop-filter`) with a translucent background; `layer_blur` → `filter:
  blur(radius/2 px)`. `blurType:"progressive"` → `mask-image` gradient over the blurred layer (approx) or asset.
- `drop_shadow` → `box-shadow: x y radius spread color` (Figma `radius` == CSS blur radius); `inner_shadow` →
  `inset`; multiple → comma list; on a TEXT node → `text-shadow: x y radius color` (no spread).
- `noise`/`glass`/`texture`/`shader` effect types have no direct CSS equivalent. For a subtle `noise`,
  approximate with a repeating SVG-noise `background-image`; otherwise **use the exported `asset`** (the
  flattened render) instead of trying to reproduce the effect in CSS — don't invent a shader.
- Node `blendMode` → `mix-blend-mode`; paint `blend` → `background-blend-mode`; `pass_through`/`normal` → omit.
  `rotation` (DEGREES, Figma positive = counter-clockwise) → `transform: rotate(-{rotation}deg)`; `flipped` →
  `transform: scaleX(-1)` (check axis against the `.png`); `skew` (degrees) → `transform: skewX(Ndeg)`.

**Text metrics** — `font-size` in rem (px/16) so user zoom works; fluid type → `clamp()` with rem bounds.
- `font.lineHeight`: `percent` → unitless `line-height: pct/100`; `px` → px/rem; `auto` → `normal`.
- `font.letterSpacing`: `percent` → `(pct/100)em`; `px` → px; absent = 0.
- `font.leadingTrim:"cap_height"` → `text-box: trim-both cap alphabetic` (Baseline 2026: Chrome 133,
  Safari 18.2, Firefox 154). `font.weight` is the verbatim style string — emit `font-weight: {weightValue}`.

**Strokes** (`strokes.{weight|weights,align,dash,colors}`)
- `align:"inside"` → `border` with `box-sizing: border-box` (or `box-shadow: inset 0 0 0 w color`);
  `"outside"` → `outline: w solid` / `box-shadow: 0 0 0 w color` (no layout); `"center"` → `outline` +
  `outline-offset: -w/2`. Per-side `weights` → `border-top` etc. `dash` → `border-style: dashed` (approx) or SVG.

**Fills** — gradient: compute the angle from `transform` `[[a,c,e],[b,d,f]]` (don't assume 180deg);
`GRADIENT_RADIAL` → `radial-gradient`, `ANGULAR` → `conic-gradient`, `DIAMOND` → no CSS equivalent (asset).
Image `scaleMode`: `fill` → `object-fit: cover`, `fit` → `contain`, `crop` → derive `object-position`/size from
`transform` (or a wrapper), `tile` → `background-repeat` + `background-size` from `scale`. Hex is 8-bit sRGB
even if `colorProfile` is display-p3 → `color(display-p3 r g b)` with a hex fallback.

**Text overflow**
- `truncate:true` → `text-overflow: ellipsis; white-space: nowrap; overflow: hidden;` (single line), or
  combined with `maxLines:N`, the `-webkit-line-clamp: N` idiom (`display:-webkit-box;
  -webkit-box-orient:vertical; overflow:hidden;`).
- `font.textWrap` mirrors Figma's `textWrapStyle`, 1:1 with CSS: `"balance"` → `text-wrap: balance;`,
  `"pretty"` → `text-wrap: pretty;`. Absent means Figma's default (`AUTO`) — emit nothing.
- `autoResize` tells you whether the text box should hug (`width_and_height`/`height`) or clip
  (`truncate`/`none`) — set `width`/`height` to `auto` vs a fixed value accordingly.
- Figma's manual line breaks are **not authoritative** (different text engine than browsers) — let text
  reflow naturally; only preserve an explicit break where it reads as clearly intentional (e.g. a
  heading) against the `.png`.

**Images** — use `intrinsicSize` (`{w,h}`) to set `aspect-ratio: w / h` in CSS so layout doesn't jump
before the image loads; always set explicit width+height on the container.

**Interaction states** — look up the component in `design/export/design-system/components.local.json`'s `components` catalog and
check its variant `options` for hover/focus/disabled/error/selected states before shipping. Always add a
visible `:focus-visible` rule even if the Figma design only shows a `:hover` state — it's the most
commonly missed a11y requirement. Gate `:hover` with `@media (hover:hover)`; add `:active`, `:disabled`/
`[aria-disabled="true"]`.

**Accessibility & RTL** — WCAG contrast 4.5:1 text, 3:1 large text (≥24px or ≥18.66px bold) and UI parts;
target size ≥24×24 CSS px (2.5.8 AA), 44 recommended; 2.4.7 Focus Visible is AA (2.4.13 appearance is AAA).
`padding` is PHYSICAL `[t,r,b,l]` → emit `padding-inline-start/end`, `margin-inline` so RTL mirrors.

**Accessibility naming — semantic element FIRST, ARIA only to patch**
- Pick the element from what the node *does*, not how it looks: `<button>` for anything clickable that
  isn't navigation, `<a href>` for navigation, `<nav>`/`<header>`/`<main>`/`<footer>` for the shell,
  `<ul><li>` for repeated rows, `<label for>` + a real `<input>` for fields. A styled `div` with
  `onClick` needs `role`, `tabIndex={0}` and key handlers — use the right element instead.
- Headings track document order: one `<h1>` per screen, then `h2`/`h3` with no skipped level. Figma's
  font size sets the CSS class, never the heading level.
- `aria-label` is for **icon-only** controls; never relabel a control that has visible text. Prefer a
  visually-hidden span (clip-path/`1px` idiom, not `display:none`) over `aria-label`.
- Images: meaningful → real `alt`; decorative/duplicated by adjacent text → `alt=""` (an inline
  decorative `<svg>` gets `aria-hidden="true"` + `focusable="false"`). Never omit `alt`.
- State goes through ARIA, not class names: `aria-expanded`, `aria-current="page"`, `aria-selected`,
  `aria-disabled` — and style off those attributes (`[aria-current="page"] { … }`) so they can't drift.
- Touch target ≥24×24 CSS px (WCAG 2.5.8 AA), 44×44 recommended — grow it with padding or a
  pseudo-element overlay, not by scaling the icon.

**Motion** — `transition.duration` is SECONDS → ms; `easing.cubicBezier{x1,y1,x2,y2}` → `cubic-bezier()`;
`spring` → `linear()` approximation or JS. Honor `@media (prefers-reduced-motion: reduce)`.

**Vector fallback** — a `geometry` field (`fills`/`strokes`: arrays of SVG path `d` strings, plus `w`/`h`)
appears on a vector node whose SVG export failed. Render it inline as
`<svg viewBox="0 0 w h"><path d="..." /></svg>` rather than an `<img>` — there is no asset file for it.

**Tokens** — the right-hand value in `tokens.json` is a CSS custom property (e.g. `var(--color-primary)`).
Use it inside the module CSS (`color: var(--color-text)`), not inline literals.

**Components** — import per `design/codeconnect.local.json`; `className={styles.x}`; pass Figma `props` through
(see **Component reuse** above before generating markup for an instance's sublayer).

**Assets** — use the exported files in `design/export/assets/`: `<img src>` for PNG, and for a vector either
`<img src="….svg">` or an icon component wrapping that file (SVGR import). **Never hand-write
`<svg><path d="…">` markup** — the only exception is the `geometry` vector fallback above, where no asset
file exists. Size every asset explicitly (see **Images**).
A path-heavy SVG (see `references/export-layout.md`, heavy vector assets) is the
case to watch: the browser antialiases each path independently, so a flattened noise texture renders
visibly speckled where Figma's canvas is smooth. Ask for a raster re-export — don't try to blur or
fade the grain away in CSS.

**Fit the existing app (detect before you emit)** — read `package.json` and a neighbouring page first.
- *Strings.* `next-intl`, `react-intl`, `react-i18next`, `lingui` present → the project's `t()`/`<FormattedMessage>`
  with a new key; `aria-label`, `alt`, placeholders and errors too. None → literals are fine; say so.
- *Routing & data.* Next App Router vs Pages vs React Router vs TanStack Router decide the file location,
  `<Link>` import and whether the component may be a Server Component (`"use client"` only where it
  has state/handlers). Data states come from the fetching layer in use.
- *Components & theme.* An installed UI kit (shadcn/ui, Radix, MUI, Headless UI) and the existing
  CSS variables win over new markup and new literal values.

**Output** — React function component `.tsx` + colocated `.module.css`, one screen per folder under `outputDir`.
