# Profile: swiftui (iOS / SwiftUI)

## Contents
Layout · Grid · Scroll/clip/sticky · Theming · Vector fallback · Units · Tokens · Components · Text ·
Assets · Idiomatic iOS (system patterns by structure) · HIG semantic colors · Dynamic Type · Shapes,
corners & aspect · Multi-screen navigation · SF Symbols · Native controls · Don't double-inset ·
Interactions · Text metrics · Effects · Strokes · Fills & images · Safe area & insets ·
Accessibility & RTL · Accessibility naming · Motion · Assets (detail) · Fit the existing app ·
Output

**Layout (IR → stacks)**
- `flexDirection:"row"` → `HStack`; `"column"` → `VStack`.
- `gap:N` → `HStack(spacing: N)` / `VStack(spacing: N)`.
- `padding:[t,r,b,l]` → `.padding(EdgeInsets(top: t, leading: l, bottom: b, trailing: r))`. The
  left→`leading` / right→`trailing` mapping is **deliberate**: Figma's insets are physical, SwiftUI's are
  directional, so this is what mirrors the layout under RTL. Only use `.padding(.leading, …)` — never
  reach for a physical-left equivalent.
- `justifyContent:"center"` → center in stack (add `Spacer()`s or set frame alignment);
  `"space-between"` → `Spacer()` between children.
- `alignItems` → the stack's `alignment:` argument (`.leading/.center/.trailing`);
  `"baseline"` → `HStack(alignment: .firstTextBaseline)`.
- `widthMode:"fill"` → `.frame(maxWidth: .infinity)`; `"hug"` → natural size; `"fixed"` → `.frame(width: N)`.

**Grid (`layout.display:"grid"`).** Pick the container by whether any child spans:
- **No spans** → `LazyVGrid`/`LazyHGrid`. `columns`/`columnSizes` (per-track `{type:"flex"|"fixed"|"hug",
  value}`) → a `[GridItem]` array: `flex`→`GridItem(.flexible())`, `fixed`→`GridItem(.fixed(value))`,
  `hug`→`GridItem(.adaptive(minimum:...))`; `columnGap`/`rowGap` → `GridItem(spacing:)`/the grid's `spacing:`.
- **Any `gridColumnSpan`/`gridRowSpan` > 1** → the eager `Grid`/`GridRow` (iOS 16+), one `GridRow` per row,
  and `.gridCellColumns(N)` on the spanning child. Lazy grids have **no** span mechanism — `gridCellColumns`
  is a `Grid`/`GridRow`-only modifier and is ignored inside a `LazyVGrid`. Use lazy grids only for uniform,
  long, scrolling content.
- `gridJustifySelf`/`gridAlignSelf` → the item's `.gridColumnAlignment` (`Grid`) / frame alignment.

**Scroll, clip & sticky** — `clip:true` → `.clipped()`; `layout.scroll` → `ScrollView` (`.horizontal` when
`"horizontal"`). `fixedChildren` **if present** (count of leading children pinned while the rest scrolls)
→ a `LazyVStack(pinnedViews: [.sectionHeaders])` with those children in a `Section(header:)`, or keep them
outside the `ScrollView` entirely as a fixed header/footer `View`.

**Theming (`resolvedModes`/`variableModes`)** — `resolvedModes` (root) names the effective color scheme
(Light/Dark) this export represents; if a subtree carries its own `variableModes`, force that scheme on it
with `.preferredColorScheme(_)` or by reading that mode's asset-catalog variant explicitly, rather than
trusting the ambient `colorScheme` environment value.

**Vector fallback** — a `geometry` field (`fills`/`strokes`: arrays of SVG path `d` strings, plus `w`/`h`)
appears on a vector node whose SVG export failed. Render it with SwiftUI `Path { ... }` in a `0 0 w h`
coordinate space rather than a bitmap `Image` — there is no asset file for that node.

**Units** — `CGFloat` points, no `px`.

**Tokens** — the right-hand value in `tokens.json` is a Swift reference (e.g. `Color("Primary")` from an
asset catalog, or `Theme.spacing.md`). Emit these, not literals.

