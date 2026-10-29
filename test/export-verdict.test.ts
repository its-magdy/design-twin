// bridge/src/export-verdict.ts: the one verdict on the export on disk — which Figma file each screen came from (and
// the design system), the newest stamp and its age, staleness, why there is no age, every unusable file, the newest
// screen — checked here, once, on fixture export dirs. doctor and figma_status only word it (bridge.test.ts,
// mcp-smoke.test.ts check that they surface it). Invented names, temp dirs only.
//   bun test/export-verdict.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, report } from "./assert.ts";
import { readExportVerdict, snapshotAge, statusSnapshot, STALE_MS } from "../bridge/src/export-verdict.ts";
import type { ExportSource, ExportVerdict } from "../bridge/src/export-verdict.ts";

const tmp = (tag: string): string => fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-verdict-" + tag + "-"));
const put = (file: string, body: unknown): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body, null, 2) + "\n");
};
const HOUR = 3600000;
const NOW = Date.parse("2026-01-10T00:00:00.000Z");
const ago = (h: number): string => new Date(NOW - h * HOUR).toISOString();
const src = (v: ExportVerdict, kind: ExportSource["kind"], sourceFile: string | null): ExportSource | undefined =>
  v.sources.find((s) => s.kind === kind && s.sourceFile === sourceFile);

console.log("the stamp rule (shared with drift-lint)");
{
  check("a stamp: its age", snapshotAge({ exportedAt: ago(2) }, NOW).ageMs === 2 * HOUR);
  check("no stamp: missing", snapshotAge({}, NOW).problem === "missing" && snapshotAge(null, NOW).problem === "missing");
  check("a stamp that is not a date: unparseable, kept", (() => { const a = snapshotAge({ exportedAt: "soon" }, NOW); return a.problem === "unparseable" && a.exportedAt === "soon"; })());
  check("the threshold is 24h", STALE_MS === 24 * HOUR);
}

console.log("nothing exported");
{
  const root = tmp("none");
  const v = readExportVerdict(root, NOW);
  check("no source, no problem, not exported", !v.exported && v.sources.length === 0 && v.problems.length === 0 && v.newest === null && !v.stale);
  check("figma_status's snapshot: null", statusSnapshot(v) === null);
  check("a missing dir: the same, never a throw", statusSnapshot(readExportVerdict(path.join(root, "absent"), NOW)) === null);
  put(path.join(root, "target.json"), { profile: "web" });
  put(path.join(root, "tokens.dtcg.json"), { color: { bg: { $value: "#fff" } } });
  check("generated files only: still nothing exported", !readExportVerdict(root, NOW).exported);
}

console.log("mixed sources: attribution, newest, staleness");
{
  const root = tmp("mixed");
  // The design system from one Figma file, pulled 30h ago; screens from two others, plus rows from an older bridge.
  put(path.join(root, "design-system.json"), { exportedAt: ago(30), file: "Kit" });
  put(path.join(root, "pages", "index.json"), { pageDirs: [], layers: [
    { id: "1:1", name: "A1", file: "pages/A/A1.json", sourceFile: "App", exportedAt: ago(5) },
    { id: "1:2", name: "A2", file: "pages/A/A2.json", sourceFile: "App", exportedAt: ago(2) },
  ] });
  put(path.join(root, "pages", "B", "index.json"), { layers: [
    { id: "2:1", name: "B1", file: "pages/B/B1.json", sourceFile: "Promo", exportedAt: ago(10) },
    { id: "2:2", name: "Old", file: "pages/B/Old.json" },
  ] });
  put(path.join(root, "pages", "C", "index.json"), "{truncated");
  const v = readExportVerdict(root, NOW);
  const app = src(v, "screens", "App"), promo = src(v, "screens", "Promo"), older = src(v, "screens", null), ds = src(v, "design-system", "Kit");
  check(`screens grouped by their own Figma file, each with its newest stamp (got ${JSON.stringify(v.sources)})`,
    app?.count === 2 && app.ageMs === 2 * HOUR && app.file === path.join(root, "pages", "A", "A2.json")
    && promo?.count === 1 && promo.ageMs === 10 * HOUR);
  check("rows with no source are a group of their own, with no stamp — never another source's", older?.count === 1 && older.problem === "missing" && older.ageMs === undefined);
  check("the design system, attributed to its own file", ds?.ageMs === 30 * HOUR && ds.file === path.join(root, "design-system.json"));
  check("order: named screens, the unrecorded ones, then the design system", v.sources.map((s) => s.sourceFile).join(",") === "App,Promo,,Kit");
  check(`newest: the last pull (App's screen), not the design system (got ${JSON.stringify(v.newest)})`,
    v.newest?.sourceFile === "App" && v.newest.ageMs === 2 * HOUR && v.newest.kind === "screens");
  check("not stale: the newest is 2h old, though the design system is 30h", !v.stale && v.staleAfterMs === STALE_MS && v.unknownFreshness === undefined);
  check("mixed: several Figma files", v.mixed);
  check(`every unusable file is a problem (got ${JSON.stringify(v.problems)})`, v.problems.length === 1 && v.problems[0]?.file === "pages/C/index.json");
  check("the newest screen row", v.lastScreen?.id === "1:2" && v.lastScreen.ageMs === 2 * HOUR && v.lastScreen.sourceFile === "App" && v.lastScreen.file === "pages/A/A2.json");
  const snap = statusSnapshot(v);
  check(`figma_status's snapshot: the newest stamp, attributed to the file it came from — the old pick named the design system's (got ${JSON.stringify(snap)})`,
    !!snap && "exportedAt" in snap && snap.exportedAt === ago(2) && snap.sourceFile === "App" && snap.ageMs === 2 * HOUR
    && snap.file === path.join(root, "pages", "A", "A2.json") && snap.warning === undefined);
  check("…with the attribution, staleness and problems alongside", !!snap && "sources" in snap && snap.sources.length === 4 && snap.stale === false && snap.staleAfterMs === STALE_MS && snap.problems.length === 1);
  const later = readExportVerdict(root, NOW + 23 * HOUR);
  check("stale once the NEWEST stamp is past 24h", later.stale && later.newest?.ageMs === 25 * HOUR);
}

