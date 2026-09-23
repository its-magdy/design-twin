// types.ts — the shared shapes of every JSON document the design-to-code layer reads or writes.
//
// Types only (plus two one-line JSON type guards at the bottom). Nothing here runs at import time.
//
// Derived from FOUR sources, reconciled in this order of authority:
//   1. The PRODUCER: figma-plugin/src/serialize.ts (+ paint.ts, text.ts, layout.ts, effects.ts,
//      prototype.ts, variables.ts, components.ts, libraries.ts, assets.ts, collect.ts, state.ts) and the
//      bridge writers that put those documents on disk (bridge/pages-layout.js, design-system-layout.js,
//      variables-merge.js, write-out.js). The plugin types its output as a loose string-keyed bag
//      (util.ts `Obj`), so what it ASSIGNS is what is declared here.
//      RULE: the producer (serialize.ts) is authoritative for IR field names. A field a consumer reads
//      that the producer never writes is either marked `// TODO(ts-port): unverified field` below (when
//      the port brief asked for it) or deliberately left out and listed in the phase-3a report.
//   2. The real exports under test/fixtures/livetest3/ (pages/**, design-system/*.json, variables.json,
//      plan/**, verify/**, mapping.reference.json), test/fixtures/audit/*.json and test/fixtures/livetest4/
//      (a key/kind census over every node of every fixture tree was run for the IR).
//   3. TESTING.md "What the agent verifies in the exported JSON" and docs/design-to-code-spec.md.
//   4. Every property access in design-to-code/*.js (the consumers), which decided which fields are
//      `?:` and which string values are literal unions (finding codes, kinds, verdicts, platforms).
//
// Conventions: `?:` on every field that a fixture or the producer treats as optional (the producer
// emits nothing rather than an empty object — util.ts `nonEmpty`/`putNonEmpty`). Open vocabularies that
// the producer passes through from the Figma API verbatim (node type, trigger, action type) are a
// literal union plus `(string & {})` so `n.type === "INSTANCE"` narrows while a value this file does not
// list still type-checks. Closed vocabularies this repo owns (finding codes, map kinds, verdicts) are
// plain literal unions.

// ================================================================ raw JSON

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

// ================================================================ the IR (one node of a screen tree)

/** Figma SceneNode.type, passed through verbatim by serialize.ts. */
export type IrNodeType =
  | "FRAME" | "GROUP" | "SECTION" | "COMPONENT" | "COMPONENT_SET" | "INSTANCE"
  | "TEXT" | "TEXT_PATH" | "RECTANGLE" | "ELLIPSE" | "POLYGON" | "STAR" | "LINE" | "VECTOR"
  | "BOOLEAN_OPERATION" | "TABLE" | "SLICE" | "STICKY" | "SHAPE_WITH_TEXT" | "CONNECTOR"
  | (string & {});

/** node.tokens / paint.tokens / effect.tokens / run.tokens: boundVariables resolved to token NAMES.
 *  A field bound to several variables (e.g. `fills` with several paints) carries an array. */
export type TokenMap = Record<string, string | string[]>;

export interface XY { x: number; y: number }

/** `box`: the absoluteBoundingBox, page-space. `x`/`y` only when the parent does not auto-position
 *  the node (serialize.ts) — inside an auto-layout parent they are absent on purpose. */
export interface Box { w: number; h: number; x?: number; y?: number }
/** `renderBox`: absoluteRenderBounds (stroke/shadow/blur extent), emitted only when it differs from `box`. */
export interface RenderBox { x: number; y: number; w: number; h: number }

export interface RadiusCorners { tl?: number; tr?: number; br?: number; bl?: number }

export interface SizeLimits { minWidth?: number; maxWidth?: number; minHeight?: number; maxHeight?: number }

/** Lowercased Figma ConstraintType. */
export type PinMode = "min" | "center" | "max" | "stretch" | "scale";
export interface Pin { h: PinMode; v: PinMode }

// ---- layout (layout.ts). ONE interface, not a discriminated union: every consumer reads it as an
// optional bag (`node.layout.mode === "absolute"`, `node.layout.padding`, …) without narrowing first.
// Flex: display:"flex" + flexDirection; grid: display:"grid"; no auto-layout: mode:"absolute" + width/height.
export type FlexAlign = "flex-start" | "center" | "flex-end" | "space-between" | "baseline";
export interface GridTrack { type?: "flex" | "fixed" | "hug"; value?: number }
export interface LayoutSpec {
  display?: "flex" | "grid";
  mode?: "absolute";
  /** With mode:"absolute" only — the frame's own size. */
  width?: number;
  height?: number;
  flexDirection?: "row" | "column";
  gap?: number;
  /** [top, right, bottom, left] */
  padding?: number[];
  justifyContent?: FlexAlign;
  alignItems?: FlexAlign;
  flexWrap?: "wrap";
  rowGap?: number;
  alignContent?: FlexAlign;
  /** auto-layout was INFERRED (node.inferredAutoLayout) — not set by the designer. */
  inferred?: true;
  reverseZ?: true;
  // grid
  columns?: number;
  rows?: number;
  columnGap?: number;
  columnSizes?: GridTrack[];
  rowSizes?: GridTrack[];
  autoFlow?: string;
  autoTracks?: string;
}

/** Per-frame layout grids (layout.ts simplifyGrid). */
export interface LayoutGridSpec {
  pattern?: "columns" | "rows" | "grid";
  size?: number;
  gutter?: number;
  count?: number;
  offset?: number;
  alignment?: "min" | "max" | "center" | "stretch";
  visible?: false;
}

// ---- paints (paint.ts simplifyFills). Discriminated on `type`.
export interface PaintBase {
  /** Lowercased paint blendMode, omitted when NORMAL. */
  blend?: string;
  /** Non-solid paints only (a SOLID folds opacity into its hex alpha). */
  opacity?: number;
  /** Paint-level variable bindings (e.g. `{ color: "Primary/Primary" }`). */
  tokens?: TokenMap;
  /** Never emitted (invisible paints are filtered out); verify-screen.js still tests `!== false`. */
  visible?: boolean;
}
export interface SolidPaint extends PaintBase { type: "solid"; color: string }
export interface GradientStop { pos: number; color: string; tokens?: TokenMap }
export interface GradientPaint extends PaintBase {
  type: "gradient";
  kind: "GRADIENT_LINEAR" | "GRADIENT_RADIAL" | "GRADIENT_ANGULAR" | "GRADIENT_DIAMOND";
  stops?: GradientStop[];
  transform?: number[][];
}
export interface ImageFilters {
  exposure?: number; contrast?: number; saturation?: number; temperature?: number; tint?: number; highlights?: number; shadows?: number;
}
export interface MediaPaint extends PaintBase {
  type: "image" | "video";
  scaleMode?: "fill" | "fit" | "crop" | "tile";
  /** correlates the fill to an exported source asset */
  hash?: string;
  scale?: number;
  rotation?: number;
  /** crop rect transform */
  transform?: number[][];
  filters?: ImageFilters;
  /** native pixel size of the source image (image paints only) */
  intrinsicSize?: { w: number; h: number };
}
export interface PatternPaint extends PaintBase {
  type: "pattern";
  sourceNodeId?: string;
  tileType?: string;
  scale?: number;
  spacing?: XY;
  align?: string;
}
export interface ShaderPaint extends PaintBase { type: "shader"; shaderId?: string }
export type Paint = SolidPaint | GradientPaint | MediaPaint | PatternPaint | ShaderPaint;

