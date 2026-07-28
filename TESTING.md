# Testing the "Design Export for AI" plugin

Two layers. **Layer A runs with no Figma app** and an agent can do it alone. **Layer B needs the
Figma desktop app** (a human clicks Export; the agent reads and validates the output). Do A first —
it catches logic bugs cheaply — then B to confirm the real `figma.*` calls.

---

## Layer A — offline logic test (agent-runnable, no Figma)

The plugin's extraction transforms are TypeScript (`figma-plugin/src/*.ts`), bundled to
`figma-plugin/code.js`. `test/harness.js` loads the built `code.js` in a VM with a mock `figma` object
and a representative node tree (mixed text, gradient, reaction, effects, bound token, scroll frame,
multi-mode variables), then asserts the emitted JSON. The bundle exposes its read API on a namespaced
global (`__designExport`) which the harness lifts onto the sandbox.

```
cd figma-plugin && npm install && npm run typecheck && npm run build && cd ..   # after editing src/
node test/harness.js
```

Expected: **`173/173 checks passed`** (exit 0). Any `✗ FAIL` prints which transform regressed.
`npm run typecheck` (`tsc --noEmit`) is the first gate — it catches property-name / `figma.mixed` /
null-handling bugs before the harness even runs.

Also always run the syntax check after (re)building the plugin:

```
node --check figma-plugin/code.js
node --check bridge/seed-components.js
```

When you add a new extracted field, edit the relevant `figma-plugin/src/*.ts` module, rebuild, then add
a matching assertion to `test/harness.js` (extend the mock node with the source property, assert the
output key). Keep both `typecheck` and the harness green.

### `tooling/` — design-to-code layer (agent-runnable, no Figma)

The `tooling/` scripts (DTCG token emitter, map validator, drift-lint, bootstrap — see
`tooling/README.md`) are plain Node modules with their own offline suite:

```
node test/tooling.test.js       # expect: 175/175 checks passed, exit 0
node --check tooling/tokens.js tooling/map-validate.js tooling/drift-lint.js tooling/map-bootstrap.js
```

### `bridge/` — handshake auth + seed CLI

