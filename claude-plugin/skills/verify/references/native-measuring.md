# Measuring by hand — native stacks, and anything the probe does not read

On web the shipped probe matches every node and reads every key; this file is for a native stack (iOS, Android,
React Native, Flutter), where the verifier finds and reads each node itself, and for any value it reads by hand on
web (a pressed state, a `note`). The visual-verifier agent reads it on a native stack.

## Contents
- Finding the element
- The canonical keys
- Traps that produced fabricated defects
- The measured file on a native stack

## Finding the element

For each row in `expected.json`, find the element and read its computed style. Two ways to find it, in this order:

1. **The stack's tag** — `accessibilityIdentifier` on iOS, `testTag` on Compose, `Semantics(identifier:)` on
   Flutter, carrying the figma node id. When it is there, matching is exact. Check it is on the element that
   IMPLEMENTS the node, not an inner leaf.
2. Otherwise match structurally and say so (`"matchedBy": "text"` / `"position"`): the row's `text` where it is
   unique, then role + position. A designed list rendered by one loop: measure designed row *i* on rendered row
   *i*, reported under the designed row's id. Record everything you could not find — an unfound node becomes
   `notMeasured`, which blocks the pass, and that is correct.

## The canonical keys

Read numbers; do not eyeball them. **Use the canonical keys — `measuredKeys` in the expectation lists them; a
differently-named key is not read, and the report's headline will say that field was present in 0 measurements.**
The web column of this table is what the probe reads; use it as the reference for a native stack's equivalent:

| key | read it as |
|---|---|
| `fontFamily` `fontSize` `fontWeight` `lineHeight` `letterSpacing` `color` `backgroundColor` `borderColor` `borderWidth` `opacity` | `getComputedStyle(el)` — colours as `rgb()`/`rgba()`, as-is; the comparison normalises them |
| `borderRadius` | a number, or `[tl, tr, br, bl]` from `borderTopLeftRadius…` — never `radius` |
| `padding` | `[top, right, bottom, left]` |
| `gap` / `gapVisual` | CSS `gap`; **and** `gapVisual`, the rendered distance between consecutive children, wherever CSS gap is not what spaces them (a `<table>` uses `border-spacing`) |
| `width` `height` `x` `y` | `el.getBoundingClientRect()`, with `x`/`y` **minus the frame element's rect** (frame-relative — see `coordinates`) |
| `textBox` | for every TEXT node: `{x, w}` of a `Range` over its characters, frame-relative — a TEXT node's x and width are compared from `textBox` only (the element's box is not the text's: a padded `<th>`, `<button>` or `<label>`, a fixed-width block); without it they are not measured |
| `text` | the element's `textContent` — **even when it has child elements** (a `<th>` with a sort caret still has text; skipping it hid every such string). A form control shows its **value**, not its children: `el.value` for an `<input>` (text-like types and a button's label) or a `<textarea>` (its child text is only the default, stale once typed in), the selected option's text for a `<select>` (its `textContent` is every option's) — never its placeholder; a password, date or list-box control is not measured as a string (null + why) |
| `fill` | for an SVG/vector node: `getComputedStyle(<path/rect/circle>).fill` — an SVG's colour is never `background-color` |
| `placeholderText` / `placeholderColor` | for a placeholder spec (`placeholder: true`): `el.placeholder`, and `getComputedStyle(el, '::placeholder').color` or the stylesheet rule — `textContent` of an empty input is `""` |
| `tag` | `el.tagName.toLowerCase()` — lets the comparison route table rows, containers and leaves correctly |
| `paintedBy` | optional, inside `styles`: when the element's own `backgroundColor` is transparent, `{backgroundColor, via: "ancestor"\|"child", tag, depth}` of the nearest containing ancestor (or same-box child) that paints — a hovered `<tr>` paints through its transparent `<td>`s; `--compare` then compares that colour and says so |
| `textTransform` | optional: the computed `text-transform` of a TEXT element — a designed upper/lower/title case is compared against the rendered string, so a CSS `uppercase` is not a copy bug |
| `states.<hover\|pressed\|focus>` | the same styles **with the element in that state** — required for every spec carrying `drawnState` (the designer drew that row hovered; measuring it at rest reports a colour bug that is not there). It sits **beside** `styles` on the node (`nodes[].states`), never inside it — a `states` key inside `styles` is listed as an unknown key and never read — and only for a spec with `drawnState`: a state measured on a node the design never drew in that state is not compared, only listed under "Inferred, not designed" |

