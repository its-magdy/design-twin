// Types for pages-layout.js — the module is plain CJS so the Node CLI can require it AND esbuild can
// inline it into the plugin bundle; this declaration is what lets main.ts import it under `strict`.
export interface PageLayoutFile {
  /** Where the file lands, joined with the caller's separator — emit this verbatim. */
  path: string;
  /** The file's contents as an object; the caller decides how to stringify it. */
  data: Record<string, any>;
}
export interface PageLayout {
  /**
   * layersDoc minus layers/index, plus the computed `pageDirs` — one entry per page, carrying
   * `{page, pageId?, dir, index, layers}`. Pages are bucketed by `pageId`; `page` is a display name
   * and is NOT unique (Figma allows two pages of the same name), so `pageId` is the field to match
   * on. It is absent on exports written before page ids were emitted. Becomes pages/index.json.
   */
  meta: Record<string, any>;
  layerFiles: PageLayoutFile[];
  /** One per page: where its index.json lands, and what goes in it (`{page, pageId?, layers}`). */
  indexFiles: Array<{ path: string; data: Record<string, any> }>;
  /** Path of the root pages index, joined with the caller's separator. */
  rootIndex: string;
}
export function buildPageLayout(layersDoc: any, sep: string): PageLayout;
export function safe(id: string): string;
