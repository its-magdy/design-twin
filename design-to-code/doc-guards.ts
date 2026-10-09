// doc-guards.ts — one runtime guard per JSON document kind the design-to-code layer reads off disk.
//
// A tool must not parse a file and merely assert its type (`JSON.parse(…) as TokensDoc`), trusting that the
// file was this repo's own output. It usually is — but a hand-edited plan, a truncated write, the wrong
// file passed on the command line, or an older export all reach the same code, which would die with a
// TypeError and a stack deep inside a walker, or (worse) quietly read nothing. Each guard here checks the
// TOP-LEVEL fields its readers actually use (the arrays they iterate, the objects they index), plus the
// identifying fields of the entries in those arrays, and nothing more: a guard is a boundary check, not a
// schema validator. Maps have their own full validator (map-validate.ts validateMap).
//
// Each guard carries an `expected` string: what read-json.ts prints when a file fails it.
import { isJsonObject } from "./types.ts";
import type { JsonObject } from "./types.ts";
import { isStringArray } from "../bridge/src/json-util.ts";
import type { VariableComposedColor } from "../bridge/src/doc-types.ts";
import type {
  AuditOverridesDoc, VariableAlias, AuditReport, BehaviourCheck, BehaviourStatus, BuildIdentity, CatalogComponent, ComponentDetailFile, ComponentProposal, ComponentsCatalog, InteractionEvidence, MeasuredComponent, PageIndex, PagesRootIndex, Plan,
  PageOverflow, PlanDescope, PlanWaiver, ProbeFrame, ProbeReach, ProbeIdentity, MeasuredBehaviour, MeasuredVisual, Rect4, ReportBehaviour, ScreenAssetsDoc, TextStylesDoc, TokensDoc, Variable, VariableCollection, VerifyMeasured, VerifyReferenceImage, VerifyReferenceUnusable, VerifyReport, VisualRegion,
} from "./types.ts";
import type { Expectation } from "./verify-shared.ts";

/** A type guard that can say, in words, what it expects (read-json.ts prints it on a mismatch). */
export type DocGuard<T> = ((x: unknown) => x is T) & { expected?: string };

// ---------------------------------------------------------------- small combinators
/** `x` is absent, or an array whose every entry passes `each`. */
function optArrayOf<T>(x: unknown, each: (e: unknown) => e is T): x is T[] | undefined {
  return x === undefined || (Array.isArray(x) && x.every(each));
}
const isObj = isJsonObject;
const optObj = (x: unknown): boolean => x === undefined || isObj(x);
const optStr = (x: unknown): boolean => x === undefined || typeof x === "string";
const anyObject = (x: unknown): x is object => isObj(x);

// ---------------------------------------------------------------- tokens.json / variables.json / <Screen>.vars.json
/** A variable value that points at another variable: `{ aliasOf: "<name>" }`. */
export const isAlias = (v: unknown): v is VariableAlias => !!v && typeof v === "object" && "aliasOf" in v && typeof v.aliasOf === "string";
/** A composed colour `{composed:{color, opacity}}` (doc-types ComposedColor). Each half is checked, so a
 *  hand-written token file with a malformed `composed` object is a non-scalar value (skipped + reported),
 *  never a half-read one. At least one half must be an alias — a composed colour with two literals is not one. */
export const isComposed = (v: unknown): v is VariableComposedColor => {
  if (!v || typeof v !== "object" || !("composed" in v)) return false;
  const c = v.composed;
  if (!c || typeof c !== "object" || !("color" in c) || !("opacity" in c)) return false;
  const colorOk = typeof c.color === "string" || isAlias(c.color);
  const opacityOk = typeof c.opacity === "number" || isAlias(c.opacity);
  return colorOk && opacityOk && (isAlias(c.color) || isAlias(c.opacity));
};
/** A number written as text ("40", "-5", "12.5") — a string-number FLOAT value. */
export const NUMERIC_TEXT = /^-?\d+(?:\.\d+)?$/;
function isVariable(x: unknown): x is Variable {
  return isObj(x) && typeof x.name === "string" && typeof x.type === "string" && isObj(x.values) && optStr(x.collection);
}
function isVariableCollection(x: unknown): x is VariableCollection {
  return isObj(x) && typeof x.name === "string" && isStringArray(x.modes);
}
/** design-system/tokens.json, the merged variables.json, a <Screen>.vars.json slice. Every array optional. */
export function isTokensDoc(x: unknown): x is TokensDoc {
  return isObj(x) && optArrayOf(x.variables, isVariable) && optArrayOf(x.collections, isVariableCollection)
    && optArrayOf(x._slices, anyObject) && optArrayOf(x._conflicts, anyObject) && (x.hygiene === undefined || isStringArray(x.hygiene));
}
isTokensDoc.expected = "a token catalog: an object whose `variables` (each {name, type, values}) and `collections` (each {name, modes[]}), when present, are arrays";

