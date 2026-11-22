# Write plane — agreed design (ADR)

Status: **accepted, partly built** (the four ops `figma_write` started with are the baseline this replaces; setting a
node's variable mode by name, `setVariableMode` / `clearVariableMode`, is built; the tree spec, `createTree` — frames,
auto-layout and text, placement, checked whole — is built; design-system references in it — instances of a named
component with property values, variables, text styles, library imports under the consent gate — are built; patch by
id — `patch` with one row per field, `move` and `delete` of the session's own nodes, the batch put back when an
op fails (as far as it can be: not once Allow edits is turned off, and what stays, bar imported library items, is reported in `applied`), one undo per batch — is built; a spec from disk (`treeFile`) and a root `key` whose re-send updates the
result in place and replies with only what changed are built; source edits — `setVariable` and `setStyle` on this
file's own variables and paint, text and effect styles, a `patch` of a main component, a library's refused naming the
library, and the dry run's count of what follows (`writeImpact`) — are built; clone and patch — a `createTree` node
`clone` that copies an existing node with its own and its layers' differences (`edits`) — and repetition — an
instance's `rows` table and the root's named `fragments` placed by `use` — are built; the designing skill
(`claude-plugin/skills/design-in-figma/`, its grammar in `references/grammar.md`) and the docs for the write surface
are built; starting from nothing — `createVariables` (a collection, its modes and every variable as one table, aliases
included) and `createStyles` (paint, text and effect styles whose values name variables), a name the file has updated
in place, both first in a batch so the specs and patches after them name what they make — is built; seeding them from
code tokens — `seedTokens`, a project's `tokens.dtcg.json` or `tokens.resolver.json` read by the MCP server into those
tables, modes included, the tokens it cannot map listed — is built; creating components — a `createTree` root of type
`COMPONENT`, or `COMPONENT_SET` from a variant table, its TEXT, BOOLEAN and INSTANCE_SWAP properties declared and its
layers wired to them, named by later specs and updated in place when its name is sent again — is built; images — a
paint `{type: "image", file}` or `{type: "image", hash}` — are built; capturing a rendered page as a screen —
`capture-page`, which writes a tree spec per viewport width and its images to disk for `treeFile` ops — is built; binding
the capture to the file — a `createTree` op's `bind: true`, which binds raw values to the file's variables and text
styles, and instances of the components the component map names, read in the write direction — is built; bulk patch
by rule — `patchWhere`, a patch of every layer a rule matches within a scope, its dry run counting per page with a token
the real run carries — is built; placement in a section, and a page or section a `createTree` makes (`section`,
`createPage`, `createSection`) — is built)
Date: 2026-11-11

This document records the design agreed for letting an agent write to a Figma file at the lowest token
cost. It complements `ARCHITECTURE.md` (the read/write planes, the consent gate) and `SECURITY.md`.
Where the two disagree once a step below lands, that step updates `ARCHITECTURE.md`.

## Problem

`figma_write` started with four ops (`createFrame`, `createText`, `setFill`, `setText`; the baseline). Every node is one op
carrying a `parentId`, so a tree is built by create, read the id back, create the children. A screen costs
a round trip per level and an op per node, colours are raw hex, and nothing can use a component, a
variable or a style. The cost grows with the node count in both directions: ops out, ids back.

## Scope

In scope first: **compose new screens from the existing design system**, and **patch existing nodes**.
Then, on the same pieces: **starting from a file with no design system** (create variables, styles and
components), and **from an existing app to Figma** (capture a rendered page as a screen).

### Starting from nothing

A file with no components and no variables is the expensive case: every part is described node by node,
and every value is raw. The route is never to draw screens from raw shapes. It is to get a small design
system first, then compose from it by name:

| Starting point | Route |
|---|---|
| A ready-made library can be enabled in the file | compose from it by name; nothing else is needed |
| The project has tokens in code | `seedTokens` reads them (DTCG, or a DTCG resolver) into the variable and style tables, landed from disk at almost no token cost (built) |
| Truly blank | create the variables and styles as one table, create a small kit of components once, then compose |

A set of variables or styles is sent as one compact table, not an op each. A component is a tree spec
marked as a component, with its properties declared. Both update in place when sent again.

### From an existing app to Figma

