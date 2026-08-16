# Profile: web-css-modules (React + CSS Modules)

**Layout (IR → CSS in `<screen>.module.css`)**
- `display:flex` → `display:flex`; `flexDirection` → `flex-direction`.
- `gap:N` → `gap:Npx`; `flexWrap:"wrap"` → `flex-wrap:wrap`.
- `padding:[t,r,b,l]` → `padding: t r b l` (px).
- `justifyContent` → `justify-content`; `alignItems` → `align-items`.
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

**Hints, not output** — `layoutGrids`, `measurements`, `devStatus`/`devStatusNote`, `devResources` inform
your column structure and let you sanity-check spacing; never render them as visible UI.

**Component reuse** — before generating markup for an instance's sublayer, check `exposedInstances`,
`propRefs`, `overrides` on the node: a prop-driven or overridden sublayer maps to a **prop/variant** on
the already-mapped component (from `components.json`), not new markup. `detachedFrom` (`{key}` or
`{componentId}`) means the node used to be an instance of a component that may still exist in
`components.json` — look it up and reuse it unless the detach looks deliberate (genuinely bespoke).

**Effects → CSS**
- `background_blur` effect → `backdrop-filter: blur(Npx)` (+ `-webkit-backdrop-filter` for Safari) with a
  translucent background so the blur is visible; `layer_blur` → `filter: blur(Npx)` (foreground).
- `noise`/`glass`/`texture`/`shader` effect types have no direct CSS equivalent. For a subtle `noise`,
  approximate with a repeating SVG-noise `background-image`; otherwise **use the exported `asset`** (the
  flattened render) instead of trying to reproduce the effect in CSS — don't invent a shader.
- `blendMode` → `mix-blend-mode`; `rotation` (radians) → `transform: rotate(rad)`; `flipped` →
  `transform: scaleX(-1)` (check axis against the `.png`); `skew` (DEGREES, unlike `rotation`) →
  `transform: skewX(Ndeg)`.

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

**Interaction states** — look up the component in `design/design-system/components.local.json`'s `components` catalog and
check its variant `options` for hover/focus/disabled/error/selected states before shipping. Always add a
visible `:focus-visible` rule even if the Figma design only shows a `:hover` state — it's the most
commonly missed a11y requirement.

**Vector fallback** — a `geometry` field (`fills`/`strokes`: arrays of SVG path `d` strings, plus `w`/`h`)
appears on a vector node whose SVG export failed. Render it inline as
`<svg viewBox="0 0 w h"><path d="..." /></svg>` rather than an `<img>` — there is no asset file for it.

**Tokens** — the right-hand value in `tokens.json` is a CSS custom property (e.g. `var(--color-primary)`).
Use it inside the module CSS (`color: var(--color-text)`), not inline literals.

**Components** — import per `components.json`; `className={styles.x}`; pass Figma `props` through.

**Text** — semantic element + a CSS class using type-scale custom properties.

**Assets** — `<img src>` for PNG; inline `<svg>` or an icon component for vectors.

**Output** — React function component `.tsx` + colocated `.module.css`, one screen per folder under `outputDir`.
