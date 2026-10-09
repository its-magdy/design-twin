// resolve-screen.ts — the ONE screen-name resolution procedure, called by every skill instead of each
// re-inventing (or half-implementing) it.
//
// The defect this closes: the export indexes only the Figma LAYER name, which in a real file is
// wrong ("positions " really shows "Jet Roles"), duplicated (four "Studio Configurations" frames) or
// a near-match to a DIFFERENT screen ("Jet Role Details" for a query of "Jet Roles"). Different
// skills would pick different fallbacks for the same situation — silently auditing the wrong frame
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
//   4b. a carried id      — only when the union is empty: the id a `<Layer>__<a>_<b>` basename (or a
//                            path to its .json) or a dash/URL form carries (stage "node id").
//   4c. the folded union  — only when 2–4b found nothing: the same three fields compared with ALL
//                            whitespace, "-" and "_" removed and case folded, after a directory part and a
//                            file tail (`.json`, `.measured.json`, `.png`) are dropped from the query, so a
//                            plan file's name or path (`CropPlans.json`, `design/plan/CropPlans.json`),
//                            `seed-swaps` or `SeedSwaps` finds the screen named "Crop Plans" / "Seed Swaps".
//                            Two or more rows are still AMBIGUOUS (listed with their node ids); an
//                            exact match always wins because this stage never runs after one.
//   5. text search        — query is a case-insensitive substring of row.name, row.title, or any of
//                            row.texts (the first N deduped text strings on the frame).
//
// Evaluating exact layer name -> title -> plan header as a SEQUENCE, each tried only if the previous
// stage matched nothing, is itself a fuzziness bug — pull the empty-state
// sibling of "Jet Roles" (layer `Jet roles`, node 7314:83742) next to the real one (layer
// `positions `, node 7314:87192) and the case-insensitive layer-name stage matches exactly the ONE
// row named `Jet roles`, resolves, and never even LOOKS at the title stage — where the OTHER row
// (`positions `, title "Jet Roles") would also have matched. Two rows visibly titled "Jet Roles" is
// exactly the ambiguity this module exists to catch, and a sequence of independent exact stages hid it.
// Collecting the union first is what makes "evaluated together" true in code, not just in comment.
//
// Text search (stage 5) NEVER resolves, even on exactly one hit:
// a text-search hit is always reported as `needs-confirmation` — a candidate list the caller must
// resolve by node id — never as `resolved`. This is what "never take a near-match" / "do not make
// name matching fuzzy" means in code: fuzziness may narrow the list, it may never pick from it.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { IndexRow, ResolveScreenResult, ScreenCandidate } from "./types.ts";
import { isPageIndex, isPagesRootIndex, isPlan } from "./doc-guards.ts";
import { readJsonOrNull } from "./read-json.ts";
import { ifDefined } from "../bridge/src/json-util.ts";
import { toNodeId } from "../bridge/src/node-id.ts";
import { getOrInit } from "./map-util.ts";
import { cliArity, cliParse, scriptCmd } from "./cli-args.ts";
import { isMainFallback } from "../bridge/src/is-main.ts"; // import.meta.main is undefined before Node 24.2
import { EXPORT_DIR, EXPORT_SUBDIR, listPlans } from "../bridge/src/project-layout.ts";

// Every file read here (pages/index.json, a page's index.json, design/plan/*.json) is checked against its
// doc-guards.ts guard; one that is absent, unreadable or not that kind of document contributes no rows.

// A Figma node id looks like "1234:5678" (also seen with an "I" instance prefix and ";" chains, e.g.
// "I20173:137670;72:3148" — but a USER never types one of those; they type either a plain id or a
// name). Treat only the plain "<digits>:<digits>" shape as an id query.
const NODE_ID_RE = /^\d+:\d+$/;

// The basename the skills pass, `<Layer>__<a>_<b>` (a screen file's name without its directory), with an
// optional `.json` / `.vars.json` / `.expected.json` / `.png` tail -> the id "a:b"; undefined for anything else.
const BASENAME_ID_RE = /__(\d+)_(\d+)(?:\.[A-Za-z0-9-]+)*$/;

// The node ids a query could mean, most specific first: the basename form, then a dash/URL/percent form
// ("10093-75273", "…?node-id=10093-75273"). A query that is already "a:b" needs no help (stage 1 takes it).
function queryIds(q: string): string[] {
  const out: string[] = [];
  const base = q.split(/[\\/]/).pop() ?? q;
  const m = BASENAME_ID_RE.exec(base);
  if (m) out.push(`${m[1]}:${m[2]}`);
  const t = toNodeId(q);
  if (t !== q && NODE_ID_RE.test(t)) out.push(t);
  return out;
}

