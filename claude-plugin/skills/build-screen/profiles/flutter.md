# Profile: flutter (Flutter / Dart widgets)

## Contents
Detect · Layout · Grid · Scroll/clip/sticky · Text metrics · Effects · Shapes & strokes · Fills & images ·
Safe area & insets · Accessibility & RTL · Accessibility naming · Theming & tokens · Idiomatic Flutter
(M3 by structure) · Interaction states · Hints, not output · Component reuse · Components ·
Interactions & motion · Vector fallback · Units · Assets · Output

**Detect** — `pubspec.yaml` with a `flutter:` sdk dependency.

**Layout (IR → Row/Column)**
- `flexDirection:"row"` → `Row`; `"column"` → `Column`; `flexWrap:"wrap"` → `Wrap(spacing:, runSpacing:)`.
- `gap:N` → `spacing: N` (Flutter 3.27+) or `SizedBox(width/height: N)` between children.
- `padding:[t,r,b,l]` (PHYSICAL) → `Padding(padding: EdgeInsetsDirectional.fromSTEB(l, t, r, b))`.
- `justifyContent` → `mainAxisAlignment` (`start/center/end/spaceBetween`); `alignItems` → `crossAxisAlignment`
  (`"baseline"` → `CrossAxisAlignment.baseline` **plus** the required `textBaseline:
  TextBaseline.alphabetic` — a `Row` asserts without it).
- `widthMode:"fill"` → `Expanded`/`Flexible` in the main axis, `double.infinity` width in the cross axis;
  `"hug"` → `mainAxisSize: MainAxisSize.min`; `"fixed"` → `SizedBox(width: N)`. `grow` → `Expanded(flex:)`;
  `alignSelf:"stretch"` → `CrossAxisAlignment.stretch`. `sizeLimits` → `ConstrainedBox(BoxConstraints(...))`.
- `absolute:true` child → `Stack` + `Positioned` (only for genuine overlays); `layout.mode:"absolute"` →
  infer a flow layout, do NOT hardcode coordinates.

**Grid (`layout.display:"grid"`)** → `GridView.count`/`SliverGrid` for uniform tracks; mixed `columnSizes`
(`flex`/`fixed`/`hug`) → a `Row` of `Expanded(flex:)`/`SizedBox` per row; `columnGap`/`rowGap` →
`crossAxisSpacing`/`mainAxisSpacing`; spans → merge cells (or `flutter_staggered_grid_view`).

**Scroll, clip & sticky** — `clip:true` → `ClipRRect`/`clipBehavior: Clip.hardEdge`; `layout.scroll` →
`SingleChildScrollView` (short) or `ListView.builder` (long). `fixedChildren` if present → `CustomScrollView`
with `SliverAppBar(pinned: true)`/`SliverPersistentHeader(pinned: true)`, or keep them outside the scroll.

**Text metrics** — `TextStyle.height` is a MULTIPLIER: `lineHeight` `px` → px/fontSize, `percent` → pct/100,
`auto` → omit; add `leadingDistribution: TextLeadingDistribution.even` to match Figma's half-leading.
`letterSpacing` is logical px: `percent` → pct/100*fontSize. `font.weight` is the verbatim style string →
`FontWeight.w{weightValue}`. Respect `MediaQuery.textScalerOf`/`TextScaler`; never fixed-height text.
`truncate`/`maxLines` → `maxLines:` + `overflow: TextOverflow.ellipsis`.

**Effects** — shadows → `BoxDecoration(boxShadow: [BoxShadow(color, offset: Offset(x,y), blurRadius: radius,
spreadRadius: spread)])` (Flutter converts blurRadius to sigma ≈ radius/2 internally, so Figma `radius`
maps directly — verify visually); `inner_shadow` → no native, use a package or asset. `background_blur` →
`ClipRect` + `BackdropFilter(filter: ImageFilter.blur(...))`; `layer_blur` → `ImageFiltered`. `rotation` is
DEGREES, Figma positive = counter-clockwise → `Transform.rotate(angle: -rotation * pi / 180)`.

**Shapes & strokes** — `radius` → `BorderRadius.circular`/`.only(topLeft…)`; `cornerSmoothing` →
`RoundedSuperellipseBorder` (Flutter 3.32+; iOS/Android only — other platforms fall back to a plain
rounded rectangle) or `ContinuousRectangleBorder`. `Border.all(width:)` in a
`BoxDecoration` is inside; `BorderSide.strokeAlign` (`strokeAlignInside`/`Center`/`Outside`) maps `align`
directly. Per-side `weights` → `Border(top: BorderSide(...))`; `dash` → CustomPainter or a package.

**Fills & images** — `LinearGradient(begin, end` from `transform`, `stops` from `stops[].pos)`/
`RadialGradient`/`SweepGradient` (angular); diamond → asset. `scaleMode` `fill` → `BoxFit.cover`, `fit` →
`BoxFit.contain`, `tile` → `ImageRepeat.repeat`. `intrinsicSize` → `AspectRatio`. Hex is 8-bit sRGB.

**Safe area & insets** — `SafeArea` / `MediaQuery.viewPaddingOf(context)`; a fake status bar in the design →
insets, never a widget.

**Accessibility & RTL** — RTL via `Directionality` + `EdgeInsetsDirectional`/`AlignmentDirectional`.

