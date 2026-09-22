// GENERATED from design-to-code/ by claude-plugin/build-scripts.js — edit the source, then rebuild.
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};

// design-to-code/kinds.js
var require_kinds = __commonJS({
  "design-to-code/kinds.js"(exports2, module2) {
    var TYPE_TO_KIND2 = { VARIANT: "enum", BOOLEAN: "boolean", TEXT: "string", INSTANCE_SWAP: "instance" };
    module2.exports = { TYPE_TO_KIND: TYPE_TO_KIND2 };
  }
});

// bridge/errmsg.js
var require_errmsg = __commonJS({
  "bridge/errmsg.js"(exports2, module2) {
    "use strict";
    var errMsg2 = (e) => typeof e === "string" ? e : String(e && e.message || e);
    module2.exports = { errMsg: errMsg2 };
  }
});

// bridge/project-layout.js
var require_project_layout = __commonJS({
  "bridge/project-layout.js"(exports2, module2) {
    "use strict";
    var fs = require("fs");
    var path = require("path");
    var DESIGN_DIR = "design";
    var EXPORT_SUBDIR = "export";
    var EXPORT_DIR = path.join(DESIGN_DIR, EXPORT_SUBDIR);
    var TARGET_FILE = path.join(DESIGN_DIR, "target.json");
    var MAP_FILE = path.join(DESIGN_DIR, "codeconnect.local.json");
    var PLAN_DIR = path.join(DESIGN_DIR, "plan");
    var AUDIT_DIR = path.join(DESIGN_DIR, "audit");
    var VERIFY_DIR = path.join(DESIGN_DIR, "verify");
    var EXPORT_MARKERS = ["pages", "design-system", "design-system.json", "variables.json", "assets", "libraries"];
    function looksLikeExportDir(dir) {
      try {
        if (!fs.statSync(dir).isDirectory()) return false;
      } catch {
        return false;
      }
      return EXPORT_MARKERS.some((m) => fs.existsSync(path.join(dir, m)));
    }
    function findExportDir(cwd) {
      const modern = path.join(cwd, EXPORT_DIR);
      if (looksLikeExportDir(modern)) return { dir: modern, layout: "export-subdir", rel: EXPORT_DIR };
      const legacy = path.join(cwd, DESIGN_DIR);
      if (looksLikeExportDir(legacy)) return { dir: legacy, layout: "legacy-flat", rel: DESIGN_DIR };
      return { dir: modern, layout: "none", rel: EXPORT_DIR };
    }
    function findMapFile(cwd) {
      const modern = path.join(cwd, MAP_FILE);
      if (fs.existsSync(modern)) return { file: modern, rel: MAP_FILE, legacy: false };
      const legacy = path.join(cwd, "codeconnect.local.json");
      if (fs.existsSync(legacy)) return { file: legacy, rel: "codeconnect.local.json", legacy: true };
      return { file: modern, rel: MAP_FILE, legacy: false, missing: true };
    }
    var README = `# design/

Two kinds of file live here, and the difference matters.

## design/export/ \u2014 dtwin owns this

Everything \`dtwin pull\` writes lands under \`export/\` and nowhere else. It is a snapshot of Figma:
delete the whole directory and re-pull and you lose nothing.

    export/pages/<Page>/<Screen>__<node-id>.json   one exported screen
    export/pages/<Page>/<Screen>__<node-id>.vars.json    the tokens THAT screen binds
    export/pages/<Page>/<Screen>__<node-id>.assets.json  which assets it uses, with content hashes
    export/pages/index.json                        every screen pulled, whatever the pull shape
    export/design-system/                          tokens.json, styles.*.json, components.*.json
    export/variables.json                          the union of every screen's slice (merged, never replaced)
    export/assets/                                 shared and cumulative across screens

## Everything else here \u2014 you own it

These are decisions and evidence. They are not regenerable, and a re-pull never touches them.

    target.json              which stack you are building for
    codeconnect.local.json   Figma component key -> your code component. Hand-maintained.
    plan/<Screen>.json       what build-screen decided, and why
    audit/<Screen>.{md,json} the pre-build design review
    verify/<Screen>.report.json  the measured per-node comparison behind any "pass"

Commit both halves. If your .gitignore ignores \`design/\`, un-ignore this half \u2014
\`!design/target.json\`, \`!design/codeconnect.local.json\`, \`!design/plan/\` \u2014 or the work is lost
with the next clone.
`;
    module2.exports = {
      DESIGN_DIR,
      EXPORT_SUBDIR,
      EXPORT_DIR,
      TARGET_FILE,
      MAP_FILE,
      PLAN_DIR,
      AUDIT_DIR,
      VERIFY_DIR,
      README,
      looksLikeExportDir,
      findExportDir,
      findMapFile
    };
  }
});

