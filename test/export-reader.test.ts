// bridge/src/export-reader.ts: the reading side of an export, through one module — which export (exportRoot), every
// screen it knows about (the root pages/index.json and every page's own pages/<dir>/index.json, merged under one rule),
// the design system's stamp and its manifest pointers — and the bridge readers that ask it (doctor, snapshot-meta).
// Invented screens, temp dirs only. The two-walk fixture is written by bridge/src/pages-layout.ts's own
// buildPageLayout, byte for byte as write-out.ts's writePages lands it: a page walk REPLACES the root index.
//   bun test/export-reader.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, report } from "./assert.ts";
import { buildPageLayout } from "../bridge/src/pages-layout.ts";
import { node } from "./fixtures.ts";
import type { LayersDoc, LayersDocLayer } from "../bridge/src/doc-types.ts";
import { resolveScreen } from "../design-to-code/resolve-screen.ts";
import { locateExport } from "../design-to-code/verify-locate.ts";
import { exportSiblings } from "../design-to-code/screen-inputs.ts";
import { findExportNeighbours } from "../design-to-code/design-system-dir.ts";
import {
  designSystemPart, exportInDesignDir, exportRoot, exportRootOfScreen, findExportRoot, hasExportIndex, pagesRootOfScreen, readDesignSystemStamp, readExportIndex,
} from "../bridge/src/export-reader.ts";
import { checkProject } from "../bridge/src/doctor.ts";
import { lastScreenExport, readSnapshotInfo } from "../bridge/src/snapshot-meta.ts";
import type { IndexRow } from "../design-to-code/types.ts";

const tmp = (tag: string): string => fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-index-" + tag + "-"));
const put = (file: string, body: unknown): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body, null, 2) + "\n");
};

/** One frame of a walk: its page, id and name, and one text so it has a title. */
interface Frame { page: string; pageId: string; id: string; name: string }
const layer = (f: Frame): LayersDocLayer => ({
  name: f.name, id: f.id, page: f.page, pageId: f.pageId,
  tree: node({ id: f.id, type: "FRAME", name: f.name, children: [{ id: f.id + "1", type: "TEXT", name: "Heading", text: f.name + " heading" }] }),
});
/** Lands one page walk in `root` the way writePages does: every layer file, every page index, and the root index replaced. */
function walk(root: string, frames: Frame[], extra: Partial<LayersDoc> = {}): void {
  const doc: LayersDoc = { ...extra, layers: frames.map(layer), index: frames.map((f) => ({ name: f.name, id: f.id, type: "FRAME", page: f.page, pageId: f.pageId })) };
  const built = buildPageLayout(doc, "/");
  for (const f of [...built.layerFiles, ...built.indexFiles]) put(path.join(root, f.path), f.data);
  put(path.join(root, built.rootIndex), built.meta);
}

const HOME = { page: "Home", pageId: "1:1" }, SETTINGS = { page: "Settings", pageId: "2:1" };
const dashboard: Frame = { ...HOME, id: "10:1", name: "Dashboard" };
const reports: Frame = { ...HOME, id: "10:2", name: "Reports" };
const profile: Frame = { ...SETTINGS, id: "20:1", name: "Profile" };

/** Walk 1 exports every page (Home, Settings); walk 2 re-walks Home alone — the root index now lists Home only.
 *  `root` defaults to a fresh temp dir. */
function twoWalks(root: string = tmp("walks")): string {
  walk(root, [dashboard, profile], { scope: "all-pages", sourceFile: "Product" });
  walk(root, [dashboard, reports], { scope: "page", page: "Home", sourceFile: "Product" });
  return root;
}