Someone has a working interface and no Figma file for it: an app an AI design tool generated, a
prototype, their own product. The route is mechanical, so the model types none of the values:

1. A script opens the running page, reads what was rendered with the probe the verify step already uses,
   and writes a tree spec to disk. Flex and grid arrive as auto-layout, text as real text.
2. `figma_write` lands the spec from disk. The result is faithful but plain: raw values, no components.

As built (steps 1 and 2): `claude-plugin/scripts/capture-page.js` (`design-to-code/capture-page.ts`) opens a page URL
in the project's own Playwright chromium, resolved and launched as the verify probe does (`probe-browser.ts`), at one
or several `--width`s, each in a fresh context with the probe's init script; it waits for the load, the fonts, an
optional `--ready` selector and a quiet DOM, and captures the whole document's height (or one `--root` element). A
walker (`probe-capture.ts`) reads which elements show and their layout facts; the probe's reader (`measureElements`)
every visual value; CDP says which font family Chromium drew each text with. The pure converter (`capture-spec.ts`)
maps flex to auto-layout (a reversed direction reverses the children, stretch and grow become `alignSelf` and
`grow`), a grid of one column or one row to a column or a row and one of several columns to a wrapping row of
fixed-width cells (an irregular grid keeps its children's positions, noted); every such auto-layout is checked
against where the page put the children (gap, padding, justify, alignment, Figma's line breaks, to the px) and one that
does not reproduce them — a margin, `margin: auto`, a grid row taller than its items, a reversed flex wrapping onto
several lines — is not written, its children keeping their x/y (counted as approximated); block flow to a frame whose children keep
their x/y, absolute children of an auto-layout frame to `absolute: true`, an element of inline text to one TEXT
(inline styles flattened, counted) and text beside blocks to a TEXT per run; borders and rings to strokes, radius,
opacity and clipping as they are; an element with no paint and one child of its box collapses into it. A weight is
named by Figma's common style names (400 italic is "Italic"); a font the file lacks is refused by the plugin's own
check, which lists every missing font with the closest the file has, and is never swapped. Pictures the page loaded
are saved as they are when Figma takes them, anything else (WebP, AVIF, SVG, an inline `<svg>`, a `<canvas>`) as a
PNG of that element, under `design/capture/images/<sha256>.<ext>`, and painted by `file`. Each spec must pass the tree
spec's own check before anything is written; one over 500 nodes or 40 levels, or pictures over all widths (one batch) past the
32 MB batch cap, is refused (capture part of the page with `--root`). Its root is keyed `capture:<name>@<width>`, so
a re-capture sent again updates the screen in place. The report (`<name>.capture.json`) lists every font up front and
counts, with sample paths, what was dropped (shadows, gradients, pseudo-element content, transforms, filters: the
tree spec has no effects) or approximated, and the ops to send (several widths: one batch, all or nothing).
3. Values that equal a variable or style in the file are bound to it, and an element the component map
   names arrives as an instance. The component map is used in the write direction: a code component and
   its props resolve to the Figma component and its property values.

As built (step 3): the ops `capture-page` prints carry `bind: true`. Before the batch's names resolve (and before a keyed
re-send compares its spec with the last one), the plugin gathers the file's local colour and number variables — each
by its collection's default mode, through its aliases, with its scopes — its local text styles, and what the create
tables earlier in the batch make (`figma-plugin/src/bind.ts`), and the pure binder (`bridge/src/bind-values.ts`) rewrites
every raw value equal to exactly one of them into the spec's own reference fields: a solid paint's colour
(`fills[i].tokens.color`; a text's font colour through `tokens.fills`), the stroke colours (`tokens.strokes`, all or
none), the gap, the wrapped tracks' gap, each padding side and the radius (`tokens.<field>`), and a text's font
(`styles.text`, when family, style, size, line height, letter spacing, case and decoration all equal). A colour is equal
by its 8-bit RGBA, a number within 0.01. A variable or style is named by its name when that is its alone in the file
and the batch (so `seedTokens` and the capture land in one call, and the same batch sent again names each one as the
first send did: a keyed re-send is unchanged), else by its id. Several equal: those whose scopes leave the field out go, then
those whose name has no word for the field (when one has), then a variable another candidate aliases; still several,
the value stays raw and the reply lists it (decision 15). Sizes, opacity, stroke weights and pictures are not bound, nor
is a paint style (a tree spec has no fill style; a follow-up). The bound refs resolve through the same resolver as any
written by hand, so the batch stays all or nothing and one undo step. The reply's `bind: {bound, instanced, unbound,
ambiguous?}` replaces `unbound` (decision 20); a dry run a plugin answers carries the same counts.

Instances: the capture's walker reads each element's code component — its `data-component` (`Export` or
`module#Export`, props in `data-props`), else a React development build's fibers (the composite components whose only
host node is the element, outermost first: one that renders several roots, a fragment, is never taken for one of them) — and the first one the component map names (`design/codeconnect.local.json`,
or `--map`) is resolved in the write direction (`design-to-code/code-usage.ts` `figmaUsageOf`: enum values inverted, a
boolean as it is, a `children` string from the rendered text, the `when` values of the one variantOverride whose code
target is the element's and not the entry's own — a value decoded from a code prop the element passed wins, warned when
they differ; a code prop the element does not pass reads back as the one option the read direction writes no code prop
for — mapped to null, or the default with `omitDefault` — else it is left out; what cannot be read back is left at the
component's default and warned). That element lands as an INSTANCE (by the entry's key, else id, else name) at its
place and size, nothing inside it captured — an inline one too (it is never folded into the text around it), and a
`--root` element the map names is that instance inside the keyed screen frame; a component the file lacks refuses the
batch with candidates, as any name does. Slots (instance-swap properties) are not filled from code yet. Parts repeated with no component are
listed in the report as candidate components, each written as a `COMPONENT` spec (a TEXT property per text that differs)
for a `createTree` of its own; making one does not replace the captured copies — map it, then capture again.

