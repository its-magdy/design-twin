// GENERATED from design-to-code/ by claude-plugin/build-scripts.js — edit the source, then rebuild.


// design-to-code/verify-build.ts
import fs5 from "node:fs";
import path3 from "node:path";
import crypto2 from "node:crypto";

// design-to-code/types.ts
function isJsonObject(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
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
function screenExportOf(doc) {
  return isScreenExport(doc) ? doc : null;
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
    for (let i = 0; i < kids.length; i++) go(kids[i], hidden, (path4 ? path4 + " > " : "") + pathOf(kids[i], i), node, depth + 1);
  })(root, false, root ? pathOf(root, 0) : "", null, 0);
}

// design-to-code/audit-gate.ts
import fs3 from "node:fs";
import path from "node:path";

// design-to-code/color.ts
var HEX = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
function normHex(v) {
  if (typeof v !== "string") return null;
  const m = HEX.exec(v.trim());
  if (!m) return null;
  const h = m[1].toLowerCase();
  return "#" + (h.length <= 4 ? h.split("").map((c) => c + c).join("") : h);
}
function colorKey(v) {
  const h = normHex(v);
  return h === null ? null : h.length === 7 ? h + "ff" : h;
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
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    return readFailure(e);
  }
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

// bridge/src/json-util.ts
function nullProto() {
  return /* @__PURE__ */ Object.create(null);
}
function isUnknownArray(x) {
  return Array.isArray(x);
}
function isStringArray(x) {
  return Array.isArray(x) && x.every((v) => typeof v === "string");
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
function isAuditReport(x) {
  return isObj(x) && isObj(x.summary) && Array.isArray(x.findings) && x.findings.every((f) => isObj(f) && typeof f.severity === "string" && typeof f.code === "string");
}
isAuditReport.expected = "an audit report (audit.js --out): an object with `summary` and a `findings` array of {severity, code, message}";
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
isVerifyExpectation.expected = "a verify expectation (verify-screen.js --expect): an object with `frame` and a `nodes` array of {nodeId, \u2026}";
function isVerifyMeasured(x) {
  return isObj(x) && optArrayOf(x.nodes, (n) => isObj(n) && typeof n.nodeId === "string") && optArrayOf(x.components, anyObject) && optArrayOf(x.interactions, anyObject) && (x.artifacts === void 0 || Array.isArray(x.artifacts)) && optStr(x.mode) && optStr(x.expectationSha256);
}
isVerifyMeasured.expected = "probe measurements: an object whose `nodes` (each {nodeId, styles}), `components`, `interactions` and `artifacts`, when present, are arrays";
function isEvidence(x) {
  return isObj(x) && typeof x.nodeId === "string";
}
function isInteractionEvidenceList(x) {
  return Array.isArray(x) && x.every(isEvidence);
}
isInteractionEvidenceList.expected = "interaction evidence: a JSON array of {nodeId, trigger, ok, selector, selectorCount, detail}";
function isVerifyReport(x) {
  return isObj(x) && optStr(x.schema) && optStr(x.verdict) && optStr(x.screen) && optStr(x.nodeId) && optStr(x.headline) && (x.why === void 0 || isStringArray(x.why)) && optArrayOf(x.deltas, anyObject) && optObj(x.inputs);
}
isVerifyReport.expected = "a verify report (verify-screen.js --compare): an object with `verdict`, `why[]`, `deltas[]`, `inputs`";
var PLAN_ARRAYS = ["files", "tokens", "components", "hidden", "deviations", "allowedLiterals"];
var PLAN_OBJECTS = ["anchors", "verification", "counts"];
var PLAN_STRINGS = ["schema", "screen", "screenName", "nodeId", "route", "file", "exportedAt", "status"];
function planProblem(x) {
  if (!isObj(x)) return "is not a plan (the file holds " + (Array.isArray(x) ? "an array" : x === null ? "null" : typeof x) + ", not an object)";
  for (const k of PLAN_ARRAYS) if (x[k] !== void 0 && !Array.isArray(x[k])) return `is not a valid plan: \`${k}\` must be an array`;
  for (const k of PLAN_OBJECTS) if (x[k] !== void 0 && !isObj(x[k])) return `is not a valid plan: \`${k}\` must be an object`;
  for (const k of PLAN_STRINGS) if (x[k] !== void 0 && x[k] !== null && typeof x[k] !== "string") return `is not a valid plan: \`${k}\` must be a string`;
  if (x.files !== void 0 && !isStringArray(x.files)) return "is not a valid plan: `files` must be an array of paths (strings)";
  for (const k of ["tokens", "components", "allowedLiterals", "deviations", "hidden"]) {
    const list = x[k];
    if (Array.isArray(list) && !list.every(isObj)) return `is not a valid plan: every \`${k}\` entry must be an object`;
  }
  if (Array.isArray(x.tokens) && !x.tokens.every((t) => isObj(t) && (t.figmaName === null || optStr(t.figmaName)))) return "is not a valid plan: a `tokens` row's `figmaName` must be a string";
  if (Array.isArray(x.components) && !x.components.every((c) => isObj(c) && typeof c.name === "string")) return "is not a valid plan: every `components` row needs its `name`";
  if (isObj(x.anchors) && !Object.values(x.anchors).every(isObj)) return "is not a valid plan: every `anchors` entry must be an object";
  if (x.auditGate !== void 0 && x.auditGate !== null && !isObj(x.auditGate)) return "is not a valid plan: `auditGate` must be an object or null";
  if (isObj(x.verification) && x.verification.hook !== void 0 && !isObj(x.verification.hook)) return "is not a valid plan: `verification.hook` must be an object";
  return null;
}
function isPlan(x) {
  return planProblem(x) === null;
}
isPlan.expected = "a plan (plan-skeleton.js): an object whose files/tokens/components/deviations are arrays of objects and whose anchors/verification are objects";
function parsePlan(x) {
  return isPlan(x) ? { plan: x } : { error: planProblem(x) || "is not a plan" };
}
function isStringRecord(x) {
  return isObj(x) && Object.values(x).every((v) => typeof v === "string");
}
isStringRecord.expected = "an object of strings";

// design-to-code/cli-args.ts
var scriptCmd = (name) => `node "\${CLAUDE_PLUGIN_ROOT}/scripts/${name}.js"`;

// bridge/src/is-main.ts
import fs2 from "node:fs";
import { fileURLToPath } from "node:url";
function isMainFallback(metaUrl) {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    return fs2.realpathSync(argv1) === fs2.realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

// design-to-code/cross-check.ts
if (false) {
  const argv = process.argv.slice(2);
  const USAGE3 = `usage: ${scriptCmd2("cross-check")} <screen.json>... [--design-system design/design-system] [--variables design/variables.json] [--out design/audit/<screen>.cross] [--json] [--gate]`;
  const OPTIONS = {
    "design-system": { type: "string" },
    variables: { type: "string" },
    out: { type: "string" },
    json: { type: "boolean" },
    gate: { type: "boolean" },
    help: { type: "boolean", short: "h" }
  };
  const { values: flags, positionals: files } = cliParse("cross-check", argv, OPTIONS, USAGE3, 2, (args) => parseArgs({ args, options: OPTIONS, allowPositionals: true }));
  if (flags.help) {
    console.log(USAGE3);
    process.exit(0);
  }
  if (!files.length) {
    console.error(USAGE3);
    process.exit(2);
  }
  const { "design-system": dsDir, variables: varsFile, out } = flags;
  const jsonOnly = !!flags.json, gate = !!flags.gate;
  const ctx = variablesContext(files, varsFile);
  for (const bad of ctx.invalid) console.error(`error  variables: '${bad.file}' ${bad.error}`);
  if (ctx.invalid.length) process.exit(2);
  const screens = files.map((f, i) => ({ doc: readDocFile(f, "screen export", isScreenDoc2), label: path.basename(f, ".json"), vars: ctx.own[i] }));
  const dsBase = dsDir || "design/design-system";
  const { variablesPath, variablesDoc } = ctx;
  if (variablesPath) console.error(`variables: ${variablesPath}`);
  if (ctx.staleLegacy) {
    console.error(`warn  ${ctx.staleLegacy} also exists and was NOT used (stale sibling of design/export/) \u2014 remove it or re-pull into design/export/.`);
  }
  const res = crossCheck({
    screens,
    sliceSources: ctx.sliceSources,
    variables: variablesDoc,
    variablesPath,
    tokens: readOptionalDoc(path.join(dsBase, "tokens.json"), "design-system tokens", isTokensDoc2),
    components: readOptionalDoc(path.join(dsBase, "components.local.json"), "component catalog", isComponentsCatalog2),
    componentsLibrary: readOptionalDoc(path.join(dsBase, "components.library.json"), "library component catalog", isComponentsCatalog2),
    stylesText: readOptionalDoc(path.join(dsBase, "styles.text.json"), "text styles", isTextStylesDoc2)
  });
  if (jsonOnly) {
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
  } else if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out + ".json", JSON.stringify(res, null, 2) + "\n");
    fs.writeFileSync(out + ".md", toMarkdown(res));
    console.error(`wrote ${out}.json and ${out}.md`);
  } else {
    process.stdout.write(toMarkdown(res));
  }
  console.error(`${res.summary.blockers} blocker(s), ${res.summary.warnings} warning(s), ${res.summary.info} info`);
  for (const n of res.notChecked) console.error(`note  not checked: ${n}`);
  process.exit(gate && res.summary.blockers > 0 ? 1 : 0);
}

