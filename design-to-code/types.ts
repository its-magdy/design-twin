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
  /** free text for people; no tool reads it */
  note?: string;
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
  /** every catalog entry sharing this name, in catalog order — set only when there are 2 or more (DT-27:
   *  nameVerdict's "ambiguous" when none verified; plan-skeleton's `catalog.by:"ambiguous"` lists them) */
  candidates?: MatchCandidate[];
}
/** component-match.ts nameVerdict(): the one name rule (DT-27) cross-check and plan-skeleton share. */
export interface NameVerdict { status: "matched" | "ambiguous" | "unmatched"; reason: string }
/** A same-named catalog entry (MatchRow.candidates, PlanComponentMatch `by:"ambiguous"`). */
export interface MatchCandidate { id?: string; key?: string; name: string }
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
  /** F-47: a label only — this name is already mapped in the project's code-connect map */
  alreadyMapped?: true;
  /** F-47: how many OTHER exported screens use the same instance or set key (shared chrome); ordering only */
  sharedWith?: number;
}

// ================================================================ findings (audit.js / cross-check.js / drift-lint.js)

export type Severity = "blocker" | "warning" | "info";
/** D1/D11: the ONLY codes that may be emitted as a blocker (audit.ts `add` / cross-check.ts `push` accept
 *  "blocker" with these codes only — a compile error otherwise). audit.ts BLOCKER_CODES lists them at runtime. */
export type BlockerCode = "export-truncated" | "assets-failed" | "missing-font" | "token-name-collision";
export interface SeverityCounts { blockers: number; warnings: number; info: number }

export type AuditPlatform = "web" | "ios" | "android" | "react-native" | "flutter";
export type AuditFindingCode =
  | "export-truncated" | "assets-failed" | "not-ready-for-dev" | "detached-instance" | "missing-font" | "no-auto-layout"
  | "self-inconsistent-geometry" | "fake-status-bar" | "fake-home-indicator" | "diamond-gradient" | "image-scale-mode"
  | "stroke-align" | "fixed-size-text" | "contrast-manual" | "low-contrast" | "negative-spacing" | "off-grid-spacing"
  | "corner-smoothing" | "shadow-spread" | "background-blur" | "progressive-blur" | "exotic-effect" | "blend-mode"
  | "small-touch-target" | "near-duplicate-colors" | "missing-component-states" | "component-states-unchecked"
  | "low-token-binding" | "heavy-asset" | "prototype-navigation" | "state-in-sibling" | "unexported-frames"
  | "default-copy-in-instance" | "prototype-target-not-exported" | "non-text-contrast" | "undesigned-open-state"
  | "near-token-color" | "duplicate-root-subtree";
export type CrossCheckFindingCode =
  | "foreign-token-library" | "token-library-matches" | "token-name-collision" | "token-name-collision-elsewhere"
  | "token-absent-from-design-system" | "unresolvable-token" | "catalog-rekeyed" | "catalog-covers-nothing"
  | "partial-catalog-coverage" | "catalog-covers-screen" | "name-matched-components" | "ambiguous-component-name"
  | "font-family-stray" | "font-not-in-design-system" | "text-style-near-miss" | "text-style-absent"
  | "sentinel-token-value" | "single-mode-export" | "derived-mode-contrast" | "mixed-mode-bindings" | "token-pair-contrast";

/** One sentinel token value (cross-check's sentinel-token-value). */
export interface SentinelTokenValue { name: string; collection: string | undefined; mode: string; value: number }
/** One text/background token pair below WCAG AA in a mode nobody rendered (cross-check's derived-mode-contrast). */
export interface ContrastFailure { mode: string; fg: string; bg: string; ratio: number; nodes: string[]; sample: string }
/** One token pair below WCAG in a mode a screen RENDERS, deduplicated over the run's screens (cross-check's
 *  token-pair-contrast): text at 4.5:1 (3:1 large), a control's stroke against the background around it at 3:1. */
export interface TokenPairRow { kind: "text" | "non-text"; fg: string; bg: string; mode: string; ratio: number; required: number; screens: string[]; nodes: string[] }
/** One colour collection a screen binds from, in the mode it resolves to (cross-check's mixed-mode-bindings). */
export interface ModeBindingRow { collection: string; mode: string; tokens: string[]; nodes: string[] }
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
  file?: string; bytes?: number; paths?: number; embeddedRaster?: number;
  /** prototype-navigation: where the prototype goes, and from how many visible layers */
  destination?: string; destinationId?: string; navigation?: string; sources?: number;
  /** state-in-sibling: the undrawn state, and the same-page frames whose copy reads like it */
  state?: ScreenStateKey; candidates?: Array<{ id: string; name: string; text: string }>;
  /** unexported-frames: node ids screenshotted into assets/ but never exported */
  ids?: string[];
  /** low-token-binding */
  category?: AuditCategory;
  /** near-duplicate-colors (the hexes, as the export spells them) */
  colors?: string[];
  /** default-copy-in-instance / non-text-contrast / undesigned-open-state: every node the finding covers (nodeId = the first) */
  nodeIds?: string[];
  /** default-copy-in-instance: the copy the not-overridden instances show, and the copies the others show */
  copies?: { default: string; overridden: string[] };
  /** prototype-navigation: false when the destination was never exported (no index row, not drawn in this tree) */
  exported?: boolean;
  /** non-text-contrast: the stroke and the colour around the control (hex), and the tokens bound to them when any */
  stroke?: string; backdrop?: string; strokeToken?: string; backdropToken?: string;
  /** duplicate-root-subtree: the in-flow node the stray absolute copy duplicates */
  twinId?: string;
  /** D1/D11: a cross-file warning to CONFIRM with the user before building on its default — the question */
  confirm?: string;
  // ---- cross-check.ts
  /** foreign-token-library: the screen's collections the design system does not have */
  collections?: Array<{ name: string; key?: string; twinKey?: string; twinName?: string }>;
  /** foreign-token-library (DT-07): the screen's variables in those collections, classified by NAME against the design system */
  nameMap?: { agree: number; differ: number; undecidable: number; absent: number;
    /** FU-namemap: rows of an export without `collectionKey` whose collection NAME a design-system collection also has — counted by name, so they may belong to either; absent when 0 */
    ambiguous?: number };
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
  /** token-pair-contrast (the rendered modes, deduplicated over the run's screens) */
  tokenPairs?: TokenPairRow[];
  /** mixed-mode-bindings: per bound colour collection, the mode it resolves to and what binds it */
  bindings?: ModeBindingRow[];
  /** single-mode-export */
  collection?: string; exportedMode?: string; modes?: string[];
}
/** One finding: severity/code/message, where it is, and its code's extras (FindingExtras). */
export interface Finding<Code extends string = string> extends FindingExtras {
  severity: Severity;
  code: Code;
  message: string;
  /** F-44: `code`, or `code@nodeId`, plus `~n` for the n-th repeat of that pair in one report
   *  (finding-id.ts findingIds) — the same id in audit and cross-check reports */
  id?: string;
  nodeId?: string;
  nodeName?: string;
  screen?: string;
  path?: string;
  /** set when a <out>.overrides.json entry changed this finding's severity (DT-21) */
  overridden?: { from: Severity; reason: string; decidedBy?: string; decidedAt?: string };
}
export type CrossCheckFinding = Finding<CrossCheckFindingCode>;
/** audit.js findings: its own codes, plus cross-check's (merged in with `crossFile: true`); `overridden`
 *  when a <out>.overrides.json entry changed its severity (DT-21). */