console.log("one source");
{
  const root = tmp("one");
  put(path.join(root, "design-system.json"), { exportedAt: ago(5), file: "Kit", components: [] });
  const v = readExportVerdict(root, NOW);
  check("a design system alone: its stamp, its file", v.newest?.sourceFile === "Kit" && v.newest.ageMs === 5 * HOUR && !v.mixed && !v.stale);
  const snap = statusSnapshot(v);
  check("figma_status's snapshot keeps its shape: file, exportedAt, ageMs, sourceFile", !!snap && "exportedAt" in snap
    && snap.file === path.join(root, "design-system.json") && snap.exportedAt === ago(5) && snap.ageMs === 5 * HOUR && snap.sourceFile === "Kit");
  check("a design system and screens of the same file: not mixed", (() => {
    put(path.join(root, "pages", "index.json"), { pageDirs: [], layers: [{ id: "1:1", name: "S", file: "pages/P/S.json", sourceFile: "Kit", exportedAt: ago(1) }] });
    return !readExportVerdict(root, NOW).mixed;
  })());
  const part = tmp("part");
  put(path.join(part, "design-system", "tokens.json"), { exportedAt: ago(3), file: "Kit", variables: [] });
  check("no manifest: a split part's stamp dates the design system", readExportVerdict(part, NOW).newest?.ageMs === 3 * HOUR);
  const walk = tmp("walk");
  put(path.join(walk, "pages", "index.json"), { exportedAt: ago(4), file: "Product", pageDirs: [] });
  const w = readExportVerdict(walk, NOW);
  check(`a page walk's index listing no screen: its own stamp and Figma file (got ${JSON.stringify(w.sources)})`, w.newest?.kind === "page-walk" && w.newest.sourceFile === "Product" && w.newest.ageMs === 4 * HOUR);
}

console.log("no usable age");
{
  const missing = tmp("unstamped");
  put(path.join(missing, "design-system.json"), { components: [] });
  const v = readExportVerdict(missing, NOW);
  check(`no stamp anywhere: exported, no age, and why (got ${v.unknownFreshness})`, v.exported && v.newest === null && !v.stale && /no exportedAt stamp in design-system\.json/.test(v.unknownFreshness ?? ""));
  const snap = statusSnapshot(v);
  check("figma_status's snapshot: no exportedAt, the warning", !!snap && "warning" in snap && snap.exportedAt === undefined && typeof snap.warning === "string");
  const bad = tmp("unparseable");
  put(path.join(bad, "design-system.json"), { exportedAt: "last week", file: "Kit" });
  check("a stamp that is not a date: said, with the stamp", /exportedAt \('last week'\) in design-system\.json is not a parseable timestamp/.test(readExportVerdict(bad, NOW).unknownFreshness ?? ""));
  put(path.join(bad, "pages", "index.json"), { pageDirs: [], layers: [{ id: "1:1", name: "S", file: "pages/P/S.json", sourceFile: "App", exportedAt: ago(1) }] });
  const partly = readExportVerdict(bad, NOW);
  check("one unparseable source beside a stamped one: the export has an age; that source says why it has none",
    partly.newest?.sourceFile === "App" && partly.unknownFreshness === undefined && src(partly, "design-system", "Kit")?.problem === "unparseable");
}