// design-to-code/audit.ts
var TOUCH_MIN = { web: 24, ios: 44, android: 48, "react-native": 44, flutter: 48 };
var PLATFORMS = Object.keys(TOUCH_MIN);
function blockerIds(auditDoc) {
  const findings = auditDoc && typeof auditDoc === "object" && "findings" in auditDoc && Array.isArray(auditDoc.findings) ? auditDoc.findings : [];
  return findings.filter((f) => !!f && typeof f === "object" && "severity" in f && f.severity === "blocker").map((f, i) => `${f.code || "blocker"}#${i}`);
}
if (false) {
  const argv = process.argv.slice(2);
  const USAGE3 = `usage: ${scriptCmd3("audit")} <screen.json>... [--platform web|ios|android|react-native|flutter]
       [--design-system design/design-system] [--variables design/variables.json]
       [--catalog components.local.json] [--grid 4] [--out design/audit] [--json] [--gate] [--force]
  --design-system turns on the cross-FILE pass (does this screen come from that design system?).
  Without it every token-binding % below means "binds SOME variable", not "matches your design system".
  --out defaults to design/audit/<input file's own basename> \u2014 the same <LayerName>__<node-id>
  name write-out.js gave the screen file, so re-auditing the same screen always lands on the same
  report pair instead of a new name each run. Refuses (exit 1) if an existing report in the same
  directory already covers this node under a DIFFERENT name \u2014 pass --force to write a second one.`;
  const OPTIONS = {
    platform: { type: "string" },
    catalog: { type: "string" },
    "design-system": { type: "string" },
    variables: { type: "string" },
    grid: { type: "string" },
    out: { type: "string" },
    json: { type: "boolean" },
    gate: { type: "boolean" },
    force: { type: "boolean" },
    help: { type: "boolean", short: "h" }
  };
  const { values: flags, positionals: files } = cliParse2("audit", argv, OPTIONS, USAGE3, 2, (args) => parseArgs({ args, options: OPTIONS, allowPositionals: true }));
  if (flags.help) {
    console.log(USAGE3);
    process.exit(0);
  }
  if (!files.length) {
    console.error(USAGE3);
    process.exit(2);
  }
  const { platform, catalog: catalogFile, "design-system": dsDir, variables: varsFile, grid: gridArg, out } = flags;
  const jsonOnly = !!flags.json, gate = !!flags.gate, force = !!flags.force;
  if (platform && !PLATFORMS.includes(platform)) {
    console.error(`--platform must be one of ${PLATFORMS.join(", ")}`);
    process.exit(2);
  }
  const grid = gridArg === void 0 ? void 0 : Number(gridArg);
  if (grid !== void 0 && !(Number.isFinite(grid) && grid > 0)) {
    console.error(`--grid must be a positive number of px, got ${JSON.stringify(gridArg)}`);
    process.exit(2);
  }
  const ctx = variablesContext2(files, varsFile, { sliceFallback: true });
  for (const bad of ctx.invalid) console.error(`error  variables: '${bad.file}' ${bad.error}`);
  if (ctx.invalid.length) process.exit(2);
  const inputs = files.map((f, i) => ({ doc: readDocFile2(f, "screen export", isScreenDoc), label: path.basename(f, ".json"), vars: ctx.own[i] }));
  const catalog = catalogFile ? readSplitFile(catalogFile, "component catalog", isComponentsCatalog3, "components", "design-system/components.local.json") : void 0;
  const designSystem = dsDir ? {
    tokens: readOptionalDoc2(path.join(dsDir, "tokens.json"), "design-system tokens", isTokensDoc3),
    components: readOptionalDoc2(path.join(dsDir, "components.local.json"), "component catalog", isComponentsCatalog3) || catalog,
    componentsLibrary: readOptionalDoc2(path.join(dsDir, "components.library.json"), "library component catalog", isComponentsCatalog3),
    stylesText: readOptionalDoc2(path.join(dsDir, "styles.text.json"), "text styles", isTextStylesDoc3)
  } : void 0;
  const variables = ctx.variablesDoc;
  if (ctx.staleLegacy) console.error(`warn  ${ctx.staleLegacy} also exists and was NOT used (stale sibling of design/export/) \u2014 remove it or re-pull into design/export/.`);
  const res = audit(inputs, { platform, catalog, designSystem, variables, sliceSources: ctx.sliceSources, grid });
  const md = jsonOnly ? "" : toMarkdown(res);
  const outBase = out || path.join("design", "audit", path.basename(files[0], ".json"));
  if (!jsonOnly && outBase && res.nodeIds && res.nodeIds.length) {
    const dup = findExistingAuditFor(path.dirname(outBase) || ".", res.nodeIds[0], outBase + ".json");
    if (dup && !force) {
      console.error(
        `error  node ${res.nodeIds[0]} already has an audit report at ${dup} \u2014 refusing to also write ${outBase}.json/.md (one screen, one report pair). Use that existing name, or pass --force to write this one anyway.`
      );
      process.exit(1);
    }
  }
  if (jsonOnly) {
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
  } else if (outBase) {
    fs.mkdirSync(path.dirname(outBase), { recursive: true });
    fs.writeFileSync(outBase + ".json", JSON.stringify(res, null, 2) + "\n");
    fs.writeFileSync(outBase + ".md", md);
    console.error(`wrote ${outBase}.json and ${outBase}.md`);
  } else {
    process.stdout.write(md);
  }
  if (res.platformAssumed) console.error("warn  no --platform given \u2014 assumed 'web'. Touch targets, shadow spread and blur support differ per platform; pass --platform or write design/target.json.");
  if (!jsonOnly) console.error(`${res.summary.blockers} blocker(s), ${res.summary.warnings} warning(s), ${res.summary.info} info`);
  for (const n of res.crossFile && res.crossFile.notChecked || []) console.error(`note  not checked: ${n}`);
  process.exit(gate && res.summary.blockers > 0 ? 1 : 0);
}

// design-to-code/audit-gate.ts
function slug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}
function locateAuditFile(cwd, screenFile, screenName) {
  const dir = path.join(cwd, "design", "audit");
  if (!fs3.existsSync(dir)) return null;
  const base = screenFile ? path.basename(screenFile, ".json") : null;
  const candidates = [];
  if (base) candidates.push(path.join(dir, base + ".json"));
  let entries = [];
  try {
    entries = fs3.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    entries = [];
  }
  for (const c of candidates) if (fs3.existsSync(c)) return path.relative(cwd, c).split(path.sep).join("/");
  const wantSlug = slug(screenName);
  if (wantSlug) {
    const stem = (f) => f.replace(/\.json$/, "");
    const nameOf = (f) => {
      const s = stem(f);
      const i = s.lastIndexOf("__");
      return i > 0 ? s.slice(0, i) : null;
    };
    const hit = entries.find((f) => slug(stem(f)) === wantSlug) ?? entries.find((f) => {
      const n = nameOf(f);
      return n !== null && slug(n) === wantSlug;
    });
    if (hit) return path.relative(cwd, path.join(dir, hit)).split(path.sep).join("/");
  }
  return null;
}
function auditGateStatus(cwd, screenFile, screenName) {
  const rel = locateAuditFile(cwd, screenFile, screenName);
  if (!rel) return { auditFile: null, blockers: [] };
  const r = readJson(path.join(cwd, rel), isAuditReport);
  if (!("doc" in r)) return { auditFile: rel, blockers: [], unreadable: true, error: r.error };
  return { auditFile: rel, blockers: blockerIds(r.doc) };
}