// bridge/snapshot-meta.js
var require_snapshot_meta = __commonJS({
  "bridge/snapshot-meta.js"(exports2, module2) {
    "use strict";
    var fs = require("fs");
    var path = require("path");
    var { errMsg: errMsg2 } = require_errmsg();
    function snapshotAge2(doc, now) {
      const exportedAt = doc && doc.exportedAt;
      if (!exportedAt) return { exportedAt: void 0, ageMs: void 0, problem: "missing" };
      const t = Date.parse(exportedAt);
      if (Number.isNaN(t)) return { exportedAt, ageMs: void 0, problem: "unparseable" };
      return { exportedAt, ageMs: (now || Date.now()) - t };
    }
    function looksLikeExport(doc) {
      return !!doc && typeof doc === "object" && (Array.isArray(doc.nodes) || Array.isArray(doc.layers) || Array.isArray(doc.pageDirs) || Array.isArray(doc.components) || Array.isArray(doc.variables) || doc.files && typeof doc.files === "object");
    }
    function snapshotCandidates(dir) {
      const out = [
        { f: path.join(dir, "design-system.json"), named: true },
        { f: path.join(dir, "pages", "index.json"), named: true }
      ];
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return out;
      }
      const rest = [];
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith(".json") || e.name === "design-system.json") continue;
        const f = path.join(dir, e.name);
        try {
          rest.push({ f, mtime: fs.statSync(f).mtimeMs });
        } catch {
        }
      }
      rest.sort((a, b) => b.mtime - a.mtime);
      return out.concat(rest.map((r) => ({ f: r.f, named: false })));
    }
    function readSnapshotInfo(outDir) {
      const dir = outDir || process.env.FIGMA_EXPORT_DIR || require_project_layout().findExportDir(process.cwd()).dir;
      const cands = snapshotCandidates(dir);
      let file = null, doc = null, parseError = null, fallback = null;
      for (const { f: cand, named } of cands) {
        let raw;
        try {
          raw = fs.readFileSync(cand, "utf8");
        } catch {
          continue;
        }
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (e) {
          if (named && parseError === null) parseError = { file: cand, error: path.basename(cand) + " is not valid JSON: " + errMsg2(e) };
          continue;
        }
        if (!named && !looksLikeExport(parsed)) continue;
        if (!parsed.exportedAt) {
          if (fallback === null) fallback = { file: cand, doc: parsed };
          continue;
        }
        file = cand;
        doc = parsed;
        break;
      }
      if (file === null && fallback !== null) {
        file = fallback.file;
        doc = fallback.doc;
      }
      if (file === null) return parseError;
      const label = path.basename(file);
      const sourceFile = doc && doc.file || (doc && typeof doc.screen === "string" ? doc.screen : void 0);
      const { exportedAt, ageMs, problem } = snapshotAge2(doc);
      const warning = problem === "missing" ? `no exportedAt stamp in ${label} \u2014 freshness unknown (re-export with the current plugin)` : problem === "unparseable" ? `exportedAt ('${exportedAt}') is not a parseable timestamp` : void 0;
      return { file, exportedAt, ageMs, sourceFile, warning };
    }
    module2.exports = { readSnapshotInfo, snapshotAge: snapshotAge2 };
  }
});

