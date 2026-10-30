// Missing host metadata must remain visible in the manifest, without repeating for each binding.
import { ok } from "../assert.ts";
import type { FakeNode } from "../fake-figma.ts";
import { world } from "./scene.ts";
import type { Case } from "./helpers.ts";

export const cases: Case[] = [{
  name: "[METADATA-WARN] unavailable variable and collection metadata warns once per id per run",
  async run() {
    for (const initial of [false, true]) {
      for (const availability of ["readable", "null", "reject", "first-null", "variable-null", "collection-null"] as const) {
        const child = (id: string): FakeNode => ({ id, type: "FRAME", name: "Bound", visible: true, width: 20, height: 20,
          boundVariables: { fills: { type: "VARIABLE_ALIAS", id: "v_primary" } },
          explicitVariableModes: { c_sem: "m_dark" }, children: [] });
        const node = child("mw:1");
        node.children = [child("mw:2"), child("mw:3")];
        node.getDevResourcesAsync = async () => [];
        const w = world({ nodes: { "mw:1": node } });
        w.figma.skipInvisibleInstanceChildren = initial;
        const getVariable = w.figma.variables.getVariableByIdAsync;
        const getCollection = w.figma.variables.getVariableCollectionByIdAsync;
        w.figma.variables.getLocalVariablesAsync = async () => [];
        w.figma.variables.getLocalVariableCollectionsAsync = async () => [];
        let variableCalls = 0, collectionCalls = 0;
        w.figma.variables.getVariableByIdAsync = async (id) => {
          variableCalls++;
          if (availability === "reject") throw new Error("metadata unavailable");
          if (availability === "null" || availability === "variable-null" || (availability === "first-null" && variableCalls === 1)) return null;
          return getVariable(id);
        };
        w.figma.variables.getVariableCollectionByIdAsync = async (id) => {
          collectionCalls++;
          if (availability === "reject") throw new Error("metadata unavailable");
          if (availability === "null" || availability === "collection-null" || (availability === "first-null" && collectionCalls === 1)) return null;
          return getCollection ? getCollection(id) : null;
        };
        const pull = () => w.api.serializeRun(() => w.api.collectNode("mw:1", { css: false }), { source: "bridge", label: "metadata warnings" });
        const result = await pull();
        const tree = result.screen.nodes[0];
        const warnings = result.screen.manifest.warnings;
        const variableMissing = !["readable", "collection-null"].includes(availability);
        const collectionMissing = !["readable", "variable-null"].includes(availability);
        const label = `[METADATA-WARN] ${initial}/${availability}`;
        ok(`${label}: variable warning identifies id exactly once despite repeated bindings`,
          warnings.filter((x) => x.includes("variable metadata unavailable") && x.includes("v_primary")).length === (variableMissing ? 1 : 0));
        ok(`${label}: collection warning identifies id exactly once despite repeated pins`,
          warnings.filter((x) => x.includes("collection metadata unavailable") && x.includes("c_sem")).length === (collectionMissing ? 1 : 0));
        ok(`${label}: token output still truthfully reflects host metadata`, !!tree?.tokens === !variableMissing);
        ok(`${label}: unresolved modes retain raw identity`,
          collectionMissing ? tree?.variableModes?.c_sem === "m_dark" : tree?.variableModes?.Semantic === "Dark");
        ok(`${label}: initial skip policy restored`, w.figma.skipInvisibleInstanceChildren === initial);
        if (availability === "readable") ok(`${label}: no metadata warnings for readable host`, warnings.length === 0);
        if (availability === "first-null") {
          ok(`${label}: no retry was added`, variableCalls === 1 && collectionCalls === 1);
          const next = await pull();
          ok(`${label}: a fresh run recovers names and has no stale warnings`,
            next.screen.nodes[0]?.tokens?.fills === "color/primary" && next.screen.manifest.warnings.length === 0);
        }
      }
    }
  },
}, {
  name: "[METADATA-WARN] an alias target first looked up by the variable dump still reaches the screen manifest",
  async run() {
    const node: FakeNode = { id: "mw:alias", name: "Bound", type: "FRAME", visible: true, width: 20, height: 20,
      boundVariables: { fills: { type: "VARIABLE_ALIAS", id: "v_primary" } }, children: [], getDevResourcesAsync: async () => [] };
    const w = world({ nodes: { "mw:alias": node } });
    const getVariable = w.figma.variables.getVariableByIdAsync;
    w.figma.variables.getLocalVariablesAsync = async () => [];
    w.figma.variables.getVariableByIdAsync = async (id) => id === "v_blue600" ? null : getVariable(id);
    const result = await w.api.collectNode("mw:alias", { css: false });
    ok("[METADATA-WARN] the dump's own failed lookup is in screen.manifest.warnings",
      result.screen.manifest.warnings.some((x) => x.includes("variable metadata unavailable") && x.includes("v_blue600")));
  },
}, {
  name: "[METADATA-WARN] absent optional collection lookup and unbound fields do not warn",
  async run() {
    const node: FakeNode = { id: "mw:optional", name: "Unbound", type: "FRAME", visible: true, width: 20, height: 20,
      boundVariables: { fills: undefined }, explicitVariableModes: { optional: "mode" }, children: [], getDevResourcesAsync: async () => [] };
    const w = world({ nodes: { "mw:optional": node } });
    Object.defineProperty(w.figma.variables, "getVariableCollectionByIdAsync", { value: undefined });
    const result = await w.api.collectNode("mw:optional", { css: false });
    ok("[METADATA-WARN] absent optional API keeps raw mode ids without false missing-metadata warnings",
      result.screen.nodes[0]?.variableModes?.optional === "mode" && result.screen.manifest.warnings.length === 0);
  },
}];
