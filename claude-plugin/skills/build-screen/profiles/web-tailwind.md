# Profile: web-tailwind (React + Tailwind CSS)

## Contents
Layout · Grid · Scroll/clip/sticky · Prototype reactions · Theming (+ dark mode) · Detect the Tailwind
major · Native controls · Idiomatic web (patterns by structure) · Hints, not output · Component reuse · Effects · Text metrics · Strokes · Fills · Text overflow ·
Images · Interaction states · Accessibility & RTL · Accessibility naming · Motion · Vector fallback ·
Tokens · Components · Assets · Fit the existing app ·
Output

**Layout (IR → Tailwind classes)**
- `display:flex` → `flex`; `flexDirection:"column"` → `flex-col` (row is default).
- `gap:N` → nearest scale (`gap-2` ≈ 8px) or `gap-[Npx]`; `flexWrap:"wrap"` → `flex-wrap`.
- `padding:[t,r,b,l]` → `pt-/pr-/pb-/pl-`; collapse to `px-`/`py-`/`p-` when symmetric.
- `justifyContent` → `justify-start|center|end|between`; `alignItems` → `items-start|center|end`,
  and `"baseline"` → `items-baseline` (`align-items: baseline`).
- `widthMode:"fill"` → `flex-1`/`w-full`; `"hug"` → `w-auto`; `"fixed"` → `w-[Npx]` (avoid if possible).

**Grid (`layout.display:"grid"`) → CSS grid utilities**
- Container → `grid`; `columns`/`rows` → `grid-cols-N`/`grid-rows-N` when it's a plain uniform count.
- `columnSizes`/`rowSizes` (array of `{type:"flex"|"fixed"|"hug", value}`) → build `grid-template-columns`
  as an arbitrary value: `flex` → `Nfr`, `fixed` → `Npx`, `hug` → `auto`, e.g.
  `grid-cols-[1fr_200px_auto]`. Don't collapse per-track sizes into a uniform `grid-cols-N` if they differ.
- `columnGap`/`rowGap` → `gap-x-N`/`gap-y-N` (these are the grid gap, distinct from the flex `gap` above —
  don't read `itemSpacing`/`gap` for a grid container).
- `autoFlow` (`row`/`column`, only emitted when non-default) → `grid-flow-row`/`grid-flow-col`.
- `autoTracks` → `auto-rows-*` when it varies from `auto`.
- Per-child `gridColumnSpan`/`gridRowSpan` → `col-span-N`/`row-span-N`; `gridColumnStart`/`gridRowStart`
  (0-based track index from Figma → 1-based CSS line) → `col-start-{N+1}`/`row-start-{N+1}`.
- `gridJustifySelf`/`gridAlignSelf` (`start`/`center`/`end`) → `justify-self-*`/`self-*`.

**Scroll, clip & sticky**
- `clip:true` → `overflow-hidden` on that container.
- `layout.scroll` (`horizontal`/`vertical`/`both`) → `overflow-x-auto`/`overflow-y-auto`/`overflow-auto`
  (use `-scroll` instead of `-auto` only if the design clearly wants a persistent scrollbar).
- `fixedChildren` **if present** on a scroll container (count of leading children pinned while the rest
  scrolls) → apply `sticky top-0 z-10` (header) or `sticky bottom-0 z-10` (footer) to that many leading
  children in DOM order; everything after scrolls normally. Absent → treat all children as normal flow.

**Prototype `reactions`/`flows` → behavior, not markup**
- `flows` (named entry points) are candidate top-level routes for your router; don't render them.
- A `reactions` entry with `trigger:"on_click"`/`"on_press"` + `actions[].navigation` → an `onClick`
  handler that does client-side navigation (`next/link`, `react-router` `navigate(destination)`).
- `type:"overlay"` action → open a modal/dropdown/tooltip component (state toggle), using `overlay.
  position`/`overlay.closeOnClickOutside`/`overlay.background` on the target node for its behavior.
- `set_variable`/`set_variable_mode` actions → local component state (`useState`) or a theme-context
  toggle, keyed by the named `variable`/`collection`/`mode`.
- Ignore triggers you can't action from static code (`mediaHitTime` scrub points, `keyCodes` with no
  matching shortcut) rather than guessing at behavior.

