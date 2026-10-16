// What bridge/src/write-out.ts tells a long-running caller without re-walking the export: writeExport's
// `opts.replaced` (the pages/ layer files a write replaced — the MCP server's implicit-spill note counts them),
// and the per-file memo of other screens' reuse keys that a screen pull's cross-screen hidden reuse reads
// through (stale entries must never change which twin is found).
// Pure functions and temp dirs only — binds no port.
// Run with:  node test/write-out-bookkeeping.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ok, report } from "./assert.ts";
import { node, screenReply } from "./fixtures.ts";
import type { NodeInput } from "./fixtures.ts";
import * as writeOut from "../bridge/src/write-out.ts";
import { resolveScreen } from "../design-to-code/resolve-screen.ts";
import type { Asset, IrNode, ScreenExport } from "../bridge/src/doc-types.ts";

const t = (name: string, cond: () => boolean): void => {
  let v = false;
  try { v = cond(); } catch (e) { console.log("    threw: " + String(e instanceof Error ? e.stack ?? e.message : e)); }
  ok(name, v);
};
const tmp = (tag: string): string => fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-wobk-" + tag + "-"));
const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

// ------------------------------------------------------------------ writeExport's replaced list
console.log("writeExport lists the pages/ layer files it replaced:");
{
  interface L { id: string; name: string; page: string }
  // A full reply built fresh per call (writeExport stamps sourceFile onto layersDoc in place).
  const full = (layers: readonly L[], stamp = "2026-10-01T00:00:00.000Z") => ({
    designSystem: { file: "Sample File", exportedAt: stamp, collections: [], variables: [], styles: { paint: [], text: [], effect: [], grid: [] }, components: [], hygiene: [] },
    layersDoc: {
      exportedAt: stamp,
      index: layers.map((l) => ({ id: l.id, name: l.name, type: "FRAME", pageId: "p-" + l.page, page: l.page })),
      layers: layers.map((l) => ({ id: l.id, name: l.name, page: l.page, pageId: "p-" + l.page, tree: node({ type: "FRAME", id: l.id, name: l.name }) })),
    },
    assets: [],
  });
  const spill = (dir: string, layers: readonly L[], stamp?: string): { replaced: string[]; res: object } => {
    const replaced: string[] = [];
    const res = writeOut.writeExport(dir, full(layers, stamp), undefined, { keepPrev: true, replaced });
    return { replaced, res };
  };
  const layerFile = (dir: string, l: L): string => path.join(dir, "pages", l.page.replace(/[^A-Za-z0-9]/g, "_"), `${l.name}__${l.id.replace(/:/g, "_")}.json`);
  const A: L = { id: "1:2", name: "Panel", page: "Page A" }, B: L = { id: "1:5", name: "Sheet", page: "Page A" }, C: L = { id: "2:1", name: "Card", page: "Page B" };
  const dir = path.join(tmp("replaced"), "design");

  const first = spill(dir, [A, B, C]);
  t("a first export into an empty dir replaced nothing", () => first.replaced.length === 0 && fs.existsSync(layerFile(dir, A)) && fs.existsSync(layerFile(dir, C)));
  const again = spill(dir, [A, B, C], "2026-10-02T00:00:00.000Z");
  t("the same export again replaced every layer file (absolute paths), whatever their content", () =>
    sameSet(again.replaced, [A, B, C].map((l) => layerFile(dir, l))) && again.replaced.every((f) => path.isAbsolute(f)));
  // pages/ also holds files this write does not touch: a screen pull's sidecars and a layer this export no longer has.
  const sidecar = path.join(dir, "pages", "Page_A", "Other__9_9.assets.json");
  fs.writeFileSync(sidecar, "{}");
  const renamed: L = { id: "1:5", name: "Drawer", page: "Page A" }, added: L = { id: "3:1", name: "Modal", page: "Page C" };
  const partial = spill(dir, [A, renamed, added], "2026-10-03T00:00:00.000Z");
  t("a renamed layer (new path), a new page's layer, a dropped layer and a sidecar are not replaced — only A is", () =>
    sameSet(partial.replaced, [layerFile(dir, A)]) && fs.existsSync(layerFile(dir, C)) && fs.existsSync(sidecar));
  t("pages/index.json and the per-page index.json are never listed", () => ![...again.replaced, ...partial.replaced].some((f) => path.basename(f) === "index.json"));

  // Two layers that land on one path: the second write finds the first one's file, but it was not on disk BEFORE the write.
  const dup = path.join(tmp("dup"), "design");
  const twin = spill(dup, [A, { ...A }]);
  t("a path written twice by one export into an empty dir is not counted as replaced", () => twin.replaced.length === 0);
  const twinAgain = spill(dup, [A, { ...A }], "2026-10-02T00:00:00.000Z");
  t("…and over its earlier export it is listed once", () => sameSet(twinAgain.replaced, [layerFile(dup, A)]));

  t("the result itself carries no replaced list (the CLI and MCP output are unchanged)", () =>
    !("replaced" in again.res) && "wrote" in again.res && typeof again.res.wrote === "object" && again.res.wrote !== null && !("replaced" in again.res.wrote));
  const dsOnly: string[] = [];
  writeOut.writeExport(dir, { designSystem: full([]).designSystem }, undefined, { keepPrev: true, replaced: dsOnly });
  const libOnly: string[] = [];
  writeOut.writeExport(dir, { designSystem: { ...full([]).designSystem, source: { role: "library", libraryName: "Kit", fileKey: "abcd1234efgh" } } }, undefined, { keepPrev: true, replaced: libOnly });
  t("a design-system-only or library export replaces no layer file", () => dsOnly.length === 0 && libOnly.length === 0);
  const viaAny: string[] = [];
  writeOut.writeAny(dir, full([A]), undefined, { keepPrev: true, replaced: viaAny });
  t("writeAny forwards `replaced` to writeExport", () => sameSet(viaAny, [layerFile(dir, A)]));
  const viaAnyNoPrev: string[] = [];
  writeOut.writeAny(dir, full([A]), undefined, { replaced: viaAnyNoPrev });
  t("…with or without keepPrev", () => sameSet(viaAnyNoPrev, [layerFile(dir, A)]));
}

