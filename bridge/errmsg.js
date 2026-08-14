// Thrown value -> message string. The ONE definition, shared across both module systems: the Node side
// requires it directly, and the plugin bundle re-exports it from util.ts (esbuild inlines this
// dependency-free CJS module, the same way it inlines pages-layout.js). A bare `e.message` prints
// `undefined` for a thrown string, and the extractor's "never silent" discipline means every catch
// reports something — so this coercion has to hold everywhere, not per module system.
const errMsg = (e) => (typeof e === "string" ? e : String((e && e.message) || e));

module.exports = { errMsg };
