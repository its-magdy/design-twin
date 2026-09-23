// Build test/fixtures/livetest3/plan/ from livetest-3's REAL artefacts, pruned to what the P2b tests
// (verify-build.js + plan-skeleton.js) read. Nothing is hand-written: every node, key, value, plan row,
// report verdict and source line is copied from the test directory.
//   node test/fixtures/livetest3/plan/build.js [livetest dir]
// Pruning keeps: every node's id/name/type/hidden flag, instance identity (mainComponent, component,
// props), every `tokens` binding (node-level and inside fills/strokes/effects/textRangeFills) and the
// root's resolvedModes — so visibility, token and instance counts are exactly the real export's.
const fs = require("fs");
const path = require("path");
const L = process.argv[2] || "/Users/mohamedomarwork/design-twin-livetest-3";
const OUT = __dirname;
const EXP = path.join(L, "design", "export");
const PAGE = "pages/__Organization_management_";
const SCREENS = ["positions___7314_87192", "System_Configurations__1359_21337"];
const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const dump = (rel, d) => { const f = path.join(OUT, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(d) + "\n"); };
const copy = (from, rel) => { const f = path.join(OUT, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.copyFileSync(from, f); };

const NODE = ["id", "name", "type", "hidden", "component", "props", "tokens", "resolvedModes", "variableModes"];
const PAINTS = ["fills", "strokes", "effects", "textRangeFills"];
function prune(n) {
  const o = {};
  for (const k of NODE) if (n[k] !== undefined) o[k] = n[k];
  if (n.mainComponent) {
    const m = n.mainComponent; o.mainComponent = {};
    for (const k of ["key", "setKey", "name", "setName", "remote", "variant"]) if (m[k] !== undefined) o.mainComponent[k] = m[k];
  }
  for (const k of PAINTS) {
    const arr = Array.isArray(n[k]) ? n[k].filter((p) => p && p.tokens).map((p) => ({ tokens: p.tokens })) : [];
    if (arr.length) o[k] = arr;
  }
  if (Array.isArray(n.children) && n.children.length) o.children = n.children.map(prune);
  return o;
}
function boundNames(doc) {
  const out = new Set();
  const collect = (o) => {
    if (Array.isArray(o)) { o.forEach(collect); return; }
    if (!o || typeof o !== "object") return;
    if (o.tokens && typeof o.tokens === "object") for (const v of Object.values(o.tokens)) for (const x of [].concat(v)) if (typeof x === "string") out.add(x);
    for (const [k, v] of Object.entries(o)) if (k !== "tokens" && v && typeof v === "object") collect(v);
  };
  collect(doc.nodes);
  return out;
}
// the names plus every alias target they reach, within one variables file
function closure(vars, names) {
  const byName = new Map(); for (const v of vars.variables) { if (!byName.has(v.name)) byName.set(v.name, []); byName.get(v.name).push(v); }
  const keep = new Set(), todo = [...names];
  while (todo.length) {
    const n = todo.pop(); if (keep.has(n)) continue; keep.add(n);
    for (const v of byName.get(n) || []) for (const val of Object.values(v.values || {})) if (val && val.aliasOf) todo.push(val.aliasOf);
  }
  const variables = vars.variables.filter((v) => keep.has(v.name));
  const colls = new Set(variables.map((v) => v.collection));
  return Object.assign({}, vars, { variables, collections: (vars.collections || []).filter((c) => colls.has(c.name)), hygiene: undefined });
}

const allNames = new Set(), instNames = new Set();
// the real two-level index: root pageDirs → the page's own index.json rows (this export predates P3's
// flattened root `layers`, so the tools must read it the way the live project was written)
const pageIndex = read(path.join(EXP, PAGE, "index.json"));
const rows = [];
for (const s of SCREENS) {
  const doc = read(path.join(EXP, PAGE, s + ".json"));
  dump(`export/${PAGE}/${s}.json`, { screen: doc.screen, nodeId: doc.nodeId, exportedAt: doc.exportedAt, page: doc.page, pageId: doc.pageId, nodes: doc.nodes.map(prune) });
  const names = boundNames(doc);
  names.forEach((n) => allNames.add(n));
  dump(`export/${PAGE}/${s}.vars.json`, closure(read(path.join(EXP, PAGE, s + ".vars.json")), names));
  (function walk(n) { if (n.type === "INSTANCE" && n.mainComponent) instNames.add(n.mainComponent.setName || n.mainComponent.name || n.name); (n.children || []).forEach(walk); })({ children: doc.nodes });
  const row = (pageIndex.layers || []).find((r) => r.id === doc.nodeId);
  if (row) rows.push(row);
}
dump("export/pages/index.json", { pageDirs: [{ page: pageIndex.page, pageId: pageIndex.pageId, dir: PAGE.split("/")[1], index: PAGE + "/index.json", layers: rows.length }] });
dump(`export/${PAGE}/index.json`, { page: pageIndex.page, pageId: pageIndex.pageId, layers: rows });
dump("export/design-system/tokens.json", closure(read(path.join(EXP, "design-system", "tokens.json")), allNames));
for (const f of ["components.local.json", "components.library.json"]) {
  const c = read(path.join(EXP, "design-system", f));
  dump(`export/design-system/${f}`, Object.assign({}, c, { components: c.components.filter((x) => instNames.has(x.name)) }));
}

// the two plans, verbatim (their `"status": "verified"` is the defect under test)
for (const s of SCREENS) copy(path.join(L, "design", "plan", s + ".json"), `plan/${s}.json`);
// the two reports the plans contradict — header, verdict and `why` verbatim; long arrays trimmed
for (const r of ["JobRoles", "GlobalPolicies"]) {
  const rep = read(path.join(L, "design", "verify", r + ".report.json"));
  const slim = {};
  for (const [k, v] of Object.entries(rep)) slim[k] = Array.isArray(v) && k !== "why" && k !== "artifacts" ? v.slice(0, 3) : v;
  dump(`verify/${r}.report.json`, slim);
}
// the source files the findings are about
for (const f of ["src/layout/Header.tsx", "src/features/global-policies/screens/GlobalPoliciesScreen.tsx", "src/assets/calendar-2.svg", "src/assets/Vector.svg"]) copy(path.join(L, "app", f), `app/${f}`);
console.log("tokens bound across both screens", allNames.size, "instance names", instNames.size);
