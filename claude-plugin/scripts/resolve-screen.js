// GENERATED from design-to-code/ by claude-plugin/build-scripts.js — edit the source, then rebuild.

// design-to-code/resolve-screen.js
var fs = require("fs");
var path = require("path");
function readJsonOr(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return fallback;
  }
}
var NODE_ID_RE = /^\d+:\d+$/;
function allRows(exportDir) {
  const rootFile = path.join(exportDir, "pages", "index.json");
  const root = readJsonOr(rootFile, null);
  if (!root) return [];
  if (Array.isArray(root.layers)) return root.layers;
  const rows = [];
  for (const pd of root.pageDirs || []) {
    const idx = readJsonOr(path.join(exportDir, pd.dir ? path.join("pages", pd.dir, "index.json") : ""), null);
    if (idx && Array.isArray(idx.layers)) rows.push(...idx.layers);
  }
  return rows;
}
function planRows(planDir) {
  if (!planDir || !fs.existsSync(planDir)) return [];
  const out = [];
  for (const f of fs.readdirSync(planDir)) {
    if (!f.endsWith(".json")) continue;
    const doc = readJsonOr(path.join(planDir, f), null);
    if (doc && (doc.screenName || doc.nodeId)) out.push({ file: f, screenName: doc.screenName, nodeId: doc.nodeId, route: doc.route });
  }
  return out;
}
function describe(row) {
  return {
    name: row.name,
    id: row.id,
    title: row.title || null,
    w: row.w,
    h: row.h,
    nodes: row.nodes,
    reference: row.reference || null,
    screenshot: row.id ? `dtwin screenshot ${row.id}` : null
  };
}
function resolveScreen(exportDir, query, opts) {
  const options = opts || {};
  const rows = allRows(exportDir);
  const q = String(query || "").trim();
  const stage = (name, matches) => ({ stage: name, matches });
  const stages = [];
  if (NODE_ID_RE.test(q)) {
    stages.push(stage("node id", rows.filter((r) => r.id === q)));
  }
  stages.push(stage("exact layer name", rows.filter((r) => r.name === q)));
  stages.push(stage("indexed title", rows.filter((r) => r.title && r.title.toLowerCase() === q.toLowerCase())));
  const plans = planRows(options.planDir);
  const planHit = plans.filter((p) => p.screenName === q || p.route === q);
  if (planHit.length) {
    const ids = new Set(planHit.map((p) => p.nodeId).filter(Boolean));
    stages.push(stage("plan screenName/route", rows.filter((r) => ids.has(r.id))));
  } else {
    stages.push(stage("plan screenName/route", []));
  }
  const qLower = q.toLowerCase();
  stages.push(
    stage(
      "text search",
      rows.filter(
        (r) => r.name && r.name.toLowerCase().includes(qLower) || r.title && r.title.toLowerCase().includes(qLower) || Array.isArray(r.texts) && r.texts.some((t) => t.toLowerCase().includes(qLower))
      )
    )
  );
  for (const s of stages) {
    if (s.matches.length === 1) return { status: "resolved", row: s.matches[0], stage: s.stage };
    if (s.matches.length > 1) {
      return { status: "ambiguous", stage: s.stage, candidates: s.matches.map(describe) };
    }
  }
  return { status: "not-found", candidates: rows.map(describe) };
}
module.exports = { resolveScreen, allRows, planRows, describe, NODE_ID_RE };
if (require.main === module) {
  const [exportDir, query, planDir] = process.argv.slice(2);
  if (!exportDir || !query) {
    console.error("usage: node design-to-code/resolve-screen.js <design/export dir> <name-or-id> [design/plan dir]");
    process.exit(2);
  }
  const res = resolveScreen(exportDir, query, { planDir });
  if (res.status === "resolved") {
    console.log(`resolved '${query}' -> ${res.row.name} (${res.row.id}) via ${res.stage}`);
    process.stdout.write(JSON.stringify(res.row, null, 2) + "\n");
    process.exit(0);
  }
  if (res.status === "ambiguous") {
    console.error(`error  '${query}' matches ${res.candidates.length} screens at the '${res.stage}' stage \u2014 pick one by node id:`);
    for (const c of res.candidates) console.error(`  ${c.id}  ${c.name}${c.title ? ` (title: "${c.title}")` : ""}  ${c.w || "?"}x${c.h || "?"}  nodes=${c.nodes ?? "?"}  ${c.reference || ""}  -> ${c.screenshot}`);
    process.exit(1);
  }
  console.error(`error  '${query}' matches no screen. Known layers:`);
  for (const c of res.candidates) console.error(`  ${c.id}  ${c.name}${c.title ? ` (title: "${c.title}")` : ""}  ${c.w || "?"}x${c.h || "?"}  nodes=${c.nodes ?? "?"}  ${c.reference || ""}  -> ${c.screenshot}`);
  process.exit(1);
}
