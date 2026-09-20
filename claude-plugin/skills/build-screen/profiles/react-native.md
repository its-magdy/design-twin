# Profile: react-native

## Contents
Layout · Grid · Scroll/clip/sticky · Prototype reactions · Theming · Effects · Text metrics ·
Safe area, a11y & RTL · Accessibility naming · Motion · Text overflow · Images · Interaction states ·
Idiomatic RN (patterns by structure) · Native controls · Hints, not output · Component reuse · Units ·
Tokens · Components · Text · Assets · Output

**Layout (IR → `View` + `StyleSheet`)** — flexbox is native; **default `flexDirection` is `column`**.
- `display:flex` → a `<View>`; `flexDirection:"row"` → `flexDirection:'row'` (omit for column).
- `gap:N` → `gap:N` (RN ≥ 0.71) else margins; `flexWrap:"wrap"` → `flexWrap:'wrap'`.
- `padding:[t,r,b,l]` → `paddingTop/Right/Bottom/Left`.
- `justifyContent`/`alignItems` → same prop names, string values (`alignItems:'baseline'` maps 1:1).
- `widthMode:"fill"` → `flex:1`; `"hug"` → omit; `"fixed"` → `width:N`.

**Grid (`layout.display:"grid"`)** — RN's flexbox has no native grid. Emulate with nested `<View>` rows:
use `columns`/`rows`/`columnSizes`/`rowSizes` to compute each row's children and per-item `flex`/fixed
`width` (from `columnSizes[i].type` `flex`→`flex:value`, `fixed`→`width:value`); `columnGap`/`rowGap` →
`gap`/row margins. `gridColumnSpan`/`gridRowSpan` → merge cells into a wider `View` spanning that many
column widths. For a genuinely dense/irregular grid, prefer a grid-capable list lib (e.g.
`FlashList`/`FlatList` with `numColumns`) over hand-rolled rows.

**Scroll, clip & sticky**
- `clip:true` → `overflow:'hidden'` in the style object.
- `layout.scroll` → wrap in `<ScrollView horizontal={scroll==='horizontal'}>` (or a virtualized
  `FlatList`/`SectionList` for long lists).
- `fixedChildren` **if present** (count of leading children pinned while the rest scrolls) → render those
  children OUTSIDE/above the `ScrollView` (RN has no `position:sticky` support in plain `ScrollView`);
  use `SectionList` `stickySectionHeadersEnabled` or a fixed header `View` + `ScrollView` below it.

**Prototype `reactions`/`flows` → navigation, not markup** — `flows` are candidate top-level screens for
React Navigation. A `reactions` entry with `navigation` → `navigation.navigate(destination)`; `overlay` →
a `Modal`/bottom-sheet component; `set_variable`/`set_variable_mode` → local state or a theme-context
toggle. Ignore triggers with no static equivalent (scrub/media-hit points).

**Theming (`resolvedModes`/`variableModes`)** — use `resolvedModes` (root) to pick the effective
light/dark theme when a subtree carries no `variableModes` of its own; `variableModes` on a subtree pins
it to a mode — read from that mode's theme object explicitly rather than the ambient `useColorScheme()`.

**Effects** — `background_blur`/`layer_blur` → `expo-blur`'s `<BlurView intensity={...} />` (plain RN
`View` has no native blur filter) or a platform blur lib; `noise`/`glass`/`texture`/`shader` have no RN
equivalent — use the exported `asset` instead of approximating. `blendMode` has partial/no RN support —
flag it. `rotation` is DEGREES, Figma positive = counter-clockwise → `transform:[{rotate:'${-rotation}deg'}]`;
`flipped` → `{scaleX:-1}`. Shadows: `boxShadow` style prop (New Architecture, RN 0.76+) behaves like CSS
incl. spread & `inset` (`x y radius spread color`); legacy → `shadow*` (iOS) / `elevation` (Android).
`filter` landed alongside `boxShadow` in **0.76**, `mixBlendMode` (plus `outline*`, `boxSizing`,
`display:'contents'`) in **0.77**; all are New-Architecture-only. Check the project's RN version in
`package.json` before emitting any of them, and flag rather than silently degrade.

**Text metrics** — `lineHeight` is absolute: `percent` → size*pct/100, `px` → as-is, `auto` → omit.
`letterSpacing` in px: `percent` → pct/100*size. Android `<Text>`: `includeFontPadding:false` +
`textAlignVertical:'center'`. Respect `allowFontScaling`; cap with `maxFontSizeMultiplier`, never
fixed-height text boxes. `font.weight` is the verbatim style string → `fontWeight:'{weightValue}'`.

**Safe area, a11y & RTL** — insets via `react-native-safe-area-context` (never a fake status bar); touch
targets 44 (iOS)/48 (Android) via `hitSlop`; padding is PHYSICAL `[t,r,b,l]` → `paddingStart/End`, check
`I18nManager.isRTL` for directional icons.

