# Profile: web-tailwind (React + Tailwind CSS)

## Contents
Layout · Grid · Scroll/clip/sticky · Tables · Theming (+ dark mode) · Detect the Tailwind major · Effects ·
Text metrics · Strokes · Fills · Text overflow · Interaction states · Tokens · Components · Output

**Read `web-common.md` beside this file too** — sizing per axis, strokes, mixed text runs, effects, fills, native
controls, idiomatic web, interaction states, accessibility, motion and assets are the same for both web profiles
and are written there in plain CSS. This file gives the Tailwind form and what is specific to Tailwind.

**Layout (IR → Tailwind classes)** — each child's size is *Sizing (per axis)* in `web-common.md`: fixed →
`w-[Npx]`/`h-[Npx]`, plus `flex-none` on the main axis, hug → `flex-none` with no size, fill/`grow` →
`flex-[1_1_0]` + `min-w-0`/`min-h-0`, cross-axis stretch → `self-stretch`.
- `display:flex` → `flex`; `flexDirection:"column"` → `flex-col` (row is default).
- `gap:N` is the main-axis gap → `gap-x-N` on a row, `gap-y-N` on a column (not `gap-N`, which also
  sets the cross axis); N is the scale step that equals it exactly, else `gap-x-[Npx]` — never round to a step. `flexWrap:"wrap"` →
  `flex-wrap`, and its track gap: `rowGap` (a wrapping row) → `gap-y-N`, `columnGap` (a wrapping column) →
  `gap-x-N`, N likewise the exact scale step or `gap-y-[Npx]`/`gap-x-[Npx]`. An absent track gap is 0 —
  emit none, or `gap-y-0`/`gap-x-0` if a `gap-N` is in play. A wrap's tracks → `content-*`: its
  `alignContent`, else from `alignItems` (`content-start`/`content-center`/`content-end`; `content-stretch`
  when every in-flow child is `alignSelf:"stretch"`; `baseline` → `content-start`, with `items-baseline`
  aligning the items within each track) — Tailwind has no default class here, so don't leave CSS's initial
  `align-content: normal`, which behaves as `stretch` on a multi-line flex container.
- `padding:[t,r,b,l]` → logical `ps-`/`pe-` with `pt-`/`pb-`; collapse to `px-`/`py-`/`p-` when symmetric.
- `justifyContent` → `justify-start|center|end|between|evenly|around`; `alignItems` →
  `items-start|center|end` (absent → `items-start`), and `"baseline"` → `items-baseline` (`align-items: baseline`).

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
- `scroll` (`horizontal`/`vertical`/`both`) → `overflow-x-auto`/`overflow-y-auto`/`overflow-auto`
  (use `-scroll` instead of `-auto` only if the design clearly wants a persistent scrollbar).
- `fixedChildren` **if present** on a scroll container (the LAST N entries of `children[]` are pinned
  while the rest scrolls; place each by its `y`) → apply `sticky top-0 z-10` (a top bar — put it first in
  the DOM) or `sticky bottom-0 z-10` (a bottom bar) to those N children; everything else scrolls
  normally. Absent → treat all children as normal flow.

**Tables** — a `table-fixed` table needs a `min-w-*` on its flexible column (or the table) inside an
`overflow-x-auto` wrapper, else the name column collapses to 0 px below the design width.
- Derive column x/widths from the BODY cells; header cells often carry different padding in the design. If header
  and body x disagree, that is a designer question.
- Negative margins go on the scroll wrapper, not the table (on the table they leave a few px of scroll overflow).
- Give the wrapper `relative` when the table holds `sr-only` (absolutely positioned) content, or it escapes the wrapper and widens the page.
- A visually-hidden `<caption>` can disturb `border-separate` spacing in some engines: check, or use `aria-labelledby`.
- Text-derived widths differ by fractions of a px between engines: compare with a tolerance.

**Theming (`resolvedModes`/`variableModes`)**
- `resolvedModes` (root only) tells you which mode (e.g. Light/Dark) this export is effectively rendered
  in — use it to pick the right token file/CSS class when a subtree has no `variableModes` of its own.
- `variableModes` on a subtree pins it to a specific mode regardless of the page default — wrap that
  subtree in the project's theme scope instead of hardcoding its resolved colors.
