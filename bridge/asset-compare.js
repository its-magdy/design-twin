// asset-compare.js — Node-side byte comparison built on svg-normalize.js's tolerance.
//
// Split out of svg-normalize.js (rather than living there) because this needs `crypto`, which the
// Figma plugin sandbox does not have and esbuild cannot tree-shake a single property out of a
// CommonJS `module.exports` object — a `require("crypto")` anywhere in a file the plugin bundle
// imports breaks that build, even for a function the bundle never calls. svg-normalize.js stays
// crypto-free so figma-plugin/src/util.ts can safely re-export it; this file is required only from
// Node (bridge/write-out.js, design-to-code/design-diff.js — the latter bundled by
// claude-plugin/build-scripts.js the same way it already bundles bridge/snapshot-meta.js).
const { normalizeSvgText, isSvgName } = require("./svg-normalize.js");

// `content` may be a Buffer (bytes on disk / about to be written) or a string (an SVG the plugin just
// produced, before it's ever touched a filesystem) — normalised either way. Always returns a Buffer.
function normalizeForCompare(fileName, content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
  if (!isSvgName(fileName)) return buf;
  return Buffer.from(normalizeSvgText(buf.toString("utf8")), "utf8");
}

function sha1Hex(buf) {
  return require("crypto").createHash("sha1").update(buf).digest("hex");
}

// The comparison every "is this the same asset" decision should use: true if the two byte strings are
// the same asset MODULO Figma's own export noise (SVG coordinate rounding only; PNG/other bytes are
// compared exactly — a changed pixel there is real signal, not noise).
function sameAsset(fileName, a, b) {
  return Buffer.compare(normalizeForCompare(fileName, a), normalizeForCompare(fileName, b)) === 0;
}

module.exports = { normalizeForCompare, sha1Hex, sameAsset };