// ---------------------------------------------------------------- components.local.json / components.library.json
function isCatalogComponent(x: unknown): x is CatalogComponent {
  return isObj(x) && typeof x.name === "string" && optStr(x.key) && optStr(x.id) && optObj(x.props) && optArrayOf(x.variants, anyObject);
}
export function isComponentsCatalog(x: unknown): x is ComponentsCatalog {
  return isObj(x) && Array.isArray(x.components) && x.components.every(isCatalogComponent);
}
isComponentsCatalog.expected = "a component catalog: an object with a `components` array of {name, type, key?, id?, props?}";

/** design-system/components/<name>__<id>.json */
export function isComponentDetailFile(x: unknown): x is ComponentDetailFile {
  return isObj(x) && typeof x.name === "string" && optArrayOf(x.variants, anyObject) && optObj(x.node);
}
isComponentDetailFile.expected = "a component detail file: an object with a `name` and `variants[]` or `node`";

/** design-system/styles.text.json */
export function isTextStylesDoc(x: unknown): x is TextStylesDoc {
  return isObj(x) && Array.isArray(x.styles) && x.styles.every((s) => isObj(s) && typeof s.name === "string");
}
isTextStylesDoc.expected = "a text-style sheet: an object with a `styles` array of {name, …}";

// ---------------------------------------------------------------- <Screen>.assets.json (write-out.ts writeScreenAssets)
export function isScreenAssetsDoc(x: unknown): x is ScreenAssetsDoc {
  return isObj(x)
    && optArrayOf(x.heavy, (h): h is { file: string; bytes: number } => isObj(h) && typeof h.file === "string" && typeof h.bytes === "number"
      && (h.paths === undefined || typeof h.paths === "number") && (h.embeddedRaster === undefined || typeof h.embeddedRaster === "number"))
    && optArrayOf(x.files, (f): f is { file: string } => isObj(f) && typeof f.file === "string" && optStr(f.node));
}
isScreenAssetsDoc.expected = "a screen asset manifest: an object whose `heavy` ({file, bytes}) and `files` ({file, node?}), when present, are arrays";

// ---------------------------------------------------------------- libraries/index.json (bridge/src/library-layout.ts)
/** The two fields of one libraries/index.json row the audit reads. */
export interface LibrariesIndexEntry { dir: string; libraryName?: string; collectionKeys?: string[] }
export function isLibrariesIndex(x: unknown): x is { libraries: LibrariesIndexEntry[] } {
  return isObj(x) && Array.isArray(x.libraries)
    && x.libraries.every((r) => isObj(r) && typeof r.dir === "string" && optStr(r.libraryName) && (r.collectionKeys === undefined || isStringArray(r.collectionKeys)));
}
isLibrariesIndex.expected = "a library index: an object with a `libraries` array of {dir, libraryName?, collectionKeys?}";

// ---------------------------------------------------------------- design/audit/<screen>.overrides.json
const SEVERITIES = ["blocker", "warning", "info"];
export function isAuditOverridesDoc(x: unknown): x is AuditOverridesDoc {
  return isObj(x) && Array.isArray(x.overrides) && x.overrides.every((o) => isObj(o) && typeof o.code === "string" && typeof o.severity === "string" && SEVERITIES.includes(o.severity)
    && typeof o.reason === "string" && o.reason.trim() !== "" && ["nodeId", "token", "component", "collection", "mode", "category", "state", "screen", "decidedBy", "decidedAt"].every((k) => optStr(o[k])));
}
isAuditOverridesDoc.expected = "an audit overrides file: { overrides: [{ code, severity: blocker|warning|info, reason (non-empty), nodeId?, token?, component?, collection?, mode?, category?, state?, screen?, decidedBy?, decidedAt? }] }";

