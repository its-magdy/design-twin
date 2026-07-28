# Architecture — Figma → code (free plan), verified

Every API and behavior below was verified against official Figma / Claude Code docs
(five parallel doc-verification passes). Time-sensitive; re-verify if Figma changes plans/APIs.

## The core constraints (why the design is what it is)

- **REST is unusable on the free plan.** Free = a View/Collab seat; Tier 1 endpoints
  (`GET file`, `GET file nodes`, `GET images`) are capped at **~6/month**, and the cap follows the
  **file's** plan. Variables REST is Enterprise-only. → We never use REST while files are free.
- **The Plugin API is the free, unthrottled path.** It runs client-side in the open file, reads all
  variables/tokens + per-node bindings + components/variants + styles, and exports assets — no plan gate
  on reads (only *extended/inheritance* variable collections are Enterprise).
- **A plugin has two contexts** (verified, `how-plugins-run`):
  - `code.js` **main sandbox** — Figma scene access, **no network / no DOM**.
  - `ui.html` **iframe** — real browser (network, WebSocket), **no scene access**.
  → Any network (a bridge WebSocket) **must live in the UI iframe**, relaying to `code.js` via
  `postMessage`. This is the single load-bearing fact of the bridge design.

## Two planes, one plugin

```
                         READ plane (design → code)  — you need this
  Figma (file open)
    code.js (Plugin API reads) ──postMessage──► ui.html [hidden iframe, WS client]
                                                       │ ws://localhost:PORT
    figma-pull (CLI)  ── hosts ephemeral WS server, requests export, writes files, exits ──►
          design/design-system.json · screens.json · assets/
    Claude Code  ── runs `figma-pull` (Bash), then Reads files selectively ──►

                         WRITE plane (code → design)  — optional, later
  Claude Code ──MCP (stdio)──► figma-mcp [hosts persistent WS server] ⇄ ws ⇄ ui.html ⇄ code.js (writes)
```

**Why CLI for read, MCP for write** (verified both are first-class in Claude Code):
- Read = one big payload, one-shot → **CLI writes to disk, agent reads selectively** (cached, greppable,
  git-diffable, never bloats context). Claude Code already has Bash + Read — zero new integration.
- Write = many small dependent steps with handles + feedback → **MCP session/tool-calling** fits; small
  results *belong* in context. Isolating writes in a separate opt-in server keeps the risky surface off
  the read path.

## Verified mechanism details (build to these)

- **Hidden UI:** `figma.showUI(__html__, { visible: false })` — iframe runs (and holds a socket) without a window.
- **Messaging:** main→UI `figma.ui.postMessage(msg)` / UI receives `onmessage → e.data.pluginMessage`;
  UI→main `parent.postMessage({ pluginMessage }, '*')` / main receives `figma.ui.onmessage`.
  Payloads must be serializable (objects, strings, `Uint8Array` ok; no functions).
- **Iframe has `null` origin** → the local CLI/MCP server must send `Access-Control-Allow-Origin: *`
  for any HTTP; for WebSocket, origin **cannot** authenticate — the plugin sends `null`, but so does a
  sandboxed attacker iframe (`<iframe sandbox="allow-scripts">`) on any site the user visits. The bridge
  therefore requires a **shared token** (`?token=…`, constant-time compare) validated at the handshake,
  keeping the Origin/Host checks only as defense-in-depth.
- **No documented payload-size cap** → **chunk large exports** across `postMessage` and add reconnect logic.
- **Network manifest:** `ws`/`wss` and `http(s)://localhost[:PORT]` are permitted in
  `networkAccess.allowedDomains`; put the bridge URL in **`devAllowedDomains`** with a `reasoning` string.
  The pure exporter keeps `allowedDomains: ["none"]` (cannot exfiltrate).
- **Whole-document read (dynamic-page, required for new plugins):** `documentAccess: "dynamic-page"`;
  call `figma.loadAllPagesAsync()` before traversing other pages; `findAllWithCriteria` needs pages loaded.
  Under dynamic-page **all reads are async** — use `getMainComponentAsync`, `getLocalPaintStylesAsync`,
  `getStyleByIdAsync`, `getVariableByIdAsync`, etc. (sync forms throw).

## Verified extraction API surface (what the plugin reads)

- **Variables/tokens:** `getLocalVariablesAsync`, `getLocalVariableCollectionsAsync`,
  `getVariableByIdAsync`. Per-node bindings via `node.boundVariables` (`fills/strokes/effects/layoutGrids`
  are alias **arrays**; scalar props are single aliases) → resolve to `.name`. `valuesByMode` **does not
  resolve aliases** and is keyed by opaque `modeId` → resolve alias targets + re-key by mode name
  (or use `resolveForConsumer(node)`). Types: COLOR/FLOAT/STRING/BOOLEAN.
