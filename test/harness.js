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
  // [AUDIT-6b] inferredVariables USED to be emitted as `inferredTokens` for every unbound field. It
  // measured 20.5% of a real payload (2,151 occurrences) with zero consumers, and the matches are
  // value-coincidence. The mock still SUPPLIES inferredVariables on scrollFrame, so this pins that the
  // extractor ignores it rather than that the fixture stopped providing it.
  ok("[AUDIT-6b] inferredTokens is no longer emitted", tree.inferredTokens === undefined);
  ok("[AUDIT-6b] and no inferred* key leaks under another name", !Object.keys(tree).some((k) => /^inferred/.test(k)));
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

  // --- [RD-noassets] skipAssets: the per-node exportAsync pass is the dominant cost on a real file
  // (it hung a ~1000-node page past 300s and outgrew the bridge's frame limit on --all-pages), yet it
  // was the only O(nodes) read with no opt-out — getCSSAsync, its cheaper twin, has had one all along.
  // Skipping must be LOUD: a missing `asset` is otherwise indistinguishable from "no graphic here".
  // Driven through the PUBLIC collect API (not by poking runOpts), so the test exercises the same
  // path figma-pull --no-assets uses rather than an internal it could drift from.
  let exportCalls = 0;
  const countingRect = { type: "RECTANGLE", name: "Photo2", visible: true, id: "img:2", width: 40, height: 40,
    fills: [{ type: "IMAGE", visible: true, scaleMode: "FILL", imageHash: "abc123" }],
    exportAsync: async () => { exportCalls++; return new Uint8Array([137, 80, 78, 71]); } };
  const prevSelection = sandbox.figma.currentPage.selection;
  sandbox.figma.currentPage.selection = [countingRect];

  const skipRun = await sandbox.collectSelection({ skipAssets: true });
  const skipCalls = exportCalls;
  const skipNode = skipRun.screen.nodes[0];
  ok("[RD-noassets] no asset is emitted when skipping", skipNode.asset === undefined);
  // The per-ROOT reference screenshot is deliberately still taken: it's one render per exported root
  // (the self-correction image), not the O(nodes) pass that caused the hang. So the contract is
  // "no PER-NODE asset export", not "no exportAsync at all" — pin that precisely.
  ok("[RD-noassets] the per-node asset export does not run (only the 1 reference render)", skipCalls <= 1);
  ok("[RD-noassets] the reference screenshot IS still produced", typeof skipRun.screen.nodes[0].reference === "string" || skipRun.assets.some((a) => a.kind === "reference"));
  ok("[RD-noassets] the skip is COUNTED, not silent", skipRun.screen.manifest.assetsSkipped >= 1);
  ok("[RD-noassets] and warned — a missing `asset` must not read as 'no graphic here'",
    skipRun.screen.manifest.warnings.some((w) => /--no-assets/.test(w) && /skipped/.test(w)));

  const normalRun = await sandbox.collectSelection({});
  ok("[RD-noassets] DEFAULT is unchanged — the asset still exports",
    typeof normalRun.screen.nodes[0].asset === "string");

  // --- [RD-noassets-shape] a FLATTENED CONTAINER must stay flattened when skipping ---
  // The case above is a childless RECTANGLE — a leaf either way, so it cannot catch the real bug:
  // an `iconLike` CONTAINER (icon-named, <=96px, no TEXT descendant) is normally flattened to ONE
  // svg and serialized as a leaf. When --no-assets returned `undefined` for it, serialize recursed
  // into its vector guts instead, so the flag QUIETLY CHANGED THE TREE it promises not to touch —
  // measured 41 -> 161 nodes and 4.3x the JSON on a 40-icon sheet, i.e. the flag INFLATED the very
  // payload it exists to shrink (and the skip counter counted those child vectors, not the exports).
  // Several vector children, and the icon nested one level down: with a single child the two trees
  // differ by too little for the node-count/size assertions below to actually discriminate.
  const iconVec = (i) => ({ type: "VECTOR", name: "path" + i, visible: true, id: "ic:v" + i, width: 16, height: 16,
    fills: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 1 }],
    exportAsync: async () => "<svg/>" });
  const iconFrame = { type: "FRAME", name: "icon/home", visible: true, id: "ic:1", width: 24, height: 24,
    children: [iconVec(1), iconVec(2), iconVec(3)], findOne: () => null, exportAsync: async () => "<svg/>" };
  const iconSheet = { type: "FRAME", name: "Sheet", visible: true, id: "ic:0", width: 100, height: 100,
    children: [iconFrame], exportAsync: async () => new Uint8Array([137, 80, 78, 71]) };
  sandbox.figma.currentPage.selection = [iconSheet];
  const iconNormal = await sandbox.collectSelection({});
  const iconSkipped = await sandbox.collectSelection({ skipAssets: true });
  const nNode = iconNormal.screen.nodes[0].children[0], sNode = iconSkipped.screen.nodes[0].children[0];

  ok("[RD-noassets-shape] normally the icon container flattens to one asset leaf",
    typeof nNode.asset === "string" && !nNode.children);
  ok("[RD-noassets-shape] --no-assets keeps it a LEAF — no descent into the icon's vectors",
    sNode.asset === undefined && !sNode.children);
  ok("[RD-noassets-shape] the node count is IDENTICAL to the full export (structure unaffected)",
    iconSkipped.screen.manifest.nodes === iconNormal.screen.manifest.nodes);
  ok("[RD-noassets-shape] and the tree is no larger than the full export's",
    JSON.stringify(iconSkipped.screen.nodes).length <= JSON.stringify(iconNormal.screen.nodes).length);
  // Per-node, not just a manifest total: a consumer must be able to tell "graphic omitted here" from
  // "this node has no graphic" at the node it cares about.
  ok("[RD-noassets-shape] the omission is marked ON the node, not only counted",
    sNode.assetSkipped === true);
  ok("[RD-noassets-shape] the counter matches the exports that would REALLY have happened (1, not 2)",
    iconSkipped.screen.manifest.assetsSkipped === 1);
  ok("[RD-noassets-shape] no assetSkipped flag leaks into a normal run", nNode.assetSkipped === undefined);

  ok("[RD-noassets] and exportAsync did run when not skipping", exportCalls > skipCalls);
  ok("[RD-noassets] a normal run reports assetsSkipped: 0", normalRun.screen.manifest.assetsSkipped === 0);
  sandbox.figma.currentPage.selection = prevSelection;

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

  // ---- [RD-alias] library variable reached ONLY through another variable's ALIAS ----
  // Regression from the first real export (2026-07-28). varName.ids() is a SNAPSHOT of ids referenced
  // by NODES; a library primitive reached only via another variable's alias entered the memo cache
  // LATER (when values were resolved), so its NAME resolved — `aliasOf` showed a friendly name —
  // while the variable itself was dropped from variables[]. Downstream that is a dangling reference
  // (theming silently breaks) PLUS a false "broken alias … could not be resolved" hygiene line
  // accusing a healthy file. On the real file: 4 dangling refs, 0 genuinely broken.
  // Alias chains are multi-level, so this pins a TWO-hop chain that a single extra pass would miss:
  //   node -> v_semlib (local) -> v_libmid (library) -> v_libprim (library)
  const LIB_MID = { id: "v_libmid", name: "brand/mid", resolvedType: "COLOR", variableCollectionId: "c_lib",
    scopes: [], codeSyntax: {}, remote: true,
    valuesByMode: { m_l: { type: "VARIABLE_ALIAS", id: "v_libprim" }, m_d: { type: "VARIABLE_ALIAS", id: "v_libprim" } } };
  const LIB_PRIM = { id: "v_libprim", name: "brand/gray-100", resolvedType: "COLOR", variableCollectionId: "c_lib",
    scopes: [], codeSyntax: {}, remote: true,
    valuesByMode: { m_l: { r: 0.9, g: 0.9, b: 0.9, a: 1 }, m_d: { r: 0.2, g: 0.2, b: 0.2, a: 1 } } };
  const EXTRA = { v_libmid: LIB_MID, v_libprim: LIB_PRIM, v_lib: LIB_VAR };
  sandbox.figma.variables.getVariableByIdAsync = async (id) => EXTRA[id] || prevGetVar(id);
  // A LOCAL semantic token whose value aliases the library chain — neither library var is node-bound.
  VARS.v_semlib = { id: "v_semlib", name: "semantic/surface", resolvedType: "COLOR", variableCollectionId: "c_sem",
    scopes: ["FRAME_FILL"], codeSyntax: {}, remote: false,
    valuesByMode: { m_light: { type: "VARIABLE_ALIAS", id: "v_libmid" }, m_dark: { type: "VARIABLE_ALIAS", id: "v_libmid" } } };

  const chainNode = { type: "FRAME", name: "ChainCard", visible: true, id: "9:2", width: 100, height: 40,
    fills: [{ type: "SOLID", visible: true, color: { r: 0.9, g: 0.9, b: 0.9 }, opacity: 1 }],
    boundVariables: { fills: [{ type: "VARIABLE_ALIAS", id: "v_semlib" }] } };
  sandbox.figma.currentPage.selection = [chainNode];
  const chainSel = await sandbox.collectSelection({ css: false });
  const cv = (n) => chainSel.variables.variables.find((v) => v.name === n);

  ok("[RD-alias] hop 1 (aliased library var) is included", !!cv("brand/mid"));
  ok("[RD-alias] hop 2 (alias-of-an-alias) is ALSO included — fixed point, not one extra pass", !!cv("brand/gray-100"));
  ok("[RD-alias] the pulled-in primitive carries its real VALUE, not just a name",
    !!cv("brand/gray-100") && cv("brand/gray-100").values.Light === "#e6e6e6");
  ok("[RD-alias] the intermediate still reads as an alias", !!cv("brand/mid") && cv("brand/mid").values.Light &&
    cv("brand/mid").values.Light.aliasOf === "brand/gray-100");
  // The false-accusation half: every alias target resolves, so hygiene must NOT claim otherwise.
  ok("[RD-alias] no FALSE 'broken alias' hygiene line for a chain that fully resolves",
    !chainSel.variables.hygiene.some((h) => /broken alias/.test(h)));
  // And the whole point: no emitted alias may point at a name that isn't in the dump.
  ok("[RD-alias] no alias dangles — every aliasOf target exists in variables[]", (() => {
    const names = new Set(chainSel.variables.variables.map((v) => v.name));
    for (const v of chainSel.variables.variables) {
      for (const val of Object.values(v.values || {})) {
        if (val && typeof val === "object" && val.aliasOf && !names.has(val.aliasOf)) return false;
      }
    }
    return true;
  })());
  // Drop only the local seed. The id resolver STAYS on the EXTRA-aware handler — it is a superset of
  // the v_lib override above, and later alias-hygiene tests still need v_lib to resolve.
  delete VARS.v_semlib;

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
  ok("readable pages still exported alongside the bad one", full && full.layersDoc.layers.length > 0);
  ok("unreadable page is warned, not silently dropped", full && full.layersDoc.manifest.warnings.some((w) => /Locked Page.*could not be read/.test(w)));
  ok("untraversable page warned in the component catalog too", full && full.layersDoc.manifest.warnings.some((w) => /component catalog.*Locked Page/.test(w)));
  ok("loadAllPagesAsync failure is itself reported", full && full.layersDoc.manifest.warnings.some((w) => /loadAllPagesAsync failed/.test(w)));
  // ---- [LIST] listPages: the cheap structural index ----
  // Reuses the unreadable-page fixture above (root.children is still [goodPage, badPage] and
  // loadAllPagesAsync still throws) — the case where an index is most tempting to get wrong.
  const listBad = await sandbox.listPages({});
  const badEntry = listBad.pages.find((p) => p.name === "Locked Page");
  ok("[LIST] an unreadable page is still LISTED", !!badEntry);
  // The whole trap: an index that shows a readable-looking page with no frames reads as "this page is
  // empty" and the caller stops looking. It must be distinguishable.
  ok("[LIST] an unreadable page is flagged, not shown as empty", !!badEntry && badEntry.unreadable === true && badEntry.frames === undefined);
  ok("[LIST] and the reason is warned", listBad.manifest.warnings.some((w) => /Locked Page.*could not be read/.test(w)));
  ok("[LIST] a readable page still lists its frames alongside the bad one",
    Array.isArray(listBad.pages.find((p) => p.name === "Page 1").frames));
  sandbox.figma.root.children = prevRootChildren;
  sandbox.figma.loadAllPagesAsync = prevLoadAll;

  const listed = await sandbox.listPages({});
  ok("[LIST] reports the file name", listed.file === "My File");
  ok("[LIST] lists every page", listed.pages.length === sandbox.figma.root.children.length);
  ok("[LIST] marks the current page", listed.pages.some((p) => p.current === true));
  const lf = listed.pages[0].frames;
  ok("[LIST] top-level frames carry id/name/type", Array.isArray(lf) && lf.length > 0 && lf.every((f) => f.id && f.name && f.type));
  ok("[LIST] frames carry size", lf.every((f) => typeof f.w === "number" && typeof f.h === "number"));
  // The POINT of the op: it is an index, not an export. No recursion, no serialization, no assets.
  ok("[LIST] frames do NOT recurse (no children)", lf.every((f) => f.children === undefined));
  ok("[LIST] frames carry no serialized detail (no fills/layout/tokens)",
    lf.every((f) => f.fills === undefined && f.layout === undefined && f.tokens === undefined));
  ok("[LIST] no assets are produced", listed.assets === undefined);
  ok("[LIST] manifest counts pages and frames", listed.manifest.pages === listed.pages.length && typeof listed.manifest.frames === "number");
  // depth 1 = page names only, and must NOT pay for loading pages.
  // depth 2 must load — but PER PAGE, never with the blanket loadAllPagesAsync that the Figma docs
  // say to avoid "unless absolutely necessary". Same total work when every page is walked, but paid
  // incrementally, isolated per page, and without leaving the whole document resident for the session.
  let loadCalls = 0;
  let perPageLoads = 0;
  const prevLoad2 = sandbox.figma.loadAllPagesAsync;
  sandbox.figma.loadAllPagesAsync = async () => { loadCalls++; };
  for (const p of sandbox.figma.root.children) if (!p.loadAsync) p.loadAsync = async () => { perPageLoads++; };
  const depth1 = await sandbox.listPages({ depth: 1 });
  ok("[LIST] depth 1 lists pages", depth1.pages.length === listed.pages.length && depth1.depth === 1);
  ok("[LIST] depth 1 omits frames entirely", depth1.pages.every((p) => p.frames === undefined));
  ok("[LIST] depth 1 loads NOTHING (that's why it's near-free)", loadCalls === 0 && perPageLoads === 0);
  await sandbox.listPages({ depth: 2 });
  ok("[LIST] depth 2 loads each page individually, NOT loadAllPagesAsync",
    loadCalls === 0 && perPageLoads === sandbox.figma.root.children.length);
  // A page that fails to load must cost only ITSELF — the whole reason for loading one at a time.
  const flaky = sandbox.figma.root.children[0];
  const prevFlakyLoad = flaky.loadAsync;
  flaky.loadAsync = async () => { throw new Error("nope"); };
  const listFlaky = await sandbox.listPages({ depth: 2 });
  ok("[LIST] a page that fails to load is warned, and the others still list",
    listFlaky.manifest.warnings.some((w) => /failed to load/.test(w)) && listFlaky.pages.length === sandbox.figma.root.children.length);
  flaky.loadAsync = prevFlakyLoad;
  sandbox.figma.loadAllPagesAsync = prevLoad2;

  // ---- [CHILDREN] listChildren: the node-scoped twin of listPages depth 2 ----
  // listPages stops at a PAGE's top-level frames; this peeks one level inside a given NODE instead —
  // same cost model (no recursion, no assets), just addressed by id.
  const grandchild = { id: "gc:1", name: "Icon", type: "VECTOR", width: 12, height: 12 };
  const childText = { id: "ch:1", name: "Label", type: "TEXT", width: 40, height: 12, visible: false };
  const childFrame = { id: "ch:2", name: "Row", type: "FRAME", width: 100, height: 20, children: [grandchild] };
  const parentFrame = { id: "p:children", name: "Card", type: "FRAME", children: [childText, childFrame] };
  const leafNode = { id: "leaf:children", name: "Glyph", type: "VECTOR", width: 8, height: 8 }; // no `children` key
  const prevGetNodeC = sandbox.figma.getNodeByIdAsync;
  sandbox.figma.getNodeByIdAsync = async (id) => ({ "p:children": parentFrame, "leaf:children": leafNode }[id] || null);

  const kids = await sandbox.listChildren("p:children");
  ok("[CHILDREN] reports the queried node's own id/name/type", kids.id === "p:children" && kids.name === "Card" && kids.type === "FRAME");
  ok("[CHILDREN] lists DIRECT children only", kids.children.length === 2);
  ok("[CHILDREN] each child carries id/name/type", kids.children.every((c) => c.id && c.name && c.type));
  ok("[CHILDREN] children carry size", kids.children.every((c) => typeof c.w === "number" && typeof c.h === "number"));
  ok("[CHILDREN] a hidden child is flagged", kids.children.find((c) => c.id === "ch:1").hidden === true);
  ok("[CHILDREN] a child that itself has children is flagged hasChildren:true", kids.children.find((c) => c.id === "ch:2").hasChildren === true);
  // The whole point of the op: it does NOT recurse. The grandchild must never appear anywhere.
  ok("[CHILDREN] does NOT recurse into grandchildren", JSON.stringify(kids).indexOf("gc:1") === -1);
  ok("[CHILDREN] no serialized detail leaks in (no fills/layout/tokens)",
    kids.children.every((c) => c.fills === undefined && c.layout === undefined && c.tokens === undefined));
  ok("[CHILDREN] no assets are produced", kids.assets === undefined);

  let leafErr = null;
  try { await sandbox.listChildren("leaf:children"); } catch (e) { leafErr = e; }
  ok("[CHILDREN] a leaf node (nothing to list) errors rather than returning an empty list", !!leafErr && /leaf/.test(leafErr.message));

  let childrenMissErr = null;
  try { await sandbox.listChildren("nope:children"); } catch (e) { childrenMissErr = e; }
  ok("[CHILDREN] an unknown node id errors", !!childrenMissErr && /not in the open file/.test(childrenMissErr.message));

  let childrenEmptyErr = null;
  try { await sandbox.listChildren(""); } catch (e) { childrenEmptyErr = e; }
  ok("[CHILDREN] an empty id errors", !!childrenEmptyErr && /No node id/.test(childrenEmptyErr.message));

  // A node on an UNLOADED page: getNodeByIdAsync only sees loaded pages under dynamic-page access, so
  // there has to be a fallback. It must load pages ONE AT A TIME and stop the moment the node
  // resolves — not call loadAllPagesAsync, which the Figma docs say to avoid unless necessary, and
  // which would pay for a 25-page file to find a node on page 1.
  let allPagesCalls = 0, incrementalLoads = 0;
  const prevLoadAll3 = sandbox.figma.loadAllPagesAsync;
  const prevRoot3 = sandbox.figma.root.children;
  sandbox.figma.loadAllPagesAsync = async () => { allPagesCalls++; };
  let unlockedPage = false;
  const lazyPage = { name: "Lazy", id: "p:lazy", loadAsync: async () => { incrementalLoads++; unlockedPage = true; }, get children() { return []; } };
  const laterPage = { name: "Later", id: "p:later", loadAsync: async () => { incrementalLoads++; }, get children() { return []; } };
  sandbox.figma.root.children = [lazyPage, laterPage];
  sandbox.figma.getNodeByIdAsync = async (id) => (id === "deep:1" && unlockedPage ? parentFrame : null);
  const lazyKids = await sandbox.listChildren("deep:1");
  ok("[CHILDREN] a node on an unloaded page is still found", lazyKids.children.length === 2);
  ok("[CHILDREN] the lookup loads pages incrementally, never loadAllPagesAsync", allPagesCalls === 0 && incrementalLoads === 1);
  ok("[CHILDREN] and stops as soon as the node resolves (later pages untouched)", incrementalLoads < sandbox.figma.root.children.length);
  sandbox.figma.root.children = prevRoot3;
  sandbox.figma.loadAllPagesAsync = prevLoadAll3;

  sandbox.figma.getNodeByIdAsync = prevGetNodeC;

  // ---- [PAGE] --page: export ONE named page (not the one that happens to be open) ----
  // Verified against the Plugin API docs: PageNode.loadAsync() loads a single page, root.children is
  // readable without loading, and figma.currentPage does NOT need to change — so a --page export
  // leaves the user's editor where it is. That last fact is what made the metadata bugs below
  // possible: three fields still assumed "exported page == currentPage".
  const pgA = { name: "Screens", id: "p:A", children: [scrollFrame], loadAsync: async () => {}, findAllWithCriteria: () => [] };
  const pgB = { name: "Screens", id: "p:B", children: [], loadAsync: async () => {}, findAllWithCriteria: () => [] };
  const pgC = { name: "Archive", id: "p:C", children: [], loadAsync: async () => {}, findAllWithCriteria: () => [] };
  const prevKids = sandbox.figma.root.children;
  const prevCurrent = sandbox.figma.currentPage;
  sandbox.figma.root.children = [pgA, pgB, pgC];

  const byId = await sandbox.collectFull({ page: "p:A", css: false });
  ok("[PAGE] resolves a page by id", byId.layersDoc.layers.length > 0);
  // The three metadata bugs an API review caught: all reported figma.currentPage, which is NOT the
  // exported page (loadAsync deliberately does not navigate).
  ok("[PAGE] scope is a distinct 'page', not 'current-page'", byId.layersDoc.scope === "page");
  ok("[PAGE] `page` names the EXPORTED page, not the open one", byId.layersDoc.page === "Screens");
  ok("[PAGE] does not navigate the user (currentPage unchanged)", sandbox.figma.currentPage === prevCurrent);
  // Every layer carries its page ID, not just the page NAME. The name is user-editable and the Plugin
  // API guarantees no uniqueness for it — pgA and pgB above are BOTH "Screens" — so a consumer keyed
  // on the name (bridge/pages-layout.js buckets pages into directories) merged two distinct pages
  // into one. The id is the only stable page identity that survives into the export.
  ok("[PAGE] every layer carries its page ID, not just the display name",
    byId.layersDoc.layers.every((l) => l.pageId === "p:A" && l.page === "Screens"));
  ok("[PAGE] and so does every index entry, so the manifest can disambiguate too",
    byId.layersDoc.index.every((e) => e.pageId === "p:A"));

  const byName = await sandbox.collectFull({ page: "Archive", css: false });
  ok("[PAGE] resolves an unambiguous page by name", byName.layersDoc.page === "Archive");
  const byCase = await sandbox.collectFull({ page: "  aRcHiVe ", css: false });
  ok("[PAGE] falls back to a UNIQUE case-insensitive name", byCase.layersDoc.page === "Archive");

  // Figma ALLOWS duplicate page names. Exact-name matching used to pick-first with no guard, which is
  // the likeliest real collision. Nothing here is interactive, so a wrong silent pick is unrecoverable.
  let dupErr = null;
  try { await sandbox.collectFull({ page: "Screens", css: false }); } catch (e) { dupErr = e; }
  ok("[PAGE] a DUPLICATE exact name errors instead of picking one", !!dupErr && /ambiguous/.test(dupErr.message));
  ok("[PAGE] the ambiguity error says to use the id", !!dupErr && /use its id/.test(dupErr.message));
  ok("[PAGE] and lists the available pages (self-healing)", !!dupErr && /p:A/.test(dupErr.message) && /p:C/.test(dupErr.message));

  let missErr = null;
  try { await sandbox.collectFull({ page: "Nope", css: false }); } catch (e) { missErr = e; }
  ok("[PAGE] an unknown page errors", !!missErr && /no page matches/.test(missErr.message));
  ok("[PAGE] the not-found error lists the valid choices", !!missErr && /Available pages/.test(missErr.message) && /"Archive"/.test(missErr.message));

  // Repeatable, and de-duplicated if the same page is named twice.
  const multi = await sandbox.collectFull({ page: ["p:A", "p:C"], css: false });
  ok("[PAGE] accepts MULTIPLE pages", Array.isArray(multi.layersDoc.pages) && multi.layersDoc.pages.length === 2);
  ok("[PAGE] multi-page export omits the singular `page` field", multi.layersDoc.page === undefined);
  const dedup = await sandbox.collectFull({ page: ["p:A", "p:A"], css: false });
  ok("[PAGE] the same page twice is exported once", dedup.layersDoc.pages === undefined && dedup.layersDoc.page === "Screens");

  // ---- [MEAS] measurements are read from the EXPORTED pages, not from whatever page is open ----
  // This used to hardcode figma.currentPage, so a --page export of a non-current page attached the
  // OPEN page's redlines to a doc about a different page. Each entry now carries its own page tag.
  const redline = (id) => [{ start: { node: { id } , side: "LEFT" }, end: { node: { id }, side: "RIGHT" }, offset: 8, freeText: id }];
  pgA.getMeasurements = () => redline("a");
  pgC.getMeasurements = () => redline("c");
  const measMulti = await sandbox.collectFull({ page: ["p:A", "p:C"], measurements: true, css: false });
  ok("[MEAS] each redline is tagged with the page it came from",
    measMulti.layersDoc.measurements.some((m) => m.page === "Screens" && m.text === "a") &&
    measMulti.layersDoc.measurements.some((m) => m.page === "Archive" && m.text === "c"));
  ok("[MEAS] and with the page ID too — the name alone can't tell two same-named pages apart",
    measMulti.layersDoc.measurements.every((m) => m.pageId === (m.text === "a" ? "p:A" : "p:C")));
  // Two pages CAN legitimately share identical redlines — that is data, not an error: emit both.
  pgC.getMeasurements = () => redline("a");
  const measDup = await sandbox.collectFull({ page: ["p:A", "p:C"], measurements: true, css: false });
  ok("[MEAS] identical sets on two pages are both emitted, not de-duplicated", measDup.layersDoc.measurements.length === 2);
  delete pgA.getMeasurements;
  delete pgC.getMeasurements;

  // An explicitly-empty selector is a caller bug (an interpolated variable that came out blank) —
  // falling back silently would export the wrong page and say nothing.
  const blank = await sandbox.collectFull({ page: "   ", css: false });
  ok("[PAGE] an empty selector warns rather than silently falling back",
    blank.layersDoc.manifest.warnings.some((w) => /page selector was empty/.test(w)));

  // allPages + page are MUTUALLY EXCLUSIVE. The branch below used to be `if (allPages) … else if
  // (page)`, so allPages silently won: a caller asking for one page got all of them — a plausible
  // export of the WRONG scope. figma-pull's arg parser refused this, but the MCP path did not, and
  // the guard belongs at the collector where EVERY caller passes through it.
  let bothErr = null;
  try { await sandbox.collectFull({ allPages: true, page: "p:A", css: false }); } catch (e) { bothErr = e; }
  ok("[PAGE] allPages + page is REFUSED, not silently resolved", !!bothErr && /different scopes/.test(bothErr.message));
  ok("[PAGE] the scope-conflict error names both ways out", !!bothErr && /page:\[ids\]/.test(bothErr.message) && /whole file/.test(bothErr.message));
  // An all-pages export with no page selector must be unaffected by that guard.
  const stillAll = await sandbox.collectFull({ allPages: true, css: false });
  ok("[PAGE] allPages alone still exports every page", stillAll.layersDoc.scope === "all-pages");
  // A blank selector alongside allPages is NOT a conflict — it trims to nothing, so there is no
  // second scope to conflict with, and refusing it would fail a run that asked for exactly one thing.
  const allBlank = await sandbox.collectFull({ allPages: true, page: "  ", css: false });
  ok("[PAGE] allPages + a BLANK page selector is not a conflict", allBlank.layersDoc.scope === "all-pages");
  sandbox.figma.root.children = prevKids;

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

  // ==================================================================================
  // Audit 2026-08-08 punch-list. The read plane was already broad; these are about the
  // output being USABLE — recoverable icons, a readable warnings list, and no payload
  // that nothing consumes.
  // ==================================================================================

  // ---- [AUDIT-1] failed vector exports: skip the empty ones, recover the real ones ----
  // The live export reported assetsFailed: 807 and left 663 vector nodes with NO `asset` at all —
  // icons simply unimplementable. Two distinct causes were collapsed into one counter and one
  // warning each: nodes that paint NOTHING (Figma rightly refuses to render them — not a failure),
  // and nodes that do paint but whose export threw (a real loss, and recoverable from geometry).
  const vecHost = (id, kids) => ({ type: "FRAME", name: "Host" + id, visible: true, id: "vh:" + id,
    width: 100, height: 100, layoutMode: "NONE", children: kids,
    exportAsync: async () => new Uint8Array([137, 80, 78, 71]) });
  const boom = async () => { throw new Error("could not be exported"); };
  const prevSel2 = sandbox.figma.currentPage.selection;

  const invisibleVec = { type: "VECTOR", name: "empty-path", visible: true, id: "iv:1", width: 16, height: 16,
    fills: [{ type: "SOLID", visible: false, color: { r: 0, g: 0, b: 0 }, opacity: 1 }], strokes: [], exportAsync: boom };
  const zeroAreaVec = { type: "VECTOR", name: "collapsed", visible: true, id: "iv:2", width: 0, height: 24,
    fills: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 1 }], exportAsync: boom };
  sandbox.figma.currentPage.selection = [vecHost("inv", [invisibleVec, zeroAreaVec])];
  const invRun = await sandbox.collectSelection({ css: false });
  const [invNode, zeroNode] = invRun.screen.nodes[0].children;

  ok("[AUDIT-1] a vector with no visible paint is skipped (no asset, no geometry)",
    invNode.asset === undefined && invNode.geometry === undefined);
  ok("[AUDIT-1] a zero-area vector is skipped too", zeroNode.asset === undefined && zeroNode.geometry === undefined);
  ok("[AUDIT-1] the skip is COUNTED in its own counter", invRun.screen.manifest.assetsSkippedInvisible === 2);
  // The whole point of separating them: these must not inflate assetsFailed, which is the number an
  // agent (and this repo's own audit) reads as "icons you have lost".
  ok("[AUDIT-1] and NOT counted as a failure", invRun.screen.manifest.assetsFailed === 0);
  ok("[AUDIT-1] and NOT warned — there is nothing to render, so there is nothing to report",
    !invRun.screen.manifest.warnings.some((w) => /asset export/.test(w)));
  ok("[AUDIT-1] exportAsync is never even attempted on them (they would have thrown)",
    invRun.screen.manifest.warnings.every((w) => !/could not be exported/.test(w)));

  // A node that DOES paint and still fails to export falls back to its resolved outlines. Docs call
  // `vectorPaths` "simple, but incomplete", so the fallback reads fillGeometry/strokeGeometry.
  const brokenVec = { type: "VECTOR", name: "icon-path", visible: true, id: "gv:1", width: 24, height: 24,
    fills: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 1 }],
    fillGeometry: [{ data: "M0 0h24v24H0z", windingRule: "NONZERO" }],
    strokeGeometry: [{ data: "M2 2h20" }],
    vectorPaths: [{ data: "M9 9L1 1" }], // deliberately DIFFERENT: the fallback must not read this
    exportAsync: boom };
  sandbox.figma.currentPage.selection = [vecHost("geo", [brokenVec])];
  const geoRun = await sandbox.collectSelection({ css: false });
  const geoNode = geoRun.screen.nodes[0].children[0];
  ok("[AUDIT-1] a real export failure falls back to fillGeometry", geoNode.geometry && geoNode.geometry.fills[0] === "M0 0h24v24H0z");
  ok("[AUDIT-1] strokeGeometry comes along when present", geoNode.geometry.strokes[0] === "M2 2h20");
  // Without w/h the path data has no coordinate space — a consumer cannot build a viewBox from it.
  ok("[AUDIT-1] geometry carries the node's own w/h so it can be rendered as inline SVG",
    geoNode.geometry.w === 24 && geoNode.geometry.h === 24);
  ok("[AUDIT-1] the incomplete `vectorPaths` is NOT what gets captured", JSON.stringify(geoNode.geometry).indexOf("M9 9L1 1") === -1);
  ok("[AUDIT-1] a recovered node is still a LEAF, like a successful export", geoNode.children === undefined && geoNode.asset === undefined);
  ok("[AUDIT-1] recovery is counted, and is not a failure",
    geoRun.screen.manifest.assetsGeometry === 1 && geoRun.screen.manifest.assetsFailed === 0);

  // Only when BOTH the export and the geometry are gone is it a genuine, warn-worthy failure.
  const hopelessVec = { type: "VECTOR", name: "gone", visible: true, id: "hv:1", width: 24, height: 24,
    fills: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 1 }], exportAsync: boom };
  sandbox.figma.currentPage.selection = [vecHost("bad", [hopelessVec])];
  const badRun = await sandbox.collectSelection({ css: false });
  ok("[AUDIT-1] an unrecoverable node IS counted as failed", badRun.screen.manifest.assetsFailed === 1);
  ok("[AUDIT-1] and IS warned, naming the node and the reason",
    badRun.screen.manifest.warnings.some((w) => /asset export failed/.test(w) && /gone \(hv:1\)/.test(w) && /could not be exported/.test(w)));

  // ---- [2026-08-13] isAsset: Figma's own icon/raster heuristic, OR'd into iconLike ----
  // A container that the name/size regex would NOT flag (unconventional name) but that Figma's own
  // `isAsset` says is an icon/raster subtree should still flatten to one asset leaf.
  const oddNameVec = { type: "VECTOR", name: "shape9", visible: true, id: "oa:v1", width: 16, height: 16,
    fills: [{ type: "SOLID", visible: true, color: { r: 1, g: 0, b: 0 }, opacity: 1 }], exportAsync: async () => "<svg/>" };
  const oddNameFrame = { type: "FRAME", name: "Group 42", visible: true, id: "oa:1", width: 20, height: 20,
    isAsset: true, children: [oddNameVec], findOne: () => null, exportAsync: async () => "<svg/>" };
  sandbox.figma.currentPage.selection = [oddNameFrame];
  const isAssetRun = await sandbox.collectSelection({});
  ok("[isAsset] a container Figma flags as an asset flattens even with a non-matching name",
    typeof isAssetRun.screen.nodes[0].asset === "string" && !isAssetRun.screen.nodes[0].children);

  const oddNameFrameWithText = { type: "FRAME", name: "Group 43", visible: true, id: "oa:2", width: 20, height: 20,
    isAsset: true, children: [{ type: "TEXT", name: "t", visible: true, id: "oa:t1" }],
    findOne: (pred) => ([{ type: "TEXT", name: "t", visible: true, id: "oa:t1" }].find(pred) || null),
    exportAsync: async () => "<svg/>" };
  sandbox.figma.currentPage.selection = [oddNameFrameWithText];
  const isAssetTextRun = await sandbox.collectSelection({});
  ok("[isAsset] isAsset:true is still overridden by a real TEXT descendant — never flatten real content",
    Array.isArray(isAssetTextRun.screen.nodes[0].children));

  // ---- [2026-08-13] variableWidthStrokeProperties: tapered strokes ----
  const taperedNode = { type: "VECTOR", name: "brush", visible: true, id: "vw:1", width: 40, height: 4,
    strokes: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 1 }],
    strokeWeight: 2,
    variableWidthStrokeProperties: { strokeWeightProfile: { type: "MULTI_POINT",
      mapping: [{ position: 0, value: 1 }, { position: 0.5, value: 4 }, { position: 1, value: 1 }] } },
    fills: [], exportAsync: async () => "<svg/>" };
  sandbox.figma.currentPage.selection = [taperedNode];
  const taperedRun = await sandbox.collectSelection({});
  const taperedStroke = taperedRun.screen.nodes[0].strokes;
  ok("[variableWidth] a tapered stroke's profile type is captured",
    !!taperedStroke && !!taperedStroke.variableWidth && taperedStroke.variableWidth.profile === "multi_point");
  ok("[variableWidth] and its points, with position+weight",
    taperedStroke.variableWidth.points.length === 3 && taperedStroke.variableWidth.points[1].pos === 0.5 && taperedStroke.variableWidth.points[1].weight === 4);

  const plainStrokeNode = { type: "VECTOR", name: "plain", visible: true, id: "vw:2", width: 40, height: 4,
    strokes: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 1 }],
    strokeWeight: 2, fills: [], exportAsync: async () => "<svg/>" };
  sandbox.figma.currentPage.selection = [plainStrokeNode];
  const plainRun = await sandbox.collectSelection({});
  ok("[variableWidth] a normal stroke with no profile emits no variableWidth key",
    !plainRun.screen.nodes[0].strokes || plainRun.screen.nodes[0].strokes.variableWidth === undefined);

  // ---- [AUDIT-6c] the warnings manifest is aggregated by kind, not one entry per node ----
  // A real export produced 896 warnings, ~800 asset failures + 80 identical missingFont sentences.
  // At that length the list is not readable, and the one-off warnings that DO need attention (an
  // unreadable page, a failed page load) are invisible inside it. The manifest stays a flat string[].
  const missingFontText = (i) => ({ type: "TEXT", name: "Label" + i, visible: true, id: "mf:" + i, characters: "x", width: 50,
    fontName: { family: "Proxima Nova", style: "Regular" }, fontSize: 12, hasMissingFont: true, getStyledTextSegments: () => [] });
  const manyFonts = [];
  for (let i = 1; i <= 12; i++) manyFonts.push(missingFontText(i));
  sandbox.figma.currentPage.selection = [vecHost("fonts", manyFonts)];
  const aggRun = await sandbox.collectSelection({ css: false });
  const aggWarnings = aggRun.screen.manifest.warnings;
  const fontLines = aggWarnings.filter((w) => /missing font/.test(w));

  ok("[AUDIT-6c] 12 missing-font nodes produce ONE warning, not 12", fontLines.length === 1);
  ok("[AUDIT-6c] the summary carries the real count", /12 node\(s\)/.test(fontLines[0]));
  ok("[AUDIT-6c] and example nodes, so it stays actionable", /Label1 \(mf:1\)/.test(fontLines[0]));
  ok("[AUDIT-6c] examples are capped (~10) and the remainder is stated, not silently dropped",
    /\(\+2 more\)/.test(fontLines[0]) && (fontLines[0].match(/mf:/g) || []).length === 10);
  // Backward compatibility: the skill's "read warnings first" step reads a plain list of strings.
  ok("[AUDIT-6c] the manifest is still a flat array of strings", Array.isArray(aggWarnings) && aggWarnings.every((w) => typeof w === "string"));
  // Per-node flags are untouched — aggregation is about the MANIFEST, not about hiding the signal.
  ok("[AUDIT-6c] every affected node still carries its own missingFont flag",
    aggRun.screen.nodes[0].children.every((c) => c.missingFont === true));
  sandbox.figma.currentPage.selection = prevSel2;

  // ---- [AUDIT-6a] box.x/y is page-space and must not survive inside an auto-layout parent ----
  const boxed = (id, extra) => Object.assign({ type: "FRAME", name: "Row" + id, visible: true, id: "bx:" + id,
    width: 100, height: 20, layoutMode: "NONE", children: [],
    absoluteBoundingBox: { x: 40, y: 80, width: 100, height: 20 } }, extra || {});
  const flowKid = boxed("flow");
  const absKid = boxed("abs", { layoutPositioning: "ABSOLUTE" });
  const autoParent = { type: "FRAME", name: "Stack", visible: true, id: "bx:p", width: 100, height: 100,
    layoutMode: "VERTICAL", itemSpacing: 0, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
    absoluteBoundingBox: { x: 5, y: 6, width: 100, height: 100 }, children: [flowKid, absKid] };
  const stack = await sandbox.serialize(autoParent, 0, false);
  const [flowOut, absOut] = stack.children;
  ok("[AUDIT-6a] a flow child of an auto-layout parent keeps w/h", flowOut.box.w === 100 && flowOut.box.h === 20);
  ok("[AUDIT-6a] but drops box.x/y — the container decides placement", flowOut.box.x === undefined && flowOut.box.y === undefined);
  // The exceptions have to survive, or absolutely-positioned overlays lose their only placement data.
  ok("[AUDIT-6a] an ABSOLUTE child keeps box.x/y", absOut.box.x === 40 && absOut.box.y === 80);
  const looseParent = { type: "FRAME", name: "Canvas", visible: true, id: "bx:l", width: 100, height: 100,
    layoutMode: "NONE", children: [boxed("loose")] };
  const loose = await sandbox.serialize(looseParent, 0, false);
  ok("[AUDIT-6a] a child of a NON-auto-layout parent keeps box.x/y", loose.children[0].box.x === 40 && loose.children[0].box.y === 80);
  // The export ROOT has no parent in the doc, so its own page-space origin is the only anchor there is.
  ok("[AUDIT-6a] an export ROOT keeps its own box.x/y", stack.box.x === 5 && stack.box.y === 6);

  // ---- [AUDIT-6b] widthMode/heightMode: emit only the non-default values ----
  const sizing = (h, v) => ({ type: "FRAME", name: "S", visible: true, id: "sz:1", width: 10, height: 10,
    layoutMode: "NONE", layoutSizingHorizontal: h, layoutSizingVertical: v, children: [] });
  const fixedBoth = await sandbox.serialize(sizing("FIXED", "FIXED"), 0, false);
  ok("[AUDIT-6b] the FIXED default emits neither key", fixedBoth.widthMode === undefined && fixedBoth.heightMode === undefined);
  const sizedFill = await sandbox.serialize(sizing("FILL", "HUG"), 0, false);
  ok("[AUDIT-6b] FILL/HUG (the values that change the CSS) still emit", sizedFill.widthMode === "fill" && sizedFill.heightMode === "hug");

  // ---- [AUDIT-5] numberOfFixedChildren: sticky headers/footers/FABs ----
  const stickyFrame = { type: "FRAME", name: "Screen", visible: true, id: "fx:1", width: 375, height: 800,
    layoutMode: "NONE", overflowDirection: "VERTICAL", numberOfFixedChildren: 2, children: [] };
  const sticky = await sandbox.serialize(stickyFrame, 0, false);
  ok("[AUDIT-5] numberOfFixedChildren -> fixedChildren", sticky.fixedChildren === 2);
  const plainFrame = await sandbox.serialize({ type: "FRAME", name: "Plain", visible: true, id: "fx:2",
    width: 10, height: 10, layoutMode: "NONE", numberOfFixedChildren: 0, children: [] }, 0, false);
  ok("[AUDIT-5] and is omitted at the 0 default (it is on every frame)", plainFrame.fixedChildren === undefined);

  // ---- [AUDIT-5] exportSettings: the designer's own asset intent ----
  const exportNode = await sandbox.serialize({ type: "FRAME", name: "Logo", visible: true, id: "ex:1",
    width: 40, height: 40, layoutMode: "NONE", children: [],
    exportSettings: [
      { format: "SVG", suffix: "", constraint: { type: "SCALE", value: 1 } },
      { format: "PNG", suffix: "@3x", constraint: { type: "SCALE", value: 3 } },
    ] }, 0, false);
  ok("[AUDIT-5] exportSettings captured, format lowercased", Array.isArray(exportNode.exportSettings) && exportNode.exportSettings[0].format === "svg");
  ok("[AUDIT-5] the density suffix + scale survive", exportNode.exportSettings[1].suffix === "@3x" && exportNode.exportSettings[1].constraint.value === 3);
  ok("[AUDIT-5] the SCALE-1 default carries no intent and is omitted", exportNode.exportSettings[0].constraint === undefined);
  ok("[AUDIT-5] a node with no presets emits nothing", plainFrame.exportSettings === undefined);

  // ---- [AUDIT-5] skew: the sheared transform the decomposition used to throw away ----
  const xf = (m) => ({ type: "FRAME", name: "T", visible: true, id: "sk:1", width: 10, height: 10,
    layoutMode: "NONE", relativeTransform: m, children: [] });
  const skewed = await sandbox.serialize(xf([[1, 0.5, 0], [0, 1, 0]]), 0, false);
  ok("[AUDIT-5] shear in relativeTransform -> skew (degrees, CSS skewX)", skewed.skew === 26.57);
  ok("[AUDIT-5] a sheared node is not mistaken for a flip", skewed.flipped === undefined);
  // A pure rotation shears by exactly 0 — the decomposition must not manufacture a skew for it.
  const rot = Math.PI / 6;
  const rotated = await sandbox.serialize(xf([[Math.cos(rot), -Math.sin(rot), 0], [Math.sin(rot), Math.cos(rot), 0]]), 0, false);
  ok("[AUDIT-5] a pure rotation emits NO skew", rotated.skew === undefined);
  const flippedNode = await sandbox.serialize(xf([[-1, 0, 0], [0, 1, 0]]), 0, false);
  ok("[AUDIT-5] a pure flip still reads as flipped, with no skew", flippedNode.flipped === true && flippedNode.skew === undefined);

  // ---- [AUDIT-4] index size hints: the skill says "read ONLY that file", so say how big it is ----
  const sized = await sandbox.collectFull({ css: false });
  const entry = sized.layersDoc.index[0];
  const layerTree = sized.layersDoc.layers[0].tree;
  const countTree = (t) => 1 + (Array.isArray(t.children) ? t.children.reduce((a, c) => a + countTree(c), 0) : 0);
  ok("[AUDIT-4] index entries carry a subtree node count", entry.nodes === countTree(layerTree));
  ok("[AUDIT-4] and an approximate serialized byte size", typeof entry.bytes === "number" && entry.bytes > 100);
  ok("[AUDIT-4] bytes tracks the tree that actually lands in the layer file",
    Math.abs(entry.bytes - JSON.stringify(layerTree).length) < 2);
  ok("[AUDIT-4] the identity fields are unchanged", !!entry.id && !!entry.name && !!entry.type && !!entry.page);

  // ---- [AUDIT-5] page backgrounds: the canvas a screen sits on ----
  const bgPage = { name: "Dark", id: "p:bg", loadAsync: async () => {}, children: [scrollFrame],
    findAllWithCriteria: () => [],
    backgrounds: [{ type: "SOLID", visible: true, color: { r: 0.1, g: 0.1, b: 0.1 }, opacity: 1 }],
    prototypeBackgrounds: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 1 }] };
  const defaultPage = { name: "Plain", id: "p:plain", loadAsync: async () => {}, children: [],
    findAllWithCriteria: () => [],
    backgrounds: [{ type: "SOLID", visible: true, color: { r: 1, g: 1, b: 1 }, opacity: 1 }] };
  const prevKids2 = sandbox.figma.root.children;
  sandbox.figma.root.children = [bgPage, defaultPage];
  const bgRun = await sandbox.collectFull({ allPages: true, css: false });
  const bgEntry = (bgRun.layersDoc.pageSettings || []).find((p) => p.pageId === "p:bg");
  ok("[AUDIT-5] a page's chosen canvas background is captured", bgEntry && bgEntry.background[0].color === "#1a1a1a");
  ok("[AUDIT-5] prototypeBackgrounds is captured separately", bgEntry && bgEntry.prototypeBackground[0].color === "#000000");
  ok("[AUDIT-5] the page entry is keyed by pageId, not by the non-unique name", bgEntry && bgEntry.page === "Dark");
  // Figma's own default carries no designer intent — emitting it would put a line on every page.
  ok("[AUDIT-5] the plain-white default is omitted", !(bgRun.layersDoc.pageSettings || []).some((p) => p.pageId === "p:plain"));
  sandbox.figma.root.children = prevKids2;

  report();
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