console.log("the latent bug: a screen an earlier walk exported, through today's callers");
{
  const project = tmp("project");
  const root = twoWalks(path.join(project, "design", "export"));
  const rootIndex: unknown = JSON.parse(fs.readFileSync(path.join(root, "pages", "index.json"), "utf8"));
  check("fixture: the second walk's root index no longer lists the Settings page", !JSON.stringify(rootIndex).includes("Profile"));
  check("fixture: the first walk's Settings index and screen are still on disk",
    fs.existsSync(path.join(root, "pages", "Settings", "index.json")) && fs.existsSync(path.join(root, "pages", "Settings", "Profile__20_1.json")));
  const r = resolveScreen(root, "20:1");
  check(`resolve-screen resolves the earlier walk's screen by node id (got ${r.status})`, r.status === "resolved");
  const byName = resolveScreen(root, "Profile");
  check(`resolve-screen resolves it by layer name (got ${byName.status})`, byName.status === "resolved");
  const hit = locateExport({ nodeId: "20:1" }, undefined, project);
  check(`verify-locate finds a plan's screen by its node id (got ${hit?.file ?? null}, row ${hit?.row?.id ?? null})`,
    hit?.file === path.join(root, "pages", "Settings", "Profile__20_1.json") && hit.row?.id === "20:1");
  const sib = exportSiblings([path.join(root, "pages", "Home", "Dashboard__10_1.json")]);
  const labels = sib ? sib().map((s) => s.label) : [];
  check(`cross-check's siblings include it (got ${JSON.stringify(labels)})`, labels.includes("Profile__20_1") && labels.includes("Reports__10_2"));
  const nb = findExportNeighbours(path.join(root, "pages", "Home", "Dashboard__10_1.json"));
  check("audit's neighbours list it (and so count it as exported)", !!nb && nb.layers.some((l) => l.id === "20:1"));
}

const ids = (rows: readonly IndexRow[]): string => rows.map((r) => r.id).join(",");

