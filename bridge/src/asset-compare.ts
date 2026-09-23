// asset-compare.ts — Node-side byte comparison built on svg-normalize.ts's tolerance.
//
// Split out of svg-normalize.ts (rather than living there) because this needs `crypto`, which the
// Figma plugin sandbox does not have — and svg-normalize.ts must type-check under the plugin's
// tsconfig (no Node types) and bundle into the plugin, so an `import … from "node:crypto"` anywhere
// in a file the plugin bundle imports breaks that build, even for a function the bundle never calls.
// svg-normalize.ts stays crypto-free so figma-plugin/src/util.ts can safely re-export it; this file
// is imported only from Node (bridge/src/write-out.ts, design-to-code/design-diff.ts — the latter
// bundled by claude-plugin/build-scripts.js the same way it already bundles bridge/src/snapshot-meta.ts).
import crypto from "node:crypto";
import { normalizeSvgText, isSvgName } from "./svg-normalize.ts";

// `content` may be a Buffer (bytes on disk / about to be written) or a string (an SVG the plugin just
// produced, before it's ever touched a filesystem) — normalised either way. Always returns a Buffer.
export function normalizeForCompare(fileName: unknown, content: Buffer | string): Buffer {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
  if (!isSvgName(fileName)) return buf;
  return Buffer.from(normalizeSvgText(buf.toString("utf8")), "utf8");
}

export function sha1Hex(buf: Buffer | string): string {
  return crypto.createHash("sha1").update(buf).digest("hex");
}

// The comparison every "is this the same asset" decision should use: true if the two byte strings are
// the same asset MODULO Figma's own export noise (SVG coordinate rounding only; PNG/other bytes are
// compared exactly — a changed pixel there is real signal, not noise).
export function sameAsset(fileName: unknown, a: Buffer | string, b: Buffer | string): boolean {
  return Buffer.compare(normalizeForCompare(fileName, a), normalizeForCompare(fileName, b)) === 0;
}