// ---------------------------------------------------------------- design/audit/<screen>.json
export function isAuditReport(x: unknown): x is AuditReport {
  return isObj(x) && isObj(x.summary) && Array.isArray(x.findings) && x.findings.every((f) => isObj(f) && typeof f.severity === "string" && typeof f.code === "string");
}
isAuditReport.expected = "an audit report (written by the audit script's --out): an object with `summary` and a `findings` array of {severity, code, message}";

// ---------------------------------------------------------------- cross-check / audit report: componentProposals[]
function isProposal(x: unknown): x is ComponentProposal {
  return isObj(x) && typeof x.name === "string";
}
export function isProposalList(x: unknown): x is ComponentProposal[] {
  return Array.isArray(x) && x.every(isProposal);
}
isProposalList.expected = "a list of component proposals: an array of {name, catalog, confirmed, …}";

// ---------------------------------------------------------------- pages/index.json, pages/<Page>/index.json
function isIndexRowLike(x: unknown): boolean {
  return isObj(x) && typeof x.id === "string" && typeof x.name === "string";
}
export function isPagesRootIndex(x: unknown): x is PagesRootIndex {
  return isObj(x) && Array.isArray(x.pageDirs) && x.pageDirs.every((d) => isObj(d) && optStr(d.dir) && optStr(d.index))
    && (x.layers === undefined || (Array.isArray(x.layers) && x.layers.every(isIndexRowLike)));
}
isPagesRootIndex.expected = "the export's pages/index.json: an object with a `pageDirs` array (and `layers`, when present, an array of {id, name, file})";
export function isPageIndex(x: unknown): x is PageIndex {
  return isObj(x) && Array.isArray(x.layers) && x.layers.every(isIndexRowLike);
}
isPageIndex.expected = "a page index (pages/<Page>/index.json): an object with a `layers` array of {id, name, file}";

// ---------------------------------------------------------------- verify-screen's documents
/** <Screen>.expected.json — what --expect wrote: a `frame` and the `nodes` specs (each with a nodeId). */
export function isVerifyExpectation(x: unknown): x is Expectation {
  return isObj(x) && isObj(x.frame) && Array.isArray(x.nodes) && x.nodes.every((n) => isObj(n) && typeof n.nodeId === "string")
    && optArrayOf(x.instances, anyObject) && optArrayOf(x.interactions, anyObject) && optArrayOf(x.notComparable, anyObject);
}
isVerifyExpectation.expected = "a verify expectation (the verify-screen script's --expect output): an object with `frame` and a `nodes` array of {nodeId, …}";

const isNameVersion = (x: unknown): boolean => isObj(x) && typeof x.version === "string" && (typeof x.package === "string" || typeof x.name === "string");
/** measured.probe — the shipped probe's identity (verify-probe.ts). */
export function isProbeIdentity(x: unknown): x is ProbeIdentity {
  return isObj(x) && typeof x.name === "string" && (x.version === null || typeof x.version === "string") && typeof x.sha256 === "string"
    && isNameVersion(x.playwright) && isNameVersion(x.browser);
}
/** measured.build — what the probe was served. */
export function isBuildIdentity(x: unknown): x is BuildIdentity {
  return isObj(x) && typeof x.url === "string" && (x.mode === "vite-dev" || x.mode === "static" || x.mode === "unknown") && typeof x.assets === "number"
    && typeof x.assetsSha256 === "string" && (x.unhashed === undefined || typeof x.unhashed === "number") && (x.gitHead === null || typeof x.gitHead === "string") && (x.gitDirty === null || typeof x.gitDirty === "boolean");
}
const isProbeFrame = (x: unknown): x is ProbeFrame => isObj(x) && typeof x.nodeId === "string" && typeof x.selector === "string" && typeof x.via === "string" && isObj(x.rect);
const isCountMap = (x: unknown): boolean => isObj(x) && Object.values(x).every((v) => typeof v === "number");
const isNavigation = (x: unknown): boolean => isObj(x) && Array.isArray(x.events) && typeof x.afterInitialLoad === "number" && typeof x.reruns === "number";
const isTagsNotInExpectation = (x: unknown): boolean => isObj(x) && typeof x.count === "number" && Array.isArray(x.ids)
  && x.ids.every((r) => isObj(r) && typeof r.id === "string" && typeof r.elements === "number");
