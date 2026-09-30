// GENERATED from design-to-code/ by claude-plugin/build-scripts.js — edit the source, then rebuild.


// design-to-code/tokens.ts
import fs3 from "node:fs";
import path4 from "node:path";

// design-to-code/types.ts
function isJsonObject(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
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
  ["notMeasured", Array.isArray, "a list \u2014 the probe's reasons for unmatched nodes are not used"]
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
  return isObj(x) && optStr(x.schema) && optStr(x.verdict) && optStr(x.screen) && optStr(x.nodeId) && optStr(x.headline) && (x.why === void 0 || isStringArray(x.why)) && optArrayOf(x.deltas, anyObject) && optObj(x.inputs);
}
isVerifyReport.expected = "a verify report (the verify-screen script's --compare output): an object with `verdict`, `why[]`, `deltas[]`, `inputs`";
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
function isStringRecord(x) {
  return isObj(x) && Object.values(x).every((v) => typeof v === "string");
}
isStringRecord.expected = "an object of strings";

// design-to-code/cli-args.ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
var SELF = fileURLToPath(import.meta.url);
var shellQuote = (p) => /["$`\\]/.test(p) ? `'${p.replaceAll("'", `'\\''`)}'` : `"${p}"`;
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

// design-to-code/tokens.ts
import { parseArgs as parseArgs2 } from "node:util";

// design-to-code/slice-sources.ts
import path2 from "node:path";
function sourcesOf(doc, docPath) {
  const out = /* @__PURE__ */ new Map();
  const add = (key, screen) => {
    if (typeof key !== "string" || !key || !screen) return;
    const list = out.get(key) || [];
    if (!list.includes(screen)) list.push(screen);
    out.set(key, list);
  };
  const base = docPath ? path2.dirname(docPath) : ".";
  for (const sl of doc && Array.isArray(doc._slices) ? doc._slices : []) {
    if (!sl) continue;
    let read = false;
    if (typeof sl.file === "string") {
      const slice = readJsonOrNull(path2.join(base, sl.file.replace(/\.json$/, ".vars.json")), isTokensDoc);
      if (slice) {
        for (const v of slice.variables || []) add(v.key, sl.screen);
        read = true;
      }
    }
    if (!read) for (const k of Array.isArray(sl.keys) ? sl.keys : []) add(k, sl.screen);
  }
  for (const c of doc && Array.isArray(doc._conflicts) ? doc._conflicts : []) {
    for (const vr of c && "variants" in c && c.variants || []) for (const sc of vr.screens || []) add(vr.key, sc);
  }
  if (!out.size && docPath && /\.vars\.json$/.test(docPath)) {
    for (const v of doc && doc.variables || []) add(v.key, path2.basename(docPath, ".vars.json"));
  }
  return out;
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
function formatHex(c) {
  const to = (x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, "0");
  const a = Math.round(c.a * 255);
  return "#" + to(c.r) + to(c.g) + to(c.b) + (a < 255 ? to(a) : "");
}
function clampOpacityPct(n) {
  return Math.min(100, Math.max(0, n));
}
function composeAlpha(alpha, opacityPct) {
  return alpha * (clampOpacityPct(opacityPct) / 100);
}

// design-to-code/tokens-native.ts
var FULL = Object.freeze({ fullyRounded: true });
function nativeEmitter({ segs: segs2, isAlias: isAlias2, defaultModeName: defaultModeName2, baseValue: baseValue2, unitDecision: unitDecision2, isSentinel: isSentinel2, percentOpacity: percentOpacity2 }) {
  const PLATFORMS2 = {
    swiftui: { file: "DesignTokens.swift" },
    compose: { file: "DesignTokens.kt" },
    flutter: { file: "design_tokens.dart" },
    "react-native": { file: "designTokens.ts" }
  };
  const PROFILE_ALIASES = { "android-compose": "compose", ios: "swiftui", swift: "swiftui", android: "compose", rn: "react-native", dart: "flutter" };
  const RESERVED = new Set("default,class,object,in,is,as,do,if,else,for,while,return,var,val,let,func,fun,import,package,switch,case,break,continue,true,false,null,nil,self,super,this,new,static,final,const,enum,struct,extension,protocol,init,internal,public,private,open,operator,typealias,interface,when,try,catch,throw,void,with,get,set,dynamic,external,factory,mixin,part,required,show,hide,on,type,function,delete,export,yield,await,async,inout,repeat,guard,defer,where,any,some,lerp,copyWith,hashCode,toString,description".split(","));
  const words = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean);
  function camel(parts) {
    const w = parts.flatMap(words);
    let id = w.map((x, i) => i === 0 ? x.charAt(0).toLowerCase() + x.slice(1) : x.charAt(0).toUpperCase() + x.slice(1)).join("");
    if (!id) id = "token";
    if (/^[0-9]/.test(id)) id = "n" + id;
    if (RESERVED.has(id)) id += "Token";
    return id;
  }
  const pascal = (parts) => {
    const c = camel(parts);
    return c.charAt(0).toUpperCase() + c.slice(1);
  };
  function isFontSize(v) {
    const scopes = v.scopes || [];
    if (scopes.length && !scopes.every((s) => s === "ALL_SCOPES")) return scopes.includes("FONT_SIZE");
    return /font.?size|text.?size|type.?size/i.test((v.collection ?? "") + "/" + v.name);
  }
  function kindOf(v, opts) {
    if (v.type === "COLOR") return "color";
    if (v.type === "BOOLEAN") return "bool";
    if (v.type === "STRING") return "string";
    if (v.type === "FLOAT") return unitDecision2(v, opts) === "px" ? isFontSize(v) ? "fontSize" : "dimension" : "number";
    return null;
  }
  const isComposed2 = (x) => !!x && typeof x === "object" && "composed" in x;
  const isNativeScalar = (x) => typeof x === "string" || typeof x === "number" || typeof x === "boolean";
  function resolve(byName, collections, v, mode, seen) {
    const values = v.values || {};
    let raw = values[mode];
    if (raw === void 0) raw = baseValue2(v, collections, defaultModeName2(v, collections));
    const next = new Set(seen || []).add(v.name);
    const follow = (a) => {
      const target = byName.get(a.aliasOf);
      if (!target || seen && seen.has(target.name)) return void 0;
      const tMode = target.values && target.values[mode] !== void 0 ? mode : defaultModeName2(target, collections);
      if (tMode === void 0) return void 0;
      return resolve(byName, collections, target, tMode, next);
    };
    if (raw && typeof raw === "object" && "composed" in raw) {
      const { color, opacity } = raw.composed;
      const c = typeof color === "string" ? color : isAlias2(color) ? follow(color) : void 0;
      const o = typeof opacity === "number" ? opacity : isAlias2(opacity) ? follow(opacity) : void 0;
      const rgba = parseHex(c);
      if (!rgba || typeof o !== "number" || !Number.isFinite(o)) return void 0;
      return formatHex({ ...rgba, a: composeAlpha(rgba.a, o) });
    }
    if (!isAlias2(raw)) return isNativeScalar(raw) ? raw : void 0;
    return follow(raw);
  }
  const NUMERIC_TEXT2 = /^-?\d+(?:\.\d+)?$/;
  function opacityNumber(r) {
    const n = typeof r === "number" ? r : typeof r === "string" && NUMERIC_TEXT2.test(r) ? Number(r) : NaN;
    return Number.isFinite(n) ? n : null;
  }
  function model(designSystem, warnings, opts) {
    const collections = designSystem && designSystem.collections || [];
    const vars = designSystem && designSystem.variables || [];
    const byName = new Map(vars.map((v) => [v.name, v]));
    const typeNames = /* @__PURE__ */ new Set();
    const out = [];
    for (const c of collections) {
      const mine = vars.filter((v) => v.collection === c.name);
      const modeNames = (c.modes && c.modes.length ? c.modes : [...new Set(mine.flatMap((v) => Object.keys(v.values || {})))]).map(String);
      const [firstModeName, ...otherModeNames] = modeNames;
      if (!mine.length || firstModeName === void 0) continue;
      let type = `${pascal([c.name])}Tokens`;
      for (let n = 2; typeNames.has(type); n++) type = `${pascal([c.name])}Tokens${n}`;
      typeNames.add(type);
      const ids = /* @__PURE__ */ new Set();
      const fields = [];
      const cands = [];
      for (const v of mine) {
        const kind = kindOf(v, opts);
        if (!segs2(v.name).length) continue;
        if (!kind) {
          warnings.push(`${v.name}: skipped \u2014 a ${v.type} variable has no native token form (only COLOR, FLOAT, STRING and BOOLEAN are emitted)`);
          continue;
        }
        const pct = kind === "number" && percentOpacity2(v, opts);
        const values = {};
        let ok = true;
        for (const m of modeNames) {
          const r = resolve(byName, collections, v, m);
          if (r === void 0 || kind === "color" && !normHex(r)) {
            ok = false;
            break;
          }
          if (pct) {
            const n = opacityNumber(r);
            if (n === null) {
              ok = false;
              break;
            }
            const clamped = clampOpacityPct(n);
            if (clamped !== n) warnings.push(`${v.name} (mode ${m}): opacity ${n} is outside Figma's 0\u2013100 range; clamped to ${clamped} (as Figma does) and written as ${clamped / 100}`);
            values[m] = clamped / 100;
            continue;
          }
          values[m] = isSentinel2 && isSentinel2(v, r) ? FULL : r;
        }
        if (!ok && Object.values(v.values || {}).some(isComposed2)) {
          warnings.push(`${v.name}: skipped \u2014 a composed colour (colour + separate opacity) whose colour or opacity could not be resolved inside this file has no native literal; tokens.dtcg.json carries it (colour reference in $value, opacity in $extensions["figma.com"].opacity)`);
          continue;
        }
        if (!ok) {
          warnings.push(`${v.name}: skipped \u2014 its value could not be resolved inside this file (an alias to a library variable that was not exported?)`);
          continue;
        }
        cands.push({ v, kind, values, id: camel(segs2(v.name)) });
      }
      const tag = (v) => v.key ? String(v.key).slice(0, 8).toLowerCase() : null;
      const label = (x) => `${x.v.name}${x.v.key ? ` (key ${tag(x.v)}\u2026)` : ""} = ${JSON.stringify(x.v.values || {})}`;
      const byId = /* @__PURE__ */ new Map();
      for (const x of cands) {
        const list = byId.get(x.id);
        if (list) list.push(x);
        else byId.set(x.id, [x]);
      }
      for (const [id, list] of byId) {
        const distinct = [list[0]];
        for (const x of list.slice(1)) if (!distinct.some((d) => JSON.stringify(d.values) === JSON.stringify(x.values))) distinct.push(x);
        if (list.length > distinct.length) warnings.push(`${list.map(label).join(" and ")}: identical in every mode, so "${id}" in ${type} is emitted once`);
        if (distinct.length === 1) {
          distinct[0].final = id;
          continue;
        }
        const sameName = distinct.every((x) => x.v.name === distinct[0].v.name);
        const lossless = distinct.filter((x) => /^[A-Za-z0-9 /_-]+$/.test(String(x.v.name)));
        const keeper = sameName ? null : lossless.length === 1 ? lossless[0] : distinct[0];
        const names = [];
        distinct.forEach((x, i) => {
          if (x === keeper) {
            x.final = id;
            ids.add(id);
            names.push(`${label(x)} \u2192 "${id}"`);
            return;
          }
          let next = tag(x.v) ? `${id}_${tag(x.v)}` : `${id}${i + 1}`;
          for (let n = 2; ids.has(next) || byId.has(next); n++) next = (tag(x.v) ? `${id}_${tag(x.v)}` : id) + n;
          ids.add(next);
          x.final = next;
          names.push(`${label(x)} \u2192 "${next}"`);
        });
        warnings.push(`${distinct.length} different variables fold onto "${id}" in ${type} and DIFFER \u2014 none is dropped: ${names.join("; ")}`);
      }
      for (const x of cands) {
        if (!x.final) continue;
        if (ids.has(x.final) && fields.some((f) => f.id === x.final)) continue;
        ids.add(x.final);
        fields.push({ id: x.final, kind: x.kind, source: x.v.name, values: x.values });
      }
      if (!fields.length) continue;
      const units = fields.reduce((n, f) => n + (f.kind === "color" || f.kind === "fontSize" ? 2 : 1), 0) + Math.ceil(fields.length / 32) + 2;
      if (modeNames.length > 1 && units > 255) warnings.push(`${c.name}: ${fields.length} tokens in one multi-mode collection need ${units} JVM parameter units (Color and TextUnit count double) \u2014 over the 255 limit, so the Compose data class will not compile; split the collection in Figma`);
      const modeIds = /* @__PURE__ */ new Set();
      const modeOf = (name) => {
        let id = camel([name]);
        if (ids.has(id)) id += "Mode";
        for (let n = 2, base = id; modeIds.has(id); n++) id = base + n;
        modeIds.add(id);
        return { name, id };
      };
      const modes = [modeOf(firstModeName), ...otherModeNames.map(modeOf)];
      const defMode = modes.find((m) => m.name === String(c.default)) ?? modes[0];
      out.push({ name: c.name, type, modes, default: defMode.name, defaultId: defMode.id, fields });
    }
    return out;
  }
  const num = (raw) => {
    const n = Number(raw);
    return Number.isFinite(n) ? String(Math.round(n * 1e4) / 1e4) : "0";
  };
  const str = (raw) => JSON.stringify(String(raw));
  const bool = (raw) => String(raw === true || raw === "true");
  const hexOf = (raw) => {
    const h = normHex(raw);
    if (h === null) throw new Error(`tokens-native: colour value ${JSON.stringify(raw)} was not validated`);
    return h;
  };
  const argb = (raw) => {
    const h = hexOf(raw);
    return "0x" + (h.length === 9 ? h.slice(7) + h.slice(1, 7) : "ff" + h.slice(1)).toUpperCase();
  };
  const valueIn = (f, mode) => {
    const r = f.values[mode];
    if (r === void 0) throw new Error(`tokens-native: field ${f.id} has no value for mode ${JSON.stringify(mode)}`);
    return r;
  };
  const HEADER = "GENERATED by Design Twin (tokens.js --native) from design-system/tokens.json \u2014 do not edit by hand; re-run after a token pull.";
  function compose(cols, opts) {
    const T = { color: "Color", dimension: "Dp", fontSize: "TextUnit", number: "Float", bool: "Boolean", string: "String" };
    const lit = (k, r) => r === FULL ? k === "fontSize" ? "9999.sp" : k === "number" ? "9999f" : "9999.dp /* Figma 'fully rounded' \u2014 use CircleShape */" : k === "color" ? `Color(${argb(r)})` : k === "dimension" ? `${num(r)}.dp` : k === "fontSize" ? `${num(r)}.sp` : k === "number" ? `${num(r)}f` : k === "bool" ? bool(r) : str(r).replace(/\$/g, "\\$");
    const L = [
      `// ${HEADER}`,
      `package ${opts && opts.package || "design.tokens"}`,
      "",
      "import androidx.compose.runtime.Immutable",
      "import androidx.compose.runtime.staticCompositionLocalOf",
      "import androidx.compose.ui.graphics.Color",
      "import androidx.compose.ui.unit.Dp",
      "import androidx.compose.ui.unit.TextUnit",
      "import androidx.compose.ui.unit.dp",
      "import androidx.compose.ui.unit.sp"
    ];
    for (const c of cols) {
      L.push("", `// Figma collection "${c.name}"`);
      const [m0, m1] = c.modes;
      if (m1 === void 0) {
        L.push(`object ${c.type} {`, ...c.fields.map((f) => `    val ${f.id}: ${T[f.kind]} = ${lit(f.kind, valueIn(f, m0.name))} // ${f.source}`), "}");
        continue;
      }
      L.push("@Immutable", `data class ${c.type}(`, ...c.fields.map((f) => `    val ${f.id}: ${T[f.kind]}, // ${f.source}`), ")");
      for (const m of c.modes) L.push("", `val ${c.type}${pascal([m.id])} = ${c.type}(`, ...c.fields.map((f) => `    ${f.id} = ${lit(f.kind, valueIn(f, m.name))},`), ")");
      const active = c.modes.find((m) => m.name !== c.default) ?? m1;
      L.push(
        "",
        `// Provide the active mode once, near the root: CompositionLocalProvider(Local${c.type} provides ${c.type}${pascal([active.id])}) { \u2026 }`,
        `val Local${c.type} = staticCompositionLocalOf { ${c.type}${pascal([c.defaultId])} }`
      );
    }
    return L.join("\n") + "\n";
  }
  function swiftModeHint(c) {
    const ids = c.modes.map((m) => m.id);
    if (ids.includes("light") && ids.includes("dark")) return "colorScheme == .dark ? .dark : .light" + (ids.length > 2 ? ` /* also: ${ids.filter((i) => i !== "light" && i !== "dark").map((i) => "." + i).join(", ")} */` : "");
    return `.${(c.modes.find((m) => m.name !== c.default) || c.modes[0]).id} /* one of: ${ids.map((i) => "." + i).join(", ")} \u2014 the app picks */`;
  }
  function swiftui(cols) {
    const T = { color: "Color", dimension: "CGFloat", fontSize: "CGFloat", number: "Double", bool: "Bool", string: "String" };
    const chan = (h, i) => num(parseInt(h.slice(i, i + 2), 16) / 255);
    const lit = (k, r) => {
      if (r === FULL) return ".infinity";
      if (k === "color") {
        const h = hexOf(r);
        return `Color(.sRGB, red: ${chan(h, 1)}, green: ${chan(h, 3)}, blue: ${chan(h, 5)}, opacity: ${h.length === 9 ? chan(h, 7) : "1"})`;
      }
      return k === "bool" ? bool(r) : k === "string" ? str(r).replace(/\\u([0-9a-fA-F]{4})/g, "\\u{$1}") : num(r);
    };
    const L = [`// ${HEADER}`, "import SwiftUI"];
    for (const c of cols) {
      L.push("", `// Figma collection "${c.name}"`);
      if (c.modes.length === 1) {
        L.push(`public enum ${c.type} {`, ...c.fields.map((f) => `    public static let ${f.id}: ${T[f.kind]} = ${lit(f.kind, valueIn(f, c.modes[0].name))} // ${f.source}`), "}");
        continue;
      }
      L.push(
        `public struct ${c.type}: Sendable, Equatable {`,
        ...c.fields.map((f) => `    public let ${f.id}: ${T[f.kind]} // ${f.source}`),
        "",
        `    public init(${c.fields.map((f) => `${f.id}: ${T[f.kind]}`).join(", ")}) {`,
        ...c.fields.map((f) => `        self.${f.id} = ${f.id}`),
        "    }"
      );
      for (const m of c.modes) L.push("", `    public static let ${m.id} = ${c.type}(`, c.fields.map((f) => `        ${f.id}: ${lit(f.kind, valueIn(f, m.name))}`).join(",\n"), "    )");
      const env = c.type.charAt(0).toLowerCase() + c.type.slice(1);
      const defId = c.defaultId;
      L.push(
        "}",
        "",
        `private struct ${c.type}Key: EnvironmentKey { static let defaultValue = ${c.type}.${defId} }`,
        "public extension EnvironmentValues {",
        `    // Set once near the root: .environment(\\.${env}, ${swiftModeHint(c)}); read with @Environment(\\.${env}).`,
        `    var ${env}: ${c.type} {`,
        `        get { self[${c.type}Key.self] }`,
        `        set { self[${c.type}Key.self] = newValue }`,
        "    }",
        "}"
      );
    }
    return L.join("\n") + "\n";
  }
  function flutter(cols) {
    const T = { color: "Color", dimension: "double", fontSize: "double", number: "double", bool: "bool", string: "String" };
    const lit = (k, r) => r === FULL ? "double.infinity" : k === "color" ? `Color(${argb(r)})` : k === "bool" ? bool(r) : k === "string" ? str(r).replace(/\$/g, "\\$") : num(r);
    const lerp = (f) => f.kind === "color" ? `Color.lerp(${f.id}, other.${f.id}, t)!` : T[f.kind] === "double" ? `lerpDouble(${f.id}, other.${f.id}, t)!` : `t < 0.5 ? ${f.id} : other.${f.id}`;
    const L = [`// ${HEADER}`, "// ignore_for_file: constant_identifier_names", "import 'dart:ui' show lerpDouble;", "", "import 'package:flutter/material.dart';"];
    for (const c of cols) {
      L.push("", `/// Figma collection "${c.name}"`);
      if (c.modes.length === 1) {
        L.push(`abstract final class ${c.type} {`, ...c.fields.map((f) => `  static const ${T[f.kind]} ${f.id} = ${lit(f.kind, valueIn(f, c.modes[0].name))}; // ${f.source}`), "}");
        continue;
      }
      L.push(
        `/// Register per theme: ThemeData(extensions: [${c.type}.${c.modes[0].id}]); read: Theme.of(context).extension<${c.type}>()!`,
        "@immutable",
        `class ${c.type} extends ThemeExtension<${c.type}> {`,
        `  const ${c.type}({`,
        ...c.fields.map((f) => `    required this.${f.id},`),
        "  });",
        "",
        ...c.fields.map((f) => `  final ${T[f.kind]} ${f.id}; // ${f.source}`)
      );
      for (const m of c.modes) L.push("", `  static const ${m.id} = ${c.type}(`, ...c.fields.map((f) => `    ${f.id}: ${lit(f.kind, valueIn(f, m.name))},`), "  );");
      L.push(
        "",
        "  @override",
        `  ${c.type} copyWith({`,
        ...c.fields.map((f) => `    ${T[f.kind]}? ${f.id},`),
        "  }) {",
        `    return ${c.type}(`,
        ...c.fields.map((f) => `      ${f.id}: ${f.id} ?? this.${f.id},`),
        "    );",
        "  }",
        "",
        "  @override",
        `  ${c.type} lerp(ThemeExtension<${c.type}>? other, double t) {`,
        `    if (other is! ${c.type}) return this;`,
        `    return ${c.type}(`,
        ...c.fields.map((f) => `      ${f.id}: ${lerp(f)},`),
        "    );",
        "  }",
        "}"
      );
    }
    return L.join("\n") + "\n";
  }
  function reactNative(cols) {
    const T = { color: "string", dimension: "number", fontSize: "number", number: "number", bool: "boolean", string: "string" };
    const lit = (k, r) => r === FULL ? "9999" : k === "color" ? str(hexOf(r)) : k === "bool" ? bool(r) : k === "string" ? str(r) : num(r);
    const L = [`// ${HEADER}`, "// Numbers are density-independent units, as React Native styles expect. Pick a mode with useColorScheme()."];
    for (const c of cols) {
      const v = c.type.charAt(0).toLowerCase() + c.type.slice(1);
      L.push("", `/** Figma collection "${c.name}" */`);
      if (c.modes.length === 1) {
        L.push(`export const ${v} = {`, ...c.fields.map((f) => `  ${f.id}: ${lit(f.kind, valueIn(f, c.modes[0].name))}, // ${f.source}`), "} as const;");
        continue;
      }
      L.push(
        `export interface ${c.type} {`,
        ...c.fields.map((f) => `  ${f.id}: ${T[f.kind]}; // ${f.source}`),
        "}",
        "",
        `export type ${c.type}Mode = ${c.modes.map((m) => str(m.id)).join(" | ")};`,
        `export const ${v}DefaultMode: ${c.type}Mode = ${str(c.defaultId)};`,
        "",
        `export const ${v}: Record<${c.type}Mode, ${c.type}> = {`
      );
      for (const m of c.modes) L.push(`  ${m.id}: {`, ...c.fields.map((f) => `    ${f.id}: ${lit(f.kind, valueIn(f, m.name))},`), "  },");
      L.push("};");
    }
    return L.join("\n") + "\n";
  }
  const EMIT = { compose, swiftui, flutter, "react-native": reactNative };
  function platformOf2(name) {
    const key = String(name || "").toLowerCase();
    const p = PROFILE_ALIASES[key] || key;
    return PLATFORMS2[p] ? p : null;
  }
  function toNative2(designSystem, platform, opts) {
    const p = platformOf2(platform);
    if (!p) throw new Error(`unknown native platform "${String(platform)}" \u2014 use one of: ${Object.keys(PLATFORMS2).join(", ")}`);
    const warnings = [];
    const cols = model(designSystem, warnings, opts);
    const target = PLATFORMS2[p], emit = EMIT[p];
    if (target === void 0 || emit === void 0) throw new Error(`tokens-native: platform "${p}" has no emitter`);
    return { file: target.file, text: emit(cols, opts), warnings };
  }
  return { toNative: toNative2, platformOf: platformOf2, PLATFORMS: PLATFORMS2 };
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

// design-to-code/map-util.ts
function getOrInit(m, k, init) {
  const have = m.get(k);
  if (have !== void 0) return have;
  const made = init();
  m.set(k, made);
  return made;
}

// bridge/src/project-layout.ts
import path3 from "node:path";
var DESIGN_DIR = "design";
var EXPORT_SUBDIR = "export";
var EXPORT_DIR = path3.join(DESIGN_DIR, EXPORT_SUBDIR);
var TARGET_FILE = path3.join(DESIGN_DIR, "target.json");
var MAP_FILE = path3.join(DESIGN_DIR, "codeconnect.local.json");
var PLAN_DIR = path3.join(DESIGN_DIR, "plan");
var AUDIT_DIR = path3.join(DESIGN_DIR, "audit");
var VERIFY_DIR = path3.join(DESIGN_DIR, "verify");
var TAILWIND_SOURCE_NOT_NOTE = `Tailwind v4 scans every file git does not ignore, ${DESIGN_DIR}/ included, so class names quoted in ${DESIGN_DIR}/ notes, audits and plans end up in your CSS. Next to \`@import "tailwindcss";\` in your CSS entry, add \`@source not "<path from that CSS file to ${DESIGN_DIR}/>";\` (e.g. \`@source not "../${DESIGN_DIR}";\` for src/app.css) \u2014 Tailwind v4.1+`;

// design-to-code/tokens.ts
var isLeaf = (n) => n !== void 0 && n.$value !== void 0;
var round = (x) => Math.round(x * 1e4) / 1e4;
var segsCache = /* @__PURE__ */ new Map();
function segs(name) {
  const key = String(name || "");
  let v = segsCache.get(key);
  if (v === void 0) {
    v = key.split("/").map((s) => s.trim().replace(/[.{}$]/g, "").replace(/\s+/g, "-")).filter(Boolean);
    segsCache.set(key, v);
  }
  return v;
}
var dtcgRef = (tokenName) => "{" + segs(tokenName).join(".") + "}";
var varNameCache = /* @__PURE__ */ new Map();
var cssVarName = (tokenName) => {
  const key = String(tokenName || "");
  let v = varNameCache.get(key);
  if (v === void 0) varNameCache.set(key, v = "--" + segs(key).join("-").replace(/[^A-Za-z0-9-]/g, "-"));
  return v;
};
var KEY_SUFFIX_LEN = 8;
function identityOf(v) {
  if (v && typeof v.key === "string" && v.key) return "k:" + v.key;
  return "n:" + String(v && v.collection || "") + "\0" + String(v && v.name || "");
}
var shortKey = (v) => v && typeof v.key === "string" && v.key ? v.key.slice(0, KEY_SUFFIX_LEN).toLowerCase() : null;
var suffixSlug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
function equivalentVars(a, b, collections) {
  if (a.type !== b.type) return false;
  const ba = JSON.stringify(baseValue(a, collections)), bb = JSON.stringify(baseValue(b, collections));
  if (ba !== bb) return false;
  const at = (v, base, m) => {
    const x = (v.values || {})[m];
    return x === void 0 ? base : JSON.stringify(x);
  };
  for (const m of /* @__PURE__ */ new Set([...Object.keys(a.values || {}), ...Object.keys(b.values || {})])) if (at(a, ba, m) !== at(b, bb, m)) return false;
  return true;
}
function planIds(vars, idOf, suffix, collections, output, exact) {
  const groups = /* @__PURE__ */ new Map();
  for (const v of vars) {
    const id = idOf(v);
    if (id == null) continue;
    getOrInit(groups, id, () => []).push(v);
  }
  const ids = /* @__PURE__ */ new Map(), canonical = /* @__PURE__ */ new Map(), notes = [];
  const taken = new Set(groups.keys());
  for (const [id, list] of groups) {
    const byIdent = /* @__PURE__ */ new Map();
    for (const v of list) byIdent.set(identityOf(v), v);
    const members = [...byIdent.values()];
    const clusters = [];
    for (const v of members) {
      const c = clusters.find((cl) => equivalentVars(cl[0], v, collections));
      if (c) c.push(v);
      else clusters.push([v]);
    }
    const onlyCluster = clusters.length === 1 ? clusters[0] : void 0;
    if (onlyCluster) {
      for (const v of list) ids.set(v, id);
      canonical.set(onlyCluster[0], id);
      if (members.length > 1) notes.push({ output, id, differ: false, members: members.map((v) => ({ v, id })) });
      continue;
    }
    const assigned = /* @__PURE__ */ new Map(), memberIds = [];
    const exactOnes = exact ? members.filter((v) => exact(v)) : [];
    const exactOne = exactOnes.length === 1 ? exactOnes[0] : void 0;
    const keeper = exactOne && members.filter((v) => v.name === exactOne.name).length === 1 ? exactOne : null;
    for (const v of members) {
      if (v === keeper) {
        assigned.set(identityOf(v), id);
        canonical.set(v, id);
        memberIds.push({ v, id });
        continue;
      }
      const s = shortKey(v) || suffixSlug(v.collection) || "alt";
      let nid = suffix(id, s);
      for (let n = 2; taken.has(nid); n++) nid = suffix(id, s + "-" + n);
      taken.add(nid);
      assigned.set(identityOf(v), nid);
      canonical.set(v, nid);
      memberIds.push({ v, id: nid });
    }
    for (const v of list) {
      const got = assigned.get(identityOf(v));
      if (got !== void 0) ids.set(v, got);
    }
    notes.push({ output, id, differ: true, members: memberIds });
  }
  const byName = /* @__PURE__ */ new Map();
  for (const v of vars) {
    getOrInit(byName, v.name, () => []).push(v);
  }
  return { id: (v) => ids.get(v), canonical, notes, byName };
}
function aliasTargetId(plan, name, referrer, warn) {
  const cands = [];
  for (const c of plan.byName.get(name) || []) {
    const id = plan.id(c);
    if (id != null) cands.push({ v: c, id });
  }
  const firstCand = cands[0];
  if (firstCand === void 0) return null;
  if (new Set(cands.map((c) => c.id)).size === 1) return firstCand;
  const sameColl = cands.filter((c) => referrer && c.v.collection === referrer.collection);
  const pool = (sameColl.length && new Set(sameColl.map((c) => c.id)).size === 1 ? sameColl : cands).slice().sort((a, b) => String(a.v.key || "").localeCompare(String(b.v.key || "")));
  const pick = pool[0] ?? firstCand;
  if (warn) {
    warn(`alias '${referrer ? referrer.name : "?"}' -> '${name}' is AMBIGUOUS: the export names an alias target by name, and ${cands.length} different variables are called '${name}' (${cands.map(({ v: c }) => (shortKey(c) ? "key " + shortKey(c) + "\u2026" : "'" + (c.collection ?? "") + "'") + " " + JSON.stringify(c.values)).join(", ")}) \u2014 pointed at ${pick.id}; confirm in Figma which one it really aliases`);
  }
  return pick;
}
function aliasTarget(plan, name, referrer, warn) {
  const t = aliasTargetId(plan, name, referrer, warn);
  return t ? t.v : null;
}
function collisionMessages(notes, opts) {
  const sources = opts && opts.sources || null;
  const bySet = /* @__PURE__ */ new Map();
  for (const n of notes) {
    const k = (n.differ ? "D" : "S") + n.members.map((m) => identityOf(m.v)).sort().join("|");
    const group = bySet.get(k);
    if (group) group.push(n);
    else bySet.set(k, [n]);
  }
  const out = [];
  for (const group of bySet.values()) {
    const first = group[0];
    const members = first.members.map((m) => m.v);
    const names = [...new Set(members.map((v) => v.name))];
    const who = (v) => {
      const k = shortKey(v);
      const where2 = k && sources ? sources.get(String(v.key)) : null;
      return (k ? `key ${k}\u2026` : `'${v.collection || ""}'`) + ` = ${JSON.stringify(v.values || {})}` + (where2 && where2.length ? ` (from ${where2.join(", ")})` : "");
    };
    const m0 = members[0];
    const oneColl = m0 !== void 0 && members.every((v) => v.collection === m0.collection) && m0.collection;
    const subject = names.length === 1 ? `${members.length} different Figma variables share the name '${names[0]}'${oneColl ? ` (collection '${oneColl}')` : ""}` : `${members.length} different Figma variables (${names.map((n) => `'${n}'`).join(", ")}) fold onto one identifier`;
    const where = group.map((n) => `${n.output} ${n.members.map((m) => m.id).join(" / ")}`).join("; ");
    if (first.differ) {
      out.push(`${subject} and resolve DIFFERENTLY \u2014 none is dropped, each keeps its own name: ${members.map(who).join(" vs ")}. Emitted as: ${where}. ` + (names.length === 1 ? `Pick by key, never by name. A screen's own .vars.json usually carries only one of them under the plain name \u2014 generate that screen's theme from it (or from design-system/tokens.json), not from the merged variables.json.` : `The name spelled exactly as the identifier keeps it; a name that only reached it by folding punctuation carries its key.`));
    } else {
      out.push(`${subject} but resolve identically in every mode \u2014 emitted ONCE: ${members.map(who).join(" and ")} \u2192 ${where}.`);
    }
  }
  return out;
}
var SENTINEL_MIN = 1e4;
var WEB_FULL_ROUND = 9999;
function isRadiusVar(v) {
  const scopes = v.scopes || [];
  const narrowed = scopes.length && !scopes.every((s) => s === "ALL_SCOPES");
  if (narrowed) return scopes.includes("CORNER_RADIUS");
  return /radius|corner|round/i.test(String(v.collection || "") + "/" + v.name);
}
function isSentinel(v, raw) {
  if (!v || v.type !== "FLOAT" || isAlias(raw)) return false;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) && Math.abs(n) >= SENTINEL_MIN && isRadiusVar(v);
}
var webNumber = (v, raw) => isSentinel(v, raw) ? WEB_FULL_ROUND : raw;
var isHexish = (v) => typeof v === "string" && /^#/.test(v);
var isScalar = (v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";
var isAlias = (v) => !!v && typeof v === "object" && "aliasOf" in v && typeof v.aliasOf === "string";
var isComposed = (v) => {
  if (!v || typeof v !== "object" || !("composed" in v)) return false;
  const c = v.composed;
  if (!c || typeof c !== "object" || !("color" in c) || !("opacity" in c)) return false;
  const colorOk = typeof c.color === "string" || isAlias(c.color);
  const opacityOk = typeof c.opacity === "number" || isAlias(c.opacity);
  return colorOk && opacityOk && (isAlias(c.color) || isAlias(c.opacity));
};
function aliasNames(v) {
  if (isAlias(v)) return [v.aliasOf];
  if (!isComposed(v)) return [];
  const out = [];
  if (isAlias(v.composed.color)) out.push(v.composed.color.aliasOf);
  if (isAlias(v.composed.opacity)) out.push(v.composed.opacity.aliasOf);
  return out;
}
var CSS_UNSAFE = /[\\\n\r\f;{}]/g;
var hexEsc = (c) => "\\" + (c.codePointAt(0) ?? 0).toString(16) + " ";
function cssUnbalanced(s) {
  let depth = 0, dq = 0, sq = 0;
  for (const ch of String(s)) {
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth < 0) return true;
    } else if (ch === '"') dq++;
    else if (ch === "'") sq++;
  }
  return depth !== 0 || dq % 2 !== 0 || sq % 2 !== 0;
}
var cssNeedsEscape = (s) => typeof s === "string" && cssEscapeText(s) !== s;
var CSS_ATTR_UNSAFE = /["\\]/g;
var cssAttrEscape = (s) => String(s).replace(CSS_ATTR_UNSAFE, hexEsc);
var cssAttrNeedsEscape = (s) => cssAttrEscape(s) !== String(s);
function cssEscapeText(s) {
  const raw = String(s);
  let out = raw.replace(CSS_UNSAFE, hexEsc);
  out = out.replace(/\/\*/g, "/" + hexEsc("*")).replace(/\*\//g, hexEsc("*") + "/");
  if (cssUnbalanced(raw)) out = out.replace(/[()"']/g, hexEsc);
  return out;
}
var isP3 = (colorProfile) => colorProfile === "display_p3" || colorProfile === "display-p3";
function hexToColorValue(hex, colorProfile) {
  const e = normHex(hex);
  if (!e) return null;
  const n = (i) => parseInt(e.slice(i, i + 2), 16) / 255;
  const value = { colorSpace: isP3(colorProfile) ? "display-p3" : "srgb", components: [round(n(1)), round(n(3)), round(n(5))] };
  if (e.length === 9) value.alpha = round(n(7));
  value.hex = e.slice(0, 7);
  return value;
}
var DTCG_TYPE = { COLOR: "color", FLOAT: "number", STRING: "string" };
var EMITTED_TYPES = /* @__PURE__ */ new Set(["COLOR", "FLOAT", "STRING", "BOOLEAN"]);
var emitted = (v) => EMITTED_TYPES.has(v.type);
function defaultModeName(variable, collections) {
  const c = (collections || []).find((x) => x.name === variable.collection);
  const modes = variable.values ? Object.keys(variable.values) : [];
  if (c && c.default && modes.includes(c.default)) return c.default;
  return modes[0];
}
function baseValue(variable, collections, def) {
  const values = variable.values || {};
  if (def === void 0) def = defaultModeName(variable, collections);
  if (def !== void 0 && values[def] !== void 0) return values[def];
  const firstDefined = Object.keys(values).find((m) => values[m] !== void 0);
  return firstDefined !== void 0 ? values[firstDefined] : void 0;
}
function dtcgValue(raw, colorProfile, dimension, ref) {
  if (isAlias(raw)) return ref ? ref(raw.aliasOf) : dtcgRef(raw.aliasOf);
  if (isComposed(raw)) {
    const { color } = raw.composed;
    return isAlias(color) ? ref ? ref(color.aliasOf) : dtcgRef(color.aliasOf) : hexToColorValue(color, colorProfile);
  }
  if (!isScalar(raw)) return null;
  if (dimension) {
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(n) ? { value: n, unit: "px" } : raw;
  }
  const c = isHexish(raw) ? hexToColorValue(raw, colorProfile) : null;
  return c || raw;
}
function dtcgOpacity(raw, ref) {
  if (!isComposed(raw)) return void 0;
  const { opacity } = raw.composed;
  return isAlias(opacity) ? ref ? ref(opacity.aliasOf) : dtcgRef(opacity.aliasOf) : opacity;
}
var SKIP = /* @__PURE__ */ Symbol("resolver-set omits this token");
var DTCG_SEP = "\0";
function dtcgPlan(designSystem) {
  const ds = designSystem || {};
  return planIds(
    ds.variables || [],
    (v) => {
      const p = segs(v.name);
      return p.length ? p.join(DTCG_SEP) : null;
    },
    (id, s) => id + "-" + s,
    ds.collections,
    "tokens.dtcg.json",
    (v) => !/[.{}$]/.test(String(v.name))
  );
}
function buildTree(designSystem, warn, opts, pick, withExtensions, plan) {
  const root = {};
  const ds = designSystem || {};
  const { colorProfile } = ds;
  plan = plan || dtcgPlan(designSystem);
  const ref = (referrer) => (name) => {
    const t = aliasTargetId(plan, name, referrer, warn);
    return t ? "{" + t.id.split(DTCG_SEP).join(".") + "}" : dtcgRef(name);
  };
  for (const v of designSystem && designSystem.variables || []) {
    if (!segs(v.name).length) {
      warn(`variable with empty/degenerate name skipped: '${v.name}'`);
      continue;
    }
    if (!emitted(v)) {
      warn(`token '${v.name}' is a ${v.type} variable \u2014 its values are not colours, numbers or strings, so no DTCG token is emitted for it (skipped)`);
      continue;
    }
    const planned = plan.canonical.get(v);
    if (planned === void 0) continue;
    const path5 = planned.split(DTCG_SEP);
    if (path5.some((s) => s === "__proto__" || s === "constructor" || s === "prototype")) {
      warn(`token '${v.name}' uses a reserved key (__proto__/constructor/prototype) \u2014 skipped`);
      continue;
    }
    const bv = pick(v);
    if (bv === SKIP) continue;
    if (bv === void 0) {
      warn(`token '${v.name}' has no value in any mode \u2014 skipped`);
      continue;
    }
    let node = root, collided = false;
    for (const [i, seg] of path5.slice(0, -1).entries()) {
      let child = node[seg];
      if (child === void 0) child = node[seg] = {};
      else if (isLeaf(child)) {
        warn(`token '${v.name}' collides with token '${path5.slice(0, i + 1).join("/")}' (a name is used as both a value and a group) \u2014 skipped`);
        collided = true;
        break;
      }
      node = child;
    }
    if (collided) continue;
    const leafKey = path5[path5.length - 1] ?? "";
    const existing = node[leafKey];
    if (existing !== void 0 && !isLeaf(existing)) {
      warn(`token '${v.name}' collides with a group of the same name \u2014 skipped`);
      continue;
    }
    if (existing !== void 0) {
      warn(`token '${v.name}' lands on '${path5.join("/")}', which another token already holds \u2014 skipped, nothing overwritten`);
      continue;
    }
    let type = DTCG_TYPE[v.type];
    if (v.type === "COLOR" && isHexish(bv) && !normHex(bv)) warn(`token '${v.name}' has malformed hex '${bv}'`);
    const dimension = v.type === "FLOAT" && unitDecision(v, opts) === "px";
    if (dimension) type = "dimension";
    if (isComposed(bv) && v.type !== "COLOR") {
      warn(`token '${v.name}' is a ${v.type} variable holding a composed colour value \u2014 skipped`);
      continue;
    }
    const aliasRef = ref(v);
    const dv = dtcgValue(webNumber(v, bv), colorProfile, dimension, aliasRef);
    if (dv === null) {
      warn(`token '${v.name}' has a non-scalar value ${JSON.stringify(bv)} \u2014 skipped`);
      continue;
    }
    let value = dv;
    if (v.type === "BOOLEAN") {
      type = "string";
      if (!isAlias(bv)) value = String(value);
      warn(`token '${v.name}' is BOOLEAN \u2014 DTCG has no boolean type; emitted as $type:"string" (origin kept in $extensions)`);
    }
    if (!type) {
      warn(`token '${v.name}' (type ${v.type}) maps to no DTCG $type \u2014 skipped (a typeless token is invalid per DTCG 2025.10)`);
      continue;
    }
    const leaf = { $type: type, $value: value };
    if (v.description) leaf.$description = v.description;
    const opacity = dtcgOpacity(bv, aliasRef);
    if (!withExtensions) {
      const setExt = {};
      if (opacity !== void 0) setExt.opacity = opacity;
      if (percentOpacity(v, opts)) setExt.unit = "percent";
      if (Object.keys(setExt).length) leaf.$extensions = { "figma.com": setExt };
      node[leafKey] = leaf;
      continue;
    }
    const values = v.values || {};
    const modeKeys = Object.keys(values);
    const ext = {};
    if (opacity !== void 0) ext.opacity = opacity;
    if (modeKeys.length > 1) {
      const modes = nullProto();
      for (const m of modeKeys) {
        const mv = values[m] === void 0 ? null : dtcgValue(webNumber(v, values[m]), colorProfile, dimension, aliasRef);
        if (mv !== null) modes[m] = mv;
      }
      ext.modes = modes;
    }
    if (modeKeys.length > 1 && modeKeys.some((m) => isComposed(values[m]))) {
      const byMode = nullProto();
      for (const m of modeKeys) {
        const o = dtcgOpacity(values[m], aliasRef);
        if (o !== void 0) byMode[m] = o;
      }
      ext.modeOpacity = byMode;
    }
    if (typeof v.key === "string" && v.key) ext.key = v.key;
    if (isSentinel(v, bv)) ext.sentinel = { figmaValue: bv, meaning: "fully rounded \u2014 emitted as the platform idiom" };
    if (v.scopes && v.scopes.length) ext.scopes = v.scopes;
    if (percentOpacity(v, opts)) ext.unit = "percent";
    if (v.codeSyntax && Object.keys(v.codeSyntax).length) ext.codeSyntax = v.codeSyntax;
    if (v.type === "BOOLEAN") ext.originalType = "boolean";
    if (Object.keys(ext).length) leaf.$extensions = { "figma.com": ext };
    node[leafKey] = leaf;
  }
  return root;
}
function toDTCG(designSystem, warnings, opts, notes) {
  const warn = (m) => {
    if (warnings) warnings.push(m);
  };
  const collections = designSystem?.collections;
  const plan = dtcgPlan(designSystem);
  const tree = buildTree(designSystem, warn, opts, (v) => baseValue(v, collections), true, plan);
  if (notes) notes.push(...plan.notes);
  else for (const m of collisionMessages(plan.notes, opts)) warn(m);
  return tree;
}
var UNITLESS_SCOPES = /* @__PURE__ */ new Set(["OPACITY", "COLOR_OPACITY", "FONT_WEIGHT"]);
var UNITLESS_NAME_SEGMENTS = /* @__PURE__ */ new Set(["opacity", "fontweight"]);
function unitlessName(name) {
  return segs(name).some((seg) => UNITLESS_NAME_SEGMENTS.has(seg.replace(/[-_ ]/g, "").toLowerCase()));
}
function scopesSayUnitless(scopes) {
  return !!scopes.length && scopes.every((s) => UNITLESS_SCOPES.has(s));
}
function unitDecision(variable, opts) {
  if (opts && opts.unitless && opts.unitless.has && opts.unitless.has(variable.name)) return "override";
  const scopes = variable.scopes || [];
  if (scopesSayUnitless(scopes)) return "scopes";
  const narrowed = scopes.length && !scopes.every((s) => s === "ALL_SCOPES");
  if (!narrowed && unitlessName(variable.name)) return "name";
  return "px";
}
var PERCENT_SCOPES = /* @__PURE__ */ new Set(["OPACITY", "COLOR_OPACITY"]);
function percentOpacity(variable, opts) {
  return variable.type === "FLOAT" && unitDecision(variable, opts) === "scopes" && (variable.scopes || []).every((s) => PERCENT_SCOPES.has(s));
}
function numberUnit(variable, opts) {
  if (percentOpacity(variable, opts)) return "%";
  return unitDecision(variable, opts) === "px" ? "px" : "";
}
var pctOutOfRange = (n) => n < 0 || n > 100;
var cssPercent = (s) => (pctOutOfRange(Number(s)) ? String(clampOpacityPct(Number(s))) : s) + "%";
var NUMERIC_TEXT = /^-?\d+(?:\.\d+)?$/;
function cssPercentVar(plan, v, opts, depth = 0) {
  if (!v || depth > 8 || !percentOpacity(v, opts)) return false;
  const vals = Object.values(v.values || {}).filter((x) => x !== void 0);
  return vals.length > 0 && vals.every((x) => isAlias(x) ? cssPercentVar(plan, aliasTarget(plan, x.aliasOf, v), opts, depth + 1) : typeof x === "number" || typeof x === "string" && NUMERIC_TEXT.test(x));
}
function cssValue(raw, unit, ref, pctRef) {
  if (isAlias(raw)) return "var(" + (ref ? ref(raw.aliasOf) : cssVarName(raw.aliasOf)) + ")";
  if (isComposed(raw)) {
    const { color, opacity } = raw.composed;
    const c = cssValue(color, "", ref);
    const pct = isAlias(opacity) ? pctRef && pctRef(opacity.aliasOf) ? cssValue(opacity, "", ref) : null : cssPercent(String(opacity));
    return pct === null ? c : `color-mix(in srgb, ${c} ${pct}, transparent)`;
  }
  const e = isHexish(raw) ? normHex(raw) : null;
  if (e) return e;
  const fmtNum = (s) => unit === "%" ? cssPercent(s) : s === "0" ? "0" : unit ? s + unit : s;
  if (typeof raw === "number") return fmtNum(String(raw));
  if (typeof raw === "string" && NUMERIC_TEXT.test(raw)) return fmtNum(raw);
  if (typeof raw === "boolean") return String(raw);
  if (typeof raw === "string") return cssEscapeText(raw);
  return String(raw);
}
function cssPlan(designSystem) {
  const ds = designSystem || {};
  return planIds(
    ds.variables || [],
    (v) => segs(v.name).length ? cssVarName(v.name) : null,
    (id, s) => id + "-" + s,
    ds.collections,
    "tokens.css",
    (v) => cssVarName(v.name) === "--" + segs(v.name).join("-")
  );
}
function collectionOf(v, collections) {
  const named = collections.filter((c) => c.name === v.collection);
  if (named.length <= 1) return named[0];
  const modes = Object.keys(v.values || {});
  return named.find((c) => modes.every((m) => (c.modes || []).includes(m))) ?? named[0];
}
function planModeScopes(designSystem) {
  const collections = designSystem && designSystem.collections || [];
  const vars = designSystem && designSystem.variables || [];
  const groupIds = /* @__PURE__ */ new Map();
  collections.forEach((c, i) => groupIds.set(c, "c" + i));
  const groupOf = (v) => {
    const c = collectionOf(v, collections);
    return c ? groupIds.get(c) ?? "" : "";
  };
  const collOfGroup = /* @__PURE__ */ new Map();
  for (const [c, id] of groupIds) collOfGroup.set(id, c);
  const groupsPerMode = /* @__PURE__ */ new Map();
  const declared = (g, v) => {
    const c = collOfGroup.get(g);
    if (c) {
      const def2 = c.default ?? (c.modes || [])[0];
      return (c.modes || []).filter((m) => m !== def2);
    }
    const def = defaultModeName(v, collections);
    return Object.keys(v.values || {}).filter((m) => m !== def);
  };
  for (const v of vars) {
    if (!segs(v.name).length || !emitted(v)) continue;
    if (baseValue(v, collections) === void 0) continue;
    const g = groupOf(v);
    for (const m of declared(g, v)) {
      const list = getOrInit(groupsPerMode, m, () => []);
      if (!list.includes(g)) list.push(g);
    }
  }
  const qualified = /* @__PURE__ */ new Set();
  for (const list of groupsPerMode.values()) if (list.length > 1) for (const g of list) qualified.add(g);
  const nameOf = (g) => collOfGroup.get(g)?.name;
  const slugOf = (g) => suffixSlug(nameOf(g) ?? "no collection") || "collection";
  const slugCount = /* @__PURE__ */ new Map();
  for (const g of qualified) slugCount.set(slugOf(g), (slugCount.get(slugOf(g)) ?? 0) + 1);
  const attrOf = /* @__PURE__ */ new Map();
  const used = /* @__PURE__ */ new Set();
  for (const g of qualified) {
    const slug = slugOf(g);
    const key = collOfGroup.get(g)?.key;
    let attr = "data-theme-" + slug + ((slugCount.get(slug) ?? 0) > 1 && key ? "-" + suffixSlug(key.slice(0, KEY_SUFFIX_LEN)) : "");
    for (let n = 2; used.has(attr); n++) attr = "data-theme-" + slug + "-" + n;
    used.add(attr);
    attrOf.set(g, attr);
  }
  const warnings = [];
  for (const [m, list] of groupsPerMode) {
    if (list.length < 2) continue;
    const label = (g) => nameOf(g) ?? "(no collection)";
    warnings.push(`mode '${m}' exists in ${list.length} collections (${list.map(label).join(", ")}); their blocks are scoped per collection instead of [data-theme="${m}"]: set ${list.map((g) => `${attrOf.get(g) ?? "data-theme"}="${m}"`).join(" / ")} on the element that picks each collection's mode`);
  }
  const scope = (g, m) => {
    const list = groupsPerMode.get(m) || [];
    return { collection: nameOf(g), attribute: list.length > 1 ? attrOf.get(g) ?? "data-theme" : "data-theme" };
  };
  return { groupOf, scope, warnings };
}
function modeBlocks(plan) {
  const blocks = /* @__PURE__ */ new Map();
  return {
    set(v, mode, prop, line) {
      const group = plan.groupOf(v);
      getOrInit(blocks, group + "\0" + mode, () => ({ group, mode, lines: /* @__PURE__ */ new Map() })).lines.set(prop, line);
    },
    render(selector) {
      let out = "";
      for (const b of blocks.values()) {
        const sc = plan.scope(b.group, b.mode);
        out += `
${selector ? selector(b.mode, sc) : `[${sc.attribute}="${cssAttrEscape(b.mode)}"]`} {
` + [...b.lines.values()].join("\n") + "\n}\n";
      }
      return out;
    }
  };
}
function toCSS(designSystem, opts, notes) {
  const collections = designSystem && designSystem.collections || [];
  const vars = designSystem && designSystem.variables || [];
  const plan = cssPlan(designSystem);
  if (notes) notes.push(...plan.notes);
  const ref = (referrer) => (name) => {
    const t = aliasTargetId(plan, name, referrer);
    return t ? t.id : cssVarName(name);
  };
  const pctRef = (referrer) => (name) => cssPercentVar(plan, aliasTarget(plan, name, referrer), opts);
  const rootLines = /* @__PURE__ */ new Map();
  const perMode = modeBlocks(planModeScopes(designSystem));
  for (const v of vars) {
    if (!segs(v.name).length) continue;
    if (!emitted(v)) continue;
    const varName = plan.canonical.get(v);
    if (varName === void 0) continue;
    const values = v.values || {};
    const def = defaultModeName(v, collections);
    const base = baseValue(v, collections, def);
    if (base === void 0) continue;
    const baseStr = JSON.stringify(base);
    const unit = numberUnit(v, opts);
    const r = ref(v), p = pctRef(v);
    const font = v.type === "STRING" && twKind(v, opts) === "fontFamily";
    const val = (raw) => font && typeof raw === "string" ? cssFontFamily(raw) : cssValue(webNumber(v, raw), unit, r, p);
    rootLines.set(varName, `  ${varName}: ${val(base)};`);
    for (const m of Object.keys(values)) {
      if (m === def || values[m] === void 0) continue;
      if (JSON.stringify(values[m]) === baseStr) continue;
      perMode.set(v, m, varName, `  ${varName}: ${val(values[m])};`);
    }
  }
  const out = rootLines.size ? ":root {\n" + [...rootLines.values()].join("\n") + "\n}\n" : "";
  return out + perMode.render(opts && opts.selector);
}
var TW_NAMESPACE = { color: "--color-", dimension: "--spacing-", radius: "--radius-", fontSize: "--text-", fontFamily: "--font-" };
var TW_PREFIX = "figma-";
function twSlug(name) {
  const slug = segs(name).join("-").replace(/[^A-Za-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase();
  return slug || "token";
}
function twName(v, opts) {
  const kind = twKind(v, opts);
  return (kind ? TW_NAMESPACE[kind] : "--") + TW_PREFIX + twSlug(v.name);
}
var RADIUS_SCOPES = /* @__PURE__ */ new Set(["CORNER_RADIUS"]);
function twKind(v, opts) {
  if (v.type === "COLOR") return "color";
  const scopes = v.scopes || [];
  const narrowed = scopes.length && !scopes.every((s) => s === "ALL_SCOPES");
  if (v.type === "STRING") {
    if (narrowed) return scopes.includes("FONT_FAMILY") ? "fontFamily" : null;
    return /font.?family|typeface/i.test((v.collection ?? "") + "/" + v.name) ? "fontFamily" : null;
  }
  if (v.type !== "FLOAT") return null;
  if (unitDecision(v, opts) !== "px") return null;
  if (narrowed && scopes.some((x) => RADIUS_SCOPES.has(x))) return "radius";
  if (narrowed && scopes.includes("FONT_SIZE")) return "fontSize";
  if (!narrowed && /radius|corner|rounded/i.test(v.name)) return "radius";
  if (!narrowed && /font.?size|text.?size|type.?size/i.test((v.collection ?? "") + "/" + v.name)) return "fontSize";
  return "dimension";
}
function cssFontFamily(raw) {
  const s = raw.trim();
  if (!s || /[,'"]/.test(s) || /^[A-Za-z_-][A-Za-z0-9_-]*$/.test(s)) return cssEscapeText(raw);
  return '"' + s.replace(/["\\\n\r\f]/g, hexEsc) + '"';
}
function toTailwind(designSystem, opts, notes) {
  const collections = designSystem && designSystem.collections || [];
  const vars = designSystem && designSystem.variables || [];
  const plan = planIds(
    vars,
    (v) => segs(v.name).length ? twName(v, opts) : null,
    (id, s) => id + "-" + s,
    collections,
    "theme.css",
    (v) => /^[A-Za-z0-9-]+$/.test(segs(v.name).join("-"))
  );
  const warnings = [];
  if (notes) notes.push(...plan.notes);
  else warnings.push(...collisionMessages(plan.notes, opts));
  const theme = /* @__PURE__ */ new Map();
  const scopes = planModeScopes(designSystem);
  const perMode = modeBlocks(scopes);
  warnings.push(...scopes.warnings);
  const aliasedByFont = /* @__PURE__ */ new Set();
  const queue = vars.filter((v) => v.type === "STRING" && twKind(v, opts) === "fontFamily");
  for (let v = queue.pop(); v !== void 0; v = queue.pop()) {
    for (const m of Object.keys(v.values || {})) for (const n of aliasNames(v.values[m])) {
      const t = aliasTarget(plan, n, v);
      if (t && !aliasedByFont.has(t)) {
        aliasedByFont.add(t);
        queue.push(t);
      }
    }
  }
  const leftOut = [];
  let utilities = 0;
  for (const v of vars) {
    if (!segs(v.name).length) continue;
    if (!emitted(v)) continue;
    const name = plan.canonical.get(v);
    if (name === void 0) continue;
    const def = defaultModeName(v, collections);
    const base = baseValue(v, collections, def);
    if (base === void 0) continue;
    const kind = twKind(v, opts);
    if (v.type === "STRING" && !kind && !aliasedByFont.has(v)) {
      if (!leftOut.includes(v.name)) leftOut.push(v.name);
      continue;
    }
    if (kind) utilities++;
    const unit = numberUnit(v, opts);
    const ref = (n) => {
      const t = aliasTargetId(plan, n, v);
      return t ? t.id : "--" + TW_PREFIX + twSlug(n);
    };
    const pctRef = (n) => cssPercentVar(plan, aliasTarget(plan, n, v), opts);
    const val = (raw) => kind === "fontFamily" && typeof raw === "string" ? cssFontFamily(raw) : cssValue(webNumber(v, raw), unit, ref, pctRef);
    const baseStr = JSON.stringify(base);
    theme.set(name, `  ${name}: ${val(base)};`);
    const values = v.values || {};
    for (const m of Object.keys(values)) {
      if (m === def || values[m] === void 0) continue;
      if (JSON.stringify(values[m]) === baseStr) continue;
      perMode.set(v, m, name, `  ${name}: ${val(values[m])};`);
    }
  }
  if (leftOut.length) {
    warnings.push(`theme.css leaves out ${leftOut.length} STRING token(s) that are not font families (${leftOut.slice(0, 4).map((n) => `'${n}'`).join(", ")}${leftOut.length > 4 ? `, \u2026 +${leftOut.length - 4} more` : ""}) \u2014 a value like 'Semi Bold' is not usable in @theme and generates no utility. They are kept in tokens.dtcg.json and tokens.css (written with --also-generic); scope a font-family STRING to FONT_FAMILY in Figma to get a --font-figma-* utility`);
  }
  let out = '@import "tailwindcss";\n/* GENERATED by Design Twin (tokens.js --web tailwind) \u2014 do not edit by hand; re-run after a token pull.\n   Every design-system variable sits under a `figma-` name (rounded-figma-xl, p-figma-space-4, bg-figma-\u2026),\n   so Tailwind\'s own scale (rounded-xl, p-4, \u2026) keeps its framework meaning. */\n';
  if (theme.size) out += "\n@theme {\n" + [...theme.values()].join("\n") + "\n}\n";
  out += perMode.render();
  return { text: out, utilities, tokens: theme.size, warnings };
}
var RESOLVER_VERSION = "2025.10";
var RESOLVER_SCHEMA = "https://www.designtokens.org/schemas/2025.10/resolver.json";
var RESOLVER_DIR = "tokens";
var ptrEsc = (s) => String(s).replace(/~/g, "~0").replace(/\//g, "~1");
function fileSlug(s, fallback) {
  const out = String(s == null ? "" : s).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-._]+|[-._]+$/g, "");
  return out || fallback;
}
function toResolver(designSystem, warnings, opts) {
  const seen = new Set(warnings || []);
  const warn = (m) => {
    if (warnings && !seen.has(m)) {
      seen.add(m);
      warnings.push(m);
    }
  };
  const ds = designSystem || {};
  const collections = ds.collections || [];
  const vars = ds.variables || [];
  const groups = /* @__PURE__ */ new Map();
  for (const v of vars) {
    const key = String(v && v.collection || "");
    getOrInit(groups, key, () => []).push(v);
  }
  const declared = /* @__PURE__ */ new Map();
  for (const c of collections) if (c && c.name != null && !declared.has(String(c.name))) declared.set(String(c.name), c);
  const plan = dtcgPlan(ds);
  const takenFiles = /* @__PURE__ */ new Map();
  function reserveFile(base, ext, owner) {
    let candidate = `${RESOLVER_DIR}/${base}${ext}`, n = 1;
    while (takenFiles.has(candidate.toLowerCase())) {
      n += 1;
      const next = `${RESOLVER_DIR}/${base}-${n}${ext}`;
      warn(`resolver file '${candidate}' for ${owner} collides with ${takenFiles.get(candidate.toLowerCase())} after sanitizing the name \u2014 wrote '${next}' instead`);
      candidate = next;
    }
    takenFiles.set(candidate.toLowerCase(), owner);
    return candidate;
  }
  const takenKeys = { set: /* @__PURE__ */ new Set(), modifier: /* @__PURE__ */ new Set() };
  function reserveKey(name, kind) {
    let candidate = name, n = 1;
    while (takenKeys[kind].has(candidate)) {
      n += 1;
      const next = `${name} ${n}`;
      warn(`resolver ${kind} name '${candidate}' is already used \u2014 renamed to '${next}'`);
      candidate = next;
    }
    takenKeys[kind].add(candidate);
    return candidate;
  }
  const sets = nullProto();
  const modifiers = nullProto();
  const files = nullProto();
  const resolutionOrder = [];
  const modifierRefs = [];
  for (const [collName, groupVars] of groups) {
    const c = declared.get(collName);
    const label = collName || "tokens";
    const sub = { ...ifDefined("colorProfile", ds.colorProfile), collections, variables: groupVars };
    const base = buildTree(sub, warn, opts, (v) => baseValue(v, collections), false, plan);
    if (!Object.keys(base).length) continue;
    const setName = reserveKey(label, "set");
    const setFile = reserveFile(fileSlug(label, "tokens"), ".json", `set '${label}'`);
    files[setFile] = base;
    sets[setName] = { description: `${label} (default mode values)`, sources: [{ $ref: setFile }], $extensions: { "figma.com": { collection: collName || null } } };
    resolutionOrder.push({ $ref: `#/sets/${ptrEsc(setName)}` });
    const modes = [];
    for (const m of c && c.modes || []) if (!modes.includes(m)) modes.push(m);
    for (const v of groupVars) for (const m of Object.keys(v && v.values || {})) if (!modes.includes(m)) modes.push(m);
    if (modes.length < 2) continue;
    const contexts = nullProto();
    let nonEmpty = 0;
    for (const m of modes) {
      const tree = buildTree(sub, warn, opts, (v) => {
        const values = v && v.values || {};
        const def2 = defaultModeName(v, collections);
        if (m === def2 || values[m] === void 0) return SKIP;
        const bv = baseValue(v, collections, def2);
        return JSON.stringify(values[m]) === JSON.stringify(bv) ? SKIP : values[m];
      }, false, plan);
      if (!Object.keys(tree).length) {
        contexts[m] = [];
        continue;
      }
      const file = reserveFile(`${fileSlug(label, "tokens")}.${fileSlug(m, "mode")}`, ".json", `collection '${label}' mode '${m}'`);
      files[file] = tree;
      contexts[m] = [{ $ref: file }];
      nonEmpty += 1;
    }
    if (!nonEmpty) continue;
    const modName = reserveKey(label, "modifier");
    const def = c && c.default != null && modes.includes(c.default) ? c.default : modes[0] ?? "";
    modifiers[modName] = { description: `${label} mode`, contexts, default: def, $extensions: { "figma.com": { collection: collName || null, defaultMode: def } } };
    modifierRefs.push({ $ref: `#/modifiers/${ptrEsc(modName)}` });
  }
  for (const r of modifierRefs) resolutionOrder.push(r);
  const resolver = {
    $schema: RESOLVER_SCHEMA,
    ...ds.file ? { name: String(ds.file) } : {},
    // optional, but the filename alone rarely says which Figma file
    version: RESOLVER_VERSION,
    // REQUIRED, MUST be "2025.10"
    sets,
    ...Object.keys(modifiers).length ? { modifiers } : {},
    // omitted rather than empty: nothing to condition on
    resolutionOrder
    // REQUIRED
  };
  return { resolver, files };
}
function lintTokens(designSystem, opts) {
  const warnings = [];
  const notes = [];
  toDTCG(designSystem, warnings, opts, notes);
  notes.push(...cssPlan(designSystem).notes);
  warnings.push(...collisionMessages(notes, opts));
  lintNames(designSystem, opts, warnings);
  return dedupe(warnings);
}
var dedupe = (list) => [...new Set(list)];
function cssFilesOf(opts) {
  return opts && opts.cssFiles ? [...opts.cssFiles] : opts && opts.tailwind ? ["tokens.css", "theme.css"] : ["tokens.css"];
}
function lintNames(designSystem, opts, warnings) {
  const vars = designSystem && designSystem.variables || [];
  const files = cssFilesOf(opts);
  const inCss = files.join("/") || "the CSS";
  warnings.push(...planModeScopes(designSystem).warnings);
  const names = new Set(vars.map((v) => segs(v.name).join(".")).filter(Boolean));
  for (const v of vars) for (const m of Object.keys(v.values || {})) {
    for (const target of aliasNames(v.values[m])) {
      if (!names.has(segs(target).join("."))) warnings.push(`token '${v.name}' (mode ${m}) references undefined token '${target}'`);
    }
  }
  let plan = null;
  for (const v of vars) {
    if (v.type !== "COLOR") continue;
    for (const m of Object.keys(v.values || {})) {
      const raw = v.values[m];
      if (!isComposed(raw)) continue;
      const { opacity } = raw.composed;
      if (isAlias(opacity)) {
        plan = plan || cssPlan(designSystem);
        if (!cssPercentVar(plan, aliasTarget(plan, opacity.aliasOf, v), opts)) {
          warnings.push(`token '${v.name}' (mode ${m}) is a composed colour whose opacity '${opacity.aliasOf}' is not an OPACITY/COLOR_OPACITY-scoped number (its CSS is not a percentage); ${inCss} carr${files.length > 1 ? "y" : "ies"} the colour only \u2014 the opacity is in tokens.dtcg.json $extensions["figma.com"]`);
          break;
        }
      } else if (pctOutOfRange(opacity)) {
        warnings.push(`token '${v.name}' (mode ${m}) is a composed colour with opacity ${opacity}, outside Figma's 0\u2013100 range; clamped to ${clampOpacityPct(opacity)}% in ${inCss} (as Figma does); tokens.dtcg.json keeps ${opacity}`);
      }
    }
  }
  for (const v of vars) {
    if (!percentOpacity(v, opts)) continue;
    for (const m of Object.keys(v.values || {})) {
      const raw = v.values[m];
      const txt = typeof raw === "number" ? String(raw) : typeof raw === "string" && NUMERIC_TEXT.test(raw) ? raw : null;
      if (txt !== null && pctOutOfRange(Number(txt))) warnings.push(`token '${v.name}' (mode ${m}) is an opacity of ${txt}, outside Figma's 0\u2013100 range; clamped to ${clampOpacityPct(Number(txt))}% in ${inCss} (as Figma does); tokens.dtcg.json keeps ${txt}`);
    }
  }
  for (const v of vars) {
    if (v.type !== "STRING") continue;
    for (const m of Object.keys(v.values || {})) {
      if (cssNeedsEscape(v.values[m])) {
        warnings.push(`token '${v.name}' (mode ${m}) contains CSS-structural characters; escaped for safety in ${inCss}`);
        break;
      }
    }
  }
  const modeNames = /* @__PURE__ */ new Set();
  for (const c of designSystem && designSystem.collections || []) for (const m of c.modes || []) modeNames.add(m);
  for (const v of vars) for (const m of Object.keys(v.values || {})) modeNames.add(m);
  for (const m of modeNames) {
    if (cssAttrNeedsEscape(m)) warnings.push(`mode '${m}' contains a quote or backslash; escaped in its ${inCss} selector`);
  }
  for (const v of vars) {
    if (v.type === "FLOAT" && unitDecision(v, opts) === "name") {
      warnings.push(`token '${v.name}' has no narrowed scopes (Figma's ALL_SCOPES default); emitted UNITLESS because its name reads as an opacity/font-weight \u2014 scope it in Figma to make this explicit`);
    }
    const s = segs(v.name);
    if (!s.length) continue;
    const folded = cssVarName(v.name);
    if (folded !== "--" + s.join("-")) {
      const as = files.map((f) => `${f === "theme.css" ? twName(v, opts) : folded} in ${f}`).join(", ");
      warnings.push(`token '${v.name}' contains characters that are illegal in a CSS custom property; emitted as ${as}`);
    }
  }
  return warnings;
}
function emitTokens(designSystem, opts) {
  const warnings = [];
  const notes = [];
  const dtcg = toDTCG(designSystem, warnings, opts, notes);
  const css = toCSS(designSystem, opts, notes);
  const tailwind = opts && opts.tailwind ? toTailwind(designSystem, opts, notes) : void 0;
  const { resolver, files } = toResolver(designSystem, warnings, opts);
  const collisions = collisionMessages(notes, opts);
  if (tailwind) warnings.push(...tailwind.warnings);
  lintNames(designSystem, opts, warnings);
  return { dtcg, css, tailwind, resolver, resolverFiles: files, warnings: dedupe(collisions.concat(warnings)), collisions };
}
var { toNative, platformOf, PLATFORMS } = nativeEmitter({ segs, isAlias, defaultModeName, baseValue, unitDecision, isSentinel, percentOpacity });
function main(args) {
  const USAGE = `usage: ${scriptCmd("tokens")} <design-system/tokens.json | design/variables.json> [outDir]
       [--native swiftui|compose|flutter|react-native] [--package <kotlin.package>] [--web tailwind] [--also-generic]
       With --web/--native, ONLY the target's file is written to [outDir]; pass --also-generic to
       additionally write the generic set (tokens.dtcg.json, tokens.css, tokens.resolver.json, tokens/).
       Without a target flag, only the generic set is written (unchanged).`;
  const OPTIONS = { native: { type: "string" }, web: { type: "string" }, package: { type: "string" }, "also-generic": { type: "boolean" }, help: { type: "boolean", short: "h" } };
  const { values: flags, positionals } = cliParse("tokens", args, OPTIONS, USAGE, 1, (a) => parseArgs2({ args: a, options: OPTIONS, allowPositionals: true }));
  if (flags.help) {
    console.log(USAGE);
    return 0;
  }
  const { native, web, package: kotlinPackage } = flags;
  const alsoGeneric = !!flags["also-generic"];
  const input = positionals[0];
  const outDir = positionals[1] || ".";
  if (!input) {
    console.error(USAGE);
    return 1;
  }
  if (native !== void 0 && !platformOf(native)) {
    console.error(`--native: unknown platform "${native}"
${USAGE}`);
    return 1;
  }
  const WEB_TARGETS = { tailwind: "theme.css", "web-tailwind": "theme.css" };
  const webFile = web === void 0 ? void 0 : WEB_TARGETS[web];
  if (web !== void 0 && !webFile) {
    console.error(`--web: unknown target "${web}" (known: tailwind)
${USAGE}`);
    return 1;
  }
  const ds = readSplitFile(
    input,
    "token catalog",
    isTokensDoc,
    "variables",
    "design-system/tokens.json",
    NO_DESIGN_SYSTEM_HINT + "\n       A single-screen pull DOES write design/variables.json \u2014 pass that instead."
  );
  fs3.mkdirSync(outDir, { recursive: true });
  const hasTarget = web !== void 0 || native !== void 0;
  const writeGeneric = !hasTarget || alsoGeneric;
  const cssFiles = [...writeGeneric ? ["tokens.css"] : [], ...webFile !== void 0 ? [webFile] : []];
  const { dtcg, css, tailwind, resolver, resolverFiles, warnings } = emitTokens(ds, { tailwind: web !== void 0, sources: sourcesOf(ds, input), cssFiles });
  const genericCount = Object.keys(resolverFiles).length;
  if (writeGeneric) {
    fs3.writeFileSync(path4.join(outDir, "tokens.dtcg.json"), JSON.stringify(dtcg, null, 2));
    fs3.writeFileSync(path4.join(outDir, "tokens.css"), css);
    fs3.writeFileSync(path4.join(outDir, "tokens.resolver.json"), JSON.stringify(resolver, null, 2));
    for (const rel of Object.keys(resolverFiles)) {
      const dest = path4.join(outDir, ...rel.split("/"));
      fs3.mkdirSync(path4.dirname(dest), { recursive: true });
      fs3.writeFileSync(dest, JSON.stringify(resolverFiles[rel], null, 2));
    }
  }
  let canonicalFile = null;
  const tw = tailwind;
  if (web !== void 0 && webFile !== void 0 && tw !== void 0) {
    const file = webFile;
    fs3.writeFileSync(path4.join(outDir, file), tw.text);
    canonicalFile = file;
    if (tw.tokens && !tw.utilities) warnings.push(`--web ${web}: no variable mapped to a Tailwind namespace, so ${file} generates no utilities \u2014 every token is a plain custom property you must reference with var()`);
    else if (tw.tokens > tw.utilities) warnings.push(`--web ${web}: ${tw.tokens - tw.utilities} of ${tw.tokens} token(s) match no Tailwind namespace (unitless FLOATs like opacity/font-weight, booleans, strings a font family aliases) \u2014 emitted as plain --figma-* properties, usable via var() but generating no utility`);
  }
  if (native !== void 0) {
    const n = toNative(ds, native, { ...ifDefined("package", kotlinPackage || void 0) });
    fs3.writeFileSync(path4.join(outDir, n.file), n.text);
    warnings.push(...n.warnings);
    canonicalFile = n.file;
  }
  warnings.forEach((w) => console.error("warn  " + w));
  if (webFile !== void 0) console.error("note  " + TAILWIND_SOURCE_NOT_NOTE);
  if (hasTarget) {
    const genericNote = writeGeneric ? ` (+ the generic set: tokens.dtcg.json, tokens.css, tokens.resolver.json, ${genericCount} file(s) under ${RESOLVER_DIR}/ \u2014 also written here because --also-generic was passed)` : ` \u2014 the generic handoff set (tokens.dtcg.json, tokens.css, tokens.resolver.json, tokens/) was NOT written here; it belongs under design/, not the app's source tree (pass --also-generic to also write it to ${outDir})`;
    console.log(`wrote ${canonicalFile} to ${outDir} \u2014 this is the file your app should import${genericNote} (${(ds.variables || []).length} variables)`);
  } else {
    console.log(`wrote tokens.dtcg.json + tokens.css + tokens.resolver.json (+${genericCount} set files under ${RESOLVER_DIR}/) (${(ds.variables || []).length} variables)`);
  }
  return 0;
}
if (import.meta.main ?? isMainFallback(import.meta.url)) process.exitCode = main(process.argv.slice(2));
export {
  PLATFORMS,
  TW_PREFIX,
  WEB_FULL_ROUND,
  cssVarName,
  emitTokens,
  hexToColorValue,
  lintTokens,
  platformOf,
  toCSS,
  toDTCG,
  toNative,
  toResolver,
  toTailwind
};
