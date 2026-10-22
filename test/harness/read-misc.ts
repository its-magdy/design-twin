// The rest of the node read: a hidden overlay frame's grids/annotations/dev status/box/mask/overlay settings, TABLE
// cells, opt-in shared plugin data, parametric shapes, the image-backed container guard, and the IR → verify-screen
// --expect end to end. Directly serialized nodes (`serialize(node, 0, false)`) carry no
// getCSSAsync/plugin data/shared data/motion, so their output does not depend on which read options a collector left on.
import { ok } from "../assert.ts";
import { must } from "../fixtures.ts";
import type { IrNode } from "../../bridge/src/doc-types.ts";
import { buildExpectation } from "../../design-to-code/verify-expect.ts";
import { flatPaint, type Case } from "./helpers.ts";
import { world } from "./scene.ts";
import { selection } from "./screen-read.ts";

/** A hidden, absolutely placed overlay frame carrying most of the less common node
 *  reads (grids, annotations, dev status, mask, overlay settings, every paint and effect kind). */
export function absNode() {
  return {
    type: "FRAME", name: "Overlay", visible: false, id: "10:5",
    x: 12.4, y: 40, layoutMode: "NONE", gridColumnSpan: 2,
    gridColumnAnchorIndex: 1, gridRowAnchorIndex: 0, gridChildHorizontalAlign: "CENTER", gridChildVerticalAlign: "MAX",
    layoutGrids: [{ pattern: "COLUMNS", sectionSize: 60, gutterSize: 20, count: 12, offset: 16, alignment: "STRETCH", visible: true }],
    annotations: [{ label: "Use spacing token md", categoryId: "cat_spacing", properties: [{ type: "width" }] }],
    devStatus: { type: "READY_FOR_DEV", description: "blocked on API" },
    absoluteBoundingBox: { x: 12, y: 40, width: 100, height: 50 },
    absoluteRenderBounds: { x: 10, y: 38, width: 104, height: 56 }, // wider due to stroke/shadow
    isMask: true, maskType: "LUMINANCE", cornerSmoothing: 0.6, targetAspectRatio: { x: 16, y: 9 },
    detachedInfo: { type: "library", componentKey: "libkey123" },
    overlayBackgroundInteraction: "CLOSE_ON_CLICK_OUTSIDE", overlayPositionType: "CENTER",
    overlayBackground: { type: "SOLID_COLOR", color: { r: 0, g: 0, b: 0, a: 0.5 } },
    fills: [
      { type: "GRADIENT_LINEAR", visible: true, gradientStops: [{ position: 0, color: { r: 1, g: 0, b: 0, a: 1 } }], gradientTransform: [[1, 0, 0], [0, 1, 0]] },
      { type: "IMAGE", visible: true, scaleMode: "FILL", imageHash: "abc123", filters: { saturation: -0.5, contrast: 0.3, exposure: 0 } },
      { type: "PATTERN", visible: true, sourceNodeId: "9:99", tileType: "RECTANGULAR", scalingFactor: 1, spacing: { x: 4, y: 4 }, horizontalAlignment: "CENTER" },
      { type: "SHADER", visible: true, id: "shader_1" },
    ],
    effects: [
      { type: "LAYER_BLUR", visible: true, radius: 8, blurType: "PROGRESSIVE", startOffset: { x: 0, y: 0 }, endOffset: { x: 0, y: 1 }, startRadius: 0 },
      { type: "NOISE", visible: true, noiseType: "MULTITONE", color: { r: 0, g: 0, b: 0, a: 1 }, density: 0.5, noiseSize: 1, opacity: 0.3, blendMode: "NORMAL" },
      { type: "GLASS", visible: true, lightIntensity: 0.5, lightAngle: 45, refraction: 0.2, depth: 4, dispersion: 0.1, radius: 8 },
    ],
    strokes: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 1 }],
    strokeWeight: 1, strokeAlign: "CENTER", strokeCap: "ROUND", strokeJoin: "ROUND",
    children: [],
  };
}
/** `abs`: the overlay serialized as a root, in a world of its own (its image fill resolves through the base file's abc123). */
export async function overlay(): Promise<IrNode> {
  const { api } = world();
  return api.serialize(absNode(), 0, false);
}