**Components** — your SwiftUI `View`s per `design/codeconnect.local.json`; pass Figma `props` via init params/modifiers.

**Text** — `Text(...)` with `.font(...)`; map `font.size/weight` to your type scale.

**Assets** — SVG usually needs importing into the Xcode asset catalog (as a PDF/vector) → `Image("name")`;
PNG → `Image("name")`. Flag any asset the user must add to the catalog.
A path-heavy SVG (see `references/export-layout.md`, heavy vector assets) is the case to
watch: the catalog keeps it as a vector and Core Graphics redraws every path on each resize, so a few
thousand paths stutter on scroll. Ask for a raster re-export rather than importing it as a vector.

**Idiomatic iOS — recognize system patterns by STRUCTURE, not node name.** Upgrade generic flex
intent to native containers; a name like "Grouped Table View" is a hint, never the decision.
- A vertical stack of similar rows → `List`/`Form`, **never** `VStack { Row(); Divider() }` (that throws
  away separators, insets, grouped background, swipe/selection/scrolling). Rounded grouped cards in
  sections → `List { Section {…} }.listStyle(.insetGrouped)`; labeled inputs/toggles/pickers → `Form`;
  edge-to-edge hairline rows → `.listStyle(.plain)` (make `.plain` explicit inside a `NavigationStack`).
- Row = leading icon + label + trailing chevron → `NavigationLink` inside `List`. Vertically scrolled
  card stack → `ScrollView { LazyVStack {…} }`; horizontal → `ScrollView(.horizontal) { LazyHStack {…} }`.
- Top bar (back chevron + centered title + trailing action) → `NavigationStack` chrome:
  `.navigationTitle(_)` + `.toolbar { ToolbarItem(placement:.topBarTrailing){…} }`. Bottom bar of 4–5
  icon+label pairs → `TabView` with one `Tab(…)` per destination.

**HIG semantic colors (free dark mode).** Map semantic token paths to system colors, don't emit RGBA:
`backgrounds/primary`→`Color(.systemBackground)`, `backgrounds/secondary`→`Color(.secondarySystemBackground)`,
`labels/primary`→`Color.primary`, `labels/secondary`→`Color.secondary`, `separators/*`→`Color(.separator)`.
A **custom brand** variable (`--brand-blue`) → a named Asset-Catalog color set `Color("BrandBlue")` with the
exact value — never remap a brand color to a system color, and never hardcode `.black`/`.white` for a bg.

**Dynamic Type fonts by NAME, not px.** `Large Title`→`.largeTitle`, `Title/1/2/3`→`.title/.title2/.title3`,
`Headline`→`.headline`, `Subheadline`→`.subheadline`, `Body`→`.body`, `Callout`→`.callout`,
`Footnote`→`.footnote`, `Caption/1/2`→`.caption/.caption2`; `/Emphasized` adds `.fontWeight(.semibold)`.
Map `fontName.style` (IR carries it verbatim) → weight (`Semibold`→`.semibold`, `Medium`→`.medium`,
`Regular`→`.regular`) AND, stacked on top, the width axis (`Expanded/Condensed/Compressed` → `.fontWidth(...)`)
— don't silently drop width; `SF Pro Rounded` → `.system(…, design: .rounded)`, not `.custom`. Flag non-SF
fonts (Inter/Roboto) and ask before substituting; keep Dynamic Type via `.custom(_:size:relativeTo:)`.

**Shapes, corners & aspect.** A node with `cornerSmoothing` (squircle) → `RoundedRectangle(cornerRadius:_, style: .continuous)`,
NOT the default `.circular` — this is the iOS-native corner and the reason Figma emits the field. Uniform `radius`
on a filled/stroked container → `.clipShape(RoundedRectangle(cornerRadius:_, style: .continuous))`; per-corner
`radius:{tl,tr,br,bl}` → `UnevenRoundedRectangle(...)`. A node with `aspectRatio` (locked ratio) → `.aspectRatio(_, contentMode:)`.
`maskType` → `.mask { … }` (alpha/luminance) vs `.clipShape` (vector). An `overlay` node (modal/popover) → `.sheet`/`.popover`
content; `overlay.closeOnClickOutside` is the default interactive-dismiss, `overlay.background` a scrim behind it.

