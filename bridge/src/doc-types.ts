// doc-types.ts — the PRODUCER-side document contract: the shapes the Figma plugin serializes and the
// bridge writes to disk (the IR node tree, the pull manifest / screen / layer / index files, the
// design-system split files, and the collector documents pages-layout.ts / design-system-layout.ts /
// library-layout.ts split). The design-to-code layer's types.ts re-exports every name here, so its
// consumers keep importing from there; the bridge imports from here so its tsc program stays inside
// rootDir `src`.
//
// Types only: no runtime code and NO imports at all (not even `import type`), no Node types, ES2019-safe —
// the plugin-shared modules (pages-layout, design-system-layout, library-layout) import it, so it is
// type-checked under figma-plugin/tsconfig.json (lib es2019, no @types/node) as well as the bridge's.
// The conventions (optional fields, open `(string & {})` vocabularies) are those described in the
// header of the design-to-code layer's types.ts, where these sections lived until step 4 of the TS port.

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
export type FlexAlign = "flex-start" | "center" | "flex-end" | "space-between" | "space-evenly" | "space-around" | "baseline";
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
/** One shader property assignment (paint.ts putShaderProperties), keyed in `properties` by Figma's opaque
 *  property-definition id. Colours are hex (8-digit when alpha < 1); a bare COLOR is wrapped as `{color}`
 *  so it can't be mistaken for a TEXT string. A value (or the colour inside a point/gradient) bound to a
 *  variable is omitted here and named in the paint/effect `tokens` instead (`defId`, `defId.color`,
 *  `defId.stops.N.color`). */
export type ShaderPropValue =
  | boolean | string | number
  | { color: string }
  | XY
  | { x: number; y: number; x2: number; y2: number }
  | { x: number; y: number; radius: number; angle?: number }
  | { x: number; y: number; color?: string }
  | { stops: Array<{ pos: number; color?: string }> };
export interface ShaderPaint extends PaintBase { type: "shader"; shaderId?: string; properties?: Record<string, ShaderPropValue> }
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
  /** Variable-width (tapered) stroke: one of Figma's named presets, or `custom` with its `variableWidthPoints`
   *  compacted to `{pos, width}` (points only for `custom`). */
  variableWidth?: { profile: "uniform" | "wedge" | "taper" | "quarter_taper" | "eye" | "mirrored_taper" | "custom"; points?: Array<{ pos: number; width: number }> };
  /** Brush / dynamic stroke (complexStrokeProperties); absent for a plain (BASIC) stroke. */
  complex?: ComplexStroke;
}
/** complexStrokeProperties, enums lowercased, numbers rounded. `brushName` is `custom` for a custom brush. */
export type ComplexStroke =
  | { type: "dynamic"; frequency: number; wiggle: number; smoothen: number }
  | { type: "brush"; brushType: "scatter"; brushName: string; gap: number; wiggle: number; sizeJitter: number; angularJitter: number; rotation: number }
  | { type: "brush"; brushType: "stretch"; brushName: string; direction: "forward" | "backward" };

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
export interface ShaderEffect extends EffectBase { type: "shader"; shaderId?: string; properties?: Record<string, ShaderPropValue> }
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
  /** FontName.variationSettings: the variable font axis values applied, e.g. {wght: 600, slnt: -10}.
   *  Absent for a static font. */
  variationSettings?: Record<string, number>;
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
  /** This run's paragraph wrap style — only when the node-level `textWrapStyle` is mixed (else it is
   *  `font.textWrap` on the node); AUTO omitted. */
  textWrap?: "balance" | "pretty";
}

// ---- prototype (prototype.ts)
/** Lowercased Figma Trigger.type; "unknown" when the trigger had no type. */
export type ReactionTrigger =
  | "on_click" | "on_hover" | "on_press" | "on_drag" | "after_timeout" | "mouse_enter" | "mouse_leave"
  | "mouse_up" | "mouse_down" | "on_key_down" | "on_media_hit" | "on_media_end" | "unknown" | (string & {});
export type ActionType =
  | "back" | "close" | "url" | "node" | "set_variable" | "set_variable_mode" | "conditional" | "update_media_runtime" | (string & {});