/** `strokes` is an OBJECT (paint.ts simplifyStrokes), never an array of paints. */
export interface Strokes {
  /** hex of every visible SOLID stroke paint */
  colors?: string[];
  /** every NON-solid stroke paint, in full */
  paints?: Paint[];
  weight?: number;
  /** per-side weights when strokeWeight is mixed */
  weights?: { top?: number; right?: number; bottom?: number; left?: number };
  align?: "inside" | "outside" | "center";
  dash?: number[];
  cap?: string;
  join?: string;
  miter?: number;
  variableWidth?: { profile: string; points: Array<{ pos: number; weight: number }> };
}

// ---- effects (effects.ts). Discriminated on `type` (lowercased Figma Effect.type).
export interface EffectBase { tokens?: TokenMap }
export interface ShadowEffect extends EffectBase {
  type: "drop_shadow" | "inner_shadow";
  color?: string;
  offset?: XY;
  radius?: number;
  spread?: number;
  blendMode?: string;
  behindNode?: true;
}
export interface BlurEffect extends EffectBase {
  type: "layer_blur" | "background_blur";
  radius?: number;
  blurType?: "progressive";
  startOffset?: XY;
  endOffset?: XY;
  startRadius?: number;
}
export interface NoiseEffect extends EffectBase {
  type: "noise";
  noiseType?: string; color?: string; density?: number; noiseSize?: number; noiseSizeVector?: XY; secondaryColor?: string; opacity?: number; blendMode?: string;
}
export interface GlassEffect extends EffectBase {
  type: "glass";
  lightIntensity?: number; lightAngle?: number; refraction?: number; depth?: number; dispersion?: number; radius?: number;
}
export interface TextureEffect extends EffectBase { type: "texture"; noiseSize?: number; noiseSizeVector?: XY; radius?: number; clipToShape?: boolean }
export interface ShaderEffect extends EffectBase { type: "shader"; shaderId?: string }
export type Effect = ShadowEffect | BlurEffect | NoiseEffect | GlassEffect | TextureEffect | ShaderEffect;

// ---- text (text.ts)
/** A Figma length. `{unit:"auto"}` carries no value (line-height AUTO). */
export interface LengthSpec { value?: number; unit: "px" | "percent" | "auto" }
export interface FontSpec {
  size?: number | "mixed";
  family?: string;
  /** Figma style name, verbatim: "Regular", "SemiBold", "Bold Italic"… */
  weight?: string;
  /** numeric CSS weight when the API exposes it (node-level only) */
  weightValue?: number;
  lineHeight?: LengthSpec;
  letterSpacing?: LengthSpec;
  case?: "upper" | "lower" | "title" | "small_caps" | "small_caps_forced";
  decoration?: "underline" | "strikethrough";
  decorationStyle?: string;
  decorationColor?: string;
  decorationThickness?: LengthSpec;
  decorationOffset?: LengthSpec;
  decorationSkipInk?: false;
  openType?: string[];
  /** first visible SOLID fill of the text, as hex */
  color?: string;
  // node-level only (not on runs[].font)
  align?: "left" | "center" | "right" | "justified";
  paragraphSpacing?: number;
  paragraphIndent?: number;
  listSpacing?: number;
  leadingTrim?: string;
  valign?: "center" | "bottom";
  textWrap?: "balance" | "pretty";
  hangingList?: true;
  hangingPunctuation?: true;
}
/** One styled segment of mixed-format text. */
export interface TextRun {
  text: string;
  font: FontSpec;
  href?: string;
  linkNode?: string;
  list?: string;
  indent?: number;
  textStyle?: string;
  fillStyle?: string;
  tokens?: TokenMap;
}

// ---- prototype (prototype.ts)
/** Lowercased Figma Trigger.type; "unknown" when the trigger had no type. */
export type ReactionTrigger =
  | "on_click" | "on_hover" | "on_press" | "on_drag" | "after_timeout" | "mouse_enter" | "mouse_leave"
  | "mouse_up" | "mouse_down" | "on_key_down" | "on_media_hit" | "on_media_end" | "unknown" | (string & {});
export type ActionType =
  | "back" | "close" | "url" | "node" | "set_variable" | "set_variable_mode" | "conditional" | "update_media_runtime" | (string & {});
export type ActionNavigation = "navigate" | "swap" | "overlay" | "scroll_to" | "change_to" | (string & {});
export interface Transition {
  type?: string;
  direction?: string;
  /** seconds */
  duration?: number;
  matchLayers?: boolean;
  easing?: string;
  cubicBezier?: unknown;
  spring?: unknown;
}
export interface Action {
  type: ActionType;
  navigation?: ActionNavigation;
  url?: string;
  destinationId?: string;
  /** the destination node's NAME, resolved */
  destination?: string;
  preserveScroll?: true;
  resetScroll?: true;
  resetVideo?: true;
  resetInteractive?: true;
  overlayOffset?: XY;
  transition?: Transition;
  // SET_VARIABLE / SET_VARIABLE_MODE / UPDATE_MEDIA_RUNTIME / CONDITIONAL
  variable?: string;
  value?: unknown;
  collection?: string;
  mode?: string;
  mediaAction?: string;
  amountToSkip?: number;
  newTimestamp?: number;
  conditionalBlocks?: Array<{ condition?: unknown; actions?: Action[] }>;
}
/** The real shape is `reactions[].actions[]` (plural on both) with `trigger` a plain string. */
export interface Reaction {
  trigger?: ReactionTrigger;
  timeout?: number;
  delay?: number;
  keyCodes?: number[];
  device?: string;
  mediaHitTime?: number;
  actions?: Action[];
}

// ---- components (components.ts)
/** INSTANCE → its main component; the join keys back to the catalog. */
export interface MainComponentRef {
  name: string;
  id?: string;
  key?: string;
  remote?: true;
  setId?: string;
  setKey?: string;
  setName?: string;
  /** the variant's own name, e.g. "Type=Primary, Status=Default" */
  variant?: string;
}
/** INSTANCE.componentProperties → `{ propName: value }` (Figma's "#id" suffix stripped). */
export type ComponentPropValues = Record<string, string | boolean>;

export interface Annotation { label?: string; markdown?: string; categoryId?: string; props?: string[] }
export interface ExportSetting { format: string; suffix?: string; constraint?: { type: string; value: number } }
export interface Overlay { position?: string; closeOnClickOutside?: true; background?: string }
export interface InstanceOverride { id: string; fields: string[] }
/** exportAsync failed but the node's resolved outlines were recovered (assets.ts geometryOf). */
export interface Geometry { fills?: string[]; strokes?: string[]; w?: number; h?: number }
export interface TableCell extends Partial<TextFields> { row: number; col: number; fills?: Paint[] }
export interface DevResource { name: string; url: string; nodeId?: string; inheritedNodeId?: string }
/** Node-level style references (variables.ts nodeStyles): style NAMES, by slot. */
export interface StyleRefs { fill?: string; stroke?: string; effect?: string; text?: string; grid?: string }
/** `{ collectionName: modeName }` (an unreadable collection keeps its raw ids). */
export type ModeMap = Record<string, string>;

