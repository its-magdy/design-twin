// types.ts — the shared shapes of every JSON document the design-to-code layer reads or writes.
//
// Types only (plus two one-line JSON type guards and the `bag()` field reader at the bottom). Nothing
// here runs at import time.
//
// The PRODUCER-side shapes (raw JSON, the IR node tree, the documents a pull writes, the design-system
// split files) live in bridge/src/doc-types.ts and are re-exported below, unchanged, so every
// `import type { … } from "./types.ts"` keeps working. This file declares the design-to-code-only
// shapes (map, matching, findings, plan, verify, diff, resolve).
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

// ================================================================ re-exported from bridge/src/doc-types.ts
// raw JSON, the IR, the documents a pull writes, the design-system split files (and the collector
// documents the bridge's layout modules split) — moved to the bridge in step 4 of the TS port (the
// bridge's tsc program must stay inside its rootDir). Explicit list on purpose: a name added there is a
// deliberate addition here.

import type {
  JsonValue, JsonObject, IrNodeType, TokenMap, ComponentPropValues, IndexRow, IrNode, LayerFile, ScreenExport,
} from "../bridge/src/doc-types.ts";
export type {
  JsonPrimitive, JsonValue, JsonObject, IrNodeType, TokenMap, XY, Box, RenderBox, RadiusCorners, SizeLimits,
  PinMode, Pin, FlexAlign, GridTrack, LayoutSpec, LayoutGridSpec, PaintBase, SolidPaint, GradientStop,
  GradientPaint, ImageFilters, MediaPaint, PatternPaint, ShaderPaint, Paint, Strokes, EffectBase,
  ShadowEffect, BlurEffect, NoiseEffect, GlassEffect, TextureEffect, ShaderEffect, Effect, LengthSpec,
  FontSpec, TextRun, ReactionTrigger, ActionType, ActionNavigation, CubicBezier, Transition, Action, Reaction,
  MotionKeyframe, MotionTrack, MotionAnimation, NodeMotion,
  MainComponentRef, ComponentPropValues, Annotation, ExportSetting, Overlay, InstanceOverride, Geometry,
  TableCell, DevResource, StyleRefs, ModeMap, TextFields, IrNode, Manifest, Measurement, ScreenExport,
  LayerFile, IndexRow, PageDirEntry, PageIndex, PrototypeFlow, PageSettings, PagesRootIndex,
  DesignSystemStamp, DesignSystemManifest, VariableType, VariableAlias, VariableValue, VariableCollection,
  Variable, SliceEntry, ValueConflict, SameNameConflict, VariableConflict, TokensDoc, VariablesDoc, StyleMeta,
  PaintStyle, TextStyle, EffectStyle, GridStyle, StylesDoc, PaintStylesDoc, TextStylesDoc, EffectStylesDoc,
  GridStylesDoc, HygieneDoc, ComponentPropType, ComponentPropDef, CatalogVariant, CatalogComponent,
  ComponentsCatalog, ComponentDetailFile,
  LayersDocLayer, LayersDocIndexRow, LayersDoc, DesignSystemStyles, DesignSystemDoc, LibraryStamp, LibraryCounts,
  LibraryManifest, LibrariesIndexRow, LibrariesIndex,
} from "../bridge/src/doc-types.ts";

// ================================================================ the screen documents a reader accepts

/**
 * Any screen document a design-to-code reader accepts: a `--node` pull ({nodes}), a page-walk layer file
 * ({tree}) or a bare node tree. A real union — narrow with export-shape.ts (isScreenExport / isLayerFile /
 * isIrNode), and get the roots with screenRoots(). (bridge/src/doc-types.ts keeps its own `ScreenDoc`,
 * a wide optional bag, for the bridge side; it is deliberately NOT re-exported here.)
 */
export type ScreenDoc = ScreenExport | LayerFile | IrNode;

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

