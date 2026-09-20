# Design Twin — architecture

**Figma → code on the free plan, verified.**

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

## Two front-ends, one bridge, one plugin

Not "CLI = read, MCP = write". The CLI is read-only; the MCP server is **read and write** — 14 of its
15 tools are reads (12 live `figma_*` reads that mirror the CLI, plus 2 `design_*` tools that read the
export on disk), and `figma_write` is the only write surface anywhere. What actually separates the two
is the calling convention, spelled out under the diagram.

```
                         CLI front-end: batch reads → files on disk  — you need this
  Figma (file open)
    code.js (Plugin API reads) ──postMessage──► ui.html [hidden iframe, WS client]
                                                       │ ws://localhost:PORT
    figma-pull (CLI)  ── hosts WS server, requests export, writes files, exits ──►
          design/design-system.json (manifest) · design-system/{tokens,styles.paint,styles.text,
          styles.effect,styles.grid,components.local,components.library,hygiene}.json ·
          design-system/components/<name>__<id>.json (one per COMPONENT_SET or standalone COMPONENT,
          holding the node tree(s) stripped out of components.local.json's variantsFile/nodeFile pointer) ·
          pages/index.json · pages/<page>/index.json +
          pages/<page>/<name>__<id>.json · assets/
    Claude Code  ── runs `figma-pull` (Bash), then Reads files selectively ──►

    figma-pull --serve (daemon)  ── holds the WS server open; later invocations become thin
          clients over a unix socket and skip the plugin reconnect ──►

                         MCP front-end: interactive reads + the only WRITE path  — optional
  Claude Code ──MCP (stdio)──► figma-mcp [hosts persistent WS server] ⇄ ws ⇄ ui.html ⇄ code.js
          same reads as the CLI (inline, or to disk via writeToDisk:true) · figma_write (code → design,
          4 safe ops, dryRun preview, refused in read-only Dev Mode)
```

**The real split is not CLI-vs-MCP — it is "does the payload go through the context window".**
Both front-ends speak the *same* plugin commands (`figma-plugin/src/bridge.ts`) over the *same*
`createBridge()`, and both now write through the *same* `write-out.js`. What differs is the calling
convention and where the bytes land:
- **Bulk payloads → disk, always.** The CLI has always done this; the MCP export tools do it too via
  `writeToDisk: true`, which returns a compact index (counts + paths) instead of the tree. Inline MCP
  results are capped (25k tokens by default) and asset bytes are never returned inline at all, so for
  anything real this is not an optimisation but the only correct path.
- **Discovery reads → context, always.** `listLibraries` (which design libraries the file draws on) and
  `listPages` are the two questions you ask *before* paying for anything, and both are bounded by
  construction. The intended order is `listLibraries` → `listPages` → a scoped export
  (`--page <id>` / `figma_export_full({page:[…]})`), which is also what Figma's own agent guidance
  recommends: discover, then scope by library. Two limits are inherent, not implementation gaps —
  Figma exposes **no API to enumerate a library's contents** (so component counts are usage-derived
  from *this* file), and libraries can be enabled **only through the Figma UI**, never via API (so
  every export is silently scoped to whatever was enabled when it ran). Both are reported in the
  result rather than left to look like failures; an empty library list is a normal outcome on a free
  plan or a file with nothing enabled. Reading libraries at all requires the manifest's
  `"permissions": ["teamlibrary"]`, so a plugin imported before that was added returns nothing.
- **Small structured reads → context.** `listPages` / `listChildren` / a single node are exactly what
  belongs inline, and MCP's advantage there is the calling convention: typed schemas, per-tool
  permission gating (`figma_write` is annotated `destructiveHint`), and no process spawn per call.
- **Writes → MCP only.** Many small dependent steps with handles and feedback. The CLI has no write
  surface.

**One bridge at a time.** `figma-pull`, `figma-pull --serve` and `figma-mcp` all bind port 8787;
whichever starts second exits on `EADDRINUSE` (`server-core.js`). So the CLI cannot be used as the
disk path *while* the MCP server is running — which is why `writeToDisk` exists, and why `--serve`
routes ordinary CLI commands through the running daemon instead of opening a second bridge.