// design-to-code/catalog-input.js
var require_catalog_input = __commonJS({
  "design-to-code/catalog-input.js"(exports2, module2) {
    function isManifest(doc, payloadKey) {
      return !!(doc && doc.files && typeof doc.files === "object" && !Array.isArray(doc.files) && !Array.isArray(doc[payloadKey]));
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
      const fs = require("fs");
      let raw;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch (e) {
        const why = e && e.code === "ENOENT" ? "does not exist" : e && e.code === "EISDIR" ? "is a directory, not a file" : e && e.code === "EACCES" ? "is not readable (permission denied)" : `could not be read (${e && e.code || e})`;
        console.error(`error  ${what}: '${file}' ${why}.` + (hint ? `
       ${hint}` : ""));
        process.exit(2);
      }
      try {
        return JSON.parse(raw);
      } catch (e) {
        console.error(`error  ${what}: '${file}' is not valid JSON \u2014 ${e && e.message || e}`);
        process.exit(2);
      }
    }
    var NO_DESIGN_SYSTEM_HINT = "A single-screen pull (`dtwin pull design --node <id>`) exports only that screen \u2014 it does not\n       write design/design-system/. Run `dtwin pull design --design-system` to create it.";
    module2.exports = { assertNotManifest, isManifest, readJsonFile, NO_DESIGN_SYSTEM_HINT };
  }
});