const isReasonMap = (x: unknown): boolean => isObj(x) && Object.values(x).every((v) => typeof v === "string");
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
/** measured.reach: the steps the probe replayed. */
export function isProbeReach(x: unknown): x is ProbeReach {
  return isObj(x) && Array.isArray(x.steps) && x.steps.every(isObj) && typeof x.sha256 === "string" && typeof x.source === "string" && typeof x.url === "string";
}
/** measured.page: the document's horizontal overflow at the measured viewport. */
export function isPageOverflow(x: unknown): x is PageOverflow {
  return isObj(x) && isObj(x.viewport) && isNum(x.viewport.w) && isNum(x.viewport.h) && isNum(x.scrollWidth) && isNum(x.clientWidth)
    && typeof x.overflowX === "string" && typeof x.scrollable === "boolean"
    && Array.isArray(x.offenders) && x.offenders.every((o) => isObj(o) && typeof o.path === "string" && (o.dt === null || typeof o.dt === "string") && isNum(o.right))
    && optStr(x.compatMode);
}
// measured.behaviour — lenient (it never reaches the verdict, so a reader keeps what it can show): version 1 and a
// boolean `ran`; ran:false names why; ran:true has checks[] rows {id, status, detail} — an id this reader does not know is
// kept (an older or newer probe). Everything else in the block is read field by field by verify-screen (behaviourReport).
const BEHAVIOUR_STATUSES: readonly BehaviourStatus[] = ["pass", "fail", "warn", "not-run", "unsupported"];
export const isBehaviourStatus = (x: unknown): x is BehaviourStatus => typeof x === "string" && BEHAVIOUR_STATUSES.some((s) => s === x);
export function isBehaviourCheck(x: unknown): x is BehaviourCheck {
  return isObj(x) && typeof x.id === "string" && isBehaviourStatus(x.status) && typeof x.detail === "string";
}
/** measured.behaviour: {version: 1, ran: false, why} or {version: 1, ran: true, checks: [{id, status, detail}, …], …}. */
export function isMeasuredBehaviour(x: unknown): x is MeasuredBehaviour {
  return isObj(x) && x.version === 1 && typeof x.ran === "boolean"
    && (x.ran ? Array.isArray(x.checks) && x.checks.every(isBehaviourCheck) : typeof x.why === "string");
}
// The visual diff. measured.visual is lenient like measured.behaviour (it never reaches the verdict): version 1
// and a boolean `ran`; ran:false names why; ran:true carries the two percentages and a regions list. Every other field is
// read one by one by verify-screen (visualReport), so an older/newer probe still reports what it can.
const isRect4 = (x: unknown): x is Rect4 => isObj(x) && isNum(x.x) && isNum(x.y) && isNum(x.w) && isNum(x.h);
/** measured.visual: {version: 1, ran: false, why} or {version: 1, ran: true, differingPct, shiftTolerantPct, regions: […], …}. */
export function isMeasuredVisual(x: unknown): x is MeasuredVisual {
  return isObj(x) && x.version === 1 && typeof x.ran === "boolean"
    && (x.ran ? isNum(x.differingPct) && isNum(x.shiftTolerantPct) && Array.isArray(x.regions) : typeof x.why === "string");
}
/** One measured.visual.regions[] row as report.visual copies it (a malformed row is left out, with a note). */
export function isVisualRegion(x: unknown): x is VisualRegion {
  return isObj(x) && isRect4(x.rect) && isNum(x.pixels) && isNum(x.pct) && isStringArray(x.built) && isStringArray(x.designed);
}
/** expectation.referenceImage (--expect): usable with its geometry, or unusable with why. */
export function isVerifyReferenceImage(x: unknown): x is VerifyReferenceImage | VerifyReferenceUnusable {
  if (!isObj(x)) return false;
  if (x.usable === false) return (x.path === null || typeof x.path === "string") && typeof x.why === "string";
  return x.usable === true && typeof x.path === "string" && typeof x.sha256 === "string" && isObj(x.png) && isNum(x.png.w) && isNum(x.png.h)
    && isNum(x.scale) && x.scale > 0 && isObj(x.offset) && isNum(x.offset.x) && isNum(x.offset.y) && (x.from === "index" || x.from === "export")
    && isRect4(x.crop) && optStr(x.colorProfile);
}
/** report.behaviour, as verify-build reads it: ran, the status counts, and the check rows. */
export function isReportBehaviour(x: unknown): x is ReportBehaviour {
  return isObj(x) && typeof x.ran === "boolean" && isObj(x.summary)
    && (["pass", "fail", "warn", "notRun", "unsupported"] as const).every((k) => isObj(x.summary) && isNum(x.summary[k]))
    && Array.isArray(x.checks) && x.checks.every(isBehaviourCheck) && optStr(x.why) && optStr(x.headline);
}