**But MANY plugins at once — one per open Figma file.** `server-core.js` keeps a registry of
connections (`clients`, keyed by a server-minted `connId`) rather than a single socket, so a design
file and the library it draws on are both connected and separately addressable. `request()` takes a
routing target as its optional 4th argument; the CLI passes `--client`, MCP passes `client`.

This replaced a single-socket rule that terminated the incumbent on every new connection. That rule
did not merely limit you to one file — it was actively unstable: the displaced plugin's 3-second
auto-reconnect immediately stole the bridge back, and two open files ping-ponged the connection
indefinitely (observed live, which is how the bug was found). Admitting both connections removes the
contention rather than arbitrating it.

Design decisions worth not re-litigating:

- **The routing key is ours, not the plugin's.** `figma.fileKey` is gated to private plugins with
  `enablePrivatePluginApi` (undefined for an ordinary local import — `--whoami` reports which case you
  are in) and `figma.root.name` is human-editable and shared by duplicated files. Both are *recorded*
  and usable as an address, but the key is always the server-minted `connId`.
- **Discovery, not typed channel names.** `--list-clients` / `figma_list_clients` enumerate; you then
  address by id — the Chrome DevTools Protocol `Target.getTargets` → `sessionId` shape. Other Figma
  bridges use user-typed channel strings, which have no server-side uniqueness and misroute silently
  on a typo or a duplicate.
- **Identity is re-derived, never resumed.** The plugin sends `hello` on connect *and* on every
  reconnect. There is no session token to persist, so a runtime Figma tore down and re-ran comes back
  correctly labelled by construction.
- **Ambiguity is refused, not guessed.** An unaddressed command with several files connected errors
  and lists them (the `adb` "more than one device" call). A wrong-file export is indistinguishable
  from a correct one, so guessing is the one unrecoverable failure here.
- **Not two ports.** `devAllowedDomains` pins each port literally — the only wildcard syntax is for
  subdomains (`*.example.com`) or fully-open `*`, never ports. A second port costs a manifest edit
  plus a plugin re-import, i.e. all the friction of the real fix with none of the benefit.
- **Output.** `write-out.js` resolves `outDir` from an argument or `FIGMA_EXPORT_DIR`, so give each
  connected file its own directory and their exports never collide.
- **Isolation.** Pending requests record their `connId`, so one file closing its plugin window fails
  only its own in-flight work — never a long export running in another file.

## Verified mechanism details (build to these)

- **UI iframe holds the socket.** `figma.showUI(__html__, { width: 360, height: 380 })` (`main.ts`) — a
  VISIBLE window, because the manual export buttons and the bridge-token field live in it. The
  API also supports `{ visible: false }` for a headless plugin (the iframe still runs and still holds
  a socket without a window), and `figma.ui.show()` reveals one started hidden — but this plugin does
  not use either. A visible window is what makes bridge state (and any control that needs a click)
  reachable at all; `figma.notify()` is the headless alternative if that ever changes.
- **Messaging:** main→UI `figma.ui.postMessage(msg)` / UI receives `onmessage → e.data.pluginMessage`;
  UI→main `parent.postMessage({ pluginMessage }, '*')` / main receives `figma.ui.onmessage`.
  Payloads must be serializable (objects, strings, `Uint8Array` ok; no functions).
- **Iframe has `null` origin** → the local CLI/MCP server must send `Access-Control-Allow-Origin: *`
  for any HTTP; for WebSocket, origin **cannot** authenticate — the plugin sends `null`, but so does a
  sandboxed attacker iframe (`<iframe sandbox="allow-scripts">`) on any site the user visits. The bridge
  therefore requires a **shared token** (`?token=…`) validated at the handshake, keeping the Origin/Host
  checks only as defense-in-depth. Compared as SHA-256 digests through `timingSafeEqual`: hashing first
  makes both sides a fixed 32 bytes, so unlike a raw compare guarded by a length check, neither the
  token's content nor its **length** leaks through timing.