// The export root a mistaken dir points at: the first ancestor holding pages/index.json, else one that sits
// just below (`<dir>/export`, `<dir>/design/export`). null when there is none.
function findExportRoot(dir: string): string | null {
  const has = (d: string): boolean => fs.existsSync(path.join(d, "pages", "index.json"));
  const abs = path.resolve(dir);
  for (let d = path.dirname(abs); ; d = path.dirname(d)) {
    if (has(d)) return d;
    if (path.dirname(d) === d) break;
  }
  for (const sub of [EXPORT_SUBDIR, EXPORT_DIR]) {
    if (has(path.join(abs, sub))) return path.join(abs, sub);
  }
  return null;
}

// Every screen row this export knows about, wherever it is indexed. Prefers the root index's
// flattened `layers` (the file every skill is told to read); falls back to walking each
// page's own index.json for an export written before that field existed.
function allRows(exportDir: string): IndexRow[] {
  const rootFile = path.join(exportDir, "pages", "index.json");
  const root = readJsonOrNull(rootFile, isPagesRootIndex);
  if (!root) return [];
  if (root.layers) return root.layers;
  const rows: IndexRow[] = [];
  for (const pd of root.pageDirs) {
    const idx = pd.dir ? readJsonOrNull(path.join(exportDir, "pages", pd.dir, "index.json"), isPageIndex) : null;
    if (idx) rows.push(...idx.layers);
  }
  return rows;
}

/** The plan header fields resolveScreen consults (design/plan/<screen>.json). */
export interface PlanRow { file: string; screenName?: string | null; nodeId?: string | null; route?: string | null }

// design/plan/*.json's schema'd header (screenName, nodeId, route, file — see verify-build.ts) is a
// secondary lookup, never primary: it only works when a human wrote a good
// screenName, and a sibling plan for the SAME run can have nothing useful in it. Used here only
// to map a query to a nodeId, which is then resolved through the same row list as everything else.
function planRows(planDir: string | null | undefined): PlanRow[] {
  if (!planDir) return [];
  const out: PlanRow[] = [];
  for (const f of listPlans(planDir)) {
    const doc = readJsonOrNull(path.join(planDir, f), isPlan);
    if (doc && (doc.screenName || doc.nodeId)) out.push({ file: f, ...ifDefined("screenName", doc.screenName), ...ifDefined("nodeId", doc.nodeId), ...ifDefined("route", doc.route) });
  }
  return out;
}

// One candidate line for the "stop and list" report: enough to tell same-named frames apart without
// opening any file (node count / id / reference PNG are the only discriminators between
// two `Create Assembly Type` frames of identical name/type/w/h). `matchedVia`, when passed, is which
// field(s) in the exact union this particular row matched on (the report must say
// WHICH field, not just that it matched, since two rows can carry the same title under different
// layer names).
function describe(row: IndexRow, matchedVia?: string[]): ScreenCandidate {
  const out: ScreenCandidate = {
    name: row.name,
    id: row.id,
    title: row.title || null,
    ...ifDefined("w", row.w),
    ...ifDefined("h", row.h),
    ...ifDefined("nodes", row.nodes),
    reference: row.reference || null,
    screenshot: row.id ? `dtwin screenshot ${row.id}` : null,
  };
  if (matchedVia && matchedVia.length) out.matchedVia = matchedVia;
  return out;
}

const fold = (s: unknown): string => String(s || "").trim().toLowerCase();
// The 4c comparison: every whitespace, "-" and "_" run dropped, case folded ("SeedSwaps" === "seed-swaps" ===
// "Seed Swaps").
const foldCompact = (s: unknown): string => String(s || "").replace(/[\s_-]+/g, "").toLowerCase();

// A file name the skills pass for a screen: a plan (`CropPlans.json`) or a verify artefact
// (`Crop_Plans.measured.json`, `.expected.json`, `.vars.json`, `.png`); the extension is not part of the screen name.
const FILE_TAIL_RE = /(?:\.(?:measured|expected|vars))?\.json$|\.png$/i;

