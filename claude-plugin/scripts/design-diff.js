#!/usr/bin/env node
// GENERATED from design-to-code/ by claude-plugin/build-scripts.js — edit the source, then rebuild.


// design-to-code/design-diff.ts
import fs3 from "node:fs";
import path2 from "node:path";
import { execFileSync } from "node:child_process";

// design-to-code/types.ts
function isJsonObject(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
function bag(o) {
  const u = o;
  return u;
}

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
function manifestOf(doc) {
  return isScreenExport(doc) || isLayerFile(doc) ? doc.manifest : void 0;
}

// design-to-code/read-json.ts
import fs from "node:fs";

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

// bridge/src/json-util.ts
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
  return isObj(x) && optArrayOf(x.heavy, (h) => isObj(h) && typeof h.file === "string" && typeof h.bytes === "number" && (h.paths === void 0 || typeof h.paths === "number") && (h.embeddedRaster === void 0 || typeof h.embeddedRaster === "number")) && optArrayOf(x.files, (f) => isObj(f) && typeof f.file === "string" && optStr(f.node));
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
function isMeasuredVisual(x) {
  return isObj(x) && x.version === 1 && typeof x.ran === "boolean" && (x.ran ? isNum(x.differingPct) && isNum(x.shiftTolerantPct) && Array.isArray(x.regions) : typeof x.why === "string");
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
var PLAN_ARRAYS = ["files", "tokens", "components", "hidden", "anchorsSuggested", "deviations", "allowedLiterals", "waivers", "descopes"];
var PLAN_OBJECTS = ["anchors", "verification", "counts"];
var PLAN_STRINGS = ["schema", "screen", "screenName", "nodeId", "route", "file", "exportedAt", "status"];
function planProblem(x) {
  if (!isObj(x)) return "is not a plan (the file holds " + (Array.isArray(x) ? "an array" : x === null ? "null" : typeof x) + ", not an object)";
  for (const k of PLAN_ARRAYS) if (x[k] !== void 0 && !Array.isArray(x[k])) return `is not a valid plan: \`${k}\` must be an array`;
  for (const k of PLAN_OBJECTS) if (x[k] !== void 0 && !isObj(x[k])) return `is not a valid plan: \`${k}\` must be an object`;
  for (const k of PLAN_STRINGS) if (x[k] !== void 0 && x[k] !== null && typeof x[k] !== "string") return `is not a valid plan: \`${k}\` must be a string`;
  if (x.files !== void 0 && !isStringArray(x.files)) return "is not a valid plan: `files` must be an array of paths (strings)";
  for (const k of ["tokens", "components", "allowedLiterals", "deviations", "hidden", "anchorsSuggested", "waivers", "descopes"]) {
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

// design-to-code/map-util.ts
function getOrInit(m, k, init) {
  const have = m.get(k);
  if (have !== void 0) return have;
  const made = init();
  m.set(k, made);
  return made;
}

// design-to-code/cli-args.ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
var SELF = fileURLToPath(import.meta.url);
var shellQuote = (p) => /["$`\\!]/.test(p) ? `'${p.replaceAll("'", `'\\''`)}'` : `"${p}"`;
var scriptCmd = (name) => `node ${shellQuote(path.join(path.dirname(SELF), name + path.extname(SELF)))}`;
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

// design-to-code/design-diff.ts
import { parseArgs as parseArgs2 } from "node:util";

// bridge/src/asset-compare.ts
import crypto from "node:crypto";

// bridge/src/svg-normalize.ts
var NUM_RE = /-?\d+\.\d+(?:[eE][+-]?\d+)?/g;
function normalizeSvgText(svg) {
  return svg.replace(NUM_RE, (m) => {
    const n = Number(m);
    if (!Number.isFinite(n)) return m;
    const fixed = n.toFixed(1);
    return fixed === "-0.0" ? "0.0" : fixed;
  });
}
function isSvgName(fileName) {
  return /\.svg$/i.test(String(fileName || ""));
}

// bridge/src/asset-compare.ts
function normalizeForCompare(fileName, content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
  if (!isSvgName(fileName)) return buf;
  return Buffer.from(normalizeSvgText(buf.toString("utf8")), "utf8");
}
function sha1Hex(buf) {
  return crypto.createHash("sha1").update(buf).digest("hex");
}
var EMPTY_NUMS = new Float64Array(0);

// bridge/src/design-system-layout.ts
var COMPONENTS_DIR = "components";
var TOKENS = "tokens.json";
var STYLES_PAINT = "styles.paint.json";
var STYLES_TEXT = "styles.text.json";
var STYLES_EFFECT = "styles.effect.json";
var STYLES_GRID = "styles.grid.json";
var COMPONENTS_LOCAL = "components.local.json";
var COMPONENTS_LIBRARY = "components.library.json";
var HYGIENE = "hygiene.json";
var MANIFEST = "design-system.json";
var DESIGN_SYSTEM_FILES = {
  TOKENS,
  STYLES_PAINT,
  STYLES_TEXT,
  STYLES_EFFECT,
  STYLES_GRID,
  COMPONENTS_LOCAL,
  COMPONENTS_LIBRARY,
  COMPONENTS_DIR,
  HYGIENE,
  MANIFEST
};

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

// design-to-code/design-diff.ts
var CATEGORY = {
  text: ["text", "runs", "truncate", "maxLines", "autoResize"],
  typography: ["font", "textTokens", "missingFont", "textStyleOverrides"],
  // overrides sit over the text STYLE the font came from
  paint: ["fills", "strokes", "effects", "opacity", "blendMode", "mask", "maskType"],
  layout: [
    "layout",
    "widthMode",
    "heightMode",
    "sizeLimits",
    "aspectRatio",
    "grow",
    "alignSelf",
    "absolute",
    "pin",
    "clip",
    "fixedChildren",
    "strokesInLayout",
    "layoutGrids",
    "gridColumnSpan",
    "gridRowSpan",
    "gridColumnStart",
    "gridRowStart",
    "gridJustifySelf",
    "gridAlignSelf",
    "size",
    "scroll"
  ],
  shape: ["radius", "cornerSmoothing", "rotation", "flipped", "skew", "sourceTransform", "arc", "shape", "booleanOp"],
  tokens: ["tokens", "styles", "variableModes", "propTokens"],
  component: ["component", "mainComponent", "props", "propRefs", "overrides", "exposedInstances", "detachedFrom", "tableCells"],
  visibility: ["hidden"],
  asset: ["asset", "assetFrom", "geometry", "assetSkipped", "exportSettings"],
  interaction: ["reactions", "overlay", "motion"],
  handoff: ["annotations", "devStatus", "devStatusNote", "name", "type"]
};
var isDiffCategory = (k) => Object.hasOwn(CATEGORY, k);
var CATEGORY_OF = /* @__PURE__ */ new Map();
for (const cat of Object.keys(CATEGORY)) if (isDiffCategory(cat)) for (const f of CATEGORY[cat] || []) CATEGORY_OF.set(f, cat);
var IGNORED = /* @__PURE__ */ new Set(["children", "box", "renderBox", "id", "css", "measurements", "pluginData", "sharedData"]);
var same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
var brief = (v) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s === void 0 ? void 0 : s.length > 160 ? s.slice(0, 157) + "\u2026" : s;
};
var MAX_LEAVES = 12;
var isObj2 = (v) => v !== null && typeof v === "object";
function leaves(before, after, at, out = []) {
  if (same(before, after)) return out;
  if (!isObj2(before) || !isObj2(after) || Array.isArray(before) !== Array.isArray(after)) {
    out.push({ at, before, after });
    return out;
  }
  const keys = Array.isArray(before) && Array.isArray(after) ? Array.from({ length: Math.max(before.length, after.length) }, (_, i) => i) : [.../* @__PURE__ */ new Set([...Object.keys(before), ...Object.keys(after)])];
  for (const k of keys) leaves(bag(before)[k], bag(after)[k], typeof k === "number" ? `${at}[${k}]` : `${at}.${k}`, out);
  return out;
}
function fieldDiffs(key, before, after, category) {
  const all = leaves(before, after, key);
  const out = all.slice(0, MAX_LEAVES).map((l) => ({ field: l.at, category, before: brief(l.before), after: brief(l.after) }));
  if (all.length > MAX_LEAVES) out.push({ field: key, category, before: void 0, after: `\u2026 and ${all.length - MAX_LEAVES} more difference(s) under \`${key}\`` });
  return out;
}
function index(doc) {
  const out = /* @__PURE__ */ new Map();
  const walk = (node, parent, trail) => {
    if (!node || typeof node !== "object" || node.id === void 0) return;
    const here = [...trail, node.name || node.type || node.id];
    const kids = Array.isArray(node.children) ? node.children : [];
    out.set(String(node.id), { node, parent, parentId: parent ? String(parent.id) : null, path: here.join(" > "), childIds: kids.map((k) => String(k && k.id)) });
    for (const k of kids) walk(k, node, here);
  };
  for (const r of screenRoots(doc)) walk(r, null, []);
  return out;
}
var ROOT_IGNORED = /* @__PURE__ */ new Set(["tree", "nodes", "exportedAt", "manifest", "snapshot", "assets", "screen", "file", "reference"]);
var nameOf = (idx, id) => {
  const e = idx.get(id);
  return e ? e.node.name || e.node.type || id : id;
};
var describe = (e) => ({ id: String(e.node.id), name: e.node.name, type: e.node.type, path: e.path, parentId: e.parentId });
var CONTAINERS = /* @__PURE__ */ new Set([
  "FRAME",
  "COMPONENT",
  "COMPONENT_SET",
  "INSTANCE",
  "GROUP",
  "BOOLEAN_OPERATION",
  "SECTION",
  "TRANSFORM_GROUP",
  "SLOT",
  "SLIDE",
  "SLIDE_ROW",
  "SLIDE_GRID",
  "PAGE"
]);
var GRID_CHILD_KEYS = ["gridColumnStart", "gridRowStart", "gridColumnSpan", "gridRowSpan", "gridJustifySelf", "gridAlignSelf"];
var ABSOLUTE_ONLY = /* @__PURE__ */ new Set(["mode", "width", "height"]);
function formatNoise(n, parent) {
  const lay = n.layout, isAssetLeaf = n.asset !== void 0 || n.geometry !== void 0 || n.assetSkipped !== void 0;
  const gridItem = !!parent && !n.absolute && parent.layout?.display === "grid";
  const dropGrid = GRID_CHILD_KEYS.filter((k) => n[k] !== void 0 && (!gridItem || (k === "gridColumnStart" || k === "gridRowStart") && n[k] === -1));
  const dropLayout = !!lay && !n.children && (isAssetLeaf || !CONTAINERS.has(n.type) && lay.mode === "absolute" && Object.keys(lay).every((k) => ABSOLUTE_ONLY.has(k)));
  if (!dropGrid.length && !dropLayout) return n;
  const out = { ...n };
  for (const k of dropGrid) delete out[k];
  if (dropLayout) delete out.layout;
  return out;
}
var hasNoise = (e) => formatNoise(e.node, e.parent) !== e.node;
function nodeFields(old, neu, raw = false) {
  const before = raw ? old.node : formatNoise(old.node, old.parent), after = raw ? neu.node : formatNoise(neu.node, neu.parent);
  const fields = [];
  for (const key of /* @__PURE__ */ new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (IGNORED.has(key) || same(bag(before)[key], bag(after)[key])) continue;
    fields.push(...fieldDiffs(key, bag(before)[key], bag(after)[key], CATEGORY_OF.get(key) || "other"));
  }
  const fixedW = !after.widthMode && !before.widthMode, fixedH = !after.heightMode && !before.heightMode;
  const b = before.box || {}, a = after.box || {};
  if (fixedW && b.w !== a.w || fixedH && b.h !== a.h) fields.push({ field: "size", category: "layout", before: `${b.w}\xD7${b.h}`, after: `${a.w}\xD7${a.h}` });
  return fields;
}
var truncatedOf = (m) => m && m.truncated;
function diffScreens(oldDoc, newDoc, opts = {}) {
  const redrawn = opts.redrawn || /* @__PURE__ */ new Set();
  const A = index(oldDoc), B = index(newDoc);
  const added = [], removed = [], changed = [], reordered = [];
  let positionOnly = 0, formatOnly = 0;
  const swapped = /* @__PURE__ */ new Map();
  for (const [id, b] of B) {
    const a = A.get(id);
    if (a && !same(a.node.mainComponent, b.node.mainComponent)) swapped.set(id, { gone: 0, came: 0 });
  }
  const underSwap = (idx, e) => {
    for (let p = e.parentId; p !== null && p !== void 0; p = idx.get(p)?.parentId) {
      const sw = swapped.get(p);
      if (sw) return sw;
    }
    return null;
  };
  for (const [id, e] of B) if (!A.has(id)) {
    const sw = underSwap(B, e);
    if (sw) sw.came++;
    else if (e.parentId === null || A.has(e.parentId)) added.push(describe(e));
  }
  for (const [id, e] of A) if (!B.has(id)) {
    const sw = underSwap(A, e);
    if (sw) sw.gone++;
    else if (e.parentId === null || B.has(e.parentId)) removed.push(describe(e));
  }
  for (const [id, b] of B) {
    const a = A.get(id);
    if (!a) continue;
    const fields = nodeFields(a, b);
    if (a.parentId !== b.parentId) fields.push({ field: "parent", category: "layout", before: a.path, after: b.path });
    if (typeof b.node.asset === "string" && b.node.asset === a.node.asset && redrawn.has(b.node.asset)) fields.push({ field: "asset bytes", category: "asset", before: "the previous render", after: `re-drawn \u2014 ${b.node.asset} has different contents under the same node id` });
    const sw = swapped.get(id);
    if (sw && (sw.gone || sw.came)) fields.push({ field: "sublayers", category: "component", before: `${sw.gone} from the old main component`, after: `${sw.came} from the new one (regenerated by the swap \u2014 not listed)` });
    if (fields.length) changed.push({ ...describe(b), categories: [...new Set(fields.map((f) => f.category))], fields });
    else if (hasNoise(a) !== hasNoise(b) && nodeFields(a, b, true).length) formatOnly++;
    else if (!same(a.node.box, b.node.box)) positionOnly++;
    const keptBefore = a.childIds.filter((c) => b.childIds.includes(c)), keptAfter = b.childIds.filter((c) => a.childIds.includes(c));
    if (!same(keptBefore, keptAfter)) reordered.push({ ...describe(b), before: keptBefore.map((c) => nameOf(A, c)), after: keptAfter.map((c) => nameOf(B, c)) });
  }
  const document = [];
  for (const key of /* @__PURE__ */ new Set([...Object.keys(oldDoc), ...Object.keys(newDoc)])) {
    if (!ROOT_IGNORED.has(key)) document.push(...fieldDiffs(key, bag(oldDoc)[key], bag(newDoc)[key], "document"));
  }
  const warnings = [];
  const trunc = truncatedOf(manifestOf(newDoc));
  if (trunc) warnings.push(`the NEW export is truncated (${trunc === true ? "some" : trunc} subtree(s) past the depth limit) \u2014 anything under "Removed" may simply not have been exported. Re-pull a narrower scope before acting on removals.`);
  if (formatOnly) warnings.push(`${formatOnly} node(s) differ only by the exporter's format (an export from an older plugin: grid-child fields off a grid, layout on text/shapes/leaves or asset leaves) \u2014 not listed. The export's content hash changed, so verification reopens once: re-run verify-screen --expect and --compare.`);
  return { kind: "screen", summary: { added: added.length, removed: removed.length, changed: changed.length + (document.length ? 1 : 0), reordered: reordered.length, positionOnly, formatOnly }, warnings, added, removed, reordered, changed, document };
}
function diffTokens(oldDoc, newDoc) {
  const idOf = (v) => typeof v.key === "string" && v.key ? "k:" + v.key : "n:" + JSON.stringify([v.collection || "", v.name]);
  const keyed = (doc) => new Map((doc.variables || []).map((v) => [idOf(v), v]));
  const A = keyed(oldDoc), B = keyed(newDoc);
  const byName = (m) => {
    const o = /* @__PURE__ */ new Map();
    for (const [id, v] of m) {
      const n = JSON.stringify([v.collection || "", v.name]);
      o.set(n, o.has(n) ? null : id);
    }
    return o;
  };
  const nA = byName(A), nB = byName(B), pairs = /* @__PURE__ */ new Map();
  for (const [id, v] of B) {
    if (A.has(id)) {
      pairs.set(id, id);
      continue;
    }
    const n = JSON.stringify([v.collection || "", v.name]), aId = nA.get(n);
    if (aId && nB.get(n) === id && !B.has(aId) && (aId.startsWith("n:") || id.startsWith("n:"))) pairs.set(id, aId);
  }
  const pairedA = new Set(pairs.values());
  const identities = /* @__PURE__ */ new Map();
  for (const v of [...A.values(), ...B.values()]) {
    getOrInit(identities, v.name, () => /* @__PURE__ */ new Map()).set(idOf(v), v.collection || "");
  }
  const label = (v) => {
    const ids = identities.get(v.name);
    if (!ids || ids.size < 2) return v.name;
    const sameColl = [...ids.values()].filter((c) => c === (v.collection || "")).length > 1;
    return (v.collection ? `${v.collection} / ${v.name}` : v.name) + (sameColl && typeof v.key === "string" && v.key ? ` (key ${v.key.slice(0, 8)}\u2026)` : "");
  };
  const added = [...B].filter(([k]) => !pairs.has(k)).map(([, v]) => label(v));
  const removed = [...A].filter(([k]) => !pairedA.has(k)).map(([, v]) => label(v));
  const changed = [];
  for (const [k, b] of B) {
    const pk = pairs.get(k);
    const a = pk !== void 0 ? A.get(pk) : null;
    if (!a) continue;
    const modes = [.../* @__PURE__ */ new Set([...Object.keys(a.values || {}), ...Object.keys(b.values || {})])].filter((m) => !same((a.values || {})[m], (b.values || {})[m]));
    if (modes.length) changed.push({ name: label(b), ...ifDefined("collection", b.collection), ...ifDefined("key", b.key), modes: modes.map((m) => ({ mode: m, before: brief((a.values || {})[m]), after: brief((b.values || {})[m]) })) });
  }
  const collNames = /* @__PURE__ */ new Map();
  for (const c of [...oldDoc.collections || [], ...newDoc.collections || []]) collNames.set(c.name, (collNames.get(c.name) || /* @__PURE__ */ new Set()).add(c.key || c.name));
  const colLabel = (c) => (collNames.get(c.name)?.size ?? 0) > 1 && c.key ? `${c.name} (key ${String(c.key).slice(0, 8)}\u2026)` : c.name;
  const cols = (doc) => new Map((doc.collections || []).map((c) => [c.key ? "k:" + c.key : "n:" + c.name, { label: colLabel(c), v: { modes: c.modes, ...ifDefined("default", c.default) } }]));
  const CA = cols(oldDoc), CB = cols(newDoc), collections = [];
  for (const [id, e] of new Map([...CA, ...CB])) collections.push(...fieldDiffs(e.label, CA.get(id)?.v, CB.get(id)?.v, "collection"));
  return { kind: "tokens", summary: { added: added.length, removed: removed.length, changed: changed.length + (collections.length ? 1 : 0) }, warnings: [], added, removed, changed, collections };
}
function diffCatalog(oldDoc, newDoc) {
  const keyed = (doc) => new Map((doc.components || []).map((c) => [String(c.key || c.id), c]));
  const A = keyed(oldDoc), B = keyed(newDoc);
  const brief1 = (c) => ({ ...ifDefined("key", c.key), ...ifDefined("id", c.id), name: c.name, type: c.type });
  const added = [...B].filter(([k]) => !A.has(k)).map(([, c]) => brief1(c)), removed = [...A].filter(([k]) => !B.has(k)).map(([, c]) => brief1(c)), changed = [];
  for (const [k, b] of B) {
    const a = A.get(k);
    if (!a) continue;
    const fields = [];
    for (const key of /* @__PURE__ */ new Set([...Object.keys(a), ...Object.keys(b)])) if (!CATALOG_IGNORED.has(key)) fields.push(...fieldDiffs(key, bag(a)[key], bag(b)[key], "component"));
    if (fields.length) changed.push({ ...brief1(b), fields });
  }
  return { kind: "catalog", summary: { added: added.length, removed: removed.length, changed: changed.length }, warnings: [], added, removed, changed };
}
var CATALOG_IGNORED = /* @__PURE__ */ new Set(["page", "pageId", "box", "renderBox"]);
function styleKey(s) {
  return s && typeof s.key === "string" && s.key ? "k:" + s.key : "n:" + String(s && s.name || "");
}
var STYLE_IGNORED = /* @__PURE__ */ new Set(["key", "id"]);
function diffStyles(oldDoc, newDoc) {
  const keyed = (doc) => new Map((doc.styles || []).map((s) => [styleKey(s), s]));
  const A = keyed(oldDoc), B = keyed(newDoc);
  const brief2 = (s) => ({ ...ifDefined("key", s.key), ...ifDefined("id", s.id), name: s.name });
  const added = [...B].filter(([k]) => !A.has(k)).map(([, s]) => brief2(s));
  const removed = [...A].filter(([k]) => !B.has(k)).map(([, s]) => brief2(s));
  const changed = [];
  for (const [k, b] of B) {
    const a = A.get(k);
    if (!a) continue;
    const fields = [];
    for (const key of /* @__PURE__ */ new Set([...Object.keys(a), ...Object.keys(b)])) if (!STYLE_IGNORED.has(key)) fields.push(...fieldDiffs(key, bag(a)[key], bag(b)[key], "style"));
    if (fields.length) changed.push({ ...brief2(b), fields });
  }
  return { kind: "styles", summary: { added: added.length, removed: removed.length, changed: changed.length }, warnings: [], added, removed, changed };
}
function diffHygiene(oldDoc, newDoc) {
  const A = new Set((oldDoc.hygiene || []).map(String)), B = new Set((newDoc.hygiene || []).map(String));
  const added = [...B].filter((h) => !A.has(h));
  const removed = [...A].filter((h) => !B.has(h));
  return { kind: "hygiene", summary: { added: added.length, removed: removed.length, changed: 0 }, warnings: [], added, removed, changed: [] };
}
var MANIFEST_IGNORED = /* @__PURE__ */ new Set(["exportedAt"]);
function diffManifest(oldDoc, newDoc) {
  const fields = [];
  for (const key of /* @__PURE__ */ new Set([...Object.keys(oldDoc || {}), ...Object.keys(newDoc || {})])) {
    if (MANIFEST_IGNORED.has(key)) continue;
    fields.push(...fieldDiffs(key, bag(oldDoc || {})[key], bag(newDoc || {})[key], "manifest"));
  }
  return { kind: "manifest", summary: { added: 0, removed: 0, changed: fields.length ? 1 : 0 }, warnings: [], fields };
}
var hasArray = (doc, key) => isJsonObject(doc) && Array.isArray(doc[key]);
var isManifest = (doc) => isJsonObject(doc) && isJsonObject(doc.counts) && isJsonObject(doc.files);
var isStyles = (doc) => isJsonObject(doc) && Array.isArray(doc.styles) && doc.styles.every((st) => isJsonObject(st) && typeof st.name === "string");
isStyles.expected = "a style sheet: an object with a `styles` array of {name, key?, \u2026}";
var isHygiene = (doc) => isJsonObject(doc) && isStringArray(doc.hygiene);
isHygiene.expected = "hygiene.json: an object with a `hygiene` array of strings";
var isScreen = (doc) => isScreenExport(doc) || isLayerFile(doc);
isScreen.expected = "a screen export: an object whose `nodes` is an array of nodes {id, type, \u2026}, or a layer file whose `tree` is one";
function checked(doc, guard) {
  if (guard(doc)) return doc;
  throw new Error(`is not ${guard.expected || "a document of that kind"}`);
}
function diffDocs(oldDoc, newDoc, opts) {
  if (hasArray(newDoc, "variables")) return diffTokens(isTokensDoc(oldDoc) ? oldDoc : {}, checked(newDoc, isTokensDoc));
  if (hasArray(newDoc, "components")) return diffCatalog(isComponentsCatalog(oldDoc) ? oldDoc : { components: [] }, checked(newDoc, isComponentsCatalog));
  if (hasArray(newDoc, "styles")) return diffStyles(isStyles(oldDoc) ? oldDoc : { styles: [] }, checked(newDoc, isStyles));
  if (hasArray(newDoc, "hygiene")) return diffHygiene(isHygiene(oldDoc) ? oldDoc : { hygiene: [] }, checked(newDoc, isHygiene));
  if (hasArray(newDoc, "nodes") || isJsonObject(newDoc) && isJsonObject(newDoc.tree)) return diffScreens(isScreen(oldDoc) ? oldDoc : { nodes: [] }, checked(newDoc, isScreen), opts);
  if (isManifest(newDoc)) return diffManifest(isManifest(oldDoc) ? oldDoc : null, newDoc);
  throw new Error("not a screen export, a token file, a component catalog, a style sheet, hygiene.json or the design-system manifest (no `tree`/`nodes`, `variables`, `components`, `styles`, `hygiene` or `counts`+`files` at the top level) \u2014 nothing here can be diffed");
}
function markdown(d, label) {
  const s = d.summary, L = [`# What changed \u2014 ${label}`, ""];
  for (const w of d.warnings || []) L.push(`> **Warning:** ${w}`, "");
  const total = s.added + s.removed + s.changed + (s.reordered || 0);
  if (!total) {
    const why = d.kind === "screen" ? [s.positionOnly ? `${s.positionOnly} node(s) only moved with their surroundings` : "", s.formatOnly ? `${s.formatOnly} node(s) differ only by the exporter's format` : ""].filter(Boolean) : [];
    return L.concat(why.length ? `Nothing changed (${why.join("; ")}).` : "Nothing changed.").join("\n") + "\n";
  }
  const line = (f) => `  - \`${f.field}\`: ${f.before === void 0 ? "\u2014" : f.before} \u2192 ${f.after === void 0 ? "\u2014" : f.after}`;
  if (d.kind === "tokens") {
    if (d.changed.length) L.push("## Token values changed", ...d.changed.map((c) => `- \`${c.name}\` \u2014 ${c.modes.map((m) => `${m.mode}: ${m.before} \u2192 ${m.after}`).join("; ")}`), "");
    if (d.collections.length) L.push("## Collections / modes changed", ...d.collections.map(line), "");
    if (d.added.length) L.push("## Tokens added", ...d.added.map((n) => `- \`${n}\``), "");
    if (d.removed.length) L.push("## Tokens removed", ...d.removed.map((n) => `- \`${n}\``), "");
    return L.join("\n") + "\n";
  }
  if (d.kind === "catalog") {
    const one = (c) => `- **${c.name}** (${c.type || "component"}, key \`${c.key || c.id}\`)`;
    L.push("_A catalog change affects every built screen that uses the component \u2014 check each `design/plan/*.json` `components[]`, not only the screen in hand._", "");
    if (d.changed.length) L.push("## Components changed", ...d.changed.flatMap((c) => [one(c), ...c.fields.map(line)]), "");
    if (d.added.length) L.push("## Components added", ...d.added.map(one), "");
    if (d.removed.length) L.push("## Components removed", ...d.removed.map(one), "");
    return L.join("\n") + "\n";
  }
  if (d.kind === "styles") {
    const one = (s2) => `- **${s2.name}** (key \`${s2.key || s2.id}\`)`;
    if (d.changed.length) L.push("## Styles changed", ...d.changed.flatMap((s2) => [one(s2), ...s2.fields.map(line)]), "");
    if (d.added.length) L.push("## Styles added", ...d.added.map(one), "");
    if (d.removed.length) L.push("## Styles removed", ...d.removed.map(one), "");
    return L.join("\n") + "\n";
  }
  if (d.kind === "hygiene") {
    if (d.added.length) L.push("## New warning(s)", ...d.added.map((h) => `- ${h}`), "");
    if (d.removed.length) L.push("## Resolved warning(s)", ...d.removed.map((h) => `- ${h}`), "");
    return L.join("\n") + "\n";
  }
  if (d.kind === "manifest") {
    L.push("## Design system summary changed", ...d.fields.map(line), "");
    return L.join("\n") + "\n";
  }
  if (d.changed.length) L.push("## Changed", ...d.changed.flatMap((c) => [`- **${c.path}** (\`${c.id}\`, ${c.categories.join(" + ")})`, ...c.fields.map(line)]), "");
  if (d.document && d.document.length) L.push("## Beside the tree (flows, modes, dev resources)", ...d.document.map(line), "");
  if (d.added.length) L.push("## Added (each stands for its whole subtree)", ...d.added.map((n) => `- **${n.path}** (\`${n.id}\`, ${n.type})`), "");
  if (d.removed.length) L.push("## Removed (each stands for its whole subtree)", ...d.removed.map((n) => `- **${n.path}** (\`${n.id}\`, ${n.type})`), "");
  if (d.reordered.length) L.push("## Reordered children", ...d.reordered.map((r) => `- **${r.path}**: ${r.before.join(", ")} \u2192 ${r.after.join(", ")}`), "");
  if (s.positionOnly) L.push(`_${s.positionOnly} other node(s) only moved with their surroundings \u2014 not listed._`, "");
  if (s.formatOnly) L.push(`_${s.formatOnly} other node(s) differ only by the exporter's format \u2014 not listed._`, "");
  return L.join("\n") + "\n";
}
function snapshotPath(file, cwd = process.cwd()) {
  const rel = path2.relative(path2.join(cwd, "design"), path2.resolve(cwd, file));
  const flat = (rel.startsWith("..") ? path2.basename(file) : rel).split(path2.sep).join("__");
  return path2.join(cwd, "design", ".sync", flat);
}
function hashAssetBytes(fileName, buf) {
  return sha1Hex(normalizeForCompare(fileName, buf));
}
function assetPaths(doc) {
  const out = /* @__PURE__ */ new Set();
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (typeof n.asset === "string") out.add(n.asset);
    for (const k of Array.isArray(n.children) ? n.children : []) walk(k);
  };
  for (const r of screenRoots(doc)) walk(r);
  return [...out];
}
function assetRoot(file, assets) {
  let dir = path2.dirname(path2.resolve(file));
  for (let i = 0; i < 6; i++, dir = path2.dirname(dir)) if (assets.some((a) => fs3.existsSync(path2.join(dir, a)))) return dir;
  return null;
}
function assetHashes(file, doc) {
  const assets = assetPaths(doc), root = assets.length ? assetRoot(file, assets) : null, out = {};
  if (root) for (const a of assets) {
    try {
      out[a] = hashAssetBytes(a, fs3.readFileSync(path2.join(root, a)));
    } catch {
    }
  }
  return { root, hashes: out };
}
function redrawnAssets(file, newDoc, prev, cwd) {
  const now = assetHashes(file, newDoc), out = /* @__PURE__ */ new Set();
  if (!now.root) return out;
  for (const [a, h] of Object.entries(now.hashes)) {
    let before;
    if (prev.kind === "snapshot") before = (prev.assets || {})[a];
    else if (prev.kind === "git") {
      try {
        before = hashAssetBytes(a, execFileSync("git", ["show", "HEAD:./" + path2.relative(cwd, path2.join(now.root, a)).split(path2.sep).join("/")], { cwd, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 }));
      } catch {
      }
    }
    if (before && before !== h) out.add(a);
  }
  return out;
}
function previous(file, against, cwd = process.cwd(), current = null) {
  if (against) {
    return { doc: readJsonFile(against, "baseline (--against)"), source: against, kind: "file", notes: [] };
  }
  const found = [];
  const snap = snapshotPath(file, cwd);
  if (fs3.existsSync(snap)) {
    const assets = readJsonOrNull(snap + ".assets.json", isStringRecord);
    const r = readJson(snap, anyJson);
    if (!("doc" in r)) throw new Error(`the snapshot ${path2.relative(cwd, snap)} ${r.error} \u2014 re-take it with --snapshot --force, or pass --against <an older copy>`);
    found.push({ doc: r.doc, source: path2.relative(cwd, snap), kind: "snapshot", assets });
  }
  if (fs3.existsSync(snap + ".prev")) {
    const assets = readJsonOrNull(snap + ".assets.json.prev", isStringRecord);
    const r = readJson(snap + ".prev", anyJson);
    if ("doc" in r) found.push({ doc: r.doc, source: path2.relative(cwd, snap) + ".prev", kind: "snapshot", assets });
  }
  try {
    const rel = path2.relative(cwd, path2.resolve(cwd, file)).split(path2.sep).join("/");
    const text = execFileSync("git", ["show", "HEAD:./" + rel], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });
    const doc = JSON.parse(text);
    found.push({ doc, source: "git HEAD", kind: "git" });
  } catch {
  }
  const firstFound = found[0];
  if (firstFound === void 0) return null;
  const at = (d) => {
    if (!d || typeof d !== "object") return null;
    if ("exportedAt" in d && typeof d.exportedAt === "string") return d.exportedAt;
    if ("_slices" in d && Array.isArray(d._slices) && d._slices.length) {
      const times = d._slices.map((s) => s && typeof s === "object" && "at" in s && typeof s.at === "string" ? s.at : null).filter((t) => !!t);
      if (times.length) return times.reduce((mx, t) => t > mx ? t : mx);
    }
    return null;
  };
  const now = at(current), notes = [];
  const useful = found.filter((c) => !(now && at(c.doc) === now));
  for (const c of found) if (!useful.includes(c)) notes.push(`${c.source} is the SAME export as ${file} (exportedAt ${now}) \u2014 ${c.kind === "snapshot" ? "the snapshot was taken after the re-pull" : "the new export is already committed"}, so it was not used as the baseline.`);
  useful.sort((x, y) => String(at(y.doc) || "").localeCompare(String(at(x.doc) || "")));
  const [newest, older] = useful;
  if (newest === void 0) return { ...firstFound, notes: [...notes, `There is no OLDER export to compare against, so this says nothing about what the designer changed. Pass --against <an older copy>.`], same: true };
  if (older !== void 0 && at(newest.doc) !== at(older.doc)) notes.push(`${older.source} is older than ${newest.source} \u2014 used the newer one, so changes already applied are not listed again.`);
  return { ...newest, notes };
}
var DS_FILE_NAMES = Object.values(DESIGN_SYSTEM_FILES).filter((v) => typeof v === "string" && /\.json$/.test(v));
function siblingFilesOf(f) {
  const abs = path2.resolve(f);
  const dir = path2.dirname(abs);
  const base = path2.basename(abs);
  const out = [];
  if (DS_FILE_NAMES.includes(base)) {
    const dsRoot = base === DESIGN_SYSTEM_FILES.MANIFEST ? dir : path2.dirname(dir);
    for (const name of DS_FILE_NAMES) {
      if (name === base) continue;
      const siblingDir = name === DESIGN_SYSTEM_FILES.MANIFEST ? dsRoot : path2.join(dsRoot, "design-system");
      out.push(path2.relative(process.cwd(), path2.join(siblingDir, name)));
    }
    return out;
  }
  const m = /\.json$/i.test(base) ? base.slice(0, -5) : null;
  if (m) {
    for (const suf of [".vars.json", ".assets.json"]) {
      const p = path2.join(dir, m + suf);
      if (fs3.existsSync(p)) out.push(path2.relative(process.cwd(), p));
    }
  }
  const pageDir = dir;
  const pagesDir = path2.dirname(pageDir);
  if (path2.basename(pagesDir) === "pages") {
    const idx = path2.join(pagesDir, "index.json");
    if (fs3.existsSync(idx)) out.push(path2.relative(process.cwd(), idx));
  }
  return out;
}
function main(argv) {
  const USAGE = `usage: ${scriptCmd("design-diff")} --snapshot <file.json>... [--force]
       ${scriptCmd("design-diff")} <file.json> [--against <old.json>] [--json] [--out <file>]`;
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
    console.error(USAGE);
    return argv.length ? 0 : 2;
  }
  const OPTIONS = { snapshot: { type: "boolean" }, against: { type: "string" }, out: { type: "string" }, json: { type: "boolean" }, force: { type: "boolean" }, help: { type: "boolean", short: "h" } };
  const { values: flags, positionals } = cliParse("design-diff", argv, OPTIONS, USAGE, 2, (args) => parseArgs2({ args, options: OPTIONS, allowPositionals: true }));
  if (flags.snapshot) {
    const force = !!flags.force;
    const requested = positionals;
    if (!requested.length) {
      console.error(USAGE);
      return 2;
    }
    const files = [...new Set(requested.flatMap((f) => [f, ...siblingFilesOf(f)]))];
    let refused = 0;
    for (const f of files) {
      if (!fs3.existsSync(f)) {
        console.error(`design-diff: ${f} not found \u2014 nothing to snapshot (first pull?)`);
        continue;
      }
      const dest = snapshotPath(f);
      fs3.mkdirSync(path2.dirname(dest), { recursive: true });
      let identical = false;
      if (fs3.existsSync(dest)) {
        try {
          identical = Buffer.compare(fs3.readFileSync(dest), fs3.readFileSync(f)) === 0;
        } catch {
        }
      }
      if (fs3.existsSync(dest) && !identical && !force) {
        console.error(`design-diff: ${path2.relative(process.cwd(), dest)} already exists and would change \u2014 refusing to overwrite it (pass --force to replace it; the old one is kept as .prev).`);
        refused++;
        continue;
      }
      if (fs3.existsSync(dest) && !identical && force) {
        try {
          fs3.copyFileSync(dest, dest + ".prev");
        } catch {
        }
        try {
          if (fs3.existsSync(dest + ".assets.json")) fs3.copyFileSync(dest + ".assets.json", dest + ".assets.json.prev");
        } catch {
        }
      }
      if (!identical) fs3.copyFileSync(f, dest);
      let n = 0;
      try {
        const parsed = readJsonOrNull(f, isScreen);
        if (parsed) {
          const h = assetHashes(f, parsed).hashes;
          n = Object.keys(h).length;
          fs3.writeFileSync(dest + ".assets.json", JSON.stringify(h, null, 2) + "\n");
        }
      } catch {
      }
      console.log(`snapshot: ${f} -> ${path2.relative(process.cwd(), dest)}${n ? ` (+ ${n} asset hash(es))` : ""}${identical ? " (unchanged)" : ""}`);
    }
    return refused ? 1 : 0;
  }
  const { against, out } = flags;
  const json = !!flags.json;
  const file = positionals[0];
  if (!file) {
    console.error(USAGE);
    return 2;
  }
  const current = readJsonFile(file, "export");
  const failed = (e) => {
    const message = e && typeof e === "object" && "message" in e ? e.message : void 0;
    console.error(`design-diff: ${file}: ${String(message)}`);
    return 2;
  };
  let prev = null;
  try {
    prev = previous(file, against, process.cwd(), current);
  } catch (e) {
    return failed(e);
  }
  if (!prev) {
    console.error(`design-diff: nothing to compare ${file} against \u2014 no snapshot in design/.sync/, and it is not committed in git.
Next time run \`${scriptCmd("design-diff")} --snapshot ${file}\` BEFORE re-pulling; for now pass --against <an older copy>.`);
    return 2;
  }
  let diff;
  try {
    diff = diffDocs(prev.doc, current, { redrawn: isScreen(current) ? redrawnAssets(file, current, prev, process.cwd()) : /* @__PURE__ */ new Set() });
  } catch (e) {
    return failed(e);
  }
  diff.warnings = [...prev.notes, ...diff.warnings || []];
  const result = { file, against: prev.source, baseline: prev.kind, warned: diff.warnings.length > 0, ...diff };
  const text = json ? JSON.stringify(result, null, 2) + "\n" : markdown(result, `${file} vs ${prev.source}`);
  if (out) {
    fs3.mkdirSync(path2.dirname(path2.resolve(out)), { recursive: true });
    fs3.writeFileSync(out, text);
    console.log(`wrote ${out} \u2014 ${JSON.stringify(result.summary)}${result.warnings.length ? ` \u2014 ${result.warnings.length} warning(s), read them` : ""}`);
  } else process.stdout.write(text);
  return 0;
}
if (import.meta.main ?? isMainFallback(import.meta.url)) process.exitCode = main(process.argv.slice(2));
export {
  assetHashes,
  diffCatalog,
  diffDocs,
  diffHygiene,
  diffManifest,
  diffScreens,
  diffStyles,
  diffTokens,
  markdown,
  previous,
  redrawnAssets,
  snapshotPath
};