// ------------------------------------------------------------------ the memo of other screens' reuse keys
console.log("\ncross-screen hidden reuse reads other screens' .assets.json through a memo that never goes stale:");
{
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><path fill="#123456" d="M0 0L4 4Z"/></svg>';
  // A screen whose Tab instance shows its icon; `key` is the Tab's main component, part of the icon's reuse key.
  const visible = (id: string, key: string): NodeInput[] => [{ id: id + ":1", type: "FRAME", children: [
    { id: id + ":2", type: "INSTANCE", name: "Tab", mainComponent: { name: "Tab", id: "40:1", key }, props: { Text: "Home" },
      children: [{ id: `I${id}:2;40:3`, type: "VECTOR", name: "Icon", box: { w: 20, h: 20 }, asset: `assets/icon-${id}.svg` }] },
  ] }];
  const hidden = (id: string, key: string): NodeInput[] => [{ id: id + ":1", type: "FRAME", children: [
    { id: id + ":2", type: "INSTANCE", name: "Tab", hidden: true, mainComponent: { name: "Tab", id: "40:1", key }, props: { Text: "Home" },
      children: [{ id: `I${id}:2;40:3`, type: "VECTOR", name: "Icon", box: { w: 20, h: 20 }, assetSkipped: "hidden" }] },
  ] }];
  const pull = (dir: string, name: string, id: string, nodes: NodeInput[], assets: Asset[] = []): ScreenExport => {
    writeOut.writeScreen(dir, screenReply({
      screenName: name, nodeId: id + ":1", page: "Page", pageId: "0:1",
      screen: { screen: name, exportedAt: "2026-10-06T00:00:00.000Z", nodes, manifest: { nodes: 4, assetsHidden: assets.length ? 0 : 1 } },
      assets,
    }));
    const doc: ScreenExport = JSON.parse(fs.readFileSync(path.join(dir, "pages", "Page", `${name}__${id}_1.json`), "utf8")) as ScreenExport;
    return doc;
  };
  const iconOf = (id: string): Asset[] => [{ id: `I${id}:2;40:3`, name: "Icon", format: "svg", file: `icon-${id}.svg`, text: svg }];
  const find = (nodes: readonly IrNode[] | undefined, id: string): IrNode | undefined => {
    for (const n of nodes || []) { if (n.id === id) return n; const c = find(n.children, id); if (c) return c; }
    return undefined;
  };
  const reusedFrom = (doc: ScreenExport, id: string): string | undefined => find(doc.nodes, `I${id}:2;40:3`)?.assetFrom;

  // The memo runs on a clock a minute ahead, so every file is old enough to be remembered as soon as it is read.
  const later = (): number => Date.now() + 60_000;
  const stale = tmp("memo-stale"), fresh = tmp("memo-hit");

  writeOut.resetScreenReuseKeys({ now: later });
  pull(stale, "Home", "7", visible("7", "k-oth"), iconOf("7"));
  const s1 = pull(stale, "Settings", "8", hidden("8", "k-tab"));
  t("a hidden icon whose key no other screen holds stays unreused", () => reusedFrom(s1, "8") === undefined);
  t("…and the other screen's keys are now remembered", () => writeOut.screenReuseKeys.size === 1);
  // Home re-pulled at once with the key the hidden icon wants (a key of the same length, so the same size):
  // its .assets.json is replaced by rename — a new inode, whatever the timestamps' precision.
  pull(stale, "Home", "7", visible("7", "k-tab"), iconOf("7"));
  const s2 = pull(stale, "Profile", "9", hidden("9", "k-tab"));
  t("after the other screen is re-pulled with the wanted key, the next pull reuses its file (the remembered keys are not used)", () =>
    reusedFrom(s2, "9") === "I7:2;40:3" && find(s2.nodes, "I9:2;40:3")?.asset === "assets/icon-7.svg");

  writeOut.resetScreenReuseKeys({ now: later });
  pull(fresh, "Home", "7", visible("7", "k-tab"), iconOf("7"));
  const h1 = pull(fresh, "Settings", "8", hidden("8", "k-tab"));
  const stored = writeOut.screenReuseKeys.size; // Home's; Settings' own .assets.json is written after the lookup
  const h2 = pull(fresh, "Profile", "9", hidden("9", "k-tab"));
  t("an unchanged other screen answers from the memo with the same twin as a fresh read", () =>
    stored === 1 && reusedFrom(h1, "8") === "I7:2;40:3" && reusedFrom(h2, "9") === "I7:2;40:3" && writeOut.screenReuseKeys.size === 2);

  // On the real clock every file here was written in the last 2 s: each is read, none remembered.
  writeOut.resetScreenReuseKeys();
  const h3 = pull(fresh, "Account", "10", hidden("10", "k-tab"));
  t("a screen written in the last 2 s is read again, never remembered", () => reusedFrom(h3, "10") === "I7:2;40:3" && writeOut.screenReuseKeys.size === 0);

  // A .assets.json that is unreadable as JSON holds no keys; the memo must not turn that into an error.
  const broken = tmp("memo-broken");
  pull(broken, "Home", "7", visible("7", "k-tab"), iconOf("7"));
  fs.writeFileSync(path.join(broken, "pages", "Page", "Home__7_1.assets.json"), "{ not json");
  const b1 = pull(broken, "Settings", "8", hidden("8", "k-tab"));
  t("a malformed other .assets.json offers no twin (and does not throw)", () => reusedFrom(b1, "8") === undefined);
  for (const d of [stale, fresh, broken]) fs.rmSync(d, { recursive: true, force: true });
}

