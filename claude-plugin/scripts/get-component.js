// GENERATED from design-to-code/ by claude-plugin/build-scripts.js — edit the source, then rebuild.


// design-to-code/get-component.ts
import path from "node:path";

// design-to-code/types.ts
function isJsonObject(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// bridge/src/json-util.ts
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
function isStringRecord(x) {
  return isObj(x) && Object.values(x).every((v) => typeof v === "string");
}
isStringRecord.expected = "an object of strings";

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

// design-to-code/cli-args.ts
var scriptCmd = (name) => `node "\${CLAUDE_PLUGIN_ROOT}/scripts/${name}.js"`;

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

// bridge/src/design-system-layout.ts
var DIR = "design-system";
var DESIGN_SYSTEM_DIR = DIR;

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

// design-to-code/get-component.ts
function findComponent(catalog, handle) {
  const comps = catalog && catalog.components || [];
  const byKey = comps.find((c) => c.key === handle);
  if (byKey) return byKey;
  const byId = comps.find((c) => c.id === handle);
  if (byId) return byId;
  const byName = comps.filter((c) => c.name === handle);
  const only = byName.length === 1 ? byName[0] : void 0;
  if (only) return only;
  if (byName.length > 1) {
    const err = new Error(`'${handle}' matches ${byName.length} components by name \u2014 use its key or id instead (${byName.map((c) => c.key || c.id).join(", ")})`);
    err.code = "ambiguous-name";
    throw err;
  }
  return null;
}
function resolveVariantsFile(catalogFile, variantsFile) {
  const catalogDir = path.dirname(catalogFile);
  const root = path.basename(catalogDir) === DESIGN_SYSTEM_DIR ? path.dirname(catalogDir) : catalogDir;
  return path.join(root, variantsFile);
}
function readOrThrow(file, guard) {
  const r = readJson(file, guard);
  if ("doc" in r) return r.doc;
  throw new Error(`'${file}' ${r.error}`);
}
function getComponent(catalogFile, handle) {
  const raw = readOrThrow(catalogFile, anyJson);
  assertNotManifest(raw, catalogFile, "components", "design-system/components.local.json");
  if (!isComponentsCatalog(raw)) throw new Error(`'${catalogFile}' is not ${isComponentsCatalog.expected}`);
  const catalog = raw;
  const comp = findComponent(catalog, handle);
  if (!comp) return { found: false };
  const pointer = comp.variantsFile || comp.nodeFile;
  if (!pointer) return { found: true, component: comp, detail: null };
  const detailPath = resolveVariantsFile(catalogFile, pointer);
  const detail = readOrThrow(detailPath, isComponentDetailFile);
  return { found: true, component: comp, detail, detailPath };
}
if (import.meta.main ?? isMainFallback(import.meta.url)) {
  const [catalogFile, handle] = process.argv.slice(2);
  if (!catalogFile || !handle) {
    console.error(`usage: ${scriptCmd("get-component")} <design-system/components.local.json> <key|id|name>`);
    process.exit(2);
  }
  try {
    const res = getComponent(catalogFile, handle);
    if (!res.found) {
      console.error(`error  no component matches '${handle}' in ${catalogFile}`);
      process.exit(1);
    }
    if (!res.detail) {
      console.error(`warn   '${handle}' has no variantsFile/nodeFile (no node trees were exported for it \u2014 re-run the export with variantVisuals:true) \u2014 printing the catalog entry only`);
      process.stdout.write(JSON.stringify(res.component, null, 2) + "\n");
      process.exit(0);
    }
    process.stdout.write(JSON.stringify(res.detail, null, 2) + "\n");
  } catch (e) {
    const message = e && typeof e === "object" && "message" in e ? e.message : void 0;
    console.error(`error  ${String(message)}`);
    process.exit(2);
  }
}
export {
  findComponent,
  getComponent,
  resolveVariantsFile
};
