# Design Twin

**Figma → code, on the free plan.**

A repeatable, genuinely-free way to feed a Figma design to an AI coding agent (Claude Code).
No Figma REST API (throttled to ~6 requests/month on free files), no paid Dev Mode MCP.
Everything runs through the **Figma Plugin API** inside your open file, with **no network egress**.

## Stack-agnostic by design
The **extraction half is identical for every target** — the plugin and its JSON are a neutral
intermediate representation (Auto Layout expressed as flex intent, which maps equally to flexbox,
SwiftUI stacks, and Compose Row/Column). Only the **translation half** is stack-specific, and it lives
in three small places: `design/target.json` (which stack), `profiles/<profile>.md` (how to translate,
in `claude-plugin/skills/build-screen/profiles/` — a project can override with its own root-level `profiles/`),
and the right-hand values in `tokens.json`/`components.json`. One plugin, any framework.

## Pieces
- `figma-plugin/` — a self-authored Figma plugin (`allowedDomains` lists only `ws://localhost` → cannot phone home).
  Exports the current selection as compacted JSON (IR), a variables snapshot, and real SVG/PNG assets.
- `claude-plugin/skills/audit-design/SKILL.md` — the pre-build design review a senior frontend/iOS/Android
  engineer does: token binding, spacing grid, component + screen states (loading/empty/error), touch
  targets, contrast, font scaling, theming, RTL, platform chrome, effects that won't translate — ending
  in `design/audit/<screen>.md` with a verdict and designer questions (each with a default). Backed by
  `design-to-code/audit.js`. Invoke with `/designtwin:audit-design <screen>`.
- `claude-plugin/skills/build-screen/SKILL.md` — the agent workflow (resolve target → gate + audit → map plan →
  build leaf-first → states/scaling/theme/RTL → render-and-compare verification).
  Invoke with `/designtwin:build-screen <screen>`.
- `claude-plugin/skills/extract/SKILL.md` — get the design out of Figma onto disk (path selection,
  discover-then-scope, manifest check). Invoke with `/designtwin:extract`.
- `claude-plugin/skills/help/SKILL.md` — orientation: the three ways to connect, one-time setup, and
  (in `references/troubleshooting.md`) the symptom→fix list. Claude loads it on "how does this work"
  questions and on bridge errors; `/designtwin:help` invokes it by hand.
- `design-to-code/` — the **design-to-code layer** (free-plan Code Connect equivalent + token pipeline): a
  DTCG token emitter, a schema'd/validated component map, a drift-lint, a map bootstrapper, the
  pre-build design audit (`audit.js`), and
  `get-component.js` (resolve one catalog entry by key/id/name and follow its `variantsFile`/`nodeFile`
  to the real node trees). This is
  the formalized superset of the simple `design/components.json`/`design/tokens.json` maps below. See
  `design-to-code/README.md` (who/what/how/why) and `docs/design-to-code-spec.md` (the sourced ADR).