// The 4c keys a query could mean, most specific first: the whole query minus a file tail, then its last path
// segment minus the tail ("design/plan/CropPlans.json" -> "CropPlans"). The whole query goes first because a
// layer name may itself contain a slash ("Settings / Profile", "Admin/Login"); the last segment is tried only for
// something that reads as a repo path (a file tail, or a design/ root or plan/ verify/ export/ directory), so neither
// "Profile / Settings" nor "Admin/Login" falls back to its last half.
const PATH_DIR_RE = /^design[\\/]|[\\/](?:plan|verify|export)[\\/]/i;
function compactKeys(q: string): string[] {
  const keys: string[] = [];
  const asPath = FILE_TAIL_RE.test(q) || PATH_DIR_RE.test(q);
  for (const cand of asPath ? [q, q.split(/[\\/]/).pop() ?? q] : [q]) {
    const k = foldCompact(cand.trim().replace(FILE_TAIL_RE, ""));
    if (k && !keys.includes(k)) keys.push(k);
  }
  return keys;
}

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
function resolveScreen(exportDir: string, query: unknown, opts?: { planDir?: string | null }): ResolveScreenResult {
  const options = opts || {};
  const rows = allRows(exportDir);
  const q = String(query || "").trim();
  const qFold = fold(q);
  const noTitles = rows.length > 0 && !rows.some((r) => r.title);

  // Nothing to resolve against: <dir> is not an export root (no pages/index.json). Say so, and name the root
  // when it is one level off — an empty "Known layers:" list reads as "this screen does not exist".
  if (!fs.existsSync(path.join(exportDir, "pages", "index.json"))) {
    return { status: "not-found", candidates: [], noIndex: { dir: exportDir, hint: findExportRoot(exportDir) } };
  }

  // Stage 1: node id. Evaluated ALONE — an id is unique and never joins the name/title union below.
  const byId = (id: string): IndexRow | undefined => {
    const idMatches = rows.filter((r) => r.id === id);
    // idMatches.length > 1 cannot legitimately happen (ids are unique in one export) and 0 falls
    // through to the union below on the off chance the query is BOTH id-shaped and a real name.
    return idMatches.length === 1 ? idMatches[0] : undefined;
  };
  const typed = NODE_ID_RE.test(q) ? byId(q) : undefined;
  if (typed) return { status: "resolved", row: typed, stage: "node id" };

  // Stages 2–4, evaluated TOGETHER as one union: a row joins the pool if it matches on
  // ANY of exact layer name / indexed title / plan screenName-route, and every field it matched on
  // is recorded so the candidate list (if the union has >1 row) says which.
  const plans = planRows(options.planDir);
  // screenName and route are trimmed and case-folded like the layer name and title. An empty query matches no
  // plan (a plan without a screenName would otherwise fold to "" and equal it).
  const planHit = qFold ? plans.filter((p) => fold(p.screenName) === qFold || fold(p.route) === qFold) : [];
  const planIds = new Set(planHit.map((p) => p.nodeId).filter((id): id is string => !!id));

  const union = new Map<string, { row: IndexRow; via: Set<string> }>(); // row.id -> { row, via: Set<string> }
  const join = (row: IndexRow, via: string): void => {
    const key = row.id || row.file || JSON.stringify(row);
    getOrInit(union, key, () => ({ row, via: new Set<string>() })).via.add(via);
  };
  for (const r of rows) {
    if (fold(r.name) === qFold) join(r, "exact layer name");
    if (r.title && fold(r.title) === qFold) join(r, "indexed title");
    if (planIds.has(r.id)) join(r, "plan screenName/route");
  }
  const unionRows = [...union.values()];
  const only = unionRows.length === 1 ? unionRows[0] : undefined;
  if (only) {
    return { status: "resolved", row: only.row, stage: [...only.via].join(" + ") };
  }
  if (unionRows.length > 1) {
    return {
      status: "ambiguous",
      stage: "exact match (layer name / title / plan header)",
      candidates: unionRows.map((u) => describe(u.row, [...u.via])),
    };
  }

  // Stage 4b: an id the query CARRIES — `<Layer>__<a>_<b>` (basename or a path to the .json) or a dash/URL
  // form. Only after the exact stages found nothing: a layer actually NAMED `Wizard__1_2` is that layer,
  // not whichever row has id 1:2.
  for (const id of NODE_ID_RE.test(q) ? [] : queryIds(q)) {
    const hit = byId(id);
    if (hit) return { status: "resolved", row: hit, stage: "node id" };
  }

  // Stage 4c: the same three fields, ignoring whitespace, "-", "_" and case. Nothing exact matched (or carried an
  // id), so a query such as a plan file's name or path (`design/plan/CropPlans.json` -> "CropPlans", `crop-plans`)
  // can still find "Crop Plans". One row resolves; two or more stop and list (e.g. two frames named "Crop Plans",
  // or "Crop Plans" and "Crop-Plans"): a fold that makes rows equal never picks one.
  for (const qCompact of compactKeys(q)) {
    const planCompactIds = new Set(
      plans.filter((p) => foldCompact(p.screenName) === qCompact || foldCompact(p.route) === qCompact).map((p) => p.nodeId).filter((id): id is string => !!id)
    );
    const compact = new Map<string, { row: IndexRow; via: Set<string> }>();
    const joinCompact = (row: IndexRow, via: string): void => {
      const key = row.id || row.file || JSON.stringify(row);
      getOrInit(compact, key, () => ({ row, via: new Set<string>() })).via.add(via);
    };
    for (const r of rows) {
      if (foldCompact(r.name) === qCompact) joinCompact(r, "layer name ignoring spaces");
      if (r.title && foldCompact(r.title) === qCompact) joinCompact(r, "indexed title ignoring spaces");
      if (planCompactIds.has(r.id)) joinCompact(r, "plan screenName/route ignoring spaces");
    }
    const compactRows = [...compact.values()];
    const one = compactRows.length === 1 ? compactRows[0] : undefined;
    if (one) return { status: "resolved", row: one.row, stage: [...one.via].join(" + ") };
    if (compactRows.length > 1) {
      return {
        status: "ambiguous",
        stage: "whitespace-insensitive match (layer name / title / plan header)",
        candidates: compactRows.map((u) => describe(u.row, [...u.via])),
      };
    }
  }

  // Stage 5: text search. A hit here is a CANDIDATE, never a result — see the file header (a single
  // substring hit is not resolved outright).
  const textMatches = rows.filter(
    (r) =>
      (r.name && fold(r.name).includes(qFold)) ||
      (r.title && fold(r.title).includes(qFold)) ||
      (Array.isArray(r.texts) && r.texts.some((t) => fold(t).includes(qFold)))
  );
  if (textMatches.length) {
    return Object.assign<Extract<ResolveScreenResult, { status: "needs-confirmation" }>, { noTitles: true } | null>(
      { status: "needs-confirmation", stage: "text search", candidates: textMatches.map((r) => describe(r)) },
      noTitles ? { noTitles: true } : null
    );
  }

  return Object.assign<Extract<ResolveScreenResult, { status: "not-found" }>, { noTitles: true } | null>({ status: "not-found", candidates: rows.map((r) => describe(r)) }, noTitles ? { noTitles: true } : null);
}

