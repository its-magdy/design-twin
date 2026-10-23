// The fake Figma the plugin's main thread runs against offline: a fresh world per case, built from a scene.
//
//   const w = fakeWorld(base, { selection: [node], variables: { v_x: X } }, { loadAllPagesAsync: async () => { throw … } });
//   await w.api.collectSelection();   // the plugin's own read API, from a VM that has seen nothing before
//   w.posted                           // every message the plugin posted to its UI
//   await w.send({ type: "bridge", … }) // one UI -> main message through main.ts's real handler; returns what it posted
//
// A scene DESCRIBES the file — its pages, the selection, the nodes/styles/variables/images reachable by id — and the
// Plugin API lookups are derived from it in one place, so a case says what is in the file rather than re-implementing
// getNodeByIdAsync. `overrides` are for what a description cannot say: a call that throws, counts, or changes the
// answer mid-run, or a lookup that must not see the base file's entries (a delta's tables only add to them). The lookups read the world's tables LIVE (`w.scene`), so a case may change its own file between two
// reads; nothing it changes reaches another case.
//
// Each world is a new VM running the plugin bundle, which is built ONCE per process from the current
// figma-plugin/src (build-options.ts, in memory): the plugin's module-level run state (state.ts — the memo caches,
// runOpts, the run chain) starts empty for every case, and the code under test is never a stale committed code.js.
import fs from "node:fs";
import vm from "node:vm";
import esbuild from "esbuild";
import { CODE_JS, pluginBuildOptions } from "../figma-plugin/build-options.ts";
import type {
  IrNode, ScreenExport, Manifest, VariablesDoc, DesignSystemDoc, DesignSystemStyles, CatalogComponent, LayersDoc, Asset,
} from "../bridge/src/doc-types.ts";
import type { ScreenReply, FullExportReply, DesignSystemReply, ListLibrariesReply } from "../bridge/src/commands.ts";
import type { ReadOptName } from "../bridge/src/read-opts.ts";

// ---- the fakes: stand-ins for Plugin API objects. code.js duck-types everything it is handed, so these
// are plain objects; the types below name only what the harness itself builds or reads back. (The real
// Plugin API typings are not visible to test/tsconfig.json — `types: ["bun"]` — and would not describe
// these partial doubles anyway.)