- **Components/variants/states:** `componentSet.componentPropertyDefinitions` → for each `type:"VARIANT"`,
  `variantOptions` is the list of states. Instance: `getMainComponentAsync()` + `componentProperties`
  (strip `#id` suffix on BOOLEAN/TEXT/INSTANCE_SWAP keys; VARIANT keys are plain). `variantGroupProperties`
  / `variantProperties` are deprecated. `description` / `documentationLinks` available.
- **Styles (pre-Variables tokens):** system-level `getLocalPaintStylesAsync` / `…TextStylesAsync` /
  `…EffectStylesAsync` / `…GridStylesAsync`; per-node `fillStyleId`/`strokeStyleId`/`effectStyleId`/
  `textStyleId` (guard `figma.mixed`) → `getStyleByIdAsync` → `.name`.
- **Layout:** `layoutMode` ∈ `NONE|HORIZONTAL|VERTICAL|`**`GRID`** (GRID is a 4th value — handle it);
  `primaryAxisAlignItems`/`counterAxisAlignItems`, `itemSpacing`, padding, `layoutWrap`,
  `layoutSizingHorizontal/Vertical` ∈ `FIXED|HUG|FILL`. Absolute (`NONE`) → flag, let the agent infer flow.
- **Paint/stroke/effects:** `fills`/`strokes` (`figma.mixed`-prone), `strokeWeight`/`strokeAlign`/
  `dashPattern`, `cornerRadius` (+ per-corner), `effects` (DROP/INNER_SHADOW, blur; union has grown —
  read defensively), `blendMode`, `opacity`. `SolidPaint.color` is RGB; alpha is separate `opacity`.
- **Text:** `characters`, `fontName`, `fontSize`, `lineHeight` (AUTO has no `value`), `letterSpacing`,
  `textCase`, `textDecoration`, `textAlign*`; `getStyledTextSegments(fields)` for mixed runs. All
  `figma.mixed`-prone — guard before use.
- **Assets:** `exportAsync` — use **`SVG_STRING`** (returns a string) for vectors, `PNG` (Uint8Array) for
  images; `constraint {type:"SCALE",value:2}`. (Plain `"SVG"` is not documented on the export page.)
  PNG bytes are **base64-encoded for transport** (a JSON int-array is ~3.5–4x larger); SVGs travel as strings.
  Container nodes are only flattened to a single SVG when genuinely icon-like (name match **and** ≤96px
  **and** no text descendant) — `exportAsync` flattens the whole subtree, so this preserves real components.
  Symmetrically, a node with an **image fill** is only rasterized to a PNG when it has **no children**; an
  image-*backed* container (a hero/cover/banner with text + buttons over a background image) keeps its
  structure and recurses instead — the image itself survives in `fills`, so no overlaid content is lost.

## Extended IR (implemented on top of the surface above)

The exporter now also reads (all verified fields, all guarded by `in`/`figma.mixed`):
- **Interactions:** `node.reactions` → `{trigger, actions:[{navigation, destination, transition:{type,
  easing, duration, direction, matchLayers, cubicBezier, spring}}]}`. FREE via the Plugin API and
  **unreadable by the paid `get_motion_context`** — the UX/navigation layer is ours. `transition` carries
  the full free-API motion surface: `matchLayers` (smart-animate) + the exact easing curve
  (`easingFunctionCubicBezier`→`cubicBezier {x1,y1,x2,y2}`, `easingFunctionSpring`→`spring
  {mass,stiffness,damping,initialVelocity}`). Verified against developers.figma.com: the free Plugin API
  exposes **NO keyframe tracks / timeline** — animated-component timelines are a paid `get_motion_context`
  surface only, so this is as far as free-plan motion extraction goes.
- **Responsive/scroll:** `clipsContent`→`clip`, `overflowDirection`→`scroll`, `constraints`→`pin`,
  `minWidth/maxWidth/minHeight/maxHeight`→`sizeLimits`, `layoutGrow`→`grow`, `layoutPositioning:ABSOLUTE`→`absolute`.
- **Inferred flex:** `node.inferredAutoLayout` upgrades a non-auto-layout frame to flex intent (`layout.inferred:true`)
  instead of emitting raw coordinates.
- **Richer paint/geometry:** gradient `stops`, image `scaleMode`, per-side stroke `weights` (mixed fallback),
  per-corner `radius` (mixed fallback), `rotation`, `blendMode`, `isMask`.
