// Offline tests for the bridge's "same SVG" fingerprint (bridge/src/svg-normalize.ts svgFingerprint/sameSvg)
// and the content index built on it (bridge/src/asset-compare.ts ContentIndex).
// The pairs in test/fixtures/g13/svg/ are real Figma exports, renamed generically:
//   disc-a/-b     one icon reached through two instances: only the def ids differ (clip0_<node id>)
//   badge-a/-b    one icon re-exported: values 0.002 apart that straddle a 0.1 rounding boundary
//   cross-a/-b    one icon re-exported: `12` vs `11.9999` (an integer v1's decimal-only regex never touches)
//   ring-a/-b     two DIFFERENT icons: same skeleton, a 1.5 vs 1.2 stroke width (0.3 apart)
//   chevron-a/-b  two DIFFERENT icons: an up and a down chevron (9.6 apart)
//   avatar-raster a 2-path SVG shell around an embedded <image> (payload shrunk to a 1x1 PNG)
// Run with:  node test/asset-compare.test.ts
import fs from "node:fs";
import path from "node:path";
import { ok, report } from "./assert.ts";
import * as norm from "../bridge/src/svg-normalize.ts";
import * as cmp from "../bridge/src/asset-compare.ts";

const FIX = path.join(import.meta.dirname, "fixtures", "g13", "svg");
const read = (f: string): string => fs.readFileSync(path.join(FIX, f), "utf8");
// A check whose code throws (e.g. run against a tree that lacks the function under test) prints ✗, not a crash.
const t = (name: string, cond: () => boolean): void => {
  let v = false;
  try { v = cond(); } catch (e) { console.log("    threw: " + String(e instanceof Error ? e.message : e)); }
  ok(name, v);
};

console.log("svg-normalize.ts — fingerprint on real drift pairs:");
for (const [pair, why] of [["disc", "def ids only"], ["badge", "a 0.1 rounding-boundary straddle"], ["cross", "an integer vs 11.9999"]] as const) {
  const a = read(pair + "-a.svg"), b = read(pair + "-b.svg");
  ok(`[svg-fp] the ${pair} pair (${why}) has different v1 normalised text — why v1 kept them apart`, norm.normalizeSvgText(a) !== norm.normalizeSvgText(b));
  t(`[svg-fp] the ${pair} pair (${why}) is the same SVG`, () => norm.sameSvg(a, b));
}
t("[svg-fp] the ring pair (a 0.3 stroke-width gap) stays apart", () => !norm.sameSvg(read("ring-a.svg"), read("ring-b.svg")));
t("[svg-fp] the chevron pair (up vs down) stays apart", () => !norm.sameSvg(read("chevron-a.svg"), read("chevron-b.svg")));
t("[svg-fp] the default tolerance is 0.01", () => norm.SVG_TOL === 0.01);

// Hex colours are kept verbatim in the skeleton. #121319 vs #121318 is the planned pair; #0A0000 vs #00A000
// is the one that also needs the protection — read as numbers, both are `#`,0,`A`,0 and would merge.
const glyph = (fill: string): string => `<svg width="16" height="16" viewBox="0 0 16 16"><path d="M2 2L14 14" stroke="${fill}" stroke-width="1.5"/></svg>`;
t("[svg-fp] two SVGs differing only in a fill hex (#121319 vs #121318) are different", () => !norm.sameSvg(glyph("#121319"), glyph("#121318")));
t("[svg-fp] hex colours are protected: #0A0000 vs #00A000 are different", () => !norm.sameSvg(glyph("#0A0000"), glyph("#00A000")));
t("[svg-fp] …and the same colour is the same SVG", () => norm.sameSvg(glyph("#0A0000"), glyph("#0A0000")));
t("[svg-fp] the skeleton keeps the colour text", () => norm.svgFingerprint(glyph("#0A0000")).skeleton.includes('stroke="#0A0000"'));

