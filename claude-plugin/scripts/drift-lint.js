// GENERATED from design-to-code/ by claude-plugin/build-scripts.js — edit the source, then rebuild.


// design-to-code/kinds.ts
var TYPE_TO_KIND = { VARIANT: "enum", BOOLEAN: "boolean", TEXT: "string", INSTANCE_SWAP: "instance", SLOT: "instance" };

// bridge/src/errmsg.ts
var errMsg = (e) => typeof e === "string" ? e : String(e && e.message || e);

// bridge/src/project-layout.ts
import path from "node:path";
var DESIGN_DIR = "design";
var EXPORT_SUBDIR = "export";
var EXPORT_DIR = path.join(DESIGN_DIR, EXPORT_SUBDIR);
var TARGET_FILE = path.join(DESIGN_DIR, "target.json");
var MAP_FILE = path.join(DESIGN_DIR, "codeconnect.local.json");
var PLAN_DIR = path.join(DESIGN_DIR, "plan");
var AUDIT_DIR = path.join(DESIGN_DIR, "audit");
var VERIFY_DIR = path.join(DESIGN_DIR, "verify");
var TAILWIND_SOURCE_NOT_NOTE = `Tailwind v4 scans every file git does not ignore, ${DESIGN_DIR}/ included, so class names quoted in ${DESIGN_DIR}/ notes, audits and plans end up in your CSS. Next to \`@import "tailwindcss";\` in your CSS entry, add \`@source not "<path from that CSS file to ${DESIGN_DIR}/>";\` (e.g. \`@source not "../${DESIGN_DIR}";\` for src/app.css) \u2014 Tailwind v4.1+`;
var VITE_WATCH_IGNORED_NOTE = `With Tailwind v4's automatic source detection, rewriting an existing text file under ${DESIGN_DIR}/ (a re-export, a verify report) makes Vite fully reload the open page. Either add \`server: { watch: { ignored: ['**/${DESIGN_DIR}/**'] } }\` in vite.config (merge it with any existing \`server.watch\` options), or the Tailwind \`@source not\` above \u2014 both stop it`;
var VERIFY_GITIGNORE_NOTE = `${VERIFY_DIR}/ is regenerated on every verify run (measurements, screenshots, reports) \u2014 consider adding \`${VERIFY_DIR}/\` to .gitignore; decisions live in ${PLAN_DIR}/ and are not affected`;

// bridge/src/snapshot-meta.ts
function field(doc, key) {
  return doc && typeof doc === "object" && key in doc ? doc[key] : void 0;
}
var asText = (v) => v ? typeof v === "string" ? v : String(v) : void 0;
function snapshotAge(doc, now) {
  const exportedAt = asText(field(doc, "exportedAt"));
  if (!exportedAt) return { exportedAt: void 0, ageMs: void 0, problem: "missing" };
  const t = Date.parse(exportedAt);
  if (Number.isNaN(t)) return { exportedAt, ageMs: void 0, problem: "unparseable" };
  return { exportedAt, ageMs: (now || Date.now()) - t };
}

// design-to-code/hidden.ts
var hiddenSelf = (node) => !!(node && typeof node === "object" && "hidden" in node && node.hidden);
var isHidden = (node, ancestorHidden) => !!ancestorHidden || hiddenSelf(node);
function walkWithHidden(root, fn, opts) {
  const pathOf = opts && opts.pathOf || ((n, i) => n.name || n.type || String(i));
  (function go(node, parentHidden, path4, parent, depth) {
    if (!node || typeof node !== "object") return;
    const hidden = isHidden(node, parentHidden);
    fn(node, { hidden, parentHidden: !!parentHidden, path: path4, parent, depth });
    const kids = Array.isArray(node.children) ? node.children : [];
    for (const [i, kid] of kids.entries()) go(kid, hidden, (path4 ? path4 + " > " : "") + pathOf(kid, i), node, depth + 1);
  })(root, false, root ? pathOf(root, 0) : "", null, 0);
}