/** The text surface (text.ts serializeText), merged into a TEXT / TEXT_PATH node. */
export interface TextFields {
  text: string;
  /** mixed-format text: one entry per styled run (font is then the FIRST run's) */
  runs?: TextRun[];
  font?: FontSpec;
  /** uniform text's own per-run bindings */
  textTokens?: TokenMap;
  href?: string;
  linkNode?: string;
  list?: string;
  indent?: number;
  autoResize?: "width_and_height" | "height" | "truncate";
  truncate?: true;
  maxLines?: number;
  missingFont?: true;
}

export interface IrNode extends Partial<TextFields> {
  type: IrNodeType;
  name: string;
  id: string;
  /** The ONE visibility flag (hidden.js): the designer switched this layer off. Descendants inherit it. */
  hidden?: true;
  // TODO(ts-port): unverified field — serialize.ts never writes `visible` (it writes `hidden`); kept
  // because component-match.js still tests `n.visible === false`. Also a component PROPERTY name.
  visible?: boolean;
  children?: IrNode[];

  // instance / component identity
  props?: ComponentPropValues;
  /** a BOOLEAN/TEXT prop whose value is driven by a variable */
  propTokens?: TokenMap;
  /** main component's bare name (INSTANCE) or the node's own name (COMPONENT / COMPONENT_SET) */
  component?: string;
  mainComponent?: MainComponentRef;
  // TODO(ts-port): unverified field — not emitted by serialize.ts (it emits `props`); listed in the
  // port brief only.
  componentProperties?: unknown;
  /** which component prop drives this sublayer's visibility / text / swapped instance */
  propRefs?: { visible?: string; characters?: string; mainComponent?: string };
  overrides?: InstanceOverride[];
  exposedInstances?: string[];
  detachedFrom?: { key?: string; componentId?: string };

  // geometry + layout
  x?: number;
  y?: number;
  box?: Box;
  renderBox?: RenderBox;
  layout?: LayoutSpec;
  layoutGrids?: LayoutGridSpec[];
  absolute?: true;
  /** layoutGrow (Figma emits 0|1; only a truthy value is written) */
  grow?: number;
  alignSelf?: "min" | "center" | "max" | "stretch";
  /** FIXED (the default) is never written. */
  widthMode?: "fill" | "hug";
  heightMode?: "fill" | "hug";
  scroll?: "horizontal" | "vertical" | "both";
  gridColumnSpan?: number;
  gridRowSpan?: number;
  gridColumnStart?: number;
  gridRowStart?: number;
  gridJustifySelf?: "start" | "center" | "end";
  gridAlignSelf?: "start" | "center" | "end";
  sizeLimits?: SizeLimits;
  pin?: Pin;
  fixedChildren?: number;
  clip?: true;

  // paint
  fills?: Paint[];
  strokes?: Strokes;
  strokesInLayout?: true;
  effects?: Effect[];
  radius?: number | RadiusCorners;
  /** the corner was Figma's "fully rounded" sentinel; `radius` holds what actually renders */
  radiusFull?: true;
  opacity?: number;
  rotation?: number;
  flipped?: true;
  skew?: number;
  blendMode?: string;
  mask?: true;
  maskType?: string;
  cornerSmoothing?: number;
  aspectRatio?: number;
  arc?: { start?: number; end?: number; innerRadius?: number };
  shape?: { points?: number; innerRadius?: number };
  booleanOp?: "union" | "intersect" | "subtract" | "exclude";
  exportSettings?: ExportSetting[];
  overlay?: Overlay;

  // TODO(ts-port): unverified field — the producer writes the text under `text` (text.ts); verify-screen.js
  // reads `characters` as a fallback for an older export shape. No fixture carries it.
  characters?: string;

  // tokens / styles / prototype / handoff
  tokens?: TokenMap;
  styles?: StyleRefs;
  reactions?: Reaction[];
  /** modes pinned ON this node */
  variableModes?: ModeMap;
  /** root only: the EFFECTIVE mode per collection, ancestors and page included */
  resolvedModes?: ModeMap;
  annotations?: Annotation[];
  devStatus?: "ready_for_dev" | "completed";
  devStatusNote?: string;
  /** opt-in reads */
  css?: Record<string, string>;
  pluginData?: Record<string, string>;
  sharedData?: Record<string, Record<string, string>>;
  motion?: JsonObject;

  // assets (asset nodes are LEAVES — no children)
  asset?: string;
  assetSkipped?: true;
  geometry?: Geometry;
  tableCells?: TableCell[][];

  // root-only enrichment attached inline by collect.ts rootTree() (single-screen pulls)
  reference?: string;
  devResources?: DevResource[];
}

// ================================================================ the documents a pull writes

/** state.ts manifest(): {nodes, skipped, truncated, assetsFailed, warnings[]} + the raw counters. */
export interface Manifest {
  nodes: number;
  /** derived: === truncated */
  skipped: number;
  truncated: number;
  assetsFailed: number;
  assetsSkipped?: number;
  assetsSkippedInvisible?: number;
  assetsGeometry?: number;
  /** which opt-in reads ran */
  reads?: string[];
  warnings: string[];
}

export interface Measurement {
  page: string; pageId: string;
  start?: { nodeId?: string; side?: string }; end?: { nodeId?: string; side?: string };
  text?: string; offset?: number;
}

/** A `--node` / `--selection` pull: pages/<Page>/<Screen>__<id>.json (collect.ts screenResult → write-out.js writeScreen). */
export interface ScreenExport {
  exportedAt?: string;
  /** the human screen label (the layer name, or "selection") */
  screen?: string;
  nodes: IrNode[];
  manifest?: Manifest;
  page?: string;
  pageId?: string;
  nodeId?: string;
  measurements?: Measurement[];
  /** which Figma file the pull talked to (write-out.js, P4 #33) */
  sourceFile?: string;
  sourceFileKey?: string;
}

/** A page-walk layer file: pages/<Page>/<Layer>__<id>.json (pages-layout.js buildPageLayout). */
export interface LayerFile {
  name: string;
  id: string;
  page?: string;
  pageId?: string;
  sourceFile?: string;
  tree: IrNode;
  reference?: string;
  devResources?: DevResource[];
  manifest?: Manifest;
}

/**
 * ANY document shape a screen reader accepts — the three `rootsOf()` implementations do
 * `Array.isArray(doc.nodes) ? doc.nodes : doc.tree ? [doc.tree] : doc.id || doc.type ? [doc] : []`.
 * One wide optional bag rather than a union, so that duck-typing stays legal without `in` narrowing.
 * ScreenExport, LayerFile and IrNode are each assignable to it.
 */
export interface ScreenDoc {
  nodes?: IrNode[];
  tree?: IrNode;
  id?: string;
  type?: string;
  name?: string;
  screen?: string;
  exportedAt?: string;
  manifest?: Manifest;
  page?: string;
  pageId?: string;
  nodeId?: string;
  reference?: string;
  devResources?: DevResource[];
  resolvedModes?: ModeMap;
  sourceFile?: string;
  measurements?: Measurement[];
  children?: IrNode[];
}

/** One row of pages/index.json `layers[]` / pages/<Page>/index.json `layers[]` — a page-walk row
 *  (name/id/type/page/pageId/nodes/bytes/title/texts/file) or a single-screen row (write-out.js
 *  writeScreen `entry`: + exportedAt/variables/assets/reference/w/h). */
