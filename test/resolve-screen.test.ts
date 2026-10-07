// test/resolve-screen.test.ts — P3 #16 #17 #19 #70 #71 #72 #73 #90 #120 #150 #151 #152 #200.
//
// Fixture: test/fixtures/livetest3/pages/ is copied VERBATIM (node trees pruned to
// type/name/id/text/children/box/manifest/page/pageId/nodeId/screen/exportedAt — the fields
// deriveTitle/collectTexts/resolveScreen actually read) from a live-test export (names replaced), five
// real screens: `positions ` (visible title "Jet Roles"), `Studio Configurations` (visible title
// "Guided Policies"), `Jet Role Details`, and two same-named `Create Assembly Type` frames. The root
// pages/index.json in the fixture was regenerated the same way bridge/write-out.js now does it —
// pageDirs unchanged, `layers` added with title/texts derived by bridge/pages-layout.js's own
// deriveTitle/collectTexts run over each screen's real node tree — so this is exactly the shape a
// re-pull produces, not a hand-written approximation.
//
// P1 (Wave A, merged first into fix/livetest-3) ALSO built fixtures at
// pages/__Optimization_management_/positions___7314_87192.json,
// .../Studio_Configurations__1359_21337.json and pages/In_progress/Create_Assembly_Type__18411_84111.json
// for test/identity.test.ts — pruned differently (mainComponent/props/component/tokens kept, TEXT
// nodes/box/manifest/exportedAt dropped), so identity.test.js's component-identity checks have what
// they need. Two prompts need two different prunings of the SAME three real screens under the SAME
// canonical path; per the rebase instruction ("keep both sets, no overwrites") the canonical path
// stays P1's (identity.test.js hardcodes it), and this suite's own copies of exactly those three
// files — pruned the way THIS suite needs (TEXT nodes, box, manifest, exportedAt kept) — live under
// the sibling `pages-titled/` instead. Nothing here reads test/fixtures/livetest3/pages/<those three
// paths> for title/texts derivation; `Jet_Role_Details` and the second `Create_Assembly_Type` (both
// untouched by P1) stay under `pages/` as before.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { check as ok, report } from "./assert.ts";
import { deriveTitle, collectTexts } from "../bridge/src/pages-layout.ts";
import { resolveScreen } from "../design-to-code/resolve-screen.ts";
import type { ResolveScreenResult, PagesRootIndex } from "../design-to-code/types.ts";
import type { TextWalkNode } from "../bridge/src/pages-layout.ts";
import { must, readFixture } from "./fixtures.ts";
import { isPagesRootIndex } from "../design-to-code/doc-guards.ts";
import { isScreenExport } from "../design-to-code/export-shape.ts";

type Unresolved = Exclude<ResolveScreenResult, { status: "resolved" }>;
// The arm a check expects; any other arm is a named failure (not a TypeError on a missing field).
const unresolved = (r: ResolveScreenResult): Unresolved => must(r.status === "resolved" ? null : r, "an unresolved result");

const FIXTURE = path.join(import.meta.dirname, "fixtures", "livetest3");

console.log("resolve-screen — title/texts derivation over the REAL export:");

// The fixture files as this suite reads them: a screen export and the root index, each checked by its guard.
const readRoot = (dir: string): PagesRootIndex => readFixture(path.join(dir, "pages", "index.json"), isPagesRootIndex);

function screenRoot(pageDir: string, file: string, base?: string): TextWalkNode {
  return must(readFixture(path.join(FIXTURE, base || "pages", pageDir, file), isScreenExport).nodes[0], "a root node");
}

ok("[title] `positions ` (trailing space, layer name) visibly reads 'Jet Roles' — deriveTitle finds it, not the sidebar nav item",
  deriveTitle(screenRoot("__Optimization_management_", "positions___7314_87192.json", "pages-titled")) === "Jet Roles");

ok("[title] `Studio Configurations` visibly reads 'Guided Policies' — NOT the `Sub titles` nav label of the same text (finding 120)",
  deriveTitle(screenRoot("__Optimization_management_", "Studio_Configurations__1359_21337.json", "pages-titled")) === "Guided Policies");

ok("[title] `Jet Role Details` (a real, different screen from 'Jet Roles') keeps its own title",
  deriveTitle(screenRoot("__Optimization_management_", "Jet_Role_Details__20174_143363.json")) === "Jet Role Details");

