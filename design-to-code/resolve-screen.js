// resolve-screen.js — the ONE screen-name resolution procedure, called by every skill instead of each
// re-inventing (or half-implementing) it. P3 #16/#17/#19/#70/#71/#72/#73/#90/#120/#150/#151/#152/#200.
//
// The defect this closes: the export indexes only the Figma LAYER name, which in a real file is
// wrong ("positions " really shows "Job Roles"), duplicated (four "System Configurations" frames) or
// a near-match to a DIFFERENT screen ("Job Role Details" for a query of "Job Roles"). Different
// skills used to pick different fallbacks for the same situation — silently auditing the wrong frame
// in one, finding nothing in another, listing candidates in a third. This module is the one place
// that decision gets made, so it is made the same way everywhere.
//
// Resolution order, each stage tried only if the previous one matched NOTHING:
//   1. node id           — the query IS a Figma node id (e.g. "7314:87192"); ids are unique, this
//                           either matches exactly one row or none exist for that id.
//   2. exact layer name   — row.name === query, byte for byte (trailing spaces and all).
//   3. indexed title      — row.title === query (case-insensitive): the text a user actually reads.
//   4. plan screenName/route — design/plan/*.json's schema'd header (screenName, nodeId, route),
//                           resolved back to the row whose id === that plan's nodeId.
//   5. text search        — query is a case-insensitive substring of row.name, row.title, or any of
//                           row.texts (the first N deduped text strings on the frame).
//
// A stage that matches MORE THAN ONE row stops immediately — it does not fall through to a later,
// looser stage, and it never picks the "closest" one. Zero matches at every stage also stops. Only a
// stage that matches EXACTLY ONE row resolves. This is deliberate (finding 70): a fuzzy match found
// "Job Role Details" for a query of "Job Roles" and produced a confident, wrong audit. Ambiguity and
// absence get the same treatment — stop, list candidates, write nothing.
const fs = require("fs");
const path = require("path");

function readJsonOr(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; }
}

// A Figma node id looks like "1234:5678" (also seen with an "I" instance prefix and ";" chains, e.g.
// "I20173:137670;72:3148" — but a USER never types one of those; they type either a plain id or a
// name). Treat only the plain "<digits>:<digits>" shape as an id query.
const NODE_ID_RE = /^\d+:\d+$/;

// Every screen row this export knows about, wherever it is indexed. Prefers the root index's
// flattened `layers` (P3 #16 — the file every skill is told to read); falls back to walking each
// page's own index.json for an export written before that field existed.
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

// design/plan/*.json's schema'd header (screenName, nodeId, route, file — see verify-build.js) is a
// secondary lookup, never primary (finding 151/180): it only works when a human wrote a good
// screenName, and finding 151's sibling plan for the SAME run had nothing useful in it. Used here only
// to map a query to a nodeId, which is then resolved through the same row list as everything else.
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

// One candidate line for the "stop and list" report: enough to tell same-named frames apart without
// opening any file (finding 19 — node count / id / reference PNG are the only discriminators between
// two `Create Activity Type` frames of identical name/type/w/h).
function describe(row) {
  return {
    name: row.name,
    id: row.id,
    title: row.title || null,
    w: row.w,
    h: row.h,
    nodes: row.nodes,
    reference: row.reference || null,
    screenshot: row.id ? `dtwin screenshot ${row.id}` : null,
  };
}

// Returns { status: "resolved", row, stage } | { status: "ambiguous"|"not-found", stage, candidates }.
// Never throws on a query that matches nothing or matches many — that is the expected, handled case.
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
        (r) =>
          (r.name && r.name.toLowerCase().includes(qLower)) ||
          (r.title && r.title.toLowerCase().includes(qLower)) ||
          (Array.isArray(r.texts) && r.texts.some((t) => t.toLowerCase().includes(qLower)))
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

// CLI: node design-to-code/resolve-screen.js <design/export dir> <name-or-id> [design/plan dir]
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
    console.error(`error  '${query}' matches ${res.candidates.length} screens at the '${res.stage}' stage — pick one by node id:`);
    for (const c of res.candidates) console.error(`  ${c.id}  ${c.name}${c.title ? ` (title: "${c.title}")` : ""}  ${c.w || "?"}x${c.h || "?"}  nodes=${c.nodes ?? "?"}  ${c.reference || ""}  -> ${c.screenshot}`);
    process.exit(1);
  }
  console.error(`error  '${query}' matches no screen. Known layers:`);
  for (const c of res.candidates) console.error(`  ${c.id}  ${c.name}${c.title ? ` (title: "${c.title}")` : ""}  ${c.w || "?"}x${c.h || "?"}  nodes=${c.nodes ?? "?"}  ${c.reference || ""}  -> ${c.screenshot}`);
  process.exit(1);
}
