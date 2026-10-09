// Thrown value -> message string. The ONE definition, shared across both consumers: the Node side
// imports it directly, and the plugin bundle re-exports it from util.ts (esbuild inlines this
// dependency-free module, the same way it inlines pages-layout.ts). A bare `e.message` prints
// `undefined` for a thrown string, and the extractor's "never silent" discipline means every catch
// reports something — so this coercion has to hold everywhere, not per module system.
export const errMsg = (e: unknown): string =>
  typeof e === "string" ? e : String((e && (e as { message?: unknown }).message) || e);

/** The first line of a thrown value's message — a Playwright or fs error carries its call log after it. */
export const firstLine = (e: unknown): string => errMsg(e).split("\n")[0] ?? "";

/** A thrown value's string `code` (an fs / Node error's ENOENT, ERR_PARSE_ARGS_…), else undefined. */
export const errCode = (e: unknown): string | undefined =>
  e && typeof e === "object" && "code" in e && typeof e.code === "string" ? e.code : undefined;