// The group-7 extras of a measured.json: optional, and a hand-written file may carry its own thing under
// the same name (`probe: "handmade"`, `notMeasured: {}`). readableMeasured() drops a malformed one with a
// note rather than refusing a file whose measurements are perfectly readable.
const MEASURED_EXTRAS: ReadonlyArray<readonly [key: string, ok: (x: unknown) => boolean, what: string]> = [
  ["probe", isProbeIdentity, "the shipped probe's identity {name, version, sha256, playwright:{package, version}, browser:{name, version}} — read as probe: unknown"],
  ["frame", isProbeFrame, "a probe frame {nodeId, selector, via, rect}"],
  ["frames", (x) => Array.isArray(x) && x.every(isProbeFrame), "a list of probe frames {nodeId, selector, via, rect}"],
  ["navigation", isNavigation, "a navigation log {events[], afterInitialLoad, reruns}"],
  ["matchedByCensus", isCountMap, "a {rule: count} map"],
  ["notMeasured", Array.isArray, "a list — the probe's reasons for unmatched nodes are not used"],
  // the run it belongs to and the build it was served
  ["runId", (x) => typeof x === "string" && x !== "", "a run id (string) — the measurement is tied to no verify run"],
  ["build", isBuildIdentity, "a build identity {url, mode: vite-dev|static|unknown, assets, assetsSha256, gitHead, gitDirty} — read as build: unknown"],
  // the shipped probe's foreign tags
  ["tagsNotInExpectation", isTagsNotInExpectation, "a foreign-tag list {count, ids: [{id, elements}]}"],
  // the steps replayed, the page's overflow, the behaviour/a11y block
  ["reach", isProbeReach, "the probe's steps {steps[], sha256, source, url}"],
  ["page", isPageOverflow, "a page overflow {viewport:{w,h}, scrollWidth, clientWidth, overflowX, scrollable, offenders[]} — page overflow not measured"],
  ["behaviour", isMeasuredBehaviour, "a behaviour block {version: 1, ran: true, checks: [{id, status: pass|fail|warn|not-run|unsupported, detail}], …} or {version: 1, ran: false, why} — behaviour/a11y not reported"],
  // the visual diff (informational)
  ["visual", isMeasuredVisual, "a visual block {version: 1, ran: true, differingPct, shiftTolerantPct, regions: […], …} or {version: 1, ran: false, why} — the visual diff not reported"],
];
/** What a compare cannot do without: nodes (each with a nodeId), and list-shaped components/interactions/artifacts. */
function isMeasuredCore(x: unknown): x is JsonObject {
  return isObj(x) && optArrayOf(x.nodes, (n): n is object => isObj(n) && typeof n.nodeId === "string")
    && optArrayOf(x.components, anyObject) && optArrayOf(x.interactions, anyObject) && (x.artifacts === undefined || Array.isArray(x.artifacts))
    && optStr(x.mode) && optStr(x.expectationSha256);
}
/** <Screen>.measured.json — the probe's output. Every list optional; the lists that are there must be lists,
 *  and the shipped probe's extras (probe, frame(s), navigation, matchedByCensus, notMeasured[], nodes[].unmeasured),
 *  when present, have their shapes. notMeasured[] entries stay open (bare ids, {nodeId, reason}, {nodeId, why}).
 *  A hand-written file with a malformed extra: read it through readableMeasured(). */
export function isVerifyMeasured(x: unknown): x is VerifyMeasured {
  return isMeasuredCore(x) && MEASURED_EXTRAS.every(([k, ok]) => x[k] === undefined || ok(x[k]))
    && (x.nodes === undefined || (Array.isArray(x.nodes) && x.nodes.every((n) => !isObj(n) || n.unmeasured === undefined || isReasonMap(n.unmeasured))));
}
/**
 * A measured.json as --compare reads it: null when the measurements themselves are unreadable (not an object,
 * nodes without ids, lists that are not lists); otherwise the document with every MALFORMED optional extra
 * dropped, and one note per drop — so a hand-written file with its own `probe` or `notMeasured` still compares.
 */
