# `figma_write` grammar

The whole write surface as the MCP server and the plugin check it. Inside a tree spec node (and its `layout`, `font`,
`strokes`, `box`, `radius`, `sizeLimits`, `renderBox`, paints, `tokens`, `styles`), a copy, a patch's `set`, a
`setStyle`'s `set` (and its effects) and a variable value, a field not listed here is refused by name with the closest
names, never dropped. The op object itself is looser: a field an op does not read (a typo beside `op`, `nodeId` on a
`createTree`) is ignored, not refused — so check the op's own field names against [The ops](#the-ops). Keys you name
yourself (`props` property names, `edits` layer names, `values` modes, `handle`s, `fragments`) are checked against the
file or the spec instead. A hex colour is `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`, with the `#`.

## Contents

- [The call](#the-call) · [The ops](#the-ops) · [Replies](#replies)
- [Tree spec (`createTree`)](#tree-spec-createtree) · [Design-system references](#design-system-references)
- [Copies, rows, fragments](#copies-rows-fragments) · [Keyed re-send](#keyed-re-send) · [Spec from disk](#spec-from-disk)
- [Patch](#patch) · [Source edits](#source-edits) · [Variable modes](#variable-modes) · [Move and delete](#move-and-delete)
- [What a write cannot set yet](#what-a-write-cannot-set-yet) · [Limits](#limits)

## The call

`figma_write {ops: [...], dryRun?, client?}` — `ops` in order, at most 50; `dryRun: true` previews without touching
the file; `client` names the file when several are connected (a connId, fileKey or part of the file name).

## The ops

| `op` | Required | Optional |
|---|---|---|
| `createTree` | `tree` (a spec, below) or `treeFile` (a path to the same spec as JSON) | `page` (a page's exact name or id; the current page by default) |
| `patch` | `nodeId`, `set` (the fields to change) | — |
| `setVariable` | `variable` (a local variable's exact name, key or id), and `values` (mode name or modeId → value) or `value` (a one-mode collection) | — |
| `setStyle` | `style` (a local paint, text or effect style's exact name, key or id), `set` | — |
| `setVariableMode` | `nodeId`, `collection`, `mode` | — |
| `clearVariableMode` | `nodeId`, `collection` | — |
| `move` | `nodeId`, `parentId` | `index` (0 first; last when absent) |
| `delete` | `nodeId` | — |
| `createFrame` | — | `parentId`, `name`, `width` + `height` (both or neither), `layoutMode` (`HORIZONTAL` \| `VERTICAL`), `itemSpacing`, `padding` (`[t, r, b, l]`), `fill` (hex) |
| `createText` | `text` | `parentId`, `fontSize`, `fill` (hex) |
| `setFill` | `nodeId`, `color` (hex) | — |
| `setText` | `nodeId`, `text` | — |

The last four are the first ops `figma_write` had, one node per op; a `createTree` or a `patch` does the same in fewer
calls and can bind variables. A create with no `parentId` lands on the current page.

## Replies

- A batch that landed: `{ok: true, applied: [...], warnings?}`, one entry per op.
  - `createTree`: `{id, created: {frames, texts, instances?, clones?}, handles?, unbound?}`; `handles` maps each
    `handle` to its node's id, and `unbound` counts raw colours, spacing, radii and stroke weights where a variable
    could stand, and texts with no text style.
  - a keyed re-send: `{id, key, changed?: [{id, handle?, fields}], created?, removed?, reordered?, handles?}`, or
    `{id, key, unchanged: true}`.
  - `patch` `{id, unbound?}` · `setVariable` `{id, modes}` · `setStyle` `{id}` · a mode op names the `collection` and
    the mode `from` → `to` (`inherited` when none is set) · `move` `{id, parentId}` · `delete` `{id, deleted: true}`.
- Refused whole, nothing changed (bar a library item already imported for it, which stays): an error saying why (Allow
  edits off, rejected with the designer's reason, nobody reviewed it, Dev Mode, or every problem of the batch with its
  path and up to three candidates).
- Failed partway: `Write failed at op N`, with what was put back (`restored`) and what stays (`applied`). Not all of it
  may come back: with Allow edits turned off mid-batch nothing is put back; a value that cannot be restored is named in
  the error; a node already deleted stays deleted; an imported library item stays, and is not listed in `applied`.
  Read `applied` before a retry, so nothing is made twice.
- A dry run: `{dryRun: true, creates, overwrites, moves?, deletes?, invalid, refusedByFile?, steps, editsAllowed,
  reviewWrites?, note}`; each step has `effect`, `target`, a one-sentence `change`, `fields` (one row per field of a
  patch or a style), `warnings`, `invalid` (every problem), and for a source edit `affects` and `refusedByFile`. A
  `createTree` dry run reads nothing from the file: a keyed one is a `creates` step whose `change` says an existing
  result of that key would be updated in place, without listing what would change or be removed.

## Tree spec (`createTree`)

A spec is the root frame of a screen, written the way the read export writes a node: the same field names and values,
defaults left out, no ids, no parent references. A read node can be fed back in. A node is an `INSTANCE` when it names
a `component`, a `TEXT` when it has `text`, else a `FRAME`; the root is a frame (or a copy, below).

| Field | Value |
|---|---|
| `type` | `FRAME` \| `TEXT` \| `INSTANCE` (optional: inferred as above) |
| `name`, `hidden` | the layer name; `hidden: true` builds it hidden |
| `handle` | your own name for the node; the reply returns its id. Unique in the spec; not `__proto__` |
| `key` | the root only: a stable name for the result (≤ 200 characters) — see [Keyed re-send](#keyed-re-send) |
| `box` | `{w, h}`: the size (the read's `x`/`y` in it are accepted and set nothing) |
| `renderBox`, `reference` | read-export compatibility only, so a read node can be fed back: `renderBox {x, y, w, h}` and `reference` (a string) are accepted and set nothing; leave them out of a spec you write |
| `layout` | `{display: "flex", flexDirection: "row" \| "column", gap, padding: [t, r, b, l], justifyContent, alignItems, flexWrap: "wrap", rowGap, columnGap, alignContent: "space-between", reverseZ: true}`, or `{mode: "absolute", width, height}` for no auto-layout. `justifyContent`: `flex-start` \| `center` \| `flex-end` \| `space-between` \| `space-evenly` \| `space-around`; `alignItems`: `flex-start` \| `center` \| `flex-end` \| `baseline` (a row only); `rowGap`/`columnGap`/`alignContent` need `flexWrap` |
| `widthMode`, `heightMode` | `fill` (in an auto-layout parent) \| `hug` (a frame with auto-layout, or a text); fixed when absent |
| `grow` (0 \| 1), `alignSelf` (`min` \| `center` \| `max` \| `stretch`), `absolute: true` | a child's role in its auto-layout parent; an `absolute` child is out of the flow, so it cannot `fill`, `grow: 1` or stretch |
| `x`, `y` | the root: page coordinates; a child: its place in a parent without auto-layout, or an `absolute` one (inside auto-layout they are a warning) |
| `sizeLimits` | `{minWidth, maxWidth, minHeight, maxHeight}`, each above 0; needs auto-layout on the node or its parent |
| `fills` | `[{type: "solid", color, opacity? (0–1), tokens?: {color: variable}}]` (solid paints only); a frame without `fills` has none |
| `strokes` | `{colors: [hex], weight, weights: {top, right, bottom, left}, align: "inside" \| "outside" \| "center"}` (`weights` not on a TEXT); `variableWidth: {profile: "uniform"}` is read-export compatibility only (the default; accepted, sets nothing; a taper is refused); `strokesInLayout: true` counts them toward the auto-layout size |
| `radius` | a number, or `{tl, tr, br, bl}` |
| `opacity` (0–1), `clip: true` | as read; a frame without `clip` does not clip |
| `text` | a TEXT's characters |
| `font` | `{family, weight (the style name: "Semi Bold", "Bold Italic"), size (≥ 1), color, align, valign, lineHeight: {unit: "px" \| "percent", value} or {unit: "auto"}, letterSpacing: {unit: "px" \| "percent", value}, case, decoration, variationSettings: {wght: 560}}`; Inter Regular when absent. `align`: `left` \| `center` \| `right` \| `justified`; `valign`: `center` \| `bottom` (leave it out for top); `case`: `upper` \| `lower` \| `title` \| `small_caps` \| `small_caps_forced`; `decoration`: `underline` \| `strikethrough` (leave `case`/`decoration` out for none). `weightValue` (a number > 0) is read-export compatibility only: it follows `weight` and sets nothing. Italic is in `weight`, not `fontStyle` |
| `autoResize` (`width_and_height` \| `height` \| `truncate`), `truncate: true`, `maxLines` | a text with `box` and no `autoResize` keeps a fixed box; `maxLines` needs `truncate: true` |
| `children` | the child nodes, in order (not on a TEXT, an INSTANCE or a copy) |

Placement: the root lands on `page`, 100 px right of the rightmost frame there and level with the topmost, unless it
has `x`/`y`. It is built hidden and shown only once every node is in place.

```json
{"op": "createTree", "tree": {
  "name": "Settings", "key": "settings", "box": {"w": 390, "h": 844},
  "layout": {"display": "flex", "flexDirection": "column", "gap": 16, "padding": [24, 16, 24, 16]},
  "fills": [{"type": "solid", "tokens": {"color": "surface/default"}}],
  "children": [
    {"text": "Settings", "styles": {"text": "Heading/Large"}, "fills": [{"type": "solid", "tokens": {"color": "text/primary"}}]},
    {"component": "List item", "props": {"Size": "md"}, "widthMode": "fill", "columns": ["Label", "Show chevron"],
     "rows": [["Account", true], ["Notifications", true], ["Sign out", false]]},
    {"component": "Button", "props": {"Variant": "Primary", "Label": "Save"}, "handle": "save", "widthMode": "fill"}
  ]}}
```

## Design-system references

| Where | What it names |
|---|---|
| `component`, `props` on an INSTANCE | a component set or component by exact name, or a component's key or id; `props` by property name: a variant's value, a text, a boolean (a property's full `name#id` key works too) |
| `fills[].tokens.color` | a colour variable for that paint (the raw `color` may then be left out) |
| `tokens` | a number variable per field: `itemSpacing`, `counterAxisSpacing`, `paddingTop`/`Right`/`Bottom`/`Left`, `topLeftRadius`/`topRightRadius`/`bottomRightRadius`/`bottomLeftRadius`, `width`, `height`, `minWidth`/`maxWidth`/`minHeight`/`maxHeight`, `strokeWeight`, `strokeTopWeight`/`Right`/`Bottom`/`Left`, `opacity`; and `fills` / `strokes` (colour variables, one per paint) |
| `styles.text` on a TEXT | a text style; the `font` fields it sets are then accepted and not set (a warning) |

- Each name is exact (case-sensitive) or a key or id. A library variable is found by name; a library component or text
  style only by its key. An item from a library is imported when the batch applies — itself a write, run only after
  every op resolved and with Allow edits still on.
- A spacing token needs auto-layout on the node; `counterAxisSpacing` needs `flexWrap: "wrap"`; a `width`/`height`
  token cannot sit beside `widthMode`/`heightMode`. A TEXT binds `width`, `height`, `opacity`, `strokeWeight`,
  `fills`, `strokes`; an INSTANCE `width`, `height`, `opacity`.
- An INSTANCE takes only `component`, `props`, `name`, `handle`, `hidden`, `box`, `x`/`y`, `absolute`, `grow`,
  `alignSelf`, `widthMode`/`heightMode`, `opacity` and `tokens` (and the compatibility-only `renderBox`, `reference`): its content comes from its component. A wrong
  variable type, a property the component lacks, a variant value it does not have, or a hugging instance whose
  component has no auto-layout refuses the batch.

## Copies, rows, fragments

- **Copy:** `{clone: "<id>", ...patch fields, edits?: {"<layer id or unique name>": {...patch fields}}}` copies an
  existing node with every layer it has. Its own fields are a [patch](#patch) of the copy; it may also take `x`, `y`,
  `absolute`, `grow`, `alignSelf` and `handle`. `edits` names a layer of the source by its id or by an exact name
  unique in the source. A copy takes no `children` or `type`. The source must be a node id, not a layer inside an
  instance (`I…;…`); as the root its source must be a frame, and it takes no `key` or `hidden`. A main component
  inside the source becomes an instance of it in the copy, so its layers cannot be edited there. The source is left as
  it is.
- **Rows:** an INSTANCE with `rows: [{prop: value}, …]` is one instance per row, each with `props` plus its row (the
  row wins); with `columns: ["A", "B"]`, each row is a list of values in that order. A row table takes no `handle`.
- **Fragments:** the root's `fragments: {name: node spec}` defines parts that are not components; `{use: "name",
  ...fields, edits?: {"<layer name>": {...fields}}}` places one anywhere: its own fields over the fragment's root,
  each edit over the layer of that name (unique in the fragment; `null` drops a field). A fragment may use another,
  never itself. An unused fragment is a warning.

Rows and fragments are expanded before the spec is checked; a problem is named at the path you wrote
(`tree.children[2].rows[1]`).

## Keyed re-send

A root `key` is stored on the result. Sending a spec with the same key while that result is in the file updates it
instead of building a second one:

- nodes are matched to last time's by `handle`, then by a name unique among siblings, then in order;
- a matched node keeps its id and gets only the fields that differ from the spec sent last time, so a designer's hand
  edit stays unless the new spec changes that field; a field the spec drops goes back to a fresh build's value;
- a node the spec adds is built, one it drops is removed, one whose type or component changed (or whose change cannot
  be made in place) is built anew in its place;
- `page` must be absent or the result's page; a key appears once per batch; if the result was deleted, a new one is
  built. Removing a node that holds a layer the key did not build refuses the batch.

## Spec from disk

`treeFile` is a path to a JSON file holding the spec, relative to the directory the MCP server runs in and inside it,
at most 2 MB. The server reads it into `tree` before anything else, so it is checked, previewed and applied exactly
like the same spec inline. Only a `createTree` takes it, and never beside `tree`.

## Patch

`{op: "patch", nodeId, set}` changes an existing node; only the fields in `set` change, each checked by the tree spec's
rule for that field.

| Field | Value |
|---|---|
| `name`, `hidden` | `hidden: true` hides, `false` shows |
| `opacity` | 0–1 |
| `text`, `styles` | a TEXT's characters; `{text: style}` |
| `autoResize` | `width_and_height` \| `height` \| `truncate` \| `none` |
| `fills` | replaces the paints (`[]` for none); paints as in a tree spec |
| `strokes` | any of `colors`, `weight`, `weights`, `align` (as in a tree spec); only those change (`colors: []` removes them) |
| `radius` | a number, or any of `{tl, tr, br, bl}` |
| `layout` | any tree-spec `layout` field but `width`/`height` (a size is `box`), only those change; `flexWrap: "nowrap"`, `alignContent: "auto"`, `reverseZ: false` turn them off; `{mode: "absolute"}` removes auto-layout |
| `box` | `{w, h}` or either: a fixed size |
| `widthMode`, `heightMode` | `fill` \| `hug` \| `fixed` |
| `tokens` | as in a tree spec; `null` unbinds the field and keeps its value |
| `props` | an INSTANCE's property values |

A patch does not move a node (`x`/`y` → `move`), change its `type`, `children` or `font` (name a text style instead), or
swap an instance's component. Whether the node exists and has each field is checked before anything runs.

## Source edits

One op on a source, and Figma carries it to everything using it. Only this file's own sources: one from a library is
refused, naming the library when Figma says which.

- `setVariable`: `values: {"<mode name or modeId>": value}`, or `value` for a one-mode collection. A value is a hex
  colour, a number, a string, `true`/`false`, or `{aliasOf: "<variable>"}` (same type; a loop is refused).
- `setStyle`: `set` in the read export's style fields; one kind per style.

  | Kind | Fields |
  |---|---|
  | paint | `paints` (as `fills`) |
  | text | `font` (family), `weight` (style name), `size` (≥ 1), `lineHeight` (`{unit: "px" \| "percent", value}` or `{unit: "auto"}`), `letterSpacing` (`{unit: "px" \| "percent", value}`), `case` (`original` \| `upper` \| `lower` \| `title` \| `small_caps` \| `small_caps_forced`), `decoration` (`none` \| `underline` \| `strikethrough`), `paragraphSpacing`, `paragraphIndent`, `tokens` (`fontFamily`, `fontStyle`, `fontWeight`, `fontSize`, `lineHeight`, `letterSpacing`, `paragraphSpacing`, `paragraphIndent` → a variable, or `null` to unbind) |
  | effect | `effects`: `{type: "drop_shadow" \| "inner_shadow", color, offset: {x, y}, radius, spread?, behindNode?: true}` (`behindNode` on a drop shadow only) or `{type: "layer_blur" \| "background_blur", radius}`, replacing the list |
  | any | `name`, `description` |

- A `patch` of a main component, or of a layer inside it, changes every instance.

The dry run's `affects` (with a plugin connected) counts what follows: `nodes`, `instances`, `styles`, `variables`.

## Variable modes

`setVariableMode {nodeId, collection, mode}` sets a node's explicit mode for one collection (a frame's Theme to Dark);
`clearVariableMode {nodeId, collection}` returns it to the mode it inherits. `collection` is a local collection's exact name, or a
collection's id or key; `mode` is a mode's exact name or modeId. A library collection the file does not use yet is
refused.

## Move and delete

Only for nodes this plugin session created (`createFrame`, `createText`, `createTree`, with everything below them).
A delete takes everything below the node and is refused when any of it is not the session's; deletes run last. A move
is refused into the node itself, into an instance, or past the end of the new parent's children.

## What a write cannot set yet

Refused by name, each with the reason: grid layout, effects on a node, mixed-format text (`runs`), images (`asset`),
a text bound to a variable (`textTokens`), a property bound to a variable (`propTokens`), rotation, blend modes,
masks, vector geometry, prototype reactions, annotations, and creating variables, styles or components. A frame's
mode inside a spec (`variableModes`) is a `setVariableMode` op after the tree lands.

## Limits

- 50 ops per call; a larger job is several calls.
- 500 nodes per spec once its rows and fragments are expanded, nested at most 40 deep; a bigger screen is several
  trees.
- `treeFile` at most 2 MB; `key` at most 200 characters.
- A review card waits 5 minutes; a rejection reason is cut at 500 characters.
- Names resolve against the file as it was before the batch.
