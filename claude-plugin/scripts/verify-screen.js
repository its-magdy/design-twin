// GENERATED from design-to-code/ by claude-plugin/build-scripts.js — edit the source, then rebuild.


// design-to-code/verify-screen.ts
import fs9 from "node:fs";
import path7 from "node:path";

// bridge/src/hash.ts
import crypto from "node:crypto";
var sha256Hex = (data) => crypto.createHash("sha256").update(data).digest("hex");

// design-to-code/hidden.ts
var hiddenSelf = (node) => !!(node && typeof node === "object" && "hidden" in node && node.hidden);
var isHidden = (node, ancestorHidden) => !!ancestorHidden || hiddenSelf(node);
function walkWithHidden(root, fn, opts) {
  const pathOf = opts && opts.pathOf || ((n, i) => n.name || n.type || String(i));
  (function go(node, parentHidden, path8, parent, depth) {
    if (!node || typeof node !== "object") return;
    const hidden = isHidden(node, parentHidden);
    fn(node, { hidden, parentHidden: !!parentHidden, path: path8, parent, depth });
    const kids = Array.isArray(node.children) ? node.children : [];
    for (const [i, kid] of kids.entries()) go(kid, hidden, (path8 ? path8 + " > " : "") + pathOf(kid, i), node, depth + 1);
  })(root, false, root ? pathOf(root, 0) : "", null, 0);
}

// design-to-code/content-hash.ts
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// bridge/src/json-util.ts
function isRecord(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
function isUnknownArray(x) {
  return Array.isArray(x);
}
function isStringArray(x) {
  return Array.isArray(x) && x.every((v) => typeof v === "string");
}
function ifDefined(key, v) {
  const o = {};
  if (v !== void 0) o[key] = v;
  return o;
}

// design-to-code/content-hash.ts
function stripPullTimes(v, parentKey) {
  if (isUnknownArray(v)) return v.map((x) => stripPullTimes(x, parentKey));
  if (!v || typeof v !== "object") return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === "exportedAt") continue;
    if (k === "at" && parentKey === "_slices") continue;
    out[k] = stripPullTimes(x, k);
  }
  return out;
}
function exportContentSha256(docs) {
  const list = isUnknownArray(docs) ? docs : [docs];
  return sha256Hex(JSON.stringify(list.map((d) => stripPullTimes(d))));
}
function fileHashes(files, cwd, cached) {
  const out = {};
  for (const rel of isUnknownArray(files) ? files.map(String) : []) {
    try {
      out[rel] = sha256Hex(cached?.(rel) ?? fs.readFileSync(path.join(cwd, rel))).slice(0, 16);
    } catch {
      out[rel] = null;
    }
  }
  return out;
}
function gitHead(cwd) {
  try {
    const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", timeout: 2e3, stdio: ["ignore", "pipe", "ignore"] });
    const h = r.status === 0 && String(r.stdout || "").trim();
    return h && /^[0-9a-f]{40}$/.test(h) ? h : null;
  } catch {
    return null;
  }
}
var RESOLVE_EXT = ["tsx", "ts", "jsx", "js"];
var isFile = (abs) => {
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
};
function mappedModulePath(raw, cwd) {
  if (typeof raw !== "string") return null;
  const s = (raw.split("#")[0] ?? "").trim().split("\\").join("/");
  if (!s || s.startsWith("/") || /^[A-Za-z]:/.test(s) || /^[@~]/.test(s) || s.includes(":")) return null;
  const rel = path.posix.normalize(s).replace(/\/+$/, "");
  if (rel === ".." || rel.startsWith("../") || rel === "." || !rel) return null;
  const dotted = /\.[A-Za-z0-9]+$/.test(path.posix.basename(rel));
  if (cwd === void 0) return dotted ? rel : null;
  if (dotted && isFile(path.join(cwd, rel))) return rel;
  const tries = [...RESOLVE_EXT.map((e) => `${rel}.${e}`), ...RESOLVE_EXT.map((e) => `${rel}/index.${e}`)];
  return tries.find((t) => isFile(path.join(cwd, t))) ?? (dotted ? rel : null);
}
function mapModules(plan) {
  const out = [];
  if (isRecord(plan.anchors)) {
    for (const a of Object.values(plan.anchors)) if (isRecord(a)) out.push(a.mapModule);
  }
  if (isUnknownArray(plan.components)) {
    for (const c of plan.components) if (isRecord(c)) out.push(c.mapModule);
  }
  return out;
}
function planCodeFiles(plan, cwd) {
  const listed = isUnknownArray(plan.files) ? plan.files.map(String) : [];
  const seen = new Set(listed.map((f) => path.posix.normalize(f.trim().split("\\").join("/"))));
  const extra = /* @__PURE__ */ new Set();
  for (const m of mapModules(plan)) {
    const rel = mappedModulePath(m, cwd);
    if (rel !== null && !seen.has(rel)) extra.add(rel);
  }
  return [...listed, ...[...extra].sort()];
}
function planCodeSkipped(plan, cwd) {
  const out = /* @__PURE__ */ new Set();
  for (const m of mapModules(plan)) {
    if (typeof m !== "string" || !m.trim()) continue;
    const rel = mappedModulePath(m, cwd);
    if (rel === null || !isFile(path.join(cwd, rel))) out.add(m.trim());
  }
  return [...out].sort();
}
function planCodeSkippedNote(plan, cwd) {
  const s = planCodeSkipped(plan, cwd);
  return s.length ? `mapModule path(s) not hashed with this plan's code: ${s.slice(0, 6).join(", ")}${s.length > 6 ? `, +${s.length - 6} more` : ""} \u2014 not a file under the project (an \`@/\`/\`~/\` alias, a package, a path outside the project, or a path that names no file even with .tsx/.ts/.jsx/.js or /index added), so an edit to it does not reopen the plan; for code this project owns write the project-relative file path` : null;
}
function planHash(plan) {
  const copy = { ...plan || {} };
  delete copy.status;
  delete copy.waivers;
  delete copy.descopes;
  delete copy.verification;
  return sha256Hex(JSON.stringify(copy)).slice(0, 16);
}
function legacyPlanHash(plan) {
  const copy = structuredClone({ ...plan || {} });
  delete copy.status;
  delete copy.waivers;
  delete copy.descopes;
  if (isRecord(copy.verification)) {
    const v = { ...copy.verification };
    delete v.hook;
    if (Object.keys(v).length) copy.verification = v;
    else delete copy.verification;
  }
  return sha256Hex(JSON.stringify(copy)).slice(0, 16);
}

// design-to-code/plan-record.ts
import fs4 from "node:fs";
import path3 from "node:path";

// bridge/src/json-file.ts
import fs3 from "node:fs";

// bridge/src/atomic-write.ts
import crypto2 from "node:crypto";
import fs2 from "node:fs";
import path2 from "node:path";
var tmpSuffix = () => `.tmp-${process.pid}-${crypto2.randomBytes(4).toString("hex")}`;
function writeFileAtomic(file, data, opts = {}) {
  fs2.mkdirSync(path2.dirname(path2.resolve(file)), { recursive: true });
  const tmp = file + tmpSuffix();
  try {
    fs2.writeFileSync(tmp, data, { flag: "wx", ...opts.mode === void 0 ? {} : { mode: opts.mode } });
    if (opts.mode !== void 0) fs2.chmodSync(tmp, opts.mode);
    fs2.renameSync(tmp, file);
  } catch (e) {
    try {
      fs2.rmSync(tmp, { force: true });
    } catch {
    }
    throw e;
  }
}

// bridge/src/json-file.ts
var indentOf = (text) => /\n([ \t]+)\S/.exec(text)?.[1] ?? "  ";
function formatJsonLike(value, raw) {
  if (raw === null) return JSON.stringify(value, null, 2) + "\n";
  const bom = raw.charCodeAt(0) === 65279 ? "\uFEFF" : "";
  const text = raw.slice(bom.length);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return bom + JSON.stringify(value, null, indentOf(text)).split("\n").join(eol) + (/\n$/.test(text) ? eol : "");
}
function writeJsonLike(file, value, raw) {
  let was = raw ?? null;
  if (raw === void 0) try {
    was = fs3.readFileSync(file, "utf8");
  } catch {
    was = null;
  }
  const out = formatJsonLike(value, was);
  if (out === was) return false;
  writeFileAtomic(file, out);
  return true;
}

// design-to-code/types.ts
function isJsonObject(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
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
var isRect4 = (x) => isObj(x) && isNum(x.x) && isNum(x.y) && isNum(x.w) && isNum(x.h);
function isMeasuredVisual(x) {
  return isObj(x) && x.version === 1 && typeof x.ran === "boolean" && (x.ran ? isNum(x.differingPct) && isNum(x.shiftTolerantPct) && Array.isArray(x.regions) : typeof x.why === "string");
}
function isVisualRegion(x) {
  return isObj(x) && isRect4(x.rect) && isNum(x.pixels) && isNum(x.pct) && isStringArray(x.built) && isStringArray(x.designed);
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
function readableMeasured(x) {
  if (!isMeasuredCore(x)) return null;
  const copy = { ...x };
  const notes = [];
  const dropped = [];
  for (const [k, ok, what] of MEASURED_EXTRAS) {
    if (copy[k] !== void 0 && !ok(copy[k])) {
      notes.push(`measured.${k} is not ${what}; ignored`);
      dropped.push(k);
      delete copy[k];
    }
  }
  if (Array.isArray(copy.nodes)) {
    let dropped2 = 0;
    copy.nodes = copy.nodes.map((n) => {
      if (!isObj(n) || n.unmeasured === void 0 || isReasonMap(n.unmeasured)) return n;
      dropped2++;
      const { unmeasured: _drop, ...rest } = n;
      return rest;
    });
    if (dropped2) notes.push(`${dropped2} node(s) carry an \`unmeasured\` that is not a {key: reason} map; ignored (their nulls read as 'reported null')`);
  }
  return isVerifyMeasured(copy) ? { doc: copy, notes, dropped } : null;
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
function parsePlan(x) {
  return isPlan(x) ? { plan: x } : { error: planProblem(x) || "is not a plan" };
}
var reqStr = (v) => typeof v === "string" && v.trim() !== "";
function isPlanWaiver(x) {
  return isObj(x) && reqStr(x.nodeId) && reqStr(x.field) && x.designed !== void 0 && x.built !== void 0 && reqStr(x.exportContentSha256) && reqStr(x.reason) && reqStr(x.decidedBy) && reqStr(x.decidedAt) && (x.tolerance === void 0 || typeof x.tolerance === "number" && x.tolerance >= 0) && optStr(x.cause);
}
isPlanWaiver.expected = "a plan waiver {nodeId, field, designed, built, exportContentSha256, reason, decidedBy, decidedAt, tolerance?, cause?}";
function isPlanDescope(x) {
  return isObj(x) && reqStr(x.nodeId) && reqStr(x.trigger) && optStr(x.destinationId) && reqStr(x.exportContentSha256) && reqStr(x.reason) && reqStr(x.decidedBy) && reqStr(x.decidedAt);
}
isPlanDescope.expected = "a plan descope {nodeId, trigger, destinationId?, exportContentSha256, reason, decidedBy, decidedAt}";
function isStringRecord(x) {
  return isObj(x) && Object.values(x).every((v) => typeof v === "string");
}
isStringRecord.expected = "an object of strings";

// design-to-code/plan-record.ts
var slash = (p) => p.split(path3.sep).join("/").split("\\").join("/");
var writePlan = writeJsonLike;
var RECORDED_DELTA_KEYS = /* @__PURE__ */ new Set(["nodeId", "field", "severity", "expected", "actual"]);
var isRecordedDelta = (d) => isJsonObject(d) && typeof d.nodeId === "string" && typeof d.field === "string" && (d.severity === "high" || d.severity === "medium") && Object.keys(d).every((k) => RECORDED_DELTA_KEYS.has(k));
function recordPlan(planFile, report, reportRel, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const abs = path3.resolve(cwd, planFile);
  const notes = [];
  const raw = fs4.readFileSync(abs, "utf8");
  const parsed = JSON.parse(raw.charCodeAt(0) === 65279 ? raw.slice(1) : raw);
  const pp = parsePlan(parsed);
  if (!("plan" in pp)) throw new Error(`${planFile} ${pp.error}`);
  const plan = pp.plan;
  const inside = (r) => !(r === ".." || r.startsWith("../") || path3.isAbsolute(r) || /^[A-Za-z]:/.test(r));
  const realOf = (p) => {
    try {
      return fs4.realpathSync(p);
    } catch {
      return p;
    }
  };
  const rel = (p) => {
    const lex = slash(path3.relative(cwd, path3.resolve(cwd, p)));
    if (inside(lex)) return lex;
    const real = slash(path3.relative(realOf(cwd), realOf(path3.resolve(cwd, p))));
    return inside(real) ? real : null;
  };
  const reportAt = rel(reportRel);
  if (reportAt === null) throw new Error(`the report ${slash(reportRel)} is outside the project (${slash(cwd)}) \u2014 the plan records project-relative paths only; write the report inside the project (--out design/verify/<Screen>)`);
  const exists2 = (p) => {
    try {
      return fs4.statSync(path3.resolve(cwd, p)).isFile();
    } catch {
      return false;
    }
  };
  const artifacts = [];
  const outside = [];
  const addArtifact = (p) => {
    if (!p || !exists2(p)) return;
    const r = rel(p);
    if (r === null) {
      if (!outside.includes(slash(p))) outside.push(slash(p));
    } else if (!artifacts.includes(r)) artifacts.push(r);
  };
  addArtifact(reportAt);
  addArtifact(reportAt.replace(/\.report\.json$/, ".report.md"));
  for (const a of report.artifacts) {
    if (typeof a === "string") addArtifact(a);
    else if (a && typeof a.path === "string" && !("exists" in a && a.exists === false)) addArtifact(a.path);
  }
  if (outside.length) notes.push(`${outside.length} artifact(s) outside the project not recorded in verification.artifacts (project-relative paths only): ${outside.join(", ")}`);
  const deltas = report.deltas;
  const compact = deltas.filter((d) => !d.accepted && (d.severity === "high" || d.severity === "medium")).map((d) => ({ nodeId: d.nodeId, field: d.field, severity: d.severity, expected: d.expected, actual: d.actual }));
  const s = report.summary;
  const notMeasured = typeof report.coverage.nodesNotMeasured === "number" ? report.coverage.nodesNotMeasured : report.notMeasured.length;
  let reportSha256;
  try {
    reportSha256 = sha256Hex(fs4.readFileSync(path3.resolve(cwd, reportAt)));
  } catch {
    reportSha256 = sha256Hex(JSON.stringify(report, null, 2) + "\n");
    notes.push(`${reportAt} is not on disk \u2014 recorded the sha256 of the report as --compare writes it`);
  }
  const b = report.behaviour;
  const recorded = {
    by: "verify-screen --record-plan",
    at: opts.now ?? (/* @__PURE__ */ new Date()).toISOString(),
    report: reportAt,
    reportSha256,
    verdict: report.verdict,
    headline: report.headline,
    ...b.headline ? { behaviourHeadline: b.headline } : {},
    counts: {
      high: s.high,
      medium: s.medium,
      low: s.low,
      accepted: s.accepted ?? deltas.filter((d) => d.accepted).length,
      notMeasured,
      inferred: s.inferred ?? (report.inferred ? report.inferred.length : 0)
    }
  };
  const v = plan.verification ?? {};
  const hook = v.hook;
  if (hook && typeof hook.planHash === "string" && hook.planHash !== planHash(plan) && hook.planHash === legacyPlanHash(plan)) {
    hook.planHash = planHash(plan);
    notes.push("the hook's record held an older plan hash that also covered verification \u2014 re-stamped with the current one, so this record does not reopen the plan");
  }
  const prev = v.recorded;
  if (prev && typeof prev.at === "string" && JSON.stringify({ ...prev, at: "" }) === JSON.stringify({ ...recorded, at: "" })) recorded.at = prev.at;
  if (report.mode === "static-only") {
    v.mode = "static-only";
    if (report.reason) v.reason = report.reason;
    delete v.renderer;
  } else {
    if (v.mode === "static-only") delete v.reason;
    v.mode = "rendered";
    if (typeof report.renderer === "string" && report.renderer) v.renderer = report.renderer;
  }
  v.artifacts = artifacts;
  const hand = Array.isArray(v.deltas) ? v.deltas.filter((d) => !isRecordedDelta(d)) : [];
  if (hand.length) notes.push(`${hand.length} row(s) in verification.deltas were not written by --record-plan and are replaced by the report's open deltas (${hand.map((d) => isJsonObject(d) && typeof d.nodeId === "string" ? `${d.nodeId}${typeof d.field === "string" ? ` ${d.field}` : ""}` : JSON.stringify(d).slice(0, 40)).join(", ")}) \u2014 put builder-chosen residuals in deviations[] (with the why), never in verification.deltas`);
  else if (v.deltas !== void 0 && !Array.isArray(v.deltas)) notes.push(`verification.deltas was a hand-written ${v.deltas === null ? "null" : typeof v.deltas} (${JSON.stringify(v.deltas).slice(0, 60)}), replaced by the report's open deltas (an array) \u2014 the counts are in verification.recorded.counts; put builder-chosen residuals in deviations[] (with the why)`);
  v.deltas = compact;
  const handText = (x) => typeof x === "string" ? x.trim() : isJsonObject(x) && typeof x.verdict === "string" ? x.verdict.trim() : null;
  const stale = [];
  const handHeadline = "headline" in v ? handText(v.headline) : null;
  if (handHeadline !== null && handHeadline !== recorded.headline.trim()) stale.push(`verification.headline ("${handHeadline.slice(0, 60)}")`);
  for (const k of ["verdict", "verifyScreenVerdict"]) {
    const t = handText(v[k]);
    if (t !== null && t.toLowerCase() !== recorded.verdict.toLowerCase()) stale.push(`verification.${k} ("${t.slice(0, 40)}")`);
  }
  if (stale.length) notes.push(`${stale.join(" and ")} \u2014 hand-written, and not what this report says (verdict "${recorded.verdict}"); stale beside verification.recorded, which is the record \u2014 update or remove ${stale.length > 1 ? "them" : "it"} by hand`);
  if (b.ran) {
    const tool = b.axe && "version" in b.axe ? `axe-core ${b.axe.version}` : "verify-probe behaviour checks";
    v.a11y = { tool, violations: b.summary.fail, warnings: b.summary.warn, report: reportAt };
  } else if (v.a11y !== void 0) notes.push(`behaviour/a11y checks did not run (${b.why || "no reason recorded"}) \u2014 verification.a11y left as it was`);
  v.recorded = recorded;
  plan.verification = v;
  return { written: writePlan(abs, plan, raw), notes };
}

// design-to-code/read-json.ts
import fs5 from "node:fs";

// bridge/src/errmsg.ts
var errMsg = (e) => typeof e === "string" ? e : String(e && e.message || e);
var firstLine = (e) => errMsg(e).split("\n")[0] ?? "";
var errCode = (e) => e && typeof e === "object" && "code" in e && typeof e.code === "string" ? e.code : void 0;

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
    buf = fs5.readFileSync(file);
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

// design-to-code/plan-waivers.ts
var PASSING_VERDICTS = ["pass", "pass-with-deviations"];
function isPassingVerdict(v) {
  return typeof v === "string" && PASSING_VERDICTS.includes(v);
}
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const entries = Object.entries(v).filter(([, x]) => x !== void 0).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}
function waiversHash(plan) {
  const waivers = Array.isArray(plan?.waivers) ? plan.waivers : [];
  const descopes = Array.isArray(plan?.descopes) ? plan.descopes : [];
  return sha256Hex(canonical({ descopes, waivers }));
}
function planInteractionsSha256(plan) {
  const rows = Array.isArray(plan?.interactions) ? plan.interactions : [];
  return sha256Hex(canonical(rows));
}

// design-to-code/png.ts
import { crc32, deflateSync, inflateSync } from "node:zlib";
var PngError = class extends Error {
};
var SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function chunks(b) {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new PngError("not a PNG (bad signature)");
  const out = [];
  let o = 8;
  while (o + 12 <= buf.length) {
    const len = buf.readUInt32BE(o);
    if (o + 12 + len > buf.length) throw new PngError("truncated PNG chunk");
    const type = buf.toString("latin1", o + 4, o + 8), data = buf.subarray(o + 8, o + 8 + len);
    if (crc32(buf.subarray(o + 4, o + 8 + len)) >>> 0 !== buf.readUInt32BE(o + 8 + len)) throw new PngError(`bad CRC in the ${type} chunk`);
    out.push({ type, data });
    o += 12 + len;
    if (type === "IEND") break;
  }
  if (!out.length || out[0]?.type !== "IHDR") throw new PngError("not a PNG (no IHDR)");
  return out;
}
function pngInfo(b) {
  let cs;
  try {
    cs = chunks(b);
  } catch {
    return null;
  }
  const ihdr = cs[0];
  if (!ihdr || ihdr.data.length < 13) return null;
  const d = ihdr.data;
  const info = { w: d.readUInt32BE(0), h: d.readUInt32BE(4), bitDepth: d[8] ?? 0, colorType: d[9] ?? 0, interlace: d[12] ?? 0, srgb: false, gama: null, iccp: null };
  for (const c of cs) {
    if (c.type === "sRGB") info.srgb = true;
    else if (c.type === "gAMA" && c.data.length >= 4) info.gama = c.data.readUInt32BE(0);
    else if (c.type === "iCCP") {
      const z = c.data.indexOf(0);
      info.iccp = c.data.toString("latin1", 0, z < 0 ? Math.min(79, c.data.length) : z);
    }
  }
  return info;
}
var MAX_DECODE_SIDE = 4096;
var MAX_DECODE_PIXELS = MAX_DECODE_SIDE * MAX_DECODE_SIDE;

// design-to-code/probe-steps.ts
var STEP_KINDS = ["click", "waitFor", "goto"];
var isStepKind = (k) => STEP_KINDS.includes(k);
var REFUSED = {
  fill: "a typed value may submit a form when the steps are replayed",
  type: "a typed value may submit a form when the steps are replayed",
  press: "a key press may submit a form when the steps are replayed",
  hover: "a hover is not a navigation (hover-revealed openers are revealed by the probe itself)",
  check: "a checked box is state, not navigation",
  select: "a selected option is state, not navigation"
};
function isSameOriginPath(v) {
  return v.startsWith("/") && !v.startsWith("//") && !/[\\\s\u0000-\u001f\u007f]/.test(v);
}
function parseSteps(x) {
  const list = Array.isArray(x) ? x : isJsonObject(x) && x.navigate !== void 0 ? x.navigate : void 0;
  if (!Array.isArray(list)) {
    return { error: isJsonObject(x) ? "holds no `navigate` list \u2014 pass a JSON array of steps, or a plan with navigate: [...]" : "is not a list of steps (a JSON array, or a plan with navigate: [...])" };
  }
  const steps = [];
  for (const [i, raw] of list.entries()) {
    const at = `step ${i + 1}`;
    if (!isJsonObject(raw)) return { error: `${at} is not an object like {"click": "<selector>"}` };
    const keys = Object.keys(raw);
    const k = keys[0];
    if (keys.length !== 1 || k === void 0) return { error: `${at} has ${keys.length ? `${keys.length} keys (${keys.join(", ")})` : "no key"} \u2014 exactly one of ${STEP_KINDS.join(" / ")}` };
    const v = raw[k];
    if (!isStepKind(k)) {
      const lk = k.toLowerCase();
      const why = Object.hasOwn(REFUSED, k) ? REFUSED[k] : Object.hasOwn(REFUSED, lk) ? REFUSED[lk] : void 0;
      return { error: `${at} {${k}: \u2026} is not a step \u2014 the vocabulary is ${STEP_KINDS.join(" / ")} (navigation only)${why ? `: ${why}` : ""}` };
    }
    if (typeof v !== "string" || v.trim() === "") return { error: `${at} {${k}: \u2026} needs a non-empty string` };
    if (k === "goto" && !isSameOriginPath(v)) return { error: `${at} {goto: ${JSON.stringify(v)}} must be a same-origin path starting with "/" (e.g. "/orders?tab=open") \u2014 never "//" or "/\\", and no backslash, whitespace or control character` };
    steps.push(k === "click" ? { click: v } : k === "waitFor" ? { waitFor: v } : { goto: v });
  }
  return { steps };
}
function stepsSha256(steps) {
  return sha256Hex(canonical(steps));
}
function isPlanExpect(x) {
  return x === "dialog" || x === "url" || typeof x === "string" && x.startsWith("selector:") && x.length > "selector:".length;
}
function actionForExpect(expect) {
  return expect === "dialog" ? "overlay" : expect === "url" ? "navigate" : "other";
}

// design-to-code/verify-run.ts
import fs7 from "node:fs";
import os from "node:os";
import path6 from "node:path";
import crypto3 from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

// design-to-code/cli-args.ts
import path4 from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
var SELF = fileURLToPath(import.meta.url);
var shellQuote = (p) => /["$`\\!]/.test(p) ? `'${p.replaceAll("'", `'\\''`)}'` : `"${p}"`;
var shellArg = (a) => /^[\w@%+=:,./-]+$/.test(a) ? a : shellQuote(a);
var scriptCmd = (name) => `node ${shellQuote(path4.join(path4.dirname(SELF), name + path4.extname(SELF)))}`;
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
function badShortWords(args, options) {
  const shorts = /* @__PURE__ */ new Map();
  for (const o of Object.values(options)) if (o.short) shorts.set(o.short, o.type);
  const bad = [];
  let takesNext = false;
  for (const a of args) {
    if (a === "--") break;
    if (takesNext) {
      takesNext = false;
      continue;
    }
    if (a.startsWith("--")) {
      takesNext = !a.includes("=") && options[a.slice(2)]?.type === "string";
      continue;
    }
    if (!/^-[^-]/.test(a)) continue;
    let ok = true;
    for (const [i, c] of [...a.slice(1)].entries()) {
      const type = shorts.get(c);
      if (type === void 0) {
        ok = false;
        break;
      }
      if (type === "string") {
        takesNext = i === a.length - 2;
        break;
      }
    }
    if (!ok) bad.push(a);
  }
  return bad;
}
function cliParse(tool, argv, options, usage, exitCode, parse) {
  const args = joinNegativeValues(argv, options);
  const unknownFlags = () => {
    const { tokens } = parseArgs({ args, options, strict: false, allowPositionals: true, tokens: true });
    const long = tokens.flatMap((t) => t.kind === "option" && t.rawName.startsWith("--") && !(t.name in options) ? [{ name: t.rawName, at: t.index }] : []);
    const short2 = badShortWords(args, options);
    const hint = short2.some((w) => w.length > 2) ? ' (a value starting with "-": put -- before it, or use --flag=value)' : "";
    const named = [...long, ...short2.map((w) => ({ name: w, at: args.indexOf(w) }))].sort((a, b) => a.at - b.at).map((n) => n.name);
    return `${tool}: unknown flag ${[...new Set(named)].join(", ")}${hint}
${usage}`;
  };
  let failure;
  try {
    const parsed = parse(args);
    if (!badShortWords(args, options).length) return parsed;
    failure = unknownFlags();
  } catch (e) {
    const code = errCode(e);
    if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      failure = unknownFlags();
    } else if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
      const msg = e instanceof Error ? e.message : "";
      const names = /Option '([^']*)'/.exec(msg)?.[1]?.match(/--?[\w-]+/g) ?? [];
      const typed = names.find((n) => args.some((a) => a === n || a.startsWith(n + "="))) ?? names.at(-1);
      failure = `${tool}: ${typed ?? "an option"} ${/does not take an argument/.test(msg) ? "takes no value" : "needs a value"}
${usage}`;
    } else {
      failure = `${tool}: ${errMsg(e)}
${usage}`;
    }
  }
  console.error(failure);
  process.exit(exitCode);
}

// bridge/src/project-layout.ts
import fs6 from "node:fs";
import path5 from "node:path";
var DESIGN_DIR = "design";
var EXPORT_SUBDIR = "export";
var EXPORT_DIR = path5.join(DESIGN_DIR, EXPORT_SUBDIR);
var TARGET_FILE = path5.join(DESIGN_DIR, "target.json");
var MAP_FILE = path5.join(DESIGN_DIR, "codeconnect.local.json");
var PLAN_DIR = path5.join(DESIGN_DIR, "plan");
var AUDIT_DIR = path5.join(DESIGN_DIR, "audit");
var VERIFY_DIR = path5.join(DESIGN_DIR, "verify");
var TAILWIND_SOURCE_NOT_NOTE = `Tailwind v4 scans every file git does not ignore, ${DESIGN_DIR}/ included, so class names quoted in ${DESIGN_DIR}/ notes, audits and plans end up in your CSS. Next to \`@import "tailwindcss";\` in your CSS entry, add \`@source not "<path from that CSS file to ${DESIGN_DIR}/>";\` (e.g. \`@source not "../${DESIGN_DIR}";\` for src/app.css) \u2014 Tailwind v4.1+`;
var VITE_WATCH_IGNORED_NOTE = `With Tailwind v4's automatic source detection, rewriting an existing text file under ${DESIGN_DIR}/ (a re-export, a verify report) makes Vite fully reload the open page. Either add \`server: { watch: { ignored: ['**/${DESIGN_DIR}/**'] } }\` in vite.config (merge it with any existing \`server.watch\` options), or the Tailwind \`@source not\` above \u2014 both stop it`;
var VERIFY_GITIGNORE_NOTE = `${VERIFY_DIR}/ is regenerated on every verify run (measurements, screenshots, reports) \u2014 consider adding \`${VERIFY_DIR}/\` to .gitignore; decisions live in ${PLAN_DIR}/ and are not affected`;
function listPlans(dir) {
  if (!fs6.existsSync(dir)) return [];
  return fs6.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
}

