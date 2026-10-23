// How a node lays out its children: auto-layout distribution and gaps, wrapping, GRID tracks and grid-child fields,
// `layout` only on containers, pinned (fixed) children. Every node here is serialized directly
// (`serialize(node, 0, false)`) in a fresh world; none of them carries getCSSAsync/plugin data/motion (the read options), so
// their output does not depend on which read options a collector left on.
import { ok } from "../assert.ts";
import { must } from "../fixtures.ts";
import type { IrNode } from "../../bridge/src/doc-types.ts";
import type { Case } from "./helpers.ts";
import { world } from "./scene.ts";
import { overlay } from "./read-misc.ts";

export const cases: Case[] = [{
  name: "primaryAxisAlignItems SPACE_EVENLY / SPACE_AROUND (Figma Update 137) -> justifyContent",
  async run() {
    const { api } = world();
    const evenlyFrame = { type: "FRAME", name: "Evenly", visible: true, id: "al:1", width: 100, height: 20,
      layoutMode: "HORIZONTAL", paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
      primaryAxisAlignItems: "SPACE_EVENLY", counterAxisAlignItems: "MIN", children: [] };
    const evenlyOut = await api.serialize(evenlyFrame, 0, false);
    ok("[SPACE_EVENLY] -> justifyContent: space-evenly", evenlyOut.layout?.justifyContent === "space-evenly");
    const aroundFrame = { type: "FRAME", name: "Around", visible: true, id: "al:2", width: 100, height: 20,
      layoutMode: "HORIZONTAL", paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
      primaryAxisAlignItems: "SPACE_AROUND", counterAxisAlignItems: "MIN", children: [] };
    const aroundOut = await api.serialize(aroundFrame, 0, false);
    ok("[SPACE_AROUND] -> justifyContent: space-around", aroundOut.layout?.justifyContent === "space-around");
    // counterAxisAlignItems maps independently of SPACE_EVENLY/SPACE_AROUND.
    const counterFrame = { type: "FRAME", name: "Counter", visible: true, id: "al:3", width: 100, height: 20,
      layoutMode: "HORIZONTAL", paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
      primaryAxisAlignItems: "MIN", counterAxisAlignItems: "CENTER", children: [] };
    const counterOut = await api.serialize(counterFrame, 0, false);
    ok("[counterAxisAlignItems] CENTER -> alignItems: center (unchanged)", counterOut.layout?.alignItems === "center");
  },
}, {
  name: "itemSpacing under an auto-gap distribution mode is slack, not a gap (both axes, both wrap directions)",
  async run() {
    const { api } = world();
    // itemSpacing under an "auto gap" distribution mode is Figma's unused slack, not a real gap:
    // https://help.figma.com/hc/en-us/articles/31289464393751 (article 31289464393751), "Guide to auto
    // layout" — Between/Evenly/Around "match CSS property values space-between, space-evenly and
    // space-around respectively", and Figma spaces children by dividing free space, not the stored
    // itemSpacing. So all three must NOT emit `gap`, while a plain CENTER frame still emits it.
    const betweenSlack = { type: "FRAME", name: "BetweenSlack", visible: true, id: "al:4", width: 100, height: 20,
      layoutMode: "HORIZONTAL", itemSpacing: 12, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
      primaryAxisAlignItems: "SPACE_BETWEEN", counterAxisAlignItems: "MIN", children: [] };
    const betweenSlackOut = await api.serialize(betweenSlack, 0, false);
    ok("[SPACE_BETWEEN] itemSpacing is slack -> no gap", betweenSlackOut.layout !== undefined && betweenSlackOut.layout.gap === undefined);
    const evenlySlack = { type: "FRAME", name: "EvenlySlack", visible: true, id: "al:5", width: 100, height: 20,
      layoutMode: "HORIZONTAL", itemSpacing: 12, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
      primaryAxisAlignItems: "SPACE_EVENLY", counterAxisAlignItems: "MIN", children: [] };
    const evenlySlackOut = await api.serialize(evenlySlack, 0, false);
    ok("[SPACE_EVENLY] itemSpacing is slack -> no gap", evenlySlackOut.layout !== undefined && evenlySlackOut.layout.gap === undefined);
    const aroundSlack = { type: "FRAME", name: "AroundSlack", visible: true, id: "al:6", width: 100, height: 20,
      layoutMode: "HORIZONTAL", itemSpacing: 12, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
      primaryAxisAlignItems: "SPACE_AROUND", counterAxisAlignItems: "MIN", children: [] };
    const aroundSlackOut = await api.serialize(aroundSlack, 0, false);
    ok("[SPACE_AROUND] itemSpacing is slack -> no gap", aroundSlackOut.layout !== undefined && aroundSlackOut.layout.gap === undefined);
    const centerGap = { type: "FRAME", name: "CenterGap", visible: true, id: "al:7", width: 100, height: 20,
      layoutMode: "HORIZONTAL", itemSpacing: 12, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
      primaryAxisAlignItems: "CENTER", counterAxisAlignItems: "MIN", children: [] };
    const centerGapOut = await api.serialize(centerGap, 0, false);
    ok("[CENTER] itemSpacing is a real gap -> gap: 12", centerGapOut.layout?.gap === 12);
    // The counter axis has the same rule (plugin-api.d.ts 1.139, `counterAxisAlignContent`:
    // "`counterAxisSpacing` is respected when `counterAxisAlignContent` is set to `\"AUTO\"`"; under
    // SPACE_BETWEEN the free space is divided between the tracks). Wrapped rows under SPACE_BETWEEN must
    // NOT emit rowGap; under AUTO the stored spacing is the real row gap.
    const wrapBetween = { type: "FRAME", name: "WrapBetween", visible: true, id: "al:8", width: 100, height: 60,
      layoutMode: "HORIZONTAL", layoutWrap: "WRAP", itemSpacing: 8, counterAxisSpacing: 16, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
      primaryAxisAlignItems: "MIN", counterAxisAlignItems: "MIN", counterAxisAlignContent: "SPACE_BETWEEN", children: [] };
    const wrapBetweenOut = await api.serialize(wrapBetween, 0, false);
    ok("[WRAP+SPACE_BETWEEN] counterAxisSpacing is slack -> no rowGap, alignContent: space-between, gap kept",
      wrapBetweenOut.layout !== undefined && wrapBetweenOut.layout.rowGap === undefined && wrapBetweenOut.layout.alignContent === "space-between" && wrapBetweenOut.layout.gap === 8);
    const wrapAuto = { type: "FRAME", name: "WrapAuto", visible: true, id: "al:9", width: 100, height: 60,
      layoutMode: "HORIZONTAL", layoutWrap: "WRAP", itemSpacing: 8, counterAxisSpacing: 16, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
      primaryAxisAlignItems: "MIN", counterAxisAlignItems: "MIN", counterAxisAlignContent: "AUTO", children: [] };
    const wrapAutoOut = await api.serialize(wrapAuto, 0, false);
    ok("[WRAP+AUTO] counterAxisSpacing is a real row gap -> rowGap: 16, no alignContent",
      wrapAutoOut.layout !== undefined && wrapAutoOut.layout.rowGap === 16 && wrapAutoOut.layout.alignContent === undefined);
    ok("[WRAP+AUTO] a wrapping row has no columnGap (its gap is the item spacing)", wrapAutoOut.layout?.columnGap === undefined && wrapAutoOut.layout?.gap === 8);
    // layoutWrap is settable on VERTICAL frames too (plugin-api.d.ts 1.141): items flow down, then onto a new
    // column, and counterAxisSpacing is the gap between those columns — CSS column-gap, since row-gap/column-gap
    // follow the axes, not flex-direction (a column's row-gap is its main-axis gap).
    const vwrapAuto = { type: "FRAME", name: "VWrapAuto", visible: true, id: "al:10", width: 100, height: 60,
      layoutMode: "VERTICAL", layoutWrap: "WRAP", itemSpacing: 8, counterAxisSpacing: 16, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
      primaryAxisAlignItems: "MIN", counterAxisAlignItems: "MIN", counterAxisAlignContent: "AUTO", children: [] };
    const vwrapAutoOut = await api.serialize(vwrapAuto, 0, false);
    ok("[VERTICAL WRAP+AUTO] counterAxisSpacing is the column gap -> columnGap: 16, no rowGap, gap: 8, flexDirection column",
      vwrapAutoOut.layout !== undefined && vwrapAutoOut.layout.columnGap === 16 && vwrapAutoOut.layout.rowGap === undefined
      && vwrapAutoOut.layout.gap === 8 && vwrapAutoOut.layout.flexDirection === "column" && vwrapAutoOut.layout.flexWrap === "wrap");
    const vwrapBetween = { ...vwrapAuto, name: "VWrapBetween", id: "al:11", counterAxisAlignContent: "SPACE_BETWEEN" };
    const vwrapBetweenOut = await api.serialize(vwrapBetween, 0, false);
    ok("[VERTICAL WRAP+SPACE_BETWEEN] counterAxisSpacing is slack -> no columnGap, no rowGap, alignContent: space-between",
      vwrapBetweenOut.layout !== undefined && vwrapBetweenOut.layout.columnGap === undefined && vwrapBetweenOut.layout.rowGap === undefined
      && vwrapBetweenOut.layout.alignContent === "space-between" && vwrapBetweenOut.layout.gap === 8);
  },
}, {
  name: "GRID fidelity: per-track sizes",
  async run() {
    const { api } = world();
    // GRID fidelity: per-track sizes + child anchor index + child cell alignment.
    const gridFrame = {
      type: "FRAME", name: "Gallery", visible: true, layoutMode: "GRID", id: "30:0",
      gridColumnCount: 2, gridRowCount: 2, gridColumnGap: 8, gridRowGap: 8,
      paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
      gridColumnSizes: [{ type: "FIXED", value: 200 }, { type: "FLEX", value: 1 }, { type: "HUG" }],
      gridRowSizes: [{ type: "FLEX", value: 1 }, { type: "FLEX", value: 1 }],
      children: [],
    };
    const gf = await api.serialize(gridFrame, 0, false);
    const gfLayout = must(gf.layout, "gf.layout");
    ok("grid track sizes (fixed px + flex fr)", gfLayout.display === "grid" && Array.isArray(gfLayout.columnSizes) && gfLayout.columnSizes[0]?.type === "fixed" && gfLayout.columnSizes[0]?.value === 200 && gfLayout.columnSizes[1]?.type === "flex");
    const gfCol2 = must(gfLayout.columnSizes?.[2], "gf.layout.columnSizes[2]");
    ok("grid HUG track (value-less) handled", gfCol2.type === "hug" && gfCol2.value === undefined);
  },
}, {
  name: "grid-child fields only on an IN-FLOW child of a GRID frame, anchors >= 0",
  async run() {
    const { api } = world();
    // Off a grid every node reads gridColumnAnchorIndex/gridRowAnchorIndex -1 (observed on all 7,882 nodes of
    // the field exports) — not a track index. A root never gets them (its parent is not exported): the
    // `absNode` root (read-misc.ts overlay()) carries span 2 / anchors 1,0 / CENTER,MAX in its fake and must emit none of it.
    const abs = await overlay();
    const gridKid = (id: string, extra: Record<string, unknown>) => ({ type: "FRAME", name: "Cell", visible: true, id, width: 10, height: 10,
      x: 3, y: 4, layoutMode: "NONE", children: [], ...extra });
    const gA = gridKid("g21g:a", { gridColumnAnchorIndex: 1, gridRowAnchorIndex: 0, gridColumnSpan: 2, gridRowSpan: 1,
      gridChildHorizontalAlign: "CENTER", gridChildVerticalAlign: "MAX" });
    const gB = gridKid("g21g:b", { gridColumnAnchorIndex: 0, gridRowAnchorIndex: 1, gridColumnSpan: 1, gridRowSpan: 1 });
    const gC = gridKid("g21g:c", { layoutPositioning: "ABSOLUTE", gridColumnAnchorIndex: 0, gridRowAnchorIndex: 0, gridColumnSpan: 2 });
    const gE = gridKid("g21g:e", { gridColumnAnchorIndex: -1, gridRowAnchorIndex: 0 }); // in flow, column anchor not a track index
    const gD = gridKid("g21g:d", { gridColumnAnchorIndex: -1, gridRowAnchorIndex: -1, gridColumnSpan: 1, gridRowSpan: 1, gridChildHorizontalAlign: "MIN",
      children: [gridKid("g21g:d1", { gridColumnAnchorIndex: -1, gridRowAnchorIndex: -1 })] });
    const g21Grid = { type: "FRAME", name: "Gallery", visible: true, id: "g21g:0", width: 100, height: 100, layoutMode: "GRID",
      gridColumnCount: 2, gridRowCount: 2, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
      gridColumnAnchorIndex: 1, gridRowAnchorIndex: 1, children: [gA, gB, gC, gE] };
    const g21Plain = { type: "FRAME", name: "Plain", visible: true, id: "g21g:p", width: 100, height: 100, layoutMode: "NONE", children: [gD] };
    const gOut = await api.serialize(g21Grid, 0, false);
    const [oA, oB, oC, oE] = must(gOut.children, "grid children");
    const pOut = await api.serialize(g21Plain, 0, false);
    const oD = must(pOut.children?.[0], "plain child");
    const gridKeys = ["gridColumnStart", "gridRowStart", "gridColumnSpan", "gridRowSpan", "gridJustifySelf", "gridAlignSelf"] as const;
    const noGrid = (n: IrNode | undefined): boolean => !!n && gridKeys.every((k) => !(k in n));
    ok("an in-flow grid child carries its span (grid column span)", oA?.gridColumnSpan === 2 && oA.gridRowSpan === undefined);
    ok("grid child anchor index (start cell) on an in-flow child of a GRID frame",
      oA?.gridColumnStart === 1 && oA.gridRowStart === 0 && oB?.gridColumnStart === 0 && oB.gridRowStart === 1);
    ok("grid child cell align (justify/align-self)", oA?.gridJustifySelf === "center" && oA.gridAlignSelf === "end");
    ok("an ABSOLUTE child of the grid is not a grid item: no anchors/span (its x/y instead)", noGrid(oC) && oC?.absolute === true && oC.x === 3);
    ok("an anchor of -1 is not a track index: dropped, the valid one kept", !!oE && !("gridColumnStart" in oE) && oE.gridRowStart === 0);
    ok("a child of a non-grid frame (anchors -1) carries no grid fields, nor does its own child", noGrid(oD) && noGrid(oD.children?.[0]));
    ok("a root carries no grid-child fields (its parent is not exported)", noGrid(gOut) && noGrid(pOut) && noGrid(abs));
  },
}, {
  name: "`layout` = how a node lays out ITS OWN children: only on nodes that can hold children",
  async run() {
    const { api } = world();
    // TEXT/shapes/vectors carried {mode:"absolute",width,height} (a copy of box.w/h) on every node.
    const leafBox = { visible: true, width: 40, height: 12, absoluteBoundingBox: { x: 0, y: 0, width: 40, height: 12 } };
    const xText = { ...leafBox, type: "TEXT", name: "Label", id: "g21x:t", characters: "Hi", fontName: { family: "Inter", style: "Regular" }, fontSize: 12,
      getStyledTextSegments: () => [] };
    const xRect = { ...leafBox, type: "RECTANGLE", name: "Bg", id: "g21x:r" };
    const xVec = { ...leafBox, type: "VECTOR", name: "Line", id: "g21x:v" };
    const xEmpty = { ...leafBox, type: "FRAME", name: "Spacer", id: "g21x:f", layoutMode: "NONE", children: [] };
    const xGroup = { ...leafBox, type: "GROUP", name: "Bits", id: "g21x:g", children: [] };
    const xHost = { type: "FRAME", name: "Host", visible: true, id: "g21x:0", width: 200, height: 100, layoutMode: "NONE",
      children: [xText, xRect, xVec, xEmpty, xGroup] };
    const xOut = await api.serialize(xHost, 0, false);
    const [oT, oR, oV, oF, oG] = must(xOut.children, "host children");
    ok("TEXT, RECTANGLE and VECTOR children carry no `layout` key",
      !!oT && !!oR && !!oV && !("layout" in oT) && !("layout" in oR) && !("layout" in oV) && oT.box?.w === 40);
    ok("a childless FRAME (layoutMode NONE) keeps {mode:\"absolute\",width,height}", JSON.stringify(oF?.layout) === '{"mode":"absolute","width":40,"height":12}');
    ok("a GROUP keeps its layout too", JSON.stringify(oG?.layout) === '{"mode":"absolute","width":40,"height":12}');
  },
}, {
  name: "a PINNED child (one of the LAST numberOfFixedChildren) always carries x/y + box.x/y",
  async run() {
    const { api } = world();
    // Figma lets only an absolute child of an auto-layout frame be fixed; this guards a pinned child that is
    // still in flow (a frame given auto layout after its children were fixed). Figma counts the LAST N over ALL
    // children, hidden ones included: with N = 2 and a hidden child among the last two, the hidden one and the
    // last are pinned and the visible one before them is not (counting only visible children would pin it).
    // (Indexing by the serialized kids instead of all children is equivalent here: serialize returns null for a
    // child only past MAX_DEPTH, which hits every sibling at once.)
    const pin = (id: string, y: number) => ({ type: "FRAME", name: "Bar", visible: true, id, x: 0, y, width: 375, height: 60,
      layoutPositioning: "AUTO", layoutMode: "NONE", absoluteBoundingBox: { x: 0, y, width: 375, height: 60 }, children: [] });
    const lScreen = { type: "FRAME", name: "Feed", visible: true, id: "g21l:0", width: 375, height: 800, layoutMode: "VERTICAL",
      itemSpacing: 0, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0, overflowDirection: "VERTICAL",
      numberOfFixedChildren: 2, children: [pin("g21l:a", 0), pin("g21l:b", 60), { ...pin("g21l:h", 680), visible: false }, pin("g21l:c", 740)] };
    const lOut = await api.serialize(lScreen, 0, false);
    const [la, lb, lh, lc] = must(lOut.children, "pinned screen children");
    ok("the pinned LAST child carries x/y and box.x/y although it is in flow", lc?.x === 0 && lc.y === 740 && lc.box?.x === 0 && lc.box.y === 740);
    ok("a HIDDEN child among the last N is pinned too (Figma counts all children)", lh?.hidden === true && lh.y === 680 && lh.box?.y === 680);
    ok("the in-flow, unpinned children carry none (the visible one just before the pinned ones included)", !!la && !!lb && la.x === undefined && la.box?.y === undefined &&
      lb.x === undefined && lb.box?.y === undefined);
    ok("fixedChildren still counts them", lOut.fixedChildren === 2);
  },
}];
