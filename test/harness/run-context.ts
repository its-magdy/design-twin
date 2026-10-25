// [RUN-CONTEXT] every run reads its own context: two reads in sequence in ONE world, and nothing the first one
// asked for, counted or warned reaches the second (figma-plugin/src/run.ts).
import { ok } from "../assert.ts";
import { must } from "../fixtures.ts";
import type { FakeNode } from "../fake-figma.ts";
import type { Case } from "./helpers.ts";
import { world } from "./scene.ts";

/** A frame that renders a reference PNG, with a text child whose font is missing (one grouped warning). */
function shotFrame(): FakeNode {
  return { type: "FRAME", name: "Shot", id: "rc:1", visible: true, width: 40, height: 20, layoutMode: "NONE",
    exportAsync: async () => new Uint8Array([137, 80, 78, 71]),
    children: [{ type: "TEXT", name: "Label", visible: true, id: "rc:2", characters: "x", width: 30,
      fontName: { family: "Missing Sans", style: "Regular" }, fontSize: 12, hasMissingFont: true, getStyledTextSegments: () => [] }] };
}

/** A vector that would export an SVG. */
const dot = (id: string): FakeNode => ({ type: "VECTOR", name: "Dot", id, visible: true, width: 8, height: 8,
  fills: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 0 }, opacity: 1 }],
  exportAsync: async () => "<svg width=\"8\" height=\"8\"><path d=\"M0 0h8\"/></svg>" });

/** The current page holds `frame`; the catalog page holds one COMPONENT_SET whose variant draws a vector. */
function variantWorld(frame: FakeNode) {
  const set: FakeNode = { type: "COMPONENT_SET", id: "rcset:1", name: "Chip", key: "rcsetkey",
    componentPropertyDefinitions: { State: { type: "VARIANT", variantOptions: ["A"] } } };
  const variant: FakeNode = { type: "COMPONENT", id: "rcv:1", name: "State=A", key: "rckey_a", parent: set, visible: true,
    width: 20, height: 20, layoutMode: "NONE", children: [dot("rcv:2")] };
  const catalog: FakeNode = { name: "Components", id: "p:rc", loadAsync: async () => {},
    findAllWithCriteria: ({ types }: { types: string[] }) => (types.indexOf("COMPONENT_SET") !== -1 ? [set, variant] : []) };
  return world({ pages: [catalog], currentPage: { name: "Screens", id: "p:rcs", selection: [], children: [frame] } });
}

export const cases: Case[] = [{
  name: "[RUN-CONTEXT] a screenshot after an export with read options reports only its own reads and warnings",
  async run() {
    const { api, scene } = world();
    scene.nodes["rc:1"] = shotFrame();
    const ui = { source: "ui" as const, label: "run-context" };

    const node = await api.serializeRun(() => api.collectNode("rc:1", { motion: true, pluginData: true, css: false }), ui);
    const first = node.screen.manifest;
    ok(`the export records the reads it asked for (got ${JSON.stringify(first.reads)})`,
      JSON.stringify(first.reads) === '["pluginData","motion"]');
    ok("…and its missing-font warning", first.warnings.some((w) => w.indexOf("missing font") !== -1));

    const shot = await api.serializeRun(() => api.collectScreenshot("rc:1"), ui);
    // pre-change: fails — collectScreenshot reset the counters but never the read options, so its manifest
    // carried the export's ["pluginData","motion"].
    ok(`the screenshot that follows reports no reads (got ${JSON.stringify(shot.manifest.reads)})`,
      JSON.stringify(shot.manifest.reads) === "[]");
    ok(`…no warnings (got ${JSON.stringify(shot.manifest.warnings)})`, shot.manifest.warnings.length === 0);
    ok("…and no nodes: it serializes nothing", shot.manifest.nodes === 0);

    // The same two reads driven directly (no scheduler — the test surface, `__designExport`): each collector call
    // is still a run of its own.
    await api.collectNode("rc:1", { motion: true, css: false });
    const direct = await api.collectScreenshot("rc:1");
    // pre-change: fails — ["motion"] from the export before it.
    ok(`driven directly, the screenshot still reports no reads (got ${JSON.stringify(direct.manifest.reads)})`,
      JSON.stringify(direct.manifest.reads) === "[]");
  },
}, {
  name: "[RUN-CONTEXT] the variant walk renders no assets and counts none of them as --no-assets skips",
  async run() {
    const plain: FakeNode = { type: "FRAME", name: "Screen", id: "rcf:1", visible: true, width: 40, height: 20, layoutMode: "NONE",
      exportAsync: async () => new Uint8Array([137, 80, 78, 71]), children: [] };
    const w1 = variantWorld(plain);
    const full = await w1.api.serializeRun(() => w1.api.collectFull({ variantVisuals: true, css: false }), { source: "ui", label: "rc-full" });
    const variantDot = must(full.designSystem.components.find((c) => c.id === "rcset:1"), "the Chip set").variants?.[0]?.node?.children?.[0];
    ok("the variant's vector is a skipped leaf, never rendered", variantDot?.assetSkipped === true && variantDot.asset === undefined);
    ok("…and no asset was registered for it", !full.assets.some((a) => a.id === "rcv:2"));
    // pre-change: fails — serializeVariant flipped the run's skipAssets on across its await, so the variant's
    // vector counted as a --no-assets skip on a run that never asked for --no-assets.
    ok(`a run without --no-assets reports assetsSkipped 0 (got ${full.layersDoc.manifest.assetsSkipped})`,
      full.layersDoc.manifest.assetsSkipped === 0);
    ok("…and no --no-assets note", !full.layersDoc.manifest.warnings.some((x) => x.indexOf("--no-assets") === 0));

    const host: FakeNode = { type: "FRAME", name: "Screen", id: "rcf:2", visible: true, width: 40, height: 20, layoutMode: "NONE",
      exportAsync: async () => new Uint8Array([137, 80, 78, 71]), children: [dot("rcf:3")] };
    const w2 = variantWorld(host);
    const skipped = await w2.api.serializeRun(() => w2.api.collectFull({ variantVisuals: true, skipAssets: true, css: false }), { source: "ui", label: "rc-skip" });
    const m = skipped.layersDoc.manifest;
    // pre-change: fails — 2, the page's vector plus the variant's.
    ok(`with --no-assets only the page walk's vector counts (got ${m.assetsSkipped})`, m.assetsSkipped === 1);
    ok("…and the note names that one node", m.warnings.some((x) => x.indexOf("--no-assets: 1 node(s)") === 0));
  },
}];
