# Profile: android-compose (Android / Jetpack Compose)

**Layout (IR → Row/Column)**
- `flexDirection:"row"` → `Row`; `"column"` → `Column`.
- `gap:N` → `horizontalArrangement = Arrangement.spacedBy(N.dp)` (Row) /
  `verticalArrangement = Arrangement.spacedBy(N.dp)` (Column).
- `padding:[t,r,b,l]` → `Modifier.padding(start = l.dp, top = t.dp, end = r.dp, bottom = b.dp)`.
- `justifyContent` → `Arrangement.Start/Center/End/SpaceBetween`; `alignItems` → the layout's
  `verticalAlignment`/`horizontalAlignment` (`Alignment.CenterVertically`, etc.).
- `widthMode:"fill"` → `Modifier.fillMaxWidth()` or `Modifier.weight(1f)`; `"hug"` → `wrapContentWidth()`;
  `"fixed"` → `Modifier.width(N.dp)`.

**Grid (`layout.display:"grid"`) → `LazyVerticalGrid`/`LazyHorizontalGrid`.** `columns`/`columnSizes`
(per-track `{type:"flex"|"fixed"|"hug", value}`) → `GridCells.Fixed(N)` for a uniform count, or
`GridCells.Adaptive(minSize)` for hug tracks; `columnGap`/`rowGap` → `horizontalArrangement`/
`verticalArrangement = Arrangement.spacedBy(N.dp)`. `gridColumnSpan`/`gridRowSpan` → that item's
`span = { GridItemSpan(N) }`. A small fixed grid can instead be nested `Row`s inside a `Column`.

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

**Components** — your `@Composable`s per `components.json`; pass Figma `props` through.

**Text** — `Text(...)` with `style = MaterialTheme.typography...`; map `font.size` to `.sp`.

**Assets** — SVG → import as a vector drawable (`ImageVector` / `painterResource(R.drawable.x)`);
PNG → `painterResource`. Flag any drawable the user must add to `res/`.

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

**Interactions (from IR `reactions`) → Navigation Compose.** `navigate`+destination →
`navController.navigate(route)` inside `NavHost { composable("route"){…} }`; `overlay` → `ModalBottomSheet`/
`Dialog`; `after_timeout` → `LaunchedEffect { delay(...) }`. Transitions → `AnimatedContent`/`animate*AsState`;
honor the animator-duration-scale / reduce-motion setting.

**Output** — a `@Composable` function per screen (`.kt`) under `outputDir`, hoisting state, taking a
`Modifier` param, passing `innerPadding` down, with a `@Preview`.