- **No documented payload-size cap** → **chunk large exports** across `postMessage` and add reconnect logic.
- **Network manifest:** `ws`/`wss` and `http(s)://localhost[:PORT]` are permitted in
  `networkAccess.allowedDomains` — **including for a published plugin**, which is what makes the bridge
  survive Community distribution. Figma's docs require a `reasoning` string precisely *because*
  `allowedDomains` may name a local server ("`reasoning` is required if … your `allowedDomains` list
  includes local or development servers"); a published counterexample is Grab's Talk to Figma MCP
  plugin, which ships `ws://localhost:3055` in production `allowedDomains`.
  Match patterns take **no port wildcard**, so every reachable port must be listed literally: we declare
  `ws://localhost:{8787,8788,8789}` and the plugin walks all three. Adding a fourth needs a new
  published version, which is why `FIGMA_BRIDGE_PORT` is validated against that set
  (`bridge/server-core.js` `ALLOWED_PORTS`) instead of accepting any number.
- **Whole-document read (dynamic-page, required for new plugins):** `documentAccess: "dynamic-page"`;
  call `figma.loadAllPagesAsync()` before traversing other pages; `findAllWithCriteria` needs pages loaded.
  Under dynamic-page **all reads are async** — use `getMainComponentAsync`, `getLocalPaintStylesAsync`,
  `getStyleByIdAsync`, `getVariableByIdAsync`, etc. (sync forms throw).

- **Library data from a CONSUMING file is descriptors only:** `figma.teamLibrary
  .getAvailableLibraryVariableCollectionsAsync()` returns collections (with `libraryName`), and
  `getVariablesInLibraryCollectionAsync(key)` returns `name`/`key`/`resolvedType` — **no values, no
  modes**. There is no team-library API for components or styles at all. This is why `--list-libraries`
  can only report counts, and why component counts there are usage-derived.
- **Full library values come from running INSIDE the library file** (`--as-library`): every object is
  then local, so `getLocalVariablesAsync` / `getLocal*StylesAsync` / a `COMPONENT|COMPONENT_SET` walk
  return the complete catalog with full per-mode values — no extra permission, no paid plan, no import.
- **`importVariableByKeyAsync` is a WRITE and is deliberately unused.** It would resolve library values
  from a consuming file, but the `import*ByKeyAsync` family **materialises into the current document**
  (the typings state exactly that of its sibling `importShaderAsync`, "mirrors `importComponentByKeyAsync`"),
  which is why those calls fail in read-only/Dev Mode. Using it in the read plane would subscribe the
  user's file to hundreds of variables as a side effect of a "pull". It also reports
  `scopes: ['ALL_SCOPES']` regardless of real scope (known, unfixed Figma bug) and returns the *local*
  variable when called inside the library file itself. The library-file path avoids all three.
- **`getPublishStatusAsync()` → `UNPUBLISHED | CURRENT | CHANGED`** on components, styles, variables and
  variable collections. Only meaningful **inside the library file**: from a consuming file or a branch
  Figma answers `UNPUBLISHED` for everything, so the field is emitted in `--as-library` mode only rather
  than shipped as a confident wrong answer. There is no API to list what the last *published snapshot*
  contained, so it describes local objects' relationship to the library, never a diff of what consumers see.

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
  `leadingTrim`, `textWrap` (Figma's `textWrapStyle`: `BALANCE`/`PRETTY` → CSS `text-wrap: balance|pretty`;
  the `AUTO` default is skipped), per-run `href`/`list`.
- **Effects:** full ordered `effects[]`, type-discriminated (`BACKGROUND_BLUR`≠`LAYER_BLUR`≠shadows), with
  `visible`/`blendMode`/`behindNode`.
- **Variables:** `tier` (primitive/semantic from alias+scopes), `scopes`, `codeSyntax {WEB,ANDROID,iOS}`
  (free per-platform token names), `remote`; COLOR values folded to hex so **alpha survives**.
- **Components:** catalog keeps the real `#uid` prop `key` + `type` + `default` + `options` + `description`
  + node `id` (the last lets `bridge/seed-components.js` map Code Connect node-ids → names). Every entry
  also carries `visuals` — the component/variant NODE's own `fills`/`strokes`/`effects`/`radius`/`opacity`/
  `blendMode`, the same mixins any other node has. Always on: these are plain synchronous property getters
  (Figma's Plugin API only suffixes the genuinely expensive calls `Async` — `getCSSAsync`, `exportAsync` —
  and these six aren't among them), so there's no cost to gate. Covers components DEFINED in this file
  only; `remote:true` entries (consumed from a library) need `--as-library` on the source file instead —
  no API exposes a library component's paint from a consuming file.
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
- **On-demand single-node screenshot (`collectScreenshot()`, bridge cmd `screenshot`, CLI `--screenshot
  <id>`, MCP `figma_screenshot`):** the same `collectReference()` render, called on ONE node addressed
  by id instead of every exported root — skips `serialize()` and the recursive asset walk entirely, so
  it stays cheap even on a node buried deep in a large tree. Exists for post-generation visual
  validation of a specific component in a dense screen, where the one whole-frame reference PNG above is
  too zoomed-out to be useful. Mirrors Figma's own Dev Mode MCP server (`get_screenshot`: single-node
  scope, called on demand) rather than pre-rendering every node/instance up front — deliberately NOT a
  bulk pass, which would pay the same O(nodes) cost `--no-assets` exists to avoid for a much bigger
  payload (PNG > structural JSON).
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
  designer-private tokens leaking into the public API) and **`key`** (durable cross-file identity for the `design-to-code/`
  map, mirroring the component-`key` precedent); **image source bytes + intrinsic size** via
  `figma.getImageByHash(hash).getBytesAsync()`/`getSizeAsync()` (asset `kind:"source"`, deduped by hash;
  paint `intrinsicSize {w,h}`); **`useAbsoluteBounds:true`** on the image-fill PNG export (overhang no longer clipped);
  and an opt-in **cross-plugin shared-data reader** (`getSharedPluginData`) that surfaces **Tokens Studio** applied
  tokens (`sharedData.tokens.{prop}`) — the semantic layer on files without native Variables. Opt-in flags now:
  `css`/`measurements`/`pluginData`/`motion`/`sharedData`. Deferred within these: the Tokens Studio document-level
  `values`/`themes` blob (lz-string-compressed + chunked — needs a decoder); dedicated a11y namespaces (no public,
  stable namespace to probe).