export type AuditFinding = Finding<AuditFindingCode | CrossCheckFindingCode> & { crossFile?: true };
/** One entry of design/audit/<screen>.overrides.json: which finding(s) (code, narrowed by nodeId / token /
 *  component when given), the severity the user decided, and why. */
export interface AuditOverride {
  code: string; nodeId?: string; token?: string; component?: string; collection?: string; mode?: string; category?: string; state?: string; screen?: string;
  severity: Severity; reason: string; decidedBy?: string; decidedAt?: string;
}
export interface AuditOverridesDoc { overrides: AuditOverride[] }

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
  /** DT-27: why a name-stage entry is unmatched/ambiguous (component-match nameVerdict's reason) */
  reason?: string;
  /** DT-27: how much a name match proved (component-match's evidence) */
  evidence?: MatchEvidence;
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

export type ControlKind = "button" | "input" | "select" | "toggle" | "tab" | "link";
export type ControlState = "hover" | "pressed" | "focus" | "disabled" | "error" | "selected" | "loading" | "open";
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
  heavy?: Array<{ file: string; bytes: number; paths?: number; embeddedRaster?: number }>;
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
  /** overrides entries NOT applied, each with why (matched nothing / too broad / not a blocker code / no decidedBy) */
  overridesUnmatched?: Array<AuditOverride & { why: string }>;
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
  /** mapped: components of the NAMED catalog with an entry; mappedElsewhere: entries resolved in another catalog read beside it */
  summary: { entries: number; catalogComponents: number; mapped: number; mappedElsewhere: number; errorCount: number; warningCount: number };
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
export type PlanComputedStatus = PlanLifecycle | "failed" | "blocked" | "stale" | "unverified" | "static-only" | "verified" | "verified-with-deviations";
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
  /** DT-33: the sibling plan (`--seed-from`) this row's person-owned answer was copied from */
  seededFrom?: string;
}
/** A component row's catalog entry. `by:"ambiguous"` (DT-27) names the same-named candidates a person must
 *  choose between — it is NEVER a match (no id/key/name of its own); narrow on `by` before reading `name`. */
export type PlanComponentMatch =
  | { by: "key" | MatchEvidence; id?: string; key?: string; name: string; confirmed?: false }
  | { by: "ambiguous"; candidates: MatchCandidate[] };
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
  /** DT-33: the sibling plan (`--seed-from`) this row's person-owned answer was copied from */
  seededFrom?: string;
}
/** anchors{}[nodeId]. A node is ANCHORED when one of mapModule/file/symbol/omitted is a non-blank string. */
export interface PlanAnchor { name?: string; type?: IrNodeType; parent?: string | null; mapModule?: string; file?: string; symbol?: string; omitted?: string;
  /** F-77: a layout-only wrapper (no paint) the build folded into this ancestor id; --compare checks the claim */
  foldedInto?: string;
  /** D33: this (outermost instance) node is a shared shell — its subtree is counted apart in coverage.sharedShell */
  shared?: boolean }
export interface PlanHiddenRoot { id: string; name: string; type: IrNodeType; nodes: number }
export interface PlanDeviation { id?: string; nodeId?: string; nodeIds?: string[]; field?: string; designed?: JsonValue; built?: JsonValue; reason?: string; what?: string }
/** D5: a person's acceptance of ONE report delta (node + field), bound to the export content and the built value.
 *  Written by `verify-screen --accept`; --compare re-checks every field and reopens it when any moved. */