- Mode selectors: a mode name that only one collection declares (besides its default) is `data-theme="<mode>"`; when several collections
  share a mode name (two "Dark"s) the generated file scopes each as `data-theme-<collection>="<mode>"` and
  `tokens.js` warns which attributes to set — set the ones the screen's `resolvedModes`/`variableModes` name.
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
- v4 scans every non-gitignored file, markdown included, so class names quoted in `design/` (audits, plans,
  notes) get compiled into the app's CSS. Put `@source not "<path from the CSS entry to design/>";` (v4.1+)
  beside `@import "tailwindcss"`; a compiled class is not evidence that an element uses it.
- Write `tokens.json`'s right-hand side to match whichever the project uses; don't create a
  `tailwind.config.js` in a v4 project just to hold tokens.
- **An `@theme` variable REPLACES Tailwind's own of the same name.** `--radius-xl: 16px` makes every
  `rounded-xl` in the project 16px instead of 12px; `--radius-l`/`--radius-s` mint `rounded-l`/
  `rounded-s`, which Tailwind already defines as the left/start-corner shorthands. So the generated
  `theme.css` (`bun --no-install --no-env-file "<scripts>/tokens.js" … --web tailwind`) puts every design token under a `figma-` sub-namespace:
  Figma's `Border Radius/XL` is `--radius-figma-xl` → `rounded-figma-xl`, `Spacing/Space 4` is
  `--spacing-figma-space-4` → `p-figma-space-4`/`gap-figma-space-4`, a colour `Primary/Primary` is
  `--color-figma-primary-primary` → `bg-figma-primary-primary`, a font size is `text-figma-…`.
  Use those for design values and leave the bare utilities (`rounded-xl`, `p-4`) with their framework
  meaning. When you add a design token by hand, follow the same rule.
