// End-to-end tests of a single-screen pull's asset handling (bridge/src/write-out.ts writeScreen into a tmp
// dir): content reuse + `duplicates` under the SVG fingerprint (DT-18), the embedded-raster warning (DT-09),
// the `.assets.json` owner fields (DT-54/F-36), hidden reuse of a visible twin's file (DT-10, D64) and the
// geometry-fallback warning (D63). Fixtures use the PLUGIN's shapes: `Asset.file` is the bare name, the tree's
// pointer is `assets/<name>`, `kind` absent (or "reference"), box is w/h. Names are invented.
// Run with:  node test/asset-index.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ok, report } from "./assert.ts";
import { screenReply } from "./fixtures.ts";
import type { NodeInput } from "./fixtures.ts";
import * as writeOut from "../bridge/src/write-out.ts";
import * as owners from "../bridge/src/asset-owners.ts";
import * as snapshotMeta from "../bridge/src/snapshot-meta.ts";
import type { AssetIndexEntry } from "../bridge/src/write-out.ts";
import type { Asset, IrNode, Manifest, ScreenExport, Variable } from "../bridge/src/doc-types.ts";

const FIX = path.join(import.meta.dirname, "fixtures", "g13", "svg");
const read = (f: string): string => fs.readFileSync(path.join(FIX, f), "utf8");
const tmp = (tag: string): string => fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-g13-" + tag + "-"));
const svgAsset = (id: string, file: string, text: string, name = file.replace(/\.svg$/, "")): Asset => ({ id, name, format: "svg", file, text });

// <Screen>.assets.json as writeScreenAssets writes it (the fields read below).
interface AssetsDoc { duplicates: Array<{ hash: string; files: string[] }>; heavy: Array<{ file: string; bytes: number; paths?: number; embeddedRaster?: number }>; files: AssetIndexEntry[] }
const readJson = <T>(file: string): T => {
  const v: T = JSON.parse(fs.readFileSync(file, "utf8")) as T;
  return v;
};
const t = (name: string, cond: () => boolean): void => {
  let v = false;
  try { v = cond(); } catch (e) { console.log("    threw: " + String(e instanceof Error ? e.message : e)); }
  ok(name, v);
};

interface Pull { dir: string; screen: ScreenExport; assets: AssetsDoc | null; log: string[]; wrote: number }
function pull(dir: string, o: { name: string; id: string; nodes: NodeInput[]; assets: Asset[]; manifest?: Partial<Manifest> }): Pull {
  const log: string[] = [];
  let wrote = -1;
  try {
    const r = writeOut.writeScreen(dir, screenReply({
      screenName: o.name, nodeId: o.id, page: "Page", pageId: "0:1",
      screen: { screen: o.name, exportedAt: "2026-10-06T00:00:00.000Z", nodes: o.nodes, manifest: { nodes: 10, ...o.manifest } },
      assets: o.assets,
    }), (m) => log.push(m));
    wrote = r.wrote.assets;
  } catch (e) { log.push("THREW " + String(e instanceof Error ? e.message : e)); }
  const base = path.join(dir, "pages", "Page", o.name + "__" + o.id.replace(/:/g, "_"));
  let screen: ScreenExport = { nodes: [] };
  try { screen = readJson<ScreenExport>(base + ".json"); } catch { /* reported by the checks */ }
  let assets: AssetsDoc | null = null;
  try { assets = readJson<AssetsDoc>(base + ".assets.json"); } catch { /* reported by the checks */ }
  return { dir, screen, assets, log, wrote };
}
const findNode = (nodes: readonly IrNode[] | undefined, id: string): IrNode | undefined => {
  for (const n of nodes || []) { if (n.id === id) return n; const c = findNode(n.children, id); if (c) return c; }
  return undefined;
};
const row = (p: Pull, file: string): AssetIndexEntry | undefined => (p.assets ? p.assets.files.find((f) => f.file === file) : undefined);
const assetFiles = (dir: string): string[] => { try { return fs.readdirSync(path.join(dir, "assets")).sort(); } catch { return []; } };

// ------------------------------------------------------------------ DT-18
console.log("DT-18 — re-exports of one icon fold into one file:");
{
  const dir = tmp("dedupe");
  pull(dir, { name: "One", id: "1:1", nodes: [{ id: "1:1", type: "FRAME", children: [{ id: "1:2", type: "VECTOR", name: "Disc", asset: "assets/disc.svg" }] }], assets: [svgAsset("1:2", "disc.svg", read("disc-a.svg"))] });
  const p2 = pull(dir, { name: "Two", id: "2:1", nodes: [{ id: "2:1", type: "FRAME", children: [{ id: "2:2", type: "VECTOR", name: "Disc", asset: "assets/disc-1a2b3c.svg" }] }], assets: [svgAsset("2:2", "disc-1a2b3c.svg", read("disc-b.svg"))] });
  t("[DT-18] a re-export differing only in def ids writes no new file", () => assetFiles(dir).join(",") === "disc.svg");
  t("[DT-18] …the node points at the file already on disk", () => findNode(p2.screen.nodes, "2:2")?.asset === "assets/disc.svg");
  t("[DT-18] …and it is counted as written", () => p2.wrote === 1);
  // The disc pair differs in ids only; this one in numbers (0.002 apart across a rounding boundary).
  pull(dir, { name: "Four", id: "4:1", nodes: [{ id: "4:1", type: "FRAME", children: [{ id: "4:2", type: "VECTOR", name: "Badge", asset: "assets/badge.svg" }] }], assets: [svgAsset("4:2", "badge.svg", read("badge-a.svg"))] });
  const p5 = pull(dir, { name: "Five", id: "5:1", nodes: [{ id: "5:1", type: "FRAME", children: [{ id: "5:2", type: "VECTOR", name: "Badge", asset: "assets/badge-9f8e7d.svg" }] }], assets: [svgAsset("5:2", "badge-9f8e7d.svg", read("badge-b.svg"))] });
  t("[DT-18] a re-export whose numbers drift by 0.002 writes no new file either", () => assetFiles(dir).join(",") === "badge.svg,disc.svg" && findNode(p5.screen.nodes, "5:2")?.asset === "assets/badge.svg");
}
{
  const dir = tmp("dupes");
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "assets", "disc.svg"), read("disc-a.svg"));
  fs.writeFileSync(path.join(dir, "assets", "disc-1a2b3c.svg"), read("disc-b.svg"));
  fs.writeFileSync(path.join(dir, "assets", "ring.svg"), read("ring-a.svg"));
  fs.writeFileSync(path.join(dir, "assets", "ring-2fd8d2.svg"), read("ring-b.svg"));
  fs.writeFileSync(path.join(dir, "assets", "badge.svg"), read("badge-a.svg"));
  fs.writeFileSync(path.join(dir, "assets", "badge-16da49.svg"), read("badge-b.svg"));
  const p = pull(dir, {
    name: "Three", id: "3:1",
    nodes: [{ id: "3:1", type: "FRAME", children: [{ id: "3:2", type: "VECTOR", name: "Disc", asset: "assets/disc.svg" }, { id: "3:3", type: "VECTOR", name: "Ring", asset: "assets/ring.svg" }] }],
    assets: [svgAsset("3:2", "disc.svg", read("disc-a.svg")), svgAsset("3:3", "ring.svg", read("ring-a.svg"))],
  });
  const d = p.assets ? p.assets.duplicates : [];
  t("[DT-18] two files of one icon already on disk are ONE duplicates group of 2, representative first",
    () => d.length === 1 && d[0]?.files.join(",") === "assets/disc.svg,assets/disc-1a2b3c.svg" && /^[0-9a-f]{40}$/.test(d[0]?.hash ?? ""));
  const pb = pull(dir, { name: "Six", id: "6:1", nodes: [{ id: "6:1", type: "FRAME", children: [{ id: "6:2", type: "VECTOR", name: "Badge", asset: "assets/badge.svg" }] }], assets: [svgAsset("6:2", "badge.svg", read("badge-a.svg"))] });
  const db = pb.assets ? pb.assets.duplicates : [];
  t("[DT-18] a pair 0.002 apart in numbers is a duplicates group too", () => db.length === 1 && db[0]?.files.join(",") === "assets/badge.svg,assets/badge-16da49.svg");
  t("[DT-18] two different icons with one skeleton (0.3 apart) are not a group", () => !d.some((g) => g.files.some((f) => f.includes("ring"))));
}

