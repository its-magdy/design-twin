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
  DTCG token emitter, a schema'd/validated component map, a drift-lint, and a map bootstrapper. This is
  the formalized superset of the simple `design/components.json`/`design/tokens.json` maps below. See
  `tooling/README.md` (who/what/how/why) and `docs/design-to-code-spec.md` (the sourced ADR).
- `profiles/<profile>.md` — IR→stack translation rules. Ships with `web-tailwind`, `web-css-modules`,
  `react-native`, `swiftui`, `android-compose`; add your own by copying `profiles/_template.md`.
- `design/` — a **generated, untracked drop-target** (does not exist until you create it or run an
  export). It holds two kinds of files:
  - **Generated exports** (regenerable — recreated on every plugin export / `figma-pull` run):
    `<screen>.json`, `variables.json`, `assets/` (icons/images **plus** a full-frame reference PNG
    per frame, referenced from the JSON's `reference` field), and for full pulls `design-system.json`
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
- **`figma-mcp`** — live tools for "check this, now pull that", plus the small write surface. Pass
  `writeToDisk: true` on the export tools to write files and get back a compact index instead of the
  payload — the only way to get asset bytes, and the right choice for anything large.

Only one of them can hold port 8787 at a time; run the one that matches what you're doing.