- **Audit + fixes (2026-08-08; harness 301/301, tooling 204/204, bridge 109/109):** a 3-agent audit (2 code,
  1 doc-research) plus a verification pass against official docs closed most of the list above. **Landed:**
  invisible/zero-area vector nodes are pre-checked and skipped *before* `exportAsync` (counted as
  `assetsSkippedInvisible`, not `assetsFailed` — a real file produced **807 false failures**); genuine export
  failures on a painting node fall back to **`geometry {fills,strokes,w,h}`** from `fillGeometry`/`strokeGeometry`
  (*not* `vectorPaths`, which the docs call "simple, but incomplete") so icons render as inline SVG; **warnings
  aggregate by kind** (one line + up to 10 example refs, manifest stays a flat `string[]`) instead of ~900 repeats;
  **`inferredTokens` removed entirely** (was ~20% of payload, matched by value-coincidence, zero consumers);
  `box.x/y` omitted under auto-layout/grid parents and `layoutSizing*: "FIXED"` treated as a skipped default;
  **`fixedChildren`** (`numberOfFixedChildren` — sticky headers/footers/FABs), compact **`exportSettings`**,
  **`skew`** (QR decomposition of `relativeTransform`, degrees, CSS `skewX` convention), **`layersDoc.pageSettings`**
  (`background`/`prototypeBackground` per page, Figma defaults skipped), and index entries gained **`nodes`/`bytes`**
  so a consumer knows a layer file's size before opening it (real files reach 5–7 MB).
