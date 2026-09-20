# Automated checks — what `audit.js` computes, how to read it, how to do it by hand

`node "${CLAUDE_PLUGIN_ROOT}/scripts/audit.js" <screen.json>... --platform <p> [--catalog components.local.json] [--grid 4] [--out design/audit/<screen>] [--json] [--gate]`

Output: `summary {blockers, warnings, info}`, `tokenBinding {color, typography, spacing, radius, effects}`
(`bound/total/pct`), `components[]` (state coverage), `screenStates {loading, empty, error}`,
`annotations[]`, `questions[]`, `findings[] {severity, code, message, nodeId, nodeName, screen, path}`.
It exits 0 on findings — they're advice — unless `--gate` is passed (exit 1 on any blocker; `build-screen` uses this).

## Contents
- [Finding codes](#finding-codes)
- [Known false positives](#known-false-positives)
- [Doing it by hand](#doing-it-by-hand)

## Finding codes

| Code | Severity | Rule | Verify by |
|---|---|---|---|
| `export-truncated` | blocker | `manifest.truncated > 0` | re-export a narrower scope |
| `assets-failed` | blocker | `manifest.assetsFailed > 0` | find `geometry` nodes |
| `missing-font` | blocker | `missingFont` on a text node | check the font is in the codebase |
| `not-ready-for-dev` | warning | root `devStatus` not ready/completed | ask if final |
| `fake-status-bar` / `fake-home-indicator` | warning | mobile only; within 2 levels of root, name/component matches status bar / 9:41 / battery (h ≤ 64) or home indicator (h ≤ 40) | screenshot |
| `small-touch-target` | warning | tappable node (`reactions` with click/press/tap/drag, control-like component instance, or control-like frame name) with `box` below web 24 / iOS 44 / Android 48 / RN 44 / Flutter 48; children of an already-checked tappable are skipped | a larger parent may be the real hit area |
| `fixed-size-text` | warning | TEXT with no `autoResize`, `truncate`, or `maxLines` | single-word labels in hugging parents are lower risk |
| `low-contrast` | warning (info if background assumed white) | WCAG ratio of text color composited over ancestor fills (+ earlier siblings in non-auto-layout parents) below 4.5 (3 for ≥24px or ≥18.66px bold) | overlapping siblings in auto layout aren't composited |
| `contrast-manual` | info | an image/gradient/video is in the background stack | eyedropper the screenshot |
| `missing-component-states` | warning (info for library components) | control kind from component name → required states vs variant option values + boolean prop names | the state may be a separate component or a boolean |
| `detached-instance` | warning | `detachedFrom` | |
| `low-token-binding` | warning | a category with ≥5 values under 50% bound | |
| `off-grid-spacing` | info | unbound gap/padding not a multiple of `--grid` or non-integer | 34pt bottom padding is often a safe-area value — fine |
| `near-duplicate-colors` | info | unbound opaque hexes with CIE76 ΔE < 3 | |
| `no-auto-layout` | info | non-root container with >1 child and `layout.mode:"absolute"` | groups are skipped |
| `negative-spacing` | info | gap/padding < 0 | intentional overlap (avatar stacks) |
| `stroke-align` | info | stroke with `align` outside/center — code borders draw inside, so rendered size and layout differ | profile's Strokes section |
| `shadow-spread` | info | iOS/Android: shadow with `spread` | |
| `background-blur` | info | Android/RN: `background_blur` | |
| `progressive-blur`, `exotic-effect`, `diamond-gradient`, `image-scale-mode`, `blend-mode`, `corner-smoothing` | info | property with no direct equivalent on the platform | the profile's approximation |

Component kinds and required states:

| Kind (name matches) | web | touch platforms |
|---|---|---|
| button (button, btn, cta, chip, icon button) | hover, pressed, focus, disabled | pressed, disabled |
| input (input, text field, search, select, dropdown, textarea) | focus, error, disabled | focus, error, disabled |
| toggle (checkbox, radio, switch, toggle) | selected, disabled | selected, disabled |
| tab (tab, segmented, nav item) | selected | selected |
| link | hover, focus | pressed |

State synonyms matched case-insensitively against whole option values: pressed = pressed/press/active/
tapped/down; focus = focus/focused/focus-visible; disabled = disabled/inactive; error = error/invalid/
danger/destructive; selected = selected/checked/on/active/current; loading = loading/busy/in progress;
hover = hover/hovered. Focus and loading are still worth asking about even when not "required".

## Known false positives
- **Screen states** are detected by layer NAMES (loading/skeleton/spinner, empty/no results, error/
  failed/offline/retry) across the exported layers only. States on another page or another file show
  as `not-found` — look there before asking.
- **Contrast** ignores node `opacity` on ancestors, text shadows, and overlapping siblings inside auto
  layout. White text in a component whose background is an instance-level override may be
  mis-composited — check the screenshot.
- **Touch targets** use the visual `box`; a 24px icon inside a padded 44pt row is fine if the row is the
  tap target. The audit only knows what's marked tappable.
- **Fixed-size text** also fires for decorative text that never changes. Downgrade it for static copy
  that fits comfortably.
- **Binding %** counts every visible paint, including one-off illustration colors — a low color % on an
  illustration-heavy screen may be fine.

## Doing it by hand
If the script genuinely errors out, do these on the screen JSON (grep is enough for most):
1. **Blockers:** read `manifest`; grep `"missingFont": true`, `"geometry"`.
2. **Chrome:** top-level children named Status Bar / 9:41 / Home Indicator.
3. **Touch targets:** nodes with `"reactions"` or control-like `component` names → compare `box.w/h` to
   the platform minimum.
4. **Fixed text:** TEXT nodes without `autoResize`/`truncate`/`maxLines` whose content is data-driven.
5. **Contrast:** for text over solid backgrounds, compute the WCAG ratio:
   `L = 0.2126 R + 0.7152 G + 0.0722 B` with each channel `c/255 → c ≤ 0.04045 ? c/12.92 : ((c+0.055)/1.055)^2.4`,
   ratio `(Lhi + 0.05) / (Llo + 0.05)`. Composite alpha first: `out = a·fg + (1−a)·bg`.
6. **States:** for each control component used, list its VARIANT `options` from
   `components.local.json` and compare with the table above.
7. **Binding:** count solid `fills` with vs without `tokens`/`styles.fill`; same for text styles.
Say in the report which of these you did by hand and which you skipped.