- A generated name ending in `-<8 hex>` (`--spacing-figma-space-4-1a2b3c4d`) means two Figma variables
  share that name with different values; the suffix is the variable's key. Use the one whose key the
  screen's own `.vars.json` carries — never the other because it looks shorter. A shell shared by several
  screens needs every screen's tokens: feed the design system's `tokens.json` when it exists, else the merged
  `design/export/variables.json`, and for each suffixed name pick the key each screen's `.vars.json` carries
  (record it in the plan's token row).
- `theme.css` holds only CSS-usable tokens: font families are `--font-figma-*` (`font-figma-*`); STRING tokens
  that are not font families (a style name like "Semi Bold") are left out with a warning — use the weight value.
- Figma's "fully rounded" corner (a literal 1e9) is emitted as `9999px`; `rounded-full` is equivalent.
- With `--web tailwind`, `tokens.js` writes **only `theme.css`** to the given directory — the generic
  handoff set (`tokens.dtcg.json`, `tokens.css`, `tokens.resolver.json`, `tokens/`) is not written there;
  pass `--also-generic` if you need it, and put it under `design/`, not the app's source tree.

**Effects** (the rules: `web-common.md`) — `background_blur` → `backdrop-blur-[radius/2 px]` + a translucent
background; `layer_blur` → `blur-[radius/2 px]`. `drop_shadow` → `shadow-[x_y_radius_spread_color]`; `inner_shadow` →
`shadow-[inset_x_y_radius_spread_color]`; several → comma-join in one arbitrary value; on a TEXT node →
`[text-shadow:x_y_radius_color]`. `blendMode` → `mix-blend-{mode}`; paint `blend` → `bg-blend-{mode}`. `rotation` →
`rotate-[${-rotation}deg]` (negate); `flipped` → `-scale-x-100`; `skew` → `skew-x-[${deg}deg]`.

**Text metrics** — sizes in rem (`text-[px/16 rem]`) so user zoom works; fluid type → `clamp()` with rem bounds.
- `font.lineHeight`: `percent` → unitless `leading-[pct/100]`; `px` → `leading-[Npx]`/rem; `auto` → `leading-normal`.
- `font.letterSpacing`: `percent` → `tracking-[pct/100 em]`; `px` → `tracking-[Npx]`; absent = 0.
- `font.leadingTrim:"cap_height"` → `[text-box:trim-both_cap_alphabetic]` (Baseline 2026: Chrome 133,
  Safari 18.2, Firefox 154). `font.weight` is the verbatim style string — use `weightValue` for `font-[N]`.

**Strokes** (the rule: `web-common.md`, keyed on `align` and `strokesInLayout`) — inside with `strokesInLayout` →
`border-[w]` (Tailwind's preflight is already `box-border`) with the stroke's token as `border-figma-…`; inside
without → `shadow-[inset_0_0_0_w_var(--color-figma-…)]`; outside → `shadow-[0_0_0_w_…]` or `outline outline-[w]`;
center → `outline outline-[w] -outline-offset-[w/2]`. Per-side `weights` → `border-t-[N]` etc.; `dash` →
`border-dashed` (approximate) or an SVG.

**Fills** — `bg-[linear-gradient(...)]` with the angle from `transform` and `stops[].pos` as %; image `scaleMode`
`fill` → `object-cover`, `fit` → `object-contain`, `tile` → `bg-repeat` + `bg-size-[…]`; node `opacity` →
`opacity-*`; display-p3 → `[color:color(display-p3_r_g_b)]` with a hex fallback; `intrinsicSize` → `aspect-[w/h]`.

**Text overflow** — `truncate:true` → `truncate` (single line), or with `maxLines:N` → `line-clamp-{N}`;
`font.textWrap` → `text-balance`/`text-pretty`.

**Interaction states** (the rules: `web-common.md`)
- v4's `outline-hidden` sets `outline-style: none`, so `focus-visible:outline-2` on top draws nothing: add
  `focus-visible:outline-solid`. `hover:` is gated on `@media (hover:hover)` by default in v4; also `active:`,
  `disabled:`/`aria-disabled:`.
- v4 buttons default to `cursor: default` (why every button showed an arrow on the field run). Once, in the CSS
  entry, unless the app already sets it: `@layer base { button:not(:disabled), [role="button"]:not(:disabled) { cursor: pointer; } }`.
- Pressed feedback on every pointer type: a design with no Pressed variant still gets a default `active:` treatment
  (the app's own, else a small darken/overlay), recorded as a defaulted state and listed as a designer question.
- A control wired to nothing (no reaction, no handler) must not look live: no hover/pointer affordance; mark it
  `disabled`/`aria-disabled` or ask.
- Hover-revealed controls: `opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100`
  (touch has no hover; `pointer-coarse:` is v4.1+, on v4.0/v3 use `[@media(pointer:coarse)]:opacity-100`); never `invisible`/`hidden`, which drop the control from the tab order (and a `visibility: hidden` opener cannot take focus back when its dialog closes).
- Logical spacing for RTL: `ps-`/`pe-`/`ms-`/`me-`; visually-hidden text is `sr-only`.

**Tokens** — the right-hand value in `tokens.json` is a Tailwind class. With the generated theme that
is the `figma-` utility (`bg-figma-primary-primary`, `text-figma-body`, `rounded-figma-md`); in a
project with its own theme, its own names win (`bg-primary`). Emit it in `className`. If no class
exists, use an arbitrary value over the variable, e.g. `bg-[var(--color-figma-primary-primary)]`.

**Components** — import per `design/codeconnect.local.json`; pass Figma `props` through to component props (see
*Component reuse* in `web-common.md` before generating any markup for an instance's sublayer). A component that takes a
`className` next to its own variant classes merges them with `tailwind-merge` (`cn = (...c) => twMerge(clsx(c))`):
in Tailwind the stylesheet order decides a conflict, not the order in `class`. Use the project's existing `cn` if it
has one; ask before adding `tailwind-merge`/`clsx`. tailwind-merge v3 is for Tailwind v4; on Tailwind v3 use v2.6,
which has no `text` theme key: register the sizes there as `classGroups: { 'font-size': [...] }` (spacing and radii
under its `spacing` / `borderRadius` theme keys). With tailwind-merge v3, register every generated `figma-`
namespace — the font sizes (every `--text-figma-*` in theme.css), the spacing and the radii — with `extendTailwindMerge({ extend: { theme: { text: ['figma-body-1', …], spacing: ['figma-space-4', …], radius: ['figma-md', …] } } })`
— each theme key's names without its prefix (`--text-`, `--spacing-`, `--radius-`), as in tailwind-merge's own
`text: ['huge']`. Unregistered, twMerge reads `text-figma-<size>` as a colour, so a colour plus a size drops one of
the two, and a size against another size (`text-sm`) is not merged; `p-figma-space-4` against `p-figma-space-6`, or
`rounded-figma-md` against `rounded-figma-lg`, keeps both, so the stylesheet order decides and the caller's override
can lose. Or don't accept conflicting utilities: expose a prop.

**Output** — React function components (`.tsx`), one screen per file under `outputDir`, colocate helpers; an asset
may also be `next/image` in a Next project.