ok("[title] both same-named `Create Assembly Type` frames resolve their OWN Page Title text",
  deriveTitle(screenRoot("In_progress", "Create_Assembly_Type__18411_84111.json", "pages-titled")) === "Add Assembly Type" &&
  deriveTitle(screenRoot("In_progress", "Create_Assembly_Type__18411_84502.json")) === "Add Assembly Type");

ok("[title] a Page Title instance's leading Breadcrumb placeholder ('Text') is never mistaken for the title",
  deriveTitle(screenRoot("__Optimization_management_", "positions___7314_87192.json", "pages-titled")) !== "Text");

ok("[texts] collectTexts returns deduped, non-empty strings in reading order, capped",
  (() => {
    const texts = collectTexts(screenRoot("__Optimization_management_", "positions___7314_87192.json", "pages-titled"));
    return texts.length > 0 && texts.length <= 8 && new Set(texts).size === texts.length && texts.every((t) => t.trim());
  })());

console.log("\nresolve-screen — the resolution procedure (P3 #16 #70 #71 #90 #120 #150):");

ok("[resolve] #90 'Jet Roles' (visible title; the layer is named `positions ` with a trailing space) resolves to 7314:87192, not nothing",
  (() => { const r = resolveScreen(FIXTURE, "Jet Roles"); return r.status === "resolved" && r.row.id === "7314:87192"; })());

ok("[resolve] #70 'Jet Roles' never resolves to 'Jet Role Details' (20174:143363) — no fuzzy fallback",
  (() => { const r = resolveScreen(FIXTURE, "Jet Roles"); return r.status === "resolved" && r.row.id !== "20174:143363"; })());

ok("[resolve] #120 'Guided Policies' resolves to the ONE screen actually titled that (1359:21337), not the sidebar match on all three",
  (() => { const r = resolveScreen(FIXTURE, "Guided Policies"); return r.status === "resolved" && r.row.id === "1359:21337"; })());