// design-to-code/map-validate.ts
var STATUSES = ["active", "deprecated", "needs-review"];
var KEYS = {
  root: ["version", "figmaFileKey", "components"],
  entry: ["figma", "code", "props", "variantOverrides", "childrenByLayer", "status"],
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
isCodeConnectMap.expected = "a valid component map (map-validate.js <file> lists what is wrong with it)";
if (false) {
  const file = process.argv[2];
  const USAGE3 = `usage: ${scriptCmd4("map-validate")} <map.json>`;
  if (file === "--help" || file === "-h") {
    console.log(USAGE3);
    process.exit(0);
  }
  if (!file || file.startsWith("-")) {
    console.error((file ? `map-validate: unknown flag ${file}
` : "") + USAGE3);
    process.exit(1);
  }
  const res = validateMap(readJsonFile(file, "component map"));
  if (res.ok) {
    console.log("map valid");
    process.exit(0);
  }
  res.errors.forEach((e) => console.error(`  ${e.path || "(root)"}: ${e.message}`));
  console.error(`
${res.errors.length} error(s)`);
  process.exit(1);
}

// design-to-code/plan-skeleton.ts
var USAGE = [
  `usage: ${scriptCmd("plan-skeleton")} <screen.json> <screen.vars.json> <design-system dir> [--out <plan.json>] [--map <codeconnect.local.json>] [--route <route>]`,
  "",
  "  Emits the build-screen plan skeleton for one screen, derived from the export:",
  "    tokens[]      every bound variable (keyed by Figma key, value in the frame's mode, design-system match)",
  "    components[]  every VISIBLE instance (key/setKey/name/props + catalog match / codeconnect mapping)",
  "    anchors{}     every VISIBLE node id, mapModule empty \u2014 fill it on sections and instances",
  "    hidden[]      roots of hidden subtrees (hidden: true or a hidden ancestor) \u2014 never built, never anchored",
  "    screenName / nodeId / file / route   the header every skill resolves a plan by",
  "",
  "  You fill in: codeToken, mapModule, verdict, decision, route, deviations[] (and files[], architecture,",
  "  verification as you build).",
  "",
  "  <design-system dir>  design/export/design-system (tokens.json, components.local.json). A missing",
  "                       directory is allowed (single-screen pull): values then come from the screen's",
  "                       own .vars.json and no catalog match is attempted \u2014 stderr says so.",
  "  --out <file>         write the plan there (default: stdout). An existing plan is MERGED, never",
  "                       overwritten: every field you filled is kept.",
  "  --map <file>         codeconnect.local.json (default: design/codeconnect.local.json or",
  "                       codeconnect.local.json in the current directory, when present).",
  "  --route <route>      the app route this screen will live at (else left null for you to fill)."
].join("\n");
function walkNodes(doc, visit) {
  const instAbove = /* @__PURE__ */ new Map();
  for (const r of screenRoots(doc)) {
    walkWithHidden(r, (n, c) => {
      const above = c.parent ? c.parent.type === "INSTANCE" ? c.parent.id : instAbove.get(c.parent) || null : null;
      instAbove.set(n, above);
      visit(n, { parent: c.parent, hidden: c.hidden, hiddenRoot: c.hidden && !c.parentHidden, insideInstance: above });
    });
  }
}
function visibility(doc) {
  const visible = /* @__PURE__ */ new Map(), hidden = /* @__PURE__ */ new Set(), hiddenRoots = [];
  const count = /* @__PURE__ */ new Map();
  walkNodes(doc, (n, ctx) => {
    if (!n.id) return;
    if (ctx.hidden) {
      hidden.add(n.id);
      if (ctx.hiddenRoot) {
        hiddenRoots.push({ id: n.id, name: n.name, type: n.type, nodes: 0 });
        count.set(n.id, hiddenRoots[hiddenRoots.length - 1]);
      }
    } else visible.set(n.id, { node: n, parentId: ctx.parent ? ctx.parent.id : null, insideInstance: ctx.insideInstance });
  });
  const tally = (n, root) => {
    if (!n || typeof n !== "object") return;
    const r = root || (count.has(n.id) ? n.id : null);
    if (r) count.get(r).nodes++;
    for (const c of n.children || []) tally(c, r);
  };
  for (const r of screenRoots(doc)) tally(r, null);
  return { visible, hidden, hiddenRoots };
}
if (false) process.exitCode = main(process.argv.slice(2));

// design-to-code/content-hash.ts
import fs4 from "node:fs";
import path2 from "node:path";
import crypto from "node:crypto";
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
      out[rel] = sha256(fs4.readFileSync(path2.join(cwd, rel))).slice(0, 16);
    } catch {
      out[rel] = null;
    }
  }
  return out;
}