- `claude-plugin/skills/build-screen/profiles/<profile>.md` — IR→stack translation rules, shipped with the
  skill. Covers `web-tailwind`, `web-css-modules`, `react-native`, `swiftui`, `android-compose`,
  `flutter` — including exact text-metric, stroke, shadow/blur, safe-area, accessibility/RTL and motion
  conversions (e.g. Figma letter-spacing % → em on Compose/CSS, points on iOS); add
  your own by copying `_template.md` to a root-level `profiles/<name>.md` in *your* project (it
  overrides the skill's bundled set).
- `design/` — the project's design directory, laid out in two halves so the line between
  "regenerable" and "irreplaceable" is visible rather than remembered:

  **`design/export/` — `dtwin` writes here and nowhere else.** Delete it and re-pull and you lose
  nothing.
  - `pages/index.json` → `pages/<Page>/index.json` → `pages/<Page>/<Name>__<node-id>.json` — **one
    file per layer, and per screen**. A `--node` pull and a `--page` pull file into the same tree, so
    nothing downstream needs to know which produced a file. The node id is in the name because a
    frame NAME does not identify a frame (two `Popup`s on one page are two screens). Split per-page,
    per-file rather than one combined JSON — a real export is tens of MB. ("Layer" is Figma's own term
    for any object in a file; "screen" stays reserved for a node you deliberately selected.)
  - Beside each screen: `…__<id>.vars.json` (exactly the variables it binds) and `…__<id>.assets.json`
    (its assets with content hashes, plus `duplicates`, `monochrome` and `heavy`).
  - `variables.json` — the **union** of every screen pulled here. It merges, keyed on each variable's
    Figma key, so pulling a second screen does not delete the first's tokens.
  - `assets/` — icons/images named after their Figma layer and deduped by content, **plus** a
    full-frame reference PNG per frame (referenced from the JSON's `reference` field), and any
    single-node reference shot by `dtwin screenshot <id>` / `figma_screenshot`.
  - `design-system.json` (full or `--design-system` pulls) — a slim manifest
    (`exportedAt`/`file`/`colorProfile` + pointers + counts) over the catalog split under
    `design-system/`, following Figma's own taxonomy: `tokens.json` (variable **collections → modes →
    variables**), `styles.paint.json`/`styles.text.json`/`styles.effect.json`/`styles.grid.json` (the
    separate, older style system, one file per type), `components.local.json` (component
    sets/variants that are real nodes in this file — each COMPONENT_SET's heavy per-variant node
    tree, or a standalone COMPONENT's own tree, lives in a sibling `components/<name>__<id>.json`
    pointed at by that entry's `variantsFile`/`nodeFile`; `design-to-code/get-component.js` resolves
    one and follows it), `components.library.json` (`remote: true` — consumed from a published
    library, recovered from instances, **not** nodes here) and `hygiene.json` (the lint report).
  - `libraries/index.json` + one `libraries/<slug>-<fileKey8>/` per library pulled with
    `--as-library` (same taxonomy as `design-system/`, plus a `source` block naming the library). A
    library catalog is the COMPLETE contents of that library file, whereas `design-system/` is the
    design file's own — the two join on `key`, never on names.

  **Everything else under `design/` is yours** — hand-authored or written by a skill, and **not
  regenerable**: `README.md` (says exactly this, where someone about to delete files will see it),
  `target.json` (which stack), `tokens.json` (Figma variable → your code token),
  `codeconnect.local.json` (Figma component → your code component + import), and `plan/`, `audit/`,
  `verify/`, `sync/` — the decisions and evidence each skill produces. Commit them.

  Projects created before this split keep their export directly in `design/`; everything still finds
  it, and `dtwin doctor` reports which layout it found.
    of truth).

## One-time setup
> Needs the Figma **desktop app** — a browser tab cannot import a development plugin. Nothing here is
> published yet (npm, Figma Community), so everything runs from a clone of this repo.

1. **Get the tools.** `git clone` this repo, then `cd bridge && npm install`. For a `dtwin` command
   on your PATH run `npm link` there as well; otherwise spell it `node /path/to/design-twin/bridge/figma-pull.js`.
2. **Import the Figma plugin.** Figma desktop app → **Plugins → Development → Import plugin from
   manifest…** → pick `figma-plugin/manifest.json`. (`code.js` is committed pre-built, so there is
   nothing to build. To edit the extractor see `figma-plugin/README.md`.)
3. **Install the Claude Code plugin** — this is what provides `/designtwin:extract`,
   `/designtwin:audit-design` and `/designtwin:build-screen`:
   `claude plugin marketplace add /path/to/design-twin` then
   `claude plugin install designtwin@designtwin-marketplace`
   (or, for one session only, `claude --plugin-dir /path/to/design-twin/claude-plugin`).
4. **Set up the project you are building.** In its root run **`dtwin init`** (add `--mcp` to register
   the MCP server, `--dry-run` to preview). It creates `design/` and `design/export/`, writes
   `design/README.md` and `design/target.json` (the detected stack, or `profile: null` for
   build-screen to fill in on its first run), makes sure a bridge token exists, and prints the steps
   left. Paste the token into
   the plugin's **Bridge token** field once (`dtwin token show` prints it). It never overwrites a file.