**Multi-screen: scaffold navigation FIRST.** For a file with several screens, stub each screen + wire the
`NavigationStack`/`TabView` routing + define sample data once *before* laying out any single screen. A
frame named `Sheet`/`Modal`/`Popover` encodes its presentation → build it as `.sheet` content with a dismiss
control. A "+"/"Add"/edit affordance implies **building its create/edit destination** (often a `Form` in a
`.sheet`) — wire it, don't leave a TODO. A stack of rotated rectangles/ellipses forming a graph → Swift
Charts (`LineMark`/`BarMark`), not transliterated shapes.

**SF Symbols by name** → `Image(systemName:)`; never guess a glyph from the screenshot or map codepoints.

**Native controls, not rebuilt ones** — Segmented→`Picker(...).pickerStyle(.segmented)`, Toggle/Switch→`Toggle`,
Slider→`Slider`, Stepper→`Stepper`, Menu/Picker→`Picker`, Spinner/Progress→`ProgressView`, `TextField`→`TextField`.

**Don't double-inset.** `List`/`Form`/`NavigationStack`/toolbars + the safe area already pad to platform
standard — if a Figma edge inset is ~16pt or the standard row inset, omit the modifier. Prefer `.padding()`.

**Interactions (from IR `reactions`)** — `on_click`/`on_press` + `navigate` → `NavigationLink`/`Button`;
`overlay` → `.sheet`/`.fullScreenCover`; `after_timeout` → `.task { try? await Task.sleep(…) }`. Transitions:
`smart_animate` → `matchedGeometryEffect` + `withAnimation`; `move_in`/`slide_in`+direction → `.transition(.move(edge:))`;
easing `custom_cubic_bezier` → `.timingCurve(...)`, spring → `.spring(...)` (never approximate a spring as a bezier).
Always honor Reduce Motion.

**Text metrics** — custom fonts `.custom(name, size:, relativeTo:)`; spacing tied to text → `@ScaledMetric`.
AX sizes reach ~310%: reflow `HStack`→`VStack` when `dynamicTypeSize.isAccessibilitySize`. `font.letterSpacing`
`percent` → `.tracking(pct/100*size)`, `px` → `.tracking(px)` (tracking, not kerning; SF has automatic
tracking — usually omit). `font.lineHeight` (call the Figma value LH; `percent` → LH = size*pct/100; `auto` → omit): iOS 26+
`.lineHeight(...)`; earlier `.lineSpacing(LH − natural)` + vertical padding of half that to recover
Figma's outer half-leading, where **natural is the rendered font's own line height —
`UIFont.lineHeight`, NOT the IR field** (SF 16pt ≈ 19.1, so LH 24 → `.lineSpacing(4.9)`; subtracting
the IR value from itself gives 0 and the text renders too tight). UIKit exact: `NSParagraphStyle`
`minimumLineHeight` = `maximumLineHeight` = LH, plus `baselineOffset` = (LH − natural)/4.

**Effects** — `.shadow(color:radius:x:y:)` has no spread; Figma blur radius ≈ 2× SwiftUI/CALayer
`shadowRadius` (community-derived — tune by eye). Put it on a background shape, `.compositingGroup()` to
avoid shadowing every child; UIKit: set `shadowPath`. `background_blur` → `.background(.ultraThinMaterial)`
family; `glass` → iOS 26 `.glassEffect`. `rotation` is DEGREES, Figma positive = counter-clockwise →
`.rotationEffect(.degrees(-rotation))`.

**Strokes** — `align:"inside"` → `.strokeBorder`, `"center"` → `.stroke`, `"outside"` → `.overlay` of a
stroke with `.padding(-w/2)`. `dash` → `StrokeStyle(lineWidth:, dash:)`; per-side `weights` → edge overlays.