// Round 2: a text-search hit is NEVER auto-resolved, even the single-hit case (finding 70 verbatim
// on the pre-title export) — it is always `needs-confirmation`, a candidate list to pick from by id.
ok("[resolve] #71/#150 an ambiguous partial name ('Jet Role') STOPS as needs-confirmation and lists candidates rather than guessing",
  (() => {
    const r = resolveScreen(FIXTURE, "Jet Role");
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

ok("[resolve] #19/#72/#73 two same-named `Create Assembly Type` frames are ambiguous and distinguishable by id, node count and reference",
  (() => {
    const r = resolveScreen(FIXTURE, "Create Assembly Type");
    if (r.status !== "ambiguous") return false;
    const ids = r.candidates.map((c) => c.id).sort();
    const nodes = r.candidates.map((c) => c.nodes);
    return ids.join("|") === "18411:84111|18411:84502" && new Set(nodes).size === r.candidates.length &&
      r.candidates.every((c) => c.reference && c.screenshot === `dtwin screenshot ${c.id}`);
  })());

ok("[resolve] node id ALWAYS beats a name stage, even if the id string also happens to be a substring elsewhere",
  (() => { const r = resolveScreen(FIXTURE, "20174:143363"); return r.status === "resolved" && r.row.name === "Jet Role Details"; })());

// The query is trimmed before matching (a human typing a query rarely means a trailing space), so
// 'positions ' (with the trailing space the layer itself carries) matches via text search rather
// than the exact-name stage — either way it must resolve to the ONE right screen.
ok("[resolve] 'positions ' (the layer's own trailing-space name) still resolves to the one screen it names",
  (() => { const r = resolveScreen(FIXTURE, "positions "); return r.status === "resolved" && r.row.id === "7314:87192"; })());

ok("[resolve] the untrimmed exact layer name matches byte for byte when queried without surrounding whitespace to strip",
  (() => { const r = resolveScreen(FIXTURE, "Studio Configurations"); return r.status === "resolved" && r.row.id === "1359:21337" && r.stage === "exact layer name"; })());

console.log("\nresolve-screen — root index shape (P3 #16 acceptance criterion 1):");

ok("[index] the fixture's root pages/index.json carries a row with name 'positions ' AND title 'Jet Roles'",
  (() => {
    const root = readRoot(FIXTURE);
    return (root.layers || []).some((l) => l.name === "positions " && l.title === "Jet Roles");
  })());

ok("[index] and a row with name 'Studio Configurations' AND title 'Guided Policies'",
  (() => {
    const root = readRoot(FIXTURE);
    return (root.layers || []).some((l) => l.name === "Studio Configurations" && l.title === "Guided Policies");
  })());

// The prompt's literal `grep -i "jet roles" pages/index.json` also matches a nav-label mention of
// "Jet Roles" inside OTHER screens' `texts[]` (it is drawn in the sidebar of every Optimization-
// management screen — the very trap finding 120 describes) — grep on raw text cannot tell "the
// visible page title" from "a word that also appears in a sidebar". The row-level `title` field is
// exactly what lets a consumer (or this test) ask that question precisely.
ok("[index] acceptance criterion 2: exactly one row's `title` is 'Jet Roles', and it is 7314:87192",
  (() => {
    const root = readRoot(FIXTURE);
    const hits = (root.layers || []).filter((l) => l.title === "Jet Roles");
    return hits.length === 1 && hits[0]?.id === "7314:87192";
  })());

console.log("\nresolve-screen — round 2: text search never auto-resolves, and a title-less export says so:");

// LEGACY fixture: the real pre-title-indexing root+page index (test/fixtures/livetest3/pages-legacy/,
// pruned from a live-test export, names replaced — the exact shape this fix closes over). resolveScreen reads <exportDir>/pages/index.json, so build a
// throwaway exportDir whose pages/ IS this legacy content, rather than teaching the resolver a
// second index location it will never see in a real project.
function legacyExportDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-legacy-"));
  const pagesDir = path.join(tmp, "pages");
  fs.mkdirSync(path.join(pagesDir, "__Optimization_management_"), { recursive: true });
  fs.copyFileSync(path.join(FIXTURE, "pages-legacy", "index.json"), path.join(pagesDir, "index.json"));
  fs.copyFileSync(
    path.join(FIXTURE, "pages-legacy", "__Optimization_management_", "index.json"),
    path.join(pagesDir, "__Optimization_management_", "index.json")
  );
  return tmp;
}
const LEGACY = legacyExportDir();

ok("[legacy] the legacy index really has no titles at all (sanity check on the fixture itself)",
  (() => { const root = readRoot(LEGACY); return !root.layers; })());

ok("[round2] 'Jet Role' on the LEGACY (title-less) export does NOT resolve — needs-confirmation, exit-worthy, not a silent wrong answer",
  (() => { const r = resolveScreen(LEGACY, "Jet Role"); return r.status === "needs-confirmation" && r.stage === "text search"; })());

ok("[round2] and the message says the export predates title indexing",
  (() => { const r = unresolved(resolveScreen(LEGACY, "Jet Role")); return "noTitles" in r && r.noTitles === true; })());

ok("[round2] a query matching NOTHING on the legacy export also flags noTitles",
  (() => { const r = resolveScreen(LEGACY, "Totally Unknown"); return r.status === "not-found" && r.noTitles === true; })());

ok("[round2] 'positions' (no trailing space, no case match needed) resolves at 'exact layer name', not text search",
  (() => { const r = resolveScreen(FIXTURE, "positions"); return r.status === "resolved" && r.row.id === "7314:87192" && r.stage === "exact layer name"; })());

ok("[round2] 'POSITIONS' (case-folded) also resolves at 'exact layer name'",
  (() => { const r = resolveScreen(FIXTURE, "POSITIONS"); return r.status === "resolved" && r.row.id === "7314:87192" && r.stage === "exact layer name"; })());

ok("[round2] 'Guided Policies' on the NEW (titled) export resolves at 'indexed title', not text search",
  (() => { const r = resolveScreen(FIXTURE, "Guided Policies"); return r.status === "resolved" && r.row.id === "1359:21337" && r.stage === "indexed title"; })());

ok("[round2] a query that hits only texts[] ('Units') is needs-confirmation, never resolved, and lists the hits",
  (() => {
    const r = resolveScreen(FIXTURE, "Units");
    return r.status === "needs-confirmation" && r.stage === "text search" && r.candidates.length >= 1 &&
      !r.noTitles; // this export DOES carry titles — only the legacy one should ever set noTitles
  })());

// "Jet Role" above IS the single-substring-hit case (matches only "Jet Role Details" on the legacy,
// title-less export) and is already asserted `needs-confirmation`, not `resolved` — this is finding
// 70 exactly as the coordinator reproduced it against the real pre-fix export.

console.log("\nresolve-screen — round 3: the empty-state sibling collision (finding 310):");

// The real empty-state sibling of "Jet Roles" — node 7314:83742, layer name `Jet roles` (lowercase
// r), visible title ALSO "Jet Roles" — pulled live with this worktree's bridge
// (`node bridge/figma-pull.js /tmp/p3-pull-310 --node 7314:83742 --client "TideStack (Copy)"`) and
// pruned into test/fixtures/livetest3/pages-titled/__Optimization_management_/Jet_roles__7314_83742.json
// the same way as the fixture's other pages-titled/ files. The row below is exactly what write-out.js
// would index for it (name/title/texts/id/w/h/nodes/reference all copied from that real pull's own
// pages/index.json output, reproduced in the P3 round-3 report).
function fixtureWithEmptyStateSibling() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-310-"));
  const pagesDir = path.join(tmp, "pages", "__Optimization_management_");
  fs.mkdirSync(pagesDir, { recursive: true });
  const root = readRoot(FIXTURE);
  const sibling = readFixture(path.join(FIXTURE, "pages-titled", "__Optimization_management_", "Jet_roles__7314_83742.json"), isScreenExport);
  // deriveTitle/collectTexts are the same top-level import as line 29 — no need to re-require them.
  const siblingRoot = sibling.nodes[0];
  if (root.layers) root.layers = root.layers.concat([{
    name: "Jet roles",
    id: "7314:83742",
    type: "FRAME",
    page: "✅ Optimization management ",
    pageId: "5282:58823",
    title: deriveTitle(siblingRoot),
    texts: collectTexts(siblingRoot),
    file: "pages/__Optimization_management_/Jet_roles__7314_83742.json",
    reference: "assets/7314_83742_ref.png",
    nodes: 209,
    w: 1440,
    h: 1236,
  }]);
  fs.writeFileSync(path.join(tmp, "pages", "index.json"), JSON.stringify(root, null, 2));
  return tmp;
}
const SIBLING_FIXTURE = fixtureWithEmptyStateSibling();

ok("[round3] the sibling really is titled 'Jet Roles' too (sanity check on the real pulled data)",
  (() => {
    const root = readRoot(SIBLING_FIXTURE);
    const sib = root.layers?.find((l) => l.id === "7314:83742");
    return sib !== undefined && sib.name === "Jet roles" && sib.title === "Jet Roles";
  })());

ok("[round3] finding 310: 'Jet Roles' with BOTH a layer-name hit (Jet roles, case-insensitive) AND a title hit (positions ) STOPS as ambiguous, never resolves to either",
  (() => {
    const r = resolveScreen(SIBLING_FIXTURE, "Jet Roles");
    return r.status === "ambiguous" && r.candidates.length === 2 &&
      r.candidates.some((c) => c.id === "7314:83742") && r.candidates.some((c) => c.id === "7314:87192");
  })());

ok("[round3] the candidate list says WHICH field each row matched on",
  (() => {
    const r = unresolved(resolveScreen(SIBLING_FIXTURE, "Jet Roles"));
    const empty = r.candidates.find((c) => c.id === "7314:83742");
    const real = r.candidates.find((c) => c.id === "7314:87192");
    return (empty?.matchedVia || []).includes("exact layer name") && (real?.matchedVia || []).includes("indexed title");
  })());

ok("[round3] lower/upper case of the layer name ('jet roles') still joins the SAME union, still stops",
  (() => { const r = resolveScreen(SIBLING_FIXTURE, "jet roles"); return r.status === "ambiguous" && r.candidates.length === 2; })());

ok("[round3] a node id still wins alone even with the sibling present",
  (() => { const r = resolveScreen(SIBLING_FIXTURE, "7314:83742"); return r.status === "resolved" && r.stage === "node id" && r.row.id === "7314:83742"; })());

ok("[round3] 'positions' (exact layer name only, no title collision on THIS query string) still resolves cleanly",
  (() => { const r = resolveScreen(SIBLING_FIXTURE, "positions"); return r.status === "resolved" && r.row.id === "7314:87192"; })());


// ---------- an index that is not an index is treated as no index (doc-guards.ts) — not iterated as one ----------
ok("[shape] a pages/index.json whose pageDirs is a string resolves nothing (was: each CHARACTER walked as a page dir)", (() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-shape-"));
  fs.mkdirSync(path.join(tmp, "pages"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "pages", "index.json"), JSON.stringify({ pageDirs: "__Optimization_management_" }));
  const r = resolveScreen(tmp, "Jet Roles");
  return r.status === "not-found" && r.candidates.length === 0;
})());