export const cases: Case[] = [{
  name: "overlay node: hidden kept, x/y, layout grids, annotations, dev status",
  async run() {
    const abs = await overlay();
    ok("hidden node kept + flagged", abs.hidden === true && abs.name === "Overlay");
    ok("absolute x/y captured", abs.x === 12.4 && abs.y === 40);
    ok("frame layoutGrids captured", Array.isArray(abs.layoutGrids) && abs.layoutGrids[0]?.pattern === "columns" && abs.layoutGrids[0]?.count === 12);
    ok("COLUMNS grid keeps its sectionSize as `size` (not just GRID's cell size)", abs.layoutGrids?.[0]?.size === 60);
    ok("dev-mode annotations captured", Array.isArray(abs.annotations) && abs.annotations[0]?.label === "Use spacing token md");
    ok("devStatus captured", abs.devStatus === "ready_for_dev");
  },
}, {
  name: "READ additions (HIGH tier + MED) on the overlay node: box, render box, mask, smoothing, ratio, detached, overlay, dev notes",
  async run() {
    const abs = await overlay();
    ok("absolute bounding box -> box", !!(abs.box && abs.box.w === 100 && abs.box.h === 50));
    ok("render box emitted when it differs", !!(abs.renderBox && abs.renderBox.h === 56));
    ok("maskType (luminance) carried", abs.maskType === "luminance");
    ok("cornerSmoothing carried", abs.cornerSmoothing === 0.6);
    ok("targetAspectRatio -> ratio", abs.aspectRatio === 1.78);
    ok("detachedInfo (library key)", !!(abs.detachedFrom && abs.detachedFrom.key === "libkey123"));
    ok("overlay settings (scrim + close-on-click-outside)", !!(abs.overlay && abs.overlay.closeOnClickOutside === true && abs.overlay.background && abs.overlay.position === "center"));
    ok("annotation categoryId", Array.isArray(abs.annotations) && abs.annotations[0]?.categoryId === "cat_spacing");
    ok("devStatus free-text note captured", abs.devStatusNote === "blocked on API");
  },
}, {
  name: "table cells traversed via cellAt",
  async run() {
    const { api } = world();
    const tableNode = { type: "TABLE", name: "Data", visible: true, id: "20:0", numRows: 2, numColumns: 2,
      cellAt: (r: number, c: number) => ({ text: { characters: "r" + r + "c" + c }, fills: [{ type: "SOLID", visible: true, color: { r: 1, g: 1, b: 1 }, opacity: 1 }], rowSpan: 1, columnSpan: 1 }) };
    const tbl = await api.serialize(tableNode, 0, false);
    const tblCell00 = tbl.tableCells?.[0]?.[0];
    ok("table cells traversed via cellAt", Array.isArray(tbl.tableCells) && tbl.tableCells.length === 2 && tblCell00 !== undefined && tblCell00.text === "r0c0");
  },
}, {
  name: "sharedData (cross-plugin, e.g. Tokens Studio applied tokens) is OPT-IN",
  async run() {
    const { w, tree } = await selection();
    ok("sharedData off by default", tree.sharedData === undefined);
    const sel4 = await w.api.collectSelection({ sharedData: true });
    const tree4 = must(sel4.screen.nodes[0], "sel4.screen.nodes[0]");
    ok("sharedData: Tokens Studio applied tokens captured (opt-in)", !!(tree4.sharedData && tree4.sharedData.tokens && tree4.sharedData.tokens.fill === "color.primary" && tree4.sharedData.tokens.borderRadius === "radius.md"));
  },
}, {
  name: "parametric shape intent: ellipse arc/donut, star/polygon points, boolean op",
  async run() {
    const { api } = world();
    const donut = await api.serialize({ type: "ELLIPSE", name: "Ring", visible: true, id: "e:1", arcData: { startingAngle: 0, endingAngle: Math.PI * 1.5, innerRadius: 0.6 } }, 0, false);
    ok("ellipse arc/donut captured (start/end/innerRadius)", !!(donut.arc && donut.arc.end === 4.71 && donut.arc.innerRadius === 0.6));
    const fullEllipse = await api.serialize({ type: "ELLIPSE", name: "Dot", visible: true, id: "e:2", arcData: { startingAngle: 0, endingAngle: Math.PI * 2, innerRadius: 0 } }, 0, false);
    ok("full ellipse emits no arc (noise-free)", fullEllipse.arc === undefined);
    const star = await api.serialize({ type: "STAR", name: "Star", visible: true, id: "st:1", pointCount: 5, innerRadius: 0.4 }, 0, false);
    ok("star pointCount + innerRadius captured", !!(star.shape && star.shape.points === 5 && star.shape.innerRadius === 0.4));
    const poly = await api.serialize({ type: "POLYGON", name: "Tri", visible: true, id: "pg:1", pointCount: 3 }, 0, false);
    ok("polygon pointCount captured", !!(poly.shape && poly.shape.points === 3));
    const boolOp = await api.serialize({ type: "BOOLEAN_OPERATION", name: "Cut", visible: true, id: "bo:1", booleanOperation: "SUBTRACT", children: [] }, 0, false);
    ok("boolean operation kind captured (lowercased)", boolOp.booleanOp === "subtract");
  },
}, {
  name: "FIX: image-BACKED container (image fill + children) must NOT flatten to a PNG",
  async run() {
    const { api } = world();
    // A hero/cover-card/banner uses an image as its background but has real children (text, buttons).
    // Flattening it to a single raster would silently drop all of that; the guard recurses instead.
    const heroFrame = {
      type: "FRAME", name: "Hero", visible: true, id: "hero:0", layoutMode: "VERTICAL",
      width: 375, height: 200, itemSpacing: 8, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
      fills: [{ type: "IMAGE", visible: true, scaleMode: "FILL", imageHash: "abc123" }],
      exportAsync: async () => new Uint8Array([137, 80, 78, 71]), // would succeed if (wrongly) flattened
      children: [{ type: "TEXT", name: "Title", visible: true, id: "hero:1", characters: "Welcome",
        fontName: { family: "Inter", style: "Bold" }, fontSize: 20, width: 200, getStyledTextSegments: () => [] }],
    };
    const hero = await api.serialize(heroFrame, 0, false);
    ok("image-backed container NOT flattened (no asset)", hero.asset === undefined);
    ok("image-backed container keeps children (text survives)", Array.isArray(hero.children) && hero.children.length === 1 && hero.children[0]?.text === "Welcome");
    ok("image-backed container keeps image as background fill", Array.isArray(hero.fills) && hero.fills.some((f) => flatPaint(f).hash === "abc123"));
    // A childless image node (a plain image rectangle) still rasterizes to a PNG asset.
    const imageRect = { type: "RECTANGLE", name: "Photo", visible: true, id: "img:1",
      fills: [{ type: "IMAGE", visible: true, scaleMode: "FILL", imageHash: "abc123" }],
      exportAsync: async () => new Uint8Array([137, 80, 78, 71]) };
    const imgLeaf = await api.serialize(imageRect, 0, false);
    ok("childless image node still exported as PNG asset", typeof imgLeaf.asset === "string" && imgLeaf.asset.indexOf(".png") !== -1);
  },
}, {
  name: "end to end: code.js IR → verify-screen --expect",
  async run() {
    const { api } = world();
    // A fixed-width text box (textAutoResize HEIGHT)
    // is wider than its words, so its width is expected at the INK width (absoluteRenderBounds → renderBox.w), with the
    // box width listed as not comparable — never the 121px box a build's hugging <span> can never fill.
    const inkFrame = {
      type: "FRAME", name: "Card", visible: true, id: "ink:0", layoutMode: "NONE",
      absoluteBoundingBox: { x: 0, y: 0, width: 320, height: 100 }, fills: [{ type: "SOLID", visible: true, color: { r: 1, g: 1, b: 1 }, opacity: 1 }],
      children: [{ type: "TEXT", name: "Date", visible: true, id: "ink:1", characters: "Date", textAutoResize: "HEIGHT", textAlignHorizontal: "LEFT",
        fontName: { family: "Inter", style: "Regular" }, fontSize: 14, width: 121, height: 20,
        absoluteBoundingBox: { x: 16, y: 20, width: 121, height: 20 }, absoluteRenderBounds: { x: 16.62, y: 24, width: 32.14, height: 11 },
        fills: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 1 }], getStyledTextSegments: () => [] }],
    };
    const inkIr = await api.serialize(inkFrame, 0, false);
    const inkText = inkIr.children?.[0];
    const inkSpec = buildExpectation([{ doc: { nodes: [inkIr] }, label: "Card" }]).nodes.find((n) => n.nodeId === "ink:1");
    ok("code.js writes the HEIGHT text's autoResize lowercase and its renderBox narrower than its box",
      inkText?.autoResize === "height" && inkText.box?.w === 121 && inkText.renderBox?.w === 32.14);
    ok("--expect: that TEXT's spec.width === renderBox.w (32.14, the ink), widthFrom renderBox, no height",
      inkSpec?.width === inkText?.renderBox?.w && inkSpec?.width === 32.14 && inkSpec.widthFrom === "renderBox" && inkSpec.height === undefined);
  },
}];
