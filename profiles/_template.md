# Profile: <name>  (copy this file to profiles/<name>.md and set `profile` in design/target.json)

Describe how to translate the neutral export IR into this stack. Keep it short and concrete.

**Layout (IR → ?)** — map each field:
- `display:flex` / `flexDirection` (row|column) → your container + direction construct.
- `gap:N`, `flexWrap` → your spacing/wrap mechanism.
- `padding:[top,right,bottom,left]` → your padding syntax.
- `justifyContent`, `alignItems` → your main/cross-axis alignment.
- `widthMode`/`heightMode` (`fill`|`hug`|`fixed`) → stretch / content-sized / fixed.
- `layout.mode:"absolute"` → infer a flow layout; do NOT hardcode coordinates.

**Units** — the unit and whether values carry a suffix.

**Tokens** — what form the right-hand value in `tokens.json` takes for this stack (CSS var, class,
Swift/Kotlin constant, theme reference) and how to emit it.

**Components** — how to import and instantiate from `components.json`, and how Figma `props` map.

**Text** — element/widget + how `font.size/weight/lineHeight` map to the type scale.

**Assets** — how to consume `design/assets/*` (SVG/PNG), including any conversion the user must do.

**Output** — file type, one-screen-per-what, where under `outputDir`, any preview/boilerplate.
