# `figma_write` grammar

The whole write surface as the MCP server and the plugin check it. Inside a tree spec node (and its `layout`, `font`,
`strokes`, `box`, `radius`, `sizeLimits`, `renderBox`, paints, `tokens`, `styles`), a copy, a patch's `set`, a
`setStyle`'s `set` (and its effects), a create table's rows and a variable value, a field not listed here is refused by name with the closest
names, never dropped. The op object itself is looser: a field an op does not read (a typo beside `op`, `nodeId` on a
`createTree`) is ignored, not refused — so check the op's own field names against [The ops](#the-ops). Keys you name
yourself (`props` property names, `edits` layer names, `values` modes, `handle`s, `fragments`) are checked against the
file or the spec instead. A hex colour is `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`, with the `#`.

## Contents

- [The call](#the-call) · [The ops](#the-ops) · [Replies](#replies)
- [Tree spec (`createTree`)](#tree-spec-createtree) · [Design-system references](#design-system-references)
- [Copies, rows, fragments](#copies-rows-fragments) · [Components](#components) · [Keyed re-send](#keyed-re-send) · [Spec from disk](#spec-from-disk)
- [Patch](#patch) · [Patch by rule](#patch-by-rule) · [Source edits](#source-edits) · [Starting from nothing](#starting-from-nothing) · [Variable modes](#variable-modes) · [Move and delete](#move-and-delete)
- [What a write cannot set yet](#what-a-write-cannot-set-yet) · [Limits](#limits)

## The call

`figma_write {ops: [...], dryRun?, client?}` — `ops` in order, at most 50; `dryRun: true` previews without touching
the file; `client` names the file when several are connected (a connId, fileKey or part of the file name).

A write may wait for the designer's review in the plugin window: always while **Review each change first** is on (the
default), and even with it off for a source edit (`setVariable`, `setStyle`, a `patch` of a main component) or when the
layers changed since their last approval would pass 25. The dry run says so (`wouldWait`, `waitReason`). A call holds
at most 45 s; if they have not answered by then it returns `{pending: true, ticket, why, waited, note}`:

- Call `figma_write {ticket}` again — not the ops — until it returns the write's result or a refusal. Tell the user
  the change waits for them in the Design Twin plugin window.
- Keep asking: with no call for 2 min the card is withdrawn and nothing is applied (15 min at most in all).
- `figma_write {ticket, cancel: true}` withdraws it. Nothing is applied.
- One write waits at a time: a new batch meanwhile is refused (`refused: "waiting"`) naming the ticket to finish first.
- Lost track? `figma_status` reports `lastFigmaWrite`: the last outcome, or the ticket waiting now.

## The ops

| `op` | Required | Optional |
|---|---|---|
| `createTree` | `tree` (a spec, below) or `treeFile` (a path to the same spec as JSON) | `page` (a page's exact name or id; the current page by default), `section` (a section's exact name or id on that page), `createPage` / `createSection` (`true`: make the page or section when the file has none of that name, [below](#pages-and-sections)), `bind` (`true`: bind raw values to the file's variables and text styles, [below](#binding-to-the-file)) |
| `patch` | `nodeId`, `set` (the fields to change) | — |
| `patchWhere` | `where` (the rule: any of `text`, `fill`, `variable`, `instanceOf`, `name`), `set` (as a patch's) | `scope` (`"selection"`, `"page"` (the default), `"file"`, or page names), `token` (from its dry run; needed over 25 matches) |
| `setVariable` | `variable` (a local variable's exact name, key or id), and `values` (mode name or modeId → value) or `value` (a one-mode collection) | — |
| `setStyle` | `style` (a local paint, text or effect style's exact name, key or id), `set` | — |
| `createVariables` | `collection` (a local collection's name or id; made when none has it), `variables` (rows `[name, type, …a value per mode]`) | `modes` (mode names, in the rows' value order; none for a one-mode collection) |
| `createStyles` | `styles` (rows `{name, kind: "paint" \| "text" \| "effect", set}`) | — |
| `seedTokens` | `file` (the project's `tokens.dtcg.json` or `tokens.resolver.json`) | `collection` (a `tokens.dtcg.json`'s collection; `Tokens` by default) |
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

- A batch that landed: `{ok: true, applied: [...], warnings?, undoSteps?, undoNote?}`, one entry per op; `undoSteps`
  and `undoNote` only when Figma split it into several undo steps ([Components](#components), Undo).
  - `createTree`: `{id, created: {frames, texts, instances?, clones?}, handles?, unbound?, pageCreated?, sectionCreated?}`;
    `handles` maps each `handle` to its node's id, `unbound` counts raw colours, spacing, radii and stroke weights where
    a variable could stand, and texts with no text style, and `pageCreated` / `sectionCreated` are the ids of a page or
    section this op made ([Pages and sections](#pages-and-sections)).
  - a keyed re-send: `{id, key, changed?: [{id, handle?, fields}], created?, removed?, reordered?, handles?}`, or
    `{id, key, unchanged: true}`.
  - with `bind: true`, either one also carries `bind: {bound, instanced, unbound, ambiguous?}` (and no `unbound` of its
    own): the raw values bound, the instances the spec places, the raw values left, and `ambiguous: {count, samples:
    [{path, field, value, candidates}]}` (at most 5 samples) for values several variables or styles matched.
  - a component: `{id, component, created: {frames, texts, instances?, clones?, variants?}, props?, handles?, unbound?}`;
    `props` maps each declared property's name to the key Figma gave it (`"Label#12:0"`). Sent again: the keyed
    re-send's reply with `component` in place of `key`, plus `props?` (the properties added or changed),
    `propsRemoved?` and `rewired?` (layers wired anew), or `{id, component, unchanged: true}`.
  - `createVariables` `{id, result, modesAdded?, rows}` (the collection, `created` / `updated` / `unchanged`, then per
    row `[id, "created" | "updated" | "unchanged"]` in table order) · `createStyles` `{rows}` (per row `[id, …]`).
  - `seedTokens` `{seeded: file, tables: [{collection, id, result, modesAdded?, created?, updated?, unchanged}, …], unmapped?, partly?}`
    (`created` / `updated` list `[name, id]`, `unchanged` counts the rest; the styles table is `{styles: true, …}`).
  - `patch` `{id, unbound?}` · `patchWhere` `{matched, pages, unbound?}` (how many layers, on how many pages; no ids) · `setVariable` `{id, modes}` · `setStyle` `{id}` · a mode op names the `collection` and
    the mode `from` → `to` (`inherited` when none is set) · `move` `{id, parentId}` · `delete` `{id, deleted: true}`.
- Refused whole, nothing changed (bar a library item already imported for it, which stays): an error saying why (Allow
  edits off, rejected with the designer's reason, withdrawn or not reviewed in time, another write still waiting, Dev Mode, or every problem of the batch with its
  path and up to three candidates).
- Failed partway: `Write failed at op N`, with what was put back (`restored`) and what stays (`applied`). Not all of it
  may come back: with Allow edits turned off mid-batch nothing is put back; a value that cannot be restored is named in
  the error; a node already deleted stays deleted; an imported library item stays, and is not listed in `applied`.
  Read `applied` before a retry, so nothing is made twice.
- A dry run: `{dryRun: true, creates, overwrites, moves?, deletes?, invalid, refusedByFile?, steps, editsAllowed,
  wouldWait?, waitReason?, waitingTicket?, note}`; each step has `effect`, `target`, a one-sentence `change`, `fields` (one row per field of a
  patch or a style), `warnings`, `invalid` (every problem), for a source edit `affects` and `refusedByFile`, for a `patchWhere` `match` ([below](#patch-by-rule)), and for a
  create table `plan: {create, update}` (the names it would make, and the ones the file has, updated in place). A
  `createTree` dry run reads nothing from the file: a keyed one is a `creates` step whose `change` says an existing
  result of that key would be updated in place, without listing what would change or be removed. A component spec
  asks the plugin: its step's `change` starts with "would create component 'X'" or "would update component 'X' in
  place (N instances follow)", with `plan` and `affects.instances` (or `refusedByFile`, for one made by hand). In a
  batch with a component spec, the component names every spec uses are resolved too, so one the same batch makes or
  updates is in `refusedByFile` (not a copy's or a patch's swap values).

## Tree spec (`createTree`)

A spec is the root frame of a screen, written the way the read export writes a node: the same field names and values,
defaults left out, no ids, no parent references. A read node can be fed back in. A node is an `INSTANCE` when it names
a `component`, a `TEXT` when it has `text`, else a `FRAME`; the root is a frame (or a copy, below), or a
[component](#components).

| Field | Value |
|---|---|
| `type` | `FRAME` \| `TEXT` \| `INSTANCE` (optional: inferred as above); on the root also `COMPONENT` \| `COMPONENT_SET` ([Components](#components)) |
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
| `fills` | `[{type: "solid", color, opacity? (0–1), tokens?: {color: variable}}]`, or an image: `{type: "image", file: "<path>"}` (a PNG, JPEG or GIF in the project, at most 8 MB and 4096 px a side, read by the server) or `{type: "image", hash}` (an image the file has: a read's `hash`, or one a write's reply listed in `images`), each with `scaleMode` (`fill` \| `fit` \| `tile`), `scale` (a tile's), `opacity`; never the bytes, a `data:` URI or a URL; a frame without `fills` has none |
| `strokes` | `{colors: [hex], weight, weights: {top, right, bottom, left}, align: "inside" \| "outside" \| "center"}` (`weights` not on a TEXT); `variableWidth: {profile: "uniform"}` is read-export compatibility only (the default; accepted, sets nothing; a taper is refused); `strokesInLayout: true` counts them toward the auto-layout size |
| `radius` | a number, or `{tl, tr, br, bl}` |
| `opacity` (0–1), `clip: true` | as read; a frame without `clip` does not clip |
| `text` | a TEXT's characters |
| `font` | `{family, weight (the style name: "Semi Bold", "Bold Italic"), size (≥ 1), color, align, valign, lineHeight: {unit: "px" \| "percent", value} or {unit: "auto"}, letterSpacing: {unit: "px" \| "percent", value}, case, decoration, variationSettings: {wght: 560}}`; Inter Regular when absent. `align`: `left` \| `center` \| `right` \| `justified`; `valign`: `center` \| `bottom` (leave it out for top); `case`: `upper` \| `lower` \| `title` \| `small_caps` \| `small_caps_forced`; `decoration`: `underline` \| `strikethrough` (leave `case`/`decoration` out for none). `weightValue` (a number > 0) is read-export compatibility only: it follows `weight` and sets nothing. Italic is in `weight`, not `fontStyle` |
| `autoResize` (`width_and_height` \| `height` \| `truncate`), `truncate: true`, `maxLines` | a text with `box` and no `autoResize` keeps a fixed box; `maxLines` needs `truncate: true` |
| `children` | the child nodes, in order (not on a TEXT, an INSTANCE or a copy) |

Placement: the root lands on `page`, 100 px right of the rightmost frame there and level with the topmost, unless it
has `x`/`y`. With only one, it is kept and the other avoids overlap: only `y` goes right of everything; only `x` stays
level with the topmost unless that lands on a layer, else 100 px below what is in its column (in a section too). It is built hidden and shown only once every node is in place.

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

### Pages and sections

`section` puts the root inside a section on `page` (nested sections too); a section given by id with no `page` is
found on whichever page holds it (by name, it is looked for on `page`, the current page by default): 100 px right of what the section holds and
level with its top, or on a new row 100 px below it when growing right would run the section into a neighbour; at
80 px from its edges when it is empty. In a section the root's `x`/`y` are the section's own. The section grows (never
shrinks) to hold the root with that 80 px margin, and so does each section around it; one that then overlaps a
neighbour is a warning, not a refusal.

`createPage: true` makes `page` when the file has no page of that name, `createSection: true` makes `section` on the
page when it has none (beside what the page holds). A name the file has once is used as it is, so the same batch sent
again lands where the first send did. Making is never guessed: a page or section that matches nothing is refused with
its closest names unless the op asks to make it, and one whose name matches several is refused with their ids (make or
not). A page or section the batch makes is made once, at the first op landing there; every op of the batch naming it
lands in that one. At most 10 new pages and 25 new sections a batch. `createPage` needs `page`, `createSection` needs
`section`; a name to make is not blank, has no spaces at its ends and does not look like a node id. The reply names what
was made on the op that made it (`pageCreated`, `sectionCreated`: ids). If a later op fails, the batch removes them again
(after the frames in them) and shrinks any section it grew — but never a page or section holding a layer the batch did
not make: that one stays, and the error says so. A file in a Starter-plan team holds at most 3 pages (drafts are not
held to it): there Figma refuses a fourth, and the batch is put back.

```json
{"op": "createTree", "page": "Checkout", "createPage": true, "section": "Payment", "createSection": true,
 "tree": {"name": "Card entry", "box": {"w": 390, "h": 844}}}
```

## Design-system references

| Where | What it names |
|---|---|
| `component`, `props` on an INSTANCE | a component set or component by exact name, or a component's key or id; `props` by property name: a variant's value, a text, a boolean, or for an instance-swap property a component (exact name, key or id; a set swaps to its default variant; a library one must be in the file already) (a property's full `name#id` key works too) |
| `propRefs` on a layer inside a component root | `{characters: "<TEXT property>"}` on a TEXT, `{visible: "<BOOLEAN property>"}` on any layer, `{mainComponent: "<INSTANCE_SWAP property>"}` on an INSTANCE: the property's name as the root's `props` declares it ([Components](#components)) |
| an INSTANCE_SWAP property's `default`, `preferredValues` | a component by exact name, key or id |
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
  `alignSelf`, `widthMode`/`heightMode`, `opacity`, `tokens` and (inside a component) `propRefs` (and the compatibility-only `renderBox`, `reference`): its content comes from its component.
- A component another op of the same batch makes or updates is not there yet: every name resolves before the batch
  runs, so the spec is refused ("create it in an earlier call" / "use it in a later call"), a copy's swap values
  included. Make the kit in one call, use it in the next. A swap property's suggestions may name a set or component the
  batch updates (itself too), and its default a standalone component the batch updates; a variant of a set the batch
  updates may not be named. A wrong
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
  never itself. An unused fragment is a warning. A component root is written as the root itself, never placed from
  a fragment.

Rows and fragments are expanded before the spec is checked; a problem is named at the path you wrote
(`tree.children[2].rows[1]`).

## Components

A root with `type: "COMPONENT"` makes a local main component instead of a frame; every frame field of a root applies
(`box`, `layout`, `fills`, `radius`, `strokes`, `x`/`y`, …), and its children are its layers. `type: "COMPONENT_SET"`
makes a set of variants from a table. Either type is on the root only. A component's `name` is required and is its
key: a later spec uses it by that name (`component: "Button"`), and sending a spec with the same name again updates it
in place (below). It lands like a frame: on `page`, beside the existing frames, built hidden and shown once complete.

- **Properties:** on a component root, `props` declares its properties (on an INSTANCE it stays values):
  `{"<name>": {type: "TEXT" | "BOOLEAN" | "INSTANCE_SWAP", default, preferredValues?}}`. A TEXT's `default` is a string,
  a BOOLEAN's `true`/`false`, an INSTANCE_SWAP's a component (name, key or id; a set means its default variant), and
  only a swap takes `preferredValues` (a list of components). A name holds no `#` and is never `__proto__` (Figma's
  message passing drops that key; nor is a column). A property name, a column and a variant value never start or end
  with a space (Figma trims them). VARIANT properties come from the table, never from `props`; SLOT
  cannot be written yet.
- **Wiring:** a layer inside takes `propRefs` (the read's own field): `{characters: "Label"}` on a TEXT,
  `{visible: "Show icon"}` on any layer, `{mainComponent: "Icon"}` on an INSTANCE, each naming a declared property of
  the matching type. A ref to an undeclared property or of the wrong type is refused with its path; a declared
  property no layer uses is a warning. The component itself is not wired, and `propRefs` outside a component is refused.
  A wired field shows its property's default (Figma keeps it bound): a wired text's `text`, if given, equals its TEXT
  property's `default`, and a wired layer's `hidden`, if given, equals `!default` of its BOOLEAN property (the set's, in
  a set) — anything else is refused at its path. To change what it shows, change the property's `default`.
- **Variants as a table:** a `COMPONENT_SET` root takes `variant` (the spec every variant starts from: a component's
  fields and its `children`, no `name`), `columns` (its VARIANT properties) and `rows`, each the values of one variant
  in column order and, last, an optional object of what that variant changes: its own fields, and
  `edits: {"<layer name unique in the base>": {...fields}}` (`null` drops a field), and `handle` (unique, as any
  handle; a re-send pairs by it first, below — the base `variant` takes none). Each row is one COMPONENT named as
  Figma names a variant (`"Size=md, State=default"`); the options come from the rows in order and the first row is the
  default variant. A duplicate combination, a missing or extra cell, and a value or column holding `=` or `,` are
  refused. The set's own fields (`layout`, `fills`, …) and its `props` (TEXT, BOOLEAN, INSTANCE_SWAP, wired in every
  variant) go on the set. A set without auto-layout lays its variants out in a column; one with it hugs them unless it
  has a size.
- **Sent again:** the one local component (or set) of that name a write made is updated in place, as a
  [keyed re-send](#keyed-re-send) is: same ids, so its instances follow. Variants pair with the old ones by the row's
  `handle`, then by exact name, then the rest in order (the old in the set's order, the new in row order): a paired
  variant keeps its node and is renamed in place, so a changed value or a column added, renamed or dropped keeps every
  instance on it. Only old variants left over (rows dropped) are removed — their instances lose their main component,
  and the reply's `warnings` and the dry run's `change` say how many ("removing variant 'Size=sm, State=default' of
  'Button' leaves 3 instances without a main component"); rows left over are built. Property definitions are added,
  edited (`default`, `preferredValues`) or deleted so they equal the spec; a layer's references to a property that goes
  are removed first, and the definition itself is deleted last of all. A wired field follows an edited default, and
  each layer whose `propRefs` changed is wired again. A variant or a property deleted cannot be brought back: a failure
  after one names it in the error and in `applied`. A component of that name made by hand, two of that name, or a single component sent as a set (or
  back) is refused before anything runs — change one made by hand with a [patch](#patch) of its id. A property's type
  cannot change in place (give it a new name). The root takes no `key`; `component` on it is accepted only equal to
  `name` (the read writes it so).

**Undo.** A batch is one Cmd-Z step, except that Figma ends an undo step at each component property a write declares,
edits or deletes (the call included; a plugin cannot merge steps). The batch still runs in op order; each press takes
back the part of it after the previous property call, and a new component still being built when a step ended is left
hidden (one finished earlier in the batch stays as it was). A batch split like that says so in its reply: `undoSteps` (how many presses: the property calls, plus
one if the batch changed the file after the last) and `undoNote` (a sentence to pass on to the designer).

```json
{"op": "createTree", "tree": {
  "type": "COMPONENT_SET", "name": "Button",
  "props": {"Label": {"type": "TEXT", "default": "Button"}, "Show icon": {"type": "BOOLEAN", "default": false},
            "Icon": {"type": "INSTANCE_SWAP", "default": "Icon/Plus", "preferredValues": ["Icon/Plus", "Icon/Arrow"]}},
  "variant": {"layout": {"display": "flex", "alignItems": "center", "gap": 8, "padding": [10, 16, 10, 16]},
              "widthMode": "hug", "heightMode": "hug", "radius": 8, "fills": [{"type": "solid", "tokens": {"color": "color/brand"}}],
              "children": [
                {"component": "Icon/Plus", "name": "Icon", "propRefs": {"visible": "Show icon", "mainComponent": "Icon"}},
                {"name": "Label", "text": "Button", "fills": [{"type": "solid", "tokens": {"color": "color/on-brand"}}], "propRefs": {"characters": "Label"}}]},
  "columns": ["Size", "State"],
  "rows": [["md", "default"], ["md", "hover", {"fills": [{"type": "solid", "tokens": {"color": "color/brand-hover"}}]}],
           ["sm", "default", {"edits": {"Label": {"font": {"size": 14}}}}]]}}
```

Then, in a later call: `{"component": "Button", "props": {"Size": "sm", "Label": "Save", "Show icon": true, "Icon": "Icon/Arrow"}}`.

## Keyed re-send

A root `key` is stored on the result. Sending a spec with the same key while that result is in the file updates it
instead of building a second one:

- nodes are matched to last time's by `handle`, then by a name unique among siblings, then in order;
- a matched node keeps its id and gets only the fields that differ from the spec sent last time, so a designer's hand
  edit stays unless the new spec changes that field; a field the spec drops goes back to a fresh build's value;
- a node the spec adds is built, one it drops is removed, one whose type or component changed (or whose change cannot
  be made in place) is built anew in its place;
- `page` and `section` must be absent or the result's (an update never moves it, nor makes a page or section for it); a key appears once per batch; if the result was deleted, a new one is
  built. Removing a node that holds a layer the key did not build refuses the batch.

## Spec from disk

`treeFile` is a path to a JSON file holding the spec, relative to the directory the MCP server runs in and inside it,
at most 2 MB. The server reads it into `tree` before anything else, so it is checked, previewed and applied exactly
like the same spec inline. Only a `createTree` takes it, and never beside `tree`. `capture-page` writes its specs for
this path (SKILL.md, Capture a page): send them as it prints them (with `bind: true`). Its candidate components
(`design/capture/<name>@<width>.candidates/*.tree.json`) are `COMPONENT` specs for the same path.

## Binding to the file

`{op: "createTree", treeFile, bind: true}` (what `capture-page` prints) binds the spec's raw values to the file before
anything resolves, then builds the bound spec as if it had been written so:

- **What binds.** A solid paint's colour (a frame's, a text's, and a text's `font.color` through `tokens.fills`), each
  stroke colour (all of a node's, or none), `layout.gap`, the wrapped tracks' gap, each `layout.padding` side, a radius
  (one number: all four corners) — to a colour or number variable; a text's font to a text style whose family, style,
  size, line height, letter spacing, case and decoration all equal it and which sets no paragraph indent, paragraph or
  list spacing, leading trim or variable-font axis value (the fields the style sets are then dropped from
  `font`). Not bound: sizes, opacity, stroke weights, pictures, a paint with its own `opacity`, anything inside a copy
  or an instance — nor a paint style (a spec has no fill style), nor a variable or style a `setVariable` / `setStyle` of
  the batch changes (or a variable aliasing one; and while the batch changes a variable, no text style bound to one).
- **Equal.** A colour by its 8-bit RGBA (the read's hex), a number within 0.01. A variable's value is the one in its
  collection's default mode, through its aliases (a broken or looping chain has none). A variable or style is named by
  its name when nothing else in the file or the batch has that name, else (the file's) by its id; one a create table
  earlier in the batch makes (`seedTokens`, `createVariables`, `createStyles`) must be new and made once. So the same
  seed-and-capture batch sent again names each one as the first send did. One whose name reads as an id
  (`VariableID:…`, `S:…`) or a 40-hex key is never bound to: its values stay raw.
- **Several equal.** In order: drop a variable whose `scopes` leave the field out; keep those whose name has a word for
  the field (fill: bg, background, surface, fill; text: text, fg, foreground, content; stroke: border, stroke, outline,
  divider; spacing: space, spacing, gap, padding, inset, gutter; radius: radius, radii, round, corner) when any has; drop
  one another candidate aliases (the semantic name over the primitive). Still several, or several text styles: the
  value stays raw and is listed in `bind.ambiguous` — never guessed.
- A keyed re-send binds the same way, so only a real change shows; the batch is one Undo step as any `createTree` is.
  A dry run a plugin answers carries the same `bind` counts on the step; with no plugin, binding is the file's to
  decide when the write applies.

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
| `props` | an INSTANCE's property values (an instance-swap property takes a component, as in a tree spec) |

A patch does not move a node (`x`/`y` → `move`), change its `type`, `children` or `font` (name a text style instead), or
swap an instance's component. Whether the node exists and has each field is checked before anything runs.

## Patch by rule

`{op: "patchWhere", where, scope?, set, token?}` sets the same `set` (any [patch](#patch) field) on every layer the rule
matches, in one op whose size does not grow with the matches. Every kind given in `where` must hold:

| Kind | Matches |
|---|---|
| `text` | a TEXT whose characters equal it |
| `fill` | a layer with a visible solid fill of that hex colour (`#rrggbbaa`: the alpha pair is the paint's opacity) |
| `variable` | a layer bound to that variable (its name, id or key: a local one, or one a layer in scope uses) |
| `instanceOf` | an instance of that component or component set (its name, id or key) |
| `name` | a layer whose name is it; `*` is any run of characters (`"Footer*"`), nothing else is special |

`scope`: `"page"` (the current page; the default), `"file"` (every page), `"selection"` (the selected layers and
everything inside them) or a list of page names or ids. Layers inside an instance, a main component or a component set
are never matched: patch the main component once instead ([Source edits](#source-edits)). A page, variable or component
name that matches nothing or several things refuses the batch with candidates. Every rule picks its layers from the
file as it is before the batch runs: an earlier op of the same batch does not change what it matches (a rule for text
another op just set matches nothing yet — send it in a later call).

Dry-run it first. Its step carries `match: {total, pages: [{page, count}], samples: [{id, name, page}], token,
needsToken}` — counts per page and three samples, never the full list. A real run that matches more than 25 layers must
carry that `token`; one whose matches changed since the dry run is refused (dry-run again), and so is one that matches
nothing, or more than 2000 layers. A layer among the matches the patch does not fit refuses the batch, counted with a few
named. A patchWhere always waits for the designer's review (whatever the box says), its card line reading "40 layers
matching text “Terms v1”: text “Terms v1” → “Terms v2” — on 'Flow A' (30), 'Flow B' (10)" with Show me; on Apply the
matches are counted again, and the batch is refused if they are not the ones the card showed. The run is one undo step,
put back whole when an op fails.

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
  | effect | `effects`: `{type: "drop_shadow" \| "inner_shadow", color, offset: {x, y}, radius, spread?, behindNode?: true, tokens?}` (`behindNode` on a drop shadow only) or `{type: "layer_blur" \| "background_blur", radius, tokens?}`, replacing the list; `tokens` binds a shadow's `color`, `radius`, `spread`, `offsetX`, `offsetY` (a blur's `radius`) to a variable |
  | any | `name`, `description` |

- A `patch` of a main component, or of a layer inside it, changes every instance.

The dry run's `affects` (with a plugin connected) counts what follows: `nodes`, `instances`, `styles`, `variables`.

## Starting from nothing

A design system as two tables, each one op. They go before every other op of the batch and run first, so a
`createTree` or `patch` after them names the new variables and text styles by name. A name the file has is updated in
place, never duplicated: the collection by its local name (modes matched by name, a missing one added), a variable by
its name in that collection, a style by name and kind. A library's collection or style is never matched by name: a
local one is made beside it.

```json
{"op": "createVariables", "collection": "Theme", "modes": ["Light", "Dark"], "variables": [
  ["gray/0", "color", "#ffffff", "#ffffff"],
  ["gray/900", "color", "#18181b", "#18181b"],
  ["color/bg", "color", {"aliasOf": "gray/0"}, {"aliasOf": "gray/900"}],
  ["space/md", "number", 16, 16]
]}
{"op": "createStyles", "styles": [
  {"name": "Surface", "kind": "paint", "set": {"paints": [{"type": "solid", "tokens": {"color": "color/bg"}}]}},
  {"name": "Body", "kind": "text", "set": {"font": "Inter", "weight": "Regular", "size": 16, "tokens": {"fontSize": "space/md"}}},
  {"name": "Card", "kind": "effect", "set": {"effects": [{"type": "drop_shadow", "color": "#00000026", "offset": {"x": 0, "y": 2}, "radius": 8, "tokens": {"color": "gray/900"}}]}}
]}
```

- A row of `createVariables`: `[name, type, …values]`, `type` one of `color`, `number`, `string`, `boolean`, then one
  value per entry of `modes`, in order (one value and no `modes` for a one-mode collection). A value is as in
  `setVariable`; `{aliasOf}` names a row of the same table (before or after), a row of an earlier table of the batch, or
  a variable the file has. Same type only; a loop is refused; a variable's type cannot change. A new variable takes
  its first value in an existing mode the table leaves out.
- A row of `createStyles`: `{name, kind, set}`, `set` as in `setStyle` for that kind, without `name`. A paint bound to a
  variable is `{type: "solid", tokens: {color}}`. A new text style starts as Inter Regular.
- A new name that another collection of the file has too (or two tables make) is refused for the op naming it: it
  would match two. A mode past the file plan's limit is refused by Figma, naming the plan.
- Sent again, the reply says per row what changed; a failure anywhere in the batch removes what the tables made and
  sets back what they changed.

### Tables from the project's token file

`seedTokens {file, collection?}` makes the tables from a token file in the project; the MCP server reads it, so no value
passes through the call. It goes first in a batch, like the tables; the 50-op limit counts the tables it makes.

```json
{"op": "seedTokens", "file": "src/theme/tokens.resolver.json"}
{"op": "seedTokens", "file": "tokens.dtcg.json", "collection": "Theme"}
```

- Read: a DTCG file (`tokens.dtcg.json`, or hand-written DTCG) and a DTCG resolver with its set and context files
  (`$ref`s next to it). Not read: CSS, Tailwind's `theme.css`, native token files. Every file must be inside the
  project, JSON, at most 2 MB; a `$ref` that is a URL, absolute, or a `#` pointer is refused.
- A resolver: each set is a collection, its modifier's contexts are the modes (the default first). A `tokens.dtcg.json`:
  the modes are `$extensions["figma.com"].modes` (the default first: its `defaultMode`, else the mode whose value is the
  `$value`), the collection is `collection`; tokens with other modes go into `<collection> (<mode> / <mode>)`, numbered
  on a clash.
- Names: the path joined with `/`; `{a.b}` is an alias of `a/b`. color → hex, dimension → px (rem × 16), number,
  string, fontFamily, fontWeight, a boolean kept as a string token → boolean; `typography` → a text style, `shadow` → an
  effect style, their `{ref}`s bound (a style has no modes: the default's value, a differing mode listed).
- `unmapped` lists each token in no table, with why (gradient, duration, an alias to nothing, a loop, a token inside a
  token, …). `partly` lists each token seeded only in part, with what was left out (a style's other modes,
  extended-collection overrides, a name given twice). The dry run's `seedTokens` step has the tables' steps (with their
  `plan`) under `tables`, then `unmapped` and `partly`; its `change` counts the two apart.

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

Refused by name, each with the reason: grid layout, effects on a node, mixed-format text (`runs`), an image's crop, rotation or filters (an image is a fill, above),
a text bound to a variable (`textTokens`), a property bound to a variable (`propTokens`), rotation, blend modes,
masks, vector geometry, prototype reactions, annotations, SLOT component properties, and a variable's scopes or code
syntax. A frame's
mode inside a spec (`variableModes`) is a `setVariableMode` op after the tree lands.

## Limits

- 50 ops per call; a larger job is several calls.
- 500 nodes per spec once its rows and fragments are expanded, nested at most 40 deep; a bigger screen is several
  trees.
- `treeFile` at most 2 MB; `key` at most 200 characters.
- An image file at most 8 MB and 4096 px a side (PNG, JPEG or GIF); a batch's images at most 32 MB together.
- A call holds 45 s for the designer; a waiting card is withdrawn 2 min after the last poll, 15 min at most; a
  rejection reason is cut at 500 characters.
- Names resolve against the file as it was before the batch, except what the batch's create tables make (a component
  the batch makes is used in a later call).
- A create table takes at most 1,000 rows.