With tokens seeded from the code first, this is the whole route from an app to a design system plus its
screens.

## Decisions

### How a write is expressed

1. **Tree spec for creating.** One nested document describes a whole screen and lands in one call. It
   carries no ids, no `parentId` and no references between ops.
2. **Patch ops for changing.** Existing nodes are changed by id, through a typed op table.
3. **No eval.** The plugin never runs code an agent sent. Every write is a row in a fixed, typed table.
4. **Write is the inverse of read.** The spec uses the field names and the compact one-node-per-line form
   of the read export, with defaults omitted. A field the read form has that a write cannot set is
   refused by name, never dropped.
5. **Design-system references are the default path.** A spec names a component (with its property
   values), a variable or a text style; the plugin resolves the name against the file. A component or
   variable key is accepted as exact. Raw values are accepted and counted in the reply as unbound.
   Importing a library component or variable is itself a write, so it runs only under the consent gate.

### The cheap route for each job

| Job | Route | What it costs |
|---|---|---|
| New screen | tree spec with design-system references | one call |
| Several similar screens | clone a node, send only the differences | the delta |
| Fix one node | patch by id | one small op |
| Same change on many screens or pages | one patch with a match rule and a scope | independent of the match count |
| Colour or brand update | change the variable or style once | one op; Figma propagates |
| Fault in a repeated part | patch the local main component once | one op; instances follow |

6. **Clone and patch.** A spec node may say "copy this node, with these overrides": `{clone: id, edits}`, the
   node's own fields a patch of the copy and each edit a patch of one of its layers (by id, or a name unique in the
   source). Built: `figma-plugin/src/clones.ts`.