console.log("readExportIndex: every indexed row once");
{
  const root = twoWalks();
  const ix = readExportIndex(root);
  check(`the root's rows first, then the page indexes' (got ${ids(ix.rows)})`, ids(ix.rows) === "10:1,10:2,20:1");
  check("an earlier walk's screen counts as exported; an unindexed id does not", ix.isExported("20:1") && ix.isExported("10:2") && !ix.isExported("99:9"));
  check("indexed: the root index was read", ix.indexed && ix.rootProblem === null);
  check("the export root is kept as given", ix.root === root);
}
{
  // one screen in the root and in its page index: the root's row (the newest write) wins
  const root = tmp("dupe");
  put(path.join(root, "pages", "index.json"), { pageDirs: [{ page: "Home", dir: "Home", index: "pages/Home/index.json", layers: 1 }], layers: [{ id: "1:2", name: "A", title: "new", file: "pages/Home/A__1_2.json", sourceFile: "Product" }] });
  put(path.join(root, "pages", "Home", "index.json"), { page: "Home", layers: [
    { id: "1:2", name: "A", title: "old", file: "pages/Home/A__1_2.json", sourceFile: "Product" },
    // node ids repeat across Figma files: another file's 1:2 is another screen
    { id: "1:2", name: "A", file: "pages/Home/A__1_2-other.json", sourceFile: "Other" },
    // two files may share a name: the key tells them apart when both rows carry one…
    { id: "1:3", name: "B", file: "pages/Home/B__1_3.json", sourceFile: "Product", sourceFileKey: "k1" },
    { id: "1:3", name: "B", file: "pages/Home/B__1_3-k2.json", sourceFile: "Product", sourceFileKey: "k2" },
    // …and a file renamed in Figma keeps its key
    { id: "1:3", name: "B", file: "pages/Home/B__1_3-renamed.json", sourceFile: "Product v2", sourceFileKey: "k1" },
  ] });
  const ix = readExportIndex(root);
  const a = ix.rows.filter((r) => r.id === "1:2"), b = ix.rows.filter((r) => r.id === "1:3");
  check(`same node, same Figma file: one row, the root's (got ${JSON.stringify(a.map((r) => r.title ?? r.sourceFile))})`, a.length === 2 && a[0]?.title === "new" && a[1]?.sourceFile === "Other");
  check(`the file key decides when both rows carry one (got ${JSON.stringify(b.map((r) => r.file))})`, b.length === 2 && b[0]?.file === "pages/Home/B__1_3.json" && b[1]?.file === "pages/Home/B__1_3-k2.json");
}
{
  // the writer's identity for rows pulled before they were stamped (pages-layout.ts sameScreenRow)
  const root = tmp("unstamped");
  // a stamped re-pull of a legacy row, its page renamed in Figma since: the root holds the new row, the old page's
  // index still the old one — one screen (the same pageId)
  put(path.join(root, "pages", "index.json"), { pageDirs: [{ page: "Renamed", pageId: "0:1", dir: "Renamed", index: "pages/Renamed/index.json", layers: 1 }],
    layers: [{ id: "5:1", name: "Tray Panel", page: "Renamed", pageId: "0:1", file: "pages/Renamed/Tray_Panel__5_1.json", sourceFile: "Product" }] });
  put(path.join(root, "pages", "Old", "index.json"), { page: "Old", pageId: "0:1", layers: [
    { id: "5:1", name: "Tray", page: "Old", pageId: "0:1", file: "pages/Old/Tray__5_1.json" },
    // two unstamped rows of one id and no page id: nothing says they are one node — both kept
    { id: "6:1", name: "Crates", file: "pages/Old/Crates__6_1.json" },
    { id: "6:1", name: "Pots", file: "pages/Old/Pots__6_1.json" },
    // a second row naming a file already read is that file's row
    { id: "7:1", name: "Bins", file: "pages/Renamed/Tray_Panel__5_1.json" },
  ] });
  const ix = readExportIndex(root);
  check(`an unstamped row a stamped one of its pageId replaced is dropped; two unstamped rows without a page id are kept (got ${ix.rows.map((r) => r.name).join(",")})`,
    ix.rows.map((r) => r.name).join(",") === "Tray Panel,Crates,Pots");
}
{
  // three walks: page Old exported; the page renamed New in Figma (same page id) and walked again, its frame renamed too;
  // then another page walked — the root lists neither, both page indexes hold the frame: the later write is the true one
  const root = tmp("renamed-page");
  const OLD = { page: "Old", pageId: "1:1" }, NEW = { page: "New", pageId: "1:1" };
  walk(root, [{ ...OLD, id: "10:1", name: "Tray" }], { sourceFile: "Product" });
  walk(root, [{ ...NEW, id: "10:1", name: "Tray Panel" }], { sourceFile: "Product" });
  walk(root, [{ ...SETTINGS, id: "20:1", name: "Profile" }], { sourceFile: "Product" });
  // the walks land within one clock tick: date the files as they happened. Old's index is the NEWEST file — a
  // single-screen pull of another frame on Old since rewrote it, carrying its stale Tray row over (mergeScreenIndex)
  const at = (rel: string, secs: number): void => { const d = new Date(Date.UTC(2026, 0, 1, 0, 0, secs)); fs.utimesSync(path.join(root, "pages", rel), d, d); };
  at("Old/Tray__10_1.json", 1); at("New/Tray_Panel__10_1.json", 2); at("New/index.json", 2); at("Settings/index.json", 3); at("Old/index.json", 9);
  const rows = readExportIndex(root).rows;
  check(`two unlisted page indexes holding one screen: the row whose screen file was written last, whatever the indexes' dates (got ${rows.map((r) => r.name).join(",")})`,
    rows.map((r) => r.name).join(",") === "Profile,Tray Panel");
  const r = resolveScreen(root, "10:1");
  check("…so resolve-screen gives the frame's current name", r.status === "resolved" && r.row.name === "Tray Panel");
  at("Old/Tray__10_1.json", 10);
  check("(decided by the screen files' write order, not the directory names')", readExportIndex(root).rows.map((x) => x.name).join(",") === "Profile,Tray");
  fs.rmSync(path.join(root, "pages", "Old", "Tray__10_1.json"));
  check("(a row whose screen file is gone loses)", readExportIndex(root).rows.map((x) => x.name).join(",") === "Profile,Tray Panel");
}
{
  // the writer's identity is asymmetric (sameScreenRow(older, newer)): an older UNSTAMPED row is replaced by a newer
  // stamped one of its pageId — whichever page index is read first
  const root = tmp("asym");
  const stamp = (rel: string, secs: number, body: unknown = {}): void => { const f = path.join(root, "pages", rel); put(f, body); const d = new Date(Date.UTC(2026, 0, 1, 0, 0, secs)); fs.utimesSync(f, d, d); };
  put(path.join(root, "pages", "index.json"), { pageDirs: [], layers: [] });
  put(path.join(root, "pages", "A_Old", "index.json"), { page: "Old", pageId: "1:1", layers: [{ id: "10:1", name: "Tray", page: "Old", pageId: "1:1", file: "pages/A_Old/Tray__10_1.json" }] });
  put(path.join(root, "pages", "Z_New", "index.json"), { page: "New", pageId: "1:1", layers: [{ id: "10:1", name: "Tray Panel", page: "New", pageId: "1:1", file: "pages/Z_New/Tray_Panel__10_1.json", sourceFile: "Product" }] });
  stamp("A_Old/Tray__10_1.json", 1); stamp("Z_New/Tray_Panel__10_1.json", 2);
  const names = readExportIndex(root).rows.map((r) => r.name).join(",");
  check(`an older unstamped row read first, then a newer stamped one of its pageId: one row, the newer (got ${names})`, names === "Tray Panel");
  const r = resolveScreen(root, "10:1");
  check("…resolvable by node id", r.status === "resolved" && r.row.name === "Tray Panel");
  // one newer row the writer would let replace SEVERAL kept rows: it replaces all of them
  put(path.join(root, "pages", "B_Keys", "index.json"), { page: "Keys", pageId: "3:1", layers: [
    { id: "30:1", name: "K1", file: "pages/B_Keys/K1__30_1.json", sourceFile: "Product", sourceFileKey: "k1" },
    { id: "30:1", name: "K2", file: "pages/B_Keys/K2__30_1.json", sourceFile: "Product", sourceFileKey: "k2" },
  ] });
  put(path.join(root, "pages", "C_Later", "index.json"), { page: "Later", pageId: "4:1", layers: [{ id: "30:1", name: "Unkeyed", file: "pages/C_Later/Unkeyed__30_1.json", sourceFile: "Product" }] });
  stamp("B_Keys/K1__30_1.json", 1); stamp("B_Keys/K2__30_1.json", 1); stamp("C_Later/Unkeyed__30_1.json", 5);
  const keyed = readExportIndex(root).rows.filter((x) => x.id === "30:1").map((x) => x.name).join(",");
  check(`a newer row that is the same screen as two kept rows replaces both (got ${keyed})`, keyed === "Unkeyed");
  stamp("C_Later/Unkeyed__30_1.json", 0);
  const older = readExportIndex(root).rows.filter((x) => x.id === "30:1").map((x) => x.name).join(",");
  check(`…and an older one replaces neither (got ${older})`, older === "K1,K2");
}
{
  // rows without a `file` (hand-edited: the guards ask for id and name only) are not one screen by their missing file
  const root = tmp("no-file");
  put(path.join(root, "pages", "index.json"), { pageDirs: [], layers: [{ id: "8:1", name: "A" }, { id: "8:2", name: "B" }, { id: "8:3", name: "C", file: "" }] });
  check("rows with no file stay distinct screens", ids(readExportIndex(root).rows) === "8:1,8:2,8:3");
}
{
  // a relative export root (verify-screen passes design/export): each page index is read once
  const root = twoWalks();
  const orig = fs.readFileSync;
  const reads: string[] = [];
  fs.readFileSync = ((...a: Parameters<typeof fs.readFileSync>) => { reads.push(String(a[0])); return orig(...a); }) as typeof fs.readFileSync;
  let rel: ReturnType<typeof readExportIndex>;
  try { rel = readExportIndex(path.relative(process.cwd(), root)); } finally { fs.readFileSync = orig; }
  const homeReads = reads.filter((f) => f.endsWith(path.join("Home", "index.json"))).length;
  check(`a relative root: the same rows, each page index read once (Home read ${homeReads}x)`, ids(rel.rows) === "10:1,10:2,20:1" && homeReads === 1);
}
{
  // a page index reached only through its pageDirs pointer, and pointers that leave the export
  const root = tmp("pointers");
  put(path.join(root, "pages", "index.json"), { pageDirs: [
    { page: "Flat", dir: "Flat", index: "pages/Flat/listing.json", layers: 1 },
    { page: "Out", dir: "Out", index: "../outside/index.json", layers: 1 },
    { page: "Up", dir: "..", layers: 1 },
  ] });
  put(path.join(root, "pages", "Flat", "listing.json"), { page: "Flat", layers: [{ id: "3:1", name: "C", file: "pages/Flat/C__3_1.json" }] });
  put(path.join(path.dirname(root), "outside", "index.json"), { page: "Out", layers: [{ id: "4:1", name: "D", file: "x.json" }] });
  put(path.join(path.dirname(root), "index.json"), { page: "Up", layers: [{ id: "5:1", name: "E", file: "y.json" }] });
  const ix = readExportIndex(root);
  check(`a pageDirs index pointer is read; one leaving the export is not (got ${ids(ix.rows)})`, ids(ix.rows) === "3:1");
}
{
  // no root `layers` (an export older than that field): the page indexes alone
  const root = tmp("old");
  put(path.join(root, "pages", "index.json"), { pageDirs: [{ page: "Home", dir: "Home", layers: 1 }] });
  put(path.join(root, "pages", "Home", "index.json"), { page: "Home", layers: [{ id: "1:2", name: "A", file: "pages/Home/A__1_2.json" }] });
  put(path.join(root, "pages", "Broken", "index.json"), "{ not json");
  const ix = readExportIndex(root);
  check("an export with no root `layers`: the page indexes' rows; a broken page index adds none", ids(ix.rows) === "1:2");
  check(`…and is named, export-relative, among the problems (got ${JSON.stringify(ix.problems)})`,
    ix.problems.length === 1 && ix.problems[0]?.file === "pages/Broken/index.json" && /not valid JSON/.test(ix.problems[0].error));
  put(path.join(root, "pages", "Home", "index.json"), { page: "Home", layers: [null, { id: "1:2", name: "A", file: "pages/Home/A__1_2.json" }] });
  check("a null row (an older index could hold one) is skipped, the index still read", ids(readExportIndex(root).rows) === "1:2");
}
{
  const corrupt = tmp("corrupt");
  put(path.join(corrupt, "pages", "index.json"), "{ not json");
  put(path.join(corrupt, "pages", "Home", "index.json"), { page: "Home", layers: [{ id: "1:2", name: "A", file: "pages/Home/A__1_2.json" }] });
  const c = readExportIndex(corrupt);
  check(`a broken root index: why, and the page indexes are still read (got ${c.rootProblem})`, !c.indexed && /not valid JSON/.test(c.rootProblem ?? "") && ids(c.rows) === "1:2");
  const none = readExportIndex(tmp("none"));
  check("no export at all: no rows, not indexed, no problem to report", !none.indexed && none.rootProblem === null && none.rows.length === 0 && none.problems.length === 0);
  check("the broken root is among the problems too", c.problems.some((p) => p.file === "pages/index.json" && p.error === c.rootProblem));
}