// design-to-code/drift-lint.js
var { TYPE_TO_KIND } = require_kinds();
var { snapshotAge } = require_snapshot_meta();
var { errMsg } = require_errmsg();
var stripSuffix = (k) => String(k).split("#")[0];
var DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
function checkFreshness(catalog, push, warnings, opts = {}) {
  const maxAgeMs = opts.maxAgeMs > 0 ? opts.maxAgeMs : DEFAULT_MAX_AGE_MS;
  const { exportedAt, ageMs, problem } = snapshotAge(catalog, opts.now || Date.now());
  if (problem === "missing") {
    const w = { code: "unknown-freshness", message: "design-system.json has no `exportedAt` timestamp \u2014 freshness cannot be verified. Findings are checked against whatever snapshot is on disk, which may be stale; re-export with the current plugin to get a timestamp." };
    push(warnings, w.code, w.message, {});
    return w;
  }
  if (problem === "unparseable") {
    const w = { code: "unknown-freshness", message: `design-system.json's \`exportedAt\` ('${exportedAt}') is not a parseable timestamp \u2014 freshness cannot be verified.` };
    push(warnings, w.code, w.message, { exportedAt });
    return w;
  }
  if (ageMs > maxAgeMs) {
    const ageH = (ageMs / 36e5).toFixed(1);
    const maxH = (maxAgeMs / 36e5).toFixed(1);
    const w = {
      code: "stale-snapshot",
      message: `STALE SNAPSHOT: design-system.json was exported ${ageH}h ago (max-age ${maxH}h)${catalog.file ? ` from '${catalog.file}'` : ""}. Every finding below is checked against that on-disk snapshot, NOT the live Figma file \u2014 re-run dtwin / the export tool before trusting them.`
    };
    push(warnings, w.code, w.message, { exportedAt, ageMs, maxAgeMs });
    return w;
  }
  return void 0;
}
function indexPropsByBase(rawProps, valKey, subject, push, warnings, mapKey) {
  const ambiguous = /* @__PURE__ */ new Set(), out = /* @__PURE__ */ Object.create(null);
  for (const k of Object.keys(rawProps || {})) {
    const b = stripSuffix(k);
    if (b in out && out[b].orig !== k) {
      push(warnings, "ambiguous-prop", `${subject} has two props with base name '${b}' ('${out[b].orig}', '${k}') \u2014 comparison skipped`, { mapKey, prop: b });
      ambiguous.add(b);
    }
    out[b] = { orig: k, [valKey]: rawProps[k] };
  }
  return { props: out, ambiguous };
}
function driftLint(map, catalog, opts) {
  const errors = [], warnings = [];
  const push = (arr, code, message, extra) => arr.push(Object.assign({ code, message }, extra || {}));
  const freshness = checkFreshness(catalog, push, warnings, opts || {});
  const comps = catalog && catalog.components || [];
  const byKey = /* @__PURE__ */ new Map(), byId = /* @__PURE__ */ new Map(), byName = /* @__PURE__ */ new Map();
  for (const c of comps) {
    if (c.key) {
      if (byKey.has(c.key)) push(warnings, "duplicate-key", `two catalog components share key '${c.key}' ('${byKey.get(c.key).name}' and '${c.name}')`, { key: c.key });
      byKey.set(c.key, c);
    }
    if (c.id) byId.set(c.id, c);
    if (c.name) (byName.get(c.name) || byName.set(c.name, []).get(c.name)).push(c);
  }
  const mappedIds = /* @__PURE__ */ new Set();
  const compToEntries = /* @__PURE__ */ new Map();
  const entries = map && map.components || {};
  for (const mapKey of Object.keys(entries)) {
    const e = entries[mapKey];
    const f = e.figma || {};
    let comp;
    if (f.key) comp = byKey.get(f.key);
    else if (f.id) comp = byId.get(f.id);
    else comp = byKey.get(mapKey) || byId.get(mapKey);
    if (!comp) {
      const sameName = f.name && byName.get(f.name);
      const suggestedKey = sameName && sameName.length === 1 ? sameName[0].key : void 0;
      push(
        errors,
        "orphaned-entry",
        `map entry '${mapKey}' (was '${f.name || "?"}'${f.id ? ", id " + f.id : ""}) has no matching component in Figma \u2014 deleted, moved, or unpublished${suggestedKey ? ` (a component named '${f.name}' exists with key ${suggestedKey} \u2014 verify before re-pointing)` : ""}`,
        { mapKey, suggestedKey }
      );
      continue;
    }
    if (comp.key) mappedIds.add(comp.key);
    if (comp.id) mappedIds.add(comp.id);
    (compToEntries.get(comp) || compToEntries.set(comp, []).get(comp)).push(mapKey);
    if (f.name && comp.name && f.name !== comp.name) {
      push(warnings, "stale-name", `map entry '${mapKey}' remembers name '${f.name}' but component is now '${comp.name}' (rename \u2014 refresh advisory metadata)`, { mapKey, from: f.name, to: comp.name });
    }
    const { props: catProps, ambiguous: catAmbiguous } = indexPropsByBase(comp.props, "def", `component '${comp.name}'`, push, warnings, mapKey);
    const { props: mapProps, ambiguous: mapAmbiguous } = indexPropsByBase(e.props, "prop", `map entry '${mapKey}'`, push, warnings, mapKey);
    for (const pn of Object.keys(mapProps)) if (!(pn in catProps)) push(errors, "stale-prop", `'${mapKey}'.props.${mapProps[pn].orig} does not exist on the Figma component`, { mapKey, prop: pn });
    for (const pn of Object.keys(catProps)) if (!(pn in mapProps)) push(warnings, "uncovered-prop", `'${mapKey}': Figma prop '${catProps[pn].orig}' (${catProps[pn].def.type}) is not mapped`, { mapKey, prop: pn });
    for (const pn of Object.keys(mapProps)) {
      const cp = catProps[pn];
      if (!cp || catAmbiguous.has(pn) || mapAmbiguous.has(pn)) continue;
      const kind = mapProps[pn].prop.kind, expected = TYPE_TO_KIND[cp.def.type];
      if (expected && kind && kind !== expected) {
        push(errors, "kind-mismatch", `'${mapKey}'.props.${mapProps[pn].orig}: map kind '${kind}' but Figma type is ${cp.def.type} (expected '${expected}')`, { mapKey, prop: pn });
        continue;
      }
      if (kind === "enum") {
        const values = mapProps[pn].prop.values || {};
        if (!Array.isArray(cp.def.options)) {
          push(warnings, "no-variant-options", `'${mapKey}'.props.${mapProps[pn].orig}: component exposes no variant options \u2014 enum values can't be verified`, { mapKey, prop: pn });
          continue;
        }
        for (const opt of Object.keys(values)) if (!cp.def.options.includes(opt)) push(errors, "unknown-variant-value", `'${mapKey}'.props.${mapProps[pn].orig}: maps option '${opt}' that is not a Figma variant option`, { mapKey, prop: pn });
        for (const opt of cp.def.options) if (!(opt in values)) push(warnings, "unmapped-variant-value", `'${mapKey}'.props.${mapProps[pn].orig}: variant option '${opt}' has no code mapping (will be omitted)`, { mapKey, prop: pn });
      }
    }
  }
  for (const [comp, keys] of compToEntries) if (keys.length > 1) push(errors, "double-mapped", `component '${comp.name}' is mapped by ${keys.length} entries (${keys.join(", ")}) \u2014 only one code target may win`, { keys });
  let catalogComponents = 0;
  for (const c of comps) {
    if (c.type !== "COMPONENT" && c.type !== "COMPONENT_SET") continue;
    catalogComponents++;
    if (c.key && mappedIds.has(c.key) || c.id && mappedIds.has(c.id)) continue;
    push(warnings, "unmapped-component", `component '${c.name}'${c.key ? " (key " + c.key + ")" : " (unpublished \u2014 no key)"} has no map entry`, { key: c.key, name: c.name });
  }
  return { errors, warnings, freshness, summary: { entries: Object.keys(entries).length, catalogComponents, mapped: compToEntries.size, errorCount: errors.length, warningCount: warnings.length } };
}
async function checkLiveFreshness(fileKey, token, exportedAt) {
  if (!fileKey || !token) return null;
  const res = await fetch(`https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}/meta`, { headers: { "X-Figma-Token": token } });
  if (!res.ok) throw new Error(`GET /v1/files/${fileKey}/meta -> ${res.status} ${res.statusText}`);
  const body = await res.json();
  const lastModified = body && body.file && body.file.last_modified;
  if (!lastModified) return { lastModified: void 0, aheadOfSnapshot: void 0 };
  const aheadOfSnapshot = exportedAt ? Date.parse(lastModified) > Date.parse(exportedAt) : void 0;
  return { lastModified, aheadOfSnapshot };
}
function screenCoverage(map, catalog, screenDocs) {
  const entries = map && map.components || {};
  const mapKeys = /* @__PURE__ */ new Set();
  for (const k of Object.keys(entries)) {
    const f = entries[k].figma || {};
    if (f.key) mapKeys.add(f.key);
    if (f.id) mapKeys.add(f.id);
    mapKeys.add(k);
  }
  const catKeys = new Set((catalog && catalog.components || []).map((c) => c.key).filter(Boolean));
  const used = /* @__PURE__ */ new Map();
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "INSTANCE" && n.mainComponent) {
      const mc = n.mainComponent;
      const id = mc.setKey || mc.key;
      if (id) {
        if (!used.has(id)) used.set(id, { setName: mc.setName || mc.name, instances: 0, key: id, variantKey: mc.key });
        used.get(id).instances++;
      }
    }
    for (const c of n.children || []) walk(c);
  };
  for (const doc of screenDocs || []) {
    const roots = Array.isArray(doc && doc.nodes) ? doc.nodes : doc && doc.tree ? [doc.tree] : doc ? [doc] : [];
    for (const r of roots) walk(r);
  }
  const rows = [...used.values()].map((u) => ({
    ...u,
    inCatalog: catKeys.has(u.key) || catKeys.has(u.variantKey),
    inMap: mapKeys.has(u.key) || mapKeys.has(u.variantKey)
  }));
  const instances = rows.reduce((n, r) => n + r.instances, 0);
  const inCatalog = rows.filter((r) => r.inCatalog).length;
  const inMap = rows.filter((r) => r.inMap).length;
  return {
    distinct: rows.length,
    instances,
    inCatalog,
    inMap,
    catalogPct: rows.length ? Math.round(inCatalog / rows.length * 100) : null,
    mapPct: rows.length ? Math.round(inMap / rows.length * 100) : null,
    unmapped: rows.filter((r) => !r.inMap).map((r) => ({ setName: r.setName, key: r.key, instances: r.instances }))
  };
}
module.exports = { driftLint, screenCoverage, checkFreshness, checkLiveFreshness, DEFAULT_MAX_AGE_MS };
if (require.main === module) {
  const { assertNotManifest, readJsonFile, NO_DESIGN_SYSTEM_HINT } = require_catalog_input();
  const argv = process.argv.slice(2);
  const maxAgeIdx = argv.indexOf("--max-age");
  let maxAgeHours;
  if (maxAgeIdx !== -1) {
    maxAgeHours = Number(argv[maxAgeIdx + 1]);
    if (!(maxAgeHours > 0)) {
      console.error("--max-age expects a positive number of hours");
      process.exit(2);
    }
    argv.splice(maxAgeIdx, 2);
  } else if (process.env.DRIFT_MAX_AGE_HOURS) {
    maxAgeHours = Number(process.env.DRIFT_MAX_AGE_HOURS);
    if (!(maxAgeHours > 0)) {
      console.error("DRIFT_MAX_AGE_HOURS expects a positive number of hours");
      process.exit(2);
    }
  }
  const maxAgeMs = maxAgeHours ? maxAgeHours * 36e5 : void 0;
  const screenFiles = [];
  for (; ; ) {
    const i = argv.indexOf("--screen");
    if (i === -1) break;
    const v = argv[i + 1];
    if (!v) {
      console.error("--screen expects a path to a screen export");
      process.exit(2);
    }
    screenFiles.push(v);
    argv.splice(i, 2);
  }
  const [mapFile, catalogFile] = argv;
  if (!mapFile || !catalogFile) {
    console.error("usage: node design-to-code/drift-lint.js <map.json> <design-system/components.local.json> [--screen design/pages/<Page>/<Screen>.json]... [--max-age <hours>]");
    process.exit(2);
  }
  const catalog = readJsonFile(catalogFile, "component catalog", NO_DESIGN_SYSTEM_HINT + "\n       Or build without a component map: every instance then counts as new (build-screen, step 1).");
  assertNotManifest(catalog, catalogFile, "components", "design-system/components.local.json");
  const map = readJsonFile(mapFile, "component map", "Scaffold one with `map-bootstrap.js <components.local.json> --out codeconnect.local.json`.");
  const res = driftLint(map, catalog, { maxAgeMs });
  res.errors.forEach((e) => console.error(`ERROR  [${e.code}] ${e.message}`));
  res.warnings.forEach((w) => console.error(`warn   [${w.code}] ${w.message}`));
  const s = res.summary;
  console.error(`
${s.mapped}/${s.catalogComponents} components mapped \xB7 ${s.errorCount} error(s), ${s.warningCount} warning(s)`);
  console.error(`      (that number is the CATALOG measured against the map \u2014 it says nothing about any particular screen.)`);
  let screenFail = false;
  if (screenFiles.length) {
    const docs = screenFiles.map((f) => readJsonFile(f, "screen export"));
    const cov = screenCoverage(map, catalog, docs);
    if (!cov.distinct) {
      console.error(`
SCREEN COVERAGE: the given screen export(s) contain no INSTANCE nodes \u2014 nothing to reuse either way.`);
    } else {
      console.error(
        `
SCREEN COVERAGE: ${cov.inMap}/${cov.distinct} (${cov.mapPct}%) of the components on this screen are in your map \xB7 ${cov.inCatalog}/${cov.distinct} (${cov.catalogPct}%) are even in the catalog \xB7 ${cov.instances} instance(s) total`
      );
      if (cov.mapPct === 0) {
        screenFail = true;
        console.error(
          `ERROR  [screen-coverage] NONE of the ${cov.distinct} components on this screen resolve to your map or catalog by key.
       The catalog you exported is not the library this screen is built from \u2014 a green "mapped" count above measures
       the catalog against itself. Open an instance in Figma and use "Go to main component" to find the owning file,
       then export it with \`dtwin pull design --as-library "<name>"\`. Until then build every instance as new.`
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
  const run = async () => {
    if (fileKey && token) {
      try {
        const live = await checkLiveFreshness(fileKey, token, catalog.exportedAt);
        if (live && live.aheadOfSnapshot) console.error(`warn   [live-meta] the live Figma file was modified (${live.lastModified}) AFTER this snapshot was exported (${catalog.exportedAt}) \u2014 it is confirmed stale, not just old.`);
      } catch (e) {
        console.error(`warn   [live-meta] could not verify against the live file: ${errMsg(e)}`);
      }
    }
    process.exit(res.errors.length || screenFail ? 1 : 0);
  };
  run();
}
