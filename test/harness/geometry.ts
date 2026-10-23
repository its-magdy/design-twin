// Geometry the serializer emits: box.x/y under auto-layout, widthMode/heightMode, numberOfFixedChildren,
// the designer's exportSettings, and skew from a sheared relativeTransform.
import { ok } from "../assert.ts";
import { must } from "../fixtures.ts";
import type { FakeNode } from "../fake-figma.ts";
import type { Case } from "./helpers.ts";
import { world } from "./scene.ts";

// The frame the numberOfFixedChildren section serializes at the 0 default; the exportSettings section's last
// check reads it too.
const plainFrameNode = (): FakeNode => ({ type: "FRAME", name: "Plain", visible: true, id: "fx:2",
  width: 10, height: 10, layoutMode: "NONE", numberOfFixedChildren: 0, children: [] });

export const cases: Case[] = [{
  // ---- box.x/y is page-space and must not survive inside an auto-layout parent ----
  name: "box.x/y is page-space and must not survive inside an auto-layout parent",
  async run() {
    const { api } = world();
    const boxed = (id: string, extra?: FakeNode): FakeNode => Object.assign({ type: "FRAME", name: "Row" + id, visible: true, id: "bx:" + id,
      width: 100, height: 20, layoutMode: "NONE", children: [],
      absoluteBoundingBox: { x: 40, y: 80, width: 100, height: 20 } }, extra || {});
    const flowKid = boxed("flow");
    const absKid = boxed("abs", { layoutPositioning: "ABSOLUTE" });
    const autoParent = { type: "FRAME", name: "Stack", visible: true, id: "bx:p", width: 100, height: 100,
      layoutMode: "VERTICAL", itemSpacing: 0, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
      absoluteBoundingBox: { x: 5, y: 6, width: 100, height: 100 }, children: [flowKid, absKid] };
    const stack = await api.serialize(autoParent, 0, false);
    const stackChildren = must(stack.children, "stack.children");
    const flowOut = must(stackChildren[0], "stack.children[0]");
    const absOut = must(stackChildren[1], "stack.children[1]");
    ok("a flow child of an auto-layout parent keeps w/h", flowOut.box?.w === 100 && flowOut.box?.h === 20);
    ok("but drops box.x/y — the container decides placement", flowOut.box !== undefined && flowOut.box.x === undefined && flowOut.box.y === undefined);
    // The exceptions have to survive, or absolutely-positioned overlays lose their only placement data.
    ok("an ABSOLUTE child keeps box.x/y", absOut.box?.x === 40 && absOut.box?.y === 80);
    const looseParent = { type: "FRAME", name: "Canvas", visible: true, id: "bx:l", width: 100, height: 100,
      layoutMode: "NONE", children: [boxed("loose")] };
    const loose = await api.serialize(looseParent, 0, false);
    const looseBox = must(must(loose.children, "loose.children")[0], "loose.children[0]").box;
    ok("a child of a NON-auto-layout parent keeps box.x/y", looseBox?.x === 40 && looseBox?.y === 80);
    // The export ROOT has no parent in the doc, so its own page-space origin is the only anchor there is.
    ok("an export ROOT keeps its own box.x/y", stack.box?.x === 5 && stack.box?.y === 6);
  },
}, {
  // ---- widthMode/heightMode: emit only the non-default values ----
  name: "widthMode/heightMode: emit only the non-default values",
  async run() {
    const { api } = world();
    const sizing = (h: string, v: string): FakeNode => ({ type: "FRAME", name: "S", visible: true, id: "sz:1", width: 10, height: 10,
      layoutMode: "NONE", layoutSizingHorizontal: h, layoutSizingVertical: v, children: [] });
    const fixedBoth = await api.serialize(sizing("FIXED", "FIXED"), 0, false);
    ok("the FIXED default emits neither key", fixedBoth.widthMode === undefined && fixedBoth.heightMode === undefined);
    const sizedFill = await api.serialize(sizing("FILL", "HUG"), 0, false);
    ok("FILL/HUG (the values that change the CSS) still emit", sizedFill.widthMode === "fill" && sizedFill.heightMode === "hug");
  },
}, {
  // ---- numberOfFixedChildren: sticky headers/footers/FABs ----
  name: "numberOfFixedChildren: sticky headers/footers/FABs",
  async run() {
    const { api } = world();
    const stickyFrame = { type: "FRAME", name: "Screen", visible: true, id: "fx:1", width: 375, height: 800,
      layoutMode: "NONE", overflowDirection: "VERTICAL", numberOfFixedChildren: 2, children: [] };
    const sticky = await api.serialize(stickyFrame, 0, false);
    ok("numberOfFixedChildren -> fixedChildren", sticky.fixedChildren === 2);
    const plainFrame = await api.serialize(plainFrameNode(), 0, false);
    ok("and is omitted at the 0 default (it is on every frame)", plainFrame.fixedChildren === undefined);
  },
}, {
  // ---- exportSettings: the designer's own asset intent ----
  name: "exportSettings: the designer's own asset intent",
  async run() {
    const { api } = world();
    const exportNode = await api.serialize({ type: "FRAME", name: "Logo", visible: true, id: "ex:1",
      width: 40, height: 40, layoutMode: "NONE", children: [],
      exportSettings: [
        { format: "SVG", suffix: "", constraint: { type: "SCALE", value: 1 } },
        { format: "PNG", suffix: "@3x", constraint: { type: "SCALE", value: 3 } },
      ] }, 0, false);
    ok("exportSettings captured, format lowercased", Array.isArray(exportNode.exportSettings) && exportNode.exportSettings[0]?.format === "svg");
    const es = must(exportNode.exportSettings, "exportNode.exportSettings");
    ok("the density suffix + scale survive", es[1]?.suffix === "@3x" && es[1]?.constraint?.value === 3);
    ok("the SCALE-1 default carries no intent and is omitted", must(es[0], "es[0]").constraint === undefined);
    // `plainFrame` is the numberOfFixedChildren section's frame with no presets, serialized here in this world.
    const plainFrame = await api.serialize(plainFrameNode(), 0, false);
    ok("a node with no presets emits nothing", plainFrame.exportSettings === undefined);
  },
}, {
  // ---- skew: the sheared transform the decomposition keeps ----
  name: "skew: the sheared transform the decomposition keeps",
  async run() {
    const { api } = world();
    const xf = (m: number[][]): FakeNode => ({ type: "FRAME", name: "T", visible: true, id: "sk:1", width: 10, height: 10,
      layoutMode: "NONE", relativeTransform: m, children: [] });
    const skewed = await api.serialize(xf([[1, 0.5, 0], [0, 1, 0]]), 0, false);
    ok("shear in relativeTransform -> skew (degrees, CSS skewX)", skewed.skew === 26.57);
    ok("a sheared node is not mistaken for a flip", skewed.flipped === undefined);
    // A pure rotation shears by exactly 0 — the decomposition must not manufacture a skew for it.
    const rot = Math.PI / 6;
    const rotated = await api.serialize(xf([[Math.cos(rot), -Math.sin(rot), 0], [Math.sin(rot), Math.cos(rot), 0]]), 0, false);
    ok("a pure rotation emits NO skew", rotated.skew === undefined);
    const flippedNode = await api.serialize(xf([[-1, 0, 0], [0, 1, 0]]), 0, false);
    ok("a pure flip still reads as flipped, with no skew", flippedNode.flipped === true && flippedNode.skew === undefined);
  },
}];