5. **Check it.** Open the Figma file, run the plugin, then `dtwin doctor` — it says exactly which of
   token / port / plugin / project is not right yet.

No terminal at all? Skip 1, 4 and 5: the plugin's export buttons produce download links, and you save
those into `design/` by hand (step 2 of the loop below).

**Tell it about your code (recommended).** Without these the skill regenerates components instead of
reusing yours, and the token drift check has nothing to compare against:
- **`design/codeconnect.local.json`** — Figma component → your code component, keyed by the
  component's stable publish `key`. `/designtwin:build-screen` scaffolds it on the first build
  (`map-bootstrap.js`) and asks you to confirm the stubs; `drift-lint` then flags entries the design
  has moved away from. *(Older projects keep it at the repo root; `dtwin doctor` finds either. An
  older name-keyed `design/components.json` is still read, but it cannot detect drift.)*
- **`design/tokens.json`** (optional overrides) — `{ "color": { "color/primary": "<your token>" }, … }`:
  left is the Figma variable path, right is your stack's token. Variables that carry a `codeSyntax`
  in Figma need no entry.
- **`design/target.json`** — which stack profile to emit (written by `dtwin init`, or auto-detected).
  If your stack isn't in `claude-plugin/skills/build-screen/profiles/`, copy its `_template.md` to a
  root-level `profiles/<name>.md` in your project and fill it in — it overrides the bundled profiles.

## Per-screen loop
1. In Figma, select the frame → run **Plugins → Development → Design Twin** →
   click **Export current selection** (or **Export design system + all page frames** for a full pull).
2. Save the resulting **Download …** links into `design/export/` (the CLI writes there directly):
   - "Download <screen>.json" → the screen tree
   - "Download variables.json" → `design/export/variables.json`
   - "Download assets (N)" → `design/export/assets/` — this includes a **full-frame reference PNG**
     per top-level frame (asset `kind:"reference"`, longest side capped ~2048px). The screen JSON
     points at it via a `reference` field, and `/designtwin:build-screen` self-corrects against it. No
     manual screenshot step needed.
