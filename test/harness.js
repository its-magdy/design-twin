// Offline validation harness for figma-plugin/code.js.
// Loads code.js in a VM with a mock `figma`, then drives serialize()/dumpVariables()/buildDesignSystem()
// against a representative fake node tree. Verifies the extraction transforms produce correct JSON.
// This needs NO Figma app — run it with:  node test/harness.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { ok, report } = require("./assert");

const MIXED = Symbol("figma.mixed");

// ---- mock design-system data ----
const VARS = {
  v_primary: { id: "v_primary", name: "color/primary", resolvedType: "COLOR", variableCollectionId: "c_sem",
    scopes: ["FRAME_FILL"], codeSyntax: { WEB: "var(--color-primary)", iOS: "Color.primary" }, remote: false, description: "Primary brand color",
    valuesByMode: { m_light: { type: "VARIABLE_ALIAS", id: "v_blue600" }, m_dark: { type: "VARIABLE_ALIAS", id: "v_blue300" } } },
  v_blue600: { id: "v_blue600", name: "blue/600", resolvedType: "COLOR", variableCollectionId: "c_prim",
    scopes: [], codeSyntax: {}, remote: false, hiddenFromPublishing: true, key: "varkey_blue600",
    valuesByMode: { m_val: { r: 0.1, g: 0.3, b: 0.9, a: 1 } } },
  v_blue300: { id: "v_blue300", name: "blue/300", resolvedType: "COLOR", variableCollectionId: "c_prim",
    scopes: [], codeSyntax: {}, remote: false, valuesByMode: { m_val: { r: 0.5, g: 0.7, b: 1, a: 1 } } },
  v_allscope: { id: "v_allscope", name: "misc/bad", resolvedType: "FLOAT", variableCollectionId: "c_sem",
    scopes: ["ALL_SCOPES"], codeSyntax: {}, remote: false, valuesByMode: { m_light: 4, m_dark: 4 } },
};
const COLLECTIONS = [
  { id: "c_prim", name: "Primitives", modes: [{ modeId: "m_val", name: "Value" }], defaultModeId: "m_val" },
  { id: "c_sem", name: "Semantic", modes: [{ modeId: "m_light", name: "Light" }, { modeId: "m_dark", name: "Dark" }], defaultModeId: "m_light" },
];

// ---- mock nodes ----
const textNode = {
  type: "TEXT", name: "Heading", visible: true, characters: "Hello World", id: "1:1",
  textAlignHorizontal: "LEFT", paragraphSpacing: 8, paragraphIndent: 0, leadingTrim: "NONE", width: 200,
  textAlignVertical: "CENTER", textAutoResize: "HEIGHT", textTruncation: "ENDING", maxLines: 2,
  fontSize: 24, fontName: { family: "Inter", style: "Bold" }, lineHeight: { unit: "PERCENT", value: 120 },
  letterSpacing: { unit: "PIXELS", value: 0.5 }, textCase: "ORIGINAL", textDecoration: "NONE",
  fills: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 1 }],
  componentPropertyReferences: { characters: "Label#1:0" }, // prop-driven text
  getStyledTextSegments: () => ([
    { characters: "Hello ", fontName: { family: "Inter", style: "Regular" }, fontSize: 24, lineHeight: { unit: "PERCENT", value: 120 }, letterSpacing: { unit: "PIXELS", value: 0.5 }, textCase: "ORIGINAL", textDecoration: "NONE", fills: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 1 }], hyperlink: null, listOptions: { type: "NONE" }, boundVariables: {} },
    { characters: "World", fontName: { family: "Inter", style: "Bold" }, fontSize: 24, lineHeight: { unit: "PERCENT", value: 120 }, letterSpacing: { unit: "PIXELS", value: 0.5 }, textCase: "ORIGINAL", textDecoration: "UNDERLINE", textDecorationThickness: { value: 2, unit: "PIXELS" }, textDecorationOffset: { value: 1, unit: "PIXELS" }, textDecorationSkipInk: false, fills: [{ type: "SOLID", visible: true, color: { r: 0.1, g: 0.3, b: 0.9 }, opacity: 1 }], hyperlink: { type: "URL", value: "https://x.com" }, listOptions: { type: "NONE" }, indentation: 1, openTypeFeatures: { SMCP: true, LIGA: false }, textStyleId: "s_heading", fillStyleId: "s_brand", boundVariables: { fills: { type: "VARIABLE_ALIAS", id: "v_primary" } } },
  ]),
};
const gradientRect = {
  type: "RECTANGLE", name: "Banner", visible: true,
  fills: [{ type: "GRADIENT_LINEAR", visible: true, gradientStops: [{ position: 0, color: { r: 1, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } }] }],
  strokes: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 1 }],
  strokeWeight: MIXED, strokeTopWeight: 0, strokeBottomWeight: 2, strokeLeftWeight: 0, strokeRightWeight: 0,
  strokeAlign: "INSIDE",
  effects: [{ type: "DROP_SHADOW", visible: true, color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 2 }, radius: 4, spread: 0, blendMode: "NORMAL", showShadowBehindNode: false, boundVariables: { radius: { type: "VARIABLE_ALIAS", id: "v_allscope" } } },
            { type: "BACKGROUND_BLUR", visible: true, radius: 10 }],
  cornerRadius: MIXED, topLeftRadius: 8, topRightRadius: 8, bottomLeftRadius: 0, bottomRightRadius: 0,
  opacity: 1, rotation: 0, blendMode: "NORMAL", isMask: false,
};
const button = {
  type: "INSTANCE", name: "PrimaryButton", visible: true,
  componentProperties: { "Label#1:0": { type: "TEXT", value: "Go", boundVariables: { value: { type: "VARIABLE_ALIAS", id: "v_primary" } } }, "Size": { type: "VARIANT", value: "md" } },
  boundVariables: { fills: [{ type: "VARIABLE_ALIAS", id: "v_primary" }] },
  fills: [{ type: "SOLID", visible: true, color: { r: 0.1, g: 0.3, b: 0.9 }, opacity: 1 }],
  overrides: [{ id: "9:9", overriddenFields: ["characters", "fills"] }, { id: "9:10", overriddenFields: [] }],
  reactions: [{ trigger: { type: "ON_CLICK" }, actions: [
    { type: "NODE", navigation: "NAVIGATE", destinationId: "frame_2", preserveScrollPosition: true, transition: { type: "SMART_ANIMATE", duration: 0.3, matchLayers: true, easing: { type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1: 0.4, y1: 0, x2: 0.2, y2: 1 } } } },
    { type: "SET_VARIABLE", variableId: "v_primary", variableValue: { resolvedType: "COLOR", value: { type: "VARIABLE_ALIAS", id: "v_blue600" } } },
    { type: "SET_VARIABLE_MODE", variableCollectionId: "c_sem", variableModeId: "m_dark" },
    { type: "CONDITIONAL", conditionalBlocks: [{ condition: { value: true }, actions: [{ type: "NODE", navigation: "NAVIGATE", destinationId: "frame_2" }] }] },
  ] }],
  getMainComponentAsync: async () => ({ name: "Button" }),
};
const scrollFrame = {
  type: "FRAME", name: "List", visible: true, layoutMode: "VERTICAL", itemSpacing: 12, id: "1:0",
  width: 375, height: 800,
  paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16,
  primaryAxisAlignItems: "MIN", counterAxisAlignItems: "MIN", layoutWrap: "NO_WRAP",
  layoutSizingHorizontal: "FILL", layoutSizingVertical: "HUG",
  clipsContent: true, overflowDirection: "VERTICAL",
  minWidth: null, maxWidth: 400, minHeight: null, maxHeight: null,
  strokesIncludedInLayout: true,
  // --- Tier-1 read additions (opt-in via css/measurements/pluginData) ---
  getCSSAsync: async () => ({ display: "flex", "flex-direction": "column", padding: "16px" }),
  getPluginDataKeys: () => ["codeConnect"],
  getPluginData: (k) => (k === "codeConnect" ? "Button/Primary" : ""),
  inferredVariables: { fills: [[{ type: "VARIABLE_ALIAS", id: "v_primary" }]] }, // suggestion for an unbound field
  // Motion plane (Plugin API Update 130) — opt-in via {motion:true}.
  timelines: [{ id: "tl1", duration: 0.5 }],
  manualKeyframeTracks: { TRANSLATION_X: { id: "trk1", baseValue: { type: "FLOAT", value: 0 }, keyframes: [{ id: "k1", timelinePosition: 0, value: { type: "FLOAT", value: 0 }, easing: { type: "EASE_OUT" } }, { id: "k2", timelinePosition: 0.5, value: { type: "FLOAT", value: 100 }, easing: { type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1: 0.4, y1: 0, x2: 0.2, y2: 1 } } }] } },
  animationStyles: [{ styleId: "as1", name: "Fade In", duration: 0.3, timelineOffset: 0 }],
  absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 800 },
  constraints: { horizontal: "MIN", vertical: "MIN" },
  explicitVariableModes: { c_sem: "m_dark" }, // this subtree pinned to the Dark theme
  // Effective/inherited modes for ALL collections at this node (incl. single-mode Primitives, which
  // must be filtered out of resolvedModes since it carries no theme choice).
  resolvedVariableModes: { c_sem: "m_dark", c_prim: "m_val" },
  exportAsync: async () => new Uint8Array([137, 80, 78, 71]), // PNG magic bytes
  getDevResourcesAsync: async () => ([{ name: "Storybook", url: "https://sb.example.com/list", inheritedNodeId: null }]),
  // Cross-plugin shared data — Tokens Studio applied tokens (opt-in via {sharedData:true}).
  getSharedPluginDataKeys: (ns) => (ns === "tokens" ? ["fill", "borderRadius"] : []),
  getSharedPluginData: (ns, k) => (ns === "tokens" ? ({ fill: "color.primary", borderRadius: "radius.md" }[k] || "") : ""),
  children: [textNode, gradientRect, button],
};