const avatar = read("avatar-raster.svg");
const otherPayload = avatar.replace(/base64,[A-Za-z0-9+/=]+/, "base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");
t("[svg-fp] same skeleton, different base64 payload → different", () => otherPayload !== avatar && !norm.sameSvg(avatar, otherPayload));
t("[svg-fp] the embedded payload is kept whole in the skeleton (its digits are not numbers)",
  () => norm.svgFingerprint(avatar).skeleton.includes("base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="));

// Ids are canonicalised generically, in order of definition, references included — any id shape.
const masked = (id: string): string => `<svg><defs><mask id="${id}"><rect width="4" height="4"/></mask></defs><g mask="url(#${id})"><use href="#${id}"/></g></svg>`;
t("[svg-fp] any id shape is canonicalised with its references (`a-mask` vs `mask_77`)", () => norm.sameSvg(masked("a-mask"), masked("mask_77")));
t("[svg-fp] a reference to an UNDEFINED id is not canonicalised", () => !norm.sameSvg('<svg><g mask="url(#m1)"/></svg>', '<svg><g mask="url(#m2)"/></svg>'));
t("[svg-fp] ids are numbered in order of first definition, so two defs swapped in order differ",
  () => !norm.sameSvg('<svg><a id="p"/><b id="q"/><c fill="url(#p)"/></svg>', '<svg><a id="p"/><b id="q"/><c fill="url(#q)"/></svg>'));
t("[svg-fp] integers are numbers too: `12` vs `11.9999`", () => norm.sameSvg('<svg><path d="M12 0"/></svg>', '<svg><path d="M11.9999 0"/></svg>'));
t("[svg-fp] scientific notation is one number: 2.09808e-05 vs -0.000406265", () => norm.sameSvg('<svg><path d="M2.09808e-05 1"/></svg>', '<svg><path d="M-0.000406265 1"/></svg>'));
t("[svg-fp] a different number of numbers is different", () => !norm.sameSvg('<svg><path d="M1 1"/></svg>', '<svg><path d="M1 1 1"/></svg>'));

// Perf: the largest real SVG has ~300k numbers (a flattened illustration).
{
  const parts: string[] = ['<svg width="1000" height="1000">'];
  for (let i = 0; i < 1500; i++) {
    let d = "M0 0";
    for (let j = 0; j < 100; j++) d += `L${(i * 0.37 + j * 1.2345).toFixed(4)} ${(j * 0.789 - i * 0.01).toFixed(4)}`;
    parts.push(`<path d="${d}Z" fill="#AABBCC"/>`);
  }
  parts.push("</svg>");
  const big = parts.join("\n");
  let n = 0, ms = Infinity;
  try {
    const t0 = performance.now();
    n = norm.svgFingerprint(big).nums.length;
    ms = performance.now() - t0;
  } catch { /* reported below */ }
  ok(`[svg-fp] perf: a ${n}-number SVG fingerprints in < 500 ms (${ms.toFixed(0)} ms)`, n >= 300000 && ms < 500);
}

