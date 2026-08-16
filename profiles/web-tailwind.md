# Profile: web-tailwind (React + Tailwind CSS)

**Layout (IR → Tailwind classes)**
- `display:flex` → `flex`; `flexDirection:"column"` → `flex-col` (row is default).
- `gap:N` → nearest scale (`gap-2` ≈ 8px) or `gap-[Npx]`; `flexWrap:"wrap"` → `flex-wrap`.
- `padding:[t,r,b,l]` → `pt-/pr-/pb-/pl-`; collapse to `px-`/`py-`/`p-` when symmetric.
- `justifyContent` → `justify-start|center|end|between`; `alignItems` → `items-start|center|end`.
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
  subtree in the corresponding theme scope (e.g. `className="dark"` with Tailwind's `dark:` variant, or
  the equivalent CSS-variable scope) instead of hardcoding its resolved colors.
- Prefer Tailwind's `dark:` variant / CSS custom properties over baking two versions of the component.

**Hints, not output** — `layoutGrids`, `measurements`, `devStatus`/`devStatusNote`, `devResources` inform
your column structure and let you sanity-check spacing; never render them as visible UI.

**Component reuse** — before generating markup for an instance's sublayer, check `exposedInstances`,
`propRefs`, `overrides` on the node: a prop-driven or overridden sublayer maps to a **prop/variant** on
the already-mapped component (from `components.json`), not new markup. `detachedFrom` (`{key}` or
`{componentId}`) means the node used to be an instance of a component that may still exist in
`components.json` — look it up and reuse it unless the detach looks deliberate (genuinely bespoke).

**Effects → CSS**
- `background_blur` effect → `backdrop-blur-*` (or `backdrop-blur-[Npx]`) + ensure the element has a
  translucent background so the blur is visible; `layer_blur` → `blur-*`/`blur-[Npx]` (foreground filter).
- `noise`/`glass`/`texture`/`shader` effect types have no Tailwind/CSS equivalent. For a subtle `noise`,
  approximate with a repeating SVG-noise background image; otherwise **use the exported `asset`** (the
  flattened render) instead of trying to reproduce the effect in CSS — don't invent a shader.
- `blendMode` → `mix-blend-{mode}`; `rotation` (radians) → `rotate-[${deg}deg]`; `flipped` → `-scale-x-100`
  (check axis against the `.png`); `skew` (DEGREES, unlike `rotation`) → `skew-x-[${deg}deg]`.

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
missed a11y requirement.

**Vector fallback** — a `geometry` field (`fills`/`strokes`: arrays of SVG path `d` strings, plus `w`/`h`)
appears on a vector node whose SVG export failed. Render it inline as
`<svg viewBox="0 0 w h"><path d="..." /></svg>` rather than an `<img>` — there is no asset file for it.

**Tokens** — the right-hand value in `tokens.json` is a Tailwind class (e.g. `bg-primary`, `text-body`,
`rounded-md`). Emit it in `className`. If no class exists, use arbitrary value `bg-[var(--color-primary)]`.

**Components** — import per `components.json`; pass Figma `props` through to component props.

**Text** — element + Tailwind type classes; map `font.size/weight` to your `text-*`/`font-*` scale.

**Assets** — `<img src>` for PNG; inline the SVG or an `<Icon/>` for vectors.

**Output** — React function components (`.tsx`), one screen per file under `outputDir`, colocate helpers.
