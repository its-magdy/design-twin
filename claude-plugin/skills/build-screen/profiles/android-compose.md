# Profile: android-compose (Android / Jetpack Compose)

## Contents
Layout · Modifier ORDER · Grid · Scroll/clip/sticky · Theming · Vector fallback · Units · Tokens ·
Components · Text · Assets · Idiomatic Android (M3 by structure) · Material theme colors · Type scale ·
Native controls · Icons · Interactions · Text metrics · Effects · Shapes & strokes · Fills & images ·
Safe area & insets · Accessibility & RTL · Accessibility naming · Motion · Assets (detail) · Fit the existing app ·
Output

**Layout (IR → Row/Column)**
- `flexDirection:"row"` → `Row`; `"column"` → `Column`.
- `gap:N` → `horizontalArrangement = Arrangement.spacedBy(N.dp)` (Row) /
  `verticalArrangement = Arrangement.spacedBy(N.dp)` (Column).
- `padding:[t,r,b,l]` → `Modifier.padding(start = l.dp, top = t.dp, end = r.dp, bottom = b.dp)`.
- `justifyContent` → `Arrangement.Start/Center/End/SpaceBetween`; `alignItems` → the layout's
  `verticalAlignment`/`horizontalAlignment` (`Alignment.CenterVertically`, etc.);
  `alignItems:"baseline"` → drop the layout-wide alignment and put `Modifier.alignByBaseline()` on the
  `Row`'s text children instead.
- `widthMode:"fill"` → depends on the axis: along a `Row`/`Column`'s **main** axis, fill means
  `Modifier.weight(1f)` — `fillMaxWidth()` there makes the first child eat the whole row. Use
  `fillMaxWidth()`/`fillMaxHeight()` only on the **cross** axis, or inside a non-weighting parent (`Box`,
  a screen root). `"hug"` → `wrapContentWidth()`; `"fixed"` → `Modifier.width(N.dp)`.

**Modifier ORDER is semantics, not style.** Modifiers apply outside-in, so the chain order changes the
result, not just the code. Canonical chain: `size`/`weight` → `clip` → `background` → `border` →
`clickable` → `padding` → content.
- `.clickable().padding(16.dp)` = padding is *inside* the hit area and ripple (usually what you want);
  `.padding(16.dp).clickable()` shrinks the touch target to the content — a common regression.
- `.padding(8.dp).background(c)` paints only the inner box; `.background(c).padding(8.dp)` paints the
  full box and insets the content. Figma padding is inner padding → background first.
- `.clip(shape)` must precede `background`/`border` for the fill and ripple to be clipped to that shape.
- Keep an incoming `modifier: Modifier = Modifier` param FIRST in the chain so callers can wrap you.

**Grid (`layout.display:"grid"`) → `LazyVerticalGrid`/`LazyHorizontalGrid`.** `columns`/`columnSizes`
(per-track `{type:"flex"|"fixed"|"hug", value}`) → `GridCells.Fixed(N)` for a uniform count, or
`GridCells.Adaptive(minSize)` for hug tracks; `columnGap`/`rowGap` → `horizontalArrangement`/
`verticalArrangement = Arrangement.spacedBy(N.dp)`. `gridColumnSpan`/`gridRowSpan` → that item's
`span = { GridItemSpan(N) }`. A small fixed grid can instead be nested `Row`s inside a `Column`.
**Never nest a lazy container inside a same-direction scroller** — `LazyVerticalGrid`/`LazyColumn` inside
a `Modifier.verticalScroll()` parent *crashes* ("Vertically scrollable component was measured with an
infinity maximum height constraint"). Either make the lazy container the scroll root (move the surrounding
content into `item {}`/`header` slots), or keep the parent scroll and render the grid non-lazily with
`FlowRow`/chunked `Row`s. Fixing it with a hardcoded `.height(N.dp)` is a bug, not a fix.

**Scroll, clip & sticky** — `clip:true` → `Modifier.clip(...)`; `layout.scroll` → `Modifier.verticalScroll`/
`horizontalScroll(rememberScrollState())`, or `LazyColumn`/`LazyRow` for long content. `fixedChildren`
**if present** (count of leading children pinned while the rest scrolls) → `LazyColumn` `stickyHeader { }`
for that many leading children, or keep them outside the scrollable composable as a fixed header/footer.