console.log("fileOf: a row's screen file, inside the export only");
{
  const root = twoWalks();
  const ix = readExportIndex(root);
  const row = (file: string): IndexRow => ({ id: "1:1", name: "x", file });
  check("a row's file, resolved against the export root", ix.fileOf(row("pages/Home/Dashboard__10_1.json")) === path.join(root, "pages", "Home", "Dashboard__10_1.json"));
  check("`..`, an absolute path and an empty file → null",
    ix.fileOf(row("../x.json")) === null && ix.fileOf(row("pages/../../x.json")) === null && ix.fileOf(row(path.join(root, "pages", "x.json"))) === null && ix.fileOf(row("")) === null);
}

console.log("the export root: from a screen file, from a dir");
{
  const root = twoWalks();
  const screen = path.join(root, "pages", "Settings", "Profile__20_1.json");
  check("a screen file at pages/<dir>/ of an indexed export → its root", exportRootOfScreen(screen) === root);
  check("hasExportIndex: pages/index.json is there", hasExportIndex(root) && !hasExportIndex(path.join(root, "pages")));
  const bare = tmp("bare");
  put(path.join(bare, "pages", "Home", "A__1_2.json"), {});
  check("no root index beside it → null", exportRootOfScreen(path.join(bare, "pages", "Home", "A__1_2.json")) === null);
  check("…its pages/ tree's root all the same (pagesRootOfScreen)", pagesRootOfScreen(path.join(bare, "pages", "Home", "A__1_2.json")) === bare && pagesRootOfScreen(path.join(bare, "x.json")) === null);
  check("a file not at pages/<dir>/ → null", exportRootOfScreen(path.join(root, "pages", "index.json")) === null && exportRootOfScreen(path.join(root, "x.json")) === null);
  const project = tmp("project");
  walk(path.join(project, "design", "export"), [dashboard]);
  check("findExportRoot: an ancestor holding pages/index.json", findExportRoot(path.join(root, "pages", "Home")) === root);
  check("findExportRoot: the export just below a project dir", findExportRoot(project) === path.join(project, "design", "export"));
  check("findExportRoot: none → null", findExportRoot(tmp("empty")) === null);
}

