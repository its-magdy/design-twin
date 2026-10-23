// GENERATED from design-to-code/ by claude-plugin/build-scripts.js — edit the source, then rebuild.


// design-to-code/resolve-screen.ts
import path9 from "node:path";

// design-to-code/export-index.ts
import fs3 from "node:fs";
import path3 from "node:path";

// bridge/src/project-layout.ts
import fs from "node:fs";
import path from "node:path";
var DESIGN_DIR = "design";
var EXPORT_SUBDIR = "export";
var EXPORT_DIR = path.join(DESIGN_DIR, EXPORT_SUBDIR);
var TARGET_FILE = path.join(DESIGN_DIR, "target.json");
var MAP_FILE = path.join(DESIGN_DIR, "codeconnect.local.json");
var PLAN_DIR = path.join(DESIGN_DIR, "plan");
var AUDIT_DIR = path.join(DESIGN_DIR, "audit");
var VERIFY_DIR = path.join(DESIGN_DIR, "verify");
var SNAPSHOT_DIR = path.join(DESIGN_DIR, ".sync");
var TAILWIND_SOURCE_NOT_NOTE = `Tailwind v4 scans every file git does not ignore, ${DESIGN_DIR}/ included, so class names quoted in ${DESIGN_DIR}/ notes, audits and plans end up in your CSS. Next to \`@import "tailwindcss";\` in your CSS entry, add \`@source not "<path from that CSS file to ${DESIGN_DIR}/>";\` (e.g. \`@source not "../${DESIGN_DIR}";\` for src/app.css) \u2014 Tailwind v4.1+`;
var VITE_WATCH_IGNORED_NOTE = `With Tailwind v4's automatic source detection, rewriting an existing text file under ${DESIGN_DIR}/ (a re-export, a verify report) makes Vite fully reload the open page. Either add \`server: { watch: { ignored: ['**/${DESIGN_DIR}/**'] } }\` in vite.config (merge it with any existing \`server.watch\` options), or the Tailwind \`@source not\` above \u2014 both stop it`;
var slashed = (p) => p.split(path.sep).join("/");
var VERIFY_GITIGNORE_NOTE = `${slashed(VERIFY_DIR)}/ is regenerated on every verify run (measurements, screenshots, reports) \u2014 consider adding \`${slashed(VERIFY_DIR)}/\` to .gitignore; decisions live in ${slashed(PLAN_DIR)}/ and are not affected`;
function listPlans(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
}

// bridge/src/json-util.ts
function isStringArray(x) {
  return Array.isArray(x) && x.every((v) => typeof v === "string");
}
function ifDefined(key, v) {
  const o = {};
  if (v !== void 0) o[key] = v;
  return o;
}

// bridge/src/pages-layout.ts
function safe(id) {
  return String(id).replace(/[^a-zA-Z0-9]/g, "_");
}
var SAFE_NODE_ID_RE = /^(?:\d+_\d+|I\d+_\d+(?:_\d+_\d+)+)$/;
function nodeIdFromSafe(safeId) {
  if (!SAFE_NODE_ID_RE.test(safeId)) return null;
  return safeId.replace(/(\d+)_(\d+)/g, "$1:$2").replace(/_/g, ";");
}
function nodeIdFromStem(stem) {
  const s = String(stem || "");
  const i = s.lastIndexOf("__");
  return i < 0 ? null : nodeIdFromSafe(s.slice(i + 2));
}
function screenStem(name, id) {
  return safe(name || "layer") + "__" + safe(id);
}
var isObjectLike = (x) => !!x && typeof x === "object";
var samePage = (l, entry) => !!entry.pageId && l.pageId === entry.pageId && (l.page ?? null) === (entry.page ?? null);
var sameFigmaFile = (l, entry) => {
  if (l.sourceFile && entry.sourceFile) {
    return l.sourceFileKey && entry.sourceFileKey ? l.sourceFileKey === entry.sourceFileKey : l.sourceFile === entry.sourceFile;
  }
  if (entry.sourceFile) return !!entry.pageId && l.pageId === entry.pageId;
  return samePage(l, entry);
};
var notSameRow = (entry) => (l) => {
  if (!isObjectLike(l)) return !!l;
  if (l.file === entry.file) return false;
  if (l.id !== entry.id) return true;
  return !sameFigmaFile(l, entry);
};
var sameScreenRow = (older, newer) => isObjectLike(older) && !notSameRow(newer)(older);

