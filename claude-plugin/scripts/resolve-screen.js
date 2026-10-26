// GENERATED from design-to-code/ by claude-plugin/build-scripts.js — edit the source, then rebuild.


// bridge/src/json-util.ts
function isRecord(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
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

// design-to-code/cli-args.ts
import path from "node:path";
import { fileURLToPath } from "node:url";

// bridge/src/errmsg.ts
var errMsg = (e) => typeof e === "string" ? e : String(e && e.message || e);

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
var scriptCmd = (name) => `${SCRIPT_RUNNER} ${shellQuote(path.join(path.dirname(SELF), name + path.extname(SELF)))}`;
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
import fs7 from "node:fs";
import path6 from "node:path";

// bridge/src/project-layout.ts
import fs from "node:fs";
import path2 from "node:path";
var DESIGN_DIR = "design";
var EXPORT_SUBDIR = "export";
var EXPORT_DIR = path2.join(DESIGN_DIR, EXPORT_SUBDIR);
var TARGET_FILE = path2.join(DESIGN_DIR, "target.json");
var MAP_FILE = path2.join(DESIGN_DIR, "codeconnect.local.json");
var PLAN_DIR = path2.join(DESIGN_DIR, "plan");
var AUDIT_DIR = path2.join(DESIGN_DIR, "audit");
var VERIFY_DIR = path2.join(DESIGN_DIR, "verify");
var SNAPSHOT_DIR = path2.join(DESIGN_DIR, ".sync");
var TAILWIND_SOURCE_NOT_NOTE = `Tailwind v4 scans every file git does not ignore, ${DESIGN_DIR}/ included, so class names quoted in ${DESIGN_DIR}/ notes, audits and plans end up in your CSS. Next to \`@import "tailwindcss";\` in your CSS entry, add \`@source not "<path from that CSS file to ${DESIGN_DIR}/>";\` (e.g. \`@source not "../${DESIGN_DIR}";\` for src/app.css) \u2014 Tailwind v4.1+`;
var VITE_WATCH_IGNORED_NOTE = `With Tailwind v4's automatic source detection, rewriting an existing text file under ${DESIGN_DIR}/ (a re-export, a verify report) makes Vite fully reload the open page. Either add \`server: { watch: { ignored: ['**/${DESIGN_DIR}/**'] } }\` in vite.config (merge it with any existing \`server.watch\` options), or the Tailwind \`@source not\` above \u2014 both stop it`;
var slashed = (p) => p.split(path2.sep).join("/");
var VERIFY_GITIGNORE_NOTE = `${slashed(VERIFY_DIR)}/ is regenerated on every verify run (measurements, screenshots, reports) \u2014 consider adding \`${slashed(VERIFY_DIR)}/\` to .gitignore; decisions live in ${slashed(PLAN_DIR)}/ and are not affected`;
function listPlans(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
}

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

// design-to-code/map-util.ts
var alnumKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
function getOrInit(m, k, init) {
  const have = m.get(k);
  if (have !== void 0) return have;
  const made = init();
  m.set(k, made);
  return made;
}

// bridge/src/read-json.ts
import fs2 from "node:fs";
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

// design-to-code/verify-sets.ts
import fs6 from "node:fs";
import path5 from "node:path";

// design-to-code/verify-status.ts
import path4 from "node:path";
import fs5 from "node:fs";

// design-to-code/run-cache.ts
import fs4 from "node:fs";
import os from "node:os";
import path3 from "node:path";

// bridge/src/hash.ts
import crypto from "node:crypto";
var sha256Hex = (data) => crypto.createHash("sha256").update(data).digest("hex");

// bridge/src/file-lock.ts
import fs3 from "node:fs";
var LIVE_STALE_MS = 2 * 6e4;
var PID_NS = (() => {
  if (process.platform !== "linux") return "";
  try {
    return fs3.readlinkSync("/proc/self/ns/pid");
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
    return fs4.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
var exists = (p) => fs4.existsSync(p);
function realpath(p) {
  if (typeof fs4.realpathSync.native === "function") {
    try {
      return fs4.realpathSync.native(p);
    } catch {
    }
  }
  return fs4.realpathSync(p);
}
function canonical(p) {
  const abs = path3.resolve(p);
  try {
    return realpath(abs);
  } catch {
    const parent = path3.dirname(abs);
    return parent === abs ? abs : path3.join(canonical(parent), path3.basename(abs));
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
  const v = canonical(verifyDir);
  const root = installRootOf(v);
  if (root !== null) {
    const cache = path3.join(root, ...RUN_CACHE_SEGMENTS);
    const rel = path3.relative(root, v).split(path3.sep).join("/");
    return { dir: rel === VERIFY_DIR.split(path3.sep).join("/") ? cache : path3.join(cache, "dirs", shortSha(rel)), root };
  }
  return { dir: path3.join(os.tmpdir(), CACHE_NAME, shortSha(v)), root: v };
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
var liveStatusFile = (base) => path4.join(runCacheDir(path4.dirname(base)), setFile(path4.basename(base), "status"));
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
  const vs = scriptCmd("verify-screen"), S = shellArg(path4.basename(base)), id = shellArg(open.runId), dir = shellArg(path4.resolve(path4.dirname(base)));
  return { waitIt: `${vs} --wait ${S} --run ${id} --dir ${dir}`, endIt: `${vs} --status ${S} --phase failed --run ${id} --dir ${dir}` };
}
function openRunSets(verifyDir) {
  let files;
  try {
    files = fs5.readdirSync(runCacheDir(verifyDir), { withFileTypes: true });
  } catch {
    return [];
  }
  return files.filter((e) => e.isFile() && setBaseOf(e.name, "status") !== null).map((e) => setBaseOf(e.name, "status") ?? e.name).filter((name) => {
    const st = readStatusFile(liveStatusFile(path4.join(verifyDir, name)));
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
var TRAILING_SEP = path5.sep === "\\" ? /[\\/]+$/ : /\/+$/;
var NAMING_KINDS = ["expected", "report", "measured"];
var namedBy = (f) => {
  for (const k of NAMING_KINDS) if (f.endsWith(SET_FILE[k])) return f.slice(0, -SET_FILE[k].length);
  return null;
};
function allSets(verifyDir) {
  let files;
  try {
    files = fs6.readdirSync(verifyDir);
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
  const exp = readJsonOrNull(setFile(path5.join(verifyDir, name), "expected"), isJsonObject);
  const rep = readJsonOrNull(setFile(path5.join(verifyDir, name), "report"), isJsonObject);
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
    const st = set !== void 0 ? readStatusFile(liveStatusFile(path5.join(verifyDir, set))) : null;
    if (set === void 0 || st === null || st === "v1") return stem;
    return `an open run ${st.runId} under ${set} (no file of it yet; end it: ${runCommands(path5.join(verifyDir, set), st).endIt})`;
  }).join(", ");
}

// design-to-code/node-artefacts.ts
function planNode(plan, file) {
  return plan.nodeId || (file !== void 0 ? nodeIdFromStem(path6.basename(file).replace(/\.json$/i, "")) : null);
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
var slash = (p) => p.split(path6.sep).join("/");
function nodeArtefacts(root, dirs = {}) {
  const planDir = dirs.planDir ?? PLAN_DIR;
  const verifyDir = dirs.verifyDir ?? VERIFY_DIR;
  const auditDir = dirs.auditDir ?? AUDIT_DIR;
  const abs = (p) => path6.resolve(root, p);
  const spell = (dir, name) => path6.isAbsolute(dir) ? path6.join(dir, name) : slash(path6.join(dir, name));
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
    const stems = /* @__PURE__ */ new Set(), conflicted = [], legacy = [];
    for (const name of [.../* @__PURE__ */ new Set([...verifySets(verifyAbs), ...runs])].sort()) {
      const ids = setIds(name);
      if (!ids.includes(nodeId)) continue;
      const p = parseSetName(name);
      if (p === null) {
        legacy.push(name);
        continue;
      }
      stems.add(p.stem);
      if (ids.length > 1) conflicted.push({ name, ids });
    }
    return { stems: [...stems].sort(), conflicted, legacy };
  }
  function auditReports() {
    let files;
    try {
      files = fs7.readdirSync(abs(auditDir)).filter((f) => f.endsWith(".json") && !f.slice(0, -5).includes(".")).sort();
    } catch {
      return [];
    }
    return files.map((f) => {
      const doc = readJsonOrNull(path6.join(abs(auditDir), f), isJsonObject);
      const ids = doc && Array.isArray(doc.nodeIds) ? doc.nodeIds.filter((x) => typeof x === "string") : [];
      return { f, stem: f.slice(0, -5), nodeIds: ids.length ? ids : null };
    });
  }
  const auditNodeIs = (r, nodeId) => r.nodeIds ? r.nodeIds.includes(nodeId) : nodeIdFromStem(r.stem) === nodeId;
  const auditNamesNode = (r) => r.nodeIds !== null || nodeIdFromStem(r.stem) !== null;
  const auditsOf = (nodeId) => auditReports().filter((r) => auditNodeIs(r, nodeId)).map((r) => spell(auditDir, r.f));
  function auditFor(nodeId, hints = {}) {
    if (!fs7.existsSync(abs(auditDir))) return null;
    if (hints.screenFile) {
      const own = path6.basename(hints.screenFile, ".json") + ".json";
      if (fs7.existsSync(path6.join(abs(auditDir), own))) return spell(auditDir, own);
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
    const { stems, conflicted, legacy } = setHolders(nodeId, runs);
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
      return { ok: true, name: o.target, existing: stems.includes(o.target), legacy };
    }
    if (stems.length > 1) return several("verify set", nodeId, stems, shown(stems));
    const have = stems[0];
    return { ok: true, name: have ?? screenStem(o.layerName ?? "", nodeId), existing: have !== void 0, legacy };
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
    if (target !== void 0 && path6.basename(target) !== path6.basename(name)) return { ok: false, why: `a new plan of node ${nodeId} is named by its node: ${name}, not ${path6.basename(target)}`, holders: [], reason: "misnamed" };
    return { ok: true, name, existing: false, legacy: [] };
  }
  function claimAudit(nodeId, target) {
    const t = abs(target);
    const own = path6.basename(t, ".json");
    const held = auditsOf(nodeId).filter((f) => abs(f) !== t && !own.startsWith(path6.basename(f, ".json") + "."));
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

// design-to-code/resolve-screen-core.ts
import path8 from "node:path";

// bridge/src/export-reader.ts
import fs8 from "node:fs";
import path7 from "node:path";

// bridge/src/design-system-layout.ts
var TOKENS = "tokens.json";
var COMPONENTS_LOCAL = "components.local.json";
var COMPONENTS_LIBRARY = "components.library.json";
var HYGIENE = "hygiene.json";
var MANIFEST = "design-system.json";
var STYLE_KIND_ROWS = {
  paint: { kind: "paint", file: "styles.paint.json", key: "stylesPaint" },
  text: { kind: "text", file: "styles.text.json", key: "stylesText" },
  effect: { kind: "effect", file: "styles.effect.json", key: "stylesEffect" },
  grid: { kind: "grid", file: "styles.grid.json", key: "stylesGrid" },
  animation: { kind: "animation", file: "styles.animation.json", key: "stylesAnimation" }
  // local custom animation styles
};
var STYLE_KINDS = Object.values(STYLE_KIND_ROWS);
var DESIGN_SYSTEM_FILE_NAMES = [TOKENS, ...STYLE_KINDS.map((row) => row.file), COMPONENTS_LOCAL, COMPONENTS_LIBRARY, HYGIENE, MANIFEST];

// bridge/src/export-reader.ts
var PAGES = "pages";
var INDEX = "index.json";
function resolveInside(base, rel, within = base) {
  const root = path7.resolve(within), file = path7.resolve(base, ...rel.split("/"));
  return file.startsWith(root + path7.sep) ? file : null;
}
var inside = (root, rel) => typeof rel === "string" && rel && !path7.isAbsolute(rel) ? resolveInside(root, rel) : null;
var relOf = (root, file) => path7.relative(root, file).split(path7.sep).join("/");
var problemOf = (root, file, read) => "error" in read && !read.missing ? { file: relOf(root, file), error: read.error } : null;
var optStr3 = (x) => x === void 0 || typeof x === "string";
var isIndexRowLike = (x) => isRecord(x) && typeof x.id === "string" && typeof x.name === "string";
var isRowList = (x) => Array.isArray(x) && x.every((r) => r === null || isIndexRowLike(r));
var isPagesRootIndex = /* @__PURE__ */ Object.assign(
  (x) => isRecord(x) && Array.isArray(x.pageDirs) && x.pageDirs.every((d) => isRecord(d) && optStr3(d.dir) && optStr3(d.index)) && (x.layers === void 0 || isRowList(x.layers)) && optStr3(x.exportedAt),
  { expected: "the export's pages/index.json: an object with a `pageDirs` array (and `layers`, when present, an array of {id, name, file})" }
);
var isPageIndex = /* @__PURE__ */ Object.assign(
  (x) => isRecord(x) && isRowList(x.layers),
  { expected: "a page index (pages/<Page>/index.json): an object with a `layers` array of {id, name, file}" }
);
var rootIndexFile = (exportRoot) => path7.join(exportRoot, PAGES, INDEX);
var hasExportIndex = (exportRoot) => fs8.existsSync(rootIndexFile(exportRoot));
function findExportRoot(dir) {
  const abs = path7.resolve(dir);
  for (let d = path7.dirname(abs); ; d = path7.dirname(d)) {
    if (hasExportIndex(d)) return d;
    if (path7.dirname(d) === d) break;
  }
  for (const sub of [EXPORT_SUBDIR, EXPORT_DIR]) {
    if (hasExportIndex(path7.join(abs, sub))) return path7.join(abs, sub);
  }
  return null;
}
function pageIndexFiles(root, pageDirs) {
  const files = [];
  const add = (f) => {
    if (f !== null && !files.includes(path7.resolve(f))) files.push(path7.resolve(f));
  };
  const ofDir = (dir) => dir && !/[\\/]/.test(dir) && dir !== ".." && dir !== "." ? path7.join(root, PAGES, dir, INDEX) : null;
  for (const pd of pageDirs) add(pd.index ? inside(root, pd.index) : ofDir(pd.dir));
  let dirs = [];
  try {
    dirs = fs8.readdirSync(path7.join(root, PAGES), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
  }
  for (const d of dirs) add(ofDir(d));
  return files;
}
function readExportIndex(exportRoot) {
  const root = exportRoot;
  const rootFile = rootIndexFile(root);
  const read = readJson(rootFile, isPagesRootIndex);
  const rootDoc = "doc" in read ? read.doc : null;
  const problems = [];
  const rootProblem = problemOf(root, rootFile, read);
  if (rootProblem) problems.push(rootProblem);
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
        t = f === null ? -1 : fs8.statSync(f).mtimeMs;
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
  const probeOf = (row) => hasFile(row) ? row : { ...row, file: "\0no file " + rows.length };
  const sameScreen = (older, newer) => hasFile(older) && older.file === newer.file || sameScreenRow(probeOf(older), newer);
  const keep = (row, isRoot) => {
    rows.push(row);
    const bucket = byId.get(row.id);
    if (bucket) bucket.push(row);
    else byId.set(row.id, [row]);
    if (hasFile(row)) files.add(row.file);
    if (isRoot) fromRoot.add(row);
  };
  const take = (row, isRoot) => {
    const candidates = [...byId.get(row.id) ?? [], ...hasFile(row) && files.has(row.file) ? rows.filter((k) => k.file === row.file && k.id !== row.id) : []];
    if (isRoot) {
      if (!candidates.some((k) => sameScreen(row, k))) keep(row, true);
      return;
    }
    const newer = (k) => writtenAt(row) > writtenAt(k);
    const conflicts = candidates.filter((k) => fromRoot.has(k) || !newer(k) ? sameScreen(row, k) : sameScreen(k, row));
    if (!conflicts.length) {
      keep(row, false);
      return;
    }
    if (conflicts.some((k) => fromRoot.has(k) || !newer(k))) return;
    const at = Math.min(...conflicts.map((k) => rows.indexOf(k)));
    for (const k of conflicts) {
      rows.splice(rows.indexOf(k), 1);
      const bucket = byId.get(k.id) ?? [];
      bucket.splice(bucket.indexOf(k), 1);
      if (!bucket.length) byId.delete(k.id);
      if (hasFile(k) && !rows.some((r) => r.file === k.file)) files.delete(k.file);
    }
    keep(row, false);
    rows.splice(rows.length - 1, 1);
    rows.splice(at, 0, row);
  };
  for (const row of rootDoc?.layers ?? []) if (row) take(row, true);
  for (const f of pageIndexFiles(root, rootDoc?.pageDirs ?? [])) {
    const page = readJson(f, isPageIndex);
    const problem = problemOf(root, f, page);
    if (problem) problems.push(problem);
    if ("doc" in page) {
      for (const row of page.doc.layers) if (row) take(row, false);
    }
  }
  const rootStamp = rootDoc?.exportedAt || void 0;
  return {
    root,
    indexed: rootDoc !== null,
    rootProblem: rootProblem && rootProblem.error,
    problems,
    rows,
    rootExportedAt: rootStamp,
    isExported: (id) => byId.has(id),
    fileOf: (row) => inside(root, row.file),
    exportedAtOf: (row) => typeof row.exportedAt === "string" && row.exportedAt || (fromRoot.has(row) ? rootStamp : void 0)
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

// design-to-code/resolve-screen-core.ts
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
  return nodeArtefacts(process.cwd(), { planDir }).plans().plans.flatMap(({ file, plan, nodeId }) => plan.screenName || nodeId ? [{ file: path8.basename(file), ...ifDefined("screenName", plan.screenName), ...ifDefined("nodeId", nodeId), ...ifDefined("route", plan.route) }] : []);
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

// design-to-code/resolve-screen.ts
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
  main
};