// design-to-code/verify-build.ts
var HOOK_TIMEOUT_MS = () => Number(process.env.DTWIN_HOOK_TIMEOUT_MS) || 6e4;
var STDIN_WAIT_MS = () => {
  const n = Number(process.env.DTWIN_HOOK_STDIN_WAIT_MS);
  return Number.isFinite(n) && n >= 0 && process.env.DTWIN_HOOK_STDIN_WAIT_MS !== "" ? n : 1e3;
};
var phase = "starting";
var setPhase = (p) => {
  phase = p;
};
function readHookInput() {
  if (process.stdin.isTTY) return Promise.resolve({ payload: {}, source: "tty" });
  let st;
  try {
    st = fs5.fstatSync(0);
  } catch {
    return Promise.resolve({ payload: {}, source: "closed" });
  }
  const parse = (raw) => {
    if (!raw.trim()) return {};
    try {
      const v = JSON.parse(raw);
      return isJsonObject(v) ? v : {};
    } catch {
      return {};
    }
  };
  if (st.isFile() || st.isCharacterDevice()) {
    try {
      return Promise.resolve({ payload: parse(fs5.readFileSync(0, "utf8")), source: "file" });
    } catch {
      return Promise.resolve({ payload: {}, source: "unreadable" });
    }
  }
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0, finished = false;
    const done = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(first);
      clearTimeout(hard);
      process.stdin.removeAllListeners("data");
      process.stdin.removeAllListeners("end");
      try {
        process.stdin.pause();
        process.stdin.unref && process.stdin.unref();
      } catch {
      }
      resolve(value);
    };
    const first = setTimeout(() => {
      if (!bytes) done({ payload: {}, source: "silent-pipe" });
    }, STDIN_WAIT_MS());
    const hard = setTimeout(() => done({ error: `timed out after ${Math.round(HOOK_TIMEOUT_MS() / 1e3)} s waiting for the hook payload on stdin (${bytes} byte(s) received, no end-of-file) \u2014 pass the plan path as an argument instead, or pipe the payload: echo '{"cwd":"\u2026"}' | ${scriptCmd("verify-build")}` }), Math.max(50, HOOK_TIMEOUT_MS() - 250));
    process.stdin.on("data", (c) => {
      bytes += c.length;
      chunks.push(c);
    });
    process.stdin.on("end", () => done({ payload: parse(Buffer.concat(chunks).toString("utf8")), source: "pipe" }));
    process.stdin.on("error", () => done({ payload: {}, source: "error" }));
    process.stdin.resume();
  });
}
var STALE_HOURS = 12;
function staleCutoffMs() {
  const raw = process.env.DTWIN_PLAN_STALE_HOURS;
  const h = raw === void 0 || raw === "" ? STALE_HOURS : Number(raw);
  return Number.isFinite(h) && h > 0 ? h * 3600 * 1e3 : 0;
}
function isStale(file, now = Date.now()) {
  const cutoff = staleCutoffMs();
  if (!cutoff) return false;
  try {
    return now - fs5.statSync(file).mtimeMs > cutoff;
  } catch {
    return false;
  }
}
function readPlan(file) {
  const r = readJson(file, anyJson);
  if (!("doc" in r)) return { file, error: r.error };
  const p = parsePlan(r.doc);
  return "plan" in p ? { file, plan: p.plan } : { file, error: p.error };
}
var isPlanFile = (p) => "plan" in p;
function findPlans(cwd) {
  const dir = path3.join(cwd, "design", "plan");
  if (!fs5.existsSync(dir)) return { plans: [], bad: [] };
  const read = fs5.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => readPlan(path3.join(dir, f)));
  return { plans: read.filter(isPlanFile), bad: read.filter((p) => !isPlanFile(p)) };
}
function rootOfPlan(file, fallback) {
  const abs = path3.resolve(file);
  const dir = path3.dirname(abs);
  if (path3.basename(dir) === "plan" && path3.basename(path3.dirname(dir)) === "design") return path3.dirname(path3.dirname(dir));
  return fallback || process.cwd();
}
var REPORT_SCHEMA_V2 = "designtwin/verify-report@2";
var LIFECYCLE = /* @__PURE__ */ new Set(["pending", "awaiting-user", "abandoned"]);
var COMPUTED_STORED = /* @__PURE__ */ new Set(["verified", "static-only"]);
var isLifecycle = (s) => LIFECYCLE.has(s);
var lifecycleOf = (plan) => {
  const s = String(plan && plan.status || "pending").trim().toLowerCase();
  return isLifecycle(s) ? s : "pending";
};
var sha = (buf) => crypto2.createHash("sha256").update(buf).digest("hex").slice(0, 16);
function fileHashes2(plan, cwd) {
  return fileHashes(plan && plan.files, cwd);
}
function planHash(plan) {
  const copy = structuredClone(plan || {});
  delete copy.status;
  if (copy.verification) {
    delete copy.verification.hook;
    if (!Object.keys(copy.verification).length) delete copy.verification;
  }
  return sha(JSON.stringify(copy));
}
function changedFiles(plan, cwd) {
  const hook = plan.verification && plan.verification.hook;
  if (!hook || !hook.files) return null;
  const now = fileHashes2(plan, cwd);
  const changed = [];
  const all = /* @__PURE__ */ new Set([...Object.keys(hook.files), ...Object.keys(now)]);
  for (const f of all) if (hook.files[f] !== now[f]) changed.push(now[f] === void 0 ? `${f} (no longer in files[])` : hook.files[f] === void 0 ? `${f} (added to files[])` : now[f] === null ? `${f} (missing)` : f);
  return changed;
}
function isOpen(p, cwd) {
  if (lifecycleOf(p.plan) !== "pending") return false;
  if (isStale(p.file)) return false;
  const hook = p.plan.verification && p.plan.verification.hook;
  if (!hook || hook.result !== "pass") return true;
  if (hook.planHash !== planHash(p.plan)) return true;
  const ch = changedFiles(p.plan, cwd);
  return !ch || ch.length > 0;
}
var SOURCE_EXT = /* @__PURE__ */ new Set([
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "vue",
  "svelte",
  "astro",
  "css",
  "scss",
  "sass",
  "less",
  "styl",
  "html",
  "htm",
  "swift",
  "kt",
  "kts",
  "java",
  "dart",
  "xml",
  "m",
  "mm",
  "h",
  "cs",
  "xaml"
]);
var extOf = (rel) => String(rel).toLowerCase().split(".").pop();
var isSourceFile = (rel) => SOURCE_EXT.has(extOf(rel));
var PROSE = /\b[A-Za-z]{2,}[,.;:]?\s+[A-Za-z]{2,}[,.;:]?\s+[A-Za-z]{2,}\b/;
var isProse = (s) => PROSE.test(s) && !/-\[|\[#/.test(s);
function scanText(rel, text) {
  const ext = extOf(rel);
  const lineComments = !["css", "html", "htm", "xml", "xaml"].includes(ext);
  const htmlComments = ["html", "htm", "xml", "xaml", "vue", "svelte", "astro"].includes(ext);
  const strings = !["html", "htm", "xml", "xaml"].includes(ext);
  let out = "", i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i], d = text[i + 1];
    if (c === "/" && d === "*") {
      const j = text.indexOf("*/", i + 2);
      const end = j === -1 ? n : j + 2;
      out += text.slice(i, end).replace(/[^\n]/g, " ");
      i = end;
      continue;
    }
    if (lineComments && c === "/" && d === "/" && text[i - 1] !== ":") {
      const j = text.indexOf("\n", i);
      const end = j === -1 ? n : j;
      out += " ".repeat(end - i);
      i = end;
      continue;
    }
    if (htmlComments && text.startsWith("<!--", i)) {
      const j = text.indexOf("-->", i + 4);
      const end = j === -1 ? n : j + 3;
      out += text.slice(i, end).replace(/[^\n]/g, " ");
      i = end;
      continue;
    }
    if (strings && (c === '"' || c === "'" || c === "`")) {
      let j = i + 1;
      while (j < n && text[j] !== c && !(c !== "`" && text[j] === "\n")) j += text[j] === "\\" ? 2 : 1;
      const end = Math.min(n, j + 1);
      const body = text.slice(i + 1, j);
      out += isProse(body) ? c + body.replace(/[^\n]/g, " ") + (text[j] === c ? c : "") : text.slice(i, end);
      i = end;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
function colorLiterals(source) {
  const found = /* @__PURE__ */ new Map();
  const add = (h, lit) => {
    if (h && !found.has(h)) found.set(h, lit);
  };
  for (const m of source.matchAll(/#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g)) add(colorKey(m[1]), m[0]);
  for (const m of source.matchAll(/\b0x([0-9a-fA-F]{8}|[0-9a-fA-F]{6})\b/g)) {
    const h = m[1].toLowerCase();
    add("#" + (h.length === 8 ? h.slice(2) + h.slice(0, 2) : h + "ff"), m[0]);
  }
  for (const m of source.matchAll(/rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})(?:[\s,/]+([\d.]+%?))?[^)]*\)/g)) {
    const rgb = [m[1], m[2], m[3]].map((x) => Math.min(255, Number(x)).toString(16).padStart(2, "0")).join("");
    add("#" + rgb + alphaHex(m[4]), m[0]);
  }
  return found;
}
function alphaHex(a) {
  if (a === void 0 || a === "") return "ff";
  const n = String(a).endsWith("%") ? Number(String(a).slice(0, -1)) / 100 : Number(a);
  if (!Number.isFinite(n)) return "ff";
  return Math.round(Math.min(1, Math.max(0, n)) * 255).toString(16).padStart(2, "0");
}
var UTILITY_KIND = [
  [/^rounded(-[a-z]+)?$/, "radius"],
  [/^text$/, "fontSize"],
  [/^leading$/, "lineHeight"],
  [/^tracking$/, "letterSpacing"],
  [/^(gap|gap-x|gap-y|space-x|space-y)$/, "spacing"],
  [/^([pm][trblxy]?)$/, "spacing"],
  [/^(top|right|bottom|left|inset(-[xy])?|start|end)$/, "spacing"],
  [/^(w|h|min-w|min-h|max-w|max-h|size|basis)$/, "size"],
  [/^border(-[trblxyse]+)?$/, "borderWidth"]
];
var KIND_MATCHES = {
  radius: ["radius", "borderradius", "cornerradius"],
  fontSize: ["fontsize", "font-size", "type", "typography"],
  lineHeight: ["lineheight", "line-height"],
  letterSpacing: ["letterspacing", "letter-spacing", "tracking"],
  spacing: ["spacing", "space", "gap", "padding", "margin", "size", "dimension"],
  size: ["size", "spacing", "space", "dimension", "width", "height"],
  borderWidth: ["borderwidth", "border-width", "border", "stroke"]
};
function utilityKind(utility) {
  const u = String(utility || "").replace(/^-/, "");
  for (const [re, kind] of UTILITY_KIND) if (re.test(u)) return kind;
  return null;
}
function kindsCompatible(utility, rowKind) {
  const uk = utilityKind(utility);
  if (!uk) return true;
  const rk = String(rowKind || "").toLowerCase().replace(/[^a-z]/g, "");
  if (!rk) return true;
  return (KIND_MATCHES[uk] || []).some((k) => k.replace(/[^a-z]/g, "") === rk);
}
function arbitraryPx(source) {
  const found = /* @__PURE__ */ new Map();
  for (const m of source.matchAll(/(?:^|[\s"'`{(])([a-z-]+)-\[(-?\d+(?:\.\d+)?)(px|rem)\]/g)) {
    const px = Number(m[2]) * (m[3] === "rem" ? 16 : 1);
    const entry = { literal: `[${m[2]}${m[3]}]`, utility: m[1] };
    const list = found.get(px) || [];
    if (!list.some((e) => e.utility === entry.utility)) list.push(entry);
    found.set(px, list);
  }
  for (const m of source.matchAll(/\[(-?\d+(?:\.\d+)?)(px|rem)\]/g)) {
    const px = Number(m[1]) * (m[2] === "rem" ? 16 : 1);
    if (!found.has(px)) found.set(px, [{ literal: m[0], utility: null }]);
  }
  return found;
}
function importsOf(text) {
  const out = [];
  const re = /\bimport\s+(?:[^'"`;]*?\sfrom\s+)?["'`]([^"'`]+)["'`]|\bexport\s+[^'"`;]*?\sfrom\s+["'`]([^"'`]+)["'`]|\b(?:require|import)\s*\(\s*["'`]([^"'`]+)["'`]\s*\)|@import\s+(?:url\()?["']([^"']+)["']/g;
  for (const m of text.matchAll(re)) out.push(m[1] || m[2] || m[3] || m[4]);
  return out;
}
var SRC_EXT_RE = /\.(tsx?|jsx?|mjs|cjs|vue|svelte|astro|css|scss|swift|kt|dart)$/i;
function moduleSegments(spec) {
  let s = String(spec || "").trim().replace(/\\/g, "/").replace(SRC_EXT_RE, "").replace(/\/index$/i, "");
  const segs = s.split("/").filter((x) => x && x !== "." && x !== "..");
  if (segs.length && /^[@~#]$/.test(segs[0])) segs.shift();
  return segs;
}
function moduleImported(mapModule, byFile, cwd) {
  const want = moduleSegments(mapModule);
  if (!want.length) return true;
  const suffixMatch = (have) => {
    const k = Math.min(have.length, want.length);
    if (!k) return false;
    for (let i = 1; i <= k; i++) if (have[have.length - i].toLowerCase() !== want[want.length - i].toLowerCase()) return false;
    return true;
  };
  const wantAbs = moduleSegments(path3.relative(cwd, path3.resolve(cwd, String(mapModule))));
  for (const f of byFile) {
    for (const spec of importsOf(f.text)) {
      if (spec.startsWith(".")) {
        const resolved = moduleSegments(path3.relative(cwd, path3.resolve(cwd, path3.dirname(f.rel), spec)));
        if (resolved.join("/").toLowerCase() === wantAbs.join("/").toLowerCase() || suffixMatch(resolved)) return true;
      } else if (suffixMatch(moduleSegments(spec))) return true;
    }
    if (!/\.(tsx?|jsx?|mjs|cjs|vue|svelte|astro)$/i.test(f.rel)) {
      const name = want[want.length - 1];
      if (name && new RegExp(`\\b${name.replace(/[^A-Za-z0-9_]/g, "")}\\b`).test(f.text)) return true;
    }
  }
  return false;
}
function exportDirOf(cwd) {
  const e = path3.join(cwd, "design", "export");
  return fs5.existsSync(path3.join(e, "pages")) ? e : path3.join(cwd, "design");
}
var idFromStem = (s) => {
  const m = /__(I?\d+)_(\d+)$/.exec(String(s || ""));
  return m ? `${m[1]}:${m[2]}` : null;
};
function indexRows(exportDir) {
  const root = readJsonOrNull(path3.join(exportDir, "pages", "index.json"), isPagesRootIndex);
  if (!root) return [];
  if (root.layers) return root.layers;
  const rows = [];
  for (const pd of root.pageDirs) {
    const idx = readJsonOrNull(path3.join(exportDir, pd.index || path3.join("pages", pd.dir || "", "index.json")), isPageIndex);
    if (idx) rows.push(...idx.layers);
  }
  return rows;
}
function locateExport(plan, planFile, cwd) {
  const exportDir = exportDirOf(cwd);
  const tryFile = (rel) => {
    if (!rel) return null;
    for (const f of [path3.resolve(cwd, rel), path3.resolve(exportDir, rel)]) {
      const doc = readJsonOrNull(f, isScreenDoc);
      if (doc) return { file: f, doc };
    }
    return null;
  };
  let hit = tryFile(plan.file && /\.json$/i.test(plan.file) ? plan.file : null);
  const rows = indexRows(exportDir);
  const ids = [plan.nodeId, idFromStem(plan.screen), planFile ? idFromStem(path3.basename(planFile, ".json")) : null].filter((id) => !!id);
  let row = null;
  for (const id of ids) {
    row = rows.find((r) => r.id === id) || null;
    if (row) break;
  }
  if (!hit && row) hit = tryFile(row.file);
  if (!hit) return null;
  const root = screenRoots(hit.doc)[0];
  const exp = screenExportOf(hit.doc);
  const nodeId = exp && exp.nodeId || root && root.id || null;
  const layerName = String(exp && exp.screen || root && root.name || "");
  if (!row) row = rows.find((r) => r.id === nodeId) || null;
  return Object.assign(hit, { row, nodeId, layerName, sameNameRows: rows.filter((r) => String(r.name || "").trim() === layerName.trim()).length });
}
var anchored = (a) => !!a && typeof a === "object" && ["mapModule", "file", "symbol", "omitted"].some((k) => {
  const v = a[k];
  return typeof v === "string" && !!v.trim();
});
function anchorCoverage(plan, doc) {
  const { visible, hidden } = visibility(doc);
  const anchors = plan.anchors || {};
  const covered = /* @__PURE__ */ new Map();
  const isCovered = (id) => {
    if (covered.has(id)) return covered.get(id);
    const v = visible.get(id);
    const r = anchored(anchors[id]) || !!v && !!v.parentId && visible.has(v.parentId) && isCovered(v.parentId);
    covered.set(id, r);
    return r;
  };
  const hasAnchoredBelow = /* @__PURE__ */ new Set();
  for (const id of visible.keys()) {
    if (!anchored(anchors[id])) continue;
    let p = visible.get(id).parentId;
    while (p && visible.has(p) && !hasAnchoredBelow.has(p)) {
      hasAnchoredBelow.add(p);
      p = visible.get(p).parentId;
    }
  }
  const unmapped = [], wrappers = [];
  for (const [id, v] of visible) {
    if (isCovered(id)) continue;
    if (hasAnchoredBelow.has(id)) {
      wrappers.push({ id, name: v.node.name, type: v.node.type });
      continue;
    }
    const parentUnmapped = v.parentId && visible.has(v.parentId) && !isCovered(v.parentId) && !hasAnchoredBelow.has(v.parentId);
    if (!parentUnmapped) unmapped.push({ id, name: v.node.name, type: v.node.type });
  }
  const unmappedNodes = [...visible.keys()].filter((id) => !isCovered(id) && !hasAnchoredBelow.has(id)).length;
  return {
    visible: visible.size,
    unmapped,
    unmappedNodes,
    wrappers,
    hiddenAnchored: Object.keys(anchors).filter((id) => hidden.has(id)),
    unknown: Object.keys(anchors).filter((id) => !visible.has(id) && !hidden.has(id))
  };
}
var verdictOf = (row) => String(row && row.verdict || "").trim().toLowerCase();
var NO_TOKEN = /* @__PURE__ */ new Set(["missing", "none", "n/a", "na", "-", "null", "tbd"]);
var hasToken = (row) => !!row.codeToken && !NO_TOKEN.has(String(row.codeToken).trim().toLowerCase());
function loadMapKeys(cwd) {
  for (const f of [path3.join(cwd, "design", "codeconnect.local.json"), path3.join(cwd, "codeconnect.local.json")]) {
    const map = readJsonOrNull(f, isCodeConnectMap);
    if (!map) continue;
    const keys = /* @__PURE__ */ new Map();
    for (const [name, e] of Object.entries(map.components)) {
      if (e.figma.key && e.status !== "deprecated") keys.set(e.figma.key, { name, module: e.code.module });
    }
    return keys;
  }
  return /* @__PURE__ */ new Map();
}
function checkVerification(plan, cwd) {
  const v = plan.verification;
  if (!v || typeof v !== "object" || v.mode === void 0) {
    return ['no `verification.mode` in the plan \u2014 record how the build was checked: {mode:"rendered", renderer, artifacts:[\u2026], deltas:[\u2026]} after rendering and comparing (references/verify.md), or {mode:"static-only", reason} if the project genuinely has no way to render'];
  }
  if (v.mode === "rendered") {
    const artifacts = Array.isArray(v.artifacts) ? v.artifacts : [];
    if (!artifacts.length) return ['verification.mode is "rendered" but `artifacts` is empty \u2014 list the screenshot(s)/report the render produced'];
    const missing = artifacts.filter((a) => !fs5.existsSync(path3.join(cwd, String(a))));
    if (missing.length) return [`verification artifact(s) not found on disk: ${missing.join(", ")} \u2014 render the screen, or record mode "static-only" with the reason`];
    if (!Array.isArray(v.deltas)) return ["verification.deltas is missing \u2014 list the residual differences against the reference ([] if none were found)"];
    return [];
  }
  if (v.mode === "static-only") {
    return v.reason ? [] : ['verification.mode is "static-only" with no `reason` \u2014 say what was checked for and not found (dev server, Playwright, simulator\u2026)'];
  }
  return [`verification.mode must be "rendered" or "static-only", got ${JSON.stringify(v.mode)}`];
}
function verificationWarnings(plan) {
  const v = plan.verification;
  if (!v || v.mode !== "rendered") return [];
  const out = [];
  const c = v.coverage;
  if (!c || !Array.isArray(c.rendered) || !c.rendered.length) out.push('verification.coverage is missing \u2014 record {rendered:[\u2026], notChecked:[{what, why}]} so the report can say which states/themes/sizes were never rendered (references/verify.md, "Beyond the ideal frame")');
  if (!v.a11y) out.push("verification.a11y is missing \u2014 no accessibility check is recorded (web: @axe-core/playwright on the rendered page); say so in the report rather than implying one ran");
  return out;
}
var A11Y = /\b(a11y|axe|accessib)/i;
function verificationContradictions(plan, reports) {
  const v = plan.verification;
  if (!v || typeof v !== "object") return [];
  const out = [];
  const notChecked = v.coverage && Array.isArray(v.coverage.notChecked) ? v.coverage.notChecked : [];
  const what = (e) => String(e && typeof e === "object" ? e.what || "" : e || "");
  const rendered = v.coverage && Array.isArray(v.coverage.rendered) ? v.coverage.rendered.map((x) => String(x).trim().toLowerCase()) : [];
  if (v.a11y && typeof v.a11y === "object" && v.a11y.violations !== void 0) {
    const nc = notChecked.find((e) => A11Y.test(what(e)));
    if (nc) out.push(`verification contradicts itself: \`a11y\` records ${JSON.stringify(v.a11y.violations)} violation(s) from ${JSON.stringify(v.a11y.tool || "an a11y scan")}, while \`coverage.notChecked\` says "${what(nc)}" was not checked${typeof nc === "object" && nc.why ? ` (${nc.why})` : ""} \u2014 keep the one that is true`);
  }
  for (const e of notChecked) if (rendered.includes(what(e).trim().toLowerCase())) out.push(`verification contradicts itself: "${what(e)}" is listed both in coverage.rendered and in coverage.notChecked`);
  for (const r of reports || []) {
    if (Array.isArray(v.deltas) && !v.deltas.length && Array.isArray(r.deltas) && r.deltas.length) out.push(`verification.deltas is [] but ${r.rel} lists ${r.deltas.length} delta(s) \u2014 copy them (or the ones you judged real, with why) into the plan`);
    for (const k of ["verifyScreenVerdict", "verdict"]) {
      const claimed = v[k];
      const s = claimed && typeof claimed === "object" ? claimed.verdict : claimed;
      if (typeof s === "string" && /pass/i.test(s) && r.verdict !== "pass") out.push(`verification.${k} says ${JSON.stringify(s)} but ${r.rel} says verdict ${JSON.stringify(r.verdict)} \u2014 the report is the verdict; the plan cannot overrule it`);
    }
  }
  return out;
}
var DEVIATION_FIELDS = ["nodeId", "field", "designed", "built", "reason"];
function deviationWarnings(plan) {
  if (plan.deviations === void 0) return [];
  const bad = [];
  plan.deviations.forEach((d, i) => {
    const miss = DEVIATION_FIELDS.filter((k) => {
      if (k === "nodeId") return !(d && (typeof d.nodeId === "string" && d.nodeId || Array.isArray(d.nodeIds) && d.nodeIds.length));
      return !(d && d[k] !== void 0 && d[k] !== null && d[k] !== "");
    });
    if (miss.length) bad.push(`#${i}${d && d.id ? ` (${d.id})` : ""}: ${miss.join(", ")}`);
  });
  return bad.length ? [`${bad.length} deviation(s) are missing fields \u2014 each needs {nodeId, field, designed, built, reason} so a reviewer can check it against the export: ${bad.slice(0, 6).join("; ")}${bad.length > 6 ? `; +${bad.length - 6} more` : ""}`] : [];
}
function validatePlanHeader(plan) {
  const missing = ["screenName", "nodeId", "route", "file"].filter((k) => plan[k] === void 0 || plan[k] === null || plan[k] === "");
  if (!missing.length) return [];
  return [
    `plan header is missing ${missing.map((k) => `\`${k}\``).join(", ")} \u2014 other skills (verify, sync-design) resolve a screen through this header, not through the free-text \`screen\` field; add ${missing.length > 1 ? "them" : "it"} so this plan is findable by node id/name/route without guessing (plan-skeleton.js writes the header; only the route is yours to fill)`
  ];
}
var DECLARATION = /(^|[\s;{,(])(--[\w-]+|[\w$][\w$-]*)\s*[:=]\s*[^;,}\n]*$/;
var slug2 = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
function tokenCore(x) {
  let s = String(x || "").toLowerCase().replace(/^--/, "").replace(/^var\(--|\)$/g, "");
  s = s.replace(/^(color|colors|spacing|space|radius|rounded|text|font|font-size|font-weight|leading|tracking|shadow|bg|border|fill|stroke|ring|outline|gap|gap-[xy]|p[xytrbl]?|m[xytrbl]?|w|h|size|inset|top|left|right|bottom)-/, "");
  s = s.replace(/^figma-/, "").replace(/-[0-9a-f]{8}$/, "");
  return slug2(s);
}
function declaresToken(line, literal, codeToken) {
  const at = line.indexOf(literal);
  if (at === -1) return false;
  const m = DECLARATION.exec(line.slice(0, at));
  if (!m) return false;
  const declared = slug2(m[2]), token = slug2(codeToken);
  if (!declared || !token) return false;
  const dc = tokenCore(m[2]), tc = tokenCore(codeToken);
  return declared === token || declared.includes(token) || token.includes(declared) || !!dc && !!tc && (dc === tc || dc.includes(tc) || tc.includes(dc));
}
function checkPlan({ plan, file }, cwd, opts) {
  const o = opts || {};
  const blocking = [], warnings = [];
  const listed = plan.files || [];
  const absent = listed.filter((f) => !fs5.existsSync(path3.join(cwd, f)));
  if (!listed.length) warnings.push("`files` is empty \u2014 list every file this build created or changed; the literal and import checks only read the files named there, so nothing was checked");
  if (absent.length) warnings.push(`file(s) listed in \`files\` not found on disk: ${absent.join(", ")} \u2014 fix the path(s) (relative to the project root) or remove entries for files that were not written`);
  const byFile = listed.filter((rel) => fs5.existsSync(path3.join(cwd, rel)) && fs5.statSync(path3.join(cwd, rel)).isFile()).map((rel) => ({ rel, text: fs5.readFileSync(path3.join(cwd, rel), "utf8") }));
  const code = byFile.filter((f) => isSourceFile(f.rel)).map((f) => ({ rel: f.rel, text: scanText(f.rel, f.text) }));
  const source = code.map((f) => f.text).join("\n");
  const allowed = new Set((plan.allowedLiterals || []).filter((a) => a && a.reason && a.value !== void 0).map((a) => String(a.value).toLowerCase()));
  const allowedFiles = (plan.allowedLiterals || []).filter((a) => a && a.reason && a.file).map((a) => String(a.file));
  const isAllowed = (row, literal) => allowed.has(String(row.value).toLowerCase()) || allowed.has(String(literal).toLowerCase());
  function definedOnlyInTokenSource(literal, codeToken) {
    if (!literal) return false;
    let seen = false;
    for (const f of code) {
      if (!f.text.includes(literal)) continue;
      if (allowedFiles.includes(f.rel)) {
        seen = true;
        continue;
      }
      for (const line of f.text.split("\n")) {
        if (!line.includes(literal)) continue;
        if (!declaresToken(line, literal, codeToken)) return false;
        seen = true;
      }
    }
    return seen;
  }
  const tokens = plan.tokens || [];
  const live = tokens.filter((r) => verdictOf(r) !== "hidden-only");
  const undecided = live.filter((row) => (verdictOf(row) === "missing" || !hasToken(row)) && !row.decision);
  if (undecided.length) {
    const show = undecided.slice(0, 8).map((row) => `${row.figmaName ? `'${row.figmaName}' ` : ""}${String(row.value)} (${row.kind})`).join(", ");
    warnings.push(`${undecided.length} token row(s) have no token and no recorded decision: ${show}${undecided.length > 8 ? `, +${undecided.length - 8} more` : ""} \u2014 fill codeToken, or say what you did about it in \`decision\` (a one-off literal is a legitimate answer; say so)`);
  }
  const byCodeToken = /* @__PURE__ */ new Map();
  for (const row of live) {
    if (!hasToken(row) || !row.figmaName) continue;
    const c = String(row.codeToken).trim();
    const names = byCodeToken.get(c) || /* @__PURE__ */ new Map();
    if (!names.has(row.figmaName)) names.set(row.figmaName, row.value);
    byCodeToken.set(c, names);
  }
  for (const [c, names] of byCodeToken) {
    if (names.size < 2) continue;
    const l = [...names].map(([n, v]) => `'${n}' (${String(v)})`).join(" and ");
    warnings.push(`code token '${c}' is mapped from ${names.size} DIFFERENT Figma tokens \u2014 ${l}. They may share a value in the exported mode, but they are separate tokens and will diverge in another mode/theme; give each its own code token named after its own Figma name`);
  }
  const colors = colorLiterals(source);
  const colourHits = /* @__PURE__ */ new Map();
  for (const row of live) {
    if (!hasToken(row) || String(row.kind).toLowerCase() !== "color") continue;
    const h = colorKey(row.value);
    const lit = h && colors.get(h);
    if (lit && !isAllowed(row, lit) && !definedOnlyInTokenSource(lit, row.codeToken)) {
      if (!colourHits.has(lit)) colourHits.set(lit, { value: row.value, tokens: [] });
      const e = colourHits.get(lit);
      if (!e.tokens.includes(row.codeToken)) e.tokens.push(row.codeToken);
    }
  }
  for (const [lit, e] of colourHits) {
    const where = code.filter((f) => f.text.includes(lit) && !allowedFiles.includes(f.rel) && !f.text.split("\n").filter((l) => l.includes(lit)).every((l) => e.tokens.some((t) => declaresToken(l, lit, t)))).map((f) => f.rel);
    blocking.push(`raw colour ${lit} in ${where.join(", ")}, but the plan resolved ${String(e.value)} to token ${e.tokens.map((t) => `'${t}'`).join(" / ")} \u2014 use the token, not the literal (comments, prose strings and non-source files such as .svg are not scanned). A value that must stay literal goes in allowedLiterals as {"value": "${lit}", "reason": "\u2026"}, matched on the exact value string, or name the file that defines the tokens: {"file": "\u2026", "reason": "\u2026"}`);
  }
  const dims = arbitraryPx(source);
  for (const row of live) {
    if (!hasToken(row) || String(row.kind).toLowerCase() === "color") continue;
    const n = parseFloat(String(row.value));
    const hits = Number.isFinite(n) ? dims.get(n) || [] : [];
    const hit = hits.find((e) => kindsCompatible(e.utility, row.kind) && !isAllowed(row, e.literal) && !definedOnlyInTokenSource(e.literal, row.codeToken));
    if (hit) warnings.push(`arbitrary value ${hit.utility ? `${hit.utility}-${hit.literal}` : hit.literal} in built code, but the plan resolved ${String(row.value)} (${row.kind}) to token '${String(row.codeToken)}' \u2014 use the token (or add it to allowedLiterals with a reason)`);
  }
  const mapped = loadMapKeys(cwd);
  const seenModule = /* @__PURE__ */ new Set();
  for (const row of plan.components || []) {
    const verdict = verdictOf(row);
    if (verdict === "reused" && row.mapModule && !seenModule.has(row.mapModule)) {
      seenModule.add(row.mapModule);
      if (!moduleImported(row.mapModule, byFile, cwd)) warnings.push(`component '${row.name}' is "reused" from ${row.mapModule}, but no file in files[] imports that module (compared by resolved path / path suffix, so '../../components/X' and '@/components/X' both count) \u2014 was it regenerated instead of reused?`);
    }
    if (verdict === "new" && row.key && mapped.has(row.key)) {
      warnings.push(`component '${row.name}' is marked "new" in the plan, but its Figma key is mapped to ${mapped.get(row.key).module} in codeconnect.local.json \u2014 reuse the existing component`);
    }
    if (verdict === "missing") warnings.push(`component '${row.name}' has no recorded reuse/new decision`);
  }
  const exp = o.export === void 0 ? locateExport(plan, file, cwd) : o.export;
  if (!exp) {
    warnings.push("could not find this plan's screen export (no `file`/`nodeId` header, and no node id in its name) \u2014 the anchor check did not run; plan-skeleton.js writes the header");
  } else {
    const cov = anchorCoverage(plan, exp.doc);
    if (cov.unmapped.length) {
      const show = cov.unmapped.slice(0, 10).map((u) => `${u.id} '${String(u.name).trim()}' (${u.type})`).join(", ");
      blocking.push(`${cov.unmappedNodes} visible design node(s) have no anchor in the plan \u2014 neither they nor any ancestor map to code. Top of each unmapped subtree: ${show}${cov.unmapped.length > 10 ? `, +${cov.unmapped.length - 10} more` : ""}. Add anchors["<id>"] = {"mapModule": "<the file that renders it>"} on the subtree's top (children inherit it), or {"omitted": "<why it is not built>"} \u2014 plan-skeleton.js lists every visible node`);
    }
    if (cov.wrappers.length) warnings.push(`${cov.wrappers.length} visible container(s) have anchored children but no anchor of their own (e.g. ${cov.wrappers.slice(0, 3).map((w) => `${w.id} '${String(w.name).trim()}'`).join(", ")}) \u2014 anchor the frame to the screen component so sync-design can place a change to it`);
    if (cov.hiddenAnchored.length) warnings.push(`${cov.hiddenAnchored.length} anchor(s) point at HIDDEN nodes (${cov.hiddenAnchored.slice(0, 4).join(", ")}${cov.hiddenAnchored.length > 4 ? ", \u2026" : ""}) \u2014 hidden layers are not built; remove them`);
    if (cov.unknown.length) warnings.push(`${cov.unknown.length} anchor(s) name node ids that are not on this frame (${cov.unknown.slice(0, 4).join(", ")}${cov.unknown.length > 4 ? ", \u2026" : ""}) \u2014 e.g. a shared shell tagged with another frame's instance ids; anchor THIS frame's ids`);
  }
  warnings.push(...checkVerification(plan, cwd));
  warnings.push(...verificationWarnings(plan));
  warnings.push(...verificationContradictions(plan, o.reports || locateReports(plan, file, cwd, exp)));
  warnings.push(...deviationWarnings(plan));
  warnings.push(...validatePlanHeader(plan));
  warnings.push(...auditGateWarnings(plan, cwd, exp));
  return { blocking, warnings };
}
function auditGateWarnings(plan, cwd, exp) {
  const screenFile = plan.file ? path3.resolve(cwd, plan.file) : null;
  const screenName = plan.screenName || exp && exp.layerName || null;
  let g;
  try {
    g = auditGateStatus(cwd, screenFile, screenName);
  } catch {
    return [];
  }
  if (g.auditFile && g.unreadable) return [`${g.auditFile} ${g.error || "could not be read"} \u2014 the audit gate was NOT checked; re-run audit.js for this screen`];
  if (!g.auditFile || !g.blockers.length) return [];
  const gate = plan.auditGate;
  if (!gate) {
    return [`${g.auditFile} is Blocked (${g.blockers.length} blocker(s): ${g.blockers.join(", ")}) and this plan has no \`auditGate\` \u2014 either resolve the blocker(s) or record {auditGate:{auditFile,verdict,overridden:[...],reason,decidedBy,decidedAt}} naming which one(s) were acknowledged and why`];
  }
  const overridden = new Set(Array.isArray(gate.overridden) ? gate.overridden : []);
  const uncovered = g.blockers.filter((id) => !overridden.has(id));
  if (uncovered.length) return [`${g.auditFile} has ${uncovered.length} blocker(s) not listed in this plan's auditGate.overridden: ${uncovered.join(", ")} \u2014 either resolve them or add them with a reason`];
  if (!gate.reason) return [`this plan's auditGate overrides ${overridden.size} blocker(s) but gives no \`reason\` \u2014 say why it is safe to build past ${g.auditFile}`];
  return [];
}
function locateReports(plan, planFile, cwd, exp) {
  const dir = path3.join(cwd, "design", "verify");
  if (!fs5.existsSync(dir)) return [];
  const e = exp === void 0 ? locateExport(plan, planFile, cwd) : exp;
  const stems = new Set([
    plan.file ? path3.basename(String(plan.file)).replace(/\.json$/i, "") : null,
    e ? path3.basename(e.file).replace(/\.json$/i, "") : null,
    planFile ? path3.basename(planFile, ".json") : null,
    plan.screen ? String(plan.screen) : null
  ].filter((s) => !!s));
  const nodeId = plan.nodeId || e && e.nodeId || idFromStem(plan.screen) || (planFile ? idFromStem(path3.basename(planFile, ".json")) : null);
  const layer = e ? e.layerName.trim() : null;
  const out = [];
  for (const f of fs5.readdirSync(dir).filter((x) => x.endsWith(".report.json")).sort()) {
    const abs = path3.join(dir, f);
    const r = readJsonOrNull(abs, isVerifyReport);
    if (!r) continue;
    const stem = f.replace(/\.report\.json$/, "");
    let by = null;
    const expFile = path3.join(dir, stem + ".expected.json");
    const expFrame = () => {
      const x = readJsonOrNull(expFile, isJsonObject);
      return x && isJsonObject(x.frame) && typeof x.frame.nodeId === "string" ? x.frame.nodeId : null;
    };
    if (stems.has(stem)) by = "name";
    else if (nodeId && (r.nodeId === nodeId || idFromStem(stem) === nodeId)) by = "nodeId";
    else if (nodeId && fs5.existsSync(expFile) && expFrame() === nodeId) by = "expectation frame";
    else if (layer && e.sameNameRows <= 1 && String(r.screen || "").trim() === layer) by = "layer name";
    if (!by) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = fs5.statSync(abs).mtimeMs;
    } catch {
    }
    const want = r.inputs && r.inputs.expectationSha256;
    let expectationChanged = false;
    if (want && fs5.existsSync(expFile)) {
      try {
        expectationChanged = crypto2.createHash("sha256").update(fs5.readFileSync(expFile)).digest("hex") !== want;
      } catch {
      }
    }
    out.push({
      rel: path3.relative(cwd, abs).split(path3.sep).join("/"),
      matchedBy: by,
      schema: r.schema || null,
      verdict: r.verdict || null,
      headline: r.headline || null,
      why: r.why || [],
      deltas: r.deltas || null,
      exportedAt: r.exportedAt || null,
      measuredAt: r.measuredAt || null,
      mtimeMs,
      exportContentSha256: r.inputs && r.inputs.exportContentSha256 || null,
      code: r.inputs && r.inputs.code || null,
      expectationChanged,
      expectationRel: expectationChanged ? path3.relative(cwd, expFile).split(path3.sep).join("/") : null
    });
  }
  return out;
}
function reportVerdict(plan, cwd, exp, reports) {
  const mode = plan.verification && plan.verification.mode;
  if (!reports.length) {
    if (mode === "static-only") return { status: "static-only", reasons: [`built and checked statically \u2014 not rendered (${plan.verification.reason || "no reason recorded"})`] };
    return { status: "unverified", reasons: [`no verify report found for this screen in design/verify/ \u2014 run verify-screen.js --expect/--compare (the report's verdict is what grants "verified")`] };
  }
  const legacy = reports.filter((r) => r.schema !== REPORT_SCHEMA_V2);
  if (legacy.length) return { status: "unverified", reasons: legacy.map((r) => `${r.rel} is ${r.schema || "an unversioned report"} (its verdict: ${JSON.stringify(r.verdict)}) \u2014 it predates ${REPORT_SCHEMA_V2}, whose counts exclude hidden layers, so its verdict and figures are not reliable. Regenerate it: verify-screen.js --expect, then --compare`) };
  const said = (r) => `${r.rel} says verdict ${JSON.stringify(r.verdict)}${r.headline ? ` (${r.headline})` : r.why.length ? `: ${r.why.join("; ")}` : ""}`;
  const failing = reports.filter((r) => r.verdict === "fail");
  if (failing.length) return { status: "failed", reasons: failing.map(said) };
  const notPass = reports.filter((r) => r.verdict !== "pass");
  if (notPass.length) return { status: "unverified", reasons: notPass.map(said) };
  const expSha = exp && exp.doc ? exportContentSha256(exp.doc) : null;
  for (const r of reports) {
    if (!r.exportContentSha256) {
      if (r.expectationChanged) return { status: "unverified", reasons: [`${r.rel} was computed against a different ${r.expectationRel} than the one on disk (inputs.expectationSha256 no longer matches) \u2014 re-run --compare`] };
      return { status: "unverified", reasons: [`${r.rel} does not record the content hash of the export it measured (inputs.exportContentSha256) \u2014 re-run verify-screen.js --expect and --compare`] };
    }
    if (!expSha) return { status: "unverified", reasons: [`cannot find this plan's screen export to compare with ${r.rel}'s inputs.exportContentSha256 \u2014 give the plan its \`file\` header`] };
    if (r.exportContentSha256 !== expSha) return { status: "unverified", reasons: [`the design changed since ${r.rel} was computed (export content sha256 ${r.exportContentSha256.slice(0, 12)}\u2026 \u2192 ${expSha.slice(0, 12)}\u2026, timestamps ignored) \u2014 re-run --expect and --compare`] };
    const measured = r.code && r.code.files && typeof r.code.files === "object" ? r.code.files : null;
    if (!measured) return { status: "unverified", reasons: [`${r.rel} does not record which code it measured (inputs.code) \u2014 re-run verify-screen.js --compare from the project root, where design/plan/ lists this screen's files`] };
    const now = fileHashes2(plan, cwd);
    const differ = Object.keys(now).filter((f) => measured[f] !== now[f]);
    if (differ.length) return { status: "unverified", reasons: [`${r.rel} measured different code \u2014 changed since: ${differ.slice(0, 6).join(", ")}${differ.length > 6 ? `, +${differ.length - 6} more` : ""} \u2014 re-run --compare`] };
  }
  const head = reports.map((r) => r.code && r.code.gitHead).find(Boolean);
  return { status: "verified", reasons: [`${reports.map((r) => r.rel).join(", ")} says pass and measured this design and exactly these files (by content)${head ? ` \u2014 at git ${head.slice(0, 12)}` : ""}`] };
}
function computeStatus(plan, opts) {
  const o = opts || {};
  const cwd = o.cwd || (o.planFile ? rootOfPlan(o.planFile) : process.cwd());
  const notes = [];
  const stored = String(plan && plan.status || "").trim().toLowerCase();
  if (COMPUTED_STORED.has(stored)) notes.push(`the stored "status": "${plan.status}" was not confirmed by the current hook and is ignored \u2014 status is computed, never stored`);
  const life = lifecycleOf(plan);
  if (life !== "pending") return { status: life, reasons: [life === "abandoned" ? 'retired by hand ("status": "abandoned")' : 'paused on a question for the user ("status": "awaiting-user")'], reports: [] };
  const exp = o.export === void 0 ? locateExport(plan, o.planFile, cwd) : o.export;
  const reports = o.reports || locateReports(plan, o.planFile, cwd, exp);
  const rv = reportVerdict(plan, cwd, exp, reports);
  const hook = plan.verification && plan.verification.hook;
  let hookState = null, hookWhy = [];
  if (!hook || !hook.result) {
    hookState = "pending";
    hookWhy = ["the build-screen Stop hook has not checked this plan"];
  } else if (hook.planHash && hook.planHash !== planHash(plan)) {
    hookState = "pending";
    hookWhy = ["the plan changed after the hook's last check"];
  } else if (hook.result !== "pass") {
    hookState = "blocked";
    hookWhy = hook.blocking && hook.blocking.length ? hook.blocking : ["the hook's last check blocked"];
  } else {
    const ch = changedFiles(plan, cwd) || [];
    if (ch.length) {
      hookState = "stale";
      hookWhy = [`file(s) changed since the hook passed: ${ch.slice(0, 6).join(", ")}${ch.length > 6 ? `, +${ch.length - 6} more` : ""}`];
    }
  }
  const reportWhy = rv.reasons.map((r) => (hookState ? "report: " : "") + r);
  if (rv.status === "failed") return { status: "failed", reasons: notes.concat(reportWhy, hookWhy.map((h) => "hook: " + h)), reports };
  if (hookState) return { status: hookState, reasons: notes.concat(hookWhy, reportWhy), reports };
  return { status: rv.status, reasons: notes.concat(rv.status === "verified" ? ["hook passed; " + rv.reasons[0]] : rv.reasons), reports };
}
function ownPlans(open, input, all) {
  const file = input.agent_transcript_path || (input.agent_id ? null : input.transcript_path);
  if (!file || typeof file !== "string") return open;
  let text;
  try {
    text = fs5.readFileSync(file, "utf8");
  } catch {
    return open;
  }
  const mentioned = (p) => {
    const base = path3.basename(p.file);
    return text.includes("plan/" + base) || text.includes("plan\\\\" + base);
  };
  const known = all && all.length ? all : open;
  if (!known.some(mentioned)) return open;
  return open.filter(mentioned);
}
var USAGE2 = [
  `usage: ${scriptCmd("verify-build")}                     (Stop hook: reads the hook JSON from stdin when stdin is not a terminal)`,
  `       ${scriptCmd("verify-build")} <plan.json>\u2026        check these plans now (no stdin read)`,
  `       ${scriptCmd("verify-build")} --status [<plan.json>\u2026] [--json]   print each plan's computed status (all of design/plan/ by default); never writes`,
  "",
  "Blocks (exit 2) on exactly two things: a raw colour the plan resolved to a token, in a source file of",
  "files[] (comments, prose strings and .svg/.json/non-source files are not scanned); and a visible",
  "design node with no anchor (itself or an ancestor) in anchors{}. Everything else is a warning (exit 0).",
  "Never writes plan.status: it records verification.hook {result, planHash, files:{path: sha256}}, and",
  "--status computes the status from that, the file hashes, and design/verify/<\u2026>.report.json. First match wins:",
  "  1. abandoned | awaiting-user  set by a person in plan.status; nothing else is evaluated",
  "  2. failed       a verify-report@2 for this screen says fail (never hidden behind the hook's state)",
  "  3. blocked      the Stop hook's last check blocked",
  "  4. stale        a file in files[] changed (by content) since the hook passed",
  "  5. pending      the hook has not checked this version of the plan",
  "  6. unverified | static-only | verified   what the report says: verified only for an @2 'pass' that",
  "     measured this design and these files, by content hash (no report / a pre-@2 report / other",
  '     design or code -> unverified). A stored "verified" is ignored.',
  "Every non-verified status carries a non-empty why: the hook's state AND what the report says (a",
  "report too old to trust is named with its schema). --json prints {plan, status, why, reasons, reports}."
].join("\n");
function checkAndRecord(p, cwd) {
  const exp = locateExport(p.plan, p.file, cwd);
  const reports = locateReports(p.plan, p.file, cwd, exp);
  setPhase(`checking ${path3.basename(p.file)}`);
  const { blocking, warnings } = checkPlan(p, cwd, { export: exp, reports });
  const plan = p.plan;
  const cleared = COMPUTED_STORED.has(String(plan.status || "").toLowerCase()) ? plan.status : null;
  if (cleared) delete plan.status;
  if (!plan.verification) plan.verification = {};
  setPhase(`hashing files[] of ${path3.basename(p.file)}`);
  plan.verification.hook = {
    result: blocking.length ? "blocked" : "pass",
    checkedAt: (/* @__PURE__ */ new Date()).toISOString(),
    blocking,
    warnings: warnings.length,
    planHash: planHash(plan),
    files: fileHashes2(plan, cwd)
  };
  let times = null;
  try {
    const s = fs5.statSync(p.file);
    times = [s.atime, s.mtime];
  } catch {
  }
  fs5.writeFileSync(p.file, JSON.stringify(plan, null, 2) + "\n");
  if (times) try {
    fs5.utimesSync(p.file, times[0], times[1]);
  } catch {
  }
  const st = computeStatus(plan, { cwd, planFile: p.file, export: exp, reports });
  return { blocking, warnings, cleared, status: st };
}
async function main(argv) {
  const args = argv.slice();
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE2);
    return 0;
  }
  const statusMode = args.includes("--status");
  const json = args.includes("--json");
  const planArgs = args.filter((a) => !a.startsWith("-"));
  const stray = args.filter((a) => a.startsWith("-") && !["--status", "--json"].includes(a));
  if (stray.length) {
    console.error(`verify-build: unknown flag ${stray.join(", ")}
${USAGE2}`);
    return 2;
  }
  if (statusMode) {
    setPhase("computing plan status");
    const found = planArgs.length ? planArgs.map((f) => readPlan(path3.resolve(f))) : null;
    const { plans, bad } = found ? { plans: found.filter(isPlanFile), bad: found.filter((p) => !isPlanFile(p)) } : findPlans(process.cwd());
    for (const b of bad) console.error(`verify-build: cannot read plan ${b.file}: ${b.error}`);
    const show = (f) => {
      const r = path3.relative(process.cwd(), f);
      return r.startsWith("..") ? f : r;
    };
    const rows = plans.map((p) => Object.assign({ plan: show(p.file) }, computeStatus(p.plan, { planFile: p.file, cwd: rootOfPlan(p.file) })));
    if (json) console.log(JSON.stringify(rows.map((r) => ({ plan: r.plan, status: r.status, why: r.reasons.join(" \xB7 ") || null, reasons: r.reasons, reports: r.reports.map((x) => ({ file: x.rel, verdict: x.verdict, matchedBy: x.matchedBy })) })), null, 2));
    else for (const r of rows) console.log(`${r.plan}: ${r.status}${r.reasons.length ? "\n  - " + r.reasons.join("\n  - ") : ""}`);
    if (!plans.length) console.error("verify-build: no plans found (design/plan/*.json)");
    return 0;
  }
  let input = {};
  let targets;
  if (planArgs.length) {
    const read = planArgs.map((f) => readPlan(path3.resolve(f)));
    const bad = read.filter((p) => !isPlanFile(p));
    if (bad.length) {
      console.error(`verify-build: cannot read plan(s): ${bad.map((b) => `${path3.relative(process.cwd(), b.file) || b.file} (${b.error})`).join(", ")}`);
      return 1;
    }
    targets = read.filter(isPlanFile);
  } else {
    setPhase("reading the hook payload on stdin");
    const r = await readHookInput();
    if (r.error) {
      console.error(`verify-build: ${r.error}`);
      return 1;
    }
    input = r.payload || {};
    if (input.stop_hook_active) return 0;
  }
  const all = [];
  if (targets) {
    for (const p of targets) {
      const cwd = rootOfPlan(p.file);
      const life = lifecycleOf(p.plan);
      if (life !== "pending") {
        console.error(`verify-build: ${path3.basename(p.file)} is "${life}" \u2014 not checked`);
        continue;
      }
      all.push({ p, cwd });
    }
  } else {
    const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
    setPhase("finding open plans in design/plan/");
    const { plans, bad } = findPlans(cwd);
    for (const b of bad) console.error(`verify-build: warning: ${path3.relative(cwd, b.file)} ${b.error} \u2014 it was NOT checked; fix it (plan-skeleton.js rewrites the skeleton fields and keeps what you filled)`);
    const open = plans.filter((p) => isOpen(p, cwd));
    if (!open.length) return 0;
    for (const p of ownPlans(open, input, plans)) all.push({ p, cwd });
  }
  const blockedOut = [];
  for (const { p, cwd } of all) {
    const res = checkAndRecord(p, cwd);
    const name = path3.basename(p.file);
    if (res.cleared) console.error(`verify-build: ${name}: removed the stored "status": "${res.cleared}" \u2014 status is computed now (verify-build.js --status), never stored`);
    for (const w of res.warnings) console.error(`verify-build: warning (${name}): ${w}`);
    if (res.blocking.length) blockedOut.push(`# ${name}`, ...res.blocking.map((m) => `  - ${m}`));
    const why = res.blocking.length ? "see below" : res.status.reasons[res.status.reasons.length - 1];
    console.error(`verify-build: ${name}: hook ${res.blocking.length ? "BLOCKED" : "passed"} \xB7 computed status: ${res.status.status}${why ? ` \u2014 ${why}` : ""}`);
  }
  if (blockedOut.length) {
    console.error("\nverify-build: build-screen check failed \u2014 do not report this screen as done until these are resolved");
    console.error('(a plan that will not be finished: set its status to "abandoned"; a build paused on a question for the user: "awaiting-user", then ask):\n');
    console.error(blockedOut.join("\n"));
    return 2;
  }
  return 0;
}
if (import.meta.main ?? isMainFallback(import.meta.url)) {
  const watchdog = setTimeout(() => {
    console.error(`verify-build: gave up after ${Math.round(HOOK_TIMEOUT_MS() / 1e3)} s while ${phase} \u2014 nothing was blocked; re-run \`${scriptCmd("verify-build")} <plan.json>\` to check the plan directly`);
    process.exit(1);
  }, HOOK_TIMEOUT_MS());
  watchdog.unref();
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (e) => {
    console.error(`verify-build: ${e instanceof Error && e.stack || String(e)}`);
    process.exitCode = 1;
  });
}
export {
  USAGE2 as USAGE,
  anchorCoverage,
  arbitraryPx,
  auditGateWarnings,
  checkPlan,
  checkVerification,
  colorKey,
  colorLiterals,
  computeStatus,
  deviationWarnings,
  fileHashes2 as fileHashes,
  importsOf,
  isOpen,
  isSourceFile,
  isStale,
  locateExport,
  locateReports,
  main,
  moduleImported,
  ownPlans,
  planHash,
  readHookInput,
  scanText,
  validatePlanHeader,
  verificationContradictions,
  verificationWarnings
};