// design-to-code/types.ts
var PLAN_VERIFICATION_RECORD_SCHEMA = "designtwin/plan-verification-record@2";
function isJsonObject(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// design-to-code/doc-guards.ts
function optArrayOf(x, each) {
  return x === void 0 || Array.isArray(x) && x.every(each);
}
var optObj = (x) => x === void 0 || isJsonObject(x);
var optStr = (x) => x === void 0 || typeof x === "string";
var anyObject = (x) => isJsonObject(x);
function isVariable(x) {
  return isJsonObject(x) && typeof x.name === "string" && typeof x.type === "string" && isJsonObject(x.values) && optStr(x.collection);
}
function isVariableCollection(x) {
  return isJsonObject(x) && typeof x.name === "string" && isStringArray(x.modes);
}
function isTokensDoc(x) {
  return isJsonObject(x) && optArrayOf(x.variables, isVariable) && optArrayOf(x.collections, isVariableCollection) && optArrayOf(x._slices, anyObject) && optArrayOf(x._conflicts, anyObject) && (x.hygiene === void 0 || isStringArray(x.hygiene));
}
isTokensDoc.expected = "a token catalog: an object whose `variables` (each {name, type, values}) and `collections` (each {name, modes[]}), when present, are arrays";
function isCatalogComponent(x) {
  return isJsonObject(x) && typeof x.name === "string" && optStr(x.key) && optStr(x.id) && optObj(x.props) && optArrayOf(x.variants, anyObject);
}
function isComponentsCatalog(x) {
  return isJsonObject(x) && Array.isArray(x.components) && x.components.every(isCatalogComponent);
}
isComponentsCatalog.expected = "a component catalog: an object with a `components` array of {name, type, key?, id?, props?}";
function isComponentDetailFile(x) {
  return isJsonObject(x) && typeof x.name === "string" && optArrayOf(x.variants, anyObject) && optObj(x.node);
}
isComponentDetailFile.expected = "a component detail file: an object with a `name` and `variants[]` or `node`";
function isTextStylesDoc(x) {
  return isJsonObject(x) && Array.isArray(x.styles) && x.styles.every((s) => isJsonObject(s) && typeof s.name === "string");
}
isTextStylesDoc.expected = "a text-style sheet: an object with a `styles` array of {name, \u2026}";
function isScreenAssetsDoc(x) {
  return isJsonObject(x) && optArrayOf(x.heavy, (h) => isJsonObject(h) && typeof h.file === "string" && typeof h.bytes === "number" && (h.paths === void 0 || typeof h.paths === "number") && (h.embeddedRaster === void 0 || typeof h.embeddedRaster === "number")) && optArrayOf(x.files, (f) => isJsonObject(f) && typeof f.file === "string" && optStr(f.node));
}
isScreenAssetsDoc.expected = "a screen asset manifest: an object whose `heavy` ({file, bytes}) and `files` ({file, node?}), when present, are arrays";
function isLibrariesIndex(x) {
  return isJsonObject(x) && Array.isArray(x.libraries) && x.libraries.every((r) => isJsonObject(r) && typeof r.dir === "string" && optStr(r.libraryName) && (r.collectionKeys === void 0 || isStringArray(r.collectionKeys)));
}
isLibrariesIndex.expected = "a library index: an object with a `libraries` array of {dir, libraryName?, collectionKeys?}";
var SEVERITIES = ["blocker", "warning", "info"];
function isAuditOverridesDoc(x) {
  return isJsonObject(x) && Array.isArray(x.overrides) && x.overrides.every((o) => isJsonObject(o) && typeof o.code === "string" && typeof o.severity === "string" && SEVERITIES.includes(o.severity) && typeof o.reason === "string" && o.reason.trim() !== "" && ["nodeId", "token", "component", "collection", "mode", "category", "state", "screen", "decidedBy", "decidedAt"].every((k) => optStr(o[k])));
}
isAuditOverridesDoc.expected = "an audit overrides file: { overrides: [{ code, severity: blocker|warning|info, reason (non-empty), nodeId?, token?, component?, collection?, mode?, category?, state?, screen?, decidedBy?, decidedAt? }] }";
function isAuditReport(x) {
  return isJsonObject(x) && isJsonObject(x.summary) && Array.isArray(x.findings) && x.findings.every((f) => isJsonObject(f) && typeof f.severity === "string" && typeof f.code === "string");
}
isAuditReport.expected = "an audit report (written by the audit script's --out): an object with `summary` and a `findings` array of {severity, code, message}";
function isProposal(x) {
  return isJsonObject(x) && typeof x.name === "string";
}
function isProposalList(x) {
  return Array.isArray(x) && x.every(isProposal);
}
isProposalList.expected = "a list of component proposals: an array of {name, catalog, confirmed, \u2026}";
function isIndexRowLike(x) {
  return isJsonObject(x) && typeof x.id === "string" && typeof x.name === "string";
}
function isPagesRootIndex(x) {
  return isJsonObject(x) && Array.isArray(x.pageDirs) && x.pageDirs.every((d) => isJsonObject(d) && optStr(d.dir) && optStr(d.index)) && (x.layers === void 0 || Array.isArray(x.layers) && x.layers.every(isIndexRowLike));
}
isPagesRootIndex.expected = "the export's pages/index.json: an object with a `pageDirs` array (and `layers`, when present, an array of {id, name, file})";
function isPageIndex(x) {
  return isJsonObject(x) && Array.isArray(x.layers) && x.layers.every(isIndexRowLike);
}
isPageIndex.expected = "a page index (pages/<Page>/index.json): an object with a `layers` array of {id, name, file}";
function isVerifyExpectation(x) {
  return isJsonObject(x) && isJsonObject(x.frame) && Array.isArray(x.nodes) && x.nodes.every((n) => isJsonObject(n) && typeof n.nodeId === "string") && optArrayOf(x.instances, anyObject) && optArrayOf(x.interactions, anyObject) && optArrayOf(x.notComparable, anyObject);
}
isVerifyExpectation.expected = "a verify expectation (the verify-screen script's --expect output): an object with `frame` and a `nodes` array of {nodeId, \u2026}";
var isNameVersion = (x) => isJsonObject(x) && typeof x.version === "string" && (typeof x.package === "string" || typeof x.name === "string");
function isProbeIdentity(x) {
  return isJsonObject(x) && typeof x.name === "string" && (x.version === null || typeof x.version === "string") && typeof x.sha256 === "string" && isNameVersion(x.playwright) && isNameVersion(x.browser);
}
function isBuildIdentity(x) {
  return isJsonObject(x) && typeof x.url === "string" && (x.mode === "vite-dev" || x.mode === "static" || x.mode === "unknown") && typeof x.assets === "number" && typeof x.assetsSha256 === "string" && (x.unhashed === void 0 || typeof x.unhashed === "number") && (x.gitHead === null || typeof x.gitHead === "string") && (x.gitDirty === null || typeof x.gitDirty === "boolean");
}
var isProbeFrame = (x) => isJsonObject(x) && typeof x.nodeId === "string" && typeof x.selector === "string" && typeof x.via === "string" && isJsonObject(x.rect);
var isCountMap = (x) => isJsonObject(x) && Object.values(x).every((v) => typeof v === "number");
var isNavigation = (x) => isJsonObject(x) && Array.isArray(x.events) && typeof x.afterInitialLoad === "number" && typeof x.reruns === "number";
var isTagsNotInExpectation = (x) => isJsonObject(x) && typeof x.count === "number" && Array.isArray(x.ids) && x.ids.every((r) => isJsonObject(r) && typeof r.id === "string" && typeof r.elements === "number");
var isReasonMap = (x) => isJsonObject(x) && Object.values(x).every((v) => typeof v === "string");
var isNum = (x) => typeof x === "number" && Number.isFinite(x);
function isProbeReach(x) {
  return isJsonObject(x) && Array.isArray(x.steps) && x.steps.every(isJsonObject) && typeof x.sha256 === "string" && typeof x.source === "string" && typeof x.url === "string";
}
function isPageOverflow(x) {
  return isJsonObject(x) && isJsonObject(x.viewport) && isNum(x.viewport.w) && isNum(x.viewport.h) && isNum(x.scrollWidth) && isNum(x.clientWidth) && typeof x.overflowX === "string" && typeof x.scrollable === "boolean" && Array.isArray(x.offenders) && x.offenders.every((o) => isJsonObject(o) && typeof o.path === "string" && (o.dt === null || typeof o.dt === "string") && isNum(o.right)) && optStr(x.compatMode);
}
var BEHAVIOUR_STATUSES = ["pass", "fail", "warn", "not-run", "unsupported"];
var isBehaviourStatus = (x) => typeof x === "string" && BEHAVIOUR_STATUSES.some((s) => s === x);
function isBehaviourCheck(x) {
  return isJsonObject(x) && typeof x.id === "string" && isBehaviourStatus(x.status) && typeof x.detail === "string";
}
function isMeasuredBehaviour(x) {
  return isJsonObject(x) && x.version === 1 && typeof x.ran === "boolean" && (x.ran ? Array.isArray(x.checks) && x.checks.every(isBehaviourCheck) : typeof x.why === "string");
}
function isMeasuredVisual(x) {
  return isJsonObject(x) && x.version === 1 && typeof x.ran === "boolean" && (x.ran ? isNum(x.differingPct) && isNum(x.shiftTolerantPct) && Array.isArray(x.regions) : typeof x.why === "string");
}
var MEASURED_EXTRAS = [
  ["probe", isProbeIdentity, "the shipped probe's identity {name, version, sha256, playwright:{package, version}, browser:{name, version}} \u2014 read as probe: unknown"],
  ["frame", isProbeFrame, "a probe frame {nodeId, selector, via, rect}"],
  ["frames", (x) => Array.isArray(x) && x.every(isProbeFrame), "a list of probe frames {nodeId, selector, via, rect}"],
  ["navigation", isNavigation, "a navigation log {events[], afterInitialLoad, reruns}"],
  ["matchedByCensus", isCountMap, "a {rule: count} map"],
  ["notMeasured", Array.isArray, "a list \u2014 the probe's reasons for unmatched nodes are not used"],
  // the run it belongs to and the build it was served
  ["runId", (x) => typeof x === "string" && x !== "", "a run id (string) \u2014 the measurement is tied to no verify run"],
  ["build", isBuildIdentity, "a build identity {url, mode: vite-dev|static|unknown, assets, assetsSha256, gitHead, gitDirty} \u2014 read as build: unknown"],
  // the shipped probe's foreign tags
  ["tagsNotInExpectation", isTagsNotInExpectation, "a foreign-tag list {count, ids: [{id, elements}]}"],
  // the steps replayed, the page's overflow, the behaviour/a11y block
  ["reach", isProbeReach, "the probe's steps {steps[], sha256, source, url}"],
  ["page", isPageOverflow, "a page overflow {viewport:{w,h}, scrollWidth, clientWidth, overflowX, scrollable, offenders[]} \u2014 page overflow not measured"],
  ["behaviour", isMeasuredBehaviour, "a behaviour block {version: 1, ran: true, checks: [{id, status: pass|fail|warn|not-run|unsupported, detail}], \u2026} or {version: 1, ran: false, why} \u2014 behaviour/a11y not reported"],
  // the visual diff (informational)
  ["visual", isMeasuredVisual, "a visual block {version: 1, ran: true, differingPct, shiftTolerantPct, regions: [\u2026], \u2026} or {version: 1, ran: false, why} \u2014 the visual diff not reported"]
];
function isMeasuredCore(x) {
  return isJsonObject(x) && optArrayOf(x.nodes, (n) => isJsonObject(n) && typeof n.nodeId === "string") && optArrayOf(x.components, anyObject) && optArrayOf(x.interactions, anyObject) && (x.artifacts === void 0 || Array.isArray(x.artifacts)) && optStr(x.mode) && optStr(x.expectationSha256);
}
function isVerifyMeasured(x) {
  return isMeasuredCore(x) && MEASURED_EXTRAS.every(([k, ok]) => x[k] === void 0 || ok(x[k])) && (x.nodes === void 0 || Array.isArray(x.nodes) && x.nodes.every((n) => !isJsonObject(n) || n.unmeasured === void 0 || isReasonMap(n.unmeasured)));
}
isVerifyMeasured.expected = "probe measurements: an object whose `nodes` (each {nodeId, styles}), `components`, `interactions` and `artifacts`, when present, are arrays";
function isEvidence(x) {
  return isJsonObject(x) && typeof x.nodeId === "string";
}
function isInteractionEvidenceList(x) {
  return Array.isArray(x) && x.every(isEvidence);
}
isInteractionEvidenceList.expected = "interaction evidence: a JSON array of {nodeId, trigger, ok, selector, selectorCount, detail}";
function isMeasuredComponentList(x) {
  return Array.isArray(x) && x.every((c) => isJsonObject(c) && optStr(c.setName) && optStr(c.name) && optStr(c.nodeId) && (c.present === void 0 || typeof c.present === "boolean"));
}
isMeasuredComponentList.expected = "component evidence: a JSON array of {setName|nodeId, present: true|false}";
function isVerifyReport(x) {
  return isJsonObject(x) && optStr(x.schema) && optStr(x.verdict) && optStr(x.screen) && optStr(x.nodeId) && optStr(x.headline) && (x.why === void 0 || isStringArray(x.why)) && (x.integrity === void 0 || isStringArray(x.integrity)) && optArrayOf(x.deltas, anyObject) && optObj(x.inputs);
}
isVerifyReport.expected = "a verify report (the verify-screen script's --compare output): an object with `verdict`, `why[]`, `deltas[]`, `inputs`";
var PLAN_ARRAYS = ["files", "tokens", "components", "hidden", "anchorsSuggested", "deviations", "allowedLiterals", "waivers", "descopes"];
var PLAN_OBJECTS = ["anchors", "verification", "counts"];
var PLAN_STRINGS = ["schema", "screen", "screenName", "nodeId", "route", "file", "exportedAt", "status"];
function planProblem(x) {
  if (!isJsonObject(x)) return "is not a plan (the file holds " + (Array.isArray(x) ? "an array" : x === null ? "null" : typeof x) + ", not an object)";
  for (const k of PLAN_ARRAYS) if (x[k] !== void 0 && !Array.isArray(x[k])) return `is not a valid plan: \`${k}\` must be an array`;
  for (const k of PLAN_OBJECTS) if (x[k] !== void 0 && !isJsonObject(x[k])) return `is not a valid plan: \`${k}\` must be an object`;
  for (const k of PLAN_STRINGS) if (x[k] !== void 0 && x[k] !== null && typeof x[k] !== "string") return `is not a valid plan: \`${k}\` must be a string`;
  if (x.files !== void 0 && !isStringArray(x.files)) return "is not a valid plan: `files` must be an array of paths (strings)";
  for (const k of ["tokens", "components", "allowedLiterals", "deviations", "hidden", "anchorsSuggested", "waivers", "descopes"]) {
    const list = x[k];
    if (Array.isArray(list) && !list.every(isJsonObject)) return `is not a valid plan: every \`${k}\` entry must be an object`;
  }
  if (Array.isArray(x.tokens) && !x.tokens.every((t) => isJsonObject(t) && (t.figmaName === null || optStr(t.figmaName)))) return "is not a valid plan: a `tokens` row's `figmaName` must be a string";
  if (Array.isArray(x.components) && !x.components.every((c) => isJsonObject(c) && typeof c.name === "string")) return "is not a valid plan: every `components` row needs its `name`";
  if (isJsonObject(x.anchors) && !Object.values(x.anchors).every(isJsonObject)) return "is not a valid plan: every `anchors` entry must be an object";
  if (x.auditGate !== void 0 && x.auditGate !== null && !isJsonObject(x.auditGate)) return "is not a valid plan: `auditGate` must be an object or null";
  if (x.target !== void 0 && x.target !== null && typeof x.target !== "string" && !isJsonObject(x.target)) return "is not a valid plan: `target` must be a profile name, an object or null";
  if (x.tagging !== void 0 && x.tagging !== null && !(isJsonObject(x.tagging) && (x.tagging.off === void 0 || typeof x.tagging.off === "boolean") && optStr(x.tagging.reason))) return 'is not a valid plan: `tagging` must be {"off": true, "reason": "\u2026"}';
  if (Array.isArray(x.tokens) && !x.tokens.every((t) => isJsonObject(t) && optStr(t.acknowledged))) return "is not a valid plan: a `tokens` row's `acknowledged` must be a string (the reason)";
  if (isJsonObject(x.verification) && x.verification.hook !== void 0 && !isJsonObject(x.verification.hook)) return "is not a valid plan: `verification.hook` must be an object";
  if (isJsonObject(x.verification) && x.verification.recorded !== void 0 && !isJsonObject(x.verification.recorded)) return "is not a valid plan: `verification.recorded` must be an object";
  for (const k of ["navigate", "interactions"]) if (x[k] !== void 0 && !Array.isArray(x[k])) return `is not a valid plan: \`${k}\` must be an array`;
  return null;
}
function isPlan(x) {
  return planProblem(x) === null;
}
isPlan.expected = "a plan (started by the plan-skeleton script): an object whose files/tokens/components/deviations are arrays of objects and whose anchors/verification are objects";
function parsePlan(x) {
  return isPlan(x) ? { plan: x } : { error: planProblem(x) || "is not a plan" };
}
var recIsCount = (x) => typeof x === "number" && Number.isFinite(x);
var recIsStr = (v) => typeof v === "string";
var recNeed = (ok) => ({ need: true, ok });
var recOpt = (ok) => ({ need: false, ok });
var RECORD_COUNTS = Object.fromEntries(["high", "medium", "low", "accepted", "notMeasured", "inferred"].map((k) => [k, recNeed(recIsCount)]));
var RECORD_DELTA = { nodeId: recNeed(recIsStr), field: recNeed(recIsStr), severity: recNeed((v) => v === "high" || v === "medium"), expected: recOpt(() => true), actual: recOpt(() => true) };
var RECORD_A11Y = { tool: recNeed(recIsStr), violations: recNeed(recIsCount), warnings: recNeed(recIsCount), report: recNeed(recIsStr) };
var RECORD_FIELDS = {
  schema: recNeed((v) => v === PLAN_VERIFICATION_RECORD_SCHEMA),
  by: recNeed(recIsStr),
  at: recNeed(recIsStr),
  report: recNeed(recIsStr),
  reportSha256: recNeed(recIsStr),
  verdict: recNeed(recIsStr),
  headline: recNeed(recIsStr),
  behaviourHeadline: recOpt(recIsStr),
  counts: recNeed(isJsonObject),
  mode: recNeed((v) => v === "rendered" || v === "static-only"),
  reason: recOpt(recIsStr),
  renderer: recOpt(recIsStr),
  artifacts: recNeed(isStringArray),
  deltas: recNeed(Array.isArray),
  a11y: recOpt(isJsonObject)
};
var RECORD_KEYS = Object.keys(RECORD_FIELDS);
var reqStr = (v) => typeof v === "string" && v.trim() !== "";
function isPlanWaiver(x) {
  return isJsonObject(x) && reqStr(x.nodeId) && reqStr(x.field) && x.designed !== void 0 && x.built !== void 0 && reqStr(x.exportContentSha256) && reqStr(x.reason) && reqStr(x.decidedBy) && reqStr(x.decidedAt) && (x.tolerance === void 0 || typeof x.tolerance === "number" && x.tolerance >= 0) && optStr(x.cause);
}
isPlanWaiver.expected = "a plan waiver {nodeId, field, designed, built, exportContentSha256, reason, decidedBy, decidedAt, tolerance?, cause?}";
function isPlanDescope(x) {
  return isJsonObject(x) && reqStr(x.nodeId) && reqStr(x.trigger) && optStr(x.destinationId) && reqStr(x.exportContentSha256) && reqStr(x.reason) && reqStr(x.decidedBy) && reqStr(x.decidedAt);
}
isPlanDescope.expected = "a plan descope {nodeId, trigger, destinationId?, exportContentSha256, reason, decidedBy, decidedAt}";
function isStringRecord(x) {
  return isJsonObject(x) && Object.values(x).every((v) => typeof v === "string");
}
isStringRecord.expected = "an object of strings";

// design-to-code/read-json.ts
import fs2 from "node:fs";

// bridge/src/errmsg.ts
var errMsg = (e) => typeof e === "string" ? e : String(e && e.message || e);

// design-to-code/read-json.ts
var anyJson = (_x) => true;
function readFailure(e) {
  const code = e && typeof e === "object" && "code" in e ? e.code : void 0;
  if (code === "ENOENT") return { error: "does not exist", missing: true };
  return {
    error: code === "EISDIR" ? "is a directory, not a file" : code === "EACCES" ? "is not readable (permission denied)" : `could not be read (${String(code || e)})`
  };
}
function readJson(file, guard) {
  let buf;
  try {
    buf = fs2.readFileSync(file);
  } catch (e) {
    return readFailure(e);
  }
  if (buf.length >= 2 && (buf[0] === 255 && buf[1] === 254 || buf[0] === 254 && buf[1] === 255)) {
    return { error: "is UTF-16, not UTF-8 \u2014 re-save it as UTF-8" };
  }
  let raw = buf.toString("utf8");
  if (raw.charCodeAt(0) === 65279) raw = raw.slice(1);
  let parsed;
  try {
    const value = JSON.parse(raw);
    parsed = value;
  } catch (e) {
    return { error: `is not valid JSON \u2014 ${errMsg(e)}` };
  }
  if (!guard(parsed)) return { error: `is not ${guard.expected || "the expected kind of document"}` };
  return { doc: parsed };
}
function readJsonOrNull(file, guard) {
  const r = readJson(file, guard);
  return "doc" in r ? r.doc : null;
}

// design-to-code/verify-shared.ts
import path2 from "node:path";

// bridge/src/hex-color.ts
function formatHex(c) {
  const to = (x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, "0");
  const a = Math.round(c.a * 255);
  return "#" + to(c.r) + to(c.g) + to(c.b) + (a < 255 ? to(a) : "");
}

// design-to-code/color.ts
var HEX = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
function normHex(v) {
  if (typeof v !== "string") return null;
  const g = HEX.exec(v.trim())?.[1];
  if (g === void 0) return null;
  const h = g.toLowerCase();
  return "#" + (h.length <= 4 ? h.split("").map((c) => c + c).join("") : h);
}
function colorKey(v) {
  const h = normHex(v);
  return h === null ? null : h.length === 7 ? h + "ff" : h;
}
function parseHex(v) {
  const k = colorKey(v);
  if (k === null) return null;
  const n = (i) => parseInt(k.slice(i, i + 2), 16);
  return { r: n(1), g: n(3), b: n(5), a: n(7) / 255 };
}
var NUM = "[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:e[+-]?\\d+)?";
var PCT = `${NUM}%`;
var CH = `${NUM}%?`;
var CH_OR_NONE = `(?:${CH}|none)`;
var legacy = (ch) => `\\(\\s*(${ch})\\s*,\\s*(${ch})\\s*,\\s*(${ch})\\s*(?:,\\s*(${CH})\\s*)?\\)`;
var RGB_LEGACY = new RegExp(`^rgba?(?:${legacy(PCT)}|${legacy(NUM)})$`);
var RGB_MODERN = new RegExp(`^rgba?\\(\\s*(${CH_OR_NONE})\\s+(${CH_OR_NONE})\\s+(${CH_OR_NONE})\\s*(?:/\\s*(${CH_OR_NONE})\\s*)?\\)$`);
var OK = new RegExp(`^(oklab|oklch)\\(\\s*(${CH_OR_NONE})\\s+(${CH_OR_NONE})\\s+(${CH_OR_NONE})\\s*(?:/\\s*(${CH_OR_NONE})\\s*)?\\)$`);
var SRGB = new RegExp(`^color\\(\\s*srgb\\s+(${CH_OR_NONE})\\s+(${CH_OR_NONE})\\s+(${CH_OR_NONE})\\s*(?:/\\s*(${CH_OR_NONE})\\s*)?\\)$`);
var comp = (x, pct) => x === void 0 || x === "none" ? 0 : x.endsWith("%") ? Number(x.slice(0, -1)) / 100 * pct : Number(x);
var clamp = (n, hi) => Math.min(hi, Math.max(0, n));
var alphaOf = (x) => x === void 0 ? 1 : clamp(comp(x, 1), 1);
function parseCssColor(v) {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  if (t === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  if (t.startsWith("#")) return parseHex(t);
  const leg = RGB_LEGACY.exec(t);
  const rgb = leg ? leg[1] !== void 0 ? leg.slice(1, 5) : leg.slice(5, 9) : RGB_MODERN.exec(t)?.slice(1, 5);
  if (rgb) {
    const ch = (x) => clamp(comp(x, 255), 255);
    const c = { r: ch(rgb[0]), g: ch(rgb[1]), b: ch(rgb[2]), a: alphaOf(rgb[3]) };
    return Number.isFinite(c.r + c.g + c.b + c.a) ? c : null;
  }
  const ok = OK.exec(t);
  if (ok) {
    const L = comp(ok[2], 1);
    let a, b;
    if (ok[1] === "oklab") {
      a = comp(ok[3], 0.4);
      b = comp(ok[4], 0.4);
    } else {
      const C = comp(ok[3], 0.4), h = comp(ok[4], 1) * Math.PI / 180;
      a = C * Math.cos(h);
      b = C * Math.sin(h);
    }
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s3 = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const enc = (c2) => Math.round(255 * clamp(c2 <= 31308e-7 ? 12.92 * c2 : 1.055 * c2 ** (1 / 2.4) - 0.055, 1));
    const c = {
      r: enc(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s3),
      g: enc(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s3),
      b: enc(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s3),
      a: alphaOf(ok[5])
    };
    return Number.isFinite(c.r + c.g + c.b + c.a) ? c : null;
  }
  const srgb = SRGB.exec(t);
  if (srgb) {
    const ch = (x) => Math.round(clamp(comp(x, 1) * 255, 255));
    const c = { r: ch(srgb[1]), g: ch(srgb[2]), b: ch(srgb[3]), a: alphaOf(srgb[4]) };
    return Number.isFinite(c.r + c.g + c.b + c.a) ? c : null;
  }
  return null;
}

// design-to-code/verify-shared.ts
var TOLERANCE = {
  fontSize: 0.5,
  // a browser rounds; a different token does not
  fontWeight: 0,
  // 500 vs 600 is a different style, never a rendering artifact
  lineHeight: 2,
  // normal/unitless line-heights and font-metric rounding genuinely differ
  letterSpacing: 0.2,
  radius: 0.5,
  padding: 1,
  gap: 1,
  // 1, not 2: a 2px box error is exactly a border put on the wrong side of the box — the filter button
  // measured 111.83×38 against 110×36, which an inclusive 2px tolerance would let through.
  size: 1,
  // Frame-relative x/y. Loose enough for sub-pixel layout and a glyph's side-bearing, tight enough that
  // a column 18.94px out of place or a bar 130px below the frame cannot hide.
  position: 2,
  opacity: 0.02,
  // a stroke's own tolerance, inclusive — a lost 1px border (1 → 0) is a delta; the padding tolerance (1) would let it pass
  stroke: 0.5,
  // a fixed/fill-width TEXT's INK width (renderBox.w) against a Range's width (the layout advance box,
  // side bearings included). Empirical: hand-written textBox.w − renderBox.w was −0.63..+2.41 px (p5..p95, n=157)
  // in the field runs. Known miss: heavy italics/overhang can exceed it.
  textInk: 3
};
function normColor(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  const key = colorKey(s);
  if (key) return key;
  const c = parseCssColor(s);
  if (c === null) return s;
  if (c.a === 0) return "transparent";
  return colorKey(formatHex(c)) ?? s;
}
var WEIGHTS = {
  thin: 100,
  extralight: 200,
  ultralight: 200,
  light: 300,
  normal: 400,
  regular: 400,
  book: 400,
  medium: 500,
  semibold: 600,
  demibold: 600,
  bold: 700,
  extrabold: 800,
  ultrabold: 800,
  black: 900,
  heavy: 900
};
function normWeight(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const key = s.toLowerCase().replace(/[^a-z]/g, "");
  return WEIGHTS[key] != null ? WEIGHTS[key] : null;
}
function normFamily(v) {
  if (v == null) return null;
  return (String(v).split(",")[0] ?? "").trim().replace(/^['"]|['"]$/g, "").toLowerCase();
}
function resolveInside(base, rel, within = base) {
  const root = path2.resolve(within), file = path2.resolve(base, ...rel.split("/"));
  return file.startsWith(root + path2.sep) ? file : null;
}
var FIELDS = [
  { key: "fontFamily", tol: null, norm: normFamily, label: "font-family" },
  { key: "fontSize", tol: TOLERANCE.fontSize, label: "font-size", unit: "px", high: true },
  { key: "fontWeight", tol: TOLERANCE.fontWeight, norm: normWeight, label: "font-weight", high: true },
  { key: "lineHeight", tol: TOLERANCE.lineHeight, label: "line-height", unit: "px" },
  { key: "letterSpacing", tol: TOLERANCE.letterSpacing, label: "letter-spacing", unit: "px" },
  { key: "color", tol: null, norm: normColor, label: "color", high: true, colour: true },
  { key: "backgroundColor", tol: null, norm: normColor, label: "background", high: true, colour: true },
  { key: "fill", tol: null, norm: normColor, label: "fill (SVG paint)", high: true, colour: true },
  { key: "placeholderColor", tol: null, norm: normColor, label: "placeholder colour", high: true, colour: true, optional: true },
  { key: "borderColor", tol: null, norm: normColor, label: "border-color", colour: true },
  { key: "borderWidth", tol: TOLERANCE.stroke, label: "border-width", unit: "px" },
  { key: "borderRadius", tol: TOLERANCE.radius, label: "border-radius", unit: "px" },
  { key: "gap", tol: TOLERANCE.gap, label: "gap", unit: "px" },
  { key: "width", tol: TOLERANCE.size, label: "width", unit: "px", box: true },
  { key: "height", tol: TOLERANCE.size, label: "height", unit: "px", box: true },
  { key: "x", tol: TOLERANCE.position, label: "x (frame-relative)", unit: "px", box: true },
  { key: "y", tol: TOLERANCE.position, label: "y (frame-relative)", unit: "px", box: true },
  { key: "opacity", tol: TOLERANCE.opacity, label: "opacity" }
];
var STYLE_KEYS = [...FIELDS.map((f) => f.key), "padding", "gapVisual", "text", "tag", "textBox", "placeholderText", "display"];
var STYLE_KEY_SHAPE = {
  borderRadius: "number | [tl,tr,br,bl]",
  padding: "[t,r,b,l]",
  fill: "an SVG's paint",
  textBox: "{x,w} of a Range over the text",
  placeholderText: "el.placeholder",
  placeholderColor: "the ::placeholder colour",
  tag: "tagName, lower-case",
  display: "getComputedStyle(el).display"
};
var MEASURED_KEYS_DOC = {
  "nodes[].nodeId": "the Figma node id the measurement is FOR (from data-dt-node, or matched by text/position)",
  // GENERATED from STYLE_KEYS, so the list a probe is told to send cannot drift from the list compared (`fill` must be in it)
  "nodes[].styles": `computed values, EVERY key on every node \u2014 lengths as px numbers (a "20px" string is read as 20; %, other units and keywords are not) \u2014 (null when it cannot be read, with the reason under unmeasured): ${STYLE_KEYS.map((k) => k + (STYLE_KEY_SHAPE[k] ? ` (${STYLE_KEY_SHAPE[k]})` : "")).join(" ")}`,
  "nodes[].unmeasured": "{<styles key>: why} for every styles key reported null \u2014 a null is listed as not measured, never as checked",
  "nodes[].styles.fill": "an SVG's paint: getComputedStyle(<path|rect|circle>).fill \u2014 never background-color",
  "nodes[].styles.textBox": "{x,w} of a Range over a TEXT node's characters, frame-relative \u2014 required for every TEXT node: its x/width are never read off the element's box",
  "nodes[].styles.display": "getComputedStyle(el).display \u2014 a FRAME/INSTANCE id on an inline element measures its text's box, not a frame's",
  "nodes[].styles.strokeFrom / strokeAlign": "where borderWidth/borderColor were read: border, or a ring (box-shadow spread / outline) and its side (inside | outside)",
  "nodes[].styles.gapVisual": "the rendered distance between consecutive children \u2014 required for a <table> (border-spacing, not gap)",
  "nodes[].styles.placeholderText / placeholderColor": "el.placeholder / the ::placeholder colour (getComputedStyle(el,'::placeholder').color or the stylesheet rule)",
  "nodes[].styles.tag": "the element's tagName, lower-case",
  "nodes[].styles.textTransform": "getComputedStyle(el).textTransform of a TEXT node's element (inherited) \u2014 optional; with it the build's RENDERED string is compared with the design's (spec textCase)",
  "nodes[].styles.paintedBy": "{backgroundColor, via: ancestor|child, tag, depth} \u2014 optional: when the element's own background is transparent, the nearest containing ancestor (or same-box child) that paints it",
  "nodes[].states.<hover|pressed|focus>": "the same styles, measured with the OWNER in that state (the spec's drawnStateFrom, else the node itself) \u2014 required for a node whose spec has drawnState; beside styles, never inside it; a state on a node whose spec has no drawnState is not compared (listed under Inferred, not designed)",
  "inferred[]": "{nodeId?, state, built, why?} \u2014 something the build does that the design never drew (an error message, an empty list, an open state): listed under Inferred, not designed; never graded",
  "interactions[]": "{nodeId, trigger, ok: true|false|null, selector, selectorCount, detail} \u2014 `ok:true` needs the selector you drove and how many elements it matched (>=1); ok:null = not probed",
  "components[]": "{setName|nodeId, present: true|false} \u2014 present:false is an explicit claim of absence",
  "notMeasured[]": "{nodeId, why} for every spec the probe could not find \u2014 the one top-level key for it (not notFound/notFoundInDom); other unknown top-level keys are listed in the report",
  "expectationSha256": "sha256 of the .expected.json you measured against"
};

// design-to-code/export-index.ts
var PAGES = "pages";
var INDEX = "index.json";
var rootIndexFile = (exportRoot) => path3.join(exportRoot, PAGES, INDEX);
var hasExportIndex = (exportRoot) => fs3.existsSync(rootIndexFile(exportRoot));
function findExportRoot(dir) {
  const abs = path3.resolve(dir);
  for (let d = path3.dirname(abs); ; d = path3.dirname(d)) {
    if (hasExportIndex(d)) return d;
    if (path3.dirname(d) === d) break;
  }
  for (const sub of [EXPORT_SUBDIR, EXPORT_DIR]) {
    if (hasExportIndex(path3.join(abs, sub))) return path3.join(abs, sub);
  }
  return null;
}
var inside = (root, rel) => rel && !path3.isAbsolute(rel) ? resolveInside(root, rel) : null;
function pageIndexFiles(root, pageDirs) {
  const files = [];
  const add = (f) => {
    if (f !== null && !files.includes(path3.resolve(f))) files.push(path3.resolve(f));
  };
  const ofDir = (dir) => dir && !/[\\/]/.test(dir) && dir !== ".." && dir !== "." ? path3.join(root, PAGES, dir, INDEX) : null;
  for (const pd of pageDirs) add(pd.index ? inside(root, pd.index) : ofDir(pd.dir));
  let dirs = [];
  try {
    dirs = fs3.readdirSync(path3.join(root, PAGES), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
  }
  for (const d of dirs) add(ofDir(d));
  return files;
}
function readExportIndex(exportRoot) {
  const root = exportRoot;
  const read = readJson(rootIndexFile(root), isPagesRootIndex);
  const rootDoc = "doc" in read ? read.doc : null;
  const rows = [];
  const byId = /* @__PURE__ */ new Map();
  const files = /* @__PURE__ */ new Set();
  const fromRoot = /* @__PURE__ */ new Set();
  const written = /* @__PURE__ */ new Map();
  const writtenAt = (row) => {
    let t = written.get(row);
    if (t === void 0) {
      const f = inside(root, row.file);
      try {
        t = f === null ? -1 : fs3.statSync(f).mtimeMs;
      } catch {
        t = -1;
      }
      written.set(row, t);
    }
    return t;
  };
  const hasFile = (row) => {
    const file = row.file;
    return typeof file === "string" && file !== "";
  };
  const take = (row, isRoot) => {
    const probe = hasFile(row) ? row : { ...row, file: "\0no file " + rows.length };
    const same = byId.get(row.id) ?? [];
    const kept = same.find((k) => sameScreenRow(probe, k)) ?? (hasFile(row) && files.has(row.file) ? rows.find((k) => k.file === row.file) : void 0);
    if (kept !== void 0) {
      if (isRoot || fromRoot.has(kept) || writtenAt(row) <= writtenAt(kept)) return;
      rows[rows.indexOf(kept)] = row;
      const bucket2 = byId.get(kept.id) ?? [];
      bucket2.splice(bucket2.indexOf(kept), 1);
      if (!bucket2.length) byId.delete(kept.id);
      if (hasFile(kept)) files.delete(kept.file);
    } else rows.push(row);
    const bucket = byId.get(row.id);
    if (bucket) bucket.push(row);
    else byId.set(row.id, [row]);
    if (hasFile(row)) files.add(row.file);
    if (isRoot) fromRoot.add(row);
  };
  for (const row of rootDoc?.layers ?? []) take(row, true);
  for (const f of pageIndexFiles(root, rootDoc?.pageDirs ?? [])) {
    for (const row of readJsonOrNull(f, isPageIndex)?.layers ?? []) take(row, false);
  }
  return {
    root,
    indexed: rootDoc !== null,
    rootProblem: "error" in read && !read.missing ? read.error : null,
    rows,
    isExported: (id) => byId.has(id),
    fileOf: (row) => inside(root, row.file)
  };
}

// bridge/src/node-id.ts
var ID = "[A-Za-z0-9%:;_-]+";
var NODE_ID_RE = new RegExp("node-id=(" + ID + ")");
function decode(s) {
  try {
    return decodeURIComponent(s);
  } catch (e) {
    return s;
  }
}
var COLON_ID_RE = /^I?\d+:\d+(?:[;:]\d+:\d+)*$/;
function isNodeId(s) {
  return COLON_ID_RE.test(s);
}
function normalizeNodeId(raw) {
  if (!raw) return void 0;
  const s = decode(String(raw).trim()).replace(/-/g, ":");
  return COLON_ID_RE.test(s) || /^\d+$/.test(s) ? s : void 0;
}
function parseNodeId(input) {
  if (!input) return void 0;
  const s = String(input).trim();
  try {
    const nid = new URL(s).searchParams.get("node-id");
    if (nid) return normalizeNodeId(nid);
  } catch (e) {
  }
  const m = s.match(NODE_ID_RE);
  if (m) return normalizeNodeId(m[1]);
  return normalizeNodeId(s);
}
function toNodeId(raw) {
  return parseNodeId(raw) || (raw == null ? "" : String(raw));
}

// design-to-code/map-util.ts
var alnumKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
function getOrInit(m, k, init) {
  const have = m.get(k);
  if (have !== void 0) return have;
  const made = init();
  m.set(k, made);
  return made;
}

// design-to-code/cli-args.ts
import path4 from "node:path";
import { fileURLToPath } from "node:url";

// bridge/src/stdio.ts
import { format, inspect } from "node:util";
function installQueuedConsole(o = {}) {
  trackWrites(process.stdout);
  trackWrites(process.stderr);
  const out = o.logTo === "stderr" ? process.stderr : process.stdout;
  const err = process.stderr;
  let indent = "";
  const write = (s, text) => {
    s.write((indent ? text.replace(/^/gm, indent) : text) + "\n");
  };
  const line = (s) => (...a) => {
    write(s, format(...a));
  };
  console.log = console.info = console.debug = line(out);
  console.warn = console.error = line(err);
  console.dir = (item, options) => {
    write(out, inspect(item, { customInspect: false, ...options }));
  };
  console.dirxml = line(out);
  console.table = (data) => {
    write(out, inspect(data));
  };
  console.write = (...data) => {
    let n = 0;
    for (const d of data) {
      const b = typeof d === "string" ? Buffer.from(d) : d instanceof ArrayBuffer ? Buffer.from(d) : Buffer.from(d.buffer, d.byteOffset, d.byteLength);
      if (b.length) {
        out.write(b);
        n += b.length;
      }
    }
    return n;
  };
  console.clear = () => {
    if (out.isTTY) out.write("\x1B[1;1H\x1B[0J");
  };
  console.trace = (...a) => {
    const e = new Error(format(...a));
    e.name = "Trace";
    Error.captureStackTrace(e, console.trace);
    write(err, e.stack ?? `Trace: ${e.message}`);
  };
  console.assert = (cond, ...a) => {
    if (!cond) write(err, a.length ? "Assertion failed: " + format(...a) : "Assertion failed");
  };
  console.group = console.groupCollapsed = (...a) => {
    if (a.length) write(out, format(...a));
    indent += "  ";
  };
  console.groupEnd = () => {
    indent = indent.slice(0, -2);
  };
  const counts = /* @__PURE__ */ new Map();
  console.count = (label = "default") => {
    const n = (counts.get(label) ?? 0) + 1;
    counts.set(label, n);
    write(out, `${label}: ${n}`);
  };
  console.countReset = (label = "default") => {
    counts.delete(label);
  };
  const timers = /* @__PURE__ */ new Map();
  const elapsed = (label) => {
    const t = timers.get(label);
    return t === void 0 ? null : `${label}: ${(performance.now() - t).toFixed(3)}ms`;
  };
  console.time = (label = "default") => {
    timers.set(label, performance.now());
  };
  console.timeLog = (label = "default", ...a) => {
    const e = elapsed(label);
    if (e === null) write(err, `Warning: No such label '${label}' for console.timeLog()`);
    else write(out, [e, ...a.map((x) => format(x))].join(" "));
  };
  console.timeEnd = (label = "default") => {
    const e = elapsed(label);
    timers.delete(label);
    write(e === null ? err : out, e ?? `Warning: No such label '${label}' for console.timeEnd()`);
  };
}
var inFlight = /* @__PURE__ */ new Map();
function trackWrites(s) {
  if (inFlight.has(s)) return;
  const st = { n: 0, idle: [] };
  inFlight.set(s, st);
  const write = s.write.bind(s);
  const settle = () => {
    if (--st.n === 0) for (const r of st.idle.splice(0)) r();
  };
  s.write = (chunk, encoding, cb) => {
    const done = typeof encoding === "function" ? encoding : cb;
    const enc = typeof encoding === "function" ? void 0 : encoding;
    if (chunk.length === 0) return write(chunk, enc, done);
    st.n++;
    let called = false;
    return write(chunk, enc, (err) => {
      if (!called) {
        called = true;
        settle();
      }
      done?.(err);
    });
  };
}
var CliExit = class extends Error {
  code;
  constructor(code) {
    super(`exit ${code}`);
    this.name = "CliExit";
    this.code = code;
  }
};
var cliDepth = 0;
function runCli(main2, o, argv = process.argv.slice(2)) {
  installQueuedConsole();
  const done = o.done ?? ((code) => {
    process.exitCode = code;
  });
  const fail = (e) => {
    if (e instanceof CliExit) return done(e.code);
    console.error(o.errorLine ? o.errorLine(e) : `${o.name}: ${e instanceof Error && e.stack || String(e)}`);
    done(o.errorCode ?? 1);
  };
  cliDepth++;
  let settled = false;
  const leave = () => {
    if (!settled) {
      settled = true;
      cliDepth--;
    }
  };
  try {
    const r = main2(argv);
    if (typeof r === "number") {
      leave();
      done(r);
    } else r.then((c) => {
      leave();
      done(c);
    }, (e) => {
      leave();
      fail(e);
    });
  } catch (e) {
    leave();
    fail(e);
  }
}

// design-to-code/proc.ts
var pause = new Int32Array(new SharedArrayBuffer(4));

// design-to-code/cli-args.ts
var SELF = fileURLToPath(import.meta.url);
var shellQuote = (p) => /["$`\\!]/.test(p) ? `'${p.replaceAll("'", `'\\''`)}'` : `"${p}"`;
var SCRIPT_RUNNER = "bun --no-install --no-env-file";
var shellArg = (a) => /^[\w@%+=:,./-]+$/.test(a) ? a : shellQuote(a);
var scriptCmd = (name) => `${SCRIPT_RUNNER} ${shellQuote(path4.join(path4.dirname(SELF), name + path4.extname(SELF)))}`;
function cliArity(tool, positionals, min, max, usage) {
  if (positionals.length < min) {
    console.error(usage);
    return false;
  }
  if (positionals.length > max) {
    console.error(`${tool}: unexpected argument ${positionals.slice(max).join(", ")}
${usage}`);
    return false;
  }
  return true;
}
var bareArgs = (argv) => argv[0] === "--" ? argv.slice(1) : argv;

// design-to-code/node-artefacts.ts
import fs8 from "node:fs";
import path8 from "node:path";

// design-to-code/verify-sets.ts
import fs7 from "node:fs";
import path7 from "node:path";

// design-to-code/verify-status.ts
import path6 from "node:path";
import fs6 from "node:fs";

// design-to-code/run-cache.ts
import fs5 from "node:fs";
import os from "node:os";
import path5 from "node:path";

// bridge/src/hash.ts
import crypto from "node:crypto";
var sha256Hex = (data) => crypto.createHash("sha256").update(data).digest("hex");

// bridge/src/file-lock.ts
import fs4 from "node:fs";
var LIVE_STALE_MS = 2 * 6e4;
var PID_NS = (() => {
  if (process.platform !== "linux") return "";
  try {
    return fs4.readlinkSync("/proc/self/ns/pid");
  } catch {
    return "";
  }
})();
var sleeper = new Int32Array(new SharedArrayBuffer(4));

// design-to-code/run-cache.ts
var CACHE_NAME = "designtwin-verify";
var RUN_CACHE_SEGMENTS = ["node_modules", ".cache", CACHE_NAME];
var shortSha = (s) => sha256Hex(s).slice(0, 16);
var isDir = (p) => {
  try {
    return fs5.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
var exists = (p) => fs5.existsSync(p);
function realpath(p) {
  if (typeof fs5.realpathSync.native === "function") {
    try {
      return fs5.realpathSync.native(p);
    } catch {
    }
  }
  return fs5.realpathSync(p);
}
function canonical(p) {
  const abs = path5.resolve(p);
  try {
    return realpath(abs);
  } catch {
    const parent = path5.dirname(abs);
    return parent === abs ? abs : path5.join(canonical(parent), path5.basename(abs));
  }
}
var hasPnp = (d) => exists(path5.join(d, ".pnp.cjs")) || exists(path5.join(d, ".pnp.js"));
function isWorkspaceRoot(d) {
  if (exists(path5.join(d, "pnpm-workspace.yaml"))) return true;
  const r = readJson(path5.join(d, "package.json"), anyJson);
  return "doc" in r && isJsonObject(r.doc) && r.doc.workspaces !== void 0;
}
function installRootOf(dir) {
  let P = null;
  for (let d = dir; ; d = path5.dirname(d)) {
    if (exists(path5.join(d, "package.json"))) {
      P = d;
      break;
    }
    if (exists(path5.join(d, ".git")) || path5.dirname(d) === d) return null;
  }
  if (isDir(path5.join(P, "node_modules"))) return P;
  let ws = null;
  for (let d = P; ; d = path5.dirname(d)) {
    if (isWorkspaceRoot(d)) {
      ws = d;
      break;
    }
    if (exists(path5.join(d, ".git")) || path5.dirname(d) === d) break;
  }
  if (ws !== null && isDir(path5.join(ws, "node_modules"))) return ws;
  if (hasPnp(P) || ws !== null && hasPnp(ws)) return null;
  return P;
}
function runCacheOf(verifyDir) {
  const v = canonical(verifyDir);
  const root = installRootOf(v);
  if (root !== null) {
    const cache = path5.join(root, ...RUN_CACHE_SEGMENTS);
    const rel = path5.relative(root, v).split(path5.sep).join("/");
    return { dir: rel === VERIFY_DIR.split(path5.sep).join("/") ? cache : path5.join(cache, "dirs", shortSha(rel)), root };
  }
  return { dir: path5.join(os.tmpdir(), CACHE_NAME, shortSha(v)), root: v };
}
function runCacheDir(verifyDir) {
  return runCacheOf(verifyDir).dir;
}

// design-to-code/verify-status.ts
var STATUS_SCHEMA = "designtwin/verify-status@2";
var STATUS_PHASES = ["queued", "starting", "renderer-found", "renderer-ready", "measuring", "measured", "driving", "done", "failed", "blocked"];
var TERMINAL_PHASES = ["done", "failed", "blocked"];
var isPhase = (x) => typeof x === "string" && STATUS_PHASES.some((p) => p === x);
var optStr2 = (x) => x === void 0 || typeof x === "string";
var isOwnRunStamp = (x) => isJsonObject(x) && typeof x.pid === "number" && typeof x.host === "string" && optStr2(x.ns) && typeof x.startedAt === "string" && typeof x.deadline === "string";
var isFailureCount = (x) => typeof x === "number" && Number.isInteger(x) && x >= 0;
var isReplacedRun = (x) => isJsonObject(x) && typeof x.runId === "string" && isPhase(x.phase) && typeof x.at === "string";
function isVerifyStatusV2(x) {
  return isJsonObject(x) && x.schema === STATUS_SCHEMA && typeof x.screen === "string" && typeof x.runId === "string" && typeof x.rev === "number" && isPhase(x.phase) && typeof x.detail === "string" && typeof x.at === "string" && (x.by === "verify-probe" || x.by === "agent" || x.by === "orchestrator") && optStr2(x.expectationSha256) && optStr2(x.measuredSha256) && optStr2(x.evidenceSha256) && (x.published === void 0 || Array.isArray(x.published) && x.published.every((p) => typeof p === "string")) && (x.ownRun === void 0 || isOwnRunStamp(x.ownRun)) && (x.probeFailures === void 0 || isFailureCount(x.probeFailures)) && (x.replaced === void 0 || isReplacedRun(x.replaced));
}
isVerifyStatusV2.expected = "a verify status @2 {schema, screen, runId, rev, phase, detail, at, by}";
var liveStatusFile = (base) => path6.join(runCacheDir(path6.dirname(base)), setFile(path6.basename(base), "status"));
function readStatusFile(file) {
  const r = readJson(file, anyJson);
  if (!("doc" in r)) return null;
  if (isVerifyStatusV2(r.doc)) return r.doc;
  if (isJsonObject(r.doc) && (r.doc.ownRun !== void 0 || r.doc.probeFailures !== void 0 || r.doc.replaced !== void 0)) {
    const { ownRun, probeFailures, replaced, ...rest } = r.doc;
    const kept = { ...rest, ...isOwnRunStamp(ownRun) ? { ownRun } : {}, ...isFailureCount(probeFailures) ? { probeFailures } : {}, ...isReplacedRun(replaced) ? { replaced } : {} };
    if (isVerifyStatusV2(kept)) return kept;
  }
  return isJsonObject(r.doc) && r.doc.schema === void 0 && typeof r.doc.phase === "string" ? "v1" : null;
}
function runCommands(base, open) {
  const vs = scriptCmd("verify-screen"), S = shellArg(path6.basename(base)), id = shellArg(open.runId), dir = shellArg(path6.resolve(path6.dirname(base)));
  return { waitIt: `${vs} --wait ${S} --run ${id} --dir ${dir}`, endIt: `${vs} --status ${S} --phase failed --run ${id} --dir ${dir}` };
}
function openRunSets(verifyDir) {
  let files;
  try {
    files = fs6.readdirSync(runCacheDir(verifyDir), { withFileTypes: true });
  } catch {
    return [];
  }
  return files.filter((e) => e.isFile() && setBaseOf(e.name, "status") !== null).map((e) => setBaseOf(e.name, "status") ?? e.name).filter((name) => {
    const st = readStatusFile(liveStatusFile(path6.join(verifyDir, name)));
    return st !== null && st !== "v1" && !TERMINAL_PHASES.includes(st.phase);
  }).sort();
}

// design-to-code/verify-sets.ts
var RESERVED_SLUGS = /* @__PURE__ */ new Set(["expected", "report", "measured", "status", "evidence", "prev", "retired", "diff", "forced-colors", "json", "md", "png", "tmp"]);
var MAX_SLUG = 32;
var VARIANT_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
var STEM_RE = /^[A-Za-z0-9_]+$/;
var isVariantSlug = (s) => s.length <= MAX_SLUG && VARIANT_RE.test(s) && !RESERVED_SLUGS.has(s);
function parseSetName(name) {
  const dot = name.indexOf(".");
  const stem = dot < 0 ? name : name.slice(0, dot);
  const variant = dot < 0 ? null : name.slice(dot + 1);
  if (!STEM_RE.test(stem)) return null;
  const nodeId = nodeIdFromStem(stem);
  if (nodeId === null) return null;
  if (variant !== null && !isVariantSlug(variant)) return null;
  return { stem, nodeId, variant };
}
function nodeIdFromSetName(name) {
  const dot = name.indexOf(".");
  return nodeIdFromStem(dot < 0 ? name : name.slice(0, dot));
}
var SET_FILE = {
  /** the expectation (verify-screen --expect) — what names the set */
  expected: ".expected.json",
  /** the expectation --expect replaced, kept beside it */
  expectedPrev: ".expected.prev.json",
  /** the report and its markdown (verify-screen --compare) */
  report: ".report.json",
  reportMd: ".report.md",
  /** what the probe (or the verifier) measured */
  measured: ".measured.json",
  /** the run's status (verify-run.ts: the live one is in the run cache, the final one published here) */
  status: ".status.json",
  /** the interactions the verifier drove (--interactions) */
  evidence: ".evidence.json",
  /** the probe's visual diff and forced-colors screenshot */
  diff: ".diff.png",
  forcedColors: ".forced-colors.png",
  /** an expectation moved aside: history, never a live set (allSets) */
  retired: ".expected.json.retired"
};
var setFile = (base, kind) => base + SET_FILE[kind];
var setBaseOf = (file, kind) => file.endsWith(SET_FILE[kind]) ? file.slice(0, -SET_FILE[kind].length) : null;
var EXPECTED_SUFFIX = SET_FILE.expected;
var TRAILING_SEP = path7.sep === "\\" ? /[\\/]+$/ : /\/+$/;
var NAMING_KINDS = ["expected", "report", "measured"];
var namedBy = (f) => {
  for (const k of NAMING_KINDS) if (f.endsWith(SET_FILE[k])) return f.slice(0, -SET_FILE[k].length);
  return null;
};
function allSets(verifyDir) {
  let files;
  try {
    files = fs7.readdirSync(verifyDir);
  } catch {
    return [];
  }
  const have = new Set(files);
  const names = /* @__PURE__ */ new Set();
  for (const f of files) {
    const named = namedBy(f);
    if (named !== null) names.add(named);
    else if (f.endsWith(SET_FILE.retired)) names.add(f.slice(0, -SET_FILE.retired.length));
  }
  return [...names].sort().map((name) => ({ name, retired: !have.has(setFile(name, "expected")) && have.has(setFile(name, "retired")) }));
}
function verifySets(verifyDir) {
  return allSets(verifyDir).filter((s) => !s.retired).map((s) => s.name);
}
function setFacts(verifyDir, name) {
  const exp = readJsonOrNull(setFile(path7.join(verifyDir, name), "expected"), isJsonObject);
  const rep = readJsonOrNull(setFile(path7.join(verifyDir, name), "report"), isJsonObject);
  return setFactsOf(exp, rep);
}
function setFactsOf(exp, rep) {
  const str = (x) => typeof x === "string" && x ? x : null;
  const e = isJsonObject(exp) ? exp : null;
  const frame = e && isJsonObject(e.frame) ? e.frame : null;
  const r = isJsonObject(rep) ? rep : null;
  return { expectedId: str(frame && frame.nodeId), expectedName: str(frame && frame.name), reportId: str(r && r.nodeId), reportScreen: str(r && r.screen) };
}
function stemHolders(verifyDir, stems, open) {
  const onDisk = new Set(verifySets(verifyDir).map((n) => parseSetName(n)?.stem));
  return stems.map((stem) => {
    const set = onDisk.has(stem) ? void 0 : open.find((n) => parseSetName(n)?.stem === stem);
    const st = set !== void 0 ? readStatusFile(liveStatusFile(path7.join(verifyDir, set))) : null;
    if (set === void 0 || st === null || st === "v1") return stem;
    return `an open run ${st.runId} under ${set} (no file of it yet; end it: ${runCommands(path7.join(verifyDir, set), st).endIt})`;
  }).join(", ");
}

// design-to-code/node-artefacts.ts
function planNode(plan, file) {
  return plan.nodeId || (file !== void 0 ? nodeIdFromStem(path8.basename(file).replace(/\.json$/i, "")) : null);
}
function setIdsOf(name, f) {
  return [...new Set([nodeIdFromSetName(name), f.expectedId, f.reportId].filter((x) => x !== null))].sort();
}
function setNodeOf(name, f) {
  const ids = setIdsOf(name, f);
  return ids.length === 1 ? ids[0] ?? null : null;
}
function readPlan(file) {
  const r = readJson(file, anyJson);
  if (!("doc" in r)) return { file, error: r.error };
  const p = parsePlan(r.doc);
  return "plan" in p ? { file, plan: p.plan } : { file, error: p.error };
}
var isPlanFile = (p) => "plan" in p;
var article = (kind) => kind === "audit report" ? "an" : "a";
var several = (kind, nodeId, holders, shown = holders.join(", ")) => ({ ok: false, why: `node ${nodeId} has ${holders.length} ${kind}s (${shown}) \u2014 one node, one ${kind}: keep one`, holders, reason: "several" });
var already = (kind, nodeId, holders, shown = holders.join(", ")) => ({ ok: false, why: `node ${nodeId} already has ${article(kind)} ${kind} (${shown}) \u2014 one node, one ${kind}`, holders, reason: "held" });
var slash = (p) => p.split(path8.sep).join("/");
function nodeArtefacts(root, dirs = {}) {
  const planDir = dirs.planDir ?? PLAN_DIR;
  const verifyDir = dirs.verifyDir ?? VERIFY_DIR;
  const auditDir = dirs.auditDir ?? AUDIT_DIR;
  const abs = (p) => path8.resolve(root, p);
  const spell = (dir, name) => path8.isAbsolute(dir) ? path8.join(dir, name) : slash(path8.join(dir, name));
  const verifyAbs = abs(verifyDir);
  const open = () => dirs.openSets ?? openRunSets(verifyAbs);
  function plans() {
    const out = [], bad = [];
    for (const f of listPlans(abs(planDir))) {
      const file = spell(planDir, f);
      const r = readPlan(abs(file));
      if (isPlanFile(r)) out.push({ file, plan: r.plan, nodeId: planNode(r.plan, f) });
      else bad.push({ file, error: r.error });
    }
    return { plans: out, bad };
  }
  const plansOf = (nodeId) => plans().plans.filter((p) => p.nodeId === nodeId);
  const setIds = (name) => setIdsOf(name, setFacts(verifyAbs, name));
  const setNode = (name) => setNodeOf(name, setFacts(verifyAbs, name));
  function setHolders(nodeId, runs) {
    const stems = /* @__PURE__ */ new Set(), conflicted = [], legacy2 = [];
    for (const name of [.../* @__PURE__ */ new Set([...verifySets(verifyAbs), ...runs])].sort()) {
      const ids = setIds(name);
      if (!ids.includes(nodeId)) continue;
      const p = parseSetName(name);
      if (p === null) {
        legacy2.push(name);
        continue;
      }
      stems.add(p.stem);
      if (ids.length > 1) conflicted.push({ name, ids });
    }
    return { stems: [...stems].sort(), conflicted, legacy: legacy2 };
  }
  function auditReports() {
    let files;
    try {
      files = fs8.readdirSync(abs(auditDir)).filter((f) => f.endsWith(".json") && !f.slice(0, -5).includes(".")).sort();
    } catch {
      return [];
    }
    return files.map((f) => {
      const doc = readJsonOrNull(path8.join(abs(auditDir), f), isJsonObject);
      const ids = doc && Array.isArray(doc.nodeIds) ? doc.nodeIds.filter((x) => typeof x === "string") : [];
      return { f, stem: f.slice(0, -5), nodeIds: ids.length ? ids : null };
    });
  }
  const auditNodeIs = (r, nodeId) => r.nodeIds ? r.nodeIds.includes(nodeId) : nodeIdFromStem(r.stem) === nodeId;
  const auditNamesNode = (r) => r.nodeIds !== null || nodeIdFromStem(r.stem) !== null;
  const auditsOf = (nodeId) => auditReports().filter((r) => auditNodeIs(r, nodeId)).map((r) => spell(auditDir, r.f));
  function auditFor(nodeId, hints = {}) {
    if (!fs8.existsSync(abs(auditDir))) return null;
    if (hints.screenFile) {
      const own = path8.basename(hints.screenFile, ".json") + ".json";
      if (fs8.existsSync(path8.join(abs(auditDir), own))) return spell(auditDir, own);
    }
    if (nodeId) {
      const held = auditsOf(nodeId)[0];
      if (held !== void 0) return held;
    }
    const want = alnumKey(hints.screenName);
    if (!want) return null;
    const pool = auditReports().filter((r) => !nodeId || !auditNamesNode(r));
    const nameOf = (s) => {
      const i = s.lastIndexOf("__");
      return i > 0 ? s.slice(0, i) : null;
    };
    const hit = pool.find((r) => alnumKey(r.stem) === want) ?? pool.find((r) => {
      const n = nameOf(r.stem);
      return n !== null && alnumKey(n) === want;
    });
    return hit ? spell(auditDir, hit.f) : null;
  }
  function claimSet(nodeId, o) {
    const runs = open();
    const { stems, conflicted, legacy: legacy2 } = setHolders(nodeId, runs);
    const shown = (names) => stemHolders(verifyAbs, names, runs);
    const mixed = conflicted[0];
    if (mixed !== void 0) {
      return {
        ok: false,
        why: `node ${nodeId}'s verify set ${mixed.name} also carries node ${mixed.ids.filter((x) => x !== nodeId).join(", ")} (its name, expectation and report disagree) \u2014 one node, one verify set: keep one node's files`,
        holders: conflicted.map((c) => c.name),
        reason: "held"
      };
    }
    if (o.target !== void 0) {
      const others = stems.filter((s) => s !== o.target);
      if (others.length) return already("verify set", nodeId, others, shown(others));
      return { ok: true, name: o.target, existing: stems.includes(o.target), legacy: legacy2 };
    }
    if (stems.length > 1) return several("verify set", nodeId, stems, shown(stems));
    const have = stems[0];
    return { ok: true, name: have ?? screenStem(o.layerName ?? "", nodeId), existing: have !== void 0, legacy: legacy2 };
  }
  function claimPlan(nodeId, o) {
    const held = plansOf(nodeId).map((p) => p.file);
    if (held.length > 1) return several("plan", nodeId, held);
    const target = o.target !== void 0 ? abs(o.target) : void 0;
    const have = held[0];
    if (have !== void 0) return target === void 0 || abs(have) === target ? { ok: true, name: have, existing: true, legacy: [] } : already("plan", nodeId, held);
    const s = claimSet(nodeId, { layerName: o.layerName });
    if (!s.ok) return s;
    const name = spell(planDir, s.name + ".json");
    if (target !== void 0 && path8.basename(target) !== path8.basename(name)) return { ok: false, why: `a new plan of node ${nodeId} is named by its node: ${name}, not ${path8.basename(target)}`, holders: [], reason: "misnamed" };
    return { ok: true, name, existing: false, legacy: [] };
  }
  function claimAudit(nodeId, target) {
    const t = abs(target);
    const own = path8.basename(t, ".json");
    const held = auditsOf(nodeId).filter((f) => abs(f) !== t && !own.startsWith(path8.basename(f, ".json") + "."));
    return held.length ? already("audit report", nodeId, held) : { ok: true, name: target, existing: false, legacy: [] };
  }
  function claim(kind, nodeId, o = {}) {
    if (kind === "plan") return claimPlan(nodeId, o);
    if (kind === "verify set") return claimSet(nodeId, o);
    if (o.target === void 0) throw new Error("claim('audit report') takes the target it is about to write");
    return claimAudit(nodeId, o.target);
  }
  return {
    root,
    planDir,
    verifyDir,
    auditDir,
    plans,
    plansOf,
    idlessPlans: () => plans().plans.filter((p) => p.nodeId === null).map((p) => p.file),
    setIds,
    setNode,
    setsOf: (nodeId) => {
      const h = setHolders(nodeId, open());
      return { stems: h.stems, legacy: h.legacy };
    },
    auditsOf,
    auditFor,
    claim
  };
}

// design-to-code/resolve-screen.ts
var STEM_TAIL_RE = /(?:\.[A-Za-z0-9-]+)*$/;
function queryIds(q) {
  const out = [];
  const base = q.split(/[\\/]/).pop() ?? q;
  const carried = nodeIdFromStem(base.replace(STEM_TAIL_RE, ""));
  if (carried) out.push(carried);
  const t = toNodeId(q);
  if (t !== q && isNodeId(t)) out.push(t);
  return out;
}
function planRows(planDir) {
  if (!planDir) return [];
  return nodeArtefacts(process.cwd(), { planDir }).plans().plans.flatMap(({ file, plan, nodeId }) => plan.screenName || nodeId ? [{ file: path9.basename(file), ...ifDefined("screenName", plan.screenName), ...ifDefined("nodeId", nodeId), ...ifDefined("route", plan.route) }] : []);
}
function describe(row, matchedVia) {
  const out = {
    name: row.name,
    id: row.id,
    title: row.title || null,
    ...ifDefined("w", row.w),
    ...ifDefined("h", row.h),
    ...ifDefined("nodes", row.nodes),
    reference: row.reference || null,
    screenshot: row.id ? `dtwin screenshot ${row.id}` : null
  };
  if (matchedVia && matchedVia.length) out.matchedVia = matchedVia;
  return out;
}
var fold = (s) => String(s || "").trim().toLowerCase();
var FOLD_STAGE = "whitespace-insensitive match (layer name / title / plan header)";
var foldCompact = (s) => String(s || "").replace(/[\s_-]+/g, "").toLowerCase();
var FILE_TAIL_RE = /(?:\.(?:measured|expected|vars))?\.json$|\.png$/i;
var PATH_DIR_RE = /^design[\\/]|[\\/](?:plan|verify|export)[\\/]/i;
function compactKeys(q) {
  const keys = [];
  const asPath = FILE_TAIL_RE.test(q) || PATH_DIR_RE.test(q);
  for (const cand of asPath ? [q, q.split(/[\\/]/).pop() ?? q] : [q]) {
    const k = foldCompact(cand.trim().replace(FILE_TAIL_RE, ""));
    if (k && !keys.includes(k)) keys.push(k);
  }
  return keys;
}
function resolveScreen(exportDir, query, opts) {
  const options = opts || {};
  const rows = readExportIndex(exportDir).rows;
  const q = String(query || "").trim();
  const qFold = fold(q);
  const noTitles = rows.length > 0 && !rows.some((r) => r.title);
  if (!hasExportIndex(exportDir)) {
    return { status: "not-found", candidates: [], noIndex: { dir: exportDir, hint: findExportRoot(exportDir) } };
  }
  const byId = (id) => {
    const idMatches = rows.filter((r) => r.id === id);
    return idMatches.length === 1 ? idMatches[0] : void 0;
  };
  const typed = isNodeId(q) ? byId(q) : void 0;
  if (typed) return { status: "resolved", row: typed, stage: "node id", kind: "node id" };
  const plans = planRows(options.planDir);
  const planHit = qFold ? plans.filter((p) => fold(p.screenName) === qFold || fold(p.route) === qFold) : [];
  const planIds = new Set(planHit.map((p) => p.nodeId).filter((id) => !!id));
  const union = /* @__PURE__ */ new Map();
  const join = (row, via) => {
    const key = row.id || row.file || JSON.stringify(row);
    getOrInit(union, key, () => ({ row, via: /* @__PURE__ */ new Set() })).via.add(via);
  };
  for (const r of rows) {
    if (fold(r.name) === qFold) join(r, "exact layer name");
    if (r.title && fold(r.title) === qFold) join(r, "indexed title");
    if (planIds.has(r.id)) join(r, "plan screenName/route");
  }
  const unionRows = [...union.values()];
  const only = unionRows.length === 1 ? unionRows[0] : void 0;
  if (only) {
    return { status: "resolved", row: only.row, stage: [...only.via].join(" + "), kind: "exact" };
  }
  if (unionRows.length > 1) {
    return {
      status: "ambiguous",
      stage: "exact match (layer name / title / plan header)",
      candidates: unionRows.map((u) => describe(u.row, [...u.via]))
    };
  }
  for (const id of isNodeId(q) ? [] : queryIds(q)) {
    const hit = byId(id);
    if (hit) return { status: "resolved", row: hit, stage: "node id", kind: "carried id" };
  }
  let folded = [];
  for (const qCompact of compactKeys(q)) {
    const planCompactIds = new Set(
      plans.filter((p) => foldCompact(p.screenName) === qCompact || foldCompact(p.route) === qCompact).map((p) => p.nodeId).filter((id) => !!id)
    );
    const compact = /* @__PURE__ */ new Map();
    const joinCompact = (row, via) => {
      const key = row.id || row.file || JSON.stringify(row);
      getOrInit(compact, key, () => ({ row, via: /* @__PURE__ */ new Set() })).via.add(via);
    };
    for (const r of rows) {
      if (foldCompact(r.name) === qCompact) joinCompact(r, "layer name ignoring spaces");
      if (r.title && foldCompact(r.title) === qCompact) joinCompact(r, "indexed title ignoring spaces");
      if (planCompactIds.has(r.id)) joinCompact(r, "plan screenName/route ignoring spaces");
    }
    const compactRows = [...compact.values()];
    if (compactRows.length) {
      folded = compactRows.map((u) => describe(u.row, [...u.via]));
      break;
    }
  }
  const textMatches = rows.filter(
    (r) => r.name && fold(r.name).includes(qFold) || r.title && fold(r.title).includes(qFold) || Array.isArray(r.texts) && r.texts.some((t) => fold(t).includes(qFold))
  );
  if (folded.length || textMatches.length) {
    const foldedIds = new Set(folded.map((c) => c.id));
    const candidates = [...folded, ...textMatches.filter((r) => !foldedIds.has(r.id)).map((r) => describe(r))];
    return Object.assign(
      { status: "needs-confirmation", stage: folded.length ? FOLD_STAGE : "text search", candidates },
      noTitles ? { noTitles: true } : null
    );
  }
  return Object.assign({ status: "not-found", candidates: rows.map((r) => describe(r)) }, noTitles ? { noTitles: true } : null);
}
function main(argv) {
  const usage = `usage: ${scriptCmd("resolve-screen")} <design/export dir> <name-or-id> [design/plan dir]`;
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage);
    return 0;
  }
  const positionals = bareArgs(argv);
  if (!cliArity("resolve-screen", positionals, 2, 3, usage)) return 2;
  const [exportDir, query, planDir] = positionals;
  if (!exportDir || !query) {
    console.error(usage);
    return 2;
  }
  const NOTITLES_NOTE = "note   this export's index carries no titles (pulled before title indexing) \u2014 re-pull the screen (`dtwin pull --node <id>`) to enable lookup by title";
  const listCandidates = (candidates) => {
    for (const c of candidates) console.error(`  ${c.id}  ${c.name}${c.title ? ` (title: "${c.title}")` : ""}${c.matchedVia ? ` [matched: ${c.matchedVia.join(", ")}]` : ""}  ${c.w || "?"}x${c.h || "?"}  nodes=${c.nodes ?? "?"}  ${c.reference || ""}  -> ${c.screenshot}`);
  };
  const res = resolveScreen(exportDir, query, { ...ifDefined("planDir", planDir) });
  if (res.status === "resolved") {
    console.log(`resolved '${query}' -> ${res.row.name} (${res.row.id}) via ${res.stage}`);
    const k = nodeArtefacts(process.cwd()).claim("verify set", res.row.id, { layerName: res.row.name });
    console.log(`stem ${k.ok ? k.name : screenStem(res.row.name, res.row.id)}`);
    if (!k.ok) console.error(`note   ${k.why}`);
    else if (k.legacy.length) console.error(`note   legacy-named verify set(s) of this node: ${k.legacy.join(", ")} \u2014 verify-screen --migrate renames them to ${k.name}`);
    process.stdout.write(JSON.stringify(res.row, null, 2) + "\n");
    return 0;
  }
  if (res.status === "ambiguous") {
    console.error(`error  '${query}' matches ${res.candidates.length} screens at the '${res.stage}' stage \u2014 pick one by node id:`);
    listCandidates(res.candidates);
    return 1;
  }
  if (res.status === "needs-confirmation") {
    console.error(res.stage === "text search" ? `error  '${query}' matched only by text search \u2014 confirm with the node id (never resolved automatically from a substring hit):` : `error  '${query}' matched only ignoring spaces/-/_ \u2014 confirm with the node id (never resolved automatically from a near-match):`);
    listCandidates(res.candidates);
    if (res.noTitles) console.error(NOTITLES_NOTE);
    return 1;
  }
  if (res.noIndex) {
    console.error(`error  '${exportDir}' is not an export root (no pages/index.json) \u2014 ${res.noIndex.hint ? `pass ${res.noIndex.hint}` : "pass the dir that holds pages/ (design/export)"}`);
    return 1;
  }
  console.error(`error  '${query}' matches no screen. Known layers:`);
  listCandidates(res.candidates);
  if (res.noTitles) console.error(NOTITLES_NOTE);
  return 1;
}
if (import.meta.main) runCli(main, { name: "resolve-screen" });
export {
  describe,
  main,
  planRows,
  resolveScreen
};
