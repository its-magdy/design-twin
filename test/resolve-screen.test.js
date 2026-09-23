// test/resolve-screen.test.js — P3 #16 #17 #19 #70 #71 #72 #73 #90 #120 #150 #151 #152 #200.
//
// Fixture: test/fixtures/livetest3/pages/ is copied VERBATIM (node trees pruned to
// type/name/id/text/children/box/manifest/page/pageId/nodeId/screen/exportedAt — the fields
// deriveTitle/collectTexts/resolveScreen actually read) from the real end-to-end export at
// /Users/mohamedomarwork/design-twin-livetest-3/design/export/pages/, five real screens:
// `positions ` (visible title "Job Roles"), `System Configurations` (visible title "Global
// Policies"), `Job Role Details`, and two same-named `Create Activity Type` frames. The root
// pages/index.json in the fixture was regenerated the same way bridge/write-out.js now does it —
// pageDirs unchanged, `layers` added with title/texts derived by bridge/pages-layout.js's own
// deriveTitle/collectTexts run over each screen's real node tree — so this is exactly the shape a
// re-pull produces, not a hand-written approximation.
//
// P1 (Wave A, merged first into fix/livetest-3) ALSO built fixtures at
// pages/__Organization_management_/positions___7314_87192.json,
// .../System_Configurations__1359_21337.json and pages/In_progress/Create_Activity_Type__18411_84111.json
// for test/identity.test.js — pruned differently (mainComponent/props/component/tokens kept, TEXT
// nodes/box/manifest/exportedAt dropped), so identity.test.js's component-identity checks have what
// they need. Two prompts need two different prunings of the SAME three real screens under the SAME
// canonical path; per the rebase instruction ("keep both sets, no overwrites") the canonical path
// stays P1's (identity.test.js hardcodes it), and this suite's own copies of exactly those three
// files — pruned the way THIS suite needs (TEXT nodes, box, manifest, exportedAt kept) — live under
// the sibling `pages-titled/` instead. Nothing here reads test/fixtures/livetest3/pages/<those three
// paths> for title/texts derivation; `Job_Role_Details` and the second `Create_Activity_Type` (both
// untouched by P1) stay under `pages/` as before.
const fs = require("fs");
const path = require("path");
const { ok, report } = require("./assert.js");
const { deriveTitle, collectTexts } = require("../bridge/pages-layout.js");
const { resolveScreen } = require("../design-to-code/resolve-screen.js");

const FIXTURE = path.join(__dirname, "fixtures", "livetest3");

console.log("resolve-screen — title/texts derivation over the REAL export:");

function screenRoot(pageDir, file, base) {
  const d = JSON.parse(fs.readFileSync(path.join(FIXTURE, base || "pages", pageDir, file), "utf8"));
  return d.nodes[0];
}

ok("[title] `positions ` (trailing space, layer name) visibly reads 'Job Roles' — deriveTitle finds it, not the sidebar nav item",
  deriveTitle(screenRoot("__Organization_management_", "positions___7314_87192.json", "pages-titled")) === "Job Roles");

ok("[title] `System Configurations` visibly reads 'Global Policies' — NOT the `Sub titles` nav label of the same text (finding 120)",
  deriveTitle(screenRoot("__Organization_management_", "System_Configurations__1359_21337.json", "pages-titled")) === "Global Policies");

ok("[title] `Job Role Details` (a real, different screen from 'Job Roles') keeps its own title",
  deriveTitle(screenRoot("__Organization_management_", "Job_Role_Details__20174_143363.json")) === "Job Role Details");

ok("[title] both same-named `Create Activity Type` frames resolve their OWN Page Title text",
  deriveTitle(screenRoot("In_progress", "Create_Activity_Type__18411_84111.json", "pages-titled")) === "Add Activity Type" &&
  deriveTitle(screenRoot("In_progress", "Create_Activity_Type__18411_84502.json")) === "Add Activity Type");

ok("[title] a Page Title instance's leading Breadcrumb placeholder ('Text') is never mistaken for the title",
  deriveTitle(screenRoot("__Organization_management_", "positions___7314_87192.json", "pages-titled")) !== "Text");

ok("[texts] collectTexts returns deduped, non-empty strings in reading order, capped",
  (() => {
    const texts = collectTexts(screenRoot("__Organization_management_", "positions___7314_87192.json", "pages-titled"));
    return texts.length > 0 && texts.length <= 8 && new Set(texts).size === texts.length && texts.every((t) => t.trim());
  })());

