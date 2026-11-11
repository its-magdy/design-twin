# Write plane — agreed design (ADR)

Status: **accepted, not built** (the four ops `figma_write` has today are the baseline this replaces)
Date: 2026-11-11

This document records the design agreed for letting an agent write to a Figma file at the lowest token
cost. It complements `ARCHITECTURE.md` (the read/write planes, the consent gate) and `SECURITY.md`.
Where the two disagree once a step below lands, that step updates `ARCHITECTURE.md`.

## Problem

`figma_write` has four ops (`createFrame`, `createText`, `setFill`, `setText`). Every node is one op
carrying a `parentId`, so a tree is built by create, read the id back, create the children. A screen costs
a round trip per level and an op per node, colours are raw hex, and nothing can use a component, a
variable or a style. The cost grows with the node count in both directions: ops out, ids back.

## Scope

In scope first: **compose new screens from the existing design system**, and **patch existing nodes**.
Later, on the same pieces: code → design sync, and authoring the design system itself (new variables,
styles, components).

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

6. **Clone and patch.** A spec node may say "copy this node, with these overrides".
7. **Repetition.** An instance takes a table of per-row property values; a fragment defined once in the
   spec is reused by name for parts that are not components.
8. **Bulk patch by rule.** A patch may select nodes by a rule (text equals, fill equals, uses a variable,
   is an instance of, name matches) within a scope (selection, page, listed pages, file). Its dry run
   answers with counts per page and a few samples, never the full match list. A real run above a
   threshold must carry the token its dry run returned.
9. **Source edits.** An existing local variable, local style or local main component may be changed; the
   dry run reports how many nodes or instances follow. Anything that lives in another library file is
   refused, with that file named.
10. **Spec from disk.** `figma_write` takes the spec inline or as a path. A spec a script produced costs
    no model tokens to send, and a corrected one is re-sent without retyping it. Writes stay on the MCP
    server; the CLI gets no write command.
11. **Re-send updates in place.** The spec root carries a key the plugin stores on the node. The same key
    sent again updates the earlier result and reports only what changed.
12. **Images and icons.** An icon is a component instance. An image is a path on disk (the bridge reads
    the bytes) or a reference to an image already in the file. Never base64 in a spec.
13. **Placement.** The spec names a target page (the current one by default) and optionally a section; the
    plugin places a new top-level frame beside the existing ones without overlap. Explicit coordinates are
    optional.

### Safety

14. **All or nothing.** Everything is checked before the file is touched: names resolve, fonts exist,
    parents exist. A new tree is built to the side and attached only when complete. A patch batch keeps
    the old values and restores them when a later op fails.
15. **Never guess a name.** A name that matches nothing, or more than one thing, refuses the whole write
    before anything runs, listing every bad name with up to three candidates.
16. **One undo per batch.**
17. **Limited destruction.** Create anywhere; overwrite properties of existing nodes; delete and reparent
    only nodes created in the same session.
18. **Consent.** "Allow edits" stays the master switch. A designer review step (approve or reject each
    change in the plugin window, with an optional reason that goes back to the agent) sits on top of it.
    Its exact form, when it applies and how the agent waits are **not decided**: they are to be
    prototyped. The write path only produces a plain description of the change, which the dry run needs
    anyway, so every candidate form displays the same data.

### Cost control

19. **One tool.** `figma_write` stays the single write tool with a short schema. The grammar lives in a
    skill reference that loads only when an agent is about to write.
20. **Small replies.** A write answers with the root id, counts, and failures and warnings only. Ids come
    back only for nodes the spec gave a handle. No tree and no screenshot by default; the outline read of
    the new root is the check.
21. **A measured budget.** A fixture suite measures total tokens (spec out, reply in, verify and fix
    rounds) and round trips for each job in the table above, against the fake plugin, with the four-op
    path as the baseline.

## Build order

Each step is its own pull request into the write-plane base branch and is usable on its own.

1. The measurement suite; the tree spec (frames, auto-layout, text, instances, variables, styles,
   placement, all or nothing); a plain approve/reject card.
2. Patch by id with the wider property set; stable keys; re-send updates in place; one undo per batch.
3. Clone and patch; repetition; images from disk.
4. Bulk patch by rule, with the dry-run token.
5. Source edits.

The designing skill and the docs are updated as each step lands. All of it is new TypeScript on the
current op table, the consent gate and the whole-batch check.

## Out of scope for now

Code → design sync; creating variables, styles and components; raw SVG input; deleting or moving nodes
the agent did not create; verify-after-write against code; a rendered before/after picture.
