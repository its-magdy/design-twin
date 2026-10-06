// svg-normalize.ts — the definitions of "same SVG, modulo Figma's export noise". There are TWO, on purpose:
//
// Figma's own SVG export is not bit-reproducible: re-exporting the SAME icon, with NOTHING changed in
// the design, comes back with different floating-point path coordinates (measured ≤0.004px drift —
// findings 25/222, e.g. `arrow-down-3ea6be.svg` d="…8.77734…4.97401…" vs `arrow-down-ccfd6b.svg`
// d="…8.7793 …4.97596…", the same icon exported twice), and with def ids that embed the exporting
// node's id (`clip0_22012_15691` vs `clip0_22012_24907` for one icon reached through two instances).
//
//   1. `normalizeSvgText` (v1, below): round every decimal to 1 place, then hash the text. Used by the
//      plugin's per-run content hash (figma-plugin/src/assets.ts register(), re-exported crypto-free
//      from figma-plugin/src/util.ts) and by the change diff (design-to-code/design-diff.ts
//      hashAssetBytes(), via bridge/src/asset-compare.ts). It stays EXACTLY as it is: design-diff
//      persists these hashes in snapshot sidecars, so any change to v1 would report every SVG with
//      defs as "redrawn" against every snapshot already on disk (D61).
//   2. `svgFingerprint` / `sameSvg` (below v1): a skeleton plus every number, compared within an
//      absolute tolerance. Used by the bridge's shared assets/ directory — the content reuse in
//      bridge/src/write-out.ts writeAssets() and its `duplicates` report, via asset-compare.ts
//      ContentIndex. It closes the three gaps v1 has on real exports (DT-18): def ids, integer
//      tokens (`12` vs `11.9999`, which v1's decimal-only regex never touches) and the rounding
//      boundary (21.9485 → 21.9 but 21.9504 → 22.0: two exports 0.002 apart hash differently).
//
// The plugin bundle inlines THIS file, so it stays dependency-free and crypto-free: the byte/hash
// helpers live in asset-compare.ts, because Node's `crypto` does not exist in the plugin's sandbox and
// this file must also type-check under the plugin's tsconfig, which has no Node types — an
// `import … from "node:crypto"` ANYWHERE in this file would break the plugin build even if the plugin
// bundle never calls that function.
//
// ---- v1
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
export function normalizeSvgText(svg: string): string {
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
export function isSvgName(fileName: unknown): boolean {
  return /\.svg$/i.test(String(fileName || ""));
}

// ---- the fingerprint (bridge only — see the header for why v1 is not changed instead)
//
// The skeleton is the SVG text with (1) every id DEFINED in the document renamed `idN` in order of first
// definition, together with every `#X` reference to it (`url(#X)`, `href="#X"`, `xlink:href="#X"`) —
// generic, so it covers any id shape Figma emits, not only the clip/pattern/image ids seen so far; (2)
// hex colours and `base64,` payloads kept verbatim (a colour is a token, not a coordinate, and a changed
// pixel in an embedded image is real signal); and (3) every other numeric token, integers included,
// replaced by `#`, its value pushed to `nums`. Two exports of one icon have equal skeletons and nums
// within SVG_TOL of each other.
//
// SVG_TOL = 0.01, absolute. On the three real export directories every tolerance from 0.005 to 0.05
// merges the same files; the largest real drift inside a merged group is 0.004 and the closest real
// pair that is genuinely different is 0.3 apart (a stroke width, 1.5 vs 1.2). 0.01 is 2.5x the drift,
// far below any visible change, and does not merge opacity steps (0.5 vs 0.54) the way 0.05 would.
// "Within" is inclusive up to float noise (TOL_EPS): 0.11 vs 0.12 and 0.5 vs 0.51 are both exactly one
// step apart, but their float differences land on either side of 0.01 (L-1).
//
// One exception, M-5: a number inside the `transform` of a `<use>` or `<image>` is in the space of the
// element it fills — for Figma's raster shells, `<pattern patternContentUnits="objectBoundingBox"><use
// transform="matrix(0.00195312 0 0 0.00195312 0 0)">`, where the whole box is 1 unit. 0.01 there is a
// 4.5x zoom of the same photo (scale 1/512 vs 1/113). The `<pattern>`'s own x/y/width/height (and
// patternTransform) are box fractions too, unless patternUnits="userSpaceOnUse" (R2-4: a tile size).
// Those numbers go to `rel` (a `%` in the skeleton)
// and compare RELATIVELY: within SVG_TOL of the larger magnitude, never looser than the absolute rule.
// Path and box coordinates keep the absolute tolerance — their near-zero drift (2.09808e-05 vs
// -0.000406265, one real chevron) is noise, not a different drawing.
export const SVG_TOL = 0.01;
const TOL_EPS = 1e-9;

export interface SvgFingerprint {
  /** the text with ids canonicalised and every number replaced by `#` */
  skeleton: string;
  /** every number the skeleton replaced with `#`, in document order */
  nums: Float64Array;
  /** every number inside a `<use>`/`<image>` `transform` or a `<pattern>`'s own x/y/width/height/patternTransform
   *  (a `%` in the skeleton), compared relatively */
  rel: Float64Array;
}

const ID_DEF_RE = /(?<![\w:-])id\s*=\s*(["'])(.*?)\1/g;
// One pass over the text with the protected spans first in the alternation, so a protected span is
// consumed whole and its digits never reach the number branch: a canonical id marker, a hex colour of
// 3/4/6/8 digits not followed by another name character (so `#clip0` or `#12345` are not colours), a
// base64 payload, then the number itself — `-?(\d+\.?\d*|\.\d+)` with an optional exponent.
const ID_MARK = "\u0000";
const TOKEN_RE = /(\u0000id\d+\u0000)|(#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-]))|(base64,[A-Za-z0-9+/=]+)|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/g;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function canonicalIds(svg: string): string {
  const order = new Map<string, string>(); // defined id -> its canonical marker, in order of first definition
  // exec, not matchAll: the plugin's tsconfig is es2019 (no String.prototype.matchAll).
  ID_DEF_RE.lastIndex = 0;
  for (let m = ID_DEF_RE.exec(svg); m; m = ID_DEF_RE.exec(svg)) {
    const id = m[2];
    if (id && !order.has(id)) order.set(id, ID_MARK + "id" + order.size + ID_MARK);
  }
  if (!order.size) return svg;
  // Longest first, so an id that is a prefix of another (`a` / `a1`) never claims the longer one's text.
  const alts = [...order.keys()].sort((x, y) => y.length - x.length).map(escapeRe).join("|");
  const re = new RegExp("(?<![\\w:-])(id\\s*=\\s*[\"'])(" + alts + ")(?=[\"'])|#(" + alts + ")(?![\\w.:-])", "g");
  return svg.replace(re, (m: string, attr: string | undefined, defined: string | undefined, ref: string | undefined) => {
    if (attr !== undefined && defined !== undefined) return attr + (order.get(defined) ?? defined);
    if (ref !== undefined) return "#" + (order.get(ref) ?? ref);
    return m;
  });
}

// The value spans compared relatively (M-5): `transform` on `<use>`/`<image>` tags, and a `<pattern>`'s own
// x/y/width/height/patternTransform (R2-4). A tag's attributes never contain `>` (a base64 payload has none),
// so `[^>]*` stays inside the tag.
const REL_TAG_RE = /<(?:use|image|pattern)\b[^>]*>/g;
const TRANSFORM_ATTR_RE = /(?<![\w:-])transform\s*=\s*(["'])([^"']*)\1/g;
// A <pattern>'s own box is a fraction of the filled shape (patternUnits defaults to objectBoundingBox): a
// TILE fill of 0.05 vs 0.0588 is 20 vs 17 tiles across. With patternUnits="userSpaceOnUse" they are user
// units, compared absolutely like any other number.
const PATTERN_ATTR_RE = /(?<![\w:-])(?:x|y|width|height|patternTransform)\s*=\s*(["'])([^"']*)\1/g;
function relSpans(svg: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  REL_TAG_RE.lastIndex = 0;
  for (let t = REL_TAG_RE.exec(svg); t; t = REL_TAG_RE.exec(svg)) {
    const re = t[0].startsWith("<pattern") ? (/patternUnits\s*=\s*["']userSpaceOnUse/.test(t[0]) ? null : PATTERN_ATTR_RE) : TRANSFORM_ATTR_RE;
    if (!re) continue;
    re.lastIndex = 0;
    for (let a = re.exec(t[0]); a; a = re.exec(t[0])) {
      const start = t.index + a.index + a[0].length - 1 - (a[2] || "").length;
      spans.push([start, start + (a[2] || "").length]);
    }
  }
  return spans;
}

export function svgFingerprint(svg: string): SvgFingerprint {
  const nums: number[] = [];
  const rel: number[] = [];
  const text = canonicalIds(svg);
  const spans = relSpans(text);
  const inRel = (at: number): boolean => spans.some(([s, e]) => at >= s && at < e);
  const skeleton = text.replace(TOKEN_RE, (m: string, _id: string | undefined, _hex: string | undefined, _b64: string | undefined, num: string | undefined, at: number) => {
    if (num === undefined) return m;
    if (spans.length && inRel(at)) { rel.push(Number(num)); return "%"; }
    nums.push(Number(num));
    return "#";
  });
  return { skeleton, nums: Float64Array.from(nums), rel: Float64Array.from(rel) };
}

/** Every number within `tol` of its counterpart (and as many of them). Exact equality also counts, so two
 *  infinities from an overflowing token compare equal rather than NaN-unequal. */
export function numsWithin(a: Float64Array, b: Float64Array, tol: number = SVG_TOL): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number, y = b[i] as number;
    if (x !== y && !(Math.abs(x - y) <= tol + TOL_EPS)) return false;
  }
  return true;
}

/** The `rel` half (M-5): every number within `tol` × the larger magnitude of the pair, and never more than
 *  `tol` apart — so a big number keeps the absolute rule and a tiny one is compared to its own scale. */
export function relWithin(a: Float64Array, b: Float64Array, tol: number = SVG_TOL): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number, y = b[i] as number;
    if (x !== y && !(Math.abs(x - y) <= Math.min(tol, tol * Math.max(Math.abs(x), Math.abs(y))) + TOL_EPS)) return false;
  }
  return true;
}

/** The bridge's "same SVG": equal skeletons, every number within `tol`, every `rel` number relatively so. */
export function sameSvg(a: string, b: string, tol: number = SVG_TOL): boolean {
  const fa = svgFingerprint(a), fb = svgFingerprint(b);
  return fa.skeleton === fb.skeleton && numsWithin(fa.nums, fb.nums, tol) && relWithin(fa.rel, fb.rel, tol);
}

// ---- DT-09: a raster image in an SVG shell
//
// An SVG with an embedded `<image>` and almost no paths is a PHOTO in an SVG shell (an avatar exported as an
// icon-like container: 2 paths and a 1.98 MB base64 JPEG). The "thousands of vector paths" advice is wrong
// for it: there is nothing to simplify, and a PNG/JPG export of the layer is the fix. ONE rule for the
// bridge's pull warning (write-out.ts) and the audit's heavy-asset finding (design-to-code/audit.ts), L-7:
// an illustration with 2000 paths and one `<image>` is still "too many paths", in both.
export const RASTER_SHELL_MAX_PATHS = 50;
export function isRasterShell(rasters: number | undefined, paths: number | undefined): boolean {
  return (rasters ?? 0) > 0 && (paths ?? 0) < RASTER_SHELL_MAX_PATHS;
}