export { resolveScreen, allRows, planRows, describe, NODE_ID_RE };

// CLI: node <plugin>/scripts/resolve-screen.js <design/export dir> <name-or-id> [design/plan dir]
// (the installed path in a consumer project; in THIS repo it is design-to-code/resolve-screen.ts).
function main(argv: string[]): number {
  const usage = `usage: ${scriptCmd("resolve-screen")} <design/export dir> <name-or-id> [design/plan dir]`;
  if (argv.includes("--help") || argv.includes("-h")) { console.log(usage); return 0; }
  const OPTIONS = { help: { type: "boolean", short: "h" } } as const;
  const { positionals } = cliParse("resolve-screen", argv, OPTIONS, usage, 2, (args) => parseArgs({ args, options: OPTIONS, allowPositionals: true }));
  if (!cliArity("resolve-screen", positionals, 2, 3, usage)) return 2;
  const [exportDir, query, planDir] = positionals;
  if (!exportDir || !query) {
    console.error(usage);
    return 2;
  }
  const NOTITLES_NOTE =
    "note   this export's index carries no titles (pulled before title indexing) — re-pull the " +
    "screen (`dtwin pull --node <id>`) to enable lookup by title";
  const listCandidates = (candidates: ScreenCandidate[]): void => {
    for (const c of candidates) console.error(`  ${c.id}  ${c.name}${c.title ? ` (title: "${c.title}")` : ""}${c.matchedVia ? ` [matched: ${c.matchedVia.join(", ")}]` : ""}  ${c.w || "?"}x${c.h || "?"}  nodes=${c.nodes ?? "?"}  ${c.reference || ""}  -> ${c.screenshot}`);
  };
  const res = resolveScreen(exportDir, query, { ...ifDefined("planDir", planDir) });
  if (res.status === "resolved") {
    console.log(`resolved '${query}' -> ${res.row.name} (${res.row.id}) via ${res.stage}`);
    process.stdout.write(JSON.stringify(res.row, null, 2) + "\n");
    return 0;
  }
  if (res.status === "ambiguous") {
    console.error(`error  '${query}' matches ${res.candidates.length} screens at the '${res.stage}' stage — pick one by node id:`);
    listCandidates(res.candidates);
    return 1;
  }
  if (res.status === "needs-confirmation") {
    console.error(`error  '${query}' matched only by text search — confirm with the node id (never resolved automatically from a substring hit):`);
    listCandidates(res.candidates);
    if (res.noTitles) console.error(NOTITLES_NOTE);
    return 1;
  }
  if (res.noIndex) {
    console.error(`error  '${exportDir}' is not an export root (no pages/index.json) — ${res.noIndex.hint ? `pass ${res.noIndex.hint}` : "pass the dir that holds pages/ (design/export)"}`);
    return 1;
  }
  console.error(`error  '${query}' matches no screen. Known layers:`);
  listCandidates(res.candidates);
  if (res.noTitles) console.error(NOTITLES_NOTE);
  return 1;
}

if (import.meta.main ?? isMainFallback(import.meta.url)) process.exitCode = main(process.argv.slice(2));