console.log("\nresolve-screen — the resolution procedure (P3 #16 #70 #71 #90 #120 #150):");

ok("[resolve] #90 'Job Roles' (visible title; the layer is named `positions ` with a trailing space) resolves to 7314:87192, not nothing",
  (() => { const r = resolveScreen(FIXTURE, "Job Roles"); return r.status === "resolved" && r.row.id === "7314:87192"; })());

ok("[resolve] #70 'Job Roles' never resolves to 'Job Role Details' (20174:143363) — no fuzzy fallback",
  resolveScreen(FIXTURE, "Job Roles").row.id !== "20174:143363");

ok("[resolve] #120 'Global Policies' resolves to the ONE screen actually titled that (1359:21337), not the sidebar match on all three",
  (() => { const r = resolveScreen(FIXTURE, "Global Policies"); return r.status === "resolved" && r.row.id === "1359:21337"; })());

// Round 2: a text-search hit is NEVER auto-resolved, even the single-hit case (finding 70 verbatim
// on the pre-title export) — it is always `needs-confirmation`, a candidate list to pick from by id.
ok("[resolve] #71/#150 an ambiguous partial name ('Job Role') STOPS as needs-confirmation and lists candidates rather than guessing",
  (() => {
    const r = resolveScreen(FIXTURE, "Job Role");
    return r.status === "needs-confirmation" && r.stage === "text search" && r.candidates.length >= 2 &&
      r.candidates.some((c) => c.id === "20174:143363") && r.candidates.some((c) => c.id === "7314:87192");
  })());

ok("[resolve] a name matching nothing STOPS and lists every known layer (never the nearest string)",
  (() => {
    const r = resolveScreen(FIXTURE, "Totally Unknown Screen Name");
    return r.status === "not-found" && r.candidates.length === 5;
  })());

ok("[resolve] a bare node id resolves directly, ahead of any name stage",
  (() => { const r = resolveScreen(FIXTURE, "7314:87192"); return r.status === "resolved" && r.stage === "node id"; })());

ok("[resolve] #19/#72/#73 two same-named `Create Activity Type` frames are ambiguous and distinguishable by id, node count and reference",
  (() => {
    const r = resolveScreen(FIXTURE, "Create Activity Type");
    if (r.status !== "ambiguous") return false;
    const ids = r.candidates.map((c) => c.id).sort();
    const nodes = r.candidates.map((c) => c.nodes);
    return ids.join("|") === "18411:84111|18411:84502" && new Set(nodes).size === r.candidates.length &&
      r.candidates.every((c) => c.reference && c.screenshot === `dtwin screenshot ${c.id}`);
  })());

ok("[resolve] node id ALWAYS beats a name stage, even if the id string also happens to be a substring elsewhere",
  (() => { const r = resolveScreen(FIXTURE, "20174:143363"); return r.status === "resolved" && r.row.name === "Job Role Details"; })());

// The query is trimmed before matching (a human typing a query rarely means a trailing space), so
// 'positions ' (with the trailing space the layer itself carries) matches via text search rather
// than the exact-name stage — either way it must resolve to the ONE right screen.
ok("[resolve] 'positions ' (the layer's own trailing-space name) still resolves to the one screen it names",
  (() => { const r = resolveScreen(FIXTURE, "positions "); return r.status === "resolved" && r.row.id === "7314:87192"; })());

ok("[resolve] the untrimmed exact layer name matches byte for byte when queried without surrounding whitespace to strip",
  (() => { const r = resolveScreen(FIXTURE, "System Configurations"); return r.status === "resolved" && r.row.id === "1359:21337" && r.stage === "exact layer name"; })());

console.log("\nresolve-screen — root index shape (P3 #16 acceptance criterion 1):");

ok("[index] the fixture's root pages/index.json carries a row with name 'positions ' AND title 'Job Roles'",
  (() => {
    const root = JSON.parse(fs.readFileSync(path.join(FIXTURE, "pages", "index.json"), "utf8"));
    return root.layers.some((l) => l.name === "positions " && l.title === "Job Roles");
  })());

ok("[index] and a row with name 'System Configurations' AND title 'Global Policies'",
  (() => {
    const root = JSON.parse(fs.readFileSync(path.join(FIXTURE, "pages", "index.json"), "utf8"));
    return root.layers.some((l) => l.name === "System Configurations" && l.title === "Global Policies");
  })());