export function readableMeasured(x: unknown): { doc: VerifyMeasured; notes: string[]; dropped: string[] } | null {
  if (!isMeasuredCore(x)) return null;
  const copy: JsonObject = { ...x };
  const notes: string[] = [];
  const dropped: string[] = [];
  for (const [k, ok, what] of MEASURED_EXTRAS) {
    if (copy[k] !== undefined && !ok(copy[k])) { notes.push(`measured.${k} is not ${what}; ignored`); dropped.push(k); delete copy[k]; }
  }
  if (Array.isArray(copy.nodes)) {
    let dropped = 0;
    copy.nodes = copy.nodes.map((n) => {
      if (!isObj(n) || n.unmeasured === undefined || isReasonMap(n.unmeasured)) return n;
      dropped++;
      const { unmeasured: _drop, ...rest } = n;
      return rest;
    });
    if (dropped) notes.push(`${dropped} node(s) carry an \`unmeasured\` that is not a {key: reason} map; ignored (their nulls read as 'reported null')`);
  }
  return isVerifyMeasured(copy) ? { doc: copy, notes, dropped } : null;
}
isVerifyMeasured.expected = "probe measurements: an object whose `nodes` (each {nodeId, styles}), `components`, `interactions` and `artifacts`, when present, are arrays";

function isEvidence(x: unknown): x is InteractionEvidence {
  return isObj(x) && typeof x.nodeId === "string";
}
/** An --interactions file's list: {nodeId, trigger, ok, …} rows. */
export function isInteractionEvidenceList(x: unknown): x is InteractionEvidence[] {
  return Array.isArray(x) && x.every(isEvidence);
}
isInteractionEvidenceList.expected = "interaction evidence: a JSON array of {nodeId, trigger, ok, selector, selectorCount, detail}";

/** An --interactions file's components[]: {setName|nodeId, present, …} rows (merged with measured.json's). */
export function isMeasuredComponentList(x: unknown): x is MeasuredComponent[] {
  return Array.isArray(x) && x.every((c) => isObj(c) && optStr(c.setName) && optStr(c.name) && optStr(c.nodeId) && (c.present === undefined || typeof c.present === "boolean"));
}
isMeasuredComponentList.expected = "component evidence: a JSON array of {setName|nodeId, present: true|false}";

/** <Screen>.report.json (either schema): only the fields verify-build reads are checked. */
export function isVerifyReport(x: unknown): x is VerifyReport {
  return isObj(x) && optStr(x.schema) && optStr(x.verdict) && optStr(x.screen) && optStr(x.nodeId) && optStr(x.headline)
    && (x.why === undefined || isStringArray(x.why)) && (x.integrity === undefined || isStringArray(x.integrity)) && optArrayOf(x.deltas, anyObject) && optObj(x.inputs);
}
isVerifyReport.expected = "a verify report (the verify-screen script's --compare output): an object with `verdict`, `why[]`, `deltas[]`, `inputs`";

