# Profile: <name>  (copy this file to a root-level `profiles/<name>.md` in your project — it overrides this skill's bundled profiles — and set `profile` in design/target.json)

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
`detachedFrom` → reuse the mapped component via `design/codeconnect.local.json` instead of regenerating markup.
Effects (`noise`/`glass`/`texture`/`shader`/backdrop blur) → nearest native filter, or the exported
`asset` when there's no equivalent. `truncate`/`maxLines`/`autoResize` → ellipsis/line-clamp (Figma line
breaks are not authoritative — different text engine than browsers). `intrinsicSize` → aspect ratio for
images. `blendMode`/`rotation`/`flipped` → the stack's blend-mode/transform equivalents.

**Units** — the unit and whether values carry a suffix.

**Tokens** — what form the right-hand value in `tokens.json` takes for this stack (CSS var, class,
Swift/Kotlin constant, theme reference) and how to emit it.

**Components** — how to import and instantiate from `design/codeconnect.local.json`, and how Figma `props` map.

**Text** — element/widget + how `font.size/weight/lineHeight` map to the type scale.

**Assets** — how to consume `design/export/assets/*` (SVG/PNG), including any conversion the user must do.
Also say what a path-heavy vector costs on this stack (`references/export-layout.md`, heavy vector
assets): Figma exports a noise texture as thousands of separate paths, and every vector pipeline pays
for that differently — say whether yours degrades in fidelity, in frame time, or at build time, so
the builder knows what to watch for and asks for a raster re-export instead of coping in code.

**Accessibility naming + touch targets** (REQUIRED — 5–10 lines) — how to give assistive tech a name and a
role on this platform: which construct labels a control, what to do for an **icon-only** control, how to
mark something **decorative** (hidden, not an empty label), how to merge a card/row into one spoken node,
how headings/roles/state are expressed, and the platform's **minimum touch target** (web 24×24 CSS px per
WCAG 2.5.8 AA / 44 recommended; iOS 44pt; Android 48dp; Flutter 48). The base skill demands semantics — this
section is where a profile says *how*, so it is not optional.

**Native controls list** (REQUIRED) — a one-line-per-control mapping from the common Figma widgets to this
stack's built-ins (switch/toggle, checkbox, radio, slider, segmented control, menu/picker, spinner,
progress, text field, tabs, dialog/sheet). Rebuilding a platform control out of boxes is a defect.

**Idiomatic patterns by structure** (REQUIRED) — how to recognize a screen shell / top bar / bottom nav /
list row / card **from the node's STRUCTURE**, not its name, and which native container each becomes.
State the "don't double-inset" rule for this stack (what the platform already pads) and which list
construct replaces a hand-rolled loop. A node name is a hint, never the decision.

**Text metrics** (optional) — `font.lineHeight` (`{unit:"auto"}` | `{value, unit:"px"|"percent"}`, percent
of font size), `font.letterSpacing` (px|percent, absent when 0), `leadingTrim`, font scaling / zoom rules.

**Effects** (optional) — `drop_shadow`/`inner_shadow` `{color, offset, radius, spread}`, `layer_blur`/
`background_blur` `{radius, blurType}`; note how Figma radius maps to the stack's blur/shadow radius.
`rotation` is DEGREES, Figma positive = counter-clockwise (clockwise-positive stacks: negate).

**Strokes** (optional) — `strokes.{weight|weights{top,right,bottom,left}, align inside|outside|center, dash}`.

**Safe area & insets** (optional) — system bars, notches, keyboard; never render a fake status bar frame.

**Accessibility & RTL** (optional) — min touch target, contrast, focus; `padding` is PHYSICAL → start/end.

**Motion** (optional) — `transition.duration` (SECONDS), `easing.cubicBezier{x1,y1,x2,y2}`, `spring`.

**Fit the existing app** (REQUIRED — 8–15 lines) — what to DETECT in the project before emitting, and
what to do for each answer: user-facing strings (the l10n mechanism and key style — including
accessibility labels; literals only when the app has none), navigation (which router; the screen
exposes callbacks and never owns the stack/shell it is pushed into), state & DI (match the
neighbours), theme (one source of truth — the project's existing theme beats a generated token file),
dependencies (use what is installed; ask before adding), and version checks for any API you mark with
one. A profile without this produces screens that match the design and fail code review.

**Output** — file type, one-screen-per-what, where under `outputDir`, any preview/boilerplate.