export interface PlanWaiver {
  nodeId: string;
  /** the exact report delta `field` label ("font-size", "placement", "border-radius (top-left)") */
  field: string;
  /** = delta.expected at accept time */
  designed: JsonValue;
  /** = delta.actual at accept time */
  built: JsonValue;
  /** numeric slack on `built`; default = the field's own tolerance */
  tolerance?: number;
  /** D21: the whole-export content hash at accept time */
  exportContentSha256: string;
  reason: string;
  decidedBy: string;
  /** ISO date */
  decidedAt: string;
  /** the report group id when accepted with --group */
  cause?: string;
}
/** D20: an interaction the owner deliberately left unwired (removed from the graded set before grading). */
export interface PlanDescope {
  nodeId: string;
  trigger: string;
  destinationId?: string;
  exportContentSha256: string;
  reason: string;
  decidedBy: string;
  decidedAt: string;
}
/** A person's exemption. Only one WITH a reason counts (verify-build.ts ignores a reasonless entry — so it may lack one). */
export interface AllowedLiteral { value?: string; file?: string; reason?: string }
/** Pre-filled from an audit with blockers (finding 136); overridden/reason/decidedBy/decidedAt are a person's. */
export interface PlanAuditGate {
  auditFile: string | null;
  /** F-44: `design/audit/<base>.cross.json` when plan-skeleton found it, else null (absent on older plans) */
  crossCheckFile?: string | null;
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
/** F-100 (D115): the tool-owned record of one --compare run, written by plan-record.ts recordPlan(). */
export interface PlanVerificationRecord {
  by: "verify-screen --record-plan"; at: string; report: string; reportSha256: string; verdict: string; headline: string;
  behaviourHeadline?: string;
  counts: { high: number; medium: number; low: number; accepted: number; notMeasured: number; inferred: number };
}
/** F-121 (D113): one thing the build does that the design never drew — judged against best practice, never "matched",
 *  never the verdict. kind: plan-declared interaction, an interaction whose destination was never exported, a state
 *  measured on a node whose design draws none, or an agent-written row (measured.json / evidence `inferred[]`). */
export interface InferredRow {
  kind: "plan-interaction" | "undesigned-interaction" | "undrawn-state" | "agent";
  nodeId?: string; name?: string; trigger?: string; state?: string; built?: string; why: string;
}
export interface PlanVerification {
  mode?: "rendered" | "static-only" | (string & {});
  reason?: string;
  renderer?: string;
  /** Documented as arrays; a plan read from disk may hold anything (the guard does not check them — live L-2: objects). */
  artifacts?: string[] | JsonValue;
  deltas?: JsonValue[] | JsonValue;
  coverage?: { rendered?: string[]; notChecked?: Array<string | { what?: string; why?: string }> };
  /** 12b: the skill copies report.behaviour.summary here — violations = summary.fail, warnings = summary.warn */
  a11y?: { tool?: string; violations?: number; warnings?: number; report?: string };
  verifyScreenVerdict?: string | { verdict?: string };
  verdict?: string | { verdict?: string };
  hook?: PlanHookRecord;
  /** F-100 (D115): what `verify-screen --compare --record-plan` recorded (tool-owned; the report is the verdict) */
  recorded?: PlanVerificationRecord;
  // A model-written verification block often carries more (interactionScript, typecheck, dataDtNode,
  // interactions, …): nothing reads those, and the hook's rewrite carries them through untouched.
}
/** L-1 (D40(7)): one step of plan.navigate / probe --steps. `goto` is a same-origin path ("/x?y"). Never fill/press:
 *  steps are replayed in many contexts, so they must be idempotent and must never submit anything. */
export type ProbeStep = { click: string } | { waitFor: string } | { goto: string };
/** F-95: what a plan interaction's activation should produce; `selector:<css>` = that selector appears. */
export type PlanInteractionExpect = "dialog" | "url" | `selector:${string}`;
/** F-95 (D40(7)): a plan.interactions[] row — keyed nodeId + trigger like an export reaction. */
export interface PlanInteraction { nodeId: string; trigger: string; expect: PlanInteractionExpect; destinationId?: string; name?: string }
/** F-34: one anchor worth filling `mapModule` on first (plan-skeleton.ts suggestAnchors); `covers` = the visible
 *  nodes it stands for (itself + descendants). "screen" is the screen frame itself, listed first. */
export interface AnchorSuggestion { id: string; name: string; why: "screen" | "section" | "instance" | "repeat"; covers: number }
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
  /** F-34: skeleton-owned, refreshed on every merge, not in counts */
  anchorsSuggested?: AnchorSuggestion[];
  deviations?: PlanDeviation[];
  /** D5: accepted report deltas (verify-screen --accept); excluded from verify-build's planHash */
  waivers?: PlanWaiver[];
  /** D20: interactions deliberately not wired (owner-only); excluded from verify-build's planHash */
  descopes?: PlanDescope[];
  auditGate?: PlanAuditGate | null;
  counts?: { tokens: number; tokensVisible: number; instances: number; anchors: number; hiddenNodes: number };
  allowedLiterals?: AllowedLiteral[];
  verification?: PlanVerification;
  /** L-1 (D40(7)): the steps that take a freshly loaded page to this screen (a section behind a click). Closed,
   *  navigation-only vocabulary (probe-steps.ts parseSteps); rows are validated where used, not by the plan guard. */
  navigate?: Array<ProbeStep | JsonValue>;
  /** F-95 (D40(7)): interactions the export does not carry (no prototype reaction) — merged at --expect when valid
   *  (probe-steps.ts / verify-screen.ts); only this list's hash binds the expectation (planInteractions.sha256). */
  interactions?: Array<PlanInteraction | JsonValue>;
  // A filled plan often carries more (layout, states, assets, openQuestions, componentCatalog, …): no
  // reader looks at those, and merge() / the hook's rewrite carry them through untouched.
}

// ================================================================ verify-screen.js

export type DrawnState = "hover" | "pressed" | "focus";
/** One expectation row: ONLY values the export states (a field the export does not define is absent). */
export interface VerifySpec {
  nodeId: string;
  /** the node draws paint this method does not compare (visible effects, a gradient/image fill) — never foldable */
  decorated?: true;
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
  /** F-69 (D114): Figma's text case on a TEXT node (font.case); `text` keeps the stored string — compare the rendered one */
  textCase?: "upper" | "lower" | "title";
  /** F-74 (D111): the node whose drawn state this spec inherits (the owner — hover the owner, not this node); absent = itself */
  drawnStateFrom?: string;
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
  /** node ids of every ancestor, nearest first, the frame root excluded (a probe scopes a text match to a
   *  tagged ancestor with it; --compare does not read it). Absent on expectations written before group 7. */
  ancestorIds?: string[];
  /** the node is absolutely positioned in its auto-layout parent (IrNode.absolute) — never "below the fold" (F-61) */
  absolute?: true;
  /** the node or an ancestor is one of a frame's fixed children (pinned while scrolling) — never "below the fold" (F-61) */
  fixed?: true;
  /** F-104: a TEXT whose identical string repeats in >=3 sibling rows (placeholder copy); compare may demote its text delta */
  repeatedText?: true;
  /** F-104: the rows' group — every spec sharing it is the same text slot in a sibling row */
  repeatedTextGroup?: string;
  /** D32/D35: the ids of the SAME node (component key + visible name path under the outermost instance) in sibling
   *  exports of the same Figma file — a probe may match an element tagged with one of them ("tag-alias") */
  aliases?: string[];
  /** D29: `width` is the text's INK width (renderBox.w), compared with tolerance textInk */
  widthFrom?: "renderBox";
  /** F-79: padding sides that cannot be compared (a fixed axis that is overfull or centres its content) */
  paddingSkip?: Array<"top" | "right" | "bottom" | "left">;
  /** D31: how each axis is sized in auto layout (absent = fixed) — a growing hug axis alone is no size suspect */
  sizing?: { w?: "hug" | "fill"; h?: "hug" | "fill" };
  /** D34: the design's stroke alignment (strokes.align) — a ring read on the other side of the box is noted, not a delta */
  strokeAlign?: "inside" | "outside" | "center";
}
export interface VerifyFrame { nodeId: string; name: string; w?: number; h?: number; x?: number; y?: number; clip?: boolean;
  /** D43: the frame root's prototype scroll direction (IrNode.scroll) — a frame designed to scroll sideways is no overflowX delta */
  scroll?: "horizontal" | "vertical" | "both" }