export type ActionNavigation = "navigate" | "swap" | "overlay" | "scroll_to" | "change_to" | (string & {});
/** Control points of a custom cubic-bezier easing — Figma's `easingFunctionCubicBezier`, carried verbatim. */
export interface CubicBezier { x1: number; y1: number; x2: number; y2: number }
export interface Transition {
  type?: string;
  direction?: string;
  /** seconds */
  duration?: number;
  matchLayers?: boolean;
  easing?: string;
  cubicBezier?: CubicBezier;
  spring?: unknown;
}
export interface Action {
  type: ActionType;
  navigation?: ActionNavigation;
  url?: string;
  openInNewTab?: true;
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

/** One keyframe of an opt-in motion track (motion.ts). `value` is already compacted: number, hex colour, {x,y}, …
 *  (absent when the keyframe carried no readable value). `easing` is the lower-cased MotionEasing type plus
 *  its curve params, or — when the easing is bound to an EASING variable (typings `MotionEasing |
 *  VariableAlias`) — the SAME alias shape a top-level variable reference uses: `{aliasOf: <variable
 *  name>}`, falling back to `{aliasOf: <id>}` when the name can't be resolved (variables.ts's
 *  VariableAlias -> {aliasOf} resolution, via state.ts's `varName` memo over
 *  `figma.variables.getVariableByIdAsync`). */
export interface MotionKeyframe { t: number; value?: JsonValue; easing?: { type: string; cubicBezier?: CubicBezier; spring?: unknown } | VariableAlias }
/** One manually-keyframed field (ManualKeyframeBinding): its base value and the keyframes. */
export interface MotionTrack { base?: JsonValue; keyframes?: MotionKeyframe[] }
/** One timeline-animated field (KeyframeBinding): base value, the timeline's duration, and its tracks,
 *  each with a non-SET keyframe operation and keyframes. */
export interface MotionAnimation { base?: JsonValue; duration?: number; tracks?: Array<{ op?: "offset" | "scale"; keyframes?: MotionKeyframe[] }> }
/** A fills[i] / strokes[i] motion entry (PaintManualKeyframeTrack / PaintKeyframeBinding): either ONE binding
 *  for the whole paint, or — for a shader paint — one binding per shader property id under `properties`. */
export type MotionPaintTrack<T> = T | { properties: Record<string, T> };
/** An effects[i] motion entry (EffectManualKeyframeTracks / EffectKeyframeBindings): one binding per
 *  EffectKeyframeFieldName (`RADIUS`, `OFFSET_X`, `COLOR`, …) plus per-shader-property bindings under `properties`. */
export type MotionEffectTracks<T> = Record<string, T> & { properties?: Record<string, T> };
/** The indexed collections of a motion map, keyed by paint/effect index as a string ("0", "1", …). */
export interface MotionIndexedTracks<T> {
  fills?: Record<string, MotionPaintTrack<T>>;
  strokes?: Record<string, MotionPaintTrack<T>>;
  effects?: Record<string, MotionEffectTracks<T>>;
}
/** node.manualKeyframeTracks: one MotionTrack per KeyframePropertyFieldName (`TRANSLATION_X`, `OPACITY`, …),
 *  plus the indexed fills/strokes/effects collections. */
export type MotionTracks = Record<string, MotionTrack> & MotionIndexedTracks<MotionTrack>;
/** node.animations: the same layout as MotionTracks, with MotionAnimation bindings. */
export type MotionAnimations = Record<string, MotionAnimation> & MotionIndexedTracks<MotionAnimation>;
/** The opt-in motion read on a node (`--motion`): timelines, per-field tracks, applied animation styles. */
/** One configured value of an applied animation style's `props` (AnimationStyleConfiguration.props):
 *  a plain string/number/boolean, or — for a MotionEasing / VariableAlias value — the same compacted
 *  shape as a keyframe's `easing` (lower-cased curve type + params, or `{aliasOf: <name or id>}`). */
export type MotionStylePropValue = string | number | boolean | NonNullable<MotionKeyframe["easing"]>;
export interface NodeMotion {
  timelines?: Array<{ id: string; duration: number }>;
  manualTracks?: MotionTracks;
  animations?: MotionAnimations;
  /** node.animationStyles (AppliedAnimationStyle[]): the applied instance id, the style's name/styleId,
   *  and its configuration (duration, timelineOffset, per-prop values). */
  styles?: Array<{
    id: string;
    name: string;
    styleId: string;
    duration?: number;
    timelineOffset?: number;
    props?: Record<string, MotionStylePropValue>;
  }>;
}
export interface IrNode extends Partial<TextFields> {
  type: IrNodeType;
  name: string;
  id: string;
  /** The ONE visibility flag (hidden.js): the designer switched this layer off. Descendants inherit it. */
  hidden?: true;
  children?: IrNode[];

