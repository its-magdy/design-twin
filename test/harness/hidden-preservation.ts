// Structural exports must preserve hidden instance descendants regardless of the host's initial skip flag.
import { ok } from "../assert.ts";
import { skipAwareInstance, type FakeNode } from "../fake-figma.ts";
import { settle, type Case } from "./helpers.ts";
import { world } from "./scene.ts";

function fixture(initial: boolean) {
  const instance: FakeNode = { id: "hp:1", name: "Card", type: "INSTANCE", visible: true, width: 100, height: 40,
    children: [{ id: "hp:2", name: "Label", type: "FRAME", visible: true, children: [] },
      { id: "hp:3", name: "Badge", type: "FRAME", visible: false, children: [] }] };
  const page = { id: "hp:p", name: "Hidden preservation", type: "PAGE", selection: [instance], children: [instance], findAllWithCriteria: () => [] };
  const w = world({ currentPage: page, pages: [page], nodes: { "hp:1": instance } });
  skipAwareInstance(instance, () => w.figma.skipInvisibleInstanceChildren === true);
  w.figma.skipInvisibleInstanceChildren = initial;
  return { w, instance };
}

export const cases: Case[] = [{
  name: "[HIDDEN-PRESERVE] child discovery retains hidden children under either host policy",
  async run() {
    for (const initial of [false, true]) {
      const { w } = fixture(initial);
      const reply = await w.api.listChildren("hp:1");
      ok(`[HIDDEN-PRESERVE] listChildren, initial ${initial}: all children retained`,
        reply.children.map(c => c.id).join(",") === "hp:2,hp:3" && reply.children[1]?.hidden === true);
      ok(`[HIDDEN-PRESERVE] listChildren, initial ${initial}: caller flag restored`, w.figma.skipInvisibleInstanceChildren === initial);
      const pages = await w.api.listPages({ depth: 2 });
      ok(`[HIDDEN-PRESERVE] listPages, initial ${initial}: child count includes hidden layers`,
        pages.pages[0]?.frames?.[0]?.childCount === 2);
      ok(`[HIDDEN-PRESERVE] listPages, initial ${initial}: caller flag restored`, w.figma.skipInvisibleInstanceChildren === initial);
    }
  },
}, {
  name: "[HIDDEN-PRESERVE] node, selection and full exports preserve hidden children and restore host policy",
  async run() {
    for (const initial of [false, true]) {
      for (const kind of ["node", "selection", "full"] as const) {
        const { w } = fixture(initial);
        const opts = { css: false, skipAssets: true };
        const children = kind === "full"
          ? (await w.api.collectFull(opts)).layersDoc.layers[0]?.tree.children
          : (kind === "node" ? await w.api.collectNode("hp:1", opts) : await w.api.collectSelection(opts)).screen.nodes[0]?.children;
        ok(`[HIDDEN-PRESERVE] ${kind}, initial ${initial}: visible and hidden child retained`,
          children?.map(c => c.id).join(",") === "hp:2,hp:3" && children[1]?.hidden === true);
        ok(`[HIDDEN-PRESERVE] ${kind}, initial ${initial}: caller flag restored`, w.figma.skipInvisibleInstanceChildren === initial);
      }
    }
  },
}, {
  name: "[HIDDEN-PRESERVE] policy is disabled before lookup, and restored on lookup failure",
  async run() {
    for (const initial of [false, true]) {
      const { w, instance } = fixture(initial);
      w.figma.getNodeByIdAsync = async id => w.figma.skipInvisibleInstanceChildren ? null : id === "hp:1" ? instance : null;
      const found = await settle(w.api.collectNode("hp:1", { css: false, skipAssets: true }));
      ok(`[HIDDEN-PRESERVE] lookup sees complete scene, initial ${initial}`, !!found.v && !found.err);
      const missing = await settle(w.api.collectNode("hp:missing", { css: false }));
      ok(`[HIDDEN-PRESERVE] lookup failure restores flag, initial ${initial}`,
        !!missing.err && w.figma.skipInvisibleInstanceChildren === initial);
      const shot = await settle(w.api.collectScreenshot("hp:1"));
      ok(`[HIDDEN-PRESERVE] screenshot lookup sees complete scene and restores flag, initial ${initial}`,
        !String(shot.err?.message ?? "").includes("is not in the open file") && w.figma.skipInvisibleInstanceChildren === initial);
    }
  },
}, {
  name: "[HIDDEN-PRESERVE] cancellation restores flag and next scheduled export retains children",
  async run() {
    for (const initial of [false, true]) {
      const { w, instance } = fixture(initial);
      instance.getCSSAsync = async () => { w.api.requestCancel(); return {}; };
      const cancelled = await settle(w.api.serializeRun(() => w.api.collectNode("hp:1", { css: true }), { source: "bridge", label: "exportNode", requestId: "hp-cancel" }));
      ok(`[HIDDEN-PRESERVE] cancel restores flag, initial ${initial}`,
        cancelled.err?.message === "export cancelled by the designer in Figma" && w.figma.skipInvisibleInstanceChildren === initial);
      const next = await w.api.serializeRun(() => w.api.collectNode("hp:1", { css: false, skipAssets: true }), { source: "bridge", label: "exportNode", requestId: "hp-next" });
      ok(`[HIDDEN-PRESERVE] next queued run is complete, initial ${initial}`,
        next.screen.nodes[0]?.children?.[1]?.hidden === true && w.figma.skipInvisibleInstanceChildren === initial);
    }
  },
}];