- **Text:** mixed runs via `getStyledTextSegments` → `runs[]` (no more flattening); unit-aware
  `lineHeight`/`letterSpacing` (`percent`/`px`/`auto`); `fontName.style` verbatim; `paragraphSpacing`,
  `leadingTrim`, per-run `href`/`list`.
- **Effects:** full ordered `effects[]`, type-discriminated (`BACKGROUND_BLUR`≠`LAYER_BLUR`≠shadows), with
  `visible`/`blendMode`/`behindNode`.
- **Variables:** `tier` (primitive/semantic from alias+scopes), `scopes`, `codeSyntax {WEB,ANDROID,iOS}`
  (free per-platform token names), `remote`; COLOR values folded to hex so **alpha survives**.
- **Components:** catalog keeps the real `#uid` prop `key` + `type` + `default` + `options` + `description`
  + node `id` (the last lets `bridge/seed-components.js` map Code Connect node-ids → names).
- **Diagnostics:** every export doc carries a `manifest` (`nodes`/`skipped`/`truncated`/`assetsFailed`/
  `warnings[]`) — no silent truncation; the design system carries a `hygiene[]` list (ALL_SCOPES,
  semantic-holds-raw, broken alias, variant-explosion>30, unnamed/duplicate components).

### Tier-1 additions (2026-07-23, all signatures verified vs developers.figma.com; harness 58/58)

- **Theme mode pins → `variableModes` + `resolvedModes`:** per node, `node.explicitVariableModes`
  (`{collectionId: modeId}`, sync) resolved to `{collectionName: modeName}` via memoized
  `getVariableCollectionByIdAsync` — the **explicit** pins set on a subtree. At the **export root** we
  additionally emit `resolvedModes` from `node.resolvedVariableModes` (the **effective** modes inherited
  from any ancestor, including the PAGE), filtered to multi-mode collections; root-only keeps it out of
  every descendant. Together these are the missing link for correct light/dark codegen — and `resolvedModes`
  specifically fixes single-node exports ("paste a link") whose theme is pinned on an ancestor/page, which
  value-baking targets (SwiftUI/Compose/RN) would otherwise render in the collection default (Light).
- **Prop-driven components:** `componentPropertyReferences` → `propRefs` (`{visible/characters/mainComponent:
  propName}`, `#id` suffix stripped) tells codegen which prop drives a nested layer; instance `overrides`
  (direct `overriddenFields` only, empty-filtered, capped 100) shows what diverges from the main component;
  design-system prop defs now carry INSTANCE_SWAP `preferredValues` (`{type,key}[]` — the allowed swap set →
  a typed enum) + per-prop `description`.
- **Full-frame reference render → `reference`:** `collectReference()` renders each top-level frame to PNG
  (`exportAsync {format:PNG, constraint:{type:SCALE,value}}`, longest side capped ~2048px, downscales below
  1× for huge canvases). Emitted as an asset `{kind:"reference"}` + a `reference` path on the tree/screen —
  structural JSON is not ground truth; the codegen agent self-corrects against this image.
- **Token bindings beyond node level:** generalized `resolveBoundMap()` now resolves `boundVariables` on
  **text runs** (`getStyledTextSegments` + `boundVariables` field → `runs[].tokens`), **effects**
  (`effect.tokens`), **gradient stops** (`stop.tokens`), and **paints** (`fill.tokens`). Previously these
  bindings degraded to hardcoded literals — the whole point of token extraction. (`simplifyFills` /
  `simplifyEffects` / `serializeText` became async; all call sites awaited, incl. design-system style maps.)
- **Bug fix + HIGH/MED coverage (2026-07-23, all names verified vs developers.figma.com; harness 89/89):**
  Fixed a real defect — progressive-blur `startOffset`/`endOffset` are **Vectors `{x,y}`** in normalized
  object space, but were guarded with `typeof === "number"` and silently dropped. Added: **`box`/`renderBox`**
  from `absoluteBoundingBox`/`absoluteRenderBounds` (resolved pixel ground-truth — auto-layout/grid children
  had none); modern prototype actions **`SET_VARIABLE`/`SET_VARIABLE_MODE`/`CONDITIONAL`(recursive)/`UPDATE_MEDIA_RUNTIME`**
  + NODE carry-over flags (`preserveScroll`/`resetVideo`/…) + **overlay settings** (position/scrim/close-on-click-outside),
  via extracted `serializeAction()`; **`ImagePaint.filters`** (+video) exposure/contrast/etc; **NOISE/GLASS/TEXTURE**
  effect fields (were `{type}` only); **`PatternPaint`**; **`VariableCollection.defaultModeId`** (the `:root` base
  mode); per-run **`textStyleId`/`fillStyleId`/`openTypeFeatures`/`indentation`** + decoration sub-fields;
  component **`key`** (resolves INSTANCE_SWAP `preferredValues` keys) + **`documentationLinks`**; **`detachedInfo`**,
  **`exposedInstances`**; **`maskType`/`cornerSmoothing`/`targetAspectRatio`**; **`strokesIncludedInLayout`**
  (border-box); **`node.getDevResourcesAsync`** (batched once per root, `includeChildren`); **`documentColorProfile`**
  (P3) + file name; `Variable.description`; `annotation.categoryId`; **`TABLE`** cell traversal via `cellAt()`
  (tables have no `children` — exported empty before).