/** A root frame as an expectation lists it (no position). */
export type VerifyRootFrame = Omit<VerifyFrame, "x" | "y">;
export interface VerifyInstance { nodeId: string; name: string; setName?: string; setKey?: string; variant?: string; props?: ComponentPropValues }
export interface VerifyInteraction { nodeId: string; name: string; trigger: string; action?: string; destinationId?: string; destination?: string;
  /** F-60/D22: false when destinationId is no node of the export for the SAME Figma file (only false is written) */
  destinationExported?: boolean;
  /** F-95: the row came from plan.interactions[] (absent = the export's reactions) */
  source?: "plan";
  /** F-95: the plan row's `expect` (dialog | url | selector:<css>) — `action` is derived from it */
  expect?: string;
  /** F-117: the destination frame's overlay settings (an overlay/swap whose destination root is exported); `from:
   *  "default"` = the export emits no overlay block for it, i.e. Figma's defaults (centred, no scrim, no click-outside) */
  overlay?: VerifyOverlay }
/** F-117: serialize.ts emits a destination root's overlay block only when it differs from the default. */
export interface VerifyOverlay { position: string; closeOnClickOutside: boolean; background: string | null; from: "export" | "default" }
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
  /** F-95: the plan whose interactions[] were merged (D40(7): only their hash binds — a change makes --compare incomplete) */
  planInteractions?: PlanInteractionsInput;
  /** 12c: the reference PNG's geometry over the first frame (absent: an expectation older than 12c, or no reference) */
  referenceImage?: VerifyReferenceImage | VerifyReferenceUnusable;
}
/** expectation.planInteractions: which plan, the hash of its interactions[] (plan-waivers.ts planInteractionsSha256),
 *  how many rows were merged and the ones dropped with why. */
export interface PlanInteractionsInput { plan: string; sha256: string; merged: number; dropped: Array<{ nodeId: string; why: string }> }

/** What a probe measures for one element. Keys beyond the canonical ones are reported as unknown, so the bag is open.
 *  `null` = the probe could not read the value (the shipped probe gives the reason in MeasuredNode.unmeasured[key]);
 *  --compare lists it as not measured, never as checked. */
/** F-74 / DT-48 (D111): who paints an element whose own background-color is transparent. */
export interface PaintedBy { backgroundColor: string; via: "ancestor" | "child"; tag: string; depth: number; dt?: string }
export interface MeasuredStyles {
  fontFamily?: string | null;
  fontSize?: number | null;
  fontWeight?: number | string | null;
  lineHeight?: number | string | null;
  letterSpacing?: number | null;
  color?: string | null;
  backgroundColor?: string | null;
  fill?: string | null;
  borderColor?: string | null;
  borderWidth?: number | null;
  borderRadius?: number | number[] | string | null;
  padding?: Array<number | null> | null;
  gap?: number | Array<number | null> | null;
  gapVisual?: number | null;
  width?: number | null;
  height?: number | null;
  x?: number | null;
  y?: number | null;
  opacity?: number | null;
  text?: string | null;
  placeholderText?: string | null;
  placeholderColor?: string | null;
  /** F-69 (D114): computed `text-transform` (inherited) of a TEXT item — optional, not a required style key */
  textTransform?: string | null;
  /** F-74 (D111): when the element's own background is transparent, the ancestor (or same-box child) that paints it */
  paintedBy?: PaintedBy | null;
  tag?: string | null;
  textBox?: { x?: number | null; w?: number | null } | null;
  /** F-78: getComputedStyle(el).display */
  display?: string | null;
  /** D34: where borderWidth/borderColor were read when the element draws no real border (a ring) */
  strokeFrom?: "border" | "box-shadow" | "outline";
  /** D34: the ring's side of the box — only when strokeFrom is not "border" */
  strokeAlign?: "inside" | "outside";
  transform?: string | null;
  rotate?: string | null;
  visible?: boolean | null;
  [key: string]: unknown;
}
/** nodes[] of measured.json: `{nodeId, styles}` (canonical) or the styles flat on the row (older probes). */
export interface MeasuredNode extends MeasuredStyles {
  nodeId: string;
  styles?: MeasuredStyles;
  states?: Record<string, MeasuredStyles | { styles: MeasuredStyles; unmeasured?: Record<string, string> }>;
  /** how the probe found the element: "tag" | "tag-shared-path" | "text" | "text-ordinal" | "position" | "frame"
   *  from the shipped probe; free text from a hand-written one */
  matchedBy?: string;
  note?: string;
  notes?: string;
  selector?: string;
  /** how many elements `selector` matched */
  selectorCount?: number;
  /** why a styles key is null: `{<key>: "<why>"}` */
  unmeasured?: Record<string, string>;
  /** a TEXT spec's typography was read from this descendant of the matched element (e.g. "span") */
  textFrom?: string;
  /** the text is split over several runs; the first run's owner was read */
  textFromMixed?: boolean;
  /** where `fill` was read from */
  fillSource?: "svg" | "background" | "img" | "css";
}
export interface MeasuredComponent { setName?: string; name?: string; nodeId?: string; present?: boolean; detail?: string; note?: string }
/** What an interaction visibly did (F-102) — recorded by whoever drove it, never inferred from `detail`. */
export type InteractionOutcome = "url-changed" | "dialog-opened" | "selector-appeared" | "state-changed" | "none";
export interface InteractionEvidence { nodeId: string; trigger?: string; ok?: boolean | null; result?: "not-probed"; selector?: string; selectorCount?: number; detail?: string;
  /** F-102: what the interaction did — a free-text value is read as "no outcome recorded" */
  outcome?: InteractionOutcome | (string & {});
  /** F-102 (D24): documents LOADED in the main frame during the interaction — a reload or a cross-document navigation
   *  (page 'load' events, or a window marker set before and gone after). An in-page URL change (pushState, a hash)
   *  loads none: it is 0. A reload is not an outcome. */
  navEvents?: number;
  /** F-70: how the shipped probe activated the control — "synthetic" (el.click()) is never a user activation (ok:null) */
  activation?: ProbeActivation;
  /** F-70: the first dialog-contract selector the opened element matched (":modal", "dialog[open]", …), or "destination-tag" */
  detectedBy?: string;
  /** the hover target that revealed a hover-hidden opener (D16 path) */
  revealedBy?: string;
  /** D41: the destination frame's tag — inside = within (or equal to, or an ancestor of) the opened element */
  destination?: { nodeId: string; inside: boolean; count: number };
  /** 12b seam: what opened, recorded raw — never graded in 12a */
  opened?: { selector: string; modal: boolean; position: string; rect: { x: number; y: number; w: number; h: number }; scrollY: number };
  /** the probe's driving budget ran out before this row: no evidence (D41: never overrides anything) */
  cut?: "budget";
  /** L-1: replaying the steps failed in the driving page (the row is not-run) */
  stepsFailed?: string }