// A COMPONENT with an INSTANCE_SWAP prop that carries preferredValues (allowed swap set).
const buttonComponent = {
  type: "COMPONENT", name: "Button", id: "5:0", description: "Primary action button", parent: null,
  key: "compkey123", documentationLinks: [{ uri: "https://docs.example.com/button" }],
  componentPropertyDefinitions: {
    "Label#1:0": { type: "TEXT", defaultValue: "Button", description: "Visible label" },
    "Icon#2:0": { type: "INSTANCE_SWAP", defaultValue: "icon:home", preferredValues: [{ type: "COMPONENT", key: "abc" }, { type: "COMPONENT", key: "def" }] },
    "Size": { type: "VARIANT", defaultValue: "md", variantOptions: ["sm", "md", "lg"] },
  },
};

// ---- mock figma ----
const noop = () => {};
const figma = {
  mixed: MIXED,
  showUI: noop, on: noop,
  ui: { onmessage: null, postMessage: noop },
  clientStorage: { getAsync: async () => "", setAsync: async () => {} },
  currentPage: {
    name: "Page 1", selection: [scrollFrame], children: [scrollFrame],
    // Dev-Mode measurement redlines — SYNCHRONOUS API (getMeasurements, not *Async).
    getMeasurements: () => [{ start: { node: { id: "1:0" }, side: "LEFT" }, end: { node: { id: "1:1" }, side: "RIGHT" }, offset: { type: "OUTER", fixed: 16 }, freeText: "16" }],
  },
  root: { name: "My File", documentColorProfile: "DISPLAY_P3", children: [{ name: "Page 1", children: [scrollFrame], findAllWithCriteria: () => [buttonComponent] }] },
  loadAllPagesAsync: async () => {},
  // Source-image resolution: intrinsic pixel size + original uploaded bytes, keyed by image hash.
  getImageByHash: (hash) => (hash === "abc123" ? { getSizeAsync: async () => ({ width: 800, height: 600 }), getBytesAsync: async () => new Uint8Array([1, 2, 3, 4]) } : null),
  getNodeByIdAsync: async (id) => (id === "frame_2" ? { name: "Details" } : null),
  getStyleByIdAsync: async (id) => ({ s_heading: { name: "Heading/H1" }, s_brand: { name: "Brand/Primary" } }[id] || null),
  getLocalPaintStylesAsync: async () => [{ name: "Brand/Primary", paints: [{ type: "SOLID", visible: true, color: { r: 0.1, g: 0.3, b: 0.9 }, opacity: 1 }], description: "" }],
  getLocalTextStylesAsync: async () => [{ name: "Body/Regular", fontSize: 16, fontName: { family: "Inter", style: "Regular" }, lineHeight: { unit: "AUTO" }, letterSpacing: { unit: "PIXELS", value: 0 }, textCase: "ORIGINAL", textDecoration: "NONE", paragraphSpacing: 8, paragraphIndent: 4, leadingTrim: "CAP_HEIGHT", listSpacing: 6, boundVariables: { fontSize: { type: "VARIABLE_ALIAS", id: "v_allscope" } }, description: "" }],
  getLocalEffectStylesAsync: async () => [],
  getLocalGridStylesAsync: async () => [{ name: "Grid/12col", layoutGrids: [{ pattern: "COLUMNS", count: 12, gutterSize: 20, sectionSize: 60 }], description: "" }],
  variables: {
    getLocalVariablesAsync: async () => Object.values(VARS),
    getLocalVariableCollectionsAsync: async () => COLLECTIONS,
    getVariableByIdAsync: async (id) => VARS[id] || null,
    getVariableCollectionByIdAsync: async (id) => COLLECTIONS.find((c) => c.id === id) || null,
  },
};

// ---- load code.js into a VM sandbox ----
const src = fs.readFileSync(path.join(__dirname, "..", "figma-plugin", "code.js"), "utf8");
const sandbox = { figma, __html__: "<ui/>", Promise, JSON, Math, Array, Object, Symbol, Map, Set, Date, console, parseInt, Number, String, Boolean, isNaN, undefined };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
// code.js is now an esbuild IIFE bundle (TypeScript source in figma-plugin/src/). It exposes the
// read API on a namespaced global; lift those onto the sandbox so the assertions below read as before.
Object.assign(sandbox, sandbox.__designExport || {});

