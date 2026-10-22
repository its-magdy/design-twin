// Hidden graphics, icon containers, asset-leaf layout/transform.
// A hidden graphic is not sent to
// exportAsync (it would come back with no `<svg` and land as `geometry` — for an icon CONTAINER, its
// own background square). Real shapes: `assetSkipped` a string/true, `geometry` {fills,strokes,w,h}.
import { ok } from "../assert.ts";
import { must } from "../fixtures.ts";
import type { FakeNode } from "../fake-figma.ts";
import type { Case } from "./helpers.ts";
import { world } from "./scene.ts";

const solid = [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 1 }];
const square = [{ data: "M0 0L16 0L16 16L0 16L0 0Z", windingRule: "NONZERO" }];
const png = async () => new Uint8Array([137, 80, 78, 71]); // the root's reference PNG — not a per-node asset
type SvgSpy = () => Promise<string>;

const hiddenScreen = (spySvg: SvgSpy): FakeNode => ({
  type: "FRAME", name: "Screen", visible: true, id: "g13:1", width: 400, height: 300, layoutMode: "NONE", exportAsync: png,
  children: [
    { type: "FRAME", name: "Panel", visible: false, id: "g13:2", width: 200, height: 100, layoutMode: "NONE",
      children: [
        { type: "INSTANCE", name: "icon/x", visible: true, id: "g13:3", width: 16, height: 16, findOne: () => null,
          getMainComponentAsync: async () => null, fills: solid, fillGeometry: square, exportAsync: spySvg,
          children: [{ type: "VECTOR", name: "path", visible: true, id: "g13:4", width: 16, height: 16, fills: solid, fillGeometry: square, exportAsync: spySvg }] },
      ] },
    { type: "FRAME", name: "Btn", visible: true, id: "g13:5", width: 80, height: 32, layoutMode: "NONE",
      children: [{ type: "VECTOR", name: "Glyph", visible: false, id: "g13:6", width: 12, height: 12, fills: solid, fillGeometry: square, exportAsync: spySvg }] },
  ],
});

// [layout]'s selection: an asset leaf with inferred padding, an auto-layout icon asset, a plain frame.
const layoutBar = (spySvg: SvgSpy): FakeNode => {
  const padVec = { type: "VECTOR", name: "inset-vec", visible: true, id: "g13l:1", width: 20, height: 20, fills: solid, exportAsync: spySvg,
    inferredAutoLayout: { layoutMode: "HORIZONTAL", paddingTop: 2, paddingRight: 2, paddingBottom: 2, paddingLeft: 2, itemSpacing: 0 },
    layoutAlign: "STRETCH", layoutSizingHorizontal: "FILL" };
  const flexIcon = { type: "INSTANCE", name: "icon/flex", visible: true, id: "g13l:2", width: 24, height: 24, findOne: () => null,
    getMainComponentAsync: async () => null, exportAsync: spySvg, layoutMode: "HORIZONTAL", itemSpacing: 4,
    paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0, layoutSizingHorizontal: "HUG",
    children: [{ type: "VECTOR", name: "a", visible: true, id: "g13l:3", width: 8, height: 8, fills: solid, exportAsync: spySvg }] };
  const plainFrame = { type: "FRAME", name: "Row", visible: true, id: "g13l:4", width: 100, height: 24, layoutMode: "HORIZONTAL", itemSpacing: 8,
    paddingTop: 4, paddingRight: 4, paddingBottom: 4, paddingLeft: 4, children: [] };
  return { type: "FRAME", name: "Bar", visible: true, id: "g13l:0", width: 200, height: 40, exportAsync: png,
    layoutMode: "HORIZONTAL", itemSpacing: 0, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0, children: [padVec, flexIcon, plainFrame] };
};