// ------------------------------------------------------------------ one row per node: stem and index agree, a rename replaces its row
console.log("\na screen's stem and its index row name one node, and a frame renamed in Figma keeps one row:");
{
  interface Row { id?: unknown; name?: unknown; file?: unknown; sourceFile?: unknown }
  const rowsOf = (dir: string, rel: string): Row[] => {
    const doc: unknown = JSON.parse(fs.readFileSync(path.join(dir, rel), "utf8"));
    const layers = doc && typeof doc === "object" && "layers" in doc && Array.isArray(doc.layers) ? doc.layers : [];
    return layers.filter((l): l is Row => !!l && typeof l === "object");
  };
  const pullAs = (dir: string, name: string, opts: { nodeId?: string; sourceFile?: string; pageId?: string } = {}): void => {
    writeOut.writeScreen(dir, screenReply({
      screenName: name, page: "Page", pageId: opts.pageId ?? "0:1", ...(opts.nodeId ? { nodeId: opts.nodeId } : {}), ...(opts.sourceFile ? { sourceFile: opts.sourceFile } : {}),
      screen: { screen: name, exportedAt: "2026-10-06T00:00:00.000Z", nodes: [{ id: "5:1", type: "FRAME", name }], manifest: { nodes: 1 } },
    }));
  };
  const noId = tmp("stem-root");
  pullAs(noId, "Tray");
  const root0 = rowsOf(noId, path.join("pages", "index.json"));
  t("a reply naming no nodeId files under its root node's id, and the index row names that file and id", () =>
    fs.existsSync(path.join(noId, "pages", "Page", "Tray__5_1.json")) && root0.length === 1 && root0[0]?.id === "5:1" && root0[0]?.file === "pages/Page/Tray__5_1.json");

  const ren = tmp("stem-rename");
  pullAs(ren, "Tray", { nodeId: "5:1", sourceFile: "Sample File" });
  pullAs(ren, "Tray Panel", { nodeId: "5:1", sourceFile: "Sample File" });
  const rootRows = rowsOf(ren, path.join("pages", "index.json")), pageRows = rowsOf(ren, path.join("pages", "Page", "index.json"));
  t("re-pulled under a new name: ONE row for the node in the root index and in the page index, naming the new file", () =>
    rootRows.filter((r) => r.id === "5:1").length === 1 && pageRows.filter((r) => r.id === "5:1").length === 1
    && rootRows[0]?.file === "pages/Page/Tray_Panel__5_1.json" && pageRows[0]?.name === "Tray Panel");
  const byId = resolveScreen(ren, "5:1");
  t("…so a lookup by the node id resolves it", () => byId.status === "resolved" && byId.row.name === "Tray Panel");
  pullAs(ren, "Tray Other", { nodeId: "5:1", sourceFile: "Other File" });
  t("the same node id from another Figma file (another name, so another file) is another row", () => rowsOf(ren, path.join("pages", "index.json")).filter((r) => r.id === "5:1").length === 2);

  // a row pulled before rows were stamped with their Figma file: ids repeat across files, so it is the same node only
  // when the incoming row is unstamped too, or names the same page
  const idsOf = (dir: string): number => rowsOf(dir, path.join("pages", "index.json")).filter((r) => r.id === "5:1").length;
  const old = tmp("stem-unstamped");
  pullAs(old, "Tray", { nodeId: "5:1" });
  pullAs(old, "Tray Other", { nodeId: "5:1", sourceFile: "Other File", pageId: "9:9" });
  t("an unstamped row is kept when another Figma file (stamped, another page) pulls the same id", () => idsOf(old) === 2);
  const samePage = tmp("stem-unstamped-page");
  pullAs(samePage, "Tray", { nodeId: "5:1" });
  pullAs(samePage, "Tray Panel", { nodeId: "5:1", sourceFile: "Sample File" });
  t("…replaced when the stamped pull names the same page", () => idsOf(samePage) === 1);
  const bothBare = tmp("stem-unstamped-both");
  pullAs(bothBare, "Tray", { nodeId: "5:1" });
  pullAs(bothBare, "Tray Panel", { nodeId: "5:1", pageId: "9:9" });
  t("…and replaced when the incoming row is unstamped too", () => idsOf(bothBare) === 1);
  for (const d of [noId, ren, old, samePage, bothBare]) fs.rmSync(d, { recursive: true, force: true });
}

report();
