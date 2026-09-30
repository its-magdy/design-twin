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
import { isStringArray } from "../bridge/src/json-util.ts";
import type {
  AuditReport, CatalogComponent, ComponentDetailFile, ComponentProposal, ComponentsCatalog, InteractionEvidence, PageIndex, PagesRootIndex, Plan,
  TextStylesDoc, TokensDoc, Variable, VariableCollection, VerifyMeasured, VerifyReport,
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

/** <Screen>.measured.json — the probe's output. Every list optional; the lists that are there must be lists. */
export function isVerifyMeasured(x: unknown): x is VerifyMeasured {
  return isObj(x) && optArrayOf(x.nodes, (n): n is object => isObj(n) && typeof n.nodeId === "string")
    && optArrayOf(x.components, anyObject) && optArrayOf(x.interactions, anyObject) && (x.artifacts === undefined || Array.isArray(x.artifacts))
    && optStr(x.mode) && optStr(x.expectationSha256);
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
const PLAN_ARRAYS = ["files", "tokens", "components", "hidden", "deviations", "allowedLiterals"] as const;
const PLAN_OBJECTS = ["anchors", "verification", "counts"] as const;
const PLAN_STRINGS = ["schema", "screen", "screenName", "nodeId", "route", "file", "exportedAt", "status"] as const;
/** Why `x` is not a plan (one line, naming the field), or null when it is one. */
function planProblem(x: unknown): string | null {
  if (!isObj(x)) return "is not a plan (the file holds " + (Array.isArray(x) ? "an array" : x === null ? "null" : typeof x) + ", not an object)";
  for (const k of PLAN_ARRAYS) if (x[k] !== undefined && !Array.isArray(x[k])) return `is not a valid plan: \`${k}\` must be an array`;
  for (const k of PLAN_OBJECTS) if (x[k] !== undefined && !isObj(x[k])) return `is not a valid plan: \`${k}\` must be an object`;
  for (const k of PLAN_STRINGS) if (x[k] !== undefined && x[k] !== null && typeof x[k] !== "string") return `is not a valid plan: \`${k}\` must be a string`;
  if (x.files !== undefined && !isStringArray(x.files)) return "is not a valid plan: `files` must be an array of paths (strings)";
  for (const k of ["tokens", "components", "allowedLiterals", "deviations", "hidden"] as const) {
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

/** A JSON object whose every value is a string (an asset-hash sidecar: path -> hash). */
export function isStringRecord(x: unknown): x is Record<string, string> {
  return isObj(x) && Object.values(x).every((v) => typeof v === "string");
}
isStringRecord.expected = "an object of strings";
