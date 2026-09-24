// Offline validation harness for figma-plugin/code.js.
// Loads code.js in a VM with a mock `figma`, then drives serialize()/dumpVariables()/buildDesignSystem()
// against a representative fake node tree. Verifies the extraction transforms produce correct JSON.
// This needs NO Figma app — run it with:  node test/harness.ts
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { ok, report } from "./assert.ts";
import type {
  IrNode, ScreenExport, Manifest, VariablesDoc, DesignSystemDoc, DesignSystemStyles, CatalogComponent, LayersDoc,
  Paint, Effect, VariableValue, ComposedColor, RadiusCorners, Asset,
} from "../bridge/src/doc-types.ts";
import type { ScreenReply, FullExportReply, DesignSystemReply, ListLibrariesReply } from "../bridge/src/commands.ts";
import type { ReadOptName } from "../bridge/src/read-opts.ts";

// ---- the fakes: stand-ins for Plugin API objects. code.js duck-types everything it is handed, so these
// are plain objects; the types below name only what the harness itself builds or reads back. (The real
// Plugin API typings are not visible to test/tsconfig.json — `types: ["node"]` — and would not describe
// these partial doubles anyway.)

/** Any fake Plugin API object: a scene node, a page, a style, a main component, a write target. */
interface FakeNode {
  type?: string;
  name?: string;
  id?: string;
  visible?: boolean;
  children?: readonly FakeNode[];
  [field: string]: unknown;
}
interface FakeVariable {
  id: string; name: string; resolvedType: string; variableCollectionId: string;
  scopes: string[]; codeSyntax: Record<string, string>; remote: boolean;
  description?: string; hiddenFromPublishing?: boolean; key?: string;
  /** raw Plugin API values: RGBA, number, or a VARIABLE_ALIAS — code.js decodes them */
  valuesByMode: Record<string, unknown>;
}
interface FakeCollection { id: string; name: string; modes: Array<{ modeId: string; name: string }>; defaultModeId: string }
interface FakeImage { getSizeAsync(): Promise<{ width: number; height: number }>; getBytesAsync(): Promise<Uint8Array> }
/** What the plugin posts to its UI (progress.ts): run-begin / progress / run-end frames. */
interface PostedMessage {
  type: string; source?: string; label?: string; phase?: string;
  page?: { index: number; of: number; name: string; pageId?: string };
  nodes?: number; assets?: number;
}
interface FakeTeamLibrary {
  getAvailableLibraryVariableCollectionsAsync(): Promise<Array<{ name: string; key: string; libraryName: string }>>;
  getVariablesInLibraryCollectionAsync(key: string): Promise<Array<{ name: string; key: string; resolvedType: string }>>;
}
interface FakeFigma {
  mixed: symbol;
  showUI(): void;
  on(): void;
  ui: { onmessage: null; postMessage(m: PostedMessage): void };
  clientStorage: { getAsync(): Promise<string>; setAsync(): Promise<void> };
  currentPage: FakeNode & { selection: FakeNode[]; appendChild?: () => void };
  fileKey: string;
  root: { name: string; documentColorProfile: string; children: FakeNode[]; getPluginData?: (key: string) => string };
  loadAllPagesAsync(): Promise<void>;
  getImageByHash(hash: string): FakeImage | null;
  getNodeByIdAsync(id: string): Promise<FakeNode | null>;
  getStyleByIdAsync(id: string): Promise<FakeNode | null>;
  getLocalPaintStylesAsync(): Promise<FakeNode[]>;
  getLocalTextStylesAsync(): Promise<FakeNode[]>;
  getLocalEffectStylesAsync(): Promise<FakeNode[]>;
  getLocalGridStylesAsync(): Promise<FakeNode[]>;
  variables: {
    getLocalVariablesAsync(): Promise<FakeVariable[]>;
    getLocalVariableCollectionsAsync(): Promise<FakeCollection[]>;
    getVariableByIdAsync(id: string): Promise<FakeVariable | null>;
    getVariableCollectionByIdAsync(id: string): Promise<FakeCollection | null>;
  };
  // installed / removed by individual sections below
  editorType?: string;
  teamLibrary?: FakeTeamLibrary;
  skipInvisibleInstanceChildren?: boolean;
  createFrame?: () => FakeNode;
  createText?: () => FakeNode;
  loadFontAsync?: () => Promise<void>;
}

// ---- what code.js's `__designExport` hands back, typed by the producer contract the bridge consumes
// (bridge/src/doc-types.ts and the per-command replies in bridge/src/commands.ts). The plugin source
// builds these same doc-types shapes (serialize() returns IrNode, buildDesignSystem a DesignSystemDoc,
// the collectors the envelopes in figma-plugin/src/collect.ts), but its program — Plugin API typings
// included — is not visible to test/tsconfig.json, so the contract is restated here from doc-types.

/** A variables dump (variables.ts dumpVariables): all three arrays are always present. */
type DumpedVariables = VariablesDoc & Required<Pick<VariablesDoc, "collections" | "variables" | "hygiene">>;
/** components.ts buildDesignSystem: every section is always present. */
type DesignSystemOut = DesignSystemDoc & Required<Pick<DesignSystemDoc, "collections" | "variables" | "components" | "hygiene">> &
  { styles: Required<DesignSystemStyles> };
/** collect.ts screenResult */
interface SelectionResult extends ScreenReply { screen: ScreenExport & { manifest: Manifest }; variables: DumpedVariables; assets: Asset[] }
/** collect.ts collectFull */
interface FullResult extends FullExportReply {
  designSystem: DesignSystemOut;
  layersDoc: LayersDoc & Required<Pick<LayersDoc, "layers" | "index" | "manifest">>;
  assets: Asset[];
}
/** collect.ts collectDesignSystemOnly / collectLibraryFile */
interface DesignSystemResult extends DesignSystemReply { designSystem: DesignSystemOut }
/** collect.ts summarize(): the ONLY shape the cheap index reads emit. The `undefined` fields are
 *  never emitted — an index is not an export (the [LIST]/[CHILDREN] checks assert exactly that). */
interface NodeSummary {
  name: string; id: string; type: string; w?: number; h?: number; hidden?: true; hasChildren?: boolean;
  children?: undefined; fills?: undefined; layout?: undefined; tokens?: undefined;
}
interface ListPagesResult {
  exportedAt: string; file: string; depth: number;
  pages: Array<{ name: string; id: string; current?: true; unreadable?: true; frames?: NodeSummary[] }>;
  manifest: { pages: number; frames?: number; warnings: string[] };
  /** never emitted (asserted) */
  assets?: undefined;
}
interface ListChildrenResult {
  exportedAt: string; id: string; name: string; type: string; children: NodeSummary[];
  manifest: { children: number; warnings: string[] };
  /** never emitted (asserted) */
  assets?: undefined;
}
type LibrariesOut = ListLibrariesReply;
/** writes.ts WriteResult (applied rows are `{ id }`) */
interface WriteResult { ok: boolean; applied: Array<{ id?: string }>; failedAt?: number; failedOp?: string; error?: string }
interface WriteOp { op: string; [field: string]: unknown }
/** progress.ts RunInfo */
interface RunInfo { source: "ui" | "bridge"; label: string }
/** collect.ts CollectOpts */
interface CollectOpts extends Partial<Record<ReadOptName, boolean>> { allPages?: boolean; page?: string | string[] }
interface DesignExportApi {
  serialize(node: FakeNode, depth: number, parentControlsLayout?: boolean): Promise<IrNode>;
  collectSelection(opts?: CollectOpts): Promise<SelectionResult>;
  collectFull(opts?: CollectOpts): Promise<FullResult>;
  collectDesignSystemOnly(opts?: CollectOpts): Promise<DesignSystemResult>;
  collectLibraryFile(opts?: CollectOpts & { asLibrary?: string }): Promise<DesignSystemResult>;
  buildDesignSystem(): Promise<DesignSystemOut>;
  listPages(opts?: { depth?: number }): Promise<ListPagesResult>;
  listChildren(rawId: string): Promise<ListChildrenResult>;
  listLibraries(): Promise<LibrariesOut>;
  collectLibraryComponents(sink?: (m: string) => void): Promise<CatalogComponent[]>;
  applyWrites(ops?: WriteOp[]): Promise<WriteResult>;
  serializeRun<T>(fn: () => Promise<T>, run: RunInfo): Promise<T>;
  requestCancel(): RunInfo | null;
}
/** The VM global object after the lift below: the export API plus the fake `figma` it reads. */
type Sandbox = DesignExportApi & { figma: FakeFigma };

/** A caught error's message, without trusting its realm: code.js throws the VM context's Error, which
 *  is not `instanceof` this realm's. */
interface Thrown { message: string }
const thrown = (e: unknown): Thrown =>
  (typeof e === "object" && e !== null && "message" in e && typeof e.message === "string" ? { message: e.message } : { message: String(e) });

// ---- reading union-typed output without narrowing first (the assertions check `type` themselves)
/** Every field any member of a discriminated union may carry, all optional. Each member is assignable
 *  to it, so `flat()` is a widening, not a cast: a field the actual member lacks reads `undefined`,
 *  exactly as it did untyped. */
type AnyOf<U> = { [K in U extends unknown ? keyof U : never]?: U extends unknown ? (K extends keyof U ? U[K] : never) : never };
const flatPaint = (p: Paint): AnyOf<Paint> => p;
const flatEffect = (e: Effect): AnyOf<Effect> => e;
/** A variable's per-mode value's alias target — `undefined` for a raw value, like `.aliasOf` on it was. */
const aliasOf = (v: VariableValue): string | undefined => (typeof v === "object" && "aliasOf" in v ? v.aliasOf : undefined);
/** A variable's per-mode value's composed-colour halves — `undefined` for anything else. */
const composedOf = (v: VariableValue | undefined): ComposedColor | undefined => (typeof v === "object" && "composed" in v ? v.composed : undefined);


const MIXED = Symbol("figma.mixed");

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
    { characters: "Hello ", fontName: { family: "Inter", style: "Regular" }, fontSize: 24, lineHeight: { unit: "PERCENT", value: 120 }, letterSpacing: { unit: "PIXELS", value: 0.5 }, textCase: "ORIGINAL", textDecoration: "NONE", fills: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 1 }], hyperlink: null, listOptions: { type: "NONE" }, boundVariables: {} },
    { characters: "World", fontName: { family: "Inter", style: "Bold" }, fontSize: 24, fontWeight: 700, lineHeight: { unit: "PERCENT", value: 120 }, letterSpacing: { unit: "PIXELS", value: 0.5 }, textCase: "ORIGINAL", textDecoration: "UNDERLINE", textDecorationThickness: { value: 2, unit: "PIXELS" }, textDecorationOffset: { value: 1, unit: "PIXELS" }, textDecorationSkipInk: false, fills: [{ type: "SOLID", visible: true, color: { r: 0.1, g: 0.3, b: 0.9 }, opacity: 1 }], hyperlink: { type: "URL", value: "https://x.com" }, listOptions: { type: "NONE" }, indentation: 1, openTypeFeatures: { SMCP: true, LIGA: false }, textStyleId: "s_heading", fillStyleId: "s_brand", boundVariables: { fills: { type: "VARIABLE_ALIAS", id: "v_primary" } } },
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

// ---- mock figma ----
const noop = () => {};
const figma: FakeFigma = {
  mixed: MIXED,
  showUI: noop, on: noop,
  ui: { onmessage: null, postMessage: noop },
  clientStorage: { getAsync: async () => "", setAsync: async () => {} },
  currentPage: {
    name: "Page 1", selection: [scrollFrame], children: [scrollFrame],
    // Dev-Mode measurement redlines — SYNCHRONOUS API (getMeasurements, not *Async).
    getMeasurements: () => [{ start: { node: { id: "1:0" }, side: "LEFT" }, end: { node: { id: "1:1" }, side: "RIGHT" }, offset: { type: "OUTER", fixed: 16 }, freeText: "16" }],
  },
  fileKey: "FILEKEY1234567",
  root: { name: "My File", documentColorProfile: "DISPLAY_P3", children: [{ name: "Page 1", children: [scrollFrame], findAllWithCriteria: () => [buttonComponent] }] },
  loadAllPagesAsync: async () => {},
  // Source-image resolution: intrinsic pixel size + original uploaded bytes, keyed by image hash.
  getImageByHash: (hash: string) => (hash === "abc123" ? { getSizeAsync: async () => ({ width: 800, height: 600 }), getBytesAsync: async () => new Uint8Array([1, 2, 3, 4]) } : null),
  getNodeByIdAsync: async (id: string) => (id === "frame_2" ? { name: "Details" } : null),
  getStyleByIdAsync: async (id: string) => { const styles: Record<string, FakeNode> = { s_heading: { name: "Heading/H1" }, s_brand: { name: "Brand/Primary" } }; return styles[id] || null; },
  getLocalPaintStylesAsync: async () => [{ name: "Brand/Primary", id: "s_brand", key: "paintkey123", paints: [{ type: "SOLID", visible: true, color: { r: 0.1, g: 0.3, b: 0.9 }, opacity: 1 }], boundVariables: { paints: { type: "VARIABLE_ALIAS", id: "v_allscope" } }, documentationLinks: [{ uri: "https://docs.example.com/brand" }], description: "", getPublishStatusAsync: async () => "CHANGED" }],
  getLocalTextStylesAsync: async () => [{ name: "Body/Regular", fontSize: 16, fontName: { family: "Inter", style: "Regular" }, lineHeight: { unit: "AUTO" }, letterSpacing: { unit: "PIXELS", value: 0 }, textCase: "ORIGINAL", textDecoration: "NONE", paragraphSpacing: 8, paragraphIndent: 4, leadingTrim: "CAP_HEIGHT", listSpacing: 6, boundVariables: { fontSize: { type: "VARIABLE_ALIAS", id: "v_allscope" } }, description: "" }],
  getLocalEffectStylesAsync: async () => [],
  getLocalGridStylesAsync: async () => [{ name: "Grid/12col", layoutGrids: [{ pattern: "COLUMNS", count: 12, gutterSize: 20, sectionSize: 60 }], description: "" }],
  variables: {
    getLocalVariablesAsync: async () => Object.values(VARS),
    getLocalVariableCollectionsAsync: async () => COLLECTIONS,
    getVariableByIdAsync: async (id: string) => VARS[id] || null,
    getVariableCollectionByIdAsync: async (id: string) => COLLECTIONS.find((c) => c.id === id) || null,
  },
};

