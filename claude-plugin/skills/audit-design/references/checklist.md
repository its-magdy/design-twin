# Engineer checklist — what to verify before implementing a design

Walk every section for the screen(s) in scope. Each item: **check** → where the export answers it →
what to do when it doesn't. "Ask" means: add a question with a default (see `questions.md`).
Field names are exact; units and shapes are in `field-map.md`.

## Contents
1. [Handoff metadata](#1-handoff-metadata)
2. [Tokens and design-system binding](#2-tokens-and-design-system-binding)
3. [Typography](#3-typography)
4. [Layout, spacing and alignment](#4-layout-spacing-and-alignment)
5. [Sizing and responsiveness](#5-sizing-and-responsiveness)
6. [Components, variants and props](#6-components-variants-and-props)
7. [Interaction states](#7-interaction-states)
8. [Screen data states](#8-screen-data-states)
9. [Content edge cases](#9-content-edge-cases)
10. [Forms and input](#10-forms-and-input)
11. [Navigation, interactions and motion](#11-navigation-interactions-and-motion)
12. [Assets: icons and images](#12-assets-icons-and-images)
13. [Effects, strokes and fills that may not translate](#13-effects-strokes-and-fills-that-may-not-translate)
14. [Accessibility](#14-accessibility)
15. [Theming and color](#15-theming-and-color)
16. [Localization and RTL](#16-localization-and-rtl)
17. [Platform chrome, safe areas and system behavior](#17-platform-chrome-safe-areas-and-system-behavior)

---

## 1. Handoff metadata
- **Is this the final frame?** Root `devStatus` (`ready_for_dev`/`completed`), `devStatusNote`. Absent
  → ask which frames are final if the page holds several similar ones (iterations, "old", "v2").
- **Designer notes.** Every `annotations[]` (`label`/`markdown`) and `devResources` (Jira/Storybook
  links) is a requirement — list them in the report and check the design honors them.
- **Export completeness.** `manifest.truncated`/`assetsFailed`/`warnings`; nodes with `geometry`
  (asset export failed) or `assetSkipped`.

## 2. Tokens and design-system binding
- **Colors bound?** `fills[].tokens`, `strokes` tokens, `styles.fill`, text `textTokens.fills` /
  `runs[].tokens`. Report the binding % from the audit; list unbound literals that are near an
  existing token (likely drift) vs genuinely new values (ask: new token or one-off?).
- **Semantic vs primitive.** Bindings should hit semantic tokens (`tier:"semantic"` in
  `design-system/tokens.json`); a node bound straight to a primitive (`blue/600`) won't theme.
- **Spacing and radius bound?** `tokens.itemSpacing`/`padding*`/`*Radius`. Unbound values off the
  base grid → likely drift.
- **Near-duplicate colors / one-off values** → probably one token; propose which.
- **Code names.** `variables[].codeSyntax` `{WEB,ANDROID,iOS}` gives the designer's intended code
  name — prefer it; note when absent for tokens this screen uses.
- **Design-system smells** in `design-system/hygiene.json` (ALL_SCOPES, raw semantic values, broken
  aliases, variant explosion) that affect this screen.

## 3. Typography
- **Styles, not ad-hoc.** `styles.text` / `runs[].textStyle` per text node. Unstyled text with a size
  that matches a style → drift; unmatched → ask.
- **Family/weight availability.** `font.family`, `font.weight` (verbatim, e.g. "Semibold Italic"),
  `missingFont` (blocker). Confirm the font files exist in the codebase and are licensed for the
  platform (web font vs bundled mobile font).
- **Metrics with units.** `font.lineHeight` (`auto` | px | percent-of-size) and `font.letterSpacing`
  (px | percent) — note each one the platform must convert (see the profile's Text metrics).
- **Font scaling.** Which text must scale with the OS setting (almost all), and which may be capped
  (badges, tab labels)? Fixed-size text boxes (`autoResize` absent) and fixed-height containers will
  clip at 200% (Android) / AX5 (~310% iOS body) → ask wrap vs truncate vs grow.
- **Overflow rule for every variable-length text.** `truncate`, `maxLines`, `autoResize`. Absent on a
  name/title/label fed by data → ask.
- **Mixed styling.** `runs[]` (bold word, inline link `href`/`linkNode`, list `list`/`indent`) —
  becomes attributed/spanned text, and links need their destination.
- **Details.** `font.case` (transform vs literal uppercase — matters for screen readers and
  localization), `decoration*`, `openType` (tabular numbers for prices/timers), `paragraphSpacing`,
  `leadingTrim` (cap-height trim changes vertical spacing), `textWrap` balance/pretty, `align`
  (should be start/end for RTL, not left/right).

## 4. Layout, spacing and alignment
- **Auto layout everywhere it matters.** `layout.display` flex/grid vs `layout.mode:"absolute"`.
  A container of several children with no auto layout → you must infer the flow; ask how it should
  resize if not obvious. `layout.inferred` → Figma guessed flex; sanity-check against the screenshot.
- **Spacing values.** `gap`, `padding [t,r,b,l]`, `rowGap`/`columnGap`, `justifyContent`
  (`space-between` = "auto" gap), `alignItems` incl. `baseline`. Negative gaps = overlap.
- **Out-of-flow children.** `absolute:true` inside auto layout (badges, FABs, overlays) — what are
  they pinned to, and do they move with RTL?
- **Grid.** `layout.display:"grid"` tracks and spans vs `layoutGrids` (column guides) — the latter
  hints at breakpoints/margins, not a CSS grid.
- **Scroll + sticky.** `clip`, `layout.scroll` (direction), `fixedChildren` (pinned header/footer).
  Which region scrolls? Does the header collapse? Pull-to-refresh? Ask if a long list has no scroll
  container marked.
- **Z-order.** `layout.reverseZ`, overlapping absolute children.

## 5. Sizing and responsiveness
- **Hug / fill / fixed.** `widthMode`/`heightMode` (`fill`|`hug`, absent = fixed). A fixed width on a
  full-bleed container → confirm it should stretch.
- **Limits.** `sizeLimits` min/max width/height; `aspectRatio`; `grow`; `alignSelf:"stretch"`.
- **Constraints** on non-auto-layout children: `pin {h,v}` (stretch/center/scale).
- **Other sizes.** Frame `box.w` tells you the one width designed (e.g. 393 iPhone, 360/412 Android,
  1440 desktop). Ask for — or state assumptions about — small phones (320–360), large phones,
  tablets/foldables (Android window size classes: compact <600dp, medium 600–839, expanded ≥840),
  landscape, and web breakpoints (what changes: columns, nav pattern, hidden elements, max content
  width, fluid vs stepped).

## 6. Components, variants and props
- **Reuse.** Every `INSTANCE` → `mainComponent` `{key,setKey,setName}` → `codeconnect.local.json`
  mapping? Unmapped components that clearly match an existing code component → note the mapping gap.
- **Native controls.** Switches, pickers, sheets, nav bars, tab bars, text fields drawn as custom
  components: should the build use the platform control (recommended) or match the drawing exactly?
  Ask when the drawing deviates from the platform look.
- **Props.** `props` on instances (variant values, booleans, text, instance swaps) → the code API.
  Many `overrides` on one instance or a `detachedFrom` → a missing variant or a one-off fork; ask.
- **Variant explosion** (>30 combos in hygiene) → the code API should be props, not one component per
  combo.

## 7. Interaction states
For every interactive element (anything with `reactions`, a control-like component, or a tappable
name), check the component's variant options in `components.local.json` — states live in the option
*values*, often under a property literally named "Property 1".
- **Buttons / tappable rows / cards:** default, pressed, disabled, focus (keyboard & TV/switch
  access), hover (web/iPad pointer/desktop only), loading (async actions), selected (toggles).
- **Inputs:** default, focused, filled, error (+ message placement), disabled, read-only, with
  helper text, with character counter.
- **Toggles/checkbox/radio:** on, off, indeterminate, disabled, focus.
- **Tabs/nav items/chips:** selected, unselected, pressed, disabled, badge.
- **Missing state →** ask; default: derive from the design system's existing state tokens (e.g.
  pressed = 8–12% overlay, disabled = 38% opacity on Material) and say it's derived.
- Focus is the most-missed state and an accessibility requirement — it must exist in code even when
  undrawn.

## 8. Screen data states
Search the whole export (other layers on the page, `hidden:true` nodes, names like
Loading/Skeleton/Empty/Error/Offline) before calling a state missing. For each screen:
- **Loading:** skeleton vs spinner vs progressive; delay before showing (avoid flicker <~300ms);
  what's interactive while loading; pull-to-refresh / load-more indicators.
- **Empty:** first use (explain + CTA) vs no results (echo the query, offer to clear filters) vs
  cleared/done (positive) vs no permission (why + request access). These are different designs.
- **Error:** inline field errors (validation timing: on blur/on submit), section error with retry,
  full-screen error (404/500/permission), offline/stale data banner, toast/snackbar duration and
  action, optimistic-update rollback.
- **Partial:** some fields missing, some images failed, one section errored while others loaded.
- **Success/confirmation** after an action, and undo.

## 9. Content edge cases
Ask for rules (or state defaults) for data-driven content:
- Very long / very short / missing text (names, titles, addresses, unbroken URLs/emails).
- Numbers: 0, 1, many (plurals), very large (1.2M abbreviation?), negative, currency/locale format,
  dates/times/relative time, time zones.
- Images: missing (placeholder/initials avatar), slow (blur-up/skeleton), failed, wrong aspect
  ratio (crop focal point — `scaleMode`), user-uploaded extremes.
- Lists: 0 / 1 / exactly-a-page / hundreds of items; end of list; list item with all optional parts
  missing.
- Badges/counters over 99; permissions/roles that hide actions.

## 10. Forms and input
- Keyboard type per field (email, number, phone, URL), autofill/content type, return-key action,
  secure entry, autocapitalize/autocorrect.
- Validation rules and timing, error message copy and placement, required markers.
- What happens when the keyboard opens: which content must stay visible (the submit button?), does
  the layout scroll, is there a sticky action bar.
- Submit states: disabled until valid? loading while submitting? double-submit prevention?

## 11. Navigation, interactions and motion
- `reactions[]`: trigger (`on_click`, `on_hover`, `on_press`, `on_drag`, `after_timeout`,
  `mouse_enter`/`mouse_leave`, `on_key_down`) → action (`navigation` `navigate`/`overlay`/`swap`/
  `scroll_to`, or `type` `back`/`close`/`url`/`set_variable`/`conditional`) → destination. Dead ends: tappable-looking elements with no reaction
  → ask where they go.
- `overlay` frames: presentation (sheet, dialog, popover, full-screen), scrim, dismiss (tap outside,
  swipe, Esc, back button).
- Transitions: `transition.type`, `duration` (seconds), `easing`/`cubicBezier`/`spring`. Smart-animate
  implies shared-element/matched-geometry work — confirm it's worth it.
- Gestures Figma can't express: swipe actions, long press, drag-to-reorder, pull-to-refresh, pinch;
  haptics; predictive back (Android 14+) / edge-swipe back (iOS) must keep working.
- Reduced motion: what replaces non-essential animation.
- `flows[]` (prototype starting points) → candidate routes; deep links?

## 12. Assets: icons and images
- Every icon is an exported `asset` (SVG) — never redrawn. `geometry` → export failed; ask for a
  re-export or use the paths.
- Icon sizing: glyph size vs container/tap area; exported with or without padding frame.
- Platform format: SVG (web), VectorDrawable (Android — no filters/masks/text), PDF/SVG or SF Symbol
  (iOS), `flutter_svg`; raster densities @2x/@3x / mdpi–xxxhdpi / srcset. `exportSettings` shows the
  designer's intended formats/scales.
- Does a matching icon already exist in the codebase (by glyph, not by name)? Does the platform have
  a system equivalent (SF Symbols, Material Symbols) the team prefers?
- Images: static assets vs content from the API/CMS (then `intrinsicSize` is only a sample), dark-mode
  variants, logos with safe areas.

## 13. Effects, strokes and fills that may not translate
- Shadows: `effects[]` offset/radius/**spread**/color; multiple stacked shadows; `behindNode`.
- Blur: `layer_blur` vs `background_blur`; `blurType:"progressive"`.
- `noise`/`glass`/`texture`/`shader` effects; `blendMode`; `mask`/`maskType`.
- Strokes: `align` inside/center/outside (affects layout), per-side `weights` (dividers), `dash`.
- Gradients: `kind` (diamond has no native equivalent), `transform` (angle is not the default).
- Image fills: `scaleMode` crop/tile, `filters`.
- `cornerSmoothing` (squircle), `rotation` (degrees), `skew`, `flipped`.
- `renderBox` larger than `box` inside a `clip:true` parent → shadow gets clipped in code too.
For each: the profile's approximation, and whether the designer accepts it.

## 14. Accessibility
- **Contrast:** text 4.5:1 (normal) / 3:1 (≥24px or ≥18.66px bold); UI component boundaries and
  meaningful icons 3:1 — in every state and theme. Text on images/gradients needs a manual check.
- **Touch targets:** 44×44pt iOS, 48×48dp Android, 24×24 CSS px minimum web (WCAG 2.5.8 AA; 44
  recommended). Visual can be smaller if the hit area is padded.
- **Semantics:** what each element is (button vs link, heading levels, list, image vs decorative),
  accessible names for icon-only buttons, grouping (a card read as one element), live announcements
  for toasts/errors/loading. Only `annotations` can carry this — usually absent → ask or state
  defaults.
- **Focus:** visible indicator (WCAG 2.4.7 AA), order, where focus goes when a sheet opens/closes or an
  item is deleted, focus trapping in modals.
- **Not color alone:** errors/status also use icon or text.
- **Scaling and reflow:** layout at 200% text (web: 400% zoom / 320px reflow), larger accessibility
  sizes on iOS, Android font scale 200%.
- **Motion and transparency:** reduced motion, reduced transparency (blurs/glass), Dark Mode + Increase
  Contrast.

## 15. Theming and color
- `variableModes` (subtree pinned) and root `resolvedModes` (effective mode): which theme is this frame?
- Does every color token the screen uses have a value in every mode (`tokens.json` `variables[].values`)?
  Are both themes drawn for this screen? If only one → ask whether the other is token-derived.
- Illustrations, images, shadows and elevation in dark mode (dark elevation usually = lighter
  surface, not shadow). Status bar content color per theme.
- Brand vs platform dynamic color (Android Material You) — opt out?
- `design-system.json` `colorProfile: display-p3` → hex values are clamped to 8-bit sRGB; use P3 color
  APIs where exactness matters.

## 16. Localization and RTL
- Text expansion (German/Finnish +30–40%, some UI labels much more): which elements have room, which
  truncate? Buttons with fixed widths are the usual breakage.
- CJK line breaking, Thai/Arabic line height (taller scripts clipping in fixed-height boxes).
- RTL: layout mirrors (`padding` is physical `[t,r,b,l]` — implement as start/end), directional icons
  mirror (back arrows, chevrons, progress), non-directional don't (clocks, media play, logos, checkmarks);
  absolute offsets and asymmetric shadows/gradients don't mirror automatically.
- Formats: numbers, dates, currency, plurals, names order.
- Hard-coded copy vs localized strings; text baked into images.

## 17. Platform chrome, safe areas and system behavior
- **Drawn system chrome** (status bar, home indicator, keyboard, nav bar, notch) → never build it;
  use insets. Frame height includes it — don't hard-code 44/47/54/59pt or 24dp.
- **Safe areas and edge-to-edge:** what extends under the status/navigation bar (backgrounds, hero
  images) vs what must stay inside (content, buttons). Android targetSdk 35+ is edge-to-edge by force.
- **Keyboard (IME) insets**, split-screen/multi-window, Stage Manager/iPad arbitrary sizes, foldable
  hinge.
- **Platform conventions:** back navigation, tab bar vs navigation bar placement, sheet detents, pull
  gestures, system dialogs — does the design fight them? Ask when it does.
- **Web:** hover-capable vs touch, viewport meta, scrollbars, sticky headers vs mobile browser chrome,
  print, prefers-color-scheme / prefers-reduced-motion.
