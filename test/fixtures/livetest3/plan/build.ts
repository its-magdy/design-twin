// Build test/fixtures/livetest3/plan/ from livetest-3's REAL artefacts, pruned to what the P2b tests
// (verify-build.js + plan-skeleton.js) read. Nothing is hand-written: every node, key, value, plan row,
// report verdict and source line is copied from the test directory.
//   node test/fixtures/livetest3/plan/build.ts [livetest-3 dir] [livetest-4 dir]
// Pruning keeps: every node's id/name/type/hidden flag, instance identity (mainComponent, component,
// props), every `tokens` binding (node-level and inside fills/strokes/effects/textRangeFills) and the
// root's resolvedModes — so visibility, token and instance counts are exactly the real export's.
import fs from "node:fs";
import path from "node:path";
import type { JsonObject, JsonValue } from "../../../../bridge/src/doc-types.ts";
import { isJsonObject } from "../../../../design-to-code/types.ts";

const L = process.argv[2] || "/Users/mohamedomarwork/design-twin-livetest-3";
const OUT = import.meta.dirname;
const EXP = path.join(L, "design", "export");
const PAGE = "pages/__Organization_management_";
const SCREENS = ["positions___7314_87192", "System_Configurations__1359_21337"];
const read = (p: string): JsonObject => {
  const v: unknown = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!isJsonObject(v)) throw new Error(`${p}: not a JSON object`);
  return v;
};
const dump = (rel: string, d: unknown): void => { const f = path.join(OUT, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(d) + "\n"); };
const copy = (from: string, rel: string): void => { const f = path.join(OUT, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.copyFileSync(from, f); };
// The array the export always has there (a missing one is a broken input: fail, as the JS version did).
const list = (x: JsonValue | undefined): JsonValue[] => { if (!Array.isArray(x)) throw new Error("expected an array"); return x; };
const objects = (x: JsonValue | undefined): JsonObject[] => list(x).map((o) => { if (!isJsonObject(o)) throw new Error("expected an object"); return o; });

const NODE = ["id", "name", "type", "hidden", "component", "props", "tokens", "resolvedModes", "variableModes"];
const PAINTS = ["fills", "strokes", "effects", "textRangeFills"];
function prune(x: JsonValue): JsonObject {
  const n = isJsonObject(x) ? x : {};
  const o: JsonObject = {};
  for (const k of NODE) if (n[k] !== undefined) o[k] = n[k];
  const m = n.mainComponent;
  if (m) {
    const mc: JsonObject = {};
    if (isJsonObject(m)) for (const k of ["key", "setKey", "name", "setName", "remote", "variant"]) if (m[k] !== undefined) mc[k] = m[k];
    o.mainComponent = mc;
  }
  for (const k of PAINTS) {
    const v = n[k];
    const arr = Array.isArray(v) ? v.flatMap((p) => (isJsonObject(p) && p.tokens ? [{ tokens: p.tokens }] : [])) : [];
    if (arr.length) o[k] = arr;
  }
  if (Array.isArray(n.children) && n.children.length) o.children = n.children.map(prune);
  return o;
}
function boundNames(doc: JsonObject): Set<string> {
  const out = new Set<string>();
  const collect = (o: JsonValue | undefined): void => {
    if (Array.isArray(o)) { o.forEach(collect); return; }
    if (!isJsonObject(o)) return;
    const t = o.tokens;
    if (isJsonObject(t)) for (const v of Object.values(t)) for (const x of Array.isArray(v) ? v : [v]) if (typeof x === "string") out.add(x);
    for (const [k, v] of Object.entries(o)) if (k !== "tokens" && v && typeof v === "object") collect(v);
  };
  collect(doc.nodes);
  return out;
}
// the names plus every alias target they reach, within one variables file
function closure(vars: JsonObject, names: Iterable<string>): object {
  const byName = new Map<JsonValue | undefined, JsonObject[]>();
  for (const v of objects(vars.variables)) { const had = byName.get(v.name); if (had) had.push(v); else byName.set(v.name, [v]); }
  const keep = new Set<JsonValue | undefined>(), todo: Array<JsonValue | undefined> = [...names];
  while (todo.length) {
    const n = todo.pop(); if (keep.has(n)) continue; keep.add(n);
    for (const v of byName.get(n) || []) for (const val of Object.values(isJsonObject(v.values) ? v.values : {})) if (isJsonObject(val) && val.aliasOf) todo.push(val.aliasOf);
  }
  const variables = objects(vars.variables).filter((v) => keep.has(v.name));
  const colls = new Set(variables.map((v) => v.collection));
  return Object.assign({}, vars, { variables, collections: objects(vars.collections || []).filter((c) => colls.has(c.name)), hygiene: undefined });
}

const allNames = new Set<string>(), instNames = new Set<JsonValue | undefined>();
// the real two-level index: root pageDirs → the page's own index.json rows (this export predates P3's
// flattened root `layers`, so the tools must read it the way the live project was written)
const pageIndex = read(path.join(EXP, PAGE, "index.json"));
const rows: JsonObject[] = [];
for (const s of SCREENS) {
  const doc = read(path.join(EXP, PAGE, s + ".json"));
  dump(`export/${PAGE}/${s}.json`, { screen: doc.screen, nodeId: doc.nodeId, exportedAt: doc.exportedAt, page: doc.page, pageId: doc.pageId, nodes: list(doc.nodes).map(prune) });
  const names = boundNames(doc);
  names.forEach((n) => allNames.add(n));
  dump(`export/${PAGE}/${s}.vars.json`, closure(read(path.join(EXP, PAGE, s + ".vars.json")), names));
  (function walk(n: JsonObject): void {
    const m = n.mainComponent;
    if (n.type === "INSTANCE" && isJsonObject(m)) instNames.add(m.setName || m.name || n.name);
    objects(n.children || []).forEach(walk);
  })({ children: list(doc.nodes) });
  const row = objects(pageIndex.layers || []).find((r) => r.id === doc.nodeId);
  if (row) rows.push(row);
}
dump("export/pages/index.json", { pageDirs: [{ page: pageIndex.page, pageId: pageIndex.pageId, dir: PAGE.split("/")[1], index: PAGE + "/index.json", layers: rows.length }] });
dump(`export/${PAGE}/index.json`, { page: pageIndex.page, pageId: pageIndex.pageId, layers: rows });
dump("export/design-system/tokens.json", closure(read(path.join(EXP, "design-system", "tokens.json")), allNames));
for (const f of ["components.local.json", "components.library.json"]) {
  const c = read(path.join(EXP, "design-system", f));
  dump(`export/design-system/${f}`, Object.assign({}, c, { components: objects(c.components).filter((x) => instNames.has(x.name)) }));
}

// the two plans, verbatim (their `"status": "verified"` is the defect under test)
for (const s of SCREENS) copy(path.join(L, "design", "plan", s + ".json"), `plan/${s}.json`);
// the two reports the plans contradict — header, verdict and `why` verbatim; long arrays trimmed
for (const r of ["JobRoles", "GlobalPolicies"]) {
  const rep = read(path.join(L, "design", "verify", r + ".report.json"));
  const slim: JsonObject = {};
  for (const [k, v] of Object.entries(rep)) slim[k] = Array.isArray(v) && k !== "why" && k !== "artifacts" ? v.slice(0, 3) : v;
  dump(`verify/${r}.report.json`, slim);
}
// livetest-4 finding 314: a no-change re-pull of 7314:87192 — the snapshot taken before the re-pull
// (design/.sync/…) and the export after it, which differ ONLY in `exportedAt`. Pruned identically.
const L4 = process.argv[3] || "/Users/mohamedomarwork/design-twin-livetest-4";
for (const [from, name] of [[".sync/export__pages____Organization_management___positions___7314_87192.json", "before"], ["export/pages/__Organization_management_/positions___7314_87192.json", "after"]] as const) {
  const doc = read(path.join(L4, "design", from));
  dump(`repull/${name}.json`, { screen: doc.screen, nodeId: doc.nodeId, exportedAt: doc.exportedAt, page: doc.page, pageId: doc.pageId, manifest: doc.manifest, nodes: list(doc.nodes).map(prune) });
}
// the source files the findings are about
for (const f of ["src/layout/Header.tsx", "src/features/global-policies/screens/GlobalPoliciesScreen.tsx", "src/assets/calendar-2.svg", "src/assets/Vector.svg"]) copy(path.join(L, "app", f), `app/${f}`);
console.log("tokens bound across both screens", allNames.size, "instance names", instNames.size);
