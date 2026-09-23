// read-opts.ts — THE registry of the extractor's opt-in read options.
//
// The same six names used to be written out by hand in four places: the plugin's `runOpts`
// (state.ts), the `CollectOpts` interface (collect.ts), the CLI's flag table (figma-pull.ts), and the
// MCP tool schema (figma-mcp.ts). Every one of those is a place a new option can be forgotten, and
// the failure is SILENT in both front-ends: the CLI just never sets the flag, and the MCP SDK's Zod
// object mode STRIPS undeclared keys before the handler runs. That is not hypothetical — `skipAssets`
// was declared on figma_export_full only, which made it dead on the other two export tools with
// nothing to make the lists disagree loudly. Both front-ends had already noticed and each fixed it
// *within its own file*, which left four consistent-by-luck lists instead of one.
//
// So: one row here is the whole change. `name` is the wire/option key the plugin reads, `flag` is the
// CLI spelling, `describe` is the MCP tool-schema help (the only consumer of prose, but it lives here
// so a new option cannot ship undocumented).
//
// Dependency-free on purpose — the same arrangement as node-id.ts / pages-layout.ts / errmsg.ts:
// imported by the CLI and the MCP entry, and inlined into the plugin bundle by esbuild, so it must
// type-check under the plugin's tsconfig too (ES2019 lib, no Node types).
//
// ReadOptName is DERIVED from the registry below (`as const satisfies`), so the names are typed in
// exactly one place: CollectOpts and runOpts both derive from it, and adding a row here makes
// TypeScript fail loudly at every site that must handle the new option rather than letting one
// drift silently.
export interface ReadOptDef {
  /** The option key on the wire / in CollectOpts. */
  name: string;
  /** The figma-pull CLI spelling. */
  flag: string;
  /** Help text for the MCP tool schema. */
  describe: string;
}

export const READ_OPTS = [
  {
    name: "css",
    flag: "--css",
    describe:
      "Include Figma's OWN computed CSS per node (getCSSAsync) — the design-to-code oracle. One async call per node, so larger/slower; use for a screen you're implementing.",
  },
  {
    // NOT "Dev Mode only": per developers.figma.com only addMeasurement/editMeasurement/
    // deleteMeasurement carry that restriction — PageNode.getMeasurements() has no such note. And no
    // longer "current page": collect.ts reads measurements from the page(s) actually exported.
    name: "measurements",
    flag: "--measurements",
    describe:
      "Include measurement redlines (spacing specs the designer placed) for the exported page(s). Reading them does not require Dev Mode.",
  },
  {
    name: "pluginData",
    flag: "--plugin-data",
    describe:
      "Include own-scope plugin data (getPluginData) stamped on nodes — round-trip metadata. Usually empty unless the write plane wrote it.",
  },
  {
    name: "motion",
    flag: "--motion",
    describe:
      "Include motion/animation reads (timelines, manual keyframe tracks, animations, applied animation styles). Free via the Plugin API; useful for Slides/prototype animation. Can be verbose.",
  },
  {
    name: "sharedData",
    flag: "--shared-data",
    describe:
      "Include cross-plugin shared data (getSharedPluginData) — notably Tokens Studio applied tokens (the semantic token layer on files without native Figma Variables). Free; per-node.",
  },
  {
    name: "variantVisuals",
    flag: "--variant-visuals",
    describe:
      "Walk each COMPONENT_SET's variant children and record their real layout/fills/radius/tokens/css — the master-component source of truth, not the component-set wrapper's own selection-chrome visuals. One node walk per variant; noticeably slower on large systems.",
  },
  {
    // The odd one out: the others ADD work, this one REMOVES it. Asset export is one exportAsync (a
    // real render round-trip — SVG per vector, 2x PNG per image) PER NODE, run sequentially, and
    // unlike getCSSAsync it was never gated despite being the same O(nodes) shape and far more
    // expensive. On a real design-system page it dominates the export and can outgrow the bridge's
    // frame limit. Opt-IN to skipping, so the default stays exactly as it was.
    name: "skipAssets",
    flag: "--no-assets",
    describe:
      "Skip the per-node SVG/PNG render pass — the dominant cost on a big file. Structure, layout and tokens are unaffected; skipped nodes stay leaves marked `assetSkipped: true`. Asset BYTES are stripped from MCP results anyway, so this is usually pure savings here.",
  },
] as const satisfies readonly ReadOptDef[];

/** The literal union of every option key — "css" | "measurements" | … | "skipAssets". */
export type ReadOptName = (typeof READ_OPTS)[number]["name"];

// Every option defaulted off, as a fresh object per call (callers mutate it — runOpts is reassigned
// per run). Derived here so no consumer restates the names just to zero them.
export function readOptDefaults(): Record<ReadOptName, boolean> {
  const o: Partial<Record<ReadOptName, boolean>> = {};
  for (const d of READ_OPTS) o[d.name] = false;
  return o as Record<ReadOptName, boolean>; // every key was just set by the loop above
}
