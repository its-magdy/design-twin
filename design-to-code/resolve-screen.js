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
//   2. exact layer name   — row.name === query, trimmed and compared case-insensitively (the layer
//                           can be `positions ` with a trailing space; a user typing "positions"
//                           still means it byte-for-byte, they just didn't type the space).
//   3. indexed title      — row.title === query (trimmed, case-insensitive): the text a user reads.
//   4. plan screenName/route — design/plan/*.json's schema'd header (screenName, nodeId, route),
//                           resolved back to the row whose id === that plan's nodeId.
//   5. text search        — query is a case-insensitive substring of row.name, row.title, or any of
//                           row.texts (the first N deduped text strings on the frame).
//
// Stages 1–4 are EXACT (id, or trimmed/case-folded name/title/plan-header match) — a stage that
// matches more than one row there stops immediately, and zero matches falls through to the next
// stage. Only a stage that matches EXACTLY ONE row resolves.
//
// Stage 5 (text search) NEVER resolves, even on exactly one hit — round 2 of this fix: the
// substring "Job Role" matches ONLY "Job Role Details" on the pre-title-indexing export, and a
// single substring hit auto-resolving to it is finding 70 verbatim (a query for "Job Roles"
// silently landing on a different screen with full confidence). A text-search hit is always
// reported as `needs-confirmation` — a candidate list the caller must resolve by node id — never as
// `resolved`. This is what "never take a near-match" / "do not make name matching fuzzy" means in
// code: fuzziness may narrow the list, it may never pick from it.
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

const fold = (s) => String(s || "").trim().toLowerCase();

// Returns one of:
//   { status: "resolved", row, stage }                          — exactly one EXACT-stage match.
//   { status: "ambiguous", stage, candidates }                  — an exact stage matched >1 row.
//   { status: "needs-confirmation", stage: "text search", candidates } — one or more text-search
//     hits; never auto-picked, even when there is only one.
//   { status: "not-found", candidates, noTitles? }               — nothing matched anywhere;
//     `noTitles: true` when NOT ONE row in this export carries a `title` at all, meaning the export
//     predates title indexing and a re-pull (not a smarter query) is the fix.
// Never throws on a query that matches nothing or matches many — that is the expected, handled case.
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

  // Stage 5: text search. A hit here is a CANDIDATE, never a result — see the file header. This is
  // what closes finding 70 for real: the pre-fix version resolved a single substring hit outright.
  const textMatches = rows.filter(
    (r) =>
      (r.name && fold(r.name).includes(qFold)) ||
      (r.title && fold(r.title).includes(qFold)) ||
      (Array.isArray(r.texts) && r.texts.some((t) => fold(t).includes(qFold)))
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

// CLI: node design-to-code/resolve-screen.js <design/export dir> <name-or-id> [design/plan dir]
if (require.main === module) {
  const [exportDir, query, planDir] = process.argv.slice(2);
  if (!exportDir || !query) {
    console.error("usage: node design-to-code/resolve-screen.js <design/export dir> <name-or-id> [design/plan dir]");
    process.exit(2);
  }
  const NOTITLES_NOTE =
    "note   this export's index carries no titles (pulled before title indexing) — re-pull the " +
    "screen (`dtwin pull --node <id>`) to enable lookup by title";
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
    console.error(`error  '${query}' matches ${res.candidates.length} screens at the '${res.stage}' stage — pick one by node id:`);
    listCandidates(res.candidates);
    process.exit(1);
  }
  if (res.status === "needs-confirmation") {
    console.error(`error  '${query}' matched only by text search — confirm with the node id (never resolved automatically from a substring hit):`);
    listCandidates(res.candidates);
    if (res.noTitles) console.error(NOTITLES_NOTE);
    process.exit(1);
  }
  console.error(`error  '${query}' matches no screen. Known layers:`);
  listCandidates(res.candidates);
  if (res.noTitles) console.error(NOTITLES_NOTE);
  process.exit(1);
}