// design-to-code/types.ts
function isJsonObject(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// design-to-code/read-json.ts
import fs from "node:fs";
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
    buf = fs.readFileSync(file);
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

// design-to-code/catalog-input.ts
function isManifest(doc, payloadKey) {
  return isJsonObject(doc) && isJsonObject(doc.files) && !Array.isArray(doc[payloadKey]);
}
function assertNotManifest(doc, givenPath, payloadKey, wantFile) {
  if (isManifest(doc, payloadKey)) {
    console.error(
      `error  '${givenPath}' is the design-system MANIFEST (a pointer map), not the '${payloadKey}' catalog.
       Since the design-system split it carries only a stamp, a \`files\` map and \`counts\`.
       Pass the split file instead \u2014 e.g. ${doc.files[payloadKey === "variables" ? "tokens" : "componentsLocal"] || wantFile} (relative to the export dir that holds ${givenPath}).`
    );
    process.exit(2);
  }
}
function readJsonFile(file, what, hint) {
  return readDocFile(file, what, anyJson, hint);
}
function readDocFile(file, what, guard, hint) {
  const r = readJson(file, guard);
  if ("doc" in r) return r.doc;
  const ioFailure = r.missing || /^(is a directory|is not readable|could not be read)/.test(r.error);
  console.error(`error  ${what}: '${file}' ${r.error}${ioFailure ? "." : ""}` + (ioFailure && hint ? `
       ${hint}` : ""));
  process.exit(2);
}
function readSplitFile(file, what, guard, payloadKey, wantFile, hint) {
  const doc = readJsonFile(file, what, hint);
  assertNotManifest(doc, file, payloadKey, wantFile);
  if (guard(doc)) return doc;
  console.error(`error  ${what}: '${file}' is not ${guard.expected || "the expected kind of document"}`);
  process.exit(2);
}
var NO_DESIGN_SYSTEM_HINT = "A single-screen pull (`dtwin pull --node <id>`) exports only that screen \u2014 it does not\n       write design/design-system/. Run `dtwin pull --design-system` to create it.";

// bridge/src/json-util.ts
function nullProto() {
  return /* @__PURE__ */ Object.create(null);
}
function isStringArray(x) {
  return Array.isArray(x) && x.every((v) => typeof v === "string");
}
function ifDefined(key, v) {
  const o = {};
  if (v !== void 0) o[key] = v;
  return o;
}

// design-to-code/probe-steps.ts
function isPlanExpect(x) {
  return x === "dialog" || x === "url" || typeof x === "string" && x.startsWith("selector:") && x.length > "selector:".length;
}

// design-to-code/doc-guards.ts
function optArrayOf(x, each) {
  return x === void 0 || Array.isArray(x) && x.every(each);
}
var isObj = isJsonObject;
var optObj = (x) => x === void 0 || isObj(x);
var optStr = (x) => x === void 0 || typeof x === "string";
var anyObject = (x) => isObj(x);
function isVariable(x) {
  return isObj(x) && typeof x.name === "string" && typeof x.type === "string" && isObj(x.values) && optStr(x.collection);
}
function isVariableCollection(x) {
  return isObj(x) && typeof x.name === "string" && isStringArray(x.modes);
}
function isTokensDoc(x) {
  return isObj(x) && optArrayOf(x.variables, isVariable) && optArrayOf(x.collections, isVariableCollection) && optArrayOf(x._slices, anyObject) && optArrayOf(x._conflicts, anyObject) && (x.hygiene === void 0 || isStringArray(x.hygiene));
}
isTokensDoc.expected = "a token catalog: an object whose `variables` (each {name, type, values}) and `collections` (each {name, modes[]}), when present, are arrays";
function isCatalogComponent(x) {
  return isObj(x) && typeof x.name === "string" && optStr(x.key) && optStr(x.id) && optObj(x.props) && optArrayOf(x.variants, anyObject);
}
function isComponentsCatalog(x) {
  return isObj(x) && Array.isArray(x.components) && x.components.every(isCatalogComponent);
}
isComponentsCatalog.expected = "a component catalog: an object with a `components` array of {name, type, key?, id?, props?}";
function isComponentDetailFile(x) {
  return isObj(x) && typeof x.name === "string" && optArrayOf(x.variants, anyObject) && optObj(x.node);
}
isComponentDetailFile.expected = "a component detail file: an object with a `name` and `variants[]` or `node`";
function isTextStylesDoc(x) {
  return isObj(x) && Array.isArray(x.styles) && x.styles.every((s) => isObj(s) && typeof s.name === "string");
}
isTextStylesDoc.expected = "a text-style sheet: an object with a `styles` array of {name, \u2026}";
function isScreenAssetsDoc(x) {
  return isObj(x) && optArrayOf(x.heavy, (h) => isObj(h) && typeof h.file === "string" && typeof h.bytes === "number") && optArrayOf(x.files, (f) => isObj(f) && typeof f.file === "string" && optStr(f.node));
}
isScreenAssetsDoc.expected = "a screen asset manifest: an object whose `heavy` ({file, bytes}) and `files` ({file, node?}), when present, are arrays";
function isLibrariesIndex(x) {
  return isObj(x) && Array.isArray(x.libraries) && x.libraries.every((r) => isObj(r) && typeof r.dir === "string" && optStr(r.libraryName) && (r.collectionKeys === void 0 || isStringArray(r.collectionKeys)));
}
isLibrariesIndex.expected = "a library index: an object with a `libraries` array of {dir, libraryName?, collectionKeys?}";
var SEVERITIES = ["blocker", "warning", "info"];
function isAuditOverridesDoc(x) {
  return isObj(x) && Array.isArray(x.overrides) && x.overrides.every((o) => isObj(o) && typeof o.code === "string" && typeof o.severity === "string" && SEVERITIES.includes(o.severity) && typeof o.reason === "string" && o.reason.trim() !== "" && ["nodeId", "token", "component", "collection", "mode", "category", "state", "screen", "decidedBy", "decidedAt"].every((k) => optStr(o[k])));
}
isAuditOverridesDoc.expected = "an audit overrides file: { overrides: [{ code, severity: blocker|warning|info, reason (non-empty), nodeId?, token?, component?, collection?, mode?, category?, state?, screen?, decidedBy?, decidedAt? }] }";
function isAuditReport(x) {
  return isObj(x) && isObj(x.summary) && Array.isArray(x.findings) && x.findings.every((f) => isObj(f) && typeof f.severity === "string" && typeof f.code === "string");
}
isAuditReport.expected = "an audit report (written by the audit script's --out): an object with `summary` and a `findings` array of {severity, code, message}";
function isProposal(x) {
  return isObj(x) && typeof x.name === "string";
}
function isProposalList(x) {
  return Array.isArray(x) && x.every(isProposal);
}
isProposalList.expected = "a list of component proposals: an array of {name, catalog, confirmed, \u2026}";
function isIndexRowLike(x) {
  return isObj(x) && typeof x.id === "string" && typeof x.name === "string";
}
function isPagesRootIndex(x) {
  return isObj(x) && Array.isArray(x.pageDirs) && x.pageDirs.every((d) => isObj(d) && optStr(d.dir) && optStr(d.index)) && (x.layers === void 0 || Array.isArray(x.layers) && x.layers.every(isIndexRowLike));
}
isPagesRootIndex.expected = "the export's pages/index.json: an object with a `pageDirs` array (and `layers`, when present, an array of {id, name, file})";
function isPageIndex(x) {
  return isObj(x) && Array.isArray(x.layers) && x.layers.every(isIndexRowLike);
}
isPageIndex.expected = "a page index (pages/<Page>/index.json): an object with a `layers` array of {id, name, file}";
function isVerifyExpectation(x) {
  return isObj(x) && isObj(x.frame) && Array.isArray(x.nodes) && x.nodes.every((n) => isObj(n) && typeof n.nodeId === "string") && optArrayOf(x.instances, anyObject) && optArrayOf(x.interactions, anyObject) && optArrayOf(x.notComparable, anyObject);
}
isVerifyExpectation.expected = "a verify expectation (the verify-screen script's --expect output): an object with `frame` and a `nodes` array of {nodeId, \u2026}";
var isNameVersion = (x) => isObj(x) && typeof x.version === "string" && (typeof x.package === "string" || typeof x.name === "string");
function isProbeIdentity(x) {
  return isObj(x) && typeof x.name === "string" && (x.version === null || typeof x.version === "string") && typeof x.sha256 === "string" && isNameVersion(x.playwright) && isNameVersion(x.browser);
}
function isBuildIdentity(x) {
  return isObj(x) && typeof x.url === "string" && (x.mode === "vite-dev" || x.mode === "static" || x.mode === "unknown") && typeof x.assets === "number" && typeof x.assetsSha256 === "string" && (x.unhashed === void 0 || typeof x.unhashed === "number") && (x.gitHead === null || typeof x.gitHead === "string") && (x.gitDirty === null || typeof x.gitDirty === "boolean");
}
var isProbeFrame = (x) => isObj(x) && typeof x.nodeId === "string" && typeof x.selector === "string" && typeof x.via === "string" && isObj(x.rect);
var isCountMap = (x) => isObj(x) && Object.values(x).every((v) => typeof v === "number");
var isNavigation = (x) => isObj(x) && Array.isArray(x.events) && typeof x.afterInitialLoad === "number" && typeof x.reruns === "number";
var isTagsNotInExpectation = (x) => isObj(x) && typeof x.count === "number" && Array.isArray(x.ids) && x.ids.every((r) => isObj(r) && typeof r.id === "string" && typeof r.elements === "number");
var isReasonMap = (x) => isObj(x) && Object.values(x).every((v) => typeof v === "string");
var isNum = (x) => typeof x === "number" && Number.isFinite(x);
function isProbeReach(x) {
  return isObj(x) && Array.isArray(x.steps) && x.steps.every(isObj) && typeof x.sha256 === "string" && typeof x.source === "string" && typeof x.url === "string";
}
function isPageOverflow(x) {
  return isObj(x) && isObj(x.viewport) && isNum(x.viewport.w) && isNum(x.viewport.h) && isNum(x.scrollWidth) && isNum(x.clientWidth) && typeof x.overflowX === "string" && typeof x.scrollable === "boolean" && Array.isArray(x.offenders) && x.offenders.every((o) => isObj(o) && typeof o.path === "string" && (o.dt === null || typeof o.dt === "string") && isNum(o.right)) && optStr(x.compatMode);
}
var BEHAVIOUR_STATUSES = ["pass", "fail", "warn", "not-run", "unsupported"];
var isBehaviourStatus = (x) => typeof x === "string" && BEHAVIOUR_STATUSES.some((s) => s === x);
function isBehaviourCheck(x) {
  return isObj(x) && typeof x.id === "string" && isBehaviourStatus(x.status) && typeof x.detail === "string";
}
function isMeasuredBehaviour(x) {
  return isObj(x) && x.version === 1 && typeof x.ran === "boolean" && (x.ran ? Array.isArray(x.checks) && x.checks.every(isBehaviourCheck) : typeof x.why === "string");
}
var MEASURED_EXTRAS = [
  ["probe", isProbeIdentity, "the shipped probe's identity {name, version, sha256, playwright:{package, version}, browser:{name, version}} \u2014 read as probe: unknown"],
  ["frame", isProbeFrame, "a probe frame {nodeId, selector, via, rect}"],
  ["frames", (x) => Array.isArray(x) && x.every(isProbeFrame), "a list of probe frames {nodeId, selector, via, rect}"],
  ["navigation", isNavigation, "a navigation log {events[], afterInitialLoad, reruns}"],
  ["matchedByCensus", isCountMap, "a {rule: count} map"],
  ["notMeasured", Array.isArray, "a list \u2014 the probe's reasons for unmatched nodes are not used"],
  // group 10: the run it belongs to (F-72) and the build it was served (DT-81)
  ["runId", (x) => typeof x === "string" && x !== "", "a run id (string) \u2014 the measurement is tied to no verify run"],
  ["build", isBuildIdentity, "a build identity {url, mode: vite-dev|static|unknown, assets, assetsSha256, gitHead, gitDirty} \u2014 read as build: unknown"],
  // group 11 (DT-47): the shipped probe's foreign tags
  ["tagsNotInExpectation", isTagsNotInExpectation, "a foreign-tag list {count, ids: [{id, elements}]}"],
  // group 12a: the steps replayed (L-1), the page's overflow (D43); 12b: the behaviour/a11y block
  ["reach", isProbeReach, "the probe's steps {steps[], sha256, source, url}"],
  ["page", isPageOverflow, "a page overflow {viewport:{w,h}, scrollWidth, clientWidth, overflowX, scrollable, offenders[]} \u2014 page overflow not measured"],
  ["behaviour", isMeasuredBehaviour, "a behaviour block {version: 1, ran: true, checks: [{id, status: pass|fail|warn|not-run|unsupported, detail}], \u2026} or {version: 1, ran: false, why} \u2014 behaviour/a11y not reported"]
];
function isMeasuredCore(x) {
  return isObj(x) && optArrayOf(x.nodes, (n) => isObj(n) && typeof n.nodeId === "string") && optArrayOf(x.components, anyObject) && optArrayOf(x.interactions, anyObject) && (x.artifacts === void 0 || Array.isArray(x.artifacts)) && optStr(x.mode) && optStr(x.expectationSha256);
}
function isVerifyMeasured(x) {
  return isMeasuredCore(x) && MEASURED_EXTRAS.every(([k, ok]) => x[k] === void 0 || ok(x[k])) && (x.nodes === void 0 || Array.isArray(x.nodes) && x.nodes.every((n) => !isObj(n) || n.unmeasured === void 0 || isReasonMap(n.unmeasured)));
}
isVerifyMeasured.expected = "probe measurements: an object whose `nodes` (each {nodeId, styles}), `components`, `interactions` and `artifacts`, when present, are arrays";
function isEvidence(x) {
  return isObj(x) && typeof x.nodeId === "string";
}
function isInteractionEvidenceList(x) {
  return Array.isArray(x) && x.every(isEvidence);
}
isInteractionEvidenceList.expected = "interaction evidence: a JSON array of {nodeId, trigger, ok, selector, selectorCount, detail}";
function isMeasuredComponentList(x) {
  return Array.isArray(x) && x.every((c) => isObj(c) && optStr(c.setName) && optStr(c.name) && optStr(c.nodeId) && (c.present === void 0 || typeof c.present === "boolean"));
}
isMeasuredComponentList.expected = "component evidence: a JSON array of {setName|nodeId, present: true|false}";
function isVerifyReport(x) {
  return isObj(x) && optStr(x.schema) && optStr(x.verdict) && optStr(x.screen) && optStr(x.nodeId) && optStr(x.headline) && (x.why === void 0 || isStringArray(x.why)) && (x.integrity === void 0 || isStringArray(x.integrity)) && optArrayOf(x.deltas, anyObject) && optObj(x.inputs);
}
isVerifyReport.expected = "a verify report (the verify-screen script's --compare output): an object with `verdict`, `why[]`, `deltas[]`, `inputs`";
var PLAN_ARRAYS = ["files", "tokens", "components", "hidden", "deviations", "allowedLiterals", "waivers", "descopes"];
var PLAN_OBJECTS = ["anchors", "verification", "counts"];
var PLAN_STRINGS = ["schema", "screen", "screenName", "nodeId", "route", "file", "exportedAt", "status"];
function planProblem(x) {
  if (!isObj(x)) return "is not a plan (the file holds " + (Array.isArray(x) ? "an array" : x === null ? "null" : typeof x) + ", not an object)";
  for (const k of PLAN_ARRAYS) if (x[k] !== void 0 && !Array.isArray(x[k])) return `is not a valid plan: \`${k}\` must be an array`;
  for (const k of PLAN_OBJECTS) if (x[k] !== void 0 && !isObj(x[k])) return `is not a valid plan: \`${k}\` must be an object`;
  for (const k of PLAN_STRINGS) if (x[k] !== void 0 && x[k] !== null && typeof x[k] !== "string") return `is not a valid plan: \`${k}\` must be a string`;
  if (x.files !== void 0 && !isStringArray(x.files)) return "is not a valid plan: `files` must be an array of paths (strings)";
  for (const k of ["tokens", "components", "allowedLiterals", "deviations", "hidden", "waivers", "descopes"]) {
    const list = x[k];
    if (Array.isArray(list) && !list.every(isObj)) return `is not a valid plan: every \`${k}\` entry must be an object`;
  }
  if (Array.isArray(x.tokens) && !x.tokens.every((t) => isObj(t) && (t.figmaName === null || optStr(t.figmaName)))) return "is not a valid plan: a `tokens` row's `figmaName` must be a string";
  if (Array.isArray(x.components) && !x.components.every((c) => isObj(c) && typeof c.name === "string")) return "is not a valid plan: every `components` row needs its `name`";
  if (isObj(x.anchors) && !Object.values(x.anchors).every(isObj)) return "is not a valid plan: every `anchors` entry must be an object";
  if (x.auditGate !== void 0 && x.auditGate !== null && !isObj(x.auditGate)) return "is not a valid plan: `auditGate` must be an object or null";
  if (x.target !== void 0 && x.target !== null && typeof x.target !== "string" && !isObj(x.target)) return "is not a valid plan: `target` must be a profile name, an object or null";
  if (x.tagging !== void 0 && x.tagging !== null && !(isObj(x.tagging) && (x.tagging.off === void 0 || typeof x.tagging.off === "boolean") && optStr(x.tagging.reason))) return 'is not a valid plan: `tagging` must be {"off": true, "reason": "\u2026"}';
  if (Array.isArray(x.tokens) && !x.tokens.every((t) => isObj(t) && optStr(t.acknowledged))) return "is not a valid plan: a `tokens` row's `acknowledged` must be a string (the reason)";
  if (isObj(x.verification) && x.verification.hook !== void 0 && !isObj(x.verification.hook)) return "is not a valid plan: `verification.hook` must be an object";
  for (const k of ["navigate", "interactions"]) if (x[k] !== void 0 && !Array.isArray(x[k])) return `is not a valid plan: \`${k}\` must be an array`;
  return null;
}
function isPlan(x) {
  return planProblem(x) === null;
}
isPlan.expected = "a plan (started by the plan-skeleton script): an object whose files/tokens/components/deviations are arrays of objects and whose anchors/verification are objects";
var reqStr = (v) => typeof v === "string" && v.trim() !== "";
function isPlanWaiver(x) {
  return isObj(x) && reqStr(x.nodeId) && reqStr(x.field) && x.designed !== void 0 && x.built !== void 0 && reqStr(x.exportContentSha256) && reqStr(x.reason) && reqStr(x.decidedBy) && reqStr(x.decidedAt) && (x.tolerance === void 0 || typeof x.tolerance === "number" && x.tolerance >= 0) && optStr(x.cause);
}
isPlanWaiver.expected = "a plan waiver {nodeId, field, designed, built, exportContentSha256, reason, decidedBy, decidedAt, tolerance?, cause?}";
function isPlanDescope(x) {
  return isObj(x) && reqStr(x.nodeId) && reqStr(x.trigger) && optStr(x.destinationId) && reqStr(x.exportContentSha256) && reqStr(x.reason) && reqStr(x.decidedBy) && reqStr(x.decidedAt);
}
isPlanDescope.expected = "a plan descope {nodeId, trigger, destinationId?, exportContentSha256, reason, decidedBy, decidedAt}";
function isPlanInteraction(x) {
  return isObj(x) && reqStr(x.nodeId) && reqStr(x.trigger) && isPlanExpect(x.expect) && (x.destinationId === void 0 || reqStr(x.destinationId)) && optStr(x.name);
}
isPlanInteraction.expected = "a plan interaction {nodeId, trigger, expect: dialog | url | selector:<css>, destinationId?, name?}";
function isStringRecord(x) {
  return isObj(x) && Object.values(x).every((v) => typeof v === "string");
}
isStringRecord.expected = "an object of strings";

// design-to-code/cli-args.ts
import path2 from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
var SELF = fileURLToPath(import.meta.url);
var shellQuote = (p) => /["$`\\!]/.test(p) ? `'${p.replaceAll("'", `'\\''`)}'` : `"${p}"`;
var scriptCmd = (name) => `node ${shellQuote(path2.join(path2.dirname(SELF), name + path2.extname(SELF)))}`;
function errCode(e) {
  return e && typeof e === "object" && "code" in e && typeof e.code === "string" ? e.code : void 0;
}
function joinNegativeValues(argv, options) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i], next = argv[i + 1];
    if (tok === void 0) continue;
    if (tok === "--") {
      out.push(...argv.slice(i));
      break;
    }
    const name = tok.startsWith("--") ? tok.slice(2) : void 0;
    if (name !== void 0 && next !== void 0 && options[name]?.type === "string" && /^-\d/.test(next)) {
      out.push(`${tok}=${next}`);
      i++;
    } else out.push(tok);
  }
  return out;
}
function cliParse(tool, argv, options, usage, exitCode, parse) {
  const args = joinNegativeValues(argv, options);
  try {
    return parse(args);
  } catch (e) {
    const code = errCode(e);
    if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      const { tokens } = parseArgs({ args, options, strict: false, allowPositionals: true, tokens: true });
      const unknown = [...new Set(tokens.flatMap((t) => t.kind === "option" && !(t.name in options) ? [t.rawName] : []))];
      console.error(`${tool}: unknown flag ${unknown.join(", ")}
${usage}`);
    } else if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
      const msg = e instanceof Error ? e.message : "";
      const m = /Option '(-[\w-]+|--[\w-]+)/.exec(msg);
      console.error(`${tool}: ${m ? m[1] : "an option"} ${/does not take an argument/.test(msg) ? "takes no value" : "needs a value"}
${usage}`);
    } else {
      console.error(`${tool}: ${e instanceof Error ? e.message : String(e)}
${usage}`);
    }
    process.exit(exitCode);
  }
}