- **Verified NON-gaps (excluded on purpose):** `gradientHandlePositions` (REST-only, not in Plugin-API
  `GradientPaint`), `SET_STATE` action (doesn't exist), `variantGroupProperties` (deprecated → `componentPropertyDefinitions`).
- **Gap-audit closeout (2026-07-24, all signatures re-verified vs developers.figma.com; harness 124/124):** a
  63-agent research pass (Plugin API + OSS tools + paid Dev-Mode MCP) found the read plane at/beyond paid parity;
  most reported "gaps" were already implemented (`listSpacing`/`hangingList`/`hangingPunctuation`/`paragraphIndent`
  in text; `itemReverseZIndex`→`reverseZ`; image `imageTransform`/`rotation`/tile `scalingFactor`). The genuine ones
  are now closed: **`EllipseNode.arcData`** → `arc {start,end,innerRadius}` (arcs/donuts/rings; omitted for a plain full
  ellipse); **`StarNode.pointCount`/`innerRadius`** + **`PolygonNode.pointCount`** → `shape {points,innerRadius}`;
  **`BooleanOperationNode.booleanOperation`** → `booleanOp`; variable + collection **`hiddenFromPublishing`** (stops
  designer-private tokens leaking into the public API) and **`key`** (durable cross-file identity for the `tooling/`
  map, mirroring the component-`key` precedent); **image source bytes + intrinsic size** via
  `figma.getImageByHash(hash).getBytesAsync()`/`getSizeAsync()` (asset `kind:"source"`, deduped by hash;
  paint `intrinsicSize {w,h}`); **`useAbsoluteBounds:true`** on the image-fill PNG export (overhang no longer clipped);
  and an opt-in **cross-plugin shared-data reader** (`getSharedPluginData`) that surfaces **Tokens Studio** applied
  tokens (`sharedData.tokens.{prop}`) — the semantic layer on files without native Variables. Opt-in flags now:
  `css`/`measurements`/`pluginData`/`motion`/`sharedData`. Deferred within these: the Tokens Studio document-level
  `values`/`themes` blob (lz-string-compressed + chunked — needs a decoder); dedicated a11y namespaces (no public,
  stable namespace to probe).
- **Still open (lowest value / deferred):** `page.backgrounds`, `ShaderPaint`/`ShaderEffect` property detail
  (only the opaque program `id` is read), `exportSettings` (designer export presets — self-driven export covers
  it), `prototypeDevice`, `relativeTransform` skew decomposition.
- **Best-practice validation + fixes (2026-07-24; harness 133/133, tooling 126/126):** an adversarial pass
  (official Figma Dev Mode/MCP + variables/modes + OSS AI-codegen practice) confirmed the read plane at/above
  parity but caught **one correctness bug**, now fixed: a container with an **image fill + children** was
  flattened to a flat PNG, silently dropping its text/buttons/tokens — the image-fill export is now guarded
  (see **Assets** above). Also added: **`resolvedModes`** (effective inherited theme at the export root — see
  above), a **`missingFont`** flag (+warning) when a text node's font is substituted, and **auto-on `css`** for
  single-node / small (≤60-node) selections so Figma's `getCSSAsync` oracle is on by default where it's cheap
  (large trees & multi-select stay opt-in; an explicit `css:false` always wins).
  **Code Connect** (node→codebase-component + prop transforms) is Org/Ent-gated — **now replicated locally**
  in `tooling/` (DTCG token emitter, schema'd + validated + drift-checked `codeconnect.local.json` map,
  bootstrapper). See `tooling/README.md` (who/what/how/why) and `docs/design-to-code-spec.md` (the sourced
  ADR); validate on real data via the Layer C checklist in `TESTING.md`. Built + 4-round adversarially
  reviewed (tooling suite 126/126); codegen resolver deferred to a target repo.

## Claude Code integration (verified)

- **MCP transports:** stdio (default, recommended here), http/streamable-http, sse (deprecated), and
  **ws** (via `.mcp.json` / `claude mcp add-json` only). Our MCP server exposes **stdio** to Claude Code
  and keeps the WebSocket-to-plugin internal.
- **`.mcp.json`** (project scope, committable): `{ "mcpServers": { "figma-bridge": { "type":"stdio",
  "command":"node", "args":["./mcp-server.js"] } } }`.
- **Permissions:** MCP tools are `mcp__<server>__<tool>`; pre-approve via `permissions.allow`
  (`"mcp__figma-bridge__*"`). CLI: allowlist `"Bash(figma-pull:*)"`. (Configure only if/when we build these.)
- **Skill vs MCP:** the `figma-to-code` **Skill orchestrates** (read files → map → build → self-correct);
  MCP/CLI **provide the data**. Complementary.

## Reuse posture — Figma's skills & knowledge (verified 2026-07)

**Reuse the knowledge, not the skills.** Figma's official skills (`figma/mcp-server-guide`:
`figma-use`, `figma-design-to-code`, `figma-generate-design`, `figma-swiftui`, `figma-implement-motion`, …)
are all wired to the **metered/paid MCP tools** (`get_design_context`, `use_figma`, …) — the exact plane
this repo avoids — so they don't *run* in a free Plugin-API pipeline. They also carry **no OSI license**
(Figma Developer Terms, Beta) → **do not vendor their files**; read them, then **re-express** the ideas in
our own `code.js` / `profiles/*.md` / skills. Our `figma-to-code` Skill stays the orchestrator.