/** F-70: how the probe clicked an opener. */
export type ProbeActivation = "mouse" | "synthetic";
/** measured.reach (L-1): the steps the probe replayed to reach the screen. */
export interface ProbeReach { steps: ProbeStep[]; sha256: string; source: string; url: string }
/** measured.page (D43): the document's horizontal overflow at the measured viewport, read in the measurement pass. */
export interface PageOverflow {
  viewport: { w: number; h: number };
  /** documentElement.scrollWidth / clientWidth */
  scrollWidth: number; clientWidth: number;
  /** the viewport's propagated overflow-x (html's, else body's) */
  overflowX: string;
  /** scrollWidth > clientWidth + 1 and overflowX is not hidden/clip — the user can scroll sideways */
  scrollable: boolean;
  /** ≤5 elements with the widest right edges past clientWidth */
  offenders: Array<{ path: string; dt: string | null; right: number }>;
  /** document.compatMode when not "CSS1Compat" (quirks mode measures the viewport off body) — informational */
  compatMode?: string;
}
// ---------------------------------------------------------------- 12b behaviour / a11y (D4, D40, D42, D45, D46)
// Never part of the fidelity verdict (D4): compare copies and counts these, nothing else reads them.
export type BehaviourStatus = "pass" | "fail" | "warn" | "not-run" | "unsupported";
export type BehaviourCheckId =
  | "dialog.focus-on-open" | "dialog.focus-trap" | "dialog.escape-closes" | "dialog.focus-return" | "dialog.nested-escape"
  | "dialog.scroll-open" | "dialog.scrim" | "dialog.click-outside"
  | "keyboard.reachable" | "keyboard.activation" | "keyboard.focus-visible"
  | "a11y.name" | "a11y.landmarks" | "a11y.axe"
  | "forced-colors.visible" | "layout.subpixel" | "overflow.mid" | "overflow.narrow";
/** One behaviour/a11y result. Per-element checks: one row per non-pass element (≤20, then a "+N more" row of the same
 *  status with evidence.count) plus one aggregate pass row ("k of n"). */
export interface BehaviourCheck {
  /** a BehaviourCheckId from this probe; a reader keeps unknown ids (older/newer probes interoperate) */
  id: BehaviourCheckId | (string & {});
  status: BehaviourStatus;
  /** the interaction row (dialog.*, keyboard.activation) or the tagged element */
  nodeId?: string; trigger?: string;
  /** "escape" | "close" (focus-return), "y=0" | "y=150" | "y=max" (scroll-open), "design" | "1024x900" | "320x900" (widths) */
  variant?: string;
  /** element path when untagged */
  target?: string;
  detail: string;
  /** F-122: a synthetic (headless) observation, not a real-browser one */
  synthetic?: true;
  evidence?: JsonObject;
}
export interface BehaviourLandmark { role: string; name: string | null; depth: number }
export type BehaviourAxe =
  | { ran: true; package: "axe-core"; version: string; violations: Array<{ id: string; impact: string | null; nodes: number; help: string; targets: string[] }> }
  | { ran: false; why: string };
export interface BehaviourWidth {
  role: "design" | "mid" | "narrow";
  overflow: PageOverflow;
  subpixel: Array<{ path: string; dt: string | null; tag: string; width: number; text: string }>;
}
/** measured.behaviour — written by the shipped probe after measuring and driving (never exit 4, never blocks the file). */
export type MeasuredBehaviour =
  | { version: 1; ran: true; browser: { name: string; version: string }; namesComputedBy: string; budgetMs: number; elapsedMs: number;
      cut: boolean; checks: BehaviourCheck[]; landmarks: BehaviourLandmark[] | null; axe: BehaviourAxe; widths: BehaviourWidth[]; artifacts: string[];
      /** L-6: the write block's scope, one line — what the battery's pages cannot send and what it does not see */
      writeBlock?: string }
  | { version: 1; ran: false; why: string };
