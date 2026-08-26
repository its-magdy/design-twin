# Figma → code (free-plan workflow)

A repeatable, genuinely-free way to feed a Figma design to an AI coding agent (Claude Code).
No Figma REST API (throttled to ~6 requests/month on free files), no paid Dev Mode MCP.
Everything runs through the **Figma Plugin API** inside your open file, with **no network egress**.

## Stack-agnostic by design
The **extraction half is identical for every target** — the plugin and its JSON are a neutral
intermediate representation (Auto Layout expressed as flex intent, which maps equally to flexbox,
SwiftUI stacks, and Compose Row/Column). Only the **translation half** is stack-specific, and it lives
in three small places: `design/target.json` (which stack), `profiles/<profile>.md` (how to translate),
and the right-hand values in `tokens.json`/`components.json`. One plugin, any framework.

## Pieces
- `figma-plugin/` — a self-authored Figma plugin (`allowedDomains: ["none"]` → cannot phone home).
  Exports the current selection as compacted JSON (IR), a variables snapshot, and real SVG/PNG assets.
- `.claude/skills/figma-to-code/SKILL.md` — the agent workflow (resolve target → read → map → build → self-correct).
  Invoke with `/figma-to-code <screen>`.
- `.claude/skills/figma-help/SKILL.md` — orientation/help: the three export paths, setup, and
  troubleshooting. Invoke with `/figma-help` when unsure how to use this or something isn't working.
- `tooling/` — the **design-to-code layer** (free-plan Code Connect equivalent + token pipeline): a
  DTCG token emitter, a schema'd/validated component map, a drift-lint, a map bootstrapper, and
  `get-component.js` (resolve one catalog entry by key/id/name and follow its `variantsFile`/`nodeFile`
  to the real node trees). This is
  the formalized superset of the simple `design/components.json`/`design/tokens.json` maps below. See
  `tooling/README.md` (who/what/how/why) and `docs/design-to-code-spec.md` (the sourced ADR).
- `profiles/<profile>.md` — IR→stack translation rules. Ships with `web-tailwind`, `web-css-modules`,
  `react-native`, `swiftui`, `android-compose`; add your own by copying `profiles/_template.md`.