- **Still open (lowest value / deferred):** `ShaderPaint`/`ShaderEffect` property detail (only the opaque program
  `id` is read — note u130 shipped `figma.listAvailableShaders()`/`importShaderById()`, so this is now closable),
  Motion/animation timelines (u130–u133), `SlotNode` (Slots GA 2026-06). **`prototypeDevice` is not deferred but
  impossible**: verified absent from the Plugin API and from `@figma/plugin-typings` 1.131.0 — it is a REST-only
  field, so device/breakpoint context cannot come from the plugin.
- **Best-practice validation + fixes (2026-07-24; harness 133/133, tooling 126/126):** an adversarial pass
  (official Figma Dev Mode/MCP + variables/modes + OSS AI-codegen practice) confirmed the read plane at/above
  parity but caught **one correctness bug**, now fixed: a container with an **image fill + children** was
  flattened to a flat PNG, silently dropping its text/buttons/tokens — the image-fill export is now guarded
  (see **Assets** above). Also added: **`resolvedModes`** (effective inherited theme at the export root — see
  above), a **`missingFont`** flag (+warning) when a text node's font is substituted, and **auto-on `css`** for
  single-node / small (≤60-node) selections so Figma's `getCSSAsync` oracle is on by default where it's cheap
  (large trees & multi-select stay opt-in; an explicit `css:false` always wins).
  **Code Connect** (node→codebase-component + prop transforms) is Org/Ent-gated — **now replicated locally**
  in `design-to-code/` (DTCG token emitter, schema'd + validated + drift-checked `codeconnect.local.json` map,
  bootstrapper). See `design-to-code/README.md` (who/what/how/why) and `docs/design-to-code-spec.md` (the sourced
  ADR); validate on real data via the Layer C checklist in `TESTING.md`. Built + 4-round adversarially
  reviewed (tooling suite 126/126); codegen resolver deferred to a target repo.
- **Competitor sweep + Plugin API cross-check (2026-08-13; harness 306/306):** researched 10+ Figma-to-code
  tools (FigmaToCode, Anima, Locofy, Builder.io Visual Copilot, TeleportHQ, Figma's own Dev Mode/Code
  Connect/official MCP, html.to.design, Codia AI, Superflex, v0, Magic Patterns, Uizard, Galileo, Zeroheight,
  Supernova, Tokens Studio, Figmagic) plus a direct re-check against `developers.figma.com`'s node property
  docs — confirmed nothing they read is missing here (descriptions, pluginData, variables, auto-layout,
  variants, motion, dev resources all already captured). Two genuine, doc-verified gaps closed: **`isAsset`**
  (Figma's own icon/raster-asset heuristic — docs call it out as "particularly useful for code generation
  plugins"; now OR'd into the `iconLike` check in `assets.ts` as a cross-check alongside the existing
  name/size heuristic, for containers the regex misses) and **`variableWidthStrokeProperties`** (tapered/
  brush-style strokes, 14 node types — now captured in `paint.ts` as `stroke.variableWidth {profile,points}`,
  no flat CSS equivalent but recorded so a consumer can render it as an SVG path with a width gradient).
  `guides` (frame ruler guides) and `complexStrokeProperties` were checked and NOT added — the former is a
  designer authoring aid with no rendered/visual effect, the latter's docs page couldn't be confirmed to exist.