**Theming (`resolvedModes`/`variableModes`)** — `resolvedModes` (root) names the effective color scheme
this export represents; if a subtree carries its own `variableModes`, force that scheme explicitly (a
dedicated `MaterialTheme(colorScheme = darkColorScheme(...))` wrapper) rather than trusting
`isSystemInDarkTheme()` for that subtree.

**Vector fallback** — a `geometry` field (`fills`/`strokes`: arrays of SVG path `d` strings, plus `w`/`h`)
appears on a vector node whose SVG export failed. Draw it with `Canvas`/`Path` in a `0 0 w h` coordinate
space rather than a bitmap — there is no asset file for that node.

**Units** — `.dp` for size/spacing, `.sp` for text.

**Tokens** — the right-hand value in `tokens.json` is a Compose reference (e.g.
`MaterialTheme.colorScheme.primary`, or your `Tokens.space.md`). Emit these, not literals.

**Components** — your `@Composable`s per `codeconnect.local.json`; pass Figma `props` through.

**Text** — `Text(...)` with `style = MaterialTheme.typography...`; map `font.size` to `.sp`.

**Assets** — SVG → import as a vector drawable (`ImageVector` / `painterResource(R.drawable.x)`);
PNG → `painterResource`. Flag any drawable the user must add to `res/`.
A path-heavy SVG (see `references/export-layout.md`, heavy vector assets) is the case to
watch: `VectorDrawable` inflates its paths on the main thread, so a few thousand of them is a jank
source, not just a size one, and AAPT can reject a pathological one outright. Ask for a raster
re-export rather than shipping it as a drawable.

**Idiomatic Android — recognize M3 patterns by STRUCTURE, not node name.** Upgrade generic flex intent
to Material 3 components; a node name is a hint, never the decision.
- **Screen shell → `Scaffold`.** Top bar / bottom bar / FAB present → `Scaffold(topBar={…}, bottomBar={…},
  floatingActionButton={…}) { innerPadding -> … }`, and **consume `innerPadding`** (`Modifier.padding(innerPadding)`)
  — the Compose "don't double-inset" rule; dropping it hides content behind bars, adding your own Figma
  edge inset on top double-pads.
- **Lists → `LazyColumn`/`LazyRow` before `Column`+`forEach`.** A vertical stack of similar rows →
  `LazyColumn { items(data){…} }` (keeps recycling/scroll); horizontal card strip → `LazyRow`. A small
  fixed cluster of dissimilar content stays `Column`.
- **Row → `ListItem`.** Leading icon + headline/supporting text + trailing chevron/toggle →
  `ListItem(headlineContent, supportingContent, leadingContent, trailingContent)`; a row that navigates
  wraps in `Modifier.clickable { navController.navigate(...) }`.
- **Top bar → the `TopAppBar` family**, not a hand-built `Row`: back + centered title + action →
  `CenterAlignedTopAppBar(title, navigationIcon, actions)`; large title → `LargeTopAppBar`; default → `TopAppBar`.
- **Bottom bar of 3–5 icon+label pairs → `NavigationBar { NavigationBarItem(...) }`** (keeps selected state,
  ripple, insets); rail/tablet → `NavigationRail`.
- **Cards** → `Card` / `ElevatedCard` / `OutlinedCard`. **Dividers** → `HorizontalDivider`/`VerticalDivider`
  (M3 renamed `Divider`), never a hand-drawn `Box` hairline.

**Material theme colors (free dark mode).** Map semantic token paths to `MaterialTheme.colorScheme.*`
(`background`, `surface`, `surfaceVariant`, `onSurface`, `onSurfaceVariant`, `primary`, `outline`) instead
of raw hex — the theme adapts light/dark for free. A **custom brand** variable → a project theme color /
`colorResource(R.color.brand)`, never remapped onto a system slot and never a hardcoded hex background.

**Type scale by role** — `MaterialTheme.typography.{displayLarge…titleLarge…bodyLarge…labelSmall}` from the
Figma named text style, not raw `.sp`; map Figma weights to `FontWeight.*`. Flag non-system fonts and ask.

