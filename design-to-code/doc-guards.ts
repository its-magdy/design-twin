// doc-guards.ts — one runtime guard per JSON document kind the design-to-code layer reads off disk.
//
// Every tool used to parse a file and assert its type (`JSON.parse(…) as TokensDoc`), trusting that the
// file was this repo's own output. It usually is — but a hand-edited plan, a truncated write, the wrong
// file passed on the command line, or an older export all reach the same code, which then died with a
// TypeError and a stack deep inside a walker, or (worse) quietly read nothing. Each guard here checks the
// TOP-LEVEL fields its readers actually use (the arrays they iterate, the objects they index), plus the
// identifying fields of the entries in those arrays, and nothing more: a guard is a boundary check, not a
// schema validator. Maps have their own full validator (map-validate.ts validateMap).
//
// Each guard carries an `expected` string: what read-json.ts prints when a file fails it.
import { isJsonObject } from "./types.ts";
import type { JsonObject } from "./types.ts";
import { isStringArray } from "../bridge/src/json-util.ts";
import type {
  AuditOverridesDoc, AuditReport, CatalogComponent, ComponentDetailFile, ComponentProposal, ComponentsCatalog, InteractionEvidence, MeasuredComponent, PageIndex, PagesRootIndex, Plan,
  PlanDescope, PlanWaiver, ProbeFrame, ProbeIdentity, ScreenAssetsDoc, TextStylesDoc, TokensDoc, Variable, VariableCollection, VerifyMeasured, VerifyReport,
} from "./types.ts";
import type { Expectation } from "./verify-screen.ts";

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
    && optArrayOf(x.heavy, (h): h is { file: string; bytes: number } => isObj(h) && typeof h.file === "string" && typeof h.bytes === "number")
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

// ---------------------------------------------------------------- design/audit/<screen>.overrides.json (DT-21)
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
const isProbeFrame = (x: unknown): x is ProbeFrame => isObj(x) && typeof x.nodeId === "string" && typeof x.selector === "string" && typeof x.via === "string" && isObj(x.rect);
const isCountMap = (x: unknown): boolean => isObj(x) && Object.values(x).every((v) => typeof v === "number");
const isNavigation = (x: unknown): boolean => isObj(x) && Array.isArray(x.events) && typeof x.afterInitialLoad === "number" && typeof x.reruns === "number";
const isReasonMap = (x: unknown): boolean => isObj(x) && Object.values(x).every((v) => typeof v === "string");
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
export function readableMeasured(x: unknown): { doc: VerifyMeasured; notes: string[] } | null {
  if (!isMeasuredCore(x)) return null;
  const copy: JsonObject = { ...x };
  const notes: string[] = [];
  for (const [k, ok, what] of MEASURED_EXTRAS) {
    if (copy[k] !== undefined && !ok(copy[k])) { notes.push(`measured.${k} is not ${what}; ignored`); delete copy[k]; }
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
  return isVerifyMeasured(copy) ? { doc: copy, notes } : null;
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
    && (x.why === undefined || isStringArray(x.why)) && optArrayOf(x.deltas, anyObject) && optObj(x.inputs);
}
isVerifyReport.expected = "a verify report (the verify-screen script's --compare output): an object with `verdict`, `why[]`, `deltas[]`, `inputs`";

// ---------------------------------------------------------------- design/plan/<screen>.json
// A plan is written by plan-skeleton.js and then FILLED by a model or a person, so it is the one document
// here whose shape is genuinely in doubt. parsePlan names the first field that is the wrong kind of value
// rather than answering a bare yes/no.
const PLAN_ARRAYS = ["files", "tokens", "components", "hidden", "deviations", "allowedLiterals", "waivers", "descopes"] as const;
const PLAN_OBJECTS = ["anchors", "verification", "counts"] as const;
const PLAN_STRINGS = ["schema", "screen", "screenName", "nodeId", "route", "file", "exportedAt", "status"] as const;
/** Why `x` is not a plan (one line, naming the field), or null when it is one. */
function planProblem(x: unknown): string | null {
  if (!isObj(x)) return "is not a plan (the file holds " + (Array.isArray(x) ? "an array" : x === null ? "null" : typeof x) + ", not an object)";
  for (const k of PLAN_ARRAYS) if (x[k] !== undefined && !Array.isArray(x[k])) return `is not a valid plan: \`${k}\` must be an array`;
  for (const k of PLAN_OBJECTS) if (x[k] !== undefined && !isObj(x[k])) return `is not a valid plan: \`${k}\` must be an object`;
  for (const k of PLAN_STRINGS) if (x[k] !== undefined && x[k] !== null && typeof x[k] !== "string") return `is not a valid plan: \`${k}\` must be a string`;
  if (x.files !== undefined && !isStringArray(x.files)) return "is not a valid plan: `files` must be an array of paths (strings)";
  for (const k of ["tokens", "components", "allowedLiterals", "deviations", "hidden", "waivers", "descopes"] as const) {
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

// plan.waivers[] / plan.descopes[] rows (D5/D20). The plan guard only asks for objects (a hand-edited row must
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
