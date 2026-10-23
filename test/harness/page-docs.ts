// The full export's page-level docs: size hints on the layers index, and page canvas backgrounds.
import { ok } from "../assert.ts";
import { must } from "../fixtures.ts";
import type { IrNode } from "../../bridge/src/doc-types.ts";
import { flatPaint, type Case } from "./helpers.ts";
import { world } from "./scene.ts";

export const cases: Case[] = [{
  // ---- index size hints: the skill says "read ONLY that file", so say how big it is ----
  name: "index size hints: the skill says \"read ONLY that file\", so say how big it is",
  async run() {
    const sized = await world().api.collectFull({ css: false });
    const entry = must(must(sized.layersDoc.index, "sized.layersDoc.index")[0], "sized.layersDoc.index[0]");
    const layerTree = must(must(sized.layersDoc.layers, "sized.layersDoc.layers")[0], "sized.layersDoc.layers[0]").tree;
    const countTree = (t: IrNode): number => 1 + (Array.isArray(t.children) ? t.children.reduce((a: number, c) => a + countTree(c), 0) : 0);
    ok("index entries carry a subtree node count", entry.nodes === countTree(layerTree));
    ok("and an approximate serialized byte size", typeof entry.bytes === "number" && entry.bytes > 100);
    ok("bytes tracks the tree that actually lands in the layer file",
      Math.abs(must(entry.bytes, "entry.bytes") - JSON.stringify(layerTree).length) < 2);
    ok("the identity fields are unchanged", !!entry.id && !!entry.name && !!entry.type && !!entry.page);
  },
}, {
  // ---- page backgrounds: the canvas a screen sits on ----
  name: "page backgrounds: the canvas a screen sits on",
  async run() {
    const { api } = world((fx) => ({ pages: [{ name: "Dark", id: "p:bg", loadAsync: async () => {}, children: [fx.scrollFrame],
      findAllWithCriteria: () => [],
      backgrounds: [{ type: "SOLID", visible: true, color: { r: 0.1, g: 0.1, b: 0.1 }, opacity: 1 }],
      prototypeBackgrounds: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 1 }] }, {
      name: "Plain", id: "p:plain", loadAsync: async () => {}, children: [],
      findAllWithCriteria: () => [],
      backgrounds: [{ type: "SOLID", visible: true, color: { r: 1, g: 1, b: 1 }, opacity: 1 }] }] }));
    const bgRun = await api.collectFull({ allPages: true, css: false });
    const bgEntry = (bgRun.layersDoc.pageSettings || []).find((p) => p.pageId === "p:bg");
    ok("a page's chosen canvas background is captured", !!(bgEntry && flatPaint(must(bgEntry.background?.[0], "bgEntry.background[0]")).color === "#1a1a1a"));
    ok("prototypeBackgrounds is captured separately", !!(bgEntry && flatPaint(must(bgEntry.prototypeBackground?.[0], "bgEntry.prototypeBackground[0]")).color === "#000000"));
    ok("the page entry is keyed by pageId, not by the non-unique name", !!(bgEntry && bgEntry.page === "Dark"));
    // Figma's own default carries no designer intent — emitting it would put a line on every page.
    ok("the plain-white default is omitted", !(bgRun.layersDoc.pageSettings || []).some((p) => p.pageId === "p:plain"));
  },
}];