export interface BehaviourSummary { pass: number; fail: number; warn: number; notRun: number; unsupported: number }
/** report.behaviour — always written by --compare (ran:false + why when the measured file has no behaviour block). */
export interface ReportBehaviour {
  ran: boolean; why?: string;
  summary: BehaviourSummary;
  /** the second headline: "BEHAVIOUR/A11Y (not the fidelity verdict) — …" */
  headline: string;
  namesComputedBy?: string;
  axe?: { version: string } | { notRun: string };
  /** sorted fail > warn > not-run > unsupported > pass */
  checks: BehaviourCheck[];
  artifacts?: string[];
  /** L-6: measured.behaviour.writeBlock, copied (the write block's scope in one line) */
  writeBlock?: string;
}
// ---------------------------------------------------------------- 12c visual diff (D40(3) informational, D40(4) reference DPR, D48, D49)
// Never read for the verdict (D4): compare copies it into report.visual, nothing else reads it.
export interface Rect4 { x: number; y: number; w: number; h: number }
/** expectation.referenceImage — the export reference PNG and how it sits over the first frame (--expect, 12c). */
export interface VerifyReferenceImage {
  usable: true;
  /** project-relative posix path: "design/export/" + expectation.reference */
  path: string; sha256: string;
  png: { w: number; h: number };
  /** PNG px per design px (4 decimals, as the index) */
  scale: number;
  /** design px: the PNG's top-left relative to the frame box's top-left (renderBox − box; ≤ 0 usually) */
  offset: { x: number; y: number };
  from: "index" | "export";
  /** the frame box inside the PNG, device px, clamped */
  crop: Rect4;
  /** "display_p3" (design-system stamp) and/or "iCCP:<name>" — colours not colour-managed */
  colorProfile?: string;
}
/** expectation.referenceImage when the reference cannot be diffed (missing, not a PNG, a discovery thumbnail — F-08) */
export interface VerifyReferenceUnusable { usable: false; path: string | null; why: string }
export interface VisualRegion {
  /** frame-relative CSS px */
  rect: Rect4;
  /** shift-tolerant differing px on the compared grid */
  pixels: number;
  /** pixels / region area · 100 (1 decimal) */
  pct: number;
  /** measured nodeIds overlapping, smallest first, ≤5 */
  built: string[];
  /** expectation nodeIds overlapping by design geometry, smallest first, ≤5 */
  designed: string[];
}
/** measured.visual — written by the shipped probe after measuring and driving (never exit 4, never blocks the file). */
export type MeasuredVisual =
  | { version: 1; ran: true;
      reference: { path: string; sha256: string; scale: number; offset: { x: number; y: number }; from: "index" | "export"; crop: Rect4; colorProfile?: string };
      capture: { dsf: number; clip: Rect4; frame: { nodeId: string; via: string; selector: string | null }; size: { w: number; h: number } };
      grid: "reference" | "1x"; resampled: "none" | "build" | "both";
      /** device px; k = device px per CSS px */
      compared: { w: number; h: number; k: number };
      notCompared?: { pct: number; why: string };
      /** a cell (cellPx², device px) is hot at ≥ max(hotMinPx, hotFraction · cellPx²) shift-tolerant differing px (D59: 0.08
       *  and 4; hotMinPx absent = a file written before that rule, when a cell was hot above 0.25 of it) */
      threshold: number; shiftPx: number; cellPx: number; hotFraction: number; hotMinPx?: number;
      /** YIQ + AA excluded (pixelmatch ≤7.2 count) */
      differingPct: number;
      shiftTolerantPct: number; aaPct: number;
      regions: VisualRegion[]; regionsTotal: number;
      diff: string | null; elapsedMs: number; notes: string[] }
  | { version: 1; ran: false; why: string };
/** report.visual — always written by --compare (ran:false + why when the measured file has no visual block). */
export interface ReportVisual {
  ran: boolean; why?: string; headline: string;
  /** DT-55 (D116): plan deviations with field "reference" — the PNG is illustrative there; never waives a delta */
  illustrative?: Array<{ nodeId: string; reason: string }>;
  differingPct?: number; shiftTolerantPct?: number; grid?: "reference" | "1x"; scale?: number;
  /** sha256: the reference PNG's (measured.visual.reference.sha256) — the next round's `against` needs the same one */
  reference?: { path: string; from: "index" | "export"; colorProfile?: string; sha256?: string };
  regions: VisualRegion[]; regionsTotal?: number;
  diff?: { path: string; exists: boolean };
  notes: string[];
  /** the previous round's shiftTolerantPct beside this one's — only when both rounds diffed the same reference (sha256)
   *  on the same grid; never verdict-changing (D18) */
  against?: { report: string; before: number; after: number };
}
/** measured.build (DT-81): what the probe was served — so a stale preview/dist is visible. */
export interface BuildIdentity {
  url: string;
  /** vite-dev when /@vite/client was served; static when same-origin assets were and it was not */
  mode: "vite-dev" | "static" | "unknown";
  /** same-origin document/script/stylesheet responses hashed */
  assets: number;
  /** sha256 over the sorted "<path> <sha256 of body>" lines */
  assetsSha256: string;
  /** same-origin bodies the probe could not hash (unread, failed) — present when > 0: assetsSha256 is partial, never
   *  "the same build" as another (verify-screen's sameBuild is null then) */
  unhashed?: number;
  gitHead: string | null;
  gitDirty: boolean | null;
}
/** The shipped probe's identity (measured.probe; copied to report.inputs.probe). */
export interface ProbeIdentity { name: string; version: string | null; sha256: string; playwright: { package: string; version: string };
  /** DT-30 (D112): executable "custom" when --browser-path named it (the path itself is never written) */
  browser: { name: string; version: string; executable?: "custom" } }
/** The element the probe took as a frame root, and how it found it. */
export interface ProbeFrame { nodeId: string; selector: string; via: "tag" | "size-and-fill" | "viewport"; rect: { x: number; y: number; w: number; h: number } }
/** Main-frame navigations the probe saw, and how many full re-runs they cost. */
export interface ProbeNavigation { events: Array<{ type: string; url: string; at: number }>; afterInitialLoad: number; reruns: number }
/** measured.notMeasured[] from the shipped probe: a spec it could not match, and why. */
export interface ProbeNotMeasured { nodeId: string; why: string }
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
  /** `{nodeId, why}` from the shipped probe; hand-written probes wrote bare ids or `{nodeId, reason}` */
  notMeasured?: Array<ProbeNotMeasured | JsonValue>;
  componentsMissing?: JsonValue[];
  probe?: ProbeIdentity;
  frame?: ProbeFrame;
  frames?: ProbeFrame[];
  navigation?: ProbeNavigation;
  /** the probe's own count per matchedBy value (compare recomputes its census from nodes[]) */
  matchedByCensus?: Record<string, number>;
  /** the shipped probe's run notes (settling, frame fallbacks, state measurement) — informational */
  notes?: string[];
  /** F-72: the verify run (status v2) this measurement belongs to */
  runId?: string;
  /** DT-81: the build the probe was served */
  build?: BuildIdentity;
  /** DT-47: data-dt-node values on visible elements that are no expected/hidden/instance/frame id ({id, elements}: first 50, sorted) */
  tagsNotInExpectation?: { count: number; ids: Array<{ id: string; elements: number }> };
  /** L-1: the steps replayed before measuring */
  reach?: ProbeReach;
  /** D43: page overflow at the measured viewport */
  page?: PageOverflow;
  /** 12b: behaviour/a11y checks (D4: never read for the verdict) */
  behaviour?: MeasuredBehaviour;
  /** 12c: the visual diff against the reference PNG (D4: never read for the verdict) */
  visual?: MeasuredVisual;
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
  /** D5: a plan waiver matched this delta — it stays listed, but leaves the counts and the verdict */
  accepted?: { reason: string; decidedBy: string; decidedAt: string; cause?: string };
  /** F-76: presentational group id (one cause) — counts and verdict stay per delta */
  group?: string;
  /** D30/D31: the severity before a match-confidence cap lowered it */
  cappedFrom?: DeltaSeverity;
  /** D39: which caps bound it — "size" (D31, lifted by a waiver on match (size)) and/or "match" (D30, stays) */
  cappedBy?: Array<"size" | "match">;
}
/** D43: coverage.pageOverflow. */
export type PageOverflowCoverage = "ok" | "overflows" | "clipped" | "not measured" | "not at design width" | "designed to scroll";
/** "undesigned" (D22): the destination was never exported; "descoped" (D20): the owner removed it from the graded set. */
export type InteractionResult = "pass" | "fail" | "not-probed" | "undesigned" | "descoped";
export interface VerifyInteractionResult extends VerifyInteraction { result: InteractionResult; detail?: string; selector?: string; selectorCount?: number; note?: string; outcome?: string; navEvents?: number;
  /** D41: whose row was graded — the run-bound shipped probe's, or the agent's (--interactions / an unbound measured row) */
  evidenceFrom?: "probe" | "agent";
  activation?: string; detectedBy?: string; revealedBy?: string;
  /** D41: the other side's disagreeing claim that this result overrides */
  overridden?: string }
