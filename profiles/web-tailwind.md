# Profile: web-tailwind (React + Tailwind CSS)

**Layout (IR → Tailwind classes)**
- `display:flex` → `flex`; `flexDirection:"column"` → `flex-col` (row is default).
- `gap:N` → nearest scale (`gap-2` ≈ 8px) or `gap-[Npx]`; `flexWrap:"wrap"` → `flex-wrap`.
- `padding:[t,r,b,l]` → `pt-/pr-/pb-/pl-`; collapse to `px-`/`py-`/`p-` when symmetric.
- `justifyContent` → `justify-start|center|end|between`; `alignItems` → `items-start|center|end`.
- `widthMode:"fill"` → `flex-1`/`w-full`; `"hug"` → `w-auto`; `"fixed"` → `w-[Npx]` (avoid if possible).

**Tokens** — the right-hand value in `tokens.json` is a Tailwind class (e.g. `bg-primary`, `text-body`,
`rounded-md`). Emit it in `className`. If no class exists, use arbitrary value `bg-[var(--color-primary)]`.

**Components** — import per `components.json`; pass Figma `props` through to component props.

**Text** — element + Tailwind type classes; map `font.size/weight` to your `text-*`/`font-*` scale.

**Assets** — `<img src>` for PNG; inline the SVG or an `<Icon/>` for vectors.

**Output** — React function components (`.tsx`), one screen per file under `outputDir`, colocate helpers.