// design-to-code/verify-run.ts
var STATUS_SCHEMA = "designtwin/verify-status@2";
var STATUS_PHASES = ["queued", "starting", "renderer-found", "renderer-ready", "measuring", "measured", "driving", "done", "failed", "blocked"];
var TERMINAL_PHASES = ["done", "failed", "blocked"];
var MEASURED_PHASES = ["measured", "done"];
var isPhase = (x) => typeof x === "string" && STATUS_PHASES.some((p) => p === x);
var optStr2 = (x) => x === void 0 || typeof x === "string";
function isVerifyStatusV2(x) {
  return isJsonObject(x) && x.schema === STATUS_SCHEMA && typeof x.screen === "string" && typeof x.runId === "string" && typeof x.rev === "number" && isPhase(x.phase) && typeof x.detail === "string" && typeof x.at === "string" && (x.by === "verify-probe" || x.by === "agent" || x.by === "orchestrator") && optStr2(x.expectationSha256) && optStr2(x.measuredSha256) && optStr2(x.evidenceSha256) && (x.published === void 0 || Array.isArray(x.published) && x.published.every((p) => typeof p === "string"));
}
isVerifyStatusV2.expected = "a verify status @2 {schema, screen, runId, rev, phase, detail, at, by}";
var statusFile = (base) => base + ".status.json";
function sha256File(file) {
  try {
    return sha256Hex(fs7.readFileSync(file));
  } catch {
    return null;
  }
}
var CACHE_NAME = "designtwin-verify";
var shortSha = (s) => sha256Hex(s).slice(0, 16);
var isDir = (p) => {
  try {
    return fs7.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
var exists = (p) => fs7.existsSync(p);
function realpath(p) {
  if (typeof fs7.realpathSync.native === "function") {
    try {
      return fs7.realpathSync.native(p);
    } catch {
    }
  }
  return fs7.realpathSync(p);
}
function canonical2(p) {
  const abs = path6.resolve(p);
  try {
    return realpath(abs);
  } catch {
    const parent = path6.dirname(abs);
    return parent === abs ? abs : path6.join(canonical2(parent), path6.basename(abs));
  }
}
var hasPnp = (d) => exists(path6.join(d, ".pnp.cjs")) || exists(path6.join(d, ".pnp.js"));
function isWorkspaceRoot(d) {
  if (exists(path6.join(d, "pnpm-workspace.yaml"))) return true;
  const r = readJson(path6.join(d, "package.json"), anyJson);
  return "doc" in r && isJsonObject(r.doc) && r.doc.workspaces !== void 0;
}
function installRootOf(dir) {
  let P = null;
  for (let d = dir; ; d = path6.dirname(d)) {
    if (exists(path6.join(d, "package.json"))) {
      P = d;
      break;
    }
    if (exists(path6.join(d, ".git")) || path6.dirname(d) === d) return null;
  }
  if (isDir(path6.join(P, "node_modules"))) return P;
  let ws = null;
  for (let d = P; ; d = path6.dirname(d)) {
    if (isWorkspaceRoot(d)) {
      ws = d;
      break;
    }
    if (exists(path6.join(d, ".git")) || path6.dirname(d) === d) break;
  }
  if (ws !== null && isDir(path6.join(ws, "node_modules"))) return ws;
  if (hasPnp(P) || ws !== null && hasPnp(ws)) return null;
  return P;
}
function runCacheOf(verifyDir) {
  const v = canonical2(verifyDir);
  const root = installRootOf(v);
  if (root !== null) {
    const cache = path6.join(root, "node_modules", ".cache", CACHE_NAME);
    const rel = path6.relative(root, v).split(path6.sep).join("/");
    return { dir: rel === VERIFY_DIR.split(path6.sep).join("/") ? cache : path6.join(cache, "dirs", shortSha(rel)), root };
  }
  return { dir: path6.join(os.tmpdir(), CACHE_NAME, shortSha(v)), root: v };
}
function runCacheDir(verifyDir) {
  return runCacheOf(verifyDir).dir;
}
var UNWRITABLE_CODES = /* @__PURE__ */ new Set(["EACCES", "EPERM", "EROFS", "ENOENT"]);
var RunCacheUnwritable = class extends Error {
  cacheDir;
  root;
  /** `code`: the refusal's errno, or "read" when the run cache exists but cannot be read (--wait). ENOENT is not a
   *  permission: a directory on the way was removed while the run wrote there */
  constructor(cacheDir, root, code) {
    super(code === "ENOENT" ? `run cache ${cacheDir} disappeared \u2014 was node_modules reinstalled during the run? (a reinstall clears node_modules/.cache: the live status and the staged files with it) \u2014 start a new run once it is back` : `run cache ${cacheDir} is not ${code === "read" ? "readable" : "writable"} (sandbox write scope?) \u2014 run from ${root} or allow ${code === "read" ? "access" : "writes"} there`);
    this.name = "RunCacheUnwritable";
    this.cacheDir = cacheDir;
    this.root = root;
  }
};
function inRunCache(verifyDir, fn) {
  try {
    return fn();
  } catch (e) {
    const code = errCode(e);
    if (code !== void 0 && UNWRITABLE_CODES.has(code)) {
      const c = runCacheOf(verifyDir);
      throw new RunCacheUnwritable(c.dir, c.root, code);
    }
    throw e;
  }
}
var EXIT_RUN_CACHE = 6;
var liveStatusFile = (base) => path6.join(runCacheDir(path6.dirname(base)), path6.basename(base) + ".status.json");
var stageDirOf = (base, runId) => path6.join(runCacheDir(path6.dirname(base)), "stage", runId);
function newRunId() {
  return (/* @__PURE__ */ new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z") + "-" + crypto3.randomBytes(3).toString("hex");
}
function readStatusFile(file) {
  const r = readJson(file, anyJson);
  if (!("doc" in r)) return null;
  if (isVerifyStatusV2(r.doc)) return r.doc;
  return isJsonObject(r.doc) && r.doc.schema === void 0 && typeof r.doc.phase === "string" ? "v1" : null;
}
function readStatusAt(base) {
  for (const file of [liveStatusFile(base), statusFile(base)]) {
    const status = readStatusFile(file);
    if (status !== null) return { file, status };
  }
  return null;
}
function readStatus(base) {
  const r = readStatusAt(base);
  return r ? r.status : null;
}
var RunEnded = class extends Error {
  constructor(runId, phase, detail) {
    super(`run ${runId} already ended at ${phase}${detail ? ` (${detail})` : ""} \u2014 start a new run with --new-run`);
    this.name = "RunEnded";
  }
};
function writeStatus(base, p) {
  const prev = readStatus(base);
  const same = prev && prev !== "v1" && prev.runId === p.runId ? prev : null;
  if (same && TERMINAL_PHASES.includes(same.phase)) throw new RunEnded(same.runId, same.phase, same.detail);
  const pick = (k) => {
    const v = p[k] ?? (same ? same[k] : void 0);
    return v !== void 0 ? { [k]: v } : {};
  };
  const published = p.published !== void 0 || same && same.published ? [.../* @__PURE__ */ new Set([...same && same.published || [], ...p.published || []])].sort() : void 0;
  const doc = {
    schema: STATUS_SCHEMA,
    screen: path6.basename(base),
    runId: p.runId,
    rev: same ? same.rev + 1 : 1,
    phase: p.phase,
    detail: p.detail ?? "",
    at: (/* @__PURE__ */ new Date()).toISOString(),
    by: p.by,
    ...pick("expectationSha256"),
    ...pick("measuredSha256"),
    ...pick("evidenceSha256"),
    ...published !== void 0 ? { published } : {}
  };
  const live = liveStatusFile(base);
  inRunCache(path6.dirname(base), () => writeFileAtomic(live, JSON.stringify(doc, null, 2) + "\n"));
  return doc;
}
function publishStatus(base, doc) {
  writeFileAtomic(statusFile(base), JSON.stringify(doc, null, 2) + "\n");
}
var TOOL_OWNED = /\.(expected\.json|report\.json|report\.md|status\.json|prev\.json)$/;
function prepareStaged(stageDir, destDir) {
  let entries;
  try {
    entries = fs7.readdirSync(stageDir, { withFileTypes: true });
  } catch (e) {
    return { error: `--publish ${stageDir}: ${firstLine(e)}` };
  }
  if (canonical2(stageDir) === canonical2(destDir)) return { error: `--publish ${stageDir} is the verify directory itself \u2014 stage outside the project` };
  const files = entries.filter((d) => d.isFile()).map((d) => d.name).sort();
  const owned = files.filter((f) => TOOL_OWNED.test(f));
  if (owned.length) return { error: `--publish refuses ${owned.join(", ")} \u2014 expected/report/status files are written by verify-screen itself, never copied in` };
  fs7.mkdirSync(destDir, { recursive: true });
  const suffix = tmpSuffix();
  const tmpOf = (name) => path6.join(destDir, name) + suffix;
  const abort = () => {
    for (const f of files) try {
      fs7.rmSync(tmpOf(f), { force: true });
    } catch {
    }
  };
  for (const f of files) {
    try {
      fs7.copyFileSync(path6.join(stageDir, f), tmpOf(f));
    } catch (e) {
      abort();
      return { error: `--publish: copying ${f} failed (${firstLine(e)}) \u2014 nothing was published` };
    }
  }
  return { files, tmpOf, abort, commit: () => {
    for (const f of files) fs7.renameSync(tmpOf(f), path6.join(destDir, f));
  } };
}
function runBase(screen, dir) {
  const s = screen.replace(/\.(status|measured|expected|evidence)\.json$/, "");
  return /[\\/]/.test(s) && dir === void 0 ? s : path6.join(dir ?? VERIFY_DIR, s);
}
function measuredExpectation(file) {
  const r = readJson(file, anyJson);
  if (!("doc" in r)) return { error: `${file} ${r.error}` };
  if (!isJsonObject(r.doc)) return { error: `${file} is not a JSON object` };
  const v = r.doc.expectationSha256, run = r.doc.runId;
  return typeof v === "string" && v ? { sha: v, ...typeof run === "string" && run ? { runId: run } : {} } : { error: `${file} names no expectation (expectationSha256)` };
}
function checkMeasured(base, measFile, runId, sameRun, prev) {
  const exp = sha256File(base + ".expected.json");
  if (!exp) return { refused: `${base}.expected.json does not exist \u2014 nothing to be done against` };
  const meas = sha256File(measFile);
  if (!meas) return { refused: `${measFile} does not exist \u2014 measure first (the probe on web; on native write it with expectationSha256) (phase stays ${prev ? prev.phase : "unset"})` };
  const named = measuredExpectation(measFile);
  if ("error" in named) return { refused: `${named.error} \u2014 re-run the probe` };
  if (named.sha !== exp) return { refused: `${measFile} was measured against expectation ${short(named.sha)}, not the current ${short(exp)} \u2014 re-run the probe` };
  if (named.runId !== void 0 && named.runId !== runId) return { refused: `${measFile} was measured in run ${named.runId}, not ${runId} \u2014 re-run the probe with --run ${runId}` };
  if (sameRun && sameRun.measuredSha256 && sameRun.measuredSha256 !== meas) {
    return { refused: `run ${runId} recorded measured file ${short(sameRun.measuredSha256)} (by the probe), but ${measFile} is ${short(meas)} \u2014 measured again outside this run? re-run the probe with --run ${runId}` };
  }
  return { expectationSha256: exp, measuredSha256: meas };
}
var RUN_ID = /^[\w.:-]+$/;
var short = (sha) => sha ? `${sha.slice(0, 12)}\u2026` : "none";
function statusMain(screen, f, usage) {
  try {
    return statusRun(screen, f, usage);
  } catch (e) {
    if (e instanceof RunCacheUnwritable) {
      console.error(e.message);
      return EXIT_RUN_CACHE;
    }
    if (e instanceof RunEnded) {
      console.error(e.message);
      return 2;
    }
    throw e;
  }
}
function statusRun(screen, f, usage) {
  if (!screen) {
    console.error("--status needs the screen name: --status <Screen> --phase <phase>\n" + usage);
    return 2;
  }
  if (!isPhase(f.phase)) {
    console.error(`--status needs --phase ${STATUS_PHASES.join("|")}${f.phase !== void 0 ? ` (got '${f.phase}')` : ""}
` + usage);
    return 2;
  }
  if (f.run !== void 0 && f["new-run"]) {
    console.error("pass --run <id> or --new-run, not both\n" + usage);
    return 2;
  }
  if (f.run !== void 0 && !RUN_ID.test(f.run)) {
    console.error(`--run must be a run id (letters, digits, . : _ -), got '${f.run}'
` + usage);
    return 2;
  }
  if (f.by !== void 0 && f.by !== "agent" && f.by !== "orchestrator") {
    console.error(`--by must be agent or orchestrator (got '${f.by}')
` + usage);
    return 2;
  }
  const by = f.by === "orchestrator" ? "orchestrator" : "agent";
  const base = runBase(screen, f.dir);
  const phase = f.phase;
  const prev = readStatus(base);
  const prevV2 = prev && prev !== "v1" ? prev : null;
  let runId;
  if (f.run !== void 0) runId = f.run;
  else if (f["new-run"]) runId = newRunId();
  else if (prevV2 && !TERMINAL_PHASES.includes(prevV2.phase)) runId = prevV2.runId;
  else {
    console.error(`pass --run <id> or --new-run \u2014 ${prevV2 ? `the last run (${prevV2.runId}) ended at ${prevV2.phase}` : prev === "v1" ? "the status on disk is an older hand-written one" : "there is no run in progress"}, so there is nothing to continue
` + usage);
    return 2;
  }
  const sameRun = prevV2 && prevV2.runId === runId ? prevV2 : null;
  if (sameRun && TERMINAL_PHASES.includes(sameRun.phase)) {
    console.error(`run ${runId} already ended at ${sameRun.phase}${sameRun.detail ? ` (${sameRun.detail})` : ""} \u2014 start a new run with --new-run
` + usage);
    return 2;
  }
  const S = path6.basename(base), dir = path6.dirname(base);
  const cache = runCacheDir(dir);
  inRunCache(dir, () => {
    fs7.mkdirSync(cache, { recursive: true });
    const probe = path6.join(cache, `.w-${process.pid}`);
    fs7.writeFileSync(probe, "");
    fs7.rmSync(probe, { force: true });
  });
  const shas = {};
  if (phase === "done" || phase === "measured") {
    const staged = phase === "done" ? f.publish !== void 0 ? path6.join(f.publish, S + ".measured.json") : null : path6.join(stageDirOf(base, runId), S + ".measured.json");
    const measFile = staged !== null && fs7.existsSync(staged) ? staged : base + ".measured.json";
    const checked = checkMeasured(base, measFile, runId, sameRun, prevV2);
    if ("refused" in checked) {
      console.error(`refused  ${checked.refused}`);
      return 1;
    }
    shas.expectationSha256 = checked.expectationSha256;
    shas.measuredSha256 = checked.measuredSha256;
  }
  let prep;
  if (f.publish !== void 0) {
    const r = prepareStaged(f.publish, dir);
    if ("error" in r) {
      console.error(`refused  ${r.error}`);
      return 1;
    }
    prep = r;
  }
  if (phase === "done") {
    const evName = S + ".evidence.json";
    const ev = prep?.files.includes(evName) ? sha256File(prep.tmpOf(evName)) : sameRun?.published?.includes(evName) ? sha256File(base + ".evidence.json") : null;
    if (ev) shas.evidenceSha256 = ev;
    else if (fs7.existsSync(base + ".evidence.json")) console.error(`note  ${base}.evidence.json was not published in run ${runId} \u2014 not recorded as this run's evidence`);
  }
  let doc;
  try {
    doc = writeStatus(base, { runId, phase, by, ...f.detail !== void 0 ? { detail: f.detail } : {}, ...shas, ...prep ? { published: prep.files } : {} });
  } catch (e) {
    prep?.abort();
    throw e;
  }
  if (prep) {
    prep.commit();
    console.error(`published ${prep.files.length} file(s) from ${f.publish} into ${dir}${prep.files.length ? `: ${prep.files.join(", ")}` : ""}`);
  }
  if (phase === "done") publishStatus(base, doc);
  const stage = stageDirOf(base, runId);
  if (!TERMINAL_PHASES.includes(phase)) inRunCache(dir, () => fs7.mkdirSync(stage, { recursive: true }));
  console.log(`run ${doc.runId} rev ${doc.rev}`);
  console.error(`status ${shellArg(liveStatusFile(base))}${phase === "done" ? ` (published to ${shellArg(statusFile(base))})` : ""}`);
  if (!TERMINAL_PHASES.includes(phase)) console.error(`stage  ${shellArg(stage)}`);
  return 0;
}
var seconds = (v, dflt) => {
  if (v === void 0) return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
async function waitMain(screen, f, usage) {
  if (!screen || f.run === void 0) {
    console.error("--wait needs the screen name and the run: --wait <Screen> --run <id>\n" + usage);
    return 2;
  }
  const timeout = seconds(f.timeout, 1200), stall = seconds(f.stall, 300), interval = seconds(f.interval, 2);
  if (timeout === null || stall === null || interval === null) {
    console.error("--timeout / --stall / --interval must be positive numbers of seconds\n" + usage);
    return 2;
  }
  const base = runBase(screen, f.dir);
  console.error(`wait  run ${f.run} on ${liveStatusFile(base)} (then ${statusFile(base)})`);
  const t0 = Date.now();
  let lastKey = "", lastChange = Date.now(), noted = "";
  for (; ; ) {
    const unreadable = cacheUnreadable(base);
    if (unreadable) {
      console.error(unreadable.message);
      return EXIT_RUN_CACHE;
    }
    const at = readStatusAt(base);
    const st = at ? at.status : null;
    const key = st && st !== "v1" ? `${st.runId}#${st.rev}` : String(st);
    if (key !== lastKey) {
      lastKey = key;
      lastChange = Date.now();
    }
    if (st && st !== "v1" && st.runId === f.run) {
      if (st.phase === "failed" || st.phase === "blocked") {
        console.error(`run ${st.runId} ${st.phase} (rev ${st.rev}, ${st.at})${st.detail ? `: ${st.detail}` : ""}`);
        return 1;
      }
      if (st.phase === "done") {
        const onDisk = sha256File(base + ".measured.json");
        if (st.measuredSha256 && onDisk === st.measuredSha256) {
          const ev = st.evidenceSha256 && sha256File(base + ".evidence.json") === st.evidenceSha256 ? ` --interactions ${shellArg(base + ".evidence.json")}` : "";
          console.error(`run ${st.runId} done (rev ${st.rev}, ${st.at})`);
          console.log(`${scriptCmd("verify-screen")} --compare ${shellArg(base + ".expected.json")} ${shellArg(base + ".measured.json")}${ev} --out ${shellArg(base)}`);
          return 0;
        }
        const why = `run ${st.runId} says done, but ${base}.measured.json ${onDisk ? `is not the file it names (sha ${onDisk.slice(0, 12)}\u2026 vs ${(st.measuredSha256 || "none").slice(0, 12)}\u2026)` : "does not exist"} \u2014 still waiting`;
        if (why !== noted) {
          console.error(`note  ${why}`);
          noted = why;
        }
      }
    } else if (st && st !== "v1" && noted !== st.runId) {
      console.error(`note  ${at ? at.file : liveStatusFile(base)} is run ${st.runId} (${st.phase}), not ${f.run} \u2014 waiting for run ${f.run}`);
      noted = st.runId;
    }
    const now = Date.now();
    if (now - t0 >= timeout * 1e3) {
      console.error(`timed out after ${timeout}s waiting for run ${f.run} (${describe(st)})`);
      return 5;
    }
    if (now - lastChange >= stall * 1e3) {
      console.error(`stalled: ${at ? at.file : liveStatusFile(base)} has not changed for ${stall}s (${describe(st)}) \u2014 the verifier may be stuck; check it before re-running`);
      return 5;
    }
    await sleep(Math.min(interval * 1e3, Math.max(1, timeout * 1e3 - (now - t0))));
  }
}
function cacheUnreadable(base) {
  const c = runCacheOf(path6.dirname(base));
  const checks = [[c.dir, fs7.constants.R_OK | fs7.constants.X_OK], [liveStatusFile(base), fs7.constants.R_OK]];
  for (const [p, mode] of checks) {
    try {
      fs7.accessSync(p, mode);
    } catch (e) {
      const code = errCode(e);
      if (code === "EACCES" || code === "EPERM") return new RunCacheUnwritable(c.dir, c.root, "read");
    }
  }
  return null;
}
var describe = (st) => st === null ? "no status file" : st === "v1" ? "an older v1 status file, not written by the tools" : `last: run ${st.runId} rev ${st.rev} ${st.phase} at ${st.at}`;

// design-to-code/verify-screen.ts
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
function screenExportOf(doc) {
  return isScreenExport(doc) ? doc : null;
}

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

// design-to-code/probe-match.ts
var CANONICAL_MATCHED_BY = ["tag", "tag-shared-path", "tag-alias", "text", "text-ordinal", "position", "frame"];
var normText = (s) => s.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
var idSuffix = (id) => {
  const i = id.indexOf(";");
  return i === -1 ? null : id.slice(i + 1);
};
var PAINT_TYPES = /* @__PURE__ */ new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "LINE"]);

// design-to-code/map-util.ts
function getOrInit(m, k, init) {
  const have = m.get(k);
  if (have !== void 0) return have;
  const made = init();
  m.set(k, made);
  return made;
}

// bridge/src/is-main.ts
import fs8 from "node:fs";
import { fileURLToPath as fileURLToPath2 } from "node:url";
function isMainFallback(metaUrl) {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    return fs8.realpathSync(argv1) === fs8.realpathSync(fileURLToPath2(metaUrl));
  } catch {
    return false;
  }
}

// design-to-code/verify-screen.ts
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
function lineHeightPx(lh, fontSize) {
  if (lh == null) return null;
  if (typeof lh === "number") return lh;
  if (typeof lh === "string") {
    const s = lh.trim().toLowerCase();
    if (s === "normal") return null;
    const n = parseFloat(s);
    if (Number.isNaN(n)) return null;
    if (s.endsWith("%")) return fontSize ? n / 100 * Number(fontSize) : null;
    if (s.endsWith("px")) return n;
    return fontSize ? n * Number(fontSize) : null;
  }
  if (typeof lh === "object") {
    if (lh.unit === "PERCENT" || lh.unit === "%") return fontSize ? Number(lh.value) / 100 * Number(fontSize) : null;
    if (lh.unit === "AUTO") return null;
    return typeof lh.value === "number" ? lh.value : null;
  }
  return null;
}
var EXPECTATION_SCHEMA = "designtwin/verify-expectation@2";
var REPORT_SCHEMA = "designtwin/verify-report@2";
var firstSolid = (fills) => (fills || []).find((f) => !!f && f.type === "solid" && f.visible !== false);
var num = (v) => typeof v === "number" && Number.isFinite(v);
var r2 = (v) => Math.round(v * 100) / 100;
var PX_RE = /^\s*[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?(?:px)?\s*$/i;
function cssPx(v) {
  if (num(v)) return v;
  if (typeof v !== "string" || !PX_RE.test(v)) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}
function fourSides(v) {
  const parts = num(v) ? [v] : Array.isArray(v) ? v : typeof v === "string" ? v.trim().split(/\s+/) : [];
  const p = parts.map(cssPx);
  if (p.length < 1 || p.length > 4 || p.some((x) => x === null)) return null;
  const [p0, p1 = p0, p2 = p0, p3 = p1] = p.filter((x) => x !== null);
  return p0 === void 0 || p1 === void 0 || p2 === void 0 || p3 === void 0 ? null : [p0, p1, p2, p3];
}
var STATE_WORD = /(?:^|[^a-z])(hover(?:ed)?|pressed|focus(?:ed)?)(?:[^a-z]|$)/i;
var normState = (w) => /^hover/i.test(w) ? "hover" : /^press/i.test(w) ? "pressed" : "focus";
function drawnStateOf(n) {
  const fillTok = n.tokens && typeof n.tokens.fills === "string" && n.tokens.fills || Array.isArray(n.fills) && n.fills.map((f) => f && f.tokens && f.tokens.color).find((t) => typeof t === "string") || null;
  const word = fillTok ? STATE_WORD.exec(fillTok)?.[1] : void 0;
  if (word !== void 0) return { state: normState(word), why: `its fill is bound to '${fillTok}'` };
  for (const [k, v] of Object.entries(n.props || {})) {
    if (typeof v === "string" && /^\s*(hover(?:ed)?|pressed|focus(?:ed)?)\s*$/i.test(v)) return { state: normState(v.trim()), why: `variant ${k}=${v}` };
  }
  for (const pair of String(n.component || "").split(",")) {
    const [k, v] = pair.split("=").map((s) => s && s.trim());
    if (k && v && /^(hover(?:ed)?|pressed|focus(?:ed)?)$/i.test(v)) return { state: normState(v), why: `variant ${k}=${v}` };
  }
  return null;
}
var isPaintNode = (n) => PAINT_TYPES.has(n.type) || typeof n.asset === "string" && /\.svg$/i.test(n.asset);
function isPlaceholder(n) {
  if (n.type !== "TEXT") return false;
  const toks = [n.tokens && n.tokens.fills, ...Array.isArray(n.fills) ? n.fills.map((f) => f && f.tokens && f.tokens.color) : []];
  return toks.some((t) => typeof t === "string" && /placeholder/i.test(t)) || /placeholder/i.test(n.name || "");
}
function framePosition(n, frame) {
  if (!frame || !num(frame.x) || !num(frame.y)) return null;
  const b = n.box || {}, rb = n.renderBox;
  if (n.type === "TEXT") {
    const align = n.font && n.font.align;
    if (num(b.x) && (n.autoResize === "width_and_height" || align === void 0 || align === "left")) return { x: r2(b.x - frame.x), source: "box" };
    if (rb && num(rb.x)) return { x: r2(rb.x - frame.x), source: "renderBox" };
    if (num(b.x)) return { x: r2(b.x - frame.x), source: "box" };
    return null;
  }
  if (num(b.x) && num(b.y)) return { x: r2(b.x - frame.x), y: r2(b.y - frame.y), source: "box" };
  if (rb && num(rb.x) && num(rb.y) && num(b.w) && num(b.h) && Math.abs(rb.w - b.w) <= 0.5 && Math.abs(rb.h - b.h) <= 0.5) {
    return { x: r2(rb.x - frame.x), y: r2(rb.y - frame.y), source: "renderBox" };
  }
  return null;
}
var inFlowChildren = (n) => (Array.isArray(n.children) ? n.children : []).filter((c) => c && !c.hidden && !c.absolute);
var growsAlong = (c, dir) => {
  const lc = c;
  return lc.grow === 1 || lc.grow === true || (dir === "column" ? lc.heightMode === "fill" : lc.widthMode === "fill");
};
var PAD_KEYS = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"];
var PAD_SIDES = ["top", "right", "bottom", "left"];
function wrapLines(mainSizes, crossSizes, inner, gap, crossGap) {
  if (!num(inner) || !mainSizes.every(num) || !crossSizes.every(num)) return void 0;
  const lines = [];
  let used = -1;
  mainSizes.forEach((w, i) => {
    const h = crossSizes[i] ?? 0;
    if (used >= 0 && used + gap + w <= inner + 1) {
      used += gap + w;
      lines[lines.length - 1] = Math.max(lines[lines.length - 1] ?? 0, h);
    } else {
      used = w;
      lines.push(h);
    }
  });
  return lines.reduce((s, v) => s + v, 0) + crossGap * Math.max(0, lines.length - 1);
}
function paddingNotShown(n, L, pad) {
  const b = n.box;
  if (!b || L.display === "grid" || L.mode === "absolute") return [];
  const dir = L.flexDirection === "column" ? "column" : "row";
  const flow = inFlowChildren(n);
  const spaced = L.justifyContent === "space-between" || L.justifyContent === "space-evenly" || L.justifyContent === "space-around";
  const g = !spaced && typeof L.gap === "number" ? L.gap : typeof L.itemSpacing === "number" && !spaced ? L.itemSpacing : 0;
  const out = [];
  for (const ax of ["x", "y"]) {
    if (ax === "x" ? n.widthMode : n.heightMode) continue;
    const size = ax === "x" ? b.w : b.h;
    const [i0, i1] = ax === "x" ? [3, 1] : [0, 2];
    const a = pad[i0] ?? 0, z = pad[i1] ?? 0;
    if (!num(size) || a === 0 && z === 0) continue;
    const sides = ax === "x" ? ["left", "right"] : ["top", "bottom"];
    const main2 = dir === "row" === (ax === "x");
    const dim = ax === "x" ? "width" : "height";
    const sizes = flow.map((c) => c.box ? ax === "x" ? c.box.w : c.box.h : void 0);
    const wraps = L.flexWrap === "wrap";
    if (flow.length && sizes.every(num)) {
      let content;
      if (main2 && !wraps) content = sizes.reduce((s, v) => s + v, 0) + g * Math.max(0, flow.length - 1);
      else if (!main2 && wraps) {
        const mainSize = ax === "x" ? b.h : b.w;
        const [m0, m1] = ax === "x" ? [0, 2] : [3, 1];
        const mainSizes = flow.map((c) => c.box ? ax === "x" ? c.box.h : c.box.w : void 0);
        content = wrapLines(mainSizes, sizes, mainSize - (pad[m0] ?? 0) - (pad[m1] ?? 0), g, typeof L.rowGap === "number" ? L.rowGap : 0) ?? Math.max(...sizes);
      } else content = Math.max(...sizes);
      if (a + z + content > size + 1) {
        const al0 = main2 ? L.justifyContent : L.alignItems;
        const al = al0 === "space-around" || al0 === "space-evenly" ? "center" : al0;
        const lost = al === "center" ? sides : al === "flex-end" ? [sides[0] ?? "left"] : [sides[1] ?? "right"];
        const shown = lost.filter((sd) => (pad[PAD_SIDES.indexOf(sd)] ?? 0) !== 0);
        if (shown.length) out.push({ sides: shown, why: `padding ${a}+${z} plus its content (${r2(content)}px) exceeds the fixed ${size}px ${dim}, and the content is ${al === "center" ? "centred" : al === "flex-end" ? "end-aligned" : "start-aligned"} \u2014 the design cannot show the ${shown.join("/")} padding, so the build need not have it` });
        continue;
      }
    }
    const centred = main2 ? L.justifyContent === "center" : L.alignItems === "center" && !(wraps && L.alignContent === "space-between");
    const grows = flow.some((c) => main2 ? growsAlong(c, dir) : (ax === "x" ? c.widthMode === "fill" : c.heightMode === "fill") || c.alignSelf === "stretch");
    if (flow.length && centred && a === z && !grows && !(main2 && wraps)) out.push({ sides, why: `content centred in a fixed ${size}px ${dim} with equal padding (${a}) \u2014 the padding moves nothing, so the build need not have it` });
  }
  return out;
}
var TEXT_BOX_HEIGHT = "text box height";
var lineBoxWhy = (lh, h) => `the line box (${r2(lh)}px) is taller than the fixed text box (${r2(h)}px): Figma lets the line overflow the box \u2014 the build chooses: line-height ${r2(lh)} (the text overflows its box, as in Figma) or ${r2(h)} (the glyphs sit about ${r2((lh - h) / 2)}px higher); the TEXT height is not compared`;
function expectNode(n, ctx = {}) {
  const spec = { nodeId: n.id, name: n.name, type: n.type, ...ifDefined("path", ctx.path) };
  const notComparable = [];
  const skip = (field, value, why) => notComparable.push({ nodeId: n.id, name: n.name, field, value, why });
  if (n.text != null) spec.text = n.text;
  const fcase = n.font ? n.font.case : void 0;
  if (n.text != null && (fcase === "upper" || fcase === "lower" || fcase === "title")) spec.textCase = fcase;
  else if (n.text != null && (fcase === "small_caps" || fcase === "small_caps_forced")) skip("text case", fcase, "small caps (font-variant) not compared \u2014 Figma draws the stored characters as small capitals; the build's font-variant is not measured");
  if (n.font) {
    if (n.font.family !== void 0) spec.fontFamily = n.font.family;
    if (typeof n.font.size === "number") spec.fontSize = n.font.size;
    const w = normWeight(n.font.weight);
    if (w != null) spec.fontWeight = w;
    const lh = lineHeightPx(n.font.lineHeight, n.font.size);
    if (lh != null) spec.lineHeight = lh;
    const ls = n.font.letterSpacing;
    if (ls && typeof ls.value === "number") {
      if (String(ls.unit).toLowerCase() !== "percent") spec.letterSpacing = ls.value;
      else if (typeof n.font.size === "number") spec.letterSpacing = r2(ls.value / 100 * n.font.size);
    }
    if (n.font.color) spec.color = normColor(n.font.color);
  }
  const fill = firstSolid(Array.isArray(n.fills) ? n.fills : null);
  if (fill && n.type !== "TEXT") {
    if (isPaintNode(n)) spec.fill = normColor(fill.color);
    else spec.backgroundColor = normColor(fill.color);
  }
  if (fill && n.type === "TEXT" && !spec.color) spec.color = normColor(fill.color);
  const paints = Array.isArray(n.fills) ? n.fills : [];
  if (Array.isArray(n.effects) && n.effects.length > 0 || paints.some((p) => p && p.type !== "solid" && p.visible !== false)) spec.decorated = true;
  if (isPlaceholder(n)) {
    spec.placeholder = true;
    if (spec.text !== void 0) {
      spec.placeholderText = spec.text;
      delete spec.text;
    }
    if (spec.color !== void 0) {
      spec.placeholderColor = spec.color;
      delete spec.color;
    }
  }
  const st = n.strokes;
  if (st && typeof st === "object" && Array.isArray(st.colors) && st.colors.length) {
    spec.borderColor = normColor(st.colors[0]);
    if (typeof st.weight === "number") spec.borderWidth = st.weight;
    else if (st.weights && typeof st.weights === "object") {
      const ws = st.weights;
      spec.borderWidths = ["top", "right", "bottom", "left"].map((k) => {
        const v = ws[k];
        return typeof v === "number" ? v : 0;
      });
    }
    if (st.align) spec.strokeAlign = st.align;
  }
  const drawsBox = paints.some((p) => p && p.visible !== false) || !!(st && (Array.isArray(st.colors) && st.colors.length > 0 || Array.isArray(st.paints) && st.paints.some((p) => p && p.visible !== false))) || Array.isArray(n.effects) && n.effects.length > 0 || n.clip === true;
  if (n.radius !== void 0 && n.radius !== null && !drawsBox && n.type !== "TEXT") {
    const r = n.radius;
    const rv = typeof r === "number" ? r : { ...ifDefined("tl", r.tl), ...ifDefined("tr", r.tr), ...ifDefined("br", r.br), ...ifDefined("bl", r.bl) };
    if (typeof r !== "number" || r !== 0) skip("border-radius", rv, "radius on a layer that draws nothing (no visible fill, stroke or effect, and it does not clip its content) \u2014 its corners are invisible in the design too");
  } else if (typeof n.radius === "number") spec.borderRadius = n.radius;
  else if (n.radius && typeof n.radius === "object") {
    const rc = n.radius;
    const corner = (v) => num(v) ? v : 0;
    const c = { tl: corner(rc.tl), tr: corner(rc.tr), br: corner(rc.br), bl: corner(rc.bl) };
    if (c.tr === c.tl && c.br === c.tl && c.bl === c.tl) spec.borderRadius = c.tl;
    else spec.radiusCorners = c;
  }
  const L = n.layout;
  if (L && typeof L === "object" && (n.asset || n.geometry || n.assetSkipped)) {
    const BAKED = "inset baked into the exported asset";
    const g = typeof L.gap === "number" ? L.gap : typeof L.itemSpacing === "number" ? L.itemSpacing : void 0;
    if (g !== void 0) skip("gap", g, BAKED);
    const pad = Array.isArray(L.padding) ? L.padding.slice(0, 4) : PAD_KEYS.some((k) => typeof L[k] === "number") ? PAD_KEYS.map((k) => L[k]) : null;
    if (pad && pad.some((v) => typeof v === "number" && v !== 0)) skip("padding", pad.map((v) => typeof v === "number" ? v : 0), BAKED);
  } else if (L && typeof L === "object") {
    const g = typeof L.gap === "number" ? L.gap : typeof L.itemSpacing === "number" ? L.itemSpacing : void 0;
    if (g !== void 0) {
      const dir = L.flexDirection === "column" ? "column" : "row";
      const flow = inFlowChildren(n);
      if (flow.length < 2) skip("gap", g, `fewer than two laid-out children (${flow.length}) \u2014 a gap has nothing to separate`);
      else if (L.justifyContent === "space-between" || L.justifyContent === "space-evenly" || L.justifyContent === "space-around") skip("gap", g, `${L.justifyContent}: Figma ignores item spacing here, so the stored value is slack, not a gap`);
      else if (flow.some((c) => growsAlong(c, dir))) skip("gap", g, "a child fills the main axis, so the stored gap and that child's size trade off \u2014 placement is checked through the children's positions and sizes instead");
      else spec.gap = g;
    }
    let pad = null;
    if (Array.isArray(L.padding)) pad = L.padding.slice(0, 4);
    else if (PAD_KEYS.some((k) => typeof L[k] === "number")) pad = PAD_KEYS.map((k) => L[k]);
    if (pad && pad.some((v) => typeof v === "number" && v !== 0)) {
      const p4 = pad.map((v) => typeof v === "number" ? v : 0);
      const skipped = [];
      for (const ax of paddingNotShown(n, L, p4)) {
        skipped.push(...ax.sides);
        skip(`padding (${ax.sides.join("/")})`, ax.sides.map((sd) => p4[PAD_SIDES.indexOf(sd)] ?? 0), ax.why);
      }
      if (skipped.length < 4) spec.padding = p4;
      if (skipped.length && skipped.length < 4) spec.paddingSkip = skipped;
    }
  }
  if (n.box) {
    if (n.type === "TEXT") {
      const rb = n.renderBox;
      const lines = typeof n.maxLines === "number" ? n.maxLines : 0;
      const truncSet = n.autoResize === "truncate" || n.truncate === true || lines > 0;
      const truncated = truncSet && (lines > 1 || !rb || !num(rb.w) || rb.w >= n.box.w - TOLERANCE.textInk);
      const shadowed = Array.isArray(n.effects) && n.effects.length > 0;
      if (isPlaceholder(n)) skip("width", n.box.w, "an input placeholder: its characters are not in the DOM (the placeholder attribute), so no Range measures their width");
      else if (truncated) skip("width", n.box.w, "truncated text (ellipsis / line clamp) the design truncates or wraps: a Range over it measures the full unclipped string, not the box");
      else if (n.autoResize === "width_and_height") spec.width = n.box.w;
      else if (shadowed) skip("width", n.box.w, "text with an effect (shadow/blur): its render bounds include the effect, so neither box nor ink width is the text's");
      else if (rb && num(rb.w)) {
        spec.width = rb.w;
        spec.widthFrom = "renderBox";
        skip("width (text box)", n.box.w, `fixed-width text box (${n.widthMode === "fill" ? "fills its parent" : "set by the designer"}) wider than its words \u2014 the build's text hugs them, so the ink width (renderBox) is compared instead`);
      } else spec.width = n.box.w;
      const lh = spec.lineHeight;
      if (num(lh) && num(n.box.h) && lh > n.box.h + 0.5 && n.autoResize !== "width_and_height" && n.autoResize !== "height") {
        skip(TEXT_BOX_HEIGHT, n.box.h, lineBoxWhy(lh, n.box.h));
      }
    } else {
      if (typeof n.box.w === "number") spec.width = n.box.w;
      if (typeof n.box.h === "number") spec.height = n.box.h;
      if (n.widthMode || n.heightMode) spec.sizing = { ...ifDefined("w", n.widthMode), ...ifDefined("h", n.heightMode) };
    }
  }
  const pos = isPlaceholder(n) ? null : framePosition(n, ctx.frame);
  if (pos) {
    spec.x = pos.x;
    if (pos.y !== void 0) spec.y = pos.y;
    spec.positionFrom = pos.source;
  }
  if (typeof n.opacity === "number" && n.opacity !== 1) spec.opacity = n.opacity;
  else if (spec.text !== void 0 || spec.placeholderText !== void 0 || spec.color !== void 0 || spec.backgroundColor !== void 0 || spec.fill !== void 0 || spec.borderColor !== void 0 || spec.decorated) spec.opacity = 1;
  const own = drawnStateOf(n);
  if (own) {
    spec.drawnState = own.state;
    spec.drawnStateWhy = own.why;
    spec.drawnStateOwn = true;
  } else if (ctx.inheritedState) {
    spec.drawnState = ctx.inheritedState.state;
    spec.drawnStateWhy = `inside '${ctx.inheritedState.from}', which ${ctx.inheritedState.why}`;
    spec.drawnStateFrom = ctx.inheritedState.fromId;
  }
  if (n.tokens && Object.keys(n.tokens).length) spec.tokens = n.tokens;
  if (ctx.frameId) spec.frameId = ctx.frameId;
  return { spec, notComparable };
}
function checkable(spec) {
  return ["text", "placeholderText", "fontSize", "color", "backgroundColor", "fill", "borderRadius", "radiusCorners", "gap", "padding", "borderColor", "x"].some((k) => spec[k] !== void 0);
}
var COORDINATES = "x/y are FRAME-RELATIVE: the node's page-space position minus the frame's own box.x/box.y. Measure el.getBoundingClientRect() minus the rendered frame element's rect (the viewport origin when the frame IS the page). A TEXT node's x and width are read ONLY from textBox {x,w} \u2014 a Range over its characters, never the element's box. Its width is the text box for hug text (autoResize width_and_height) and the INK width (the export's renderBox, widthFrom renderBox) for fixed- or fill-width text, whose box is wider than its words; its x is the box's left edge for hug or left-aligned text, else the ink start. TEXT nodes carry no y and no height (vertical ink and line boxes depend on font metrics). Auto-layout children carry no position (the export does not state one); their parent's is compared.";
var actionsOf = (r) => (Array.isArray(r.actions) ? r.actions : []).filter((a) => a && (a.type || a.navigation));
var triggerOf = (r) => String(r.trigger || "on_click").toLowerCase();
function shellIndex(roots) {
  const out = /* @__PURE__ */ new Map();
  const index = (inst) => {
    const m = /* @__PURE__ */ new Map();
    const textOf = /* @__PURE__ */ new Map();
    const noText = [];
    const go = (n, p, chain, anc) => {
      if (n.hidden) return [];
      const mc = n.type === "INSTANCE" ? n.mainComponent : void 0;
      const here = `${chain}/${n.type}${mc ? `[${mc.key ?? ""}|${mc.setName ?? mc.name}]` : ""}`;
      const texts = n.type === "TEXT" && typeof n.text === "string" ? [n.text] : [];
      for (const c of Array.isArray(n.children) ? n.children : []) if (c) texts.push(...go(c, p === "" && n === inst ? c.name : `${p}\0${c.name}`, here, [n, ...anc]));
      const text = texts.join(" ").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
      textOf.set(n, text);
      if (n.id) {
        m.set(p, m.has(p) ? null : { id: n.id, sig: text ? `text:${text}` : `shape:${here}` });
        if (!text) noText.push({ p, anc });
      }
      return texts;
    };
    go(inst, "", "", []);
    for (const { p, anc } of noText) {
      const e = m.get(p);
      const owner = anc.find((a) => (textOf.get(a) ?? "") !== "");
      if (e && owner) e.sig += `|in:${textOf.get(owner) ?? ""}`;
    }
    return m;
  };
  const walk = (n) => {
    if (n.hidden) return;
    const key = n.type === "INSTANCE" && n.mainComponent ? n.mainComponent.key : void 0;
    if (key) {
      getOrInit(out, key, () => []).push(index(n));
      return;
    }
    for (const c of Array.isArray(n.children) ? n.children : []) if (c) walk(c);
  };
  for (const r of roots) walk(r);
  return out;
}
function rowSignature(n) {
  const mc = n.type === "INSTANCE" ? n.mainComponent : void 0;
  if (mc) return `I:${mc.setKey || mc.key || mc.setName || mc.name || ""}`;
  return `${n.type}(${(Array.isArray(n.children) ? n.children : []).filter((c) => c && !c.hidden).map(rowSignature).join(",")})`;
}
function markRepeatedText(root, specById) {
  const visibleKids = (n) => (Array.isArray(n.children) ? n.children : []).filter((c) => c && !c.hidden);
  const texts = (n, rel, out) => {
    if (n.type === "TEXT" && typeof n.text === "string" && n.id) getOrInit(out, rel, () => []).push({ id: n.id, text: n.text.trim() });
    visibleKids(n).forEach((c, i) => texts(c, rel ? `${rel}/${i}` : String(i), out));
  };
  (function go(p) {
    if (p.hidden) return;
    const kids = visibleKids(p);
    const bySig = /* @__PURE__ */ new Map();
    for (const k of kids) getOrInit(bySig, rowSignature(k), () => []).push(k);
    for (const rows of bySig.values()) {
      if (rows.length < 3) continue;
      const slots = /* @__PURE__ */ new Map();
      for (const r of rows) texts(r, "", slots);
      for (const [rel, list] of slots) {
        const byText = /* @__PURE__ */ new Map();
        for (const e of list) if (e.text) getOrInit(byText, e.text, () => []).push(e.id);
        let k = 0;
        for (const ids of byText.values()) {
          if (ids.length < 3) continue;
          const group = `${p.id}>${rel || "."}#${k++}`;
          for (const id of ids) {
            const spec = specById.get(id);
            if (spec && spec.type === "TEXT" && spec.text !== void 0 && !spec.repeatedText) {
              spec.repeatedText = true;
              spec.repeatedTextGroup = group;
            }
          }
        }
      }
    }
    for (const k of kids) go(k);
  })(root);
}
function buildExpectation(docs, opts) {
  const nodes = [];
  const instances = [];
  const interactions = [];
  const notComparable = [];
  const hidden = { roots: [], ids: [], specsSkipped: 0, instancesSkipped: 0, interactionsSkipped: 0 };
  const frames = [];
  const seen = /* @__PURE__ */ new Set();
  let screen = void 0, exportedAt = void 0, reference = null;
  const idsByFile = /* @__PURE__ */ new Map();
  const rootsByFile = /* @__PURE__ */ new Map();
  const interactionFile = /* @__PURE__ */ new Map();
  const roots = [];
  const rootNodesByFile = /* @__PURE__ */ new Map();
  const visibleById = /* @__PURE__ */ new Map();
  for (const { doc, label } of docs) {
    const exp = screenExportOf(doc);
    const sf = doc && "sourceFile" in doc ? doc.sourceFile : exp ? exp.sourceFile : void 0;
    const sourceFile = typeof sf === "string" && sf ? sf : void 0;
    const fileIds = getOrInit(idsByFile, sourceFile ?? "", () => /* @__PURE__ */ new Set());
    if (!screen) screen = exp && exp.screen || label;
    if (!exportedAt) exportedAt = exp ? exp.exportedAt : void 0;
    for (const root of screenRoots(doc)) {
      if (root.id) {
        const names = getOrInit(getOrInit(rootsByFile, sourceFile ?? "", () => /* @__PURE__ */ new Map()), root.id, () => /* @__PURE__ */ new Set());
        for (const n of [root.name, exp && exp.nodeId === root.id ? exp.screen : void 0]) if (typeof n === "string" && n) names.add(n);
      }
      getOrInit(rootNodesByFile, sourceFile ?? "", () => []).push(root);
      if (!reference && root.reference) reference = root.reference;
      const b = root.box || {};
      const frame = {
        nodeId: root.id,
        name: root.name,
        ...ifDefined("w", b.w),
        ...ifDefined("h", b.h),
        ...ifDefined("x", b.x),
        ...ifDefined("y", b.y),
        clip: root.clip === true,
        ...ifDefined("scroll", root.scroll)
      };
      frames.push(frame);
      const frameId = frames.length > 1 ? root.id : void 0;
      const stateOf = /* @__PURE__ */ new WeakMap();
      const chainOf = /* @__PURE__ */ new WeakMap();
      const fixedNodes = /* @__PURE__ */ new WeakSet();
      roots.push(root);
      walkWithHidden(root, (n, c) => {
        if (n.id) fileIds.add(n.id);
        if (c.hidden) {
          if (!c.parentHidden) hidden.roots.push({ nodeId: n.id, name: n.name, path: c.path });
          if (n.id) hidden.ids.push(n.id);
          if (checkable(expectNode(n, { path: c.path }).spec)) hidden.specsSkipped++;
          if (n.type === "INSTANCE" && n.mainComponent) hidden.instancesSkipped++;
          for (const r of Array.isArray(n.reactions) ? n.reactions : []) hidden.interactionsSkipped += actionsOf(r).length;
          return;
        }
        const inherited = c.parent ? stateOf.get(c.parent) : void 0;
        const ancestorIds = c.parent ? chainOf.get(c.parent) ?? [] : [];
        chainOf.set(n, c.parent ? [...n.id ? [n.id] : [], ...ancestorIds] : []);
        if (n.id && seen.has(n.id)) return;
        if (n.id) seen.add(n.id);
        if (n.id) visibleById.set(n.id, { name: n.name, file: sourceFile ?? "" });
        const { spec, notComparable: gaps } = expectNode(n, { path: c.path, frame, ...ifDefined("inheritedState", inherited), ...ifDefined("frameId", frameId) });
        spec.ancestorIds = ancestorIds;
        if (n.absolute) spec.absolute = true;
        const par = c.parent;
        const sibs = par && Array.isArray(par.children) ? par.children : [];
        const nFixed = par && typeof par.fixedChildren === "number" ? par.fixedChildren : 0;
        if (par && (fixedNodes.has(par) || nFixed > 0 && sibs.indexOf(n) >= sibs.length - nFixed)) {
          fixedNodes.add(n);
          spec.fixed = true;
        }
        if (spec.drawnState) stateOf.set(n, inherited || { state: spec.drawnState, why: spec.drawnStateWhy || "", from: n.name || n.id, fromId: n.id });
        if (checkable(spec)) nodes.push(spec);
        else {
          const g11 = gaps.filter((g) => g.field === "border-radius" || g.field.startsWith("padding ("));
          if (g11.length) gaps.push({
            nodeId: n.id,
            name: n.name,
            field: "node",
            value: null,
            why: gaps.some((g) => g.field === "border-radius") ? "node not checked: it draws nothing (no fill, stroke, effect or clip) \u2014 its radius was its only stated value" : `node not checked: every value it states is excluded by method (${g11.map((g) => g.field).join(", ")})`
          });
        }
        notComparable.push(...gaps);
        if (n.type === "INSTANCE" && n.mainComponent) {
          instances.push({
            nodeId: n.id,
            name: n.name,
            setName: n.mainComponent.setName || n.mainComponent.name,
            ...ifDefined("setKey", n.mainComponent.setKey || n.mainComponent.key),
            ...ifDefined("variant", n.mainComponent.variant),
            ...ifDefined("props", n.props || void 0)
          });
        }
        for (const r of Array.isArray(n.reactions) ? n.reactions : []) {
          const trigger = triggerOf(r);
          for (const a of actionsOf(r)) {
            const row = {
              nodeId: n.id,
              name: n.name,
              trigger,
              ...ifDefined("action", a.navigation || a.type),
              ...ifDefined("destinationId", a.destinationId),
              ...ifDefined("destination", a.destination)
            };
            interactions.push(row);
            interactionFile.set(row, sourceFile ?? "");
          }
        }
      });
    }
  }
  const planIn = opts && opts.plan;
  let planInteractions;
  if (planIn && Array.isArray(planIn.plan.interactions)) {
    const dropped = [];
    const keys = new Set(interactions.map((r) => `${r.nodeId}|${r.trigger}`));
    const hiddenIds = new Set(hidden.ids);
    let merged = 0;
    planIn.plan.interactions.forEach((raw, k) => {
      const at = `interactions[${k}]`;
      const o = isJsonObject(raw) ? raw : null;
      const id = o && typeof o.nodeId === "string" && o.nodeId.trim() ? o.nodeId.trim() : null;
      const drop = (why) => {
        dropped.push({ nodeId: id ?? `(${at})`, why });
      };
      if (!o) return drop(`${at} is not an object`);
      if (id === null) return drop(`${at} has no nodeId \u2014 a plan interaction is keyed by its node like an export reaction`);
      if (typeof o.trigger !== "string" || !o.trigger.trim()) return drop("no trigger (on_click, on_press, \u2026)");
      if (!isPlanExpect(o.expect)) return drop(`expect ${JSON.stringify(o.expect ?? null)} is not dialog | url | selector:<css>`);
      if (o.destinationId !== void 0 && (typeof o.destinationId !== "string" || !o.destinationId.trim())) return drop("destinationId is not a node id");
      if (o.expect === "dialog" && o.destinationId === void 0) return drop("expect dialog needs the destinationId of the frame it opens (its root is tagged with it)");
      const node = visibleById.get(id);
      if (!node) return drop(hiddenIds.has(id) ? "the node is a hidden layer \u2014 it is not built or driven" : "no visible node of this export has that id");
      const trigger = o.trigger.trim().toLowerCase();
      if (o.expect === "dialog" && trigger !== "on_click" && trigger !== "on_press") return drop(`expect dialog needs trigger on_click or on_press (the probe opens a dialog by clicking its opener), not ${trigger}`);
      if (keys.has(`${id}|${trigger}`)) return drop(`duplicates ${interactions.some((r) => r.nodeId === id && r.trigger === trigger && r.source !== "plan") ? "the export's own interaction" : "an earlier plan row"} for this node and trigger (${trigger})`);
      keys.add(`${id}|${trigger}`);
      const destinationId = typeof o.destinationId === "string" ? o.destinationId.trim() : void 0;
      const row = { nodeId: id, name: node.name, trigger, action: actionForExpect(o.expect), expect: o.expect, ...ifDefined("destinationId", destinationId), source: "plan" };
      interactions.push(row);
      interactionFile.set(row, node.file);
      merged++;
    });
    planInteractions = { plan: planIn.file, sha256: planInteractionsSha256(planIn.plan), merged, dropped };
  }
  const specById = new Map(nodes.map((s) => [s.nodeId, s]));
  for (const r of roots) markRepeatedText(r, specById);
  const index = opts && opts.index;
  const unnamedIds = idsByFile.get("");
  const candidatesFor = (file) => candidatesOf(file)?.rows ?? null;
  function candidatesOf(file) {
    if (!index) return null;
    const own = rootsByFile.get(file);
    const sameName = (l) => {
      const names = own?.get(l.id);
      return !!names && (!names.size || l.name === void 0 || names.has(l.name));
    };
    const covering = own ? index.layers.filter((l) => sameName(l) && (file === "" || !l.sourceFile || l.sourceFile === file)) : [];
    if (!covering.length) return null;
    let f = file;
    if (f === "") {
      const named = new Set(covering.map((l) => l.sourceFile).filter((x) => !!x));
      if (named.size > 1) return null;
      if (named.size === 0 || covering.some((l) => !l.sourceFile)) return { rows: index.layers, resolved: null };
      f = [...named][0] ?? "";
    }
    return { rows: index.layers.filter((l) => !l.sourceFile || l.sourceFile === f), resolved: f || null };
  }
  for (const row of interactions) {
    const file = interactionFile.get(row);
    if (!row.destinationId || file === void 0 || String(row.action).toLowerCase() === "change_to") continue;
    const known = idsByFile.get(file);
    if (!known || known.has(row.destinationId) || unnamedIds && unnamedIds.has(row.destinationId)) continue;
    const candidates = candidatesFor(file);
    if (candidates && !candidates.some((l) => l.id === row.destinationId)) row.destinationExported = false;
  }
  const readSibling = opts && opts.readSibling;
  const siblingCache = /* @__PURE__ */ new Map();
  const sibling = (file) => {
    if (!readSibling) return null;
    if (!siblingCache.has(file)) siblingCache.set(file, readSibling(file) ?? null);
    return siblingCache.get(file) ?? null;
  };
  if (index && readSibling) {
    const ownRootIds = new Set(roots.map((r) => r.id));
    const specSuffixes = new Set(nodes.map((n) => idSuffix(n.nodeId)).filter((x) => x !== null));
    const aliases = /* @__PURE__ */ new Map();
    for (const [file, fileRoots] of rootNodesByFile) {
      const co = candidatesOf(file);
      if (!co) continue;
      const cands = co.rows;
      const own = shellIndex(fileRoots);
      if (!own.size) continue;
      const read = /* @__PURE__ */ new Set();
      for (const row of cands) {
        if (ownRootIds.has(row.id) || !row.file || read.has(row.file)) continue;
        read.add(row.file);
        const sib = sibling(row.file);
        if (!sib) continue;
        const sx = screenExportOf(sib);
        const sibFile = "sourceFile" in sib ? sib.sourceFile : sx ? sx.sourceFile : void 0;
        if (co.resolved && typeof sibFile === "string" && sibFile && sibFile !== co.resolved) continue;
        const theirs = shellIndex(screenRoots(sib));
        for (const [key, mine] of own) {
          const other = theirs.get(key);
          const a = mine.length === 1 ? mine[0] : void 0, b = other && other.length === 1 ? other[0] : void 0;
          if (!a || !b) continue;
          for (const [p, mine1] of a) {
            const their1 = b.get(p);
            if (!mine1 || !their1 || mine1.sig !== their1.sig) continue;
            const id = mine1.id, sid = their1.id;
            if (sid === id) continue;
            const s2 = idSuffix(sid);
            if (s2 !== null && specSuffixes.has(s2)) continue;
            getOrInit(aliases, id, () => /* @__PURE__ */ new Set()).add(sid);
          }
        }
      }
    }
    for (const [id, set] of aliases) {
      const sp = specById.get(id);
      if (sp) sp.aliases = [...set].sort();
    }
  }
  const destinationRoot = (destId, file) => {
    const own = [...rootNodesByFile.get(file) ?? [], ...file !== "" ? rootNodesByFile.get("") ?? [] : []].find((r) => r.id === destId);
    if (own) return own;
    const co = candidatesOf(file);
    for (const row of co ? co.rows : []) {
      if (row.id !== destId || !row.file) continue;
      const sib = sibling(row.file);
      if (!sib) continue;
      const sx = screenExportOf(sib);
      const sibFile = "sourceFile" in sib ? sib.sourceFile : sx ? sx.sourceFile : void 0;
      if (co && co.resolved && typeof sibFile === "string" && sibFile && sibFile !== co.resolved) continue;
      const hit = screenRoots(sib).find((r) => r.id === destId);
      if (hit) return hit;
    }
    return void 0;
  };
  for (const row of interactions) {
    const act = String(row.action).toLowerCase();
    if (!row.destinationId || act !== "overlay" && act !== "swap" || row.destinationExported === false) continue;
    const dest = destinationRoot(row.destinationId, interactionFile.get(row) ?? "");
    if (!dest) continue;
    const ov = dest.overlay;
    row.overlay = {
      position: ov && typeof ov.position === "string" ? ov.position : "center",
      closeOnClickOutside: !!ov && ov.closeOnClickOutside === true,
      background: ov && typeof ov.background === "string" ? ov.background : null,
      from: ov ? "export" : "default"
    };
  }
  const f0 = frames[0] || {};
  const readReference = opts && opts.readReference;
  let referenceImage;
  if (readReference) {
    const first = roots[0];
    const firstFile = first ? [...rootNodesByFile].find(([, rs]) => rs.includes(first))?.[0] : void 0;
    referenceImage = referenceImageFor({
      reference,
      root: first,
      sourceFile: firstFile || void 0,
      rows: index ? index.layers : [],
      readReference,
      colorProfile: opts && typeof opts.colorProfile === "string" ? opts.colorProfile : null
    });
  }
  const rootFrame = (f) => ({ ...ifDefined("nodeId", f.nodeId), ...ifDefined("name", f.name), ...ifDefined("w", f.w), ...ifDefined("h", f.h), ...ifDefined("clip", f.clip), ...ifDefined("scroll", f.scroll) });
  return {
    schema: EXPECTATION_SCHEMA,
    ...ifDefined("screen", screen),
    ...ifDefined("exportedAt", exportedAt),
    // the design's identity without the pull's timestamps, so a no-change
    // re-pull (only `exportedAt` differs) is recognised as the same design by content, not by clock.
    exportContentSha256: exportContentSha256(docs.map((d) => d.doc)),
    reference,
    frame: rootFrame(f0),
    ...frames.length > 1 ? { frames: frames.map(rootFrame) } : {},
    coordinates: COORDINATES,
    note: "Generated from the export \u2014 do NOT retype these numbers into code comments. Every row is the value the design states; a field the export does not define is absent rather than defaulted. Layers the designer switched off (hidden: true on the node or an ancestor) have NO row: do not build, measure or drive them \u2014 their ids are listed under `hidden`. Feed this to a renderer probe and compare with `verify-screen.js --compare`; the probe's field names are listed under `measuredKeys`.",
    measuredKeys: MEASURED_KEYS_DOC,
    tolerance: TOLERANCE,
    counts: {
      nodes: nodes.length,
      instances: instances.length,
      interactions: interactions.length,
      notComparable: notComparable.length,
      hidden: { layers: hidden.roots.length, nodes: hidden.ids.length, specsSkipped: hidden.specsSkipped, instancesSkipped: hidden.instancesSkipped, interactionsSkipped: hidden.interactionsSkipped }
    },
    nodes,
    instances,
    interactions,
    notComparable,
    hidden: { roots: hidden.roots, ids: hidden.ids },
    ...ifDefined("planInteractions", planInteractions),
    ...ifDefined("referenceImage", referenceImage)
  };
}
var round4 = (n) => Math.round(n * 1e4) / 1e4;
function resolveInside(base, rel, within = base) {
  const root = path7.resolve(within), file = path7.resolve(base, ...rel.split("/"));
  return file.startsWith(root + path7.sep) ? file : null;
}
var figmaReferenceScale = (w, h) => Math.min(2, 2048 / (Math.max(w, h) || 1));
var REFERENCE_SCALE_SLACK = 0.02;
function referenceImageFor(o) {
  const { reference, root } = o;
  const unusable = (p2, why) => ({ usable: false, path: p2, why });
  if (!reference) return unusable(null, "the export has no reference PNG for this screen \u2014 re-pull it with its reference");
  const p = "design/export/" + reference;
  if (resolveInside(path7.resolve(EXPORT_DIR), reference) === null) return unusable(p, `the reference pointer ${reference} leads outside design/export \u2014 re-pull the screen`);
  if (!root || root.reference !== reference) return unusable(p, "the reference PNG belongs to another frame than the first one \u2014 only the first frame is diffed");
  const box = root.box;
  if (!box || !(num(box.w) && box.w > 0) || !(num(box.h) && box.h > 0)) return unusable(p, "the frame has no size in the export (box.w/h) \u2014 the reference cannot be placed");
  const bytes = o.readReference(reference);
  if (!bytes) return unusable(p, `the reference PNG ${p} is missing on disk \u2014 re-pull the screen`);
  const png = pngInfo(bytes);
  if (!png) return unusable(p, `the reference ${p} is not a PNG or is damaged \u2014 re-pull the screen`);
  if (png.bitDepth !== 8 || png.colorType !== 2 && png.colorType !== 6 || png.interlace !== 0)
    return unusable(p, `the reference ${p} is a PNG of colour type ${png.colorType} / depth ${png.bitDepth}${png.interlace ? " / interlaced" : ""} \u2014 the visual diff reads 8-bit RGB/RGBA, non-interlaced`);
  if (!png.w || !png.h) return unusable(p, `the reference ${p} is an empty PNG`);
  const row = o.rows.find((r) => r.id === root.id && (!r.sourceFile || !o.sourceFile || r.sourceFile === o.sourceFile) && r.reference === reference && num(r.referenceScale) && r.referenceScale > 0);
  const rb = root.renderBox && num(root.renderBox.w) && root.renderBox.w > 0 ? root.renderBox : void 0;
  const exportOffset = !rb ? { x: 0, y: 0 } : num(rb.x) && num(rb.y) && num(box.x) && num(box.y) ? { x: rb.x - box.x, y: rb.y - box.y } : null;
  const rowOffset = row && row.referenceOffset && num(row.referenceOffset.x) && num(row.referenceOffset.y) ? { x: row.referenceOffset.x, y: row.referenceOffset.y } : null;
  const scale = row && num(row.referenceScale) ? row.referenceScale : round4(png.w / (rb ? rb.w : box.w));
  const offset = rowOffset ?? exportOffset;
  if (!offset) return unusable(p, "the export root has render bounds but no position (box.x/y) \u2014 where the reference sits over the frame is unknown");
  const s0 = figmaReferenceScale(box.w, box.h), onDisk = png.w / (rb ? rb.w : box.w);
  if (![scale, onDisk].every((v) => Math.abs(v - s0) <= REFERENCE_SCALE_SLACK * s0))
    return unusable(p, `the reference is a ${png.w} px image, not the export reference (a discovery thumbnail) \u2014 re-pull the screen`);
  const refW = rb ? rb.w : box.w, refH = rb && num(rb.h) && rb.h > 0 ? rb.h : box.h;
  const ew = Math.round(refW * scale), eh = Math.round(refH * scale), tolH = 2 + Math.floor(refH * (1 / refW + 5e-5));
  if (Math.abs(png.w - ew) > 2 || Math.abs(png.h - eh) > tolH)
    return unusable(p, `the reference ${p} is ${png.w}\xD7${png.h} px, but the frame's render bounds at ${scale}x are ${ew}\xD7${eh} \u2014 a stale or foreign PNG under the pointer; re-pull the screen, then re-run --expect`);
  const x = Math.min(Math.max(0, Math.round(-offset.x * scale)), png.w), y = Math.min(Math.max(0, Math.round(-offset.y * scale)), png.h);
  const crop = { x, y, w: Math.max(0, Math.min(Math.round(box.w * scale), png.w - x)), h: Math.max(0, Math.min(Math.round(box.h * scale), png.h - y)) };
  const profiles = [o.colorProfile === "display_p3" ? "display_p3" : null, png.iccp !== null ? `iCCP:${png.iccp || "unnamed"}` : null].filter((v) => v !== null);
  return {
    usable: true,
    path: p,
    sha256: sha256Hex(bytes),
    png: { w: png.w, h: png.h },
    scale,
    offset,
    from: row ? "index" : "export",
    crop,
    ...profiles.length ? { colorProfile: profiles.join(" + ") } : {}
  };
}
var KNOWN_NODE_KEYS = /* @__PURE__ */ new Set([
  "nodeId",
  "styles",
  "states",
  "matchedBy",
  "note",
  "notes",
  "selector",
  "selectorCount",
  "unmeasured",
  "textFrom",
  "textFromMixed",
  "fillSource"
]);
var KNOWN_STYLE_KEYS = /* @__PURE__ */ new Set([
  "fontFamily",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "letterSpacing",
  "color",
  "backgroundColor",
  "fill",
  "borderColor",
  "borderWidth",
  "borderRadius",
  "gap",
  "gapVisual",
  "width",
  "height",
  "x",
  "y",
  "opacity",
  "padding",
  "text",
  "placeholderText",
  "placeholderColor",
  "tag",
  "textBox",
  "display",
  "transform",
  "rotate",
  "visible",
  // where the probe read borderWidth/borderColor (a real border, or a ring drawn by box-shadow/outline)
  "strokeFrom",
  "strokeAlign",
  // a TEXT's computed text-transform; who paints a transparent element (optional keys)
  "textTransform",
  "paintedBy",
  // free text, never read for a judgement — tolerated on either level
  "note",
  "notes"
]);
var KNOWN_MEASURED_KEYS = /* @__PURE__ */ new Set([...KNOWN_NODE_KEYS, ...KNOWN_STYLE_KEYS]);
var KEY_HINTS = {
  radius: "borderRadius",
  borderTopLeftRadius: "borderRadius",
  background: "backgroundColor",
  bg: "backgroundColor",
  w: "width",
  h: "height",
  svgFill: "fill",
  placeholder: "placeholderText",
  rowGap: "gapVisual",
  columnGap: "gap",
  // a node-level key written INSIDE styles is not read there (a styles.fillSource "img" would not exempt the fill)
  ...Object.fromEntries([...KNOWN_NODE_KEYS].filter((k) => k !== "nodeId" && k !== "styles" && k !== "note" && k !== "notes").map((k) => [k, `nodes[].${k} (beside styles, not inside)`]))
};
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
var TOKEN_KEYS = {
  color: ["fills", "color"],
  backgroundColor: ["fills"],
  fill: ["fills"],
  placeholderColor: ["fills"],
  borderColor: ["strokes"],
  borderWidth: ["strokeWeight", "strokeTopWeight"],
  fontSize: ["fontSize"],
  fontWeight: ["fontWeight"],
  fontFamily: ["fontFamily"],
  lineHeight: ["lineHeight"],
  letterSpacing: ["letterSpacing"],
  gap: ["itemSpacing", "gap"],
  width: ["width", "minWidth"],
  height: ["height", "minHeight"],
  opacity: ["opacity"],
  padding: ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"],
  "radius.tl": ["topLeftRadius"],
  "radius.tr": ["topRightRadius"],
  "radius.br": ["bottomRightRadius"],
  "radius.bl": ["bottomLeftRadius"],
  borderRadius: ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius", "cornerRadius"]
};
function tokenFor(spec, key) {
  const t = spec && spec.tokens;
  if (!t) return void 0;
  const names = [...new Set((TOKEN_KEYS[key] || []).map((k) => t[k]).filter((v) => typeof v === "string"))];
  return names.length ? names.join(" / ") : void 0;
}
function compareField(f, want, got) {
  const nw = f.norm ? f.norm(want) : want;
  const ng = f.norm ? f.norm(got) : got;
  if (nw == null || ng == null) return null;
  if (f.tol == null) return nw === ng ? null : { want: nw, got: ng, delta: null };
  const a = Number(nw), b = Number(ng);
  if (Number.isNaN(a) || Number.isNaN(b)) return nw === ng ? null : { want: nw, got: ng, delta: null };
  const delta = Math.abs(a - b);
  return delta <= f.tol ? null : { want: a, got: b, delta: Number(delta.toFixed(3)) };
}
function comparePadding(want, got, skip) {
  if (!Array.isArray(want)) return null;
  const w = want.map(Number);
  if (w.some(Number.isNaN)) return null;
  const worst = Math.max(0, ...w.map((v, i) => skip && skip.includes(PAD_SIDES[i] ?? "") ? 0 : Math.abs(v - (got[i] ?? 0))));
  return worst <= TOLERANCE.padding ? null : { want: w, got: [...got], delta: Number(worst.toFixed(3)) };
}
function radiusCorners(v) {
  return v == null ? null : fourSides(v);
}
var clampRadius = (r, w, h) => num(w) && num(h) && w > 0 && h > 0 ? Math.min(r, Math.min(w, h) / 2) : r;
var TABLE_TAGS = /* @__PURE__ */ new Set(["table", "thead", "tbody", "tfoot", "tr"]);
var ROW_TAGS = /* @__PURE__ */ new Set(["tr", "thead", "tbody", "tfoot"]);
var ROW_RADIUS_WHY = "a table row/row-group does not draw border-radius \u2014 report the corner cells' radii under this id, or tag the cells";
var INLINE_BOX_FIELDS = /* @__PURE__ */ new Set(["width", "height", "x", "y", "borderRadius"]);
var inlineWhy = (tag) => `the id sits on an inline <${tag || "element"}>, whose box is its text's \u2014 tag the element that owns the box`;
var cssBorderWidth = (d) => d <= 0 ? 0 : d < 1 ? 1 : Math.floor(d);
var isPaintedBy = (x) => isJsonObject(x) && typeof x.backgroundColor === "string" && (x.via === "ancestor" || x.via === "child") && typeof x.tag === "string" && typeof x.depth === "number" && (x.dt === void 0 || typeof x.dt === "string");
function applyFigmaCase(t, c) {
  if (c === "upper") return t.toUpperCase();
  if (c === "lower") return t.toLowerCase();
  if (c === "title") return t.toLowerCase().replace(/(^|\s)(\S)/gu, (_m, sp, ch) => sp + ch.toUpperCase());
  return t;
}
function applyCssTransform(t, tt) {
  const v = tt.trim().toLowerCase();
  if (v === "none") return t;
  if (v === "uppercase") return t.toUpperCase();
  if (v === "lowercase") return t.toLowerCase();
  if (v === "capitalize") return t.replace(/(^|[\s\-\u2010-\u2015])([^\p{L}\p{N}\s\-]*)([\p{L}\p{N}])/gu, (_m, b, punct, ch) => b + punct + ch.toUpperCase());
  return null;
}
function renderedText(stored, textCase, built, transform, norm) {
  const designed = applyFigmaCase(stored, textCase);
  const tt = typeof transform === "string" ? transform : null;
  const shown = tt !== null ? applyCssTransform(built, tt) : null;
  if (shown !== null) return { want: designed, have: shown, same: norm(designed) === norm(shown), transform: tt };
  const want = norm(built) === norm(stored) ? stored : designed;
  return { want, have: built, same: norm(want) === norm(built), transform: null };
}
var CONTAINER_TAGS = /* @__PURE__ */ new Set(["th", "td", "tr", "button", "label", "li", "a", "section", "article", "header", "footer", "nav", "table", "input"]);
var LEAF_TAGS = /* @__PURE__ */ new Set(["input", "textarea", "select", "img", "svg", "path", "video", "canvas"]);
var CONTAINER_TYPES = /* @__PURE__ */ new Set(["FRAME", "INSTANCE", "COMPONENT", "GROUP", "SECTION"]);
var PIXEL_TAGS = /* @__PURE__ */ new Set(["img", "picture", "canvas", "object", "embed"]);
var NON_NEGATIVE = /* @__PURE__ */ new Set(["fontSize", "lineHeight", "borderWidth", "gap", "width", "height", "opacity"]);
var LEAF_FIELDS = /* @__PURE__ */ new Set(["width", "height", "x", "y", "backgroundColor", "borderColor", "borderWidth", "borderRadius", "gap"]);
var isContainer = (got) => !!(got.tag && CONTAINER_TAGS.has(String(got.tag).toLowerCase()) || Array.isArray(got.padding) && got.padding.some((v) => (cssPx(v) ?? 0) > 0));
var LIMITS = [
  "::before/::after content and any other pseudo-element are invisible to a computed-style probe; the export cannot say which layers a build draws that way, so they are compared only if the probe reports them under the node's id.",
  "::placeholder colour is compared only when the probe reports placeholderColor (getComputedStyle(el,'::placeholder') or the stylesheet rule); otherwise it is listed under `unverifiable`, never passed.",
  "A <table> with border-spacing (border-collapse: separate) also puts that spacing between its edge and the outer rows \u2014 above the first and below the last (CSS 2.1 \xA717.6.1): a container-height delta of twice the spacing is the table model, not a layout bug.",
  "A rotation applied with the CSS `rotate` property reads `transform: none` (Tailwind v4 `rotate-180`) \u2014 read `rotate` too before calling a rotation missing.",
  "An icon drawn by an <img> (or <canvas>, <object>) has no readable fill: the SVG inside is a separate document, so its fill is listed under `unverifiable` \u2014 compare the asset file instead.",
  'Numbers are read as px: a number or a px string ("20px"). A percentage, another unit or a keyword (other than letter-spacing: normal = 0) is listed as not measured; so is a value CSS cannot produce (a negative gap, padding or size).',
  "Positions are compared only where the export states one (absolute layers, render/ink boxes); auto-layout children are placed by their parent, whose position is compared.",
  "A TEXT node's height is not compared (neither a Range nor its element gives the line box Figma's text box has), and the width of text the design truncates is not either (a Range spans the unclipped string). A fixed- or fill-width text is compared at its ink width within 3px \u2014 an empirical bound (field runs: \u22120.6\u2026+2.4px); heavy italics or overhanging glyphs may exceed it.",
  "A transparent element's background is compared through the element that paints it (paintedBy): its only same-box child, else its nearest painting ancestor that holds it. A sibling or an absolutely positioned overlay painting over it is not seen \u2014 when the ancestor's colour is the designed one the node may PASS although the overlay shows another; a transparent element whose own children paint all of it gets no painter (compared as transparent).",
  "Border widths are compared as CSS draws them: Chromium floors a computed border width to whole px, at least 1 (a 1.5px stroke is a 1px border). A ring (box-shadow spread, outline) is compared with the design's own width.",
  "Severity follows the match: a node matched by position or a non-canonical rule is at most low, by text-ordinal or another screen's id (tag-alias) at most medium; a matched element far from the design's size gets one 'match (size)' row and its other deltas are capped at low (cappedFrom keeps the original, cappedBy says which cap). An open capped delta blocks a plain pass (verdict incomplete, never fail on its own); a waiver on 'match (size)' lifts only the size cap \u2014 a match-confidence cap stays."
];
function fieldTolerance(label) {
  const f = FIELDS.find((x) => x.label === label);
  if (f) return f.tol;
  if (label === "padding") return TOLERANCE.padding;
  if (label.startsWith("border-radius (")) return TOLERANCE.radius;
  if (label === "placement") return TOLERANCE.position;
  if (label === "width (text ink)") return TOLERANCE.textInk;
  if (label === "match (size)") return TOLERANCE.size;
  if (label === "overflowX") return TOLERANCE.position;
  return null;
}
var fieldBase = (f) => f.replace(/\s*\(.*\)$/, "");
var INTEGRITY_PHRASES = {
  otherExpectation: "the measurements were taken against a DIFFERENT expectation",
  noExpectation: "measured file names no expectation (expectationSha256)",
  unfinished: "\u2014 the verifier had not finished",
  otherMeasured: "names a different measured file",
  unrecorded: "no status of that run records it",
  measuredBefore: "was measured before that run ended"
};
var isIntegrityReason = (w) => Object.values(INTEGRITY_PHRASES).some((p) => w.includes(p));
function excludedNow(d, nc) {
  const rows = nc.filter((g) => g.nodeId === d.nodeId && fieldBase(g.field) === fieldBase(d.field));
  if (!rows.length) return void 0;
  if (d.field !== "padding") return rows[0];
  const skipped = new Set(rows.flatMap((g) => (/^padding \((.*)\)$/.exec(g.field)?.[1] ?? "").split("/")));
  const e = Array.isArray(d.expected) ? d.expected : [], a = Array.isArray(d.actual) ? d.actual : [];
  const differs = PAD_SIDES.filter((_, i) => {
    const x = e[i], y = a[i];
    return typeof x === "number" && typeof y === "number" && Math.abs(x - y) > TOLERANCE.padding;
  });
  return differs.length && differs.every((sd) => skipped.has(sd)) ? rows[0] : void 0;
}
function deltaChanges(prev, cur, now) {
  const keyOf = (d) => typeof d.nodeId === "string" && typeof d.field === "string" ? `${d.nodeId}\0${d.field}` : null;
  const curByKey = /* @__PURE__ */ new Map();
  for (const d of cur) {
    const k = keyOf(d);
    if (k !== null && !curByKey.has(k)) curByKey.set(k, d);
  }
  const prevByKey = /* @__PURE__ */ new Map();
  for (const d of prev) {
    const k = isJsonObject(d) ? keyOf(d) : null;
    if (k !== null && !prevByKey.has(k)) prevByKey.set(k, d);
  }
  const out = { fixed: 0, new: 0, unchanged: 0, lostCoverage: [] };
  const was = (d) => d.actual === void 0 ? null : d.actual;
  if (now.sameMeasured) {
    const reclassified = [];
    for (const [k, d] of curByKey) if (!prevByKey.has(k)) reclassified.push({ nodeId: d.nodeId, field: d.field, change: "new", was: null });
    for (const [k, d] of prevByKey) {
      if (curByKey.has(k)) out.unchanged++;
      else if (now.specIds.has(d.nodeId) || d.field === "overflowX") reclassified.push({ nodeId: d.nodeId, field: d.field, change: "gone", was: was(d) });
    }
    return { ...out, sameMeasured: true, reclassified };
  }
  for (const k of curByKey.keys()) if (!prevByKey.has(k)) out.new++;
  const unmeasuredNodes = new Set(now.notMeasured.map((n) => n.nodeId));
  const nowUnverifiable = [];
  const sameField = (g, d) => g.nodeId === d.nodeId && (g.field === d.field || fieldBase(g.field) === fieldBase(d.field));
  for (const [k, d] of prevByKey) {
    if (curByKey.has(k)) {
      out.unchanged++;
      continue;
    }
    if (d.field === "overflowX") {
      const po = now.pageOverflow;
      if (po === void 0 || po === "not measured" || po === "not at design width") out.lostCoverage.push({ nodeId: d.nodeId, field: d.field, was: was(d), why: po === "not at design width" ? "the page was not measured at the design width this round" : "page overflow was not measured this round" });
      else if (po === "designed to scroll") nowUnverifiable.push({ nodeId: d.nodeId, field: d.field, was: was(d), why: "the frame is designed to scroll sideways now" });
      else if (po === "clipped") nowUnverifiable.push({ nodeId: d.nodeId, field: d.field, was: was(d), why: "the page is still wider than the design width but clips it now (overflow-x hidden/clip) \u2014 clipped, not fixed" });
      else out.fixed++;
      continue;
    }
    if (!now.specIds.has(d.nodeId)) continue;
    if (unmeasuredNodes.has(d.nodeId)) {
      out.lostCoverage.push({ nodeId: d.nodeId, field: d.field, was: was(d), why: "the node was not measured this round" });
      continue;
    }
    const gapRow = now.fieldsNotMeasured.find((g) => sameField(g, d));
    const absent = gapRow ? now.absent.has(`${gapRow.nodeId}\0${gapRow.field}`) : now.absent.has(k) || [...now.absent].some((a) => a.startsWith(`${d.nodeId}\0`) && fieldBase(a.slice(d.nodeId.length + 1)) === fieldBase(d.field));
    if (absent) {
      out.lostCoverage.push({ nodeId: d.nodeId, field: d.field, was: was(d), why: `not measured this round: ${gapRow ? gapRow.why : "the probe did not report this property"}` });
      continue;
    }
    const derived = d.field === "placement" ? now.placementGaps?.get(d.nodeId) : void 0;
    if (derived && derived.absent) {
      out.lostCoverage.push({ nodeId: d.nodeId, field: d.field, was: was(d), why: `not measured this round: ${derived.why}` });
      continue;
    }
    if (derived) {
      nowUnverifiable.push({ nodeId: d.nodeId, field: d.field, was: was(d), why: derived.why });
      continue;
    }
    const method = gapRow ?? now.unverifiable.find((g) => sameField(g, d)) ?? excludedNow(d, now.notComparable || []);
    if (method) {
      nowUnverifiable.push({ nodeId: d.nodeId, field: d.field, was: was(d), why: method.why });
      continue;
    }
    out.fixed++;
  }
  return nowUnverifiable.length ? { ...out, nowUnverifiable } : out;
}
var NUM_IN_TEXT = /-?\d+(?:\.\d+)?/g;
function sameWithin(a, b, tol) {
  const t = tol ?? 0;
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= t + 1e-9;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => {
    const y = b[i];
    return y !== void 0 && sameWithin(x, y, tol);
  });
  if (typeof a === "string" && typeof b === "string") {
    if (tol == null) return a.trim() === b.trim();
    if (a.replace(NUM_IN_TEXT, "#") !== b.replace(NUM_IN_TEXT, "#")) return false;
    const na = a.match(NUM_IN_TEXT) || [], nb = b.match(NUM_IN_TEXT) || [];
    return na.length === nb.length && na.every((x, i) => Math.abs(Number(x) - Number(nb[i])) <= t + 1e-9);
  }
  return JSON.stringify(a) === JSON.stringify(b);
}
var PAINT_KEYS = ["decorated", "text", "placeholderText", "fontSize", "color", "backgroundColor", "fill", "borderColor", "borderWidth", "borderWidths", "borderRadius", "radiusCorners", "opacity"];
var paintOf = (s) => PAINT_KEYS.filter((k) => s[k] !== void 0);
var MATCH_BUCKET = {
  tag: "tag",
  "data-dt-node": "tag",
  id: "tag",
  "tag-shared-path": "tagSharedPath",
  "tag-alias": "tagAlias",
  text: "text",
  "text-ordinal": "textOrdinal",
  position: "position",
  frame: "frame"
};
var MATCH_BUCKETS = ["tag", "tagSharedPath", "tagAlias", "text", "textOrdinal", "position", "frame", "sharedComponentPath", "other", "unstated"];
var MATCH_LABEL = {
  tag: "tag",
  tagSharedPath: "shared path",
  tagAlias: "alias",
  text: "text",
  textOrdinal: "ordinal",
  position: "position",
  frame: "frame",
  sharedComponentPath: "shared component path",
  other: "other",
  unstated: "unstated"
};
var CANONICAL_MATCH = new Set(CANONICAL_MATCHED_BY);
var MATCH_SYNONYM = { "data-dt-node": "tag", id: "tag" };
var NO_CAP = /* @__PURE__ */ new Set(["tag", "tag-shared-path", "text", "frame"]);
var MEDIUM_CAP = /* @__PURE__ */ new Set(["text-ordinal", "tag-alias"]);
var TYPO_FIELDS = /* @__PURE__ */ new Set(["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "color"]);
var SEVERITY_RANK = { high: 0, medium: 1, low: 2 };
var NEVER_MEASURED_HEADLINE_MIN = 2;
var MEASURED_TOP_KEYS = {
  measuredAt: true,
  renderer: true,
  viewport: true,
  theme: true,
  artifacts: true,
  expectationSha256: true,
  mode: true,
  reason: true,
  nodes: true,
  components: true,
  interactions: true,
  consoleErrors: true,
  notMeasured: true,
  componentsMissing: true,
  probe: true,
  frame: true,
  frames: true,
  navigation: true,
  matchedByCensus: true,
  notes: true,
  runId: true,
  build: true,
  tagsNotInExpectation: true,
  reach: true,
  page: true,
  behaviour: true,
  visual: true
};
var MEASURED_UNTYPED_TOP_KEYS = /* @__PURE__ */ new Set(["inferred"]);
var TOP_KEY_HINTS = { notFound: "notMeasured", notFoundInDom: "notMeasured", notMeasuredByProbe: "notMeasured", missing: "notMeasured", measurements: "nodes", elements: "nodes", navEvents: "navigation" };
var INTERACTION_OUTCOMES = ["url-changed", "dialog-opened", "selector-appeared", "state-changed", "none"];
var ANY_BUT_NONE = INTERACTION_OUTCOMES.filter((o) => o !== "none");
var OUTCOMES_FOR_ACTION = {
  navigate: ["url-changed", "selector-appeared"],
  overlay: ["dialog-opened", "selector-appeared"],
  change_to: ["state-changed", "selector-appeared"],
  swap: ["state-changed", "selector-appeared"],
  other: ANY_BUT_NONE
};
var URL_ACTIONS = /* @__PURE__ */ new Set(["navigate", "back", "url"]);
var isOutcome = (x) => typeof x === "string" && INTERACTION_OUTCOMES.some((o) => o === x);
function outcomesFor(action) {
  return action === "navigate" || action === "overlay" || action === "change_to" || action === "swap" ? OUTCOMES_FOR_ACTION[action] : OUTCOMES_FOR_ACTION.other;
}
function evidenceGaps(hit, action) {
  const gaps = [];
  const count = Number(hit.selectorCount);
  if (!hit.selector) gaps.push("no selector named");
  else if (!(count >= 1)) gaps.push(`selector '${hit.selector}' matched ${Number.isFinite(count) ? count : "an unreported number of"} element(s)`);
  else if (count !== 1) gaps.push(`selector '${hit.selector}' matched ${count} elements \u2014 which one was driven? (needs exactly 1)`);
  const allowed = outcomesFor(action);
  if (hit.outcome === void 0) gaps.push("no outcome recorded (url-changed | dialog-opened | selector-appeared | state-changed | none)");
  else if (!isOutcome(hit.outcome)) gaps.push(`outcome '${String(hit.outcome)}' is not one of ${INTERACTION_OUTCOMES.join(" | ")}`);
  else if (!allowed.includes(hit.outcome)) gaps.push(`outcome '${hit.outcome}' is not what ${action ? `${/^[aeiou]/.test(action) ? "an" : "a"} ${action}` : "this action"} does (${allowed.join(" or ")})`);
  const nav = hit.navEvents;
  if (nav === void 0) gaps.push("no navEvents recorded (documents loaded during the interaction: a reload or a full navigation)");
  else if (typeof nav !== "number" || !Number.isInteger(nav) || nav < 0) gaps.push(`navEvents ${JSON.stringify(nav)} is not a count`);
  else if (nav > 0 && !(action !== void 0 && URL_ACTIONS.has(action) && hit.outcome === "url-changed")) gaps.push(`${nav} document(s) loaded during the interaction (a reload or a full navigation) \u2014 a reload is not an outcome${hit.outcome === "url-changed" ? `; only a navigate, back or url action may load a document` : ""}`);
  return gaps;
}
function compare(expectation, measured, opts) {
  opts = opts || {};
  measured = measured || {};
  const hiddenSet = new Set((expectation.hidden && expectation.hidden.ids || []).map(String));
  const legacy2 = expectation.schema !== EXPECTATION_SCHEMA;
  const specs = (expectation.nodes || []).filter((s) => !hiddenSet.has(String(s.nodeId)));
  const frameOf = (spec) => spec.frameId && (expectation.frames || []).find((f) => f.nodeId === spec.frameId) || expectation.frame || {};
  const byId = /* @__PURE__ */ new Map();
  let duplicateNodeIds = 0;
  const unknownKeys = /* @__PURE__ */ new Map();
  const keysSeen = /* @__PURE__ */ new Set();
  for (const m of measured.nodes || []) {
    if (!m || m.nodeId == null) continue;
    const id = String(m.nodeId);
    if (byId.has(id)) {
      duplicateNodeIds++;
      continue;
    }
    byId.set(id, m);
    const s = m.styles || m;
    const known = m.styles ? KNOWN_STYLE_KEYS : KNOWN_MEASURED_KEYS;
    for (const k of Object.keys(s)) {
      keysSeen.add(k);
      if (!known.has(k)) unknownKeys.set(k, (unknownKeys.get(k) || 0) + 1);
    }
  }
  const expectedIds = /* @__PURE__ */ new Set([...specs.map((s) => String(s.nodeId)), ...(expectation.instances || []).map((i) => String(i.nodeId))]);
  const suffix = (id) => {
    const i = id.indexOf(";");
    return i === -1 ? null : id.slice(i + 1);
  };
  const foreignBySuffix = /* @__PURE__ */ new Map();
  for (const id of byId.keys()) {
    if (expectedIds.has(id) || hiddenSet.has(id)) continue;
    const sfx = suffix(id);
    if (sfx) foreignBySuffix.set(sfx, (foreignBySuffix.get(sfx) || []).concat(id));
  }
  const viaSharedPath = (id) => {
    const sfx = suffix(String(id));
    const c = sfx && foreignBySuffix.get(sfx);
    const only = c && c.length === 1 ? c[0] : void 0;
    return only ?? null;
  };
  const probeWhy = /* @__PURE__ */ new Map();
  for (const e of Array.isArray(measured.notMeasured) ? measured.notMeasured : []) {
    const row = e;
    if (!isJsonObject(row) || typeof row.nodeId !== "string") continue;
    const w = typeof row.why === "string" ? row.why : typeof row.reason === "string" ? row.reason : void 0;
    if (w && !probeWhy.has(row.nodeId)) probeWhy.set(row.nodeId, w);
  }
  const deltas = [];
  const notMeasured = [];
  const fieldsNotMeasured = [];
  const unverifiable = [];
  const census = /* @__PURE__ */ new Map();
  const tally = (key, present) => {
    const c = census.get(key) || { expected: 0, present: 0 };
    c.expected++;
    if (present) c.present++;
    census.set(key, c);
  };
  let fieldsChecked = 0, nodesMeasured = 0, nodesMatchedByComponentPath = 0, fieldsReportedNull = 0;
  const matchedByCensus = Object.fromEntries(MATCH_BUCKETS.map((b) => [b, 0]));
  const typographyOn = /* @__PURE__ */ new Map();
  const matchKind = /* @__PURE__ */ new Map();
  const matchCapOf = /* @__PURE__ */ new Map();
  const absentGaps = /* @__PURE__ */ new Set();
  const placementGaps = /* @__PURE__ */ new Map();
  const undrawnStates = [];
  const paintedVia = [];
  const lineBoxWhyOf = new Map((expectation.notComparable || []).filter((g) => g.field === TEXT_BOX_HEIGHT).map((g) => [g.nodeId, g.why]));
  const gap = (spec, field, why, absent = false) => {
    if (absent) absentGaps.add(`${spec.nodeId}\0${field}`);
    return fieldsNotMeasured.push({ nodeId: spec.nodeId, name: spec.name, field, why });
  };
  const push = (spec, field, severity, bad, extra) => deltas.push(Object.assign({
    severity,
    nodeId: spec.nodeId,
    name: spec.name,
    ...ifDefined("path", spec.path),
    field,
    expected: bad.want,
    actual: bad.got,
    delta: bad.delta
  }, extra));
  const anchors = opts.anchors && isJsonObject(opts.anchors) ? opts.anchors : {};
  const folded = [];
  const probeFrames = [...Array.isArray(measured.frames) ? measured.frames : [], ...measured.frame ? [measured.frame] : []];
  const multiFrame = (expectation.frames || []).length > 1;
  const frameMeasured = (id) => probeFrames.some((f) => f.nodeId === id);
  const builtTexts = /* @__PURE__ */ new Map();
  for (const s of specs) {
    if (!s.repeatedTextGroup) continue;
    const mm = byId.get(String(s.nodeId));
    const t = mm ? (mm.styles || mm).text : void 0;
    if (typeof t === "string") getOrInit(builtTexts, s.repeatedTextGroup, () => []).push(t.replace(/\u00a0/g, " ").trim());
  }
  for (const spec of specs) {
    let m = byId.get(String(spec.nodeId));
    let matchedBy = m ? m.matchedBy || "id" : null;
    if (!m) {
      const alt = viaSharedPath(spec.nodeId);
      if (alt) {
        m = byId.get(alt);
        matchedBy = `shared-component-path (${alt})`;
        nodesMatchedByComponentPath++;
      }
    }
    if (!m) {
      let why = probeWhy.get(String(spec.nodeId)) ?? "no measurement for this node id";
      const anchor = anchors[spec.nodeId];
      const into = anchor && typeof anchor.foldedInto === "string" && anchor.foldedInto.trim() ? anchor.foldedInto.trim() : null;
      const paint = paintOf(spec);
      const frameId = frameOf(spec).nodeId;
      if (into) {
        const refuse = paint.length ? `it states ${paint.join("/")} \u2014 a node that paints or carries copy is built, never folded` : !((spec.ancestorIds || []).includes(into) || into === frameId) ? `${into} is not an ancestor of this node in the export` : !(byId.has(into) || viaSharedPath(into) || frameMeasured(into)) ? `${into} was not measured, so nothing stands in for this node` : null;
        if (!refuse) {
          folded.push({ nodeId: spec.nodeId, name: spec.name, into, why: `plan anchor foldedInto ${into}: a layout-only wrapper the build merged into that measured ancestor` });
          continue;
        }
        why += ` \u2014 plan anchor foldedInto ${into} refused: ${refuse}`;
      } else if (!paint.length) {
        const parent = (spec.ancestorIds || [])[0] ?? frameId;
        why += ` \u2014 foldable (no paint \u2014 anchor it foldedInto its parent${parent ? ` ${parent}` : ""} if the build merged it there)`;
      }
      notMeasured.push({ nodeId: spec.nodeId, name: spec.name, ...ifDefined("path", spec.path), why });
      continue;
    }
    nodesMeasured++;
    const rawMatch = typeof m.matchedBy === "string" ? m.matchedBy : "";
    matchKind.set(String(spec.nodeId), matchedBy && matchedBy.startsWith("shared-component-path") ? "shared-component-path" : rawMatch);
    const bucket = matchedBy && matchedBy.startsWith("shared-component-path") ? "sharedComponentPath" : rawMatch === "" ? "unstated" : MATCH_BUCKET[rawMatch] ?? "other";
    matchedByCensus[bucket] = (matchedByCensus[bucket] ?? 0) + 1;
    const base = m.styles || m;
    let got = base, measuredIn = "rest";
    const state = spec.drawnState;
    if (!state && m.states && isJsonObject(m.states)) for (const s of Object.keys(m.states)) undrawnStates.push({ spec, state: s });
    const st2 = state && m.states && m.states[state];
    if (st2) {
      got = Object.assign({}, base, st2.styles || st2);
      measuredIn = state;
    }
    const stUm = st2 ? st2.unmeasured : void 0;
    const um = { ...isJsonObject(m.unmeasured) ? m.unmeasured : {}, ...isJsonObject(stUm) ? Object.fromEntries(Object.entries(stUm).filter((e) => typeof e[1] === "string")) : {} };
    const nullWhy = (...keys) => {
      for (const k of keys) {
        const w = um[k];
        if (typeof w === "string" && w) return w;
      }
      return "reported null";
    };
    const gapNull = (field, ...keys) => {
      fieldsReportedNull++;
      gap(spec, field, nullWhy(...keys), true);
    };
    const zeroAtRest = num(base.width) && num(base.height) && base.width === 0 && base.height === 0;
    const stateWhy = state ? `the designer drew this ${spec.drawnStateOwn ? "layer" : "layer's container"} in its ${state} state (${spec.drawnStateWhy}) \u2014 measure it ${state === "hover" ? "hovered" : state} and report the values under states.${state}` : "";
    if (state && measuredIn === "rest" && zeroAtRest) {
      for (const f of FIELDS) if (spec[f.key] !== void 0) {
        tally(f.key, false);
        gap(spec, f.label, `renders 0\xD70 at rest: ${stateWhy}`);
      }
      placementGaps.set(String(spec.nodeId), { absent: false, why: `renders 0\xD70 at rest: ${stateWhy}` });
      continue;
    }
    const isText = spec.type === "TEXT";
    const container = isText && isContainer(got);
    const tb = got.textBox && typeof got.textBox === "object" ? got.textBox : null;
    const tagLc = typeof got.tag === "string" ? got.tag.toLowerCase() : "";
    if (isText && tagLc && (CONTAINER_TAGS.has(tagLc) || tagLc === "div") && m.textFrom === void 0) typographyOn.set(String(spec.nodeId), tagLc);
    const table = got.tag && TABLE_TAGS.has(String(got.tag).toLowerCase());
    const onLeaf = !!(CONTAINER_TYPES.has(spec.type) && got.tag && LEAF_TAGS.has(String(got.tag).toLowerCase()));
    const leafWhy = onLeaf ? `this ${spec.type}'s id sits on a leaf <${String(got.tag).toLowerCase()}> inside the element that implements it (a ...rest spread?) \u2014 tag and measure the container` : "";
    const rowTag = ROW_TAGS.has(tagLc);
    const inline = CONTAINER_TYPES.has(spec.type) && typeof got.display === "string" && got.display.trim() === "inline";
    const textDiffers = isText && spec.text !== void 0 && typeof got.text === "string" && !renderedText(spec.text, spec.textCase, got.text, got.textTransform, normText).same;
    const firstDelta = deltas.length;
    for (const f0 of FIELDS) {
      const want0 = spec[f0.key];
      if (want0 === void 0) continue;
      const f = isText && f0.key === "width" && spec.widthFrom === "renderBox" ? { ...f0, label: "width (text ink)", tol: TOLERANCE.textInk } : f0;
      let val = got[f.key];
      let nullKeys = [f.key];
      let present = val !== void 0;
      const textXW = isText && (f.key === "x" || f.key === "width");
      if (textXW) {
        val = tb ? f.key === "x" ? tb.x : tb.w : got.textBox === null ? null : void 0;
        present = val !== void 0;
        nullKeys = ["textBox", f.key];
      }
      if (f.key === "gap" && got.gapVisual !== void 0 && (got.gapVisual !== null || val == null)) {
        val = got.gapVisual;
        present = true;
        nullKeys = ["gapVisual", "gap"];
      }
      if (f.key === "fill" && (PIXEL_TAGS.has(tagLc) || m.fillSource === "img")) {
        unverifiable.push({ nodeId: spec.nodeId, name: spec.name, field: f.label, expected: want0, why: `drawn by an <${PIXEL_TAGS.has(tagLc) ? tagLc : "img"}>: its paint is pixels, not a CSS property \u2014 the SVG's own fill cannot be read from the element's computed style` });
        continue;
      }
      tally(f.key, present);
      if (state && measuredIn === "rest" && (spec.drawnStateOwn && f.colour || f.key === "opacity")) {
        gap(spec, f.label, stateWhy);
        continue;
      }
      if (onLeaf && LEAF_FIELDS.has(f.key)) {
        gap(spec, f.label, leafWhy);
        continue;
      }
      if (inline && INLINE_BOX_FIELDS.has(f.key)) {
        gap(spec, f.label, inlineWhy(tagLc));
        continue;
      }
      if (f.key === "borderRadius" && rowTag) {
        gap(spec, f.label, ROW_RADIUS_WHY);
        continue;
      }
      if (textXW && textDiffers) {
        gap(spec, f.label, "the text differs from the design's, so its width (and a centred or right-aligned start) does too \u2014 compared once the copy matches");
        continue;
      }
      if (textXW && val === void 0) {
        gap(spec, f.label, "report textBox {x,w} \u2014 a Range over the text's characters; a TEXT's x/width are never read off its element's box", true);
        continue;
      }
      if (isText && f.box && container && !tb && !textXW) {
        if (got.textBox === null && f.key !== "height") {
          gapNull(f.label, "textBox");
          continue;
        }
        gap(spec, f.label, `this TEXT node's id sits on a <${got.tag || "container"}>${Array.isArray(got.padding) && got.padding.some((v) => (cssPx(v) ?? 0) > 0) ? " with padding" : ""}, whose box is not the text's \u2014 report textBox (a Range over the text) instead`);
        continue;
      }
      if (isText && tb && f.key === "height") {
        continue;
      }
      if (f.key === "gap" && table && got.gapVisual == null) {
        if (got.gapVisual === null) {
          gapNull(f.label, "gapVisual");
          continue;
        }
        gap(spec, f.label, `the element is a <${got.tag}>, which spaces rows with border-spacing, not gap \u2014 report gapVisual (the distance between consecutive rows)`);
        continue;
      }
      if (val === void 0) {
        if (f.optional) {
          unverifiable.push({ nodeId: spec.nodeId, name: spec.name, field: f.label, expected: want0, why: "a ::placeholder colour is not readable from getComputedStyle(el) \u2014 report placeholderColor to have it checked" });
          continue;
        }
        gap(spec, f.label, "the probe did not report this property", true);
        continue;
      }
      if (val === null || Array.isArray(val) && val.includes(null)) {
        gapNull(f.label, ...nullKeys);
        continue;
      }
      if (f.norm && (f.norm(val) == null || typeof val !== "string" && typeof val !== "number")) {
        gap(spec, f.label, `could not read '${typeof val === "string" ? val : JSON.stringify(val)}' as ${f.label}`);
        continue;
      }
      if (f.tol != null && !f.norm && f.key !== "borderRadius") {
        const flexOrGrid = typeof got.display === "string" && /(^|-)(flex|grid)$/.test(got.display.trim());
        const n = val === "normal" && (f.key === "letterSpacing" || f.key === "gap" && flexOrGrid) ? 0 : cssPx(val);
        if (n === null) {
          const kw = val !== "normal" ? "" : f.key === "gap" ? " (0 in flex/grid, not applicable in block layout \u2014 report display, or a number)" : " (its px value depends on the font's metrics)";
          gap(spec, f.label, `could not read '${typeof val === "string" ? val : JSON.stringify(val)}' as a px number${kw}`);
          continue;
        }
        const box = Math.max(cssPx(got.width) ?? 0, cssPx(got.height) ?? 0);
        const why = NON_NEGATIVE.has(f.key) && n < 0 && !(f.key === "gap" && num(want0) && want0 < 0) ? `${r2(n)} is impossible for ${f.label} (CSS cannot make it negative)` : f.key === "opacity" && n > 1 ? `${r2(n)} is impossible for opacity (0 to 1)` : f.key === "gap" && nullKeys[0] === "gapVisual" && box > 0 && n > box ? `${r2(n)}px is larger than the element measured (${r2(box)}px)` : null;
        const cssGap = why && nullKeys[0] === "gapVisual" && !table ? cssPx(got.gap) : null;
        if (cssGap !== null && cssGap >= 0) val = cssGap;
        else if (why) {
          gap(spec, f.label, `${why} \u2014 a measuring artefact (children not laid out in one line, or rows read across columns?); not compared`);
          continue;
        } else val = n;
      }
      fieldsChecked++;
      let want = want0, have = val;
      let strokeNote;
      if (f.key === "borderWidth" && typeof want0 === "number") {
        const ring = got.strokeFrom === "box-shadow" || got.strokeFrom === "outline";
        if (!ring && cssBorderWidth(want0) !== want0) {
          want = cssBorderWidth(want0);
          strokeNote = `the design's ${want0}px stroke draws as a ${want}px CSS border (computed border widths are whole px, at least 1)`;
        }
        if (ring && got.strokeAlign && spec.strokeAlign && spec.strokeAlign !== "center" && got.strokeAlign !== spec.strokeAlign) strokeNote = `read from a ${got.strokeFrom} ring ${got.strokeAlign} the box; the design's stroke is ${spec.strokeAlign}`;
      }
      if (f.key === "borderRadius") {
        const c = radiusCorners(val);
        if (!c) {
          gap(spec, f.label, `could not read '${JSON.stringify(val)}' as a px radius`);
          fieldsChecked--;
          continue;
        }
        if (c.some((r) => r < 0)) {
          gap(spec, f.label, `${JSON.stringify(val)} is impossible for a radius (CSS cannot make it negative) \u2014 a measuring artefact; not compared`);
          fieldsChecked--;
          continue;
        }
        const W = num(got.width) ? got.width : spec.width, H = num(got.height) ? got.height : spec.height;
        if (typeof want === "number") want = clampRadius(want, spec.width, spec.height);
        const target = Number(want);
        const worst = c.map((r) => clampRadius(r, W, H)).reduce((a, r) => Math.abs(r - target) > Math.abs(a - target) ? r : a, clampRadius(c[0], W, H));
        have = worst;
      }
      let paintNote;
      if (f.key === "backgroundColor" && normColor(have) === "transparent" && normColor(want) !== "transparent") {
        const stBag = st2 ? st2.styles || st2 : void 0;
        const pb = isJsonObject(stBag) && stBag.backgroundColor !== void 0 ? stBag.paintedBy : base.paintedBy;
        if (isPaintedBy(pb)) {
          have = pb.backgroundColor;
          paintNote = pb.via === "child" ? `background painted by its same-box child <${pb.tag}> \u2014 the element itself is transparent` : `background painted by its <${pb.tag}>${pb.depth > 1 ? ` (${pb.depth} levels up)` : ""} \u2014 the element itself is transparent`;
          paintedVia.push({ nodeId: spec.nodeId, how: `${pb.via === "child" ? "child" : "ancestor"} <${pb.tag}>` });
        }
      }
      const bad = compareField(f, want, have);
      if (bad) {
        push(spec, f.label, f.high ? "high" : "medium", bad, {
          ...ifDefined("unit", f.unit),
          ...ifDefined("token", tokenFor(spec, f.key)),
          ...measuredIn !== "rest" ? { measuredIn } : {},
          ...ifDefined("matchedBy", matchedBy !== "id" ? matchedBy || void 0 : void 0),
          ...f.key === "borderRadius" && spec.borderRadius !== want ? { note: `design radius ${spec.borderRadius} on a ${spec.width}\xD7${spec.height} box draws ${want}` } : {},
          ...ifDefined("note", [strokeNote, paintNote, f.key === "lineHeight" ? lineBoxWhyOf.get(spec.nodeId) : void 0].filter((x) => x !== void 0).join("; ") || void 0)
        });
      }
    }
    if (spec.radiusCorners && onLeaf) gap(spec, "border-radius", leafWhy);
    else if (spec.radiusCorners && inline) gap(spec, "border-radius", inlineWhy(tagLc));
    else if (spec.radiusCorners && rowTag) {
      tally("borderRadius", got.borderRadius !== void 0);
      gap(spec, "border-radius", ROW_RADIUS_WHY);
    } else if (spec.radiusCorners) {
      const rc = spec.radiusCorners;
      const c = radiusCorners(got.borderRadius);
      tally("borderRadius", got.borderRadius !== void 0);
      if (got.borderRadius === null || Array.isArray(got.borderRadius) && got.borderRadius.some((v) => v === null)) gapNull("border-radius", "borderRadius");
      else if (!c) gap(spec, "border-radius", got.borderRadius === void 0 ? "the probe did not report this property" : `could not read '${JSON.stringify(got.borderRadius)}' as a px radius`, got.borderRadius === void 0);
      else if (c.some((r) => r < 0)) gap(spec, "border-radius", `${JSON.stringify(got.borderRadius)} is impossible for a radius (CSS cannot make it negative) \u2014 a measuring artefact; not compared`);
      else {
        const W = num(got.width) ? got.width : spec.width, H = num(got.height) ? got.height : spec.height;
        const [ctl, ctr, cbr, cbl] = c;
        const measured2 = { tl: ctl, tr: ctr, br: cbr, bl: cbl };
        ["tl", "tr", "br", "bl"].forEach((k) => {
          fieldsChecked++;
          const want = clampRadius(rc[k], spec.width, spec.height), have = clampRadius(measured2[k], W, H);
          const d = Math.abs(want - have);
          if (d > TOLERANCE.radius) push(spec, `border-radius (${{ tl: "top-left", tr: "top-right", br: "bottom-right", bl: "bottom-left" }[k]})`, "medium", { want, got: have, delta: Number(d.toFixed(3)) }, { unit: "px", ...ifDefined("token", tokenFor(spec, "radius." + k)) });
        });
      }
    }
    if (spec.padding !== void 0) {
      tally("padding", got.padding !== void 0);
      const pad = fourSides(got.padding);
      if (got.padding === void 0) gap(spec, "padding", "the probe did not report this property", true);
      else if (got.tag && String(got.tag).toLowerCase() === "tr") gap(spec, "padding", "a table row's padding lives on its cells \u2014 report the first/last cell's padding under this id");
      else if (onLeaf) gap(spec, "padding", leafWhy);
      else if (inline) gap(spec, "padding", inlineWhy(tagLc));
      else if (got.padding === null || Array.isArray(got.padding) && got.padding.some((v) => v === null)) gapNull("padding", "padding");
      else if (!pad) gap(spec, "padding", `could not read '${JSON.stringify(got.padding)}' as px padding [t,r,b,l]`);
      else if (pad.some((v) => v < 0)) gap(spec, "padding", `${JSON.stringify(got.padding)} is impossible for padding (CSS cannot make it negative) \u2014 a measuring artefact; not compared`);
      else {
        fieldsChecked++;
        const bad = comparePadding(spec.padding, pad, spec.paddingSkip);
        const allZero = pad.every((v) => v === 0);
        const skipNote = spec.paddingSkip && spec.paddingSkip.length ? `${spec.paddingSkip.join("/")} not compared (the design cannot show that padding \u2014 see notComparable)` : void 0;
        const zeroNote = allZero && !got.tag ? "measured 0 on every side \u2014 if this id sits on a <tr> or a wrapper, the padding lives on its cells/child: report `tag` and measure the element that carries it" : void 0;
        const padNote = [zeroNote, skipNote].filter((x) => !!x).join("; ");
        if (bad) push(spec, "padding", "medium", bad, { unit: "px", ...ifDefined("token", tokenFor(spec, "padding")), ...padNote ? { note: padNote } : {} });
      }
    }
    if (spec.placeholderText !== void 0) {
      tally("placeholderText", got.placeholderText !== void 0);
      if (got.placeholderText === void 0) gap(spec, "placeholder text", "this layer is an input placeholder: report el.placeholder as placeholderText (textContent of an empty input is '')", true);
      else if (got.placeholderText === null) gapNull("placeholder text", "placeholderText");
      else {
        fieldsChecked++;
        if (!renderedText(String(spec.placeholderText), spec.textCase, String(got.placeholderText), void 0, (t) => t.trim()).same) push(spec, "placeholder text", "high", { want: spec.placeholderText, got: got.placeholderText, delta: null });
      }
    }
    if (spec.text !== void 0) {
      tally("text", got.text !== void 0);
      if (got.text === null) {
        fieldsReportedNull++;
        gap(spec, "text", um.text || "the probe reported text: null \u2014 an element with child elements still has text; report its textContent", true);
      } else if (got.text === void 0) absentGaps.add(`${spec.nodeId}\0text`);
      else if (got.text !== void 0) {
        fieldsChecked++;
        const rt = renderedText(String(spec.text), spec.textCase, String(got.text), got.textTransform, (t) => t.replace(/ /g, " ").trim());
        const w = rt.want.replace(/ /g, " ").trim();
        const g = rt.have.replace(/ /g, " ").trim();
        const caseShown = spec.textCase !== void 0 || rt.transform !== null && rt.transform.trim().toLowerCase() !== "none";
        const renderNote = !caseShown ? void 0 : `the design renders '${w}' (stored '${String(spec.text).trim()}'${spec.textCase ? `, text case ${spec.textCase}` : ""}); the build renders '${g}' (text '${String(got.text).trim()}'${rt.transform !== null ? `, text-transform ${rt.transform}` : ", text-transform not reported"})`;
        if (!rt.same) {
          const caseOnly = w.toLowerCase() === g.toLowerCase();
          const extraGlyphs = !caseOnly && g.startsWith(w) && !/[\p{L}\p{N}]/u.test(g.slice(w.length));
          const rowTexts = spec.repeatedText && spec.repeatedTextGroup ? builtTexts.get(spec.repeatedTextGroup) : void 0;
          const distinct = rowTexts ? new Set(rowTexts).size : 0;
          const asDesigned = rowTexts ? rowTexts.filter((t) => t === w).length : 0;
          const realData = !caseOnly && !extraGlyphs && !!rowTexts && distinct >= 3 && asDesigned * 2 <= rowTexts.length;
          const why = caseOnly ? caseShown ? "differs only in case, as rendered" : "differs only in case \u2014 check for a text-transform, which Figma applies at render time while storing the original" : extraGlyphs ? `the designed text is intact, followed by '${g.slice(w.length).trim()}' (an icon or caret inside the same element?)` : realData ? `repeated placeholder copy: the design shows '${w}' in every sibling row; the build shows ${distinct} different values across them (real data?) \u2014 check the copy is the data the design means` : void 0;
          const note = [why, renderNote].filter((x) => x !== void 0).join(" \u2014 ");
          push(spec, "text", caseOnly || extraGlyphs || realData ? "low" : "high", { want: spec.textCase ? rt.want : spec.text, got: caseShown && rt.transform !== null ? rt.have : got.text, delta: null }, {
            ...note ? { note } : {}
          });
        }
        if (/ /.test(String(spec.text))) {
          const show = (t) => String(t).replace(/ /g, "\\u00a0");
          deltas.push({
            severity: "low",
            nodeId: spec.nodeId,
            name: spec.name,
            field: "text (invisible character)",
            expected: show(spec.text),
            actual: show(got.text),
            note: "the designed string contains a non-breaking space (U+00A0) \u2014 a Figma auto-substitution. Carrying it into the DOM verbatim is usually not what anyone meant; decide deliberately."
          });
        }
      }
    }
    const fr = frameOf(spec);
    const bx = got;
    if (num(fr.w) && num(fr.h)) {
      const BOX_KEYS = ["x", "y", "width", "height"];
      const missing = BOX_KEYS.filter((k) => bx[k] === void 0 || bx[k] === null);
      const unread = BOX_KEYS.filter((k) => bx[k] !== void 0 && bx[k] !== null && !num(bx[k]));
      if (missing.length) placementGaps.set(String(spec.nodeId), { absent: true, why: `the probe did not report ${missing.join("/")} (placement is derived from the box)` });
      else if (unread.length) placementGaps.set(String(spec.nodeId), { absent: false, why: `could not read ${unread.join("/")} as px numbers (placement is derived from the box)` });
    }
    if (num(fr.w) && num(fr.h) && (num(bx.x) || num(bx.y))) {
      const w = num(bx.width) ? bx.width : 0, h = num(bx.height) ? bx.height : 0;
      const tol = TOLERANCE.position;
      const inDesign = (!num(spec.x) || spec.x >= -tol && spec.x + (spec.width || 0) <= fr.w + tol) && (!num(spec.y) || spec.y >= -tol && spec.y + (spec.height || 0) <= fr.h + tol);
      const out = [];
      const over = [];
      let bottomOnly = true;
      if (num(bx.y) && bx.y + h > fr.h + tol) {
        out.push(`bottom edge at y=${r2(bx.y + h)} in a ${fr.h}-high frame`);
        over.push(bx.y + h - fr.h);
      }
      if (num(bx.y) && bx.y < -tol) {
        out.push(`top edge at y=${r2(bx.y)}`);
        over.push(-bx.y);
        bottomOnly = false;
      }
      if (num(bx.x) && bx.x + w > fr.w + tol) {
        out.push(`right edge at x=${r2(bx.x + w)} in a ${fr.w}-wide frame`);
        over.push(bx.x + w - fr.w);
        bottomOnly = false;
      }
      if (num(bx.x) && bx.x < -tol) {
        out.push(`left edge at x=${r2(bx.x)}`);
        over.push(-bx.x);
        bottomOnly = false;
      }
      if (inDesign && out.length && !zeroAtRest) {
        const pf = probeFrames.find((f) => f.nodeId === fr.nodeId) ?? (!multiFrame && probeFrames.length === 1 ? probeFrames[0] : void 0);
        const pageGrew = !!pf && (pf.via === "viewport" || isJsonObject(pf.rect) && num(pf.rect.h) && pf.rect.h > fr.h + tol);
        const belowFold = bottomOnly && pageGrew && !spec.absolute && !spec.fixed && !multiFrame;
        deltas.push({
          severity: belowFold ? "medium" : "high",
          nodeId: spec.nodeId,
          name: spec.name,
          ...ifDefined("path", spec.path),
          field: "placement",
          expected: "inside the frame",
          actual: out.join(", "),
          delta: r2(Math.max(...over)),
          // px past the frame (no `unit`: `actual` is prose, printed as-is)
          note: belowFold ? "below the fold: the page renders taller than the design's frame and this node sits past its bottom edge \u2014 reachable by scrolling; accept it (verify-screen --accept) if the longer page is intended" : "the design places this node inside the frame; the build renders it outside, where the user cannot see it without scrolling"
        });
      }
    }
    const own = deltas.slice(firstDelta);
    let sizeRow;
    if (!isText && !onLeaf && !inline) {
      const ew = num(spec.width) ? spec.width : null, eh = num(spec.height) ? spec.height : null;
      const mw = cssPx(got.width), mh = cssPx(got.height);
      const off = (e, m2) => e !== null && m2 !== null && Math.abs(m2 - e) >= 8 && (Math.min(e, m2) <= 0 || Math.max(m2 / e, e / m2) >= 2);
      const frameRoot = spec.nodeId === frameOf(spec).nodeId;
      const growOnlyW = spec.sizing?.w === "hug" && ew !== null && mw !== null && mw > ew;
      const growOnlyH = (spec.sizing?.h === "hug" || frameRoot) && eh !== null && mh !== null && mh > eh;
      const rawW = off(ew, mw), rawH = off(eh, mh);
      if (rawW && (!growOnlyW || rawH) || rawH && (!growOnlyH || rawW)) {
        const dist = Math.max(ew !== null && mw !== null ? Math.abs(mw - ew) : 0, eh !== null && mh !== null ? Math.abs(mh - eh) : 0);
        sizeRow = {
          severity: "medium",
          nodeId: spec.nodeId,
          name: spec.name,
          ...ifDefined("path", spec.path),
          field: "match (size)",
          expected: [ew, eh],
          actual: [mw, mh],
          delta: r2(dist),
          unit: "px",
          ...ifDefined("matchedBy", matchedBy !== "id" ? matchedBy || void 0 : void 0),
          note: `the matched element is far from the design's size \u2014 likely the wrong element (a wrapper, a page root, a neighbour); this node's other deltas are capped at low. Tag the element the design means, or accept the match (verify-screen --accept --field "match (size)")`
        };
        deltas.push(sizeRow);
      }
    }
    const canon = MATCH_SYNONYM[rawMatch] ?? rawMatch;
    const cap = rawMatch === "" || NO_CAP.has(canon) ? null : MEDIUM_CAP.has(canon) ? "medium" : "low";
    if (cap) matchCapOf.set(String(spec.nodeId), cap);
    for (const d of [...own, ...sizeRow ? [sizeRow] : []]) {
      let sev = d.severity;
      const why = [];
      const by = [];
      if (sizeRow && d !== sizeRow && SEVERITY_RANK[sev] < SEVERITY_RANK.low) {
        sev = "low";
        by.push("size");
        why.push("capped at low: the matched element's size is far from the design's (see match (size))");
      }
      if (cap && SEVERITY_RANK[d.severity] < SEVERITY_RANK[cap]) by.push("match");
      if (cap && SEVERITY_RANK[sev] < SEVERITY_RANK[cap]) {
        sev = cap;
        why.push(`capped at ${cap}: matched by ${rawMatch}${canon === rawMatch && !CANONICAL_MATCH.has(canon) ? " (not a canonical matchedBy)" : ""}, not by its data-dt-node tag \u2014 the element measured may not be the one the design means`);
      }
      if (sev !== d.severity) {
        d.cappedFrom = d.severity;
        d.cappedBy = by;
        d.severity = sev;
        d.note = d.note ? `${d.note}; ${why.join("; ")}` : why.join("; ");
      }
    }
  }
  const pageRaw = measured.page;
  const page = isPageOverflow(pageRaw) ? pageRaw : void 0;
  const pageNotes = [];
  if (pageRaw !== void 0 && !page) pageNotes.push("measured.page is not a page overflow block; ignored (page overflow: not measured)");
  const rootF = expectation.frame || {};
  let pageOverflow = "not measured";
  if (page) {
    const over = page.scrollWidth - page.clientWidth;
    if (!num(rootF.w) || Math.abs(page.viewport.w - rootF.w) > 1) {
      pageOverflow = "not at design width";
      pageNotes.push(`page overflow was measured at a ${page.viewport.w}px viewport${num(rootF.w) ? `, the design is ${rootF.w}px wide` : " and the expectation states no frame width"} \u2014 not judged (measure at the design width)`);
    } else if (rootF.scroll === "horizontal" || rootF.scroll === "both") pageOverflow = "designed to scroll";
    else if (over <= 1) pageOverflow = "ok";
    else if (!page.scrollable) {
      pageOverflow = "clipped";
      pageNotes.push(`the page is ${page.scrollWidth}px wide in a ${page.clientWidth}px viewport but its root clips it (overflow-x: ${page.overflowX}) \u2014 content past the right edge cannot be scrolled to`);
    } else {
      pageOverflow = "overflows";
      const widest = page.offenders.slice(0, 3).map((o) => `${o.dt ? `\`${o.dt}\` ` : ""}${o.path} \u2192 ${r2(o.right)}px`).join(", ");
      if (typeof rootF.nodeId === "string") {
        deltas.push({
          severity: "high",
          nodeId: rootF.nodeId,
          ...ifDefined("name", rootF.name),
          field: "overflowX",
          expected: page.clientWidth,
          actual: page.scrollWidth,
          delta: r2(over),
          unit: "px",
          note: `the page scrolls sideways at the design width${widest ? ` (widest: ${widest})` : ""} \u2014 accept it (verify-screen --accept --node ${rootF.nodeId} --field overflowX) only if intended`
        });
      }
    }
    const probeNotedQuirks = Array.isArray(measured.notes) && measured.notes.some((n) => typeof n === "string" && n.includes("quirks mode"));
    if (page.compatMode && page.compatMode !== "CSS1Compat" && !probeNotedQuirks) pageNotes.push(`the page renders in quirks mode (document.compatMode ${page.compatMode}) \u2014 its overflow is measured off <body>`);
  }
  const addNote = (d, note) => {
    d.note = d.note ? `${d.note}; ${note}` : note;
  };
  const typoLabels = new Set(FIELDS.filter((f) => TYPO_FIELDS.has(f.key)).map((f) => f.label));
  for (const d of deltas) {
    const tag = typographyOn.get(String(d.nodeId));
    if (tag && typoLabels.has(d.field)) addNote(d, `typography read from a <${tag}>, not the text run \u2014 if the text sits in a child element, measure that element (the shipped probe does, and says textFrom)`);
  }
  const knownIds = /* @__PURE__ */ new Set([...expectedIds, ...hiddenSet, ...[expectation.frame, ...expectation.frames || []].map((f) => f && f.nodeId).filter((id) => typeof id === "string")]);
  for (const id of expectedIds) {
    const alt = viaSharedPath(id);
    if (alt) knownIds.add(alt);
  }
  const measuredIdsNotInExpectation = [...byId.keys()].filter((id) => !knownIds.has(id));
  const tniRaw = measured.tagsNotInExpectation;
  const tni = isJsonObject(tniRaw) && typeof tniRaw.count === "number" && Array.isArray(tniRaw.ids) ? { count: tniRaw.count, ids: tniRaw.ids.filter(isJsonObject).map((r) => r.id).filter((x) => typeof x === "string") } : null;
  const foreignListed = [.../* @__PURE__ */ new Set([...tni ? tni.ids : [], ...measuredIdsNotInExpectation])];
  const foreignTotal = (tni ? Math.max(tni.count, tni.ids.length) : 0) + measuredIdsNotInExpectation.filter((id) => !(tni && tni.ids.includes(id))).length;
  const expectedSuffixes = new Set([...expectedIds].map(idSuffix).filter((x) => x !== null));
  const aliasIds = new Set(specs.flatMap((sp) => sp.aliases || []));
  const foreignClass = (id) => {
    const sf = idSuffix(id);
    return sf !== null && expectedSuffixes.has(sf) ? "prefixDrift" : aliasIds.has(id) ? "alias" : "unknown";
  };
  const prefixDrift = foreignListed.filter((id) => foreignClass(id) === "prefixDrift").length;
  const aliasTags = foreignListed.filter((id) => foreignClass(id) === "alias").length;
  const foreignTags = foreignTotal > 0 ? {
    total: foreignTotal,
    prefixDrift,
    alias: aliasTags,
    unknown: foreignTotal - prefixDrift - aliasTags,
    sample: [...foreignListed.filter((id) => foreignClass(id) === "unknown"), ...foreignListed.filter((id) => foreignClass(id) !== "unknown")].slice(0, 5)
  } : void 0;
  const fieldsNeverMeasured = [];
  for (const [key, c] of census) {
    if (FIELDS.some((f) => f.key === key && f.optional)) continue;
    if (c.expected > 0 && c.present === 0) {
      const hinted = [...unknownKeys.keys()].filter((k) => KEY_HINTS[k] === key);
      fieldsNeverMeasured.push({ field: key, expectedOn: c.expected, measuredOn: 0, ...hinted.length ? { probeSent: hinted } : {} });
    }
  }
  const comps = [...Array.isArray(measured.components) ? measured.components : [], ...Array.isArray(opts.components) ? opts.components : []];
  const reported = comps.filter((c) => c && c.present !== false);
  const namesSeen = new Set(reported.map((c) => String(c.setName || c.name || c)));
  const idsSeen = /* @__PURE__ */ new Set([...reported.map((c) => c.nodeId).filter(Boolean).map(String), ...byId.keys()]);
  const bySet = /* @__PURE__ */ new Map();
  for (const i of expectation.instances || []) {
    if (hiddenSet.has(String(i.nodeId))) continue;
    const k = i.setName || i.name;
    const e = getOrInit(bySet, k, () => ({ setName: k, ...ifDefined("setKey", i.setKey), nodeIds: [], instances: 0 }));
    e.instances++;
    e.nodeIds.push(i.nodeId);
  }
  const untaggedInstanceSets = [];
  let setsViaSharedPath = 0;
  for (const [k, v] of bySet) {
    if (namesSeen.has(k) || v.nodeIds.some((id) => idsSeen.has(String(id)))) continue;
    if (v.nodeIds.some((id) => viaSharedPath(id))) {
      setsViaSharedPath++;
      continue;
    }
    untaggedInstanceSets.push(v);
  }
  const visibleInstances = (expectation.instances || []).filter((i) => !hiddenSet.has(String(i.nodeId)));
  const instanceById = new Map(visibleInstances.map((i) => [String(i.nodeId), i]));
  const outermostOf = (id) => {
    const outer = id.startsWith("I") && id.includes(";") ? id.slice(1, id.indexOf(";")) : id;
    return instanceById.has(outer) ? outer : null;
  };
  const foldedIds = new Set(folded.map((f) => f.nodeId));
  const shellGroups = /* @__PURE__ */ new Map();
  for (const sp of specs) {
    const id = String(sp.nodeId);
    const outer = outermostOf(id);
    if (!outer || foldedIds.has(id)) continue;
    const g = getOrInit(shellGroups, outer, () => ({ expected: 0, measured: 0, viaOther: false }));
    g.expected++;
    const how = matchKind.get(id);
    if (how !== void 0) g.measured++;
    if (how === "tag-shared-path" || how === "tag-alias" || how === "shared-component-path") g.viaOther = true;
  }
  const shellIds = new Set([...shellGroups].filter(([id, g]) => g.viaOther || anchors[id] && anchors[id].shared === true).map(([id]) => id));
  const sharedShell = shellIds.size ? (() => {
    const rows = [...shellIds].map((id) => {
      const i = instanceById.get(id);
      const g = shellGroups.get(id);
      return { nodeId: id, name: i ? i.name : id, ...ifDefined("setName", i && i.setName), expected: g ? g.expected : 0, measured: g ? g.measured : 0 };
    });
    return { instances: rows, expected: rows.reduce((a, r) => a + r.expected, 0), measured: rows.reduce((a, r) => a + r.measured, 0) };
  })() : void 0;
  const untaggedInstanceSetsInShell = untaggedInstanceSets.filter((v) => shellIds.size > 0 && v.nodeIds.every((id) => {
    const o = outermostOf(String(id));
    return o !== null && shellIds.has(o);
  }));
  const untaggedOnScreen = untaggedInstanceSets.filter((v) => !untaggedInstanceSetsInShell.includes(v));
  const componentsAbsent = [];
  for (const c of comps.filter((c2) => c2 && c2.present === false)) {
    const set = [...bySet.values()].find((v) => v.setName === (c.setName || c.name) || c.nodeId !== void 0 && v.nodeIds.includes(c.nodeId));
    if (set) componentsAbsent.push({ setName: set.setName, nodeIds: set.nodeIds, ...ifDefined("detail", c.detail || c.note) });
  }
  const st = opts.status && opts.status.status !== "v1" ? opts.status.status : null;
  const stale = !!(opts.expectationSha256 && measured.expectationSha256 && measured.expectationSha256 !== opts.expectationSha256);
  const integrity = [];
  let unboundNote;
  if (stale) integrity.push(`${INTEGRITY_PHRASES.otherExpectation} (${String(measured.expectationSha256).slice(0, 12)}\u2026 vs ${String(opts.expectationSha256).slice(0, 12)}\u2026) \u2014 re-measure`);
  if (opts.expectationSha256 && !measured.expectationSha256) integrity.push(`${INTEGRITY_PHRASES.noExpectation} \u2014 nothing ties these numbers to this design; re-measure with the shipped probe`);
  const measuredRun = typeof measured.runId === "string" && measured.runId ? measured.runId : void 0;
  if (measuredRun !== void 0 && opts.status !== void 0 && (st === null || st.runId !== measuredRun)) {
    integrity.push(`the measured file was taken in run ${measuredRun}, but ${st ? `${opts.status ? opts.status.file : "the status"} is run ${st.runId}` : opts.status && opts.status.status === "v1" ? `${opts.status.file} is an older hand-written status` : "no status file was found"} \u2014 ${INTEGRITY_PHRASES.unrecorded}; ${st ? `run ${st.runId} is the current run \u2014 re-measure in it (never record run ${measuredRun} over it)` : `record it with --status <Screen> --phase measured --run ${measuredRun}, or re-measure`}`);
  } else if (st && measuredRun === void 0 && TERMINAL_PHASES.includes(st.phase) && Date.parse(String(measured.measuredAt)) > Date.parse(st.at)) {
    unboundNote = `${opts.status ? opts.status.file : "status.json"} is run ${st.runId} (${st.phase}); this measured file names no run \u2014 graded as an unbound measurement`;
  } else if (st) {
    const stFile = opts.status ? opts.status.file : "status.json";
    const endHint = measuredRun === void 0 ? ` \u2014 wait for it, or if nobody is running it any more, end it: --status ${shellArg(st.screen)} --phase failed --run ${shellArg(st.runId)}` : "";
    if (measuredRun === void 0 && TERMINAL_PHASES.includes(st.phase) && st.phase !== "done") integrity.push(`this measured file names no run and ${INTEGRITY_PHRASES.measuredBefore} (${stFile}: run ${st.runId} ${st.phase} at ${st.at}) \u2014 measure again`);
    else if (!MEASURED_PHASES.includes(st.phase)) integrity.push(`${stFile} (run ${st.runId}, rev ${st.rev}) is at phase ${st.phase} ${INTEGRITY_PHRASES.unfinished}${st.detail ? ` (${st.detail})` : ""}${endHint}`);
    else if (st.measuredSha256 && opts.measuredSha256 && st.measuredSha256 !== opts.measuredSha256) integrity.push(`${stFile} ${INTEGRITY_PHRASES.otherMeasured} (sha ${st.measuredSha256.slice(0, 12)}\u2026, this one ${opts.measuredSha256.slice(0, 12)}\u2026) \u2014 measured again outside run ${st.runId}?${st.phase === "done" ? "" : endHint}`);
  }
  const measuredRows = Array.isArray(measured.interactions) ? measured.interactions : [];
  const allEvidence = [...measuredRows, ...Array.isArray(opts.interactions) ? opts.interactions : []];
  const probeBound = isProbeIdentity(measured.probe) && measuredRun !== void 0 && st !== null && st.runId === measuredRun && !!st.measuredSha256 && st.measuredSha256 === opts.measuredSha256 && integrity.length === 0;
  const fromMeasured = new Set(measuredRows);
  const probeRows = /* @__PURE__ */ new Map();
  const exercised = /* @__PURE__ */ new Map();
  let interactionEvidenceOnHidden = 0;
  const expectedKeys = new Set((expectation.interactions || []).map((i) => String(i.nodeId) + "|" + i.trigger));
  for (const r of allEvidence) {
    if (!r || r.nodeId == null) continue;
    if (hiddenSet.has(String(r.nodeId))) {
      interactionEvidenceOnHidden++;
      continue;
    }
    const key = String(r.nodeId) + "|" + String(r.trigger || "on_click").toLowerCase();
    if (probeBound && fromMeasured.has(r)) {
      if (r.cut !== "budget") probeRows.set(key, r);
      continue;
    }
    exercised.set(key, r);
  }
  const exportSha = expectation.exportContentSha256;
  const inputNotes = [...Array.isArray(opts.inputNotes) ? opts.inputNotes : []];
  inputNotes.push(...pageNotes);
  if (expectation.tolerance && isJsonObject(expectation.tolerance) && expectation.tolerance.textInk === void 0) inputNotes.push("expectation written by an older verify-screen (TEXT box widths, no aliases) \u2014 re-run --expect");
  const reopened = [];
  const unused = [];
  const descopeRows = [];
  (Array.isArray(opts.descopes) ? opts.descopes : []).forEach((d, i) => {
    if (isPlanDescope(d)) descopeRows.push(d);
    else inputNotes.push(`plan descopes[${i}] is not ${isPlanDescope.expected}; ignored`);
  });
  const descopeUsed = /* @__PURE__ */ new Set();
  const descopeFor = (i) => {
    const hits = descopeRows.filter((d) => d.nodeId === i.nodeId && d.trigger.toLowerCase() === i.trigger && (d.destinationId === void 0 || d.destinationId === i.destinationId));
    for (const d of hits) descopeUsed.add(d);
    const live = hits.find((d) => d.exportContentSha256 === exportSha);
    if (!live) for (const d of hits) reopened.push({ nodeId: d.nodeId, field: `interaction (${d.trigger})`, why: "design re-exported: the export content changed since it was descoped" });
    return live;
  };
  if (unboundNote !== void 0) inputNotes.push(unboundNote);
  if (!probeBound && isProbeIdentity(measured.probe) && measuredRows.length) inputNotes.push("the measured file's interaction rows are not run-bound (no finished run's status names this measured file) \u2014 graded as agent evidence");
  const interactions = (expectation.interactions || []).filter((i) => !hiddenSet.has(String(i.nodeId))).map((i) => {
    const key = String(i.nodeId) + "|" + i.trigger;
    const p = probeRows.get(key), a = exercised.get(key);
    const gapsOf = (h) => h && h.ok === true && h.result !== "not-probed" ? evidenceGaps(h, i.action) : null;
    const act = String(i.action).toLowerCase();
    const needsInside = !!i.destinationId && (act === "overlay" || act === "swap");
    const pGaps = gapsOf(p);
    const pInside = !needsInside || !!p && !!p.destination && p.destination.inside === true && p.destination.nodeId === i.destinationId;
    const pPass = pGaps !== null && pGaps.length === 0 && pInside;
    const hit = p && pPass ? p : a ?? p;
    const fromProbe = !!hit && hit === p;
    const insideMiss = fromProbe && pGaps !== null && pGaps.length === 0 && !pInside;
    const gaps = fromProbe ? insideMiss ? [] : pGaps : gapsOf(hit);
    const worked = fromProbe ? pPass : gaps !== null && gaps.length === 0;
    const overridden = fromProbe && pPass && a && !(a.ok === true && (gapsOf(a) ?? []).length === 0) ? `agent row ok: ${a.ok === void 0 ? "(none)" : String(a.ok)}${a.detail ? ` \u2014 ${a.detail}` : ""}` : void 0;
    if (overridden) inputNotes.push(`${i.nodeId} (${i.trigger}): the run-bound probe's pass overrides the agent's row (${overridden})`);
    const row = {
      nodeId: i.nodeId,
      name: i.name,
      trigger: i.trigger,
      ...ifDefined("action", i.action),
      ...ifDefined("destinationId", i.destinationId),
      ...i.destinationExported === false ? { destinationExported: false } : {},
      ...i.source === "plan" ? { source: "plan", ...ifDefined("expect", i.expect) } : {}
    };
    const str = (v) => typeof v === "string" && v ? v : void 0;
    const said = hit ? {
      ...ifDefined("outcome", typeof hit.outcome === "string" ? hit.outcome : void 0),
      ...ifDefined("navEvents", typeof hit.navEvents === "number" ? hit.navEvents : void 0),
      ...probeBound ? { evidenceFrom: fromProbe ? "probe" : "agent" } : {},
      ...ifDefined("activation", str(hit.activation)),
      ...ifDefined("detectedBy", str(hit.detectedBy)),
      ...ifDefined("revealedBy", str(hit.revealedBy)),
      ...ifDefined("overridden", overridden)
    } : {};
    const saidBy = fromProbe ? "probe said" : "agent evidence said";
    const scoped = descopeFor(i);
    if (scoped) return Object.assign(row, { result: "descoped", detail: `descoped by ${scoped.decidedBy} (${scoped.decidedAt}): ${scoped.reason}`, ...worked ? { note: "descoped but works \u2014 the probe drove it successfully; drop the descope?" } : {} });
    if (i.destinationExported === false && !worked) return Object.assign(row, { result: "undesigned", detail: `destination ${i.destinationId} is not in this Figma file's export \u2014 nothing designed to check it against${hit && hit.detail ? `; ${saidBy}: ${hit.detail}` : ""}` });
    if (!hit) return Object.assign(row, { result: "not-probed", detail: "no probe result for this node and trigger" });
    const count = Number(hit.selectorCount);
    if (hit.result === "not-probed" || hit.ok === null || hit.ok === void 0) return Object.assign(row, { result: "not-probed", ...ifDefined("detail", hit.detail), ...probeBound ? said : {} });
    if (hit.ok === false) return Object.assign(row, { result: "fail", ...ifDefined("detail", hit.detail), ...ifDefined("selector", hit.selector), ...said });
    if (insideMiss) {
      return Object.assign(row, { result: "not-probed", detail: `probe pass without the destination tag inside the opened element \u2014 tag the root of what opens with data-dt-node="${i.destinationId}"${p && p.destination ? ` (the probe found ${p.destination.count} element(s) tagged ${p.destination.nodeId}, none inside it)` : ""}${hit.detail ? `; probe said: ${hit.detail}` : ""}`, ...ifDefined("selector", hit.selector), ...said });
    }
    if (!worked || !hit.selector) {
      return Object.assign(row, { result: "not-probed", detail: `reported ok without evidence \u2014 ${(gaps || []).join("; ")}${hit.detail ? `; ${saidBy}: ${hit.detail}` : ""}`, ...ifDefined("selector", hit.selector), ...said });
    }
    return Object.assign(row, { result: "pass", ...ifDefined("detail", hit.detail), selector: hit.selector, selectorCount: count, ...said });
  });
  const unexpectedRows = allEvidence.filter((r) => r && r.nodeId != null && !hiddenSet.has(String(r.nodeId)) && !expectedKeys.has(String(r.nodeId) + "|" + String(r.trigger || "on_click").toLowerCase()));
  const unexpectedInteractionEvidence = unexpectedRows.length;
  const designed = (expectation.interactions || []).filter((i) => !hiddenSet.has(String(i.nodeId)));
  const specAnc = new Map(specs.map((sp) => [String(sp.nodeId), sp.ancestorIds || []]));
  const unmatchedInteractionEvidence = [];
  const unmatchedSeen = /* @__PURE__ */ new Set();
  for (const r of unexpectedRows) {
    const nodeId = String(r.nodeId), trigger = String(r.trigger || "on_click");
    const key = nodeId + "|" + trigger.toLowerCase();
    if (unmatchedSeen.has(key)) continue;
    unmatchedSeen.add(key);
    const bare = trigger.toLowerCase().replace(/\s*[(:[].*$/, "").trim();
    const sameNode = designed.filter((i) => String(i.nodeId) === nodeId);
    const exact = sameNode.find((i) => i.trigger === bare);
    const kin = designed.find((i) => i.trigger === bare && (specAnc.get(String(i.nodeId)) || []).includes(nodeId)) ?? designed.find((i) => i.trigger === bare && (specAnc.get(nodeId) || []).includes(String(i.nodeId)));
    const hint = exact ? `use the expectation's trigger \`${exact.trigger}\` verbatim (not \`${trigger}\`)` : sameNode.length ? `this node's designed trigger is ${sameNode.map((i) => `\`${i.trigger}\``).join(" / ")}, not \`${trigger}\`` : kin ? `${(specAnc.get(String(kin.nodeId)) || []).includes(nodeId) ? "an ancestor" : "a descendant"} of the designed \`${kin.nodeId}\` ${kin.name || ""} (${kin.trigger}) \u2014 report the result under the designed node's id`.replace("  (", " (") : void 0;
    unmatchedInteractionEvidence.push({ nodeId, trigger, ...ifDefined("hint", hint) });
  }
  const interactionsFailed = interactions.filter((i) => i.result === "fail");
  const interactionsNotProbed = interactions.filter((i) => i.result === "not-probed");
  const interactionsPassed = interactions.filter((i) => i.result === "pass");
  const interactionsUndesigned = interactions.filter((i) => i.result === "undesigned");
  const interactionsDescoped = interactions.filter((i) => i.result === "descoped");
  for (const d of descopeRows) if (!descopeUsed.has(d)) unused.push({ nodeId: d.nodeId, field: `interaction (${d.trigger})`, why: "no designed interaction with this node and trigger this round" });
  const inferred = [];
  let inferredHead = 0, inferredUndesigned = 0;
  for (const i of interactions) {
    if (i.source === "plan" || i.destinationExported === false) {
      if (i.result === "undesigned") inferredUndesigned++;
      else inferredHead++;
    }
    if (i.source === "plan") inferred.push({
      kind: "plan-interaction",
      nodeId: i.nodeId,
      ...ifDefined("name", i.name),
      trigger: i.trigger,
      built: i.result,
      why: `declared by the plan (expect ${i.expect ?? "?"}) \u2014 the export carries no prototype link for it; graded as an interaction, but what it does was never drawn`
    });
    if (i.destinationExported === false) inferred.push({
      kind: "undesigned-interaction",
      nodeId: i.nodeId,
      ...ifDefined("name", i.name),
      trigger: i.trigger,
      built: i.result,
      why: `its destination ${i.destinationId ?? "?"} was never exported \u2014 what it opens is the build's own reading of the design`
    });
  }
  const undrawnBy = /* @__PURE__ */ new Map();
  for (const u of undrawnStates) {
    undrawnBy.set(u.state, (undrawnBy.get(u.state) ?? 0) + 1);
    inferredHead++;
    inferred.push({
      kind: "undrawn-state",
      nodeId: u.spec.nodeId,
      ...ifDefined("name", u.spec.name),
      state: u.state,
      why: `measured in its ${u.state} state, but the design draws no ${u.state} state for this node \u2014 the build's ${u.state} look is its own (not compared)`
    });
  }
  for (const [st0, n] of undrawnBy) inputNotes.push(`states.${st0} measured on ${n} node(s) whose design draws no ${st0} state \u2014 not compared (listed under Inferred, not designed)`);
  const specName = new Map(specs.map((sp) => [String(sp.nodeId), sp.name]));
  const unknownIds = /* @__PURE__ */ new Set();
  const agentRows = (raw, from) => {
    if (raw === void 0) return;
    if (!Array.isArray(raw)) {
      inputNotes.push(`${from} inferred is not a list of {nodeId?, state, built, why?}; ignored`);
      return;
    }
    raw.forEach((r, k) => {
      const bad = () => {
        inputNotes.push(`${from} inferred[${k}] is not {nodeId?, state, built, why?} (state and built: non-empty strings); ignored`);
      };
      if (!isJsonObject(r)) return bad();
      const { nodeId, state: rs, built, why } = r;
      if (typeof rs !== "string" || !rs.trim() || typeof built !== "string" || !built.trim() || nodeId !== void 0 && typeof nodeId !== "string" || why !== void 0 && typeof why !== "string") return bad();
      if (nodeId !== void 0 && !specName.has(nodeId)) unknownIds.add(nodeId);
      inferredHead++;
      inferred.push({
        kind: "agent",
        ...ifDefined("nodeId", nodeId),
        ...ifDefined("name", nodeId !== void 0 ? specName.get(nodeId) : void 0),
        state: rs.trim(),
        built: built.trim(),
        why: why !== void 0 && why.trim() ? why.trim() : "reported by the verifier: built, but the design draws no such state"
      });
    });
  };
  agentRows("inferred" in measured ? measured.inferred : void 0, "measured.json");
  agentRows(opts.inferred, "the --interactions evidence file's");
  if (unknownIds.size) inputNotes.push(`inferred[] row(s) name ${unknownIds.size} node id(s) not in this expectation: ${[...unknownIds].slice(0, 5).join(", ")}${unknownIds.size > 5 ? ", \u2026" : ""} \u2014 listed as written (another screen's id, or a typo?)`);
  if (paintedVia.length) inputNotes.push(`background compared through the element that paints it on ${paintedVia.length} node(s) whose own background is transparent (paintedBy): ${paintedVia.slice(0, 5).map((p) => `${p.nodeId} by its ${p.how}`).join(", ")}${paintedVia.length > 5 ? `, \u2026and ${paintedVia.length - 5} more` : ""}`);
  const notWaivable = /* @__PURE__ */ new Map();
  for (const n of notMeasured) notWaivable.set(n.nodeId, "the node was not measured \u2014 only a measured delta can be accepted");
  for (const i of interactionsFailed) notWaivable.set(i.nodeId, "a failed interaction is never waivable \u2014 descope it (plan.descopes, owner-only) if it is deliberately inert");
  for (const c of componentsAbsent) for (const id of c.nodeIds) notWaivable.set(id, `component set '${c.setName}' is reported ABSENT \u2014 a missing component is never waivable`);
  let applied = 0;
  (Array.isArray(opts.waivers) ? opts.waivers : []).forEach((w, i) => {
    if (!isPlanWaiver(w)) {
      inputNotes.push(`plan waivers[${i}] is not ${isPlanWaiver.expected}; ignored`);
      return;
    }
    const cands = deltas.filter((d2) => d2.nodeId === w.nodeId && d2.field === w.field && !d2.accepted);
    if (!cands.length) {
      const fieldGap = fieldsNotMeasured.some((g) => g.nodeId === w.nodeId && g.field === w.field) ? "that value was not measured this round \u2014 only a measured delta can be accepted" : void 0;
      const inkNow = w.field === "width" && (deltas.some((d2) => d2.nodeId === w.nodeId && d2.field === "width (text ink)") || specs.some((sp) => sp.nodeId === w.nodeId && sp.widthFrom === "renderBox")) ? "this TEXT's width is compared as 'width (text ink)' \u2014 re-accept against the new report" : void 0;
      unused.push({ nodeId: w.nodeId, field: w.field, why: notWaivable.get(w.nodeId) ?? fieldGap ?? inkNow ?? "no such delta this round \u2014 fixed? drop the waiver" });
      return;
    }
    if (!exportSha || w.exportContentSha256 !== exportSha) {
      reopened.push({ nodeId: w.nodeId, field: w.field, why: exportSha ? "design re-exported: the export content changed since the waiver was accepted" : "the expectation records no export content hash \u2014 regenerate it with --expect" });
      return;
    }
    const tol = fieldTolerance(w.field);
    const d = cands.find((x) => sameWithin(w.designed, x.expected, tol) && sameWithin(w.built, x.actual, w.tolerance ?? tol));
    if (d) {
      d.accepted = { reason: w.reason, decidedBy: w.decidedBy, decidedAt: w.decidedAt, ...ifDefined("cause", w.cause) };
      applied++;
      return;
    }
    const c0 = cands.find((x) => sameWithin(w.designed, x.expected, tol));
    reopened.push({
      nodeId: w.nodeId,
      field: w.field,
      why: c0 ? `built value moved: was ${fmt(w.built)}, now ${fmt(c0.actual)}` : `designed value changed: was ${fmt(w.designed)}, now ${fmt(cands[0]?.expected)}`
    });
  });
  for (const sz of deltas.filter((d) => d.field === "match (size)" && d.accepted)) {
    const mcap = matchCapOf.get(String(sz.nodeId));
    for (const d of deltas) {
      if (d === sz || d.nodeId !== sz.nodeId || !d.cappedFrom || !(d.cappedBy || []).includes("size")) continue;
      const orig = d.cappedFrom;
      const sev = mcap && SEVERITY_RANK[orig] < SEVERITY_RANK[mcap] ? mcap : orig;
      d.severity = sev;
      if (sev === orig) {
        delete d.cappedFrom;
        delete d.cappedBy;
      } else d.cappedBy = ["match"];
      d.note = `${d.note ? `${d.note}; ` : ""}size cap lifted: the owner accepted this element (waiver on match (size))${sev !== orig ? ` \u2014 still capped at ${sev} by how it was matched` : ""}`;
    }
  }
  const specOf = new Map(specs.map((sp) => [String(sp.nodeId), sp]));
  const placed = /* @__PURE__ */ new Map();
  for (const d of deltas) if (d.field === "placement") placed.set(String(d.nodeId), d);
  for (const d of placed.values()) {
    const anc = (specOf.get(String(d.nodeId))?.ancestorIds || []).filter((a) => placed.has(a));
    const root = anc[anc.length - 1];
    if (root) {
      d.group = `placement:${root}`;
      const r = placed.get(root);
      if (r) r.group = `placement:${root}`;
    }
  }
  const sameKey = /* @__PURE__ */ new Map();
  for (const d of deltas) if (!d.group) getOrInit(sameKey, JSON.stringify([d.field, d.expected, d.actual]), () => []).push(d);
  for (const [k, list] of sameKey) {
    if (list.length < 2) continue;
    const gid = `same:${sha256Hex(k).slice(0, 8)}`;
    for (const d of list) d.group = gid;
  }
  const open = deltas.filter((d) => !d.accepted);
  const high = open.filter((d) => d.severity === "high").length;
  const medium = open.filter((d) => d.severity === "medium").length;
  const accepted = deltas.length - open.length;
  const openHigh = open.filter((d) => d.severity === "high");
  const highCauses = new Set(openHigh.map((d, i) => d.group ?? `#${i}`)).size;
  const planNow = opts.plan || null;
  const recordedPi = expectation.planInteractions && isJsonObject(expectation.planInteractions) && typeof expectation.planInteractions.sha256 === "string" ? expectation.planInteractions : void 0;
  const nowRows = planNow && Array.isArray(planNow.plan.interactions) ? planNow.plan.interactions : null;
  const otherPlan = recordedPi !== void 0 && planNow !== null && !samePlanFile(recordedPi.plan, planNow.file);
  const rerunPlanArg = planNow && (planNow.choice === "flag" || planNow.choice === "files" || planNow.choice === "recorded" || otherPlan) ? ` --plan ${planNow.file}` : "";
  const gone = opts.recordedPlanGone || null;
  const shaNow = planNow ? planInteractionsSha256(planNow.plan) : "";
  const planInteractionsChanged = !planNow || !(recordedPi ? shaNow !== recordedPi.sha256 : !!nowRows && nowRows.length > 0) ? null : !recordedPi ? `the plan's interactions[] changed since --expect (${planNow.file}: the expectation merged none) \u2014 re-run --expect${rerunPlanArg}` : otherPlan && planNow.choice === "flag" ? `the plan's interactions[] differ from those --expect merged (${planNow.file}, passed by --plan: sha256 ${shaNow.slice(0, 12)}\u2026; --expect merged ${recordedPi.plan}'s${gone ? `, which ${gone}` : ""}: ${recordedPi.sha256.slice(0, 12)}\u2026) \u2014 re-run --expect --plan ${planNow.file}${gone ? "" : `, or drop --plan at --compare to check against ${recordedPi.plan}`}` : otherPlan ? `the plan's interactions[] at --expect came from ${recordedPi.plan}, which ${gone ?? "--compare did not use"}; the plan found now, ${planNow.file}, declares others (sha256 ${recordedPi.sha256.slice(0, 12)}\u2026 at --expect, ${shaNow.slice(0, 12)}\u2026 now) \u2014 if that plan moved, re-run --compare \u2026 --plan <its path now>; otherwise re-run --expect \u2026 --plan <the plan you intend> (--plan ${planNow.file} to adopt this one)` : `the plan's interactions[] changed since --expect (${planNow.file}: sha256 ${recordedPi.sha256.slice(0, 12)}\u2026 at --expect, ${shaNow.slice(0, 12)}\u2026 now) \u2014 re-run --expect${rerunPlanArg}`;
  if (recordedPi && planNow && otherPlan && gone && !planInteractionsChanged) inputNotes.push(`the expectation merged plan interactions from ${recordedPi.plan}, which ${gone}; ${planNow.file} (used now) declares the same interactions[]`);
  if (recordedPi && !planNow) inputNotes.push(gone ? `the expectation merged plan interactions from ${recordedPi.plan}, which ${gone}, and no single plan describes this frame now \u2014 not checked; pass --compare \u2026 --plan <plan.json> (or re-run --expect \u2026 --plan <plan.json>)` : `the expectation merged plan interactions from ${recordedPi.plan}, but no plan was found for this frame now \u2014 not checked`);
  const reachRaw = measured.reach;
  const reach = isProbeReach(reachRaw) ? reachRaw : void 0;
  if (reachRaw !== void 0 && !reach && !inputNotes.some((n) => n.startsWith("measured.reach "))) inputNotes.push("measured.reach is not the probe's steps block; ignored");
  let reachInput;
  if (reach) {
    const nav = planNow && planNow.plan.navigate !== void 0 ? parseSteps({ navigate: planNow.plan.navigate }) : null;
    const planSha = nav && "steps" in nav ? stepsSha256(nav.steps) : null;
    const matchesPlan = nav === null ? null : planSha !== null && planSha === reach.sha256;
    reachInput = { sha256: reach.sha256, steps: reach.steps.length, source: reach.source, matchesPlan };
    if (matchesPlan === false) inputNotes.push(nav && "error" in nav ? `the plan's navigate ${nav.error} \u2014 the probe's steps (sha ${reach.sha256.slice(0, 12)}\u2026) were not checked against it` : `the probe's steps (sha ${reach.sha256.slice(0, 12)}\u2026, ${reach.source}) are not the plan's navigate (sha ${(planSha ?? "").slice(0, 12)}\u2026) \u2014 measured another way than the plan says`);
  } else if (reachRaw === void 0 && planNow && Array.isArray(planNow.plan.navigate) && planNow.plan.navigate.length > 0) {
    inputNotes.push(`the plan declares navigate steps but the probe ran without --steps (${planNow.file}) \u2014 it measured whatever the URL shows first; re-run the probe with --steps ${planNow.file}`);
  }
  const probeRaw = measured.probe;
  const probeIdentity = isProbeIdentity(probeRaw) ? probeRaw : void 0;
  const buildRaw = measured.build;
  const buildNow = isBuildIdentity(buildRaw) ? buildRaw : void 0;
  if (buildRaw !== void 0 && !buildNow && !inputNotes.some((n) => n.startsWith("measured.build "))) inputNotes.push("measured.build is not a build identity; ignored (build: unknown)");
  if (opts.status && opts.status.status === "v1") inputNotes.push(`${opts.status.file} is an older hand-written status (no run id, no shas) \u2014 not checked; write it with verify-screen --status`);
  const runId = measuredRun ?? (st && unboundNote === void 0 ? st.runId : void 0);
  if (probeRaw !== void 0 && !probeIdentity && !inputNotes.some((n) => n.startsWith("measured.probe "))) inputNotes.push("measured.probe is not the shipped probe's identity; ignored (probe: unknown)");
  const inputs = {
    expectationSchema: expectation.schema || "(none)",
    ...ifDefined("expectationSha256", opts.expectationSha256),
    ...ifDefined("measuredSha256", opts.measuredSha256),
    ...ifDefined("measuredAgainst", measured.expectationSha256 || void 0),
    // WHAT was measured, by content — the design (timestamps stripped)
    // and the code (sha256 of each file in the plan's files[], the hashes the Stop hook records).
    ...ifDefined("exportContentSha256", expectation.exportContentSha256 || void 0),
    ...ifDefined("code", opts.code || void 0),
    // Which probe produced these numbers: a hand-written probe is "unknown", and its numbers are not
    // comparable round to round — a changed probe changes what "measured" means.
    probe: probeIdentity ?? "unknown",
    ...ifDefined("waivers", opts.waiversInput || void 0),
    // the build the probe was served — "unknown" when it records none (a hand-written probe, an older one)
    build: buildNow ?? "unknown",
    ...ifDefined("runId", runId),
    ...ifDefined("reach", reachInput)
  };
  const staticOnly = measured.mode === "static-only";
  const artifactCheck = Array.isArray(opts.artifactCheck) ? opts.artifactCheck : null;
  const noRender = !!artifactCheck && !artifactCheck.some((a) => a.exists && a.image);
  const nodesExpected = specs.length - folded.length;
  const reasons = [];
  reasons.push(...integrity);
  const integrityFailed = integrity.length > 0;
  const lowConfidence = open.filter((d) => d.cappedFrom !== void 0).length;
  if (lowConfidence) reasons.push(`${lowConfidence} delta(s) on low-confidence matches \u2014 tag these elements`);
  if (planInteractionsChanged) reasons.push(planInteractionsChanged);
  if (legacy2) reasons.push(`the expectation is ${expectation.schema || "unversioned"}, which predates hidden-layer filtering \u2014 regenerate it with --expect before trusting any number here`);
  if (staticOnly) reasons.push(`not rendered \u2014 the probe reported static-only${measured.reason ? ` (${measured.reason})` : ""}`);
  if (noRender) reasons.push("no screenshot of this render exists on disk \u2014 nothing ties these numbers to a picture (write design/verify/<Screen>.png and list it in artifacts)");
  for (const f of fieldsNeverMeasured) reasons.push(`field '${f.field}' was present on 0 of the ${f.expectedOn} measured node(s) whose spec states it${f.probeSent ? ` (the probe sent '${f.probeSent.join("', '")}' \u2014 the canonical key is '${f.field}')` : ""}`);
  if (notMeasured.length) reasons.push(`${notMeasured.length} of ${nodesExpected} node spec(s) were never measured`);
  if (high) reasons.push(`${high} high-severity value mismatch(es)`);
  if (medium) reasons.push(`${medium} medium-severity value mismatch(es)`);
  if (componentsAbsent.length) reasons.push(`${componentsAbsent.length} component set(s) reported ABSENT from the build by the probe`);
  if (interactionsFailed.length) reasons.push(`${interactionsFailed.length} designed interaction(s) failed`);
  if (interactionsNotProbed.length) reasons.push(`${interactionsNotProbed.length} designed interaction(s) were not probed`);
  const fieldGapsOther = fieldsNotMeasured.length;
  if (fieldGapsOther) reasons.push(`${fieldGapsOther} value(s) on measured nodes were not reported by the probe${fieldsReportedNull ? ` (${fieldsReportedNull} reported null \u2014 the probe could not read them)` : ""}`);
  const verdict = reasons.length === 0 ? accepted || interactionsDescoped.length ? "pass-with-deviations" : "pass" : integrityFailed ? "incomplete" : high || componentsAbsent.length || interactionsFailed.length ? "fail" : "incomplete";
  const coverage = {
    nodesExpected,
    nodesMeasured,
    nodesNotMeasured: notMeasured.length,
    nodesMatchedByComponentPath,
    fieldsChecked,
    fieldsNotMeasured: fieldsNotMeasured.length,
    fieldsNeverMeasured,
    valuesNotComparable: (expectation.notComparable || []).length,
    valuesUnverifiable: unverifiable.length,
    ...ifDefined("hiddenLayersSkipped", expectation.counts && expectation.counts.hidden || void 0),
    instanceSets: bySet.size,
    instanceSetsWithEvidence: bySet.size - untaggedInstanceSets.length,
    instanceSetsViaSharedPath: setsViaSharedPath,
    interactionsExpected: interactions.length,
    interactionsPassed: interactionsPassed.length,
    interactionsFailed: interactionsFailed.length,
    interactionsNotProbed: interactionsNotProbed.length,
    interactionsUndesigned: interactionsUndesigned.length,
    interactionsDescoped: interactionsDescoped.length,
    deltasAccepted: accepted,
    nodesFolded: folded.length,
    matchedBy: matchedByCensus,
    ...ifDefined("sharedShell", sharedShell),
    ...probeBound ? { interactionsByProbe: interactions.filter((i) => i.evidenceFrom === "probe").length } : {},
    pageOverflow
  };
  let against;
  if (opts.against) {
    const prev = opts.against.report;
    const pb = prev.inputs ? prev.inputs.build : void 0;
    const prevBuild = isBuildIdentity(pb) ? pb : null;
    const pc = prev.coverage;
    const shaOf = (p) => isJsonObject(p) && typeof p.sha256 === "string" ? p.sha256 : null;
    const prevSha = shaOf(prev.inputs && prev.inputs.probe), curSha = probeIdentity ? probeIdentity.sha256 : null;
    const prevExp = prev.inputs && typeof prev.inputs.expectationSha256 === "string" ? prev.inputs.expectationSha256 : null;
    against = {
      report: opts.against.file,
      nodesMeasured: { before: pc && num(pc.nodesMeasured) ? pc.nodesMeasured : null, after: nodesMeasured },
      nodesExpected: { before: pc && num(pc.nodesExpected) ? pc.nodesExpected : null, after: nodesExpected },
      probeChanged: prevSha === null && curSha === null ? null : prevSha !== curSha,
      expectationChanged: prevExp && opts.expectationSha256 ? prevExp !== opts.expectationSha256 : null,
      ...Array.isArray(prev.deltas) ? { deltas: deltaChanges(prev.deltas, deltas, {
        notMeasured,
        fieldsNotMeasured,
        unverifiable,
        notComparable: expectation.notComparable || [],
        specIds: new Set(specs.map((sp) => String(sp.nodeId))),
        absent: absentGaps,
        placementGaps,
        pageOverflow,
        sameMeasured: !!(opts.measuredSha256 && prev.inputs && prev.inputs.measuredSha256 === opts.measuredSha256)
      }) } : {},
      // unknown when either side's hash is partial (bodies left out) — never "the same build" on a partial hash
      sameBuild: prevBuild && buildNow && !prevBuild.unhashed && !buildNow.unhashed ? prevBuild.assetsSha256 === buildNow.assetsSha256 : null
    };
  }
  const prevCode = opts.against && opts.against.report.inputs ? opts.against.report.inputs.code : void 0;
  const codeNow = opts.code ? opts.code.files : {};
  const common = prevCode ? Object.keys(prevCode.files).filter((f) => Object.hasOwn(codeNow, f)) : [];
  const codeChanged = prevCode && opts.code ? common.length ? common.some((f) => prevCode.files[f] !== codeNow[f]) : !!(prevCode.gitHead && opts.code.gitHead && prevCode.gitHead !== opts.code.gitHead) : false;
  const sameBuildServed = !!(against && against.sameBuild === true && codeChanged);
  const lost = against && against.deltas ? against.deltas.lostCoverage.length : 0;
  const unmatchedCount = unmatchedInteractionEvidence.length;
  const fell = against && against.nodesMeasured.before !== null && against.nodesMeasured.after < against.nodesMeasured.before;
  const mark = verdict.toUpperCase();
  const systemic = fieldsNeverMeasured.filter((f) => f.expectedOn >= NEVER_MEASURED_HEADLINE_MIN || f.probeSent || !keysSeen.has(f.field));
  const headline = `${mark} \u2014 ` + (systemic.length ? `NEVER MEASURED: ${systemic.map((f) => `'${f.field}' present on 0 of ${f.expectedOn} nodes that state it${f.probeSent ? ` (probe sent '${f.probeSent.join("', '")}')` : ""}`).join("; ")} \xB7 ` : "") + `nodes measured ${nodesMeasured}/${nodesExpected}${folded.length ? ` (${folded.length} folded)` : ""}${sharedShell ? ` (shared shell ${sharedShell.measured}/${sharedShell.expected})` : ""} \xB7 ${fieldsChecked} values compared \xB7 ${high} high${highCauses < high ? ` (${highCauses} cause${highCauses === 1 ? "" : "s"})` : ""}, ${medium} medium` + (lowConfidence ? ` (+${lowConfidence} capped on low-confidence matches)` : "") + (accepted ? ` \xB7 ${accepted} accepted` : "") + (reopened.length ? ` \xB7 ${reopened.length} waiver(s) REOPENED` : "") + " \xB7 " + // (not a verdict reason, like ::placeholder colour — but never silent: an <img> icon's fill is not a pass)
  (unverifiable.length ? `${unverifiable.length} value(s) unverifiable by method \xB7 ` : "") + `interactions ${interactionsPassed.length} pass, ${interactionsFailed.length} fail, ${interactionsNotProbed.length} not-probed` + (interactionsUndesigned.length ? `, ${interactionsUndesigned.length} undesigned` : "") + (interactionsDescoped.length ? `, ${interactionsDescoped.length} descoped` : "") + ` of ${interactions.length} \xB7 data-dt-node/component evidence ${coverage.instanceSetsWithEvidence}/${bySet.size} instance sets (tag coverage, not presence)` + (against && fell ? ` \xB7 COVERAGE FELL ${against.nodesMeasured.before}\u2192${against.nodesMeasured.after} vs ${against.report}` : "") + (against && against.probeChanged === true ? " \xB7 probe changed" : "") + // unmatched probe results — informational, never the verdict
  (unmatchedCount ? ` \xB7 ${unmatchedCount} probe result(s) matched no designed interaction` : "") + (inferredHead ? ` \xB7 ${inferredHead} inferred (not designed${inferredUndesigned ? `; the ${inferredUndesigned} undesigned interaction(s) are counted above` : ""})` : "") + (lost ? ` \xB7 LOST COVERAGE on ${lost} earlier delta(s)` : "") + (foreignTags ? ` \xB7 ${foreignTags.total} foreign tag(s) (${foreignTags.prefixDrift} prefix drift, ${foreignTags.alias} alias, ${foreignTags.unknown} unknown)` : "") + (sameBuildServed && against ? ` \xB7 SAME BUILD SERVED as ${against.report} although the code changed (stale preview/dist?)` : "");
  const visual = visualReport(measured.visual, opts.visualMalformed === true, { diff: opts.visualDiff ?? null, against: opts.against ?? null, noProbe: !isProbeIdentity(measured.probe) });
  const devs = planNow && Array.isArray(planNow.plan.deviations) ? planNow.plan.deviations : [];
  const illustrative = [];
  for (const d of devs) {
    if (!isJsonObject(d) || d.field !== "reference") continue;
    const ids = [...typeof d.nodeId === "string" && d.nodeId ? [d.nodeId] : [], ...Array.isArray(d.nodeIds) ? d.nodeIds.filter((x) => typeof x === "string" && x !== "") : []];
    const reason = typeof d.reason === "string" && d.reason ? d.reason : typeof d.what === "string" ? d.what : "";
    for (const id of ids.length ? ids : typeof rootF.nodeId === "string" ? [rootF.nodeId] : []) illustrative.push({ nodeId: id, reason });
  }
  if (illustrative.length && planNow) {
    visual.illustrative = illustrative;
    visual.headline += ` (the plan marks the reference illustrative for ${illustrative.length} node(s))`;
    inputNotes.push(`${planNow.file} marks the reference PNG illustrative (deviations field "reference") for ${illustrative.map((r) => r.nodeId).join(", ")} \u2014 the visual diff there shows a stand-in; no delta is waived or changed`);
  }
  return {
    schema: REPORT_SCHEMA,
    ...ifDefined("screen", expectation.screen),
    ...ifDefined("exportedAt", expectation.exportedAt),
    measuredAt: measured.measuredAt || (/* @__PURE__ */ new Date()).toISOString(),
    renderer: measured.renderer || "unknown",
    ...ifDefined("viewport", measured.viewport),
    artifacts: artifactCheck || (Array.isArray(measured.artifacts) ? measured.artifacts : []),
    // --record-plan records a static-only run as static-only, with its why
    ...staticOnly ? { mode: "static-only", ...ifDefined("reason", measured.reason || void 0) } : {},
    inputs,
    verdict,
    headline,
    // copied and counted, read by nothing above
    behaviour: behaviourReport(measured.behaviour, opts.behaviourMalformed === true),
    // copied, read by nothing above
    visual,
    why: reasons,
    integrity,
    coverage,
    summary: {
      high,
      medium,
      low: open.filter((d) => d.severity === "low").length,
      componentsAbsent: componentsAbsent.length,
      interactionsFailed: interactionsFailed.length,
      interactionsNotProbed: interactionsNotProbed.length,
      accepted,
      descoped: interactionsDescoped.length,
      undesigned: interactionsUndesigned.length,
      inferred: inferred.length,
      highCauses,
      lowConfidence
    },
    deltas: deltas.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]),
    componentsAbsent,
    untaggedInstanceSets: untaggedOnScreen,
    ...untaggedInstanceSetsInShell.length ? { untaggedInstanceSetsInShell } : {},
    interactions,
    ...inferred.length ? { inferred } : {},
    notMeasured,
    fieldsNotMeasured,
    unverifiable,
    notComparable: expectation.notComparable || [],
    waivers: { applied, reopened, unused },
    folded,
    probe: {
      unknownKeys: [...unknownKeys].map(([key, count]) => ({ key, count, ...ifDefined("canonical", KEY_HINTS[key]) })),
      unknownTopLevelKeys: Object.keys(measured).filter((k) => !Object.hasOwn(MEASURED_TOP_KEYS, k) && !MEASURED_UNTYPED_TOP_KEYS.has(k)).map((key) => ({ key, ...ifDefined("canonical", TOP_KEY_HINTS[key]) })),
      duplicateNodeIds,
      interactionEvidenceOnHiddenLayers: interactionEvidenceOnHidden,
      interactionEvidenceNotInExpectation: unexpectedInteractionEvidence,
      ...unmatchedInteractionEvidence.length ? { unmatchedInteractionEvidence } : {},
      measuredIdsOnHiddenLayers: [...byId.keys()].filter((id) => hiddenSet.has(id)).length,
      measuredIdsNotInExpectation: measuredIdsNotInExpectation.length,
      measuredIdsNotInExpectationSample: measuredIdsNotInExpectation.slice(0, 5),
      ...ifDefined("foreignTags", foreignTags),
      ...inputNotes.length ? { inputNotes } : {}
    },
    ...ifDefined("against", against),
    limits: LIMITS
  };
}
function matchedLine(census) {
  const c = census || {};
  const always = ["tag", "text", "textOrdinal", "position"];
  const keys = [...always, ...MATCH_BUCKETS.filter((b) => !always.includes(b) && (c[b] ?? 0) > 0)];
  return keys.map((k) => `${MATCH_LABEL[k] ?? k} ${c[k] ?? 0}`).join(" \xB7 ");
}
function probeLine(r) {
  const p = r.inputs && r.inputs.probe;
  const who = p && p !== "unknown" ? `probe ${p.name} ${p.version ?? "(no version)"} (sha ${p.sha256.slice(0, 12)}\u2026) \xB7 ${p.playwright.package} ${p.playwright.version} \xB7 ${p.browser.name} ${p.browser.version}` : "probe unknown (hand-written \u2014 not comparable round to round)";
  return `${who} \xB7 matched: ${matchedLine(r.coverage && r.coverage.matchedBy)}`;
}
var VISUAL_NO_BLOCK = "the measured file carries no visual diff (hand-written, or a probe that predates the visual diff)";
var VISUAL_NOT_APPLICABLE = "not applicable (no web probe)";
var VISUAL_MALFORMED = "the measured file's visual block is malformed \u2014 ignored (see the input notes)";
var VISUAL_PREFIX = "VISUAL (informational \u2014 never the verdict) \u2014 ";
var pctText = (n) => n > 0 && n < 0.05 ? "<0.1" : (Math.round(n * 10) / 10).toFixed(1);
function visualHeadline(r, shiftPx, notComparedPct) {
  if (!r.ran) return r.why === VISUAL_NOT_APPLICABLE ? VISUAL_PREFIX + VISUAL_NOT_APPLICABLE : `${VISUAL_PREFIX}not run (${r.why || "no reason recorded"})`;
  const n = r.regionsTotal ?? r.regions.length;
  const parts = [
    `${pctText(r.shiftTolerantPct ?? 0)}% of pixels differ (${pctText(r.differingPct ?? 0)}% before ${shiftPx ?? 1}-px shift tolerance)`,
    `${n} hot region${n === 1 ? "" : "s"}`
  ];
  const at = r.reference ? ` (${r.reference.from})` : "";
  parts.push(r.grid === "1x" ? `resampled to 1x (reference ${r.scale ?? "?"}x${at}) \u2014 resampling can hide a difference` : `at the reference's ${r.scale ?? "?"}x${at}`);
  if (notComparedPct) parts.push(`${pctText(notComparedPct)}% of the design window not compared`);
  if (r.reference && r.reference.colorProfile) parts.push(`${r.reference.colorProfile}: colours not colour-managed`);
  if (r.diff) parts.push(r.diff.exists ? r.diff.path : `${r.diff.path} (missing)`);
  return VISUAL_PREFIX + parts.join(" \xB7 ");
}
function visualReport(v, malformed = false, o) {
  const none = (why) => {
    const r3 = { ran: false, why, regions: [], notes: [] };
    return { ...r3, headline: visualHeadline(r3) };
  };
  if (v === void 0) return none(malformed ? VISUAL_MALFORMED : o && o.noProbe ? VISUAL_NOT_APPLICABLE : VISUAL_NO_BLOCK);
  if (!isMeasuredVisual(v)) return none(VISUAL_MALFORMED);
  if (!v.ran) return none(v.why);
  const notes = [];
  const raw = v.regions;
  const regions = raw.filter(isVisualRegion);
  if (regions.length < raw.length) notes.push(`${raw.length - regions.length} malformed region row(s) left out`);
  const rt = v.regionsTotal, ref = v.reference, grid = v.grid, cap = v.capture, nc = v.notCompared, sp = v.shiftPx, dp = v.diff;
  const from = isJsonObject(ref) ? ref.from === "index" ? "index" : ref.from === "export" ? "export" : null : null;
  const reference = isJsonObject(ref) && typeof ref.path === "string" && from ? { path: ref.path, from, ...ifDefined("colorProfile", typeof ref.colorProfile === "string" ? ref.colorProfile : void 0), ...ifDefined("sha256", typeof ref.sha256 === "string" ? ref.sha256 : void 0) } : void 0;
  const refScale = isJsonObject(ref) && num(ref.scale) ? ref.scale : void 0;
  const scale = refScale ?? (isJsonObject(cap) && num(cap.dsf) ? cap.dsf : void 0);
  const g = grid === "reference" ? "reference" : grid === "1x" ? "1x" : void 0;
  const notCompared = isJsonObject(nc) && num(nc.pct) ? { pct: nc.pct, why: typeof nc.why === "string" ? nc.why : "" } : void 0;
  if (notCompared && notCompared.pct > 0) notes.push(`${pctText(notCompared.pct)}% of the design window not compared${notCompared.why ? ` (${notCompared.why})` : ""}`);
  const own = Array.isArray(v.notes) ? v.notes : [];
  notes.unshift(...own.filter((n) => typeof n === "string"));
  const diff = typeof dp === "string" && dp ? o && o.diff ? o.diff : { path: dp, exists: fs9.existsSync(dp) } : void 0;
  let against;
  const pv = o && o.against ? o.against.report.visual : void 0;
  if (o && o.against && isJsonObject(pv) && pv.ran === true && num(pv.shiftTolerantPct) && pv.grid === g && reference && reference.sha256 && isJsonObject(pv.reference) && pv.reference.sha256 === reference.sha256) against = { report: o.against.file, before: pv.shiftTolerantPct, after: v.shiftTolerantPct };
  const r = {
    ran: true,
    differingPct: v.differingPct,
    shiftTolerantPct: v.shiftTolerantPct,
    ...ifDefined("grid", g),
    ...ifDefined("scale", scale),
    ...ifDefined("reference", reference),
    regions,
    regionsTotal: num(rt) ? rt : regions.length,
    ...ifDefined("diff", diff),
    notes,
    ...ifDefined("against", against)
  };
  return { ...r, headline: visualHeadline(r, num(sp) ? sp : void 0, notCompared ? notCompared.pct : void 0) };
}
var VISUAL_MD_ROWS = 10;
function visualMarkdown(v) {
  const L = ["## Visual diff \u2014 informational, not part of the verdict", ""];
  L.push("*The pixel diff never changes the fidelity verdict above. Font rasterisation alone differs 1\u20133% on text-heavy screens (Figma's renderer vs Chromium), so read the regions, not the percentage.*", "");
  if (!v.ran) {
    L.push(v.why === VISUAL_NOT_APPLICABLE ? "Not applicable (no web probe)." : `Not run (${mdText(v.why) || "no reason recorded"}).`, "");
    return L;
  }
  L.push(`${pctText(v.shiftTolerantPct ?? 0)}% of the compared pixels differ after the shift tolerance (${pctText(v.differingPct ?? 0)}% before it; anti-aliased edge pixels excluded) \xB7 ${v.regionsTotal ?? v.regions.length} hot region(s).`, "");
  if (v.reference) L.push(`Reference: ${mdText(v.reference.path)} at ${v.scale ?? "?"}x (geometry from the ${v.reference.from === "index" ? "export index" : "export root, recomputed"}).`, "");
  if (v.grid === "1x") L.push("Grid: **resampled to 1x** \u2014 the capture and the reference crop differ by more than 2 px, so both were resampled to the design size (up or down); resampling can hide a difference.", "");
  else if (v.grid) L.push("Grid: the reference's own pixel grid (the build rendered at the reference's scale).", "");
  if (v.reference && v.reference.colorProfile) L.push(`Colour profile: ${mdText(v.reference.colorProfile)} \u2014 colours are compared without colour management, so colour differences are unreliable.`, "");
  if (v.regions.length) {
    L.push("| Region (x, y) | Size | Differ | Built nodes | Designed nodes |", "|---|---|---|---|---|");
    for (const g of v.regions.slice(0, VISUAL_MD_ROWS)) {
      L.push(`| ${Math.round(g.rect.x)}, ${Math.round(g.rect.y)} | ${Math.round(g.rect.w)}\xD7${Math.round(g.rect.h)} | ${pctText(g.pct)}% (${g.pixels} px) | ${g.built.map(mdText).join(", ")} | ${g.designed.map(mdText).join(", ")} |`);
    }
    const total = v.regionsTotal ?? v.regions.length;
    if (total > Math.min(v.regions.length, VISUAL_MD_ROWS)) L.push(`| \u2026and ${total - Math.min(v.regions.length, VISUAL_MD_ROWS)} more (the largest are listed) | | | | |`);
    L.push("");
  }
  if (v.diff) L.push(`Diff image: ${mdText(v.diff.path)}${v.diff.exists ? "" : " (missing on disk)"}`, "");
  if (v.against) L.push(`Against the previous round (${mdText(v.against.report)}): visual: ${pctText(v.against.before)} % \u2192 ${pctText(v.against.after)} % (same reference, same grid; never the verdict).`, "");
  for (const n of v.notes) L.push(`- ${mdText(n)}`);
  if (v.notes.length) L.push("");
  return L;
}
var BEHAVIOUR_ORDER = { fail: 0, warn: 1, "not-run": 2, unsupported: 3, pass: 4 };
var BEHAVIOUR_NO_BLOCK = "the measured file carries no behaviour checks (hand-written, or a probe that predates the behaviour checks)";
var BEHAVIOUR_MALFORMED = "the measured file's behaviour block is malformed \u2014 ignored (see the input notes)";
var NAMES_LABEL = "names computed by Playwright (Chromium), not screen-reader verified";
var BEHAVIOUR_PREFIX = "BEHAVIOUR/A11Y (not the fidelity verdict) \u2014 ";
function moreCount(c) {
  const ev = c.evidence;
  const n = ev ? ev.count : void 0;
  if (!ev || c.status === "pass" || typeof n !== "number" || !Number.isInteger(n) || n <= 0) return null;
  if (ev.more === true) return n;
  return ev.more === void 0 && c.detail.startsWith(`+${n} more `) ? n : null;
}
function behaviourSummary(checks) {
  const s = { pass: 0, fail: 0, warn: 0, notRun: 0, unsupported: 0 };
  for (const c of checks) {
    const n = moreCount(c) ?? 1;
    if (c.status === "not-run") s.notRun += n;
    else s[c.status] += n;
  }
  return s;
}
function behaviourHeadline(summary, o) {
  if (!o.ran) return `${BEHAVIOUR_PREFIX}not run (${o.why || "no reason recorded"})`;
  const parts = [`${summary.fail} fail`, `${summary.warn} warn`, `${summary.pass} pass`, `${summary.notRun} not run`];
  if (summary.unsupported) parts.push(`${summary.unsupported} unsupported`);
  if (o.cut) parts.push("cut by the time budget");
  if (o.axe) parts.push("version" in o.axe ? `axe-core ${o.axe.version}` : "axe-core not run");
  parts.push(NAMES_LABEL);
  return BEHAVIOUR_PREFIX + parts.join(" \xB7 ");
}
function behaviourReport(b, malformed = false) {
  const none = (why) => {
    const summary2 = behaviourSummary([]);
    return { ran: false, why, summary: summary2, headline: behaviourHeadline(summary2, { ran: false, why }), checks: [] };
  };
  if (b === void 0) return none(malformed ? BEHAVIOUR_MALFORMED : BEHAVIOUR_NO_BLOCK);
  if (!isMeasuredBehaviour(b)) return none(BEHAVIOUR_MALFORMED);
  if (!b.ran) return none(b.why);
  const checks = b.checks.map((c, i) => ({ c, i })).sort((x, y) => BEHAVIOUR_ORDER[x.c.status] - BEHAVIOUR_ORDER[y.c.status] || x.i - y.i).map((x) => x.c);
  const summary = behaviourSummary(checks);
  const ax = b.axe;
  const axe = !isJsonObject(ax) ? void 0 : ax.ran === true && typeof ax.version === "string" ? { version: ax.version } : ax.ran === false ? { notRun: typeof ax.why === "string" ? ax.why : "no reason recorded" } : void 0;
  const artifacts = b.artifacts;
  const arts = Array.isArray(artifacts) ? artifacts.filter((a) => typeof a === "string") : [];
  const names = b.namesComputedBy;
  const cut = b.cut;
  const block = b.writeBlock;
  return {
    ran: true,
    summary,
    headline: behaviourHeadline(summary, { ran: true, axe, cut: cut === true }),
    ...ifDefined("namesComputedBy", typeof names === "string" ? names : void 0),
    ...ifDefined("axe", axe),
    checks,
    ...arts.length ? { artifacts: arts } : {},
    ...ifDefined("writeBlock", typeof block === "string" ? block : void 0)
  };
}
var mdText = (x) => (x ?? "").replace(/\r?\n|\r/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "\\|").replace(/`/g, "\\`");
var behaviourWhere = (c) => [c.nodeId ? mdText(c.nodeId) : "", c.trigger ? `(${mdText(c.trigger)})` : "", c.target ? mdText(c.target) : ""].filter(Boolean).join(" ");
var BEHAVIOUR_MD_ROWS = 80;
function behaviourMarkdown(b) {
  const L = ["## Behaviour and accessibility \u2014 not part of the verdict", ""];
  L.push("*These checks never change the fidelity verdict above. A failed check is still a measurable accessibility failure: fix it or raise a designer question.*", "");
  if (!b.ran) {
    L.push(`Not run (${mdText(b.why) || "no reason recorded"}).`, "");
    return L;
  }
  const s = b.summary;
  L.push(`${s.fail} fail \xB7 ${s.warn} warn \xB7 ${s.pass} pass \xB7 ${s.notRun} not run${s.unsupported ? ` \xB7 ${s.unsupported} unsupported` : ""}`, "");
  const fails = b.checks.filter((c) => c.status === "fail");
  if (fails.length) {
    L.push(`### Failed (${fails.length})`, "");
    for (const c of fails) L.push(`- **${mdText(c.id)}**${behaviourWhere(c) ? ` ${behaviourWhere(c)}` : ""}${c.variant ? ` [${mdText(c.variant)}]` : ""} \u2014 ${mdText(c.detail)}`);
    L.push("");
  }
  if (b.checks.length) {
    L.push("| Status | Check | Node/target | Variant | Detail |", "|---|---|---|---|---|");
    for (const c of b.checks.slice(0, BEHAVIOUR_MD_ROWS)) L.push(`| ${c.status} | ${mdText(c.id)} | ${behaviourWhere(c)} | ${mdText(c.variant)} | ${mdText(c.detail)}${c.synthetic ? " *(synthetic (headless), not a real-browser observation)*" : ""} |`);
    if (b.checks.length > BEHAVIOUR_MD_ROWS) L.push(`| \u2026and ${b.checks.length - BEHAVIOUR_MD_ROWS} more (report.json lists all) | | | | |`);
    L.push("");
  }
  L.push(`Accessible names: ${NAMES_LABEL}${b.namesComputedBy ? ` (${mdText(b.namesComputedBy)})` : ""}.`, "");
  if (b.axe) L.push("version" in b.axe ? `axe-core ${mdText(b.axe.version)} ran on the main frame (iframes not scanned): critical/serious violations fail, moderate/minor warn.` : `axe-core: not run \u2014 ${mdText(b.axe.notRun)}.`, "");
  if (b.artifacts && b.artifacts.length) L.push(`Behaviour artifacts: ${b.artifacts.map(mdText).join(", ")}`, "");
  if (b.writeBlock) L.push(`Write block: ${mdText(b.writeBlock)}`, "");
  return L;
}
function reportToMarkdown(r) {
  const L = [];
  L.push(`# Verify \u2014 ${r.screen}`, "");
  L.push(`**${r.headline || r.verdict.toUpperCase()}**`, "");
  L.push(`**${mdText(r.behaviour.headline)}**`, "");
  L.push(mdText(r.visual.headline), "");
  L.push(`renderer ${r.renderer}${r.viewport ? ` at ${typeof r.viewport === "object" ? JSON.stringify(r.viewport) : r.viewport}` : ""} \xB7 measured ${r.measuredAt}` + (r.inputs && r.inputs.expectationSha256 ? ` \xB7 against expectation ${r.inputs.expectationSha256.slice(0, 12)}\u2026` : "") + (r.inputs && r.inputs.runId ? ` \xB7 run ${r.inputs.runId}` : ""), "");
  const rc = r.inputs && r.inputs.reach;
  if (rc) L.push(`Reached by ${rc.steps} step(s) (sha ${rc.sha256.slice(0, 12)}\u2026, ${rc.source})${rc.matchesPlan === true ? " \u2014 the plan's navigate" : rc.matchesPlan === false ? " \u2014 **not the plan's navigate**" : ""}.`, "");
  const b = r.inputs && r.inputs.build;
  L.push(b && b !== "unknown" ? `Build served: ${b.mode} ${b.url} \xB7 ${b.assets} asset(s), sha256 ${b.assetsSha256.slice(0, 12)}\u2026${b.unhashed ? ` (partial: ${b.unhashed} body(ies) not hashed)` : ""} \xB7 git ${b.gitHead ? b.gitHead.slice(0, 12) : "none"}${b.gitDirty ? " (uncommitted changes)" : ""}` : "Build served: build identity unknown (the measured file records none \u2014 measured by a hand-written or older probe).", "");
  if (r.why.length) {
    L.push("Why this is not a pass:", "");
    for (const w of r.why) L.push(`- ${w}`);
    L.push("");
  }
  const c = r.coverage;
  L.push("## What was actually checked", "");
  L.push("| | |", "|---|---|");
  L.push(`| node specs measured | ${c.nodesMeasured} / ${c.nodesExpected}${c.nodesMatchedByComponentPath ? ` (${c.nodesMatchedByComponentPath} via a shared component's internal path)` : ""}${c.nodesFolded ? ` (+${c.nodesFolded} folded into a measured ancestor, out of the count)` : ""} |`);
  if (c.sharedShell) L.push(`| of which in a shared shell (informational \u2014 matched through another screen's id, or plan anchors[id].shared) | ${c.sharedShell.measured} / ${c.sharedShell.expected} in ${c.sharedShell.instances.map((i) => `${i.name} \`${i.nodeId}\` ${i.measured}/${i.expected}`).join(", ")} |`);
  L.push(`| individual values compared | ${c.fieldsChecked} |`);
  L.push(`| values on measured nodes the probe did not report | ${c.fieldsNotMeasured} |`);
  if (c.fieldsNeverMeasured.length) L.push(`| **fields present in 0 measurements** | ${c.fieldsNeverMeasured.map((f) => `\`${f.field}\`${f.probeSent ? ` (probe sent \`${f.probeSent.join("`, `")}\`)` : ""}`).join(", ")} |`);
  L.push(`| design values excluded by method (listed below) | ${c.valuesNotComparable} |`);
  L.push(`| values the method cannot read unaided | ${c.valuesUnverifiable} |`);
  if (c.hiddenLayersSkipped) L.push(`| hidden layers skipped (not built, not measured, not driven) | ${c.hiddenLayersSkipped.layers} layer(s) \xB7 ${c.hiddenLayersSkipped.specsSkipped} spec(s) \xB7 ${c.hiddenLayersSkipped.instancesSkipped} instance(s) \xB7 ${c.hiddenLayersSkipped.interactionsSkipped} interaction(s) |`);
  L.push(`| instance sets the probe could point at (data-dt-node / component evidence \u2014 coverage, NOT presence) | ${c.instanceSetsWithEvidence} / ${c.instanceSets} |`);
  L.push(`| designed interactions: pass / fail / not-probed | ${c.interactionsPassed} / ${c.interactionsFailed} / ${c.interactionsNotProbed} of ${c.interactionsExpected}${c.interactionsUndesigned ? ` \xB7 ${c.interactionsUndesigned} undesigned (destination never exported)` : ""}${c.interactionsDescoped ? ` \xB7 ${c.interactionsDescoped} descoped by the owner` : ""}${c.interactionsByProbe ? ` \xB7 ${c.interactionsByProbe} driven by the shipped probe (dialog contract)` : ""} |`);
  if (c.pageOverflow !== void 0) L.push(`| page overflow at the design width (overflowX) | ${c.pageOverflow} |`);
  if (c.deltasAccepted) L.push(`| value mismatches accepted by a plan waiver (listed, out of the counts) | ${c.deltasAccepted} |`);
  L.push("");
  L.push(...behaviourMarkdown(r.behaviour));
  L.push(...visualMarkdown(r.visual));
  if (r.against) {
    const a = r.against;
    L.push(`Against the previous round (${a.report}): nodes measured ${a.nodesMeasured.before ?? "?"} \u2192 ${a.nodesMeasured.after}, expected ${a.nodesExpected.before ?? "?"} \u2192 ${a.nodesExpected.after}${a.probeChanged === true ? " \xB7 **the probe changed**" : a.probeChanged === null ? " \xB7 probe identity unknown on both rounds" : ""}${a.expectationChanged ? " \xB7 the expectation changed" : ""}. This never changes the verdict.`, "");
    const d = a.deltas;
    if (d && d.sameMeasured) {
      const rc2 = d.reclassified || [];
      L.push(`Previous deltas (node + field): **the same measured file as last round** \u2014 nothing about the build changed, so nothing is fixed, new or lost; ${d.unchanged} still open${rc2.length ? `, ${rc2.length} reclassified by the compare (or the expectation): ${rc2.filter((x) => x.change === "gone").length} no longer a delta, ${rc2.filter((x) => x.change === "new").length} newly a delta` : ""}.`, "");
      if (rc2.length) {
        L.push(`## Reclassified (${rc2.length})`, "", "*Same measured file \u2014 the compare changed, not the build.*", "", "| Node | Field | Change | Was |", "|---|---|---|---|");
        for (const x of rc2.slice(0, 40)) L.push(`| \`${x.nodeId}\` | ${x.field} | ${x.change === "gone" ? "no longer a delta" : "newly a delta"} | ${x.change === "gone" ? fmt(x.was) : ""} |`);
        if (rc2.length > 40) L.push(`| \u2026and ${rc2.length - 40} more | | | |`);
        L.push("");
      }
    } else if (d) {
      const nu = d.nowUnverifiable || [];
      L.push(`Previous deltas (node + field): ${d.fixed} fixed \xB7 ${d.unchanged} still open \xB7 ${d.new} new \xB7 ${d.lostCoverage.length ? `**${d.lostCoverage.length} lost coverage** (gone only because they were not measured this round)` : "0 lost coverage"}${nu.length ? ` \xB7 ${nu.length} now unverifiable by method (measured, but the compare no longer reads it)` : ""}.`, "");
      if (nu.length) {
        L.push(`## Now unverifiable by method (${nu.length})`, "", "*A previous delta whose value was measured this round, but the compare now declines it \u2014 not lost coverage, not a fix.*", "", "| Node | Field | Was | Why |", "|---|---|---|---|");
        for (const x of nu.slice(0, 40)) L.push(`| \`${x.nodeId}\` | ${x.field} | ${fmt(x.was)} | ${x.why} |`);
        if (nu.length > 40) L.push(`| \u2026and ${nu.length - 40} more | | | |`);
        L.push("");
      }
    }
    if (a.sameBuild === true && r.headline.includes("SAME BUILD SERVED")) L.push("**The same build was served as last round although the code changed** \u2014 a stale preview or dist? Rebuild before measuring a preview.", "");
    if (d && d.lostCoverage.length) {
      L.push(`## Lost coverage (${d.lostCoverage.length})`, "", "*A previous delta that is gone only because its node or value was not measured \u2014 not a fix.*", "", "| Node | Field | Was | Why |", "|---|---|---|---|");
      for (const x of d.lostCoverage.slice(0, 40)) L.push(`| \`${x.nodeId}\` | ${x.field} | ${fmt(x.was)} | ${x.why} |`);
      if (d.lostCoverage.length > 40) L.push(`| \u2026and ${d.lostCoverage.length - 40} more | | | |`);
      L.push("");
    }
  }
  L.push("## How nodes were matched", "");
  const ip = r.inputs && r.inputs.probe;
  L.push(ip && ip !== "unknown" ? `Probe: ${ip.name} ${ip.version ?? "(no version)"} \xB7 sha256 ${ip.sha256.slice(0, 12)}\u2026 \xB7 ${ip.playwright.package} ${ip.playwright.version} \xB7 ${ip.browser.name} ${ip.browser.version}` : "Probe: unknown (a hand-written measured.json \u2014 its numbers are not comparable round to round).", "");
  L.push("| rule | node specs |", "|---|---|");
  for (const b2 of MATCH_BUCKETS) if ((c.matchedBy[b2] ?? 0) > 0 || b2 === "tag") L.push(`| ${MATCH_LABEL[b2] ?? b2} | ${c.matchedBy[b2] ?? 0} |`);
  L.push("");
  if (r.deltas.length) {
    const groups = /* @__PURE__ */ new Map();
    for (const d of r.deltas) if (d.group) getOrInit(groups, d.group, () => []).push(d);
    if (groups.size) {
      L.push(`## Grouped causes (${groups.size})`, "", "*Presentational: every row still counts on its own.*", "");
      for (const [g, list] of groups) {
        const rootId = g.startsWith("placement:") ? g.slice("placement:".length) : null;
        const root = rootId ? list.find((d) => d.nodeId === rootId) : void 0;
        const open = list.filter((d) => !d.accepted);
        L.push(`- \`${g}\` \u2014 ${list[0]?.field ?? ""}, **${list.length} rows**${root ? ` (${root.name || root.nodeId} and ${list.length - 1} inside it)` : ` (${fmt(list[0]?.expected)} \u2192 ${fmt(list[0]?.actual)})`}${open.length < list.length ? ` \xB7 ${list.length - open.length} accepted` : ""} \u2014 accept together: \`--accept <report> --group ${g} --reason \u2026 --by \u2026\``);
      }
      L.push("");
    }
    L.push(`## Value mismatches (${r.deltas.length})`, "", "| Severity | Node | Field | Expected | Actual | Token | Group / accepted |", "|---|---|---|---|---|---|---|");
    for (const d of r.deltas) {
      const status = d.accepted ? `accepted \u2014 ${d.accepted.reason} (${d.accepted.decidedBy}, ${d.accepted.decidedAt})` : d.group ? `\`${d.group}\`` : "";
      L.push(`| ${d.accepted ? `~~${d.severity}~~` : d.severity} | ${d.name || ""} \`${d.nodeId}\` | ${d.field} | ${withUnit(d.expected, d.unit)} | ${withUnit(d.actual, d.unit)} | ${d.token || "\u2014"} | ${status} |`);
    }
    L.push("");
  }
  const wv = r.waivers;
  if (wv && (wv.reopened.length || wv.unused.length)) {
    L.push("## Plan waivers that no longer apply", "");
    for (const w of wv.reopened) L.push(`- **reopened** \`${w.nodeId}\` (${w.field}) \u2014 ${w.why}`);
    for (const w of wv.unused) L.push(`- unused \`${w.nodeId}\` (${w.field})${w.why ? ` \u2014 ${w.why}` : ""}`);
    L.push("");
  }
  if (r.folded && r.folded.length) {
    L.push(`## Folded into a measured ancestor (${r.folded.length} node specs, out of the count)`, "");
    for (const f of r.folded) L.push(`- \`${f.nodeId}\` ${f.name || ""} \u2192 \`${f.into}\` \u2014 ${f.why}`);
    L.push("");
  }
  if (r.componentsAbsent.length) {
    L.push(`## Components the probe reported ABSENT (${r.componentsAbsent.length})`, "");
    for (const m of r.componentsAbsent) L.push(`- **${m.setName}** \u2014 e.g. \`${m.nodeIds[0]}\`${m.detail ? ` \u2014 ${m.detail}` : ""}`);
    L.push("");
  }
  if (r.untaggedInstanceSets.length) {
    L.push(
      `## Instance sets with no evidence in the probe (${r.untaggedInstanceSets.length})`,
      "",
      "*Tag coverage, not presence: these carry no `data-dt-node` and no reported setName. They may well be built \u2014 a repeated row rendered by one `.map()` or a shared shell is expected to leave gaps here. Not a failure on its own.*",
      ""
    );
    for (const m of r.untaggedInstanceSets.slice(0, 40)) L.push(`- ${m.setName} \u2014 ${m.instances} instance(s), e.g. \`${m.nodeIds[0]}\``);
    if (r.untaggedInstanceSets.length > 40) L.push(`- \u2026and ${r.untaggedInstanceSets.length - 40} more`);
    L.push("");
  }
  const inShell = r.untaggedInstanceSetsInShell || [];
  if (inShell.length) {
    L.push(`## Instance sets with no evidence, inside the shared shell (${inShell.length})`, "", "*Built once for every screen \u2014 listed apart, not this screen's work. Not a failure on its own.*", "");
    for (const m of inShell.slice(0, 40)) L.push(`- ${m.setName} \u2014 ${m.instances} instance(s), e.g. \`${m.nodeIds[0]}\``);
    if (inShell.length > 40) L.push(`- \u2026and ${inShell.length - 40} more`);
    L.push("");
  }
  const bad = r.interactions.filter((i) => i.result === "fail" || i.result === "not-probed");
  if (bad.length) {
    L.push(`## Designed interactions not confirmed (${bad.length})`, "");
    for (const i of bad) L.push(`- \`${i.nodeId}\` ${i.name || ""} \u2014 ${i.trigger} \u2192 ${i.action}${i.destinationId ? ` (${i.destinationId})` : ""}${i.source === "plan" ? " [plan]" : ""}: **${i.result}**${i.detail ? ` \u2014 ${i.detail}` : ""}`);
    L.push("");
  }
  const um = r.probe && r.probe.unmatchedInteractionEvidence || [];
  if (um.length) {
    L.push(`## Probe results that matched no designed interaction (${um.length})`, "", "*Copy nodeId and trigger verbatim from the expectation's interactions[]; these results were not graded.*", "");
    for (const u of um.slice(0, 40)) L.push(`- \`${u.nodeId}\` ${u.trigger}${u.hint ? ` \u2014 ${u.hint}` : ""}`);
    if (um.length > 40) L.push(`- \u2026and ${um.length - 40} more`);
    L.push("");
  }
  const ungraded = r.interactions.filter((i) => i.result === "undesigned" || i.result === "descoped");
  if (ungraded.length) {
    L.push(`## Interactions not graded (${ungraded.length})`, "", "*undesigned: the destination was never exported; descoped: the owner removed it (plan.descopes).*", "");
    for (const i of ungraded) L.push(`- \`${i.nodeId}\` ${i.name || ""} \u2014 ${i.trigger} \u2192 ${i.action}${i.destinationId ? ` (${i.destinationId})` : ""}: **${i.result}**${i.detail ? ` \u2014 ${i.detail}` : ""}${i.note ? ` \u2014 ${i.note}` : ""}`);
    L.push("");
  }
  const inf = r.inferred || [];
  if (inf.length) {
    L.push(`## Inferred, not designed (${inf.length})`, "", "*What the build does that the design never drew \u2014 judged against best practice and the design's intent, never 'matched'. Not part of the verdict.*", "");
    for (const x of inf.slice(0, 40)) {
      const what = [x.trigger, x.state ? `state ${x.state}` : void 0].filter((v) => !!v).join(", ");
      L.push(`- ${x.nodeId ? `\`${x.nodeId}\` ` : ""}${x.name ? `${mdText(x.name)} ` : ""}[${x.kind}]${what ? ` ${mdText(what)}` : ""}${x.built ? ` \u2014 built: ${mdText(x.built)}` : ""} \u2014 ${mdText(x.why)}`);
    }
    if (inf.length > 40) L.push(`- \u2026and ${inf.length - 40} more`);
    L.push("");
  }
  if (r.notMeasured.length) {
    L.push(`## Not measured (${r.notMeasured.length} node specs)`, "", "*Gaps in the probe, not clean results.*", "");
    for (const n of r.notMeasured.slice(0, 40)) L.push(`- \`${n.nodeId}\` ${n.name || ""} \u2014 ${n.why}`);
    if (r.notMeasured.length > 40) L.push(`- \u2026and ${r.notMeasured.length - 40} more`);
    L.push("");
  }
  if (r.fieldsNotMeasured.length) {
    L.push(`## Values the probe did not report on measured nodes (${r.fieldsNotMeasured.length})`, "");
    for (const n of r.fieldsNotMeasured.slice(0, 40)) L.push(`- \`${n.nodeId}\` ${n.name || ""} (${n.field}) \u2014 ${n.why}`);
    if (r.fieldsNotMeasured.length > 40) L.push(`- \u2026and ${r.fieldsNotMeasured.length - 40} more`);
    L.push("");
  }
  if (r.notComparable.length || r.unverifiable.length) {
    L.push(`## Excluded by method (${r.notComparable.length + r.unverifiable.length})`, "", "*Stated so they are not mistaken for passes.*", "");
    for (const n of [...r.unverifiable, ...r.notComparable].slice(0, 40)) L.push(`- \`${n.nodeId}\` ${n.name || ""} (${n.field}${"value" in n && n.value !== void 0 ? ` ${fmt(n.value)}` : ""}) \u2014 ${n.why}`);
    if (r.notComparable.length + r.unverifiable.length > 40) L.push(`- \u2026and ${r.notComparable.length + r.unverifiable.length - 40} more`);
    L.push("");
  }
  const p = r.probe || {};
  if (p.unknownKeys && p.unknownKeys.length || p.unknownTopLevelKeys && p.unknownTopLevelKeys.length || p.duplicateNodeIds || p.interactionEvidenceOnHiddenLayers || p.measuredIdsOnHiddenLayers || p.measuredIdsNotInExpectation || p.foreignTags || p.inputNotes && p.inputNotes.length) {
    L.push("## About the probe's input", "");
    for (const k of p.unknownKeys || []) L.push(`- key \`${k.key}\` (${k.count}\xD7) is not read by verify-screen${k.canonical ? ` \u2014 the canonical key is \`${k.canonical}\`` : ""}`);
    for (const k of p.unknownTopLevelKeys || []) L.push(`- top-level key \`${k.key}\` is not read by verify-screen${k.canonical ? ` \u2014 the canonical key is \`${k.canonical}\`` : ""}`);
    if (p.duplicateNodeIds) L.push(`- ${p.duplicateNodeIds} duplicate node id(s) in nodes[] \u2014 the first measurement of each id was used`);
    if (p.measuredIdsOnHiddenLayers) L.push(`- ${p.measuredIdsOnHiddenLayers} measurement(s) are for hidden layers and were ignored`);
    for (const n of p.inputNotes || []) L.push(`- ${n}`);
    if (p.measuredIdsNotInExpectation) L.push(`- ${p.measuredIdsNotInExpectation} measured node id(s) are not in the expectation (e.g. ${(p.measuredIdsNotInExpectationSample || []).map((id) => `\`${id}\``).join(", ")}) \u2014 measured against another screen or an older expectation?`);
    if (p.interactionEvidenceOnHiddenLayers) L.push(`- ${p.interactionEvidenceOnHiddenLayers} interaction result(s) are for hidden layers and were ignored \u2014 a hidden layer cannot be driven`);
    const ft = p.foreignTags;
    if (ft) L.push(`- ${ft.total} tag(s)/id(s) on the page name no node of this expectation (informational): ${ft.prefixDrift} prefix drift (an expected node's \`;\` path under another instance id \u2014 a stale or other screen's id table?), ${ft.alias} another screen's id for one of these nodes (alias), ${ft.unknown} unknown${ft.sample.length ? ` \u2014 e.g. ${ft.sample.map((id) => `\`${id}\``).join(", ")}` : ""}`);
    L.push("");
  }
  L.push("## Limits of this method", "");
  for (const l of r.limits || []) L.push(`- ${l}`);
  return L.join("\n") + "\n";
}
var fmt = (v) => Array.isArray(v) ? v.join("/") : String(v);
var withUnit = (v, unit) => {
  const t = fmt(v);
  return unit && !t.endsWith(unit) ? t + unit : t;
};
var STATUS_STALL_MS = 3e5;
function runStatusNote(base, now = Date.now()) {
  const found = readStatusAt(base);
  if (!found) return null;
  const st = found.status, name = path7.basename(base);
  if (st === "v1") return `${found.file} is a hand-written status (no run id) \u2014 not checked`;
  const detail = st.detail ? ` (${st.detail})` : "";
  if (st.phase === "failed" || st.phase === "blocked") return `the last run of ${name} (run ${st.runId}) ended at phase ${st.phase}${detail} \u2014 its measured/report files are partial; this expectation is safe to re-measure against`;
  if (TERMINAL_PHASES.includes(st.phase)) return null;
  const age = now - Date.parse(st.at);
  if (Number.isFinite(age) && age >= STATUS_STALL_MS) return `the last run of ${name} (run ${st.runId}) never finished \u2014 still at phase ${st.phase}${detail}, ${Math.round(age / 1e3)} s ago; its measured/report files are partial`;
  return `a run of ${name} (run ${st.runId}) is in progress \u2014 phase ${st.phase}${detail}${Number.isFinite(age) ? `, ${Math.round(age / 1e3)} s ago` : ""}; it measures against the expectation it started with`;
}
var PREV_EXPECTED_SUFFIX = ".expected.prev.json";
function findExistingExpectedFor(dir, nodeId, ownTarget) {
  if (!nodeId || !fs9.existsSync(dir)) return null;
  for (const f of fs9.readdirSync(dir)) {
    if (!f.endsWith(".expected.json")) continue;
    const full = path7.join(dir, f);
    if (path7.resolve(full) === path7.resolve(ownTarget)) continue;
    const doc = readJsonOrNull(full, isJsonObject);
    if (doc && isJsonObject(doc.frame) && doc.frame.nodeId === nodeId) return full;
  }
  return null;
}
function plansFor(frameId, stem) {
  const hits = [];
  for (const f of listPlans(PLAN_DIR)) {
    const p = readJsonOrNull(path7.join(PLAN_DIR, f), isPlan);
    if (!p) continue;
    const byId = frameId && (p.nodeId === frameId || new RegExp(`__${String(frameId).replace(":", "_")}$`).test(path7.basename(f, ".json")));
    const byName = path7.basename(f, ".json") === stem || p.file && path7.basename(String(p.file), ".json") === stem;
    if (byId || byName) hits.push({ file: path7.join(PLAN_DIR, f).split(path7.sep).join("/"), plan: p });
  }
  return hits;
}
function samePlanFile(a, b) {
  return path7.resolve(a) === path7.resolve(b);
}
function choosePlan(flagged, frameId, stem) {
  if (flagged) return { hit: { ...flagged, choice: "flag" }, all: [flagged] };
  const all = plansFor(frameId, stem);
  if (all.length === 1 && all[0]) return { hit: { ...all[0], choice: "only" }, all };
  const withFiles = all.filter((h) => h.plan.files);
  if (withFiles.length === 1 && withFiles[0]) return { hit: { ...withFiles[0], choice: "files" }, all };
  return { all };
}
function selectForAccept(rep, sel) {
  const integrity = Array.isArray(rep.integrity) ? rep.integrity : (rep.why || []).filter(isIntegrityReason);
  if (integrity.length) return { error: `the report's run is unverified (${integrity.join("; ")}) \u2014 nothing in it can be accepted; re-measure and --compare, then accept against the new report` };
  const deltas = Array.isArray(rep.deltas) ? rep.deltas : [];
  const picked = sel.group !== void 0 ? deltas.filter((d) => d.group === sel.group) : deltas.filter((d) => d.nodeId === sel.node && (sel.field === void 0 || d.field === sel.field));
  if (picked.length) return { deltas: picked };
  if (sel.group !== void 0) {
    const gs = [...new Set(deltas.map((d) => d.group).filter((g) => !!g))];
    return { error: `no delta in the report belongs to group '${sel.group}'${gs.length ? ` (groups: ${gs.join(", ")})` : " (the report has no groups)"}` };
  }
  const id = sel.node;
  if ((rep.componentsAbsent || []).some((c) => c.nodeIds.includes(String(id)))) return { error: `${id} belongs to a component set reported ABSENT \u2014 a missing component is never waivable; build it` };
  if ((rep.interactions || []).some((i) => i.nodeId === id && i.result === "fail")) return { error: `${id} is a failed interaction \u2014 never waivable; fix it, or have the owner descope it in plan.descopes` };
  if ((rep.notMeasured || []).some((n) => n.nodeId === id)) return { error: `${id} was not measured \u2014 there is no delta to accept; measure it (or fold it, plan anchor foldedInto) first` };
  if (sel.field !== void 0 && (rep.fieldsNotMeasured || []).some((n) => n.nodeId === id && n.field === sel.field)) return { error: `${id} (${sel.field}) was not measured \u2014 there is no delta to accept` };
  const fields = deltas.filter((d) => d.nodeId === id).map((d) => d.field);
  return { error: `no delta in the report for ${id}${sel.field !== void 0 ? ` field '${sel.field}'` : ""}${fields.length ? ` (its deltas: ${fields.join(", ")})` : ""}` };
}
function main(argv) {
  const sha = (file) => sha256Hex(fs9.readFileSync(file));
  const USAGE = `usage:
  ${scriptCmd("verify-screen")} --expect <screen.json>... --out design/verify/<Screen> [--force] [--plan <plan.json>]
      writes <Screen>.expected.json \u2014 the design's own numbers, as data, for VISIBLE layers only.
      The plan for this frame (--plan, else the one plan in design/plan/ that describes it) adds its interactions[]
      ({nodeId, trigger, expect: dialog|url|selector:<css>, destinationId?}) the export cannot carry; a row that cannot
      be graded is dropped with why. Their hash binds the expectation: change them \u2192 re-run --expect.
      Read them; never retype them. --out defaults to design/verify/<the first input file's own basename>.
      Refuses (exit 1) if the same node already has an expectation under a DIFFERENT name in this
      directory \u2014 pass --force to write a second one anyway. Replacing one that differs keeps the old bytes as
      <Screen>.expected.prev.json (one generation) and says why: the export changed, or verify-screen did (same export
      content). It notes a last run of <Screen> that failed, was blocked or never finished (its files are partial).
  ${scriptCmd("verify-screen")} --compare <Screen>.expected.json <measured.json> [--interactions <file>] [--against <report.json>] [--plan <plan.json>] [--record-plan] --out design/verify/<Screen>
      writes <Screen>.report.json + .md and exits 1 unless the verdict passes (pass / pass-with-deviations). It has NO browser: it compares
      two JSON files. Interaction results come from measured.json's interactions[] and/or --interactions <file>
      (a JSON array, or {interactions:[\u2026], components:[\u2026], inferred:[\u2026]}, of {nodeId, trigger, ok, selector, selectorCount, detail};
      components[] rows {setName|nodeId, present} are merged with measured.json's; inferred[] rows {nodeId?, state, built, why?}
      \u2014 what the build does that the design never drew \u2014 are listed under 'Inferred, not designed', never graded).
      --out defaults to design/verify/<the .expected.json file's own basename>.
      Coverage is compared with the report this run overwrites (or --against <report.json>): a drop in nodes
      measured prints COVERAGE FELL, a different probe prints 'probe changed'. Neither changes the verdict.
      Integrity first: a measured file naming no or another expectation, or a run status not finished / naming another
      measured file, makes the verdict 'incomplete' even with high mismatches (the numbers belong to an unverified run).
      The plan for this frame (--plan <plan.json>; else the plan file --expect merged interactions from, while it exists;
      else design/plan/ as at --expect) supplies waivers[] and descopes[]: an accepted
      delta stays listed but leaves the counts; with nothing else open the verdict is 'pass-with-deviations' (exit 0).
      --record-plan: then writes the tool-owned keys of that plan's verification block from the report (mode, renderer,
      artifacts, open high/medium deltas, a11y, recorded{report sha, verdict, counts}); hand keys (coverage, notes) stay.
      No plan, or several and no --plan: exit 2 before comparing. A failed record \u2014 e.g. a report outside the project
      (the plan records project-relative paths only) \u2014 leaves the report written (exit 1).
  ${scriptCmd("verify-screen")} --accept <Screen>.report.json (--node <id> (--field <label> | --all-fields) | --group <gid>) --reason "<why>" --by "<who>" [--plan <plan.json>]
      writes one plan waiver per node + field from the report's delta(s), bound to the export content, the designed
      and the built value (any change reopens it). Only on the owner's explicit word. Refuses a node with no delta:
      absent components, failed interactions and unmeasured nodes are never waivable. Re-run --compare to apply.
  ${scriptCmd("verify-screen")} --status <Screen> --phase <${STATUS_PHASES.join("|")}> [--run <id> | --new-run] [--detail "\u2026"] [--by agent|orchestrator] [--dir design/verify] [--publish <stageDir>]
      writes the run's LIVE status (status v2: runId, rev, machine time) atomically in the run cache \u2014
      node_modules/.cache/designtwin-verify/<Screen>.status.json (the project's: the nearest package.json at or above <dir>, or the
      workspace root its dependencies are hoisted to, never past .git; the OS temp dir, not shared between sandboxed and unsandboxed
      commands, with no package.json or Yarn PnP) \u2014 <dir> resolves against the cwd \u2014 outside every dev-server
      watch, so a heartbeat never reloads the page being measured \u2014 and prints \`run <id> rev <n>\` (stdout), the live file and the run's
      stage dir (stderr). A run that has ended (done/failed/blocked) takes no more writes, with or without --run (exit 2: start a --new-run). \`done\` checks first \u2014 refuses (exit 1)
      a missing measured file (the staged one when --publish holds it), one measured against another expectation, in another run, or
      not the one the probe recorded in this run \u2014 then publishes, records the sha256 of <Screen>.expected/.measured.json (and
      .evidence.json when this run published it), and writes the final status into <dir>/<Screen>.status.json. --publish copies every
      file of a staging directory into <dir> (tmp file in <dir>, then rename) \u2014 stage in the run cache while any page of the app is open.
  ${scriptCmd("verify-screen")} --wait <Screen> --run <id> [--timeout <s>=1200] [--stall <s>=300] [--interval <s>=2] [--dir design/verify]
      waits (on the live status, else <dir>/<Screen>.status.json) until run <id> is done and <Screen>.measured.json is the file it
      names, then prints the --compare command (exit 0; with --interactions only for evidence this run published);
      exit 1 when the run failed or is blocked (prints why), 5 on timeout or when the status did not change for --stall seconds,
      6 when the run cache exists but cannot be read.
exit (--status): 0 wrote \xB7 1 refused \xB7 2 usage \xB7 6 the run cache is not writable (sandbox write scope? \u2014 run from the project root).`;
  if (argv.includes("--help") || argv.includes("-h") || !argv.length) {
    console.log(USAGE);
    return argv.length ? 0 : 2;
  }
  const OPTIONS = {
    out: { type: "string" },
    interactions: { type: "string" },
    against: { type: "string" },
    force: { type: "boolean" },
    expect: { type: "boolean" },
    compare: { type: "boolean" },
    accept: { type: "boolean" },
    node: { type: "string" },
    field: { type: "string" },
    group: { type: "string" },
    reason: { type: "string" },
    by: { type: "string" },
    plan: { type: "string" },
    "all-fields": { type: "boolean" },
    status: { type: "string" },
    wait: { type: "string" },
    phase: { type: "string" },
    run: { type: "string" },
    "new-run": { type: "boolean" },
    detail: { type: "string" },
    dir: { type: "string" },
    publish: { type: "string" },
    timeout: { type: "string" },
    stall: { type: "string" },
    interval: { type: "string" },
    "record-plan": { type: "boolean" },
    help: { type: "boolean", short: "h" }
  };
  const { values: flags, positionals: files } = cliParse("verify-screen", argv, OPTIONS, USAGE, 2, (args) => parseArgs2({ args, options: OPTIONS, allowPositionals: true }));
  const runFlags = ["phase", "run", "new-run", "detail", "dir", "publish", "timeout", "stall", "interval"];
  if (flags.status !== void 0 || flags.wait !== void 0) {
    if (flags.status !== void 0 && flags.wait !== void 0) {
      console.error("pass --status or --wait, not both\n" + USAGE);
      return 2;
    }
    const other = ["expect", "compare", "accept", "out", "interactions", "against", "force", "node", "field", "group", "reason", "plan", "all-fields", "record-plan"].filter((k) => flags[k] !== void 0);
    if (other.length || files.length) {
      console.error(`--${flags.status !== void 0 ? "status" : "wait"} takes none of ${[...other.map((k) => `--${k}`), ...files].join(", ")}
` + USAGE);
      return 2;
    }
    if (flags.wait !== void 0) {
      const bad2 = ["phase", "new-run", "detail", "publish", "by"].filter((k) => flags[k] !== void 0);
      if (bad2.length) {
        console.error(`--wait takes none of ${bad2.map((k) => `--${k}`).join(", ")}
` + USAGE);
        return 2;
      }
      return waitMain(flags.wait, flags, USAGE);
    }
    const bad = ["timeout", "stall", "interval"].filter((k) => flags[k] !== void 0);
    if (bad.length) {
      console.error(`--status takes none of ${bad.map((k) => `--${k}`).join(", ")}
` + USAGE);
      return 2;
    }
    return statusMain(flags.status, flags, USAGE);
  }
  for (const k of runFlags) if (flags[k] !== void 0) {
    console.error(`--${k} only applies to --status / --wait
` + USAGE);
    return 2;
  }
  const { out, interactions: interactionsFile, against: againstFile, plan: planFlag } = flags;
  const force = !!flags.force, doExpect = !!flags.expect, doCompare = !!flags.compare, doAccept = !!flags.accept;
  if ([doExpect, doCompare, doAccept].filter(Boolean).length !== 1) {
    console.error("pass exactly one of --expect / --compare / --accept\n" + USAGE);
    return 2;
  }
  for (const k of ["node", "field", "group", "reason", "by", "all-fields"]) if (flags[k] !== void 0 && !doAccept) {
    console.error(`--${k} only applies to --accept
` + USAGE);
    return 2;
  }
  if (doAccept) return acceptMain(files, flags, USAGE);
  if (interactionsFile !== void 0 && !doCompare) {
    console.error("--interactions only applies to --compare\n" + USAGE);
    return 2;
  }
  if (againstFile !== void 0 && !doCompare) {
    console.error("--against only applies to --compare\n" + USAGE);
    return 2;
  }
  const recordPlanFlag = !!flags["record-plan"];
  if (recordPlanFlag && !doCompare) {
    console.error("--record-plan only applies to --compare\n" + USAGE);
    return 2;
  }
  const write = (base, obj, md2) => {
    if (!base) {
      process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
      return;
    }
    writeFileAtomic(base + (doExpect ? ".expected.json" : ".report.json"), JSON.stringify(obj, null, 2) + "\n");
    if (md2) writeFileAtomic(base + ".report.md", md2);
    console.error(`wrote ${base}${doExpect ? ".expected.json" : ".report.json"}${md2 ? " and " + base + ".report.md" : ""}`);
  };
  if (doExpect) {
    const firstFile = files[0];
    if (firstFile === void 0) {
      console.error("--expect needs at least one screen export\n" + USAGE);
      return 2;
    }
    const docs = files.map((f) => ({ doc: readDocFile(f, "screen export", isScreenDoc), label: path7.basename(f, ".json") }));
    const indexFile = path7.join(EXPORT_DIR, "pages", "index.json");
    const idx = readJson(indexFile, isPagesRootIndex);
    if (!("doc" in idx) && !idx.missing) console.error(`note  ${indexFile} ${idx.error} \u2014 interaction destinations are checked against the given export(s) only`);
    const pagesDir = path7.join(EXPORT_DIR, "pages");
    const pageRows = [];
    let dirs = [];
    try {
      dirs = fs9.readdirSync(pagesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
    }
    for (const d of dirs) {
      const pi2 = readJson(path7.join(pagesDir, d, "index.json"), isPageIndex);
      if ("doc" in pi2) pageRows.push(...pi2.doc.layers);
    }
    const rootRows = "doc" in idx ? idx.doc.layers || [] : [];
    const seen = new Set(rootRows.map((l) => `${l.id}\0${l.sourceFile ?? ""}`));
    const layers = [...rootRows, ...pageRows.filter((l) => !seen.has(`${l.id}\0${l.sourceFile ?? ""}`))];
    const exportRoot = EXPORT_DIR;
    const readSibling = (file) => readJsonOrNull(path7.join(exportRoot, file), isScreenDoc);
    const outBase0 = out || path7.join(VERIFY_DIR, path7.basename(firstFile, ".json"));
    let flagged2;
    if (planFlag !== void 0) {
      const r = readJson(planFlag, isPlan);
      if (!("doc" in r)) {
        console.error(`--plan '${planFlag}' ${r.error}`);
        return 2;
      }
      flagged2 = { file: planFlag.split(path7.sep).join("/"), plan: r.doc };
    }
    const firstRoot = docs.map((d) => screenRoots(d.doc)[0]).find((r) => r !== void 0);
    const chosen = choosePlan(flagged2, firstRoot && firstRoot.id, path7.basename(outBase0));
    const planForExpect = chosen.hit;
    if (chosen.all.length > 1 && chosen.all.some((h2) => h2.plan.interactions !== void 0)) {
      console.error(planForExpect ? `note  ${chosen.all.length} plans in design/plan/ describe this frame (${chosen.all.map((h2) => h2.file).join(", ")}) \u2014 using ${planForExpect.file}, the only one listing files[] (--compare picks the same); pass --plan <plan.json> to choose another` : `note  ${chosen.all.length} plans in design/plan/ describe this frame (${chosen.all.map((h2) => h2.file).join(", ")}) \u2014 no plan interactions merged; pass --plan <plan.json> (here and at --compare)`);
    }
    const readReference = (pointer) => {
      const file = resolveInside(exportRoot, pointer);
      if (file === null) return null;
      try {
        return fs9.readFileSync(file);
      } catch {
        return null;
      }
    };
    const ds = readJsonOrNull(path7.join(exportRoot, "design-system.json"), isJsonObject);
    const colorProfile = ds && typeof ds.colorProfile === "string" ? ds.colorProfile : null;
    const expOpts = { ..."doc" in idx || layers.length ? { index: { layers }, readSibling } : {}, ...planForExpect ? { plan: planForExpect } : {}, readReference, colorProfile };
    const exp = buildExpectation(docs, Object.keys(expOpts).length ? expOpts : null);
    const pi = exp.planInteractions;
    if (pi) {
      console.error(`${pi.plan}: ${pi.merged} plan interaction(s) merged${pi.dropped.length ? `, ${pi.dropped.length} dropped` : ""} (plan interactions sha256 ${pi.sha256.slice(0, 12)}\u2026)`);
      for (const d of pi.dropped) console.error(`warn  plan interaction ${d.nodeId} dropped: ${d.why}`);
    }
    const outBase = outBase0;
    const target = outBase + ".expected.json";
    const dup = findExistingExpectedFor(path7.dirname(target) || ".", exp.frame && exp.frame.nodeId, target);
    if (dup && !force) {
      const oldBase = dup.slice(0, -".expected.json".length);
      const dir = path7.dirname(dup), stemOld = path7.basename(oldBase);
      const oldFiles = fs9.readdirSync(dir).filter((f) => f.startsWith(stemOld + ".") || f.startsWith(stemOld + "-")).sort().map((f) => path7.join(dir, f));
      const canonical3 = path7.join(path7.dirname(target), path7.basename(firstFile, ".json"));
      const oldStatus = runStatusNote(oldBase);
      if (oldStatus) console.error(`note  ${oldStatus}`);
      if (stemOld === path7.basename(canonical3)) {
        console.error(
          `error  node ${exp.frame.nodeId} already has an expectation at ${dup} \u2014 refusing to also write ${target} (one screen, one artefact set). That is the canonical name: drop --out (the default is ${shellArg(canonical3)}), or pass --force to write a second set anyway.`
        );
        return 1;
      }
      console.error(
        `error  node ${exp.frame.nodeId} already has an expectation at ${dup} \u2014 refusing to also write ${target} (one screen, one artefact set).
       existing set under '${stemOld}' (${oldFiles.length} file(s)): ${oldFiles.join(", ")}
       the canonical name for this screen is '${path7.basename(canonical3)}' (<Layer>__<id> \u2014 the screen file's own basename), not '${stemOld}'.
       To move it to the canonical name: mv ${shellArg(dup)} ${shellArg(dup + ".retired")}, then re-run this command` + (path7.resolve(target) === path7.resolve(canonical3 + ".expected.json") ? "" : ` with --out ${shellArg(canonical3)}`) + `, then probe + --compare as usual \u2014 the old measured/report/PNGs stay as history under the old name.
       Or keep the old name: --out ${shellArg(oldBase)}. (--force writes a second, parallel set \u2014 not recommended.)`
      );
      return 1;
    }
    const next = JSON.stringify(exp, null, 2) + "\n";
    const prev = fs9.existsSync(target) ? fs9.readFileSync(target, "utf8") : null;
    const h = sha256Hex(next);
    let prevContent = null;
    try {
      if (prev !== null) {
        const prevDoc = JSON.parse(prev);
        prevContent = isJsonObject(prevDoc) ? prevDoc.exportContentSha256 : null;
      }
    } catch {
    }
    const onlyExportedAt = prev !== null && prev !== next && !!prevContent && prevContent === exp.exportContentSha256 && prev.replace(/"exportedAt": "[^"]*"/, "") === next.replace(/"exportedAt": "[^"]*"/, "");
    const prevFile = outBase + PREV_EXPECTED_SUFFIX;
    if (prev !== null && prev !== next && !onlyExportedAt) writeFileAtomic(prevFile, prev);
    write(outBase, exp);
    const runNote = runStatusNote(outBase);
    if (runNote) console.error(`note  ${runNote}`);
    if (prev !== null && prev === next) console.error(`note  ${target} is byte-identical to the expectation on disk (same export inputs, sha256 ${h.slice(0, 12)}\u2026) \u2014 unchanged; this says nothing about the build: re-measure to check the code`);
    else if (onlyExportedAt) {
      console.error(`note  ${target}: only exportedAt changed (export content sha256 ${exp.exportContentSha256.slice(0, 12)}\u2026 unchanged) \u2014 existing measurements and report still apply`);
    } else if (prev !== null) {
      const why = typeof prevContent === "string" && prevContent === exp.exportContentSha256 ? "same export content \u2014 the expectation generator changed (verify-screen upgrade)" : typeof prevContent === "string" ? `the export changed (content sha ${prevContent.slice(0, 12)}\u2026 \u2192 ${exp.exportContentSha256.slice(0, 12)}\u2026)` : `the expectation recorded no export hash (exportContentSha256) \u2014 cannot tell whether the export or the expectation generator changed`;
      console.error(`note  REPLACED an existing ${target} that differed (sha256 ${sha256Hex(prev).slice(0, 12)}\u2026 \u2192 ${h.slice(0, 12)}\u2026): ${why}; the previous one is kept as ${prevFile}`);
      const stale = [".measured.json", ".report.json", ".report.md"].map((s) => outBase + s).filter((f) => fs9.existsSync(f));
      if (stale.length) console.error(`warn  ${stale.join(", ")} ${stale.length > 1 ? "were" : "was"} computed against the PREVIOUS expectation \u2014 re-measure and re-compare before reading ${stale.length > 1 ? "them" : "it"}.`);
    }
    const hc = exp.counts.hidden;
    const lineBoxes = exp.notComparable.filter((g) => g.field === TEXT_BOX_HEIGHT).length;
    console.error(`${exp.counts.nodes} node spec(s), ${exp.counts.instances} instance(s), ${exp.counts.interactions} designed interaction(s) \u2014 visible layers only; skipped ${hc.layers} hidden layer(s) (${hc.specsSkipped} spec(s), ${hc.instancesSkipped} instance(s), ${hc.interactionsSkipped} interaction(s)); ${exp.counts.notComparable} design value(s) excluded by method (listed in notComparable${lineBoxes ? `; ${lineBoxes} a line box taller than its fixed text box \u2014 the build chooses its line-height` : ""}) \xB7 expectation sha256 ${h.slice(0, 12)}\u2026`);
    const ri = exp.referenceImage;
    if (ri) console.error(ri.usable ? `reference ${ri.path} ${ri.png.w}\xD7${ri.png.h} at ${ri.scale}x (${ri.from})${ri.offset.x || ri.offset.y ? `, offset ${ri.offset.x},${ri.offset.y}` : ""}${ri.colorProfile ? ` \u2014 ${ri.colorProfile}: colours are compared without colour management` : ""}` : `note  no visual diff for this screen: ${ri.why}`);
    if (!exp.counts.interactions) console.error("note  this export declares no `reactions` on visible layers \u2014 interaction coverage cannot be checked, and the report will say so rather than passing.");
    return 0;
  }
  const [expFile, measuredFile] = files;
  if (!expFile || !measuredFile) {
    console.error("--compare needs <expected.json> <measured.json>\n" + USAGE);
    return 2;
  }
  const expectation = readDocFile(expFile, "expectation", isVerifyExpectation);
  const measuredRaw = readJsonFile(
    measuredFile,
    "probe measurements",
    "Render the built screen and write {measuredAt, renderer, viewport, artifacts, expectationSha256, nodes:[{nodeId,styles}], components:[], interactions:[]}."
  );
  const readable = readableMeasured(measuredRaw);
  if (!readable) {
    console.error(`error  probe measurements: '${measuredFile}' is not ${isVerifyMeasured.expected}`);
    return 2;
  }
  const measured = readable.doc;
  for (const n of readable.notes) console.error(`note  ${measuredFile}: ${n}`);
  let extra;
  let extraComponents;
  let extraInferred;
  if (interactionsFile) {
    const raw = readJsonFile(interactionsFile, "interaction evidence", "Write a JSON array of {nodeId, trigger, ok, selector, selectorCount, detail}.");
    const obj = isJsonObject(raw) ? raw : null;
    const list = isInteractionEvidenceList(raw) ? raw : obj && isInteractionEvidenceList(obj.interactions) ? obj.interactions : obj && obj.interactions === void 0 && (obj.components !== void 0 || obj.inferred !== void 0) ? [] : null;
    if (obj && obj.inferred !== void 0) extraInferred = obj.inferred;
    const comps = obj && obj.components !== void 0 ? isMeasuredComponentList(obj.components) ? obj.components : null : [];
    if (!list || !comps) {
      console.error(`--interactions ${interactionsFile}: expected a JSON array or {interactions:[\u2026], components:[\u2026], inferred:[\u2026]}`);
      return 2;
    }
    extra = list;
    if (comps.length) extraComponents = comps;
  }
  const artifacts = measured.artifacts || [];
  const artifactCheck = artifacts.map((a) => {
    const p = typeof a === "string" ? a : a && a.path;
    const exists2 = !!p && fs9.existsSync(p);
    return { ...ifDefined("path", p), exists: exists2, image: !!p && /\.(png|jpe?g|webp)$/i.test(p), ...ifDefined("sha256", exists2 ? sha(p) : void 0) };
  });
  let code;
  let planHit;
  let recordedPlanGone;
  const compareNotes = [];
  let flagged;
  if (planFlag !== void 0) {
    const r = readJson(planFlag, isPlan);
    if (!("doc" in r)) {
      console.error(`--plan '${planFlag}' ${r.error}`);
      return 2;
    }
    flagged = { file: planFlag.split(path7.sep).join("/"), plan: r.doc };
  }
  {
    const frameId = expectation.frame && expectation.frame.nodeId;
    const stem = path7.basename(expFile, ".json").replace(/\.expected$/, "");
    const chosen = choosePlan(flagged, frameId, stem);
    const all = chosen.all;
    const hits = all.filter((h) => h.plan.files);
    const onlyHit = hits.length === 1 ? hits[0] : void 0;
    planHit = chosen.hit;
    const recPi = expectation.planInteractions && isJsonObject(expectation.planInteractions) && typeof expectation.planInteractions.plan === "string" ? expectation.planInteractions.plan : void 0;
    if (recPi !== void 0 && !(planHit && samePlanFile(planHit.file, recPi))) {
      const r = readJson(recPi, isPlan);
      if (!("doc" in r)) recordedPlanGone = r.missing ? "no longer exists" : `is not a readable plan now (${r.error})`;
      else if (!flagged) {
        const foundNow = planHit ? ` instead of ${planHit.file}, the plan found in design/plan/ now` : all.length ? `; ${all.length} plans in design/plan/ describe this frame now (${all.map((h) => h.file).join(", ")})` : "; no plan in design/plan/ describes this frame";
        compareNotes.push(`using ${recPi} (the plan --expect merged interactions from)${foundNow} \u2014 its interactions[], waivers, descopes, anchors and navigate apply; pass --plan <plan.json> to use another`);
        console.error(`note  ${compareNotes[compareNotes.length - 1]}`);
        planHit = { file: recPi, plan: r.doc, choice: "recorded" };
      }
    }
    if (!planHit && all.length > 1) console.error(`note  ${all.length} plans in design/plan/ describe this frame (${all.map((h) => h.file).join(", ")}) \u2014 no waivers/descopes applied; pass --plan <plan.json>`);
    if (recordPlanFlag && !planHit) {
      console.error(all.length > 1 ? `--record-plan: ${all.length} plans in design/plan/ describe this frame (${all.map((h) => h.file).join(", ")}) \u2014 pass --plan <plan.json> to say which one records the run` : "--record-plan: no plan in design/plan/ describes this frame (run from the project root) \u2014 pass --plan <plan.json>");
      return 2;
    }
    if (onlyHit && onlyHit.plan.files) {
      code = { plan: onlyHit.file, files: fileHashes(planCodeFiles(onlyHit.plan, process.cwd()), process.cwd()), gitHead: gitHead(process.cwd()) };
      const skipped = planCodeSkippedNote(onlyHit.plan, process.cwd());
      if (skipped) {
        compareNotes.push(`${onlyHit.file}: ${skipped}`);
        console.error(`note  ${compareNotes[compareNotes.length - 1]}`);
      }
    } else {
      console.error(hits.length ? `note  ${hits.length} plans in design/plan/ describe this frame (${hits.map((h) => h.file).join(", ")}) \u2014 the report records no code hashes, so its status cannot be tied to the code` : all.length ? `note  ${all.map((h) => h.file).join(", ")} list${all.length === 1 ? "s" : ""} no files[] \u2014 the report records no code hashes, so verify-build --status cannot tie it to the code` : "note  no plan in design/plan/ describes this frame \u2014 the report records no code hashes (run from the project root), so verify-build --status cannot tie it to the code");
    }
  }
  const planInputs = planHit ? {
    ...ifDefined("waivers", planHit.plan.waivers),
    ...ifDefined("descopes", planHit.plan.descopes),
    ...ifDefined("anchors", planHit.plan.anchors),
    waiversInput: { plan: planHit.file, sha256: waiversHash(planHit.plan) }
  } : {};
  const compareBase = out || path7.join(VERIFY_DIR, path7.basename(expFile, ".json").replace(/\.expected$/, ""));
  let against;
  if (againstFile !== void 0) {
    const r = readJson(againstFile, isVerifyReport);
    if (!("doc" in r)) {
      console.error(`--against '${againstFile}' ${r.error}`);
      return 2;
    }
    against = { file: againstFile, report: r.doc };
  } else {
    const own = compareBase + ".report.json";
    const r = readJson(own, isVerifyReport);
    if ("doc" in r) against = { file: own, report: r.doc };
    else if (!r.missing) console.error(`note  ${own} ${r.error} \u2014 no coverage baseline this round (it is about to be overwritten)`);
  }
  const measuredBase = /\.measured\.json$/.test(measuredFile) ? measuredFile.replace(/\.measured\.json$/, "") : null;
  const probeBase = measuredBase !== null && typeof measured.runId === "string" && measured.runId ? path7.join(path7.dirname(expFile), path7.basename(measuredBase)) : null;
  const found = measuredBase === null ? null : readStatusAt(measuredBase) ?? (probeBase !== null && path7.resolve(probeBase) !== path7.resolve(measuredBase) ? readStatusAt(probeBase) : null);
  const statusOpt = found ? { status: { file: [measuredBase, probeBase].some((b) => b !== null && found.file === statusFile(b)) ? path7.basename(found.file) : `${path7.basename(found.file)} (live, ${found.file})`, status: found.status } } : measuredBase !== null ? { status: null } : {};
  const vd = measured.visual && measured.visual.ran ? measured.visual.diff : void 0;
  let visualDiff = null;
  if (typeof vd === "string" && vd) {
    const beside = path7.join(path7.dirname(measuredFile), path7.basename(vd));
    visualDiff = fs9.existsSync(vd) ? { path: vd, exists: true } : fs9.existsSync(beside) ? { path: beside.split(path7.sep).join("/"), exists: true } : { path: vd, exists: false };
  }
  const rep = compare(expectation, measured, { ...statusOpt, ...readable.dropped.includes("behaviour") ? { behaviourMalformed: true } : {}, ...readable.dropped.includes("visual") ? { visualMalformed: true } : {}, ...visualDiff ? { visualDiff } : {}, ...readable.notes.length || compareNotes.length ? { inputNotes: [...readable.notes, ...compareNotes] } : {}, ...ifDefined("recordedPlanGone", recordedPlanGone), ...ifDefined("interactions", extra), ...ifDefined("components", extraComponents), ...extraInferred !== void 0 ? { inferred: extraInferred } : {}, expectationSha256: sha(expFile), measuredSha256: sha(measuredFile), artifactCheck, ...ifDefined("code", code), ...ifDefined("against", against), ...planInputs, ...planHit ? { plan: planHit } : {} });
  const md = reportToMarkdown(rep);
  write(compareBase, rep, md);
  console.error(rep.headline);
  console.error(probeLine(rep));
  console.error(rep.behaviour.headline);
  console.error(rep.visual.headline);
  const nie = rep.probe.measuredIdsNotInExpectation || 0;
  if (nie) console.error(`note  ${nie} measured node id(s) are not in the expectation (e.g. ${(rep.probe.measuredIdsNotInExpectationSample || []).join(", ")}) \u2014 measured against another screen or an older expectation?`);
  for (const w of rep.waivers.reopened) console.error(`warn  waiver REOPENED ${w.nodeId} (${w.field}): ${w.why}`);
  if (rep.waivers.unused.length) console.error(`note  ${rep.waivers.unused.length} plan waiver(s)/descope(s) match nothing this round: ${rep.waivers.unused.map((w) => `${w.nodeId} (${w.field})`).join(", ")} \u2014 fixed? drop them`);
  if (recordPlanFlag && planHit) {
    const realOf = (p) => {
      try {
        return fs9.realpathSync(p);
      } catch {
        return p;
      }
    };
    const reportRel = path7.relative(realOf(process.cwd()), realOf(path7.resolve(compareBase + ".report.json"))).split(path7.sep).join("/");
    try {
      const r = recordPlan(planHit.file, rep, reportRel, { cwd: process.cwd() });
      for (const n of r.notes) console.error(`note  ${n}`);
      console.error(r.written ? `recorded ${reportRel} in ${planHit.file} (plan.verification)` : `${planHit.file}: plan.verification already records ${reportRel} \u2014 unchanged`);
    } catch (e) {
      console.error(`error  --record-plan: ${errMsg(e)} \u2014 ${reportRel} is written; ${planHit.file} was not updated`);
      return 1;
    }
  }
  return isPassingVerdict(rep.verdict) ? 0 : 1;
}
function acceptMain(files, flags, USAGE) {
  const reportFile = files[0];
  if (!reportFile || files.length > 1) {
    console.error("--accept needs exactly one <Screen>.report.json\n" + USAGE);
    return 2;
  }
  if (flags.node === void 0 === (flags.group === void 0)) {
    console.error("--accept needs exactly one of --node <id> / --group <gid>\n" + USAGE);
    return 2;
  }
  if ((flags.field !== void 0 || flags["all-fields"]) && flags.group !== void 0) {
    console.error("--field / --all-fields go with --node, not --group\n" + USAGE);
    return 2;
  }
  if (flags.node !== void 0 && flags.field === void 0 === !flags["all-fields"]) {
    console.error('--accept --node needs exactly one of --field "<label>" / --all-fields\n' + USAGE);
    return 2;
  }
  const reason = (flags.reason || "").trim(), by = (flags.by || "").trim();
  if (!reason || !by) {
    console.error(`--accept needs ${!reason ? '--reason "<why this deviation is intended>"' : ""}${!reason && !by ? " and " : ""}${!by ? '--by "<who decided>"' : ""} \u2014 a waiver without a reason and a decider is not recorded
` + USAGE);
    return 2;
  }
  const r = readJson(reportFile, isVerifyReport);
  if (!("doc" in r)) {
    console.error(`error  report: '${reportFile}' ${r.error}`);
    return 2;
  }
  const report = r.doc;
  const exportSha = report.inputs && report.inputs.exportContentSha256;
  if (!exportSha) {
    console.error(`error  ${reportFile} records no inputs.exportContentSha256 \u2014 re-run --expect and --compare, then accept against the new report`);
    return 1;
  }
  const sel = selectForAccept(report, { node: flags.node, field: flags.field, group: flags.group });
  if ("error" in sel) {
    console.error(`refused  ${sel.error}`);
    return 1;
  }
  const stem = path7.basename(reportFile, ".json").replace(/\.report$/, "");
  const recorded = report.inputs && report.inputs.waivers && report.inputs.waivers.plan || report.inputs && report.inputs.code && report.inputs.code.plan || void 0;
  let planFile = flags.plan ?? (recorded && fs9.existsSync(recorded) ? recorded : void 0);
  if (!planFile) {
    const hits = plansFor(report.nodeId, stem);
    const only = hits.length === 1 ? hits[0] : void 0;
    if (!only) {
      console.error(hits.length ? `error  ${hits.length} plans describe this screen (${hits.map((h) => h.file).join(", ")}) \u2014 pass --plan <plan.json>` : "error  no plan in design/plan/ describes this screen (run from the project root, or pass --plan <plan.json>)");
      return 1;
    }
    planFile = only.file;
  }
  const pr = readJson(planFile, isPlan);
  if (!("doc" in pr)) {
    console.error(`error  plan: '${planFile}' ${pr.error}`);
    return 1;
  }
  const plan = pr.doc;
  const decidedAt = (/* @__PURE__ */ new Date()).toISOString();
  const waivers = Array.isArray(plan.waivers) ? [...plan.waivers] : [];
  const wrote = [];
  for (const d of sel.deltas) {
    const row = { nodeId: d.nodeId, field: d.field, designed: d.expected, built: d.actual, exportContentSha256: exportSha, reason, decidedBy: by, decidedAt, ...ifDefined("cause", flags.group) };
    const at = waivers.findIndex((w) => isJsonObject(w) && w.nodeId === d.nodeId && w.field === d.field);
    if (at >= 0) waivers[at] = row;
    else waivers.push(row);
    wrote.push(`${at >= 0 ? "replaced" : "added"}  ${d.nodeId} ${d.name ? `(${d.name}) ` : ""}${d.field}: designed ${fmt(d.expected)}, built ${fmt(d.actual)}`);
  }
  plan.waivers = waivers;
  writePlan(planFile, plan);
  console.error(`wrote ${wrote.length} waiver(s) to ${planFile} (decided by ${by}: ${reason})`);
  for (const w of wrote) console.error(`  ${w}`);
  console.error(`re-run --compare to apply ${wrote.length === 1 ? "it" : "them"}: an accepted delta stays listed, leaves the counts, and reopens if the design is re-exported or the built value moves.`);
  return 0;
}
if (import.meta.main ?? isMainFallback(import.meta.url)) {
  const code = main(process.argv.slice(2));
  if (typeof code === "number") process.exitCode = code;
  else code.then((c) => {
    process.exitCode = c;
  }, (e) => {
    console.error(`verify-screen: ${errMsg(e)}`);
    process.exitCode = 1;
  });
}
export {
  BEHAVIOUR_MALFORMED,
  BEHAVIOUR_NO_BLOCK,
  EXPECTATION_SCHEMA,
  FIELDS,
  INTERACTION_OUTCOMES,
  MEASURED_KEYS_DOC,
  NAMES_LABEL,
  OUTCOMES_FOR_ACTION,
  REPORT_SCHEMA,
  STYLE_KEYS,
  TOLERANCE,
  VISUAL_MALFORMED,
  VISUAL_NOT_APPLICABLE,
  VISUAL_NO_BLOCK,
  behaviourHeadline,
  behaviourReport,
  behaviourSummary,
  buildExpectation,
  compare,
  figmaReferenceScale,
  findExistingExpectedFor,
  lineHeightPx,
  mdText,
  normColor,
  normFamily,
  normWeight,
  pctText,
  probeLine,
  radiusCorners,
  referenceImageFor,
  reportToMarkdown,
  resolveInside,
  selectForAccept,
  tokenFor,
  visualHeadline,
  visualReport
};