**Native controls, not rebuilt ones** — Switch→`Switch`, Checkbox→`Checkbox`, Radio→`RadioButton`,
Slider→`Slider`, Segmented→`SingleChoiceSegmentedButtonRow { SegmentedButton(...) }`, Menu→`DropdownMenu`/
`ExposedDropdownMenuBox`, Spinner→`CircularProgressIndicator`, Progress→`LinearProgressIndicator`,
TextField→`TextField`/`OutlinedTextField`.

**Icons** — `Icon(Icons.Default.X)` (or `Icons.Outlined/Rounded`) / `painterResource(R.drawable.x)` from the
exported vector drawable. Never redraw a vector; reuse a Material icon only if the glyph clearly matches.

**Interactions (from IR `reactions`).** `navigate`+destination → an `onX: () -> Unit` lambda on the screen,
wired by the caller (with Navigation Compose: `navController.navigate(route)` inside `NavHost { composable("route"){…} }` — see *Fit the existing app*); `overlay` → `ModalBottomSheet`/
`Dialog`; `after_timeout` → `LaunchedEffect { delay(...) }`. Transitions → `AnimatedContent`/`animate*AsState`;
honor the animator-duration-scale / reduce-motion setting.

**Text metrics** — size `.sp`. `font.lineHeight` `px` → `(px/fontSizePx).em` (or `.sp`), `percent` →
`(pct/100).em`, `auto` → omit. `font.letterSpacing` `percent` → `(pct/100).em`, `px` → `(px/fontSize).em`.
Match Figma half-leading with `LineHeightStyle(alignment = Center, trim = None)` (`includeFontPadding` is
false by default since Compose 1.6). XML views: set `includeFontPadding="false"` explicitly;
`android:letterSpacing` is em-only; `android:lineHeight` needs API 28+. Android 14+ scales fonts nonlinearly
to 200% — never fixed-height text containers; use `heightIn(min = …)`. `font.weight` is the verbatim style
string → `FontWeight(weightValue)`.

**Effects** — `Modifier.shadow(elevation)` cannot express offset/blur/spread/color (color only API 28+ via
`ambientShadowColor`/`spotShadowColor`). For exact Figma shadows use Compose 1.9+
`Modifier.dropShadow(shape, Shadow(radius, spread, color, offset))` (before `background`) / `innerShadow`
(after `background`); Material 3 prefers tonal elevation where the design is just "raised". `layer_blur` →
`Modifier.blur` (API 31+, no-op below); `background_blur` → window blur or a library (e.g. Haze).
`rotation` is DEGREES, Figma positive = counter-clockwise → `Modifier.rotate(-rotation)`.

**Shapes & strokes** — `RoundedCornerShape` is circular; if `cornerSmoothing` matters use
`androidx.graphics.shapes` or a custom path. `radius:{tl,tr,br,bl}` → `RoundedCornerShape(topStart…)`.
`Modifier.border` draws inside bounds (= `align:"inside"`); `outside`/`center` → padding compensation or
`drawBehind`. Per-side `weights` → `drawBehind` lines; `dash` → `PathEffect.dashPathEffect`.

**Fills & images** — gradients → `Brush.linearGradient`/`radialGradient`/`sweepGradient` (angle from
`transform`); `GRADIENT_DIAMOND` → asset. Image `scaleMode` `fill` → `ContentScale.Crop`, `fit` →
`ContentScale.Fit`, `tile` → `ImageShader(..., TileMode.Repeated)`. Hex is 8-bit sRGB; if `colorProfile` is
display-p3 → `Color(r, g, b, a, ColorSpaces.DisplayP3)`.

**Safe area & insets** — edge-to-edge is enforced on Android 15+ once the app targets SDK 35; the
`windowOptOutEdgeToEdgeEnforcement` escape hatch is **deprecated and disabled** for apps targeting SDK 36
(it still works only for an SDK-36 app running on an Android 15 device). Treat edge-to-edge as mandatory:
`enableEdgeToEdge()`, `WindowInsets.safeDrawing`, `Modifier.imePadding()`. A fake status/nav bar frame in the
design → insets, never a composable.

