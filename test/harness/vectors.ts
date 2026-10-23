// Vector/icon output that has to be USABLE: failed vector exports (skip the empty ones, recover the real ones),
// Figma's own isAsset heuristic, and tapered (variable-width) strokes.
import { ok } from "../assert.ts";
import { must } from "../fixtures.ts";
import type { FakeNode } from "../fake-figma.ts";
import type { Case } from "./helpers.ts";
import { world } from "./scene.ts";

// ==================================================================================
// Audit 2026-08-08 punch-list. The read plane was already broad; these are about the
// output being USABLE — recoverable icons, a readable warnings list, and no payload
// that nothing consumes.
// ==================================================================================

const vecHost = (id: string, kids: FakeNode[]): FakeNode => ({ type: "FRAME", name: "Host" + id, visible: true, id: "vh:" + id,
  width: 100, height: 100, layoutMode: "NONE", children: kids,
  exportAsync: async () => new Uint8Array([137, 80, 78, 71]) });
const boom = async (): Promise<never> => { throw new Error("could not be exported"); };

export const cases: Case[] = [{
  // ---- failed vector exports: skip the empty ones, recover the real ones ----
  // The live export reported assetsFailed: 807 and left 663 vector nodes with NO `asset` at all —
  // icons simply unimplementable. Two distinct causes were collapsed into one counter and one
  // warning each: nodes that paint NOTHING (Figma rightly refuses to render them — not a failure),
  // and nodes that do paint but whose export threw (a real loss, and recoverable from geometry).
  name: "failed vector exports: skip the empty ones, recover the real ones",
  async run() {
    const invisibleVec = { type: "VECTOR", name: "empty-path", visible: true, id: "iv:1", width: 16, height: 16,
      fills: [{ type: "SOLID", visible: false, color: { r: 0, g: 0, b: 0 }, opacity: 1 }], strokes: [], exportAsync: boom };
    const zeroAreaVec = { type: "VECTOR", name: "collapsed", visible: true, id: "iv:2", width: 0, height: 24,
      fills: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 1 }], exportAsync: boom };
    const invRun = await world({ selection: [vecHost("inv", [invisibleVec, zeroAreaVec])] }).api.collectSelection({ css: false });
    const invRunChildren = must(must(invRun.screen.nodes[0], "invRun.screen.nodes[0]").children, "invRun tree children");
    const invNode = must(invRunChildren[0], "invRun tree children[0]");
    const zeroNode = must(invRunChildren[1], "invRun tree children[1]");

    ok("a vector with no visible paint is skipped (no asset, no geometry)",
      invNode.asset === undefined && invNode.geometry === undefined);
    ok("a zero-area vector is skipped too", zeroNode.asset === undefined && zeroNode.geometry === undefined);
    ok("the skip is COUNTED in its own counter", invRun.screen.manifest.assetsSkippedInvisible === 2);
    // The whole point of separating them: these must not inflate assetsFailed, which is the number an
    // agent (and this repo's own audit) reads as "icons you have lost".
    ok("and NOT counted as a failure", invRun.screen.manifest.assetsFailed === 0);
    ok("and NOT warned — there is nothing to render, so there is nothing to report",
      !invRun.screen.manifest.warnings.some((w) => /asset export/.test(w)));
    ok("exportAsync is never even attempted on them (they would have thrown)",
      invRun.screen.manifest.warnings.every((w) => !/could not be exported/.test(w)));

    // A node that DOES paint and still fails to export falls back to its resolved outlines. Docs call
    // `vectorPaths` "simple, but incomplete", so the fallback reads fillGeometry/strokeGeometry.
    const brokenVec = { type: "VECTOR", name: "icon-path", visible: true, id: "gv:1", width: 24, height: 24,
      fills: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 1 }],
      fillGeometry: [{ data: "M0 0h24v24H0z", windingRule: "NONZERO" }],
      strokeGeometry: [{ data: "M2 2h20" }],
      vectorPaths: [{ data: "M9 9L1 1" }], // deliberately DIFFERENT: the fallback must not read this
      exportAsync: boom };
    const geoRun = await world({ selection: [vecHost("geo", [brokenVec])] }).api.collectSelection({ css: false });
    const geoNode = must(must(must(geoRun.screen.nodes[0], "geoRun.screen.nodes[0]").children, "geoRun tree children")[0], "geoRun tree children[0]");
    ok("a real export failure falls back to fillGeometry", !!(geoNode.geometry && geoNode.geometry.fills?.[0] === "M0 0h24v24H0z"));
    ok("strokeGeometry comes along when present", geoNode.geometry?.strokes?.[0] === "M2 2h20");
    // Without w/h the path data has no coordinate space — a consumer cannot build a viewBox from it.
    ok("geometry carries the node's own w/h so it can be rendered as inline SVG",
      geoNode.geometry?.w === 24 && geoNode.geometry?.h === 24);
    ok("the incomplete `vectorPaths` is NOT what gets captured", JSON.stringify(geoNode.geometry).indexOf("M9 9L1 1") === -1);
    ok("a recovered node is still a LEAF, like a successful export", geoNode.children === undefined && geoNode.asset === undefined);
    ok("recovery is counted, and is not a failure",
      geoRun.screen.manifest.assetsGeometry === 1 && geoRun.screen.manifest.assetsFailed === 0);

    // Only when BOTH the export and the geometry are gone is it a genuine, warn-worthy failure.
    const hopelessVec = { type: "VECTOR", name: "gone", visible: true, id: "hv:1", width: 24, height: 24,
      fills: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 1 }], exportAsync: boom };
    const badRun = await world({ selection: [vecHost("bad", [hopelessVec])] }).api.collectSelection({ css: false });
    ok("an unrecoverable node IS counted as failed", badRun.screen.manifest.assetsFailed === 1);
    ok("and IS warned, naming the node and the reason",
      badRun.screen.manifest.warnings.some((w) => /asset export failed/.test(w) && /gone \(hv:1\)/.test(w) && /could not be exported/.test(w)));
  },
}, {
  // ---- [2026-08-13] isAsset: Figma's own icon/raster heuristic, OR'd into iconLike ----
  // A container that the name/size regex would NOT flag (unconventional name) but that Figma's own
  // `isAsset` says is an icon/raster subtree should still flatten to one asset leaf.
  name: "[isAsset] Figma's own icon/raster heuristic, OR'd into iconLike",
  async run() {
    const oddNameVec = { type: "VECTOR", name: "shape9", visible: true, id: "oa:v1", width: 16, height: 16,
      fills: [{ type: "SOLID", visible: true, color: { r: 1, g: 0, b: 0 }, opacity: 1 }], exportAsync: async () => "<svg/>" };
    const oddNameFrame = { type: "FRAME", name: "Group 42", visible: true, id: "oa:1", width: 20, height: 20,
      isAsset: true, children: [oddNameVec], findOne: () => null, exportAsync: async () => "<svg/>" };
    const isAssetRun = await world({ selection: [oddNameFrame] }).api.collectSelection({});
    const isAssetNode0 = must(isAssetRun.screen.nodes[0], "isAssetRun.screen.nodes[0]");
    ok("[isAsset] a container Figma flags as an asset flattens even with a non-matching name",
      typeof isAssetNode0.asset === "string" && !isAssetNode0.children);

    const oddNameFrameWithText = { type: "FRAME", name: "Group 43", visible: true, id: "oa:2", width: 20, height: 20,
      isAsset: true, children: [{ type: "TEXT", name: "t", visible: true, id: "oa:t1" }],
      findOne: (pred: (n: FakeNode) => boolean) => ([{ type: "TEXT", name: "t", visible: true, id: "oa:t1" }].find(pred) || null),
      exportAsync: async () => "<svg/>" };
    const isAssetTextRun = await world({ selection: [oddNameFrameWithText] }).api.collectSelection({});
    ok("[isAsset] isAsset:true is still overridden by a real TEXT descendant — never flatten real content",
      Array.isArray(isAssetTextRun.screen.nodes[0]?.children));
  },
}, {
  // ---- [2026-08-13, fixed 2026-09-24] variableWidthStrokeProperties: tapered strokes ----
  // Real shape per https://developers.figma.com/docs/plugins/api/VariableWidthStrokeProperties/ and
  // plugin-api.d.ts ~L8669-8697: CUSTOM carries `variableWidthPoints:[{position,width}]`; presets
  // (UNIFORM/WEDGE/TAPER/QUARTER_TAPER/EYE/MIRRORED_TAPER) carry only `widthProfile`, no points array.
  name: "[variableWidth] variableWidthStrokeProperties: tapered strokes",
  async run() {
    const taperedNode = { type: "VECTOR", name: "brush", visible: true, id: "vw:1", width: 40, height: 4,
      strokes: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 1 }],
      strokeWeight: 2,
      variableWidthStrokeProperties: { widthProfile: "CUSTOM",
        variableWidthPoints: [{ position: 0, width: 1 }, { position: 0.5, width: 4 }, { position: 1, width: 1 }] },
      fills: [], exportAsync: async () => "<svg/>" };
    const taperedRun = await world({ selection: [taperedNode] }).api.collectSelection({});
    const taperedStroke = must(taperedRun.screen.nodes[0], "taperedRun.screen.nodes[0]").strokes;
    ok("[variableWidth] a CUSTOM tapered stroke's profile is captured",
      !!taperedStroke && !!taperedStroke.variableWidth && taperedStroke.variableWidth.profile === "custom");
    const taperedPoints = must(taperedStroke?.variableWidth?.points, "taperedStroke.variableWidth.points");
    ok("[variableWidth] and its points, with position+width",
      taperedPoints.length === 3 && taperedPoints[1]?.pos === 0.5 && taperedPoints[1]?.width === 4);

    const presetNode = { type: "VECTOR", name: "wedge", visible: true, id: "vw:3", width: 40, height: 4,
      strokes: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 1 }],
      strokeWeight: 2,
      variableWidthStrokeProperties: { widthProfile: "WEDGE" },
      fills: [], exportAsync: async () => "<svg/>" };
    const presetRun = await world({ selection: [presetNode] }).api.collectSelection({});
    const presetStroke = must(presetRun.screen.nodes[0], "presetRun.screen.nodes[0]").strokes;
    ok("[variableWidth] a preset (WEDGE) stroke carries only a profile, no points",
      !!presetStroke && !!presetStroke.variableWidth && presetStroke.variableWidth.profile === "wedge" && presetStroke.variableWidth.points === undefined);

    const plainStrokeNode = { type: "VECTOR", name: "plain", visible: true, id: "vw:2", width: 40, height: 4,
      strokes: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 1 }],
      strokeWeight: 2, fills: [], exportAsync: async () => "<svg/>" };
    const plainRun = await world({ selection: [plainStrokeNode] }).api.collectSelection({});
    const plainStroke = must(plainRun.screen.nodes[0], "plainRun.screen.nodes[0]").strokes;
    ok("[variableWidth] a normal stroke with no profile emits no variableWidth key",
      !plainStroke || plainStroke.variableWidth === undefined);
  },
}];