- **Instance → main-component join keys + per-variant visual truth (2026-08-18; harness 371/371):** two gaps
  found by reviewing a real export: (1) an `INSTANCE`'s `component` field carried only the main component's
  bare `name` (`getMainComponentAsync()` resolved, then everything but `.name` discarded) — unjoinable with
  the catalog's `{name,id}` entries, and colliding whenever two components share a name. Every `INSTANCE` now
  also emits **`mainComponent` `{name,id,key,remote,setId,setKey,setName,variant}`** alongside the unchanged
  `component` string (`.parent` optional-chained — a *remote* main's `.parent` may be `null`, per
  `plugin-api.d.ts`); `setId`/`setKey` are the join back to `components.local.json`/`components.library.json`.
  (2) The component catalog's `visuals` for a `COMPONENT_SET` were the **set wrapper's own** fills/radius —
  Figma's purple dashed *selection chrome*, not a design value — while every variant was skipped outright
  (`componentPropertyDefinitions` throws on a variant, so the catalog walk routed around them rather than
  reading their real paint). New opt-in **`--variant-visuals`** flag (registered once in `bridge/read-opts.js`,
  so the CLI/MCP schema pick it up for free) walks each set's variants — already found by the same
  `findAllWithCriteria` pass, no second traversal — and attaches **`entry.variants[]`** with each variant's
  real `layout`/`fills`/`radius`/`tokens`/`css` via the existing node `serialize()` (injected as a parameter
  into `buildDesignSystem`/`collectComponentCatalog` to dodge the `serialize.ts` ↔ `components.ts` import
  cycle — no second serializer). Depth-capped (3 levels), forces `skipAssets` (a design-system pull has no
  asset-manifest path), and per-variant `try/catch` so one bad variant can't drop the catalog. No per-variant
  `props` — `componentPropertyDefinitions` still throws on a variant, so the set-level `props` map stays the
  one source of truth for the prop *schema*; `values` (`{Type:"Default",...}`) comes from `variantProperties`
  or, failing that, is parsed from the variant name Figma guarantees is `"Prop=Val, ..."`. Off by default;
  flag-off catalog output is byte-identical (regression-tested).
- **`components.local.json` index/detail split (2026-08-18):** `--variant-visuals` made the catalog huge
  on a real design-system file — one real export measured `components.local.json` at 4.3MB, almost
  entirely `variants[].node` trees an agent doesn't need just to see a component's prop table. Neither
  `design-to-code/drift-lint.js` nor `design-to-code/map-bootstrap.js` ever reads `.node` (both key off
  `name`/`id`/`key`/`type`/`props`), so `bridge/design-system-layout.js` now strips it out of each
  `COMPONENT_SET` entry into a sibling `design-system/components/<safe(name)>__<safe(id)>.json`, and adds
  a `variantsFile` pointer on the entry (absent, not null, when the set had no exported node trees — same
  convention as `pageId`'s absence on pre-pageId exports). Every variant keeps its `id`/`name`/`key`/
  `values` in the slim catalog. Manifest gained `files.componentsDir`. New `design-to-code/get-component.js`
  resolves one entry by key/id/name and follows `variantsFile` to print its full detail — the read path
  for an agent that DOES want one component's real variant visuals. On that same real export the split
  took `components.local.json` from 4.3MB to 196KB with drift-lint/map-bootstrap unmodified against it
  (143/143 mapped, 0 errors). Both writers build off the one shared function, so they cannot drift.
- **`--variant-visuals` extended to standalone COMPONENTs (2026-08-18; harness 374/374, tooling 222/222):**
  the flag only ever walked variant children of a `COMPONENT_SET` — a standalone `COMPONENT` (never part
  of a set) got none of the same treatment, leaving it with only the slim catalog fields and no way to
  pull its real layout/tokens/css. `collectComponentCatalog` (`figma-plugin/src/components.ts`) now also
  runs `serializeVariant` on a standalone `COMPONENT` (same depth budget, same forced `skipAssets`) and
  attaches the result as **`entry.node`** (not `entry.variants[]` — there is no set to enumerate variants
  of). `bridge/design-system-layout.js` splits any local `COMPONENT` entry carrying `.node` into the same
  `design-system/components/<name>__<id>.json` sibling file, replacing it with a **`nodeFile`** pointer
  (mirroring `variantsFile`). `design-to-code/get-component.js` resolves either pointer. Flag-off and
  `COMPONENT_SET` output are byte-identical (regression-tested).

## Claude Code integration (verified)

- **MCP transports:** stdio (default, recommended here), http/streamable-http, sse (deprecated), and
  **ws** (via `.mcp.json` / `claude mcp add-json` only). Our MCP server exposes **stdio** to Claude Code
  and keeps the WebSocket-to-plugin internal.
- **`.mcp.json`** (project scope, committable): `{ "mcpServers": { "designtwin": { "type":"stdio",
  "command":"node", "args":["/abs/path/to/bridge/figma-mcp.mjs"] } } }` — registered in the
  project you point the bridge at, never in this repo.
- **Permissions:** MCP tools are `mcp__<server>__<tool>`; pre-approve via `permissions.allow`
  (`"mcp__designtwin__*"`). CLI: allowlist `"Bash(dtwin:*)"`.
- **Skill vs MCP:** the skills **orchestrate** — `audit-design` reviews the export before code
  (`design-to-code/audit.js` does the deterministic checks; the skill adds engineer judgment and
  designer questions), `build-screen` gates on that audit → maps → builds → verifies by rendering;
  MCP/CLI **provide the data**. Complementary. The audit is offline-only (reads `design/`), like
  drift-lint.

## Reuse posture — Figma's skills & knowledge (verified 2026-07)

**Reuse the knowledge, not the skills.** Figma's official skills (`figma/mcp-server-guide`:
`figma-use`, `figma-design-to-code`, `figma-generate-design`, `figma-swiftui`, `figma-implement-motion`, …)
are all wired to the **metered/paid MCP tools** (`get_design_context`, `use_figma`, …) — the exact plane
this repo avoids — so they don't *run* in a free Plugin-API pipeline. They also carry **no OSI license**
(Figma Developer Terms, Beta) → **do not vendor their files**; read them, then **re-express** the ideas in
our own `code.js` / `profiles/*.md` / skills. Our `build-screen` skill stays the orchestrator.

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