console.log("exportedAtOf: when a row's screen was pulled");
{
  const root = tmp("stamps");
  put(path.join(root, "pages", "index.json"), { exportedAt: "2026-01-02T00:00:00.000Z", pageDirs: [], layers: [
    { id: "1:1", name: "Walked", file: "pages/Home/Walked__1_1.json" },
    { id: "1:2", name: "Pulled", file: "pages/Home/Pulled__1_2.json", exportedAt: "2026-01-03T00:00:00.000Z" },
  ] });
  put(path.join(root, "pages", "Old", "index.json"), { page: "Old", layers: [
    { id: "2:1", name: "Earlier", file: "pages/Old/Earlier__2_1.json" },
    { id: "2:2", name: "Single", file: "pages/Old/Single__2_2.json", exportedAt: "2026-01-04T00:00:00.000Z" },
  ] });
  const ix = readExportIndex(root);
  const at = (id: string): string | undefined => { const row = ix.rows.find((r) => r.id === id); return row && ix.exportedAtOf(row); };
  check("a page walk's root row: the root index's stamp", at("1:1") === "2026-01-02T00:00:00.000Z");
  check("a row's own stamp wins", at("1:2") === "2026-01-03T00:00:00.000Z" && at("2:2") === "2026-01-04T00:00:00.000Z");
  check("an earlier walk's unstamped row, listed by no root row: no stamp (the root's is another walk's)", at("2:1") === undefined);
  const last = lastScreenExport(root, Date.parse("2026-01-05T00:00:00.000Z"));
  check(`snapshot-meta's last screen is read off every index, not the root's rows alone (got ${last?.id})`, last?.id === "2:2" && last.file === "pages/Old/Single__2_2.json");
}