/** What matchByNameAndSignature() reads per instance: plan-skeleton's rows (keys `null`, no screen label) or visibleInstances()' output. */
export interface MatchInstance {
  /** the screen label; absent when the caller matches one screen and lists no screens (plan-skeleton) */
  screen?: string;
  nodeId: string;
  /** the layer name */
  layer: string;
  /** setName || main name || layer name */
  name: string;
  /** absent (visibleInstances) or null (plan-skeleton's rows) when the export has no key */
  key?: string | null;
  setKey?: string | null;
  remote: boolean;
  variant: Record<string, string> | null;
  props: ComponentPropValues;
}
/** component-match.js visibleInstances(): always labelled; a missing key is absent, never null. */
export interface VisibleInstance extends MatchInstance { screen: string; key?: string; setKey?: string }
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
/** A row matchByNameAndSignature proposes: it has a catalog match (and none by key). */
export type ProposedMatchRow = MatchRow & { match: MatchTarget };
export interface MatchResult { rows: MatchRow[]; proposals: ProposedMatchRow[]; summary: MatchSummary }
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
  | "small-touch-target" | "near-duplicate-colors" | "missing-component-states" | "component-states-unchecked"
  | "low-token-binding" | "heavy-asset" | "prototype-navigation";
export type CrossCheckFindingCode =
  | "foreign-token-library" | "token-library-matches" | "token-name-collision" | "token-name-collision-elsewhere"
  | "token-absent-from-design-system" | "unresolvable-token" | "catalog-rekeyed" | "catalog-covers-nothing"
  | "partial-catalog-coverage" | "catalog-covers-screen" | "name-matched-components" | "ambiguous-component-name"
  | "font-family-stray" | "font-not-in-design-system" | "text-style-near-miss" | "text-style-absent"
  | "sentinel-token-value" | "single-mode-export" | "derived-mode-contrast";

/** One sentinel token value (cross-check's sentinel-token-value). */
export interface SentinelTokenValue { name: string; collection: string | undefined; mode: string; value: number }
/** One text/background token pair below WCAG AA in a mode nobody rendered (cross-check's derived-mode-contrast). */
export interface ContrastFailure { mode: string; fg: string; bg: string; ratio: number; nodes: string[]; sample: string }
/**
 * The extra fields a finding carries beside severity/code/message, by the code that writes them (the
 * writers are audit.ts `add(…, extra)` and cross-check.ts `push(…, extra)`; a finding of any other code
 * carries none). Typed optional fields rather than an open `[extra: string]` bag, so a reader gets the
 * real type — and a misspelt field is a compile error, not an `unknown`.
 */