1. ✅ **Exporter plugin** (done) — full design system + all layers + assets, loopback-only
   `allowedDomains`, read-only, no internet. Manual file handoff. **This is enough to start.** Now authored in
   **TypeScript** (`figma-plugin/src/*.ts`, typed against `@figma/plugin-typings`) and bundled to
   `code.js` via esbuild; the built `code.js` is committed so import stays zero-build. `tsc --noEmit`
   is the first test gate. See `figma-plugin/README.md`.
2. ✅ **`dtwin` CLI** (done, optional) — the plugin has a hidden-iframe WS client
   (`allowedDomains: ["ws://localhost:PORT"]`); the CLI hosts an ephemeral WS server, pulls, writes
   the same files, exits. Removes the manual click. No MCP. Packaged as the `designtwin` npm package
   (**not yet published** — until it is, run `node bridge/figma-pull.js` from a clone);
   `bridge/figma-pull.js` is its entry point. `dtwin init` sets a consumer project up in one command.
3. ✅ **`dtwin mcp` server** (done, opt-in only) — stdio↔Claude Code, persistent WS↔plugin. The
   interactive front-end: the same reads as the CLI as typed tools, plus `figma_write`, the only
   code→design path. Kept a separate process so the write surface never touches the CLI's read path.
   Writes are still a small fixed set of safe ops with a `dryRun` preview, not a general authoring API.

## Security posture

- Exporter: no internet domain in `allowedDomains` → structurally cannot exfiltrate. Figma **publishes**
  the declared domain list on the Community page, so this is a claim a stranger can verify without
  reading the source — a stronger guarantee than a self-asserted one.
- Bridge: `ws://localhost` only → reaches your machine, never the internet. But loopback is *reachability*,
  not authentication — any local process, and any page in your browser, can open the port. So the bridge
  requires a **shared token**, generated on first use and persisted per-user (`bridge/token-store.js`:
  `~/.config/design-twin/bridge-token` / `%APPDATA%`, mode `0600`; `--token-file` and
  `FIGMA_BRIDGE_TOKEN` override it). Pasted into the plugin once and kept in `clientStorage`.
  Connections without it are rejected at the handshake (401, compared as SHA-256 digests through
  `timingSafeEqual` so neither content nor length leaks), foreign origins 403.
  In-flight requests reject on plugin disconnect; a busy port exits with a clear `EADDRINUSE` message.
- Write server is opt-in and isolated. We prefer our own read-only tools over the community read-**write**
  MCPs (larger, arbitrary-code surfaces; one REST-based server shipped an RCE, CVE-2025-53967).
- File must be **open in Figma** with the plugin running for any live path (never headless).