export interface IndexRow {
  name: string;
  id: string;
  type?: IrNodeType;
  page?: string;
  pageId?: string;
  /** relative to the export root: pages/<dir>/<Layer>__<id>.json */
  file: string;
  nodes?: number;
  bytes?: number;
  /** the visible on-screen title (pages-layout.js deriveTitle), absent when none could be derived */
  title?: string;
  /** the first distinct TEXT strings, reading order */
  texts?: string[];
  exportedAt?: string;
  sourceFile?: string;
  /** sibling <Screen>.vars.json */
  variables?: string;
  /** sibling <Screen>.assets.json */
  assets?: string;
  reference?: string;
  w?: number;
  h?: number;
}
export interface PageDirEntry { page: string; pageId?: string; dir: string; index: string; layers: number }
export interface PageIndex { page: string; pageId?: string; layers: IndexRow[] }
export interface PrototypeFlow { page: string; pageId: string; nodeId: string; name: string }
export interface PageSettings { page: string; pageId: string; background?: Paint[]; prototypeBackground?: Paint[] }
/** pages/index.json (pages-layout.js meta + mergeRootIndex). `layers` is absent on the oldest exports. */
export interface PagesRootIndex {
  pageDirs: PageDirEntry[];
  layers?: IndexRow[];
  exportedAt?: string;
  scope?: "all-pages" | "page" | "current-page";
  page?: string;
  pages?: string[];
  flows?: PrototypeFlow[];
  pageSettings?: PageSettings[];
  measurements?: Measurement[];
  manifest?: Manifest;
  sourceFile?: string;
  sourceFileKey?: string;
}

// ================================================================ the design system (split files)

/** The stamp every design-system file repeats (design-system-layout.js). */
export interface DesignSystemStamp {
  exportedAt?: string;
  file?: string;
  colorProfile?: "legacy" | "srgb" | "display-p3" | (string & {});
}

/** design-system.json — the slim POINTER manifest (never a payload; catalog-input.js refuses it). */
export interface DesignSystemManifest extends DesignSystemStamp {
  files: {
    tokens: string; stylesPaint: string; stylesText: string; stylesEffect: string; stylesGrid: string;
    componentsLocal: string; componentsLibrary: string; hygiene: string;
    /** only when a COMPONENT_SET detail file was written */
    componentsDir?: string;
  };
  counts: {
    collections: number; variables: number; stylesPaint: number; stylesText: number; stylesEffect: number; stylesGrid: number;
    components: number; libraryComponents: number; hygiene: number;
  };
}

export type VariableType = "COLOR" | "FLOAT" | "STRING" | "BOOLEAN";
export interface VariableAlias { aliasOf: string }
/** A per-mode value: COLOR → hex string (alpha kept); FLOAT → number; STRING/BOOLEAN → as is; alias → {aliasOf}. */
export type VariableValue = string | number | boolean | VariableAlias;
export interface VariableCollection {
  name: string;
  modes: string[];
  /** the base/`:root` mode */
  default?: string;
  theming: boolean;
  extended?: true;
  hiddenFromPublishing?: true;
  key?: string;
  /** library mode only: current | changed | unpublished */
  publish?: string;
}
export interface Variable {
  name: string;
  type: VariableType;
  collection: string;
  tier: "primitive" | "semantic";
  /** keyed by MODE NAME */
  values: Record<string, VariableValue>;
  scopes?: string[];
  codeSyntax?: { WEB?: string; ANDROID?: string; iOS?: string };
  description?: string;
  remote?: true;
  hiddenFromPublishing?: true;
  /** durable cross-file identity — a variable IS its key; names are not unique */
  key?: string;
  publish?: string;
}
/** One contributing pull recorded in a merged variables.json (variables-merge.js sliceEntry). */
export interface SliceEntry {
  screen: string;
  file?: string;
  at: string;
  variables: number;
  collections: number;
  /** every variable key this pull carried */
  keys?: string[];
}
export interface ValueConflict {
  kind?: "value";
  name: string; collection?: string; key?: string;
  was?: Record<string, VariableValue>; now?: Record<string, VariableValue>;
  from?: string;
}
export interface SameNameConflict {
  kind: "same-name";
  name: string; collection?: string; sameValue: boolean;
  variants: Array<{ key?: string; values?: Record<string, VariableValue>; screens: string[] }>;
}
export type VariableConflict = ValueConflict | SameNameConflict;
/**
 * design-system/tokens.json ({stamp, collections, variables}) AND the merged design/export/variables.json
 * / per-screen <Screen>.vars.json ({collections, variables, hygiene, _slices, _conflicts, _note,
 * exportedAt}) — the same token catalog shape, read by the same emitters (tokens.js). A merged union has
 * `exportedAt: null` until a slice carries an `at`.
 */
export interface TokensDoc extends Omit<DesignSystemStamp, "exportedAt"> {
  exportedAt?: string | null;
  collections?: VariableCollection[];
  variables?: Variable[];
  hygiene?: string[];
  _slices?: SliceEntry[];
  _conflicts?: VariableConflict[];
  _note?: string;
  /** library pulls only */
  source?: { role: "library"; libraryName?: string; fileKey?: string; collectionKeys?: string[] };
}
export type VariablesDoc = TokensDoc;

/** The catalog meta every style shares (components.ts styleMeta). */
export interface StyleMeta { key?: string; id?: string; remote?: true; docs?: string[]; publish?: string; description?: string; tokens?: TokenMap }
export interface PaintStyle extends StyleMeta { name: string; paints?: Paint[] }
export interface TextStyle extends StyleMeta {
  name: string;
  size?: number;
  /** font family */
  font?: string;
  weight?: string;
  lineHeight?: LengthSpec;
  letterSpacing?: LengthSpec;
  case?: string;
  decoration?: string;
  paragraphSpacing?: number;
  paragraphIndent?: number;
  leadingTrim?: string;
  listSpacing?: number;
  textWrap?: string;
}
export interface EffectStyle extends StyleMeta { name: string; effects?: Effect[] }
export interface GridStyle extends StyleMeta { name: string; grids?: LayoutGridSpec[] }
/** design-system/styles.<paint|text|effect|grid>.json */
export interface StylesDoc<S = PaintStyle | TextStyle | EffectStyle | GridStyle> extends DesignSystemStamp { styles: S[] }
export type PaintStylesDoc = StylesDoc<PaintStyle>;
export type TextStylesDoc = StylesDoc<TextStyle>;
export type EffectStylesDoc = StylesDoc<EffectStyle>;
export type GridStylesDoc = StylesDoc<GridStyle>;
/** design-system/hygiene.json */
export interface HygieneDoc extends DesignSystemStamp { hygiene: string[] }