## Traps that produced fabricated defects

Check these before you call anything wrong:

- **`rotate` is not `transform`.** Tailwind v4's `rotate-180` sets the CSS `rotate` property;
  `getComputedStyle(el).transform` reads `none` while `.rotate` reads `180deg`. Read both.
- **`::placeholder`** is a pseudo-element: `getComputedStyle(el).color` is the typed-text colour.
- **`border-spacing` vs `gap`**: rows of a `<table>` are spaced by `border-spacing`; measure the distance between
  rows (`gapVisual`).
- **Auto-layout slack**: a Figma `gap` in a `space-between` row, or next to a child that fills the row, is not a gap
  (the expectation lists these under `notComparable` — leave them as they are).
- **Fully rounded**: a design radius of 500 on a 36px box and `rounded-full` (33554400px) are the same circle; the
  comparison clamps both to half the shorter side.
- **A TEXT node's id on its `<th>`**: the cell's box includes padding; report `textBox`.
- **A stroke drawn as a ring or an outline**: Tailwind `ring` / `inset-ring` is a `box-shadow: 0 0 0 Npx` (v4 always
  computes five shadows, the unused ones transparent — find the ring by its content, never by its position in the
  list), and `outline` with `outline-offset: -Npx` is an inside stroke (`-N/2px`: a centre stroke, straddling the edge).
  Report it as `borderWidth` / `borderColor` with `strokeFrom` (`box-shadow` | `outline`) and `strokeAlign` (`inside` |
  `outside` | `center`), as the probe does —
  `border-width: 0` alone is not a missing stroke.

## The measured file on a native stack

Put `expectationSha256` (the sha256 of the `.expected.json` you measured against — `shasum -a 256`) at the top level,
so a report can never be read against a newer expectation than it was measured on. The file names no run: write it
before sending `--status <Layer>__<id> --phase measured --run <id>`, which records its sha256 in your run — that record is
what ties it to the run (`--compare` judges a measured file that names no run by the run whose status is beside it,
and a file that run did not record is `incomplete`). On a native stack everything —
nodes, components, interactions — goes in `design/verify/<Layer>__<id>.measured.json` (on web the probe writes
`measured.json` and your rows go in the staged evidence file):

```json
{"measuredAt": "<ISO from `date -u`>", "renderer": "playwright-chromium", "viewport": "1440x1236",
 "expectationSha256": "<shasum -a 256 design/verify/<Layer>__<id>.expected.json>",
 "artifacts": ["design/verify/<Layer>__<id>.png"],
 "nodes": [{"nodeId": "4210:1873", "styles": {"tag": "span", "fontSize": 20, "fontWeight": 600,
            "color": "rgb(3,213,171)", "backgroundColor": "rgba(0,0,0,0)", "borderRadius": 100,
            "x": 304, "y": 80, "width": 148, "height": 28, "text": "Active"}},
           {"nodeId": "18580:60874", "styles": {"tag": "tr", "backgroundColor": "rgb(29,29,31)"},
            "states": {"hover": {"backgroundColor": "rgb(70,70,79)"}}}],
 "components": [{"setName": "Button"}, {"setName": "Pagination"}],
 "interactions": [{"nodeId": "I4210:1901;72:3440", "trigger": "on_click", "ok": true,
                   "selector": "[data-dt-node=\"I4210:1901;72:3440\"]", "selectorCount": 1,
                   "outcome": "dialog-opened", "navEvents": 0,
                   "detail": "opened the Add Item overlay"}],
 "notes": ["the build reloaded between the first and second capture — <file> changed"]}
```