// ---------- [F-53] hidden nodes (and their subtrees) are invisible to the text walkers ----------
const txt = (text: string, extra: Record<string, unknown> = {}) => ({ type: "TEXT", name: "t", text, ...extra });
const hiddenTree = {
  type: "FRAME", name: "Screen",
  children: [
    txt("Ghost label", { hidden: true }),
    { type: "FRAME", name: "Ghost panel", hidden: true, children: [txt("Ghost inside"), { type: "FRAME", name: "Page Title", children: [txt("Ghost title")] }] },
    txt("Visible label"),
  ],
};
ok("[F-53] hidden TEXT and hidden FRAME's TEXT are excluded from texts; the visible sibling stays",
  JSON.stringify(collectTexts(hiddenTree)) === JSON.stringify(["Visible label"]));
ok("[F-53] title skips hidden TEXT, hidden subtree and a hidden 'Page Title' slot",
  deriveTitle(hiddenTree) === "Visible label");
ok("[F-53] hidden:false behaves like absent",
  JSON.stringify(collectTexts({ type: "FRAME", name: "S", children: [txt("A", { hidden: false }), txt("B")] })) === JSON.stringify(["A", "B"]));
ok("[F-53] DEFAULT (hidden absent) still collects every text and derives the first as title", (() => {
  const tree = { type: "FRAME", name: "S", children: [{ type: "FRAME", name: "Box", children: [txt("A")] }, txt("B")] };
  return JSON.stringify(collectTexts(tree)) === JSON.stringify(["A", "B"]) && deriveTitle(tree) === "A";
})());

