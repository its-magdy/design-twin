# Profile: web-css-modules (React + CSS Modules)

**Layout (IR → CSS in `<screen>.module.css`)**
- `display:flex` → `display:flex`; `flexDirection` → `flex-direction`.
- `gap:N` → `gap:Npx`; `flexWrap:"wrap"` → `flex-wrap:wrap`.
- `padding:[t,r,b,l]` → `padding: t r b l` (px).
- `justifyContent` → `justify-content`; `alignItems` → `align-items`.
- `widthMode:"fill"` → `flex:1` or `width:100%`; `"hug"` → `width:auto`/omit; `"fixed"` → `width:Npx` (avoid if possible).

**Tokens** — the right-hand value in `tokens.json` is a CSS custom property (e.g. `var(--color-primary)`).
Use it inside the module CSS (`color: var(--color-text)`), not inline literals.

**Components** — import per `components.json`; `className={styles.x}`; pass Figma `props` through.

**Text** — semantic element + a CSS class using type-scale custom properties.

**Assets** — `<img src>` for PNG; inline `<svg>` or an icon component for vectors.

**Output** — React function component `.tsx` + colocated `.module.css`, one screen per folder under `outputDir`.