**Theming (`resolvedModes`/`variableModes`)**
- `resolvedModes` (root only) tells you which mode (e.g. Light/Dark) this export is effectively rendered
  in — use it to pick the right token file/CSS class when a subtree has no `variableModes` of its own.
- `variableModes` on a subtree pins it to a specific mode regardless of the page default — wrap that
  subtree in the project's theme scope instead of hardcoding its resolved colors.
- **`dark:` is `prefers-color-scheme`-only by default** — a `className="dark"` wrapper does nothing unless
  the project has opted into a selector-driven dark variant. In v4 that's one line of CSS:
  `@custom-variant dark (&:where(.dark, .dark *));` (or `(&:where([data-theme=dark], [data-theme=dark] *))`).
  In v3 it's `darkMode: 'class'` in `tailwind.config.*`. Check which is present before emitting `dark:` +
  a class scope; if neither, either add the `@custom-variant` line or scope with CSS custom properties.
- Prefer one `dark:`/custom-property-scoped component over baking two versions of it.

**Detect the Tailwind major before emitting anything.** v4 = `@import "tailwindcss"` in the CSS entry (no
`tailwind.config.js` required); v3 = a `tailwind.config.{js,ts,cjs,mjs}` with `content`/`theme`.
- **v4 is CSS-first**: design tokens live in an `@theme { … }` block as CSS variables
  (`--color-primary`, `--font-display`, `--text-lg`, `--radius-md`), and every one of them auto-generates
  the matching utility (`bg-primary`, `text-lg`). The spacing scale derives from a single `--spacing`
  variable, so `p-4` = `calc(var(--spacing) * 4)`. Add new design tokens to `@theme`, not to a config file.
- **v3** keeps tokens in `tailwind.config.*` under `theme.extend.{colors,spacing,fontSize,borderRadius}`.
- Write `tokens.json`'s right-hand side to match whichever the project uses; don't create a
  `tailwind.config.js` in a v4 project just to hold tokens.

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
library (Radix, React Aria, Headless UI…) beats all of the above** — check `codeconnect.local.json` and
`package.json` before writing either.

**Idiomatic web (patterns by structure)** — decide from the node's STRUCTURE; its name is only a hint.
- Full-width bar pinned to the top of the root frame (`fixedChildren`, or first child with logo/title/
  actions) → `<header>`, `sticky`/`fixed` per the scroll section; a row of destinations inside it →
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
- The frame's width is ONE viewport, not a fixed canvas: the root is `w-full`/`width:100%` with a
  `max-width` when the design is centred, and fills are fluid. Add breakpoints only where the project
  already uses them or a second frame shows the other size.

**Hints, not output** — `layoutGrids`, `measurements`, `devStatus`/`devStatusNote`, `devResources` inform
your column structure and let you sanity-check spacing; never render them as visible UI.

**Component reuse** — before generating markup for an instance's sublayer, check `exposedInstances`,
`propRefs`, `overrides` on the node: a prop-driven or overridden sublayer maps to a **prop/variant** on
the already-mapped component (from `codeconnect.local.json`), not new markup. `detachedFrom` (`{key}` or
`{componentId}`) means the node used to be an instance of a component that may still exist in
`codeconnect.local.json` — look it up and reuse it unless the detach looks deliberate (genuinely bespoke).

**Effects → CSS**
- `background_blur` effect → `backdrop-blur-*` (or `backdrop-blur-[Npx]`) + ensure the element has a
  translucent background so the blur is visible; `layer_blur` → `blur-*`/`blur-[Npx]` (foreground filter).
- `noise`/`glass`/`texture`/`shader` effect types have no Tailwind/CSS equivalent. For a subtle `noise`,
  approximate with a repeating SVG-noise background image; otherwise **use the exported `asset`** (the
  flattened render) instead of trying to reproduce the effect in CSS — don't invent a shader.
- `blendMode` (node) → `mix-blend-{mode}`; paint `blend` → `bg-blend-{mode}`; `pass_through`/`normal` → omit.
  `rotation` (DEGREES, Figma positive = counter-clockwise) → `rotate-[${-rotation}deg]` (negate); `flipped` →
  `-scale-x-100` (check axis against the `.png`); `skew` (degrees) → `skew-x-[${deg}deg]`.