// design-to-code/drift-lint.ts
import { parseArgs as parseArgs2 } from "node:util";

// design-to-code/export-shape.ts
function isIrNode(x) {
  return isJsonObject(x) && typeof x.id === "string" && typeof x.type === "string" && (x.children === void 0 || Array.isArray(x.children));
}
function isScreenExport(x) {
  return isJsonObject(x) && Array.isArray(x.nodes) && x.nodes.every(isIrNode);
}
function isLayerFile(x) {
  return isJsonObject(x) && !Array.isArray(x.nodes) && isIrNode(x.tree);
}
function isScreenDoc(x) {
  return isScreenExport(x) || isLayerFile(x) || isIrNode(x);
}
isScreenDoc.expected = "a screen export: {nodes:[\u2026]} whose every node has a string id and type, a layer file {tree: node}, or a bare node {id, type, \u2026}";
function screenRoots(doc) {
  if (isScreenExport(doc)) return doc.nodes;
  if (isLayerFile(doc)) return [doc.tree];
  if (isIrNode(doc)) return [doc];
  return [];
}

// design-to-code/map-util.ts
function getOrInit(m, k, init) {
  const have = m.get(k);
  if (have !== void 0) return have;
  const made = init();
  m.set(k, made);
  return made;
}

// design-to-code/component-match.ts
function visibleInstances(doc, label) {
  const out = [];
  const roots = screenRoots(doc);
  const walk = (n) => {
    if (!n || typeof n !== "object" || n.hidden === true) return;
    if (n.type === "INSTANCE" && n.mainComponent) {
      const mc = n.mainComponent;
      out.push({
        screen: label,
        nodeId: n.id,
        layer: n.name,
        name: mc.setName || mc.name || n.name,
        ...ifDefined("key", mc.key),
        ...ifDefined("setKey", mc.setKey),
        remote: mc.remote === true,
        variant: parseVariant(n.component) || parseVariant(mc.variant),
        props: n.props && typeof n.props === "object" ? n.props : {}
      });
    }
    for (const c of n.children || []) walk(c);
  };
  for (const r of roots) walk(r);
  return out;
}
function parseVariant(s) {
  if (isJsonObject(s)) {
    const out2 = Object.fromEntries(Object.entries(s).filter((e) => typeof e[1] === "string"));
    return Object.keys(out2).length ? out2 : null;
  }
  if (!s || typeof s !== "string" || !s.includes("=")) return null;
  const out = {};
  for (const part of s.split(/,\s*(?=[^,=]+=)/)) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return Object.keys(out).length ? out : null;
}
var baseProp = (p) => String(p).split("#")[0] ?? "";
var SHARED_PAGE = /shared|style ?guide|foundation|core|global|design.?system|librar|banner|badge/i;
function signature(inst, cand) {
  const props = {};
  for (const [k, v] of Object.entries(cand.props || {})) props[baseProp(k)] = v;
  const reasons = [];
  let score = 40, verified = true;
  reasons.push("name matches catalog entry verbatim");
  const variant = inst.variant;
  if (variant) {
    const axes = Object.keys(variant);
    const known = axes.filter((k) => props[k] && props[k].type === "VARIANT");
    if (known.length === axes.length) {
      score += 25;
      reasons.push(`all ${axes.length} variant prop name(s) exist as VARIANT props`);
    } else {
      verified = false;
      score += known.length ? 10 : -15;
      reasons.push(known.length ? `${known.length}/${axes.length} variant prop names exist` : "variant prop names are NOT on this candidate");
    }
    const bad = Object.entries(variant).filter(([k, val]) => {
      const d = props[k];
      return d && d.type === "VARIANT" && !(d.options || []).includes(val);
    }).map(([k]) => k);
    if (known.length && !bad.length) {
      score += 25;
      reasons.push(`variant value(s) ${known.map((k) => `${k}=${variant[k]}`).join(", ")} are in the option list`);
    } else if (bad.length) {
      verified = false;
      score -= 20;
      reasons.push(`variant value(s) not in option list (${bad.map((k) => `${k}=${variant[k]}`).join(", ")})`);
    }
  } else if (cand.type === "COMPONENT") {
    score += 15;
    reasons.push("instance has no variant string and the catalog entry is a plain COMPONENT");
  } else {
    verified = false;
    reasons.push(`instance sets no variant but the catalog entry is a ${cand.type}`);
  }
  const own = Object.keys(inst.props || {}).filter((k) => !variant || !(baseProp(k) in variant));
  if (own.length) {
    const typed = own.filter((k) => {
      const d = props[baseProp(k)], v = inst.props[k];
      if (!d) return false;
      if (typeof v === "boolean") return d.type === "BOOLEAN";
      return d.type === "TEXT" || d.type === "INSTANCE_SWAP" || d.type === "VARIANT";
    });
    if (typed.length === own.length) {
      score += 15;
      reasons.push(`all ${own.length} non-variant prop name(s) exist on the definition`);
    } else {
      verified = false;
      score += typed.length ? 5 : -10;
      reasons.push(typed.length ? `${typed.length}/${own.length} non-variant prop names exist with a matching type` : "none of the instance prop names exist on this definition");
    }
  }
  if (SHARED_PAGE.test(String(cand.page || ""))) {
    score += 5;
    reasons.push(`lives on a shared page (${cand.page})`);
  }
  return { verified, score, reasons };
}
var sigOf = (c) => JSON.stringify(Object.entries(c.props || {}).map(([k, v]) => [baseProp(k), v.type, v.options || null]).sort());
function matchByNameAndSignature(instances, catalog, library) {
  const comps = catalog && catalog.components || [];
  const byName = /* @__PURE__ */ new Map();
  comps.forEach((c, i) => {
    getOrInit(byName, c.name, () => []).push(Object.assign({ _order: i }, c));
  });
  const catKeys = new Set(comps.map((c) => c.key).filter((k) => !!k));
  const libKeys = new Set((library && library.components || []).map((c) => c.key).filter((k) => !!k));
  const libNames = new Set((library && library.components || []).map((c) => c.name));
  const groups = /* @__PURE__ */ new Map();
  for (const inst of instances) {
    const group = groups.get(inst.name);
    if (group) group.push(inst);
    else groups.set(inst.name, [inst]);
  }
  const rows = [];
  for (const [name, list] of groups) {
    const byKey = list.some((i) => catKeys.has(i.key ?? "") || catKeys.has(i.setKey ?? ""));
    const row = {
      name,
      instances: list.length,
      nodeIds: list.map((i) => i.nodeId),
      screens: [...new Set(list.map((i) => i.screen).filter((s) => !!s))],
      instanceKeys: [...new Set(list.map((i) => i.setKey || i.key).filter((k) => !!k))],
      remote: list.every((i) => i.remote),
      byKey,
      match: null,
      alternatives: [],
      reasons: []
    };
    const cands = byName.get(name) || [];
    if (!cands.length) {
      const inLibrary = list.some((i) => libKeys.has(i.key ?? "") || libKeys.has(i.setKey ?? ""));
      row.reasons.push(`no catalog entry named ${JSON.stringify(name)}`);
      row.reasons.push(inLibrary ? "its key IS in components.library.json \u2014 a third-party library both files consume, not the design system's own component" : libNames.has(name) ? "the name appears in components.library.json \u2014 a third-party library the design system consumes, not one of its own components" : "not a component of the exported design system (typically an external icon library) \u2014 expected, not a miss");
      rows.push(row);
      continue;
    }
    const [firstInst, ...otherInsts] = list;
    const scored = cands.map((c) => {
      const first = signature(firstInst, c);
      const per = [first, ...otherInsts.map((i) => signature(i, c))];
      return { c, verified: per.every((p) => p.verified), score: Math.min(...per.map((p) => p.score)), reasons: first.reasons, failing: per.find((p) => !p.verified) };
    }).sort((a, b) => Number(b.verified) - Number(a.verified) || b.score - a.score || a.c._order - b.c._order);
    const best = scored[0];
    if (best === void 0) throw new Error("component-match: a non-empty candidate list scored to nothing");
    if (!best.verified) {
      row.reasons.push(`${cands.length} catalog entr${cands.length === 1 ? "y is" : "ies are"} named ${JSON.stringify(name)}, but no prop signature agrees: ` + (best.failing ? best.failing.reasons.filter((r) => /NOT|not in|none of|\d+\/\d+|sets no variant/.test(r)).join("; ") : "signature mismatch") + " \u2014 a name alone is not a match");
      rows.push(row);
      continue;
    }
    const verifiedOnes = scored.filter((s) => s.verified);
    const runnerUp = verifiedOnes[1];
    const ties = verifiedOnes.filter((s) => s.score === best.score && s !== best);
    row.match = { ...ifDefined("id", best.c.id), ...ifDefined("key", best.c.key), name: best.c.name, type: best.c.type, ...ifDefined("page", best.c.page) };
    row.evidence = list.some((i) => i.variant || Object.keys(i.props || {}).length) ? "name+signature" : "name+no-props";
    row.reasons = best.reasons.slice();
    if (ties.length) {
      const identical = ties.every((t) => sigOf(t.c) === sigOf(best.c));
      row.reasons.push(identical ? `${ties.length + 1} catalog entries named "${name}" score identically \u2014 they are duplicates of one definition (same props, same variants); the first in the catalog is used` : `${ties.length + 1} catalog entries named "${name}" score identically with DIFFERENT signatures \u2014 the first in the catalog is used; confirm which one`);
      row.tie = identical ? "duplicate-definitions" : "different-signatures";
    } else if (scored.length > 1) {
      row.reasons.push(`beat ${scored.length - 1} same-named candidate(s)${runnerUp ? ` by ${best.score - runnerUp.score} pts` : " (their prop signatures do not agree)"}`);
    }
    row.alternatives = verifiedOnes.filter((s) => s !== best).map((s) => ({ ...ifDefined("id", s.c.id), ...ifDefined("key", s.c.key), ...ifDefined("page", s.c.page), score: s.score }));
    row.reasons.push("key lookup: " + (byKey ? "matched" : "NO MATCH (the instance's key is not in the catalog \u2014 re-keyed)"));
    rows.push(row);
  }
  const proposals = rows.filter((r) => !!r.match && !r.byKey);
  return {
    rows,
    proposals,
    summary: {
      instances: instances.length,
      names: rows.length,
      byKey: rows.filter((r) => r.byKey).length,
      proposed: proposals.length,
      proposedWithSignature: proposals.filter((r) => r.evidence === "name+signature").length,
      withCandidates: rows.filter((r) => (byName.get(r.name) || []).length).length,
      unmatched: rows.filter((r) => !r.match).length,
      remote: instances.filter((i) => i.remote).length
    }
  };
}
var REKEY_MIN_PROPOSALS = 3;
var REKEY_MIN_SHARE = 0.5;
function isRekeyed(result) {
  const s = result.summary;
  return s.names > 0 && s.byKey / s.names <= 0.05 && s.proposedWithSignature >= REKEY_MIN_PROPOSALS && s.withCandidates > 0 && s.proposedWithSignature / s.withCandidates >= REKEY_MIN_SHARE;
}

