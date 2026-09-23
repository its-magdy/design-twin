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
function describe(row, matchedVia) {
  const out = {
    name: row.name,
    id: row.id,
    title: row.title || null,
    w: row.w,
    h: row.h,
    nodes: row.nodes,
    reference: row.reference || null,
    screenshot: row.id ? `dtwin screenshot ${row.id}` : null
  };
  if (matchedVia && matchedVia.length) out.matchedVia = matchedVia;
  return out;
}
var fold = (s) => String(s || "").trim().toLowerCase();
function resolveScreen(exportDir, query, opts) {
  const options = opts || {};
  const rows = allRows(exportDir);
  const q = String(query || "").trim();
  const qFold = fold(q);
  const noTitles = rows.length > 0 && !rows.some((r) => r.title);
  if (NODE_ID_RE.test(q)) {
    const idMatches = rows.filter((r) => r.id === q);
    if (idMatches.length === 1) return { status: "resolved", row: idMatches[0], stage: "node id" };
  }
  const plans = planRows(options.planDir);
  const planHit = plans.filter((p) => p.screenName === q || p.route === q);
  const planIds = new Set(planHit.map((p) => p.nodeId).filter(Boolean));
  const union = /* @__PURE__ */ new Map();
  const join = (row, via) => {
    const key = row.id || row.file || JSON.stringify(row);
    if (!union.has(key)) union.set(key, { row, via: /* @__PURE__ */ new Set() });
    union.get(key).via.add(via);
  };
  for (const r of rows) {
    if (fold(r.name) === qFold) join(r, "exact layer name");
    if (r.title && fold(r.title) === qFold) join(r, "indexed title");
    if (planIds.has(r.id)) join(r, "plan screenName/route");
  }
  const unionRows = [...union.values()];
  if (unionRows.length === 1) {
    const only = unionRows[0];
    return { status: "resolved", row: only.row, stage: [...only.via].join(" + ") };
  }
  if (unionRows.length > 1) {
    return {
      status: "ambiguous",
      stage: "exact match (layer name / title / plan header)",
      candidates: unionRows.map((u) => describe(u.row, [...u.via]))
    };
  }
  const textMatches = rows.filter(
    (r) => r.name && fold(r.name).includes(qFold) || r.title && fold(r.title).includes(qFold) || Array.isArray(r.texts) && r.texts.some((t) => fold(t).includes(qFold))
  );
  if (textMatches.length) {
    return Object.assign(
      { status: "needs-confirmation", stage: "text search", candidates: textMatches.map((r) => describe(r)) },
      noTitles ? { noTitles: true } : null
    );
  }
  return Object.assign({ status: "not-found", candidates: rows.map((r) => describe(r)) }, noTitles ? { noTitles: true } : null);
}
module.exports = { resolveScreen, allRows, planRows, describe, NODE_ID_RE };
if (require.main === module) {
  const [exportDir, query, planDir] = process.argv.slice(2);
  if (!exportDir || !query) {
    console.error('usage: node "${CLAUDE_PLUGIN_ROOT}/scripts/resolve-screen.js" <design/export dir> <name-or-id> [design/plan dir]');
    process.exit(2);
  }
  const NOTITLES_NOTE = "note   this export's index carries no titles (pulled before title indexing) \u2014 re-pull the screen (`dtwin pull --node <id>`) to enable lookup by title";
  const listCandidates = (candidates) => {
    for (const c of candidates) console.error(`  ${c.id}  ${c.name}${c.title ? ` (title: "${c.title}")` : ""}${c.matchedVia ? ` [matched: ${c.matchedVia.join(", ")}]` : ""}  ${c.w || "?"}x${c.h || "?"}  nodes=${c.nodes ?? "?"}  ${c.reference || ""}  -> ${c.screenshot}`);
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
