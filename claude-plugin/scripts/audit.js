// GENERATED from design-to-code/ by claude-plugin/build-scripts.js — edit the source, then rebuild.


// design-to-code/audit.ts
import fs5 from "node:fs";
import path2 from "node:path";

// design-to-code/hidden.ts
var hiddenSelf = (node) => !!(node && typeof node === "object" && "hidden" in node && node.hidden);
var isHidden = (node, ancestorHidden) => !!ancestorHidden || hiddenSelf(node);

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
function parseHex(v) {
  const k = colorKey(v);
  if (k === null) return null;
  const n = (i) => parseInt(k.slice(i, i + 2), 16);
  return { r: n(1), g: n(3), b: n(5), a: n(7) / 255 };
}
function luminance(c) {
  const ch = (v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}
function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

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

// design-to-code/component-match.ts
function visibleInstances(doc, label) {
  const out = [];
  const roots = screenRoots(doc);
  const walk2 = (n) => {
    if (!n || typeof n !== "object" || n.hidden === true) return;
    if (n.type === "INSTANCE" && n.mainComponent) {
      const mc = n.mainComponent;
      out.push({
        screen: label,
        nodeId: n.id,
        layer: n.name,
        name: mc.setName || mc.name || n.name,
        key: mc.key,
        setKey: mc.setKey,
        remote: mc.remote === true,
        variant: parseVariant(n.component) || parseVariant(mc.variant),
        props: n.props && typeof n.props === "object" ? n.props : {}
      });
    }
    for (const c of n.children || []) walk2(c);
  };
  for (const r of roots) walk2(r);
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
var baseProp = (p) => String(p).split("#")[0];
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
    const bad = known.filter((k) => !(props[k].options || []).includes(variant[k]));
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
    if (!byName.has(c.name)) byName.set(c.name, []);
    byName.get(c.name).push(Object.assign({ _order: i }, c));
  });
  const catKeys = new Set(comps.map((c) => c.key).filter((k) => !!k));
  const libKeys = new Set((library && library.components || []).map((c) => c.key).filter((k) => !!k));
  const libNames = new Set((library && library.components || []).map((c) => c.name));
  const groups = /* @__PURE__ */ new Map();
  for (const inst of instances) {
    if (!groups.has(inst.name)) groups.set(inst.name, []);
    groups.get(inst.name).push(inst);
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
    const scored = cands.map((c) => {
      const per = list.map((i) => signature(i, c));
      return { c, verified: per.every((p) => p.verified), score: Math.min(...per.map((p) => p.score)), reasons: per[0].reasons, failing: per.find((p) => !p.verified) };
    }).sort((a, b) => Number(b.verified) - Number(a.verified) || b.score - a.score || a.c._order - b.c._order);
    const best = scored[0];
    if (!best.verified) {
      row.reasons.push(`${cands.length} catalog entr${cands.length === 1 ? "y is" : "ies are"} named ${JSON.stringify(name)}, but no prop signature agrees: ` + (best.failing ? best.failing.reasons.filter((r) => /NOT|not in|none of|\d+\/\d+|sets no variant/.test(r)).join("; ") : "signature mismatch") + " \u2014 a name alone is not a match");
      rows.push(row);
      continue;
    }
    const verifiedOnes = scored.filter((s) => s.verified);
    const ties = verifiedOnes.filter((s) => s.score === best.score && s !== best);
    row.match = { id: best.c.id, key: best.c.key, name: best.c.name, type: best.c.type, page: best.c.page };
    row.evidence = list.some((i) => i.variant || Object.keys(i.props || {}).length) ? "name+signature" : "name+no-props";
    row.reasons = best.reasons.slice();
    if (ties.length) {
      const identical = ties.every((t) => sigOf(t.c) === sigOf(best.c));
      row.reasons.push(identical ? `${ties.length + 1} catalog entries named "${name}" score identically \u2014 they are duplicates of one definition (same props, same variants); the first in the catalog is used` : `${ties.length + 1} catalog entries named "${name}" score identically with DIFFERENT signatures \u2014 the first in the catalog is used; confirm which one`);
      row.tie = identical ? "duplicate-definitions" : "different-signatures";
    } else if (scored.length > 1) {
      row.reasons.push(`beat ${scored.length - 1} same-named candidate(s)${verifiedOnes.length > 1 ? ` by ${best.score - verifiedOnes[1].score} pts` : " (their prop signatures do not agree)"}`);
    }
    row.alternatives = verifiedOnes.filter((s) => s !== best).map((s) => ({ id: s.c.id, key: s.c.key, page: s.c.page, score: s.score }));
    row.reasons.push("key lookup: " + (byKey ? "matched" : "NO MATCH (the instance's key is not in the catalog \u2014 re-keyed)"));
    rows.push(row);
  }
  const proposals = rows.filter((r) => r.match && !r.byKey);
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

