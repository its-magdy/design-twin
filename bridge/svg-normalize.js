// svg-normalize.js — the ONE definition of "same SVG, modulo Figma's export noise".
//
// Figma's own SVG export is not bit-reproducible: re-exporting the SAME icon, with NOTHING changed in
// the design, comes back with different floating-point path coordinates (measured ≤0.002px drift —
// findings 25/222, e.g. `arrow-down-3ea6be.svg` d="…8.77734…4.97401…" vs `arrow-down-ccfd6b.svg`
// d="…8.7793 …4.97596…", the same icon exported twice). Three places independently need to answer
// "are these two SVGs the same asset": the plugin's own content-hash/dedup (figma-plugin/src/assets.ts
// register()), the shared assets/ directory's clobber-avoidance (bridge/write-out.js writeAssets(), via
// bridge/asset-compare.js), and the change diff (design-to-code/design-diff.js redrawnAssets(), same).
// Those used to each rehash their own copy of the rounding logic — a change to the tolerance in one and
// not the others silently reintroduces "same icon reported as changed/duplicated" in whichever place
// was missed. One definition, shared everywhere:
//   - Node side requires this directly (bridge/asset-compare.js — see there for why the byte/hash
//     helpers live in a SEPARATE module: they need Node's `crypto`, which does not exist in the
//     plugin's sandbox, and esbuild cannot tree-shake a single property out of a CommonJS
//     `module.exports` object, so a `require("crypto")` ANYWHERE in this file would break the plugin
//     build even if the plugin bundle never calls that function).
//   - The plugin bundle re-exports THIS file (crypto-free) from figma-plugin/src/util.ts (esbuild
//     inlines this dependency-free CJS module), the same way it inlines errmsg.js.
//
// Rounding to 1 decimal place (~0.1px), not 2 (~0.01px): tried 2 decimals first and it does NOT
// reliably collapse the drift, because two legitimately identical re-exports can straddle a rounding
// boundary — 4.97401 rounds to 4.97 but 4.97596 (0.00195 away — well inside the ≤0.002px drift budget)
// rounds to 4.98, so the "same" icon split into two hashes anyway. Verified against the real eight
// `arrow-down*.svg` variants (test/fixtures/livetest3/arrow-down/, from a real Figma export) with a
// small script before choosing this: 1 decimal place is the coarsest rounding that does NOT itself
// introduce a boundary split on this data, and it correctly separates the THREE genuinely different
// icons among those eight files. Still two orders of magnitude below anything a human would call
// "moved" — accepted by the orchestrator as the tolerance to use, despite differing from the ~0.01px
// originally suggested, specifically because 0.01px empirically fails on this real fixture data.
// Matches BOTH plain decimals (`-0.000406265`) and scientific notation (`2.09808e-05`) — Figma emits
// both for a coordinate near zero, sometimes for the SAME logical value across two exports of what is
// otherwise the identical icon (live evidence: a real `angle-left` chevron came back as
// `2.09808e-05`/`-0.000406265`/`8.2016e-05` in three different pulls of the same shape). The regex
// used to stop at the decimal mantissa (`-?\d+\.\d+`), so a scientific-notation coordinate like
// `2.09808e-05` had only its `2.09808` replaced, leaving the exponent dangling as `2.1e-05` — a
// corrupted, un-normalised leftover that could never match the plain-decimal form's `0.0`, and the
// icon failed to dedup even though every OTHER coordinate in the path matched exactly. Round 3 found
// this live: five `angle-left*.svg` files for what should have been two (a real up/down pair).
const NUM_RE = /-?\d+\.\d+(?:[eE][+-]?\d+)?/g;
function normalizeSvgText(svg) {
  return svg.replace(NUM_RE, (m) => {
    const n = Number(m);
    if (!Number.isFinite(n)) return m;
    // toFixed can print "-0.0" for a tiny negative value that rounds to zero — a plain "0.0" and a
    // "-0.0" are the same design value and must normalise identically, or they poison dedup the same
    // way the scientific-notation bug above did.
    const fixed = n.toFixed(1);
    return fixed === "-0.0" ? "0.0" : fixed;
  });
}

// `fileName` decides whether normalisation even applies: only a textual SVG has a coordinate space to
// round. PNG/other bytes are never touched — a changed pixel there is real signal, not noise.
function isSvgName(fileName) {
  return /\.svg$/i.test(String(fileName || ""));
}

module.exports = { normalizeSvgText, isSvgName };