export type ComponentPropType = "VARIANT" | "BOOLEAN" | "TEXT" | "INSTANCE_SWAP";
/** One componentPropertyDefinitions entry (real "#uid" key kept under `key`). */
export interface ComponentPropDef {
  key: string;
  type: ComponentPropType;
  /** VARIANT only */
  options?: string[];
  /** VARIANT/TEXT: string; BOOLEAN: boolean; INSTANCE_SWAP: a component id (string) */
  default?: string | boolean;
  preferredValues?: Array<{ type: string; key: string }>;
  description?: string;
  tokens?: TokenMap;
  /** library entries with derivedFrom:"instances" — the values SEEN, not the option list */
  observed?: Array<string | boolean>;
}
export interface CatalogVariant { id: string; name: string; key?: string; values?: Record<string, string>; node?: IrNode }
/**
 * One row of components.local.json (a local COMPONENT / COMPONENT_SET: id, page, pageId, props from
 * definitions, visuals) or components.library.json (a consumed library main recovered from instances
 * — remote:true, source, uses, derivedFrom; no id/page).
 */
export interface CatalogComponent {
  name: string;
  type: "COMPONENT" | "COMPONENT_SET";
  key?: string;
  id?: string;
  page?: string;
  pageId?: string;
  description?: string;
  remote?: true;
  docs?: string[];
  props?: Record<string, ComponentPropDef>;
  visuals?: { fills?: Paint[]; strokes?: Strokes; effects?: Effect[]; radius?: number | RadiusCorners; opacity?: number; blendMode?: string };
  publish?: string;
  /** COMPONENT_SET: the variants (their node trees split out to `variantsFile`) */
  variants?: CatalogVariant[];
  variantsFile?: string;
  /** standalone COMPONENT with variantVisuals: its node tree, split out to `nodeFile` */
  node?: IrNode;
  nodeFile?: string;
  // library entries only (libraries.ts)
  source?: string;
  uses?: number;
  variant?: string;
  derivedFrom?: "definitions" | "instances";
}
/** design-system/components.local.json / components.library.json */
export interface ComponentsCatalog extends DesignSystemStamp { components: CatalogComponent[] }
/** design-system/components/<name>__<id>.json — a COMPONENT_SET's variants with node trees, or a COMPONENT's node. */
export interface ComponentDetailFile extends DesignSystemStamp {
  name: string;
  setId?: string; setKey?: string; variants?: CatalogVariant[];
  id?: string; key?: string; node?: IrNode;
}

// ================================================================ codeconnect.local.json (map-validate.js is THE source of truth)

/** kinds.js TYPE_TO_KIND values — the transform vocabulary. Note TEXT → "string" (not "text"). */
export type MapPropKind = "enum" | "boolean" | "string" | "instance";
export type MapStatus = "active" | "deprecated" | "needs-review";
export interface EnumPropMap { kind: "enum"; codeProp: string; values?: Record<string, string | number | boolean | null>; default?: string | number | boolean; omitDefault?: boolean }
export interface BooleanPropMap { kind: "boolean"; codeProp: string; default?: boolean; omitDefault?: boolean }
export interface StringPropMap { kind: "string"; codeProp: string }
export interface InstancePropMap { kind: "instance"; codeProp?: string; slot?: string }
export type PropMap = EnumPropMap | BooleanPropMap | StringPropMap | InstancePropMap;
export interface MapCodeTarget { module: string; export: string }
export interface MapEntry {
  figma: { name: string; key?: string; id?: string; unstable?: boolean };
  code: MapCodeTarget & { targets?: Record<string, Partial<MapCodeTarget>> };
  props?: Record<string, PropMap>;
  variantOverrides?: Array<{ when: Record<string, string>; code: MapCodeTarget }>;
  childrenByLayer?: { layerNamePattern?: string; slot?: string };
  status?: MapStatus;
}
export interface CodeConnectMap {
  version: 1;
  figmaFileKey?: string;
  /** keyed by publish key (or node id when unpublished, or the SCREEN's instance key for a confirmed re-key proposal) */
  components: Record<string, MapEntry>;
}
/** map-validate.js validateMap() */
export interface MapValidationResult { ok: boolean; errors: Array<{ path: string; message: string }> }

// ================================================================ component-match.js

export interface VisibleInstance {
  screen: string;
  nodeId: string;
  /** the layer name */
  layer: string;
  /** setName || main name || layer name */
  name: string;
  key?: string;
  setKey?: string;
  remote: boolean;
  variant: Record<string, string> | null;
  props: ComponentPropValues;
}
export interface MatchTarget { id?: string; key?: string; name: string; type: "COMPONENT" | "COMPONENT_SET"; page?: string }
export interface MatchAlternative { id?: string; key?: string; page?: string; score: number }
export type MatchEvidence = "name+signature" | "name+no-props";
export type MatchTie = "duplicate-definitions" | "different-signatures";
export interface MatchRow {
  name: string;
  instances: number;
  nodeIds: string[];
  screens: string[];
  instanceKeys: string[];
  remote: boolean;
  /** some instance of this name resolves to the catalog by KEY */
  byKey: boolean;
  match: MatchTarget | null;
  alternatives: MatchAlternative[];
  reasons: string[];
  evidence?: MatchEvidence;
  tie?: MatchTie;
}
export interface MatchSummary {
  instances: number; names: number; byKey: number; proposed: number; proposedWithSignature: number; withCandidates: number; unmatched: number; remote: number;
}
export interface MatchResult { rows: MatchRow[]; proposals: MatchRow[]; summary: MatchSummary }
/** cross-check.js componentProposals[] — a MatchRow reshaped for a person to confirm. */
export interface ComponentProposal {
  name: string; instances: number; screens: string[]; instanceKeys: string[]; remote: boolean;
  catalog: MatchTarget | null; evidence?: MatchEvidence; tie: MatchTie | null; alternatives: MatchAlternative[]; reasons: string[];
  confirmed: boolean;
}

// ================================================================ findings (audit.js / cross-check.js / drift-lint.js)

export type Severity = "blocker" | "warning" | "info";
export interface SeverityCounts { blockers: number; warnings: number; info: number }

export type AuditPlatform = "web" | "ios" | "android" | "react-native" | "flutter";
export type AuditFindingCode =
  | "export-truncated" | "assets-failed" | "not-ready-for-dev" | "detached-instance" | "missing-font" | "no-auto-layout"
  | "self-inconsistent-geometry" | "fake-status-bar" | "fake-home-indicator" | "diamond-gradient" | "image-scale-mode"
  | "stroke-align" | "fixed-size-text" | "contrast-manual" | "low-contrast" | "negative-spacing" | "off-grid-spacing"
  | "corner-smoothing" | "shadow-spread" | "background-blur" | "progressive-blur" | "exotic-effect" | "blend-mode"
  | "small-touch-target" | "near-duplicate-colors" | "missing-component-states" | "low-token-binding";
export type CrossCheckFindingCode =
  | "foreign-token-library" | "token-library-matches" | "token-name-collision" | "token-name-collision-elsewhere"
  | "token-absent-from-design-system" | "unresolvable-token" | "catalog-rekeyed" | "catalog-covers-nothing"
  | "partial-catalog-coverage" | "catalog-covers-screen" | "name-matched-components" | "ambiguous-component-name"
  | "font-family-stray" | "font-not-in-design-system" | "text-style-near-miss" | "text-style-absent"
  | "sentinel-token-value" | "single-mode-export" | "derived-mode-contrast";

