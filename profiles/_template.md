# Profile: <name>  (copy this file to profiles/<name>.md and set `profile` in design/target.json)

Describe how to translate the neutral export IR into this stack. Keep it short and concrete.

**Layout (IR → ?)** — map each field:
- `display:flex` / `flexDirection` (row|column) → your container + direction construct.
- `gap:N`, `flexWrap` → your spacing/wrap mechanism.
- `padding:[top,right,bottom,left]` → your padding syntax.
- `justifyContent`, `alignItems` → your main/cross-axis alignment.
- `widthMode`/`heightMode` (`fill`|`hug`|`fixed`) → stretch / content-sized / fixed.
- `layout.mode:"absolute"` → infer a flow layout; do NOT hardcode coordinates.
- `layout.display:"grid"` + `columns`/`rows`/`columnSizes`/`rowSizes`/`columnGap`/`rowGap`/`autoFlow`/
  `autoTracks`, and per-child `gridColumnSpan`/`gridRowSpan`/`gridColumnStart`/`gridRowStart`/
  `gridJustifySelf`/`gridAlignSelf` → your stack's native grid construct (see the other profiles for
  worked examples per stack).
- `clip`/`layout.scroll` → overflow/scroll container; `fixedChildren` (if present) → sticky/fixed leading
  children inside a scroll container.

**Behavior & theming** — `reactions`/`flows` (prototype interactions) → navigation/state, not markup;
`resolvedModes`/`variableModes` → light/dark theming. `layoutGrids`/`measurements`/`devStatus`/
`devResources` are hints for you, never rendered output. `exposedInstances`/`propRefs`/`overrides`/
`detachedFrom` → reuse the mapped component via `components.json` instead of regenerating markup.
Effects (`noise`/`glass`/`texture`/`shader`/backdrop blur) → nearest native filter, or the exported
`asset` when there's no equivalent. `truncate`/`maxLines`/`autoResize` → ellipsis/line-clamp (Figma line
breaks are not authoritative — different text engine than browsers). `intrinsicSize` → aspect ratio for
images. `blendMode`/`rotation`/`flipped` → the stack's blend-mode/transform equivalents.

**Units** — the unit and whether values carry a suffix.

**Tokens** — what form the right-hand value in `tokens.json` takes for this stack (CSS var, class,
Swift/Kotlin constant, theme reference) and how to emit it.

**Components** — how to import and instantiate from `components.json`, and how Figma `props` map.

**Text** — element/widget + how `font.size/weight/lineHeight` map to the type scale.

**Assets** — how to consume `design/assets/*` (SVG/PNG), including any conversion the user must do.

**Output** — file type, one-screen-per-what, where under `outputDir`, any preview/boilerplate.