console.log("exportRoot: which export a reader reads (and write-out writes)");
{
  const saved = process.env.FIGMA_EXPORT_DIR;
  try {
    delete process.env.FIGMA_EXPORT_DIR;
    const modern = tmp("root-modern");
    check("nothing exported yet: design/export under the cwd", exportRoot(undefined, modern) === path.join(modern, "design", "export"));
    put(path.join(modern, "design", "design-system.json"), {});
    check("the older flat layout: design/ itself, when it holds an export", exportRoot(undefined, modern) === path.join(modern, "design"));
    put(path.join(modern, "design", "export", "design-system.json"), {});
    check("both: design/export wins", exportRoot(null, modern) === path.join(modern, "design", "export"));
    process.env.FIGMA_EXPORT_DIR = "elsewhere";
    check("FIGMA_EXPORT_DIR beats the layout, resolved against the cwd", exportRoot("", modern) === path.join(modern, "elsewhere"));
    check("a dir given beats both", exportRoot("mine", modern) === path.join(modern, "mine") && (() => { const abs = path.join(tmp("abs"), "x"); return exportRoot(abs, modern) === abs; })());
  } finally {
    if (saved === undefined) delete process.env.FIGMA_EXPORT_DIR; else process.env.FIGMA_EXPORT_DIR = saved;
  }
  const design = path.join(tmp("design-dir"), "design");
  check("exportInDesignDir: <design>/export when nothing is there yet", exportInDesignDir(design) === path.join(design, "export"));
  put(path.join(design, "design-system.json"), {});
  check("exportInDesignDir: the design dir itself on the older flat layout", exportInDesignDir(design) === design);
  put(path.join(design, "export", "pages", "index.json"), { pageDirs: [] });
  check("exportInDesignDir: <design>/export once it holds an export", exportInDesignDir(design) === path.join(design, "export"));
}