/** One finding. `extra` is per-code (`{size, min}` on small-touch-target, `{coverage}` on catalog-covers-nothing, …). */
export interface Finding<Code extends string = string> {
  severity: Severity;
  code: Code;
  message: string;
  nodeId?: string;
  nodeName?: string;
  screen?: string;
  path?: string;
  [extra: string]: unknown;
}
export type CrossCheckFinding = Finding<CrossCheckFindingCode>;
/** audit.js findings: its own codes, plus cross-check's (merged in with `crossFile: true`). */
export type AuditFinding = Finding<AuditFindingCode | CrossCheckFindingCode> & { crossFile?: true };

export type CoverageBucket = "localKey" | "libraryKey" | "proposed" | "nameOnly" | "ambiguous" | "newWork";
export interface CoverageEntry {
  setName: string;
  key?: string;
  matchedBy: "key" | "name" | null;
  scope?: "local" | "library";
  verified?: boolean;
  catalogName?: string;
  catalogKey?: string;
  propOverlap?: string;
  instances: number;
  ambiguous?: true;
  candidates?: number;
  bucket?: CoverageBucket;
}
export interface CrossCheckCoverage {
  instances: number; distinct: number; matchedByKey: number; matchedByLocalKey: number; matchedByName: number;
  ambiguousName: number; unmatched: number; pct: number | null; localPct: number | null;
  entries: CoverageEntry[];
  rekey?: (MatchSummary & { rekeyed: boolean }) | null;
  buckets?: Record<CoverageBucket, number>;
  hiddenOnly?: number;
}
export interface CrossCheckInputs { screens?: string[]; variables?: boolean; tokens?: boolean; components?: boolean; stylesText?: boolean }
/** cross-check.js crossCheck(). audit.js embeds the same shape (or a stub with coverage:null) under `crossFile`. */
export interface CrossCheckReport {
  summary: SeverityCounts;
  coverage: CrossCheckCoverage | null;
  componentProposals?: ComponentProposal[];
  componentResidual?: Array<{ name: string; instances: number; reasons: string[] }>;
  findings: CrossCheckFinding[];
  notChecked: string[];
  inputs: CrossCheckInputs;
}

export type ControlKind = "button" | "input" | "toggle" | "tab" | "link";
export type ControlState = "hover" | "pressed" | "focus" | "disabled" | "error" | "selected" | "loading";
export interface AuditComponentRow { name: string; kind: ControlKind; known: boolean; sampled?: boolean; present: ControlState[]; missing: ControlState[]; note?: string }
export interface AuditAnnotation { nodeId: string; nodeName: string; screen: string; label?: string }
export type AuditCategory = "color" | "typography" | "spacing" | "radius" | "effects";
export type ScreenStateKey = "loading" | "empty" | "error";
/** audit.js audit() — also what --out writes to <out>.json. */
export interface AuditReport {
  platform: AuditPlatform;
  platformAssumed: boolean;
  crossFile: CrossCheckReport | null;
  grid: number;
  gridAssumed?: boolean;
  gridMismatch?: number | null;
  screenStatesScope: { rootsAudited: number; singleFrame: boolean };
  screens: string[];
  /** the root node id(s) audited (P3 round 3) — absent on older reports */
  nodeIds?: string[];
  summary: SeverityCounts;
  hiddenLayers?: { nodesSkipped: number; crossFileFindingsOmitted: number };
  tokenBinding: Record<AuditCategory, { bound: number; total: number; pct: number | null }>;
  components: AuditComponentRow[];
  screenStates: Record<ScreenStateKey, "designed" | "not-found">;
  annotations: AuditAnnotation[];
  questions: string[];
  findings: AuditFinding[];
}

export type DriftCode =
  | "unknown-freshness" | "stale-snapshot" | "ambiguous-prop" | "duplicate-key" | "orphaned-entry" | "stale-name" | "stale-prop"
  | "uncovered-prop" | "kind-mismatch" | "no-variant-options" | "unknown-variant-value" | "unmapped-variant-value"
  | "double-mapped" | "unmapped-component";
export interface DriftFinding {
  code: DriftCode;
  message: string;
  mapKey?: string; prop?: string; key?: string; name?: string; keys?: string[]; suggestedKey?: string;
  from?: string; to?: string; exportedAt?: string; ageMs?: number; maxAgeMs?: number;
}
export interface FreshnessWarning { code: "unknown-freshness" | "stale-snapshot"; message: string }
/** drift-lint.js driftLint(). (There is no `ok`: the CLI exits 1 on `errors.length`.) */
export interface DriftLintResult {
  errors: DriftFinding[];
  warnings: DriftFinding[];
  freshness: FreshnessWarning | undefined;
  summary: { entries: number; catalogComponents: number; mapped: number; errorCount: number; warningCount: number };
}
/** drift-lint.js screenCoverage() */
export interface ScreenCoverage {
  distinct: number; instances: number; hiddenInstances: number; hiddenOnly: number; inCatalog: number; inMap: number;
  catalogPct: number | null; mapPct: number | null;
  unmapped: Array<{ setName?: string; key: string; instances: number }>;
}

// ================================================================ design/plan/<screen>.json (plan-skeleton.js skeleton())

export type PlanLifecycle = "pending" | "awaiting-user" | "abandoned";
/** What a PERSON sets; "verified"/"static-only" were written by an older hook and are ignored by verify-build.js. */
export type PlanStoredStatus = PlanLifecycle | "verified" | "static-only" | (string & {});
/** verify-build.js computeStatus() */
export type PlanComputedStatus = PlanLifecycle | "failed" | "blocked" | "stale" | "unverified" | "static-only" | "verified";
export type TokenKind =
  | "color" | "fontStyle" | "string" | "boolean" | "radius" | "fontSize" | "fontWeight" | "lineHeight" | "letterSpacing"
  | "spacing" | "borderWidth" | "size" | "opacity" | "number";
