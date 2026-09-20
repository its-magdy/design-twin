# Change-review / visual-diff research handoff

Status: research only, nothing built. Captures findings from a research thread
(2026-09-02) on how to let a human review changes Claude Code makes to a Figma
file (potentially across multiple pages), without using the REST API.

## The ask

Build something like Figma's Enterprise branching "review changes" screen —
but for everyone, not just Enterprise — so a human can see exactly what
Claude changed after a write-plane session, including when other designers
may have edited the same file concurrently.

## What Figma gives you natively (no building required)

- **Version History**: whole-file snapshots, ~30min auto-checkpoints + manual
  named saves. No real diff — you toggle between snapshots and eyeball it.
  Free/Starter: 30-day window. Pro+/Org: full history.
- **Branching + merge review**: Org/Enterprise, Full seat only. Real
  side-by-side diff broken out by page, Approve/Suggest before merge. This is
  the actual feature we'd be approximating. Not available to us (assume
  non-Enterprise).
- **Dev Mode "Changed" status**: a frame marked ready-for-dev auto-flags
  "Changed" if edited after, with a diff-against-handoff view. File/frame
  level, not attributed to a person.
- **Comments**: review mechanism, not a diff.

## What's confirmed buildable (Plugin API only, no REST)

Three layers, meant to be combined:

1. **Before/after snapshot diff**
   - Capture via `node.exportAsync()` (PNG/SVG/etc, any node type, no REST
     rate limits, runs off the live canvas) + the plugin's existing JSON node
     read.
   - Diff images with pixelmatch or odiff (odiff outputs a highlighted
     overlay image showing changed regions — matches "visual diff" ask).
   - Diff JSON trees for a structured added/removed/modified node list.
   - Ship both snapshots to disk via the existing bridge (matches current
     CLI=read architecture) — capture "before" once, close, edit, reopen,
     capture "after," diff offline. No need for the plugin open continuously
     for this layer.

2. **Live `documentchange` listener (the strongest finding)**
   - `figma.on('documentchange', cb)` — requires
     `"documentAccess": "dynamic-page"` + `figma.loadAllPagesAsync()` first.
   - Payload: `{documentChanges: DocumentChange[]}`, each with `type`
     (CREATE/DELETE/PROPERTY_CHANGE/STYLE_CREATE/STYLE_DELETE/
     STYLE_PROPERTY_CHANGE), `id`, and — critically —
     **`origin: 'LOCAL' | 'REMOTE'`**.
   - Doc-verbatim: `origin` is *"LOCAL... from the user running the plugin"*
     vs *"REMOTE... from a different user in the file."* This is the only
     real collision-detection signal that exists — confirms/refutes whether
     someone else edited the file during Claude's session.
   - Gives property *names* changed, not old/new values (still need snapshot
     diff for that). Nested creates/deletes only report the top-level parent.
   - Batched, not synchronous — real delay expected.
   - Trade-off: the lighter `nodechange`/`stylechange` events Figma
     recommends for performance **do not have the origin field at all** —
     only `documentchange` does. You cannot get cheap + attributed at the
     same time. Also `loadAllPagesAsync()` is explicitly documented as slow
     on large files.
   - Must be listening live for the whole session — no persistence, no
     replay, nothing captured if the plugin isn't open and running at the
     moment of the change.

3. **`setPluginData`/`getPluginData` self-tagging**
   - Stamp `agentId:timestamp` on nodes as Claude's plugin creates/edits
     them → durable, inspectable later (unlike `documentchange`, which only
     exists during the live session).
   - ~100KB cap per pluginId+key+value entry. Only tags what your own plugin
     writes — doesn't detect others' changes (that's `documentchange`'s job).

## Confirmed gaps — do not re-research these, they are closed

- **No node/edit-level author attribution anywhere** in Figma (Plugin API or
  REST). REST version checkpoints attribute to whoever triggered *that save*
  only — a single checkpoint can contain interleaved edits from multiple
  people.
- **Figma's multiplayer engine is last-writer-wins**, single flattened
  shared document, no retained per-user op log server-side (confirmed via
  Figma's own eng blog, "How Figma's multiplayer technology works").
- **`figma.activeUsers` (presence API) is FigJam-only.** Not available for
  Design files at all. No presence/collision signal exists for Design files
  outside of `documentchange`'s origin field.
- **Plugin API has zero read access to past version history.** Only
  `figma.saveVersionHistoryAsync()` exists (write-only, creates a new
  checkpoint). No get/list/read of prior versions. If you don't capture a
  "before" snapshot proactively, it cannot be recovered later via Plugin API
  — REST would be required (`GET /v1/files/:key?version=X`), which we're
  choosing not to use.
- **No node timestamp properties** (`createdAt`/`updatedAt`) documented
  anywhere on the base node properties.
- **REST `/v1/images` has real reliability problems** if ever reconsidered:
  documented `version=` param 400 errors on some org/plan tokens, stricter
  real-world rate limits than published, forum reports of dropped elements
  on re-render. Reinforces the decision to stay Plugin-API-only.

## Open items — not yet verified, worth testing before building

1. **Node ID stability** across move/reparent/property-edit/close-reopen —
   community consensus says stable, but this is *not officially documented
   anywhere*. Needs an empirical test in `figma-plugin/` against a real file
   before the per-node diff/list layer can be trusted.
2. **`exportAsync()` render determinism** — no formal Figma statement either
   way. Structurally should be more reliable than REST (renders live canvas,
   not a server re-render) but has its own known bug (broken SVG
   pattern/image linkage on image-filled shapes). Worth testing: export the
   same unchanged node twice, confirm byte/pixel-identical output, before
   trusting a version-to-version pixel diff as signal instead of noise.
3. **`documentchange` reliability** — forum reports exist of some property
   changes (e.g. list indentation) not triggering the event at all. Unclear
   if resolved. Don't treat `documentchange` as a complete change log; treat
   it as a collision/attribution signal layered on top of snapshot diffing,
   not a replacement for it.
4. Whether `stylechange`'s payload also lacks `origin` (strongly assumed yes
   by pattern with `nodechange`, but not directly fetched/confirmed).

## Explicitly out of scope / rejected directions

- REST API — user does not want this used, and this repo's architecture
  already deliberately avoids REST in favor of the Plugin API bridge (see
  `figma-free-plan-design-to-code.md` in memory).
- True "branching" (isolate-then-merge-or-reject before it lands in the main
  file) is **not achievable** without Figma Enterprise. What's buildable here
  is the *review/reporting* half only — Claude's edits already happen live
  in the file by the time a human sees the diff. Rollback, if needed, would
  rely on the write-plane's existing undo mechanism (see
  `figma-write-surface-assessment.md` in memory — write-plane branch has
  identity+drift+undo+variables, parked, not on main).

## Suggested next step (not started)

Check what the parked `write-plane` branch's existing "drift" detection
already covers — per memory it already has identity+drift+undo+variables
built (24 write ops). May overlap significantly with layer 1/3 above before
building anything new.
