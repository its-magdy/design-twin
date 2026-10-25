// read-opts.ts — THE registry of the extractor's opt-in read options.
//
// The same six names would otherwise be written out by hand in four places: the plugin's run reads
// (run.ts), the `CollectOpts` interface (collect.ts), the CLI's flag table (figma-pull.ts), and the
// MCP tool schema (figma-mcp.ts). Every one of those is a place a new option can be forgotten, and
// the failure is SILENT in both front-ends: the CLI just never sets the flag, and the MCP SDK's Zod
// object mode STRIPS undeclared keys before the handler runs. That is not hypothetical — `skipAssets`
// was once declared on figma_export_full only, which made it dead on the other two export tools with
// nothing to make the lists disagree loudly. Fixing that *within each file* would leave four
// consistent-by-luck lists instead of one.
//
// So: one row here is the whole change. `name` is the wire/option key the plugin reads, `flag` is the
// CLI spelling, `describe` is the MCP tool-schema help (the only consumer of prose, but it lives here
// so a new option cannot ship undocumented), `scopes` the reads that take it (see READ_SCOPES below).
//
// Dependency-free on purpose — the same arrangement as node-id.ts / pages-layout.ts / errmsg.ts:
// imported by the CLI and the MCP entry, and inlined into the plugin bundle by esbuild, so it must
// type-check under the plugin's tsconfig too (ES2019 lib, no Node types).
//
// ReadOptName is DERIVED from the registry below (`as const satisfies`), so the names are typed in
// exactly one place: CollectOpts and the run's reads both derive from it, and adding a row here makes
// TypeScript fail loudly at every site that must handle the new option rather than letting one
// drift silently.

// The read SCOPES — what one read exports. read-plan.ts turns a scope into the command that reads it; each
// row below declares the scopes that take it, and a read option given to any other scope is refused (the
// CLI) or not declared at all (each MCP tool's schema is derived from its scope). Declared as what each
// front-end accepted before the rows said so, not as what the plugin is known to read: variantVisuals on a
// node or selection pull builds no catalog, and a variant walk does serialize with the walk options on —
// both decisions for another day, and one row each when they are made.
export const READ_SCOPES = ["node", "selection", "pages", "designSystem", "library", "screenshot"] as const;
export type ReadScopeKind = (typeof READ_SCOPES)[number];
/** The scopes that walk nodes: every walk option is read there. */
const WALK = ["node", "selection", "pages"] as const;

export interface ReadOptDef {
  /** The option key on the wire / in CollectOpts. */
  name: string;
  /** The figma-pull CLI spelling. */
  flag: string;
  /** Help text for the MCP tool schema. */
  describe: string;
  /** The read scopes that take this option. */
  scopes: readonly ReadScopeKind[];
}

export const READ_OPTS = [
  {
    name: "css",
    flag: "--css",
    describe:
      "Include Figma's OWN computed CSS per node (getCSSAsync) — the design-to-code oracle. One async call per node, so larger/slower; use for a screen you're implementing.",
    scopes: WALK,
  },
  {
    // NOT "Dev Mode only": per developers.figma.com only addMeasurement/editMeasurement/
    // deleteMeasurement carry that restriction — PageNode.getMeasurements() has no such note. And no
    // longer "current page": collect.ts reads measurements from the page(s) actually exported.
    name: "measurements",
    flag: "--measurements",
    describe:
      "Include measurement redlines (spacing specs the designer placed) for the exported page(s). Reading them does not require Dev Mode.",
    scopes: WALK,
  },
  {
    name: "pluginData",
    flag: "--plugin-data",
    describe:
      "Include own-scope plugin data (getPluginData) stamped on nodes — round-trip metadata. Usually empty unless the write plane wrote it.",
    scopes: WALK,
  },
  {
    name: "motion",
    flag: "--motion",
    describe:
      "Include motion/animation reads (timelines, manual keyframe tracks, animations, applied animation styles). Free via the Plugin API; useful for Slides/prototype animation. Can be verbose.",
    scopes: WALK,
  },
  {
    name: "sharedData",
    flag: "--shared-data",
    describe:
      "Include cross-plugin shared data (getSharedPluginData) — notably Tokens Studio applied tokens (the semantic token layer on files without native Figma Variables). Free; per-node.",
    scopes: WALK,
  },
  {
    name: "variantVisuals",
    flag: "--variant-visuals",
    describe:
      "Walk each COMPONENT_SET's variant children and record their real layout/fills/radius/tokens/css — the master-component source of truth, not the component-set wrapper's own selection-chrome visuals. One node walk per variant; noticeably slower on large systems.",
    scopes: [...WALK, "designSystem", "library"],
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
    scopes: WALK,
  },
] as const satisfies readonly ReadOptDef[];

/** The literal union of every option key — "css" | "measurements" | … | "skipAssets". */
export type ReadOptName = (typeof READ_OPTS)[number]["name"];

/** A registry row as its readers take it: its name typed, its scopes widened to every scope (so a reader
 *  can ask whether a row lists any scope, not only one it already knows it lists). */
export type ReadOptRow = ReadOptDef & { name: ReadOptName };
export const READ_OPT_ROWS: readonly ReadOptRow[] = READ_OPTS;

/** The options a scope takes, as a literal union — what an MCP tool's schema for that scope declares. */
export type ReadOptNameFor<K extends ReadScopeKind> = RowNameFor<(typeof READ_OPTS)[number], K>;
type RowNameFor<R, K> = R extends { name: infer N; scopes: readonly (infer S)[] } ? (K extends S ? N : never) : never;

// Every option defaulted off, as a fresh object per call (callers fill it in — each run builds its own
// reads from one). Derived here so no consumer restates the names just to zero them.
export function readOptDefaults(): Record<ReadOptName, boolean> {
  const o: Partial<Record<ReadOptName, boolean>> = {};
  for (const d of READ_OPTS) o[d.name] = false;
  return o as Record<ReadOptName, boolean>; // every key was just set by the loop above
}
