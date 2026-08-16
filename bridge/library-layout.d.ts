// Types for library-layout.js — plain CJS so the Node CLI can require it AND esbuild can inline it
// into the plugin bundle; this declaration is what lets main.ts import it under `strict`.
export interface LibraryLayoutFile {
  /** Where the file lands, joined with the caller's separator — emit this verbatim. */
  path: string;
  /** The file's contents as an object; the caller decides how to stringify it. */
  data: Record<string, any>;
}
export interface LibraryLayout {
  /** Every file to write, INCLUDING the directory's own index.json (last). */
  files: LibraryLayoutFile[];
  /** The slim manifest alone: stamp + `source` + `files` pointer map + `counts` + `publish`. */
  manifest: Record<string, any>;
  counts: Record<string, number>;
  /** The full relative directory the parts live under ("libraries/<slug>-<fileKey8>"). */
  dir: string;
  /** Just the leaf directory name — the identity a libraries/index.json row is keyed on. */
  dirName: string;
}
export function buildLibraryLayout(ds: any, sep: string): LibraryLayout;
export function mergeLibrariesIndex(prev: any, built: LibraryLayout): Record<string, any>;
export const ROOT: string;
export const INDEX: string;
