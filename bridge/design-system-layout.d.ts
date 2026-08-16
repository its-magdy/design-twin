// Types for design-system-layout.js — plain CJS so the Node CLI can require it AND esbuild can inline
// it into the plugin bundle; this declaration is what lets main.ts import it under `strict`.
export interface DesignSystemLayoutFile {
  /** Where the file lands, joined with the caller's separator — emit this verbatim. */
  path: string;
  /** The file's contents as an object; the caller decides how to stringify it. */
  data: Record<string, any>;
}
export interface DesignSystemLayout {
  /** Every file to write, INCLUDING the slim manifest (last). */
  files: DesignSystemLayoutFile[];
  /** The slim manifest alone: stamp + `files` pointer map + `counts`. */
  manifest: Record<string, any>;
  counts: Record<string, number>;
  /** The subdirectory the split parts live under ("design-system"). */
  dir: string;
}
export function buildDesignSystemLayout(ds: any, sep: string): DesignSystemLayout;