// ---- load code.js into a VM sandbox ----
const src = fs.readFileSync(path.join(import.meta.dirname, "..", "figma-plugin", "code.js"), "utf8");
const context: Record<string, unknown> = { figma, __html__: "<ui/>", Promise, JSON, Math, Array, Object, Symbol, Map, Set, Date, console, parseInt, Number, String, Boolean, isNaN, undefined };
vm.createContext(context);
vm.runInContext(src, context);
// code.js is now an esbuild IIFE bundle (TypeScript source in figma-plugin/src/). It exposes the
// read API on a namespaced global; lift those onto the sandbox so the assertions below read as before.
Object.assign(context, context.__designExport || {});
// The one VM boundary: what code.js put on its global is untyped to this realm (see DesignExportApi).
const sandbox = context as unknown as Sandbox;

// ---- run + assert ----
(async () => {
  const sel = await sandbox.collectSelection();
  const tree = sel.screen.nodes[0];
  const [txt, rect, btn] = tree.children!;

  ok("manifest present", sel.screen.manifest && typeof sel.screen.manifest.nodes === "number");
  ok("manifest counted nodes (>=4)", sel.screen.manifest.nodes >= 4);
  ok("scroll frame -> clip", tree.clip === true);
  ok("scroll frame -> scroll:vertical", tree.scroll === "vertical");
  ok("scroll frame -> sizeLimits.maxWidth", !!(tree.sizeLimits && tree.sizeLimits.maxWidth === 400));
  ok("layout flex column + gap + padding", !!(tree.layout && tree.layout.flexDirection === "column" && tree.layout.gap === 12 && Array.isArray(tree.layout.padding)));

  // ---- primaryAxisAlignItems SPACE_EVENLY / SPACE_AROUND (Figma Update 137) -> justifyContent ----
  const evenlyFrame = { type: "FRAME", name: "Evenly", visible: true, id: "al:1", width: 100, height: 20,
    layoutMode: "HORIZONTAL", paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
    primaryAxisAlignItems: "SPACE_EVENLY", counterAxisAlignItems: "MIN", children: [] };
  const evenlyOut = await sandbox.serialize(evenlyFrame, 0, false);
  ok("[SPACE_EVENLY] -> justifyContent: space-evenly", evenlyOut.layout!.justifyContent === "space-evenly");
  const aroundFrame = { type: "FRAME", name: "Around", visible: true, id: "al:2", width: 100, height: 20,
    layoutMode: "HORIZONTAL", paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
    primaryAxisAlignItems: "SPACE_AROUND", counterAxisAlignItems: "MIN", children: [] };
  const aroundOut = await sandbox.serialize(aroundFrame, 0, false);
  ok("[SPACE_AROUND] -> justifyContent: space-around", aroundOut.layout!.justifyContent === "space-around");
  // counterAxisAlignItems still maps as before (unaffected by the SPACE_EVENLY/SPACE_AROUND addition).
  const counterFrame = { type: "FRAME", name: "Counter", visible: true, id: "al:3", width: 100, height: 20,
    layoutMode: "HORIZONTAL", paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
    primaryAxisAlignItems: "MIN", counterAxisAlignItems: "CENTER", children: [] };
  const counterOut = await sandbox.serialize(counterFrame, 0, false);
  ok("[counterAxisAlignItems] CENTER -> alignItems: center (unchanged)", counterOut.layout!.alignItems === "center");

  ok("text mixed -> runs[] with 2", Array.isArray(txt.runs) && txt.runs.length === 2);
  ok("text run weight verbatim (Bold)", txt.runs![1].font.weight === "Bold");
  ok("text run numeric weight from segment fontWeight", txt.runs![1].font.weightValue === 700);
  ok("text run underline decoration", txt.runs![1].font.decoration === "underline");
  ok("text run href", txt.runs![1].href === "https://x.com");
  ok("lineHeight unit carried (percent)", !!(txt.font!.lineHeight && txt.font!.lineHeight.unit === "percent"));
  ok("letterSpacing unit carried (px)", !!(txt.font!.letterSpacing && txt.font!.letterSpacing.unit === "px"));
  ok("paragraphSpacing", txt.font!.paragraphSpacing === 8);

  // --- new READ additions (Batch: close the read gap) ---
  ok("node id captured", txt.id === "1:1");
  ok("text vertical align", txt.font!.valign === "center");
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
  ok("COLUMNS grid keeps its sectionSize as `size` (only GRID's cell size was read after the de-any)", abs.layoutGrids![0].size === 60);
  ok("dev-mode annotations captured", Array.isArray(abs.annotations) && abs.annotations[0].label === "Use spacing token md");
  ok("devStatus captured", abs.devStatus === "ready_for_dev");
  ok("gradient transform carried", Array.isArray(flatPaint(abs.fills![0]).transform) && flatPaint(abs.fills![0]).transform![0][0] === 1);
  ok("image hash carried", flatPaint(abs.fills![1]).hash === "abc123");
  ok("image intrinsicSize via getImageByHash", !!(flatPaint(abs.fills![1]).intrinsicSize && flatPaint(abs.fills![1]).intrinsicSize!.w === 800 && flatPaint(abs.fills![1]).intrinsicSize!.h === 600));
  ok("stroke cap + join carried", abs.strokes!.cap === "round" && abs.strokes!.join === "round");

  ok("gradient stops carried", rect.fills![0].type === "gradient" && Array.isArray(rect.fills![0].stops) && rect.fills![0].stops.length === 2);
  ok("gradient stop color hex", flatPaint(rect.fills![0]).stops![0].color === "#ff0000");
  ok("per-side stroke weights (mixed fallback)", !!(rect.strokes!.weights && rect.strokes!.weights.bottom === 2));
  ok("effects ordered array len 2", Array.isArray(rect.effects) && rect.effects.length === 2);
  ok("drop_shadow discriminated", rect.effects![0].type === "drop_shadow" && rect.effects![0].offset!.y === 2);
  ok("background_blur no offset", rect.effects![1].type === "background_blur" && flatEffect(rect.effects![1]).offset === undefined);
  ok("per-corner radius (mixed fallback)", !!(rect.radius && (rect.radius as RadiusCorners).tl === 8 && (rect.radius as RadiusCorners).bl === undefined));

  // Two things used to land in `radius` that a builder then copied verbatim into CSS.
  const pill = await sandbox.serialize(
    { type: "RECTANGLE", name: "Pill", visible: true, id: "r:full", width: 120, height: 32,
      absoluteBoundingBox: { x: 0, y: 0, width: 120, height: 32 }, cornerRadius: 1000000000 }, 0, false);
  ok("radius: Figma's 'fully rounded' sentinel is not emitted as 1000000000", pill.radius !== 1000000000);
  ok("radius: it is clamped to what Figma actually renders — half the shorter side", pill.radius === 16);
  ok("radius: and the INTENT survives as radiusFull, so a builder can emit 50% / .infinity", pill.radiusFull === true);
  const dusty = await sandbox.serialize(
    { type: "RECTANGLE", name: "Card", visible: true, id: "r:dust", width: 100, height: 100,
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 }, cornerRadius: 60.00000762939453 }, 0, false);
  ok("radius: float dust from a resize is rounded like every other emitted number", dusty.radius === 60);
  ok("radius: an ordinary radius carries no radiusFull flag", dusty.radiusFull === undefined);

  ok("instance main component name", btn.component === "Button");
  ok("mainComponent join keys captured (id/key)", !!(btn.mainComponent && btn.mainComponent.id === "comp:btn1" && btn.mainComponent.key === "compkey_btn"));
  ok("mainComponent set join keys captured (setId/setKey)", btn.mainComponent!.setId === "set:btn" && btn.mainComponent!.setKey === "setkey_btn");
  ok("mainComponent variant name kept separately from the set name", btn.mainComponent!.setName === "ButtonSet" && btn.mainComponent!.variant === "Button");

  // A remote main whose `.parent` is NULL (plugin-api.d.ts documented shape) must not throw, and
  // must emit id/key with NO setId/setKey (there is no set to join to).
  const remoteInst = { type: "INSTANCE", name: "RemoteBtn", visible: true, getMainComponentAsync: async () => ({ name: "Icon", id: "rc:1", key: "rk:1", remote: true, parent: null }) };
  const remoteSer = await sandbox.serialize(remoteInst, 0, false);
  ok("remote main with null parent: id/key captured, no setId/setKey", !!(remoteSer.mainComponent && remoteSer.mainComponent.id === "rc:1" && remoteSer.mainComponent.remote === true && remoteSer.mainComponent.setId === undefined));
  ok("bound token resolved to name", !!(btn.tokens && btn.tokens.fills === "color/primary"));
  ok("reactions extracted", Array.isArray(btn.reactions) && btn.reactions.length === 1);
  ok("reaction trigger", btn.reactions![0].trigger === "on_click");
  ok("reaction navigation + destination name", btn.reactions![0].actions![0].navigation === "navigate" && btn.reactions![0].actions![0].destination === "Details");
  ok("reaction transition easing (lowercased)", btn.reactions![0].actions![0].transition!.easing === "custom_cubic_bezier");

  const ds = await sandbox.buildDesignSystem();
  const primary = ds.variables.find((v) => v.name === "color/primary");
  ok("variable tier semantic", !!(primary && primary.tier === "semantic"));
  ok("variable codeSyntax carried", !!(primary && primary.codeSyntax && primary.codeSyntax.WEB === "var(--color-primary)"));
  ok("variable alias re-keyed by mode name", !!(primary && primary.values.Light && aliasOf(primary.values.Light) === "blue/600"));
  ok("COLOR primitive folded to hex", ds.variables.find((v) => v.name === "blue/600")!.values.Value === "#1a4de6");
  ok("variable hiddenFromPublishing captured", ds.variables.find((v) => v.name === "blue/600")!.hiddenFromPublishing === true);
  ok("variable key captured (durable identity)", ds.variables.find((v) => v.name === "blue/600")!.key === "varkey_blue600");
  ok("public variable has no hiddenFromPublishing flag", primary!.hiddenFromPublishing === undefined);
  ok("hygiene: ALL_SCOPES flagged", ds.hygiene.some((h) => h.indexOf("ALL_SCOPES") !== -1));
  // tier regression: a raw (non-alias) variable whose only scope is the ALL_SCOPES default is a
  // primitive, not semantic — ALL_SCOPES must not be treated as a meaningful scope.
  ok("tier: raw + ALL_SCOPES-only => primitive", (ds.variables.find((v) => v.name === "misc/bad") || {}).tier === "primitive");
  ok("paint style carries color value", !!(ds.styles.paint[0] && ds.styles.paint[0].paints && flatPaint(ds.styles.paint[0].paints[0]).color === "#1a4de6"));
  ok("grid style exported", ds.styles.grid && ds.styles.grid[0] && Array.isArray(ds.styles.grid[0].grids) && ds.styles.grid[0].grids[0].count === 12);

  // collectDesignSystemOnly — the --design-system / figma_export_design_system path: no page/frame
  // walk, no assets, just { designSystem }. Exercises the actual collector (not just buildDesignSystem
  // directly), since collectDesignSystemOnly is a resetRun()+applyOpts() wrapper around it.
  const dsOnly = await sandbox.collectDesignSystemOnly();
  ok("collectDesignSystemOnly returns ONLY a designSystem (no layersDoc/assets keys)",
    !!dsOnly.designSystem && !("layersDoc" in dsOnly) && !("assets" in dsOnly));
  ok("collectDesignSystemOnly's designSystem carries the same variable/style/component data as buildDesignSystem",
    dsOnly.designSystem.variables.some((v) => v.name === "color/primary") &&
    Array.isArray(dsOnly.designSystem.styles.paint) && Array.isArray(dsOnly.designSystem.components));
  // The one documented gap (see collect.ts): with no page walk, the note lands in `hygiene` — the ONE
  // field buildDesignSystemLayout's split actually persists to disk (hygiene.json) and forwards
  // through the MCP writeToDisk path, unlike a `manifest.warnings` field the split would drop.
  ok("collectDesignSystemOnly notes the library-variable limitation in hygiene (the field that survives to disk)",
    dsOnly.designSystem.hygiene.some((h) => /library \(remote\) variables/.test(h)));

  // --- new READ additions (Tier 1: variable modes, prop-driven wiring, reference render, token bindings) ---
  ok("variable mode pin resolved to names", !!(tree.variableModes && tree.variableModes.Semantic === "Dark"));
  // Effective/inherited theme at the export root (resolvedVariableModes) — the fix for ancestor/page
  // pins on single-node exports. Multi-mode collection reported by name; single-mode one filtered out.
  ok("resolved (inherited) modes at root", !!(tree.resolvedModes && tree.resolvedModes.Semantic === "Dark"));
  ok("resolvedModes filters single-mode collections", !!(tree.resolvedModes && tree.resolvedModes.Primitives === undefined));
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
  // Named from the LAYER, not from the node-id path. An app importing 41 icons used to import 41
  // filenames like `I10970_111374_1910_23337_1902_19173.svg` (live finding 96) while the layer name
  // sat unused right beside it in the tree.
  ok("the reference PNG keeps its <id>_ref.png name — build-screen looks it up by id",
    sel.assets.some((a) => a.kind === "reference" && /_ref\.png$/.test(a.file)));
  ok("every asset carries a content hash, so a consumer can spot duplicates without diffing bytes",
    sel.assets.every((a) => typeof a.hash === "string" && a.hash.length > 0));
  ok("componentPropertyReferences -> propRefs (stripped)", !!(txt.propRefs && txt.propRefs.characters === "Label"));
  ok("instance overrides captured (empty filtered)", Array.isArray(btn.overrides) && btn.overrides.length === 1 && btn.overrides[0].fields.indexOf("characters") !== -1);
  ok("text run bound variable -> token name", !!(txt.runs![1].tokens && txt.runs![1].tokens.fills === "color/primary"));
  ok("effect bound variable -> token name", !!(rect.effects![0].tokens && rect.effects![0].tokens.radius === "misc/bad"));
  // matchLayers lives on DirectionalTransition only (MOVE_IN/OUT, PUSH, SLIDE_IN/OUT); SimpleTransition
  // (DISSOLVE, SMART_ANIMATE, SCROLL_ANIMATE) has no such field — developers.figma.com/docs/plugins/api/Transition/.
  ok("transition matchLayers carried", btn.reactions![0].actions![0].transition!.matchLayers === true);
  ok("transition type/direction carried", btn.reactions![0].actions![0].transition!.type === "move_in" && btn.reactions![0].actions![0].transition!.direction === "left");
  ok("transition custom cubic-bezier carried", btn.reactions![0].actions![0].transition!.easing === "custom_cubic_bezier" && btn.reactions![0].actions![0].transition!.cubicBezier!.x1 === 0.4);
  const btnComp = ds.components.find((c) => c.name === "Button");
  ok("component description captured", !!(btnComp && btnComp.description === "Primary action button"));
  ok("INSTANCE_SWAP preferredValues captured", !!(btnComp && btnComp.props!.Icon && btnComp.props!.Icon.type === "INSTANCE_SWAP" && Array.isArray(btnComp.props!.Icon.preferredValues) && btnComp.props!.Icon.preferredValues.length === 2));

  // --- READ additions (verified vs developers.figma.com 2026-07-23): bug fix + HIGH tier + MED ---
  // BUG FIX: progressive-blur startOffset/endOffset are Vectors {x,y}, not numbers (were dropped).
  ok("progressive blur endOffset Vector kept", !!(flatEffect(abs.effects![0]).blurType === "progressive" && flatEffect(abs.effects![0]).endOffset && flatEffect(abs.effects![0]).endOffset!.y === 1));
  ok("noise effect fields", abs.effects![1].type === "noise" && abs.effects![1].noiseType === "multitone" && abs.effects![1].opacity === 0.3);
  ok("glass effect fields", abs.effects![2].type === "glass" && abs.effects![2].refraction === 0.2 && abs.effects![2].depth === 4);
  ok("image filters carried", !!(flatPaint(abs.fills![1]).filters && flatPaint(abs.fills![1]).filters!.saturation === -0.5 && flatPaint(abs.fills![1]).filters!.exposure === undefined));
  ok("pattern paint fields", abs.fills![2].type === "pattern" && abs.fills![2].sourceNodeId === "9:99" && abs.fills![2].tileType === "rectangular");
  ok("absolute bounding box -> box", !!(abs.box && abs.box.w === 100 && abs.box.h === 50));
  ok("render box emitted when it differs", !!(abs.renderBox && abs.renderBox.h === 56));
  ok("maskType (luminance) carried", abs.maskType === "luminance");
  ok("cornerSmoothing carried", abs.cornerSmoothing === 0.6);
  ok("targetAspectRatio -> ratio", abs.aspectRatio === 1.78);
  ok("detachedInfo (library key)", !!(abs.detachedFrom && abs.detachedFrom.key === "libkey123"));
  ok("overlay settings (scrim + close-on-click-outside)", !!(abs.overlay && abs.overlay.closeOnClickOutside === true && abs.overlay.background && abs.overlay.position === "center"));
  ok("annotation categoryId", Array.isArray(abs.annotations) && abs.annotations[0].categoryId === "cat_spacing");

  ok("resolved box on auto-layout root", !!(tree.box && tree.box.w === 375));
  ok("strokesIncludedInLayout flagged", tree.strokesInLayout === true);
  ok("dev-resource links batched at root", Array.isArray(tree.devResources) && tree.devResources[0].url.indexOf("sb.example.com") !== -1);

  ok("per-run textStyle resolved", txt.runs![1].textStyle === "Heading/H1");
  ok("per-run fillStyle resolved", txt.runs![1].fillStyle === "Brand/Primary");
  ok("per-run openType features (enabled only)", Array.isArray(txt.runs![1].font.openType) && txt.runs![1].font.openType.indexOf("SMCP") !== -1 && txt.runs![1].font.openType.indexOf("LIGA") === -1);
  ok("per-run list indentation level", txt.runs![1].indent === 1);

  const acts = btn.reactions![0].actions;
  ok("NODE action preserveScroll flag", acts![0].preserveScroll === true);
  ok("SET_VARIABLE resolves variable name", acts!.some((a) => a.type === "set_variable" && a.variable === "color/primary"));
  ok("SET_VARIABLE_MODE resolves collection+mode names", acts!.some((a) => a.type === "set_variable_mode" && a.collection === "Semantic" && a.mode === "Dark"));
  ok("UPDATE_MEDIA_RUNTIME keeps destinationId + resolved destination name",
    acts!.some((a) => a.type === "update_media_runtime" && a.mediaAction === "play" && a.destinationId === "frame_2" && a.destination === "Details"));
  ok("CONDITIONAL nests actions", acts!.some((a) => a.type === "conditional" && Array.isArray(a.conditionalBlocks) && a.conditionalBlocks[0].actions![0].destination === "Details"));
  const urlNewTab = acts!.find((a) => a.type === "url" && a.url === "https://newtab.example.com");
  const urlSameTab = acts!.find((a) => a.type === "url" && a.url === "https://sametab.example.com");
  ok("URL action emits openInNewTab when true", !!urlNewTab && urlNewTab.openInNewTab === true);
  ok("URL action omits openInNewTab when unset", !!urlSameTab && !("openInNewTab" in urlSameTab));

  ok("collection defaultModeId -> mode name", ds.collections.find((c) => c.name === "Semantic")!.default === "Light");
  ok("variable description captured", ds.variables.find((v) => v.name === "color/primary")!.description === "Primary brand color");
  ok("document color profile", ds.colorProfile === "display_p3");
  ok("document file name", ds.file === "My File");
  ok("component publish key captured", btnComp!.key === "compkey123");
  ok("component documentationLinks captured", Array.isArray(btnComp!.docs) && btnComp!.docs[0].indexOf("docs.example.com") !== -1);

  const tableNode = { type: "TABLE", name: "Data", visible: true, id: "20:0", numRows: 2, numColumns: 2,
    cellAt: (r: number, c: number) => ({ text: { characters: "r" + r + "c" + c }, fills: [{ type: "SOLID", visible: true, color: { r: 1, g: 1, b: 1 }, opacity: 1 }], rowSpan: 1, columnSpan: 1 }) };
  const tbl = await sandbox.serialize(tableNode, 0, false);
  ok("table cells traversed via cellAt", Array.isArray(tbl.tableCells) && tbl.tableCells.length === 2 && tbl.tableCells[0][0].text === "r0c0");

  // --- READ additions (2026-07-23 fresh 3-agent doc audit): bug fixes + grid fidelity + prop/style bindings ---
  // BUG FIX: textDecorationThickness/Offset are { value:number, unit } — .value IS the number (was read as .value.value → always dropped).
  ok("text decoration thickness (value+unit)", !!(txt.runs![1].font.decorationThickness && txt.runs![1].font.decorationThickness.value === 2 && txt.runs![1].font.decorationThickness.unit === "px"));
  ok("text decoration offset (value+unit)", !!(txt.runs![1].font.decorationOffset && txt.runs![1].font.decorationOffset.value === 1));
  ok("text decoration skip-ink (only when false)", txt.runs![1].font.decorationSkipInk === false);

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
  ok("grid track sizes (fixed px + flex fr)", gf.layout!.display === "grid" && Array.isArray(gf.layout!.columnSizes) && gf.layout!.columnSizes[0].type === "fixed" && gf.layout!.columnSizes[0].value === 200 && gf.layout!.columnSizes[1].type === "flex");
  ok("grid HUG track (value-less) handled", gf.layout!.columnSizes![2].type === "hug" && gf.layout!.columnSizes![2].value === undefined);
  ok("grid child anchor index (start cell)", abs.gridColumnStart === 1 && abs.gridRowStart === 0);
  ok("grid child cell align (justify/align-self)", abs.gridJustifySelf === "center" && abs.gridAlignSelf === "end");

  ok("shader paint id captured", abs.fills![3] && abs.fills![3].type === "shader" && abs.fills![3].shaderId === "shader_1");
  ok("devStatus free-text note captured", abs.devStatusNote === "blocked on API");
  ok("instance component-prop variable binding -> propTokens", !!(btn.propTokens && btn.propTokens.Label === "color/primary"));

  const bodyStyle = ds.styles.text.find((s) => s.name === "Body/Regular");
  ok("text style leadingTrim + listSpacing + paragraphIndent", !!(bodyStyle && bodyStyle.leadingTrim === "cap_height" && bodyStyle.listSpacing === 6 && bodyStyle.paragraphIndent === 4));
  ok("text style variable binding (fontSize -> token)", !!(bodyStyle && bodyStyle.tokens && bodyStyle.tokens.fontSize === "misc/bad"));

  // --- Tier-1 read additions ---
  // [AUDIT-6b] inferredVariables USED to be emitted as `inferredTokens` for every unbound field. It
  // measured 20.5% of a real payload (2,151 occurrences) with zero consumers, and the matches are
  // value-coincidence. The mock still SUPPLIES inferredVariables on scrollFrame, so this pins that the
  // extractor ignores it rather than that the fixture stopped providing it.
  ok("[AUDIT-6b] inferredTokens is no longer emitted", (tree as IrNode & { inferredTokens?: unknown }).inferredTokens === undefined);
  ok("[AUDIT-6b] and no inferred* key leaks under another name", !Object.keys(tree).some((k) => /^inferred/.test(k)));
  // css / measurements / pluginData are OPT-IN — off by default.
  // css now AUTO-ENABLES for a small single selection (the "inspect one component" path). scrollFrame
  // is tiny (4 nodes), so the CSS oracle comes back without an explicit opt-in.
  ok("css auto-on for small single selection", !!(tree.css && tree.css.display === "flex" && tree.css.padding === "16px"));
  ok("pluginData still off by default (not auto-enabled)", tree.pluginData === undefined);
  const sel2 = await sandbox.collectSelection({ css: true, measurements: true, pluginData: true });
  const tree2 = sel2.screen.nodes[0];
  ok("getCSSAsync -> css oracle (opt-in)", !!(tree2.css && tree2.css.display === "flex" && tree2.css.padding === "16px"));
  ok("own-scope plugin data captured (opt-in)", !!(tree2.pluginData && tree2.pluginData.codeConnect === "Button/Primary"));
  ok("measurements captured via sync getMeasurements (opt-in)", Array.isArray(sel2.screen.measurements) && sel2.screen.measurements[0].text === "16" && sel2.screen.measurements[0].start!.side === "LEFT");
  ok("motion off by default", tree.motion === undefined);
  const sel3 = await sandbox.collectSelection({ motion: true });
  const m3 = sel3.screen.nodes[0].motion;
  ok("motion timelines captured (opt-in)", !!(m3 && Array.isArray(m3.timelines) && m3.timelines[0].duration === 0.5));
  ok("motion keyframe track: base + keyframes + values", !!(m3 && m3.manualTracks!.TRANSLATION_X && m3.manualTracks!.TRANSLATION_X.base === 0 && m3.manualTracks!.TRANSLATION_X.keyframes![1].value === 100));
  ok("motion keyframe custom cubic-bezier easing carried", !!(m3 && m3.manualTracks!.TRANSLATION_X.keyframes![1].easing!.cubicBezier!.x1 === 0.4));
  ok("motion applied animation style captured", !!(m3 && m3.styles![0].name === "Fade In" && m3.styles![0].duration === 0.3));
  ok("motion animations: base + duration + per-track op/keyframes surface (was dead pre-fix)",!!(
    m3 && m3.animations!.ROTATION && m3.animations!.ROTATION.base === 0 && m3.animations!.ROTATION.duration === 1.2 &&
    m3.animations!.ROTATION.tracks![0].op === "offset" && m3.animations!.ROTATION.tracks![0].keyframes![1].value === 90));
  // Indexed collections (fills/strokes keyed by paint index, effects by effect index) used to come out
  // empty — every value was read as one binding — and were dropped. Pin each shape.
  const mt = m3!.manualTracks!;
  ok("motion scalar track output unchanged (TRANSLATION_X, byte-identical)", JSON.stringify(mt.TRANSLATION_X) ===
    '{"base":0,"keyframes":[{"t":0,"value":0,"easing":{"type":"ease_out"}},{"t":0.5,"value":100,"easing":{"type":"custom_cubic_bezier","cubicBezier":{"x1":0.4,"y1":0,"x2":0.2,"y2":1}}}]}');
  const f0 = mt.fills?.["0"];
  ok("motion manualTracks.fills[\"0\"]: base + 2 keyframes", !!(f0 && !("properties" in f0) && f0.base === "#ff0000" &&
    f0.keyframes!.length === 2 && f0.keyframes![1].value === "#0000ff" && f0.keyframes![1].t === 1));
  ok("motion keyframe easing bound to a variable emits the alias id",
    JSON.stringify(f0 && !("properties" in f0) && f0.keyframes![1].easing) === '{"type":"variable_alias","id":"VariableID:1"}');
  const f1 = mt.fills?.["1"];
  ok("motion manualTracks.fills shader track under properties", !!(f1 && "properties" in f1 &&
    f1.properties["shader:speed"].base === 1 && f1.properties["shader:speed"].keyframes![1].value === 3));
  const s0 = mt.strokes?.["0"];
  ok("motion manualTracks.strokes[\"0\"] track", !!(s0 && !("properties" in s0) && s0.base === 0 &&
    s0.keyframes!.length === 1 && s0.keyframes![0].value === 0.5 && s0.keyframes![0].easing!.type === "ease_in"));
  const e0 = mt.effects?.["0"];
  ok("motion manualTracks.effects[\"0\"].RADIUS track", !!(e0 && e0.RADIUS.base === 4 && e0.RADIUS.keyframes!.length === 2 && e0.RADIUS.keyframes![1].value === 12));
  ok("motion manualTracks.effects[\"0\"].properties shader track", !!(e0 && e0.properties && e0.properties["shader:glow"].keyframes![0].value === 0.8));
  const an = m3!.animations!;
  ok("motion animations scalar output unchanged (ROTATION, byte-identical)", JSON.stringify(an.ROTATION) ===
    '{"base":0,"duration":1.2,"tracks":[{"op":"offset","keyframes":[{"t":0,"value":0},{"t":1,"value":90}]}]}');
  const af0 = an.fills?.["0"];
  ok("motion animations.fills[\"0\"]: base + duration + op track", !!(af0 && !("properties" in af0) && af0.base === 1 && af0.duration === 0.8 &&
    af0.tracks![0].op === "scale" && af0.tracks![0].keyframes![1].value === 0.5));
  const af2 = an.fills?.["2"];
  ok("motion animations.fills shader track under properties (SET op omitted)", !!(af2 && "properties" in af2 &&
    af2.properties["shader:phase"].duration === 3 && af2.properties["shader:phase"].tracks![0].op === undefined &&
    af2.properties["shader:phase"].tracks![0].keyframes![0].value === 6));
  const as1 = an.strokes?.["1"];
  ok("motion animations.strokes[\"1\"] track", !!(as1 && !("properties" in as1) && as1.tracks![0].op === "offset" && as1.tracks![0].keyframes![0].value === 3));
  const ae0 = an.effects?.["0"];
  ok("motion animations.effects[\"0\"].OFFSET_Y track", !!(ae0 && ae0.OFFSET_Y.duration === 0.6 && ae0.OFFSET_Y.tracks![0].keyframes![1].value === 8));
  ok("motion indexed collections follow the scalar fields", JSON.stringify(Object.keys(mt)) === '["TRANSLATION_X","fills","strokes","effects"]' &&
    JSON.stringify(Object.keys(an)) === '["ROTATION","fills","strokes","effects"]');

  // --- sharedData (cross-plugin, e.g. Tokens Studio applied tokens) is OPT-IN ---
  ok("sharedData off by default", tree.sharedData === undefined);
  const sel4 = await sandbox.collectSelection({ sharedData: true });
  const tree4 = sel4.screen.nodes[0];
  ok("sharedData: Tokens Studio applied tokens captured (opt-in)", !!(tree4.sharedData && tree4.sharedData.tokens && tree4.sharedData.tokens.fill === "color.primary" && tree4.sharedData.tokens.borderRadius === "radius.md"));

  // --- parametric shape intent: ellipse arc/donut, star/polygon points, boolean op ---
  const donut = await sandbox.serialize({ type: "ELLIPSE", name: "Ring", visible: true, id: "e:1", arcData: { startingAngle: 0, endingAngle: Math.PI * 1.5, innerRadius: 0.6 } }, 0, false);
  ok("ellipse arc/donut captured (start/end/innerRadius)", !!(donut.arc && donut.arc.end === 4.71 && donut.arc.innerRadius === 0.6));
  const fullEllipse = await sandbox.serialize({ type: "ELLIPSE", name: "Dot", visible: true, id: "e:2", arcData: { startingAngle: 0, endingAngle: Math.PI * 2, innerRadius: 0 } }, 0, false);
  ok("full ellipse emits no arc (noise-free)", fullEllipse.arc === undefined);
  const star = await sandbox.serialize({ type: "STAR", name: "Star", visible: true, id: "st:1", pointCount: 5, innerRadius: 0.4 }, 0, false);
  ok("star pointCount + innerRadius captured", !!(star.shape && star.shape.points === 5 && star.shape.innerRadius === 0.4));
  const poly = await sandbox.serialize({ type: "POLYGON", name: "Tri", visible: true, id: "pg:1", pointCount: 3 }, 0, false);
  ok("polygon pointCount captured", !!(poly.shape && poly.shape.points === 3));
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
  ok("image-backed container keeps image as background fill", Array.isArray(hero.fills) && hero.fills.some((f) => flatPaint(f).hash === "abc123"));
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
  const iconVec = (i: number) => ({ type: "VECTOR", name: "path" + i, visible: true, id: "ic:v" + i, width: 16, height: 16,
    fills: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 1 }],
    exportAsync: async () => "<svg/>" });
  const iconFrame = { type: "FRAME", name: "icon/home", visible: true, id: "ic:1", width: 24, height: 24,
    children: [iconVec(1), iconVec(2), iconVec(3)], findOne: () => null, exportAsync: async () => "<svg/>" };
  const iconSheet = { type: "FRAME", name: "Sheet", visible: true, id: "ic:0", width: 100, height: 100,
    children: [iconFrame], exportAsync: async () => new Uint8Array([137, 80, 78, 71]) };
  sandbox.figma.currentPage.selection = [iconSheet];
  const iconNormal = await sandbox.collectSelection({});
  const iconSkipped = await sandbox.collectSelection({ skipAssets: true });
  const nNode = iconNormal.screen.nodes[0].children![0], sNode = iconSkipped.screen.nodes[0].children![0];

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

  // ---- asset NAMING and DEDUPE (live findings 96/97)
  // Names came from the node-id PATH, which included the whole instance chain: an app importing 41
  // icons imported 41 filenames like `I10970_111374_1910_23337_1902_19173.svg`, and one shared
  // sidebar icon was re-exported under a different name for every screen that used it.
  const svgIcon = (id: string, name: string, body: string) => ({ type: "VECTOR", name, visible: true, id, width: 16, height: 16,
    fills: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 1 }],
    exportAsync: async () => body });
  const namedSheet = { type: "FRAME", name: "Names", visible: true, id: "an:0", width: 100, height: 100,
    children: [
      svgIcon("I1:2:3", "vuesax/linear/element-4", "<svg>A</svg>"),
      svgIcon("I9:8:7", "Side menu tabs/vuesax/linear/element-4", "<svg>A</svg>"), // same artwork, another instance path
      svgIcon("I4:5:6", "Linear / School / Diploma", "<svg>B</svg>"),
      svgIcon("I7:7:7", "misc/Diploma", "<svg>C</svg>"), // same leaf name, DIFFERENT artwork
    ],
    exportAsync: async () => new Uint8Array([137, 80, 78, 71]) };
  sandbox.figma.currentPage.selection = [namedSheet];
  const named = await sandbox.collectSelection({});
  const icons = named.assets.filter((a) => a.format === "svg");
  const fileOf = (n: string) => { const a = icons.find((x) => x.name === n); return a && a.file; };

  ok("[ASSET-NAME] an icon is named after its Figma layer, not its node-id path", fileOf("vuesax/linear/element-4") === "element-4.svg");
  ok("[ASSET-NAME] the hyphen survives — it is the commonest character in an icon name",
    icons.every((a) => a.file.indexOf("/") === -1) && fileOf("vuesax/linear/element-4")!.indexOf("-") !== -1);
  ok("[ASSET-NAME] a slash-pathed layer name files under its LAST segment, trimmed", fileOf("Linear / School / Diploma") === "Diploma.svg");
  ok("[ASSET-DEDUPE] the same artwork reached through two instance paths produces ONE file", icons.length === 3);
  ok("[ASSET-DEDUPE] and both node ids are recorded on the file that survived",!!(
    (() => { const a = icons.find((x) => x.file === "element-4.svg"); return a!.from && a!.from.indexOf("I1:2:3") !== -1 && a!.from.indexOf("I9:8:7") !== -1; })()));
  ok("[ASSET-DEDUPE] the deduped node's tree path points at that same one file",
    named.screen.nodes[0].children![1].asset === "assets/element-4.svg");
  ok("[ASSET-NAME] two DIFFERENT icons sharing a leaf name both survive, told apart by content",!!(
    (() => { const f = fileOf("misc/Diploma"); return f && f !== "Diploma.svg" && /^Diploma-[0-9a-f]{6}\.svg$/.test(f); })()));
  ok("[ASSET-NAME] every filename is still separator-free and ends in its format",
    named.assets.every((a) => a.file.indexOf("/") === -1 && a.file.endsWith("." + a.format)));
  sandbox.figma.currentPage.selection = [iconSheet];

  ok("[RD-noassets] and exportAsync did run when not skipping", exportCalls > skipCalls);
  ok("[RD-noassets] a normal run reports assetsSkipped: 0", normalRun.screen.manifest.assetsSkipped === 0);
  // Which OPT-IN reads ran. An absent `codeSyntax`/`annotations`/`measurements` used to be
  // indistinguishable from "the read was never asked for", which silently killed two of
  // build-screen's six hint tiers with nothing to say so (live finding 44).
  ok("[RD-manifest] the manifest names the opt-in reads that actually ran",
    Array.isArray(normalRun.screen.manifest.reads));
  ok("[RD-manifest] an opt-in read that was requested appears in it",
    (await sandbox.collectSelection({ measurements: true })).screen.manifest.reads!.includes("measurements"));
  ok("[RD-manifest] one that was not, does not",
    !(await sandbox.collectSelection({})).screen.manifest.reads!.includes("measurements"));
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
  sandbox.figma.variables.getVariableByIdAsync = async (id: string) => (id === "v_lib" ? LIB_VAR : prevGetVar(id));
  sandbox.figma.variables.getVariableCollectionByIdAsync = async (id: string) => (id === "c_lib" ? LIB_COLLECTION : prevGetColl(id));

  const libNode = { type: "FRAME", name: "LibCard", visible: true, id: "9:1", width: 100, height: 40,
    fills: [{ type: "SOLID", visible: true, color: { r: 1, g: 0.4, b: 0 }, opacity: 1 }],
    boundVariables: { fills: [{ type: "VARIABLE_ALIAS", id: "v_lib" }] } };
  sandbox.figma.currentPage.selection = [libNode];
  const libSel = await sandbox.collectSelection({ css: false });
  const libDump = libSel.variables.variables.find((v) => v.name === "brand/accent");
  ok("library var referenced by a node IS included in the dump", !!libDump);
  ok("library var flagged remote:true", !!(libDump && libDump.remote === true));
  ok("library var values keyed by readable mode names", !!(libDump && libDump.values && libDump.values.Light === "#ff6600"));
  ok("library var's collection is emitted (default mode for :root)", libSel.variables.collections.some((c) => c.name === "Library/Brand" && c.default === "Light"));
  ok("library pull is reported in hygiene (never silent)", libSel.variables.hygiene.some((h) => /published LIBRARY/.test(h)));
  ok("node still resolves the library token by name", !!(libSel.screen.nodes[0].tokens && libSel.screen.nodes[0].tokens.fills === "brand/accent"));
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
  const EXTRA: Record<string, FakeVariable> = { v_libmid: LIB_MID, v_libprim: LIB_PRIM, v_lib: LIB_VAR };
  sandbox.figma.variables.getVariableByIdAsync = async (id: string) => EXTRA[id] || prevGetVar(id);
  // A LOCAL semantic token whose value aliases the library chain — neither library var is node-bound.
  VARS.v_semlib = { id: "v_semlib", name: "semantic/surface", resolvedType: "COLOR", variableCollectionId: "c_sem",
    scopes: ["FRAME_FILL"], codeSyntax: {}, remote: false,
    valuesByMode: { m_light: { type: "VARIABLE_ALIAS", id: "v_libmid" }, m_dark: { type: "VARIABLE_ALIAS", id: "v_libmid" } } };

  const chainNode = { type: "FRAME", name: "ChainCard", visible: true, id: "9:2", width: 100, height: 40,
    fills: [{ type: "SOLID", visible: true, color: { r: 0.9, g: 0.9, b: 0.9 }, opacity: 1 }],
    boundVariables: { fills: [{ type: "VARIABLE_ALIAS", id: "v_semlib" }] } };
  sandbox.figma.currentPage.selection = [chainNode];
  const chainSel = await sandbox.collectSelection({ css: false });
  const cv = (n: string) => chainSel.variables.variables.find((v) => v.name === n);

  ok("[RD-alias] hop 1 (aliased library var) is included", !!cv("brand/mid"));
  ok("[RD-alias] hop 2 (alias-of-an-alias) is ALSO included — fixed point, not one extra pass", !!cv("brand/gray-100"));
  ok("[RD-alias] the pulled-in primitive carries its real VALUE, not just a name",
    !!cv("brand/gray-100") && cv("brand/gray-100")!.values.Light === "#e6e6e6");
  ok("[RD-alias] the intermediate still reads as an alias", !!(!!cv("brand/mid") && cv("brand/mid")!.values.Light &&
    aliasOf(cv("brand/mid")!.values.Light) === "brand/gray-100"));
  // The false-accusation half: every alias target resolves, so hygiene must NOT claim otherwise.
  ok("[RD-alias] no FALSE 'broken alias' hygiene line for a chain that fully resolves",
    !chainSel.variables.hygiene.some((h) => /broken alias/.test(h)));
  // And the whole point: no emitted alias may point at a name that isn't in the dump.
  ok("[RD-alias] no alias dangles — every aliasOf target exists in variables[]", (() => {
    const names = new Set(chainSel.variables.variables.map((v) => v.name));
    for (const v of chainSel.variables.variables) {
      for (const val of Object.values(v.values || {})) {
        if (val && typeof val === "object" && "aliasOf" in val && val.aliasOf && !names.has(val.aliasOf)) return false;
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
  ok("alias to a resolved library var still resolves to its name", aliasSel.variables.variables.some((v) => v.name === "color/brand" && v.values.Light && aliasOf(v.values.Light) === "brand/accent"));
  ok("a genuinely dangling alias IS still reported", aliasHyg.some((h) => /broken alias in 'color\/ghost'/.test(h)));
  ok("dangling-alias warning names the unresolved id", aliasHyg.some((h) => /v_deleted/.test(h)));
  delete VARS.v_aliases_lib;
  delete VARS.v_dangling;

  // ---- COMPOSED colour variables (plugin-typings 1.139, Figma Update 139) ----
  // VariableComposedColor = {color: RGB|RGBA, opacity: VariableAlias} | {color: VariableAlias, opacity: number|VariableAlias}.
  // Its nested alias(es) must be treated like a top-level alias: resolved to a name in the IR, pulled
  // in from the library when only the composed value references them, counted for the tier and the
  // "raw value in a multi-mode collection" hygiene check, and reported when they dangle.
  EXTRA.v_libop = { id: "v_libop", name: "brand/opacity-60", resolvedType: "FLOAT", variableCollectionId: "c_lib",
    scopes: ["COLOR_OPACITY"], codeSyntax: {}, remote: true, valuesByMode: { m_l: 60, m_d: 40 } };
  EXTRA.v_libink = { id: "v_libink", name: "brand/ink", resolvedType: "COLOR", variableCollectionId: "c_lib",
    scopes: [], codeSyntax: {}, remote: true, valuesByMode: { m_l: { r: 0, g: 0, b: 0, a: 1 }, m_d: { r: 1, g: 1, b: 1, a: 1 } } };
  // form 1: raw colour + opacity alias, in BOTH modes of a two-mode collection
  VARS.v_comp_raw = { id: "v_comp_raw", name: "overlay/scrim", resolvedType: "COLOR", variableCollectionId: "c_sem",
    scopes: ["FRAME_FILL"], codeSyntax: {}, remote: false, valuesByMode: {
      m_light: { color: { r: 0, g: 0, b: 0, a: 1 }, opacity: { type: "VARIABLE_ALIAS", id: "v_libop" } },
      m_dark: { color: { r: 1, g: 1, b: 1 }, opacity: { type: "VARIABLE_ALIAS", id: "v_libop" } } } };
  // form 2: colour alias + raw opacity (Light) / colour alias + opacity alias (Dark)
  VARS.v_comp_alias = { id: "v_comp_alias", name: "text/muted", resolvedType: "COLOR", variableCollectionId: "c_sem",
    scopes: [], codeSyntax: {}, remote: false, valuesByMode: {
      m_light: { color: { type: "VARIABLE_ALIAS", id: "v_libink" }, opacity: 50 },
      m_dark: { color: { type: "VARIABLE_ALIAS", id: "v_libink" }, opacity: { type: "VARIABLE_ALIAS", id: "v_libop" } } } };
  // a composed colour whose opacity alias dangles
  VARS.v_comp_ghost = { id: "v_comp_ghost", name: "text/ghost", resolvedType: "COLOR", variableCollectionId: "c_sem",
    scopes: ["TEXT_FILL"], codeSyntax: {}, remote: false, valuesByMode: {
      m_light: { color: { type: "VARIABLE_ALIAS", id: "v_libink" }, opacity: { type: "VARIABLE_ALIAS", id: "v_gone" } } } };
  sandbox.figma.currentPage.selection = [libNode];
  const compSel = await sandbox.collectSelection({ css: false });
  const compVar = (n: string) => compSel.variables.variables.find((v) => v.name === n);
  const scrim = compVar("overlay/scrim"), muted = compVar("text/muted");
  const scrimL = composedOf(scrim && scrim.values.Light), scrimD = composedOf(scrim && scrim.values.Dark);
  const mutedL = composedOf(muted && muted.values.Light), mutedD = composedOf(muted && muted.values.Dark);
  ok("[composed] raw colour + opacity alias -> {composed:{color:hex, opacity:{aliasOf}}}",
    JSON.stringify(scrim && scrim.values.Light) === JSON.stringify({ composed: { color: "#000000", opacity: { aliasOf: "brand/opacity-60" } } }));
  ok("[composed] a raw RGB (no alpha) colour half folds to 6-digit hex like any COLOR value", !!scrimD && scrimD.color === "#ffffff");
  ok("[composed] colour alias + raw opacity -> {composed:{color:{aliasOf}, opacity:<number verbatim>}}",
    JSON.stringify(muted && muted.values.Light) === JSON.stringify({ composed: { color: { aliasOf: "brand/ink" }, opacity: 50 } }));
  ok("[composed] both halves aliases -> both resolved to names",
    !!mutedD && typeof mutedD.color === "object" && mutedD.color.aliasOf === "brand/ink" && typeof mutedD.opacity === "object" && mutedD.opacity.aliasOf === "brand/opacity-60");
  ok("[composed] every mode of both composed variables is emitted composed", !!scrimL && !!scrimD && !!mutedL && !!mutedD);
  const libOp = compVar("brand/opacity-60"), libInk = compVar("brand/ink");
  ok("[composed] library var reached ONLY via a nested OPACITY alias is pulled in (aliasTargets)",
    !!libOp && libOp.remote === true && libOp.values.Light === 60);
  ok("[composed] library var reached ONLY via a nested COLOR alias is pulled in (aliasTargets)",
    !!libInk && libInk.values.Light === "#000000");
  ok("[composed] COLOR_OPACITY scope carried through verbatim", !!libOp && (libOp.scopes || []).includes("COLOR_OPACITY"));
  ok("[composed] a composed value counts as an alias for the tier (semantic even when unscoped)", !!muted && muted.tier === "semantic");
  ok("[composed] no 'raw value in a multi-mode collection' hygiene line for a composed colour",
    !compSel.variables.hygiene.some((h) => /semantic color '(overlay\/scrim|text\/muted)'/.test(h)));
  ok("[composed] resolved nested aliases are not called broken", !compSel.variables.hygiene.some((h) => /broken alias in '(overlay\/scrim|text\/muted)'/.test(h)));
  ok("[composed] a dangling NESTED alias is reported with its id", compSel.variables.hygiene.some((h) => /broken alias in 'text\/ghost'.*v_gone/.test(h)));
  delete VARS.v_comp_raw;
  delete VARS.v_comp_alias;
  delete VARS.v_comp_ghost;
  delete EXTRA.v_libop;
  delete EXTRA.v_libink;
  sandbox.figma.variables.getVariableByIdAsync = prevGetVar;
  sandbox.figma.variables.getVariableCollectionByIdAsync = prevGetColl;
  sandbox.figma.currentPage.selection = [scrollFrame];

  // ---- source-image container format (magic bytes, not a hardcoded ".img") ----
  const prevGetImage = sandbox.figma.getImageByHash;
  const magicRect = (hash: string) => ({ type: "RECTANGLE", name: "Photo", visible: true, id: "m:" + hash, width: 10, height: 10,
    fills: [{ type: "IMAGE", visible: true, scaleMode: "FILL", imageHash: hash }], exportAsync: async () => new Uint8Array([137, 80, 78, 71]) });
  const MAGIC = {
    png: [0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10],
    jpg: [0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46],
    gif: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 1],
    webp: [0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
  };
  for (const [fmt, bytes] of Object.entries(MAGIC)) {
    sandbox.figma.getImageByHash = (h: string) => (h === "h_" + fmt ? { getSizeAsync: async () => ({ width: 8, height: 8 }), getBytesAsync: async () => new Uint8Array(bytes) } : null);
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
  const badPage = { name: "Locked Page", get children(): FakeNode[] { throw new Error("page not loaded"); },
    findAllWithCriteria: () => { throw new Error("page not loaded"); } };
  const prevRootChildren = sandbox.figma.root.children;
  sandbox.figma.root.children = [goodPage, badPage];
  const prevLoadAll = sandbox.figma.loadAllPagesAsync;
  sandbox.figma.loadAllPagesAsync = async () => { throw new Error("load failed"); };
  let fullErr: Thrown | null = null, full: FullResult | null = null;
  try { full = await sandbox.collectFull({ allPages: true, css: false }); } catch (e) { fullErr = thrown(e); }
  ok("unreadable page does NOT abort the export", fullErr === null && !!full);
  ok("readable pages still exported alongside the bad one", !!(full && full.layersDoc.layers.length > 0));
  ok("unreadable page is warned, not silently dropped", !!(full && full.layersDoc.manifest.warnings.some((w) => /Locked Page.*could not be read/.test(w))));
  ok("untraversable page warned in the component catalog too", !!(full && full.layersDoc.manifest.warnings.some((w) => /component catalog.*Locked Page/.test(w))));
  ok("loadAllPagesAsync failure is itself reported", !!(full && full.layersDoc.manifest.warnings.some((w) => /loadAllPagesAsync failed/.test(w))));
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
    Array.isArray(listBad.pages.find((p) => p.name === "Page 1")!.frames));
  sandbox.figma.root.children = prevRootChildren;
  sandbox.figma.loadAllPagesAsync = prevLoadAll;

  const listed = await sandbox.listPages({});
  ok("[LIST] reports the file name", listed.file === "My File");
  ok("[LIST] lists every page", listed.pages.length === sandbox.figma.root.children.length);
  ok("[LIST] marks the current page", listed.pages.some((p) => p.current === true));
  const lf = listed.pages[0].frames;
  ok("[LIST] top-level frames carry id/name/type", Array.isArray(lf) && lf.length > 0 && lf.every((f) => f.id && f.name && f.type));
  ok("[LIST] frames carry size", lf!.every((f) => typeof f.w === "number" && typeof f.h === "number"));
  // The POINT of the op: it is an index, not an export. No recursion, no serialization, no assets.
  ok("[LIST] frames do NOT recurse (no children)", lf!.every((f) => f.children === undefined));
  ok("[LIST] frames carry no serialized detail (no fills/layout/tokens)",
    lf!.every((f) => f.fills === undefined && f.layout === undefined && f.tokens === undefined));
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
  sandbox.figma.getNodeByIdAsync = async (id: string) => { const nodes: Record<string, FakeNode> = { "p:children": parentFrame, "leaf:children": leafNode }; return nodes[id] || null; };

  const kids = await sandbox.listChildren("p:children");
  ok("[CHILDREN] reports the queried node's own id/name/type", kids.id === "p:children" && kids.name === "Card" && kids.type === "FRAME");
  ok("[CHILDREN] lists DIRECT children only", kids.children.length === 2);
  ok("[CHILDREN] each child carries id/name/type", kids.children.every((c) => c.id && c.name && c.type));
  ok("[CHILDREN] children carry size", kids.children.every((c) => typeof c.w === "number" && typeof c.h === "number"));
  ok("[CHILDREN] a hidden child is flagged", kids.children.find((c) => c.id === "ch:1")!.hidden === true);
  ok("[CHILDREN] a child that itself has children is flagged hasChildren:true", kids.children.find((c) => c.id === "ch:2")!.hasChildren === true);
  // The whole point of the op: it does NOT recurse. The grandchild must never appear anywhere.
  ok("[CHILDREN] does NOT recurse into grandchildren", JSON.stringify(kids).indexOf("gc:1") === -1);
  ok("[CHILDREN] no serialized detail leaks in (no fills/layout/tokens)",
    kids.children.every((c) => c.fills === undefined && c.layout === undefined && c.tokens === undefined));
  ok("[CHILDREN] no assets are produced", kids.assets === undefined);

  let leafErr: Thrown | null = null;
  try { await sandbox.listChildren("leaf:children"); } catch (e) { leafErr = thrown(e); }
  ok("[CHILDREN] a leaf node (nothing to list) errors rather than returning an empty list", !!leafErr && /leaf/.test(leafErr.message));

  let childrenMissErr: Thrown | null = null;
  try { await sandbox.listChildren("nope:children"); } catch (e) { childrenMissErr = thrown(e); }
  ok("[CHILDREN] an unknown node id errors", !!childrenMissErr && /not in the open file/.test(childrenMissErr.message));

  let childrenEmptyErr: Thrown | null = null;
  try { await sandbox.listChildren(""); } catch (e) { childrenEmptyErr = thrown(e); }
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
  sandbox.figma.getNodeByIdAsync = async (id: string) => (id === "deep:1" && unlockedPage ? parentFrame : null);
  const lazyKids = await sandbox.listChildren("deep:1");
  ok("[CHILDREN] a node on an unloaded page is still found", lazyKids.children.length === 2);
  ok("[CHILDREN] the lookup loads pages incrementally, never loadAllPagesAsync", allPagesCalls === 0 && incrementalLoads === 1);
  ok("[CHILDREN] and stops as soon as the node resolves (later pages untouched)", incrementalLoads < sandbox.figma.root.children.length);
  sandbox.figma.root.children = prevRoot3;
  sandbox.figma.loadAllPagesAsync = prevLoadAll3;

  // listChildren(pageId) on a page that ISN'T current: under dynamic-page access PageNode.children
  // throws until loadAsync() has run — https://developers.figma.com/docs/plugins/migrating-to-dynamic-loading/.
  // The fake page's `children` getter enforces exactly that.
  let otherPageLoaded = false;
  const otherPageFrame = { id: "opf:1", name: "Hero", type: "FRAME", width: 300, height: 100 };
  const otherPage = {
    type: "PAGE", id: "page:other", name: "Other Page",
    loadAsync: async () => { otherPageLoaded = true; },
    get children() {
      if (!otherPageLoaded) throw new Error("children could not be read (page not loaded)");
      return [otherPageFrame];
    },
  };
  sandbox.figma.getNodeByIdAsync = async (id: string) => (id === "page:other" ? otherPage : null);
  const pageKids = await sandbox.listChildren("page:other");
  ok("[CHILDREN] a non-current page is loaded before its children are read", pageKids.children.length === 1 && pageKids.children[0].id === "opf:1");

  // listChildren("0:0") — the DOCUMENT node: its children are PageNodes, and reading `hasChildren` on
  // each of THEM has the identical dynamic-page rule, so every page must be loaded first too.
  let docPageALoaded = false, docPageBLoaded = false;
  const docPageA = {
    type: "PAGE", id: "page:a", name: "A",
    loadAsync: async () => { docPageALoaded = true; },
    get children() { if (!docPageALoaded) throw new Error("not loaded"); return [{ id: "a:frame", name: "F", type: "FRAME" }]; },
  };
  const docPageB = {
    type: "PAGE", id: "page:b", name: "B",
    loadAsync: async () => { docPageBLoaded = true; },
    get children() { if (!docPageBLoaded) throw new Error("not loaded"); return []; },
  };
  const documentNode = { type: "DOCUMENT", id: "0:0", name: "My File", children: [docPageA, docPageB] };
  sandbox.figma.getNodeByIdAsync = async (id: string) => (id === "0:0" ? documentNode : null);
  const docKids = await sandbox.listChildren("0:0");
  ok("[CHILDREN] listChildren(\"0:0\") succeeds and lists pages", docKids.children.length === 2 && docKids.children.some((c) => c.id === "page:a"));
  ok("[CHILDREN] each page was loaded before its hasChildren was read", docKids.children.find((c) => c.id === "page:a")!.hasChildren === true && docKids.children.find((c) => c.id === "page:b")!.hasChildren === false);

  sandbox.figma.getNodeByIdAsync = prevGetNodeC;

  // ---- [PAGE] --page: export ONE named page (not the one that happens to be open) ----
  // Verified against the Plugin API docs: PageNode.loadAsync() loads a single page, root.children is
  // readable without loading, and figma.currentPage does NOT need to change — so a --page export
  // leaves the user's editor where it is. That last fact is what made the metadata bugs below
  // possible: three fields still assumed "exported page == currentPage".
  const pgA: FakeNode = { name: "Screens", id: "p:A", children: [scrollFrame], loadAsync: async () => {}, findAllWithCriteria: () => [] };
  const pgB: FakeNode = { name: "Screens", id: "p:B", children: [], loadAsync: async () => {}, findAllWithCriteria: () => [] };
  const pgC: FakeNode = { name: "Archive", id: "p:C", children: [], loadAsync: async () => {}, findAllWithCriteria: () => [] };
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
  let dupErr: Thrown | null = null;
  try { await sandbox.collectFull({ page: "Screens", css: false }); } catch (e) { dupErr = thrown(e); }
  ok("[PAGE] a DUPLICATE exact name errors instead of picking one", !!dupErr && /ambiguous/.test(dupErr.message));
  ok("[PAGE] the ambiguity error says to use the id", !!dupErr && /use its id/.test(dupErr.message));
  ok("[PAGE] and lists the available pages (self-healing)", !!dupErr && /p:A/.test(dupErr.message) && /p:C/.test(dupErr.message));

  let missErr: Thrown | null = null;
  try { await sandbox.collectFull({ page: "Nope", css: false }); } catch (e) { missErr = thrown(e); }
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
  const redline = (id: string) => [{ start: { node: { id } , side: "LEFT" }, end: { node: { id }, side: "RIGHT" }, offset: 8, freeText: id }];
  pgA.getMeasurements = () => redline("a");
  pgC.getMeasurements = () => redline("c");
  const measMulti = await sandbox.collectFull({ page: ["p:A", "p:C"], measurements: true, css: false });
  ok("[MEAS] each redline is tagged with the page it came from",
    measMulti.layersDoc.measurements!.some((m) => m.page === "Screens" && m.text === "a") &&
    measMulti.layersDoc.measurements!.some((m) => m.page === "Archive" && m.text === "c"));
  ok("[MEAS] and with the page ID too — the name alone can't tell two same-named pages apart",
    measMulti.layersDoc.measurements!.every((m) => m.pageId === (m.text === "a" ? "p:A" : "p:C")));
  // Two pages CAN legitimately share identical redlines — that is data, not an error: emit both.
  pgC.getMeasurements = () => redline("a");
  const measDup = await sandbox.collectFull({ page: ["p:A", "p:C"], measurements: true, css: false });
  ok("[MEAS] identical sets on two pages are both emitted, not de-duplicated", measDup.layersDoc.measurements!.length === 2);
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
  let bothErr: Thrown | null = null;
  try { await sandbox.collectFull({ allPages: true, page: "p:A", css: false }); } catch (e) { bothErr = thrown(e); }
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
  const created: FakeNode[] = [];
  sandbox.figma.createFrame = () => { const f = { id: "new:frame", type: "FRAME", name: "", fills: [], resize() {}, appendChild() {} }; created.push(f); return f; };
  sandbox.figma.createText = () => { const t = { id: "new:text", type: "TEXT", characters: "", fills: [], fontName: { family: "Inter", style: "Regular" } }; created.push(t); return t; };
  sandbox.figma.loadFontAsync = async () => {};
  sandbox.figma.currentPage.appendChild = () => {};

  const textTarget: FakeNode = { id: "t:1", type: "TEXT", name: "Label", characters: "old", fontName: { family: "Inter", style: "Regular" }, getRangeAllFontNames: () => [{ family: "Inter", style: "Regular" }] };
  const rectTarget: FakeNode & { fills: Array<{ color: { g: number } }> } = { id: "r:1", type: "RECTANGLE", name: "Box", fills: [] };
  const groupTarget: FakeNode = { id: "g:1", type: "GROUP", name: "Wrap" }; // no `fills`
  const prevGetNode = sandbox.figma.getNodeByIdAsync;
  sandbox.figma.getNodeByIdAsync = async (id: string) => { const nodes: Record<string, FakeNode> = { "t:1": textTarget, "r:1": rectTarget, "g:1": groupTarget }; return nodes[id] || prevGetNode(id); };

  const wOk = await sandbox.applyWrites([{ op: "createFrame", name: "Card", fill: "#ff0000" }, { op: "setText", nodeId: "t:1", text: "new" }]);
  ok("write: successful batch -> ok:true + applied ids", wOk.ok === true && wOk.applied.length === 2 && wOk.applied[0].id === "new:frame");
  ok("write: setText actually mutated the node", textTarget.characters === "new");
  ok("write: setFill applies a parsed hex", (await sandbox.applyWrites([{ op: "setFill", nodeId: "r:1", color: "#00ff00" }])).ok === true && Math.round(rectTarget.fills[0].color.g) === 1);

  // A missing node must FAIL, not silently report {id} — the old behaviour told the agent it worked.
  const wMissing = await sandbox.applyWrites([{ op: "setFill", nodeId: "nope:1", color: "#fff" }]);
  ok("write: setFill on a missing node fails (not silent success)", wMissing.ok === false && /no node with id/.test(wMissing.error!));
  const wWrongType = await sandbox.applyWrites([{ op: "setText", nodeId: "r:1", text: "x" }]);
  ok("write: setText on a non-TEXT node fails", wWrongType.ok === false && /not TEXT/.test(wWrongType.error!));
  const wNoFills = await sandbox.applyWrites([{ op: "setFill", nodeId: "g:1", color: "#fff" }]);
  ok("write: setFill on a node without fills fails", wNoFills.ok === false && /has no fills/.test(wNoFills.error!));

  // Dev Mode is read-only for plugins (manifest editorType now includes "dev"): the batch is refused
  // up front with the fix, not left to throw an opaque Plugin-API error partway through.
  sandbox.figma.editorType = "dev";
  const wDev = await sandbox.applyWrites([{ op: "createFrame", name: "X" }]);
  ok("write: refused as a whole in Dev Mode, with the fix in the error", wDev.ok === false && wDev.applied.length === 0 && wDev.failedAt === 0 && /Dev Mode/.test(wDev.error!) && /Design mode/.test(wDev.error!));
  sandbox.figma.editorType = "figma";

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
  ok("write: unknown op is rejected", (await sandbox.applyWrites([{ op: "nope" }])).error!.indexOf("unknown write op") !== -1);
  ok("write: empty/omitted batch is a no-op success", (await sandbox.applyWrites(undefined)).ok === true);

  // ---- parentId (was entirely uncovered, which is how the silent-reparent bug survived) ----
  // The contract mirrors setFill/setText: if the node did NOT land where it was asked to go, the op
  // must fail. The old code fell back to currentPage and still returned {id}, so an agent composing a
  // tree got ok:true and a flat pile of nodes on the canvas.
  const parentKids: FakeNode[] = [];
  const containerTarget = { id: "c:1", type: "FRAME", name: "Root", appendChild: (n: FakeNode) => parentKids.push(n) };
  const pageLoads = [];
  const pageTarget = { id: "pg:1", type: "PAGE", name: "Page 2", loadAsync: async () => pageLoads.push("pg:1"), appendChild: (n: FakeNode) => parentKids.push(n) };
  const leafTarget = { id: "lf:1", type: "TEXT", name: "Leaf" }; // no appendChild — cannot hold children
  sandbox.figma.getNodeByIdAsync = async (id: string) => {
    const nodes: Record<string, FakeNode> = { "t:1": textTarget, "r:1": rectTarget, "g:1": groupTarget, "c:1": containerTarget, "pg:1": pageTarget, "lf:1": leafTarget };
    return nodes[id] || null;
  };

  const pOk = await sandbox.applyWrites([{ op: "createFrame", name: "Child", parentId: "c:1" }]);
  ok("write: valid parentId -> ok:true and the node lands on that parent", pOk.ok === true && parentKids.length === 1 && parentKids[0].id === "new:frame");
  ok("write: valid parentId did NOT fall through to currentPage", parentKids[0] === created[created.length - 1]);

  const beforeOrphan = created.length;
  const pMissing = await sandbox.applyWrites([{ op: "createFrame", name: "Orphan", parentId: "gone:99" }]);
  ok("write: unresolvable parentId fails (not silent reparent)", pMissing.ok === false && /not found/.test(pMissing.error!));
  ok("write: failed parent leaves NO orphan node behind", created.length === beforeOrphan);
  ok("write: failed parent reports nothing as applied", pMissing.applied.length === 0);

  const pLeaf = await sandbox.applyWrites([{ op: "createFrame", parentId: "lf:1" }]);
  ok("write: parent that cannot have children fails", pLeaf.ok === false && /cannot have children/.test(pLeaf.error!));

  const pText = await sandbox.applyWrites([{ op: "createText", text: "hi", parentId: "gone:99" }]);
  ok("write: createText honours parentId failure too", pText.ok === false && /not found/.test(pText.error!));

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
  const vecHost = (id: string, kids: FakeNode[]) => ({ type: "FRAME", name: "Host" + id, visible: true, id: "vh:" + id,
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
  const [invNode, zeroNode] = invRun.screen.nodes[0].children!;

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
  const geoNode = geoRun.screen.nodes[0].children![0];
  ok("[AUDIT-1] a real export failure falls back to fillGeometry", !!(geoNode.geometry && geoNode.geometry.fills![0] === "M0 0h24v24H0z"));
  ok("[AUDIT-1] strokeGeometry comes along when present", geoNode.geometry!.strokes![0] === "M2 2h20");
  // Without w/h the path data has no coordinate space — a consumer cannot build a viewBox from it.
  ok("[AUDIT-1] geometry carries the node's own w/h so it can be rendered as inline SVG",
    geoNode.geometry!.w === 24 && geoNode.geometry!.h === 24);
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
    findOne: (pred: (n: FakeNode) => boolean) => ([{ type: "TEXT", name: "t", visible: true, id: "oa:t1" }].find(pred) || null),
    exportAsync: async () => "<svg/>" };
  sandbox.figma.currentPage.selection = [oddNameFrameWithText];
  const isAssetTextRun = await sandbox.collectSelection({});
  ok("[isAsset] isAsset:true is still overridden by a real TEXT descendant — never flatten real content",
    Array.isArray(isAssetTextRun.screen.nodes[0].children));

  // ---- [2026-08-13, fixed 2026-09-24] variableWidthStrokeProperties: tapered strokes ----
  // Real shape per https://developers.figma.com/docs/plugins/api/VariableWidthStrokeProperties/ and
  // plugin-api.d.ts ~L8669-8697: CUSTOM carries `variableWidthPoints:[{position,width}]`; presets
  // (UNIFORM/WEDGE/TAPER/QUARTER_TAPER/EYE/MIRRORED_TAPER) carry only `widthProfile`, no points array.
  const taperedNode = { type: "VECTOR", name: "brush", visible: true, id: "vw:1", width: 40, height: 4,
    strokes: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 1 }],
    strokeWeight: 2,
    variableWidthStrokeProperties: { widthProfile: "CUSTOM",
      variableWidthPoints: [{ position: 0, width: 1 }, { position: 0.5, width: 4 }, { position: 1, width: 1 }] },
    fills: [], exportAsync: async () => "<svg/>" };
  sandbox.figma.currentPage.selection = [taperedNode];
  const taperedRun = await sandbox.collectSelection({});
  const taperedStroke = taperedRun.screen.nodes[0].strokes;
  ok("[variableWidth] a CUSTOM tapered stroke's profile is captured",
    !!taperedStroke && !!taperedStroke.variableWidth && taperedStroke.variableWidth.profile === "custom");
  ok("[variableWidth] and its points, with position+width",
    taperedStroke!.variableWidth!.points!.length === 3 && taperedStroke!.variableWidth!.points![1].pos === 0.5 && taperedStroke!.variableWidth!.points![1].width === 4);

  const presetNode = { type: "VECTOR", name: "wedge", visible: true, id: "vw:3", width: 40, height: 4,
    strokes: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 1 }],
    strokeWeight: 2,
    variableWidthStrokeProperties: { widthProfile: "WEDGE" },
    fills: [], exportAsync: async () => "<svg/>" };
  sandbox.figma.currentPage.selection = [presetNode];
  const presetRun = await sandbox.collectSelection({});
  const presetStroke = presetRun.screen.nodes[0].strokes;
  ok("[variableWidth] a preset (WEDGE) stroke carries only a profile, no points",
    !!presetStroke && !!presetStroke.variableWidth && presetStroke.variableWidth.profile === "wedge" && presetStroke.variableWidth.points === undefined);

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
  const missingFontText = (i: number) => ({ type: "TEXT", name: "Label" + i, visible: true, id: "mf:" + i, characters: "x", width: 50,
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
    aggRun.screen.nodes[0].children!.every((c) => c.missingFont === true));
  sandbox.figma.currentPage.selection = prevSel2;

  // ---- [AUDIT-6a] box.x/y is page-space and must not survive inside an auto-layout parent ----
  const boxed = (id: string, extra?: FakeNode) => Object.assign({ type: "FRAME", name: "Row" + id, visible: true, id: "bx:" + id,
    width: 100, height: 20, layoutMode: "NONE", children: [],
    absoluteBoundingBox: { x: 40, y: 80, width: 100, height: 20 } }, extra || {});
  const flowKid = boxed("flow");
  const absKid = boxed("abs", { layoutPositioning: "ABSOLUTE" });
  const autoParent = { type: "FRAME", name: "Stack", visible: true, id: "bx:p", width: 100, height: 100,
    layoutMode: "VERTICAL", itemSpacing: 0, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
    absoluteBoundingBox: { x: 5, y: 6, width: 100, height: 100 }, children: [flowKid, absKid] };
  const stack = await sandbox.serialize(autoParent, 0, false);
  const [flowOut, absOut] = stack.children!;
  ok("[AUDIT-6a] a flow child of an auto-layout parent keeps w/h", flowOut.box!.w === 100 && flowOut.box!.h === 20);
  ok("[AUDIT-6a] but drops box.x/y — the container decides placement", flowOut.box!.x === undefined && flowOut.box!.y === undefined);
  // The exceptions have to survive, or absolutely-positioned overlays lose their only placement data.
  ok("[AUDIT-6a] an ABSOLUTE child keeps box.x/y", absOut.box!.x === 40 && absOut.box!.y === 80);
  const looseParent = { type: "FRAME", name: "Canvas", visible: true, id: "bx:l", width: 100, height: 100,
    layoutMode: "NONE", children: [boxed("loose")] };
  const loose = await sandbox.serialize(looseParent, 0, false);
  ok("[AUDIT-6a] a child of a NON-auto-layout parent keeps box.x/y", loose.children![0].box!.x === 40 && loose.children![0].box!.y === 80);
  // The export ROOT has no parent in the doc, so its own page-space origin is the only anchor there is.
  ok("[AUDIT-6a] an export ROOT keeps its own box.x/y", stack.box!.x === 5 && stack.box!.y === 6);

  // ---- [AUDIT-6b] widthMode/heightMode: emit only the non-default values ----
  const sizing = (h: string, v: string) => ({ type: "FRAME", name: "S", visible: true, id: "sz:1", width: 10, height: 10,
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
  ok("[AUDIT-5] the density suffix + scale survive", exportNode.exportSettings![1].suffix === "@3x" && exportNode.exportSettings![1].constraint!.value === 3);
  ok("[AUDIT-5] the SCALE-1 default carries no intent and is omitted", exportNode.exportSettings![0].constraint === undefined);
  ok("[AUDIT-5] a node with no presets emits nothing", plainFrame.exportSettings === undefined);

  // ---- [AUDIT-5] skew: the sheared transform the decomposition used to throw away ----
  const xf = (m: number[][]) => ({ type: "FRAME", name: "T", visible: true, id: "sk:1", width: 10, height: 10,
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
  const countTree = (t: IrNode): number => 1 + (Array.isArray(t.children) ? t.children.reduce((a: number, c) => a + countTree(c), 0) : 0);
  ok("[AUDIT-4] index entries carry a subtree node count", entry.nodes === countTree(layerTree));
  ok("[AUDIT-4] and an approximate serialized byte size", typeof entry.bytes === "number" && entry.bytes > 100);
  ok("[AUDIT-4] bytes tracks the tree that actually lands in the layer file",
    Math.abs(entry.bytes! - JSON.stringify(layerTree).length) < 2);
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
  ok("[AUDIT-5] a page's chosen canvas background is captured", !!(bgEntry && flatPaint(bgEntry.background![0]).color === "#1a1a1a"));
  ok("[AUDIT-5] prototypeBackgrounds is captured separately", !!(bgEntry && flatPaint(bgEntry.prototypeBackground![0]).color === "#000000"));
  ok("[AUDIT-5] the page entry is keyed by pageId, not by the non-unique name", !!(bgEntry && bgEntry.page === "Dark"));
  // Figma's own default carries no designer intent — emitting it would put a line on every page.
  ok("[AUDIT-5] the plain-white default is omitted", !(bgRun.layersDoc.pageSettings || []).some((p) => p.pageId === "p:plain"));
  sandbox.figma.root.children = prevKids2;

  // ---- [LIB] team libraries: the half of the design system that lives in another file ----
  // Every assertion here covers a shape the Plugin API really produces and that a naive implementation
  // crashes on or lies about: a remote main whose `.parent` is NULL, a `componentPropertyDefinitions`
  // getter that THROWS on a variant, and a teamLibrary that is absent (no permission) or empty
  // (no library enabled — a NORMAL state, since libraries can only be turned on from the Figma UI).
  // Optional fields are exercised at their DEFAULT, which is where the real bugs have always been.
  const remoteVariantMain = {
    type: "COMPONENT", name: "Size=md, State=default", key: "libkey_btn", remote: true,
    parent: null, // documented shape for a remote main (plugin-api.d.ts:6092) — NOT a test convenience
    get componentPropertyDefinitions() {
      throw new Error("Can only get component property definitions of a component set or non-variant component");
    },
  };
  const remoteSetMain = {
    type: "COMPONENT", name: "Card", key: "libkey_card", remote: true, description: "Library card",
    parent: { type: "COMPONENT_SET", name: "CardSet" },
    componentPropertyDefinitions: { "Elevated#3:0": { type: "BOOLEAN", defaultValue: false }, "Tone": { type: "VARIANT", defaultValue: "a", variantOptions: ["a", "b"] } },
  };
  const localMain = { type: "COMPONENT", name: "LocalOnly", key: "compkey123", remote: false, parent: null, componentPropertyDefinitions: {} };
  const libInst = (main: FakeNode, props: Record<string, { type: string; value: string }>) => ({ type: "INSTANCE", name: "i", visible: true, componentProperties: props, getMainComponentAsync: async () => main });
  const libInstances = [
    libInst(remoteVariantMain, { "Size": { type: "VARIANT", value: "md" }, "Label#1:0": { type: "TEXT", value: "Go" } }),
    libInst(remoteVariantMain, { "Size": { type: "VARIANT", value: "lg" }, "Label#1:0": { type: "TEXT", value: "Stop" } }),
    libInst(remoteVariantMain, { "Size": { type: "VARIANT", value: "md" } }), // duplicate value must not duplicate the option
    libInst(remoteSetMain, { "Tone": { type: "VARIANT", value: "a" } }),
    libInst(localMain, { }),
    { type: "INSTANCE", name: "broken", visible: true, getMainComponentAsync: async () => { throw new Error("detached"); } },
  ];
  const libPage = { name: "Lib Page", id: "p:lib", loadAsync: async () => {}, children: [],
    // The catalog and the library scan ask for DIFFERENT types off the same page — answer each one
    // honestly so the merge below is exercised against a real local walk, not an empty one.
    findAllWithCriteria: ({ types }: { types: string[] }) => (types.indexOf("INSTANCE") !== -1 ? libInstances : [buttonComponent]) };
  const prevKids3 = sandbox.figma.root.children;
  sandbox.figma.root.children = [libPage];

  const libComps = await sandbox.collectLibraryComponents(() => {});
  ok("[LIB] library components recovered by walking instances (mains cannot be enumerated)", libComps.length === 2);
  const btnLib = libComps.find((c) => c.key === "libkey_btn");
  const cardLib = libComps.find((c) => c.key === "libkey_card");
  ok("[LIB] a LOCAL main is not duplicated into the library catalog", !libComps.some((c) => c.key === "compkey123"));
  ok("[LIB] an instance whose main cannot be resolved does not abort the scan", !!btnLib && !!cardLib);
  // Dedupe is by KEY, never by name: two libraries can both ship a "Button".
  ok("[LIB] deduped by publish key", !!btnLib && libComps.filter((c) => c.key === "libkey_btn").length === 1);
  ok("[LIB] and the instance count survives the dedupe", btnLib!.uses === 3);
  // parent === null is the documented remote shape — reading .parent.name would have thrown here.
  ok("[LIB] a NULL parent on a remote main is survivable, and its own name is used", btnLib!.name === "Size=md, State=default" && btnLib!.variant === undefined);
  ok("[LIB] a COMPONENT_SET parent gives the useful name, with the variant kept", cardLib!.name === "CardSet" && cardLib!.variant === "Card");
  // The getter THROWS on a variant — the fallback must engage, and must SAY it did.
  ok("[LIB] throwing componentPropertyDefinitions falls back to instances", btnLib!.derivedFrom === "instances");
  ok("[LIB] observed variant values aggregated across instances", btnLib!.props!.Size.observed!.indexOf("md") !== -1 && btnLib!.props!.Size.observed!.indexOf("lg") !== -1);
  ok("[LIB] repeated values are uniqued, not appended per instance", btnLib!.props!.Size.observed!.length === 2);
  ok("[LIB] non-variant props are observed too, keyed by the stripped name", btnLib!.props!.Label && btnLib!.props!.Label.key === "Label#1:0");
  // The whole point of derivedFrom: an inferred sample must never be mistaken for a complete enum.
  ok("[LIB] readable definitions are used verbatim and flagged as such", cardLib!.derivedFrom === "definitions" && cardLib!.props!.Tone.options!.length === 2);
  ok("[LIB] an inferred entry uses 'observed', a defined one uses 'options'", btnLib!.props!.Size.options === undefined && cardLib!.props!.Tone.observed === undefined);
  ok("[LIB] every entry is flagged remote", libComps.every((c) => c.remote === true));
  // There is NO API mapping a component key to its library — unattributed must read as unknown.
  ok("[LIB] unattributed remote components are 'unknown-library', never guessed", libComps.every((c) => c.source === "unknown-library"));

  // ---- [VARIANTVIS] --variant-visuals: per-variant layout/fills truth, not the set-wrapper's chrome ----
  const variantA: FakeNode = {
    type: "COMPONENT", id: "v:a", name: "Type=Default, Status=Default", key: "vkey_a",
    fills: [{ type: "SOLID", visible: true, color: { r: 0, g: 0.6, b: 0 }, opacity: 1 }],
    cornerRadius: 16, visible: true, children: [],
  };
  const variantB: FakeNode = {
    type: "COMPONENT", id: "v:b", name: "Type=Default, Status=Hover", key: "vkey_b",
    variantProperties: { Type: "Default", Status: "Hover" },
    fills: [{ type: "SOLID", visible: true, color: { r: 0, g: 0.4, b: 0 }, opacity: 1 }],
    cornerRadius: 16, visible: true, children: [],
    // A variant whose own componentPropertyDefinitions getter throws (documented Plugin API shape) —
    // the walk must still emit this variant's node, just without props (props stay set-level only).
    get componentPropertyDefinitions() { throw new Error("Can only get component property definitions of a component set or non-variant component"); },
  };
  const tagSet = {
    type: "COMPONENT_SET", id: "set:tag", name: "Tag", key: "setkey_tag",
    fills: [{ type: "SOLID", visible: true, color: { r: 0.6, g: 0.28, b: 1 }, opacity: 1 }], // Figma's own purple selection chrome — NOT a design value
    cornerRadius: 5,
    componentPropertyDefinitions: { Type: { type: "VARIANT", variantOptions: ["Default"] }, Status: { type: "VARIANT", variantOptions: ["Default", "Hover"] } },
  };
  variantA.parent = tagSet; variantB.parent = tagSet;
  // A standalone COMPONENT — no COMPONENT_SET wrapper — must get the SAME serializeVariant treatment
  // under --variant-visuals, attached as entry.node rather than entry.variants[].node.
  const standaloneComp = {
    type: "COMPONENT", id: "c:solo", name: "IconButton", key: "compkey_solo", parent: null,
    fills: [{ type: "SOLID", visible: true, color: { r: 1, g: 0, b: 0 }, opacity: 1 }],
    cornerRadius: 8, visible: true, children: [], componentPropertyDefinitions: {},
  };
  const variantPage = { name: "Variants", id: "p:variants", loadAsync: async () => {},
    findAllWithCriteria: ({ types }: { types: string[] }) => (types.indexOf("COMPONENT_SET") !== -1 ? [tagSet, variantA, variantB, standaloneComp] : []) };
  const kidsBeforeVariantPage = sandbox.figma.root.children; // = [libPage] — must be restored, not prevKids3, since the [LIB] section below still needs it
  sandbox.figma.root.children = [variantPage];

  const dsOff = await sandbox.collectDesignSystemOnly();
  const tagOff = dsOff.designSystem.components.find((c) => c.id === "set:tag");
  const soloOff = dsOff.designSystem.components.find((c) => c.id === "c:solo");
  ok("[VARIANTVIS] off by default: the set-wrapper's OWN visuals are what's captured (selection chrome, not design)", !!(tagOff && tagOff.visuals && flatPaint(tagOff.visuals.fills![0]).color === "#9947ff"));
  ok("[VARIANTVIS] off by default: no per-variant data attached (regression guard)", !!(tagOff && tagOff.variants === undefined));
  ok("[VARIANTVIS] off by default: a standalone COMPONENT gets no node tree either (regression guard)", !!(soloOff && soloOff.node === undefined));

  const dsOn = await sandbox.collectDesignSystemOnly({ variantVisuals: true });
  const tagOn = dsOn.designSystem.components.find((c) => c.id === "set:tag");
  const soloOn = dsOn.designSystem.components.find((c) => c.id === "c:solo");
  ok("[VARIANTVIS] on: a standalone COMPONENT gets its own node tree under entry.node", !!(soloOn && soloOn.node && soloOn.node.fills && flatPaint(soloOn.node.fills[0]).color === "#ff0000" && soloOn.node.radius === 8));
  ok("[VARIANTVIS] on: a standalone COMPONENT never gets a variants[] array (that's the SET shape)", !!(soloOn && soloOn.variants === undefined));
  ok("[VARIANTVIS] on: the set entry itself is otherwise unchanged", !!(tagOn && tagOn.visuals && flatPaint(tagOn.visuals.fills![0]).color === "#9947ff"));
  ok("[VARIANTVIS] on: two variants captured, keyed by id/name/key", !!(tagOn && Array.isArray(tagOn.variants) && tagOn.variants.length === 2 &&
    tagOn.variants.every((v) => v.id && v.name && v.key)));
  const va = tagOn!.variants!.find((v) => v.id === "v:a");
  const vb = tagOn!.variants!.find((v) => v.id === "v:b");
  ok("[VARIANTVIS] variant values parsed from the name when variantProperties is absent", !!(va && va.values && va.values.Type === "Default" && va.values.Status === "Default"));
  ok("[VARIANTVIS] variant values read from variantProperties when present", !!(vb && vb.values && vb.values.Status === "Hover"));
  ok("[VARIANTVIS] each variant's REAL fills/radius captured (the master-component source of truth)",!!(
    va && va.node && va.node.fills && flatPaint(va.node.fills[0]).color === "#009900" && va.node.radius === 16));
  ok("[VARIANTVIS] a variant whose own componentPropertyDefinitions throws still gets its node captured, not dropped",!!(
    vb && vb.node && vb.node.fills && flatPaint(vb.node.fills[0]).color === "#006600"));
  ok("[VARIANTVIS] no per-variant props (componentPropertyDefinitions throws on a variant; set-level props stay authoritative)",!!(
    va && va.node && va.node.props === undefined));
  sandbox.figma.root.children = kidsBeforeVariantPage;

  // A user-maintained registry is the ONLY honest attribution route.
  sandbox.figma.root.getPluginData = (k: string) => (k === "libraryRegistry" ? JSON.stringify({ libkey_btn: "Acme DS" }) : "");
  const attributed = await sandbox.collectLibraryComponents(() => {});
  ok("[LIB] the registry attributes a component to its library", attributed.find((c) => c.key === "libkey_btn")!.source === "Acme DS");
  ok("[LIB] and unregistered ones stay unknown", attributed.find((c) => c.key === "libkey_card")!.source === "unknown-library");
  sandbox.figma.root.getPluginData = () => "!!not json!!";
  const badReg = await sandbox.collectLibraryComponents(() => {});
  ok("[LIB] a corrupt registry degrades to no attribution, it does not throw", badReg.length === 2 && badReg.every((c) => c.source === "unknown-library"));
  delete sandbox.figma.root.getPluginData;

  // --- listLibraries: the cheap discovery map ---
  // DEFAULT state first: no figma.teamLibrary at all (permission missing / older host).
  const noPerm = await sandbox.listLibraries();
  ok("[LIB] a missing teamlibrary permission is a WARNING, not a crash", Array.isArray(noPerm.libraries) && noPerm.warnings.some((w) => /teamlibrary/.test(w)));
  ok("[LIB] and the component half still reports without it", noPerm.libraries.some((l) => l.componentCount === 2));
  ok("[LIB] the local file is listed as kind:local", noPerm.libraries.some((l) => l.kind === "local" && l.name === "My File"));
  ok("[LIB] local variable collections are counted", (noPerm.libraries.find((l) => l.kind === "local")!.variableCollections || []).some((c) => c.name === "Semantic" && c.variableCount === 2));
  ok("[LIB] the unknown-library bucket says counts are USED-IN-THIS-FILE, not what the library offers",
    /USED IN THIS FILE/.test(noPerm.libraries.find((l) => l.name === "unknown-library")!.note!));

  // Enabled-but-empty: a fresh file with no library turned on. NORMAL, and must say so.
  sandbox.figma.teamLibrary = { getAvailableLibraryVariableCollectionsAsync: async () => [], getVariablesInLibraryCollectionAsync: async () => [] };
  const empty = await sandbox.listLibraries();
  ok("[LIB] an empty team-library result reads as normal, not as a failure", empty.warnings.some((w) => /normal, not a failure/.test(w) && /Assets > Libraries/.test(w)));
  ok("[LIB] and it is not reported as an error", empty.libraries.length > 0);
  // The warning must SCOPE itself to variable collections. Worded as a flat "no libraries are
  // enabled" it contradicted the "LIBRARIES (2)" printed immediately below, whose rows come from the
  // component side and from this file itself — two true statements reading as one lie (finding 17).
  ok("[LIB] and it says WHICH list is empty, so it cannot contradict the rows printed beneath it",
    empty.warnings.some((w) => /VARIABLE collections/.test(w) && /rows below come from this file itself/.test(w)));

  sandbox.figma.teamLibrary = {
    getAvailableLibraryVariableCollectionsAsync: async () => ([
      { name: "Semantic", key: "lc_sem", libraryName: "Acme DS" },
      { name: "Primitives", key: "lc_prim", libraryName: "Acme DS" },
      { name: "Broken", key: "lc_bad", libraryName: "Acme DS" },
    ]),
    getVariablesInLibraryCollectionAsync: async (k: string) => {
      if (k === "lc_bad") throw new Error("no access");
      return k === "lc_sem" ? [{ name: "a", key: "1", resolvedType: "COLOR" }, { name: "b", key: "2", resolvedType: "FLOAT" }] : [{ name: "c", key: "3", resolvedType: "COLOR" }];
    },
  };
  const libs = await sandbox.listLibraries();
  const acme = libs.libraries.find((l) => l.name === "Acme DS");
  ok("[LIB] enabled libraries are grouped by libraryName (the ONLY name the API gives)", !!acme && acme.kind === "library" && acme.variableCollections.length === 3);
  ok("[LIB] each collection carries its variable count", acme!.variableCollections.find((c) => c.name === "Semantic")!.variableCount === 2);
  ok("[LIB] one unreadable collection omits only its own count", acme!.variableCollections.find((c) => c.name === "Broken")!.variableCount === undefined
    && libs.warnings.some((w) => /'Broken'/.test(w)));
  ok("[LIB] a library with no attributable components carries no invented count", acme!.componentCount === undefined && /cannot be enumerated|impossible/.test(acme!.note!));

  // --- the merge into the design-system catalog ---
  const dsLib = await sandbox.buildDesignSystem();
  ok("[LIB] library components are merged into the design-system catalog", dsLib.components.some((c) => c.key === "libkey_btn" && c.remote === true));
  ok("[LIB] the local catalog walk still works alongside them", dsLib.components.some((c) => c.key === "compkey123" && !c.remote));
  ok("[LIB] a library main already present locally is not double-listed", dsLib.components.filter((c) => c.key === "compkey123").length === 1);
  ok("[LIB] hygiene warns that inferred props are a sample", dsLib.hygiene.some((h) => /published LIBRARY/.test(h) && /sample/.test(h)));
  delete sandbox.figma.teamLibrary;
  sandbox.figma.root.children = prevKids3;

  // ---------- [LIB-FILE] the library-file export (--as-library) ----------
  // Run INSIDE the library file, everything is local, so the ordinary local reads return the COMPLETE
  // catalog — that is the whole reason this mode exists instead of importVariableByKeyAsync.
  {
    const lib = await sandbox.collectLibraryFile({ asLibrary: "NERA" });
    const d = lib.designSystem;

    ok("[LIB-FILE] stamps source.role=library", !!(d.source && d.source.role === "library"));
    ok("[LIB-FILE] carries the library name the user typed", d.source!.libraryName === "NERA");
    ok("[LIB-FILE] records fileKey as the durable directory identity", d.source!.fileKey === "FILEKEY1234567");
    ok("[LIB-FILE] collectionKeys are the join back to --list-libraries", Array.isArray(d.source!.collectionKeys));
    // exportedAt/file must stay top-level and unchanged — snapshot-meta.js and drift-lint read them.
    ok("[LIB-FILE] keeps the freshness stamp intact", typeof d.exportedAt === "string" && d.file === "My File");

    // Publish status: gated to library mode because Figma answers UNPUBLISHED for everything when
    // asked from a consuming file or a branch.
    const btn = d.components.find((c) => c.name === "Button");
    ok("[LIB-FILE] component carries publish status", !!(btn && btn.publish === "current"));
    const paint = d.styles.paint[0];
    ok("[LIB-FILE] style carries publish status", paint && paint.publish === "changed");
    ok("[LIB-FILE] hygiene states the catalog is complete", d.hygiene.some((h) => /COMPLETE local catalog of 'NERA'/.test(h)));
    ok("[LIB-FILE] hygiene admits the published snapshot is unlistable", d.hygiene.some((h) => /last PUBLISHED snapshot/.test(h)));
    ok("[LIB-FILE] does NOT claim the false design-system caveat", !d.hygiene.some((h) => /prior\/no page walk referenced/.test(h)));

    // The style fixes, which apply on BOTH paths — `key` is what makes a library style joinable at all.
    ok("[LIB-FILE] paint style carries its cross-file key", paint.key === "paintkey123");
    ok("[LIB-FILE] paint style carries bound variables (tokens)", !!(paint.tokens && Object.keys(paint.tokens).length > 0));
    ok("[LIB-FILE] paint style carries documentationLinks", Array.isArray(paint.docs) && paint.docs.length === 1);

    // The default path must NOT gain a publish field: it would read as authoritative and be wrong.
    const dsPlain = (await sandbox.collectDesignSystemOnly({})).designSystem;
    ok("[LIB-FILE] default design-system pull emits NO publish status", !dsPlain.components.some((c) => c.publish) && !dsPlain.styles.paint.some((s) => s.publish));
    ok("[LIB-FILE] default design-system pull emits NO source block", dsPlain.source === undefined);
    ok("[LIB-FILE] but the style key fix applies there too", dsPlain.styles.paint[0].key === "paintkey123");
  }

  // ---------- [PROGRESS] / [CANCEL] a long export must be watchable AND stoppable ----------
  // An --all-pages pull measured 10+ minutes on a real file, during which the plugin window said only
  // "Exporting…" and offered no way out. Both halves are driven through serializeRun (the same entry
  // point main.ts and bridge.ts use) because progress and cancellation only exist inside a bracketed
  // run — a collector called directly must stay completely silent, which is asserted below.
  {
    const posted: PostedMessage[] = [];
    const prevPost = sandbox.figma.ui.postMessage;
    sandbox.figma.ui.postMessage = (m: PostedMessage) => { posted.push(m); };
    const prevKidsPC = sandbox.figma.root.children;
    const pcPage = (id: string, name: string, kids: FakeNode[]) => ({ id, name, children: kids || [], loadAsync: async () => {}, findAllWithCriteria: () => [] });
    const pc1 = pcPage("p:pc1", "Home", [scrollFrame]);
    const pc2 = pcPage("p:pc2", "Checkout", []);
    const pc3 = pcPage("p:pc3", "Archive", []);
    sandbox.figma.root.children = [pc1, pc2, pc3];

    const run = await sandbox.serializeRun(() => sandbox.collectFull({ allPages: true, css: false }), { source: "ui", label: "test-full" });
    ok("[PROGRESS] the export itself is unaffected — it still returns its layers", run.layersDoc.layers.length > 0);
    ok("[PROGRESS] the run is bracketed by run-begin … run-end",
      posted[0].type === "run-begin" && posted[posted.length - 1].type === "run-end");
    ok("[PROGRESS] run-begin names WHO asked (so a bridge pull isn't mistaken for your own click)",
      posted[0].source === "ui" && posted[0].label === "test-full");
    const pageFrames = posted.filter((m) => m.type === "progress" && m.phase === "pages" && m.page);
    // Page boundaries are the frames that must NEVER be dropped by the throttle — a missed one leaves
    // the status line naming a page the walk already finished.
    ok("[PROGRESS] one frame per page boundary, 1-based, with the total",
      [1, 2, 3].every((i) => pageFrames.some((m) => m.page!.index === i && m.page!.of === 3)));
    ok("[PROGRESS] the frame carries the page NAME for display…", pageFrames.some((m) => m.page!.index === 2 && m.page!.name === "Checkout"));
    // Page names are NOT unique in Figma; the id is the identity. Same rule as the exported docs.
    ok("[PROGRESS] …and the pageId, which is the actual identity", pageFrames.some((m) => m.page!.pageId === "p:pc2"));
    ok("[PROGRESS] running node/asset counters ride along", pageFrames.every((m) => typeof m.nodes === "number" && typeof m.assets === "number"));
    ok("[PROGRESS] the design-system phase is announced (the walk going quiet reads as a hang otherwise)",
      posted.some((m) => m.type === "progress" && m.phase === "design-system"));

    posted.length = 0;
    await sandbox.collectFull({ css: false });
    ok("[PROGRESS] a collector driven OUTSIDE a bracketed run posts nothing at all", posted.length === 0);

    // ---- cancel mid-export, on a BRIDGE-triggered run ----
    // The trap page requests the cancel while its children are being read, so the very next safe point
    // (the top-level frame loop) is where the walk aborts.
    posted.length = 0;
    let cancelHit = null as RunInfo | null; // widened: TS cannot see the getter below assign it
    const trapPage = { id: "p:trap", name: "Trap", loadAsync: async () => {}, findAllWithCriteria: () => [],
      get children() { cancelHit = sandbox.requestCancel(); return [scrollFrame]; } };
    sandbox.figma.root.children = [trapPage, pc2];
    let cancelErr: Thrown | null = null, cancelled: FullResult | null = null;
    try {
      cancelled = await sandbox.serializeRun(() => sandbox.collectFull({ allPages: true, css: false }), { source: "bridge", label: "exportFull" });
    } catch (e) { cancelErr = thrown(e); }
    // (c): a cancelled run must REJECT. A partial layers doc returned as if complete is the silent
    // truncation this codebase refuses everywhere else.
    ok("[CANCEL] a cancelled run rejects — no partial doc is ever handed back", cancelled === null && !!cancelErr);
    // (a): this exact string is what main.ts puts in `bridge-result.error`, so the CLI/MCP fails fast
    // with a human cause instead of sitting out its request timeout.
    ok("[CANCEL] with the message the CLI/MCP prints verbatim", /export cancelled by the designer in Figma/.test(cancelErr!.message));
    ok("[CANCEL] the cancel was matched to the live run", !!(cancelHit && cancelHit.source === "bridge" && cancelHit.label === "exportFull"));
    ok("[CANCEL] the bridge-triggered run was visible in the plugin window, and for whom",
      posted.some((m) => m.type === "run-begin" && m.source === "bridge" && m.label === "exportFull"));
    ok("[CANCEL] the run is still closed out, so the UI cannot hang on a cancelled export",
      posted[posted.length - 1].type === "run-end");

    // ---- cancel INSIDE the component-catalog walk ----
    // The one place a run flips a GLOBAL Figma toggle (skipInvisibleInstanceChildren). Its `finally`
    // has to restore it on the cancellation path too, or every later export silently loses hidden
    // instance children.
    posted.length = 0;
    sandbox.figma.skipInvisibleInstanceChildren = false;
    const catA = { id: "p:catA", name: "Cat A", children: [], loadAsync: async () => {},
      findAllWithCriteria: () => { sandbox.requestCancel(); return []; } };
    sandbox.figma.root.children = [catA, pcPage("p:catB", "Cat B", [])];
    let dsErr: Thrown | null = null;
    try { await sandbox.serializeRun(() => sandbox.collectDesignSystemOnly({}), { source: "ui", label: "exportDesignSystem" }); } catch (e) { dsErr = thrown(e); }
    ok("[CANCEL] a cancel inside the component-catalog page walk aborts it as well",
      !!dsErr && /export cancelled by the designer in Figma/.test(dsErr.message));
    ok("[CANCEL] and skipInvisibleInstanceChildren is restored, not stranded on", sandbox.figma.skipInvisibleInstanceChildren === false);
    delete sandbox.figma.skipInvisibleInstanceChildren;

    // (b): the whole point of resetting state — the NEXT export has to work.
    posted.length = 0;
    sandbox.figma.root.children = [pc1, pc2];
    const after = await sandbox.serializeRun(() => sandbox.collectFull({ allPages: true, css: false }), { source: "ui", label: "after-cancel" });
    ok("[CANCEL] state is fully reset: the very next export runs to completion", after.layersDoc.layers.length > 0);
    ok("[CANCEL] …and reports progress normally again", posted.some((m) => m.type === "progress" && m.phase === "pages"));

    // (d): a cancel that landed on a run which finished before reaching a safe point must not carry
    // over. The flag is cleared at the START of every run precisely so a stale one can't kill the next.
    await sandbox.serializeRun(async () => { sandbox.requestCancel(); return "done"; }, { source: "ui", label: "stale" });
    const survivor = await sandbox.serializeRun(() => sandbox.collectFull({ allPages: true, css: false }), { source: "ui", label: "next" });
    ok("[CANCEL] a STALE cancel does not abort the following export", survivor.layersDoc.layers.length > 0);
    ok("[CANCEL] a cancel with nothing running is refused outright, not armed for later", sandbox.requestCancel() === null);

    sandbox.figma.root.children = prevKidsPC;
    sandbox.figma.ui.postMessage = prevPost;
  }

  report();
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