  // instance / component identity
  props?: ComponentPropValues;
  /** a BOOLEAN/TEXT prop whose value is driven by a variable */
  propTokens?: TokenMap;
  /** main component's bare name (INSTANCE) or the node's own name (COMPONENT / COMPONENT_SET) */
  component?: string;
  mainComponent?: MainComponentRef;
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
  motion?: NodeMotion;

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

/** state.ts manifest(): {nodes, skipped, truncated, assetsFailed, warnings[]} + the raw counters
 *  (every RunStats counter is always present — state.ts newStats() zeroes them all). */
export interface Manifest {
  nodes: number;
  /** derived: === truncated */
  skipped: number;
  truncated: number;
  assetsFailed: number;
  /** nodes that would have exported an asset but were skipped via --no-assets */
  assetsSkipped: number;
  /** vector/icon nodes with no visible paint — nothing to render, never attempted, never a failure */
  assetsSkippedInvisible: number;
  /** real export failures RECOVERED as inline path geometry (assets.ts geometryOf) */
  assetsGeometry: number;
  /** which opt-in reads ran */
  reads?: string[];
  warnings: string[];
}

// ---- assets (figma-plugin/src/state.ts Asset — the ONE definition, used by the plugin's collectors
// and by the bridge's write-out.ts alike)
/** What assets.ts registers: an SVG (`text`), a 2x PNG (`base64`), or a source image's own bytes. */
export type AssetFormat = "svg" | "png" | "jpg" | "webp" | "gif" | "bin";
/** `reference`: the whole-frame screenshot; `source`: an image fill's original bytes; absent: a rendered node. */
export type AssetKind = "reference" | "source";
/** One exported asset. Exactly one of `base64`/`text` carries the bytes (a manifest-only entry has neither). */
export interface Asset {
  id: string;
  name: string;
  format: AssetFormat;
  /** Basename this asset must be written as. The PRODUCER names the file (assets.ts) and the node
   *  tree's `asset` path is built from the same string, so a consumer never re-derives the convention
   *  — a mismatch here would silently point every `asset:` path at a file that isn't on disk. */
  file: string;
  base64?: string;
  text?: string;
  kind?: AssetKind;
  /** Content hash of the bytes (assets.ts contentHash). Written into the per-screen asset index so a
   *  consumer can see which files are byte-identical without diffing them. */
  hash?: string;
  /** Every node id that resolved to THIS file. Present only when more than one did — i.e. when the
   *  same artwork was reached through several instance paths and deduped to one file. */
  from?: string[];
}

export interface Measurement {
  page: string; pageId: string;
  start?: { nodeId?: string; side?: string }; end?: { nodeId?: string; side?: string };
  text?: string;
  /** Figma's MeasurementOffset, verbatim: `{type:"INNER", relative}` or `{type:"OUTER", fixed}`. */
  offset?: { type: "INNER"; relative: number } | { type: "OUTER"; fixed: number };
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
  /** Lowercased DocumentNode.documentColorProfile (components.ts): note the UNDERSCORE in "display_p3". */
  colorProfile?: "legacy" | "srgb" | "display_p3" | (string & {});
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

/** Figma's VariableResolvedDataType, verbatim (EASING/TIMING are the motion variable types). */
export type VariableType = "COLOR" | "FLOAT" | "STRING" | "BOOLEAN" | "EASING" | "TIMING";
export interface VariableAlias { aliasOf: string }
/**
 * Figma's VariableComposedColor (plugin-typings 1.139, Update 139): a COLOR value authored as a colour
 * plus a SEPARATE opacity, where the colour, the opacity, or both are variable aliases. Each alias half
 * is emitted exactly like a top-level alias (`{aliasOf: <target name, or id when unresolvable>}`); a raw
 * colour is a hex string like any COLOR value; a raw opacity is Figma's number VERBATIM — not rescaled —
 * on Figma's 0–100 scale: "An opacity percentage from 0 to 100, or an alias to a FLOAT variable" (REST API
 * variables types, VariableComposedColor.opacity: https://developers.figma.com/docs/rest-api/variables-types/).
 * An aliased opacity names a FLOAT on the same scale. How it combines with a colour whose own alpha is
 * < 1 is not documented; design-to-code multiplies (alpha × opacity/100) — an inference.
 * The two members are Figma's two, so "neither half is an alias" is unrepresentable here too.
 */
export type ComposedColor =
  | { color: string; opacity: VariableAlias }
  | { color: VariableAlias; opacity: number | VariableAlias };
export interface VariableComposedColor { composed: ComposedColor }
/** A per-mode value: COLOR → hex string (alpha kept); FLOAT → number; STRING/BOOLEAN → as is; alias → {aliasOf};
 *  composed colour → {composed: {color, opacity}} (see ComposedColor). */
export type VariableValue = string | number | boolean | VariableAlias | VariableComposedColor;
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
  /** Absent when the plugin could not resolve the variable's collection (variables.ts writes `collOf(id)?.name`). */
  collection?: string;
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

export type ComponentPropType = "VARIANT" | "BOOLEAN" | "TEXT" | "INSTANCE_SWAP" | "SLOT";
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
  /** SLOT only: Figma's SlotSettings as set (a null min/max = no limit, omitted). */
  slotSettings?: { stretchChildOnInsert?: boolean; displayEmptyByDefault?: boolean; minChildren?: number; maxChildren?: number; allowPreferredValuesOnly?: boolean };
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

// ================================================================ the collector documents the bridge splits

// ---- pages-layout.ts (buildPageLayout's input)
/** One top-level layer in the collector's layersDoc (figma-plugin/src/collect.ts collectFull). */
export interface LayersDocLayer {
  name: string;
  id: string;
  page?: string;
  pageId?: string;
  tree: IrNode;
  reference?: string;
  devResources?: DevResource[];
}

/** The collector's per-layer index row — IndexRow before pages-layout.ts adds title/texts/file. */
export type LayersDocIndexRow = Omit<IndexRow, "file" | "title" | "texts">;

/**
 * The collector's layersDoc: the run-wide manifest fields that become pages/index.json, plus the two
 * parallel arrays pages-layout.ts splits into per-page files. write-out.ts's writeExport also stamps
 * `sourceFile` on it (P4 #33).
 */
export interface LayersDoc extends Omit<PagesRootIndex, "pageDirs" | "layers"> {
  layers?: LayersDocLayer[];
  index?: LayersDocIndexRow[];
}

// ---- design-system-layout.ts / library-layout.ts (the designSystem doc they split)
/** The plugin's styles block (components.ts buildDesignSystem), one array per style kind. */
export interface DesignSystemStyles {
  paint?: PaintStyle[];
  text?: TextStyle[];
  effect?: EffectStyle[];
  grid?: GridStyle[];
}

/**
 * The plugin's designSystem doc (components.ts buildDesignSystem) — the ONE document
 * design-system-layout.ts and library-layout.ts split. `source` is present on a library-mode export only (collectLibraryFile).
 */
export interface DesignSystemDoc extends DesignSystemStamp {
  collections?: VariableCollection[];
  variables?: Variable[];
  components?: CatalogComponent[];
  styles?: DesignSystemStyles;
  hygiene?: string[];
  source?: TokensDoc["source"];
}

// ---- library-layout.ts (libraries/<dir>/index.json and libraries/index.json)
/** The stamp every library file carries: the design-system stamp plus `source` (library mode). */
export interface LibraryStamp extends DesignSystemStamp {
  source?: TokensDoc["source"];
}

export interface LibraryCounts {
  collections: number;
  variables: number;
  stylesPaint: number;
  stylesText: number;
  stylesEffect: number;
  stylesGrid: number;
  components: number;
  hygiene: number;
}

/** libraries/<dir>/index.json — the slim manifest: stamp + `source` + `files` pointer map + `counts`
 *  + `publish` (a per-status count, absent when nothing carries a publish status). */
export interface LibraryManifest extends LibraryStamp {
  files: {
    tokens: string; stylesPaint: string; stylesText: string; stylesEffect: string; stylesGrid: string;
    components: string; hygiene: string;
  };
  counts: LibraryCounts;
  publish?: Record<string, number>;
}

/** One row of libraries/index.json. */
export interface LibrariesIndexRow {
  dir: string;
  libraryName?: string;
  file?: string;
  fileKey?: string;
  collectionKeys?: string[];
  exportedAt?: string;
  counts: LibraryCounts;
  publish?: Record<string, number>;
  index: string;
}

/** libraries/index.json. Rows already on disk are carried through as read (untyped JSON). */
export interface LibrariesIndex {
  libraries: unknown[];
  generatedAt: string;
}
