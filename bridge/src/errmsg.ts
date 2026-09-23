// Thrown value -> message string. The ONE definition, shared across both consumers: the Node side
// imports it directly, and the plugin bundle re-exports it from util.ts (esbuild inlines this
// dependency-free module, the same way it inlines pages-layout.ts). A bare `e.message` prints
// `undefined` for a thrown string, and the extractor's "never silent" discipline means every catch
// reports something — so this coercion has to hold everywhere, not per module system.
export const errMsg = (e: unknown): string =>
  typeof e === "string" ? e : String((e && (e as { message?: unknown }).message) || e);