- `design/` — a **generated, untracked drop-target** (does not exist until you create it or run an
  export). It holds two kinds of files:
  - **Generated exports** (regenerable — recreated on every plugin export / `figma-pull` run):
    `<screen>.json`, `variables.json`, `assets/` (icons/images **plus** a full-frame reference PNG
    per frame, referenced from the JSON's `reference` field), and for full pulls `design-system.json`
    — a slim manifest (`exportedAt`/`file`/`colorProfile` + pointers + counts) over the catalog split
    under `design-system/`, following Figma's own taxonomy: `tokens.json` (variable **collections →
    modes → variables**), `styles.paint.json`/`styles.text.json`/`styles.effect.json`/`styles.grid.json`
    (the separate, older style system, one file per style type),
    `components.local.json` (component sets/variants that are real nodes in this file — each
    COMPONENT_SET's own heavy per-variant node tree, or a standalone COMPONENT's own node tree, lives
    in a sibling `components/<name>__<id>.json`, pointed at by that entry's `variantsFile`/`nodeFile`;
    `tooling/get-component.js` resolves one and follows it),
    `components.library.json` (entries flagged `remote: true` — consumed from a published library,
    recovered from instances, **not** nodes here) and `hygiene.json` (the lint report)
    and, when you pull a LIBRARY file with `--as-library`, `libraries/index.json` + one
    `libraries/<slug>-<fileKey8>/` per library (same taxonomy as `design-system/`, plus `index.json`
    and a `source` block naming the library; a library catalog is the COMPLETE contents of that library
    file, whereas `design-system/` is the design file's own — the two join on `key`, never on names)
    + `pages/index.json` + one `pages/<page>/index.json` + `pages/<page>/<name>__<id>.json` per **layer**
    — split per-page, per-file rather than one combined `screens.json` (a real export can be tens of
    MB), mirroring Figma's own Page > Frame containment (a page holds many layers, never the reverse).
    ("Layer" is Figma's own term for any object in a file; "screen" here stays reserved for a single
    node you deliberately selected — `<screen>.json` above — not everything a full-page walk sweeps up.)
  - **Your config maps** (hand-authored — **not** regenerable, so back them up): `target.json`
    (which stack; auto-detected if absent), `tokens.json` (Figma variable → your code token; styling
    source of truth), `components.json` (Figma component → your code component + import; reuse source
    of truth).

## One-time setup
`design/` starts empty (or absent) — the plugin export / `figma-pull` creates it and its generated
files. You only author the config maps below.
1. Figma desktop app → **Plugins → Development → Import plugin from manifest…** → pick `figma-plugin/manifest.json`. (`code.js` is committed pre-built, so no build is needed to use it. To edit the extractor, see `figma-plugin/README.md` — TypeScript source lives in `figma-plugin/src/`, `npm run build` regenerates `code.js`.)
2. Create `design/target.json` for your stack (or let the skill auto-detect from the repo on first run
   and offer to write it). If your stack isn't in `profiles/`, copy `profiles/_template.md` to
   `profiles/<name>.md` and fill it in.
3. Create `design/tokens.json` and `design/components.json` for your project. Shapes:
   - `tokens.json` — `{ "color": { "color/primary": "<your token>" }, "spacing": {…}, "radius": {…}, "typography": {…} }`
     (left = Figma variable path from `variables.json`; right = your stack's token form).
   - `components.json` — `{ "Button": { "import": "import { Button } from '@yourorg/ui'", "component": "Button", "props": { "Variant": "variant" } } }`.
   These are optional but recommended: without them the skill auto-detects the stack, regenerates
   components instead of reusing yours, and the token drift check has nothing to compare against.

## Per-screen loop
1. In Figma, select the frame → run **Plugins → Development → Design Export for AI** →
   click **Export current selection** (or **Export design system + all page frames** for a full pull).
2. Save the resulting **Download …** links into `design/`:
   - "Download <screen>.json" → `design/<screen>.json`
   - "Download variables.json" → `design/variables.json`
   - "Download assets (N)" → `design/assets/` — this now includes a **full-frame reference PNG**
     per top-level frame (asset `kind:"reference"`, longest side capped ~2048px). The `<screen>.json`
     points at it via a `reference` field, and `/figma-to-code` self-corrects against it. No manual
     screenshot step needed anymore.
3. In Claude Code: `/figma-to-code <screen>` (or: "build <screen> from design/<screen>.json").

## Why this shape (evidence)
- Structured metadata beats a screenshot alone for fidelity, but **raw** metadata makes models hardcode
  absolute coordinates — so the plugin maps Auto Layout → flex intent and resolves variable bindings to
  semantic token names. A full-frame reference screenshot is auto-included for visual ground truth (multimodal).
- Figma's Variables **REST** API is Enterprise-only, but the **Plugin** API reads variables + per-node
  bindings for free — which is why this is a plugin, not a REST tool.

## Upgrade path (later, optional)
If manual export gets tedious, swap the file handoff for a **localhost-only** WebSocket bridge
(`devAllowedDomains: ["ws://localhost:8787"]` — reaches your machine, never the internet). Loopback isn't
authentication, so the bridge is gated by a **shared token** you paste into the plugin once (see
`bridge/README.md`). The Skill and the token/component maps carry over unchanged.

Two front-ends sit on that bridge, and they speak the same commands:
- **`figma-pull` CLI** — bulk reads streamed to disk. Add `--serve` to hold the connection open so
  later pulls skip the plugin reconnect; `--stop` ends it.
  Start with the cheap discovery steps: `--list-libraries` (which design libraries this file draws on)
  then `--list` (pages + frame ids), and only then `--page <id>` to pull what you actually need.
  Only want the tokens/styles/components/hygiene catalog, no screens? `--design-system` skips the
  page/frame walk entirely (and the assets that walk would export); each catalogued component still
  carries its own fills/strokes/effects/radius/opacity/blendMode (see `bridge/README.md`).
- **`figma-mcp`** — live tools for "check this, now pull that", plus the small write surface. Pass
  `writeToDisk: true` on the export tools to write files and get back a compact index instead of the
  payload — the only way to get asset bytes, and the right choice for anything large.

Only one of them can hold port 8787 at a time; run the one that matches what you're doing.

**Several Figma FILES at once, though.** The bridge accepts one connection per open Figma file, so a
design file and the library it draws on can both be connected and driven in the same session. Each
plugin announces which file it is on connect; commands are then addressed:

```
node bridge/figma-pull.js --list-clients            # which files are connected (connId, name, fileKey)
node bridge/figma-pull.js design/base --client "App"      # pull one
node bridge/figma-pull.js design/lib --client "NERA" --as-library "NERA"
```
MCP twins: `figma_list_clients`, and a `client` argument on every tool.

With **one** file connected you can omit `--client` entirely — nothing changes from before. With
**several**, omitting it is an error that lists your choices rather than a guess: an export from the
wrong file looks exactly like a correct one, so the bridge refuses instead of picking. Give each file
its own output directory (as above) and their exports never collide.

**Discover before you pull.** Both front-ends expose a library-discovery step —
`node bridge/figma-pull.js --list-libraries` and the `figma_list_libraries` MCP tool — that reports
which design libraries the open file draws on, their variable collections, and how many of their
components this file uses. Consult it first, then scope the export (`--list` → `--page <id>`), the
same way Figma's own agent guidance says to discover first and scope by library. Two limits to keep in
mind: Figma has **no API to enumerate a library's contents**, so component counts are *usage-derived*
(what this file uses, not what the library holds); and libraries can only be **enabled from the Figma
UI**, never via API, so any export is silently scoped to whatever was enabled when it ran.

> **Re-import the plugin after updating.** Library reads require `"permissions": ["teamlibrary"]` in
> `figma-plugin/manifest.json`. A plugin imported before that was added keeps working but returns **no
> libraries at all**, silently. If library discovery comes back empty, re-import the manifest in Figma
> (Plugins → Development → Import plugin from manifest…) before assuming your file has none.
