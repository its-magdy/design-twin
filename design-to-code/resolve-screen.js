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
// Resolution order:
//   1. node id            — the query IS a Figma node id (e.g. "7314:87192"); ids are unique, this
//                            either matches exactly one row or none exist for that id. Evaluated
//                            ALONE and wins alone: a node id is never ambiguous with a name/title.
//   2–4. the EXACT union   — exact layer name, indexed title and plan screenName/route (each
//                            trimmed and case-folded) are evaluated TOGETHER, not as a sequence of
//                            independent stages. A row that matches ANY of the three joins ONE
//                            candidate pool; if that pool holds more than one row, the run stops and
//                            lists them (naming which field each one matched) — it does NOT resolve
//                            on whichever field happened to be checked first.
//   5. text search         — query is a case-insensitive substring of row.name, row.title, or any of
//                            row.texts (the first N deduped text strings on the frame).
//
// Round 3 (finding 310): evaluating exact layer name -> title -> plan header as a SEQUENCE, each
// tried only if the previous stage matched nothing, is itself a fuzziness bug — pull the empty-state
// sibling of "Job Roles" (layer `Job roles`, node 7314:83742) next to the real one (layer
// `positions `, node 7314:87192) and the case-insensitive layer-name stage matches exactly the ONE
// row named `Job roles`, resolves, and never even LOOKS at the title stage — where the OTHER row
// (`positions `, title "Job Roles") would also have matched. Two rows visibly titled "Job Roles" is
// exactly the ambiguity Prompt 3 exists to catch, and a sequence of independent exact stages hid it.
// Collecting the union first is what makes "evaluated together" true in code, not just in comment.
//
// Text search (stage 5) still NEVER resolves, even on exactly one hit (round 2's fix, finding 70):
// a text-search hit is always reported as `needs-confirmation` — a candidate list the caller must
// resolve by node id — never as `resolved`. This is what "never take a near-match" / "do not make
// name matching fuzzy" means in code: fuzziness may narrow the list, it may never pick from it.
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
// two `Create Activity Type` frames of identical name/type/w/h). `matchedVia`, when passed, is which
// field(s) in the exact union this particular row matched on (finding 310 — the report must say
// WHICH field, not just that it matched, since two rows can carry the same title under different
// layer names).
function describe(row, matchedVia) {
  const out = {
    name: row.name,
    id: row.id,
    title: row.title || null,
    w: row.w,
    h: row.h,
    nodes: row.nodes,
    reference: row.reference || null,
    screenshot: row.id ? `dtwin screenshot ${row.id}` : null,
  };
  if (matchedVia && matchedVia.length) out.matchedVia = matchedVia;
  return out;
}

const fold = (s) => String(s || "").trim().toLowerCase();

// Returns one of:
//   { status: "resolved", row, stage }                          — node id alone, or exactly one row
//     in the exact-stage union.
//   { status: "ambiguous", stage, candidates }                  — the exact-stage union has >1 row;
//     each candidate's `matchedVia` names which field(s) it matched on.
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

  // Stage 1: node id. Evaluated ALONE — an id is unique and never joins the name/title union below.
  if (NODE_ID_RE.test(q)) {
    const idMatches = rows.filter((r) => r.id === q);
    if (idMatches.length === 1) return { status: "resolved", row: idMatches[0], stage: "node id" };
    // idMatches.length > 1 cannot legitimately happen (ids are unique in one export) and 0 falls
    // through to the union below on the off chance the query is BOTH id-shaped and a real name.
  }

  // Stages 2–4, evaluated TOGETHER as one union (finding 310): a row joins the pool if it matches on
  // ANY of exact layer name / indexed title / plan screenName-route, and every field it matched on
  // is recorded so the candidate list (if the union has >1 row) says which.
  const plans = planRows(options.planDir);
  const planHit = plans.filter((p) => p.screenName === q || p.route === q);
  const planIds = new Set(planHit.map((p) => p.nodeId).filter(Boolean));

  const union = new Map(); // row.id -> { row, via: Set<string> }
  const join = (row, via) => {
    const key = row.id || row.file || JSON.stringify(row);
    if (!union.has(key)) union.set(key, { row, via: new Set() });
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
      candidates: unionRows.map((u) => describe(u.row, [...u.via])),
    };
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
      { status: "needs-confirmation", stage: "text search", candidates: textMatches.map((r) => describe(r)) },
      noTitles ? { noTitles: true } : null
    );
  }

  return Object.assign({ status: "not-found", candidates: rows.map((r) => describe(r)) }, noTitles ? { noTitles: true } : null);
}

module.exports = { resolveScreen, allRows, planRows, describe, NODE_ID_RE };

// CLI: node "${CLAUDE_PLUGIN_ROOT}/scripts/resolve-screen.js" <design/export dir> <name-or-id> [design/plan dir]
// (that is the installed path in a consumer project; in THIS repo it is design-to-code/resolve-screen.js).
if (require.main === module) {
  const [exportDir, query, planDir] = process.argv.slice(2);
  if (!exportDir || !query) {
    console.error('usage: node "${CLAUDE_PLUGIN_ROOT}/scripts/resolve-screen.js" <design/export dir> <name-or-id> [design/plan dir]');
    process.exit(2);
  }
  const NOTITLES_NOTE =
    "note   this export's index carries no titles (pulled before title indexing) — re-pull the " +
    "screen (`dtwin pull --node <id>`) to enable lookup by title";
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
