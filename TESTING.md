# Testing the "Design Twin" plugin

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

Expected: **`414/414 checks passed`** (exit 0). Any `✗ FAIL` prints which transform regressed.
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

### `design-to-code/` — design-to-code layer (agent-runnable, no Figma)

The `design-to-code/` scripts (DTCG token emitter, map validator, drift-lint, bootstrap — see
`design-to-code/README.md`) are plain Node modules with their own offline suite:

```
node test/design-to-code.test.js       # expect: 292/292 checks passed, exit 0
node test/audit.test.js                # expect: 96/96 checks passed, exit 0
node test/verify-build.test.js         # expect: 134/134 checks passed, exit 0 — the build-screen Stop-hook gate
                                       # (stdin only when fd 0 is not a TTY, 1s silent-pipe / 60s hard cutoff,
                                       # computed --status never stored), and that claude-plugin/scripts/ is in
                                       # sync with design-to-code/ (stale? run: node claude-plugin/build-scripts.js)
node test/plan-skeleton.test.js        # expect: 31/31 checks passed, exit 0 — the shared plan shape/visibility
                                       # helpers (visibility, rootsOf) every skill and verify-build.js walk with
node test/ui.test.js                   # expect: 14/14 checks passed, exit 0 — the plugin window's script against a fake
                                       # DOM + WebSocket: connection states, theming, the ids/ports it depends on
node test/cross-check.test.js          # expect: 56/56 checks passed, exit 0 — the JOIN between a screen and the
                                       # design system: a duplicated file that re-keys every collection, a catalog
                                       # covering 0% of the screen, token names that collide on different values,
                                       # a text style one capital letter apart, a 1e9 radius, contrast in a mode
                                       # that was derived rather than drawn, and auto-discovery of
                                       # design/export/variables.json (never a stale design/variables.json sibling)
node test/verify-screen.test.js        # expect: 120/120 checks passed, exit 0 — the per-node comparison behind a
                                       # "pass": the expectation emitted as data, the tolerance table, component
                                       # coverage, reactions/--interactions-driven checks, and the rule that an
                                       # unmeasured expectation is not a passed one
node test/design-diff.test.js          # expect: 31/31 checks passed, exit 0 — the sync-design change list (node-id diff, leaf paths, catalog +
                                       # token diffs, baseline choice, re-drawn assets, --snapshot/--force CLI)
node test/identity.test.js             # expect: 48/48 checks passed, exit 0 — token and component IDENTITY on livetest-3's
                                       # real export (test/fixtures/livetest3/): two variables sharing a name are both
                                       # emitted, diffed and attributed by KEY; theme.css cannot shadow Tailwind's scale;
                                       # a re-keyed (duplicated) catalog yields name+prop-signature PROPOSALS, never auto-accepted
node test/resolve-screen.test.js       # expect: 27/27 checks passed, exit 0 — the shared node-id/layer-name/indexed-title
                                       # resolver every skill uses to turn "the Job Roles screen" into one exact file
node test/mcp-share.test.js            # expect: 4/4 checks passed, exit 0 — two MCP servers on one port share the bridge
node test/mcp-smoke.test.js            # expect: 12/12 checks passed, exit 0 — boots the real MCP server over stdio
                                       # (port 8789, fixed token), lists tools, calls figma_write dryRun, and drives the inline size guard with a fake plugin
node --check design-to-code/tokens.js design-to-code/map-validate.js design-to-code/drift-lint.js design-to-code/map-bootstrap.js design-to-code/audit.js design-to-code/catalog-input.js design-to-code/verify-build.js design-to-code/design-diff.js design-to-code/cross-check.js design-to-code/verify-screen.js design-to-code/component-match.js design-to-code/slice-sources.js design-to-code/plan-skeleton.js design-to-code/resolve-screen.js
```

`test/audit.test.js` drives `design-to-code/audit.js` (the pre-build design audit behind the
`audit-design` skill) over `test/fixtures/audit/flawed-login.json` — a login screen seeded with one of
each flaw (drawn status bar, 32pt close button, #bbb text on white, fixed-size text, a missing font, a
detached instance, off-grid spacing, a Button set with no pressed/disabled variants). Every seeded flaw
has an assertion that it IS reported and the clean nodes have assertions that they are NOT, per
platform (web 24px / iOS 44pt / Android 48dp targets differ).

### `bridge/` — handshake auth + seed CLI