`test/bridge.test.js` covers the two bridge files the plugin harness can't reach: `server-core.js`'s
`verifyClient` (the bridge's **only** real access control — token, Origin, loopback Host) and the
`seed-components.js` CLI, driven as a subprocess against a temp directory.

```
node test/bridge.test.js        # expect: 19/19 checks passed, exit 0
node --check bridge/server-core.js bridge/seed-components.js bridge/figma-pull.js
```

`verifyClient` deserves direct coverage because the interesting cases are negative ones — a sandboxed
attacker iframe sends `Origin: null` exactly like the real plugin does, so the suite asserts that
`Origin: null` **without** a valid token is still rejected (the CSWSH case), alongside DNS-rebinding
(non-loopback `Host`) and length-mismatched tokens.

This suite was hardened over FOUR adversarial review rounds. Round 1 found 28 confirmed bugs; round 2
(re-reviewing the fixes) found ~6 regressions the fixes themselves introduced; round 3 found one more (a
bootstrap "refresh untouched stub" heuristic that destroyed half-finished human edits → reverted to
always-preserve); round 4 found one narrow code fix (an asymmetric ambiguous-prop guard) and confirmed the
rest, with the remaining findings all LOW/pathological or pure test-coverage gaps (now closed). The
validator was cross-checked against an ajv oracle (0 divergences over 10,733 inputs), and the whole pipeline
was confirmed to compose end-to-end. Assertions pin actual VALUES (RGB channels, not just
`components.length`), drift warnings are asserted to *fire*, and every finding has a tagged regression test.
Lesson baked in: assert values, mutation-test, and adversarially re-review EACH fix pass — every fix pass
can introduce its own bugs (findings converged 28 → ~6 → 1 → ~0 real across the four rounds).

When you change a `tooling/` script or the map schema, extend `test/tooling.test.js` with the new
behavior AND keep `tooling/map-schema.json` and `tooling/map-validate.js` in lock-step (the JSON Schema
is the source of truth; the validator must reject everything the schema rejects). If you add a token
field, assert both the DTCG output and the CSS output.

---

## Layer B — live export test (human + Figma; agent validates output)

### Gotchas we hit — check these FIRST if something's wrong

1. **Import as a PLUGIN, not a WIDGET.** Use **Plugins → Development → Import plugin from manifest…**
   (or ⌘/ → "Import plugin from manifest"). Importing via the *widget* path fails with
   `Manifest error: Expected "manifest.containsWidget" to have type true but got undefined` and the
   plugin never loads (UI looks frozen on "Loading…"). The manifest is correct as-is — it's a plugin.
2. **A stale plugin window runs stale code.** After editing `code.js`/`ui.html`, **close the plugin
   window and re-run it** (or re-import) so Figma reloads from disk.
3. **`Unrecognized feature: 'local-network-access'` in the console is harmless noise** from Figma's own
   internals — ignore it. It is *not* a plugin error.
4. **The localhost bridge (figma-pull / MCP) is blocked by modern Chrome** ("Local Network Access"), so
   the WebSocket path usually won't connect from the plugin iframe. **Use the manual download path below**
   for testing — it needs no network.
5. **To see plugin errors:** turn on **Plugins → Development → Use Developer VM**, then
   **Plugins → Development → Open Console**. The main thread logs `[export] code.js loaded` and
   `[export] main thread ready — onmessage registered`; the UI surfaces any error as red text in the
   plugin window itself. A healthy load shows the status change from "Loading…" to "N selected".

### Procedure (manual download — recommended)

1. Open a real design file. Import the plugin (gotcha #1). Run **Plugins → Development → Design Export for AI**.
2. Confirm health: status shows **"N selected"** or a select-a-frame hint (not stuck on "Loading…").
3. **Select a frame**, click **"Export current selection"** → click **Download `<screen>.json`** and
   **Download `variables.json`** (and **Download assets** if a count shows). Files land in `~/Downloads`.
   - Or **"Export design system + all page frames"** → `design-system.json` + `screens.json` (the fuller test).
4. Hand the files to the agent: it reads `~/Downloads/<screen>.json` (and `variables.json` /
   `design-system.json` / `screens.json`) and validates against the checklist below. Move the files into
   `design/` when you want to actually build from them.

### What the agent verifies in the exported JSON

**Every doc** — a `manifest` object: `{nodes, skipped, truncated, assetsFailed, warnings[]}`. `nodes` is a
sane count; `truncated`/`assetsFailed` are 0 (or the `warnings[]` explain them). This is the no-silent-
truncation guarantee — read it first.

**Screen `tree`** (fields appear only when the design contains them):
- `reactions` on interactive nodes → `{trigger, actions:[{navigation, destination, transition:{easing,duration}}]}`
- `runs[]` on mixed-format text (not a single flat `font`); `font.lineHeight`/`letterSpacing` carry a `unit`
- `layout` flex/grid intent; `layout.inferred:true` where auto-layout was inferred; `clip`/`scroll`;
  `sizeLimits`/`pin`; `absolute`/`grow`
- `fills` gradient `stops`; `strokes.weights` (per-side); `radius` per-corner object; `effects[]`
  type-discriminated (`background_blur` has no offset); `rotation`/`blendMode`/`mask`
- `tokens` (bound-variable names), `component` (instance→main name), `asset` (path into `assets/`)

**`design-system.json`**:
- `variables[]` with `tier` (primitive/semantic), `scopes`, `codeSyntax {WEB,ANDROID,iOS}` (when set), and
  alias values re-keyed by mode name; COLOR values as hex (alpha preserved)
- `components[]` with `id`, `description`, and props as `{key,type,options,default}` (real `#uid` key kept)
- `hygiene[]` — design-system smells (ALL_SCOPES, semantic-holds-raw, broken alias, variant>30, unnamed/dupe)

### Component-map seeding (optional, tested separately)

`node bridge/seed-components.js [codeRoot] [outDir]` scans the codebase for Code Connect files
(`figma.connect(...)`, `@FigmaConnect`, or `// url=`/`// component=`/`// source=` templates) and seeds
`design/components.json`. Verify it finds your mappings and fills `component`/`source`/`nodeId` without
clobbering hand-authored fields.

---

## Layer C — design-to-code tooling on a REAL export (checklist)

The `tooling/` suite (`test/tooling.test.js`, 175 checks) runs on **mock** data. The tooling has never been
run on real extractor output, so validate it against a genuine `design-system.json` once (a full export
from Layer B). Work top-to-bottom; each box is a concrete pass/fail.

### Prereq
- [ ] You have a real `design-system.json` from **"Export design system + all page frames"** (Layer B).
      It should contain a non-empty `variables[]` and `components[]`.

### Tokens (`node tooling/tokens.js design-system.json ./out`)
- [ ] Command prints `wrote tokens.dtcg.json + tokens.css (N variables)` with N matching your variable count.
- [ ] **References preserved** in `out/tokens.dtcg.json`: a semantic token's `$value` is a `"{group.token}"`
      string, NOT a flattened hex. (A flattened hex here = the themeability bug.)
- [ ] **Structured color**: a primitive color `$value` is `{colorSpace, components:[r,g,b], hex}` (a
      semi-transparent token also carries `alpha` and an 8-digit `hex`). If your file is P3, `colorSpace` is `display-p3`.
- [ ] **Modes → theming** in `out/tokens.css`: primitives sit in `:root`; each extra mode has a
      `[data-theme="…"]` block that overrides only the semantic tokens that differ.
- [ ] **Units**: spacing/radius/size vars end in `px`; any opacity/font-weight var is unitless. No bare
      number like `--x: 16;` on a length, and no `--x: 0.5px;` on an opacity.
- [ ] **Never-silent**: any warning the CLI prints (`warn …`) is a REAL issue in your file (a dangling
      alias, a name collision, a token with no value) — investigate each; there should be none on a clean file.

### Bootstrap → validate (`node tooling/map-bootstrap.js design-system.json > codeconnect.local.json`)
- [ ] Every **published** component appears, keyed by its publish key; unpublished ones are keyed by node
      id with `figma.unstable: true`.
- [ ] Each entry has `status: "needs-review"`, a `code.export` that reads like a component name, and props
      translated by type (VARIANT→`enum` with option values, BOOLEAN→`boolean`, TEXT→`string`/`children`,
      INSTANCE_SWAP→`instance` slot).
- [ ] `node tooling/map-validate.js codeconnect.local.json` prints **`map valid`** (exit 0).

### Drift-lint — clean, then inject each drift class (`node tooling/drift-lint.js codeconnect.local.json design-system.json`)
- [ ] On the fresh bootstrap it reports **0 errors and 0 warnings** (`N/N components mapped`) — bootstrap
      covers every component and every variant option, so a clean file is clean. (No tool flags the
      `TODO: import path` placeholders — they're markers for you to fill in, then confirm the entry.)
- [ ] **orphaned-entry (ERROR)**: add a bogus entry `"ZZZ": {figma:{key:"ZZZ",name:"Gone"}, code:{module:"x",export:"X"}}` → lint errors, exit 1.
- [ ] **stale-name (warn)**: change one component's `name` in `design-system.json` (keep its key) → `stale-name` warning, still 0 errors.
- [ ] **stale-prop (ERROR)**: add a made-up prop to a map entry → `stale-prop` error.
- [ ] **unknown-variant-value (ERROR)**: in an enum's `values`, add an option that isn't in the component → error.
- [ ] **kind-mismatch (ERROR)**: change a map prop's `kind` to the wrong type → error.
- [ ] **unmapped-component (warn)**: delete an entry for a component that still exists → coverage warning.
- [ ] Re-running bootstrap over your **edited** map PRESERVES your hand-edits (fill in one `code.module`,
      re-run `map-bootstrap … existing`, confirm your value survived).

### Reality check on a messy file (optional but recommended)
- [ ] Run tokens on a file that hardcodes hex instead of using variables → `variables[]` is small/empty and
      the token output is thin. This is the "degraded input" case the reconciliation layer (deferred) is for —
      note how little the map/tokens can do, which is the signal to improve the Figma file or build that layer.

> Anything that fails here is a **real-data** gap the mock suite couldn't see — capture the input and add a
> regression test to `test/tooling.test.js` (assert the VALUE, not just presence — see the lesson above).

---

## Quick reference — commands

| Command | What |
|---|---|
| `node test/harness.js` | Offline exporter logic test (read + write planes) — expect `173/173` |
| `cd figma-plugin && npm run typecheck` | Type-check the extractor (`tsc --noEmit`) after editing `src/` |
| `cd figma-plugin && npm run build` | Rebuild `code.js` from `src/*.ts` |
| `node test/tooling.test.js` | Offline design-to-code tooling test (tokens/validate/drift/bootstrap) — expect `175/175` |
| `node test/bridge.test.js` | Offline bridge test (server-core handshake auth + seed-components CLI) — expect `19/19` |
| `node --check figma-plugin/code.js` | Syntax check the exporter |
| `node --check tooling/*.js` | Syntax check the tooling scripts |
| `node bridge/seed-components.js . design` | Seed components.json from Code Connect files (code side) |
| `node tooling/map-bootstrap.js design-system.json` | Scaffold codeconnect.local.json from the Figma catalog |
| `node tooling/drift-lint.js codeconnect.local.json design-system.json` | Fail on map↔Figma drift (CI/pre-commit) |
| `node tooling/tokens.js design-system.json ./out` | Emit tokens.dtcg.json + tokens.css |
