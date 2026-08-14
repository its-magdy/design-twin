# Profile: swiftui (iOS / SwiftUI)

**Layout (IR → stacks)**
- `flexDirection:"row"` → `HStack`; `"column"` → `VStack`.
- `gap:N` → `HStack(spacing: N)` / `VStack(spacing: N)`.
- `padding:[t,r,b,l]` → `.padding(EdgeInsets(top: t, leading: l, bottom: b, trailing: r))`.
- `justifyContent:"center"` → center in stack (add `Spacer()`s or set frame alignment);
  `"space-between"` → `Spacer()` between children.
- `alignItems` → the stack's `alignment:` argument (`.leading/.center/.trailing`).
- `widthMode:"fill"` → `.frame(maxWidth: .infinity)`; `"hug"` → natural size; `"fixed"` → `.frame(width: N)`.

**Grid (`layout.display:"grid"`) → `LazyVGrid`/`LazyHGrid`.** `columns`/`columnSizes` (per-track
`{type:"flex"|"fixed"|"hug", value}`) → a `[GridItem]` array: `flex`→`GridItem(.flexible())`,
`fixed`→`GridItem(.fixed(value))`, `hug`→`GridItem(.adaptive(minimum:...))`; `columnGap`/`rowGap` →
`GridItem(spacing:)`/the grid's `spacing:`. `gridColumnSpan`/`gridRowSpan` → wrap that child in
`.gridCellColumns(N)` (iOS 16+). `gridJustifySelf`/`gridAlignSelf` → the item's `.gridColumnAlignment`/
frame alignment.

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

**Components** — your SwiftUI `View`s per `components.json`; pass Figma `props` via init params/modifiers.

**Text** — `Text(...)` with `.font(...)`; map `font.size/weight` to your type scale.

**Assets** — SVG usually needs importing into the Xcode asset catalog (as a PDF/vector) → `Image("name")`;
PNG → `Image("name")`. Flag any asset the user must add to the catalog.

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

**Output** — a `View` struct per screen (`.swift`) under `outputDir`, with a `#Preview`.