export interface ArtifactCheck { path?: string; exists: boolean; image: boolean; sha256?: string }
/** report.inputs.code (finding 317): which code was measured, by content. */
export interface CodeInputs { plan?: string; files: Record<string, string | null>; gitHead?: string | null }
export type VerifyVerdict = "pass" | "pass-with-deviations" | "fail" | "incomplete";
/** report.waivers (D5): how the plan's waivers fared against this round's deltas. */
export interface VerifyWaiverResult {
  /** waivers that matched a delta (the delta carries `accepted`) */
  applied: number;
  /** waivers (and descopes) that matched a node + field but no longer hold, and why */
  reopened: Array<{ nodeId: string; field: string; why: string }>;
  /** waivers (and descopes) that match nothing this round (fixed? drop them) */
  unused: Array<{ nodeId: string; field: string; why?: string }>;
}
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
  inputs?: { expectationSchema?: string; expectationSha256?: string; measuredSha256?: string; measuredAgainst?: string; exportContentSha256?: string; code?: CodeInputs;
    /** the shipped probe's identity, or "unknown" for a hand-written measured.json (group 7) */
    probe?: ProbeIdentity | "unknown";
    /** the plan whose waivers/descopes were applied, and waiversHash() of them (verify-build: stale when it differs) */
    waivers?: { plan: string; sha256: string };
    /** DT-81: the build the probe was served (measured.build), or "unknown" */
    build?: BuildIdentity | "unknown";
    /** F-72: the verify run the measured file belongs to */
    runId?: string;
    /** L-1: the steps the probe replayed (measured.reach); matchesPlan = their sha equals the plan's navigate (null: no plan navigate) */
    reach?: { sha256: string; steps: number; source: string; matchesPlan: boolean | null } };
  verdict?: VerifyVerdict | (string & {});
  headline?: string;
  /** 12b: the behaviour/a11y section — a second headline, never the verdict (D4) */
  behaviour?: ReportBehaviour;
  /** 12c: the visual diff — a third headline, informational, never the verdict (D4, D40(3)) */
  visual?: ReportVisual;
  /** F-121 (D113): "Inferred, not designed" — never the verdict (D4 style) */
  inferred?: InferredRow[];
  why?: string[];
  /** L-1: the why[] entries that say the run itself is unverified (D26) — what --accept refuses on. Absent in reports
   *  written before it was recorded (--accept then matches why[] by wording). */
  integrity?: string[];
  coverage?: {
    nodesExpected: number; nodesMeasured: number; nodesNotMeasured?: number; nodesMatchedByComponentPath?: number; fieldsChecked: number;
    fieldsNotMeasured?: number; fieldsNeverMeasured?: Array<{ field: string; expectedOn: number; measuredOn: number; probeSent?: string[] }>;
    valuesNotComparable?: number; valuesUnverifiable?: number; hiddenLayersSkipped?: { layers: number; nodes: number; specsSkipped: number; instancesSkipped: number; interactionsSkipped: number };
    instanceSets?: number; instanceSetsWithEvidence?: number; instanceSetsViaSharedPath?: number; componentsBuilt?: number;
    interactionsExpected?: number; interactionsPassed?: number; interactionsFailed?: number; interactionsNotProbed?: number;
    interactionsUndesigned?: number; interactionsDescoped?: number; deltasAccepted?: number; nodesFolded?: number;
    /** measured specs per matching rule (tag, tagSharedPath, text, textOrdinal, position, frame, sharedComponentPath, other, unstated) */
    matchedBy?: Record<string, number>;
    /** D33 (informational): outermost instances that are a shared shell, and their specs expected/measured */
    sharedShell?: { instances: Array<{ nodeId: string; name: string; setName?: string; expected: number; measured: number }>; expected: number; measured: number };
    /** D41: interaction results graded on the run-bound shipped probe's rows */
    interactionsByProbe?: number;
    /** D43: the page's horizontal overflow at the design width */
    pageOverflow?: PageOverflowCoverage;
  };
  /** high/medium/low count OPEN deltas only; `accepted` = deltas a plan waiver matched */
  summary?: { high: number; medium: number; low: number; componentsAbsent?: number; interactionsFailed?: number; interactionsNotProbed?: number; missingComponents?: number;
    accepted?: number; descoped?: number; undesigned?: number;
    /** F-121 (D113): rows of report.inferred — never the verdict */
    inferred?: number;
    /** distinct causes among the open high deltas (F-76: a group counts once) */
    highCauses?: number;
    /** D39: open deltas whose severity a match cap lowered (cappedFrom) — any blocks a plain pass */
    lowConfidence?: number };
  waivers?: VerifyWaiverResult;
  /** F-77: specs a plan anchor folded into a measured ancestor — out of the denominator */
  folded?: Array<{ nodeId: string; name?: string; into: string; why: string }>;
  deltas?: VerifyDelta[];
  componentsAbsent?: Array<{ setName: string; nodeIds: string[]; detail?: string }>;
  untaggedInstanceSets?: Array<{ setName: string; setKey?: string; nodeIds: string[]; instances: number }>;
  /** F-96 (D33): untagged instance sets that live inside a shared shell — not this screen's work */
  untaggedInstanceSetsInShell?: Array<{ setName: string; setKey?: string; nodeIds: string[]; instances: number }>;
  /** @1 only */
  missingComponents?: Array<{ setName: string; setKey?: string; nodeIds: string[]; instances: number }>;
  interactions?: VerifyInteractionResult[];
  notMeasured?: Array<{ nodeId: string; name?: string; path?: string; why: string }>;
  fieldsNotMeasured?: Array<{ nodeId: string; name?: string; field: string; why: string }>;
  unverifiable?: Array<{ nodeId: string; name?: string; field: string; expected: JsonValue; why: string }>;
  notComparable?: NotComparable[];
  probe?: { unknownKeys: Array<{ key: string; count: number; canonical?: string }>;
    /** top-level keys of the measured file verify-screen does not read (F-94: `notFound`, `extra`) — listed, never used */
    unknownTopLevelKeys?: Array<{ key: string; canonical?: string }>; duplicateNodeIds: number; interactionEvidenceOnHiddenLayers: number; interactionEvidenceNotInExpectation: number; measuredIdsOnHiddenLayers: number;
    /** measured node ids that match no spec, instance or hidden layer of the expectation (and no shared path) */
    measuredIdsNotInExpectation?: number; measuredIdsNotInExpectationSample?: string[];
    /** malformed optional extras of the measured file that were ignored (a hand-written `probe`, a non-list notMeasured) */
    inputNotes?: string[];
    /** DT-29: interaction results whose nodeId + trigger match no designed interaction, with a hint when one is near */
    unmatchedInteractionEvidence?: Array<{ nodeId: string; trigger: string; hint?: string }>;
    /** DT-47: measured tags/ids not in the expectation, classified — prefixDrift: the `;` suffix equals an expected id's;
     *  alias: some spec's alias; unknown: neither */
    foreignTags?: { total: number; prefixDrift: number; alias: number; unknown: number; sample: string[] } };
  /** D18: coverage against the previous report (the one this run overwrote, or --against) */
  against?: VerifyAgainst;
  limits?: string[];
  /** read by verify-build.js locateReports (a report written under a nickname) */
  nodeId?: string;
}
/** report.against (D18): the previous round's coverage beside this one's. Never changes the verdict. */
export interface VerifyAgainst {
  report: string;
  nodesMeasured: { before: number | null; after: number };
  nodesExpected: { before: number | null; after: number };
  /** true/false when both rounds name a probe sha (or only one does); null when neither does */
  probeChanged: boolean | null;
  /** null when either report lacks inputs.expectationSha256 */
  expectationChanged: boolean | null;
  /** F-92: the previous round's deltas (nodeId + field) against this round's; lostCoverage = a previous delta whose
   *  node is not measured now, or whose measured node lacks the value (key absent or null) — neither fixed nor still
   *  open. H2: nowUnverifiable = a previous delta whose value WAS measured but the compare now declines it (an
   *  impossible value, an <img> fill, a method gap) — not lost coverage; reclassified = every difference when the
   *  measured file is the SAME as last round's (inputs.measuredSha256): the compare (or the expectation) changed, not
   *  the build, so nothing is fixed, new or lost. */
  deltas?: { fixed: number; new: number; unchanged: number; lostCoverage: Array<{ nodeId: string; field: string; was: JsonValue; why: string }>;
    nowUnverifiable?: Array<{ nodeId: string; field: string; was: JsonValue; why: string }>;
    sameMeasured?: boolean;
    reclassified?: Array<{ nodeId: string; field: string; change: "gone" | "new"; was: JsonValue }> };
  /** DT-81: both rounds served the same build (assetsSha256); null when either round records none */
  sameBuild?: boolean | null;
}
type VerifyCoverage = NonNullable<VerifyReport["coverage"]>;
/** report.coverage as compare() writes it (schema @2): every counter present. */
export interface VerifyCoverageV2 extends VerifyCoverage {
  nodesNotMeasured: number; nodesMatchedByComponentPath: number; fieldsNotMeasured: number;
  fieldsNeverMeasured: NonNullable<VerifyCoverage["fieldsNeverMeasured"]>; valuesNotComparable: number; valuesUnverifiable: number;
  instanceSets: number; instanceSetsWithEvidence: number; instanceSetsViaSharedPath: number;
  interactionsExpected: number; interactionsPassed: number; interactionsFailed: number; interactionsNotProbed: number;
  interactionsUndesigned: number; interactionsDescoped: number; deltasAccepted: number; nodesFolded: number;
  matchedBy: Record<string, number>;
}
/**
 * What verify-screen.js compare() returns (schema @2): every @2 field present. `artifacts` is the CLI's
 * on-disk check when it ran, else the probe's own list passed through as-is (the one field wider than VerifyReport's).
 */