3. In Claude Code, review it first: `/designtwin:audit-design <screen>` (or: "is this design ready to
   build?") → `design/audit/<screen>.md` with blockers, missing states, questions for the designer,
   and — the part no single file can answer — whether this screen actually comes from the design
   system sitting beside it. Standalone:
   `node design-to-code/audit.js design/export/pages/<Page>/<Screen>__<id>.json --platform ios
   --design-system design/export/design-system --out design/audit/<screen>`.
4. Build: `/designtwin:build-screen <screen>`. It reads the audit (or runs the script itself) and
   records every default it had to assume.
5. Check a built screen any time: `/designtwin:verify <screen>` ("does this match the design?"). The
   `visual-verifier` agent renders the screen, measures every VISIBLE node (hidden layers are skipped)
   and drives each designed interaction, recording the selector it drove. `verify-screen.js --compare`
   has no browser: it compares those measurements with the design's own numbers — type, colour,
   radius, spacing, size and frame-relative position — and takes interaction results from
   `measured.json` or an `--interactions <file>`. Anything nobody drove is `not-probed`, never passed.
   The instance-set count it reports is `data-dt-node` tag coverage, not proof a component is present;
   only a component the probe reports absent fails the screen. It writes
   `design/verify/<Screen>.report.json`, whose headline states how much was actually measured. The
   verdict is computed from that file, so a "pass" is never something anyone asserts. It changes no
   code.
6. When the design changes later: `/designtwin:sync-design <screen>`. It keeps the previous export,
   re-pulls, diffs the two by node id (`design-to-code/design-diff.js`) and patches only what moved —
   a rebuild would throw away every hand edit since step 4. Commit `design/` so a previous export
   always exists.

## Why this shape (evidence)
- Structured metadata beats a screenshot alone for fidelity, but **raw** metadata makes models hardcode
  absolute coordinates — so the plugin maps Auto Layout → flex intent and resolves variable bindings to
  semantic token names. A full-frame reference screenshot is auto-included for visual ground truth (multimodal).
- Figma's Variables **REST** API is Enterprise-only, but the **Plugin** API reads variables + per-node
  bindings for free — which is why this is a plugin, not a REST tool.

## Upgrade path (later, optional)
If manual export gets tedious, swap the file handoff for a **localhost-only** WebSocket bridge
(`allowedDomains: ["ws://localhost:8787", …]` — reaches your machine, never the internet). Loopback isn't
authentication, so the bridge is gated by a **shared token**. Nothing to configure: the first bridge
start generates one, saves it per-user (`~/.config/design-twin/bridge-token`, mode `0600`) and prints
it once — paste that into the plugin and neither side asks again (`dtwin --token-status` /
`--show-token` / `--rotate-token`; see `bridge/README.md`). The Skill and the token/component maps
carry over unchanged.

Two front-ends sit on that bridge, and they speak the same commands:
- **`dtwin` CLI** — bulk reads streamed to disk. Add `--serve` to hold the connection open so
  later pulls skip the plugin reconnect; `--stop` ends it.
  Start with the cheap discovery steps: `--list-libraries` (which design libraries this file draws on)
  then `--list` (pages + frame ids), and only then `--page <id>` to pull what you actually need.
  Only want the tokens/styles/components/hygiene catalog, no screens? `--design-system` skips the
  page/frame walk entirely (and the assets that walk would export); each catalogued component still
  carries its own fills/strokes/effects/radius/opacity/blendMode (see `bridge/README.md`).
- **`figma-mcp`** — live tools for "check this, now pull that", plus the small write surface. Pass
  `writeToDisk: true` on the export tools to write files and get back a compact index instead of the
  payload — the only way to get asset bytes, and the right choice for anything large.

Only one of them can hold port 8787 at a time; run the one that matches what you're doing. If something
else already owns it, `FIGMA_BRIDGE_PORT` accepts `8788` or `8789` — and only those, because the plugin
manifest names exactly those three ports and the plugin walks all three when connecting.

**Several Figma FILES at once, though.** The bridge accepts one connection per open Figma file, so a
design file and the library it draws on can both be connected and driven in the same session. Each
plugin announces which file it is on connect; commands are then addressed:

```
node bridge/figma-pull.js --list-clients            # which files are connected (connId, name, fileKey)
node bridge/figma-pull.js design/base --client "App"      # pull one
node bridge/figma-pull.js design/lib --client "Acme UI" --as-library "Acme UI"
```
MCP twins: `figma_list_clients`, and a `client` argument on every tool.

## Sharing this as a plugin
This repo holds **three separate products**, deliberately kept apart:

| | What it is | How it ships |
|---|---|---|
| `claude-plugin/` | The Claude Code plugin — skills + profiles + self-contained `scripts/` (bundled from `design-to-code/`), **zero dependencies** | `claude plugin install` |
| `bridge/` | The `dtwin` CLI + MCP server (needs `ws`, `zod`, MCP SDK) | npm package `designtwin` — **not published yet**; until it is, clone and run `node bridge/figma-pull.js` |
| `figma-plugin/` | The Figma-side plugin | imported into Figma from its manifest |

The Claude Code plugin has no dependencies because the CLI is **not** inside it — installing the
plugin never needs an `npm install`, and users get only `claude-plugin/` in their cache. Its `scripts/`
are committed bundles: after editing `design-to-code/*.js` run `node claude-plugin/build-scripts.js`
(`test/verify-build.test.js` fails if they are stale). It also ships no
`.mcp.json`: the MCP server is registered in the project you point it at, not here.

To try it locally: `claude --plugin-dir /path/to/this/repo/claude-plugin`. To hand it to a teammate: they run
`claude plugin marketplace add <your-git-host>/<you>/design-twin` then `claude plugin install designtwin@designtwin-marketplace`
(or add both to their project's `.claude/settings.json` under `extraKnownMarketplaces`/`enabledPlugins`
for auto-load). Skills load under the `designtwin:` namespace. `claude plugin validate ./claude-plugin`
checks the plugin manifest before you publish (`validate .` checks the *marketplace* manifest instead). The Figma-side plugin import (`figma-plugin/manifest.json`)
and `bridge/`'s `npm install` stay manual — installing the Claude plugin doesn't set those up.

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
