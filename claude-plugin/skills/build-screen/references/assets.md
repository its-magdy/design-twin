# Using the exported assets — `heavy`, `monochrome`, `duplicates`

Build-screen step 3 imports only the files THIS screen's `.assets.json` lists. That file also says three things the
files themselves do not; this is what each one changes in the code. (Where the files are and why some SVGs arrive
as thousands of paths is `export-layout.md`.)

- **`heavy`** — faithfully exported and still unusable inline: a flattened noise texture arrives
  as thousands of paths and bloats the bundle. Import it by URL and
  ask the designer to re-export as a PNG (an `embeddedRaster` row with few `paths` is a raster inside an SVG shell: use
  it as an image, there are no paths to simplify). Leave its artwork as exported — no redraw, simplification
  or cover-up in your code.
- **`monochrome`** — every fill and stroke in that SVG is one colour, so its colour is thematic,
  not semantic. Figma exports the frame as it LOOKS, which means a glyph taken from a Dark frame
  has `stroke="#D4D4D4"` baked in and cannot serve a Light theme. Leave the asset file as it is (the
  producer owns that file and a re-pull overwrites it) and draw nothing new: swap `fill`/`stroke`
  for `currentColor` **at render time** in one shared icon wrapper, and let the colour come from
  the token on the parent. A tint drawn as a CSS mask (`background: currentColor` plus `mask-image`) vanishes
  under forced colours: add `forced-color-adjust: none`, or `background-color: CanvasText` under
  `@media (forced-colors: active)`; an inline SVG with `fill="currentColor"` needs nothing. A glyph NOT in that list — a red trash, a green tick, a brand mark —
  carries meaning in its colour, so leave it alone and give the wrapper an opt-out for it.
- **`duplicates`** — the same artwork under different names. Import one.