- Shadows: `drop_shadow` → `shadow-[x_y_radius_spread_color]` (Figma `radius` == CSS blur radius);
  `inner_shadow` → `shadow-[inset_x_y_radius_spread_color]`; several → comma-join in one arbitrary value;
  on a TEXT node → `[text-shadow:x_y_radius_color]` (no spread).
- Blurs: Figma blur ≈ 2× CSS blur (community-derived — verify visually): `layer_blur` → `blur-[radius/2 px]`,
  `background_blur` → `backdrop-blur-[radius/2 px]` + translucent bg. `blurType:"progressive"` → mask-image
  gradient over the blurred layer (approx) or the asset.

**Text metrics** — sizes in rem (`text-[px/16 rem]`) so user zoom works; fluid type → `clamp()` with rem bounds.
- `font.lineHeight`: `percent` → unitless `leading-[pct/100]`; `px` → `leading-[Npx]`/rem; `auto` → `leading-normal`.
- `font.letterSpacing`: `percent` → `tracking-[pct/100 em]`; `px` → `tracking-[Npx]`; absent = 0.
- `font.leadingTrim:"cap_height"` → `[text-box:trim-both_cap_alphabetic]` (Baseline 2026: Chrome 133,
  Safari 18.2, Firefox 154). `font.weight` is the verbatim style string — use `weightValue` for `font-[N]`.

**Strokes** (`strokes.{weight|weights,align,dash,colors}`)
- `align:"inside"` → `border-[w]` (Tailwind is `box-border`) or `shadow-[inset_0_0_0_w_color]`; `"outside"` →
  `outline outline-[w]` or `shadow-[0_0_0_w_color]` (no layout shift); `"center"` → `outline` +
  `-outline-offset-[w/2]`. Per-side `weights` → `border-t-[N]` etc. `dash` → `border-dashed` (approx) or SVG.