`test/bridge.test.js` covers the bridge files the plugin harness can't reach: `server-core.js`'s
`verifyClient` (the bridge's **only** real access control — token, Origin, loopback Host),
`token-store.js` (where that token lives between runs — precedence, `0600` permissions, the
lifecycle commands), the
`seed-components.js` CLI driven as a subprocess against a temp directory, `write-out.js` (the one
writer both front-ends share), and `daemon.js`. It also owns `figma-pull.js`'s argument parsing and
its `--list-libraries` renderer: the CLI/MCP layer is testable without a plugin on the other end
(arg guards, table/empty-case output, and the built MCP bundle's tool schema), and the plugin-side
library reads are the harness's job, not this suite's.

The daemon tests drive a **fake bridge** — no Figma, no WebSocket — so the parts that actually break
are testable offline: request serialization (the plugin is single-threaded), newline framing across
chunks for multi-megabyte replies, stale-socket recovery after a crash, and refusing a second
`--serve` rather than stealing a live socket. They bind port `19787`, never `8787`, so running the
suite can't contend with a bridge you have open.

`verbs.js` (`dtwin <verb>` → flags) is tested as the pure argv → argv function it is, plus subprocess
runs proving a verb and its flag are the same command. `doctor.js` is tested three ways: its pure
check functions directly; its probes against real sockets on spare ports (a plain HTTP server, a real
bridge answering `426`, and plugin-shaped clients with the right and the wrong token); and one
subprocess run with a fresh `DESIGNTWIN_CONFIG_DIR` — no token there, so the plugin probe is skipped
and the run never binds a port, while proving doctor mints nothing.

```
node test/bridge.test.js        # expect: 577/577 checks passed, exit 0 — deterministic whether or not
                                 # a real dtwin daemon is running elsewhere on this machine: the two
                                 # doctor-cli "not checked" assertions pin FIGMA_BRIDGE_PORT=8789 (one
                                 # of the plugin manifest's other two allowed ports, see ALLOWED_PORTS
                                 # in bridge/doctor.js) so they never race a daemon that only ever
                                 # holds one port at a time.
# NOTE: run this with FIGMA_BRIDGE_TOKEN unset in your shell. The doctor-cli subprocess cases spawn
# with `{...process.env, DESIGNTWIN_CONFIG_DIR: <fresh temp dir>}` — they override the config dir but
# do NOT clear an inherited FIGMA_BRIDGE_TOKEN, so a shell that already exports one (e.g. a
# CI/ephemeral escape-hatch token) defeats the "no token there" setup and the
# `[doctor-cli] with no token, the plugin probe is SKIPPED` case fails for a different reason.
node --check bridge/server-core.js bridge/seed-components.js bridge/figma-pull.js bridge/write-out.js bridge/daemon.js bridge/token-store.js bridge/verbs.js bridge/doctor.js
```

`verifyClient` deserves direct coverage because the interesting cases are negative ones — a sandboxed
attacker iframe sends `Origin: null` exactly like the real plugin does, so the suite asserts that
`Origin: null` **without** a valid token is still rejected (the CSWSH case), alongside DNS-rebinding
(non-loopback `Host`) and tokens of a different length — which must compare `false` rather than throw,
since the compare hashes both sides to a fixed width precisely so length cannot leak.

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

When you change a `design-to-code/` script or the map shape, extend `test/design-to-code.test.js` with the new
behavior. `design-to-code/map-validate.js` is the single source of truth for that shape — update its KEYS/PROP
tables and the prose in `design-to-code/README.md` together. If you add a token field, assert both the DTCG
output and the CSS output.

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
4. **The localhost bridge DOES work — verified 2026-07-28** in the Figma **desktop app** (v126.7.8):
   the plugin iframe connected to `ws://localhost:8787` on its own, and reconnects by itself after the
   bridge restarts. (Earlier revisions of this file claimed Chrome's "Local Network Access" usually
   blocks it and sent you to the manual path — that was wrong for the desktop app, and it steers you
   away from the path that actually works. It may still hold for Figma in a *browser* tab; if so, the
   manual download path below is the fallback, not the default.)
   *Symptom if it ever does block:* the bridge sits on "Open your Figma file and run…" and no
   `ESTABLISHED` socket appears in `lsof -nP -iTCP:8787`.
5. **To see plugin errors:** turn on **Plugins → Development → Use Developer VM**, then
   **Plugins → Development → Open Console**. The main thread logs `[export] code.js loaded` and
   `[export] main thread ready — onmessage registered`; the UI surfaces any error as red text in the
   plugin window itself. A healthy load shows the status change from "Loading…" to "N selected".

### Procedure (manual download — recommended)

1. Open a real design file. Import the plugin (gotcha #1). Run **Plugins → Development → Design Twin**.
2. Confirm health: status shows **"N selected"** or a select-a-frame hint (not stuck on "Loading…").
3. **Select a frame**, click **"Export current selection"** → click **Download `<screen>.json`** and
   **Download `variables.json`** (and **Download assets** if a count shows). Files land in `~/Downloads`.
   - Or **"Export design system + all page frames"** → `design-system.json` + `design-system__*.json` + click **Download layers
     (N)** (one file per top-level layer grouped under `pages/<page>/`, plus a root `pages/index.json`
     and a per-page `pages/<page>/index.json` — see "layers are split per-page, per-file" below) — the
     fuller test.
4. Hand the files to the agent: it reads `~/Downloads/<screen>.json` (and `variables.json` /
   `design-system.json` + `design-system/` (or `design-system__*.json` from the browser download) /
   `pages/index.json` + the per-page `index.json` + the per-layer files) and
   validates against the checklist below. Move the files into `design/` when you want to actually build
   from them.

### Layers are split per-page, per-file

`screens.json` used to bundle every exported frame into a single file — a real design-system export
measured **24MB**, unworkable for an agent that only wants to build one at a time. Splitting to
one-file-per-node fixed that; grouping those files by Figma PAGE is the next step of the same idea.
Naming: Figma itself calls every object in a file a **layer** (its own Layers-panel vocabulary; there is
no "screen" node type in Figma). This tool reserves **"screen"** for a single node a human deliberately
selected (`collectSelection`/`collectNode`) — everything swept up by walking a
whole page indiscriminately (specimen sections, icon components, real UI frames alike) is a **"layer"**
instead, which is both the accurate Figma term and avoids implying every one of them is a real app view.
A page can hold many layers, never the reverse (Figma's own model is File → Page → Frame), so the
directory structure mirrors that containment instead of dumping every layer from every page into one
flat folder. A deliberately-selected SCREEN files into the same tree, under the same
`<name>__<id>.json` convention — it used to land flat as `design/<Screen>.json`, which meant two
frames called `Popup` overwrote each other and a single-screen project had no index at all. Both export paths write `design/export/pages/index.json` (the run-wide `manifest` + a lean
`pageDirs[]` of `{page,dir,index,layers}` (`index` is the pointer to that page's own index file — open it verbatim, don't rebuild it from `dir`) — NOT the full layer list, so reading it never means loading every
layer's metadata) plus, per page, `design/export/pages/<page>/index.json` (that page's own
`{name,id,type,page,file}` entries) and one `design/export/pages/<page>/<name>__<id>.json` per layer (`{name,
id, page, tree, reference, devResources}`). Read the root index to find the PAGE you want, its own
index.json to find the LAYER, then read only that file — never a whole directory.

### Discovering which libraries a file uses (do this first)

Before any pull, run `node bridge/figma-pull.js --list-libraries` (MCP twin: `figma_list_libraries`).
It prints the local file's published assets plus every **enabled** team library, each with its variable
collections and a component count, then you scope the pull with `--list` → `--page <id>`.

What to check in the output, and what NOT to read into it:
- Component counts are **usage-derived** — Figma has no API to enumerate a library's contents, so the
  number is components of that library used in *this* file. A low count is not a small library.
- Only libraries **enabled in the Figma UI** can appear; nothing can enable one via API. If a library
  you expect is missing, enable it in Figma (Assets → Libraries) and re-run — the export was scoped to
  what was enabled at the time, silently.
- **An empty list is a valid result** (free plan, or nothing enabled) and the command says so in words.
  But rule out a **stale plugin first**: library reads require `"permissions": ["teamlibrary"]` in
  `figma-plugin/manifest.json`, and a plugin imported before that returns nothing at all with no error.
  Re-import the manifest, then re-run.

### Peeking inside a frame before a full pull

`--list` (or the manual export) only shows a page's TOP-LEVEL frames — no recursion. To see what's
*inside* one of those frames before committing to a full recursive pull of it, use the node-scoped
twin: `node bridge/figma-pull.js --children <id>` lists that one node's direct children only (same
no-recursion, no-asset cost as `--list`), which is otherwise a jump straight to "pull everything."

### Visually checking one component after generating code for it

`node bridge/figma-pull.js --screenshot <id> [--scale N]` renders ONE node to `screenshots/<id>_ref.png` —
skips `serialize()` and the recursive asset walk, so it stays cheap even on a node deep inside a large
tree. Use it after `build-screen` generates code for a specific component in a dense screen, where the
one whole-frame reference PNG every export already carries is too zoomed-out to compare against.
Verified live (2026-09-08): a real node rendered a correct PNG at the default scale and at an explicit
`--scale` override; combining it with a scope flag, another index command, or a read option is refused
with a specific message rather than silently ignored.

### What the agent verifies in the exported JSON

**Every doc** — a `manifest` object: `{nodes, skipped, truncated, assetsFailed, warnings[]}`. `nodes` is a
sane count; `truncated`/`assetsFailed` are 0 (or the `warnings[]` explain them). This is the no-silent-
truncation guarantee — read it first.

**Node `tree`** — same shape for a single-selection `<screen>.json` or a page-walk layer file (fields
appear only when the design contains them):
- `reactions` on interactive nodes → `{trigger, actions:[{navigation, destination, transition:{easing,duration}}]}`
- `runs[]` on mixed-format text (not a single flat `font`); `font.lineHeight`/`letterSpacing` carry a `unit`
- `layout` flex/grid intent; `layout.inferred:true` where auto-layout was inferred; `clip`/`scroll`;
  `sizeLimits`/`pin`; `absolute`/`grow`
- `fills` gradient `stops`; `strokes.weights` (per-side); `radius` per-corner object; `effects[]`
  type-discriminated (`background_blur` has no offset); `rotation`/`blendMode`/`mask`
- `tokens` (bound-variable names), `component` (instance→main name), `asset` (path into `assets/`)

**`design-system.json`** is a slim manifest (`exportedAt`/`file`/`colorProfile`, `files` pointers,
`counts`); the catalog itself is split under `design-system/` along Figma's own taxonomy —
`tokens.json` (collections → modes → variables), one file per style type — `styles.paint.json`/
`styles.text.json`/`styles.effect.json`/`styles.grid.json` — (the separate Paint/Text/Effect/Grid
style system), `components.local.json` / `components.library.json`, `hygiene.json`:
- `design-system/tokens.json` → `collections[]` + `variables[]` with `tier` (primitive/semantic), `scopes`, `codeSyntax {WEB,ANDROID,iOS}` (when set), and
  alias values re-keyed by mode name; COLOR values as hex (alpha preserved)
- `design-system/components.local.json` → `components[]` with `id`, `page`/`pageId`, `description`, and
  props as `{key,type,options,default}` (real `#uid` key kept). `components.library.json` holds the
  `remote: true` entries — library mains recovered from instances, so no `id`/`page` and possibly
  INFERRED props. Each COMPONENT_SET's `variants[]` keeps `id`/`name`/`key`/`values` but not the heavy
  serialized `node` tree (opt-in via `variantVisuals`) — that lives in a sibling
  `design-system/components/<name>__<id>.json`, pointed at by the entry's `variantsFile` (absent when
  no node trees were exported for that set). A standalone `COMPONENT` (not a variant inside a set) gets
  the same treatment under `variantVisuals`, but its node tree is attached directly as `entry.node` and
  split out via `nodeFile` instead — there's no `variants[]` to hang it off of. `node
  design-to-code/get-component.js <components.local.json> <key|id|name>` resolves one entry and follows its
  `variantsFile`/`nodeFile` to print the full detail.
- `design-system/hygiene.json` → `hygiene[]` — design-system smells (ALL_SCOPES, semantic-holds-raw, broken alias, variant>30, unnamed/dupe)

### Component-map seeding (optional, tested separately)

`node bridge/seed-components.js [codeRoot] [outDir]` scans the codebase for Code Connect files
(`figma.connect(...)`, `@FigmaConnect`, or `// url=`/`// component=`/`// source=` templates) and seeds
`design/components.json`. Verify it finds your mappings and fills `component`/`source`/`nodeId` without
clobbering hand-authored fields.

---

## Layer C — design-to-code tooling on a REAL export (checklist)

The `design-to-code/` suite (`test/design-to-code.test.js`, 288 checks) runs on **mock** data, so validate it against a
genuine `design-system.json` once (a full export from Layer B) to catch what the mocks can't. Work
top-to-bottom; each box is a concrete pass/fail.

**Run 2026-07-29** against a real `design-system.json` (222 variables, 65 components, "🎨 Design System"
page export): every checklist item below passed. One real bug found and fixed — a FLOAT variable scoped
to `FONT_WEIGHT` *and* length scopes at once (e.g. a "Body 2" type-scale token also scoped to
`FONT_SIZE`/`LINE_HEIGHT`/`LETTER_SPACING`) was emitted unitless (`--Body-2: 18;`, invalid as a
font-size) because `numberUnit()` used `.some()` — one unitless scope silenced the length scopes sitting
next to it. Fixed to `.every()` (unitless only when *no* scope contradicts it); regression tests
`[RD2-mixed]`/`[RD2-pure]` added to `test/design-to-code.test.js`.

### Prereq
- [ ] You have a real export from **"Export design system + all page frames"** (Layer B): a
      `design-system.json` manifest plus `design-system/` with a non-empty `tokens.json` `variables[]`
      and `components.local.json` `components[]`. Every split file repeats the `exportedAt` stamp, so
      the tooling below is pointed at the part it actually consumes.

### Tokens (`node design-to-code/tokens.js design/export/design-system/tokens.json ./out`)
- [ ] Command prints `wrote tokens.dtcg.json + tokens.css + tokens.resolver.json (+M set files under tokens/) (N variables)` with N matching your variable count.
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

### Bootstrap → validate (`node design-to-code/map-bootstrap.js design/export/design-system/components.local.json --out design/codeconnect.local.json`)
- [ ] Every **published** component appears, keyed by its publish key; unpublished ones are keyed by node
      id with `figma.unstable: true`.
- [ ] Each entry has `status: "needs-review"`, a `code.export` that reads like a component name, and props
      translated by type (VARIANT→`enum` with option values, BOOLEAN→`boolean`, TEXT→`string`/`children`,
      INSTANCE_SWAP→`instance` slot).
- [ ] `node design-to-code/map-validate.js design/codeconnect.local.json` prints **`map valid`** (exit 0).

### Drift-lint — clean, then inject each drift class (`node design-to-code/drift-lint.js design/codeconnect.local.json design/export/design-system/components.local.json`)
- [ ] On the fresh bootstrap it reports **0 errors and 0 warnings** (`N/N components mapped`) — bootstrap
      covers every component and every variant option, so a clean file is clean. (No tool flags the
      `TODO: import path` placeholders — they're markers for you to fill in, then confirm the entry.)
- [ ] **orphaned-entry (ERROR)**: add a bogus entry `"ZZZ": {figma:{key:"ZZZ",name:"Gone"}, code:{module:"x",export:"X"}}` → lint errors, exit 1.
- [ ] **stale-name (warn)**: change one component's `name` in `components.local.json` (keep its key) → `stale-name` warning, still 0 errors.
- [ ] **stale-prop (ERROR)**: add a made-up prop to a map entry → `stale-prop` error.
- [ ] **unknown-variant-value (ERROR)**: in an enum's `values`, add an option that isn't in the component → error.
- [ ] **kind-mismatch (ERROR)**: change a map prop's `kind` to the wrong type → error.
- [ ] **unmapped-component (warn)**: delete an entry for a component that still exists → coverage warning.
- [ ] Re-running bootstrap over your **edited** map PRESERVES your hand-edits (fill in one `code.module`,
      re-run `map-bootstrap … existing`, confirm your value survived).
- [ ] **Staleness**: a fresh `components.local.json` (just exported) reports no freshness warning; hand-edit
      its `exportedAt` to >24h ago → `stale-snapshot` warning naming the age; delete `exportedAt` entirely →
      `unknown-freshness` warning. Override the threshold with `node design-to-code/drift-lint.js map.json components.local.json --max-age <hours>`
      (or `DRIFT_MAX_AGE_HOURS`). `figma_status` (MCP) and `node bridge/figma-pull.js` both surface the
      same `exportedAt` stamp — `figma_status`'s `snapshot.ageMs` reads whatever `design/export/design-system.json`
      manifest (or `$FIGMA_EXPORT_DIR/design-system.json`) last landed on disk.

### Reality check on a messy file (optional but recommended)
- [ ] Run tokens on a file that hardcodes hex instead of using variables → `variables[]` is small/empty and
      the token output is thin. This is the "degraded input" case the reconciliation layer (deferred) is for —
      note how little the map/tokens can do, which is the signal to improve the Figma file or build that layer.

> Anything that fails here is a **real-data** gap the mock suite couldn't see — capture the input and add a
> regression test to `test/design-to-code.test.js` (assert the VALUE, not just presence — see the lesson above).

---

## Quick reference — commands

| Command | What |
|---|---|
| `node test/harness.js` | Offline exporter logic test (read + write planes) — expect `414/414` |
| `cd figma-plugin && npm run typecheck` | Type-check the extractor (`tsc --noEmit`) after editing `src/` |
| `cd figma-plugin && npm run build` | Rebuild `code.js` from `src/*.ts` |
| `node test/design-to-code.test.js` | Offline design-to-code tooling test (tokens/validate/drift/bootstrap/get-component/tailwind) — expect `288/288` |
| `node test/identity.test.js` | Token + component identity on livetest-3's real export (key, not name; re-keyed catalogs) — expect `48/48` |
| `node test/cross-check.test.js` | Screen-vs-design-system join — expect `47/47` |
| `node test/verify-screen.test.js` | Per-node verification and its verdict — expect `44/44` |
| `node test/bridge.test.js` | Offline bridge test (handshake auth + seed CLI + request-timeout + figma-pull arg parsing + shared write-out writer + daemon lifecycle/queueing/framing + snapshot freshness stamp + `--list-libraries` parsing/rendering
and the `figma_list_libraries` tool schema + multi-client routing + `--whoami`/`--client`/`--list-clients` parsing + generated-bundle/source parity + component detail split + snapshot shapes + the multi-client doctor note + the merging `variables.json`, the nested single-screen layout and the per-screen asset index) — expect `529/529` |
| `node bridge/figma-pull.js --list-clients` | Cheap: which Figma files are connected (connId, name, fileKey) — the address book for `--client` |
| `node bridge/figma-pull.js --whoami` | Cheap: who is connected — plugin instance id, file, `fileKey` availability, socket uptime, takeover count |
| `node bridge/figma-pull.js --list-libraries` | Cheap: which design libraries this file draws on (prints a table to stdout) |
| `node bridge/figma-pull.js --list-pages` | Cheap: page names only, no page load (prints to stdout) |
| `node bridge/figma-pull.js --list` | Cheap: pages + their top-level frames (prints to stdout) |
| `node bridge/figma-pull.js --children <id>` | Cheap: one node's DIRECT children only (prints to stdout) |
| `node bridge/figma-pull.js --screenshot <id> [--scale N]` | Cheap-ish: renders ONE node to `screenshots/<id>_ref.png` (writes a file, unlike the row above) |
| `node bridge/figma-pull.js design --page <id>` | Live pull of one/several named pages (repeatable `--page`) |
| `node bridge/figma-pull.js design --all-pages` | Live pull over the local bridge (`--timeout N` to extend) |
| `node bridge/figma-pull.js design --design-system` | Live pull of ONLY tokens/styles/components/hygiene — no page walk, no assets. Each component carries its own fills/strokes/effects/radius/opacity/blendMode under `visuals` (see bridge/README.md) |
| `node bridge/figma-pull.js design --as-library "<name>"` | Live pull of the COMPLETE catalog of a LIBRARY file — run with the LIBRARY open, writes `design/export/libraries/<slug>-<fileKey8>/` |
| `node --check figma-plugin/code.js` | Syntax check the exporter |
| `node --check design-to-code/*.js` | Syntax check the tooling scripts |
| `node bridge/seed-components.js . design` | Seed components.json from Code Connect files (code side) |
| `node design-to-code/map-bootstrap.js design/export/design-system/components.local.json --out design/codeconnect.local.json` | Scaffold design/codeconnect.local.json from the Figma catalog (re-running merges into it) |
| `node design-to-code/drift-lint.js design/codeconnect.local.json design/export/design-system/components.local.json` | Fail on map↔Figma drift (CI/pre-commit) |
| `node design-to-code/get-component.js design/export/design-system/components.local.json <key\|id\|name>` | Resolve one COMPONENT_SET or standalone COMPONENT, follow its `variantsFile`/`nodeFile`, print the full node tree(s) |
| `node design-to-code/tokens.js <tokens.json\|variables.json> ./out` | Emit tokens.dtcg.json + tokens.css (`--web tailwind` → ONLY theme.css; `--native <p>` → ONLY a native token file; pass `--also-generic` to also write the generic set alongside a target) |