// ---------------------------------------------------------------- design/plan/<screen>.json
// A plan is written by plan-skeleton.ts and then FILLED by a model or a person, so it is the one document
// here whose shape is genuinely in doubt. parsePlan names the first field that is the wrong kind of value
// rather than answering a bare yes/no.
const PLAN_ARRAYS = ["files", "tokens", "components", "hidden", "anchorsSuggested", "deviations", "allowedLiterals", "waivers", "descopes"] as const;
const PLAN_OBJECTS = ["anchors", "verification", "counts"] as const;
const PLAN_STRINGS = ["schema", "screen", "screenName", "nodeId", "route", "file", "exportedAt", "status"] as const;
/** Why `x` is not a plan (one line, naming the field), or null when it is one. */
function planProblem(x: unknown): string | null {
  if (!isObj(x)) return "is not a plan (the file holds " + (Array.isArray(x) ? "an array" : x === null ? "null" : typeof x) + ", not an object)";
  for (const k of PLAN_ARRAYS) if (x[k] !== undefined && !Array.isArray(x[k])) return `is not a valid plan: \`${k}\` must be an array`;
  for (const k of PLAN_OBJECTS) if (x[k] !== undefined && !isObj(x[k])) return `is not a valid plan: \`${k}\` must be an object`;
  for (const k of PLAN_STRINGS) if (x[k] !== undefined && x[k] !== null && typeof x[k] !== "string") return `is not a valid plan: \`${k}\` must be a string`;
  if (x.files !== undefined && !isStringArray(x.files)) return "is not a valid plan: `files` must be an array of paths (strings)";
  for (const k of ["tokens", "components", "allowedLiterals", "deviations", "hidden", "anchorsSuggested", "waivers", "descopes"] as const) {
    const list = x[k];
    if (Array.isArray(list) && !list.every(isObj)) return `is not a valid plan: every \`${k}\` entry must be an object`;
  }
  // (a token row's figmaName is optional: older plans, and raw unbound values, have none — or null)
  if (Array.isArray(x.tokens) && !x.tokens.every((t) => isObj(t) && (t.figmaName === null || optStr(t.figmaName)))) return "is not a valid plan: a `tokens` row's `figmaName` must be a string";
  if (Array.isArray(x.components) && !x.components.every((c) => isObj(c) && typeof c.name === "string")) return "is not a valid plan: every `components` row needs its `name`";
  if (isObj(x.anchors) && !Object.values(x.anchors).every(isObj)) return "is not a valid plan: every `anchors` entry must be an object";
  if (x.auditGate !== undefined && x.auditGate !== null && !isObj(x.auditGate)) return "is not a valid plan: `auditGate` must be an object or null";
  if (x.target !== undefined && x.target !== null && typeof x.target !== "string" && !isObj(x.target)) return "is not a valid plan: `target` must be a profile name, an object or null";
  if (x.tagging !== undefined && x.tagging !== null && !(isObj(x.tagging) && (x.tagging.off === undefined || typeof x.tagging.off === "boolean") && optStr(x.tagging.reason))) return "is not a valid plan: `tagging` must be {\"off\": true, \"reason\": \"…\"}";
  if (Array.isArray(x.tokens) && !x.tokens.every((t) => isObj(t) && optStr(t.acknowledged))) return "is not a valid plan: a `tokens` row's `acknowledged` must be a string (the reason)";
  if (isObj(x.verification) && x.verification.hook !== undefined && !isObj(x.verification.hook)) return "is not a valid plan: `verification.hook` must be an object";
  // navigate / interactions: only the lists' kind — rows are validated where used (probe-steps.ts parseSteps; --expect drops a bad interaction row with why)
  for (const k of ["navigate", "interactions"] as const) if (x[k] !== undefined && !Array.isArray(x[k])) return `is not a valid plan: \`${k}\` must be an array`;
  return null;
}
/** A plan: every field planProblem names is the right kind of value; the rest of Plan is optional. */
export function isPlan(x: unknown): x is Plan {
  return planProblem(x) === null;
}
isPlan.expected = "a plan (started by the plan-skeleton script): an object whose files/tokens/components/deviations are arrays of objects and whose anchors/verification are objects";
/** A plan, or the reason it is not one (one line, naming the field). */
export function parsePlan(x: unknown): { plan: Plan } | { error: string } {
  return isPlan(x) ? { plan: x } : { error: planProblem(x) || "is not a plan" };
}

// plan.waivers[] / plan.descopes[] rows. The plan guard only asks for objects (a hand-edited row must
// not make the whole plan unreadable); --compare applies the rows these accept and lists the others.
const reqStr = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";
/** One plan.waivers[] row a --compare can apply: every binding field present. */
export function isPlanWaiver(x: unknown): x is PlanWaiver {
  return isObj(x) && reqStr(x.nodeId) && reqStr(x.field) && x.designed !== undefined && x.built !== undefined && reqStr(x.exportContentSha256)
    && reqStr(x.reason) && reqStr(x.decidedBy) && reqStr(x.decidedAt) && (x.tolerance === undefined || (typeof x.tolerance === "number" && x.tolerance >= 0)) && optStr(x.cause);
}
isPlanWaiver.expected = "a plan waiver {nodeId, field, designed, built, exportContentSha256, reason, decidedBy, decidedAt, tolerance?, cause?}";
/** One plan.descopes[] row a --compare can apply. */
export function isPlanDescope(x: unknown): x is PlanDescope {
  return isObj(x) && reqStr(x.nodeId) && reqStr(x.trigger) && optStr(x.destinationId) && reqStr(x.exportContentSha256) && reqStr(x.reason) && reqStr(x.decidedBy) && reqStr(x.decidedAt);
}
isPlanDescope.expected = "a plan descope {nodeId, trigger, destinationId?, exportContentSha256, reason, decidedBy, decidedAt}";

/** A JSON object whose every value is a string (an asset-hash sidecar: path -> hash). */
export function isStringRecord(x: unknown): x is Record<string, string> {
  return isObj(x) && Object.values(x).every((v) => typeof v === "string");
}
isStringRecord.expected = "an object of strings";