7. **Repetition.** An instance takes a table of per-row property values (`rows`, optionally with `columns`); a
   fragment defined once in the spec (the root's `fragments`) is reused by name (`use`, with `edits`) for parts that
   are not components. Both are expanded before the spec is checked (`bridge/src/tree-expand.ts`).
8. **Bulk patch by rule.** A patch may select nodes by a rule (text equals, fill equals, uses a variable,
   is an instance of, name matches) within a scope (selection, page, listed pages, file). Its dry run
   answers with counts per page and a few samples, never the full match list. A real run above a
   threshold must carry the token its dry run returned.

   As built (#171): `{op: "patchWhere", where, scope?, set, token?}` (the pure check, words and token in
   `bridge/src/rule-spec.ts`; the file side in `figma-plugin/src/rules.ts`). `where` holds any of `text` (a text's
   characters equal), `fill` (a visible solid fill equal by its 8-bit channels and opacity), `variable` (bound to it,
   directly), `instanceOf` (an instance of the component or its set) and `name` (`*` is any run of characters), all of
   which must hold; `scope` is `"page"` (the current one, the default), `"file"`, `"selection"` or a list of pages. Layers
   inside an instance, a main component or a set are never matched (patching the main component is the source edit). A
   page, variable or component name resolves under decision 15: the variables are the file's own and those layers in scope
   are bound to, the components those its instances in scope are of. The dry run's step is `match: {total, pages,
   samples (3), token, needsToken}`; the token is the match count and a hash of the rule, scope, `set` and the sorted ids,
   so it stands for this change on these layers. A real run over 25 matches (the review's layer limit) without it is
   refused, as is one whose token no longer matches, one that matches nothing and one over 2000 matches. Each match then
   resolves and applies as a patch by id (`patch.ts`): a misfit refuses the batch, counted with three named; each keeps
   what it replaces, so the batch is put back whole and stays one undo step. The reply is `{matched, pages}`.
9. **Source edits.** An existing local variable, local style or local main component may be changed; the
   dry run reports how many nodes or instances follow. Anything that lives in another library file is
   refused, with that file named.
10. **Spec from disk.** `figma_write` takes the spec inline or as a path. A spec a script produced costs
    no model tokens to send, and a corrected one is re-sent without retyping it. Writes stay on the MCP
    server; the CLI gets no write command.
11. **Re-send updates in place.** The spec root carries a key the plugin stores on the node. The same key
    sent again updates the earlier result and reports only what changed.
12. **Images and icons.** An icon is a component instance. An image is a path on disk (the bridge reads
    the bytes) or a reference to an image already in the file. Never base64 in a spec. As built, an image is a
    paint in any `fills` (or a paint style's `paints`): `{type: "image", file}` or `{type: "image", hash}`. The MCP
    server reads each file (inside its directory, by real path; PNG, JPEG or GIF by its bytes; ≤ 8 MB, ≤ 4096 px a
    side; ≤ 32 MB a batch), rewrites the paint to carry the sha-256 of the bytes as `image`, and sends the bytes once
    per image beside the ops; the plugin makes every image and checks every `hash` before the batch runs, and the
    reply lists each made image's Figma hash for reuse. A crop, rotation and filters are not written yet.
13. **Placement.** The spec names a target page (the current one by default) and optionally a section on it, either
    of which it may ask to make; the plugin places a new frame beside what is there without overlap. Explicit
    coordinates are optional.

    As built (#184): a `createTree` op's `page`, `section`, `createPage` and `createSection` (the pure check and the
    dry run's words in `bridge/src/place-spec.ts`; the file side in `figma-plugin/src/places.ts`).
    - **Names, never guesses (decision 15).** `page` and `section` are an exact name or id; a section is looked for on
      the target page, nested ones included. A name that matches several is refused with their ids; one that matches
      nothing is refused with its closest names and the field that would make it. Making is asked for, never inferred
      from a miss: `createPage: true` makes the page when the file has no page of that name, `createSection: true` the
      section when the page has none. A name the file has exactly once is used as it is — so the same batch sent again
      lands where the first send did, and making stays all-or-nothing safe to repeat — and a name it has several of is
      refused even with `create…` (which one is meant is not ours to pick).
    - **Checked on the wire** (writeOpError, the dry run and the plugin alike): only a createTree carries `section`,
      `createPage`, `createSection`; `createPage` needs `page`, `createSection` needs `section`; a name to make is not
      blank, has no spaces at its ends (names match exactly) and does not read as a node id. A section name is never
      blank.
    - **Once per batch.** A page or section to make is planned when the batch resolves, before anything runs: one per
      page name, one per section name on its page. Every op of the batch that names it lands in that one, whether or
      not that op asked to make it. A batch makes at most 10 pages and 25 sections (refused above that). It is made
      when the first op landing there runs, so a batch that is refused or waits for review makes nothing.
    - **Placing in a section.** The frame's `x`/`y` are the section's own (as Figma reads a section child's). Without
      them it goes 100 px right of what the section holds, level with its top; when growing right would run the
      section into one of its neighbours, on a new row 100 px below instead; in an empty section at 80 px from its
      edges. The section then grows — never shrinks, keeping its top-left — to hold the frame with that 80 px margin,
      and so does each section around it. A section that still runs into a neighbour (explicit coordinates, or no row
      that avoids it) is a `warning`, never a refusal: no existing layer is moved to make room. A new section is placed
      on its page as a new frame is (right of everything, level with the topmost), then grows to hold its frames.
    - **All or nothing (decision 14).** A made page and section are Changes on the batch's list, so a later failure
      removes them, newest first, after the frames in them; a section's growth goes back with the frame that caused
      it. A page or section that holds a layer the batch did not make (the designer put one in while a preview was up)
      is not removed: it stays with that layer, listed in `applied`, and the error says why. A page that is the
      current one when it goes is left first (the current page is not undo history); after that wait, its layers and
      "Allow edits" are checked again before it is removed, and it stays (listed as kept) when either has changed. On a Starter plan Figma refuses a
      fourth page, which is only known when it is made: the batch is then put back like any op Figma refuses.
    - **One undo step (decision 16).** Making a page or section and resizing a section are ordinary plugin edits
      inside the batch's commitUndo pair; whether Figma folds a new page into that one step is checked live.
    - **A keyed re-send stays where its result is.** `page` and `section` must be absent or the result's; an update
      neither moves its result nor makes a page or section for it (a re-send into a section its result is not in is
      refused, and nothing is made).
    - **Reply, dry run, card.** The op that made a page or section names it (`pageCreated`, `sectionCreated`: ids);
      a page or section the file had is not named. The dry run says where the frame lands ("in section 'Payment' (made
      when the page has none) on page 'Checkout' (made when the file has none)", "the section grows to fit"); it reads
      no file, so whether the page and section exist is answered when applied. The review card says "lands in section
      'Payment' on page 'Checkout'", "in a new section …", "on a new page …"; Show me pans to where it lands, except on a
      page still to make. A section's growth is said in the card only as "the section grows to fit" in Details; it is
      not counted toward the review's layer limit (a container growing to hold the new frame, not a change to a layer).
    - Not built: moving or resizing an existing section beyond growing it, a section's fills or other fields, page
      dividers, ordering the new page among the others (it is appended), and re-placing a keyed result when the spec
      grows it inside a section (the section is grown only for a new frame).

### Safety

14. **All or nothing, as far as the plugin can put things back.** Everything is checked before the file is touched: names resolve, fonts exist,
    parents exist. A new tree is built to the side and attached only when complete. A patch batch keeps
    the old values and restores them when a later op fails — best effort: nothing is put back once the designer
    turns Allow edits off mid-batch, a restore can fail for one change, an imported library item and a deleted node
    stay. `applied` lists the changes not put back and the deletes already run, not the imported items (a batch
    that fails while importing has an empty `applied`).
15. **Never guess a name.** A name that matches nothing, or more than one thing, refuses the whole write
    before anything runs, listing every bad name with up to three candidates.
16. **One undo per batch.** Figma ends an undo step at each addComponentProperty, editComponentProperty and
    deleteComponentProperty call, the call included (seen live), and a plugin cannot merge steps. A batch that declares,
    edits or deletes component properties is therefore split: it still runs in op order (reordering it to make the
    first Undo take back all it shows changed what the batch does), each press takes back the part after the previous
    property call, and a new component still being built when a step ended is left hidden. The reply says so: `undoSteps` (the property
    calls, plus one if the batch changed the file after the last) and `undoNote`.
17. **Limited destruction.** Create anywhere; overwrite properties of existing nodes; delete and reparent
    only nodes created in the same session.
18. **Consent.** "Allow edits" stays the master switch: with it off a batch is refused before it is ever reviewed. On top
    of it the designer reviews the agent's writes in the plugin window (`figma-plugin/src/review.ts`). As built (#174):
    - **The card** lists the batch in plain words, grouped: "30 layers: radius 6 → 20, opacity 100% → 80%", "Variable
      'color/accent': #3b82f6 → #16a34a — 40 layers follow", "New frame 'Settings card', 320 wide, height hugs content —
      lands right of the existing frames". Old → new values, with a colour swatch for a colour; no node ids, no
      schematic or thumbnail. The lines come from `bridge/src/review-card.ts` (pure) over what the plugin reads of the
      resolved batch (`figma-plugin/src/review-reads.ts`: names, current values, followers, landing spot); the dry run's
      `change` sentences (`commands.ts` `reviewLines`) sit behind a collapsed **Details**. The card says why the batch
      waited. **Show me** on a line selects and zooms to its layers (or pans to where a new frame lands), **Show all**
      to every line's; selection and viewport are not undo history, so neither adds an undo step. Apply, or Reject with
      an optional reason that goes back to the agent (`refused: "rejected"`, `reason`).
    - **Preview on canvas**, offered for a source edit or a batch over the layer limit by itself (and #171's bulk change
      by rule): the batch is applied as it would be on Apply and the card turns to **Keep** / **Put back**. Keep leaves it
      as an applied write; Put back restores it (the put-back a failed batch uses) and the card waits again. Every action
      on a card runs after the one before it, and the window enables its buttons only when the main thread says where
      the card is, so a Put back clicked while the preview is still landing is done, not dropped. Limits: a preview is in
      the file, so everyone in it sees it (the card says so); a preview that is put back leaves **two** undo entries (the
      preview, then the put-back — a Cmd-Z after Put back brings the preview back; a plugin cannot drop a step); not
      offered when the batch deletes or re-sends a keyed tree, which cannot be put back; and if the plugin window
      closes or Figma reloads while a preview is up, nothing can put it back — it stays as applied. A card that ends
      while previewing (withdrawn, expired, out of time) puts the preview back first, unless "Allow edits" was turned
      off, after which the plugin changes nothing and the reply lists the preview as applied.
    - **When a write waits** (`bridge/src/review-policy.ts`, pure): "Review each change first" is ticked — on when
      never set, saved per user, set only from the window — or, whatever the box says, the batch edits a source
      (setVariable, setStyle, a patch of a main component or a layer in one: a change other layers follow), or it is a
      bulk change by rule (a `patchWhere` sets `bulkByRule`), or the existing layers changed since the
      designer's last approval exceed 25 (fixed). Counted: existing layers a batch patches, moves or deletes (a keyed
      re-send: each layer of its earlier result whose fields change, that changes place among its frame's children, or
      that it removes) plus the layers and instances that follow its source edits, each once; layers this plugin
      session created do not count. The count is per plugin session and goes back to 0 when the designer approves a
      batch or keeps a preview. The dry run reports `wouldWait` and `waitReason` (and `waitingTicket` when one waits)
      by the same rule over what it can see (a keyed re-send's count, `changedLayers`, is the plugin's, planned against
      the spec as sent). On approval the batch is resolved again against the file as it is then; a rule's matches are counted again there
      and the batch is refused when their token is not the one the card was built from.
    - **How the agent waits — a ticket the plugin owns.** MCP clients built on the TypeScript SDK time a tool call out
      at 60 s by default, so one call holds at most 45 s (`REVIEW_HOLD_MS`; `DTWIN_REVIEW_HOLD_MS` overrides it for
      tests, within 0…50 s): then the plugin answers `{pending, ticket, why, waited, note}` and keeps the card up.
      `figma_write {ticket}` sends `writeTicket`, which the plugin answers with the result once there is one, or
      pending again after the hold; `{ticket, cancel: true}` withdraws it (card down, nothing applied, a preview put
      back), answered within the same hold: when the card is busy longer (an approved batch applying, a preview being
      put back) it answers pending, and the next `{ticket}` gets the outcome (an approved batch already running is not
      withdrawn: its result is the outcome). Finished outcomes are kept a while (the newest 20, 30 min), so a repeat answers at once, and an MCP server
      restart loses nothing. A card whose ticket is not asked about within 2 min of its last pending answer ends
      "withdrawn — the agent stopped waiting"; no card stays up longer than 15 min. One waiting card at a time: a second
      batch is refused at once, naming the waiting ticket (`refused: "waiting"`). A late poll gets a refusal that says
      nothing changed. `figma_status` reports the last write's outcome (`lastFigmaWrite`), including one the designer
      answered after the agent stopped asking (`unseen`). A card going up also shows a Figma toast and takes down a
      stale red one. Closing the plugin window or reloading Figma drops a waiting card, applying nothing.

### Cost control

19. **One tool.** `figma_write` stays the single write tool with a short schema. The grammar lives in a
    skill reference that loads only when an agent is about to write. As built, the grammar is
    `claude-plugin/skills/design-in-figma/references/grammar.md`, which that skill reads before a first write. The
    tool's description is the op names with a line each, the dry-run rule and a pointer to that reference (its size is
    `toolDefinition` in `test/write-cost/baseline.json`); the input schema is unchanged. A client without the skill
    learns the rest from the refusals, which name each offending field by path.
20. **Small replies.** A write answers with the root id, counts, and failures and warnings only. Ids come
    back only for nodes the spec gave a handle. No tree and no screenshot by default; the outline read of
    the new root is the check.
21. **A measured budget.** A fixture suite measures total tokens (spec out, reply in, verify and fix
    rounds) and round trips for each job in the table above, against the fake plugin, with the four-op
    path as the baseline. It is `test/write-cost.test.ts` (`bun test/write-cost.test.ts`); the recorded numbers are in
    `test/write-cost/baseline.json`, and a new route is added to `test/write-cost/routes.ts`. Its seventh job is a new
    screen and the fix round its check leads to; its eighth starts from nothing (a token table, then a screen bound to
    it); its ninth (`create-components` / `blank-file`) starts from a blank file: 7 colour tokens in light and dark, a
    5-component kit (two icons, a 4-variant Button set with TEXT, BOOLEAN and INSTANCE_SWAP properties, an Input, a
    Card), then a sign-up screen of their instances — recorded at 4 calls, 7 ops, about 2,171 tokens (1,023 out, 1,148
    in; the replies' `undoSteps` / `undoNote` count toward the input). Its tenth (`capture-page`) lands one captured
    page: a generic 39-node dashboard captured at 1280 px with three images (`test/fixtures/capture/sample`, the
    converter's output from a committed capture), sent by `treeFile` — recorded at 1 call, 1 op, about 184 tokens
    (28 out, 156 in), against 6 calls, 39 ops and about 2,184 tokens for the four-op route typing it node by node
    (which cannot place its images). Its eleventh (`capture-bind`) is the whole route from an app: the project's 9 code tokens
    (`test/fixtures/capture/bind/tokens.dtcg.json`: 6 colours, one an alias, 2 spacings, a radius) seeded, then a captured
    9-node settings panel with two instances of the file's Button landed with `bind: true` — one call with both ops,
    recorded at 1 call, 2 ops, about 196 tokens (43 out, 153 in; the reply binds 13 values and leaves 10 raw), against 5
    calls, 9 ops and about 698 tokens for the four-op route typing it node by node (no variables, no instances). Adding
    `bind` to `figma_write`'s schema and description took `toolDefinition` from 1,229 to 1,257. The same change on many
    screens (`rule-patch` / `same-change-many`: one footer text on 12 screens across 3 pages) is one `patchWhere` call —
    recorded at 1 call, 1 op, about 46 tokens (34 out, 12 in), against 14 calls, 12 ops and about 5,894 tokens for the
    four-op route (a page list, an outline per screen, then the setText ops), and the op does not grow with the matches. The
    way a run over 25 matches goes (`rule-patch-token`: the dry run, then the run carrying its token) is recorded on the
    same job at 2 calls, 1 op, about 519 tokens (78 out, 441 in: the dry run's preview and `match`).
    Adding `patchWhere` to the schema and description took `toolDefinition` from 1,287 to 1,400; adding `section`,
    `createPage` and `createSection` (#184) took it to 1,449.

## Build order

Each piece is its own pull request into the write-plane base branch and is usable on its own. Pieces in
one wave can be built in parallel.

1. The measurement suite and its baseline; the tree spec (frames, auto-layout, text, placement, all or
   nothing).
2. Design-system references; patch by id with one undo per batch; a plain approve/reject card; spec from
   disk with stable keys and re-send updating in place. Checked against live Figma before wave 3.
3. Source edits; clone and patch with repetition; the designing skill and the docs. The review prototype
   runs alongside.
4. Starting from nothing: create variables and styles; seed them from code tokens; create components.
5. From an existing app to Figma: images; capture a rendered page as a screen; bind the capture to the
   file's variables and components.
6. Bulk patch by rule, with the dry-run token, once the review prototype has answered.

Starting from nothing comes before bulk patch because its chain of dependencies is the longest. All of it
is new TypeScript on the current op table, the consent gate and the whole-batch check.

## Out of scope for now

Raw SVG input; deleting or moving nodes
the agent did not create; verify-after-write against code; a rendered before/after picture.