**Accessibility & RTL** — touch target 48dp (`minimumInteractiveComponentSize()`). `padding` is PHYSICAL
`[t,r,b,l]` → `start`/`end` (as above); directional icons → `Icons.AutoMirrored`.

**Accessibility naming (do this, don't just "add semantics")**
- Every `Icon`/`Image` needs `contentDescription`: a real string if it carries meaning, **`null`** if it's
  decorative or its label is already spoken by adjacent text. Never `""`, never the drawable name.
- Don't describe the picture — describe the action: `contentDescription = "Delete item"`, not "trash icon".
- Section titles / headings → `Modifier.semantics { heading() }`; a non-`Button` that's clickable →
  `Modifier.semantics { role = Role.Button }` (`Checkbox`/`Switch`/`RadioButton`/`Tab` roles likewise).
- A card or `ListItem` TalkBack should read as one item → `Modifier.semantics(mergeDescendants = true) {}`
  (`ListItem`/`Button` already merge); the reverse is `clearAndSetSemantics {}`.
- Describe the gesture, not the widget: `Modifier.clickable(onClickLabel = "Open profile") { … }`; toggles
  get `toggleable(…, onValueChange)` / `stateDescription` rather than a hand-written "on"/"off" label.
- Touch target ≥48dp — `Modifier.minimumInteractiveComponentSize()` (M3 components apply it already); an
  icon drawn at 24dp still needs the 48dp clickable box.

**Motion** — `transition.duration` SECONDS ×1000 → ms; `easing.cubicBezier` → `CubicBezierEasing(x1,y1,x2,y2)`;
`spring` → `spring(dampingRatio, stiffness)` (Figma carries mass/stiffness/damping: ratio =
damping / (2·√(stiffness·mass))).

**Assets (detail)** — SVG → VectorDrawable (no filters/masks/text; gradients API 24+); PNG densities
mdpi 1x / hdpi 1.5x / xhdpi 2x / xxhdpi 3x / xxxhdpi 4x; prefer WebP.

**Fit the existing app (detect before you emit)** — the screen lands in a codebase with conventions; a
generated screen that ignores them is rejected in review however well it matches the design.
- *Strings.* No literal UI text: `stringResource(R.string.login_title)` with a new entry in
  `res/values/strings.xml` (plurals → `pluralStringResource`), following the file's existing key style.
  `contentDescription`, `onClickLabel`, placeholders and error text too. Sample/preview data may be literal.
- *Navigation.* A screen composable never receives or captures a `NavController`. Hoist events:
  `LoginScreen(state, onBack: () -> Unit, onSubmit: (…) -> Unit)`, and wire them where the project wires
  routes. Check which library that is first (`navigation-compose`, Navigation 3, Voyager, Decompose,
  Fragments) — the `NavHost` mapping under Interactions applies only when the project uses it.
- *State.* State hoisting: a stateless `XScreen(state, callbacks)` plus a thin stateful wrapper that
  reads the project's `ViewModel` (`collectAsStateWithLifecycle`). Match the DI in use (Hilt, Koin,
  manual). `@Preview` calls the stateless one with sample state.
- *Theme: one source of truth.* An existing `AppTheme`/`MaterialTheme` wins. When the Figma tokens ARE
  Material 3 roles (`primary`, `onSurfaceVariant`, `surfaceTint`…), feed them into
  `lightColorScheme(...)`/`darkColorScheme(...)` so `Button`/`Card` pick them up — a parallel
  `LocalXTokens` that the Material widgets never read leaves the file and the UI disagreeing. Keep a
  custom `CompositionLocal` only for roles Material has no slot for.
- *Versions & ownership.* Check the Compose BOM before an API this file marks with a version
  (`Modifier.dropShadow` needs 1.9+; fall back to `shadow`). `enableEdgeToEdge()` belongs in the
  `Activity`, not in a screen — check it is there, don't add it here.

**Output** — a `@Composable` function per screen (`.kt`) under `outputDir`, hoisting state, taking a
`Modifier` param, passing `innerPadding` down, with a `@Preview`.