/** Any fake Plugin API object: a scene node, a page, a style, a main component, a write target. */
export interface FakeNode {
  type?: string;
  name?: string;
  id?: string;
  visible?: boolean;
  children?: readonly FakeNode[];
  [field: string]: unknown;
}
export interface FakeVariable {
  id: string; name: string; resolvedType: string; variableCollectionId: string;
  scopes: string[]; codeSyntax: Record<string, string>; remote: boolean;
  description?: string; hiddenFromPublishing?: boolean; key?: string;
  /** raw Plugin API values: RGBA, number, or a VARIABLE_ALIAS — code.js decodes them */
  valuesByMode: Record<string, unknown>;
}
export interface FakeCollection { id: string; name: string; modes: Array<{ modeId: string; name: string }>; defaultModeId: string; key?: unknown }
interface FakeImage { getSizeAsync(): Promise<{ width: number; height: number }>; getBytesAsync(): Promise<Uint8Array> }
/** What the plugin posts to its UI (progress.ts): run-begin / progress / run-end frames. */
export interface PostedMessage {
  type: string; source?: string; label?: string; phase?: string;
  page?: { index: number; of: number; name: string; pageId?: string };
  nodes?: number; assets?: number;
  /** progress.ts run-begin / queued: the bridge request a run serves */
  requestId?: string;
  /** main.ts `bridge-result` */
  id?: string; ok?: boolean; result?: unknown; error?: string;
}
export interface FakeTeamLibrary {
  getAvailableLibraryVariableCollectionsAsync(): Promise<Array<{ name: string; key: string; libraryName: string }>>;
  getVariablesInLibraryCollectionAsync(key: string): Promise<Array<{ name: string; key: string; resolvedType: string }>>;
}
type FakePage = FakeNode & { selection: FakeNode[]; appendChild?: () => void };
export interface FakeFigma {
  mixed: symbol;
  showUI(): void;
  on(): void;
  /** `onmessage` is main.ts's UI -> main handler once code.js has been evaluated. */
  ui: { onmessage: ((msg: unknown) => Promise<void>) | null; postMessage(m: PostedMessage): void };
  clientStorage: { getAsync(): Promise<string>; setAsync(): Promise<void> };
  currentPage: FakePage;
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
  getLocalCustomAnimationStylesAsync?(): Promise<FakeNode[]>;
  variables: {
    getLocalVariablesAsync(): Promise<FakeVariable[]>;
    getLocalVariableCollectionsAsync(): Promise<FakeCollection[]>;
    getVariableByIdAsync(id: string): Promise<FakeVariable | null>;
    getVariableCollectionByIdAsync(id: string): Promise<FakeCollection | null>;
  };
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
export interface FullResult extends FullExportReply {
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
  childCount?: number; title?: string; distinctTexts?: string[];
  children?: undefined; fills?: undefined; layout?: undefined; tokens?: undefined;
}
interface ListPagesResult {
  exportedAt: string; file: string; depth: number;
  pages: Array<{ name: string; id: string; current?: true; unreadable?: true; frames?: NodeSummary[] }>;
  manifest: { pages: number; frames?: number; warnings: string[] };
  /** never emitted (asserted) */
  assets?: undefined;
}
export interface ListChildrenResult {
  exportedAt: string; id: string; name: string; type: string; children: NodeSummary[];
  manifest: { children: number; warnings: string[] };
  /** never emitted (asserted) */
  assets?: undefined;
}
/** writes.ts WriteResult (applied rows are `{ id }`) */
export interface WriteResult { ok: boolean; applied: Array<{ id?: string }>; failedAt?: number; failedOp?: string; error?: string }
interface WriteOp { op: string; [field: string]: unknown }
/** progress.ts RunInfo */
export interface RunInfo { source: "ui" | "bridge"; label: string; requestId?: string }
/** collect.ts ScreenshotResult (w/h/scale). */
interface ScreenshotOut { id: string; name: string; type: string; w?: number; h?: number; scale?: number; reference: string; assets: Asset[] }
/** collect.ts CollectOpts */
interface CollectOpts extends Partial<Record<ReadOptName, boolean>> { allPages?: boolean; page?: string | string[] }
export interface DesignExportApi {
  serialize(node: FakeNode, depth: number, parentControlsLayout?: boolean): Promise<IrNode>;
  collectSelection(opts?: CollectOpts): Promise<SelectionResult>;
  collectNode(rawId: string, opts?: CollectOpts): Promise<SelectionResult>;
  collectFull(opts?: CollectOpts): Promise<FullResult>;
  collectDesignSystemOnly(opts?: CollectOpts): Promise<DesignSystemResult>;
  collectLibraryFile(opts?: CollectOpts & { asLibrary?: string }): Promise<DesignSystemResult>;
  buildDesignSystem(): Promise<DesignSystemOut>;
  listPages(opts?: { depth?: number }): Promise<ListPagesResult>;
  listChildren(rawId: string): Promise<ListChildrenResult>;
  listLibraries(): Promise<ListLibrariesReply>;
  collectLibraryComponents(sink?: (m: string) => void): Promise<CatalogComponent[]>;
  applyWrites(ops?: WriteOp[]): Promise<WriteResult>;
  serializeRun<T>(fn: () => Promise<T>, run: RunInfo): Promise<T>;
  requestCancel(): RunInfo | null;
  collectScreenshot(rawId: string, opts?: { scale?: number }): Promise<ScreenshotOut>;
  /** state.ts assetRetention: entries the run-owned asset array and dedupe tables still hold. */
  assetRetention(): { assets: number; byContent: number; byName: number };
}

// ---- the scene: what is in the file

/** A style lookup's answer: the style, or a thunk (to count lookups, or throw as a failing lookup does). */
type StyleEntry = FakeNode | (() => FakeNode | null);
export interface Scene {
  file?: { name?: string; colorProfile?: string; fileKey?: string; editorType?: string };
  /** figma.root.children */
  pages?: FakeNode[];
  /** figma.currentPage (its `selection` is replaced by `selection` below when that is given) */
  currentPage?: FakePage;
  selection?: FakeNode[];
  /** getNodeByIdAsync's table, by id */
  nodes?: Record<string, FakeNode>;
  /** getStyleByIdAsync's table, by id */
  styles?: Record<string, StyleEntry>;
  /** the getLocal*StylesAsync lists; `animation: null` = a runtime without getLocalCustomAnimationStylesAsync */
  localStyles?: { paint?: FakeNode[]; text?: FakeNode[]; effect?: FakeNode[]; grid?: FakeNode[]; animation?: FakeNode[] | null };
  /** this file's variables and collections: listed by getLocal*Async AND resolvable by id */
  variables?: Record<string, FakeVariable>;
  collections?: Record<string, FakeCollection>;
  /** a library's variables and collections: resolvable by id only, never listed (as the Plugin API does for consumed ones) */
  remote?: { variables?: Record<string, FakeVariable>; collections?: Record<string, FakeCollection> };
  /** getImageByHash's table, by hash */
  images?: Record<string, FakeImage>;
  teamLibrary?: FakeTeamLibrary;
  rootPluginData?: (key: string) => string;
}
/** A scene with every table present: what a world's lookups read, live. */
export interface ResolvedScene {
  nodes: Record<string, FakeNode>;
  styles: Record<string, StyleEntry>;
  localStyles: { paint: FakeNode[]; text: FakeNode[]; effect: FakeNode[]; grid: FakeNode[]; animation: FakeNode[] | null };
  variables: Record<string, FakeVariable>;
  collections: Record<string, FakeCollection>;
  remote: { variables: Record<string, FakeVariable>; collections: Record<string, FakeCollection> };
  images: Record<string, FakeImage>;
}
/** Behaviour a scene cannot describe, set on the fake after it is built (`variables` is merged, not replaced). */
export type FakeOverrides = Partial<Omit<FakeFigma, "variables">> & { variables?: Partial<FakeFigma["variables"]> };

export interface World {
  figma: FakeFigma;
  api: DesignExportApi;
  scene: ResolvedScene;
  /** every message the plugin posted to its UI, in order (clear it with `posted.length = 0`) */
  posted: PostedMessage[];
  /** one UI -> main message through main.ts's handler; resolves to what the plugin posted while handling it */
  send(msg: unknown): Promise<PostedMessage[]>;
}

/** figma.mixed. One symbol for every world, so a fixture can carry it before its world exists. */
export const MIXED = Symbol("figma.mixed");

// ---- the plugin bundle: built once per process from the current sources
const built = await esbuild.build({ ...pluginBuildOptions(), write: false, logLevel: "silent" });
const bundleText = built.outputFiles?.[0]?.text;
if (bundleText === undefined) throw new Error("fake-figma: esbuild produced no bundle for figma-plugin/src/main.ts");
const BUNDLE = new vm.Script(bundleText, { filename: "figma-plugin/code.js (built from src/)" });
/** False when the committed figma-plugin/code.js is not what src/ builds to (run `bun figma-plugin/build.ts`). */
export const committedBundleFresh = fs.existsSync(CODE_JS) && fs.readFileSync(CODE_JS, "utf8") === bundleText;

// main.ts announces itself on every load; one line per world is noise. Everything else the plugin logs passes through.
const LOAD_LINE = /^\[export\] (main\.ts loaded|main thread ready)/;
const pluginConsole: Pick<Console, "log" | "info" | "warn" | "error" | "debug"> = {
  log: (...a: unknown[]) => { if (!(typeof a[0] === "string" && LOAD_LINE.test(a[0]))) console.log(...a); },
  info: (...a: unknown[]) => console.info(...a),
  warn: (...a: unknown[]) => console.warn(...a),
  error: (...a: unknown[]) => console.error(...a),
  debug: (...a: unknown[]) => console.debug(...a),
};

const API_MEMBERS: Record<keyof DesignExportApi, true> = {
  serialize: true, collectSelection: true, collectNode: true, collectFull: true, collectDesignSystemOnly: true, collectLibraryFile: true,
  buildDesignSystem: true, listPages: true, listChildren: true, listLibraries: true, collectLibraryComponents: true,
  applyWrites: true, serializeRun: true, requestCancel: true, collectScreenshot: true, assetRetention: true,
};
const missingApi = (c: Record<string, unknown>): string[] => Object.keys(API_MEMBERS).filter((k) => typeof c[k] !== "function");
// The one VM boundary: what code.js put on its global is untyped to this realm (see DesignExportApi). Narrowed by a
// runtime check — every API member present as a function — so a bundle that stopped exporting a method fails here by
// name, not as a TypeError at first use.
function isApi(c: Record<string, unknown>): c is Record<string, unknown> & DesignExportApi {
  return missingApi(c).length === 0;
}

const noop = (): void => {};

/** A fresh world: `base` with `delta` over it (tables merged by key, everything else replaced), then `overrides`. */
export function fakeWorld(base: Scene, delta: Scene = {}, overrides: FakeOverrides = {}): World {
  const scene: ResolvedScene = {
    nodes: { ...base.nodes, ...delta.nodes },
    styles: { ...base.styles, ...delta.styles },
    localStyles: {
      paint: [], text: [], effect: [], grid: [], animation: [],
      ...base.localStyles, ...delta.localStyles,
    },
    variables: { ...base.variables, ...delta.variables },
    collections: { ...base.collections, ...delta.collections },
    remote: {
      variables: { ...base.remote?.variables, ...delta.remote?.variables },
      collections: { ...base.remote?.collections, ...delta.remote?.collections },
    },
    images: { ...base.images, ...delta.images },
  };
  const file = { ...base.file, ...delta.file };
  // The page object itself, not a copy: a case's page may have getters, or be the same object it also puts in `nodes`.
  const currentPage = delta.currentPage ?? base.currentPage ?? { name: "Page 1", selection: [], children: [] };
  const selection = delta.selection ?? base.selection;
  if (selection) currentPage.selection = selection;
  const posted: PostedMessage[] = [];
  const rootPluginData = delta.rootPluginData ?? base.rootPluginData;
  const teamLibrary = delta.teamLibrary ?? base.teamLibrary;

  const figma: FakeFigma = {
    mixed: MIXED,
    showUI: noop, on: noop,
    ui: { onmessage: null, postMessage: (m) => { posted.push(m); } },
    clientStorage: { getAsync: async () => "", setAsync: async () => {} },
    currentPage,
    fileKey: file.fileKey ?? "",
    root: {
      name: file.name ?? "", documentColorProfile: file.colorProfile ?? "",
      children: delta.pages ?? base.pages ?? [],
      ...(rootPluginData ? { getPluginData: rootPluginData } : {}),
    },
    loadAllPagesAsync: async () => {},
    getImageByHash: (hash) => scene.images[hash] ?? null,
    getNodeByIdAsync: async (id) => scene.nodes[id] ?? null,
    getStyleByIdAsync: async (id) => {
      const s = scene.styles[id];
      return typeof s === "function" ? s() : s ?? null;
    },
    getLocalPaintStylesAsync: async () => scene.localStyles.paint,
    getLocalTextStylesAsync: async () => scene.localStyles.text,
    getLocalEffectStylesAsync: async () => scene.localStyles.effect,
    getLocalGridStylesAsync: async () => scene.localStyles.grid,
    variables: {
      getLocalVariablesAsync: async () => Object.values(scene.variables),
      getLocalVariableCollectionsAsync: async () => Object.values(scene.collections),
      getVariableByIdAsync: async (id) => scene.variables[id] ?? scene.remote.variables[id] ?? null,
      getVariableCollectionByIdAsync: async (id) => scene.collections[id] ?? scene.remote.collections[id] ?? null,
    },
    ...(file.editorType !== undefined ? { editorType: file.editorType } : {}),
    ...(teamLibrary ? { teamLibrary } : {}),
  };
  if (scene.localStyles.animation !== null) figma.getLocalCustomAnimationStylesAsync = async () => scene.localStyles.animation ?? [];
  const { variables: varOverrides, ...rest } = overrides;
  Object.assign(figma, rest);
  if (varOverrides) Object.assign(figma.variables, varOverrides);

  const context: Record<string, unknown> = {
    figma, __html__: "<ui/>", Promise, JSON, Math, Array, Object, Symbol, Map, Set, Date, console: pluginConsole,
    parseInt, Number, String, Boolean, isNaN, undefined,
  };
  vm.createContext(context);
  BUNDLE.runInContext(context);
  // code.js is an esbuild IIFE bundle; it exposes its read API on a namespaced global.
  const exported = context.__designExport;
  const api: Record<string, unknown> = typeof exported === "object" && exported !== null ? { ...exported } : {};
  if (!isApi(api)) throw new Error(`code.js did not expose the export API: missing ${missingApi(api).join(", ")}`);

  return {
    figma, api, scene, posted,
    async send(msg) {
      const handler = figma.ui.onmessage;
      if (!handler) throw new Error("code.js did not register figma.ui.onmessage");
      const from = posted.length;
      await handler(msg);
      return posted.slice(from);
    },
  };
}