console.log("\nasset-compare.ts — ContentIndex:");
t("[index] the representative is the plain name: x.svg beats x-abc123.svg, whatever order they were added in", () => {
  const ix = new cmp.ContentIndex();
  ix.add("x-abc123.svg", read("disc-b.svg"));
  ix.add("x.svg", read("disc-a.svg"));
  const groups = ix.groups();
  return ix.find("new.svg", read("disc-b.svg")) === "x.svg" && groups.length === 1 && groups[0]?.files.join(",") === "x.svg,x-abc123.svg";
});
t("[index] the plain name wins even when it is the LONGER one (disc_outline.svg over disc-1a2b3c.svg)", () => {
  const ix = new cmp.ContentIndex();
  ix.add("disc-1a2b3c.svg", read("disc-b.svg"));
  ix.add("disc_outline.svg", read("disc-a.svg"));
  return ix.find("n.svg", read("disc-a.svg")) === "disc_outline.svg";
});
t("[index] then the shortest, then alphabetical", () => {
  const ix = new cmp.ContentIndex();
  for (const n of ["bb.svg", "a-123456.svg", "ab.svg", "c.svg"]) ix.add(n, read("cross-a.svg"));
  return ix.groups()[0]?.files.join(",") === "c.svg,ab.svg,bb.svg,a-123456.svg";
});
t("[index] a different icon with the same skeleton is not found, and is its own group", () => {
  const ix = new cmp.ContentIndex();
  ix.add("ring.svg", read("ring-a.svg"));
  ix.add("ring-2fd8d2.svg", read("ring-b.svg"));
  return ix.find("q.svg", read("ring-b.svg")) === "ring-2fd8d2.svg" && ix.groups().filter((g) => g.files.length > 1).length === 0;
});
t("[index] non-SVG bytes match exactly only", () => {
  const ix = new cmp.ContentIndex();
  ix.add("p.png", Buffer.from([1, 2, 3]));
  return ix.find("q.png", Buffer.from([1, 2, 3])) === "p.png" && ix.find("q.png", Buffer.from([1, 2, 4])) === undefined;
});
t("[index] a group's hash is stable whichever member it was built from", () => {
  const a = new cmp.ContentIndex(); a.add("x.svg", read("badge-a.svg")); a.add("x-111111.svg", read("badge-b.svg"));
  const b = new cmp.ContentIndex(); b.add("x.svg", read("badge-a.svg"));
  const ha = a.groups()[0]?.hash, hb = b.groups()[0]?.hash;
  return typeof ha === "string" && ha.length === 40 && ha === hb;
});
console.log("\nthe tolerance at its edge and in objectBoundingBox space:");
{
  const op = (o: string): string => `<svg width="16" height="16"><path d="M0 0H16V16H0Z" fill="#000" fill-opacity="${o}"/></svg>`;
  // The float difference of 0.5/0.51, 0.3/0.31 and 0.11/0.12 lands on either side of 0.01; all three must merge.
  t("numbers exactly 0.01 apart are within the tolerance, whatever the float rounding (0.5/0.51, 0.3/0.31, 0.11/0.12)",
    () => norm.sameSvg(op("0.5"), op("0.51")) && norm.sameSvg(op("0.3"), op("0.31")) && norm.sameSvg(op("0.11"), op("0.12")));
  t("…and 0.011 apart is not", () => !norm.sameSvg(op("0.5"), op("0.511")));
  const shell = (m: string): string => `<svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><rect width="40" height="40" fill="url(#pattern0_1_2)"/><defs><pattern id="pattern0_1_2" patternContentUnits="objectBoundingBox" width="1" height="1"><use xlink:href="#image0_1_2" transform="${m}"/></pattern><image id="image0_1_2" width="512" height="512" xlink:href="data:image/png;base64,iVBORw0KGgo="/></defs></svg>`;
  // Every number of the 4.5x zoom is within 0.01 absolute, yet the pair must stay apart.
  t("one photo at 1x vs 4.5x zoom (pattern scale 1/512 vs 1/113) is NOT the same SVG",
    () => !norm.sameSvg(shell("matrix(0.00195312 0 0 0.00195312 0 0)"), shell("matrix(0.00884956 0 0 0.00884956 -0.006 -0.006)")));
  t("…a 0.1 % re-export drift of that scale still is", () => norm.sameSvg(shell("matrix(0.00195312 0 0 0.00195312 0 0)"), shell("matrix(0.00195507 0 0 0.00195507 0 0)")));
  t("the transform's numbers are compared relatively (`%` in the skeleton, `rel` in the fingerprint)", () => {
    const f = norm.svgFingerprint(shell("matrix(0.00195312 0 0 0.00195312 0 0)"));
    // 8 = the <pattern>'s width="1" height="1", then the six matrix numbers.
    return f.rel.length === 8 && f.rel[0] === 1 && f.rel[1] === 1 && f.rel[2] === 0.00195312 && f.skeleton.includes('transform="matrix(% % % % % %)"') && !f.skeleton.includes("0.00195312");
  });
  t("a big number in a <use> transform keeps the absolute rule (12 vs 12.005 same; 12 vs 12.02 not)",
    () => norm.sameSvg(shell("translate(12 0)"), shell("translate(12.005 0)")) && !norm.sameSvg(shell("translate(12 0)"), shell("translate(12.02 0)")));
  const chev = (y: string): string => `<svg width="18" height="10"><path d="M0 ${y}L9 9L18 0" stroke="#111"/></svg>`;
  t("near-zero path drift (2.09808e-05 vs -0.000406265 in d=) stays the same SVG", () => norm.sameSvg(chev("2.09808e-05"), chev("-0.000406265")));
  t("a transform on a non-<use>/<image> element keeps the absolute rule",
    () => norm.sameSvg('<svg><g transform="matrix(0.002 0 0 0.002 0 0)"><path d="M0 0h1"/></g></svg>', '<svg><g transform="matrix(0.009 0 0 0.009 0 0)"><path d="M0 0h1"/></g></svg>'));
  t("the index keeps the two zooms apart: two groups, two hashes", () => {
    const ix = new cmp.ContentIndex();
    ix.add("avatar.svg", shell("matrix(0.00195312 0 0 0.00195312 0 0)"));
    ix.add("avatar-111111.svg", shell("matrix(0.00195507 0 0 0.00195507 0 0)"));
    ix.add("avatar-222222.svg", shell("matrix(0.00884956 0 0 0.00884956 -0.006 -0.006)"));
    const g = ix.groups();
    return g.length === 2 && g[0]?.files.join(",") === "avatar.svg,avatar-111111.svg" && g[1]?.files.join(",") === "avatar-222222.svg" && g[0].hash !== g[1].hash
      && ix.find("q.svg", shell("matrix(0.00884956 0 0 0.00884956 -0.006 -0.006)")) === "avatar-222222.svg";
  });
  // a <pattern>'s own x/y/width/height are fractions of the filled box (patternUnits defaults to
  // objectBoundingBox) — a TILE image fill's tile size.
  const tile = (w: string, units = ""): string => `<svg width="200" height="200" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><rect width="200" height="200" fill="url(#pattern0_1_2)"/><defs><pattern id="pattern0_1_2"${units} patternContentUnits="objectBoundingBox" width="${w}" height="${w}"><use xlink:href="#image0_1_2" transform="scale(0.000976562)"/></pattern><image id="image0_1_2" width="256" height="256" xlink:href="data:image/png;base64,iVBORw0KGgo="/></defs></svg>`;
  // 0.05 vs 0.0588 is within 0.01 absolute, yet the pair must stay apart.
  t("a tile fill of 0.05 vs 0.0588 (20 vs 17 tiles across) is NOT the same SVG", () => !norm.sameSvg(tile("0.05"), tile("0.0588")));
  t("…a 0.1 % drift of the tile size still is", () => norm.sameSvg(tile("0.05"), tile("0.05005")));
  t("the pattern's width/height are `%` in the skeleton", () => norm.svgFingerprint(tile("0.05")).skeleton.includes('width="%" height="%"'));
  t("with patternUnits=\"userSpaceOnUse\" they are user units: the absolute rule (0.05 vs 0.0588 same)",
    () => norm.sameSvg(tile("0.05", ' patternUnits="userSpaceOnUse"'), tile("0.0588", ' patternUnits="userSpaceOnUse"')));
  // one raster-shell rule for the pull and the audit.
  t("isRasterShell: an <image> and under 50 paths; none without an <image>, none at 50+ paths",
    () => norm.isRasterShell(1, 2) && norm.isRasterShell(1, undefined) && !norm.isRasterShell(0, 2) && !norm.isRasterShell(undefined, 2) && !norm.isRasterShell(1, 50) && !norm.isRasterShell(1, 2000));
}
t("[index] the v1 compare (design-diff's) is unchanged: the disc pair is still different under sameAsset",
  () => !cmp.sameAsset("d.svg", read("disc-a.svg"), read("disc-b.svg")));

report();