// ---- run + assert ----
(async () => {
  const sel = await sandbox.collectSelection();
  const tree = sel.screen.nodes[0];
  const [txt, rect, btn] = tree.children;

  ok("manifest present", sel.screen.manifest && typeof sel.screen.manifest.nodes === "number");
  ok("manifest counted nodes (>=4)", sel.screen.manifest.nodes >= 4);
  ok("scroll frame -> clip", tree.clip === true);
  ok("scroll frame -> scroll:vertical", tree.scroll === "vertical");
  ok("scroll frame -> sizeLimits.maxWidth", tree.sizeLimits && tree.sizeLimits.maxWidth === 400);
  ok("layout flex column + gap + padding", tree.layout && tree.layout.flexDirection === "column" && tree.layout.gap === 12 && Array.isArray(tree.layout.padding));

  ok("text mixed -> runs[] with 2", Array.isArray(txt.runs) && txt.runs.length === 2);
  ok("text run weight verbatim (Bold)", txt.runs[1].font.weight === "Bold");
  ok("text run underline decoration", txt.runs[1].font.decoration === "underline");
  ok("text run href", txt.runs[1].href === "https://x.com");
  ok("lineHeight unit carried (percent)", txt.font.lineHeight && txt.font.lineHeight.unit === "percent");
  ok("letterSpacing unit carried (px)", txt.font.letterSpacing && txt.font.letterSpacing.unit === "px");
  ok("paragraphSpacing", txt.font.paragraphSpacing === 8);

  // --- new READ additions (Batch: close the read gap) ---
  ok("node id captured", txt.id === "1:1");
  ok("text vertical align", txt.font.valign === "center");
  ok("text autoResize", txt.autoResize === "height");
  ok("text truncate -> ellipsis", txt.truncate === true);
  ok("text maxLines (line-clamp)", txt.maxLines === 2);

  const absNode = {
    type: "FRAME", name: "Overlay", visible: false, id: "10:5",
    x: 12.4, y: 40, layoutMode: "NONE", gridColumnSpan: 2,
    gridColumnAnchorIndex: 1, gridRowAnchorIndex: 0, gridChildHorizontalAlign: "CENTER", gridChildVerticalAlign: "MAX",
    layoutGrids: [{ pattern: "COLUMNS", sectionSize: 60, gutterSize: 20, count: 12, offset: 16, alignment: "STRETCH", visible: true }],
    annotations: [{ label: "Use spacing token md", categoryId: "cat_spacing", properties: [{ type: "width" }] }],
    devStatus: { type: "READY_FOR_DEV", description: "blocked on API" },
    absoluteBoundingBox: { x: 12, y: 40, width: 100, height: 50 },
    absoluteRenderBounds: { x: 10, y: 38, width: 104, height: 56 }, // wider due to stroke/shadow
    isMask: true, maskType: "LUMINANCE", cornerSmoothing: 0.6, targetAspectRatio: { x: 16, y: 9 },
    detachedInfo: { type: "library", componentKey: "libkey123" },
    overlayBackgroundInteraction: "CLOSE_ON_CLICK_OUTSIDE", overlayPositionType: "CENTER",
    overlayBackground: { type: "SOLID_COLOR", color: { r: 0, g: 0, b: 0, a: 0.5 } },
    fills: [
      { type: "GRADIENT_LINEAR", visible: true, gradientStops: [{ position: 0, color: { r: 1, g: 0, b: 0, a: 1 } }], gradientTransform: [[1, 0, 0], [0, 1, 0]] },
      { type: "IMAGE", visible: true, scaleMode: "FILL", imageHash: "abc123", filters: { saturation: -0.5, contrast: 0.3, exposure: 0 } },
      { type: "PATTERN", visible: true, sourceNodeId: "9:99", tileType: "RECTANGULAR", scalingFactor: 1, spacing: { x: 4, y: 4 }, horizontalAlignment: "CENTER" },
      { type: "SHADER", visible: true, id: "shader_1" },
    ],
    effects: [
      { type: "LAYER_BLUR", visible: true, radius: 8, blurType: "PROGRESSIVE", startOffset: { x: 0, y: 0 }, endOffset: { x: 0, y: 1 }, startRadius: 0 },
      { type: "NOISE", visible: true, noiseType: "MULTITONE", color: { r: 0, g: 0, b: 0, a: 1 }, density: 0.5, noiseSize: 1, opacity: 0.3, blendMode: "NORMAL" },
      { type: "GLASS", visible: true, lightIntensity: 0.5, lightAngle: 45, refraction: 0.2, depth: 4, dispersion: 0.1, radius: 8 },
    ],
    strokes: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 1 }],
    strokeWeight: 1, strokeAlign: "CENTER", strokeCap: "ROUND", strokeJoin: "ROUND",
    children: [],
  };
  const abs = await sandbox.serialize(absNode, 0, false);
  ok("hidden node kept + flagged", abs.hidden === true && abs.name === "Overlay");
  ok("absolute x/y captured", abs.x === 12.4 && abs.y === 40);
  ok("grid column span", abs.gridColumnSpan === 2);
  ok("frame layoutGrids captured", Array.isArray(abs.layoutGrids) && abs.layoutGrids[0].pattern === "columns" && abs.layoutGrids[0].count === 12);
  ok("dev-mode annotations captured", Array.isArray(abs.annotations) && abs.annotations[0].label === "Use spacing token md");
  ok("devStatus captured", abs.devStatus === "ready_for_dev");
  ok("gradient transform carried", Array.isArray(abs.fills[0].transform) && abs.fills[0].transform[0][0] === 1);
  ok("image hash carried", abs.fills[1].hash === "abc123");
  ok("image intrinsicSize via getImageByHash", abs.fills[1].intrinsicSize && abs.fills[1].intrinsicSize.w === 800 && abs.fills[1].intrinsicSize.h === 600);
  ok("stroke cap + join carried", abs.strokes.cap === "round" && abs.strokes.join === "round");

  ok("gradient stops carried", rect.fills[0].type === "gradient" && Array.isArray(rect.fills[0].stops) && rect.fills[0].stops.length === 2);
  ok("gradient stop color hex", rect.fills[0].stops[0].color === "#ff0000");
  ok("per-side stroke weights (mixed fallback)", rect.strokes.weights && rect.strokes.weights.bottom === 2);
  ok("effects ordered array len 2", Array.isArray(rect.effects) && rect.effects.length === 2);
  ok("drop_shadow discriminated", rect.effects[0].type === "drop_shadow" && rect.effects[0].offset.y === 2);
  ok("background_blur no offset", rect.effects[1].type === "background_blur" && rect.effects[1].offset === undefined);
  ok("per-corner radius (mixed fallback)", rect.radius && rect.radius.tl === 8 && rect.radius.bl === undefined);

  ok("instance main component name", btn.component === "Button");
  ok("bound token resolved to name", btn.tokens && btn.tokens.fills === "color/primary");
  ok("reactions extracted", Array.isArray(btn.reactions) && btn.reactions.length === 1);
  ok("reaction trigger", btn.reactions[0].trigger === "on_click");
  ok("reaction navigation + destination name", btn.reactions[0].actions[0].navigation === "navigate" && btn.reactions[0].actions[0].destination === "Details");
  ok("reaction transition easing (lowercased)", btn.reactions[0].actions[0].transition.easing === "custom_cubic_bezier");

  const ds = await sandbox.buildDesignSystem();
  const primary = ds.variables.find((v) => v.name === "color/primary");
  ok("variable tier semantic", primary && primary.tier === "semantic");
  ok("variable codeSyntax carried", primary && primary.codeSyntax && primary.codeSyntax.WEB === "var(--color-primary)");
  ok("variable alias re-keyed by mode name", primary && primary.values.Light && primary.values.Light.aliasOf === "blue/600");
  ok("COLOR primitive folded to hex", ds.variables.find((v) => v.name === "blue/600").values.Value === "#1a4de6");
  ok("variable hiddenFromPublishing captured", ds.variables.find((v) => v.name === "blue/600").hiddenFromPublishing === true);
  ok("variable key captured (durable identity)", ds.variables.find((v) => v.name === "blue/600").key === "varkey_blue600");
  ok("public variable has no hiddenFromPublishing flag", primary.hiddenFromPublishing === undefined);
  ok("hygiene: ALL_SCOPES flagged", ds.hygiene.some((h) => h.indexOf("ALL_SCOPES") !== -1));
  // tier regression: a raw (non-alias) variable whose only scope is the ALL_SCOPES default is a
  // primitive, not semantic — ALL_SCOPES must not be treated as a meaningful scope.
  ok("tier: raw + ALL_SCOPES-only => primitive", (ds.variables.find((v) => v.name === "misc/bad") || {}).tier === "primitive");
  ok("paint style carries color value", ds.styles.paint[0] && ds.styles.paint[0].paints && ds.styles.paint[0].paints[0].color === "#1a4de6");
  ok("grid style exported", ds.styles.grid && ds.styles.grid[0] && Array.isArray(ds.styles.grid[0].grids) && ds.styles.grid[0].grids[0].count === 12);

  // --- new READ additions (Tier 1: variable modes, prop-driven wiring, reference render, token bindings) ---
  ok("variable mode pin resolved to names", tree.variableModes && tree.variableModes.Semantic === "Dark");
  // Effective/inherited theme at the export root (resolvedVariableModes) — the fix for ancestor/page
  // pins on single-node exports. Multi-mode collection reported by name; single-mode one filtered out.
  ok("resolved (inherited) modes at root", tree.resolvedModes && tree.resolvedModes.Semantic === "Dark");
  ok("resolvedModes filters single-mode collections", tree.resolvedModes && tree.resolvedModes.Primitives === undefined);
  ok("reference screenshot path on tree", typeof tree.reference === "string" && tree.reference.indexOf("assets/") === 0 && tree.reference.indexOf("ref") !== -1);
  ok("reference asset flagged kind:reference", sel.assets.some((a) => a.kind === "reference" && a.format === "png"));
  // The asset-naming contract: the producer names the file ONCE, and every `asset:`/`reference:` path
  // in the tree is "assets/" + that name. Consumers (figma-pull, the UI download) write a.file rather
  // than re-deriving it, so a drift here would silently point every path at a file that isn't on disk.
  ok("every asset record carries its filename", sel.assets.length > 0 && sel.assets.every((a) => typeof a.file === "string" && a.file.length > 0));
  ok("asset filename has no path separators", sel.assets.every((a) => a.file.indexOf("/") === -1));
  ok("asset filename ends in its declared format", sel.assets.every((a) => a.file.endsWith("." + a.format)));
  ok(
    "tree reference path == assets/ + the record's file",
    sel.assets.some((a) => a.kind === "reference" && "assets/" + a.file === tree.reference)
  );
  ok("componentPropertyReferences -> propRefs (stripped)", txt.propRefs && txt.propRefs.characters === "Label");
  ok("instance overrides captured (empty filtered)", Array.isArray(btn.overrides) && btn.overrides.length === 1 && btn.overrides[0].fields.indexOf("characters") !== -1);
  ok("text run bound variable -> token name", txt.runs[1].tokens && txt.runs[1].tokens.fills === "color/primary");
  ok("effect bound variable -> token name", rect.effects[0].tokens && rect.effects[0].tokens.radius === "misc/bad");
  ok("transition matchLayers carried", btn.reactions[0].actions[0].transition.matchLayers === true);
  ok("transition custom cubic-bezier carried", btn.reactions[0].actions[0].transition.easing === "custom_cubic_bezier" && btn.reactions[0].actions[0].transition.cubicBezier.x1 === 0.4);
  const btnComp = ds.components.find((c) => c.name === "Button");
  ok("component description captured", btnComp && btnComp.description === "Primary action button");
  ok("INSTANCE_SWAP preferredValues captured", btnComp && btnComp.props.Icon && btnComp.props.Icon.type === "INSTANCE_SWAP" && Array.isArray(btnComp.props.Icon.preferredValues) && btnComp.props.Icon.preferredValues.length === 2);

  // --- READ additions (verified vs developers.figma.com 2026-07-23): bug fix + HIGH tier + MED ---
  // BUG FIX: progressive-blur startOffset/endOffset are Vectors {x,y}, not numbers (were dropped).
  ok("progressive blur endOffset Vector kept", abs.effects[0].blurType === "progressive" && abs.effects[0].endOffset && abs.effects[0].endOffset.y === 1);
  ok("noise effect fields", abs.effects[1].type === "noise" && abs.effects[1].noiseType === "multitone" && abs.effects[1].opacity === 0.3);
  ok("glass effect fields", abs.effects[2].type === "glass" && abs.effects[2].refraction === 0.2 && abs.effects[2].depth === 4);
  ok("image filters carried", abs.fills[1].filters && abs.fills[1].filters.saturation === -0.5 && abs.fills[1].filters.exposure === undefined);
  ok("pattern paint fields", abs.fills[2].type === "pattern" && abs.fills[2].sourceNodeId === "9:99" && abs.fills[2].tileType === "rectangular");
  ok("absolute bounding box -> box", abs.box && abs.box.w === 100 && abs.box.h === 50);
  ok("render box emitted when it differs", abs.renderBox && abs.renderBox.h === 56);
  ok("maskType (luminance) carried", abs.maskType === "luminance");
  ok("cornerSmoothing carried", abs.cornerSmoothing === 0.6);
  ok("targetAspectRatio -> ratio", abs.aspectRatio === 1.78);
  ok("detachedInfo (library key)", abs.detachedFrom && abs.detachedFrom.key === "libkey123");
  ok("overlay settings (scrim + close-on-click-outside)", abs.overlay && abs.overlay.closeOnClickOutside === true && abs.overlay.background && abs.overlay.position === "center");
  ok("annotation categoryId", Array.isArray(abs.annotations) && abs.annotations[0].categoryId === "cat_spacing");

  ok("resolved box on auto-layout root", tree.box && tree.box.w === 375);
  ok("strokesIncludedInLayout flagged", tree.strokesInLayout === true);
  ok("dev-resource links batched at root", Array.isArray(tree.devResources) && tree.devResources[0].url.indexOf("sb.example.com") !== -1);

  ok("per-run textStyle resolved", txt.runs[1].textStyle === "Heading/H1");
  ok("per-run fillStyle resolved", txt.runs[1].fillStyle === "Brand/Primary");
  ok("per-run openType features (enabled only)", Array.isArray(txt.runs[1].font.openType) && txt.runs[1].font.openType.indexOf("SMCP") !== -1 && txt.runs[1].font.openType.indexOf("LIGA") === -1);
  ok("per-run list indentation level", txt.runs[1].indent === 1);

  const acts = btn.reactions[0].actions;
  ok("NODE action preserveScroll flag", acts[0].preserveScroll === true);
  ok("SET_VARIABLE resolves variable name", acts.some((a) => a.type === "set_variable" && a.variable === "color/primary"));
  ok("SET_VARIABLE_MODE resolves collection+mode names", acts.some((a) => a.type === "set_variable_mode" && a.collection === "Semantic" && a.mode === "Dark"));
  ok("CONDITIONAL nests actions", acts.some((a) => a.type === "conditional" && Array.isArray(a.conditionalBlocks) && a.conditionalBlocks[0].actions[0].destination === "Details"));

  ok("collection defaultModeId -> mode name", ds.collections.find((c) => c.name === "Semantic").default === "Light");
  ok("variable description captured", ds.variables.find((v) => v.name === "color/primary").description === "Primary brand color");
  ok("document color profile", ds.colorProfile === "display_p3");
  ok("document file name", ds.file === "My File");
  ok("component publish key captured", btnComp.key === "compkey123");
  ok("component documentationLinks captured", Array.isArray(btnComp.docs) && btnComp.docs[0].indexOf("docs.example.com") !== -1);

  const tableNode = { type: "TABLE", name: "Data", visible: true, id: "20:0", numRows: 2, numColumns: 2,
    cellAt: (r, c) => ({ text: { characters: "r" + r + "c" + c }, fills: [{ type: "SOLID", visible: true, color: { r: 1, g: 1, b: 1 }, opacity: 1 }], rowSpan: 1, columnSpan: 1 }) };
  const tbl = await sandbox.serialize(tableNode, 0, false);
  ok("table cells traversed via cellAt", Array.isArray(tbl.tableCells) && tbl.tableCells.length === 2 && tbl.tableCells[0][0].text === "r0c0");

  // --- READ additions (2026-07-23 fresh 3-agent doc audit): bug fixes + grid fidelity + prop/style bindings ---
  // BUG FIX: textDecorationThickness/Offset are { value:number, unit } — .value IS the number (was read as .value.value → always dropped).
  ok("text decoration thickness (value+unit)", txt.runs[1].font.decorationThickness && txt.runs[1].font.decorationThickness.value === 2 && txt.runs[1].font.decorationThickness.unit === "px");
  ok("text decoration offset (value+unit)", txt.runs[1].font.decorationOffset && txt.runs[1].font.decorationOffset.value === 1);
  ok("text decoration skip-ink (only when false)", txt.runs[1].font.decorationSkipInk === false);

  // GRID fidelity: per-track sizes + child anchor index + child cell alignment.
  const gridFrame = {
    type: "FRAME", name: "Gallery", visible: true, layoutMode: "GRID", id: "30:0",
    gridColumnCount: 2, gridRowCount: 2, gridColumnGap: 8, gridRowGap: 8,
    paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
    gridColumnSizes: [{ type: "FIXED", value: 200 }, { type: "FLEX", value: 1 }, { type: "HUG" }],
    gridRowSizes: [{ type: "FLEX", value: 1 }, { type: "FLEX", value: 1 }],
    children: [],
  };
  const gf = await sandbox.serialize(gridFrame, 0, false);
  ok("grid track sizes (fixed px + flex fr)", gf.layout.display === "grid" && Array.isArray(gf.layout.columnSizes) && gf.layout.columnSizes[0].type === "fixed" && gf.layout.columnSizes[0].value === 200 && gf.layout.columnSizes[1].type === "flex");
  ok("grid HUG track (value-less) handled", gf.layout.columnSizes[2].type === "hug" && gf.layout.columnSizes[2].value === undefined);
  ok("grid child anchor index (start cell)", abs.gridColumnStart === 1 && abs.gridRowStart === 0);
  ok("grid child cell align (justify/align-self)", abs.gridJustifySelf === "center" && abs.gridAlignSelf === "end");

  ok("shader paint id captured", abs.fills[3] && abs.fills[3].type === "shader" && abs.fills[3].shaderId === "shader_1");
  ok("devStatus free-text note captured", abs.devStatusNote === "blocked on API");
  ok("instance component-prop variable binding -> propTokens", btn.propTokens && btn.propTokens.Label === "color/primary");

  const bodyStyle = ds.styles.text.find((s) => s.name === "Body/Regular");
  ok("text style leadingTrim + listSpacing + paragraphIndent", bodyStyle && bodyStyle.leadingTrim === "cap_height" && bodyStyle.listSpacing === 6 && bodyStyle.paragraphIndent === 4);
  ok("text style variable binding (fontSize -> token)", bodyStyle && bodyStyle.tokens && bodyStyle.tokens.fontSize === "misc/bad");

  // --- Tier-1 read additions ---
  // inferredVariables (Figma's token suggestions for unbound fields) is ALWAYS on — the root has no
  // explicit fills binding, so the suggestion surfaces.
  ok("inferred token suggestion (unbound field)", tree.inferredTokens && typeof tree.inferredTokens.fills === "string");
  // css / measurements / pluginData are OPT-IN — off by default.
  // css now AUTO-ENABLES for a small single selection (the "inspect one component" path). scrollFrame
  // is tiny (4 nodes), so the CSS oracle comes back without an explicit opt-in.
  ok("css auto-on for small single selection", tree.css && tree.css.display === "flex" && tree.css.padding === "16px");
  ok("pluginData still off by default (not auto-enabled)", tree.pluginData === undefined);
  const sel2 = await sandbox.collectSelection({ css: true, measurements: true, pluginData: true });
  const tree2 = sel2.screen.nodes[0];
  ok("getCSSAsync -> css oracle (opt-in)", tree2.css && tree2.css.display === "flex" && tree2.css.padding === "16px");
  ok("own-scope plugin data captured (opt-in)", tree2.pluginData && tree2.pluginData.codeConnect === "Button/Primary");
  ok("measurements captured via sync getMeasurements (opt-in)", Array.isArray(sel2.screen.measurements) && sel2.screen.measurements[0].text === "16" && sel2.screen.measurements[0].start.side === "LEFT");
  ok("motion off by default", tree.motion === undefined);
  const sel3 = await sandbox.collectSelection({ motion: true });
  const m3 = sel3.screen.nodes[0].motion;
  ok("motion timelines captured (opt-in)", m3 && Array.isArray(m3.timelines) && m3.timelines[0].duration === 0.5);
  ok("motion keyframe track: base + keyframes + values", m3 && m3.manualTracks.TRANSLATION_X && m3.manualTracks.TRANSLATION_X.base === 0 && m3.manualTracks.TRANSLATION_X.keyframes[1].value === 100);
  ok("motion keyframe custom cubic-bezier easing carried", m3 && m3.manualTracks.TRANSLATION_X.keyframes[1].easing.cubicBezier.x1 === 0.4);
  ok("motion applied animation style captured", m3 && m3.styles[0].name === "Fade In" && m3.styles[0].duration === 0.3);

  // --- sharedData (cross-plugin, e.g. Tokens Studio applied tokens) is OPT-IN ---
  ok("sharedData off by default", tree.sharedData === undefined);
  const sel4 = await sandbox.collectSelection({ sharedData: true });
  const tree4 = sel4.screen.nodes[0];
  ok("sharedData: Tokens Studio applied tokens captured (opt-in)", tree4.sharedData && tree4.sharedData.tokens && tree4.sharedData.tokens.fill === "color.primary" && tree4.sharedData.tokens.borderRadius === "radius.md");

  // --- parametric shape intent: ellipse arc/donut, star/polygon points, boolean op ---
  const donut = await sandbox.serialize({ type: "ELLIPSE", name: "Ring", visible: true, id: "e:1", arcData: { startingAngle: 0, endingAngle: Math.PI * 1.5, innerRadius: 0.6 } }, 0, false);
  ok("ellipse arc/donut captured (start/end/innerRadius)", donut.arc && donut.arc.end === 4.71 && donut.arc.innerRadius === 0.6);
  const fullEllipse = await sandbox.serialize({ type: "ELLIPSE", name: "Dot", visible: true, id: "e:2", arcData: { startingAngle: 0, endingAngle: Math.PI * 2, innerRadius: 0 } }, 0, false);
  ok("full ellipse emits no arc (noise-free)", fullEllipse.arc === undefined);
  const star = await sandbox.serialize({ type: "STAR", name: "Star", visible: true, id: "st:1", pointCount: 5, innerRadius: 0.4 }, 0, false);
  ok("star pointCount + innerRadius captured", star.shape && star.shape.points === 5 && star.shape.innerRadius === 0.4);
  const poly = await sandbox.serialize({ type: "POLYGON", name: "Tri", visible: true, id: "pg:1", pointCount: 3 }, 0, false);
  ok("polygon pointCount captured", poly.shape && poly.shape.points === 3);
  const boolOp = await sandbox.serialize({ type: "BOOLEAN_OPERATION", name: "Cut", visible: true, id: "bo:1", booleanOperation: "SUBTRACT", children: [] }, 0, false);
  ok("boolean operation kind captured (lowercased)", boolOp.booleanOp === "subtract");

  // --- FIX: image-BACKED container (image fill + children) must NOT flatten to a PNG ---
  // A hero/cover-card/banner uses an image as its background but has real children (text, buttons).
  // Flattening it to a single raster silently dropped all of that; the guard now recurses instead.
  const heroFrame = {
    type: "FRAME", name: "Hero", visible: true, id: "hero:0", layoutMode: "VERTICAL",
    width: 375, height: 200, itemSpacing: 8, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
    fills: [{ type: "IMAGE", visible: true, scaleMode: "FILL", imageHash: "abc123" }],
    exportAsync: async () => new Uint8Array([137, 80, 78, 71]), // would succeed if (wrongly) flattened
    children: [{ type: "TEXT", name: "Title", visible: true, id: "hero:1", characters: "Welcome",
      fontName: { family: "Inter", style: "Bold" }, fontSize: 20, width: 200, getStyledTextSegments: () => [] }],
  };
  const hero = await sandbox.serialize(heroFrame, 0, false);
  ok("image-backed container NOT flattened (no asset)", hero.asset === undefined);
  ok("image-backed container keeps children (text survives)", Array.isArray(hero.children) && hero.children.length === 1 && hero.children[0].text === "Welcome");
  ok("image-backed container keeps image as background fill", Array.isArray(hero.fills) && hero.fills.some((f) => f.hash === "abc123"));
  // A childless image node (a plain image rectangle) still rasterizes to a PNG asset as before.
  const imageRect = { type: "RECTANGLE", name: "Photo", visible: true, id: "img:1",
    fills: [{ type: "IMAGE", visible: true, scaleMode: "FILL", imageHash: "abc123" }],
    exportAsync: async () => new Uint8Array([137, 80, 78, 71]) };
  const imgLeaf = await sandbox.serialize(imageRect, 0, false);
  ok("childless image node still exported as PNG asset", typeof imgLeaf.asset === "string" && imgLeaf.asset.indexOf(".png") !== -1);

  // --- FIX: hasMissingFont -> flag + warning so codegen knows the recorded font may be substituted ---
  const legacyText = { type: "TEXT", name: "Legacy", visible: true, id: "t:missing", characters: "x", width: 50,
    fontName: { family: "Proxima Nova", style: "Regular" }, fontSize: 12, hasMissingFont: true, getStyledTextSegments: () => [] };
  const legacy = await sandbox.serialize(legacyText, 0, false);
  ok("missing font flagged on text node", legacy.missingFont === true);

  // --- FIX: css auto-on is bounded — a LARGE single selection keeps the per-node oracle OFF ---
  const bigKids = [];
  for (let i = 0; i < 70; i++) bigKids.push({ type: "RECTANGLE", name: "r" + i, visible: true, id: "big:" + (i + 1), fills: [] });
  const bigFrame = { type: "FRAME", name: "Big", visible: true, id: "big:0", layoutMode: "NONE",
    width: 100, height: 100, getCSSAsync: async () => ({ display: "block" }), children: bigKids };
  sandbox.figma.currentPage.selection = [bigFrame];
  const selBig = await sandbox.collectSelection();
  ok("css stays OFF for large single selection (>cap)", selBig.screen.nodes[0].css === undefined);
  // explicit css:false always wins, even on a small tree.
  sandbox.figma.currentPage.selection = [scrollFrame];
  const selNoCss = await sandbox.collectSelection({ css: false });
  ok("explicit css:false wins over auto-enable", selNoCss.screen.nodes[0].css === undefined);

  // ---- LIBRARY (remote) variables ----
  // getLocalVariablesAsync returns ONLY this file's variables, but node bindings resolve remote ones
  // by id. A file whose design system lives in a published library would otherwise emit screens full
  // of token names with no matching definitions, and the DTCG/CSS emitters would drop exactly the
  // tokens the screens use. The dump must pull referenced library variables in, flagged remote:true.
  const LIB_COLLECTION = { id: "c_lib", name: "Library/Brand", modes: [{ modeId: "m_l", name: "Light" }, { modeId: "m_d", name: "Dark" }], defaultModeId: "m_l" };
  const LIB_VAR = { id: "v_lib", name: "brand/accent", resolvedType: "COLOR", variableCollectionId: "c_lib",
    scopes: ["FRAME_FILL"], codeSyntax: {}, remote: true, key: "libkey_accent",
    valuesByMode: { m_l: { r: 1, g: 0.4, b: 0, a: 1 }, m_d: { r: 1, g: 0.6, b: 0.2, a: 1 } } };
  const prevGetVar = sandbox.figma.variables.getVariableByIdAsync;
  const prevGetColl = sandbox.figma.variables.getVariableCollectionByIdAsync;
  // Resolvable by id (as the real API does for consumed library variables) but absent from the LOCAL list.
  sandbox.figma.variables.getVariableByIdAsync = async (id) => (id === "v_lib" ? LIB_VAR : prevGetVar(id));
  sandbox.figma.variables.getVariableCollectionByIdAsync = async (id) => (id === "c_lib" ? LIB_COLLECTION : prevGetColl(id));

  const libNode = { type: "FRAME", name: "LibCard", visible: true, id: "9:1", width: 100, height: 40,
    fills: [{ type: "SOLID", visible: true, color: { r: 1, g: 0.4, b: 0 }, opacity: 1 }],
    boundVariables: { fills: [{ type: "VARIABLE_ALIAS", id: "v_lib" }] } };
  sandbox.figma.currentPage.selection = [libNode];
  const libSel = await sandbox.collectSelection({ css: false });
  const libDump = libSel.variables.variables.find((v) => v.name === "brand/accent");
  ok("library var referenced by a node IS included in the dump", !!libDump);
  ok("library var flagged remote:true", libDump && libDump.remote === true);
  ok("library var values keyed by readable mode names", libDump && libDump.values && libDump.values.Light === "#ff6600");
  ok("library var's collection is emitted (default mode for :root)", libSel.variables.collections.some((c) => c.name === "Library/Brand" && c.default === "Light"));
  ok("library pull is reported in hygiene (never silent)", libSel.variables.hygiene.some((h) => /published LIBRARY/.test(h)));
  ok("node still resolves the library token by name", libSel.screen.nodes[0].tokens && libSel.screen.nodes[0].tokens.fills === "brand/accent");
  // An UNreferenced library variable must NOT be dragged in — the dump stays scoped to what's used.
  ok("unreferenced library vars are not pulled in", !libSel.variables.variables.some((v) => v.name === "unused/never"));

  // Alias hygiene must distinguish "points at a library variable we resolved" from "genuinely
  // dangling". The check keyed off the LOCAL id set alone, so every legitimate library alias was
  // reported as broken — on a library-consuming file that is the whole hygiene list, and real
  // breakage hides among the noise.
  VARS.v_aliases_lib = { id: "v_aliases_lib", name: "color/brand", resolvedType: "COLOR", variableCollectionId: "c_sem",
    scopes: ["FRAME_FILL"], codeSyntax: {}, remote: false, valuesByMode: { m_light: { type: "VARIABLE_ALIAS", id: "v_lib" } } };
  VARS.v_dangling = { id: "v_dangling", name: "color/ghost", resolvedType: "COLOR", variableCollectionId: "c_sem",
    scopes: ["FRAME_FILL"], codeSyntax: {}, remote: false, valuesByMode: { m_light: { type: "VARIABLE_ALIAS", id: "v_deleted" } } };
  sandbox.figma.currentPage.selection = [libNode];
  const aliasSel = await sandbox.collectSelection({ css: false });
  const aliasHyg = aliasSel.variables.hygiene;
  // Matched loosely on purpose: the old wording was "broken/remote alias in '…'", so a regex tied to
  // the new phrasing would pass against the old behaviour too and prove nothing.
  ok("alias to a RESOLVED library variable is not called broken", !aliasHyg.some((h) => /broken.*'color\/brand'/.test(h)));
  ok("alias to a resolved library var still resolves to its name", aliasSel.variables.variables.some((v) => v.name === "color/brand" && v.values.Light && v.values.Light.aliasOf === "brand/accent"));
  ok("a genuinely dangling alias IS still reported", aliasHyg.some((h) => /broken alias in 'color\/ghost'/.test(h)));
  ok("dangling-alias warning names the unresolved id", aliasHyg.some((h) => /v_deleted/.test(h)));
  delete VARS.v_aliases_lib;
  delete VARS.v_dangling;
  sandbox.figma.variables.getVariableByIdAsync = prevGetVar;
  sandbox.figma.variables.getVariableCollectionByIdAsync = prevGetColl;
  sandbox.figma.currentPage.selection = [scrollFrame];

  // ---- source-image container format (magic bytes, not a hardcoded ".img") ----
  const prevGetImage = sandbox.figma.getImageByHash;
  const magicRect = (hash) => ({ type: "RECTANGLE", name: "Photo", visible: true, id: "m:" + hash, width: 10, height: 10,
    fills: [{ type: "IMAGE", visible: true, scaleMode: "FILL", imageHash: hash }], exportAsync: async () => new Uint8Array([137, 80, 78, 71]) });
  const MAGIC = {
    png: [0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10],
    jpg: [0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46],
    gif: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 1],
    webp: [0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
  };
  for (const [fmt, bytes] of Object.entries(MAGIC)) {
    sandbox.figma.getImageByHash = (h) => (h === "h_" + fmt ? { getSizeAsync: async () => ({ width: 8, height: 8 }), getBytesAsync: async () => new Uint8Array(bytes) } : null);
    sandbox.figma.currentPage.selection = [magicRect("h_" + fmt)];
    const r = await sandbox.collectSelection({ css: false });
    ok(`source image format detected from magic bytes: ${fmt}`, r.assets.some((a) => a.kind === "source" && a.format === fmt));
  }
  sandbox.figma.getImageByHash = prevGetImage;
  sandbox.figma.currentPage.selection = [scrollFrame];

  // ---- an unreadable page degrades, it does not abort ----
  // PageNode.children THROWS on a page that isn't current and wasn't loaded (dynamic-page access).
  // A failed loadAllPagesAsync used to warn "may miss pages" and then abort the whole export here.
  const goodPage = sandbox.figma.root.children[0];
  const badPage = { name: "Locked Page", get children() { throw new Error("page not loaded"); },
    findAllWithCriteria: () => { throw new Error("page not loaded"); } };
  const prevRootChildren = sandbox.figma.root.children;
  sandbox.figma.root.children = [goodPage, badPage];
  const prevLoadAll = sandbox.figma.loadAllPagesAsync;
  sandbox.figma.loadAllPagesAsync = async () => { throw new Error("load failed"); };
  let fullErr = null, full = null;
  try { full = await sandbox.collectFull({ allPages: true, css: false }); } catch (e) { fullErr = e; }
  ok("unreadable page does NOT abort the export", fullErr === null && !!full);
  ok("readable pages still exported alongside the bad one", full && full.screensDoc.screens.length > 0);
  ok("unreadable page is warned, not silently dropped", full && full.screensDoc.manifest.warnings.some((w) => /Locked Page.*could not be read/.test(w)));
  ok("untraversable page warned in the component catalog too", full && full.screensDoc.manifest.warnings.some((w) => /component catalog.*Locked Page/.test(w)));
  ok("loadAllPagesAsync failure is itself reported", full && full.screensDoc.manifest.warnings.some((w) => /loadAllPagesAsync failed/.test(w)));
  sandbox.figma.root.children = prevRootChildren;
  sandbox.figma.loadAllPagesAsync = prevLoadAll;

  // ---- WRITE plane (writes.ts) ----
  // Previously untested entirely. The two contracts that matter to an agent driving figma_write:
  // a write that didn't happen must NOT report success, and a failed batch must still surface what
  // it already applied (Figma gives no transaction, so the earlier ops are committed for good).
  const created = [];
  sandbox.figma.createFrame = () => { const f = { id: "new:frame", type: "FRAME", name: "", fills: [], resize() {}, appendChild() {} }; created.push(f); return f; };
  sandbox.figma.createText = () => { const t = { id: "new:text", type: "TEXT", characters: "", fills: [], fontName: { family: "Inter", style: "Regular" } }; created.push(t); return t; };
  sandbox.figma.loadFontAsync = async () => {};
  sandbox.figma.currentPage.appendChild = () => {};

  const textTarget = { id: "t:1", type: "TEXT", name: "Label", characters: "old", fontName: { family: "Inter", style: "Regular" }, getRangeAllFontNames: () => [{ family: "Inter", style: "Regular" }] };
  const rectTarget = { id: "r:1", type: "RECTANGLE", name: "Box", fills: [] };
  const groupTarget = { id: "g:1", type: "GROUP", name: "Wrap" }; // no `fills`
  const prevGetNode = sandbox.figma.getNodeByIdAsync;
  sandbox.figma.getNodeByIdAsync = async (id) => ({ "t:1": textTarget, "r:1": rectTarget, "g:1": groupTarget }[id] || prevGetNode(id));

  const wOk = await sandbox.applyWrites([{ op: "createFrame", name: "Card", fill: "#ff0000" }, { op: "setText", nodeId: "t:1", text: "new" }]);
  ok("write: successful batch -> ok:true + applied ids", wOk.ok === true && wOk.applied.length === 2 && wOk.applied[0].id === "new:frame");
  ok("write: setText actually mutated the node", textTarget.characters === "new");
  ok("write: setFill applies a parsed hex", (await sandbox.applyWrites([{ op: "setFill", nodeId: "r:1", color: "#00ff00" }])).ok === true && Math.round(rectTarget.fills[0].color.g) === 1);

  // A missing node must FAIL, not silently report {id} — the old behaviour told the agent it worked.
  const wMissing = await sandbox.applyWrites([{ op: "setFill", nodeId: "nope:1", color: "#fff" }]);
  ok("write: setFill on a missing node fails (not silent success)", wMissing.ok === false && /no node with id/.test(wMissing.error));
  const wWrongType = await sandbox.applyWrites([{ op: "setText", nodeId: "r:1", text: "x" }]);
  ok("write: setText on a non-TEXT node fails", wWrongType.ok === false && /not TEXT/.test(wWrongType.error));
  const wNoFills = await sandbox.applyWrites([{ op: "setFill", nodeId: "g:1", color: "#fff" }]);
  ok("write: setFill on a node without fills fails", wNoFills.ok === false && /has no fills/.test(wNoFills.error));

  // Partial failure: ops 0-1 are already committed, so their ids must come back with the error.
  const wPartial = await sandbox.applyWrites([
    { op: "createFrame", name: "A" },
    { op: "createText", text: "B" },
    { op: "setFill", nodeId: "missing:9", color: "#fff" },
    { op: "createFrame", name: "never" },
  ]);
  ok("write: partial failure reports ok:false", wPartial.ok === false);
  ok("write: partial failure keeps the applied prefix", wPartial.applied.length === 2);
  ok("write: partial failure reports the failing index + op", wPartial.failedAt === 2 && wPartial.failedOp === "setFill");
  ok("write: ops after the failure are not applied", created.filter((n) => n.name === "never").length === 0);
  ok("write: unknown op is rejected", (await sandbox.applyWrites([{ op: "nope" }])).error.indexOf("unknown write op") !== -1);
  ok("write: empty/omitted batch is a no-op success", (await sandbox.applyWrites(undefined)).ok === true);

  // ---- parentId (was entirely uncovered, which is how the silent-reparent bug survived) ----
  // The contract mirrors setFill/setText: if the node did NOT land where it was asked to go, the op
  // must fail. The old code fell back to currentPage and still returned {id}, so an agent composing a
  // tree got ok:true and a flat pile of nodes on the canvas.
  const parentKids = [];
  const containerTarget = { id: "c:1", type: "FRAME", name: "Root", appendChild: (n) => parentKids.push(n) };
  const pageLoads = [];
  const pageTarget = { id: "pg:1", type: "PAGE", name: "Page 2", loadAsync: async () => pageLoads.push("pg:1"), appendChild: (n) => parentKids.push(n) };
  const leafTarget = { id: "lf:1", type: "TEXT", name: "Leaf" }; // no appendChild — cannot hold children
  sandbox.figma.getNodeByIdAsync = async (id) =>
    ({ "t:1": textTarget, "r:1": rectTarget, "g:1": groupTarget, "c:1": containerTarget, "pg:1": pageTarget, "lf:1": leafTarget }[id] || null);

  const pOk = await sandbox.applyWrites([{ op: "createFrame", name: "Child", parentId: "c:1" }]);
  ok("write: valid parentId -> ok:true and the node lands on that parent", pOk.ok === true && parentKids.length === 1 && parentKids[0].id === "new:frame");
  ok("write: valid parentId did NOT fall through to currentPage", parentKids[0] === created[created.length - 1]);

  const beforeOrphan = created.length;
  const pMissing = await sandbox.applyWrites([{ op: "createFrame", name: "Orphan", parentId: "gone:99" }]);
  ok("write: unresolvable parentId fails (not silent reparent)", pMissing.ok === false && /not found/.test(pMissing.error));
  ok("write: failed parent leaves NO orphan node behind", created.length === beforeOrphan);
  ok("write: failed parent reports nothing as applied", pMissing.applied.length === 0);

  const pLeaf = await sandbox.applyWrites([{ op: "createFrame", parentId: "lf:1" }]);
  ok("write: parent that cannot have children fails", pLeaf.ok === false && /cannot have children/.test(pLeaf.error));

  const pText = await sandbox.applyWrites([{ op: "createText", text: "hi", parentId: "gone:99" }]);
  ok("write: createText honours parentId failure too", pText.ok === false && /not found/.test(pText.error));

  // documentAccess:"dynamic-page" — appendChild on a PageNode throws unless the page is loaded first.
  const pPage = await sandbox.applyWrites([{ op: "createFrame", parentId: "pg:1" }]);
  ok("write: PAGE parent is loadAsync'd before appendChild", pPage.ok === true && pageLoads.length === 1);

  sandbox.figma.getNodeByIdAsync = prevGetNode;

  report();
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