export const cases: Case[] = [{
  name: "[hidden] graphics under a hidden frame, or hidden themselves, are leaves never exported",
  async run() {
    let g13Exports = 0;
    const spySvg = async () => { g13Exports++; return "<svg width=\"16\" height=\"16\"><path d=\"M1 1h14\"/></svg>"; };
    const { api } = world({ selection: [hiddenScreen(spySvg)] });
    const hRun = await api.collectSelection({ css: false });
    const hRoot = must(hRun.screen.nodes[0], "hidden screen root");
    const hPanel = hRoot.children?.[0];
    const hIcon = hPanel?.children?.[0];
    const hGlyph = hRoot.children?.[1]?.children?.[0];
    // pre-change: fails — the icon came back as `geometry` (the square), assetSkipped undefined.
    ok("[hidden] an icon INSTANCE under a hidden FRAME is a leaf with assetSkipped:\"hidden\" (no geometry, no asset, no children)",
      hIcon?.assetSkipped === "hidden" && hIcon.geometry === undefined && hIcon.asset === undefined && hIcon.children === undefined);
    // pre-change: fails — the Glyph came back as `geometry`.
    ok("[hidden] a VECTOR that is itself visible:false is the same leaf, and keeps hidden:true",
      hGlyph?.assetSkipped === "hidden" && hGlyph.geometry === undefined && hGlyph.asset === undefined && hGlyph.hidden === true);
    ok("[hidden] the hidden Panel itself stays a container (only graphics become leaves)", hPanel?.hidden === true && hPanel.assetSkipped === undefined && hPanel.children?.length === 1);
    // pre-change: fails — exportAsync was called for both (2).
    ok("[hidden] exportAsync is never called for a hidden graphic", g13Exports === 0);
    const hm = hRun.screen.manifest;
    // pre-change: fails — assetsHidden absent, assetsGeometry 2.
    ok("[hidden] manifest: assetsHidden === 2, assetsGeometry === 0, assetsFailed === 0",
      hm.assetsHidden === 2 && hm.assetsGeometry === 0 && hm.assetsFailed === 0);
    // Panel (self) + icon/x (under Panel) + Glyph (self); the icon's own child is never serialized.
    ok("[hidden] manifest.hiddenNodes counts the hidden node AND what is under it (3)", hm.hiddenNodes === 3);
    ok("[hidden] no asset files are produced for hidden graphics (only the root reference)",
      hRun.assets.length === 1 && hRun.assets[0]?.kind === "reference");
  },
}, {
  name: "[noassets-wins] --no-assets keeps its own marker even for a hidden graphic",
  async run() {
    let g13Exports = 0;
    const spySvg = async () => { g13Exports++; return "<svg width=\"16\" height=\"16\"><path d=\"M1 1h14\"/></svg>"; };
    const { api } = world({ selection: [hiddenScreen(spySvg)] });
    const naRun = await api.collectSelection({ css: false, skipAssets: true });
    const naRoot = must(naRun.screen.nodes[0], "no-assets root");
    ok("[noassets-wins] skipAssets + hidden -> assetSkipped === true on both graphics",
      naRoot.children?.[0]?.children?.[0]?.assetSkipped === true && naRoot.children?.[1]?.children?.[0]?.assetSkipped === true);
    ok("[noassets-wins] counted as assetsSkipped (2), not assetsHidden (0), no export",
      naRun.screen.manifest.assetsSkipped === 2 && naRun.screen.manifest.assetsHidden === 0 && g13Exports === 0);
  },
}, {
  name: "[hidden-root] a frame pulled BY ID out of a hidden panel",
  async run() {
    // [hidden-root] a frame pulled BY ID out of a hidden panel: its ancestor chain is hidden, so
    // its graphics are too, though serialize() never sees the panel.
    let g13Exports = 0;
    const spySvg = async () => { g13Exports++; return "<svg width=\"16\" height=\"16\"><path d=\"M1 1h14\"/></svg>"; };
    const g13Page: FakeNode = { type: "PAGE", name: "Page G13", id: "g13p:0" };
    const hiddenParent: FakeNode = { type: "FRAME", name: "Drawer", visible: false, id: "g13p:1", parent: g13Page };
    const card: FakeNode = { type: "FRAME", name: "Card", visible: true, id: "g13p:2", width: 100, height: 60, layoutMode: "NONE",
      parent: hiddenParent, exportAsync: png,
      children: [{ type: "VECTOR", name: "Mark", visible: true, id: "g13p:3", width: 12, height: 12, fills: solid, fillGeometry: square, exportAsync: spySvg }] };
    const { api } = world({ nodes: { "g13p:2": card } });
    const rootRun = await api.collectNode("g13p:2", { css: false });
    const rootTree = must(rootRun.screen.nodes[0], "hidden-root tree");
    // pre-change: fails — Mark exported (asset path), spy called once.
    ok("[hidden-root] collectNode on a frame whose PARENT is hidden: its vector is assetSkipped:\"hidden\", never exported",
      rootTree.children?.[0]?.assetSkipped === "hidden" && rootTree.children[0].asset === undefined && g13Exports === 0);
    ok("[hidden-root] the root keeps no hidden flag of its own (it is not visible:false), hiddenNodes counts root + child",
      rootTree.hidden === undefined && rootRun.screen.manifest.hiddenNodes === 2 && rootRun.screen.manifest.assetsHidden === 1);
    // The same frame under a VISIBLE parent exports normally — the walk is what decides.
    hiddenParent.visible = true;
    const visRun = await api.collectNode("g13p:2", { css: false });
    ok("[hidden-root] …and under a visible parent the same vector exports (asset path, hiddenNodes 0)",
      typeof visRun.screen.nodes[0]?.children?.[0]?.asset === "string" && visRun.screen.manifest.hiddenNodes === 0 && g13Exports === 1);
    // a root hidden by an ancestor, or hidden itself, is exported WITH a warning.
    const hiddenRootNote = (w: string[]) => w.filter((m) => /^'Card' \(g13p:2\) is hidden /.test(m));
    hiddenParent.visible = false;
    const ancRun = await api.collectNode("g13p:2", { css: false });
    ok("a root under a hidden ancestor warns once: hidden under a hidden ancestor, graphics not exported, reference may be blank",
      hiddenRootNote(ancRun.screen.manifest.warnings).length === 1 && /is hidden under a hidden ancestor — its graphics are not exported \(assetSkipped:"hidden"\) and its reference image may be blank$/.test(hiddenRootNote(ancRun.screen.manifest.warnings)[0] ?? ""));
    hiddenParent.visible = true;
    card.visible = false;
    const selfRun = await api.collectNode("g13p:2", { css: false });
    ok("a root that is hidden itself warns too (\"hidden itself\"), and keeps hidden:true",
      hiddenRootNote(selfRun.screen.manifest.warnings).some((m) => /is hidden itself —/.test(m)) && selfRun.screen.nodes[0]?.hidden === true);
    card.visible = true;
    const visRun2 = await api.collectNode("g13p:2", { css: false });
    ok("a visible root under visible parents: no such warning (the default)", hiddenRootNote(visRun2.screen.manifest.warnings).length === 0);
  },
}, {
  name: "a hidden layer that paints nothing stays what it was",
  async run() {
    // a hidden layer that paints nothing (no visible paint, or no area) stays what it was
    // without the hidden-graphics handling: assetsSkippedInvisible, no marker — and a zero-area icon container still recurses.
    // neither becomes an assetSkipped:"hidden" leaf or counts toward assetsHidden (3).
    let g13Exports = 0;
    const spySvg = async () => { g13Exports++; return "<svg width=\"16\" height=\"16\"><path d=\"M1 1h14\"/></svg>"; };
    const ghost = { type: "VECTOR", name: "Ghost", visible: false, id: "g13i:1", width: 12, height: 12, fills: [{ type: "SOLID", visible: false, color: { r: 0, g: 0, b: 0 } }], strokes: [], exportAsync: spySvg };
    const flat = { type: "INSTANCE", name: "icon/flat", visible: false, id: "g13i:2", width: 0, height: 16, findOne: () => null,
      getMainComponentAsync: async () => null, exportAsync: spySvg,
      children: [{ type: "VECTOR", name: "inner", visible: true, id: "g13i:3", width: 8, height: 8, fills: solid, exportAsync: spySvg }] };
    const { api } = world({ selection: [{ type: "FRAME", name: "Inv", visible: true, id: "g13i:0", width: 50, height: 50, layoutMode: "NONE", exportAsync: png, children: [ghost, flat] }] });
    const iRun = await api.collectSelection({ css: false });
    const [iGhost, iFlat] = [iRun.screen.nodes[0]?.children?.[0], iRun.screen.nodes[0]?.children?.[1]];
    ok("a hidden VECTOR with no visible paint carries no assetSkipped (and no asset/geometry)",
      !!iGhost && iGhost.assetSkipped === undefined && iGhost.asset === undefined && iGhost.geometry === undefined && iGhost.hidden === true);
    ok("a hidden zero-area icon container still recurses: its painting child is the assetSkipped:\"hidden\" leaf",
      !!iFlat && iFlat.assetSkipped === undefined && iFlat.children?.length === 1 && iFlat.children[0]?.assetSkipped === "hidden");
    ok("counts: assetsSkippedInvisible 2, assetsHidden 1, no export",
      iRun.screen.manifest.assetsSkippedInvisible === 2 && iRun.screen.manifest.assetsHidden === 1 && g13Exports === 0);
  },
}, {
  name: "[container] a VISIBLE icon container whose export fails",
  async run() {
    // [container] a VISIBLE icon container whose export fails: its fillGeometry is the frame's own
    // background rect, which must never stand in for the icon.
    const brokenIcon = { type: "INSTANCE", name: "icon/broken", visible: true, id: "g13c:1", width: 16, height: 16, findOne: () => null,
      getMainComponentAsync: async () => null, fills: solid, fillGeometry: square, exportAsync: async () => "" };
    const { api } = world({ selection: [{ type: "FRAME", name: "Host", visible: true, id: "g13c:0", width: 50, height: 50, layoutMode: "NONE",
      exportAsync: png, children: [brokenIcon] }] });
    const cRun = await api.collectSelection({ css: false });
    const cNode = cRun.screen.nodes[0]?.children?.[0];
    // pre-change: fails — geometry {fills:["M0 0L16 0…"]}, assetsGeometry 1, assetsFailed 0.
    ok("[container] a failed icon CONTAINER gets no geometry (never its background rect)", !!cNode && cNode.geometry === undefined && cNode.asset === undefined);
    ok("[container] it is a real failure: assetsFailed === 1, assetsGeometry === 0",
      cRun.screen.manifest.assetsFailed === 1 && cRun.screen.manifest.assetsGeometry === 0);
    ok("[container] and the grouped warning names it",
      cRun.screen.manifest.warnings.some((w) => /asset export failed/.test(w) && /icon\/broken \(g13c:1\)/.test(w)));
  },
}, {
  name: "[layout] an asset leaf ships as ONE picture",
  async run() {
    // [layout] an asset leaf ships as ONE picture; its own layout (inferred padding, or a real
    // auto-layout icon's padding + gap) is an inset baked into the file.
    const spySvg = async () => "<svg width=\"16\" height=\"16\"><path d=\"M1 1h14\"/></svg>";
    const w = world({ selection: [layoutBar(spySvg)] });
    const lRun = await w.api.collectSelection({ css: false });
    const lKids = lRun.screen.nodes[0]?.children || [];
    const [lVec, lIcon, lRow] = [lKids[0], lKids[1], lKids[2]];
    // pre-change: fails — layout {display:"flex",…,padding:[2,2,2,2],inferred:true}.
    ok("[layout] a VECTOR asset leaf with inferred padding carries no `layout`; its role in the parent stays (widthMode, alignSelf)",
      typeof lVec?.asset === "string" && lVec.layout === undefined && lVec.widthMode === "fill" && lVec.alignSelf === "stretch");
    // pre-change: fails — layout {display:"flex",flexDirection:"row",gap:4}.
    ok("[layout] an auto-layout icon INSTANCE asset (gap, no padding) carries no `layout` either; widthMode kept",
      typeof lIcon?.asset === "string" && lIcon.layout === undefined && lIcon.widthMode === "hug");
    ok("[layout] a non-asset frame keeps its layout", lRow?.asset === undefined && lRow?.layout?.gap === 8 && JSON.stringify(lRow.layout.padding) === "[4,4,4,4]");
    // the [hidden] case's leaves (an icon under a hidden frame, a hidden glyph), read in this world
    w.figma.currentPage.selection = [hiddenScreen(spySvg)];
    const hRoot = must((await w.api.collectSelection({ css: false })).screen.nodes[0], "hidden screen root");
    const hIcon = hRoot.children?.[0]?.children?.[0];
    const hGlyph = hRoot.children?.[1]?.children?.[0];
    ok("[layout] an assetSkipped:\"hidden\" leaf carries no layout", hIcon?.layout === undefined && hGlyph?.layout === undefined);
  },
}, {
  name: "[transform] rotation/flip on an asset leaf move under sourceTransform",
  async run() {
    // [transform] exportAsync draws the node as it is on screen, so rotation/flip already live in
    // the file — on an asset leaf they move under sourceTransform; a geometry leaf keeps them bare.
    const spySvg = async () => "<svg width=\"16\" height=\"16\"><path d=\"M1 1h14\"/></svg>";
    const rotVec = { type: "VECTOR", name: "chevron", visible: true, id: "g13t:1", width: 18, height: 10, fills: solid, exportAsync: spySvg,
      rotation: 90, relativeTransform: [[0, 1, 0], [1, 0, 0]] };
    const rotGeo = { type: "VECTOR", name: "chevron-geo", visible: true, id: "g13t:2", width: 18, height: 10, fills: solid, fillGeometry: square,
      exportAsync: async () => { throw new Error("could not be exported"); }, rotation: 45, relativeTransform: [[0.7071, -0.7071, 0], [0.7071, 0.7071, 0]] };
    const host = () => ({ type: "FRAME", name: "Host", visible: true, id: "g13t:0", width: 50, height: 50, layoutMode: "NONE", exportAsync: png, children: [rotVec, rotGeo] });
    const w = world({ selection: [host()] });
    const tRun = await w.api.collectSelection({ css: false });
    const [tVec, tGeo] = [tRun.screen.nodes[0]?.children?.[0], tRun.screen.nodes[0]?.children?.[1]];
    // pre-change: fails — sourceTransform absent, bare rotation 90 + flipped true.
    ok("[transform] an asset leaf: sourceTransform {rotation:90, flipped:true}, no bare rotation/flipped",
      typeof tVec?.asset === "string" && JSON.stringify(tVec.sourceTransform) === '{"rotation":90,"flipped":true}' && tVec.rotation === undefined && tVec.flipped === undefined);
    ok("[transform] a geometry leaf keeps bare rotation (paths are in local space), no sourceTransform",
      !!tGeo?.geometry && tGeo.rotation === 45 && tGeo.sourceTransform === undefined);
    w.figma.currentPage.selection = [host()];
    const tNa = await w.api.collectSelection({ css: false, skipAssets: true });
    const tNaVec = tNa.screen.nodes[0]?.children?.[0];
    ok("[transform] an assetSkipped:true leaf (--no-assets) keeps bare rotation/flipped",
      tNaVec?.assetSkipped === true && tNaVec.rotation === 90 && tNaVec.flipped === true && tNaVec.sourceTransform === undefined);
    // the [layout] case's auto-layout icon (g13l:2), read in this world
    w.figma.currentPage.selection = [layoutBar(spySvg)];
    const lIcon = (await w.api.collectSelection({ css: false })).screen.nodes[0]?.children?.[1];
    ok("[transform] a node with no transform carries no sourceTransform (default absent)", lIcon?.sourceTransform === undefined);
  },
}];