// bridge/src/is-main.ts
import fs2 from "node:fs";
import { fileURLToPath as fileURLToPath2 } from "node:url";
function isMainFallback(metaUrl) {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    return fs2.realpathSync(argv1) === fs2.realpathSync(fileURLToPath2(metaUrl));
  } catch {
    return false;
  }
}

// design-to-code/map-validate.ts
var STATUSES = ["active", "deprecated", "needs-review"];
var KEYS = {
  root: ["version", "figmaFileKey", "components"],
  entry: ["figma", "code", "props", "variantOverrides", "childrenByLayer", "status", "note"],
  figma: ["key", "id", "name", "unstable"],
  code: ["module", "export", "targets"],
  target: ["module", "export"],
  vo: ["when", "code"],
  voCode: ["module", "export"],
  children: ["layerNamePattern", "slot"],
  prop: Object.assign(nullProto(), {
    enum: ["kind", "codeProp", "values", "default", "omitDefault"],
    boolean: ["kind", "codeProp", "default", "omitDefault"],
    string: ["kind", "codeProp"],
    instance: ["kind", "codeProp", "slot"]
  })
};
var PROP_KINDS = Object.keys(KEYS.prop);
var isStr = (v) => typeof v === "string";
var isObj2 = (v) => !!v && typeof v === "object" && !Array.isArray(v);
var isBool = (v) => typeof v === "boolean";
var noExtra = (obj, allowed, at, err) => {
  if (!Array.isArray(allowed)) return;
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) err(`${at}.${k}`, "unknown property (additionalProperties:false)");
};
var optStrings = (obj, keys, at, err) => {
  for (const k of keys) if (obj[k] !== void 0 && !isStr(obj[k])) err(`${at}.${k}`, "must be a string");
};
function validateMap(map) {
  const errors = [];
  const err = (path4, message) => errors.push({ path: path4, message });
  if (!isObj2(map)) return { ok: false, errors: [{ path: "", message: "map must be an object" }] };
  noExtra(map, KEYS.root, "", err);
  if (map.version !== 1) err("version", "must be 1");
  if (map.figmaFileKey !== void 0 && !isStr(map.figmaFileKey)) err("figmaFileKey", "must be a string");
  if (!isObj2(map.components)) {
    err("components", "must be an object");
    return { ok: false, errors };
  }
  for (const key of Object.keys(map.components)) {
    const e = map.components[key];
    const at = `components.${key}`;
    if (!isObj2(e)) {
      err(at, "entry must be an object");
      continue;
    }
    noExtra(e, KEYS.entry, at, err);
    if (!isObj2(e.figma)) err(`${at}.figma`, "required object");
    else {
      noExtra(e.figma, KEYS.figma, `${at}.figma`, err);
      if (!isStr(e.figma.name)) err(`${at}.figma.name`, "required string");
      optStrings(e.figma, ["key", "id"], `${at}.figma`, err);
      if (e.figma.unstable !== void 0 && !isBool(e.figma.unstable)) err(`${at}.figma.unstable`, "must be a boolean");
    }
    if (!isObj2(e.code)) err(`${at}.code`, "required object");
    else {
      noExtra(e.code, KEYS.code, `${at}.code`, err);
      if (!isStr(e.code.module)) err(`${at}.code.module`, "required string");
      if (!isStr(e.code.export)) err(`${at}.code.export`, "required string");
      if (e.code.targets !== void 0) {
        if (!isObj2(e.code.targets)) err(`${at}.code.targets`, "must be an object");
        else for (const t of Object.keys(e.code.targets)) {
          const tv = e.code.targets[t], ta = `${at}.code.targets.${t}`;
          if (!isObj2(tv)) err(ta, "must be an object");
          else {
            noExtra(tv, KEYS.target, ta, err);
            optStrings(tv, ["module", "export"], ta, err);
          }
        }
      }
    }
    if (e.status !== void 0 && (!isStr(e.status) || !STATUSES.includes(e.status))) err(`${at}.status`, `must be one of ${STATUSES.join("|")}`);
    optStrings(e, ["note"], at, err);
    if (e.props !== void 0) {
      if (!isObj2(e.props)) err(`${at}.props`, "must be an object");
      else for (const pn of Object.keys(e.props)) validateProp(e.props[pn], `${at}.props.${pn}`, err);
    }
    if (e.variantOverrides !== void 0) {
      if (!Array.isArray(e.variantOverrides)) err(`${at}.variantOverrides`, "must be an array");
      else e.variantOverrides.forEach((vo, i) => {
        const va = `${at}.variantOverrides[${i}]`;
        if (!isObj2(vo)) {
          err(va, "must be an object");
          return;
        }
        noExtra(vo, KEYS.vo, va, err);
        if (!isObj2(vo.when)) err(`${va}.when`, "required object");
        else for (const wk of Object.keys(vo.when)) if (!isStr(vo.when[wk])) err(`${va}.when.${wk}`, "value must be a string");
        if (!isObj2(vo.code)) err(`${va}.code`, "required object");
        else {
          noExtra(vo.code, KEYS.voCode, `${va}.code`, err);
          if (!isStr(vo.code.module)) err(`${va}.code.module`, "required string");
          if (!isStr(vo.code.export)) err(`${va}.code.export`, "required string");
        }
      });
    }
    if (e.childrenByLayer !== void 0) {
      if (!isObj2(e.childrenByLayer)) err(`${at}.childrenByLayer`, "must be an object");
      else {
        noExtra(e.childrenByLayer, KEYS.children, `${at}.childrenByLayer`, err);
        optStrings(e.childrenByLayer, ["layerNamePattern", "slot"], `${at}.childrenByLayer`, err);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}
function validateProp(p, at, err) {
  if (!isObj2(p)) {
    err(at, "prop must be an object");
    return;
  }
  const allowed = typeof p.kind === "string" ? KEYS.prop[p.kind] : void 0;
  if (!Array.isArray(allowed)) {
    err(`${at}.kind`, `must be one of ${PROP_KINDS.join("|")}`);
    return;
  }
  noExtra(p, allowed, at, err);
  if (p.kind !== "instance" && !isStr(p.codeProp)) err(`${at}.codeProp`, "required string");
  if (p.kind === "instance" && p.codeProp !== void 0 && !isStr(p.codeProp)) err(`${at}.codeProp`, "must be a string");
  if (p.kind === "instance" && p.slot !== void 0 && !isStr(p.slot)) err(`${at}.slot`, "must be a string");
  if (p.kind === "enum") {
    if (p.values !== void 0 && !isObj2(p.values)) err(`${at}.values`, "must be an object (VARIANT option -> code value)");
    else if (isObj2(p.values)) for (const k of Object.keys(p.values)) {
      const t = typeof p.values[k];
      if (p.values[k] !== null && !["string", "number", "boolean"].includes(t)) err(`${at}.values.${k}`, "value must be string|number|boolean|null");
    }
    if (p.default !== void 0 && !["string", "number", "boolean"].includes(typeof p.default)) err(`${at}.default`, "must be string|number|boolean");
  }
  if (p.kind === "boolean" && p.default !== void 0 && !isBool(p.default)) err(`${at}.default`, "must be a boolean");
  if ((p.kind === "enum" || p.kind === "boolean") && p.omitDefault !== void 0 && !isBool(p.omitDefault)) err(`${at}.omitDefault`, "must be a boolean");
}
function isCodeConnectMap(x) {
  return validateMap(x).ok;
}
isCodeConnectMap.expected = "a valid component map (the map-validate script lists what is wrong with it)";
if (false) process.exitCode = main(process.argv.slice(2));

// design-to-code/design-system-dir.ts
import fs3 from "node:fs";
import path3 from "node:path";
function exportRootOf(screenFile, dsDir) {
  const roots = [];
  if (screenFile) {
    const pages = path3.dirname(path3.dirname(screenFile));
    if (path3.basename(pages) === "pages") roots.push(path3.dirname(pages));
  }
  if (dsDir) {
    const parent = path3.dirname(path3.normalize(dsDir));
    roots.push(path3.basename(parent) === "libraries" ? path3.dirname(parent) : parent);
  }
  return roots.find((r) => fs3.existsSync(path3.join(r, "libraries", "index.json"))) ?? null;
}
function findLibraryExports(screenFile, dsDir) {
  const root = exportRootOf(screenFile, dsDir);
  if (!root) return [];
  const index = readJsonOrNull(path3.join(root, "libraries", "index.json"), isLibrariesIndex);
  if (!index) return [];
  return index.libraries.filter((r) => r.dir && r.dir !== "." && r.dir !== ".." && !/[\\/]/.test(r.dir)).map((r) => {
    const rel = path3.join(root, "libraries", r.dir);
    return { rel, name: r.libraryName || r.dir, collectionKeys: r.collectionKeys || [], components: readJsonOrNull(path3.join(rel, "components.json"), isComponentsCatalog) };
  });
}
function discoverCatalogs(namedFile, screenFile) {
  const dir = path3.dirname(namedFile);
  const out = [];
  const seen = /* @__PURE__ */ new Set([path3.resolve(namedFile)]);
  const add = (file, role, catalog) => {
    if (seen.has(path3.resolve(file)) || !fs3.existsSync(file)) return;
    seen.add(path3.resolve(file));
    out.push({ file, role, catalog });
  };
  for (const lib of findLibraryExports(screenFile, dir)) add(path3.join(lib.rel, "components.json"), "library", lib.components);
  const sample = path3.join(dir, "components.library.json");
  add(sample, "library-sample", readJsonOrNull(sample, isComponentsCatalog));
  return out;
}
function readCatalogSet(namedFile, named, extraFiles, screenFile, onSkip) {
  const out = [{ file: namedFile, catalog: named, role: "named" }];
  const seen = /* @__PURE__ */ new Set([path3.resolve(namedFile)]);
  for (const f of extraFiles) {
    if (seen.has(path3.resolve(f))) continue;
    seen.add(path3.resolve(f));
    out.push({ file: f, role: "extra", catalog: readSplitFile(f, "component catalog (--catalog)", isComponentsCatalog, "components", "design-system/components.library.json") });
  }
  for (const d of discoverCatalogs(namedFile, screenFile)) {
    if (seen.has(path3.resolve(d.file))) continue;
    seen.add(path3.resolve(d.file));
    if (d.catalog) out.push({ file: d.file, role: d.role, catalog: d.catalog });
    else if (onSkip) onSkip(d.file);
  }
  return out;
}
function unionCatalog(sources) {
  const first = sources[0];
  const keys = /* @__PURE__ */ new Set();
  const components = [];
  for (const s of sources) for (const c of s.catalog.components) {
    if (c.key) {
      if (keys.has(c.key)) continue;
      keys.add(c.key);
    }
    components.push(c);
  }
  return { ...first ? first.catalog : {}, components };
}
var catalogSetLine = (sources) => `catalogs read (${sources.length}): ` + sources.map((s) => `${s.file} [${s.role}, ${s.catalog.components.length} component(s)]`).join(", ");

// design-to-code/drift-lint.ts
var stripSuffix = (k) => String(k).split("#")[0] ?? "";
function discoverExtraCatalogs(namedFile) {
  return discoverCatalogs(namedFile).flatMap((d) => d.catalog ? [{ file: d.file, catalog: d.catalog }] : []);
}
var DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
function checkFreshness(catalog, push, warnings, opts = {}) {
  const maxAgeMs = opts.maxAgeMs !== void 0 && opts.maxAgeMs > 0 ? opts.maxAgeMs : DEFAULT_MAX_AGE_MS;
  const { exportedAt, ageMs, problem } = snapshotAge(catalog, opts.now || Date.now());
  if (problem === "missing") {
    const w = { code: "unknown-freshness", message: "design-system.json has no `exportedAt` timestamp \u2014 freshness cannot be verified. Findings are checked against whatever snapshot is on disk, which may be stale; re-export with the current plugin to get a timestamp." };
    push(warnings, w.code, w.message, {});
    return w;
  }
  if (problem === "unparseable") {
    const w = { code: "unknown-freshness", message: `design-system.json's \`exportedAt\` ('${exportedAt}') is not a parseable timestamp \u2014 freshness cannot be verified.` };
    push(warnings, w.code, w.message, { ...ifDefined("exportedAt", exportedAt) });
    return w;
  }
  if (typeof ageMs === "number" && ageMs > maxAgeMs) {
    const ageH = (ageMs / 36e5).toFixed(1);
    const maxH = (maxAgeMs / 36e5).toFixed(1);
    const w = {
      code: "stale-snapshot",
      message: `STALE SNAPSHOT: design-system.json was exported ${ageH}h ago (max-age ${maxH}h)${catalog && catalog.file ? ` from '${catalog.file}'` : ""}. Every finding below is checked against that on-disk snapshot, NOT the live Figma file \u2014 re-run dtwin / the export tool before trusting them.`
    };
    push(warnings, w.code, w.message, { ...ifDefined("exportedAt", exportedAt), ageMs, maxAgeMs });
    return w;
  }
  return void 0;
}
function checkExtraFreshness(x, push, warnings, opts) {
  const maxAgeMs = opts.maxAgeMs !== void 0 && opts.maxAgeMs > 0 ? opts.maxAgeMs : DEFAULT_MAX_AGE_MS;
  const { exportedAt, ageMs, problem } = snapshotAge(x.catalog, opts.now || Date.now());
  if (problem) push(warnings, "unknown-freshness", `${x.file} has ${problem === "missing" ? "no `exportedAt` timestamp" : `an unparseable \`exportedAt\` ('${exportedAt}')`} \u2014 map entries resolved in it may be stale.`, { ...ifDefined("exportedAt", exportedAt) });
  else if (typeof ageMs === "number" && ageMs > maxAgeMs) push(warnings, "stale-snapshot", `${x.file} was exported ${(ageMs / 36e5).toFixed(1)}h ago (max-age ${(maxAgeMs / 36e5).toFixed(1)}h) \u2014 map entries resolved in it are checked against that snapshot.`, { ...ifDefined("exportedAt", exportedAt), ageMs, maxAgeMs });
}
function indexPropsByBase(rawProps, valKey, subject, push, warnings, mapKey) {
  const ambiguous = /* @__PURE__ */ new Set(), out = nullProto();
  for (const k of Object.keys(rawProps || {})) {
    const b = stripSuffix(k);
    const prev = out[b];
    if (prev !== void 0 && prev.orig !== k) {
      push(warnings, "ambiguous-prop", `${subject} has two props with base name '${b}' ('${prev.orig}', '${k}') \u2014 comparison skipped`, { mapKey, prop: b });
      ambiguous.add(b);
    }
    out[b] = { orig: k, [valKey]: (rawProps || {})[k] };
  }
  return { props: out, ambiguous };
}
function driftLint(map, catalog, opts) {
  const errors = [], warnings = [];
  const push = (arr, code, message, extra) => arr.push(Object.assign({ code, message }, extra || {}));
  const freshness = checkFreshness(catalog, push, warnings, opts || {});
  const extras = opts && opts.extraCatalogs || [];
  for (const x of extras) checkExtraFreshness(x, push, warnings, opts || {});
  const comps = catalog && catalog.components || [];
  const byKey = /* @__PURE__ */ new Map(), byId = /* @__PURE__ */ new Map(), byName = /* @__PURE__ */ new Map();
  const index = (list, primary, file) => {
    const own = /* @__PURE__ */ new Map(), claimed = /* @__PURE__ */ new Set();
    for (const c of list) {
      if (c.key) {
        const dup = own.get(c.key);
        if (dup) push(warnings, "duplicate-key", `two catalog components share key '${c.key}' ('${dup.name}' and '${c.name}')${file ? ` in ${file}` : ""}`, { key: c.key });
        own.set(c.key, c);
        if (!byKey.has(c.key) || claimed.has(c.key)) {
          byKey.set(c.key, c);
          claimed.add(c.key);
        }
      }
      if (c.id && primary) byId.set(c.id, c);
      if (c.name) getOrInit(byName, c.name, () => []).push(c);
    }
  };
  index(comps, true);
  for (const x of extras) index(x.catalog.components || [], false, x.file);
  const inNamed = new Set(comps);
  const mappedIds = /* @__PURE__ */ new Set();
  const compToEntries = /* @__PURE__ */ new Map();
  const entries = map && map.components || {};
  for (const [mapKey, e] of Object.entries(entries)) {
    const f = e.figma || {};
    let comp;
    if (f.key) comp = byKey.get(f.key);
    else if (f.id) comp = byId.get(f.id);
    else comp = byKey.get(mapKey) || byId.get(mapKey);
    if (!comp) {
      const sameName = f.name && byName.get(f.name);
      const onlyNamed = sameName && sameName.length === 1 ? sameName[0] : void 0;
      const suggestedKey = onlyNamed ? onlyNamed.key : void 0;
      push(
        errors,
        "orphaned-entry",
        `map entry '${mapKey}' (was '${f.name || "?"}'${f.id ? ", id " + f.id : ""}) has no matching component in Figma \u2014 deleted, moved, or unpublished${suggestedKey ? ` (a component named '${f.name}' exists with key ${suggestedKey} \u2014 verify before re-pointing)` : ""}`,
        { mapKey, ...ifDefined("suggestedKey", suggestedKey) }
      );
      continue;
    }
    if (comp.key) mappedIds.add(comp.key);
    if (comp.id && inNamed.has(comp)) mappedIds.add(comp.id);
    getOrInit(compToEntries, comp, () => []).push(mapKey);
    if (f.name && comp.name && f.name !== comp.name) {
      push(warnings, "stale-name", `map entry '${mapKey}' remembers name '${f.name}' but component is now '${comp.name}' (rename \u2014 refresh advisory metadata)`, { mapKey, from: f.name, to: comp.name });
    }
    const { props: catProps, ambiguous: catAmbiguous } = indexPropsByBase(comp.props, "def", `component '${comp.name}'`, push, warnings, mapKey);
    const { props: mapProps, ambiguous: mapAmbiguous } = indexPropsByBase(e.props, "prop", `map entry '${mapKey}'`, push, warnings, mapKey);
    for (const [pn, mp] of Object.entries(mapProps)) if (!(pn in catProps)) push(errors, "stale-prop", `'${mapKey}'.props.${mp.orig} does not exist on the Figma component`, { mapKey, prop: pn });
    for (const [pn, cp] of Object.entries(catProps)) if (!(pn in mapProps)) push(warnings, "uncovered-prop", `'${mapKey}': Figma prop '${cp.orig}' (${cp.def.type}) is not mapped`, { mapKey, prop: pn });
    for (const [pn, mp] of Object.entries(mapProps)) {
      const cp = catProps[pn];
      if (!cp || catAmbiguous.has(pn) || mapAmbiguous.has(pn)) continue;
      const prop = mp.prop;
      const kind = prop.kind, expected = TYPE_TO_KIND[cp.def.type];
      if (expected && kind && kind !== expected) {
        push(errors, "kind-mismatch", `'${mapKey}'.props.${mp.orig}: map kind '${kind}' but Figma type is ${cp.def.type} (expected '${expected}')`, { mapKey, prop: pn });
        continue;
      }
      if (prop.kind === "enum") {
        const values = prop.values || {};
        if (!Array.isArray(cp.def.options)) {
          push(warnings, "no-variant-options", `'${mapKey}'.props.${mp.orig}: component exposes no variant options \u2014 enum values can't be verified`, { mapKey, prop: pn });
          continue;
        }
        for (const opt of Object.keys(values)) if (!cp.def.options.includes(opt)) push(errors, "unknown-variant-value", `'${mapKey}'.props.${mp.orig}: maps option '${opt}' that is not a Figma variant option`, { mapKey, prop: pn });
        for (const opt of cp.def.options) if (!(opt in values)) push(warnings, "unmapped-variant-value", `'${mapKey}'.props.${mp.orig}: variant option '${opt}' has no code mapping (will be omitted)`, { mapKey, prop: pn });
      }
    }
  }
  for (const [comp, keys] of compToEntries) if (keys.length > 1) push(errors, "double-mapped", `component '${comp.name}' is mapped by ${keys.length} entries (${keys.join(", ")}) \u2014 only one code target may win`, { keys });
  let catalogComponents = 0;
  for (const c of comps) {
    if (c.type !== "COMPONENT" && c.type !== "COMPONENT_SET") continue;
    catalogComponents++;
    if (c.key && mappedIds.has(c.key) || c.id && mappedIds.has(c.id)) continue;
    push(warnings, "unmapped-component", `component '${c.name}'${c.key ? " (key " + c.key + ")" : " (unpublished \u2014 no key)"} has no map entry`, { ...ifDefined("key", c.key), name: c.name });
  }
  let mapped = 0, mappedElsewhere = 0;
  for (const comp of compToEntries.keys()) if (inNamed.has(comp)) mapped++;
  else mappedElsewhere++;
  return { errors, warnings, freshness, summary: { entries: Object.keys(entries).length, catalogComponents, mapped, mappedElsewhere, errorCount: errors.length, warningCount: warnings.length } };
}
var LIVE_META_TIMEOUT_MS = 1e4;
async function checkLiveFreshness(fileKey, token, exportedAt) {
  if (!fileKey || !token) return null;
  const res = await fetch(`https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}/meta`, { headers: { "X-Figma-Token": token }, signal: AbortSignal.timeout(LIVE_META_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET /v1/files/${fileKey}/meta -> ${res.status} ${res.statusText}`);
  const body = await res.json();
  const lastModified = isJsonObject(body) && isJsonObject(body.file) && typeof body.file.last_modified === "string" ? body.file.last_modified : void 0;
  if (!lastModified) return { lastModified: void 0, aheadOfSnapshot: void 0 };
  const aheadOfSnapshot = exportedAt ? Date.parse(lastModified) > Date.parse(exportedAt) : void 0;
  return { lastModified, aheadOfSnapshot };
}
function screenCoverage(map, catalog, screenDocs) {
  const entries = map && map.components || {};
  const mapKeys = /* @__PURE__ */ new Set();
  for (const [k, entry] of Object.entries(entries)) {
    const f = entry.figma || {};
    if (f.key) mapKeys.add(f.key);
    if (f.id) mapKeys.add(f.id);
    mapKeys.add(k);
  }
  const catKeys = new Set((catalog && catalog.components || []).map((c) => c.key).filter((k) => !!k));
  const used = /* @__PURE__ */ new Map();
  for (const doc of screenDocs || []) {
    for (const r of screenRoots(doc)) walkWithHidden(r, (n, c) => {
      if (n.type !== "INSTANCE" || !n.mainComponent) return;
      const mc = n.mainComponent;
      const id = mc.setKey || mc.key;
      if (!id) return;
      const u = getOrInit(used, id, () => ({ setName: mc.setName || mc.name, instances: 0, hiddenInstances: 0, key: id, variantKey: mc.key }));
      u.instances++;
      if (c.hidden) u.hiddenInstances++;
    });
  }
  const rows = [...used.values()].map((u) => ({
    ...u,
    inCatalog: catKeys.has(u.key) || !!u.variantKey && catKeys.has(u.variantKey),
    inMap: mapKeys.has(u.key) || !!u.variantKey && mapKeys.has(u.variantKey)
  }));
  const instances = rows.reduce((n, r) => n + r.instances, 0);
  const hiddenInstances = rows.reduce((n, r) => n + r.hiddenInstances, 0);
  const hiddenOnly = rows.filter((r) => r.instances === r.hiddenInstances).length;
  const inCatalog = rows.filter((r) => r.inCatalog).length;
  const inMap = rows.filter((r) => r.inMap).length;
  return {
    distinct: rows.length,
    instances,
    hiddenInstances,
    hiddenOnly,
    inCatalog,
    inMap,
    catalogPct: rows.length ? Math.round(inCatalog / rows.length * 100) : null,
    mapPct: rows.length ? Math.round(inMap / rows.length * 100) : null,
    unmapped: rows.filter((r) => !r.inMap).map((r) => ({ setName: r.setName, key: r.key, instances: r.instances }))
  };
}
async function main(argv) {
  const USAGE = `usage: ${scriptCmd("drift-lint")} <map.json> <design-system/components.local.json> [--screen design/pages/<Page>/<Screen>.json]... [--catalog <components.json>]... [--max-age <hours>]`;
  const OPTIONS = { "max-age": { type: "string" }, screen: { type: "string", multiple: true }, catalog: { type: "string", multiple: true }, help: { type: "boolean", short: "h" } };
  const { values: flags, positionals } = cliParse("drift-lint", argv, OPTIONS, USAGE, 2, (args) => parseArgs2({ args, options: OPTIONS, allowPositionals: true }));
  if (flags.help) {
    console.log(USAGE);
    return 0;
  }
  let maxAgeHours;
  if (flags["max-age"] !== void 0) {
    maxAgeHours = Number(flags["max-age"]);
    if (!(maxAgeHours > 0)) {
      console.error("--max-age expects a positive number of hours");
      return 2;
    }
  } else if (process.env.DRIFT_MAX_AGE_HOURS) {
    maxAgeHours = Number(process.env.DRIFT_MAX_AGE_HOURS);
    if (!(maxAgeHours > 0)) {
      console.error("DRIFT_MAX_AGE_HOURS expects a positive number of hours");
      return 2;
    }
  }
  const maxAgeMs = maxAgeHours ? maxAgeHours * 36e5 : void 0;
  const screenFiles = flags.screen || [];
  const [mapFile, catalogFile] = positionals;
  if (!mapFile || !catalogFile) {
    console.error(USAGE);
    return 2;
  }
  const catalog = readSplitFile(
    catalogFile,
    "component catalog",
    isComponentsCatalog,
    "components",
    "design-system/components.local.json",
    NO_DESIGN_SYSTEM_HINT + "\n       Or build without a component map: every instance then counts as new (build-screen, step 1)."
  );
  const mapRaw = readJsonFile(mapFile, "component map", `Scaffold one with \`${scriptCmd("map-bootstrap")} <components.local.json> --out codeconnect.local.json\`.`);
  const valid = validateMap(mapRaw);
  if (!valid.ok) {
    valid.errors.forEach((e) => console.error(`ERROR  [map-invalid] ${mapFile}: ${e.path || "(root)"}: ${e.message}`));
    console.error(`
${mapFile} is not a valid component map (${valid.errors.length} error(s)) \u2014 fix it, or check it with \`${scriptCmd("map-validate")} ${mapFile}\`.`);
    return 1;
  }
  if (!isCodeConnectMap(mapRaw)) return 1;
  const map = mapRaw;
  const sources = readCatalogSet(
    catalogFile,
    catalog,
    flags.catalog || [],
    screenFiles[0],
    (f) => console.error(`warn   [catalog-unreadable] ${f} is not a readable component catalog \u2014 skipped (map entries that live only there will show as orphaned).`)
  );
  console.error(catalogSetLine(sources));
  const extraCatalogs = sources.slice(1).map((x) => ({ file: x.file, catalog: x.catalog }));
  const union = unionCatalog(sources);
  const res = driftLint(map, catalog, { ...ifDefined("maxAgeMs", maxAgeMs), extraCatalogs });
  res.errors.forEach((e) => console.error(`ERROR  [${e.code}] ${e.message}`));
  res.warnings.forEach((w) => console.error(`warn   [${w.code}] ${w.message}`));
  const s = res.summary;
  console.error(`
${s.mapped}/${s.catalogComponents} components mapped${s.mappedElsewhere ? ` (+${s.mappedElsewhere} map entr${s.mappedElsewhere === 1 ? "y" : "ies"} resolved in the other catalog(s))` : ""} \xB7 ${s.errorCount} error(s), ${s.warningCount} warning(s)`);
  console.error(`      (that number is the CATALOG measured against the map \u2014 it says nothing about any particular screen.)`);
  if (screenFiles.length) {
    const read = screenFiles.map((f) => ({ file: f, doc: readDocFile(f, "screen export", isScreenDoc) }));
    const docs = read.map((r) => r.doc);
    const cov = screenCoverage(map, union, docs);
    if (!cov.distinct) {
      console.error(`
SCREEN COVERAGE: the given screen export(s) contain no INSTANCE nodes \u2014 nothing to reuse either way.`);
    } else {
      console.error(
        `
SCREEN COVERAGE: ${cov.inMap}/${cov.distinct} (${cov.mapPct}%) of the component sets placed on this screen are in your map (by component key) \xB7 ${cov.inCatalog}/${cov.distinct} (${cov.catalogPct}%) are even in the catalog \xB7 ${cov.instances} instance(s) total, ${cov.hiddenInstances} of them on hidden layers` + (cov.hiddenOnly ? ` (${cov.hiddenOnly} set(s) appear ONLY on hidden layers and will not be built)` : "")
      );
      console.error(`       (this says which components you can REUSE by key \u2014 not which ones the build contains; that is verify's job.)`);
      const none = [];
      const others = { components: extraCatalogs.flatMap((x) => x.catalog.components) };
      const rekey = cov.mapPct === 0 ? matchByNameAndSignature(none.concat(...read.map((r) => visibleInstances(r.doc, r.file))), catalog, others) : null;
      if (cov.mapPct === 0 && rekey && isRekeyed(rekey)) {
        console.error(
          `warn   [catalog-rekeyed] NONE of the ${cov.distinct} components on this screen resolve to your map or catalog by key \u2014 but ${rekey.summary.proposed} of the ${rekey.summary.withCandidates} visible component name(s) that exist in the catalog also match it by prop signature.
       That is the SAME library under new keys (one of the Figma files is a duplicate, or the library was re-published), not a foreign one.
       Get the confirmation list with \`${scriptCmd("cross-check")} <screen.json> --design-system <dir> --out design/audit/<screen>.cross\`, have the user
       confirm it (set "confirmed": true per entry), then \`${scriptCmd("map-bootstrap")} <components.local.json> --out <map> --from-proposals design/audit/<screen>.cross.json\`.
       Confirm: ${rekey.summary.proposed} component(s) match the catalog by name and prop signature but not by key (a duplicated or re-published file) \u2014 are they the same components? Until confirmed, build every instance as new.`
        );
      } else if (cov.mapPct === 0) {
        console.error(
          `warn   [screen-coverage] NONE of the ${cov.distinct} components on this screen resolve to your map by key` + (cov.inCatalog ? ` (${cov.inCatalog} of them are in the catalog(s) read \u2014 \`${scriptCmd("map-bootstrap")} ${catalogFile} --screen <screen.json> --out <map>\` stubs those).
` : `, nor to any catalog read.
`) + `       The catalog you exported is not the library this screen is built from \u2014 a green "mapped" count above measures
       the catalog against itself. Open an instance in Figma and use "Go to main component" to find the owning file,
       then export it with \`dtwin pull --as-library "<name>"\` (CLI only \u2014 the MCP server has no library export).
       Confirm: is ${catalogFile}${extraCatalogs.length ? ` (or any of the ${extraCatalogs.length} other catalog(s) read)` : ""} the component library this screen is built from? Until confirmed, build every instance as new.`
        );
      } else if (cov.unmapped.length) {
        console.error(
          `warn   [screen-coverage] ${cov.unmapped.length} component(s) on this screen have no map entry: ` + cov.unmapped.slice(0, 6).map((u) => `'${u.setName}' (${u.instances}x)`).join(", ") + (cov.unmapped.length > 6 ? ", \u2026" : "")
        );
      }
    }
  } else {
    console.error(`note   pass --screen <screen.json> to get the number that matters: how much of THAT screen your map covers.`);
  }
  const fileKey = process.env.FIGMA_FILE_KEY;
  const token = process.env.FIGMA_TOKEN;
  if (fileKey && token) {
    try {
      const live = await checkLiveFreshness(fileKey, token, catalog.exportedAt);
      if (live && live.aheadOfSnapshot) console.error(`warn   [live-meta] the live Figma file was modified (${live.lastModified}) AFTER this snapshot was exported (${catalog.exportedAt}) \u2014 it is confirmed stale, not just old.`);
    } catch (e) {
      console.error(`warn   [live-meta] could not verify against the live file: ${errMsg(e)}`);
    }
  }
  return res.errors.length ? 1 : 0;
}
if (import.meta.main ?? isMainFallback(import.meta.url)) void main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
export {
  DEFAULT_MAX_AGE_MS,
  checkFreshness,
  checkLiveFreshness,
  discoverExtraCatalogs,
  driftLint,
  screenCoverage,
  validateMap
};