**Fills** — gradient: compute the angle from `transform` `[[a,c,e],[b,d,f]]` (don't assume 180deg) →
`bg-[linear-gradient(...)]` with `stops[].pos` as %; `GRADIENT_RADIAL` → `radial-gradient`, `ANGULAR` →
`conic-gradient`, `DIAMOND` → no CSS equivalent (asset). Image `scaleMode`: `fill` → `object-cover`, `fit` →
`object-contain`, `crop` → derive `object-position`/size from `transform` (or a wrapper), `tile` →
`bg-repeat` + `bg-size` from `scale`. Paint `opacity` multiplies into the color; node `opacity` → `opacity-*`.
Hex is 8-bit sRGB even when `colorProfile` is display-p3 → `[color:color(display-p3_r_g_b)]` with hex fallback.

**Text overflow**
- `truncate:true` → `truncate` (single line) or, combined with `maxLines:N`, `line-clamp-{N}`.
- `font.textWrap` mirrors Figma's `textWrapStyle` and is 1:1 with CSS `text-wrap-style`:
  `"balance"` → `text-balance` (evened-out line lengths — headings/short blocks), `"pretty"` →
  `text-pretty` (fewer orphans — body copy). Absent means Figma's default (`AUTO`), so emit nothing.
- `autoResize` tells you whether the text box should hug (`width_and_height`/`height`) or clip
  (`truncate`/`none`) — pick `w-fit`/`h-fit` vs a fixed box accordingly.
- Figma's manual line breaks are **not authoritative** (different text engine than browsers) — let text
  reflow naturally; only preserve an explicit break where it reads as clearly intentional (e.g. a
  heading) against the `.png`.

**Images** — use `intrinsicSize` (`{w,h}`) to set `aspect-[w/h]` so layout doesn't jump before the image
loads; always set explicit width+height on the container (see the base skill's asset-sizing rule).

**Interaction states** — look up the component in `design/design-system/components.local.json`'s `components` catalog and
check its variant `options` for hover/focus/disabled/error/selected states before shipping. Always add a
visible `focus-visible:` style even if the Figma design only shows a hover state — it's the most commonly
missed a11y requirement. `hover:` only matters on pointer devices (`@media (hover:hover)` — Tailwind v4's
default); also `active:`, `disabled:`/`aria-disabled:`.

**Accessibility & RTL** — WCAG contrast 4.5:1 text, 3:1 large text (≥24px or ≥18.66px bold) and UI parts;
target size ≥24×24 CSS px (2.5.8 AA), 44 recommended; 2.4.7 Focus Visible is AA (2.4.13 appearance is AAA).
`padding` is PHYSICAL `[t,r,b,l]` → emit logical `ps-`/`pe-`/`ms-`/`me-` so RTL mirrors.

**Accessibility naming — semantic element FIRST, ARIA only to patch**
- Pick the element from what the node *does*, not how it looks: `<button>` for anything clickable that
  isn't navigation, `<a href>` for navigation, `<nav>`/`<header>`/`<main>`/`<footer>` for the shell,
  `<ul><li>` for repeated rows, `<label for>` + real `<input>` for fields. A `div` with `onClick` needs
  `role`, `tabIndex={0}` and key handlers — just use the right element instead.
- Headings track document order: one `<h1>` per screen, then `h2`/`h3` with no skipped level. Figma's
  font size is not the heading level — the visual scale is a Tailwind class, the level is semantics.
- `aria-label` is for **icon-only** controls (`<button aria-label="Close">`); a control with visible text
  must not be relabelled. Prefer visually-hidden text (`sr-only`) over `aria-label` where possible.
- Images: meaningful → real `alt`; decorative/duplicated by adjacent text → `alt=""` (an inline
  decorative `<svg>` gets `aria-hidden="true"` + `focusable="false"`). Never omit `alt`.
- State goes through ARIA, not classes: `aria-expanded`, `aria-current="page"`, `aria-selected`,
  `aria-disabled`; icons that convey state need an accessible name too.
- Touch target ≥24×24 CSS px (WCAG 2.5.8 AA), 44×44 recommended — grow it with padding or a
  pseudo-element overlay, not by scaling the icon.

**Motion** — `transition.duration` is SECONDS → `duration-[ms]`; `easing.cubicBezier{x1,y1,x2,y2}` →
`ease-[cubic-bezier(x1,y1,x2,y2)]`; `spring` → `linear()` approximation or a JS spring. Wrap in
`motion-safe:` / honor `prefers-reduced-motion`.

**Vector fallback** — a `geometry` field (`fills`/`strokes`: arrays of SVG path `d` strings, plus `w`/`h`)
appears on a vector node whose SVG export failed. Render it inline as
`<svg viewBox="0 0 w h"><path d="..." /></svg>` rather than an `<img>` — there is no asset file for it.

**Tokens** — the right-hand value in `tokens.json` is a Tailwind class (e.g. `bg-primary`, `text-body`,
`rounded-md`). Emit it in `className`. If no class exists, use arbitrary value `bg-[var(--color-primary)]`.

**Components** — import per `codeconnect.local.json`; pass Figma `props` through to component props (see
**Component reuse** above before generating any markup for an instance's sublayer).

**Assets** — use the exported files in `design/assets/`: `<img src>` (or `next/image`) for PNG, and for a
vector either `<img src="….svg">` or an `<Icon/>` wrapper around that file / an SVGR import of it. **Never
hand-write `<svg><path d="…">` markup** — the only exception is the `geometry` vector fallback above, where
no asset file exists. Size every asset explicitly (see **Images**).

**Fit the existing app (detect before you emit)** — read `package.json` and a neighbouring page first.
- *Strings.* `next-intl`, `react-intl`, `react-i18next`, `lingui` present → the project's `t()`/`<FormattedMessage>`
  with a new key; `aria-label`, `alt`, placeholders and errors too. None → literals are fine; say so.
- *Routing & data.* Next App Router vs Pages vs React Router vs TanStack Router decide the file location,
  `<Link>` import and whether the component may be a Server Component (`"use client"` only where it
  has state/handlers). Data states come from the fetching layer in use.
- *Components & theme.* An installed UI kit (shadcn/ui, Radix, MUI, Headless UI) and the existing
  Tailwind theme win over new markup and new arbitrary values.

**Output** — React function components (`.tsx`), one screen per file under `outputDir`, colocate helpers.