// ---------- [M-4] a HIDDEN ROOT keeps its title and texts — only hidden DESCENDANTS are skipped ----------
// (a hidden top-level frame in a page walk, a hidden frame pulled by id, a hidden listChildren row)
const hiddenRoot = { ...hiddenTree, hidden: true };
// pre-fix: title undefined and texts [] — the walkers returned early on the root's own flag.
ok("[M-4] a hidden root's texts are its visible descendants' (the hidden ones still skipped)",
  JSON.stringify(collectTexts(hiddenRoot)) === JSON.stringify(["Visible label"]));
ok("[M-4] a hidden root still gets its title", deriveTitle(hiddenRoot) === "Visible label");
ok("[M-4] the 'Page Title' slot inside a hidden root is found",
  deriveTitle({ type: "FRAME", name: "Popup", hidden: true, children: [txt("Close"), { type: "FRAME", name: "Page Title", children: [txt("Edit profile", { name: "Title" })] }] }) === "Edit profile");
ok("[M-4] a hidden TEXT root is its own text", deriveTitle(txt("Lonely", { hidden: true })) === "Lonely" && JSON.stringify(collectTexts(txt("Lonely", { hidden: true }))) === JSON.stringify(["Lonely"]));

// ---------- [DT-41] not an export root; the basename / path / dash id forms ----------
console.log("\nresolve-screen — DT-41: a non-root dir says so; <Layer>__<a>_<b> basenames, .json paths and dash ids resolve:");
{
  const pageDir = path.join(FIXTURE, "pages", "__Optimization_management_");
  const nr = resolveScreen(pageDir, "Jet Roles");
  ok("[DT41-1] a page subdir is not-found with noIndex naming the export root (not a silent empty list)",
    nr.status === "not-found" && !!nr.noIndex && nr.noIndex.dir === pageDir && nr.noIndex.hint === FIXTURE && nr.candidates.length === 0);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "rs-noroot-"));
  const nr2 = resolveScreen(empty, "x");
  ok("[DT41-1] a dir with no root above or below: noIndex.hint is null", nr2.status === "not-found" && !!nr2.noIndex && nr2.noIndex.hint === null);
  fs.mkdirSync(path.join(empty, "design", "export"), { recursive: true });
  fs.cpSync(path.join(FIXTURE, "pages"), path.join(empty, "design", "export", "pages"), { recursive: true });
  const nr3 = resolveScreen(empty, "x");
  ok("[DT41-1] the root found BELOW the dir (design/export) is named", nr3.status === "not-found" && nr3.noIndex?.hint === path.join(empty, "design", "export"));
  fs.rmSync(empty, { recursive: true, force: true });
  ok("[DT41-1] a real root has no noIndex", (() => { const r = resolveScreen(FIXTURE, "no such screen"); return r.status === "not-found" && !r.noIndex && r.candidates.length > 0; })());

  const idOf = (q: string): string | null => { const r = resolveScreen(FIXTURE, q); return r.status === "resolved" ? r.row.id : null; };
  ok("[DT41-2] the basename `positions___7314_87192` resolves by node id", idOf("positions___7314_87192") === "7314:87192");
  ok("[DT41-2] a path to the .json resolves by node id",
    idOf("pages/__Optimization_management_/positions___7314_87192.json") === "7314:87192");
  ok("[DT41-2] a `.vars.json` / `.expected.json` tail is stripped too",
    idOf("Studio_Configurations__1359_21337.vars.json") === "1359:21337" && idOf("design/verify/Studio_Configurations__1359_21337.expected.json") === "1359:21337");
  ok("[DT41-2] the resolved stage is 'node id'", (() => { const r = resolveScreen(FIXTURE, "positions___7314_87192"); return r.status === "resolved" && r.stage === "node id"; })());
  ok("[DT41-3] a dash id `7314-87192` resolves", idOf("7314-87192") === "7314:87192");
  ok("[DT41-3] a URL-ish `?node-id=7314-87192` resolves", idOf("https://www.figma.com/design/KEY/Name?node-id=7314-87192") === "7314:87192");
  const cli = (...a: string[]): { status: number | null; err: string } => {
    const r = spawnSync(process.execPath, [path.join(import.meta.dirname, "..", "design-to-code", "resolve-screen.ts"), ...a], { encoding: "utf8" });
    return { status: r.status, err: r.stderr };
  };
  const c1 = cli(pageDir, "Jet Roles");
  ok("[DT41-1] the CLI says 'not an export root' and names the root — no empty 'Known layers:'",
    c1.status === 1 && /not an export root/.test(c1.err) && c1.err.includes(`pass ${FIXTURE}`) && !/Known layers/.test(c1.err));
  ok("[DT41-2] the CLI resolves a basename", cli(FIXTURE, "positions___7314_87192").status === 0);
  ok("[DT41-2] a basename whose id is not in the export is still not-found (never a fuzzy pick)", idOf("Ghost__1_2") === null);
}
{
  // Review 1 L-3: a layer actually NAMED `<x>__<a>_<b>` resolves by its exact name, not as the id a:b.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rs-l3-"));
  fs.mkdirSync(path.join(dir, "pages"), { recursive: true });
  fs.writeFileSync(path.join(dir, "pages", "index.json"), JSON.stringify({ pageDirs: [{ page: "P", dir: "P" }], layers: [
    { name: "Home", id: "1:2", type: "FRAME", page: "P", file: "pages/P/Home__1_2.json" },
    { name: "Wizard__1_2", id: "7:8", type: "FRAME", page: "P", file: "pages/P/Wizard__1_2__7_8.json" },
  ] }));
  const r = resolveScreen(dir, "Wizard__1_2");
  ok(`[L-3] a layer named "Wizard__1_2" resolves by exact layer name, not to id 1:2 (got ${r.status === "resolved" ? `${r.row.name} via ${r.stage}` : r.status})`,
    r.status === "resolved" && r.row.id === "7:8" && r.stage === "exact layer name");
  const b = resolveScreen(dir, "Home__1_2");
  ok("[L-3] control: a basename no layer is named still resolves by its id", b.status === "resolved" && b.row.id === "1:2" && b.stage === "node id");
  fs.rmSync(dir, { recursive: true, force: true });
}

report();