// design-to-code/catalog-input.ts
import fs2 from "node:fs";

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
function readOptionalDoc(file, what, guard) {
  return fs2.existsSync(file) ? readDocFile(file, what, guard) : null;
}
function readSplitFile(file, what, guard, payloadKey, wantFile, hint) {
  const doc = readJsonFile(file, what, hint);
  assertNotManifest(doc, file, payloadKey, wantFile);
  if (guard(doc)) return doc;
  console.error(`error  ${what}: '${file}' is not ${guard.expected || "the expected kind of document"}`);
  process.exit(2);
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

// design-to-code/cli-args.ts
import { parseArgs } from "node:util";
var scriptCmd = (name) => `node "\${CLAUDE_PLUGIN_ROOT}/scripts/${name}.js"`;
function errCode(e) {
  return e && typeof e === "object" && "code" in e && typeof e.code === "string" ? e.code : void 0;
}
function cliParse(tool, argv, options, usage, exitCode, parse) {
  try {
    return parse();
  } catch (e) {
    const code = errCode(e);
    if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      const { tokens } = parseArgs({ args: argv, options, strict: false, allowPositionals: true, tokens: true });
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

// design-to-code/slice-sources.ts
import fs3 from "node:fs";
import path from "node:path";
function sourcesOf(doc, docPath) {
  const out = /* @__PURE__ */ new Map();
  const add = (key, screen) => {
    if (typeof key !== "string" || !key || !screen) return;
    const list = out.get(key) || [];
    if (!list.includes(screen)) list.push(screen);
    out.set(key, list);
  };
  const base = docPath ? path.dirname(docPath) : ".";
  for (const sl of doc && Array.isArray(doc._slices) ? doc._slices : []) {
    if (!sl) continue;
    let read = false;
    if (typeof sl.file === "string") {
      const slice = readJsonOrNull(path.join(base, sl.file.replace(/\.json$/, ".vars.json")), isTokensDoc);
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
    for (const v of doc && doc.variables || []) add(v.key, path.basename(docPath, ".vars.json"));
  }
  return out;
}
function variablesContext(screenFiles, varsFile, opts) {
  const invalid = [];
  const readTokens = (f) => {
    if (!f) return null;
    const r = readJson(f, isTokensDoc);
    if ("doc" in r) return r.doc;
    if (!r.missing) invalid.push({ file: f, error: r.error });
    return null;
  };
  const files = screenFiles || [];
  const own = files.map((f) => readTokens(String(f).replace(/\.json$/, ".vars.json")));
  let variablesPath = varsFile || null;
  if (!variablesPath && files.length) {
    const exportRoot = path.resolve(path.dirname(files[0]), "..", "..");
    const rootVars = path.join(exportRoot, "variables.json");
    const sibling = path.join(path.dirname(files[0]), "variables.json");
    if (fs3.existsSync(rootVars)) variablesPath = rootVars;
    else if (fs3.existsSync(sibling)) variablesPath = sibling;
    else if (opts && opts.sliceFallback && files.length === 1 && own[0]) variablesPath = String(files[0]).replace(/\.json$/, ".vars.json");
  }
  const variablesDoc = readTokens(variablesPath);
  let staleLegacy = null;
  if (files.length) {
    const legacy = path.join(path.resolve(path.dirname(files[0]), "..", ".."), "..", "variables.json");
    if (fs3.existsSync(legacy) && path.resolve(legacy) !== path.resolve(variablesPath || "")) staleLegacy = legacy;
  }
  return { own, variablesPath, variablesDoc, sliceSources: variablesDoc ? sourcesOf(variablesDoc, variablesPath) : null, staleLegacy, invalid };
}

// bridge/src/is-main.ts
import fs4 from "node:fs";
import { fileURLToPath } from "node:url";
function isMainFallback(metaUrl) {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    return fs4.realpathSync(argv1) === fs4.realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

// design-to-code/cross-check.ts
var SEVERITY_ORDER = { blocker: 0, warning: 1, info: 2 };
var ABSURD_NUMBER = 1e4;
var WRONG_CATALOG_PCT = 5;
function walk(node, fn) {
  if (!node || typeof node !== "object") return;
  if (hiddenSelf(node)) return;
  fn(node);
  for (const c of node.children || []) walk(c, fn);
}
var norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
function crossCheck(input) {
  const screens = input.screens || [];
  const variables = input.variables || null;
  const tokens = input.tokens || null;
  const components = input.components || null;
  const componentsLibrary = input.componentsLibrary || null;
  const stylesText = input.stylesText || null;
  const findings = [];
  const notChecked = [];
  const push = (severity, code, message, extra) => findings.push(Object.assign({ severity, code, message }, extra || {}));
  const usedTokenNames = /* @__PURE__ */ new Map();
  const instances = [];
  const fonts = /* @__PURE__ */ new Map();
  const textStyles = /* @__PURE__ */ new Map();
  const resolvedModes = /* @__PURE__ */ new Map();
  for (const s of screens) {
    const label = s.label || screenExportOf(s.doc)?.screen || "screen";
    for (const root of screenRoots(s.doc)) {
      if (root && root.resolvedModes) {
        for (const [coll, mode] of Object.entries(root.resolvedModes)) {
          if (!resolvedModes.has(coll)) resolvedModes.set(coll, /* @__PURE__ */ new Set());
          resolvedModes.get(coll).add(mode);
        }
      }
      walk(root, (n) => {
        for (const [field, name] of Object.entries(n.tokens || {})) {
          if (typeof name !== "string") continue;
          if (!usedTokenNames.has(name)) usedTokenNames.set(name, []);
          usedTokenNames.get(name).push({ screen: label, nodeId: n.id, field });
        }
        for (const f of n.fills || []) {
          const t = f && f.tokens && f.tokens.color;
          if (typeof t === "string") {
            if (!usedTokenNames.has(t)) usedTokenNames.set(t, []);
            usedTokenNames.get(t).push({ screen: label, nodeId: n.id, field: "fills" });
          }
        }
        if (n.font && n.font.family) fonts.set(n.font.family, (fonts.get(n.font.family) || 0) + 1);
        const ts = n.styles && n.styles.text;
        if (ts) textStyles.set(ts, (textStyles.get(ts) || 0) + 1);
      });
    }
  }
  const visible = [];
  screens.forEach((s) => {
    const label = s.label || screenExportOf(s.doc)?.screen || "screen";
    for (const i of visibleInstances(s.doc, label)) {
      visible.push(i);
      instances.push({ screen: label, nodeId: i.nodeId, name: i.layer, key: i.key, setKey: i.setKey, setName: i.name, propNames: Object.keys(i.props || {}) });
    }
  });
  const dsCollByKey = /* @__PURE__ */ new Map();
  const dsCollByName = /* @__PURE__ */ new Map();
  for (const c of tokens && tokens.collections || []) {
    if (c.key) dsCollByKey.set(c.key, c);
    if (c.name) dsCollByName.set(norm(c.name), c);
  }
  const screenColls = variables && variables.collections || [];
  if (!tokens) {
    notChecked.push(
      "collection provenance \u2014 no design-system tokens.json was given, so nothing could verify that the screen's variables come from the design system you exported. Run `dtwin pull --design-system` and pass it."
    );
  } else if (!screenColls.length) {
    notChecked.push(
      input.variablesPath ? `collection provenance \u2014 ${input.variablesPath} was checked but carries no collections for this screen, so its own token library is unknown.` : `collection provenance \u2014 no variables.json was found (looked in design/export/variables.json), so the screen's own token library is unknown.`
    );
  } else {
    const foreign = [];
    for (const c of screenColls) {
      if (c.key && dsCollByKey.has(c.key)) continue;
      const twin = dsCollByName.get(norm(c.name));
      foreign.push({ name: c.name, key: c.key, twinKey: twin && twin.key, twinName: twin && twin.name });
    }
    if (foreign.length) {
      const sameNameDifferentKey = foreign.filter((f) => f.twinKey);
      const severity = foreign.length === screenColls.length ? "blocker" : "warning";
      push(
        severity,
        "foreign-token-library",
        `${foreign.length} of ${screenColls.length} variable collection(s) the screen binds are NOT in the design-system export \u2014 the screen consumes a DIFFERENT library than the one you pulled. ` + (sameNameDifferentKey.length ? `${sameNameDifferentKey.length} of them carry a design-system collection's name under a different key (${sameNameDifferentKey.slice(0, 3).map((f) => `'${f.name}'`).join(", ")}), which is the signature of a DUPLICATED Figma file: duplicating a library re-keys everything while leaving names and values identical. ` : "") + `Names and values may still line up (check the collisions below), but nothing here is the same variable. To find the real owner: run \`dtwin list libraries --client <the screen's file>\` \u2014 variable collections are the ONE thing Figma attributes to a library by name \u2014 then open that file and export it with \`dtwin pull --as-library "<name>"\`.`,
        { collections: foreign }
      );
    } else {
      push("info", "token-library-matches", `all ${screenColls.length} variable collection(s) the screen binds resolve to the design-system export by key.`, {});
    }
  }
  const dsVarByName = /* @__PURE__ */ new Map();
  for (const v of tokens && tokens.variables || []) if (v.name) dsVarByName.set(v.name, v);
  const sliceSources = input.sliceSources || null;
  const labels = screens.map((s) => s.label || screenExportOf(s.doc)?.screen || "screen");
  const own = screens.map((s) => s && s.vars && Array.isArray(s.vars.variables) ? s.vars.variables : null);
  let varScope = "own";
  let screenVars = [];
  const none = [];
  if (own.length && own.every((o) => !!o)) {
    screenVars = none.concat(...own);
  } else if (variables && sliceSources && sliceSources.size) {
    varScope = "union-by-source";
    screenVars = (variables && variables.variables || []).filter((v) => !v.key || !sliceSources.has(v.key) || sliceSources.get(v.key).some((sc) => labels.includes(sc)));
  } else {
    varScope = "union";
    screenVars = variables && variables.variables || [];
  }
  const screenVarsByName = /* @__PURE__ */ new Map();
  for (const v of screenVars) {
    if (!v || !v.name) continue;
    if (!screenVarsByName.has(v.name)) screenVarsByName.set(v.name, []);
    const list = screenVarsByName.get(v.name);
    if (!list.some((x) => x.key && x.key === v.key || !x.key && !v.key && x.collection === v.collection)) list.push(v);
  }
  const screenVarByName = new Map([...screenVarsByName].map(([n, l]) => [n, l[0]]));
  const shortKey = (v) => v && typeof v.key === "string" && v.key ? v.key.slice(0, 8) + "\u2026" : null;
  const fromWhere = (v) => {
    const sc = v && v.key && sliceSources && sliceSources.get(v.key);
    return sc && sc.length ? ` (from ${sc.join(", ")})` : "";
  };
  function flatten(v) {
    const out = {};
    for (const [mode, val] of Object.entries(v && v.values || {})) {
      out[mode] = val && typeof val === "object" ? val.aliasOf != null ? "-> " + val.aliasOf : JSON.stringify(val) : String(val);
    }
    return out;
  }
  function valueSet(v) {
    return new Set(Object.values(flatten(v)));
  }
  function sameResolution(a, b) {
    const fa = flatten(a), fb = flatten(b);
    const shared = Object.keys(fa).filter((m) => m in fb);
    if (shared.length) return shared.every((m) => fa[m] === fb[m]);
    const sa = valueSet(a), sb = valueSet(b);
    if (!sa.size || !sb.size) return null;
    for (const x of sa) if (sb.has(x)) return null;
    return false;
  }
  if (tokens && screenVarByName.size) {
    const collisions = [], missing = [];
    for (const [name, list] of screenVarsByName) {
      const dv = dsVarByName.get(name);
      if (!dv) {
        let near = null;
        for (const dname of dsVarByName.keys()) if (norm(dname) === norm(name) && dname !== name) {
          near = dname;
          break;
        }
        if (usedTokenNames.has(name) || near) missing.push({ name, near });
        continue;
      }
      for (const sv of list) {
        if (sameResolution(sv, dv) === false) {
          collisions.push({ name, key: sv.key, twins: list, sv, screen: flatten(sv), designSystem: flatten(dv), usedAt: (usedTokenNames.get(name) || []).slice(0, 3) });
        }
      }
    }
    const dsByNorm = /* @__PURE__ */ new Map();
    for (const [dname, dv] of dsVarByName) {
      const k = norm(dname);
      if (!dsByNorm.has(k)) dsByNorm.set(k, []);
      dsByNorm.get(k).push({ name: dname, v: dv });
    }
    for (const [name, list] of screenVarsByName) {
      if (dsVarByName.has(name)) continue;
      for (const cand of dsByNorm.get(norm(name)) || []) {
        for (const sv of list) {
          if (sameResolution(sv, cand.v) === false) {
            collisions.push({ name, key: sv.key, twins: list, sv, alsoKnownAs: cand.name, screen: flatten(sv), designSystem: flatten(cand.v), usedAt: (usedTokenNames.get(name) || []).slice(0, 3) });
          }
        }
      }
    }
    const scopeNote = varScope === "own" ? "" : varScope === "union-by-source" ? " (read from the merged variables.json, restricted to the variables its slice records for this screen \u2014 pass the screen's .vars.json to be exact)" : " (read from the MERGED variables.json: this screen's own .vars.json was not available, so this may be another screen's variable \u2014 check its key)";
    for (const c of collisions) {
      const twinNote = c.twins.length > 1 ? ` This screen's own variables include ${c.twins.length} DIFFERENT variables called '${c.name}': ` + c.twins.map((t) => `${shortKey(t) ? "key " + shortKey(t) : "'" + (t.collection || "") + "'"} = ${JSON.stringify(flatten(t))}${fromWhere(t)}`).join(" vs ") + ` \u2014 only the one(s) listed as colliding differ from the design system.` : "";
      push(
        "blocker",
        "token-name-collision",
        // Both subjects are named, whether the names are identical or only near-identical (livetest-3 #326).
        `The screen's '${c.name}'${shortKey(c.sv) ? ` (key ${shortKey(c.sv)})` : ""} and the design system's '${c.alsoKnownAs || c.name}' ${c.alsoKnownAs ? "differ only by case or punctuation" : "share a name"} but resolve DIFFERENTLY: screen ${JSON.stringify(c.screen)} vs design system ${JSON.stringify(c.designSystem)}` + (Object.keys(c.screen).some((m) => m in c.designSystem) ? ". " : " \u2014 no mode name is shared and the two value sets are disjoint. ") + `Slugging the name onto the existing token would silently apply the wrong value \u2014 namespace the screen's copy, or confirm which library is authoritative.` + twinNote + scopeNote,
        { token: c.name, key: c.key, alsoKnownAs: c.alsoKnownAs, screenValue: c.screen, designSystemValue: c.designSystem, usedAt: c.usedAt, scope: varScope }
      );
    }
    if (variables && varScope !== "union") {
      const mine = new Set(screenVars.map((v) => v.key).filter(Boolean));
      const unionByName = /* @__PURE__ */ new Map();
      for (const v of variables && variables.variables || []) {
        if (!v || !v.name || !v.key) continue;
        if (!unionByName.has(v.name)) unionByName.set(v.name, /* @__PURE__ */ new Map());
        unionByName.get(v.name).set(v.key, v);
      }
      for (const [name, byKey] of unionByName) {
        if (byKey.size < 2) continue;
        const all = [...byKey.values()];
        const others = all.filter((v) => !mine.has(v.key));
        if (!others.length) continue;
        if (new Set(all.flatMap((v) => Object.values(flatten(v)))).size <= 1) continue;
        if (all.every((v) => JSON.stringify(flatten(v)) === JSON.stringify(flatten(all[0])))) continue;
        const ours = all.filter((v) => mine.has(v.key));
        push(
          "info",
          "token-name-collision-elsewhere",
          `'${name}' is ${all.length} different variables in the merged variables.json \u2014 ` + all.map((v) => `key ${shortKey(v)} = ${JSON.stringify(flatten(v))}${fromWhere(v)}`).join(" vs ") + ". " + (ours.length ? `THIS screen's own variables carry only key ${ours.map(shortKey).join(", ")}, so the ambiguity belongs to ${[...new Set(others.flatMap((v) => sliceSources && sliceSources.get(v.key) || []))].join(", ") || "another screen"} \u2014 do not change this screen's value to match it.` : `THIS screen carries none of them.`) + ` Generate this screen's theme from its own .vars.json (or design-system/tokens.json), not from the union.`,
          { token: name, keys: all.map((v) => v.key), mine: ours.map((v) => v.key) }
        );
      }
    }
    if (missing.length) {
      push(
        "warning",
        "token-absent-from-design-system",
        `${missing.length} token name(s) the screen binds do not exist in the design-system export` + (missing.some((m) => m.near) ? ` (${missing.filter((m) => m.near).length} differ from a design-system name only by case or punctuation \u2014 e.g. ` + missing.filter((m) => m.near).slice(0, 2).map((m) => `'${m.name}' vs '${m.near}'`).join(", ") + ")" : "") + `: ${missing.slice(0, 8).map((m) => "'" + m.name + "'").join(", ")}${missing.length > 8 ? ", \u2026" : ""}. Build these as literals with a recorded decision \u2014 do not invent a design-system token for them.`,
        { tokens: missing }
      );
    }
  }
  if (variables || varScope === "own") {
    const dangling = [];
    for (const name of usedTokenNames.keys()) {
      if (screenVarByName.has(name) || dsVarByName.has(name)) continue;
      dangling.push(name);
    }
    if (dangling.length) {
      push(
        "warning",
        "unresolvable-token",
        `${dangling.length} token name(s) are bound by a node but defined in NEITHER design/variables.json nor the design-system export: ${dangling.slice(0, 8).map((n) => "'" + n + "'").join(", ")}${dangling.length > 8 ? ", \u2026" : ""}. Re-pull the screen (variables.json now merges, so nothing is lost) or treat the node's raw value as authoritative.`,
        { tokens: dangling }
      );
    }
  }
  let rekey = null;
  const coverage = { instances: instances.length, distinct: 0, matchedByKey: 0, matchedByLocalKey: 0, matchedByName: 0, ambiguousName: 0, unmatched: 0, pct: null, localPct: null, entries: [] };
  const localComps = components && components.components || [];
  const localKeys = new Set(localComps.map((c) => c.key).filter((k) => !!k));
  const catalog = localComps.concat(componentsLibrary && componentsLibrary.components || []);
  if (!catalog.length) {
    notChecked.push("component coverage \u2014 no components.local.json was given, so every instance counts as new by default.");
  } else if (!instances.length) {
    notChecked.push("component coverage \u2014 the screen export contains no INSTANCE nodes to compare.");
  } else {
    const byKey = /* @__PURE__ */ new Map();
    const byName = /* @__PURE__ */ new Map();
    for (const c of catalog) {
      if (c.key) byKey.set(c.key, c);
      const k = norm(c.name);
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(c);
    }
    const distinct = /* @__PURE__ */ new Map();
    for (const i of instances) {
      const id = i.setKey || i.key || "name:" + norm(i.setName);
      if (!distinct.has(id)) distinct.set(id, Object.assign({ count: 0 }, i));
      distinct.get(id).count++;
    }
    coverage.distinct = distinct.size;
    for (const i of distinct.values()) {
      const byKeyHit = i.setKey && byKey.get(i.setKey) || i.key && byKey.get(i.key);
      if (byKeyHit) {
        coverage.matchedByKey++;
        const local = !!byKeyHit.key && localKeys.has(byKeyHit.key);
        if (local) coverage.matchedByLocalKey++;
        coverage.entries.push({ setName: i.setName, key: i.setKey || i.key, matchedBy: "key", scope: local ? "local" : "library", verified: true, catalogName: byKeyHit.name, instances: i.count });
        continue;
      }
      const cands = byName.get(norm(i.setName)) || [];
      let best = null;
      for (const c of cands) {
        const props = Object.keys(c.props || {}).map((p) => norm(String(p).split("#")[0]));
        const want = i.propNames.map((p) => norm(String(p).split("#")[0]));
        const hit = want.filter((p) => props.includes(p)).length;
        const score = want.length ? hit / want.length : props.length ? 0 : 0.5;
        if (!best || score > best.score) best = { c, score, hit, of: want.length };
      }
      if (best && cands.length > 1) {
        coverage.ambiguousName++;
        coverage.entries.push({ setName: i.setName, key: i.setKey || i.key, matchedBy: null, ambiguous: true, candidates: cands.length, instances: i.count });
      } else if (best && (best.score >= 0.5 || cands.length === 1)) {
        coverage.matchedByName++;
        coverage.entries.push({
          setName: i.setName,
          key: i.setKey || i.key,
          matchedBy: "name",
          verified: false,
          catalogName: best.c.name,
          catalogKey: best.c.key,
          propOverlap: `${best.hit}/${best.of}`,
          instances: i.count
        });
      } else {
        coverage.unmatched++;
        coverage.entries.push({ setName: i.setName, key: i.setKey || i.key, matchedBy: null, verified: false, instances: i.count });
      }
    }
    coverage.pct = Math.round(coverage.matchedByKey / coverage.distinct * 100);
    coverage.localPct = Math.round(coverage.matchedByLocalKey / coverage.distinct * 100);
    rekey = localComps.length ? matchByNameAndSignature(visible, components, componentsLibrary) : null;
    const rekeyed = !!rekey && coverage.localPct <= WRONG_CATALOG_PCT && isRekeyed(rekey);
    coverage.rekey = rekey ? Object.assign({ rekeyed }, rekey.summary) : null;
    const proposedNames = new Set(rekeyed ? rekey.proposals.map((r) => r.name) : []);
    const buckets = { localKey: 0, libraryKey: 0, proposed: 0, nameOnly: 0, ambiguous: 0, newWork: 0 };
    for (const e of coverage.entries) {
      const b = e.matchedBy === "key" ? e.scope === "local" ? "localKey" : "libraryKey" : proposedNames.has(e.setName) ? "proposed" : e.matchedBy === "name" ? "nameOnly" : e.ambiguous ? "ambiguous" : "newWork";
      e.bucket = b;
      buckets[b]++;
    }
    coverage.buckets = buckets;
    const visibleSets = new Set(instances.map((i) => i.setKey || i.key || "name:" + norm(i.setName)));
    const hiddenOnly = /* @__PURE__ */ new Set();
    const everyInstance = (n) => {
      if (!n || typeof n !== "object") return;
      if (n.type === "INSTANCE" && n.mainComponent) {
        const mc = n.mainComponent, id = mc.setKey || mc.key || "name:" + norm(mc.setName || mc.name);
        if (!visibleSets.has(id)) hiddenOnly.add(id);
      }
      for (const c of n.children || []) everyInstance(c);
    };
    for (const s of screens) for (const root of screenRoots(s.doc)) everyInstance(root);
    coverage.hiddenOnly = hiddenOnly.size;
    if (rekeyed) {
      const s = rekey.summary, props = rekey.proposals;
      const residual = rekey.rows.filter((r) => !r.match);
      push(
        "blocker",
        "catalog-rekeyed",
        `0 of ${s.names} component(s) on this screen resolve to components.local.json by key, but ${s.proposed} of the ${s.withCandidates} whose NAME is in the catalog also match it by prop signature (variant axes + values, prop names + types)${s.remote ? `, and ${s.remote} of the ${s.instances} visible instance(s) say remote:true` : ""}. That is not a foreign library \u2014 it is the SAME components under new keys: one or both Figma files are duplicates (duplicating a file re-mints every component key), or the library was re-published. Proposed matches (confirm each before reuse \u2014 nothing is auto-accepted): ` + props.slice(0, 12).map((r) => `'${r.name}' \u2192 ${r.match.id}${r.evidence === "name+no-props" ? " (no props to compare \u2014 weaker)" : ""}${r.tie === "duplicate-definitions" ? " (duplicate definitions, harmless tie)" : ""}`).join(", ") + (props.length > 12 ? `, \u2026 (${props.length} in all \u2014 see componentProposals)` : "") + `. ${residual.length} name(s) are not in components.local.json` + (buckets.libraryKey + buckets.nameOnly ? ` \u2014 of the table's rows, ${buckets.libraryKey + buckets.nameOnly} are third-party components.library.json matches and ${buckets.newWork} new work` : ` and stay new work`) + (residual.length ? ` (${residual.slice(0, 5).map((r) => `'${r.name}'`).join(", ")}${residual.length > 5 ? ", \u2026" : ""})` : "") + `. To use them: show the user the list, set "confirmed": true on each accepted entry of componentProposals in this report's JSON, then run \`map-bootstrap.js <components.local.json> --out design/codeconnect.local.json --from-proposals <this report>.json\` \u2014 it stubs ONLY the confirmed ones, keyed by the screen's own instance key.`,
        { rekey: s, proposals: props.length }
      );
    } else if (coverage.localPct <= WRONG_CATALOG_PCT) {
      push(
        "blocker",
        "catalog-covers-nothing",
        `${coverage.matchedByLocalKey} of ${coverage.distinct} component(s) used on this screen (${coverage.localPct}%) are in components.local.json by key \u2014 the catalog you exported is not the library this screen is built from. ` + (coverage.matchedByKey > coverage.matchedByLocalKey ? `${coverage.matchedByKey - coverage.matchedByLocalKey} more match components.library.json, which only means both files consume the same third-party set. ` : "") + (coverage.matchedByName ? `${coverage.matchedByName} match BY NAME only and are marked unverified: a lead, not a mapping. ` : "") + (coverage.ambiguousName ? `${coverage.ambiguousName} more share a name with SEVERAL catalog entries ('Component 1'-class names) and are deliberately left unmatched. ` : "") + `A "318/318 mapped" count measures the catalog against itself and means nothing here. To find the owning library: open any instance in Figma and use right-click > "Go to main component" \u2014 it jumps to the file that defines it. Then connect that file and run \`dtwin pull --as-library "<name>"\`. Until then every instance is correctly a \`verdict:"new"\` build, not a port of the catalog.` + (rekey && rekey.summary.withCandidates ? ` (Checked for the duplicated-file case too: only ${rekey.summary.proposedWithSignature} of the ${rekey.summary.withCandidates} name twin(s) also agree on prop signature \u2014 too few to call it the same library under new keys.)` : ""),
        { coverage: { distinct: coverage.distinct, byLocalKey: coverage.matchedByLocalKey, byKey: coverage.matchedByKey, byName: coverage.matchedByName, ambiguousName: coverage.ambiguousName, localPct: coverage.localPct } }
      );
    } else if (coverage.localPct < 100) {
      push(
        "warning",
        "partial-catalog-coverage",
        `${coverage.matchedByLocalKey} of ${coverage.distinct} component(s) on this screen (${coverage.localPct}%) resolve to components.local.json by key` + (coverage.matchedByName ? `, ${coverage.matchedByName} more by name only (unverified)` : "") + `. The rest are new work: ${coverage.entries.filter((e) => !e.matchedBy).slice(0, 6).map((e) => "'" + e.setName + "'").join(", ")}.`,
        { coverage: { distinct: coverage.distinct, byLocalKey: coverage.matchedByLocalKey, byKey: coverage.matchedByKey, byName: coverage.matchedByName, localPct: coverage.localPct } }
      );
    } else {
      push("info", "catalog-covers-screen", `all ${coverage.distinct} component(s) on this screen resolve to components.local.json by key.`, {});
    }
    const named = coverage.entries.filter((e) => e.matchedBy === "name" && !proposedNames.has(e.setName));
    if (named.length) {
      push(
        "info",
        "name-matched-components",
        `${named.length} component(s) have no key in the catalog but DO have an exact name twin there: ` + named.slice(0, 10).map((e) => `'${e.setName}' (props ${e.propOverlap})`).join(", ") + (named.length > 10 ? `, \u2026` : "") + `. Mapped BY NAME, UNVERIFIED \u2014 confirm one with "Go to main component" before reusing any of their code; if that one instance points at the catalog's file, the rest almost certainly do too.`,
        { components: named.map((e) => ({ setName: e.setName, catalogName: e.catalogName, catalogKey: e.catalogKey, propOverlap: e.propOverlap, verified: false })) }
      );
    }
    const amb = coverage.entries.filter((e) => e.ambiguous && !proposedNames.has(e.setName));
    if (amb.length) {
      push(
        "warning",
        "ambiguous-component-name",
        `${amb.length} component(s) share their name with SEVERAL catalog entries and were left unmatched on purpose: ` + amb.slice(0, 8).map((e) => `'${e.setName}' (${e.candidates} candidates)`).join(", ") + (amb.length > 8 ? ", \u2026" : "") + `. Generic names like these are what the design system's own hygiene report flags as duplicated/unnamed \u2014 binding code to one of them by name would be a guess with a 1-in-${amb[0].candidates} chance.`,
        { components: amb.map((e) => ({ setName: e.setName, candidates: e.candidates })) }
      );
    }
  }
  if (fonts.size > 1) {
    const sorted = [...fonts.entries()].sort((a, b) => b[1] - a[1]);
    const [mainFamily, mainCount] = sorted[0];
    const strays = sorted.slice(1);
    const total = sorted.reduce((n, [, c]) => n + c, 0);
    push(
      "warning",
      "font-family-stray",
      `${total} text node(s) use ${sorted.length} different font families: ${sorted.map(([f, c]) => `${f} (${c})`).join(", ")}. '${mainFamily}' carries ${mainCount}; the rest are strays \u2014 usually a starter-kit style (Figma's Material 3 kit leaks \`material-theme/*\`) left on a layer. Ask the designer before shipping a second webfont for ${strays.reduce((n, [, c]) => n + c, 0)} node(s).`,
      { families: sorted.map(([family, count2]) => ({ family, count: count2 })) }
    );
  }
  if (stylesText && fonts.size) {
    const dsFamilies = new Set(stylesText.styles.map((s) => s.font).filter((f) => !!f));
    const foreign = [...fonts.keys()].filter((f) => dsFamilies.size && !dsFamilies.has(f));
    if (foreign.length) {
      push(
        "warning",
        "font-not-in-design-system",
        `font ${foreign.map((f) => `'${f}'`).join(", ")} appears on the screen but NO design-system text style uses it (the design system's text styles are all ${[...dsFamilies].join(", ")}). Nothing in the export declares a font file or a webfont for either, so "is it installed and licensed" is a question only the designer can answer.`,
        { fonts: foreign, designSystemFonts: [...dsFamilies] }
      );
    }
  }
  if (stylesText && stylesText.styles && textStyles.size) {
    const dsByName = new Map((stylesText.styles || []).map((s) => [s.name, s]));
    const dsNorm = /* @__PURE__ */ new Map();
    for (const s of stylesText.styles || []) dsNorm.set(norm(s.name), s.name);
    const absent = [], nearMiss = [];
    for (const name of textStyles.keys()) {
      if (dsByName.has(name)) continue;
      const near = dsNorm.get(norm(name));
      if (near) nearMiss.push({ name, near });
      else absent.push(name);
    }
    if (nearMiss.length) {
      push(
        "blocker",
        "text-style-near-miss",
        `${nearMiss.length} text style name(s) differ from a design-system style ONLY by case or punctuation: ` + nearMiss.map((n) => `'${n.name}' vs '${n.near}'`).join(", ") + `. That is the exact near-miss a name-based mapping binds wrongly and silently. Confirm they are the same style before reusing it.`,
        { styles: nearMiss }
      );
    }
    if (absent.length) {
      push(
        "warning",
        "text-style-absent",
        `${absent.length} of ${textStyles.size} text style(s) used on the screen are not in the design-system export: ` + absent.slice(0, 8).map((n) => "'" + n + "'").join(", ") + (absent.length > 8 ? ", \u2026" : "") + ".",
        { styles: absent }
      );
    }
  }
  const absurd = [];
  const seenAbsurd = /* @__PURE__ */ new Set();
  const allVars = (tokens && tokens.variables || []).concat(variables && variables.variables || []);
  for (const v of allVars) {
    for (const [mode, val] of Object.entries(v && v.values || {})) {
      const n = typeof val === "number" ? val : val && typeof val === "object" && "value" in val && typeof val.value === "number" ? val.value : null;
      if (n == null || Math.abs(n) < ABSURD_NUMBER) continue;
      const id = JSON.stringify([v.collection ?? null, v.name, mode]);
      if (seenAbsurd.has(id)) continue;
      seenAbsurd.add(id);
      absurd.push({ name: v.name, collection: v.collection, mode, value: n });
    }
  }
  if (absurd.length) {
    push(
      "warning",
      "sentinel-token-value",
      `${absurd.length} token value(s) are sentinels, not measurements: ` + absurd.slice(0, 4).map((a) => `'${a.name}' = ${a.value} (${a.mode})`).join(", ") + (absurd.length > 4 ? ", \u2026" : "") + `. Figma's "fully rounded" corner exports as a literal 1e9. Emit these as the platform's own idiom (CSS 9999px or 50%, SwiftUI .infinity, Compose CircleShape) \u2014 never as \`${absurd[0].value}px\`.`,
      { tokens: absurd }
    );
  }
  const multiModeColls = [];
  const seenColl = /* @__PURE__ */ new Set();
  const allColls = (tokens && tokens.collections || []).concat(screenColls);
  for (const c of allColls) {
    if (!Array.isArray(c.modes) || c.modes.length <= 1) continue;
    if (seenColl.has(c.name)) continue;
    seenColl.add(c.name);
    multiModeColls.push(c);
  }
  for (const c of multiModeColls) {
    const seen = resolvedModes.get(c.name);
    if (!seen || !seen.size) continue;
    if (seen.size === 1 && c.modes.length > 1) {
      const only = [...seen][0];
      const rest = c.modes.filter((m) => m !== only);
      push(
        "warning",
        "single-mode-export",
        `every exported frame resolved collection '${c.name}' in mode '${only}', but it defines ${c.modes.length} modes (${c.modes.join(", ")}). The other ${rest.length} mode(s) are DERIVED from variable values, never seen rendered \u2014 so any element whose ${only}-mode token has no sensible counterpart (a dark surface token that stays dark in Light) will be mechanically correct and visually broken. Export a frame in ${rest.map((m) => `'${m}'`).join(" / ")} too, or have the designer confirm the derivation before it ships.`,
        { collection: c.name, exportedMode: only, modes: c.modes }
      );
    }
  }
  contrastPerMode(screens, variables, tokens, push, resolvedModes);
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.code.localeCompare(b.code));
  const count = (s) => findings.filter((f) => f.severity === s).length;
  return {
    summary: { blockers: count("blocker"), warnings: count("warning"), info: count("info") },
    coverage,
    // The confirmation list (catalog-rekeyed). Every entry starts unconfirmed; map-bootstrap.ts
    // --from-proposals stubs only the ones a person set "confirmed": true on.
    componentProposals: rekey && coverage.rekey && coverage.rekey.rekeyed ? rekey.proposals.map((r) => ({
      name: r.name,
      instances: r.instances,
      screens: r.screens,
      instanceKeys: r.instanceKeys,
      remote: r.remote,
      catalog: r.match,
      evidence: r.evidence,
      tie: r.tie || null,
      alternatives: r.alternatives,
      reasons: r.reasons,
      confirmed: false
    })) : [],
    componentResidual: rekey && coverage.rekey && coverage.rekey.rekeyed ? rekey.rows.filter((r) => !r.match).map((r) => ({ name: r.name, instances: r.instances, reasons: r.reasons })) : [],
    findings,
    notChecked,
    inputs: {
      screens: screens.map((s) => s.label),
      variables: !!variables,
      tokens: !!tokens,
      components: !!components,
      stylesText: !!stylesText
    }
  };
}
var MIN_CONTRAST = 4.5;
function contrastPerMode(screens, variables, tokens, push, resolvedModes) {
  const defs = /* @__PURE__ */ new Map();
  for (const v of tokens && tokens.variables || []) if (v.name) defs.set(v.name, v);
  for (const v of variables && variables.variables || []) if (v.name) defs.set(v.name, v);
  if (!defs.size) return;
  function resolve(name, mode, depth) {
    if (depth > 8) return null;
    const v = defs.get(name);
    if (!v || !v.values) return null;
    let val = v.values[mode];
    if (val === void 0) {
      const keys = Object.keys(v.values);
      if (keys.length !== 1) return null;
      val = v.values[keys[0]];
    }
    if (typeof val === "string") return parseHex(val);
    if (val && typeof val === "object" && val.aliasOf) return resolve(val.aliasOf, mode, depth + 1);
    return null;
  }
  const modes = /* @__PURE__ */ new Set();
  const allColls = (tokens && tokens.collections || []).concat(variables && variables.collections || []);
  for (const c of allColls) {
    for (const m of c && c.modes || []) modes.add(m);
  }
  const rendered = /* @__PURE__ */ new Set();
  for (const set of (resolvedModes || /* @__PURE__ */ new Map()).values()) for (const m of set) rendered.add(m);
  for (const m of rendered) modes.delete(m);
  if (!modes.size) return;
  if (!rendered.size) return;
  const pairs = /* @__PURE__ */ new Map();
  for (const s of screens) {
    for (const root of screenRoots(s.doc)) {
      walkWithBg(root, null, (n, bgToken) => {
        if (n.type !== "TEXT" || !bgToken) return;
        const fg = n.tokens && (n.tokens.fills || n.tokens.textRangeFills) || (n.fills || []).map((f) => f && f.tokens && f.tokens.color).find(Boolean);
        if (!fg || typeof fg !== "string") return;
        const key = fg + "|" + bgToken;
        if (!pairs.has(key)) pairs.set(key, { fg, bg: bgToken, nodes: [], sample: n.name });
        if (pairs.get(key).nodes.length < 4) pairs.get(key).nodes.push(n.id);
      });
    }
  }
  if (!pairs.size) return;
  const failures = [];
  for (const p of pairs.values()) {
    for (const mode of modes) {
      const fg = resolve(p.fg, mode, 0);
      const bg = resolve(p.bg, mode, 0);
      if (!fg || !bg) continue;
      const r = contrastRatio(fg, bg);
      if (r >= MIN_CONTRAST) continue;
      failures.push({ mode, fg: p.fg, bg: p.bg, ratio: Number(r.toFixed(2)), nodes: p.nodes, sample: p.sample });
    }
  }
  if (!failures.length) return;
  const byMode = /* @__PURE__ */ new Map();
  for (const f of failures) {
    if (!byMode.has(f.mode)) byMode.set(f.mode, []);
    byMode.get(f.mode).push(f);
  }
  for (const [mode, list] of byMode) {
    push(
      "blocker",
      "derived-mode-contrast",
      `in mode '${mode}', ${list.length} text/background token pair(s) fall below WCAG AA (${MIN_CONTRAST}:1): ` + list.slice(0, 4).map((f) => `'${f.fg}' on '${f.bg}' = ${f.ratio}:1 (e.g. ${f.sample})`).join("; ") + (list.length > 4 ? ", \u2026" : "") + `. No frame was exported in '${mode}', so this mode is DERIVED from variable values and nobody has ever seen it rendered \u2014 the derivation is mechanically correct and visually broken. Export a '${mode}' frame, or get the designer to say which token each of these should use there. Do not invent an override and call it done.`,
      { mode, pairs: list }
    );
  }
}
function walkWithBg(node, bgToken, fn) {
  if (!node || typeof node !== "object") return;
  if (hiddenSelf(node)) return;
  let bg = bgToken;
  const own = node.tokens && node.tokens.fills || (node.fills || []).map((f) => f && f.tokens && f.tokens.color).find(Boolean);
  if (own && typeof own === "string" && node.type !== "TEXT") bg = own;
  fn(node, bg);
  for (const c of node.children || []) walkWithBg(c, bg, fn);
}
if (false) {
  const argv = process.argv.slice(2);
  const USAGE = `usage: ${scriptCmd2("cross-check")} <screen.json>... [--design-system design/design-system] [--variables design/variables.json] [--out design/audit/<screen>.cross] [--json] [--gate]`;
  const OPTIONS = {
    "design-system": { type: "string" },
    variables: { type: "string" },
    out: { type: "string" },
    json: { type: "boolean" },
    gate: { type: "boolean" },
    help: { type: "boolean", short: "h" }
  };
  const { values: flags, positionals: files } = cliParse2("cross-check", argv, OPTIONS, USAGE, 2, () => parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }));
  if (flags.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (!files.length) {
    console.error(USAGE);
    process.exit(2);
  }
  const { "design-system": dsDir, variables: varsFile, out } = flags;
  const jsonOnly = !!flags.json, gate = !!flags.gate;
  const ctx = variablesContext2(files, varsFile);
  for (const bad of ctx.invalid) console.error(`error  variables: '${bad.file}' ${bad.error}`);
  if (ctx.invalid.length) process.exit(2);
  const screens = files.map((f, i) => ({ doc: readDocFile2(f, "screen export", isScreenDoc2), label: path.basename(f, ".json"), vars: ctx.own[i] }));
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
    tokens: readOptionalDoc2(path.join(dsBase, "tokens.json"), "design-system tokens", isTokensDoc2),
    components: readOptionalDoc2(path.join(dsBase, "components.local.json"), "component catalog", isComponentsCatalog2),
    componentsLibrary: readOptionalDoc2(path.join(dsBase, "components.library.json"), "library component catalog", isComponentsCatalog2),
    stylesText: readOptionalDoc2(path.join(dsBase, "styles.text.json"), "text styles", isTextStylesDoc2)
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
import { parseArgs as parseArgs2 } from "node:util";
var SEVERITY_ORDER2 = { blocker: 0, warning: 1, info: 2 };
var TOUCH_MIN = { web: 24, ios: 44, android: 48, "react-native": 44, flutter: 48 };
var PLATFORMS = Object.keys(TOUCH_MIN);
var AUDIT_CATEGORIES = ["color", "typography", "spacing", "radius", "effects"];
var isPlatform = (p) => typeof p === "string" && PLATFORMS.includes(p);
var over = (fg, bg) => ({
  r: fg.r * fg.a + bg.r * (1 - fg.a),
  g: fg.g * fg.a + bg.g * (1 - fg.a),
  b: fg.b * fg.a + bg.b * (1 - fg.a),
  a: 1
});
function toLab(c) {
  const lin = (v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const R = lin(c.r), G = lin(c.g), B = lin(c.b);
  const f = (t) => t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
  const x = f((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047);
  const y = f(R * 0.2126 + G * 0.7152 + B * 0.0722);
  const z = f((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
var labDist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
var deltaE = (a, b) => labDist(toLab(a), toLab(b));
var INTERACTIVE_NAME = /\b(button|btn|cta|link|tab|chip|toggle|switch|checkbox|check box|radio|input|text ?field|textfield|search|select|dropdown|menu item|icon ?button|close|back|segmented|stepper|slider)\b/i;
var TAP_TRIGGER = /click|press|tap|drag/;
var CHROME_TOP = /status ?bar|9:41|battery|signal|dynamic island|notch/i;
var CHROME_BOTTOM = /home ?indicator|gesture ?bar|navigation ?handle/i;
var STATE_KEYS = ["loading", "empty", "error"];
var STATE_WORDS = {
  loading: /\b(loading|skeleton|spinner|shimmer|placeholder)\b/i,
  empty: /\b(empty|no results?|no data|nothing (here|found)|zero ?state)\b/i,
  error: /\b(error|failed|failure|offline|retry|something went wrong|not found|404|500)\b/i
};
var CONTROL_STATES = ["hover", "pressed", "focus", "disabled", "error", "selected", "loading"];
var STATE_SYNONYMS = {
  hover: /^(hover|hovered|mouse ?over)$/,
  pressed: /^(pressed|press|active|tapped|down)$/,
  focus: /^(focus|focused|focus[- ]visible|keyboard ?focus)$/,
  disabled: /^(disabled|inactive|is ?disabled)$/,
  // Not "danger"/"destructive": those are button STYLE variants (a red button), not an error state.
  error: /^(error|invalid|has ?error|is ?invalid)$/,
  selected: /^(selected|checked|on|active|current|is ?selected)$/,
  loading: /^(loading|busy|in ?progress|is ?loading)$/
};
function requiredStates(kind, platform) {
  const pointer = platform === "web";
  switch (kind) {
    case "button":
      return pointer ? ["hover", "pressed", "focus", "disabled"] : ["pressed", "disabled"];
    case "input":
      return ["focus", "error", "disabled"];
    case "toggle":
      return ["selected", "disabled"];
    case "tab":
      return ["selected"];
    case "link":
      return pointer ? ["hover", "focus"] : ["pressed"];
    default:
      return [];
  }
}
function controlKind(name) {
  const s = String(name || "");
  if (/\b(input|text ?field|textfield|search|select|dropdown|textarea)\b/i.test(s)) return "input";
  if (/\b(checkbox|check box|radio|switch|toggle)\b/i.test(s)) return "toggle";
  if (/\b(tab|tabs|segmented|nav ?item|navigation item)\b/i.test(s)) return "tab";
  if (/\blink\b/i.test(s)) return "link";
  if (/\b(button|btn|cta|icon ?button|chip)\b/i.test(s)) return "button";
  return null;
}
function labelledRoots(doc, label) {
  const exp = isScreenExport(doc) ? doc : null;
  const manifest = exp ? exp.manifest : isLayerFile(doc) ? doc.manifest : void 0;
  return screenRoots(doc).map((tree) => ({ tree, label: exp && exp.screen || tree.name || label, manifest }));
}
var r1 = (v) => Math.round(v * 100) / 100;
var hasTok = (node, ...keys) => !!(node.tokens && keys.some((k) => node.tokens[k] != null));
var unwrap = (d, i) => !d || isScreenDoc(d) ? { doc: d || null, label: `input${i}`, vars: null } : { doc: d.doc || null, label: d.label || `input${i}`, vars: d.vars || null };
function audit(input, opts = {}) {
  const givenPlatform = opts.platform;
  const platformAssumed = !isPlatform(givenPlatform);
  const platform = isPlatform(givenPlatform) ? givenPlatform : "web";
  const gridAssumed = !(opts.grid !== void 0 && opts.grid > 0);
  const grid = gridAssumed || opts.grid === void 0 ? 4 : opts.grid;
  let gridMismatch = null;
  if (gridAssumed) {
    const dsTokens = opts.designSystem && opts.designSystem.tokens;
    const spacingValues = [];
    const colls = dsTokens && dsTokens.collections || [];
    for (const c of colls) {
      if (!/spac|space/i.test(c.name || "")) continue;
      for (const v of c.variables || []) {
        for (const mv of Object.values(v.valuesByMode || v.values || {})) {
          const n = typeof mv === "number" ? mv : typeof mv === "string" && /^-?\d+(\.\d+)?$/.test(mv) ? Number(mv) : null;
          if (n !== null && Number.isFinite(n) && n > 0) spacingValues.push(Math.abs(n));
        }
      }
    }
    if (spacingValues.length >= 2) {
      const gcd2 = (a, b) => b === 0 ? a : gcd2(b, a % b);
      const step = spacingValues.map(Math.round).reduce((a, b) => gcd2(a, b));
      if (step > 0 && step !== grid) gridMismatch = step;
    }
  }
  const docs = (Array.isArray(input) ? input : [input]).map(unwrap);
  const roots = docs.flatMap((d) => labelledRoots(d.doc, d.label));
  const catalog = opts.catalog && Array.isArray(opts.catalog.components) ? opts.catalog.components : [];
  const findings = [];
  const add = (severity, code, message, node, ctx, extra) => findings.push(Object.assign(
    { severity, code, message },
    node ? { nodeId: node.id, nodeName: node.name } : {},
    ctx ? { screen: ctx.label, path: ctx.path } : {},
    extra || {}
  ));
  const binding = { color: [0, 0], typography: [0, 0], spacing: [0, 0], radius: [0, 0], effects: [0, 0] };
  const tally = (cat, bound) => {
    binding[cat][1]++;
    if (bound) binding[cat][0]++;
  };
  const rawColors = /* @__PURE__ */ new Map();
  const usedComponents = /* @__PURE__ */ new Map();
  const stateHits = { loading: [], empty: [], error: [] };
  const annotations = [];
  const hiddenIds = /* @__PURE__ */ new Set();
  for (const root of roots) {
    const m = root.manifest || {};
    if (m.truncated) add("blocker", "export-truncated", `export of '${root.label}' was truncated (${m.truncated} subtree(s) past the depth limit) \u2014 the tree is incomplete; re-export a narrower scope before building`, null, { label: root.label });
    if (m.assetsFailed) add("blocker", "assets-failed", `${m.assetsFailed} asset export(s) failed in '${root.label}' \u2014 those nodes have no file (look for \`geometry\` fallbacks)`, null, { label: root.label });
    if (root.tree.devStatus && root.tree.devStatus !== "ready_for_dev" && root.tree.devStatus !== "completed") {
      add("warning", "not-ready-for-dev", `'${root.label}' dev status is '${String(root.tree.devStatus)}' \u2014 confirm the design is final before building`, root.tree, { label: root.label, path: root.tree.name });
    }
    walk2(root.tree, [], { label: root.label, rootBox: root.tree.box });
  }
  function walk2(node, ancestors, ctx) {
    if (!node || typeof node !== "object") return;
    const path3 = [...ancestors.map((a) => a.name), node.name].join(" > ");
    const here = { label: ctx.label, path: path3 };
    const hiddenBranch = isHidden(node, ancestors.some((a) => hiddenSelf(a)));
    if (Array.isArray(node.annotations)) for (const a of node.annotations) annotations.push({ nodeId: node.id, nodeName: node.name, screen: ctx.label, label: a.label || a.markdown });
    if (node.devStatusNote) annotations.push({ nodeId: node.id, nodeName: node.name, screen: ctx.label, label: `dev note: ${node.devStatusNote}` });
    for (const state of STATE_KEYS) {
      const re = STATE_WORDS[state];
      if (re.test(node.name || "") || node.type === "TEXT" && ancestors.length <= 6 && re.test(node.text || "")) {
        stateHits[state].push({ nodeId: node.id, nodeName: node.name, screen: ctx.label, hidden: !!hiddenBranch });
      }
    }
    if (hiddenBranch) {
      if (node.id) hiddenIds.add(node.id);
      const self = { name: node.name, hidden: true, fills: [], __tappable: false, __beneath: [] };
      for (const child of Array.isArray(node.children) ? node.children : []) walk2(child, [...ancestors, self], ctx);
      return;
    }
    if (node.mainComponent || node.component) {
      const mc = node.mainComponent || {};
      const name = mc.setName || node.component;
      const key = mc.setKey || mc.key || name;
      if (key && !usedComponents.has(key)) usedComponents.set(key, { name, key: mc.setKey || mc.key, remote: !!mc.remote, nodeId: node.id });
    }
    if (node.detachedFrom) add("warning", "detached-instance", `'${node.name}' is a detached component instance \u2014 map it back to the component unless the detach was deliberate`, node, here);
    if (node.missingFont) add("blocker", "missing-font", `'${node.name}' uses a font Figma couldn't load \u2014 the recorded family/weight may not match the render; confirm the font files and license`, node, here);
    if (node.layout && node.layout.mode === "absolute" && Array.isArray(node.children) && node.children.length > 1 && node.type !== "GROUP" && ancestors.length > 0) {
      add("info", "no-auto-layout", `'${node.name}' has no auto layout (${node.children.length} children placed by coordinates) \u2014 infer a flow layout and ask how it should resize`, node, here);
    }
    if (node.layout && Array.isArray(node.layout.padding) && node.layout.padding.length === 4 && node.box && Array.isArray(node.children) && node.children.length) {
      const [padTop, , padBottom] = node.layout.padding;
      const kids = node.children.filter((c) => !!(c && c.box && typeof c.box.h === "number"));
      if (kids.length === node.children.length && kids.length) {
        const direction = node.layout.flexDirection || (node.layout.display === "flex" ? "row" : null);
        const gap = typeof node.layout.gap === "number" ? node.layout.gap : 0;
        let expectedH = null;
        if (direction === "row") expectedH = padTop + padBottom + Math.max(...kids.map((c) => c.box.h));
        else if (direction === "column") expectedH = padTop + padBottom + kids.reduce((s, c) => s + c.box.h, 0) + gap * (kids.length - 1);
        const heightMode = node.heightMode || "fixed";
        const delta = expectedH === null ? 0 : expectedH - node.box.h;
        const overflow = expectedH !== null && delta > 1;
        const hugMismatch = expectedH !== null && heightMode === "hug" && Math.abs(delta) > 1;
        if (overflow || hugMismatch) {
          const how = direction === "row" ? "max child " + Math.max(...kids.map((c) => c.box.h)) : "children sum " + (expectedH - padTop - padBottom);
          const why = heightMode === "hug" ? `heightMode:"hug" means this box's height IS the content height, but its own padding + children compute ${expectedH}, not the declared ${node.box.h}` : `content (padding + children) computes ${expectedH}, which OVERFLOWS the declared box.h=${node.box.h} by ${delta}px`;
          add("warning", "self-inconsistent-geometry", `'${node.name}' declares box.h=${node.box.h} (heightMode:${JSON.stringify(heightMode)}) \u2014 ${why}: ${padTop}+${how}+${padBottom} = ${expectedH}. The export contradicts itself \u2014 decide which number to trust before building.`, node, here, { statedH: node.box.h, expectedH, heightMode });
        }
      }
    }
    if (ancestors.length <= 2 && node.box && ctx.rootBox && platform !== "web") {
      const label = `${node.name || ""} ${node.component || ""} ${node.mainComponent && node.mainComponent.setName || ""}`;
      if (CHROME_TOP.test(label) && node.box.h <= 64) add("warning", "fake-status-bar", `'${node.name}' looks like a drawn status bar \u2014 don't build it; apply the system safe-area/status-bar inset instead`, node, here);
      else if (CHROME_BOTTOM.test(label) && node.box.h <= 40) add("warning", "fake-home-indicator", `'${node.name}' looks like a drawn home indicator/gesture bar \u2014 use the bottom safe-area inset instead`, node, here);
    }
    const isAssetLeaf = !!(node.asset || node.geometry);
    if (!isAssetLeaf && node.type !== "TEXT" && Array.isArray(node.fills)) {
      for (const f of node.fills) {
        if (f.type === "solid") {
          const bound = !!(f.tokens || hasTok(node, "fills") || node.styles && node.styles.fill);
          tally("color", bound);
          if (!bound) noteRaw(f.color, node);
        }
        if (f.type === "gradient" && /DIAMOND/.test(f.kind || "") && platform !== "flutter") add("info", "diamond-gradient", `'${node.name}' uses a diamond gradient \u2014 no native equivalent; use the exported asset or approximate`, node, here);
        if (f.type === "image" && (f.scaleMode === "crop" || f.scaleMode === "tile")) add("info", "image-scale-mode", `'${node.name}' image fill uses scaleMode '${f.scaleMode}' \u2014 not a plain cover/contain; read the crop transform / tile scale`, node, here);
      }
    }
    if (!isAssetLeaf && node.strokes && (node.strokes.align === "outside" || node.strokes.align === "center") && (node.strokes.weight || node.strokes.weights)) {
      const how = { web: "a CSS border is inside the box \u2014 use outline/box-shadow (no layout) or grow the box", ios: "SwiftUI .strokeBorder is inside, .stroke is centered \u2014 pad an overlay for outside", android: "Modifier.border draws inside \u2014 compensate with padding or drawBehind", "react-native": "borderWidth is inside \u2014 wrap or add padding", flutter: "use BorderSide.strokeAlign outside/center" };
      add("info", "stroke-align", `'${node.name}' has a ${node.strokes.align} stroke \u2014 ${how[platform]}; the rendered size differs from box`, node, here);
    }
    if (!isAssetLeaf && node.strokes && Array.isArray(node.strokes.colors)) {
      for (const c of node.strokes.colors) {
        const bound = !!(hasTok(node, "strokes") || node.styles && node.styles.stroke || (node.strokes.paints || []).some((p) => p.tokens));
        tally("color", bound);
        if (!bound) noteRaw(c, node);
      }
    }
    if (node.type === "TEXT") {
      const runs = Array.isArray(node.runs) && node.runs.length ? node.runs : [{ font: node.font, tokens: node.textTokens, textStyle: node.styles && node.styles.text }];
      for (const r of runs) {
        const typoBound = !!(r.textStyle || node.styles && node.styles.text || r.tokens && (r.tokens.fontSize || r.tokens.fontFamily || r.tokens.lineHeight) || node.textTokens && (node.textTokens.fontSize || node.textTokens.fontFamily));
        tally("typography", typoBound);
        if (r.font && r.font.color) {
          const cBound = !!(r.tokens && r.tokens.fills || r.fillStyle || node.textTokens && node.textTokens.fills || hasTok(node, "fills") || node.styles && node.styles.fill);
          tally("color", cBound);
          if (!cBound) noteRaw(r.font.color, node);
        }
      }
      if (!hiddenBranch) textChecks(node, ancestors, here);
    }
    if (node.layout) {
      const L = node.layout;
      const spacing = [];
      if (typeof L.gap === "number") spacing.push(["gap", L.gap, hasTok(node, "itemSpacing")]);
      if (typeof L.rowGap === "number") spacing.push(["rowGap", L.rowGap, hasTok(node, "counterAxisSpacing")]);
      if (typeof L.columnGap === "number") spacing.push(["columnGap", L.columnGap, hasTok(node, "gridColumnGap")]);
      if (Array.isArray(L.padding)) {
        const pad = L.padding;
        ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"].forEach((k, j) => {
          if (pad[j]) spacing.push([k, pad[j], hasTok(node, k)]);
        });
      }
      const offGrid = [];
      for (const [k, v, bound] of spacing) {
        tally("spacing", bound);
        if (v < 0) add("info", "negative-spacing", `'${node.name}' ${k} is ${v} (overlap) \u2014 Compose Arrangement.spacedBy rejects negatives; use offset/overlay`, node, here);
        else if (!bound && (v % grid !== 0 || !Number.isInteger(v))) offGrid.push(`${k}=${v}`);
      }
      if (offGrid.length) add("info", "off-grid-spacing", `'${node.name}' has unbound spacing off the ${grid}px grid (${offGrid.join(", ")}) \u2014 likely drift; fix it in Figma or bind a token. Until then the build uses these values EXACTLY \u2014 it must not round them to the grid`, node, here);
    }
    if (node.radius != null) {
      const vals = typeof node.radius === "number" ? [node.radius] : Object.values(node.radius);
      const bound = hasTok(node, "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius");
      vals.forEach(() => tally("radius", bound));
      if (node.cornerSmoothing && (platform === "android" || platform === "web" || platform === "react-native")) {
        add("info", "corner-smoothing", `'${node.name}' uses corner smoothing ${node.cornerSmoothing} (squircle) \u2014 ${platform} has no native continuous corners; plain radius or a custom shape`, node, here);
      }
    }
    if (Array.isArray(node.effects)) {
      for (const e of node.effects) {
        tally("effects", !!(e.tokens || node.styles && node.styles.effect));
        if ((e.type === "drop_shadow" || e.type === "inner_shadow") && e.spread && (platform === "ios" || platform === "android")) {
          add("info", "shadow-spread", `'${node.name}' shadow has spread ${e.spread} \u2014 ${platform === "ios" ? "SwiftUI .shadow/CALayer have no spread (use shadowPath or a padded shape)" : "Modifier.shadow can't express it (use Compose 1.9+ Modifier.dropShadow)"}`, node, here);
        }
        if (e.type === "background_blur" && (platform === "android" || platform === "react-native")) add("info", "background-blur", `'${node.name}' uses a background blur \u2014 ${platform === "android" ? "no backdrop blur below API 31 / needs window blur or a library" : "needs expo-blur or a native blur view"}`, node, here);
        if ("blurType" in e && e.blurType === "progressive") add("info", "progressive-blur", `'${node.name}' uses a progressive blur \u2014 no direct equivalent on any platform; mask a blur with a gradient or use the asset`, node, here);
        if (["noise", "glass", "texture", "shader"].includes(e.type)) add("info", "exotic-effect", `'${node.name}' uses a '${e.type}' effect \u2014 no code equivalent; rasterize via the exported asset if it's load-bearing`, node, here);
      }
    }
    if (node.blendMode && (platform === "android" || platform === "react-native")) add("info", "blend-mode", `'${node.name}' uses blend mode '${node.blendMode}' \u2014 limited support on ${platform}; flag or bake into an asset`, node, here);
    const tappable = !hiddenBranch && isTappable(node);
    if (tappable && node.box && !ancestors.some((a) => a.__tappable)) {
      const min = TOUCH_MIN[platform];
      if (node.box.w < min || node.box.h < min) {
        add("warning", "small-touch-target", `'${node.name}' is ${node.box.w}\xD7${node.box.h} \u2014 below the ${min}\xD7${min} ${platform} minimum; expand the hit area (padding/hitSlop/contentShape) even if the visual stays small`, node, here, { size: { w: node.box.w, h: node.box.h }, min });
      }
    }
    if (Array.isArray(node.children)) {
      const stacks = !node.layout || node.layout.mode === "absolute";
      const beneath = [];
      const self = { name: node.name, hidden: node.hidden, fills: node.fills, __tappable: tappable, __beneath: beneath };
      const chain = [...ancestors, self];
      for (const child of node.children) {
        self.__beneath = stacks || child.absolute ? beneath : [];
        walk2(child, chain, ctx);
        if (!child.hidden && Array.isArray(child.fills)) beneath.push(...child.fills);
      }
    }
  }
  function isTappable(node) {
    if (Array.isArray(node.reactions) && node.reactions.some((r) => TAP_TRIGGER.test(r.trigger || ""))) return true;
    const compName = node.mainComponent && node.mainComponent.setName || node.component || "";
    if (node.type === "INSTANCE" && controlKind(compName)) return true;
    return (node.type === "INSTANCE" || node.type === "FRAME" || node.type === "COMPONENT") && INTERACTIVE_NAME.test(node.name || "") && !/\b(group|container|list|bar|section|row)s?\b/i.test(node.name || "");
  }
  function noteRaw(hex, node) {
    const h = String(hex || "").toLowerCase();
    const rgb = parseHex(h);
    if (!rgb) return;
    const e = rawColors.get(h) || { count: 0, nodeId: node.id, nodeName: node.name, rgb };
    e.count++;
    rawColors.set(h, e);
  }
  function textChecks(node, ancestors, here) {
    const font = node.font || {};
    if (!node.autoResize && !node.truncate && !node.maxLines) {
      add("warning", "fixed-size-text", `'${node.name}' is a fixed-size text box with no truncation rule \u2014 it will clip under font scaling or longer translations; decide wrap / truncate / grow`, node, here);
    }
    const fg = parseHex(font.color);
    if (!fg) return;
    let bg = null, complex = false;
    for (const a of ancestors) {
      const layers = [...Array.isArray(a.fills) ? a.fills : [], ...a.__beneath || []];
      for (const f of layers) {
        if (f.type === "solid") {
          const c = parseHex(f.color);
          if (!c) continue;
          bg = bg ? over(c, bg) : c.a >= 1 ? c : over(c, { r: 255, g: 255, b: 255, a: 1 });
          if (c.a >= 1) complex = false;
        } else if (f.type === "gradient" || f.type === "image" || f.type === "video") {
          complex = true;
        }
      }
    }
    const size = typeof font.size === "number" ? font.size : null;
    const bold = (font.weightValue || 0) >= 700 || /bold|black|heavy/i.test(font.weight || "");
    const large = size != null && (size >= 24 || size >= 18.66 && bold);
    const need = large ? 3 : 4.5;
    if (complex) {
      add("info", "contrast-manual", `'${node.name}' sits on a gradient/image \u2014 check text contrast manually (needs ${need}:1)`, node, here);
      return;
    }
    const assumed = !bg;
    const base = bg || { r: 255, g: 255, b: 255, a: 1 };
    const ratio = contrastRatio(over(fg, base), base);
    if (ratio < need) {
      add(assumed ? "info" : "warning", "low-contrast", `'${node.name}' text contrast ${r1(ratio)}:1 is below WCAG AA ${need}:1 (${large ? "large" : "normal"} text, ${font.color} on ${assumed ? "an assumed white page" : "its background"})`, node, here, { ratio: r1(ratio), required: need });
    }
  }
  const raws = [...rawColors.entries()].map(([hex, e]) => ({ hex, ...e })).filter((x) => x.rgb.a >= 1);
  const labs = raws.map((x) => toLab(x.rgb));
  const seen = /* @__PURE__ */ new Set();
  for (let a = 0; a < raws.length; a++) {
    if (seen.has(raws[a].hex)) continue;
    const cluster = [raws[a]];
    for (let b = a + 1; b < raws.length; b++) {
      if (!seen.has(raws[b].hex) && labDist(labs[a], labs[b]) < 3) {
        cluster.push(raws[b]);
        seen.add(raws[b].hex);
      }
    }
    if (cluster.length > 1) add("info", "near-duplicate-colors", `unbound colors ${cluster.map((c) => `${c.hex}\xD7${c.count}`).join(", ")} are visually indistinguishable (\u0394E<3) \u2014 probably one token`, null, null, { colors: cluster.map((c) => c.hex) });
  }
  const components = [];
  const byKey = /* @__PURE__ */ new Map(), byName = /* @__PURE__ */ new Map();
  for (const c of catalog) {
    if (c.key) byKey.set(c.key, c);
    if (c.name) byName.set(c.name, c);
  }
  const candidates = usedComponents.size ? [...usedComponents.values()].map((u) => ({ use: u, def: u.key && byKey.get(u.key) || (u.name === void 0 ? void 0 : byName.get(u.name)) })) : catalog.filter((c) => c.type === "COMPONENT_SET" || c.type === "COMPONENT").map((c) => ({ use: { name: c.name }, def: c }));
  for (const { use, def } of candidates) {
    const kind = controlKind(use.name) || def && controlKind(def.name);
    if (!kind) continue;
    const need = requiredStates(kind, platform);
    if (!def) {
      components.push({ name: use.name ?? "", kind, known: false, present: [], missing: [], note: "not in the component catalog \u2014 states unknown" });
      continue;
    }
    const values = [];
    for (const p of Object.values(def.props || {})) {
      if (p.type === "VARIANT" && Array.isArray(p.options)) values.push(...p.options);
      if (p.type === "BOOLEAN") values.push(String(p.key || "").split("#")[0]);
    }
    const norm2 = values.map((v) => String(v).trim().toLowerCase());
    const present = CONTROL_STATES.filter((s) => norm2.some((v) => STATE_SYNONYMS[s].test(v)));
    const missing = need.filter((s) => !present.includes(s));
    const sampled = !!(use.remote || def.remote);
    components.push({ name: def.name, kind, known: true, sampled, present, missing });
    if (missing.length) {
      add(sampled ? "info" : "warning", "missing-component-states", `${kind} '${def.name}' has no ${missing.join("/")} state${missing.length > 1 ? "s" : ""} in its variants${sampled ? " (library component \u2014 props are sampled, so this may be incomplete rather than missing)" : ""} \u2014 ask the designer or derive from tokens, and say so`, null, null, { component: def.name, missing });
    }
  }
  const stateOf = (s) => stateHits[s].length ? "designed" : "not-found";
  const screenStates = { loading: stateOf("loading"), empty: stateOf("empty"), error: stateOf("error") };
  const screenStatesScope = { rootsAudited: roots.length, singleFrame: roots.length === 1 };
  const bindingOf = (k) => {
    const [b, t] = binding[k];
    return { bound: b, total: t, pct: t ? Math.round(b / t * 100) : null };
  };
  const tokenBinding = { color: bindingOf("color"), typography: bindingOf("typography"), spacing: bindingOf("spacing"), radius: bindingOf("radius"), effects: bindingOf("effects") };
  for (const k of AUDIT_CATEGORIES) {
    const v = tokenBinding[k];
    if (v.total >= 5 && v.pct !== null && v.pct < 50) add("warning", "low-token-binding", `only ${v.pct}% of ${k} values are bound to tokens/styles (${v.bound}/${v.total}) \u2014 expect to carry raw values through EXACTLY and report each as unbound; do not snap them to the nearest token`, null, null, { category: k });
  }
  const questions = [];
  const STATE_QUESTION = {
    loading: "what shows while data loads (skeleton vs spinner, delay before showing)?",
    empty: "what shows when there's no data (first use vs no results vs cleared)?",
    error: "what shows when a request fails (inline vs full-screen, retry, offline)?"
  };
  for (const s of STATE_KEYS) if (screenStates[s] === "not-found") questions.push(`No ${s} state was found in the exported layers \u2014 ${STATE_QUESTION[s]}`);
  for (const c of components.filter((c2) => c2.missing && c2.missing.length)) questions.push(`'${c.name}' has no ${c.missing.join("/")} design \u2014 use the design-system default, or is there a spec?`);
  if (findings.some((f) => f.code === "fixed-size-text")) questions.push("Several text boxes are fixed-size \u2014 at 200% font scale or in a longer language, should they wrap, truncate (how many lines), or grow?");
  let crossFile = null;
  let hiddenFindingsOmitted = 0;
  if (opts.designSystem || opts.variables) {
    crossFile = crossCheck({
      // Each screen's OWN variables (d.vars — its <Screen>.vars.json) travel with it: the collision
      // check is about the variables THIS screen carries, not the merged union's (livetest-3 #311 —
      // without them this gate raised another screen's `Space 4` blocker against Job Roles).
      screens: docs,
      variables: opts.variables || null,
      sliceSources: opts.sliceSources || null,
      tokens: opts.designSystem && opts.designSystem.tokens || null,
      components: opts.designSystem && opts.designSystem.components || opts.catalog || null,
      componentsLibrary: opts.designSystem && opts.designSystem.componentsLibrary || null,
      stylesText: opts.designSystem && opts.designSystem.stylesText || null
    });
    for (const f of crossFile.findings) {
      if (f.severity === "info") continue;
      if (f.nodeId && hiddenIds.has(f.nodeId)) {
        hiddenFindingsOmitted++;
        continue;
      }
      const { severity, code, message, ...rest } = f;
      findings.push({ severity, code, message, crossFile: true, ...rest });
    }
  } else {
    crossFile = {
      summary: { blockers: 0, warnings: 0, info: 0 },
      findings: [],
      coverage: null,
      notChecked: [
        `the whole cross-FILE pass \u2014 no design system was given. Every token-binding percentage below means "resolves to some variable in this screen's own file", NOT "matches your design system". Re-run with --design-system design/design-system to tell the two apart.`
      ],
      inputs: {}
    };
  }
  findings.sort((a, b) => SEVERITY_ORDER2[a.severity] - SEVERITY_ORDER2[b.severity] || a.code.localeCompare(b.code));
  const count = (s) => findings.filter((f) => f.severity === s).length;
  return {
    platform,
    platformAssumed,
    crossFile,
    grid,
    gridAssumed,
    gridMismatch,
    screenStatesScope,
    screens: roots.map((r) => r.label),
    // The root node id(s) audited — additive, read only by the CLI's finding-315 duplicate-artefact
    // check (P3 round 3): it lets a re-run find an EARLIER report for the same screen under a
    // different name without re-parsing every screen export in the directory.
    nodeIds: roots.map((r) => r.tree && r.tree.id).filter((id) => !!id),
    summary: { blockers: count("blocker"), warnings: count("warning"), info: count("info") },
    hiddenLayers: { nodesSkipped: hiddenIds.size, crossFileFindingsOmitted: hiddenFindingsOmitted },
    tokenBinding,
    components,
    screenStates,
    annotations,
    questions,
    findings
  };
}
function toMarkdown(res) {
  const L = [];
  L.push(`# Design audit \u2014 ${res.screens.join(", ") || "(no screens)"}`, "");
  const gridNote = res.gridAssumed ? res.gridMismatch ? ` *(DEFAULT \u2014 not given; this system's own spacing tokens step by ${res.gridMismatch}px, not ${res.grid}px \u2014 pass \`--grid ${res.gridMismatch}\`)*` : " *(default \u2014 not given)*" : "";
  L.push(`Platform: **${res.platform}**${res.platformAssumed ? " *(ASSUMED \u2014 not given)*" : ""} \xB7 grid ${res.grid}px${gridNote} \xB7 **${res.summary.blockers} blocker(s)**, ${res.summary.warnings} warning(s), ${res.summary.info} info`, "");
  if (res.hiddenLayers && res.hiddenLayers.nodesSkipped) L.push(`*${res.hiddenLayers.nodesSkipped} node(s) on hidden layers (switched off in Figma) were skipped \u2014 they are not built, and no finding below cites one.*`, "");
  if (res.platformAssumed) {
    L.push(
      `> \u26A0\uFE0F **No platform was given, so this audit assumed \`web\`.** Touch-target minimums, shadow`,
      `> spread, blur and blend-mode support all differ per platform \u2014 on the wrong one, every one of`,
      `> those findings is wrong. Confirm it, then re-run with \`--platform ios|android|react-native|flutter\``,
      `> (or write \`design/target.json\`, which both this audit and build-screen read).`,
      ""
    );
  }
  const cf = res.crossFile;
  if (cf) {
    L.push("## Does this screen come from that design system?", "");
    if (cf.coverage && cf.coverage.distinct) {
      const c = cf.coverage;
      L.push(
        `**${c.matchedByLocalKey}/${c.distinct} (${c.localPct}%)** of the components on this screen resolve to \`components.local.json\` **by key**` + (c.matchedByName ? `; ${c.matchedByName} more match by NAME only and are unverified` : "") + (c.ambiguousName ? `; ${c.ambiguousName} share a name with several catalog entries and were left unmatched` : "") + ".",
        ""
      );
      if (c.rekey && c.rekey.rekeyed) {
        L.push(
          `**This is the re-keyed-copy case, not a foreign library:** ${c.rekey.proposed} of the ${c.rekey.withCandidates} component(s) whose name is in the catalog also match it by prop signature. The proposed matches are listed under \`crossFile.componentProposals\` \u2014 confirm them with the user, then \`map-bootstrap.js \u2026 --from-proposals\` stubs exactly those.`,
          ""
        );
      }
    }
    const cfBlock = cf.findings.filter((f) => f.severity !== "info" || f.code === "token-name-collision-elsewhere");
    if (cfBlock.length) {
      for (const f of cfBlock) L.push(`- **${f.severity}** \`${f.code}\` ${f.message}`);
      L.push("");
    } else if (cf.inputs && cf.inputs.tokens) {
      L.push("No cross-file problem found: the screen's tokens, text styles and components all trace to the design system you exported.", "");
    }
    if (cf.notChecked && cf.notChecked.length) {
      L.push("*Not checked \u2014 these are gaps in the INPUT, not clean results:*", "");
      for (const n of cf.notChecked) L.push(`- ${n}`);
      L.push("");
    }
  }
  L.push("## Token binding", "");
  L.push(
    '*"Bound" means the node binds SOME variable \u2014 read it together with the section above, which says whether',
    "that variable is one the design system defines.*",
    "",
    "| Category | Bound | Total | % |",
    "|---|---|---|---|"
  );
  for (const [k, v] of Object.entries(res.tokenBinding)) L.push(`| ${k} | ${v.bound} | ${v.total} | ${v.pct == null ? "\u2013" : v.pct + "%"} |`);
  L.push("", "## Screen states", "");
  const scope = res.screenStatesScope || {};
  if (scope.singleFrame) {
    L.push(
      `*Scope: **one frame** was audited. "not found" below means "not in this frame" \u2014 it does not`,
      `mean the state is missing from the Figma file. Export the other frames to tell the two apart.*`,
      ""
    );
  } else if (scope.rootsAudited !== void 0 && scope.rootsAudited > 1) {
    L.push(`*Scope: ${scope.rootsAudited} frames audited \u2014 "not found" means none of them drew it.*`, "");
  }
  for (const [k, v] of Object.entries(res.screenStates)) {
    L.push(`- ${k}: ${v === "designed" ? "designed" : scope.singleFrame ? "**not in this frame \u2014 ask**" : "**not found \u2014 ask**"}`);
  }
  if (res.components.length) {
    L.push("", "## Component states", "", "| Component | Kind | Present | Missing |", "|---|---|---|---|");
    for (const c of res.components) L.push(`| ${c.name} | ${c.kind} | ${c.present.join(", ") || "\u2013"} | ${c.known ? c.missing.join(", ") || "none" : c.note}${c.sampled ? " (sampled)" : ""} |`);
  }
  for (const sev of ["blocker", "warning", "info"]) {
    const fs6 = res.findings.filter((f) => f.severity === sev);
    if (!fs6.length) continue;
    L.push("", `## ${sev === "blocker" ? "Blockers" : sev === "warning" ? "Warnings" : "Info"} (${fs6.length})`, "");
    for (const f of fs6) L.push(`- \`${f.code}\` ${f.message}${f.nodeId ? ` \u2014 node \`${f.nodeId}\`${f.screen ? ` in ${f.screen}` : ""}` : ""}`);
  }
  if (res.annotations.length) {
    L.push("", "## Designer annotations", "");
    for (const a of res.annotations) L.push(`- **${a.nodeName}** (\`${a.nodeId}\`): ${a.label}`);
  }
  if (res.questions.length) {
    L.push("", "## Questions for the designer", "");
    res.questions.forEach((q, i) => L.push(`${i + 1}. ${q}`));
  }
  return L.join("\n") + "\n";
}
function blockerIds(auditDoc) {
  const findings = auditDoc && typeof auditDoc === "object" && "findings" in auditDoc && Array.isArray(auditDoc.findings) ? auditDoc.findings : [];
  return findings.filter((f) => !!f && typeof f === "object" && "severity" in f && f.severity === "blocker").map((f, i) => `${f.code || "blocker"}#${i}`);
}
function findExistingAuditFor(dir, nodeId, ownTarget) {
  if (!nodeId || !fs5.existsSync(dir)) return null;
  for (const f of fs5.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const full = path2.join(dir, f);
    if (path2.resolve(full) === path2.resolve(ownTarget)) continue;
    const doc = readJsonOrNull(full, isJsonObject);
    if (doc && Array.isArray(doc.nodeIds) && doc.nodeIds.includes(nodeId)) return full;
  }
  return null;
}
if (import.meta.main ?? isMainFallback(import.meta.url)) {
  const argv = process.argv.slice(2);
  const USAGE = `usage: ${scriptCmd("audit")} <screen.json>... [--platform web|ios|android|react-native|flutter]
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
  const { values: flags, positionals: files } = cliParse("audit", argv, OPTIONS, USAGE, 2, () => parseArgs2({ args: argv, options: OPTIONS, allowPositionals: true }));
  if (flags.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (!files.length) {
    console.error(USAGE);
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
  const ctx = variablesContext(files, varsFile, { sliceFallback: true });
  for (const bad of ctx.invalid) console.error(`error  variables: '${bad.file}' ${bad.error}`);
  if (ctx.invalid.length) process.exit(2);
  const inputs = files.map((f, i) => ({ doc: readDocFile(f, "screen export", isScreenDoc), label: path2.basename(f, ".json"), vars: ctx.own[i] }));
  const catalog = catalogFile ? readSplitFile(catalogFile, "component catalog", isComponentsCatalog, "components", "design-system/components.local.json") : void 0;
  const designSystem = dsDir ? {
    tokens: readOptionalDoc(path2.join(dsDir, "tokens.json"), "design-system tokens", isTokensDoc),
    components: readOptionalDoc(path2.join(dsDir, "components.local.json"), "component catalog", isComponentsCatalog) || catalog,
    componentsLibrary: readOptionalDoc(path2.join(dsDir, "components.library.json"), "library component catalog", isComponentsCatalog),
    stylesText: readOptionalDoc(path2.join(dsDir, "styles.text.json"), "text styles", isTextStylesDoc)
  } : void 0;
  const variables = ctx.variablesDoc;
  if (ctx.staleLegacy) console.error(`warn  ${ctx.staleLegacy} also exists and was NOT used (stale sibling of design/export/) \u2014 remove it or re-pull into design/export/.`);
  const res = audit(inputs, { platform, catalog, designSystem, variables, sliceSources: ctx.sliceSources, grid });
  const md = jsonOnly ? "" : toMarkdown(res);
  const outBase = out || path2.join("design", "audit", path2.basename(files[0], ".json"));
  if (!jsonOnly && outBase && res.nodeIds && res.nodeIds.length) {
    const dup = findExistingAuditFor(path2.dirname(outBase) || ".", res.nodeIds[0], outBase + ".json");
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
    fs5.mkdirSync(path2.dirname(outBase), { recursive: true });
    fs5.writeFileSync(outBase + ".json", JSON.stringify(res, null, 2) + "\n");
    fs5.writeFileSync(outBase + ".md", md);
    console.error(`wrote ${outBase}.json and ${outBase}.md`);
  } else {
    process.stdout.write(md);
  }
  if (res.platformAssumed) console.error("warn  no --platform given \u2014 assumed 'web'. Touch targets, shadow spread and blur support differ per platform; pass --platform or write design/target.json.");
  if (!jsonOnly) console.error(`${res.summary.blockers} blocker(s), ${res.summary.warnings} warning(s), ${res.summary.info} info`);
  for (const n of res.crossFile && res.crossFile.notChecked || []) console.error(`note  not checked: ${n}`);
  process.exit(gate && res.summary.blockers > 0 ? 1 : 0);
}
export {
  TOUCH_MIN,
  audit,
  blockerIds,
  contrastRatio,
  controlKind,
  deltaE,
  findExistingAuditFor,
  parseHex,
  toMarkdown
};
