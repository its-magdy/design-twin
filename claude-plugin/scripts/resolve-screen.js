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
var fold = (s) => String(s || "").trim().toLowerCase();
function resolveScreen(exportDir, query, opts) {
  const options = opts || {};
  const rows = allRows(exportDir);
  const q = String(query || "").trim();
  const qFold = fold(q);
  const noTitles = rows.length > 0 && !rows.some((r) => r.title);
  const stage = (name, matches) => ({ stage: name, matches });
  const exactStages = [];
  if (NODE_ID_RE.test(q)) {
    exactStages.push(stage("node id", rows.filter((r) => r.id === q)));
  }
  exactStages.push(stage("exact layer name", rows.filter((r) => fold(r.name) === qFold)));
  exactStages.push(stage("indexed title", rows.filter((r) => r.title && fold(r.title) === qFold)));
  const plans = planRows(options.planDir);
  const planHit = plans.filter((p) => p.screenName === q || p.route === q);
  if (planHit.length) {
    const ids = new Set(planHit.map((p) => p.nodeId).filter(Boolean));
    exactStages.push(stage("plan screenName/route", rows.filter((r) => ids.has(r.id))));
  } else {
    exactStages.push(stage("plan screenName/route", []));
  }
  for (const s of exactStages) {
    if (s.matches.length === 1) return { status: "resolved", row: s.matches[0], stage: s.stage };
    if (s.matches.length > 1) return { status: "ambiguous", stage: s.stage, candidates: s.matches.map(describe) };
  }
  const textMatches = rows.filter(
    (r) => r.name && fold(r.name).includes(qFold) || r.title && fold(r.title).includes(qFold) || Array.isArray(r.texts) && r.texts.some((t) => fold(t).includes(qFold))
  );
  if (textMatches.length) {
    return Object.assign(
      { status: "needs-confirmation", stage: "text search", candidates: textMatches.map(describe) },
      noTitles ? { noTitles: true } : null
    );
  }
  return Object.assign({ status: "not-found", candidates: rows.map(describe) }, noTitles ? { noTitles: true } : null);
}
module.exports = { resolveScreen, allRows, planRows, describe, NODE_ID_RE };
if (require.main === module) {
  const [exportDir, query, planDir] = process.argv.slice(2);
  if (!exportDir || !query) {
    console.error("usage: node design-to-code/resolve-screen.js <design/export dir> <name-or-id> [design/plan dir]");
    process.exit(2);
  }
  const NOTITLES_NOTE = "note   this export's index carries no titles (pulled before title indexing) \u2014 re-pull the screen (`dtwin pull --node <id>`) to enable lookup by title";
  const listCandidates = (candidates) => {
    for (const c of candidates) console.error(`  ${c.id}  ${c.name}${c.title ? ` (title: "${c.title}")` : ""}  ${c.w || "?"}x${c.h || "?"}  nodes=${c.nodes ?? "?"}  ${c.reference || ""}  -> ${c.screenshot}`);
  };
  const res = resolveScreen(exportDir, query, { planDir });
  if (res.status === "resolved") {
    console.log(`resolved '${query}' -> ${res.row.name} (${res.row.id}) via ${res.stage}`);
    process.stdout.write(JSON.stringify(res.row, null, 2) + "\n");
    process.exit(0);
  }
  if (res.status === "ambiguous") {
    console.error(`error  '${query}' matches ${res.candidates.length} screens at the '${res.stage}' stage \u2014 pick one by node id:`);
    listCandidates(res.candidates);
    process.exit(1);
  }
  if (res.status === "needs-confirmation") {
    console.error(`error  '${query}' matched only by text search \u2014 confirm with the node id (never resolved automatically from a substring hit):`);
    listCandidates(res.candidates);
    if (res.noTitles) console.error(NOTITLES_NOTE);
    process.exit(1);
  }
  console.error(`error  '${query}' matches no screen. Known layers:`);
  listCandidates(res.candidates);
  if (res.noTitles) console.error(NOTITLES_NOTE);
  process.exit(1);
}
