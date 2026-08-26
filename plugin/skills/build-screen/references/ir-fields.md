# IR field reference — what a node's `tree` can carry

Every field here is **optional**. Read this when a node has a key you don't recognise, or before
building anything interactive/scrolling/themed/animated. For *which file to open*, see
`export-layout.md`.

## Contents
- [Navigation, state and prototypes](#navigation-state-and-prototypes)
- [Layout: grid, scroll, sticky](#layout-grid-scroll-sticky)
- [Theme modes](#theme-modes)
- [Text](#text)
- [Components, props and overrides](#components-props-and-overrides)
- [Interaction states (always check this)](#interaction-states-always-check-this)
- [Paint, effects and transforms](#paint-effects-and-transforms)
- [Images and vectors](#images-and-vectors)
- [Sizing and boxes](#sizing-and-boxes)
- [Agent-only hints — never render these](#agent-only-hints--never-render-these)

## Navigation, state and prototypes

- **`reactions`** — prototype interactions: trigger + navigation + transition/easing, including
  `set_variable` / `set_variable_mode` / `conditional` actions. Wire real navigation + state, not a
  dead button.
- **`flows`** (top-level in the full export, not per-node): `{page, pageId, nodeId, name}` per
  prototype entry point → candidate top-level routes/screens.
- Mapping: a `reactions` entry with `navigation` → route change (SPA nav / deep link); `overlay` →
  modal/sheet component; `set_variable`/`set_variable_mode` → local state / theme toggle.
- Ignore purely presentational triggers you can't action (e.g. `mediaHitTime` scrub points) rather
  than guessing.
- **`overlay`** — the frame is a modal/popover: honour position / scrim / close-on-click-outside.

## Layout: grid, scroll, sticky

- **`layout.display:"grid"`** → `columns`/`rows`/`columnGap`/`rowGap`/`columnSizes`/`rowSizes`
  (per-track `{type,value}`, `type` one of `flex`/`fixed`/`hug`)/`autoFlow`/`autoTracks` on the
  container, and per-child `gridColumnSpan`/`gridRowSpan`/`gridColumnStart`/`gridRowStart`/
  `gridJustifySelf`/`gridAlignSelf` (`start`/`center`/`end`). Use the profile's Grid section — don't
  flatten a real grid into nested flex rows.
- **`clip:true`** (Figma `clipsContent`) + **`layout.scroll`** (Figma `overflowDirection`:
  `horizontal`/`vertical`/`both`) → overflow handling.
- **`fixedChildren`** *if present* — a count of leading children pinned while the rest scrolls (sticky
  headers/footers/FABs) → `position:sticky`/`fixed` on those children, not plain flow.
- **`layout.inferred`** — flex inferred from a non-auto-layout frame. Trust it, but sanity-check
  against the `.png`.
- **`sizeLimits`/`pin`** → responsive constraints. **`strokesInLayout`** → border-box.

## Theme modes

- **`variableModes`** — this subtree is pinned to a theme mode (e.g. Dark) → emit under that theme.
- **`resolvedModes`** (root only) — the **effective** theme inherited from the page/ancestor. Use it
  when a single-node export has no `variableModes` of its own, or you'll build the Light variant of a
  Dark design.

## Text

- **`runs`** — mixed-format text: render each run; may carry `textStyle`/`fillStyle`/`openType`/`indent`.
- **`truncate:true`** (Figma `ENDING`) → `text-overflow:ellipsis` + `white-space:nowrap`/
  `overflow:hidden`, or `-webkit-line-clamp` when paired with `maxLines`.
- **`maxLines:N`** → line-clamp to N lines.
- **`autoResize`** (`width_and_height`/`height`/`truncate`/`none`) → whether the box hugs/wraps or clips.
- **`missingFont`** — Figma is substituting a fallback, so the recorded `font.family` may not match the
  render. Pin a webfont or flag it.
- **Figma's own line breaks are not authoritative.** Figma uses a different text engine than browsers —
  don't copy manual `\n` placement as gospel. Let the real text wrap; honour an explicit break only if
  it looks intentional (e.g. a short heading) against the `.png`.

## Components, props and overrides

- **`propRefs`** (prop-driven layers), **`overrides`** (instance-level overrides),
  **`exposedInstances`**. Before writing new markup for an instance's sublayer, check whether it's
  prop-driven or instance-overridden and map that back onto the **existing** mapped component's
  props/variants rather than hand-building the divergence.
- **`detachedFrom`** (`{key}` or `{componentId}`) — the node used to be an instance. Look that
  component up in `components.json` and reuse it unless the detach was clearly intentional.
- **`tableCells`** — a table's cell grid.

## Interaction states (always check this)

Before shipping any interactive element (button, input, link, row), check that component's variant
`options` in `design/design-system/components.local.json` (or `components.library.json`). Hover /
focus / disabled / error / selected states are usually modeled as **variant values, not separate
nodes**.

**Focus states are the most commonly missed** and are an accessibility regression — keyboard-only
users lose their place. Always implement a visible `:focus-visible` style even when the design only
shows hover.

## Paint, effects and transforms

- **`effects[].type`** including `noise`/`glass`/`texture`/`shader`, plus `background_blur` (backdrop)
  vs `layer_blur` (foreground) → CSS `backdrop-filter: blur()` for `background_blur`,
  `filter: blur()` for `layer_blur`.
  `noise`/`glass`/`texture`/`shader` have no direct CSS equivalent — approximate simple cases (a subtle
  `noise` as a repeating SVG/PNG grain overlay) but **rasterize via the exported asset** when the
  effect is load-bearing to the look. Don't invent a shader.
- **`blendMode`** (lowercased CSS blend mode name) → `mix-blend-mode`.
- **`rotation`** (radians) → `transform: rotate()`.
- **`flipped`** (mirrored via a negative-determinant transform) → `transform: scaleX(-1)` (or Y — check
  which axis against the `.png`).
- **`skew`** → `transform: skewX()`, in **DEGREES** (unlike `rotation`).
- **`aspectRatio`** / **`cornerSmoothing`** / **`maskType`**.

## Images and vectors

- **`intrinsicSize`** on image fills (`{w,h}`) → the image's natural aspect ratio. Use it for
  `aspect-ratio`/placeholder sizing so layout doesn't jump before the asset loads.
- **`geometry`** on a vector-shaped node (`fills`/`strokes`: arrays of SVG path `d` strings, plus
  `w`/`h`) means that node's SVG export **failed and there is NO asset file for it**. Render the paths
  as an inline SVG (`<svg viewBox="0 0 w h"><path d="..."/></svg>`) rather than recreating the shape
  in CSS. This is the one case where you write SVG by hand.

## Sizing and boxes

- **`box`/`renderBox`** (`absoluteBoundingBox`) — resolved page-space pixel size. This is the
  ground-truth dimension for auto-layout/grid children that have no `x`/`y`.

## Agent-only hints — never render these

`layoutGrids`, `measurements`, `devStatus`/`devStatusNote`, `devResources` and `css` are
implementation hints for **you**, not UI:

- **`layoutGrids`** informs the responsive column structure you choose.
- **`measurements`** (Dev-Mode redlines: `start`/`end`/`offset`/`text`) cross-checks spacing values you
  already have from `layout`/`box`.
- **`css`** — Figma's own computed CSS for the node when present. A strong hint, but reconcile against
  tokens rather than pasting verbatim.
- **`devResources`** — the designer's linked Jira/Storybook/GitHub URLs; handoff context.
