# IR field reference — what a node's `tree` can carry

Every field here is **optional**; absent usually means the Figma default. Read this before mapping a
screen, when a node has a key you don't recognise, or before building anything interactive, scrolling,
themed or animated. The audit-design skill reads it too — it is the one field reference, so a field is
described (and corrected) in exactly one place. For *which file to open*, see `export-layout.md`. For
how a value becomes code on your stack, see the profile.

## Contents
- [Handoff: annotations, status, visibility](#handoff-annotations-status-visibility)
- [Tokens, styles and theme modes](#tokens-styles-and-theme-modes)
- [Text](#text)
- [Layout: flex, grid, scroll, sticky](#layout-flex-grid-scroll-sticky)
- [Sizing, boxes and constraints](#sizing-boxes-and-constraints)
- [Fills and strokes](#fills-and-strokes)
- [Effects, blend, masks and transforms](#effects-blend-masks-and-transforms)
- [Components, props and overrides](#components-props-and-overrides)
- [Interaction states (always check this)](#interaction-states-always-check-this)
- [Navigation, prototypes and motion](#navigation-prototypes-and-motion)
- [Images and vectors](#images-and-vectors)
- [Agent-only hints — never render these](#agent-only-hints--never-render-these)
- [Catalog files: states, styles, smells](#catalog-files-states-styles-smells)
- [Not in the export at all](#not-in-the-export-at-all)

## Handoff: annotations, status, visibility

- **`annotations[]`** (`label`/`markdown`/`categoryId`/`props`) — the designer's written requirements
  on that node. Treat them as constraints (hint priority 2), not decoration.
- **`devStatus`** (`ready_for_dev`/`completed`) + **`devStatusNote`** — whether the node is final.
- **`hidden:true`** — the layer exists but is off by default: usually a conditional state (error
  message, tooltip, empty state). Implement it as conditional UI, don't render it and don't drop it.
- Doc-level **`manifest`** (`truncated`/`assetsFailed`/`warnings`) — read before building.

## Tokens, styles and theme modes

- **`tokens`** — node property → variable name (`{itemSpacing:"space/md", paddingLeft:"space/lg",
  topLeftRadius:"radius/card", fills:["color/surface"]}`). Paint-level bindings live on the paint
  (`fills[].tokens.color`, `stops[].tokens`, `effects[].tokens`); text bindings on `textTokens` or
  `runs[].tokens`.
  **These names are the token's identity — the resolved value beside them is only what it happens to
  be in this export's mode.** Two nodes showing the same hex may be bound to two different variables
  that diverge in another theme, so map and name from this field, never from the colour you see. It
  is what the plan's `figmaName` records (build-screen step 2, *Names come from Figma*).
- **`styles`** — `{fill, stroke, effect, text, grid}` → the Figma style NAME (the pre-Variables token
  system). A text style name is the best key into the type scale.
- **`variableModes`** — this subtree is pinned to a theme mode (e.g. Dark) → emit under that theme.
- **`resolvedModes`** (root only) — the **effective** theme inherited from page/ancestors. Use it when
  a single-node export has no `variableModes` of its own, or you'll build Light for a Dark design.
- **Color profile**: `design-system.json` `colorProfile`. Hex values are always 8-bit sRGB-clamped; if
  the file is `display-p3`, use the stack's P3 color API where exactness matters.

## Text

- **`text`** — the characters. **Figma's line breaks are not authoritative** (different text engine):
  let text wrap; keep an explicit break only when it's clearly intentional against the `.png`.
- **`font.size`** px (or `"mixed"` → read `runs`). **`font.family`**, **`font.weight`** = the style
  string verbatim (`"Semibold Italic"` → weight 600 + italic), **`font.weightValue`** numeric when
  available.
- **`font.lineHeight`** — `{unit:"auto"}` (the font's natural leading) | `{value, unit:"px"}` |
  `{value, unit:"percent"}` (**percent of font size**: 150 → 1.5×). Figma distributes the extra leading
  half above, half below each line.
- **`font.letterSpacing`** — `{value, unit:"px"|"percent"}`; percent is of font size (−2 → −0.02em).
  Absent = 0.
- **`font.color`** — first solid fill, hex (8-digit when alpha < 1).
- **`font.case`** (`upper`/`lower`/`title`/`small_caps`…) → a text transform, not rewritten characters.
  **`font.decoration`** + `decorationStyle/Color/Thickness/Offset/SkipInk`. **`font.openType[]`** —
  enabled features (`TNUM` tabular numbers, `SMCP`, `LIGA`…).
- **`font.paragraphSpacing`**, `paragraphIndent`, `listSpacing` (px); **`font.align`** (map to
  start/end for RTL), **`font.valign`** (only when not top); **`font.leadingTrim:"cap_height"`** →
  trims space above caps / below baseline; **`font.textWrap`** (`balance`/`pretty`);
  `hangingList`/`hangingPunctuation`.
- **`runs[]`** — mixed-format text: render each run (`text`, `font`, `textStyle`, `fillStyle`, `tokens`,
  `href` external link / `linkNode` internal link, `list` ordered/unordered, `indent`).
- **`autoResize`** — `width_and_height` (hugs both axes) | `height` (fixed width, wraps and grows
  down) | `truncate`. **Absent = fixed-size box** — it will clip longer text; decide an overflow rule.
- **`truncate:true`** (ellipsis at end) and **`maxLines:N`** (clamp) — the design's overflow rule.
- **`missingFont`** — Figma is rendering a fallback; the recorded family may not match the `.png`.
  Confirm the real font or flag it.

## Layout: flex, grid, scroll, sticky

- **`layout`** flex: `display:"flex"`, `flexDirection` `row|column`, `gap`, `padding:[t,r,b,l]`
  (physical sides — map to start/end for RTL), `justifyContent` (`center`/`flex-end`/`space-between`;
  absent = start), `alignItems` (`center`/`flex-end`/`baseline`; absent = start), `flexWrap:"wrap"` +
  `rowGap` + `alignContent`, `reverseZ` (later children paint underneath). Negative `gap` = overlap.
- **`layout.inferred:true`** — flex guessed from a non-auto-layout frame. Trust it, but sanity-check
  against the `.png`.
- **`layout.mode:"absolute"`** (+`width`/`height`) — no auto layout; children carry `x`/`y`. Infer a
  flow layout; do not transcribe coordinates.
- **`layout.display:"grid"`** → `columns`/`rows`/`columnGap`/`rowGap`/`columnSizes`/`rowSizes`
  (per-track `{type: flex|fixed|hug, value}`)/`autoFlow`/`autoTracks`; children
  `gridColumnSpan`/`gridRowSpan`/`gridColumnStart`/`gridRowStart` (0-based) and
  `gridJustifySelf`/`gridAlignSelf` (`start`/`center`/`end`). Don't flatten a real grid into rows.
- **`clip:true`** + **`layout.scroll`** (`horizontal`/`vertical`/`both`) → overflow handling.
- **`fixedChildren:N`** — the first N children are pinned while the rest scrolls (sticky
  header/footer/FAB).
- **`layoutGrids[]`** — column/row guides (`pattern`, `count`, `size`, `gutter`, `offset`,
  `alignment`): informs margins and breakpoints; not a grid container.

## Sizing, boxes and constraints

- **`widthMode`/`heightMode`** — `fill` (stretch in the parent) | `hug` (content-sized); **absent =
  fixed**. Use fixed only when the design genuinely is.
- **`grow`** (flex-grow), **`alignSelf:"stretch"`** (cross-axis stretch), **`absolute:true`** (out of
  the parent's auto-layout flow — badges, overlays; positioned by `x`/`y`).
- **`sizeLimits`** `{minWidth,maxWidth,minHeight,maxHeight}` → min/max constraints. **`aspectRatio`** —
  locked ratio.
- **`pin`** `{h,v}` (`min`/`max`/`center`/`stretch`/`scale`) — how a non-auto-layout child resizes with
  its parent. **`strokesInLayout`** → stroke counts toward size (border-box).
- **`box`** `{w,h[,x,y]}` — resolved page-space size, and **the only place a node's size lives**:
  there are no top-level `width`/`height` fields, so read `box.w`/`box.h` (a root frame's `box` is the
  screen size). It is the ground-truth dimension for children with no `x`/`y`. Its `x`/`y` are
  **page-space** coordinates and are routinely large negatives (a real root: `box.x -5535`) — they
  locate the frame on the Figma canvas and mean nothing to your layout. A node's own top-level
  `x`/`y`, which appear only when the parent doesn't lay it out, are **parent-relative** and are the
  ones to build from; the two disagreeing is normal, not a bug. **`renderBox`** — includes
  shadow/stroke/blur overflow; if it's larger than `box` inside a `clip:true` parent, the effect is
  clipped in the design too.

## Fills and strokes

- **`fills[]`** — bottom → top paint stack.
  - `{type:"solid", color, blend, tokens}` — paint opacity is folded into the hex alpha.
  - `{type:"gradient", kind, stops[{pos, color, tokens}], transform, opacity, blend}` — `kind`
    `GRADIENT_LINEAR|RADIAL|ANGULAR|DIAMOND`. `transform` `[[a,c,e],[b,d,f]]` maps the gradient's unit
    square onto the node: **derive the angle/center from it** — never assume top-to-bottom. Diamond has
    no native equivalent (use the asset or approximate).
  - `{type:"image", scaleMode, hash, scale, rotation, transform, filters, intrinsicSize, opacity}` —
    `fill` = cover, `fit` = contain, `crop` = the `transform` crop rect, `tile` = repeat at `scale`;
    `filters` (`exposure`/`contrast`/`saturation`/`temperature`/`tint`/`highlights`/`shadows`, −1..1).
  - `video`, `pattern` (`sourceNodeId`, `tileType`, `spacing`), `shader` (use the asset).
- **Node `opacity`** (whole subtree, < 1 only) is different from paint alpha/`opacity` — don't merge them.
- **`strokes`** — `colors[]` (solid hex), `paints[]` (non-solid stroke paints, same shape as fills),
  `weight` or per-side `weights{top,right,bottom,left}` (a one-sided stroke = divider/underline),
  **`align`** `inside` | `outside` | `center` (inside ≈ a border within the box; outside/center extend
  past it and don't take layout space unless the stack draws them that way), `dash[]`, `cap`, `join`,
  `miter`, `variableWidth` (tapered — SVG only).

## Effects, blend, masks and transforms

- **`effects[]`**:
  - `drop_shadow` / `inner_shadow` — `color` (hex8), `offset{x,y}`, `radius` (= CSS blur radius),
    `spread`, `blendMode`, `behindNode`, `tokens`. Multiple shadows stack in order.
  - `layer_blur` (blurs the node) vs `background_blur` (blurs what's behind it — needs a translucent
    fill to be visible) — `radius`, `blurType:"progressive"` with `startOffset`/`endOffset`/
    `startRadius` (a ramped blur).
  - `noise` / `glass` / `texture` / `shader` — no code equivalent. Approximate a subtle `noise` as a
    grain overlay; otherwise **use the exported asset** when the effect is load-bearing. Don't invent a
    shader.
- **`blendMode`** (node) / paint `blend` → the stack's blend mode (lowercased CSS names).
- **`mask:true`** + **`maskType`** (`vector` clip | `luminance`; alpha default).
- **`rotation`** — **DEGREES**, −180..180, Figma positive = **counter-clockwise** (clockwise-positive
  stacks negate it).
- **`flipped`** — mirrored (check the axis against the `.png`). **`skew`** — degrees.
- **`radius`** — number, or per-corner `{tl,tr,br,bl}`. **`cornerSmoothing`** 0..1 — squircle (iOS
  continuous corners ≈ 0.6).
- **`arc`** `{start,end,innerRadius}` (radians; donut/pie), **`shape`** `{points, innerRadius}`
  (star/polygon), **`booleanOp`** (`union`/`subtract`/`intersect`/`exclude`).

## Components, props and overrides

- **`component`** (name) + **`mainComponent`** `{id, key, remote, setId, setKey, setName, variant}` —
  join to `design/codeconnect.local.json` and the catalogs by `key`/`setKey`, never by name.
- **`props`** `{name: value}` — the instance's variant values, booleans, text and swaps → the code
  component's props. **`propTokens`** — a prop value driven by a variable.
- **`propRefs`** (which prop drives this sublayer's `visible`/`characters`/`mainComponent`),
  **`overrides`** `[{id, fields[]}]` (field NAMES overridden on this instance — read the values from
  the node itself), **`exposedInstances`**. Before writing markup for an instance's sublayer, map it back
  onto the existing component's props/variants rather than hand-building the divergence.
- **`detachedFrom`** (`{key}` or `{componentId}`) — used to be an instance. Reuse that component unless
  the detach was clearly intentional.
- **`tableCells`** — a table's cell grid (`row`, `col`, text fields, `fills`).

## Interaction states (always check this)

Before shipping any interactive element (button, input, link, row, card), check that component's
variant `options` in `design/export/design-system/components.local.json` (or `components.library.json`, whose
props are only a sample). States are usually **variant option values, not separate nodes** — and
often under a property literally named "Property 1" (`["Default","hover","Pressed"]`). Boolean props
like `Disabled`/`Loading` also carry states.

**Focus is the most commonly missed** and an accessibility regression: always implement a visible
focus indicator, even when the design only shows hover. On touch platforms implement pressed feedback.
Undesigned states use the audit's default (derived from tokens) and are reported.

## Navigation, prototypes and motion

- **`reactions[]`** — `{trigger, timeout, delay, keyCodes, device, actions[]}`. `trigger`: `on_click`,
  `on_hover`, `on_press`, `on_drag`, `after_timeout` (+`timeout`), `mouse_enter`/`mouse_leave`/
  `mouse_up`/`mouse_down` (+`delay`), `on_key_down` (+`keyCodes`), `on_media_hit`/`on_media_end`.
- **`actions[]`** — `navigation`: `navigate` (route change) / `overlay` (modal/sheet/popover, with
  `overlayOffset`) / `swap` (replace overlay) / `scroll_to` / `change_to` (variant swap), with
  `destinationId`/`destination`. Or `type`: `back` / `close` / `url` (+`url`) / `set_variable`
  (`variable`, `value`) / `set_variable_mode` (`collection`, `mode` — a theme toggle) / `conditional`
  (`conditionalBlocks[{condition, actions}]`) / `update_media_runtime`. `preserveScroll`/`resetScroll`
  flags when set.
- **`transition`** — `type` (`dissolve`, `smart_animate`, `move_in`/`move_out`/`push`/`slide_in`/
  `slide_out` + `direction`), **`duration` in SECONDS**, `easing` (`ease_in`, `ease_out`,
  `ease_in_and_out`, `linear`, `ease_in_back`/`ease_out_back`/`ease_in_and_out_back`, `gentle`, `quick`,
  `bouncy`, `slow`, `custom_cubic_bezier`, `custom_spring`), `cubicBezier{x1,y1,x2,y2}`, `spring`
  (Figma's config verbatim: `mass`, `stiffness`, `damping`, `initialVelocity`), `matchLayers`.
  Smart-animate = shared-element / matched-geometry transition. Honor reduced motion.
- **`overlay`** on a frame — `{position, closeOnClickOutside, background}` (scrim color).
- **`flows[]`** (top level) — `{page, pageId, nodeId, name}` prototype entry points → candidate routes.
- Ignore triggers with no code meaning (`mediaHitTime` scrub points) rather than guessing.
- **`motion`** (opt-in `--motion`) — keyframe timelines/animations; map to the stack's keyframe API.

## Images and vectors

- **`asset`** — path of the exported SVG/PNG for this node; the node is a leaf. Import it; never redraw.
- **`intrinsicSize`** `{w,h}` on image fills → natural aspect ratio for placeholders so layout doesn't
  jump.
- **`geometry`** `{fills[], strokes[], w, h}` (SVG path `d` strings) — the SVG export **failed and there
  is NO asset file**. Render the paths in a `0 0 w h` space. This is the one case where you write paths.
- **`assetSkipped`** — `--no-assets` run; the graphic exists in Figma but wasn't exported.
- **`exportSettings[]`** `{format, suffix, constraint}` — the designer's own export presets (formats,
  @2x/@3x).

## Agent-only hints — never render these

`layoutGrids`, `measurements`, `devStatus`/`devStatusNote`, `devResources`, `annotations`, `css`,
`pluginData`, `sharedData` are information for **you**, not UI:

- **`layoutGrids`** → column structure and margins you choose.
- **`measurements`** (Dev Mode redlines `start`/`end`/`offset`/`text`) → cross-check spacing.
- **`css`** — Figma's computed CSS for the node. A strong hint and a verification oracle; reconcile
  against tokens rather than pasting verbatim.
- **`devResources`** (root, `{name, url, nodeId}`) — linked Jira/Storybook/GitHub URLs; handoff context.
- **`sharedData.tokens`** — Tokens Studio applied tokens (property → token name) on files that don't
  use native variables.

## Catalog files: states, styles, smells

| Concern | File → field |
|---|---|
| Variant states | `design-system/components.local.json` `components[].props[*] {key, type:"VARIANT", options[], default}` — states are option VALUES (property often "Property 1") |
| Per-variant trees | entry `variantsFile` / `nodeFile` (opt-in `--variant-visuals`) |
| Library components | `components.library.json` — props SAMPLED from instances in this file |
| Token catalog | `design-system/tokens.json` — `collections[] {name, modes, default, theming}`, `variables[] {name, type, collection, tier, values{mode: hex \| number \| {aliasOf}}, scopes, codeSyntax{WEB,ANDROID,iOS}, key}` |
| Text/paint/effect/grid styles | `design-system/styles.{text,paint,effect,grid}.json` |
| Smells | `design-system/hygiene.json` `hygiene[]` — ALL_SCOPES, raw semantic values, broken aliases, variant explosion (>30), unnamed/duplicate components. It does NOT check per-node unbound values — `audit.js` does. |
| Color profile | `design-system.json` `colorProfile` (`srgb`/`display-p3`/`legacy`) — hex is always 8-bit sRGB-clamped |

## Not in the export at all

Designer intent that no field carries — it must come from annotations, other frames, or a question to
the designer: loading/empty/error/offline screens (unless drawn as layers), accessibility
labels/roles/focus order, font-scaling and localization behavior, breakpoints and other device sizes,
keyboard behavior, gestures and haptics, validation rules, data formats, analytics, platform-control
preferences, and exact P3 color values.
