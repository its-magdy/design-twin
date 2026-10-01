// GENERATED from design-to-code/ by claude-plugin/build-scripts.js — edit the source, then rebuild.


// design-to-code/verify-screen.ts
import fs5 from "node:fs";
import path4 from "node:path";
import crypto4 from "node:crypto";

// design-to-code/hidden.ts
var hiddenSelf = (node) => !!(node && typeof node === "object" && "hidden" in node && node.hidden);
var isHidden = (node, ancestorHidden) => !!ancestorHidden || hiddenSelf(node);
function walkWithHidden(root, fn, opts) {
  const pathOf = opts && opts.pathOf || ((n, i) => n.name || n.type || String(i));
  (function go(node, parentHidden, path5, parent, depth) {
    if (!node || typeof node !== "object") return;
    const hidden = isHidden(node, parentHidden);
    fn(node, { hidden, parentHidden: !!parentHidden, path: path5, parent, depth });
    const kids = Array.isArray(node.children) ? node.children : [];
    for (const [i, kid] of kids.entries()) go(kid, hidden, (path5 ? path5 + " > " : "") + pathOf(kid, i), node, depth + 1);
  })(root, false, root ? pathOf(root, 0) : "", null, 0);
}

// design-to-code/content-hash.ts
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

// bridge/src/json-util.ts
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
var sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
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
  return sha256(JSON.stringify(list.map((d) => stripPullTimes(d))));
}
function fileHashes(files, cwd) {
  const out = {};
  for (const rel of isUnknownArray(files) ? files.map(String) : []) {
    try {
      out[rel] = sha256(fs.readFileSync(path.join(cwd, rel))).slice(0, 16);
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

// design-to-code/types.ts
function isJsonObject(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

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
  return isObj(x) && typeof x.url === "string" && (x.mode === "vite-dev" || x.mode === "static" || x.mode === "unknown") && typeof x.assets === "number" && typeof x.assetsSha256 === "string" && (x.gitHead === null || typeof x.gitHead === "string") && (x.gitDirty === null || typeof x.gitDirty === "boolean");
}
var isProbeFrame = (x) => isObj(x) && typeof x.nodeId === "string" && typeof x.selector === "string" && typeof x.via === "string" && isObj(x.rect);
var isCountMap = (x) => isObj(x) && Object.values(x).every((v) => typeof v === "number");
var isNavigation = (x) => isObj(x) && Array.isArray(x.events) && typeof x.afterInitialLoad === "number" && typeof x.reruns === "number";
var isReasonMap = (x) => isObj(x) && Object.values(x).every((v) => typeof v === "string");
var MEASURED_EXTRAS = [
  ["probe", isProbeIdentity, "the shipped probe's identity {name, version, sha256, playwright:{package, version}, browser:{name, version}} \u2014 read as probe: unknown"],
  ["frame", isProbeFrame, "a probe frame {nodeId, selector, via, rect}"],
  ["frames", (x) => Array.isArray(x) && x.every(isProbeFrame), "a list of probe frames {nodeId, selector, via, rect}"],
  ["navigation", isNavigation, "a navigation log {events[], afterInitialLoad, reruns}"],
  ["matchedByCensus", isCountMap, "a {rule: count} map"],
  ["notMeasured", Array.isArray, "a list \u2014 the probe's reasons for unmatched nodes are not used"],
  // group 10: the run it belongs to (F-72) and the build it was served (DT-81)
  ["runId", (x) => typeof x === "string" && x !== "", "a run id (string) \u2014 the measurement is tied to no verify run"],
  ["build", isBuildIdentity, "a build identity {url, mode: vite-dev|static|unknown, assets, assetsSha256, gitHead, gitDirty} \u2014 read as build: unknown"]
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
  for (const [k, ok, what] of MEASURED_EXTRAS) {
    if (copy[k] !== void 0 && !ok(copy[k])) {
      notes.push(`measured.${k} is not ${what}; ignored`);
      delete copy[k];
    }
  }
  if (Array.isArray(copy.nodes)) {
    let dropped = 0;
    copy.nodes = copy.nodes.map((n) => {
      if (!isObj(n) || n.unmeasured === void 0 || isReasonMap(n.unmeasured)) return n;
      dropped++;
      const { unmeasured: _drop, ...rest } = n;
      return rest;
    });
    if (dropped) notes.push(`${dropped} node(s) carry an \`unmeasured\` that is not a {key: reason} map; ignored (their nulls read as 'reported null')`);
  }
  return isVerifyMeasured(copy) ? { doc: copy, notes } : null;
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
function isStringRecord(x) {
  return isObj(x) && Object.values(x).every((v) => typeof v === "string");
}
isStringRecord.expected = "an object of strings";

// design-to-code/plan-waivers.ts
import crypto2 from "node:crypto";
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
  return crypto2.createHash("sha256").update(canonical({ descopes, waivers })).digest("hex");
}

// design-to-code/verify-run.ts
import fs3 from "node:fs";
import os from "node:os";
import path3 from "node:path";
import crypto3 from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

// design-to-code/cli-args.ts
import path2 from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
var SELF = fileURLToPath(import.meta.url);
var shellQuote = (p) => /["$`\\!]/.test(p) ? `'${p.replaceAll("'", `'\\''`)}'` : `"${p}"`;
var shellArg = (a) => /^[\w@%+=:,./-]+$/.test(a) ? a : shellQuote(a);
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
var sha256Of = (data) => crypto3.createHash("sha256").update(data).digest("hex");
function sha256File(file) {
  try {
    return sha256Of(fs3.readFileSync(file));
  } catch {
    return null;
  }
}
var CACHE_NAME = "designtwin-verify";
var shortSha = (s) => sha256Of(s).slice(0, 16);
var isDir = (p) => {
  try {
    return fs3.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
var exists = (p) => fs3.existsSync(p);
function realpath(p) {
  if (typeof fs3.realpathSync.native === "function") {
    try {
      return fs3.realpathSync.native(p);
    } catch {
    }
  }
  return fs3.realpathSync(p);
}
function canonical2(p) {
  const abs = path3.resolve(p);
  try {
    return realpath(abs);
  } catch {
    const parent = path3.dirname(abs);
    return parent === abs ? abs : path3.join(canonical2(parent), path3.basename(abs));
  }
}
var hasPnp = (d) => exists(path3.join(d, ".pnp.cjs")) || exists(path3.join(d, ".pnp.js"));
function isWorkspaceRoot(d) {
  if (exists(path3.join(d, "pnpm-workspace.yaml"))) return true;
  const r = readJson(path3.join(d, "package.json"), anyJson);
  return "doc" in r && isJsonObject(r.doc) && r.doc.workspaces !== void 0;
}
function installRootOf(dir) {
  let P = null;
  for (let d = dir; ; d = path3.dirname(d)) {
    if (exists(path3.join(d, "package.json"))) {
      P = d;
      break;
    }
    if (exists(path3.join(d, ".git")) || path3.dirname(d) === d) return null;
  }
  if (isDir(path3.join(P, "node_modules"))) return P;
  let ws = null;
  for (let d = P; ; d = path3.dirname(d)) {
    if (isWorkspaceRoot(d)) {
      ws = d;
      break;
    }
    if (exists(path3.join(d, ".git")) || path3.dirname(d) === d) break;
  }
  if (ws !== null && isDir(path3.join(ws, "node_modules"))) return ws;
  if (hasPnp(P) || ws !== null && hasPnp(ws)) return null;
  return P;
}
function runCacheOf(verifyDir) {
  const v = canonical2(verifyDir);
  const root = installRootOf(v);
  if (root !== null) {
    const cache = path3.join(root, "node_modules", ".cache", CACHE_NAME);
    const rel = path3.relative(root, v).split(path3.sep).join("/");
    return { dir: rel === "design/verify" ? cache : path3.join(cache, "dirs", shortSha(rel)), root };
  }
  return { dir: path3.join(os.tmpdir(), CACHE_NAME, shortSha(v)), root: v };
}
function runCacheDir(verifyDir) {
  return runCacheOf(verifyDir).dir;
}
var UNWRITABLE_CODES = /* @__PURE__ */ new Set(["EACCES", "EPERM", "EROFS", "ENOENT"]);
var errCode2 = (e) => e && typeof e === "object" && "code" in e && typeof e.code === "string" ? e.code : void 0;
var RunCacheUnwritable = class extends Error {
  cacheDir;
  root;
  /** `code`: the refusal's errno, or "read" when the run cache exists but cannot be read (--wait). ENOENT is not a
   *  permission: a directory on the way was removed while the run wrote there (L-4) */
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
    const code = errCode2(e);
    if (code !== void 0 && UNWRITABLE_CODES.has(code)) {
      const c = runCacheOf(verifyDir);
      throw new RunCacheUnwritable(c.dir, c.root, code);
    }
    throw e;
  }
}
var EXIT_RUN_CACHE = 6;
var liveStatusFile = (base) => path3.join(runCacheDir(path3.dirname(base)), path3.basename(base) + ".status.json");
var stageDirOf = (base, runId) => path3.join(runCacheDir(path3.dirname(base)), "stage", runId);
function writeFileAtomic(file, data) {
  fs3.mkdirSync(path3.dirname(path3.resolve(file)), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs3.writeFileSync(tmp, data);
    fs3.renameSync(tmp, file);
  } catch (e) {
    try {
      fs3.rmSync(tmp, { force: true });
    } catch {
    }
    throw e;
  }
}
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
function writeStatus(base, p) {
  const prev = readStatus(base);
  const same = prev && prev !== "v1" && prev.runId === p.runId ? prev : null;
  const pick = (k) => {
    const v = p[k] ?? (same ? same[k] : void 0);
    return v !== void 0 ? { [k]: v } : {};
  };
  const published = p.published !== void 0 || same && same.published ? [.../* @__PURE__ */ new Set([...same && same.published || [], ...p.published || []])].sort() : void 0;
  const doc = {
    schema: STATUS_SCHEMA,
    screen: path3.basename(base),
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
  inRunCache(path3.dirname(base), () => writeFileAtomic(live, JSON.stringify(doc, null, 2) + "\n"));
  return doc;
}
function publishStatus(base, doc) {
  writeFileAtomic(statusFile(base), JSON.stringify(doc, null, 2) + "\n");
}
var TOOL_OWNED = /\.(expected\.json|report\.json|report\.md|status\.json)$/;
function publishStaged(stageDir, destDir) {
  let entries;
  try {
    entries = fs3.readdirSync(stageDir, { withFileTypes: true });
  } catch (e) {
    return { error: `--publish ${stageDir}: ${errMsg(e).split("\n")[0]}` };
  }
  if (canonical2(stageDir) === canonical2(destDir)) return { error: `--publish ${stageDir} is the verify directory itself \u2014 stage outside the project (D9)` };
  const files = entries.filter((d) => d.isFile()).map((d) => d.name).sort();
  const owned = files.filter((f) => TOOL_OWNED.test(f));
  if (owned.length) return { error: `--publish refuses ${owned.join(", ")} \u2014 expected/report/status files are written by verify-screen itself, never copied in` };
  fs3.mkdirSync(destDir, { recursive: true });
  for (const f of files) {
    const dest = path3.join(destDir, f), tmp = `${dest}.tmp-${process.pid}`;
    try {
      fs3.copyFileSync(path3.join(stageDir, f), tmp);
      fs3.renameSync(tmp, dest);
    } catch (e) {
      try {
        fs3.rmSync(tmp, { force: true });
      } catch {
      }
      return { error: `--publish: copying ${f} failed (${errMsg(e).split("\n")[0]}) \u2014 files before it were published` };
    }
  }
  return { published: files };
}
function runBase(screen, dir) {
  const s = screen.replace(/\.(status|measured|expected|evidence)\.json$/, "");
  return /[\\/]/.test(s) && dir === void 0 ? s : path3.join(dir ?? path3.join("design", "verify"), s);
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
  const S = path3.basename(base), dir = path3.dirname(base);
  const cache = runCacheDir(dir);
  inRunCache(dir, () => {
    fs3.mkdirSync(cache, { recursive: true });
    const probe = path3.join(cache, `.w-${process.pid}`);
    fs3.writeFileSync(probe, "");
    fs3.rmSync(probe, { force: true });
  });
  const shas = {};
  if (phase === "done" || phase === "measured") {
    const staged = phase === "done" ? f.publish !== void 0 ? path3.join(f.publish, S + ".measured.json") : null : path3.join(stageDirOf(base, runId), S + ".measured.json");
    const measFile = staged !== null && fs3.existsSync(staged) ? staged : base + ".measured.json";
    const checked = checkMeasured(base, measFile, runId, sameRun, prevV2);
    if ("refused" in checked) {
      console.error(`refused  ${checked.refused}`);
      return 1;
    }
    shas.expectationSha256 = checked.expectationSha256;
    shas.measuredSha256 = checked.measuredSha256;
  }
  let published;
  if (f.publish !== void 0) {
    const r = publishStaged(f.publish, dir);
    if ("error" in r) {
      console.error(`refused  ${r.error}`);
      return 1;
    }
    published = r.published;
    console.error(`published ${published.length} file(s) from ${f.publish} into ${dir}${published.length ? `: ${published.join(", ")}` : ""}`);
  }
  if (phase === "done") {
    const evName = S + ".evidence.json";
    const ours = (published || []).includes(evName) || !!(sameRun && sameRun.published && sameRun.published.includes(evName));
    const ev = ours ? sha256File(base + ".evidence.json") : null;
    if (ev) shas.evidenceSha256 = ev;
    else if (fs3.existsSync(base + ".evidence.json")) console.error(`note  ${base}.evidence.json was not published in run ${runId} \u2014 not recorded as this run's evidence`);
  }
  const doc = writeStatus(base, { runId, phase, by, ...f.detail !== void 0 ? { detail: f.detail } : {}, ...shas, ...published ? { published } : {} });
  if (phase === "done") publishStatus(base, doc);
  const stage = stageDirOf(base, runId);
  if (!TERMINAL_PHASES.includes(phase)) inRunCache(dir, () => fs3.mkdirSync(stage, { recursive: true }));
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
  const c = runCacheOf(path3.dirname(base));
  const checks = [[c.dir, fs3.constants.R_OK | fs3.constants.X_OK], [liveStatusFile(base), fs3.constants.R_OK]];
  for (const [p, mode] of checks) {
    try {
      fs3.accessSync(p, mode);
    } catch (e) {
      const code = errCode2(e);
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

// design-to-code/map-util.ts
function getOrInit(m, k, init) {
  const have = m.get(k);
  if (have !== void 0) return have;
  const made = init();
  m.set(k, made);
  return made;
}

// bridge/src/is-main.ts
import fs4 from "node:fs";
import { fileURLToPath as fileURLToPath2 } from "node:url";
function isMainFallback(metaUrl) {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    return fs4.realpathSync(argv1) === fs4.realpathSync(fileURLToPath2(metaUrl));
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
  // measured 111.83×38 against 110×36 and the old inclusive 2px tolerance emitted nothing (finding 193).
  size: 1,
  // Frame-relative x/y. Loose enough for sub-pixel layout and a glyph's side-bearing, tight enough that
  // a column 18.94px out of place (finding 192) or a bar 130px below the frame (164) cannot hide.
  position: 2,
  opacity: 0.02
};
function normColor(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  const key = colorKey(s);
  if (key) return key;
  const inner = /^rgba?\(([^)]+)\)$/.exec(s)?.[1];
  if (inner !== void 0) {
    const p = inner.split(/[,\s/]+/).filter(Boolean).map(Number);
    const [r, g, b, a0] = p;
    if (r === void 0 || g === void 0 || b === void 0 || p.some((n) => Number.isNaN(n))) return s;
    const a = a0 ?? 1;
    if (a === 0) return "transparent";
    const hex = (n) => Math.round(n).toString(16).padStart(2, "0");
    return "#" + hex(r) + hex(g) + hex(b) + hex(Math.round(a * 255));
  }
  if (s === "transparent" || s === "rgba(0, 0, 0, 0)") return "transparent";
  return s;
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
var PAINT_TYPES = /* @__PURE__ */ new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "LINE"]);
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
function expectNode(n, ctxOrPath) {
  return expectNodeRow(n, ctxOrPath).spec;
}
function expectNodeRow(n, ctxOrPath) {
  const ctx = ctxOrPath == null ? {} : typeof ctxOrPath === "string" ? { path: ctxOrPath } : ctxOrPath;
  const spec = { nodeId: n.id, name: n.name, type: n.type, ...ifDefined("path", ctx.path) };
  const notComparable = [];
  const skip = (field, value, why) => notComparable.push({ nodeId: n.id, name: n.name, field, value, why });
  if (n.text != null) spec.text = n.text;
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
  }
  if (typeof n.radius === "number") spec.borderRadius = n.radius;
  else if (n.radius && typeof n.radius === "object") {
    const rc = n.radius;
    const corner = (v) => num(v) ? v : 0;
    const c = { tl: corner(rc.tl), tr: corner(rc.tr), br: corner(rc.br), bl: corner(rc.bl) };
    if (c.tr === c.tl && c.br === c.tl && c.bl === c.tl) spec.borderRadius = c.tl;
    else spec.radiusCorners = c;
  }
  const L = n.layout;
  if (L && typeof L === "object") {
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
    if (pad && pad.some((v) => typeof v === "number" && v !== 0)) spec.padding = pad.map((v) => typeof v === "number" ? v : 0);
  }
  if (n.box) {
    if (typeof n.box.w === "number") spec.width = n.box.w;
    if (typeof n.box.h === "number") spec.height = n.box.h;
  }
  const pos = framePosition(n, ctx.frame);
  if (pos) {
    spec.x = pos.x;
    if (pos.y !== void 0) spec.y = pos.y;
    spec.positionFrom = pos.source;
  }
  if (typeof n.opacity === "number" && n.opacity !== 1) spec.opacity = n.opacity;
  const own = drawnStateOf(n);
  if (own) {
    spec.drawnState = own.state;
    spec.drawnStateWhy = own.why;
    spec.drawnStateOwn = true;
  } else if (ctx.inheritedState) {
    spec.drawnState = ctx.inheritedState.state;
    spec.drawnStateWhy = `inside '${ctx.inheritedState.from}', which ${ctx.inheritedState.why}`;
  }
  if (n.tokens && Object.keys(n.tokens).length) spec.tokens = n.tokens;
  if (ctx.frameId) spec.frameId = ctx.frameId;
  Object.defineProperty(spec, "__notComparable", { value: notComparable, enumerable: false });
  return { spec, notComparable };
}
function checkable(spec) {
  return ["text", "placeholderText", "fontSize", "color", "backgroundColor", "fill", "borderRadius", "radiusCorners", "gap", "padding", "borderColor", "x"].some((k) => spec[k] !== void 0);
}
var COORDINATES = "x/y are FRAME-RELATIVE: the node's page-space position minus the frame's own box.x/box.y. Measure el.getBoundingClientRect() minus the rendered frame element's rect (the viewport origin when the frame IS the page). A TEXT node's x is its INK start (the export's renderBox) \u2014 measure it with a Range over the text and report it as textBox {x,w}. TEXT nodes carry no y (vertical ink depends on font metrics). Auto-layout children carry no position (the export does not state one); their parent's is compared.";
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
      if (!reference && root.reference) reference = root.reference;
      const b = root.box || {};
      const frame = { nodeId: root.id, name: root.name, ...ifDefined("w", b.w), ...ifDefined("h", b.h), ...ifDefined("x", b.x), ...ifDefined("y", b.y), clip: root.clip === true };
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
          if (checkable(expectNode(n, { path: c.path }))) hidden.specsSkipped++;
          if (n.type === "INSTANCE" && n.mainComponent) hidden.instancesSkipped++;
          const reactions2 = Array.isArray(n.reactions) ? n.reactions : [];
          for (const r of reactions2) hidden.interactionsSkipped += (Array.isArray(r.actions) ? r.actions : r.action ? [r.action] : []).filter((a) => a && (a.type || a.navigation)).length;
          return;
        }
        const inherited = c.parent ? stateOf.get(c.parent) : void 0;
        const ancestorIds = c.parent ? chainOf.get(c.parent) ?? [] : [];
        chainOf.set(n, c.parent ? [...n.id ? [n.id] : [], ...ancestorIds] : []);
        if (n.id && seen.has(n.id)) return;
        if (n.id) seen.add(n.id);
        const { spec, notComparable: gaps } = expectNodeRow(n, { path: c.path, frame, ...ifDefined("inheritedState", inherited), ...ifDefined("frameId", frameId) });
        spec.ancestorIds = ancestorIds;
        if (n.absolute) spec.absolute = true;
        const par = c.parent;
        const sibs = par && Array.isArray(par.children) ? par.children : [];
        const nFixed = par && typeof par.fixedChildren === "number" ? par.fixedChildren : 0;
        if (par && (fixedNodes.has(par) || nFixed > 0 && sibs.indexOf(n) >= sibs.length - nFixed)) {
          fixedNodes.add(n);
          spec.fixed = true;
        }
        if (spec.drawnState) stateOf.set(n, inherited || { state: spec.drawnState, why: spec.drawnStateWhy || "", from: n.name || n.id });
        if (checkable(spec)) nodes.push(spec);
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
        const reactions = Array.isArray(n.reactions) ? n.reactions : [];
        for (const r of reactions) {
          const actions = Array.isArray(r.actions) ? r.actions : r.action ? [r.action] : [];
          const trigger = r.trigger && (typeof r.trigger === "object" ? r.trigger.type || r.trigger : r.trigger) || r.on || "on_click";
          for (const a of actions) {
            if (!a || !(a.type || a.navigation)) continue;
            const row = {
              nodeId: n.id,
              name: n.name,
              trigger: String(trigger).toLowerCase(),
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
  const specById = new Map(nodes.map((s) => [s.nodeId, s]));
  for (const r of roots) markRepeatedText(r, specById);
  const index = opts && opts.index;
  const unnamedIds = idsByFile.get("");
  const candidatesFor = (file) => {
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
      if (named.size === 0 || covering.some((l) => !l.sourceFile)) return index.layers;
      f = [...named][0] ?? "";
    }
    return index.layers.filter((l) => !l.sourceFile || l.sourceFile === f);
  };
  for (const row of interactions) {
    const file = interactionFile.get(row);
    if (!row.destinationId || file === void 0 || String(row.action).toLowerCase() === "change_to") continue;
    const known = idsByFile.get(file);
    if (!known || known.has(row.destinationId) || unnamedIds && unnamedIds.has(row.destinationId)) continue;
    const candidates = candidatesFor(file);
    if (candidates && !candidates.some((l) => l.id === row.destinationId)) row.destinationExported = false;
  }
  const f0 = frames[0] || {};
  const rootFrame = (f) => ({ ...ifDefined("nodeId", f.nodeId), ...ifDefined("name", f.name), ...ifDefined("w", f.w), ...ifDefined("h", f.h), ...ifDefined("clip", f.clip) });
  return {
    schema: EXPECTATION_SCHEMA,
    ...ifDefined("screen", screen),
    ...ifDefined("exportedAt", exportedAt),
    // P2b round 2 (finding 314): the design's identity without the pull's timestamps, so a no-change
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
    hidden: { roots: hidden.roots, ids: hidden.ids }
  };
}
var KNOWN_MEASURED_KEYS = /* @__PURE__ */ new Set([
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
  "fillSource",
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
  "visible"
]);
var KEY_HINTS = { radius: "borderRadius", borderTopLeftRadius: "borderRadius", background: "backgroundColor", bg: "backgroundColor", w: "width", h: "height", svgFill: "fill", placeholder: "placeholderText", rowGap: "gapVisual", columnGap: "gap" };
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
  { key: "borderWidth", tol: TOLERANCE.padding, label: "border-width", unit: "px" },
  { key: "borderRadius", tol: TOLERANCE.radius, label: "border-radius", unit: "px" },
  { key: "gap", tol: TOLERANCE.gap, label: "gap", unit: "px" },
  { key: "width", tol: TOLERANCE.size, label: "width", unit: "px", box: true },
  { key: "height", tol: TOLERANCE.size, label: "height", unit: "px", box: true },
  { key: "x", tol: TOLERANCE.position, label: "x (frame-relative)", unit: "px", box: true },
  { key: "y", tol: TOLERANCE.position, label: "y (frame-relative)", unit: "px", box: true },
  { key: "opacity", tol: TOLERANCE.opacity, label: "opacity" }
];
var STYLE_KEYS = [...FIELDS.map((f) => f.key), "padding", "gapVisual", "text", "tag", "textBox", "placeholderText"];
var STYLE_KEY_SHAPE = {
  borderRadius: "number | [tl,tr,br,bl]",
  padding: "[t,r,b,l]",
  fill: "an SVG's paint",
  textBox: "{x,w} of a Range over the text",
  placeholderText: "el.placeholder",
  placeholderColor: "the ::placeholder colour",
  tag: "tagName, lower-case"
};
var MEASURED_KEYS_DOC = {
  "nodes[].nodeId": "the Figma node id the measurement is FOR (from data-dt-node, or matched by text/position)",
  // GENERATED from STYLE_KEYS, so the list a probe is told to send cannot drift from the list compared (DT-23: `fill` was missing)
  "nodes[].styles": `computed values, EVERY key on every node \u2014 lengths as px numbers (a "20px" string is read as 20; %, other units and keywords are not) \u2014 (null when it cannot be read, with the reason under unmeasured): ${STYLE_KEYS.map((k) => k + (STYLE_KEY_SHAPE[k] ? ` (${STYLE_KEY_SHAPE[k]})` : "")).join(" ")}`,
  "nodes[].unmeasured": "{<styles key>: why} for every styles key reported null \u2014 a null is listed as not measured, never as checked",
  "nodes[].styles.fill": "an SVG's paint: getComputedStyle(<path|rect|circle>).fill \u2014 never background-color",
  "nodes[].styles.textBox": "{x,w} of a Range over a TEXT node's characters, frame-relative \u2014 required when the id sits on a padded container (<th>, <button>, <label>)",
  "nodes[].styles.gapVisual": "the rendered distance between consecutive children \u2014 required for a <table> (border-spacing, not gap)",
  "nodes[].styles.placeholderText / placeholderColor": "el.placeholder / the ::placeholder colour (getComputedStyle(el,'::placeholder').color or the stylesheet rule)",
  "nodes[].styles.tag": "the element's tagName, lower-case",
  "nodes[].states.<hover|pressed|focus>": "the same styles, measured WITH the element in that state \u2014 required for a node whose spec has drawnState",
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
function comparePadding(want, got) {
  if (!Array.isArray(want)) return null;
  const w = want.map(Number);
  if (w.some(Number.isNaN)) return null;
  const worst = Math.max(...w.map((v, i) => Math.abs(v - (got[i] ?? 0))));
  return worst <= TOLERANCE.padding ? null : { want: w, got: [...got], delta: Number(worst.toFixed(3)) };
}
function radiusCorners(v) {
  return v == null ? null : fourSides(v);
}
var clampRadius = (r, w, h) => num(w) && num(h) && w > 0 && h > 0 ? Math.min(r, Math.min(w, h) / 2) : r;
var TABLE_TAGS = /* @__PURE__ */ new Set(["table", "thead", "tbody", "tfoot", "tr"]);
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
  "A rotation applied with the CSS `rotate` property reads `transform: none` (Tailwind v4 `rotate-180`) \u2014 read `rotate` too before calling a rotation missing (finding 198).",
  "An icon drawn by an <img> (or <canvas>, <object>) has no readable fill: the SVG inside is a separate document, so its fill is listed under `unverifiable` \u2014 compare the asset file instead.",
  'Numbers are read as px: a number or a px string ("20px"). A percentage, another unit or a keyword (other than letter-spacing: normal = 0) is listed as not measured; so is a value CSS cannot produce (a negative gap, padding or size).',
  "Positions are compared only where the export states one (absolute layers, render/ink boxes); auto-layout children are placed by their parent, whose position is compared."
];
function fieldTolerance(label) {
  const f = FIELDS.find((x) => x.label === label);
  if (f) return f.tol;
  if (label === "padding") return TOLERANCE.padding;
  if (label.startsWith("border-radius (")) return TOLERANCE.radius;
  if (label === "placement") return TOLERANCE.position;
  return null;
}
var fieldBase = (f) => f.replace(/\s*\(.*\)$/, "");
var INTEGRITY_PHRASES = {
  otherExpectation: "the measurements were taken against a DIFFERENT expectation",
  noExpectation: "measured file names no expectation (expectationSha256)",
  unfinished: "\u2014 the verifier had not finished",
  otherMeasured: "names a different measured file",
  unrecorded: "no status of that run records it"
};
var isIntegrityReason = (w) => Object.values(INTEGRITY_PHRASES).some((p) => w.includes(p));
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
      else if (now.specIds.has(d.nodeId)) reclassified.push({ nodeId: d.nodeId, field: d.field, change: "gone", was: was(d) });
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
    const method = gapRow ?? now.unverifiable.find((g) => sameField(g, d));
    if (method) {
      nowUnverifiable.push({ nodeId: d.nodeId, field: d.field, was: was(d), why: method.why });
      continue;
    }
    out.fixed++;
  }
  return nowUnverifiable.length ? { ...out, nowUnverifiable } : out;
}
var sortKeys = (o) => Object.entries(o).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
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
  "tag-shared-path": "tagSharedPath",
  text: "text",
  "text-ordinal": "textOrdinal",
  position: "position",
  frame: "frame"
};
var MATCH_BUCKETS = ["tag", "tagSharedPath", "text", "textOrdinal", "position", "frame", "sharedComponentPath", "other", "unstated"];
var MATCH_LABEL = {
  tag: "tag",
  tagSharedPath: "shared path",
  text: "text",
  textOrdinal: "ordinal",
  position: "position",
  frame: "frame",
  sharedComponentPath: "shared component path",
  other: "other",
  unstated: "unstated"
};
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
  build: true
};
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
  const legacy = expectation.schema !== EXPECTATION_SCHEMA;
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
    for (const k of Object.keys(s)) {
      keysSeen.add(k);
      if (!KNOWN_MEASURED_KEYS.has(k)) unknownKeys.set(k, (unknownKeys.get(k) || 0) + 1);
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
  const positionMatched = /* @__PURE__ */ new Set();
  const typographyOn = /* @__PURE__ */ new Map();
  const absentGaps = /* @__PURE__ */ new Set();
  const placementGaps = /* @__PURE__ */ new Map();
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
    const bucket = matchedBy && matchedBy.startsWith("shared-component-path") ? "sharedComponentPath" : rawMatch === "" ? "unstated" : MATCH_BUCKET[rawMatch] ?? "other";
    matchedByCensus[bucket] = (matchedByCensus[bucket] ?? 0) + 1;
    if (/^position/i.test(rawMatch)) positionMatched.add(String(spec.nodeId));
    const base = m.styles || m;
    let got = base, measuredIn = "rest";
    const state = spec.drawnState;
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
    for (const f of FIELDS) {
      const want0 = spec[f.key];
      if (want0 === void 0) continue;
      let val = got[f.key];
      let nullKeys = [f.key];
      let present = val !== void 0;
      if (isText && tb && (f.key === "x" || f.key === "width")) {
        val = f.key === "x" ? tb.x : tb.w;
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
      if (state && measuredIn === "rest" && spec.drawnStateOwn && f.colour) {
        gap(spec, f.label, stateWhy);
        continue;
      }
      if (onLeaf && LEAF_FIELDS.has(f.key)) {
        gap(spec, f.label, leafWhy);
        continue;
      }
      if (isText && f.box && container && !tb) {
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
      const bad = compareField(f, want, have);
      if (bad) {
        push(spec, f.label, f.high ? "high" : "medium", bad, {
          ...ifDefined("unit", f.unit),
          ...ifDefined("token", tokenFor(spec, f.key)),
          ...measuredIn !== "rest" ? { measuredIn } : {},
          ...ifDefined("matchedBy", matchedBy !== "id" ? matchedBy || void 0 : void 0),
          ...f.key === "borderRadius" && spec.borderRadius !== want ? { note: `design radius ${spec.borderRadius} on a ${spec.width}\xD7${spec.height} box draws ${want}` } : {}
        });
      }
    }
    if (spec.radiusCorners && onLeaf) gap(spec, "border-radius", leafWhy);
    else if (spec.radiusCorners) {
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
      else if (got.padding === null || Array.isArray(got.padding) && got.padding.some((v) => v === null)) gapNull("padding", "padding");
      else if (!pad) gap(spec, "padding", `could not read '${JSON.stringify(got.padding)}' as px padding [t,r,b,l]`);
      else if (pad.some((v) => v < 0)) gap(spec, "padding", `${JSON.stringify(got.padding)} is impossible for padding (CSS cannot make it negative) \u2014 a measuring artefact; not compared`);
      else {
        fieldsChecked++;
        const bad = comparePadding(spec.padding, pad);
        const allZero = pad.every((v) => v === 0);
        if (bad) push(spec, "padding", "medium", bad, {
          unit: "px",
          ...ifDefined("token", tokenFor(spec, "padding")),
          ...allZero && !got.tag ? { note: "measured 0 on every side \u2014 if this id sits on a <tr> or a wrapper, the padding lives on its cells/child: report `tag` and measure the element that carries it" } : {}
        });
      }
    }
    if (spec.placeholderText !== void 0) {
      tally("placeholderText", got.placeholderText !== void 0);
      if (got.placeholderText === void 0) gap(spec, "placeholder text", "this layer is an input placeholder: report el.placeholder as placeholderText (textContent of an empty input is '')", true);
      else if (got.placeholderText === null) gapNull("placeholder text", "placeholderText");
      else {
        fieldsChecked++;
        if (String(got.placeholderText).trim() !== String(spec.placeholderText).trim()) push(spec, "placeholder text", "high", { want: spec.placeholderText, got: got.placeholderText, delta: null });
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
        const w = String(spec.text).replace(/ /g, " ").trim();
        const g = String(got.text).replace(/ /g, " ").trim();
        if (w !== g) {
          const caseOnly = w.toLowerCase() === g.toLowerCase();
          const extraGlyphs = !caseOnly && g.startsWith(w) && !/[\p{L}\p{N}]/u.test(g.slice(w.length));
          const rowTexts = spec.repeatedText && spec.repeatedTextGroup ? builtTexts.get(spec.repeatedTextGroup) : void 0;
          const distinct = rowTexts ? new Set(rowTexts).size : 0;
          const asDesigned = rowTexts ? rowTexts.filter((t) => t === w).length : 0;
          const realData = !caseOnly && !extraGlyphs && !!rowTexts && distinct >= 3 && asDesigned * 2 <= rowTexts.length;
          push(spec, "text", caseOnly || extraGlyphs || realData ? "low" : "high", { want: spec.text, got: got.text, delta: null }, {
            ...ifDefined("note", caseOnly ? "differs only in case \u2014 check for a text-transform, which Figma applies at render time while storing the original" : extraGlyphs ? `the designed text is intact, followed by '${g.slice(w.length).trim()}' (an icon or caret inside the same element?)` : realData ? `repeated placeholder copy: the design shows '${w}' in every sibling row; the build shows ${distinct} different values across them (real data?) \u2014 check the copy is the data the design means` : void 0)
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
  }
  const addNote = (d, note) => {
    d.note = d.note ? `${d.note}; ${note}` : note;
  };
  const typoLabels = new Set(FIELDS.filter((f) => TYPO_FIELDS.has(f.key)).map((f) => f.label));
  for (const d of deltas) {
    const tag = typographyOn.get(String(d.nodeId));
    if (tag && typoLabels.has(d.field)) addNote(d, `typography read from a <${tag}>, not the text run \u2014 if the text sits in a child element, measure that element (the shipped probe does, and says textFrom)`);
    if (positionMatched.has(String(d.nodeId))) addNote(d, "low confidence: this node was matched by position, not by its data-dt-node tag or its text \u2014 the element measured may not be the one the design means");
  }
  const knownIds = /* @__PURE__ */ new Set([...expectedIds, ...hiddenSet, ...[expectation.frame, ...expectation.frames || []].map((f) => f && f.nodeId).filter((id) => typeof id === "string")]);
  for (const id of expectedIds) {
    const alt = viaSharedPath(id);
    if (alt) knownIds.add(alt);
  }
  const measuredIdsNotInExpectation = [...byId.keys()].filter((id) => !knownIds.has(id));
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
  const componentsAbsent = [];
  for (const c of comps.filter((c2) => c2 && c2.present === false)) {
    const set = [...bySet.values()].find((v) => v.setName === (c.setName || c.name) || c.nodeId !== void 0 && v.nodeIds.includes(c.nodeId));
    if (set) componentsAbsent.push({ setName: set.setName, nodeIds: set.nodeIds, ...ifDefined("detail", c.detail || c.note) });
  }
  const allEvidence = [...Array.isArray(measured.interactions) ? measured.interactions : [], ...Array.isArray(opts.interactions) ? opts.interactions : []];
  const exercised = /* @__PURE__ */ new Map();
  let interactionEvidenceOnHidden = 0;
  const expectedKeys = new Set((expectation.interactions || []).map((i) => String(i.nodeId) + "|" + i.trigger));
  for (const r of allEvidence) {
    if (!r || r.nodeId == null) continue;
    if (hiddenSet.has(String(r.nodeId))) {
      interactionEvidenceOnHidden++;
      continue;
    }
    exercised.set(String(r.nodeId) + "|" + String(r.trigger || "on_click").toLowerCase(), r);
  }
  const exportSha = expectation.exportContentSha256;
  const inputNotes = [...Array.isArray(opts.inputNotes) ? opts.inputNotes : []];
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
  const interactions = (expectation.interactions || []).filter((i) => !hiddenSet.has(String(i.nodeId))).map((i) => {
    const hit = exercised.get(String(i.nodeId) + "|" + i.trigger);
    const row = { nodeId: i.nodeId, name: i.name, trigger: i.trigger, ...ifDefined("action", i.action), ...ifDefined("destinationId", i.destinationId), ...i.destinationExported === false ? { destinationExported: false } : {} };
    const gaps = hit && hit.ok === true && hit.result !== "not-probed" ? evidenceGaps(hit, i.action) : null;
    const worked = gaps !== null && gaps.length === 0;
    const said = hit ? { ...ifDefined("outcome", typeof hit.outcome === "string" ? hit.outcome : void 0), ...ifDefined("navEvents", typeof hit.navEvents === "number" ? hit.navEvents : void 0) } : {};
    const scoped = descopeFor(i);
    if (scoped) return Object.assign(row, { result: "descoped", detail: `descoped by ${scoped.decidedBy} (${scoped.decidedAt}): ${scoped.reason}`, ...worked ? { note: "descoped but works \u2014 the probe drove it successfully; drop the descope?" } : {} });
    if (i.destinationExported === false && !worked) return Object.assign(row, { result: "undesigned", detail: `destination ${i.destinationId} is not in this Figma file's export \u2014 nothing designed to check it against${hit && hit.detail ? `; probe said: ${hit.detail}` : ""}` });
    if (!hit) return Object.assign(row, { result: "not-probed", detail: "no probe result for this node and trigger" });
    const count = Number(hit.selectorCount);
    if (hit.result === "not-probed" || hit.ok === null || hit.ok === void 0) return Object.assign(row, { result: "not-probed", ...ifDefined("detail", hit.detail) });
    if (hit.ok === false) return Object.assign(row, { result: "fail", ...ifDefined("detail", hit.detail), ...ifDefined("selector", hit.selector), ...said });
    if (!worked || !hit.selector) {
      return Object.assign(row, { result: "not-probed", detail: `reported ok without evidence \u2014 ${(gaps || []).join("; ")}${hit.detail ? `; probe said: ${hit.detail}` : ""}`, ...ifDefined("selector", hit.selector), ...said });
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
  const notWaivable = /* @__PURE__ */ new Map();
  for (const n of notMeasured) notWaivable.set(n.nodeId, "the node was not measured \u2014 only a measured delta can be accepted");
  for (const i of interactionsFailed) notWaivable.set(i.nodeId, "a failed interaction is never waivable (D5) \u2014 descope it (plan.descopes, owner-only) if it is deliberately inert");
  for (const c of componentsAbsent) for (const id of c.nodeIds) notWaivable.set(id, `component set '${c.setName}' is reported ABSENT \u2014 a missing component is never waivable (D5)`);
  let applied = 0;
  (Array.isArray(opts.waivers) ? opts.waivers : []).forEach((w, i) => {
    if (!isPlanWaiver(w)) {
      inputNotes.push(`plan waivers[${i}] is not ${isPlanWaiver.expected}; ignored`);
      return;
    }
    const cands = deltas.filter((d2) => d2.nodeId === w.nodeId && d2.field === w.field && !d2.accepted);
    if (!cands.length) {
      const fieldGap = fieldsNotMeasured.some((g) => g.nodeId === w.nodeId && g.field === w.field) ? "that value was not measured this round \u2014 only a measured delta can be accepted" : void 0;
      unused.push({ nodeId: w.nodeId, field: w.field, why: notWaivable.get(w.nodeId) ?? fieldGap ?? "no such delta this round \u2014 fixed? drop the waiver" });
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
    const gid = `same:${crypto4.createHash("sha256").update(k).digest("hex").slice(0, 8)}`;
    for (const d of list) d.group = gid;
  }
  const open = deltas.filter((d) => !d.accepted);
  const high = open.filter((d) => d.severity === "high").length;
  const medium = open.filter((d) => d.severity === "medium").length;
  const accepted = deltas.length - open.length;
  const openHigh = open.filter((d) => d.severity === "high");
  const highCauses = new Set(openHigh.map((d, i) => d.group ?? `#${i}`)).size;
  const probeRaw = measured.probe;
  const probeIdentity = isProbeIdentity(probeRaw) ? probeRaw : void 0;
  const buildRaw = measured.build;
  const buildNow = isBuildIdentity(buildRaw) ? buildRaw : void 0;
  if (buildRaw !== void 0 && !buildNow && !inputNotes.some((n) => n.startsWith("measured.build "))) inputNotes.push("measured.build is not a build identity; ignored (build: unknown)");
  const st = opts.status && opts.status.status !== "v1" ? opts.status.status : null;
  if (opts.status && opts.status.status === "v1") inputNotes.push(`${opts.status.file} is an older hand-written status (no run id, no shas) \u2014 not checked; write it with verify-screen --status`);
  const runId = typeof measured.runId === "string" && measured.runId ? measured.runId : st ? st.runId : void 0;
  if (probeRaw !== void 0 && !probeIdentity && !inputNotes.some((n) => n.startsWith("measured.probe "))) inputNotes.push("measured.probe is not the shipped probe's identity; ignored (probe: unknown)");
  const inputs = {
    expectationSchema: expectation.schema || "(none)",
    ...ifDefined("expectationSha256", opts.expectationSha256),
    ...ifDefined("measuredSha256", opts.measuredSha256),
    ...ifDefined("measuredAgainst", measured.expectationSha256 || void 0),
    // P2b round 2 (findings 314/317): WHAT was measured, by content — the design (timestamps stripped)
    // and the code (sha256 of each file in the plan's files[], the hashes the Stop hook records).
    ...ifDefined("exportContentSha256", expectation.exportContentSha256 || void 0),
    ...ifDefined("code", opts.code || void 0),
    // Which probe produced these numbers (F-101): a hand-written probe is "unknown", and its numbers are not
    // comparable round to round — a changed probe changes what "measured" means.
    probe: probeIdentity ?? "unknown",
    ...ifDefined("waivers", opts.waiversInput || void 0),
    // DT-81: the build the probe was served — "unknown" when it records none (a hand-written probe, an older one)
    build: buildNow ?? "unknown",
    ...ifDefined("runId", runId)
  };
  const stale = !!(opts.expectationSha256 && measured.expectationSha256 && measured.expectationSha256 !== opts.expectationSha256);
  const staticOnly = measured.mode === "static-only";
  const artifactCheck = Array.isArray(opts.artifactCheck) ? opts.artifactCheck : null;
  const noRender = !!artifactCheck && !artifactCheck.some((a) => a.exists && a.image);
  const nodesExpected = specs.length - folded.length;
  const reasons = [];
  if (stale) reasons.push(`${INTEGRITY_PHRASES.otherExpectation} (${String(measured.expectationSha256).slice(0, 12)}\u2026 vs ${String(opts.expectationSha256).slice(0, 12)}\u2026) \u2014 re-measure`);
  if (opts.expectationSha256 && !measured.expectationSha256) reasons.push(`${INTEGRITY_PHRASES.noExpectation} \u2014 nothing ties these numbers to this design; re-measure with the shipped probe`);
  const measuredRun = typeof measured.runId === "string" && measured.runId ? measured.runId : void 0;
  if (measuredRun !== void 0 && opts.status !== void 0 && (st === null || st.runId !== measuredRun)) {
    reasons.push(`the measured file was taken in run ${measuredRun}, but ${st ? `${opts.status ? opts.status.file : "the status"} is run ${st.runId}` : opts.status && opts.status.status === "v1" ? `${opts.status.file} is an older hand-written status` : "no status file was found"} \u2014 ${INTEGRITY_PHRASES.unrecorded}; ${st ? `run ${st.runId} is the current run \u2014 re-measure in it (never record run ${measuredRun} over it)` : `record it with --status <Screen> --phase measured --run ${measuredRun}, or re-measure`}`);
  } else if (st) {
    const stFile = opts.status ? opts.status.file : "status.json";
    if (!MEASURED_PHASES.includes(st.phase)) reasons.push(`${stFile} (run ${st.runId}, rev ${st.rev}) is at phase ${st.phase} ${INTEGRITY_PHRASES.unfinished}${st.detail ? ` (${st.detail})` : ""}`);
    else if (st.measuredSha256 && opts.measuredSha256 && st.measuredSha256 !== opts.measuredSha256) reasons.push(`${stFile} ${INTEGRITY_PHRASES.otherMeasured} (sha ${st.measuredSha256.slice(0, 12)}\u2026, this one ${opts.measuredSha256.slice(0, 12)}\u2026) \u2014 measured again outside run ${st.runId}?`);
  }
  const integrity = [...reasons];
  const integrityFailed = integrity.length > 0;
  if (legacy) reasons.push(`the expectation is ${expectation.schema || "unversioned"}, which predates hidden-layer filtering \u2014 regenerate it with --expect before trusting any number here`);
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
    matchedBy: matchedByCensus
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
        specIds: new Set(specs.map((sp) => String(sp.nodeId))),
        absent: absentGaps,
        placementGaps,
        sameMeasured: !!(opts.measuredSha256 && prev.inputs && prev.inputs.measuredSha256 === opts.measuredSha256)
      }) } : {},
      sameBuild: prevBuild && buildNow ? prevBuild.assetsSha256 === buildNow.assetsSha256 : null
    };
  }
  const prevCode = opts.against && opts.against.report.inputs ? opts.against.report.inputs.code : void 0;
  const codeChanged = prevCode && opts.code ? Object.keys(prevCode.files).length && Object.keys(opts.code.files).length ? JSON.stringify(sortKeys(prevCode.files)) !== JSON.stringify(sortKeys(opts.code.files)) : !!(prevCode.gitHead && opts.code.gitHead && prevCode.gitHead !== opts.code.gitHead) : false;
  const sameBuildServed = !!(against && against.sameBuild === true && codeChanged);
  const lost = against && against.deltas ? against.deltas.lostCoverage.length : 0;
  const unmatchedCount = unmatchedInteractionEvidence.length;
  const fell = against && against.nodesMeasured.before !== null && against.nodesMeasured.after < against.nodesMeasured.before;
  const mark = verdict.toUpperCase();
  const systemic = fieldsNeverMeasured.filter((f) => f.expectedOn >= NEVER_MEASURED_HEADLINE_MIN || f.probeSent || !keysSeen.has(f.field));
  const headline = `${mark} \u2014 ` + (systemic.length ? `NEVER MEASURED: ${systemic.map((f) => `'${f.field}' present on 0 of ${f.expectedOn} nodes that state it${f.probeSent ? ` (probe sent '${f.probeSent.join("', '")}')` : ""}`).join("; ")} \xB7 ` : "") + `nodes measured ${nodesMeasured}/${nodesExpected}${folded.length ? ` (${folded.length} folded)` : ""} \xB7 ${fieldsChecked} values compared \xB7 ${high} high${highCauses < high ? ` (${highCauses} cause${highCauses === 1 ? "" : "s"})` : ""}, ${medium} medium` + (accepted ? ` \xB7 ${accepted} accepted` : "") + (reopened.length ? ` \xB7 ${reopened.length} waiver(s) REOPENED` : "") + " \xB7 " + // (not a verdict reason, like ::placeholder colour — but never silent: an <img> icon's fill is not a pass)
  (unverifiable.length ? `${unverifiable.length} value(s) unverifiable by method \xB7 ` : "") + `interactions ${interactionsPassed.length} pass, ${interactionsFailed.length} fail, ${interactionsNotProbed.length} not-probed` + (interactionsUndesigned.length ? `, ${interactionsUndesigned.length} undesigned` : "") + (interactionsDescoped.length ? `, ${interactionsDescoped.length} descoped` : "") + ` of ${interactions.length} \xB7 data-dt-node/component evidence ${coverage.instanceSetsWithEvidence}/${bySet.size} instance sets (tag coverage, not presence)` + (against && fell ? ` \xB7 COVERAGE FELL ${against.nodesMeasured.before}\u2192${against.nodesMeasured.after} vs ${against.report}` : "") + (against && against.probeChanged === true ? " \xB7 probe changed" : "") + // group 10 — informational, never the verdict
  (unmatchedCount ? ` \xB7 ${unmatchedCount} probe result(s) matched no designed interaction` : "") + (lost ? ` \xB7 LOST COVERAGE on ${lost} earlier delta(s)` : "") + (sameBuildServed && against ? ` \xB7 SAME BUILD SERVED as ${against.report} although the code changed (stale preview/dist?)` : "");
  return {
    schema: REPORT_SCHEMA,
    ...ifDefined("screen", expectation.screen),
    ...ifDefined("exportedAt", expectation.exportedAt),
    measuredAt: measured.measuredAt || (/* @__PURE__ */ new Date()).toISOString(),
    renderer: measured.renderer || "unknown",
    ...ifDefined("viewport", measured.viewport),
    artifacts: artifactCheck || (Array.isArray(measured.artifacts) ? measured.artifacts : []),
    inputs,
    verdict,
    headline,
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
      highCauses
    },
    deltas: deltas.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]),
    componentsAbsent,
    untaggedInstanceSets,
    interactions,
    notMeasured,
    fieldsNotMeasured,
    unverifiable,
    notComparable: expectation.notComparable || [],
    waivers: { applied, reopened, unused },
    folded,
    probe: {
      unknownKeys: [...unknownKeys].map(([key, count]) => ({ key, count, ...ifDefined("canonical", KEY_HINTS[key]) })),
      unknownTopLevelKeys: Object.keys(measured).filter((k) => !Object.hasOwn(MEASURED_TOP_KEYS, k)).map((key) => ({ key, ...ifDefined("canonical", TOP_KEY_HINTS[key]) })),
      duplicateNodeIds,
      interactionEvidenceOnHiddenLayers: interactionEvidenceOnHidden,
      interactionEvidenceNotInExpectation: unexpectedInteractionEvidence,
      ...unmatchedInteractionEvidence.length ? { unmatchedInteractionEvidence } : {},
      measuredIdsOnHiddenLayers: [...byId.keys()].filter((id) => hiddenSet.has(id)).length,
      measuredIdsNotInExpectation: measuredIdsNotInExpectation.length,
      measuredIdsNotInExpectationSample: measuredIdsNotInExpectation.slice(0, 5),
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
function reportToMarkdown(r) {
  const L = [];
  L.push(`# Verify \u2014 ${r.screen}`, "");
  L.push(`**${r.headline || r.verdict.toUpperCase()}**`, "");
  L.push(`renderer ${r.renderer}${r.viewport ? ` at ${typeof r.viewport === "object" ? JSON.stringify(r.viewport) : r.viewport}` : ""} \xB7 measured ${r.measuredAt}` + (r.inputs && r.inputs.expectationSha256 ? ` \xB7 against expectation ${r.inputs.expectationSha256.slice(0, 12)}\u2026` : "") + (r.inputs && r.inputs.runId ? ` \xB7 run ${r.inputs.runId}` : ""), "");
  const b = r.inputs && r.inputs.build;
  L.push(b && b !== "unknown" ? `Build served: ${b.mode} ${b.url} \xB7 ${b.assets} asset(s), sha256 ${b.assetsSha256.slice(0, 12)}\u2026 \xB7 git ${b.gitHead ? b.gitHead.slice(0, 12) : "none"}${b.gitDirty ? " (uncommitted changes)" : ""}` : "Build served: build identity unknown (the measured file records none \u2014 measured by a hand-written or older probe).", "");
  if (r.why.length) {
    L.push("Why this is not a pass:", "");
    for (const w of r.why) L.push(`- ${w}`);
    L.push("");
  }
  const c = r.coverage;
  L.push("## What was actually checked", "");
  L.push("| | |", "|---|---|");
  L.push(`| node specs measured | ${c.nodesMeasured} / ${c.nodesExpected}${c.nodesMatchedByComponentPath ? ` (${c.nodesMatchedByComponentPath} via a shared component's internal path)` : ""}${c.nodesFolded ? ` (+${c.nodesFolded} folded into a measured ancestor, out of the count)` : ""} |`);
  L.push(`| individual values compared | ${c.fieldsChecked} |`);
  L.push(`| values on measured nodes the probe did not report | ${c.fieldsNotMeasured} |`);
  if (c.fieldsNeverMeasured.length) L.push(`| **fields present in 0 measurements** | ${c.fieldsNeverMeasured.map((f) => `\`${f.field}\`${f.probeSent ? ` (probe sent \`${f.probeSent.join("`, `")}\`)` : ""}`).join(", ")} |`);
  L.push(`| design values excluded by method (listed below) | ${c.valuesNotComparable} |`);
  L.push(`| values the method cannot read unaided | ${c.valuesUnverifiable} |`);
  if (c.hiddenLayersSkipped) L.push(`| hidden layers skipped (not built, not measured, not driven) | ${c.hiddenLayersSkipped.layers} layer(s) \xB7 ${c.hiddenLayersSkipped.specsSkipped} spec(s) \xB7 ${c.hiddenLayersSkipped.instancesSkipped} instance(s) \xB7 ${c.hiddenLayersSkipped.interactionsSkipped} interaction(s) |`);
  L.push(`| instance sets the probe could point at (data-dt-node / component evidence \u2014 coverage, NOT presence) | ${c.instanceSetsWithEvidence} / ${c.instanceSets} |`);
  L.push(`| designed interactions: pass / fail / not-probed | ${c.interactionsPassed} / ${c.interactionsFailed} / ${c.interactionsNotProbed} of ${c.interactionsExpected}${c.interactionsUndesigned ? ` \xB7 ${c.interactionsUndesigned} undesigned (destination never exported)` : ""}${c.interactionsDescoped ? ` \xB7 ${c.interactionsDescoped} descoped by the owner` : ""} |`);
  if (c.deltasAccepted) L.push(`| value mismatches accepted by a plan waiver (listed, out of the counts) | ${c.deltasAccepted} |`);
  L.push("");
  if (r.against) {
    const a = r.against;
    L.push(`Against the previous round (${a.report}): nodes measured ${a.nodesMeasured.before ?? "?"} \u2192 ${a.nodesMeasured.after}, expected ${a.nodesExpected.before ?? "?"} \u2192 ${a.nodesExpected.after}${a.probeChanged === true ? " \xB7 **the probe changed**" : a.probeChanged === null ? " \xB7 probe identity unknown on both rounds" : ""}${a.expectationChanged ? " \xB7 the expectation changed" : ""}. This never changes the verdict.`, "");
    const d = a.deltas;
    if (d && d.sameMeasured) {
      const rc = d.reclassified || [];
      L.push(`Previous deltas (node + field): **the same measured file as last round** \u2014 nothing about the build changed, so nothing is fixed, new or lost; ${d.unchanged} still open${rc.length ? `, ${rc.length} reclassified by the compare (or the expectation): ${rc.filter((x) => x.change === "gone").length} no longer a delta, ${rc.filter((x) => x.change === "new").length} newly a delta` : ""}.`, "");
      if (rc.length) {
        L.push(`## Reclassified (${rc.length})`, "", "*Same measured file \u2014 the compare changed, not the build.*", "", "| Node | Field | Change | Was |", "|---|---|---|---|");
        for (const x of rc.slice(0, 40)) L.push(`| \`${x.nodeId}\` | ${x.field} | ${x.change === "gone" ? "no longer a delta" : "newly a delta"} | ${x.change === "gone" ? fmt(x.was) : ""} |`);
        if (rc.length > 40) L.push(`| \u2026and ${rc.length - 40} more | | | |`);
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
  const bad = r.interactions.filter((i) => i.result === "fail" || i.result === "not-probed");
  if (bad.length) {
    L.push(`## Designed interactions not confirmed (${bad.length})`, "");
    for (const i of bad) L.push(`- \`${i.nodeId}\` ${i.name || ""} \u2014 ${i.trigger} \u2192 ${i.action}${i.destinationId ? ` (${i.destinationId})` : ""}: **${i.result}**${i.detail ? ` \u2014 ${i.detail}` : ""}`);
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
  if (p.unknownKeys && p.unknownKeys.length || p.unknownTopLevelKeys && p.unknownTopLevelKeys.length || p.duplicateNodeIds || p.interactionEvidenceOnHiddenLayers || p.measuredIdsOnHiddenLayers || p.measuredIdsNotInExpectation || p.inputNotes && p.inputNotes.length) {
    L.push("## About the probe's input", "");
    for (const k of p.unknownKeys || []) L.push(`- key \`${k.key}\` (${k.count}\xD7) is not read by verify-screen${k.canonical ? ` \u2014 the canonical key is \`${k.canonical}\`` : ""}`);
    for (const k of p.unknownTopLevelKeys || []) L.push(`- top-level key \`${k.key}\` is not read by verify-screen${k.canonical ? ` \u2014 the canonical key is \`${k.canonical}\`` : ""}`);
    if (p.duplicateNodeIds) L.push(`- ${p.duplicateNodeIds} duplicate node id(s) in nodes[] \u2014 the first measurement of each id was used`);
    if (p.measuredIdsOnHiddenLayers) L.push(`- ${p.measuredIdsOnHiddenLayers} measurement(s) are for hidden layers and were ignored`);
    for (const n of p.inputNotes || []) L.push(`- ${n}`);
    if (p.measuredIdsNotInExpectation) L.push(`- ${p.measuredIdsNotInExpectation} measured node id(s) are not in the expectation (e.g. ${(p.measuredIdsNotInExpectationSample || []).map((id) => `\`${id}\``).join(", ")}) \u2014 measured against another screen or an older expectation?`);
    if (p.interactionEvidenceOnHiddenLayers) L.push(`- ${p.interactionEvidenceOnHiddenLayers} interaction result(s) are for hidden layers and were ignored \u2014 a hidden layer cannot be driven`);
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
function findExistingExpectedFor(dir, nodeId, ownTarget) {
  if (!nodeId || !fs5.existsSync(dir)) return null;
  for (const f of fs5.readdirSync(dir)) {
    if (!f.endsWith(".expected.json")) continue;
    const full = path4.join(dir, f);
    if (path4.resolve(full) === path4.resolve(ownTarget)) continue;
    const doc = readJsonOrNull(full, isJsonObject);
    if (doc && isJsonObject(doc.frame) && doc.frame.nodeId === nodeId) return full;
  }
  return null;
}
function plansFor(frameId, stem) {
  const planDir = path4.join("design", "plan");
  const hits = [];
  for (const f of fs5.existsSync(planDir) ? fs5.readdirSync(planDir).filter((x) => x.endsWith(".json")).sort() : []) {
    const p = readJsonOrNull(path4.join(planDir, f), isPlan);
    if (!p) continue;
    const byId = frameId && (p.nodeId === frameId || new RegExp(`__${String(frameId).replace(":", "_")}$`).test(path4.basename(f, ".json")));
    const byName = path4.basename(f, ".json") === stem || p.file && path4.basename(String(p.file), ".json") === stem;
    if (byId || byName) hits.push({ file: path4.join(planDir, f).split(path4.sep).join("/"), plan: p });
  }
  return hits;
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
  if ((rep.componentsAbsent || []).some((c) => c.nodeIds.includes(String(id)))) return { error: `${id} belongs to a component set reported ABSENT \u2014 a missing component is never waivable (D5); build it` };
  if ((rep.interactions || []).some((i) => i.nodeId === id && i.result === "fail")) return { error: `${id} is a failed interaction \u2014 never waivable (D5); fix it, or have the owner descope it in plan.descopes (D20)` };
  if ((rep.notMeasured || []).some((n) => n.nodeId === id)) return { error: `${id} was not measured \u2014 there is no delta to accept; measure it (or fold it, plan anchor foldedInto) first` };
  if (sel.field !== void 0 && (rep.fieldsNotMeasured || []).some((n) => n.nodeId === id && n.field === sel.field)) return { error: `${id} (${sel.field}) was not measured \u2014 there is no delta to accept` };
  const fields = deltas.filter((d) => d.nodeId === id).map((d) => d.field);
  return { error: `no delta in the report for ${id}${sel.field !== void 0 ? ` field '${sel.field}'` : ""}${fields.length ? ` (its deltas: ${fields.join(", ")})` : ""}` };
}
function main(argv) {
  const sha = (file) => crypto4.createHash("sha256").update(fs5.readFileSync(file)).digest("hex");
  const USAGE = `usage:
  ${scriptCmd("verify-screen")} --expect <screen.json>... --out design/verify/<Screen> [--force]
      writes <Screen>.expected.json \u2014 the design's own numbers, as data, for VISIBLE layers only.
      Read them; never retype them. --out defaults to design/verify/<the first input file's own basename>.
      Refuses (exit 1) if the same node already has an expectation under a DIFFERENT name in this
      directory \u2014 pass --force to write a second one anyway.
  ${scriptCmd("verify-screen")} --compare <Screen>.expected.json <measured.json> [--interactions <file>] [--against <report.json>] --out design/verify/<Screen>
      writes <Screen>.report.json + .md and exits 1 unless the verdict passes (pass / pass-with-deviations). It has NO browser: it compares
      two JSON files. Interaction results come from measured.json's interactions[] and/or --interactions <file>
      (a JSON array, or {interactions:[\u2026], components:[\u2026]}, of {nodeId, trigger, ok, selector, selectorCount, detail};
      components[] rows {setName|nodeId, present} are merged with measured.json's).
      --out defaults to design/verify/<the .expected.json file's own basename>.
      Coverage is compared with the report this run overwrites (or --against <report.json>): a drop in nodes
      measured prints COVERAGE FELL, a different probe prints 'probe changed'. Neither changes the verdict.
      Integrity first: a measured file naming no or another expectation, or a run status not finished / naming another
      measured file, makes the verdict 'incomplete' even with high mismatches (the numbers belong to an unverified run).
      The plan for this frame (design/plan/, or --plan <plan.json>) supplies waivers[] and descopes[]: an accepted
      delta stays listed but leaves the counts; with nothing else open the verdict is 'pass-with-deviations' (exit 0).
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
      stage dir (stderr). Without --run it continues only a run that has not ended (else exit 2). \`done\` checks first \u2014 refuses (exit 1)
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
    help: { type: "boolean", short: "h" }
  };
  const { values: flags, positionals: files } = cliParse("verify-screen", argv, OPTIONS, USAGE, 2, (args) => parseArgs2({ args, options: OPTIONS, allowPositionals: true }));
  const runFlags = ["phase", "run", "new-run", "detail", "dir", "publish", "timeout", "stall", "interval"];
  if (flags.status !== void 0 || flags.wait !== void 0) {
    if (flags.status !== void 0 && flags.wait !== void 0) {
      console.error("pass --status or --wait, not both\n" + USAGE);
      return 2;
    }
    const other = ["expect", "compare", "accept", "out", "interactions", "against", "force", "node", "field", "group", "reason", "plan", "all-fields"].filter((k) => flags[k] !== void 0);
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
  if (planFlag !== void 0 && doExpect) {
    console.error("--plan only applies to --compare / --accept\n" + USAGE);
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
    const docs = files.map((f) => ({ doc: readDocFile(f, "screen export", isScreenDoc), label: path4.basename(f, ".json") }));
    const indexFile = path4.join("design", "export", "pages", "index.json");
    const idx = readJson(indexFile, isPagesRootIndex);
    if (!("doc" in idx) && !idx.missing) console.error(`note  ${indexFile} ${idx.error} \u2014 interaction destinations are checked against the given export(s) only`);
    const pagesDir = path4.join("design", "export", "pages");
    const pageRows = [];
    let dirs = [];
    try {
      dirs = fs5.readdirSync(pagesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
    }
    for (const d of dirs) {
      const pi = readJson(path4.join(pagesDir, d, "index.json"), isPageIndex);
      if ("doc" in pi) pageRows.push(...pi.doc.layers);
    }
    const rootRows = "doc" in idx ? idx.doc.layers || [] : [];
    const seen = new Set(rootRows.map((l) => `${l.id}\0${l.sourceFile ?? ""}`));
    const layers = [...rootRows, ...pageRows.filter((l) => !seen.has(`${l.id}\0${l.sourceFile ?? ""}`))];
    const exp = buildExpectation(docs, "doc" in idx || layers.length ? { index: { layers } } : null);
    const outBase = out || path4.join("design", "verify", path4.basename(firstFile, ".json"));
    const target = outBase + ".expected.json";
    const dup = findExistingExpectedFor(path4.dirname(target) || ".", exp.frame && exp.frame.nodeId, target);
    if (dup && !force) {
      console.error(
        `error  node ${exp.frame.nodeId} already has an expectation at ${dup} \u2014 refusing to also write ${target} (one screen, one artefact set). Use that existing name, or pass --force to write this one anyway.`
      );
      return 1;
    }
    const next = JSON.stringify(exp, null, 2) + "\n";
    const prev = fs5.existsSync(target) ? fs5.readFileSync(target, "utf8") : null;
    write(outBase, exp);
    const h = crypto4.createHash("sha256").update(next).digest("hex");
    let prevContent = null;
    try {
      if (prev !== null) {
        const prevDoc = JSON.parse(prev);
        prevContent = isJsonObject(prevDoc) ? prevDoc.exportContentSha256 : null;
      }
    } catch {
    }
    if (prev !== null && prev === next) console.error(`note  ${target} was already identical (sha256 ${h.slice(0, 12)}\u2026) \u2014 unchanged`);
    else if (prev !== null && prevContent && prevContent === exp.exportContentSha256 && prev.replace(/"exportedAt": "[^"]*"/, "") === next.replace(/"exportedAt": "[^"]*"/, "")) {
      console.error(`note  ${target}: only exportedAt changed (export content sha256 ${exp.exportContentSha256.slice(0, 12)}\u2026 unchanged) \u2014 existing measurements and report still apply`);
    } else if (prev !== null) {
      console.error(`note  REPLACED an existing ${target} that differed (sha256 ${crypto4.createHash("sha256").update(prev).digest("hex").slice(0, 12)}\u2026 \u2192 ${h.slice(0, 12)}\u2026)`);
      const stale = [".measured.json", ".report.json", ".report.md"].map((s) => outBase + s).filter((f) => fs5.existsSync(f));
      if (stale.length) console.error(`warn  ${stale.join(", ")} ${stale.length > 1 ? "were" : "was"} computed against the PREVIOUS expectation \u2014 re-measure and re-compare before reading ${stale.length > 1 ? "them" : "it"}.`);
    }
    const hc = exp.counts.hidden;
    console.error(`${exp.counts.nodes} node spec(s), ${exp.counts.instances} instance(s), ${exp.counts.interactions} designed interaction(s) \u2014 visible layers only; skipped ${hc.layers} hidden layer(s) (${hc.specsSkipped} spec(s), ${hc.instancesSkipped} instance(s), ${hc.interactionsSkipped} interaction(s)); ${exp.counts.notComparable} design value(s) excluded by method (listed in notComparable) \xB7 expectation sha256 ${h.slice(0, 12)}\u2026`);
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
  if (interactionsFile) {
    const raw = readJsonFile(interactionsFile, "interaction evidence", "Write a JSON array of {nodeId, trigger, ok, selector, selectorCount, detail}.");
    const obj = isJsonObject(raw) ? raw : null;
    const list = isInteractionEvidenceList(raw) ? raw : obj && isInteractionEvidenceList(obj.interactions) ? obj.interactions : obj && obj.interactions === void 0 && obj.components !== void 0 ? [] : null;
    const comps = obj && obj.components !== void 0 ? isMeasuredComponentList(obj.components) ? obj.components : null : [];
    if (!list || !comps) {
      console.error(`--interactions ${interactionsFile}: expected a JSON array or {interactions:[\u2026], components:[\u2026]}`);
      return 2;
    }
    extra = list;
    if (comps.length) extraComponents = comps;
  }
  const artifacts = measured.artifacts || [];
  const artifactCheck = artifacts.map((a) => {
    const p = typeof a === "string" ? a : a && a.path;
    const exists2 = !!p && fs5.existsSync(p);
    return { ...ifDefined("path", p), exists: exists2, image: !!p && /\.(png|jpe?g|webp)$/i.test(p), ...ifDefined("sha256", exists2 ? sha(p) : void 0) };
  });
  let code;
  let planHit;
  if (planFlag !== void 0) {
    const r = readJson(planFlag, isPlan);
    if (!("doc" in r)) {
      console.error(`--plan '${planFlag}' ${r.error}`);
      return 2;
    }
    planHit = { file: planFlag.split(path4.sep).join("/"), plan: r.doc };
  }
  {
    const frameId = expectation.frame && expectation.frame.nodeId;
    const stem = path4.basename(expFile, ".json").replace(/\.expected$/, "");
    const all = planHit ? [planHit] : plansFor(frameId, stem);
    const hits = all.filter((h) => h.plan.files);
    const onlyHit = hits.length === 1 ? hits[0] : void 0;
    if (!planHit) planHit = all.length === 1 ? all[0] : onlyHit;
    if (!planHit && all.length > 1) console.error(`note  ${all.length} plans in design/plan/ describe this frame (${all.map((h) => h.file).join(", ")}) \u2014 no waivers/descopes applied; pass --plan <plan.json>`);
    if (onlyHit && onlyHit.plan.files) {
      code = { plan: onlyHit.file, files: fileHashes(onlyHit.plan.files, process.cwd()), gitHead: gitHead(process.cwd()) };
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
  const compareBase = out || path4.join("design", "verify", path4.basename(expFile, ".json").replace(/\.expected$/, ""));
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
  const probeBase = measuredBase !== null && typeof measured.runId === "string" && measured.runId ? path4.join(path4.dirname(expFile), path4.basename(measuredBase)) : null;
  const found = measuredBase === null ? null : readStatusAt(measuredBase) ?? (probeBase !== null && path4.resolve(probeBase) !== path4.resolve(measuredBase) ? readStatusAt(probeBase) : null);
  const statusOpt = found ? { status: { file: [measuredBase, probeBase].some((b) => b !== null && found.file === statusFile(b)) ? path4.basename(found.file) : `${path4.basename(found.file)} (live, ${found.file})`, status: found.status } } : measuredBase !== null ? { status: null } : {};
  const rep = compare(expectation, measured, { ...statusOpt, ...readable.notes.length ? { inputNotes: readable.notes } : {}, ...ifDefined("interactions", extra), ...ifDefined("components", extraComponents), expectationSha256: sha(expFile), measuredSha256: sha(measuredFile), artifactCheck, ...ifDefined("code", code), ...ifDefined("against", against), ...planInputs });
  const md = reportToMarkdown(rep);
  write(compareBase, rep, md);
  console.error(rep.headline);
  console.error(probeLine(rep));
  const nie = rep.probe.measuredIdsNotInExpectation || 0;
  if (nie) console.error(`note  ${nie} measured node id(s) are not in the expectation (e.g. ${(rep.probe.measuredIdsNotInExpectationSample || []).join(", ")}) \u2014 measured against another screen or an older expectation?`);
  for (const w of rep.waivers.reopened) console.error(`warn  waiver REOPENED ${w.nodeId} (${w.field}): ${w.why}`);
  if (rep.waivers.unused.length) console.error(`note  ${rep.waivers.unused.length} plan waiver(s)/descope(s) match nothing this round: ${rep.waivers.unused.map((w) => `${w.nodeId} (${w.field})`).join(", ")} \u2014 fixed? drop them`);
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
  const stem = path4.basename(reportFile, ".json").replace(/\.report$/, "");
  const recorded = report.inputs && report.inputs.waivers && report.inputs.waivers.plan || report.inputs && report.inputs.code && report.inputs.code.plan || void 0;
  let planFile = flags.plan ?? (recorded && fs5.existsSync(recorded) ? recorded : void 0);
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
  const tmp = `${planFile}.${process.pid}.tmp`;
  fs5.writeFileSync(tmp, JSON.stringify(plan, null, 2) + "\n");
  fs5.renameSync(tmp, planFile);
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
    console.error(`verify-screen: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
export {
  EXPECTATION_SCHEMA,
  FIELDS,
  INTERACTION_OUTCOMES,
  MEASURED_KEYS_DOC,
  OUTCOMES_FOR_ACTION,
  REPORT_SCHEMA,
  STYLE_KEYS,
  TOLERANCE,
  buildExpectation,
  compare,
  expectNode,
  findExistingExpectedFor,
  lineHeightPx,
  normColor,
  normFamily,
  normWeight,
  probeLine,
  radiusCorners,
  reportToMarkdown,
  selectForAccept,
  tokenFor
};
