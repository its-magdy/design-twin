// design-to-code/export-index.ts: every screen an export knows about, read through one module — the root
// pages/index.json and every page's own pages/<dir>/index.json, merged under one rule.
// Invented screens, temp dirs only. The two-walk fixture is written by bridge/src/pages-layout.ts's own
// buildPageLayout, byte for byte as write-out.ts's writePages lands it: a page walk REPLACES the root index.
//   bun test/export-index.test.ts
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
import { exportRootOfScreen, findExportRoot, hasExportIndex, pagesRootOfScreen, readExportIndex } from "../design-to-code/export-index.ts";
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
  check("an export with no root `layers`: the page indexes' rows; a broken page index adds none", ids(readExportIndex(root).rows) === "1:2");
}
{
  const corrupt = tmp("corrupt");
  put(path.join(corrupt, "pages", "index.json"), "{ not json");
  put(path.join(corrupt, "pages", "Home", "index.json"), { page: "Home", layers: [{ id: "1:2", name: "A", file: "pages/Home/A__1_2.json" }] });
  const c = readExportIndex(corrupt);
  check(`a broken root index: why, and the page indexes are still read (got ${c.rootProblem})`, !c.indexed && /not valid JSON/.test(c.rootProblem ?? "") && ids(c.rows) === "1:2");
  const none = readExportIndex(tmp("none"));
  check("no export at all: no rows, not indexed, no problem to report", !none.indexed && none.rootProblem === null && none.rows.length === 0);
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

report();