**Accessibility naming (do this, don't just "add semantics")** — RN has no DOM, so nothing is implicit.
- Every interactive element: `accessibilityRole` (`'button'|'link'|'header'|'image'|'switch'|'checkbox'|
  'tab'|'search'`) + `accessibilityLabel` when there's no visible text (icon-only controls).
- A row/card that should read as one item → `accessible={true}` on the wrapper (it merges children);
  leave it off when each child must be reachable separately.
- Decorative art → `accessibilityElementsHidden` (iOS) + `importantForAccessibility="no-hide-descendants"`
  (Android), or simply no label; don't ship an empty-string label.
- State, not styling: `accessibilityState={{disabled, selected, checked, expanded}}` and
  `accessibilityValue` for sliders/progress; `accessibilityHint` only for non-obvious outcomes.
- Section titles → `accessibilityRole="header"`. `<TextInput>` needs its own `accessibilityLabel` when the
  visual label is a separate `<Text>` (there is no `for`/`htmlFor`).
- Targets: 44×44pt iOS / 48×48dp Android. Prefer real padding; use `hitSlop` when the visual must stay small
  (note `hitSlop` extends touch only — VoiceOver/TalkBack still traces the frame).

**Motion** — `transition.duration` SECONDS → ms; `cubicBezier` → `Easing.bezier(x1,y1,x2,y2)`; `spring` →
`Animated.spring({stiffness,damping,mass})`. Honor reduce motion (`AccessibilityInfo.isReduceMotionEnabled`).

**Text overflow** — `truncate:true` → `numberOfLines={1}` + `ellipsizeMode="tail"`; `maxLines:N` →
`numberOfLines={N}`. Figma's manual line breaks are **not authoritative** (different text engine) — don't
copy them as literal `\n`s; let `<Text>` wrap.

**Images** — use `intrinsicSize` to set `aspectRatio: w/h` in the image's style so layout doesn't jump
before load; always set explicit `width`/`height` or `aspectRatio` (never omit both).

**Interaction states** — check `design/design-system/components.local.json` component variant `options` for
pressed/disabled/error/selected states; implement pressed via `Pressable`'s `style={({pressed}) => ...}`.
RN has no hover/focus-visible on touch, but for any web-adjacent RN target (RNW) still add a focus ring.

**Idiomatic RN — recognize native patterns by STRUCTURE, not node name.** Upgrade generic flex intent to
platform components; a name like "Tab Bar" is a hint, never the decision.
- **Screen chrome belongs to the navigator, not the screen.** A top bar (back chevron + title + trailing
  action) → React Navigation's header (`options={{ title, headerRight }}`), not a hand-built `<View>`. A
  bottom bar of 3–5 icon+label pairs → a `createBottomTabNavigator`, not a row of `Pressable`s. `flows`
  names the candidate navigators/routes.
- **Repeated similar rows → `FlatList`** (`data`/`renderItem`/`keyExtractor`), grouped rows →
  `SectionList` (its `stickySectionHeadersEnabled` is how `fixedChildren` headers are done); a short fixed
  cluster of dissimilar content stays a `View`/`ScrollView`. Never `data.map()` inside a `ScrollView` for
  a long list.
- **A frame the IR marks as an `overlay`** (`reactions` action `type:"overlay"`) → `Modal` or a
  bottom-sheet lib, with the `overlay.background` scrim and `overlay.closeOnClickOutside` honored — not an
  absolutely-positioned sibling `View`.
- **Screen edges** → `useSafeAreaInsets()`/`SafeAreaView` from `react-native-safe-area-context` (the core
  `SafeAreaView` is deprecated and iOS-only), never a hardcoded status-bar height.

**Native controls, not rebuilt ones** — Toggle/Switch→`Switch`, text input→`TextInput` (with
`keyboardType`/`secureTextEntry`/`returnKeyType` inferred from the field), Slider→`@react-native-community/
slider`, Spinner→`ActivityIndicator`, Progress→`ProgressBarAndroid`/a bar lib, pull-to-refresh→
`RefreshControl`, Picker→`@react-native-picker/picker`, Segmented→`SegmentedControl` (iOS) or tabs.
Anything tappable → `Pressable` (not `TouchableOpacity`) so pressed/disabled state comes from its
`({pressed})` style callback rather than a custom gesture.

**Hints, not output** — `layoutGrids`, `measurements`, `devStatus`/`devStatusNote`, `devResources` inform
your structure and let you sanity-check spacing; never render them as visible UI.

**Component reuse** — `exposedInstances`/`propRefs`/`overrides` on an instance's sublayer mean: map to a
**prop** on the already-imported component from `codeconnect.local.json`, don't hand-build the divergence.
`detachedFrom` (`{key}`/`{componentId}`) → look that component up in `codeconnect.local.json` and reuse it
unless clearly intentional.

**Units** — unitless density-independent numbers (no `px`).

**Tokens** — the right-hand value in `tokens.json` is a JS theme reference (e.g. `theme.colors.primary`,
`theme.space.md`). No CSS variables. Emit via `StyleSheet.create` or inline style.

**Components** — import per `codeconnect.local.json` (RN components / your kit); pass Figma `props` through.

**Text** — `<Text>` with style; map `font.size/weight` to your theme's type scale.

**Assets** — `<Image source={require(...)}>` for PNG; an SVG component (react-native-svg) for vectors.

**Output** — function component `.tsx` with a `StyleSheet.create` block, one screen per file under `outputDir`.
