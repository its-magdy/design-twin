// The harness's representative file: a scroll frame with mixed text, a gradient rect and a reacting instance, a
// multi-mode token set, styles of every kind (custom animation styles included), a component with an INSTANCE_SWAP
// prop. `fixtures()` builds every object anew on each call and `world()` makes a fresh fake-figma world over it, so
// no case can see what another case did to the file.
import {
  fakeWorld, MIXED, type FakeCollection, type FakeNode, type FakeOverrides, type FakeVariable, type Scene, type World,
} from "../fake-figma.ts";

// cas1's entries as both the motion read and the catalog emit them (motion.ts animationStyleEntry).
export const CAS1_ENTRIES = '{"id":"entry1","name":"Fade In","styleId":"as1","duration":0.3,"props":{"easing":{"type":"ease_out"}}},' +
  '{"id":"entry2","name":"Slide Up","styleId":"as2","description":"Rises into place","duration":0.46,"timelineOffset":0.2,"props":{"distance":16,"color":{"aliasOf":"easing/emphasized"}}}';

export function fixtures() {
  // ---- mock design-system data ----
  const VARS: Record<string, FakeVariable> = {
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
    // Named EASING variable — a motion easing/style-prop alias resolves to {aliasOf: "easing/emphasized"}
    // through the same getVariableByIdAsync memo (run.ts Run.varName) variables.ts uses. Keyed by the
    // "VariableID:2" id the animationStyles fixture below binds to.
    "VariableID:2": { id: "VariableID:2", name: "easing/emphasized", resolvedType: "EASING", variableCollectionId: "c_sem",
      scopes: [], codeSyntax: {}, remote: false, valuesByMode: { m_light: { type: "EASE_OUT" } } },
  };
  const COLLECTIONS: FakeCollection[] = [
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
      { characters: "Hello ", fontName: { family: "Inter", style: "Regular" }, fontSize: 24, lineHeight: { unit: "PERCENT", value: 120 }, letterSpacing: { unit: "PIXELS", value: 0.5 }, textCase: "ORIGINAL", textDecoration: "NONE", fills: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 1 }], hyperlink: null, listOptions: { type: "NONE" }, boundVariables: {}, fontStyle: "REGULAR", paragraphSpacing: 8, paragraphIndent: 0, textStyleOverrides: [] },
      { characters: "World", fontName: { family: "Inter", style: "Bold", variationSettings: { wght: 600 } }, fontSize: 24, fontWeight: 700, lineHeight: { unit: "PERCENT", value: 120 }, letterSpacing: { unit: "PIXELS", value: 0.5 }, textCase: "ORIGINAL", textDecoration: "UNDERLINE", textDecorationThickness: { value: 2, unit: "PIXELS" }, textDecorationOffset: { value: 1, unit: "PIXELS" }, textDecorationSkipInk: false, fills: [{ type: "SOLID", visible: true, color: { r: 0.1, g: 0.3, b: 0.9 }, opacity: 1 }], hyperlink: { type: "URL", value: "https://x.com" }, listOptions: { type: "NONE" }, indentation: 1, openTypeFeatures: { SMCP: true, LIGA: false }, textStyleId: "s_heading", fillStyleId: "s_brand", boundVariables: { fills: { type: "VARIABLE_ALIAS", id: "v_primary" } }, fontStyle: "REGULAR", paragraphSpacing: 8, paragraphIndent: 0, textStyleOverrides: [] },
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
      { type: "NODE", navigation: "NAVIGATE", destinationId: "frame_2", preserveScrollPosition: true, transition: { type: "MOVE_IN", direction: "LEFT", duration: 0.3, matchLayers: true, easing: { type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1: 0.4, y1: 0, x2: 0.2, y2: 1 } } } },
      { type: "SET_VARIABLE", variableId: "v_primary", variableValue: { resolvedType: "COLOR", value: { type: "VARIABLE_ALIAS", id: "v_blue600" } } },
      { type: "SET_VARIABLE_MODE", variableCollectionId: "c_sem", variableModeId: "m_dark" },
      { type: "CONDITIONAL", conditionalBlocks: [{ condition: { value: true }, actions: [{ type: "NODE", navigation: "NAVIGATE", destinationId: "frame_2" }] }] },
      { type: "UPDATE_MEDIA_RUNTIME", destinationId: "frame_2", mediaAction: "PLAY" },
      { type: "URL", url: "https://newtab.example.com", openInNewTab: true },
      { type: "URL", url: "https://sametab.example.com" },
    ] }],
    getMainComponentAsync: async () => ({
      name: "Button", id: "comp:btn1", key: "compkey_btn", remote: false,
      parent: { type: "COMPONENT_SET", id: "set:btn", key: "setkey_btn", name: "ButtonSet" },
    }),
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
    getPluginData: (k: string) => (k === "codeConnect" ? "Button/Primary" : ""),
    inferredVariables: { fills: [[{ type: "VARIABLE_ALIAS", id: "v_primary" }]] }, // suggestion for an unbound field
    // Motion plane (Plugin API Update 130) — opt-in via {motion:true}.
    timelines: [{ id: "tl1", duration: 0.5 }],
    manualKeyframeTracks: { TRANSLATION_X: { id: "trk1", baseValue: { type: "FLOAT", value: 0 }, keyframes: [{ id: "k1", timelinePosition: 0, value: { type: "FLOAT", value: 0 }, easing: { type: "EASE_OUT" } }, { id: "k2", timelinePosition: 0.5, value: { type: "FLOAT", value: 100 }, easing: { type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1: 0.4, y1: 0, x2: 0.2, y2: 1 } } }] },
      // Indexed collections (d.ts ManualKeyframeTracks): fills/strokes keyed by paint index — a plain
      // ManualKeyframeBinding, or {properties:{shaderPropId: binding}} for a shader paint; effects keyed by
      // effect index -> {EffectKeyframeFieldName: binding, properties?}.
      fills: {
        0: { id: "trkF0", baseValue: { type: "COLOR", value: { r: 1, g: 0, b: 0, a: 1 } }, keyframes: [
          { id: "kf1", timelinePosition: 0, value: { type: "COLOR", value: { r: 1, g: 0, b: 0, a: 1 } }, easing: { type: "LINEAR" } },
          { id: "kf2", timelinePosition: 1, value: { type: "COLOR", value: { r: 0, g: 0, b: 1, a: 1 } }, easing: { type: "VARIABLE_ALIAS", id: "VariableID:1" } }] },
        1: { properties: { "shader:speed": { id: "trkF1s", baseValue: { type: "FLOAT", value: 1 }, keyframes: [
          { id: "kfs1", timelinePosition: 0, value: { type: "FLOAT", value: 1 }, easing: { type: "LINEAR" } },
          { id: "kfs2", timelinePosition: 2, value: { type: "FLOAT", value: 3 }, easing: { type: "LINEAR" } }] } } },
      },
      strokes: { 0: { id: "trkS0", baseValue: { type: "FLOAT", value: 0 }, keyframes: [
        { id: "ks1", timelinePosition: 0.25, value: { type: "FLOAT", value: 0.5 }, easing: { type: "EASE_IN" } }] } },
      effects: { 0: {
        RADIUS: { id: "trkE0r", baseValue: { type: "FLOAT", value: 4 }, keyframes: [
          { id: "ke1", timelinePosition: 0, value: { type: "FLOAT", value: 4 }, easing: { type: "LINEAR" } },
          { id: "ke2", timelinePosition: 0.5, value: { type: "FLOAT", value: 12 }, easing: { type: "LINEAR" } }] },
        properties: { "shader:glow": { id: "trkE0p", baseValue: { type: "FLOAT", value: 0 }, keyframes: [
          { id: "kep1", timelinePosition: 1, value: { type: "FLOAT", value: 0.8 }, easing: { type: "LINEAR" } }] } },
      } },
    },
    // animations = KeyframeBinding {baseValue, timelineDuration, tracks:[ManualKeyframeTrack{keyframeOperation,keyframes}]}
    // — one level deeper than manualKeyframeTracks; see https://developers.figma.com/docs/plugins/api/Motion/.
    animations: { ROTATION: { baseValue: { type: "FLOAT", value: 0 }, timelineDuration: 1.2,
      tracks: [{ id: "atrk1", keyframeOperation: "OFFSET", keyframes: [{ id: "ak1", timelinePosition: 0, value: { type: "FLOAT", value: 0 } }, { id: "ak2", timelinePosition: 1, value: { type: "FLOAT", value: 90 } }] }] },
      // Same indexed layout as manualKeyframeTracks, with KeyframeBinding values (d.ts Animations).
      fills: {
        0: { baseValue: { type: "FLOAT", value: 1 }, timelineDuration: 0.8, tracks: [{ id: "afk", keyframeOperation: "SCALE", keyframes: [
          { id: "afk1", timelinePosition: 0, value: { type: "FLOAT", value: 1 } }, { id: "afk2", timelinePosition: 0.8, value: { type: "FLOAT", value: 0.5 } }] }] },
        2: { properties: { "shader:phase": { baseValue: { type: "FLOAT", value: 0 }, timelineDuration: 3, tracks: [{ id: "afp", keyframeOperation: "SET", keyframes: [
          { id: "afp1", timelinePosition: 3, value: { type: "FLOAT", value: 6 } }] }] } } },
      },
      strokes: { 1: { baseValue: { type: "FLOAT", value: 2 }, timelineDuration: 0.4, tracks: [{ id: "ask", keyframeOperation: "OFFSET", keyframes: [
        { id: "ask1", timelinePosition: 0.4, value: { type: "FLOAT", value: 3 } }] }] } },
      effects: { 0: { OFFSET_Y: { baseValue: { type: "FLOAT", value: 0 }, timelineDuration: 0.6, tracks: [{ id: "aek", keyframeOperation: "OFFSET", keyframes: [
        { id: "aek1", timelinePosition: 0, value: { type: "FLOAT", value: 0 } }, { id: "aek2", timelinePosition: 0.6, value: { type: "FLOAT", value: 8 } }] }] } } },
    },
    // AppliedAnimationStyle is discriminated on `type` (typings 1.141): the first entry has NO `type` (a
    // runtime older than the CUSTOM kind — read as FIGMA), the second is an explicit FIGMA style, applied3-9
    // are CUSTOM ones (a CustomAnimationStyle applied: ids, name and timelineOffset only — no duration/props),
    // applied10 and the MORPH row are kinds newer than the typings; applied12-13 are FIGMA styles with a non-empty
    // and an empty description; applied14 has an empty type, read as FIGMA.
    // A CUSTOM row is expanded from the style its styleId resolves to (getStyleByIdAsync below): cas1
    // resolves (twice — one fetch), the others do not resolve to a readable custom animation style.
    animationStyles: [{
      id: "applied1", styleId: "as1", name: "Fade In", duration: 0.3, timelineOffset: 0,
      // AnimationStyleConfiguration.props (AnimationStylePropValue = string|number|boolean|MotionEasing|VariableAlias):
      // a plain number, a MotionEasing, and a VariableAlias-bound value.
      props: {
        distance: 24,
        easing: { type: "EASE_OUT" },
        color: { type: "VARIABLE_ALIAS", id: "VariableID:2" },
      },
    }, {
      type: "FIGMA", id: "applied2", styleId: "as2", name: "Slide Up", duration: 0.45, timelineOffset: 0.1, props: { distance: 16 },
    }, {
      type: "CUSTOM", id: "applied3", styleId: "cas1", name: "Brand Entrance", timelineOffset: 0.25,
    }, {
      type: "CUSTOM", id: "applied4", styleId: "cas_missing", name: "Gone",
    }, {
      type: "CUSTOM", id: "applied5", styleId: "s_accent", name: "Wrong Kind",
    }, {
      type: "CUSTOM", id: "applied6", styleId: "cas_throw", name: "Lookup Throws", timelineOffset: 0.5,
    }, {
      type: "CUSTOM", id: "applied7", styleId: "cas_broken", name: "Broken",
    }, {
      type: "CUSTOM", id: "applied8", styleId: "cas1", name: "Brand Entrance", timelineOffset: 0,
    }, {
      type: "CUSTOM", id: "applied9", styleId: "cas_empty", name: "Empty",
    }, {
      // a kind added after the typings: exported as its lower-cased kind, never read as a FIGMA style (the
      // duration/props/entries it carries are never read: the getters throw)
      type: "SPRING", id: "applied10", styleId: "as3", name: "Bounce", timelineOffset: 0.5,
      get duration(): number { throw new Error("unknown-kind row: duration read"); },
      get props(): Record<string, number> { throw new Error("unknown-kind row: props read"); },
      get entries(): unknown[] { throw new Error("unknown-kind row: entries read"); },
    }, {
      // an unknown kind whose id, name and styleId are not strings, with a zero offset: none of them is exported
      type: "MORPH", id: 11, name: 7, styleId: 9, timelineOffset: 0,
    }, {
      type: "FIGMA", id: "applied12", styleId: "as4", name: "Pop", description: "Scales in with a bounce", duration: 0.2,
    }, {
      type: "FIGMA", id: "applied13", styleId: "as5", name: "Plain", description: "", duration: 0.1,
    }, {
      // an empty type string: read as a FIGMA style, like an absent type
      type: "", id: "applied14", styleId: "as6", name: "Blank", duration: 0.1,
    }],
    absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 800 },
    constraints: { horizontal: "MIN", vertical: "MIN" },
    explicitVariableModes: { c_sem: "m_dark" }, // this subtree pinned to the Dark theme
    // Effective/inherited modes for ALL collections at this node (incl. single-mode Primitives, which
    // must be filtered out of resolvedModes since it carries no theme choice).
    resolvedVariableModes: { c_sem: "m_dark", c_prim: "m_val" },
    exportAsync: async () => new Uint8Array([137, 80, 78, 71]), // PNG magic bytes
    getDevResourcesAsync: async () => ([{ name: "Storybook", url: "https://sb.example.com/list", inheritedNodeId: null }]),
    // Cross-plugin shared data — Tokens Studio applied tokens (opt-in via {sharedData:true}).
    getSharedPluginDataKeys: (ns: string) => (ns === "tokens" ? ["fill", "borderRadius"] : []),
    getSharedPluginData: (ns: string, k: string) => { const tokens: Record<string, string> = { fill: "color.primary", borderRadius: "radius.md" }; return ns === "tokens" ? (tokens[k] || "") : ""; },
    children: [textNode, gradientRect, button],
  };

  // A COMPONENT with an INSTANCE_SWAP prop that carries preferredValues (allowed swap set).
  const buttonComponent = {
    type: "COMPONENT", name: "Button", id: "5:0", description: "Primary action button", parent: null,
    key: "compkey123", documentationLinks: [{ uri: "https://docs.example.com/button" }],
    getPublishStatusAsync: async () => "CURRENT",
    componentPropertyDefinitions: {
      "Label#1:0": { type: "TEXT", defaultValue: "Button", description: "Visible label" },
      "Icon#2:0": { type: "INSTANCE_SWAP", defaultValue: "icon:home", preferredValues: [{ type: "COMPONENT", key: "abc" }, { type: "COMPONENT", key: "def" }] },
      "Size": { type: "VARIANT", defaultValue: "md", variantOptions: ["sm", "md", "lg"] },
    },
  };

  // Custom animation styles (CustomAnimationStyle, typings 1.141): what an applied CUSTOM row's styleId
  // resolves to, and what the catalog lists. cas1 carries a description and two entries (AnimationEntry =
  // AppliedFigmaAnimationStyle); cas_broken's animationEntries read throws. `counts.customStyleFetches` counts
  // cas1 lookups so the per-run memo is observable.
  const counts = { customStyleFetches: 0 };
  const customAnimStyle: FakeNode = {
    type: "CUSTOM_ANIMATION", id: "cas1", key: "caskey1", name: "Brand Entrance", description: "Hero entrance sequence",
    remote: false, documentationLinks: [], getPublishStatusAsync: async () => "CURRENT",
    animationEntries: [
      { type: "FIGMA", id: "entry1", styleId: "as1", name: "Fade In", duration: 0.3, timelineOffset: 0, props: { easing: { type: "EASE_OUT" } } },
      { type: "FIGMA", id: "entry2", styleId: "as2", name: "Slide Up", description: "Rises into place", duration: 0.456, timelineOffset: 0.2,
        props: { distance: 16, color: { type: "VARIABLE_ALIAS", id: "VariableID:2" } } },
    ],
  };
  const brokenAnimStyle: FakeNode = {
    type: "CUSTOM_ANIMATION", id: "cas_broken", name: "Broken", description: "",
    get animationEntries(): never { throw new Error("animation entries unreadable"); },
  };
  // cas_empty's animationEntries read succeeds and is an empty list: a style with no animations, which must
  // stay distinct from cas_broken's unreadable one.
  const emptyAnimStyle: FakeNode = {
    type: "CUSTOM_ANIMATION", id: "cas_empty", key: "caskey_empty", name: "Empty", description: "",
    remote: false, documentationLinks: [], getPublishStatusAsync: async () => "CURRENT",
    animationEntries: [],
  };

  const page1: FakeNode = { name: "Page 1", children: [scrollFrame], findAllWithCriteria: () => [buttonComponent] };
  const scene: Scene = {
    file: { name: "My File", colorProfile: "DISPLAY_P3", fileKey: "FILEKEY1234567" },
    pages: [page1],
    currentPage: {
      name: "Page 1", selection: [scrollFrame], children: [scrollFrame],
      // Dev-Mode measurement redlines — SYNCHRONOUS API (getMeasurements, not *Async).
      getMeasurements: () => [{ start: { node: { id: "1:0" }, side: "LEFT" }, end: { node: { id: "1:1" }, side: "RIGHT" }, offset: { type: "OUTER", fixed: 16 }, freeText: "16" }],
    },
    nodes: { frame_2: { name: "Details" } },
    styles: {
      cas1: () => { counts.customStyleFetches++; return customAnimStyle; },
      cas_throw: () => { throw new Error("style lookup failed"); },
      s_heading: { name: "Heading/H1" }, s_brand: { name: "Brand/Primary" }, cas_broken: brokenAnimStyle, cas_empty: emptyAnimStyle,
      // a PAINT style with a description: a CUSTOM row pointing at it must not pick that description up
      s_accent: { type: "PAINT", name: "Brand/Accent", description: "Accent paint" },
    },
    localStyles: {
      paint: [{ name: "Brand/Primary", id: "s_brand", key: "paintkey123", paints: [{ type: "SOLID", visible: true, color: { r: 0.1, g: 0.3, b: 0.9 }, opacity: 1 }], boundVariables: { paints: { type: "VARIABLE_ALIAS", id: "v_allscope" } }, documentationLinks: [{ uri: "https://docs.example.com/brand" }], description: "", getPublishStatusAsync: async () => "CHANGED" }],
      text: [{ name: "Body/Regular", fontSize: 16, fontName: { family: "Inter", style: "Regular" }, lineHeight: { unit: "AUTO" }, letterSpacing: { unit: "PIXELS", value: 0 }, textCase: "ORIGINAL", textDecoration: "NONE", paragraphSpacing: 8, paragraphIndent: 4, leadingTrim: "CAP_HEIGHT", listSpacing: 6, boundVariables: { fontSize: { type: "VARIABLE_ALIAS", id: "v_allscope" } }, description: "" }],
      effect: [],
      grid: [{ name: "Grid/12col", layoutGrids: [{ pattern: "COLUMNS", count: 12, gutterSize: 20, sectionSize: 60 }], description: "" }],
      animation: [customAnimStyle, brokenAnimStyle, emptyAnimStyle],
    },
    variables: VARS,
    collections: Object.fromEntries(COLLECTIONS.map((c) => [c.id, c])),
    // Source-image resolution: intrinsic pixel size + original uploaded bytes, keyed by image hash.
    images: { abc123: { getSizeAsync: async () => ({ width: 800, height: 600 }), getBytesAsync: async () => new Uint8Array([1, 2, 3, 4]) } },
  };
  return { scene, counts, page1, scrollFrame, buttonComponent };
}
export type Fixtures = ReturnType<typeof fixtures>;

/** A world over a fresh copy of the representative file. Its fixture objects are on `fx`, and `delta` may be built
 *  from them (`(fx) => ({ pages: [{ id: "p:2", name: "Two", children: [fx.scrollFrame] }] })`). */
export function world(delta: Scene | ((fx: Fixtures) => Scene) = {}, overrides: FakeOverrides | ((fx: Fixtures) => FakeOverrides) = {}): World & { fx: Fixtures } {
  const fx = fixtures();
  const d = typeof delta === "function" ? delta(fx) : delta;
  const o = typeof overrides === "function" ? overrides(fx) : overrides;
  return { ...fakeWorld(fx.scene, d, o), fx };
}