console.log("the design system: its stamp, and the manifest's pointers");
{
  const root = tmp("ds");
  check("no design system: no stamp, no problem", (() => { const r = readDesignSystemStamp(root); return r.stamp === null && r.problems.length === 0; })());
  put(path.join(root, "design-system", "tokens.json"), { exportedAt: "2026-01-01T00:00:00.000Z", file: "Kit", colorProfile: "srgb", variables: [] });
  const fromPart = readDesignSystemStamp(root);
  check("no manifest: a split part's stamp", fromPart.stamp?.file === "Kit" && fromPart.stamp.colorProfile === "srgb" && fromPart.problems.length === 0);
  const snap = readSnapshotInfo(root);
  check(`…and snapshot-meta (figma_status, doctor) reports the same export, not "nothing exported" (got ${JSON.stringify(snap)})`,
    !!snap && "exportedAt" in snap && snap.exportedAt === "2026-01-01T00:00:00.000Z" && snap.sourceFile === "Kit");
  put(path.join(root, "design-system.json"), { exportedAt: "2026-01-02T00:00:00.000Z", file: "Kit v2", files: { componentsLocal: "design-system/components.local.json", tokens: "../outside.json" } });
  const fromManifest = readDesignSystemStamp(root);
  check("the manifest's stamp, the stamp fields only", JSON.stringify(fromManifest.stamp) === JSON.stringify({ exportedAt: "2026-01-02T00:00:00.000Z", file: "Kit v2" }));
  const part = designSystemPart(root, "componentsLocal");
  check("a pointer, followed inside the export", "file" in part && part.file === path.join(root, "design-system", "components.local.json"));
  const out = designSystemPart(root, "tokens");
  check(`a pointer leaving the export is refused, by name (got ${"error" in out ? out.error : "a file"})`, "error" in out && /files\.tokens \('\.\.\/outside\.json'\) leads outside the export/.test(out.error));
  const none = designSystemPart(root, "hygiene");
  check("no such pointer: said", "error" in none && /has no files\.hygiene pointer/.test(none.error));
  put(path.join(root, "design-system.json"), { exportedAt: "2026-01-02T00:00:00.000Z", file: { name: "x" } });
  const bad = readDesignSystemStamp(root);
  check(`a wrong-shaped manifest is a problem, and the part's stamp is read instead (got ${JSON.stringify(bad.problems)})`,
    bad.problems.length === 1 && bad.problems[0]?.file === "design-system.json" && /`file`/.test(bad.problems[0].error) && bad.stamp?.file === "Kit");
  check("…and a pointer cannot be followed through it", (() => { const r = designSystemPart(root, "componentsLocal"); return "error" in r && /design-system\.json is not a design-system manifest/.test(r.error); })());
  const missing = designSystemPart(tmp("ds-none"), "componentsLocal");
  check("no manifest at all: no design export found", "error" in missing && /no design export found at .*design-system\.json/.test(missing.error));
}

console.log("doctor counts each screen once (a screen re-filed under a renamed page's dir)");
{
  // Two single-screen pulls of one frame, the page renamed in Figma between them: the second files the screen under
  // pages/New/ and the root lists it there, while pages/Old/index.json keeps the old row — and both page dirs stay in
  // pageDirs (mergeRootIndex replaces an entry by its dir). One node of one Figma file: one screen. Doctor used to
  // de-duplicate by `file` alone, and counted two.
  const project = tmp("doctor-renamed");
  const root = path.join(project, "design", "export");
  const at = new Date().toISOString();
  const row = (dir: string): IndexRow => ({ id: "10:1", name: "Tray", page: dir, pageId: "1:1", file: `pages/${dir}/Tray__10_1.json`, sourceFile: "Product", sourceFileKey: "k1", exportedAt: at });
  put(path.join(project, "design", "target.json"), {});
  put(path.join(root, "design-system.json"), { exportedAt: at, file: "Kit" });
  put(path.join(root, "pages", "index.json"), { pageDirs: [
    { page: "Old", pageId: "1:1", dir: "Old", index: "pages/Old/index.json", layers: 1 },
    { page: "New", pageId: "1:1", dir: "New", index: "pages/New/index.json", layers: 1 },
  ], layers: [row("New")] });
  put(path.join(root, "pages", "New", "index.json"), { page: "New", pageId: "1:1", layers: [row("New")] });
  put(path.join(root, "pages", "Old", "index.json"), { page: "Old", pageId: "1:1", layers: [row("Old")] });
  put(path.join(root, "pages", "New", "Tray__10_1.json"), { exportedAt: at, nodes: [] });
  put(path.join(root, "pages", "Old", "Tray__10_1.json"), { exportedAt: at, nodes: [] });
  check("fixture: the reader holds one row for the frame", readExportIndex(root).rows.length === 1);
  const exp = checkProject(project).filter((c) => c.id === "export");
  check(`doctor: 1 screen, not 2 (got ${JSON.stringify(exp.map((c) => c.detail))})`, exp.length === 1 && /^1 screen\(s\) from 'Product'/.test(exp[0]?.detail ?? ""));
}

report();