// The prompt's literal `grep -i "job roles" pages/index.json` also matches a nav-label mention of
// "Job Roles" inside OTHER screens' `texts[]` (it is drawn in the sidebar of every Organization-
// management screen — the very trap finding 120 describes) — grep on raw text cannot tell "the
// visible page title" from "a word that also appears in a sidebar". The row-level `title` field is
// exactly what lets a consumer (or this test) ask that question precisely.
ok("[index] acceptance criterion 2: exactly one row's `title` is 'Job Roles', and it is 7314:87192",
  (() => {
    const root = JSON.parse(fs.readFileSync(path.join(FIXTURE, "pages", "index.json"), "utf8"));
    const hits = root.layers.filter((l) => l.title === "Job Roles");
    return hits.length === 1 && hits[0].id === "7314:87192";
  })());

console.log("\nresolve-screen — round 2: text search never auto-resolves, and a title-less export says so:");

// LEGACY fixture: the real pre-title-indexing root+page index (test/fixtures/livetest3/pages-legacy/,
// copied verbatim from /Users/mohamedomarwork/design-twin-livetest-3/design/export/pages/ — the
// exact shape this fix closes over). resolveScreen reads <exportDir>/pages/index.json, so build a
// throwaway exportDir whose pages/ IS this legacy content, rather than teaching the resolver a
// second index location it will never see in a real project.
const os = require("os");
function legacyExportDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-legacy-"));
  const pagesDir = path.join(tmp, "pages");
  fs.mkdirSync(path.join(pagesDir, "__Organization_management_"), { recursive: true });
  fs.copyFileSync(path.join(FIXTURE, "pages-legacy", "index.json"), path.join(pagesDir, "index.json"));
  fs.copyFileSync(
    path.join(FIXTURE, "pages-legacy", "__Organization_management_", "index.json"),
    path.join(pagesDir, "__Organization_management_", "index.json")
  );
  return tmp;
}
const LEGACY = legacyExportDir();

ok("[legacy] the legacy index really has no titles at all (sanity check on the fixture itself)",
  (() => { const root = JSON.parse(fs.readFileSync(path.join(LEGACY, "pages", "index.json"), "utf8")); return !root.layers; })());

ok("[round2] 'Job Role' on the LEGACY (title-less) export does NOT resolve — needs-confirmation, exit-worthy, not a silent wrong answer",
  (() => { const r = resolveScreen(LEGACY, "Job Role"); return r.status === "needs-confirmation" && r.stage === "text search"; })());

ok("[round2] and the message says the export predates title indexing",
  (() => { const r = resolveScreen(LEGACY, "Job Role"); return r.noTitles === true; })());

ok("[round2] a query matching NOTHING on the legacy export also flags noTitles",
  (() => { const r = resolveScreen(LEGACY, "Totally Unknown"); return r.status === "not-found" && r.noTitles === true; })());

ok("[round2] 'positions' (no trailing space, no case match needed) resolves at 'exact layer name', not text search",
  (() => { const r = resolveScreen(FIXTURE, "positions"); return r.status === "resolved" && r.row.id === "7314:87192" && r.stage === "exact layer name"; })());

ok("[round2] 'POSITIONS' (case-folded) also resolves at 'exact layer name'",
  (() => { const r = resolveScreen(FIXTURE, "POSITIONS"); return r.status === "resolved" && r.row.id === "7314:87192" && r.stage === "exact layer name"; })());

ok("[round2] 'Global Policies' on the NEW (titled) export resolves at 'indexed title', not text search",
  (() => { const r = resolveScreen(FIXTURE, "Global Policies"); return r.status === "resolved" && r.row.id === "1359:21337" && r.stage === "indexed title"; })());

ok("[round2] a query that hits only texts[] ('Units') is needs-confirmation, never resolved, and lists the hits",
  (() => {
    const r = resolveScreen(FIXTURE, "Units");
    return r.status === "needs-confirmation" && r.stage === "text search" && r.candidates.length >= 1 &&
      !r.noTitles; // this export DOES carry titles — only the legacy one should ever set noTitles
  })());

// "Job Role" above IS the single-substring-hit case (matches only "Job Role Details" on the legacy,
// title-less export) and is already asserted `needs-confirmation`, not `resolved` — this is finding
// 70 exactly as the coordinator reproduced it against the real pre-fix export.

report();