export interface FindingExtras {
  // ---- audit.ts
  /** self-inconsistent-geometry */
  statedH?: number; expectedH?: number | null; heightMode?: string;
  /** small-touch-target */
  size?: { w: number; h: number }; min?: number;
  /** low-contrast */
  ratio?: number; required?: number;
  /** low-contrast / contrast-manual / fixed-size-text: the layer's own text (truncated) — the layer NAME often isn't it */
  text?: string;
  /** missing-component-states */
  component?: string; missing?: ControlState[];
  /** component-states-unchecked: the controls no catalog defines */
  controls?: string[];
  /** heavy-asset (the row of <Screen>.assets.json `heavy`) */
  file?: string; bytes?: number; paths?: number;
  /** prototype-navigation: where the prototype goes, and from how many visible layers */
  destination?: string; destinationId?: string; navigation?: string; sources?: number;
  /** low-token-binding */
  category?: AuditCategory;
  /** near-duplicate-colors (the hexes, as the export spells them) */
  colors?: string[];
  // ---- cross-check.ts
  /** foreign-token-library: the screen's collections the design system does not have */
  collections?: Array<{ name: string; key?: string; twinKey?: string; twinName?: string }>;
  /** token-name-collision */
  token?: string; key?: string; alsoKnownAs?: string; screenValue?: Record<string, string>; designSystemValue?: Record<string, string>;
  usedAt?: Array<{ screen: string; nodeId: string; field: string }>; scope?: string;
  /** token-name-collision-elsewhere */
  keys?: Array<string | undefined>; mine?: Array<string | undefined>;
  /** unresolvable-token: names; token-absent-from-design-system: {name, near}; sentinel-token-value: the values */
  tokens?: string[] | Array<{ name: string; near: string | null }> | SentinelTokenValue[];
  /** catalog-rekeyed */
  rekey?: MatchSummary; proposals?: number;
  /** catalog-covers-nothing / partial-catalog-coverage */
  coverage?: { distinct: number; byLocalKey: number; byKey: number; byName: number; ambiguousName?: number; localPct: number | null };
  /** name-matched-components / ambiguous-component-name */
  components?: Array<{ setName: string; catalogName?: string; catalogKey?: string; propOverlap?: string; verified?: false; candidates?: number }>;
  /** font-family-stray */
  families?: Array<{ family: string; count: number }>;
  /** font-not-in-design-system */
  fonts?: string[]; designSystemFonts?: string[];
  /** text-style-absent: names; text-style-near-miss: {name, near} */
  styles?: string[] | Array<{ name: string; near: string }>;
  /** derived-mode-contrast */
  mode?: string; pairs?: ContrastFailure[];
  /** single-mode-export */
  collection?: string; exportedMode?: string; modes?: string[];
}
/** One finding: severity/code/message, where it is, and its code's extras (FindingExtras). */
export interface Finding<Code extends string = string> extends FindingExtras {
  severity: Severity;
  code: Code;
  message: string;
  nodeId?: string;
  nodeName?: string;
  screen?: string;
  path?: string;
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
/** Which inputs crossCheck() was given. `screens` = the screen LABELS (file stems), not paths. */
export interface CrossCheckInputs { screens: string[]; variables: boolean; tokens: boolean; components: boolean; stylesText: boolean }
/** cross-check.js crossCheck(). audit.js embeds the same shape (or a stub — see AuditCrossFile) under `crossFile`. */
export interface CrossCheckReport {
  summary: SeverityCounts;
  coverage: CrossCheckCoverage | null;
  componentProposals?: ComponentProposal[];
  componentResidual?: Array<{ name: string; instances: number; reasons: string[] }>;
  findings: CrossCheckFinding[];
  notChecked: string[];
  inputs: CrossCheckInputs;
}
/** audit.js report.crossFile: the cross-check report, or — no design system given — a stub with coverage:null and `inputs: {}`. */
export type AuditCrossFile = CrossCheckReport | (Omit<CrossCheckReport, "inputs"> & { inputs: Partial<CrossCheckInputs> });

export type ControlKind = "button" | "input" | "toggle" | "tab" | "link";
export type ControlState = "hover" | "pressed" | "focus" | "disabled" | "error" | "selected" | "loading";
/** One control's state coverage. `catalog` says which catalog defined it and `matchedBy` how it was found there. */
export interface AuditComponentRow { name: string; kind: ControlKind; known: boolean; sampled?: boolean; present: ControlState[]; missing: ControlState[]; note?: string; catalog?: string; matchedBy?: "key" | "name" }
export interface AuditAnnotation { nodeId: string; nodeName: string; screen: string; label?: string }
export type AuditCategory = "color" | "typography" | "spacing" | "radius" | "effects";
export type ScreenStateKey = "loading" | "empty" | "error";
/** "not-applicable": a state that does not exist for what was audited (an empty LIST state of a dialog). */
export type ScreenStateValue = "designed" | "not-found" | "not-applicable";
/** The fixed three, plus `validation` only when the audited roots hold an input. */
export type AuditScreenStates = Record<ScreenStateKey, ScreenStateValue> & { validation?: ScreenStateValue };
/** The two fields of <Screen>.assets.json (bridge/src/write-out.ts writeScreenAssets) the audit reads. */
export interface ScreenAssetsDoc {
  heavy?: Array<{ file: string; bytes: number; paths?: number }>;
  files?: Array<{ file: string; node?: string }>;
}
/** audit.js audit() — also what --out writes to <out>.json. */
export interface AuditReport {
  platform: AuditPlatform;
  platformAssumed: boolean;
  crossFile: AuditCrossFile | null;
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
  screenStates: AuditScreenStates;
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
  /** the Figma variable's name — plan-skeleton always writes it; older hand-written plans (and raw
   *  unbound values: `null`) have none, and no row without one is compared for token identity */
  figmaName?: string | null;
  key?: string | null;
  collection?: string | null;
  kind: TokenKind | (string & {});
  value: JsonValue;
  mode?: string | null;
  bindings?: string[];
  sites?: { visible: number; hidden: number };
  aliasOf?: string;
  /** `collection` is absent when the export could not name the variable's collection (variables.ts) */
  keyCandidates?: Array<{ key?: string; collection?: string; value: JsonValue }>;
  note?: string;
  designSystem?: { match: "key" | "name"; key: string | null; value: JsonValue; agrees: boolean } | null;
  // filled by the model / a person (plan-skeleton writes both as null; a hand-written row may omit them)
  codeToken: string | null;
  verdict?: PlanTokenVerdict | null;
  decision?: string;
  /** a person's reason for deliberately sharing this row's codeToken with another Figma name (silences
   *  verify-build's merged-token warning for this row) */
  acknowledged?: string;
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
  /** a person's answer: the module that renders it (`null`/absent: not decided, or new) */
  mapModule?: string | null;
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
/** A person's exemption. Only one WITH a reason counts (verify-build.ts ignores a reasonless entry — so it may lack one). */
export interface AllowedLiteral { value?: string; file?: string; reason?: string }
/** Pre-filled from an audit with blockers (finding 136); overridden/reason/decidedBy/decidedAt are a person's. */
export interface PlanAuditGate {
  auditFile: string | null;
  verdict: "blocked" | (string & {});
  /** plan-skeleton writes every field below; a person edits them, so any may be missing (verify-build reads them defensively) */
  blockers?: string[];
  overridden?: string[];
  reason?: string | null;
  decidedBy?: string | null;
  decidedAt?: string | null;
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
  /** web profiles: anchored visible nodes whose id appears in a listed file, of how many */
  tagCoverage?: { tagged: number; anchored: number };
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
  // A model-written verification block often carries more (interactionScript, typecheck, dataDtNode,
  // interactions, …): nothing reads those, and the hook's rewrite carries them through untouched.
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
  /** the target profile: "web-tailwind", or {profile: "web-tailwind", stack, …} */
  target?: JsonObject | string | null;
  architecture?: JsonObject | null;
  /** opt out of the web data-dt-node tag check (verify-build.ts); honoured only with a non-empty reason */
  tagging?: { off?: boolean; reason?: string } | null;
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
  // A filled plan often carries more (layout, states, assets, openQuestions, componentCatalog, …): no
  // reader looks at those, and merge() / the hook's rewrite carry them through untouched.
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
/** A root frame as an expectation lists it (no position). */
export type VerifyRootFrame = Omit<VerifyFrame, "x" | "y">;
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
  /** `{}` when the export had no roots */
  frame: Partial<VerifyRootFrame>;
  frames?: Array<Partial<VerifyRootFrame>>;
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
type VerifyCoverage = NonNullable<VerifyReport["coverage"]>;
/** report.coverage as compare() writes it (schema @2): every counter present. */
export interface VerifyCoverageV2 extends VerifyCoverage {
  nodesNotMeasured: number; nodesMatchedByComponentPath: number; fieldsNotMeasured: number;
  fieldsNeverMeasured: NonNullable<VerifyCoverage["fieldsNeverMeasured"]>; valuesNotComparable: number; valuesUnverifiable: number;
  instanceSets: number; instanceSetsWithEvidence: number; instanceSetsViaSharedPath: number;
  interactionsExpected: number; interactionsPassed: number; interactionsFailed: number; interactionsNotProbed: number;
}
/**
 * What verify-screen.js compare() returns (schema @2): every @2 field present. `artifacts` is the CLI's
 * on-disk check when it ran, else the probe's own list passed through as-is (the one field wider than VerifyReport's).
 */
export interface VerifyReportV2 extends Omit<VerifyReport, "artifacts"> {
  artifacts: Array<string | ArtifactCheck | { path?: string }>;
  verdict: VerifyVerdict;
  headline: string;
  why: string[];
  coverage: VerifyCoverageV2;
  summary: NonNullable<VerifyReport["summary"]>;
  deltas: VerifyDelta[];
  componentsAbsent: NonNullable<VerifyReport["componentsAbsent"]>;
  untaggedInstanceSets: NonNullable<VerifyReport["untaggedInstanceSets"]>;
  interactions: VerifyInteractionResult[];
  notMeasured: NonNullable<VerifyReport["notMeasured"]>;
  fieldsNotMeasured: NonNullable<VerifyReport["fieldsNotMeasured"]>;
  unverifiable: NonNullable<VerifyReport["unverifiable"]>;
  notComparable: NotComparable[];
  probe: NonNullable<VerifyReport["probe"]>;
  limits: string[];
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
/**
 * Read any object as a string-keyed bag of unknowns — for the generic key loops (design-diff, tests) that
 * compare WHATEVER a document or node carries, named field or not. The interfaces here deliberately have
 * no string index; this is the one place that reads past them. Two steps through `unknown` because an
 * interface and Record<string, unknown> do not overlap for a direct assertion.
 */
export function bag(o: object): Record<string, unknown> {
  const u: unknown = o;
  return u as Record<string, unknown>;
}