// ------------------------------------------------------------------ DT-09
console.log("\nDT-09 — a raster image embedded in an SVG shell:");
{
  const dir = tmp("raster");
  // Over BIG_ASSET_BYTES (250 KB): the payload padded in-test (the fixture keeps a 1x1 PNG).
  const big = read("avatar-raster.svg").replace(/(base64,[A-Za-z0-9+/=]*?)(=*)"/, (_m, b64: string) => b64 + "A".repeat(300 * 1024) + '"');
  const p = pull(dir, {
    name: "Avatar", id: "4:1",
    nodes: [{ id: "4:1", type: "FRAME", children: [{ id: "4:2", type: "FRAME", name: "Avatar", asset: "assets/avatar.svg" }, { id: "4:3", type: "VECTOR", name: "Cross", asset: "assets/cross.svg" }] }],
    assets: [svgAsset("4:2", "avatar.svg", big), svgAsset("4:3", "cross.svg", read("cross-a.svg"))],
  });
  const line = p.log.find((l) => /avatar\.svg/.test(l) && /warn/.test(l)) ?? "";
  t("[DT-09] the pull warns that the file is a raster image embedded in an SVG shell", () => /avatar\.svg 0\.\d\d MB is a raster image embedded in an SVG shell — use it as an image/.test(line));
  t("[DT-09] …not the \"thousands of vector paths\" wording", () => !p.log.some((l) => /thousands of vector paths/.test(l)));
  t("[DT-09] the heavy row says embeddedRaster: 1", () => p.assets?.heavy.find((h) => h.file === "assets/avatar.svg")?.embeddedRaster === 1);
  t("[DT-09] the files row says embeddedRaster: 1", () => row(p, "assets/avatar.svg")?.embeddedRaster === 1);
  t("[DT-09] an SVG with no <image> has no embeddedRaster (the default)", () => { const r = row(p, "assets/cross.svg"); return !!r && r.embeddedRaster === undefined; });
}

// ------------------------------------------------------------------ DT-54
console.log("\nDT-54 — .assets.json names each file's owner:");
{
  const dir = tmp("owner");
  const p = pull(dir, {
    name: "Form", id: "5:1",
    nodes: [{ id: "5:1", type: "FRAME", children: [
      { id: "5:2", type: "INSTANCE", name: "Checkbox", mainComponent: { name: "Status=Checked", id: "30:1", key: "kc", setName: "Checkbox", variant: "Status=Checked" },
        children: [{ id: "I5:2;30:7", type: "VECTOR", name: "Icon", asset: "assets/Icon.svg" }] },
      { id: "5:3", type: "INSTANCE", name: "Row", mainComponent: { name: "Row", id: "31:1" },
        children: [{ id: "I5:3;31:4", type: "INSTANCE", name: "Glyph", mainComponent: { name: "Property 33", id: "32:1", setName: "Glyphs", variant: "Property 1=33" }, asset: "assets/Glyph.svg" }] },
      { id: "5:4", type: "VECTOR", name: "Loose", asset: "assets/Loose.svg" },
    ] }],
    assets: [svgAsset("I5:2;30:7", "Icon.svg", read("cross-a.svg"), "Icon"), svgAsset("I5:3;31:4", "Glyph.svg", read("ring-a.svg"), "Glyph"), svgAsset("5:4", "Loose.svg", read("chevron-a.svg"), "Loose")],
  });
  const icon = row(p, "assets/Icon.svg");
  t("[DT-54] the row carries the layer name", () => icon?.name === "Icon");
  t("[DT-54] the owner is the nearest instance: component = its set, variant, ids, not self",
    () => icon?.owner?.component === "Checkbox" && icon.owner.variant === "Status=Checked" && icon.owner.componentId === "30:1" && icon.owner.componentKey === "kc" && icon.owner.instance === "5:2" && icon.owner.self === false);
  t("[DT-54] usedBy lists the node, and the defaults are absent (no context, no hiddenUses, no usedByCount, no paintOverrides)",
    () => icon?.usedBy?.join(",") === "I5:2;30:7" && icon.context === undefined && icon.hiddenUses === undefined && icon.usedByCount === undefined && icon.owner?.paintOverrides === undefined);
  t("[DT-54] the reuse key is component key | source node | non-boolean props | chain above the owner", () => icon?.reuseKey === "kc|30:7|[]|[]");
  const glyph = row(p, "assets/Glyph.svg");
  t("[DT-54] a self-owned icon instance: owner.self true, and the instance above it is the context",
    () => glyph?.owner?.self === true && glyph.owner.component === "Glyphs" && glyph.context?.component === "Row" && glyph.context.variant === undefined && glyph.reuseKey === "32:1|self|[]|[\"31:1\"]");
  const loose = row(p, "assets/Loose.svg");
  t("[DT-54] a graphic outside any instance has no owner and no reuse key, but its usedBy", () => !!loose && loose.owner === undefined && loose.reuseKey === undefined && loose.usedBy?.join(",") === "5:4");
}

// ------------------------------------------------------------------ DT-10 hidden reuse
console.log("\nDT-10 — a hidden graphic reuses a visible twin's file:");
interface Variant { hiddenMain?: { id: string; key: string }; visibleOverrides?: Array<{ id: string; fields: string[] }>; hiddenBox?: { w: number; h: number }; hiddenRotation?: number; visibleRotation?: number; hiddenLabel?: string }
function reuseCase(tag: string, v: Variant = {}): { p: Pull; hidden: IrNode | undefined } {
  const dir = tmp("reuse-" + tag);
  const main = { name: "Button", id: "20:1", key: "kb" };
  const hm = v.hiddenMain ? { name: "Button", ...v.hiddenMain } : main;
  const visGlyph: NodeInput = { id: "I1:2;20:5", type: "VECTOR", name: "Glyph", box: { w: 16, h: 16 }, asset: "assets/glyph.svg" };
  if (v.visibleRotation !== undefined) visGlyph.sourceTransform = { rotation: v.visibleRotation };
  const hidGlyph: NodeInput = { id: "I1:3;20:5", type: "VECTOR", name: "Glyph", hidden: true, box: v.hiddenBox ?? { w: 16, h: 16 }, assetSkipped: "hidden" };
  if (v.hiddenRotation !== undefined) hidGlyph.rotation = v.hiddenRotation;
  const visible: NodeInput = { id: "1:2", type: "INSTANCE", name: "Button", mainComponent: main, props: { Label: "Go", "Show icon": true }, children: [visGlyph] };
  if (v.visibleOverrides) visible.overrides = v.visibleOverrides;
  const p = pull(dir, {
    name: "Bar", id: "1:1", manifest: { assetsHidden: 1 },
    nodes: [{ id: "1:1", type: "FRAME", children: [
      visible,
      // Booleans differ (the toggle that hid the glyph) — they are not part of the key.
      { id: "1:3", type: "INSTANCE", name: "Button", mainComponent: hm, props: { Label: v.hiddenLabel ?? "Go", "Show icon": false }, children: [hidGlyph] },
    ] }],
    assets: [svgAsset("I1:2;20:5", "glyph.svg", read("cross-a.svg"), "Glyph")],
  });
  return { p, hidden: findNode(p.screen.nodes, "I1:3;20:5") };
}
{
  const { p, hidden } = reuseCase("base");
  t("[DT-10 reuse] the hidden glyph points at the visible twin's file (boolean props differ: still reused)", () => hidden?.asset === "assets/glyph.svg" && hidden.assetFrom === "I1:2;20:5");
  t("[DT-10 reuse] …keeps hidden:true and loses assetSkipped", () => hidden?.hidden === true && hidden.assetSkipped === undefined);
  t("[DT-10 reuse] the pull says how many hidden graphics were not exported and how many reuse a twin",
    () => p.log.some((l) => l === 'info  1 hidden graphic(s) not exported (`assetSkipped:"hidden"`); 1 reuse a visible twin\'s file'));
  t("[DT-10 reuse] the row lists both uses and counts the hidden one", () => { const r = row(p, "assets/glyph.svg"); return r?.usedBy?.join(",") === "I1:2;20:5,I1:3;20:5" && r.hiddenUses === 1; });
  t("[DT-10 reuse] no dangling pointer", () => !p.log.some((l) => /not on disk/.test(l)));
}
{
  // An older export (or a node already reused) can carry `asset` while hidden: never a twin itself.
  const dir = tmp("reuse-hiddentwin");
  const btn = (id: string, glyph: NodeInput): NodeInput => ({ id, type: "INSTANCE", name: "Button", hidden: true, mainComponent: { name: "Button", id: "20:1", key: "kb" }, children: [glyph] });
  const p = pull(dir, {
    name: "Old", id: "1:1", manifest: { assetsHidden: 1 },
    nodes: [{ id: "1:1", type: "FRAME", children: [
      btn("1:2", { id: "I1:2;20:5", type: "VECTOR", name: "Glyph", box: { w: 16, h: 16 }, asset: "assets/glyph.svg" }),
      btn("1:3", { id: "I1:3;20:5", type: "VECTOR", name: "Glyph", box: { w: 16, h: 16 }, assetSkipped: "hidden" }),
    ] }],
    assets: [svgAsset("I1:2;20:5", "glyph.svg", read("cross-a.svg"), "Glyph")],
  });
  const h = findNode(p.screen.nodes, "I1:3;20:5");
  t("[DT-10 reuse] a HIDDEN node with an asset is not a twin", () => !!h && h.assetSkipped === "hidden" && h.asset === undefined);
}
const notReused = (h: IrNode | undefined): boolean => !!h && h.assetSkipped === "hidden" && h.asset === undefined && h.assetFrom === undefined;
t("[DT-10 reuse] a different main component (variant) is not reused", () => notReused(reuseCase("main", { hiddenMain: { id: "20:2", key: "kb2" } }).hidden));
t("[DT-10 reuse] a different non-boolean prop (TEXT) is not reused", () => notReused(reuseCase("prop", { hiddenLabel: "Stop" }).hidden));
t("[DT-10 reuse] a fills override on the visible owner blocks reuse", () => notReused(reuseCase("fills", { visibleOverrides: [{ id: "I1:2;20:5", fields: ["fills"] }] }).hidden));
t("[DT-10 reuse] a non-paint override (characters) does not", () => reuseCase("chars", { visibleOverrides: [{ id: "I1:2;20:9", fields: ["characters"] }] }).hidden?.assetFrom === "I1:2;20:5");
t("[DT-10 reuse] a box 1 px different is not reused", () => notReused(reuseCase("box", { hiddenBox: { w: 17, h: 16 } }).hidden));
t("[DT-10 reuse] a box 0.4 px different is", () => reuseCase("box04", { hiddenBox: { w: 16.4, h: 16 } }).hidden?.assetFrom === "I1:2;20:5");
t("[DT-10 reuse] a different rotation is not reused", () => notReused(reuseCase("rot", { hiddenRotation: 90 }).hidden));
{
  const h = reuseCase("rot-same", { hiddenRotation: 90, visibleRotation: 90 }).hidden;
  t("[DT-10 reuse] the same rotation (bare on the hidden, sourceTransform on the visible) is reused, and moves under sourceTransform (D66)",
    () => h?.assetFrom === "I1:2;20:5" && h.sourceTransform?.rotation === 90 && h.rotation === undefined);
}
{
  const h = reuseCase("base-tf").hidden;
  t("[DT-10 reuse] with no transform, no sourceTransform is added (the default)", () => !!h && h.sourceTransform === undefined && h.rotation === undefined);
}

console.log("\nDT-10 — hidden reuse across screens:");
{
  const visible = (): NodeInput[] => [{ id: "7:1", type: "FRAME", children: [
    { id: "7:2", type: "INSTANCE", name: "Tab", mainComponent: { name: "Tab", id: "40:1", key: "kt" }, props: { Text: "Home" },
      children: [{ id: "I7:2;40:3", type: "VECTOR", name: "Icon", box: { w: 20, h: 20 }, asset: "assets/tab-icon.svg" }] },
  ] }];
  const hidden = (): NodeInput[] => [{ id: "8:1", type: "FRAME", children: [
    { id: "8:2", type: "INSTANCE", name: "Tab", hidden: true, mainComponent: { name: "Tab", id: "40:1", key: "kt" }, props: { Text: "Home" },
      children: [{ id: "I8:2;40:3", type: "VECTOR", name: "Icon", box: { w: 20, h: 20 }, assetSkipped: "hidden" }] },
  ] }];
  const tabAsset = (): Asset[] => [svgAsset("I7:2;40:3", "tab-icon.svg", read("badge-a.svg"), "Icon")];
  const d1 = tmp("cross-1");
  pull(d1, { name: "Home", id: "7:1", nodes: visible(), assets: tabAsset() });
  const p2 = pull(d1, { name: "Settings", id: "8:1", nodes: hidden(), assets: [], manifest: { assetsHidden: 1 } });
  const h = findNode(p2.screen.nodes, "I8:2;40:3");
  t("[DT-10 reuse cross-screen] a screen pulled after the visible one reuses its file", () => h?.asset === "assets/tab-icon.svg" && h.assetFrom === "I7:2;40:3" && h.assetSkipped === undefined);
  t("[DT-10 reuse cross-screen] …and the line says it came from another screen", () => p2.log.some((l) => /1 reuse a visible twin's file \(1 from another screen\)/.test(l)));
  const d2 = tmp("cross-2");
  const q = pull(d2, { name: "Settings", id: "8:1", nodes: hidden(), assets: [], manifest: { assetsHidden: 1 } });
  pull(d2, { name: "Home", id: "7:1", nodes: visible(), assets: tabAsset() });
  t("[DT-10 reuse cross-screen] pulled BEFORE the visible screen, the hidden glyph stays assetSkipped:\"hidden\"", () => notReused(findNode(q.screen.nodes, "I8:2;40:3")));
  t("[DT-10 reuse cross-screen] …and its line says 0 reuse", () => q.log.some((l) => /1 hidden graphic\(s\) not exported .*; 0 reuse a visible twin's file$/.test(l)));
}

// ------------------------------------------------------------------ fix 1 (review 1): the reuse key's context, outer overrides
console.log("\nDT-10 fix 1 — the parent variant (the chain above the owner) and outer-instance overrides keep a twin apart:");
// A Button (top-level INSTANCE, one main component per variant) holds an Icon instance (the owner) holding a
// VECTOR. The visible Button is Type=Primary; the hidden one varies. Ids follow Figma's sublayer scheme:
// `I<top>;<icon slot in the Button's definition>;<vector in the Icon's definition>`.
interface Nest { variant?: { id: string; key: string; name: string }; slot?: string; visibleOverrides?: Array<{ id: string; fields: string[] }>; hiddenOverrides?: Array<{ id: string; fields: string[] }>; top?: { id: string; key: string } }
function nestCase(tag: string, v: Nest = {}): { p: Pull; hidden: IrNode | undefined } {
  const dir = tmp("nest-" + tag);
  const top = v.top ?? { id: "20:1", key: "kp" };
  const primary = { name: "Type=Primary", ...top, setName: "Button", variant: "Type=Primary" };
  const hv = v.variant ? { name: v.variant.name, id: v.variant.id, key: v.variant.key, setName: "Button", variant: v.variant.name } : primary;
  const icon = { name: "Icon", id: "50:1", key: "ki" };
  const slot = v.slot ?? "20:9";
  const visible: NodeInput = { id: "1:2", type: "INSTANCE", name: "Button", mainComponent: primary, children: [
    { id: "I1:2;20:9", type: "INSTANCE", name: "Icon", mainComponent: icon, children: [
      { id: "I1:2;20:9;50:3", type: "VECTOR", name: "Vector", box: { w: 16, h: 16 }, asset: "assets/Vector.svg" }] }] };
  if (v.visibleOverrides) visible.overrides = v.visibleOverrides;
  const hidden: NodeInput = { id: "1:3", type: "INSTANCE", name: "Button", mainComponent: hv, children: [
    { id: "I1:3;" + slot, type: "INSTANCE", name: "Icon", hidden: true, mainComponent: icon, children: [
      { id: "I1:3;" + slot + ";50:3", type: "VECTOR", name: "Vector", box: { w: 16, h: 16 }, assetSkipped: "hidden" }] }] };
  if (v.hiddenOverrides) hidden.overrides = v.hiddenOverrides;
  const p = pull(dir, { name: "Nest", id: "1:1", manifest: { assetsHidden: 1 }, nodes: [{ id: "1:1", type: "FRAME", children: [visible, hidden] }],
    assets: [svgAsset("I1:2;20:9;50:3", "Vector.svg", read("cross-a.svg"), "Vector")] });
  return { p, hidden: findNode(p.screen.nodes, "I1:3;" + slot + ";50:3") };
}
{
  const same = nestCase("same").hidden;
  t("[M-1] the same parent variant and slot: the nested icon is reused (control)", () => same?.asset === "assets/Vector.svg" && same.assetFrom === "I1:2;20:9;50:3");
  // pre-fix: reused — the key was the Icon's key + the vector's last id segment, blind to the Button around it.
  t("[M-1] a nested icon under a DIFFERENT parent variant (Button / Type=Danger) is not reused",
    () => notReused(nestCase("variant", { variant: { id: "21:1", key: "kd", name: "Type=Danger" }, slot: "21:9" }).hidden));
  // The chain on its own: the same slot ids (as after an instance swap) under another parent component.
  t("[M-1] …nor when only the parent's main component differs (the chain in the key)",
    () => notReused(nestCase("chain", { variant: { id: "21:1", key: "kd", name: "Type=Danger" } }).hidden));
  // Where the owner sits in the parent is NOT in the key (see reuseKeyOf): another slot of the same variant reuses.
  t("[M-1] the same parent variant, the icon in another slot (a list row): reused", () => nestCase("slot", { slot: "20:10" }).hidden?.assetFrom === "I1:2;20:9;50:3");
  const k = nestCase("key").p;
  t("[M-1] the row's reuseKey carries the chain above the owner (the Button's key)", () => row(k, "assets/Vector.svg")?.reuseKey === 'ki|50:3|[]|["kp"]');
  // Two levels: the same Button variant inside two different Cards — the outer definition may recolour it too.
  t("[M-1] the same parent variant under a different OUTER component is not reused", () => {
    const dir = tmp("nest-outer-chain");
    const btn = { name: "Type=Primary", id: "20:1", key: "kp", setName: "Button", variant: "Type=Primary" };
    const icon = { name: "Icon", id: "50:1", key: "ki" };
    const card = (id: string, main: { name: string; id: string; key: string }, hidden: boolean): NodeInput => ({ id, type: "INSTANCE", name: "Card", mainComponent: main, children: [
      { id: "I" + id + ";60:2", type: "INSTANCE", name: "Button", mainComponent: btn, children: [
        { id: "I" + id + ";60:2;20:9", type: "INSTANCE", name: "Icon", mainComponent: icon, ...(hidden ? { hidden: true } : {}), children: [
          hidden ? { id: "I" + id + ";60:2;20:9;50:3", type: "VECTOR", name: "Vector", box: { w: 16, h: 16 }, assetSkipped: "hidden" }
            : { id: "I" + id + ";60:2;20:9;50:3", type: "VECTOR", name: "Vector", box: { w: 16, h: 16 }, asset: "assets/Vector.svg" }] }] }] });
    const p = pull(dir, { name: "Cards", id: "1:1", manifest: { assetsHidden: 1 }, nodes: [{ id: "1:1", type: "FRAME", children: [
      card("1:2", { name: "Card A", id: "60:1", key: "kca" }, false), card("1:3", { name: "Card B", id: "61:1", key: "kcb" }, true)] }],
      assets: [svgAsset("I1:2;60:2;20:9;50:3", "Vector.svg", read("cross-a.svg"), "Vector")] });
    return notReused(findNode(p.screen.nodes, "I1:3;60:2;20:9;50:3"));
  });
  // pre-fix: reused — only the Icon instance's own overrides were read for a VECTOR graphic.
  t("[M-2] a fills override on an OUTER instance (the Button), about the nested vector, blocks reuse",
    () => notReused(nestCase("outer", { visibleOverrides: [{ id: "I1:2;20:9;50:3", fields: ["fills"] }] }).hidden));
  t("[M-2] …and the row marks the visible use paintOverrides", () => row(nestCase("outer-row", { visibleOverrides: [{ id: "I1:2;20:9;50:3", fields: ["fills"] }] }).p, "assets/Vector.svg")?.owner?.paintOverrides === true);
  t("[M-2] an outer override on the HIDDEN side blocks it too",
    () => notReused(nestCase("outer-hidden", { hiddenOverrides: [{ id: "I1:3;20:9;50:3", fields: ["strokes"] }] }).hidden));
  // P-1: the id rule is pinned — an outer paint entry about ANOTHER node leaves this one alone.
  t("[M-2] an outer fills override about a different node (a sibling vector) does not block",
    () => nestCase("outer-other", { visibleOverrides: [{ id: "I1:2;20:9;50:8", fields: ["fills"] }] }).hidden?.assetFrom === "I1:2;20:9;50:3");
  t("[M-2] an outer override that is not paint (characters) does not block",
    () => nestCase("outer-chars", { visibleOverrides: [{ id: "I1:2;20:9;50:3", fields: ["characters"] }] }).hidden?.assetFrom === "I1:2;20:9;50:3");
}
{
  // P-1: a nested INSTANCE graphic (a self-owned icon inside a Button) — overrides on the top instance whose
  // id is the icon's own (or its sublayer's) block; one about the Button's label does not.
  const iconCase = (tag: string, overrides?: Array<{ id: string; fields: string[] }>): IrNode | undefined => {
    const dir = tmp("nestinst-" + tag);
    const main = { name: "Button", id: "20:1", key: "kb" };
    const glyph = { name: "Glyph", id: "50:1", key: "kg" };
    const vis: NodeInput = { id: "1:2", type: "INSTANCE", name: "Button", mainComponent: main, children: [
      { id: "I1:2;20:9", type: "INSTANCE", name: "Glyph", mainComponent: glyph, box: { w: 16, h: 16 }, asset: "assets/Glyph.svg" }] };
    if (overrides) vis.overrides = overrides;
    const p = pull(dir, { name: "NI", id: "1:1", manifest: { assetsHidden: 1 }, nodes: [{ id: "1:1", type: "FRAME", children: [vis,
      { id: "1:3", type: "INSTANCE", name: "Button", mainComponent: main, children: [
        { id: "I1:3;20:9", type: "INSTANCE", name: "Glyph", hidden: true, mainComponent: glyph, box: { w: 16, h: 16 }, assetSkipped: "hidden" }] }] }],
      assets: [svgAsset("I1:2;20:9", "Glyph.svg", read("ring-a.svg"), "Glyph")] });
    return findNode(p.screen.nodes, "I1:3;20:9");
  };
  t("[P-1 nested instance] no override: the hidden self-owned icon is reused", () => iconCase("none")?.assetFrom === "I1:2;20:9");
  t("[P-1 nested instance] a fills override on the top instance with the icon's own id blocks", () => notReused(iconCase("own", [{ id: "I1:2;20:9", fields: ["fills"] }])));
  t("[P-1 nested instance] …so does one on the icon's sublayer (`<id>;…`)", () => notReused(iconCase("sub", [{ id: "I1:2;20:9;50:2", fields: ["opacity"] }])));
  t("[P-1 nested instance] one about another node (the label) does not", () => iconCase("label", [{ id: "I1:2;20:4", fields: ["fills"] }])?.assetFrom === "I1:2;20:9");
}
{
  // M-3: the cross-screen file is listed in the REUSING screen's .assets.json.
  const d = tmp("cross-index");
  pull(d, { name: "Home", id: "7:1", nodes: [{ id: "7:1", type: "FRAME", children: [
    { id: "7:2", type: "INSTANCE", name: "Tab", mainComponent: { name: "Tab", id: "40:1", key: "kt" }, children: [
      { id: "I7:2;40:3", type: "VECTOR", name: "Icon", box: { w: 20, h: 20 }, asset: "assets/tab-icon.svg" }] }] }],
    assets: [svgAsset("I7:2;40:3", "tab-icon.svg", read("badge-a.svg"), "Icon")] });
  const p = pull(d, { name: "Settings", id: "8:1", manifest: { assetsHidden: 1 }, nodes: [{ id: "8:1", type: "FRAME", children: [
    { id: "8:2", type: "INSTANCE", name: "Tab", hidden: true, mainComponent: { name: "Tab", id: "40:1", key: "kt" }, children: [
      { id: "I8:2;40:3", type: "VECTOR", name: "Icon", box: { w: 20, h: 20 }, assetSkipped: "hidden" }] }] }],
    assets: [] });
  const r = row(p, "assets/tab-icon.svg");
  const size = fs.statSync(path.join(d, "assets", "tab-icon.svg")).size;
  // pre-fix: no .assets.json at all for a pull with no assets of its own (and no row when it had some).
  t("[M-3] the reusing screen's .assets.json lists the other screen's file", () => !!r && r.node === "I8:2;40:3" && r.bytes === size && typeof r.hash === "string" && r.hash.length === 40);
  t("[M-3] …with reusedFrom = the twin's node id, hiddenUses 1, the hidden use in usedBy, no reuseKey", () => r?.reusedFrom === "I7:2;40:3" && r.hiddenUses === 1 && r.usedBy?.join(",") === "I8:2;40:3" && r.reuseKey === undefined);
  t("[M-3] …its owner and layer name, and it is counted", () => r?.owner?.component === "Tab" && r.name === "Icon" && readJson<{ count: number }>(path.join(d, "pages", "Page", "Settings__8_1.assets.json")).count === 1);
  t("[M-3] …and the screen's index row points at that .assets.json", () => readJson<{ layers: Array<{ id: string; assets?: string }> }>(path.join(d, "pages", "Page", "index.json")).layers.find((l) => l.id === "8:1")?.assets === "pages/Page/Settings__8_1.assets.json");
  const home = readJson<AssetsDoc>(path.join(d, "pages", "Page", "Home__7_1.assets.json"));
  t("[M-3] a file this pull wrote has no reusedFrom (the default)", () => home.files.length === 1 && home.files[0]?.reusedFrom === undefined);
}
{
  // L-3: a twin pointer whose exact name is not on disk (only a different-case file is — another icon).
  const d = tmp("case");
  fs.mkdirSync(path.join(d, "assets"), { recursive: true });
  fs.writeFileSync(path.join(d, "assets", "angle-left.svg"), read("chevron-a.svg"));
  const main = { name: "Pager", id: "70:1", key: "kpg" };
  const p = pull(d, { name: "Case", id: "1:1", manifest: { assetsHidden: 1 }, nodes: [{ id: "1:1", type: "FRAME", children: [
    { id: "1:2", type: "INSTANCE", name: "Pager", mainComponent: main, children: [{ id: "I1:2;70:2", type: "VECTOR", name: "Angle", box: { w: 8, h: 8 }, asset: "assets/Angle-left.svg" }] },
    { id: "1:3", type: "INSTANCE", name: "Pager", mainComponent: main, children: [{ id: "I1:3;70:2", type: "VECTOR", name: "Angle", hidden: true, box: { w: 8, h: 8 }, assetSkipped: "hidden" }] },
  ] }], assets: [svgAsset("9:9", "other.svg", read("cross-a.svg"), "Other")] });
  // pre-fix (case-insensitive disk): reused — fs.existsSync found angle-left.svg for Angle-left.svg.
  t("[L-3] a twin whose pointer names a file only a different-case name matches is not reused", () => notReused(findNode(p.screen.nodes, "I1:3;70:2")));
}
{
  // L-4: another screen's JSON on disk is malformed (`children: {}`) — this pull still completes.
  const d = tmp("malformed");
  const tab = (id: string, kid: NodeInput): NodeInput => ({ id, type: "INSTANCE", name: "Tab", mainComponent: { name: "Tab", id: "40:1", key: "kt" }, children: [kid] });
  pull(d, { name: "Home", id: "7:1", nodes: [{ id: "7:1", type: "FRAME", children: [tab("7:2", { id: "I7:2;40:3", type: "VECTOR", name: "Icon", box: { w: 20, h: 20 }, asset: "assets/tab-icon.svg" })] }],
    assets: [svgAsset("I7:2;40:3", "tab-icon.svg", read("badge-a.svg"), "Icon")] });
  const homeJson = path.join(d, "pages", "Page", "Home__7_1.json");
  const broken = readJson<{ nodes: Array<Record<string, unknown>> }>(homeJson);
  if (broken.nodes[0]) broken.nodes[0].children = {};
  fs.writeFileSync(homeJson, JSON.stringify(broken));
  const p = pull(d, { name: "Settings", id: "8:1", manifest: { assetsHidden: 1 }, nodes: [{ id: "8:1", type: "FRAME", children: [
    { ...tab("8:2", { id: "I8:2;40:3", type: "VECTOR", name: "Icon", box: { w: 20, h: 20 }, assetSkipped: "hidden" }), hidden: true }] }], assets: [] });
  // pre-fix: THREW "… is not iterable" after the assets were written, and the screen JSON was never written.
  t("[L-4] a malformed other screen does not make the pull throw", () => !p.log.some((l) => l.startsWith("THREW")));
  t("[L-4] …the screen JSON is written, its hidden glyph left assetSkipped:\"hidden\"", () => notReused(findNode(p.screen.nodes, "I8:2;40:3")));
}
{
  // L-6 (D67): the hidden-node line.
  const dir = tmp("hidden-nodes");
  const p = pull(dir, { name: "HN", id: "1:1", manifest: { hiddenNodes: 3 }, nodes: [{ id: "1:1", type: "FRAME", children: [] }], assets: [] });
  // pre-fix: no such line (hiddenNodes was read nowhere in the bridge).
  // R2-6: the counter is every node hidden itself OR under a hidden ancestor — most carry no `hidden:true`.
  t("[L-6/R2-6] the pull says how many hidden nodes the tree keeps (themselves or under a hidden ancestor)",
    () => p.log.includes("info  3 node(s) hidden (themselves or under a hidden ancestor) kept in the tree (conditional UI)") && !p.log.some((l) => /kept as `hidden:true`/.test(l)));
  const q = pull(tmp("hidden-nodes-0"), { name: "HN0", id: "1:1", nodes: [{ id: "1:1", type: "FRAME", children: [] }], assets: [] });
  t("[L-6] no hiddenNodes counter (an older export), no line (the default)", () => !q.log.some((l) => /node\(s\) hidden|hidden node\(s\) kept/.test(l)));
}

// ------------------------------------------------------------------ fix 2 (review 2)
console.log("\nDT-10 fix 2 — variable modes, a self-owned icon's booleans, sublayer overrides, stale and foreign twins:");
// A Bell icon (self-owned INSTANCE graphic) inside a Button; the visible copy first, the hidden one after.
const bell = { name: "Bell", id: "50:1", key: "kbell" };
const bellBtn = { name: "Type=Primary", id: "20:1", key: "kbtn", setName: "Button", variant: "Type=Primary" };
const bellIn = (id: string, hidden: boolean, extra: Partial<NodeInput> = {}, btnExtra: Partial<NodeInput> = {}): NodeInput => ({
  id, type: "INSTANCE", name: "Button", mainComponent: bellBtn, ...btnExtra, children: [hidden
    ? { id: "I" + id + ";20:9", type: "INSTANCE", name: "Bell", mainComponent: bell, hidden: true, box: { w: 16, h: 16 }, assetSkipped: "hidden", ...extra }
    : { id: "I" + id + ";20:9", type: "INSTANCE", name: "Bell", mainComponent: bell, box: { w: 16, h: 16 }, asset: "assets/Bell.svg", ...extra }] });
const bellAsset = (id: string): Asset[] => [svgAsset("I" + id + ";20:9", "Bell.svg", read("ring-a.svg"), "Bell")];
const bellPull = (tag: string, roots: NodeInput[]): Pull => pull(tmp("r2-" + tag), { name: "Modes", id: "1:1", manifest: { assetsHidden: 1 }, nodes: roots, assets: bellAsset("1:2") });
const hiddenBell = (p: Pull): IrNode | undefined => findNode(p.screen.nodes, "I1:3;20:9");
{
  // R2-1: the effective variable modes are in the key — a bound colour renders per mode.
  // pre-fix: reused (the key had no mode in it).
  t("[R2-1] a hidden icon in a frame pinned Theme=Dark does not reuse the Light frame's file", () => notReused(hiddenBell(bellPull("dark", [{ id: "1:1", type: "FRAME", children: [
    { id: "1:10", type: "FRAME", name: "Light", children: [bellIn("1:2", false)] },
    { id: "1:11", type: "FRAME", name: "Dark", variableModes: { Theme: "Dark" }, children: [bellIn("1:3", true)] }] }]))));
  t("[R2-1] …both frames pinned Theme=Light: reused (control)", () => hiddenBell(bellPull("light2", [{ id: "1:1", type: "FRAME", children: [
    { id: "1:10", type: "FRAME", name: "A", variableModes: { Theme: "Light" }, children: [bellIn("1:2", false)] },
    { id: "1:11", type: "FRAME", name: "B", variableModes: { Theme: "Light" }, children: [bellIn("1:3", true)] }] }]))?.assetFrom === "I1:2;20:9");
  t("[R2-1] a pin on the root's resolvedModes overridden lower down counts the lower one (Dark under a Light root: not reused)", () => notReused(hiddenBell(bellPull("override", [{ id: "1:1", type: "FRAME", resolvedModes: { Theme: "Light" }, children: [
    bellIn("1:2", false), bellIn("1:3", true, {}, { variableModes: { Theme: "Dark" } })] }]))));
  const k = bellPull("key", [{ id: "1:1", type: "FRAME", resolvedModes: { Theme: "Light", Brand: "A" }, children: [bellIn("1:2", false), bellIn("1:3", true)] }]);
  t("[R2-1] the row's reuseKey ends in the sorted [collection, mode] list", () => row(k, "assets/Bell.svg")?.reuseKey === 'kbell|self|[]|["kbtn"]|[["Brand","A"],["Theme","Light"]]');
  t("[R2-1] …and the same modes reuse", () => hiddenBell(k)?.assetFrom === "I1:2;20:9");
  // Across screens: the other screen's root resolves Theme=Light, this one Theme=Dark.
  const d = tmp("r2-cross-modes");
  pull(d, { name: "Light", id: "7:1", nodes: [{ id: "7:1", type: "FRAME", resolvedModes: { Theme: "Light" }, children: [bellIn("7:2", false)] }], assets: bellAsset("7:2") });
  const dark = pull(d, { name: "Dark", id: "8:1", manifest: { assetsHidden: 1 }, nodes: [{ id: "8:1", type: "FRAME", resolvedModes: { Theme: "Dark" }, children: [bellIn("8:2", true)] }], assets: [] });
  t("[R2-1] a Dark screen does not reuse a Light screen's file", () => notReused(findNode(dark.screen.nodes, "I8:2;20:9")));
  const same = pull(d, { name: "LightB", id: "9:1", manifest: { assetsHidden: 1 }, nodes: [{ id: "9:1", type: "FRAME", resolvedModes: { Theme: "Light" }, children: [bellIn("9:2", true)] }], assets: [] });
  t("[R2-1] …a second Light screen does (control)", () => findNode(same.screen.nodes, "I9:2;20:9")?.assetFrom === "I7:2;20:9");
  // pre-fix: reused — explicitVariableModes was not a paint field.
  t("[R2-1] an explicitVariableModes override about the graphic blocks reuse", () => notReused(hiddenBell(bellPull("evm", [{ id: "1:1", type: "FRAME", children: [
    bellIn("1:2", false, {}, { overrides: [{ id: "I1:2;20:9", fields: ["explicitVariableModes"] }] }), bellIn("1:3", true)] }]))));
}
{
  // R2-2 (a): a SELF-owned icon's own booleans are its internal toggles — in the key.
  // pre-fix: reused (every boolean was dropped).
  t("[R2-2] a self-owned icon with Show badge true vs false is not reused", () => notReused(hiddenBell(bellPull("badge", [{ id: "1:1", type: "FRAME", children: [
    bellIn("1:2", false, { props: { "Show badge": true } }), bellIn("1:3", true, { props: { "Show badge": false } })] }]))));
  t("[R2-2] …the same own booleans are reused, the PARENT's booleans still left out (control)", () => hiddenBell(bellPull("badge-same", [{ id: "1:1", type: "FRAME", children: [
    bellIn("1:2", false, { props: { "Show badge": true } }, { props: { "Show icon": true } }), bellIn("1:3", true, { props: { "Show badge": true } }, { props: { "Show icon": false } })] }]))?.assetFrom === "I1:2;20:9");
  // R2-2 (b): an override on a SUBLAYER inside the exported graphic changes the file.
  // pre-fix: reused — only paint fields were read.
  t("[R2-2] a visible override on a sublayer of the twin blocks reuse", () => notReused(hiddenBell(bellPull("subvis", [{ id: "1:1", type: "FRAME", children: [
    bellIn("1:2", false, {}, { overrides: [{ id: "I1:2;20:9;50:3", fields: ["visible"] }] }), bellIn("1:3", true)] }]))));
  t("[R2-2] …so does a size override on a sublayer (width)", () => notReused(hiddenBell(bellPull("subw", [{ id: "1:1", type: "FRAME", children: [
    bellIn("1:2", false, {}, { overrides: [{ id: "I1:2;20:9;50:3", fields: ["width"] }] }), bellIn("1:3", true)] }]))));
  t("[R2-2] an inert field on a sublayer (name) does not block", () => hiddenBell(bellPull("subname", [{ id: "1:1", type: "FRAME", children: [
    bellIn("1:2", false, {}, { overrides: [{ id: "I1:2;20:9;50:3", fields: ["name"] }] }), bellIn("1:3", true)] }]))?.assetFrom === "I1:2;20:9");
  t("[R2-2] the graphic's OWN visible override (what hid it) does not block", () => hiddenBell(bellPull("ownvis", [{ id: "1:1", type: "FRAME", children: [
    bellIn("1:2", false), bellIn("1:3", true, {}, { overrides: [{ id: "I1:3;20:9", fields: ["visible"] }] })] }]))?.assetFrom === "I1:2;20:9");
  // R2-2 (c): Figma's typings spell one stroke field `stokeTopWeight`.
  t("[R2-2] a stokeTopWeight override about the graphic blocks reuse", () => notReused(hiddenBell(bellPull("stoke", [{ id: "1:1", type: "FRAME", children: [
    bellIn("1:2", false, {}, { overrides: [{ id: "I1:2;20:9", fields: ["stokeTopWeight"] }] }), bellIn("1:3", true)] }]))));
  t("[R2-2] …and so does effectStyleId", () => notReused(hiddenBell(bellPull("effstyle", [{ id: "1:1", type: "FRAME", children: [
    bellIn("1:2", false, {}, { overrides: [{ id: "I1:2;20:9", fields: ["effectStyleId"] }] }), bellIn("1:3", true)] }]))));
}
{
  // R2-3 (b): the same frame renamed leaves its old JSON on disk — never a twin of itself.
  const d = tmp("r2-rename");
  pull(d, { name: "Popup", id: "3:1", nodes: [{ id: "3:1", type: "FRAME", children: [bellIn("3:2", false)] }], assets: bellAsset("3:2") });
  const p = pull(d, { name: "PopupV2", id: "3:1", manifest: { assetsHidden: 1 }, nodes: [{ id: "3:1", type: "FRAME", children: [bellIn("3:2", true)] }], assets: [] });
  // pre-fix: reused, assetFrom = its own node id in the stale Popup__3_1.json.
  t("[R2-3b] a renamed frame's hidden icon does not reuse its own old JSON's file", () => notReused(findNode(p.screen.nodes, "I3:2;20:9")));
  t("[R2-3b] …and its line says 0 reuse", () => p.log.some((l) => /1 hidden graphic\(s\) not exported .*; 0 reuse a visible twin's file$/.test(l)));
}
{
  // R2-5: a twin pointer must be `assets/<name>`.
  const base = tmp("r2-outside");
  const d = path.join(base, "export");
  pull(d, { name: "A", id: "1:1", nodes: [{ id: "1:1", type: "FRAME", children: [bellIn("1:2", false)] }], assets: bellAsset("1:2") });
  const aj = path.join(d, "pages", "Page", "A__1_1.json");
  const doc = readJson<{ nodes: NodeInput[] }>(aj);
  const kid = doc.nodes[0]?.children?.[0]?.children?.[0];
  if (kid) kid.asset = "../private.svg";
  fs.writeFileSync(aj, JSON.stringify(doc));
  fs.writeFileSync(path.join(base, "private.svg"), "<svg>not part of the export</svg>");
  const p = pull(d, { name: "B", id: "2:1", manifest: { assetsHidden: 1 }, nodes: [{ id: "2:1", type: "FRAME", children: [bellIn("2:2", true)] }], assets: [] });
  // pre-fix: the hidden node pointed at ../private.svg and B.assets.json listed that file's bytes.
  t("[R2-5] a sibling's twin pointer outside assets/ is not reused", () => !!kid && notReused(findNode(p.screen.nodes, "I2:2;20:9")));
  t("[R2-5] …and no row reads the outside file", () => !(p.assets?.files ?? []).some((f) => f.file.includes("private")));
  // The rule itself, with no pointerExists (every pointer "exists"): only `assets/<name>` qualifies.
  const viaPointer = (ptr: string): boolean => {
    const roots: IrNode[] = [{ id: "1:1", type: "FRAME", name: "F", children: [
      { id: "1:2", type: "INSTANCE", name: "Bell", mainComponent: bell, box: { w: 16, h: 16 }, asset: ptr },
      { id: "1:3", type: "INSTANCE", name: "Bell", mainComponent: bell, hidden: true, box: { w: 16, h: 16 }, assetSkipped: "hidden" }] }];
    owners.reuseHiddenAssets(roots);
    return roots[0]?.children?.[1]?.assetFrom === "1:2";
  };
  t("[R2-5] assets/Bell.svg is a twin pointer (control)", () => viaPointer("assets/Bell.svg"));
  t("[R2-5] /abs/Bell.svg, assets/sub/Bell.svg, assets/.., assets\\Bell.svg and other/Bell.svg are not",
    () => ["/abs/Bell.svg", "assets/sub/Bell.svg", "assets/..", "assets\\Bell.svg", "other/Bell.svg", "assets/../Bell.svg"].every((ptr) => !viaPointer(ptr)));
}

// ------------------------------------------------------------------ DT-10 / D63 geometry warning
console.log("\nD63 — any geometry fallback warns, naming the nodes:");
{
  const dir = tmp("geo");
  const p = pull(dir, {
    name: "Geo", id: "9:1", manifest: { nodes: 100, assetsGeometry: 2 },
    nodes: [{ id: "9:1", type: "FRAME", children: [
      { id: "9:5", type: "VECTOR", name: "Vec A", geometry: { fills: ["M0 0L1 1"], w: 4, h: 4 } },
      { id: "9:6", type: "VECTOR", name: "Vec B", geometry: { strokes: ["M0 0L2 2"], w: 4, h: 4 } },
    ] }],
    assets: [],
  });
  const line = p.log.find((l) => /fell back to raw geometry/.test(l)) ?? "";
  t("[DT-10 warn] 2 of 100 nodes (2 %) still warn", () => line.startsWith("warn  2 of 100 node(s) fell back to raw geometry"));
  t("[DT-10 warn] …the line names both, `name (id)`", () => line.endsWith(": Vec A (9:5), Vec B (9:6)"));
  t("[DT-10 warn] …with the new wording (no \"unusual paint/blend\")", () => /returned no SVG for these visible vectors/.test(line) && !/paint\/blend/.test(line));
  t("[DT-10 warn] no assetsHidden counter, no hidden line", () => !p.log.some((l) => /hidden graphic/.test(l)));
  const many = writeOut.assetsGeometryWarning({ nodes: 50, assetsGeometry: 7 }, [{ id: "1", type: "FRAME", name: "F", children: [1, 2, 3, 4, 5, 6, 7].map((i) => ({ id: "g" + i, type: "VECTOR", name: "V" + i, geometry: {} })) }]) ?? "";
  t("[DT-10 warn] at most 5 are named, then …", () => many.endsWith(": V1 (g1), V2 (g2), V3 (g3), V4 (g4), V5 (g5), …"));
}


// ------------------------------------------------------------------ group 14: F-06 keepPrev, DT-71, O-1, F-07
// Guarded: a write-out / snapshot-meta from before group 14 lacks these behaviours (or the export), and each
// check must then FAIL with ✗, never crash the suite.
console.log("\nF-06 — keepPrev keeps <screen>.json.prev when the existing file differs:");
{
  const dir = tmp("prev");
  const one = (opts: { keepPrev?: boolean } | undefined, title: string, exportedAt = "2026-10-07T00:00:00.000Z"): { prev: string | undefined; log: string[] } => {
    const log: string[] = [];
    let prev: string | undefined;
    try {
      const r = writeOut.writeScreen(dir, screenReply({
        screenName: "Prev", nodeId: "9:1", page: "Page", pageId: "0:1",
        screen: { screen: "Prev", exportedAt, nodes: [{ id: "9:1", type: "FRAME", name: "Prev", children: [{ id: "9:2", type: "TEXT", name: "T", text: title }] }], manifest: { nodes: 2 } },
      }), (m) => log.push(m), opts);
      const w: Record<string, unknown> = r.wrote;
      prev = typeof w.prev === "string" ? w.prev : undefined;
    } catch (e) { log.push("THREW " + String(e instanceof Error ? e.message : e)); }
    return { prev, log };
  };
  const file = path.join(dir, "pages", "Page", "Prev__9_1.json");
  const first = one({ keepPrev: true }, "Hello");
  t("[F06 unit] a first write keeps nothing (no file to keep)", () => first.prev === undefined && !fs.existsSync(file + ".prev"));
  const same = one({ keepPrev: true }, "Hello");
  t("[F06 unit] an identical re-write keeps nothing", () => same.prev === undefined && !fs.existsSync(file + ".prev"));
  const changed = one({ keepPrev: true }, "Changed");
  t("[F06 unit] a differing re-write keeps the old bytes as <screen>.json.prev and wrote.prev names it",
    () => changed.prev === file + ".prev" && fs.readFileSync(file + ".prev", "utf8").includes("Hello") && fs.readFileSync(file, "utf8").includes("Changed"));
  t("[F06 unit] …and logs it", () => changed.log.some((l) => /kept the previous .*Prev__9_1\.json as Prev__9_1\.json\.prev/.test(l)));
  fs.rmSync(file + ".prev", { force: true });
  const plain = one(undefined, "Again");
  t("[F06 unit] without keepPrev (an explicit pull) nothing is kept", () => plain.prev === undefined && !fs.existsSync(file + ".prev"));
  // Review 1 M-1: every plugin reply carries a fresh exportedAt, so two spills of an unchanged design differ only
  // in the stamp. The second must not replace the .prev that holds what the FIRST spill displaced.
  fs.rmSync(file + ".prev", { force: true });
  one(undefined, "Original", "2026-10-07T01:00:00.000Z");
  const spill1 = one({ keepPrev: true }, "Spilled", "2026-10-07T02:00:00.000Z");
  const spill2 = one({ keepPrev: true }, "Spilled", "2026-10-07T03:00:00.000Z");
  const prevText = ((): string => { try { return fs.readFileSync(file + ".prev", "utf8"); } catch { return ""; } })();
  t("[F06 M-1] a first spill over the user's own export keeps it as .prev", () => spill1.prev === file + ".prev");
  t("[F06 M-1] a re-spill of the same design with a different exportedAt keeps nothing new", () => spill2.prev === undefined);
  t("[F06 M-1] …and .prev still holds the user's original", () => prevText.includes("Original") && !prevText.includes("Spilled"));
  t("[F06 M-1] …and the target got the new stamp", () => fs.readFileSync(file, "utf8").includes("2026-10-07T03:00:00.000Z"));
}

console.log("\nDT-71 — a pull that grows variables.json says a generated theme is now behind:");
{
  const dir = tmp("dt71");
  const v = (key: string, name: string): Variable => ({ name, collection: "Color", key, type: "COLOR", tier: "primitive", values: { Light: "#ffffff" } });
  const pullVars = (vars: Variable[]): string[] => {
    const log: string[] = [];
    try {
      writeOut.writeScreen(dir, screenReply({
        screenName: "Vars", nodeId: "9:1", page: "Page", pageId: "0:1",
        screen: { screen: "Vars", nodes: [{ id: "9:1", type: "FRAME", name: "Vars" }] },
        variables: { collections: [], variables: vars, hygiene: [] },
      }), (m) => log.push(m));
    } catch (e) { log.push("THREW " + String(e instanceof Error ? e.message : e)); }
    return log;
  };
  const first = pullVars([v("k1", "surface")]);
  t("[DT71-4] the first pull (variables.json created) says nothing is behind", () => first.length > 0 && !first.some((l) => /now behind/.test(l)));
  const grown = pullVars([v("k1", "surface"), v("k2", "accent")]);
  t("[DT71-4] a pull adding 1 variable logs \"1 new variable(s) merged … now behind\"",
    () => grown.some((l) => /^info {2}1 new variable\(s\) merged into variables\.json — a token\/theme file generated from it is now behind/.test(l)));
  const same = pullVars([v("k1", "surface"), v("k2", "accent")]);
  t("[DT71-4] a pull adding nothing does not", () => same.length > 0 && !same.some((l) => /now behind/.test(l)));
}

console.log("\nO-1 — the inline limit stays under Claude Code's 50,000-char persist threshold:");
t("[O-1] default (no MAX_MCP_OUTPUT_TOKENS) is capped at 48000", () => writeOut.inlineLimitChars({}) === 48000);
t("[O-1] a larger MAX_MCP_OUTPUT_TOKENS does not raise it past 48000", () => writeOut.inlineLimitChars({ MAX_MCP_OUTPUT_TOKENS: "100000" }) === 48000);
t("[O-1] a smaller MAX_MCP_OUTPUT_TOKENS still lowers it (5000 tokens → 16000 chars)", () => writeOut.inlineLimitChars({ MAX_MCP_OUTPUT_TOKENS: "5000" }) === 16000);

console.log("\nF-07 — lastScreenExport reads the newest row of pages/index.json:");
{
  const fn: unknown = (snapshotMeta as Record<string, unknown>)["lastScreenExport"];
  const last = (dir: string, now?: number): unknown => (typeof fn === "function" ? (fn as (d: string, n?: number) => unknown)(dir, now) : "missing");
  const dir = tmp("last");
  fs.mkdirSync(path.join(dir, "pages"), { recursive: true });
  const idx = (doc: unknown) => fs.writeFileSync(path.join(dir, "pages", "index.json"), typeof doc === "string" ? doc : JSON.stringify(doc));
  idx({ pageDirs: [], layers: [
    { name: "Old", id: "1:1", file: "pages/P/Old__1_1.json", exportedAt: "2026-10-01T00:00:00.000Z" },
    { name: "New", id: "2:2", file: "pages/P/New__2_2.json", exportedAt: "2026-10-05T00:00:00.000Z", sourceFile: "Sample App" },
    { name: "Mid", id: "3:3", file: "pages/P/Mid__3_3.json", exportedAt: "2026-10-03T00:00:00.000Z" },
  ] });
  const now = Date.parse("2026-10-05T00:00:10.000Z");
  const got = last(dir, now);
  const rec = (x: unknown): Record<string, unknown> => (x && typeof x === "object" ? { ...x } : {});
  t("[F07 unit] the newest row by exportedAt wins (not the last one)", () => rec(got).id === "2:2" && rec(got).name === "New" && rec(got).file === "pages/P/New__2_2.json");
  t("[F07 unit] …with its age and sourceFile", () => rec(got).ageMs === 10000 && rec(got).sourceFile === "Sample App");
  idx({ exportedAt: "2026-10-06T00:00:00.000Z", pageDirs: [], layers: [{ name: "Walked", id: "4:4", file: "pages/P/Walked__4_4.json" }] });
  t("[F07 unit] a page-walk row without its own stamp uses the index's exportedAt", () => rec(last(dir)).id === "4:4" && rec(last(dir)).exportedAt === "2026-10-06T00:00:00.000Z");
  idx("{ not json");
  t("[F07 unit] a garbled index → null", () => last(dir) === null);
  fs.rmSync(path.join(dir, "pages", "index.json"));
  t("[F07 unit] no index → null", () => last(dir) === null);
}

report();