export type PlanTokenVerdict = "hidden-only" | "resolved" | "missing" | (string & {});
export type PlanComponentVerdict = "reused" | "new" | "missing" | (string & {});
export interface PlanTokenRow {
  figmaName: string;
  key?: string | null;
  collection?: string | null;
  kind: TokenKind | (string & {});
  value: JsonValue;
  mode?: string | null;
  bindings?: string[];
  sites?: { visible: number; hidden: number };
  aliasOf?: string;
  keyCandidates?: Array<{ key?: string; collection: string; value: JsonValue }>;
  note?: string;
  designSystem?: { match: "key" | "name"; key: string | null; value: JsonValue; agrees: boolean } | null;
  // filled by the model / a person
  codeToken: string | null;
  verdict: PlanTokenVerdict | null;
  decision?: string;
}
export interface PlanComponentMatch { by: "key" | MatchEvidence; id?: string; key?: string; name: string; confirmed?: false }
export interface PlanComponentRow {
  nodeId?: string;
  name: string;
  layer?: string;
  key?: string | null;
  setKey?: string | null;
  variant?: Record<string, string> | null;
  props?: ComponentPropValues;
  catalog?: PlanComponentMatch | null;
  mapped?: { module: string | null; export: string | null; status: MapStatus | null } | null;
  mapModule?: string;
  verdict?: PlanComponentVerdict | null;
  decision?: string;
  insideInstance?: string;
  // older hand-written plans
  matchedByName?: string | null;
  figmaName?: string;
  note?: string;
  repoPath?: string;
}
/** anchors{}[nodeId]. A node is ANCHORED when one of mapModule/file/symbol/omitted is a non-blank string. */
export interface PlanAnchor { name?: string; type?: IrNodeType; parent?: string | null; mapModule?: string; file?: string; symbol?: string; omitted?: string }
export interface PlanHiddenRoot { id: string; name: string; type: IrNodeType; nodes: number }
export interface PlanDeviation { id?: string; nodeId?: string; nodeIds?: string[]; field?: string; designed?: JsonValue; built?: JsonValue; reason?: string; what?: string }
export interface AllowedLiteral { value?: string; file?: string; reason: string }
/** Pre-filled from an audit with blockers (finding 136); overridden/reason/decidedBy/decidedAt are a person's. */
export interface PlanAuditGate {
  auditFile: string | null;
  verdict: "blocked" | (string & {});
  blockers: string[];
  overridden: string[];
  reason: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
}
/** verify-build.js writes this; never `plan.status`. */
export interface PlanHookRecord {
  result: "pass" | "blocked";
  checkedAt: string;
  blocking: string[];
  warnings: number;
  planHash: string;
  /** rel path → sha256/16, or null when the file is not on disk */
  files: Record<string, string | null>;
}
export interface PlanVerification {
  mode?: "rendered" | "static-only" | (string & {});
  reason?: string;
  renderer?: string;
  artifacts?: string[];
  deltas?: JsonValue[];
  coverage?: { rendered?: string[]; notChecked?: Array<string | { what?: string; why?: string }> };
  a11y?: { tool?: string; violations?: number };
  verifyScreenVerdict?: string | { verdict?: string };
  verdict?: string | { verdict?: string };
  hook?: PlanHookRecord;
  [extra: string]: unknown;
}
export interface Plan {
  schema?: "designtwin/plan@2" | (string & {});
  /** the plan's own file stem: <Layer>__<id> */
  screen?: string | null;
  screenName?: string | null;
  nodeId?: string | null;
  route?: string | null;
  /** the screen export, project-relative */
  file?: string | null;
  exportedAt?: string | null;
  status?: PlanStoredStatus;
  target?: JsonObject | null;
  architecture?: JsonObject | null;
  files?: string[];
  tokens?: PlanTokenRow[];
  components?: PlanComponentRow[];
  anchors?: Record<string, PlanAnchor>;
  hidden?: PlanHiddenRoot[];
  deviations?: PlanDeviation[];
  auditGate?: PlanAuditGate | null;
  counts?: { tokens: number; tokensVisible: number; instances: number; anchors: number; hiddenNodes: number };
  allowedLiterals?: AllowedLiteral[];
  verification?: PlanVerification;
  [extra: string]: unknown;
}

// ================================================================ verify-screen.js

export type DrawnState = "hover" | "pressed" | "focus";
/** One expectation row: ONLY values the export states (a field the export does not define is absent). */
export interface VerifySpec {
  nodeId: string;
  name: string;
  type: IrNodeType;
  path?: string;
  text?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  lineHeight?: number;
  letterSpacing?: number;
  color?: string | null;
  backgroundColor?: string | null;
  /** an SVG's paint */
  fill?: string | null;
  placeholder?: true;
  placeholderText?: string;
  placeholderColor?: string | null;
  borderColor?: string | null;
  borderWidth?: number;
  /** [top, right, bottom, left] when weights are per-side */
  borderWidths?: number[];
  borderRadius?: number;
  radiusCorners?: { tl: number; tr: number; br: number; bl: number };
  gap?: number;
  padding?: number[];
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  positionFrom?: "box" | "renderBox";
  opacity?: number;
  drawnState?: DrawnState;
  drawnStateWhy?: string;
  drawnStateOwn?: true;
  tokens?: TokenMap;
  frameId?: string;
}
export interface VerifyFrame { nodeId: string; name: string; w?: number; h?: number; x?: number; y?: number; clip?: boolean }
export interface VerifyInstance { nodeId: string; name: string; setName?: string; setKey?: string; variant?: string; props?: ComponentPropValues }
export interface VerifyInteraction { nodeId: string; name: string; trigger: string; action?: string; destinationId?: string; destination?: string }
export interface NotComparable { nodeId: string; name: string; field: string; value: JsonValue; why: string }
/** <Screen>.expected.json (verify-screen.js buildExpectation) */
export interface VerifyExpectation {
  schema: "designtwin/verify-expectation@2" | (string & {});
  screen?: string;
  exportedAt?: string;
  exportContentSha256?: string;
  reference?: string | null;
  frame: Omit<VerifyFrame, "x" | "y">;
  frames?: Array<Omit<VerifyFrame, "x" | "y">>;
  coordinates?: string;
  note?: string;
  measuredKeys?: Record<string, string>;
  tolerance?: Record<string, number>;
  counts?: { nodes: number; instances: number; interactions: number; notComparable: number; hidden: { layers: number; nodes: number; specsSkipped: number; instancesSkipped: number; interactionsSkipped: number } };
  nodes: VerifySpec[];
  instances?: VerifyInstance[];
  interactions?: VerifyInteraction[];
  notComparable?: NotComparable[];
  hidden?: { roots: Array<{ nodeId: string; name: string; path?: string }>; ids: string[] };
}

/** What a probe measures for one element. Keys beyond the canonical ones are reported as unknown, so the bag is open. */
export interface MeasuredStyles {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number | string;
  lineHeight?: number | string;
  letterSpacing?: number;
  color?: string;
  backgroundColor?: string;
  fill?: string;
  borderColor?: string;
  borderWidth?: number;
  borderRadius?: number | number[] | string;
  padding?: number[];
  gap?: number | Array<number | null>;
  gapVisual?: number;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  opacity?: number;
  text?: string | null;
  placeholderText?: string;
  placeholderColor?: string;
  tag?: string;
  textBox?: { x?: number; w?: number };
  display?: string;
  transform?: string;
  rotate?: string;
  visible?: boolean;
  [key: string]: unknown;
}
/** nodes[] of measured.json: `{nodeId, styles}` (canonical) or the styles flat on the row (older probes). */
export interface MeasuredNode extends MeasuredStyles {
  nodeId: string;
  styles?: MeasuredStyles;
  states?: Record<string, MeasuredStyles | { styles: MeasuredStyles }>;
  matchedBy?: string;
  note?: string;
  notes?: string;
  selector?: string;
}
export interface MeasuredComponent { setName?: string; name?: string; nodeId?: string; present?: boolean; detail?: string; note?: string }
export interface InteractionEvidence { nodeId: string; trigger?: string; ok?: boolean | null; result?: "not-probed"; selector?: string; selectorCount?: number; detail?: string }
/** <Screen>.measured.json — the probe's output, read as-is. */
export interface VerifyMeasured {
  measuredAt?: string;
  renderer?: string;
  viewport?: string | JsonObject;
  theme?: string;
  artifacts?: Array<string | { path?: string }>;
  expectationSha256?: string;
  mode?: "static-only" | (string & {});
  reason?: string;
  nodes?: MeasuredNode[];
  components?: MeasuredComponent[];
  interactions?: InteractionEvidence[];
  consoleErrors?: JsonValue[];
  notMeasured?: JsonValue[];
  componentsMissing?: JsonValue[];
}
export type DeltaSeverity = "high" | "medium" | "low";
export interface VerifyDelta {
  severity: DeltaSeverity;
  nodeId: string;
  name?: string;
  path?: string;
  field: string;
  expected: JsonValue;
  actual: JsonValue;
  delta?: number | null;
  unit?: string;
  token?: string;
  measuredIn?: string;
  matchedBy?: string;
  note?: string;
}
export interface VerifyInteractionResult extends VerifyInteraction { result: "pass" | "fail" | "not-probed"; detail?: string; selector?: string; selectorCount?: number }
export interface ArtifactCheck { path?: string; exists: boolean; image: boolean; sha256?: string }
/** report.inputs.code (finding 317): which code was measured, by content. */
export interface CodeInputs { plan?: string; files: Record<string, string | null>; gitHead?: string | null }
export type VerifyVerdict = "pass" | "fail" | "incomplete";
/** <Screen>.report.json (verify-screen.js compare(), schema @2). An @1 report carries only screen/exportedAt/
 *  measuredAt/renderer/viewport/artifacts/verdict/why/coverage/summary/deltas/missingComponents/interactions/notMeasured. */