export interface VerifyReportV2 extends Omit<VerifyReport, "artifacts"> {
  artifacts: Array<string | ArtifactCheck | { path?: string }>;
  /** M2 (s19): the measured file was static-only (nothing rendered) — absent for a rendered one; `reason` is its why */
  mode?: "static-only";
  reason?: string;
  verdict: VerifyVerdict;
  headline: string;
  /** 12b: always written (ran:false + why when the measured file has none) — never the verdict (D4) */
  behaviour: ReportBehaviour;
  /** 12c: always written (ran:false + why when the measured file has none) — never the verdict (D4) */
  visual: ReportVisual;
  why: string[];
  integrity: string[];
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
  waivers: VerifyWaiverResult;
  folded: NonNullable<VerifyReport["folded"]>;
  probe: NonNullable<VerifyReport["probe"]>;
  limits: string[];
}

// ================================================================ design-diff.js

export type DiffCategory =
  | "text" | "typography" | "paint" | "layout" | "shape" | "tokens" | "component" | "visibility" | "asset" | "interaction" | "handoff"
  | "other" | "document" | "collection" | "style" | "manifest";
export interface FieldDiff { field: string; category: DiffCategory; before: string | undefined; after: string | undefined }
export interface DiffNodeRef { id: string; name: string; type: IrNodeType; path: string; parentId: string | null }
export interface DiffSummary { added: number; removed: number; changed: number; reordered?: number; positionOnly?: number;
  /** D141: nodes whose only differences are the old plugin's format noise (−1 grid anchors, `layout` on childless types) */
  formatOnly?: number }
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
  | { status: "not-found"; candidates: ScreenCandidate[]; noTitles?: true; noIndex?: { dir: string; hint: string | null } };

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
