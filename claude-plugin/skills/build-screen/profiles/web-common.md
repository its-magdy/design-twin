# Web rules shared by both web profiles

`web-tailwind.md` and `web-css-modules.md` each give the syntax (a utility class or a CSS declaration); the rules
below are the same for both and are written in plain CSS. In Tailwind, use the arbitrary-value form of the same
declaration where no utility exists (`flex-[0_0_141px]`, `basis-0`, `self-stretch`).

## Contents
Sizing (per axis) · Strokes · Mixed text runs · Text overflow · Effects · Fills · Images · Prototype reactions ·
Native controls · Date and select fields · Idiomatic web · Hints, not output · Component reuse ·
Interaction states · Accessibility & RTL · Accessibility naming · Motion · Vector fallback · Assets ·
Fit the existing app

**Sizing (per axis)** — size each axis of each flex child from its own IR fields; the parent's mode never decides
a child's size.
- **Absent `widthMode`/`heightMode` = fixed**: the export declares that size (`box.w`/`box.h`). Use it, even inside
  a hug parent (a hug parent hugs its children's sizes; it does not make them hug): `width`/`height: Npx`, plus
  `flex: none` on the main axis. (`flex: 0 0 Npx` alone is not enough: a flex item's automatic minimum lets a long
  word push it past the basis.) A fixed size the export declares is not a magic number; one it does not
  declare is.
- `hug` → main axis `flex: 0 0 auto`; cross axis no size.
- Main-axis `fill`, or `grow: 1` → `flex: 1 1 0` plus `min-width: 0` in a row / `min-height: 0` in a column, so
  content cannot push it past its share.
- Cross-axis `fill`, or `alignSelf: "stretch"` → `align-self: stretch` with no cross size. `alignSelf`
  `min`/`center`/`max` → `align-self: flex-start`/`center`/`flex-end`.
- Every flex container sets `align-items` from `layout.alignItems`; absent `alignItems` = start → `flex-start`.
  Never leave CSS's initial `normal`, which stretches flex items where Figma starts them.
- `sizeLimits` → `min-width`/`max-width`/`min-height`/`max-height` on top of the mode.
- A TEXT's fixed width is kept like any other (it wraps inside it); a fixed TEXT height becomes `min-height`, so
  200% zoom and longer translations still fit.
- Two exceptions. A root frame that is a whole page is one viewport, not a canvas: `width: 100%` (with a `max-width`
  when the design is centred) and at least the viewport tall (`min-height: 100dvh`, or the app shell's content area),
  so a `grow` child has a height to fill. Any other root — a dialog, popover, panel, cell or component frame — keeps
  its declared size like any fixed node. And an `absolute:true` child is placed by its `x`/`y` and sized by `box`;
  the children of a `layout.mode:"absolute"` parent (no auto layout) are sized by `box`, but their flow is inferred,
  never transcribed coordinates.

**Strokes** (`strokes.{weight|weights,align,dash,colors}`, `strokesInLayout`) — the colour is the stroke's own bound
token (`tokens.strokes`), never a nearby grey and never the hex beside it.
- `align: "inside"` with `strokesInLayout` → a real `border` with `box-sizing: border-box`: the stroke takes layout
  space and counts toward a hug size. Use a real border with `box-sizing: border-box`, not a box-shadow ring — an
  inset ring takes no space, so a hugging badge comes out 2×weight narrower and shorter.
- `align: "inside"` without `strokesInLayout` → `box-shadow: inset 0 0 0 w color`: the stroke takes no space, and a
  border would push the content in by `w`.
- `align: "outside"` → a spread ring `box-shadow: 0 0 0 w color`, or `outline: w solid color`; no layout space.
- `align: "center"` → `outline: w solid color` + `outline-offset: -w/2`.
- Per-side `weights` → per-side borders (`border-top-width` …): a spread box-shadow can't draw sides of different
  widths. Without `strokesInLayout` a single side may be an offset inset shadow (`inset 0 -w 0 0 color`).
- `dash` → `border-style: dashed` (approximate) or an SVG.

**Mixed text runs** — `runs[]` present → one inline element (`<span>`) per run, each styled from that run's own
`font`, colour and `tokens`; the node's `font` is only the first run. A run's `href` → `<a>`; `list` → `<ul>`/`<ol>`.

**Text overflow**
- `truncate:true` → `text-overflow: ellipsis; white-space: nowrap; overflow: hidden` (single line); with
  `maxLines:N`, the line-clamp idiom (`display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp: N`).
- `font.textWrap` mirrors Figma's `textWrapStyle`, 1:1 with CSS `text-wrap`: `"balance"`, `"pretty"`. Absent is
  Figma's default (`AUTO`) — emit nothing.
- `autoResize` says whether the text box hugs (`width_and_height`/`height`) or clips (`truncate`/`none`).
- Figma's manual line breaks are **not authoritative** (a different text engine) — let text reflow; keep an explicit
  break only where it reads as clearly intentional (a heading) against the `.png`.

**Effects**
- Figma blur ≈ 2× CSS blur (community-derived — verify visually): `background_blur` → `backdrop-filter:
  blur(radius/2 px)` with a translucent background; `layer_blur` → `filter: blur(radius/2 px)`.
  `blurType:"progressive"` → a `mask-image` gradient over the blurred layer (approximate) or the asset.
- `drop_shadow` → `box-shadow: x y radius spread color` (Figma `radius` == CSS blur radius); `inner_shadow` →
  `inset`; several → a comma list; on a TEXT node → `text-shadow: x y radius color` (no spread).
- `noise`/`glass`/`texture`/`shader` have no CSS equivalent. A subtle `noise` may be a repeating SVG-noise
  background; otherwise **use the exported `asset`** (the flattened render) — don't invent a shader.
- Node `blendMode` → `mix-blend-mode`; paint `blend` → `background-blend-mode`; `pass_through`/`normal` → omit.
  `rotation` (DEGREES, Figma positive = counter-clockwise) → `rotate(-{rotation}deg)`; `flipped` → `scaleX(-1)`
  (check the axis against the `.png`); `skew` (degrees) → `skewX(Ndeg)`.

**Fills** — gradient: compute the angle from `transform` `[[a,c,e],[b,d,f]]` (don't assume 180deg), `stops[].pos`
as %; `GRADIENT_RADIAL` → `radial-gradient`, `ANGULAR` → `conic-gradient`, `DIAMOND` → no CSS equivalent (asset).
Image `scaleMode`: `fill` → `object-fit: cover`, `fit` → `contain`, `crop` → `object-position`/size from `transform`
(or a wrapper), `tile` → `background-repeat` + `background-size` from `scale`. Paint `opacity` is in the colour;
node `opacity` → `opacity`. Hex is 8-bit sRGB even when `colorProfile` is display-p3 → `color(display-p3 r g b)`
with a hex fallback.

**Images** — `intrinsicSize` (`{w,h}`) → `aspect-ratio: w / h` so layout doesn't jump before the image loads; always
set explicit width and height on the container.

**Prototype `reactions`/`flows` → behaviour, not markup**
- `flows` (named entry points) are candidate top-level routes; don't render them.
- `trigger:"on_click"`/`"on_press"` + `actions[].navigation` → an `onClick` that navigates client-side (the router's
  `navigate(destination)`, or an `<a>`/`<Link>` when the destination is a real route).
- `type:"overlay"` → open a modal/dropdown/tooltip (state toggle), using the target's `overlay.position`/
  `overlay.closeOnClickOutside`/`overlay.background`.
- `set_variable`/`set_variable_mode` → local state (`useState`) or a theme-context toggle, keyed by the named
  `variable`/`collection`/`mode`.
- Ignore triggers static code can't action (`mediaHitTime` scrub points, `keyCodes` with no matching shortcut).

**Native controls, not rebuilt ones** — a Figma widget maps to the HTML element that already has the behaviour,
keyboard handling and accessibility; style it, don't rebuild it from `div`s. Checkbox → `<input type="checkbox">`;
radio group → `<input type="radio">` sharing a `name` inside `<fieldset>`/`<legend>`; switch → `<input
type="checkbox" role="switch">`; slider → `<input type="range">`; text field → `<input>` with the right
`type`/`inputmode`/`autocomplete` inferred from the field (email, tel, password, one-time-code) and a real `<label>`;
multi-line → `<textarea>`; dropdown → `<select>` unless the design needs rich options; date → `<input type="date">`;
progress → `<progress>`; modal → `<dialog>` + `showModal()` (focus trap, Esc and backdrop come free);
menu/tooltip/popover → the `popover` attribute; disclosure → `<details><summary>`. No native element: spinner (CSS
animation + `role="status"`), tabs and segmented controls (`role="tablist"` with arrow keys), combobox. **The
project's own component or an installed headless library (Radix, React Aria, Headless UI…) beats all of these** —
check `design/codeconnect.local.json` and `package.json` first.

**Date and select fields keep the drawn text colours** — a native control draws its own text, so the design's
placeholder/value colours do not arrive by themselves. `::placeholder` never applies to `<input type="date">`
(it has no placeholder). Chromium/WebKit, non-standard — check in the browser: colour `::-webkit-datetime-edit`
(and its `-fields-wrapper` / `-text` parts) with the placeholder token while the field is empty (`:invalid` on a
`required` field, else a `data-empty` attribute you toggle) and the value token once set. Firefox: no such
pseudo-elements that we know of — set `color` on the input itself and check it in the browser. Set `color-scheme`
(dark) so the native picker usually matches the theme. A `<select>` placeholder is a first
`<option value="">` on a `required` select (the spec's placeholder label option), coloured with `select:invalid`.
If you make it `disabled hidden`, also mark it `selected`; in React, use `defaultValue=""` or a controlled
`value=""` on the `<select>`. Otherwise the first enabled option is selected, the field is valid, and the
placeholder never shows. Record the substitution in the plan as a `deviations[]` row
`{nodeId, field: "control", designed, built, reason}` and verify the colour on the element's own text.

**Idiomatic web (patterns by structure)** — decide from the node's STRUCTURE; its name is only a hint.
- A full-width bar pinned to the top of the root frame (`fixedChildren`, or a first child with logo/title/actions)
  → `<header>`, sticky or fixed per the scroll section; a row of destinations in it → `<nav>`. The main scrolling
  column → `<main>`; a bottom bar of links → `<footer>`. One of each per page — when the app already has a
  layout/shell route the screen renders INSIDE it, so emit no second header.
- A bottom bar of 3–5 icon+label destinations (mobile web) → `<nav>` with `<a aria-current="page">`, fixed to the
  bottom with `padding-bottom: env(safe-area-inset-bottom)`.
- N siblings with the same structure → `<ul><li>` from ONE `.map()` over sample data with a stable `key`, never N
  pasted blocks. Rows of aligned cells under column labels → a real `<table>`; derive column x/widths from the BODY
  cells (header cells often carry different padding in the design — header and body x disagreeing is a designer
  question). A wrapping set of equal cards → CSS grid (`repeat(auto-fill, minmax(…))`), not columns copied from one
  frame width.
- A row that navigates → the whole row is one `<a>`; a card with one primary action → one link/button stretched over
  the card with a pseudo-element, not nested interactive elements.
- A labelled group of inputs with a submit action → `<form>` with `onSubmit` (Enter submits, password managers work).
- **Don't double-inset**: when a shell already applies the page gutter or max-width, drop the root frame's own
  horizontal padding. Drawn browser chrome, status bars, scrollbars and on-screen keyboards are never elements.
- The frame's width is ONE viewport, not a fixed canvas: the root is `width:100%` with a `max-width` when the design
  is centred, and fills are fluid. Add breakpoints only where the project already uses them or a second frame shows
  the other size. When every exported frame is one desktop width (especially with Tablet/Mobile variable modes),
  don't silently ship desktop-only: raise the designer question "desktop-only design — how should narrow widths
  behave?" and build the default: fluid down to a stated minimum width, an existing responsive shell pattern (e.g.
  a collapsible sidebar) reused, wide tables scrolling in their container.

**Hints, not output** — `layoutGrids`, `measurements`, `devStatus`/`devStatusNote`, `devResources` inform the column
structure and let you sanity-check spacing; never render them.

**Component reuse** — before generating markup for an instance's sublayer, check `exposedInstances`, `propRefs` and
`overrides` on the node: a prop-driven or overridden sublayer is a **prop/variant** on the mapped component (from
`design/codeconnect.local.json`), not new markup. `detachedFrom` (`{key}` or `{componentId}`) was an instance of a
component that may still be mapped — look it up and reuse it unless the detach looks deliberate.

**Interaction states** — check the component's variant `options` in `design/export/design-system/components.local.json`
for hover/focus/disabled/error/selected before shipping.
- Always add a visible `:focus-visible` style even when the design only shows hover — the most commonly missed a11y
  requirement. A reset that sets `outline-style: none` defeats a bare `outline-width`: state `outline-style: solid`
  (or the full `outline` shorthand) in the focus rule.
- Gate hover with `@media (hover:hover)`; add `:active` and `:disabled`/`[aria-disabled="true"]`.
- The browser's default `<button>` cursor is the arrow: set `cursor: pointer` on enabled buttons once in the base CSS.
- Pressed feedback on every pointer type: a design with no Pressed variant still gets a default active treatment
  (the app's own, else a small darken/overlay), recorded as a defaulted state and listed as a designer question.
- A control wired to nothing (no reaction, no handler) must not look live: no hover/pointer affordance; mark it
  `disabled`/`aria-disabled` or ask.
- Hover-revealed row actions: `opacity: 0` at rest, `opacity: 1` on `:hover`, `:focus-within` and under
  `@media (pointer: coarse)`; never `visibility: hidden` or `display: none`, which drop the control from the tab
  order and leave a dialog opener unable to take focus back.

**Accessibility & RTL** — WCAG contrast 4.5:1 text, 3:1 large text (≥24px or ≥18.66px bold) and UI parts; target
size ≥24×24 CSS px (2.5.8 AA), 44 recommended — grow it with padding or a pseudo-element, not by scaling the icon;
2.4.7 Focus Visible is AA (2.4.13 appearance is AAA). `padding` is PHYSICAL `[t,r,b,l]` → emit logical
`padding-inline-start/end` and `margin-inline` so RTL mirrors. Font sizes in rem (px/16) so user zoom works.

**Accessibility naming — semantic element first, ARIA only to patch**
- Pick the element from what the node *does*: `<button>` for anything clickable that isn't navigation, `<a href>`
  for navigation, `<nav>`/`<header>`/`<main>`/`<footer>` for the shell, `<ul><li>` for repeated rows, `<label for>`
  + a real `<input>` for fields. A `div` with `onClick` needs `role`, `tabIndex={0}` and key handlers — use the
  right element instead.
- Headings follow document order: one `<h1>` per screen, then `h2`/`h3` with no skipped level. Figma's font size
  sets the styling, never the heading level.
- `aria-label` is for **icon-only** controls; never relabel a control that has visible text. Prefer visually-hidden
  text over `aria-label`.
- Images: meaningful → real `alt`; decorative or duplicated by adjacent text → `alt=""` (an inline decorative `<svg>`
  gets `aria-hidden="true"` + `focusable="false"`). Never omit `alt`.
- State goes through ARIA, not class names — `aria-expanded`, `aria-current="page"`, `aria-selected`,
  `aria-disabled` — and is styled off those attributes so the two can't drift.

**Motion** — `transition.duration` is SECONDS → ms; `easing.cubicBezier{x1,y1,x2,y2}` → `cubic-bezier()`; `spring` →
a `linear()` approximation or a JS spring. Honour `prefers-reduced-motion`.

**Vector fallback** — a `geometry` field (`fills`/`strokes`: arrays of SVG path `d` strings, plus `w`/`h`) appears on
a vector whose SVG export failed: render it inline as `<svg viewBox="0 0 w h"><path d="..." /></svg>` — there is no
asset file for it.

**Assets** — the exported files in `design/export/assets/`: `<img src>` for PNG; for a vector `<img src="….svg">` or
an icon component wrapping that file (an SVGR import). **Never hand-write `<svg><path d="…">` markup** — the only
exception is the `geometry` fallback above. Size every asset explicitly (*Images*). A path-heavy SVG
(`references/export-layout.md`, heavy vector assets) renders speckled where Figma's canvas is smooth, because the
browser antialiases each path on its own: ask for a raster re-export rather than blurring the grain away.

**Fit the existing app (detect before you emit)** — read `package.json` and a neighbouring page first.
- *Strings.* `next-intl`, `react-intl`, `react-i18next`, `lingui` present → the project's `t()`/`<FormattedMessage>`
  with a new key; `aria-label`, `alt`, placeholders and errors too. None → literals are fine; say so.
- *Routing & data.* Next App Router vs Pages vs React Router vs TanStack Router decide the file location, the
  `<Link>` import and whether a component may be a Server Component (`"use client"` only where it has
  state/handlers). Data states come from the fetching layer in use.
- *Components & theme.* An installed UI kit (shadcn/ui, Radix, MUI, Headless UI) and the existing theme win over
  new markup and new literal values.
