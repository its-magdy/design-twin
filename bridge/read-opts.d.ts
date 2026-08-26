// Types for read-opts.js — the module is plain CJS so the Node CLI/MCP can require it AND esbuild can
// inline it into the plugin bundle; this declaration is what lets state.ts/collect.ts import it under
// `strict`. (Same arrangement as node-id.d.ts / pages-layout.d.ts.)
//
// ReadOptName is spelled out as a literal union because a .js registry cannot narrow to literals on
// its own. It is the ONE place the names are typed — CollectOpts and runOpts both derive from it, so
// adding an option is still a row in read-opts.js plus this union, and TypeScript then fails loudly
// at every site that must handle it rather than letting one drift silently.
export type ReadOptName = "css" | "measurements" | "pluginData" | "motion" | "sharedData" | "variantVisuals" | "skipAssets";

export interface ReadOptDef {
  /** The option key on the wire / in CollectOpts. */
  name: ReadOptName;
  /** The figma-pull CLI spelling. */
  flag: string;
  /** Help text for the MCP tool schema. */
  describe: string;
}

export const READ_OPTS: ReadOptDef[];
/** Every read option, defaulted to false. A fresh object per call — callers mutate it. */
export function readOptDefaults(): Record<ReadOptName, boolean>;