**Fills & images** — gradients → `LinearGradient`/`RadialGradient`/`AngularGradient` (points from
`transform`); diamond → asset. Image `scaleMode` `fill` → `.scaledToFill()` + `.clipped()`, `fit` →
`.scaledToFit()`, `tile` → `Image("name").resizable(resizingMode: .tile)` (it's a modifier on `Image`,
not an `Image` initializer). Hex is 8-bit sRGB; display-p3 files →
`Color(.displayP3, red:green:blue:opacity:)`.

**Safe area & insets** — never build a fake status bar/home-indicator frame; SwiftUI respects the safe
area, backgrounds `.ignoresSafeArea()`; keyboard avoidance is automatic.

**Accessibility & RTL** — touch target 44×44pt (`.frame(minWidth:44, minHeight:44)` + `.contentShape`).
Use leading/trailing (padding is PHYSICAL `[t,r,b,l]`); directional images
`.flipsForRightToLeftLayoutDirection(true)`.

**Accessibility naming (do this, don't just "add semantics")**
- Native controls (`Button`, `Toggle`, `NavigationLink`) carry their label already — don't re-label them.
- Icon-only control → `.accessibilityLabel("Close")`; an SF Symbol name is not a label.
- Decorative shape/image/divider → `.accessibilityHidden(true)`, never an empty label.
- A card/row of several `Text`s VoiceOver should read as one item →
  `.accessibilityElement(children: .combine)` (or `.ignore` + your own label).
- Roles/traits Figma implies but SwiftUI can't infer → `.accessibilityAddTraits(.isHeader)` on section
  titles, `.isButton` on a tappable non-`Button` (and prefer making it a real `Button`).
- Live/changing values → `.accessibilityValue(_)`; group state → `.accessibilityAddTraits(.isSelected)`.

**Motion** — `transition.duration` is SECONDS; `easing.cubicBezier` → `.timingCurve(x1,y1,x2,y2,
duration:)`; `spring` → `.spring(...)` / `Spring(mass:stiffness:damping:)`.

**Assets (detail)** — PDF/SVG with "Preserve Vector Data", @2x/@3x rasters, SF Symbols where they match.

**Fit the existing app (detect before you emit)** — the screen lands in a codebase with conventions; a
generated screen that ignores them is rejected in review however well it matches the design.
- *Strings.* Never ship `Text("Delete")` as a bare literal in a localised app. Check for a String Catalog
  (`Localizable.xcstrings`) or `.strings`: with one, `Text("delete_action")` / `String(localized:)` using
  the project's key style, and add the entry; the same for `.accessibilityLabel(...)`, alerts and
  placeholders. User data and numbers are `Text(verbatim:)`. No catalog at all → literals are fine; say so.
- *Navigation.* Find how screens are presented (an existing `NavigationStack` + `navigationDestination`
  or path/enum router, a coordinator, TCA, a UIKit host) and plug into it. A screen that is pushed must
  NOT create its own `NavigationStack` (double nav bar). Expose taps as closures (`onClose: () -> Void`)
  or the project's route type; the rules above describe the chrome, not who owns the stack.
- *State & data.* Match what neighbouring screens use — `@Observable` (iOS 17+) or `ObservableObject`,
  where view models live, how dependencies arrive (init injection, `@Environment`). No business logic,
  networking or singleton access in the `View`; `#Preview` runs on injected sample data.
- *Colors: one source of truth.* A value bound to a Figma variable → the project's token for it (its
  asset-catalog color, its theme type, or the generated `DesignTokens.swift`). The HIG semantic colors
  above are for values with NO token that are plainly system chrome — never replace a brand token with
  `Color(.systemBackground)` because the hex is close.
- *Deployment target.* Read it (`IPHONEOS_DEPLOYMENT_TARGET` / `Package.swift` `platforms`) before using
  an API this file marks with an iOS version.

**Output** — a `View` struct per screen (`.swift`) under `outputDir`, with a `#Preview`.