- **Knowledge worth lifting (re-authored):** the Plugin-API gotchas (systematic `=== figma.mixed` guards,
  async-under-dynamic-page, `findAllWithCriteria` perf), `variable.codeSyntax {WEB,ANDROID,iOS}` for free
  per-platform token names, the Code-Connect data model (property `#uid` key + type + `defaultValue` +
  `componentPropertyReferences`) for a richer `components.json`, and the `figma-swiftui` structural rules
  (recognize `List`/`NavigationStack`/`TabView`; HIG semantic colors → dark mode; SF Symbols by name).
- **Typings:** ✅ pulled from **npm `@figma/plugin-typings`** (properly licensed, v1.131.0) — not the
  unlicensed vendored copy in mcp-server-guide. The plugin source is now TypeScript checked against it,
  retiring the hand-maintained API list.
- **Community skills (third-party, MIT/CC0):** `export-tokens-figma`, `design-react-api`, the a11y set
  (`lint-design-figma`, `apca-compliance-figma`) — vendorable *with attribution*, applied to our JSON export.
- **Free advantage the paid tools lack:** `node.reactions` (prototype interactions) reads free via the
  Plugin API; `get_motion_context` cannot read it at all. The interaction/UX layer is ours to extract.

## Build order

1. ✅ **Exporter plugin** (done) — full design system + all screens + assets, `allowedDomains:["none"]`,
   read-only, no network. Manual file handoff. **This is enough to start.** Now authored in
   **TypeScript** (`figma-plugin/src/*.ts`, typed against `@figma/plugin-typings`) and bundled to
   `code.js` via esbuild; the built `code.js` is committed so import stays zero-build. `tsc --noEmit`
   is the first test gate. See `figma-plugin/README.md`.
2. **`figma-pull` CLI** (next, optional) — plugin gains a hidden-iframe WS client (`devAllowedDomains:
   ["ws://localhost:PORT"]`); CLI hosts an ephemeral WS server, pulls, writes the same files, exits.
   Removes the manual click. No MCP.
3. **`figma-mcp` write server** (later, opt-in only) — stdio↔Claude Code, persistent WS↔plugin, for
   code→design. Kept separate so the write surface never touches the read path.

## Security posture

- Exporter: `["none"]` → structurally cannot exfiltrate.
- Bridge: `ws://localhost` only → reaches your machine, never the internet. But loopback is *reachability*,
  not authentication — any local process, and any page in your browser, can open the port. So the bridge
  requires a **shared token** (from `FIGMA_BRIDGE_TOKEN`, else printed per-run; pasted into the plugin and
  kept in `clientStorage`); connections without it are rejected at the handshake (401), foreign origins 403.
  In-flight requests reject on plugin disconnect; a busy port exits with a clear `EADDRINUSE` message.
- Write server is opt-in and isolated. We prefer our own read-only tools over the community read-**write**
  MCPs (larger, arbitrary-code surfaces; one REST-based server shipped an RCE, CVE-2025-53967).
- File must be **open in Figma** with the plugin running for any live path (never headless).
