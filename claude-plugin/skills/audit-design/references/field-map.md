# Field map — implementation concern → export field

Where each answer lives in a node `tree` (paths are per node unless noted) and the exact shape/units.
Every field is optional; absent usually means "Figma default". For which FILE to open, see
`../build-screen/references/export-layout.md`; for how a stack renders it, the build-screen profile.

## Contents
- [Identity, handoff, visibility](#identity-handoff-visibility)
- [Tokens and styles](#tokens-and-styles)
- [Typography](#typography)
- [Layout and sizing](#layout-and-sizing)
- [Paint: fills, strokes, effects](#paint-fills-strokes-effects)
- [Shape and transform](#shape-and-transform)
- [Components](#components)
- [Prototype and motion](#prototype-and-motion)
- [Assets](#assets)
- [Catalog files](#catalog-files)
- [Not in the export at all](#not-in-the-export-at-all)

## Identity, handoff, visibility
| Concern | Field | Shape / notes |
|---|---|---|
| Node identity | `id`, `name`, `type` | `id` is what the designer clicks; cite it |
| Hidden layer (undrawn-by-default state) | `hidden` | kept in the tree, not dropped |
| Final? | `devStatus`, `devStatusNote` | `ready_for_dev` \| `completed` |
| Designer notes | `annotations[]` | `{label, markdown, categoryId, props[]}` (props = annotated property NAMES) |
| Linked tickets/docs | root `devResources[]` | `{name, url, nodeId}` |
| Redlines | screen doc `measurements[]` (opt-in `--measurements`) | `{start{nodeId,side}, end, offset, text}` |
| Figma's CSS | `css` (opt-in `--css`) | Figma's computed CSS — a cross-check, not output |
| Export health | doc `manifest` | `nodes, skipped, truncated, assetsFailed, warnings[]` |

## Tokens and styles
| Concern | Field | Shape / notes |
|---|---|---|
| Node property → variable | `tokens` | `{ figmaProperty: "token/name" }` e.g. `itemSpacing`, `paddingLeft`, `topLeftRadius`, `strokeWeight`, `opacity`, `fills` (array of names), `width` |
| Paint → variable | `fills[].tokens`, `strokes.paints[].tokens`, `effects[].tokens`, `fills[].stops[].tokens` | e.g. `{color:"color/primary"}` |
| Text → variable | `textTokens` (uniform text), `runs[].tokens` (mixed) | `fontSize`, `fontFamily`, `lineHeight`, `fills`… |
| Style references | `styles` | `{fill, stroke, effect, text, grid}` → style NAME |
| Theme pinned here | `variableModes` | `{collectionName: modeName}` |
| Effective theme | root `resolvedModes` | skips single-mode collections |
| Token catalog | `design-system/tokens.json` | `collections[] {name, modes, default, theming}`, `variables[] {name, type, collection, tier, values{mode: hex \| number \| {aliasOf}}, scopes, codeSyntax{WEB,ANDROID,iOS}, key}` |

## Typography
| Concern | Field | Shape / units |
|---|---|---|
| Characters | `text` | Figma's manual line breaks are NOT authoritative |
| Size | `font.size` | px, or `"mixed"` (then read `runs`) |
| Family / weight | `font.family`, `font.weight`, `font.weightValue` | weight is the style string verbatim ("Semibold Italic"); numeric only at node level |
| Line height | `font.lineHeight` | `{unit:"auto"}` \| `{value, unit:"px"}` \| `{value, unit:"percent"}` (% of font size) |
| Letter spacing | `font.letterSpacing` | `{value, unit:"px" \| "percent"}` (% of font size); absent = 0 |
| Color | `font.color` | hex (8-digit when alpha < 1) |
| Case / decoration | `font.case`, `font.decoration`, `decorationStyle/Color/Thickness/Offset`, `decorationSkipInk` | lowercased enums |
| OpenType | `font.openType[]` | enabled feature tags (`TNUM`, `SMCP`, `LIGA`…) |
| Paragraph | `font.paragraphSpacing`, `paragraphIndent`, `listSpacing` | px |
| Alignment | `font.align`, `font.valign` | `left/center/right/justified`; valign only when not top |
| Trim / wrap | `font.leadingTrim` (`cap_height`), `font.textWrap` (`balance`/`pretty`) | |
| Box behavior | `autoResize` | `width_and_height` (hug) \| `height` (wraps, grows down) \| `truncate`; ABSENT = fixed size |
| Overflow | `truncate: true`, `maxLines` | ellipsis at end; line clamp |
| Mixed formatting | `runs[]` | `{text, font, textStyle, fillStyle, tokens, href, linkNode, list, indent}` |
| Font problem | `missingFont` | Figma is rendering a fallback |

## Layout and sizing
| Concern | Field | Shape / notes |
|---|---|---|
| Flex container | `layout` | `{display:"flex", flexDirection, gap, padding:[t,r,b,l], justifyContent, alignItems, flexWrap, rowGap, alignContent, reverseZ}`; `justifyContent/alignItems` only when not start |
| Guessed flex | `layout.inferred: true` | from a frame without auto layout |
| No auto layout | `layout.mode:"absolute"` + `width`,`height` | children carry `x`,`y` |
| Grid container | `layout` `{display:"grid", columns, rows, columnGap, rowGap, columnSizes[{type:flex\|fixed\|hug, value}], rowSizes, autoFlow, autoTracks}` | |
| Grid child | `gridColumnSpan`, `gridRowSpan`, `gridColumnStart`/`gridRowStart` (0-based), `gridJustifySelf`, `gridAlignSelf` | |
| Child sizing | `widthMode`, `heightMode` | `fill` \| `hug`; absent = fixed |
| Child role | `absolute`, `grow`, `alignSelf:"stretch"` | out of flow; flex-grow; cross-axis stretch |
| Size | `box {w,h[,x,y]}`, `renderBox` | page-space px; x/y only when parent doesn't lay the node out; renderBox includes shadow/stroke overflow |
| Limits | `sizeLimits {minWidth,maxWidth,minHeight,maxHeight}`, `aspectRatio` | |
| Constraints | `pin {h, v}` | `min`/`max`/`center`/`stretch`/`scale` (non-auto-layout children) |
| Column guides | `layoutGrids[]` | `{pattern, size, gutter, count, offset, alignment, visible}` |
| Scroll / clip / sticky | `layout.scroll`, `clip`, `fixedChildren` | `horizontal`/`vertical`/`both`; count of pinned leading children |
| Border-box | `strokesInLayout` | stroke counts toward size |
| Overlay | `overlay` | `{position, closeOnClickOutside, background}` |

## Paint: fills, strokes, effects
| Concern | Field | Shape / notes |
|---|---|---|
| Solid fill | `fills[] {type:"solid", color, blend, tokens}` | paint opacity folded into hex alpha; array order = bottom → top |
| Gradient | `{type:"gradient", kind, stops[{pos, color, tokens}], transform:[[a,c,e],[b,d,f]], opacity, blend}` | `kind` = GRADIENT_LINEAR/RADIAL/ANGULAR/DIAMOND; angle comes from `transform` |
| Image | `{type:"image", scaleMode, hash, scale, rotation, transform, filters, intrinsicSize{w,h}, opacity}` | `fill`/`fit`/`crop`/`tile`; `transform` = crop rect; `scale` = tile factor |
| Node opacity | `opacity` | only when < 1; applies to the whole subtree |
| Blend | `blendMode` (node), `fills[].blend` (paint) | lowercased; normal/pass-through omitted |
| Strokes | `strokes {colors[], paints[], weight \| weights{top,right,bottom,left}, align, dash[], cap, join, miter, variableWidth}` | `align` = `inside`/`outside`/`center` |
| Shadow | `effects[] {type:"drop_shadow"\|"inner_shadow", color, offset{x,y}, radius, spread, blendMode, behindNode, tokens}` | Figma radius = CSS blur radius |
| Blur | `effects[] {type:"layer_blur"\|"background_blur", radius, blurType:"progressive", startOffset, endOffset, startRadius}` | |
| Exotic | `effects[].type` = `noise`/`glass`/`texture`/`shader` | no code equivalent |
| Mask | `mask`, `maskType` | `vector`/`luminance` (alpha default) |

## Shape and transform
| Concern | Field | Shape / notes |
|---|---|---|
| Corners | `radius` | number, or `{tl,tr,br,bl}` |
| Squircle | `cornerSmoothing` | 0..1 (iOS continuous ≈ 0.6) |
| Rotation | `rotation` | DEGREES −180..180, positive = counter-clockwise |
| Mirror / shear | `flipped`, `skew` (degrees) | |
| Parametric | `arc {start,end,innerRadius}` (radians), `shape {points, innerRadius}`, `booleanOp` | |

## Components
| Concern | Field | Shape / notes |
|---|---|---|
| Is an instance of | `component` (name), `mainComponent {id, key, remote, setId, setKey, setName, variant}` | join catalog on `key`/`setKey`, never name |
| Instance props | `props {propName: value}`, `propTokens` | variant values, booleans, text, swaps |
| Prop-driven sublayer | `propRefs {visible, characters, mainComponent}` | |
| Overrides | `overrides [{id, fields[]}]` | field NAMES only — read values from the node |
| Nested exposed | `exposedInstances[]` | ids |
| Detached | `detachedFrom {key}` \| `{componentId}` | |
| Table | `tableCells [[{row, col, text, font, fills}]]` | |

## Prototype and motion
| Concern | Field | Shape / notes |
|---|---|---|
| Interactions | `reactions[] {trigger, timeout, delay, keyCodes, device, actions[]}` | trigger (Figma type, lowercased): `on_click`, `on_hover`, `on_press`, `on_drag`, `after_timeout`, `mouse_enter`, `mouse_leave`, `mouse_up`, `mouse_down`, `on_key_down`, `on_media_hit`, `on_media_end` |
| Action | `actions[] {type, navigation, destinationId, destination, url, overlayOffset, transition, preserveScroll, resetScroll}` | `type` `node`/`back`/`close`/`url`/`set_variable`/`set_variable_mode`/`conditional`/`update_media_runtime`; `navigation` `navigate`/`overlay`/`swap`/`scroll_to`/`change_to`; `set_variable` → `variable`, `value`; `set_variable_mode` → `collection`, `mode`; `conditional` → `conditionalBlocks[{condition, actions}]` |
| Transition | `transition {type, direction, duration, matchLayers, easing, cubicBezier{x1,y1,x2,y2}, spring}` | `duration` in SECONDS; `easing` `ease_in`/`ease_out`/`ease_in_and_out`/`linear`/`*_back`/`gentle`/`quick`/`bouncy`/`slow`/`custom_cubic_bezier`/`custom_spring`; `spring` passed through verbatim from Figma (`mass`, `stiffness`, `damping`, `initialVelocity`) |
| Entry points | top-level `flows[] {page, pageId, nodeId, name}` | |
| Keyframes | `motion {timelines, manualTracks, animations, styles}` (opt-in `--motion`) | |

## Assets
| Concern | Field | Shape / notes |
|---|---|---|
| Exported file | `asset` | path under `design/`; node is a leaf |
| Export failed | `geometry {fills[], strokes[], w, h}` | SVG path data; no file |
| Skipped | `assetSkipped` | `--no-assets` run |
| Designer's export presets | `exportSettings [{format, suffix, constraint{type, value}}]` | |
| Reference render | root `reference` / `design/<screen>.png` | visual ground truth |

## Catalog files
| Concern | File → field |
|---|---|
| Variant states | `design-system/components.local.json` `components[].props[*] {key, type:"VARIANT", options[], default}` — states are option VALUES (property often "Property 1") |
| Per-variant trees | entry `variantsFile` / `nodeFile` (opt-in `--variant-visuals`) |
| Library components | `components.library.json` — props SAMPLED from instances in this file |
| Text/paint/effect/grid styles | `design-system/styles.{text,paint,effect,grid}.json` |
| Smells | `design-system/hygiene.json` `hygiene[]` — ALL_SCOPES, raw semantic values, broken aliases, variant explosion (>30), unnamed/duplicate components. It does NOT check per-node unbound values — `audit.js` does. |
| Color profile | `design-system.json` `colorProfile` (`srgb`/`display-p3`/`legacy`) — hex is always 8-bit sRGB-clamped |

## Not in the export at all
Designer intent that no field carries — must come from annotations, other frames, or questions:
loading/empty/error/offline screens (unless drawn as layers), accessibility labels/roles/focus order,
font-scaling and localization behavior, breakpoints and other device sizes, keyboard behavior, gestures
and haptics, validation rules, data formats, analytics, platform-control preferences, and exact P3
color values.
