# Profile: react-native

**Layout (IR → `View` + `StyleSheet`)** — flexbox is native; **default `flexDirection` is `column`**.
- `display:flex` → a `<View>`; `flexDirection:"row"` → `flexDirection:'row'` (omit for column).
- `gap:N` → `gap:N` (RN ≥ 0.71) else margins; `flexWrap:"wrap"` → `flexWrap:'wrap'`.
- `padding:[t,r,b,l]` → `paddingTop/Right/Bottom/Left`.
- `justifyContent`/`alignItems` → same prop names, string values.
- `widthMode:"fill"` → `flex:1`; `"hug"` → omit; `"fixed"` → `width:N`.

**Units** — unitless density-independent numbers (no `px`).

**Tokens** — the right-hand value in `tokens.json` is a JS theme reference (e.g. `theme.colors.primary`,
`theme.space.md`). No CSS variables. Emit via `StyleSheet.create` or inline style.

**Components** — import per `components.json` (RN components / your kit); pass Figma `props` through.

**Text** — `<Text>` with style; map `font.size/weight` to your theme's type scale.

**Assets** — `<Image source={require(...)}>` for PNG; an SVG component (react-native-svg) for vectors.

**Output** — function component `.tsx` with a `StyleSheet.create` block, one screen per file under `outputDir`.