**Accessibility naming (do this, don't just "add semantics")**
- Material widgets (`FilledButton`, `ListTile`, `Switch`…) already expose role + label from their child —
  don't wrap them in a redundant `Semantics`.
- Icon-only control → `IconButton(tooltip: 'Delete')` (the tooltip *is* the accessible name), or
  `Icon(Icons.x, semanticLabel: 'Delete')` / `Image.asset(..., semanticLabel:)` for a bare icon.
- Decorative art → `ExcludeSemantics(child: …)` or `semanticLabel: null`; never a blank label.
- A custom tappable/section title → `Semantics(button: true, label: …)` / `Semantics(header: true, …)`;
  a card whose several `Text`s should read as one node → `MergeSemantics`.
- State: `Semantics(selected:, enabled:, checked:, value:, onTapHint:)` rather than a hand-built string.
- Touch target ≥48×48 (`kMinInteractiveDimension`): keep `MaterialTapTargetSize.padded` (the default) and
  don't set `materialTapTargetSize: shrinkWrap` to match a small Figma frame — pad instead. Verify with
  `flutter test`'s `meetsGuideline(androidTapTargetGuideline)` / `iOSTapTargetGuideline` / `textContrastGuideline`.

**Theming & tokens** — Material 3 `ThemeData(colorScheme:, textTheme:)` from tokens; brand extras via
`ThemeExtension`; `resolvedModes`/`variableModes` → `theme`/`darkTheme`, or a nested `Theme` for a pinned
subtree. The right-hand value in `tokens.json` is a Dart reference (`Theme.of(context).colorScheme.primary`,
`AppSpacing.md`). Emit these, not literals.

**Idiomatic Flutter — recognize Material 3 patterns by STRUCTURE, not node name.** Upgrade generic flex
intent to real widgets; a node name is a hint, never the decision.
- **Screen shell → `Scaffold`** (`appBar:`, `bottomNavigationBar:`, `floatingActionButton:`, `drawer:`).
  It handles insets and the keyboard — don't hand-build bars inside the body and then pad around them.
- **Top bar** (back + title + actions) → `AppBar(title:, leading:, actions:)`; a bar that collapses or
  pins while content scrolls → `CustomScrollView` + `SliverAppBar(pinned:/floating:/expandedHeight:)`.
- **Bottom bar of 3–5 icon+label pairs** → `NavigationBar { NavigationDestination }` (M3; `BottomNavigationBar`
  is the M2 widget); wide/tablet → `NavigationRail`.
- **Repeated similar rows** → `ListView.builder` + `ListTile`/`CheckboxListTile`/`SwitchListTile`, with
  `Divider`/`ListView.separated` for separators — never a `Column` of hand-drawn `Container` hairlines.
- **Cards** → `Card`/`Card.filled`/`Card.outlined`, not a `Container` with a `BoxShadow`.
- **Buttons by emphasis**: `FilledButton` / `FilledButton.tonal` / `ElevatedButton` / `OutlinedButton` /
  `TextButton` / `IconButton` / `FloatingActionButton` — pick from the Figma fill+stroke, then let the
  theme supply the colors.
- **Native controls, not rebuilt ones** — Switch→`Switch`, Checkbox→`Checkbox`, Radio→`Radio`,
  Slider→`Slider`, Segmented→`SegmentedButton`, Menu→`DropdownMenu`/`MenuAnchor`, Chip→`FilterChip`/
  `InputChip`, Spinner→`CircularProgressIndicator`, Progress→`LinearProgressIndicator`, field→`TextField`
  with an `InputDecoration` (`labelText`/`hintText`/`errorText`) rather than a separate label `Text`,
  tabs→`TabBar`/`TabBarView`, sheet→`showModalBottomSheet`, dialog→`AlertDialog`.

**Interaction states** — look up the component in `design/design-system/components.local.json`'s
`components` catalog and check its variant `options` for hover/focus/pressed/disabled/error/selected
before shipping. In M3 these are `WidgetStateProperty.resolveWith((states) => …)` on the widget's
`ButtonStyle`/theme (`WidgetState.hovered/focused/pressed/disabled/selected/error`) — one styled widget,
not a copy per state. A bespoke tappable → `InkWell`/`InkResponse` inside a `Material` so the ripple,
`focusColor` and `hoverColor` come for free; always keep a visible focus indicator even if Figma shows
only a pressed state.

**Hints, not output** — `layoutGrids`, `measurements`, `devStatus`/`devStatusNote`, `devResources` inform
your structure and let you sanity-check spacing; never render them as visible UI.

**Component reuse** — before generating widgets for an instance's sublayer, check `exposedInstances`,
`propRefs`, `overrides` on the node: a prop-driven or overridden sublayer maps to a **constructor
param/enum variant** on the already-mapped widget (from `codeconnect.local.json`), not new widget code.
`detachedFrom` (`{key}` or `{componentId}`) means the node used to be an instance of a component that may
still exist in `codeconnect.local.json` — look it up and reuse it unless the detach looks deliberate.

**Components** — your widgets per `codeconnect.local.json`; Figma `props` → constructor params.

**Interactions & motion** — `reactions` navigate → `go_router` `context.go/push` (or `Navigator`); overlay →
`showModalBottomSheet`/`showDialog`. `transition.duration` SECONDS → `Duration(milliseconds:)`;
`cubicBezier` → `Cubic(x1,y1,x2,y2)`; `spring` → `SpringDescription(mass:, stiffness:, damping:)`. Honor
`MediaQuery.disableAnimationsOf`.

**Vector fallback** — `geometry` (`fills`/`strokes` SVG path `d` strings, `w`/`h`) → `CustomPaint` with
`parseSvgPathData` (path_drawing) in a `0 0 w h` space.

**Units** — logical pixels, plain `double`s.

**Assets** — SVG → `flutter_svg` `SvgPicture.asset`; PNG → `assets/images/` with `2.0x/`/`3.0x/` variant
folders, declared in `pubspec.yaml`. Flag anything the user must add.

**Output** — one `StatelessWidget`/`StatefulWidget` per screen (`.dart`) under `outputDir`; suggest a golden
test (`matchesGoldenFile`) for visual checking.