console.log("unusable files");
{
  const root = tmp("broken");
  put(path.join(root, "design-system.json"), "{ not json");
  const v = readExportVerdict(root, NOW);
  check("only a broken manifest: exported (something is there), no source, the problem", v.exported && v.sources.length === 0 && v.problems.length === 1);
  const snap = statusSnapshot(v);
  check(`figma_status's snapshot: { file, error }, not "nothing exported" (got ${JSON.stringify(snap)})`,
    !!snap && "error" in snap && /^design-system\.json is not valid JSON/.test(snap.error) && snap.file === path.join(root, "design-system.json"));
  put(path.join(root, "pages", "index.json"), "{ not json either");
  const both = statusSnapshot(readExportVerdict(root, NOW));
  check("a broken manifest AND a broken root index: the manifest's is the one named", !!both && "error" in both && /^design-system\.json /.test(both.error) && both.problems.length === 2);
}

console.log("the older flat layout: a top-level screen doc");
{
  const dir = tmp("flat");
  put(path.join(dir, "Skills_list.json"), { exportedAt: ago(2), screen: "Skills list", nodes: [{ id: "1:2" }], manifest: {} });
  const v = readExportVerdict(dir, NOW);
  check("a single-screen pull IS an export: its stamp, its `screen` label", v.newest?.kind === "screen-doc" && v.newest.ageMs === 2 * HOUR && v.newest.sourceFile === "Skills list");
  check("…and a screen's label is not a Figma file: not mixed", !v.mixed);
  put(path.join(dir, "target.json"), { profile: "web" });
  put(path.join(dir, "tokens.resolver.json"), { name: "r", sets: [] });
  check("generated files are never mistaken for it", readExportVerdict(dir, NOW).newest?.file?.endsWith("Skills_list.json") === true);
  // variables.json is export-shaped (variables[]) but carries no stamp: the stamped screen doc beside it wins
  put(path.join(dir, "variables.json"), { variables: [{ name: "x" }] });
  const withVars = readExportVerdict(dir, NOW);
  check("an unstamped variables.json never outranks the stamped doc", withVars.newest?.sourceFile === "Skills list" && withVars.unknownFreshness === undefined);
  const onlyVars = tmp("only-vars");
  put(path.join(onlyVars, "variables.json"), { variables: [] });
  const ov = readExportVerdict(onlyVars, NOW);
  check(`the only export-shaped file, unstamped: reported with why, not "nothing exported" (got ${ov.unknownFreshness})`, ov.exported && /variables\.json/.test(ov.unknownFreshness ?? ""));
  const indexed = tmp("flat-indexed");
  put(path.join(indexed, "Stray.json"), { exportedAt: ago(1), nodes: [] });
  put(path.join(indexed, "design-system.json"), { exportedAt: ago(5), file: "Kit" });
  check("a top-level doc is consulted only when nothing else is stamped", readExportVerdict(indexed, NOW).sources.every((s) => s.kind !== "screen-doc"));
}

console.log("the newest screen row");
{
  const dir = tmp("last");
  const idx = (doc: unknown): void => put(path.join(dir, "pages", "index.json"), doc);
  idx({ pageDirs: [], layers: [
    { name: "Old", id: "1:1", file: "pages/P/Old__1_1.json", exportedAt: ago(96) },
    { name: "New", id: "2:2", file: "pages/P/New__2_2.json", exportedAt: ago(1), sourceFile: "Sample App" },
    { name: "Mid", id: "3:3", file: "pages/P/Mid__3_3.json", exportedAt: ago(48) },
  ] });
  const got = readExportVerdict(dir, NOW).lastScreen;
  check("the newest row by exportedAt wins (not the last one), with its age and sourceFile",
    got?.id === "2:2" && got.name === "New" && got.file === "pages/P/New__2_2.json" && got.ageMs === HOUR && got.sourceFile === "Sample App");
  idx({ exportedAt: ago(0.5), pageDirs: [], layers: [{ name: "Walked", id: "4:4", file: "pages/P/Walked__4_4.json" }] });
  check("a page-walk row without its own stamp uses the index's exportedAt", (() => { const l = readExportVerdict(dir, NOW).lastScreen; return l?.id === "4:4" && l.exportedAt === ago(0.5); })());
  idx("{ not json");
  check("a garbled index: no newest screen", readExportVerdict(dir, NOW).lastScreen === null);
}

report();