export interface VerifyReport {
  schema?: "designtwin/verify-report@2" | "designtwin/verify-report@1" | (string & {});
  screen?: string;
  exportedAt?: string;
  measuredAt?: string;
  renderer?: string;
  viewport?: string | JsonObject;
  artifacts?: Array<string | ArtifactCheck>;
  inputs?: { expectationSchema?: string; expectationSha256?: string; measuredSha256?: string; measuredAgainst?: string; exportContentSha256?: string; code?: CodeInputs };
  verdict?: VerifyVerdict | (string & {});
  headline?: string;
  why?: string[];
  coverage?: {
    nodesExpected: number; nodesMeasured: number; nodesNotMeasured?: number; nodesMatchedByComponentPath?: number; fieldsChecked: number;
    fieldsNotMeasured?: number; fieldsNeverMeasured?: Array<{ field: string; expectedOn: number; measuredOn: number; probeSent?: string[] }>;
    valuesNotComparable?: number; valuesUnverifiable?: number; hiddenLayersSkipped?: { layers: number; nodes: number; specsSkipped: number; instancesSkipped: number; interactionsSkipped: number };
    instanceSets?: number; instanceSetsWithEvidence?: number; instanceSetsViaSharedPath?: number; componentsBuilt?: number;
    interactionsExpected?: number; interactionsPassed?: number; interactionsFailed?: number; interactionsNotProbed?: number;
  };
  summary?: { high: number; medium: number; low: number; componentsAbsent?: number; interactionsFailed?: number; interactionsNotProbed?: number; missingComponents?: number };
  deltas?: VerifyDelta[];
  componentsAbsent?: Array<{ setName: string; nodeIds: string[]; detail?: string }>;
  untaggedInstanceSets?: Array<{ setName: string; setKey?: string; nodeIds: string[]; instances: number }>;
  /** @1 only */
  missingComponents?: Array<{ setName: string; setKey?: string; nodeIds: string[]; instances: number }>;
  interactions?: VerifyInteractionResult[];
  notMeasured?: Array<{ nodeId: string; name?: string; path?: string; why: string }>;
  fieldsNotMeasured?: Array<{ nodeId: string; name?: string; field: string; why: string }>;
  unverifiable?: Array<{ nodeId: string; name?: string; field: string; expected: JsonValue; why: string }>;
  notComparable?: NotComparable[];
  probe?: { unknownKeys: Array<{ key: string; count: number; canonical?: string }>; duplicateNodeIds: number; interactionEvidenceOnHiddenLayers: number; interactionEvidenceNotInExpectation: number; measuredIdsOnHiddenLayers: number };
  limits?: string[];
  /** read by verify-build.js locateReports (a report written under a nickname) */
  nodeId?: string;
}

// ================================================================ design-diff.js

export type DiffCategory =
  | "text" | "typography" | "paint" | "layout" | "shape" | "tokens" | "component" | "visibility" | "asset" | "interaction" | "handoff"
  | "other" | "document" | "collection" | "style" | "manifest";
export interface FieldDiff { field: string; category: DiffCategory; before: string | undefined; after: string | undefined }
export interface DiffNodeRef { id: string; name: string; type: IrNodeType; path: string; parentId: string | null }
export interface DiffSummary { added: number; removed: number; changed: number; reordered?: number; positionOnly?: number }
export interface ScreenDiff {
  kind: "screen";
  summary: DiffSummary;
  warnings: string[];
  added: DiffNodeRef[];
  removed: DiffNodeRef[];
  reordered: Array<DiffNodeRef & { before: string[]; after: string[] }>;
  changed: Array<DiffNodeRef & { categories: DiffCategory[]; fields: FieldDiff[] }>;
  /** facts beside the tree (flows, resolvedModes, dev resources) */
  document: FieldDiff[];
}
export interface TokensDiff {
  kind: "tokens";
  summary: DiffSummary;
  warnings: string[];
  /** human labels (collection / name (key …) when the name is ambiguous) */
  added: string[];
  removed: string[];
  changed: Array<{ name: string; collection?: string; key?: string; modes: Array<{ mode: string; before: string | undefined; after: string | undefined }> }>;
  collections: FieldDiff[];
}
export interface CatalogBrief { key?: string; id?: string; name: string; type?: "COMPONENT" | "COMPONENT_SET" }
export interface CatalogDiff { kind: "catalog"; summary: DiffSummary; warnings: string[]; added: CatalogBrief[]; removed: CatalogBrief[]; changed: Array<CatalogBrief & { fields: FieldDiff[] }> }
export interface StyleBrief { key?: string; id?: string; name: string }
export interface StylesDiff { kind: "styles"; summary: DiffSummary; warnings: string[]; added: StyleBrief[]; removed: StyleBrief[]; changed: Array<StyleBrief & { fields: FieldDiff[] }> }
export interface HygieneDiff { kind: "hygiene"; summary: DiffSummary; warnings: string[]; added: string[]; removed: string[]; changed: never[] }
export interface ManifestDiff { kind: "manifest"; summary: DiffSummary; warnings: string[]; fields: FieldDiff[] }
export type DiffReport = ScreenDiff | TokensDiff | CatalogDiff | StylesDiff | HygieneDiff | ManifestDiff;
/** The CLI's --json result: the diff plus which baseline it was computed against. */
export type DiffResult = DiffReport & { file: string; against: string; baseline: "file" | "snapshot" | "git"; warned: boolean };

// ================================================================ resolve-screen.js

export interface ScreenCandidate {
  name: string; id: string; title: string | null; w?: number; h?: number; nodes?: number; reference: string | null; screenshot: string | null;
  /** which exact-stage field(s) this row matched on */
  matchedVia?: string[];
}
export type ResolveScreenResult =
  | { status: "resolved"; row: IndexRow; stage: string }
  | { status: "ambiguous"; stage: string; candidates: ScreenCandidate[] }
  | { status: "needs-confirmation"; stage: "text search"; candidates: ScreenCandidate[]; noTitles?: true }
  | { status: "not-found"; candidates: ScreenCandidate[]; noTitles?: true };

// ================================================================ tiny guards for the raw-JSON boundary

/** A parsed JSON object (not null, not an array). */
export function isJsonObject(x: unknown): x is JsonObject {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
/** A parsed JSON array. */
export function isJsonArray(x: unknown): x is JsonValue[] {
  return Array.isArray(x);
}
