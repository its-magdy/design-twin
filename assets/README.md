# Design Twin brand assets

The mark is **Bo**: a selection box with a face. It is the box with four handles that every design tool draws
around what you picked, plus two eyes. The same drawing is the logo, the 16 px icon in the Figma plugin, the
sprite in `dtwin --version`, and the companion character.

## Files

| File | Use |
| --- | --- |
| `logo.svg` | The mark. The frame and eyes are `currentColor`, so use it inline, where it takes the text colour. In an `<img>`, `currentColor` turns black, so use one of the two files below instead. |
| `logo-light.svg` / `logo-dark.svg` | The mark for light / dark backgrounds (ink `#16141f` / `#ffffff`). |
| `logo-16.svg` | The mark drawn on a 16 px grid, crisp at exactly 16 px (the plugin window uses it inline). Use it for anything 16–23 px. |
| `wordmark-light.svg` / `wordmark-dark.svg` | The mark plus "Design Twin", with the text converted to outlines (Inter Bold). The README header uses them in a `<picture>`. |
| `wordmark-light.png` | The light wordmark as a PNG, for places that show neither SVG nor `<picture>`. The npm page uses it. |
| `avatar.svg` / `avatar-512.png` | A square avatar for GitHub, npm or Discord. The mark sits inside the circle those sites crop to. `claude-plugin/.claude-plugin/icon.png` is a copy: the Claude Code plugin's icon. |
| `social-preview.svg` / `social-preview.png` | GitHub's social preview, 1280×640. Upload the PNG in the repo's Settings → General → Social preview. |
| `bo.svg` | Bo, the character (hello pose). |
| `bo-states.svg` | Bo's states: hello, reading, drawing, matched, off. |

## Colour

| | Hex | Where |
| --- | --- | --- |
| Selection magenta | `#d6409f` | The four handles, and nothing else in the mark. |
| Ink, light background | `#16141f` | Frame and eyes. |
| Ink, dark background | `#ffffff` | Frame and eyes. |
| Terminal magenta | `#e05aaf` | The CLI sprite: slightly lighter so it holds up on dark terminals (256-colour 169, 16-colour bright magenta). |

Magenta clears 3:1 contrast against white (4.1), `#16141f` (4.4) and Figma's dark `#2c2c2c` (3.4).

## Size and clear space

- **Minimum size:** 16 px, and only with `logo-16.svg`. The other files need at least 24 px. The wordmark needs at
  least 24 px of height.
- **Bo's expressions** (the `bo-states.svg` faces) need at least 24 px. Below that, use the plain mark.
- **Clear space:** keep at least one handle's width (3/16 of the mark's size) empty on every side.

## Do

- Keep Bo **hollow**: the box is a selection, not a block.
- Keep all **four handles**, in magenta (or in the ink colour in a one-colour version).
- Show expressions with the **eyes only**: their shape, or what sits inside or beside the box.

## Don't

- Don't fill the body, drop or move a handle, or add a mouth, arms or legs.
- Don't put Bo next to Claude Code's figure, or draw it in Claude's terracotta.
- **Don't use magenta for errors, warnings or any status.** It reads close to danger red for many colour-blind
  people, and it is the brand colour, not a signal.
- Don't recolour, stretch, rotate or outline the mark, and don't put it on a background where the ink is below 3:1
  contrast.

## Licence

The assets are licensed under [MIT](../LICENSE), like the rest of the repository. The wordmark's letterforms are
outlined from [Inter](https://rsms.me/inter/) (SIL Open Font License 1.1), which allows this. Please don't use the
mark in a way that suggests the project endorses you or your product.
