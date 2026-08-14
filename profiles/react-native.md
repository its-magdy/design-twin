# Profile: react-native

**Layout (IR → `View` + `StyleSheet`)** — flexbox is native; **default `flexDirection` is `column`**.
- `display:flex` → a `<View>`; `flexDirection:"row"` → `flexDirection:'row'` (omit for column).
- `gap:N` → `gap:N` (RN ≥ 0.71) else margins; `flexWrap:"wrap"` → `flexWrap:'wrap'`.
- `padding:[t,r,b,l]` → `paddingTop/Right/Bottom/Left`.
- `justifyContent`/`alignItems` → same prop names, string values.
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
flag it. `rotation`/`flipped` → `transform:[{rotate:'${deg}deg'}]`/`{scaleX:-1}`.

**Text overflow** — `truncate:true` → `numberOfLines={1}` + `ellipsizeMode="tail"`; `maxLines:N` →
`numberOfLines={N}`. Figma's manual line breaks are **not authoritative** (different text engine) — don't
copy them as literal `\n`s; let `<Text>` wrap.

**Images** — use `intrinsicSize` to set `aspectRatio: w/h` in the image's style so layout doesn't jump
before load; always set explicit `width`/`height` or `aspectRatio` (never omit both).

**Interaction states** — check `design/design-system.json` component variant `options` for
pressed/disabled/error/selected states; implement pressed via `Pressable`'s `style={({pressed}) => ...}`.
RN has no hover/focus-visible on touch, but for any web-adjacent RN target (RNW) still add a focus ring.

**Component reuse** — `exposedInstances`/`propRefs`/`overrides` on an instance's sublayer mean: map to a
**prop** on the already-imported component from `components.json`, don't hand-build the divergence.
`detachedFrom` (`{key}`/`{componentId}`) → look that component up in `components.json` and reuse it
unless clearly intentional.

**Units** — unitless density-independent numbers (no `px`).

**Tokens** — the right-hand value in `tokens.json` is a JS theme reference (e.g. `theme.colors.primary`,
`theme.space.md`). No CSS variables. Emit via `StyleSheet.create` or inline style.

**Components** — import per `components.json` (RN components / your kit); pass Figma `props` through.

**Text** — `<Text>` with style; map `font.size/weight` to your theme's type scale.

**Assets** — `<Image source={require(...)}>` for PNG; an SVG component (react-native-svg) for vectors.

**Output** — function component `.tsx` with a `StyleSheet.create` block, one screen per file under `outputDir`.
